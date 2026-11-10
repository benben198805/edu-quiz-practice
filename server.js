const path = require("path");
const express = require("express");
const { openDB } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = openDB();

/* ---------- 套题列表（含答题历史数） ---------- */
app.get("/api/papers", (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.description, p.created_at,
           (SELECT COUNT(*) FROM questions q WHERE q.paper_id = p.id) AS question_count,
           (SELECT COALESCE(SUM(q.score),0) FROM questions q WHERE q.paper_id = p.id) AS max_score,
           (SELECT COUNT(*) FROM attempts a WHERE a.paper_id = p.id OR a.paper_name = p.name) AS attempt_count,
           (SELECT MAX(a.started_at) FROM attempts a WHERE a.paper_id = p.id OR a.paper_name = p.name) AS last_attempt_at
    FROM papers p
    -- 提取名称中的数字并转为整数排序，例如 "进阶版第2套" 提取出 2
    ORDER BY CAST(SUBSTR(p.name, INSTR(p.name, '第') + 1, LENGTH(p.name) - INSTR(p.name, '第') - 1) AS INTEGER) ASC
  `).all();
  res.json(rows);
});

/* ---------- 某套题的题目（只读详情，管理页也用它） ---------- */
app.get("/api/papers/:id/questions", (req, res) => {
  const paperId = Number(req.params.id);
  const paper = db.prepare("SELECT * FROM papers WHERE id = ?").get(paperId);
  if (!paper) return res.status(404).json({ error: "套题不存在" });

  const rows = db.prepare(`
    SELECT id, seq, type, score, stem, options, answer, analysis
    FROM questions WHERE paper_id = ? ORDER BY seq
  `).all(paperId);

  res.json({
    paper,
    questions: rows.map(r => ({
      ...r,
      options: JSON.parse(r.options),
      answer: JSON.parse(r.answer),
    }))
  });
});

/* ---------- 导入套题（同名覆盖题目，不影响已有历史快照） ---------- */
app.post("/api/papers/import", (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  if (!name) return res.status(400).json({ error: "请填写套题名称" });
  if (name.length > 100) return res.status(400).json({ error: "套题名称过长（最多 100 字）" });

  const { questions, errors } = normalizeQuestions(body.questions);
  if (errors.length) {
    return res.status(400).json({
      error: "题目数据校验失败",
      details: errors.slice(0, 10),
      errorCount: errors.length,
    });
  }

  const existing = db.prepare("SELECT id FROM papers WHERE name = ?").get(name);
  const created = !existing;

  let paperId;
  try {
    paperId = db.transaction(() => {
      db.prepare(`
        INSERT INTO papers (name, description) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET
          description = CASE WHEN excluded.description = '' THEN papers.description
                             ELSE excluded.description END
      `).run(name, description);

      const id = db.prepare("SELECT id FROM papers WHERE name = ?").get(name).id;

      const upsert = db.prepare(`
        INSERT INTO questions (paper_id, seq, type, score, stem, options, answer, analysis)
        VALUES (@paper_id, @seq, @type, @score, @stem, @options, @answer, @analysis)
        ON CONFLICT(paper_id, seq) DO UPDATE SET
          type=excluded.type, score=excluded.score, stem=excluded.stem,
          options=excluded.options, answer=excluded.answer, analysis=excluded.analysis
      `);
      questions.forEach((q, idx) => {
        upsert.run({
          paper_id: id,
          seq: idx + 1,
          type: q.type,
          score: q.score,
          stem: q.stem,
          options: JSON.stringify(q.options),
          answer: JSON.stringify(q.answer),
          analysis: q.analysis,
        });
      });

      // 新文件题数变少时删掉尾部多余题目；历史已存快照，不受影响
      db.prepare("DELETE FROM questions WHERE paper_id = ? AND seq > ?").run(id, questions.length);
      return id;
    })();
  } catch (err) {
    return res.status(500).json({ error: "导入失败：" + err.message });
  }

  res.json({ ok: true, paperId, name, created, questionCount: questions.length });
});

function normalizeQuestions(input) {
  const errors = [];
  if (!Array.isArray(input)) {
    return { questions: [], errors: ["缺少题目数组（questions）"] };
  }
  if (!input.length) {
    return { questions: [], errors: ["题目数组为空"] };
  }

  const validTypes = new Set(["judge", "single", "multi"]);
  const out = [];

  input.forEach((raw, i) => {
    const n = i + 1;
    const q = raw && typeof raw === "object" ? raw : {};
    const type = String(q.type || "").trim();
    const score = Number(q.score);
    const stem = typeof q.stem === "string" ? q.stem.trim() : "";
    const analysis = typeof q.analysis === "string" ? q.analysis : "";
    const options = Array.isArray(q.options) ? q.options : [];
    const answer = Array.isArray(q.answer) ? q.answer.map(k => String(k).trim()) : [];

    if (!validTypes.has(type)) {
      errors.push(`第 ${n} 题：type 必须是 judge / single / multi`);
      return;
    }
    if (!Number.isFinite(score) || score < 0) {
      errors.push(`第 ${n} 题：score 必须是非负数字`);
      return;
    }
    if (!stem) {
      errors.push(`第 ${n} 题：题干（stem）不能为空`);
      return;
    }
    if (options.length < 2) {
      errors.push(`第 ${n} 题：至少需要 2 个选项`);
      return;
    }
    const keys = [];
    for (const opt of options) {
      if (!Array.isArray(opt) || opt.length < 2 || opt[0] == null || opt[1] == null) {
        errors.push(`第 ${n} 题：选项格式应为 ["A","选项内容"]`);
        return;
      }
      keys.push(String(opt[0]).trim());
    }
    if (new Set(keys).size !== keys.length) {
      errors.push(`第 ${n} 题：选项字母重复`);
      return;
    }
    if (!answer.length) {
      errors.push(`第 ${n} 题：answer 不能为空`);
      return;
    }
    if (answer.some(k => !keys.includes(k))) {
      errors.push(`第 ${n} 题：answer 含不存在的选项 ${answer.filter(k => !keys.includes(k)).join("、")}`);
      return;
    }
    if (type !== "multi" && answer.length !== 1) {
      errors.push(`第 ${n} 题：${type === "judge" ? "判断题" : "单选题"} 只能有 1 个正确答案`);
      return;
    }
    if (type === "multi" && answer.length < 2) {
      errors.push(`第 ${n} 题：多项选择题至少要有 2 个正确答案`);
      return;
    }

    out.push({
      type,
      score,
      stem,
      analysis,
      options: options.map(opt => [String(opt[0]).trim(), String(opt[1])]),
      answer,
    });
  });

  return { questions: out, errors };
}

/* ---------- 删除套题（题目删除，历史快照保留） ---------- */
app.delete("/api/papers/:id", (req, res) => {
  const paperId = Number(req.params.id);
  if (!paperId) return res.status(400).json({ error: "缺少套题 id" });

  const paper = db.prepare("SELECT id, name FROM papers WHERE id = ?").get(paperId);
  if (!paper) return res.status(404).json({ error: "套题不存在" });

  const attemptCount = db.prepare(
    "SELECT COUNT(*) AS c FROM attempts WHERE paper_id = ? OR paper_name = ?"
  ).get(paperId, paper.name).c;

  try {
    // questions 随套题级联删除；answers.question_id 置 NULL，快照字段保留
    db.prepare("DELETE FROM papers WHERE id = ?").run(paperId);
  } catch (err) {
    return res.status(500).json({ error: "删除失败：" + err.message });
  }

  res.json({ ok: true, deleted: paperId, name: paper.name, keptAttempts: attemptCount });
});

/* ---------- 开始一次练习 ---------- */
app.post("/api/attempts", (req, res) => {
  const paperId = Number(req.body && req.body.paperId);
  if (!paperId) return res.status(400).json({ error: "缺少 paperId" });

  const paper = db.prepare("SELECT id, name FROM papers WHERE id = ?").get(paperId);
  if (!paper) return res.status(404).json({ error: "套题不存在" });

  const maxScore = db.prepare(
    "SELECT COALESCE(SUM(score),0) AS s FROM questions WHERE paper_id = ?"
  ).get(paperId).s;

  const info = db.prepare(
    `INSERT INTO attempts (paper_id, paper_name, max_score) VALUES (?, ?, ?)`
  ).run(paperId, paper.name, maxScore);

  res.json({ attemptId: info.lastInsertRowid, maxScore });
});

/* ---------- 提交单题作答（同时写入题目快照） ---------- */
app.post("/api/attempts/:id/answers", (req, res) => {
  const attemptId = Number(req.params.id);
  const { questionId, chosen } = req.body || {};
  if (!attemptId || !questionId) {
    return res.status(400).json({ error: "缺少 attemptId 或 questionId" });
  }

  const q = db.prepare("SELECT * FROM questions WHERE id = ?").get(questionId);
  if (!q) return res.status(404).json({ error: "题目不存在" });

  const right = JSON.parse(q.answer).sort().join("");
  const user = (chosen || []).slice().sort().join("");
  const isCorrect = right === user && user !== "";
  const earned = isCorrect ? q.score : 0;

  db.prepare(`
    INSERT INTO answers
      (attempt_id, question_id, seq, type, score, stem, options, answer, analysis,
       chosen, is_correct, earned)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(attempt_id, question_id) DO UPDATE SET
      chosen=excluded.chosen, is_correct=excluded.is_correct,
      earned=excluded.earned, answered_at=datetime('now','localtime')
  `).run(
    attemptId, questionId,
    q.seq, q.type, q.score, q.stem, q.options, q.answer, q.analysis,
    JSON.stringify(chosen || []), isCorrect ? 1 : 0, earned
  );

  refreshAttempt(attemptId);
  res.json({ isCorrect, earned });
});

/* ---------- 结束一次练习 ---------- */
app.post("/api/attempts/:id/finish", (req, res) => {
  const attemptId = Number(req.params.id);
  refreshAttempt(attemptId);
  db.prepare(`UPDATE attempts SET finished_at = datetime('now','localtime') WHERE id = ?`)
    .run(attemptId);
  const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
  res.json(row);
});

function refreshAttempt(attemptId) {
  const s = db.prepare(`
    SELECT COALESCE(SUM(earned),0) AS total_score,
           COUNT(*) AS answered,
           COALESCE(SUM(is_correct),0) AS correct
    FROM answers WHERE attempt_id = ?
  `).get(attemptId);

  db.prepare(`
    UPDATE attempts SET total_score = ?, answered = ?, correct = ? WHERE id = ?
  `).run(s.total_score, s.answered, s.correct, attemptId);
}

/* ---------- 历史记录列表（全部返回，前端按套题筛选） ---------- */
app.get("/api/attempts", (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS paper_exists
    FROM attempts a
    LEFT JOIN papers p ON p.name = a.paper_name
    ORDER BY a.id DESC
  `).all();
  res.json(rows);
});

/* ---------- 删除一条历史记录 ---------- */
app.delete("/api/attempts/:id", (req, res) => {
  const attemptId = Number(req.params.id);
  if (!attemptId) return res.status(400).json({ error: "缺少记录 id" });

  // answers 表有 ON DELETE CASCADE，这里显式清理一次，避免旧库未开启外键时留下孤儿数据
  const remove = db.transaction((id) => {
    db.prepare("DELETE FROM answers WHERE attempt_id = ?").run(id);
    return db.prepare("DELETE FROM attempts WHERE id = ?").run(id);
  });
  const info = remove(attemptId);
  if (!info.changes) return res.status(404).json({ error: "记录不存在" });
  res.json({ ok: true, deleted: attemptId });
});

/* ---------- 历史记录详情（纯读快照，套题删了也完整） ---------- */
app.get("/api/attempts/:id", (req, res) => {
  const attempt = db.prepare(`
    SELECT a.*, CASE WHEN p.id IS NULL THEN 0 ELSE 1 END AS paper_exists
    FROM attempts a LEFT JOIN papers p ON p.name = a.paper_name
    WHERE a.id = ?
  `).get(req.params.id);
  if (!attempt) return res.status(404).json({ error: "记录不存在" });

  const detail = db.prepare(`
    SELECT seq, type, score, stem, options, answer, analysis,
           chosen, is_correct, earned, answered_at
    FROM answers WHERE attempt_id = ? ORDER BY seq
  `).all(req.params.id);

  res.json({
    attempt,
    detail: detail.map(r => ({
      ...r,
      options: JSON.parse(r.options),
      answer: JSON.parse(r.answer),
      chosen: r.chosen ? JSON.parse(r.chosen) : []
    }))
  });
});

app.listen(PORT, () => {
  console.log(`服务已启动：http://localhost:${PORT}`);
});
