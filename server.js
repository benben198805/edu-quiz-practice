const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Op, fn, col, literal } = require("sequelize");
const {
  sequelize, Paper, Question, Attempt, Answer,
  WrongQuestion, ReviewSession, ReviewItem,
} = require("./db");
const { nowLocal } = require("./db/time");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* MySQL DOUBLE 求和会出现 83.99999999999994，保留 2 位小数规避浮点误差。 */
function roundScore(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/* ---------- 健康检查（云托管探针可用） ---------- */
app.get("/api/health", asyncHandler(async (req, res) => {
  await sequelize.authenticate();
  res.json({ ok: true });
}));

/* ---------- 套题列表（含答题历史数） ---------- */
app.get("/api/papers", asyncHandler(async (req, res) => {
  const rows = await Paper.findAll({
    attributes: [
      "id",
      "name",
      "description",
      "created_at",
      [literal("(SELECT COUNT(*) FROM questions q WHERE q.paper_id = Paper.id)"), "question_count"],
      [literal("(SELECT COALESCE(SUM(q.score), 0) FROM questions q WHERE q.paper_id = Paper.id)"), "max_score"],
      [literal("(SELECT COUNT(*) FROM attempts a WHERE a.paper_id = Paper.id OR a.paper_name = Paper.name)"), "attempt_count"],
      [literal("(SELECT MAX(a.started_at) FROM attempts a WHERE a.paper_id = Paper.id OR a.paper_name = Paper.name)"), "last_attempt_at"],
    ],
    // 从名称里提取“第 N 套”的 N 排序，与旧 SQLite 实现保持一致
    order: [
      literal("CAST(SUBSTRING(Paper.name, LOCATE('第', Paper.name) + 1) AS UNSIGNED) ASC"),
      ["id", "ASC"],
    ],
    raw: true,
  });

  res.json(rows.map(row => ({
    ...row,
    question_count: Number(row.question_count) || 0,
    max_score: roundScore(row.max_score),
    attempt_count: Number(row.attempt_count) || 0,
  })));
}));

/* ---------- 某套题的题目（只读详情，管理页也用它） ---------- */
app.get("/api/papers/:id/questions", asyncHandler(async (req, res) => {
  const paperId = Number(req.params.id);
  if (!paperId) return res.status(400).json({ error: "缺少套题 id" });

  const paper = await Paper.findByPk(paperId, { raw: true });
  if (!paper) return res.status(404).json({ error: "套题不存在" });

  const rows = await Question.findAll({
    attributes: ["id", "seq", "type", "score", "material", "stem", "options", "answer", "analysis"],
    where: { paper_id: paperId },
    order: [["seq", "ASC"]],
    raw: true,
  });

  res.json({
    paper,
    questions: rows.map(row => ({
      ...row,
      material: row.material || "",
      options: parseJson(row.options, []),
      answer: parseJson(row.answer, []),
    })),
  });
}));

/* ---------- 导入套题（同名覆盖题目，不影响已有历史快照） ---------- */
app.post("/api/papers/import", asyncHandler(async (req, res) => {
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

  try {
    const result = await sequelize.transaction(async transaction => {
      let paper = await Paper.findOne({ where: { name }, transaction });
      const created = !paper;

      if (paper) {
        if (description) await paper.update({ description }, { transaction });
      } else {
        paper = await Paper.create(
          { name, description, created_at: nowLocal() },
          { transaction }
        );
      }

      const rows = questions.map((q, index) => ({
        paper_id: paper.id,
        seq: index + 1,
        type: q.type,
        score: q.score,
        material: q.material,
        stem: q.stem,
        options: JSON.stringify(q.options),
        answer: JSON.stringify(q.answer),
        analysis: q.analysis,
      }));

      await Question.bulkCreate(rows, {
        updateOnDuplicate: ["type", "score", "material", "stem", "options", "answer", "analysis"],
        transaction,
      });

      // 新文件题数变少时删掉尾部多余题目；历史已存快照，不受影响
      await Question.destroy({
        where: { paper_id: paper.id, seq: { [Op.gt]: questions.length } },
        transaction,
      });

      return { paperId: paper.id, created };
    });

    res.json({
      ok: true,
      paperId: result.paperId,
      name,
      created: result.created,
      questionCount: questions.length,
    });
  } catch (err) {
    return res.status(500).json({ error: "导入失败：" + err.message });
  }
}));

function normalizeQuestions(input) {
  const errors = [];
  if (!Array.isArray(input)) {
    return { questions: [], errors: ["缺少题目数组（questions）"] };
  }
  if (!input.length) {
    return { questions: [], errors: ["题目数组为空"] };
  }

  // case：案例分析题，题面依赖可独立阅读的材料（material），作答可多选；正确答案允许只有 1 个
  const validTypes = new Set(["judge", "single", "multi", "case"]);
  const out = [];

  input.forEach((raw, i) => {
    const n = i + 1;
    const q = raw && typeof raw === "object" ? raw : {};
    const type = String(q.type || "").trim();
    const score = Number(q.score);
    const material = typeof q.material === "string" ? q.material.trim() : "";
    const stem = typeof q.stem === "string" ? q.stem.trim() : "";
    const analysis = typeof q.analysis === "string" ? q.analysis : "";
    const options = Array.isArray(q.options) ? q.options : [];
    const answer = Array.isArray(q.answer) ? q.answer.map(k => String(k).trim()) : [];

    if (!validTypes.has(type)) {
      errors.push(`第 ${n} 题：type 必须是 judge / single / multi / case`);
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
    if (type === "case" && !material) {
      errors.push(`第 ${n} 题：案例分析题必须提供 material（案例材料）`);
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
    if ((type === "judge" || type === "single") && answer.length !== 1) {
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
      material: type === "case" ? material : null,
      stem,
      analysis,
      options: options.map(opt => [String(opt[0]).trim(), String(opt[1])]),
      answer,
    });
  });

  return { questions: out, errors };
}

/* ---------- 删除套题（题目删除，历史快照保留） ---------- */
app.delete("/api/papers/:id", asyncHandler(async (req, res) => {
  const paperId = Number(req.params.id);
  if (!paperId) return res.status(400).json({ error: "缺少套题 id" });

  const paper = await Paper.findByPk(paperId, { raw: true });
  if (!paper) return res.status(404).json({ error: "套题不存在" });

  const attemptCount = await Attempt.count({
    where: {
      [Op.or]: [{ paper_id: paperId }, { paper_name: paper.name }],
    },
  });

  try {
    // questions 随套题级联删除；answers.question_id 置 NULL，快照字段保留
    await Paper.destroy({ where: { id: paperId } });
  } catch (err) {
    return res.status(500).json({ error: "删除失败：" + err.message });
  }

  res.json({ ok: true, deleted: paperId, name: paper.name, keptAttempts: attemptCount });
}));

/* ---------- 开始一次练习 ---------- */
app.post("/api/attempts", asyncHandler(async (req, res) => {
  const paperId = Number(req.body && req.body.paperId);
  if (!paperId) return res.status(400).json({ error: "缺少 paperId" });

  const paper = await Paper.findByPk(paperId, { raw: true });
  if (!paper) return res.status(404).json({ error: "套题不存在" });

  const maxScore = roundScore(await Question.sum("score", { where: { paper_id: paperId } }));

  const attempt = await Attempt.create({
    paper_id: paperId,
    paper_name: paper.name,
    started_at: nowLocal(),
    max_score: maxScore,
  });

  res.json({ attemptId: attempt.id, maxScore });
}));

/* ---------- 提交单题作答（同时写入题目快照） ---------- */
app.post("/api/attempts/:id/answers", asyncHandler(async (req, res) => {
  const attemptId = Number(req.params.id);
  const questionId = Number(req.body && req.body.questionId);
  const chosen = Array.isArray(req.body && req.body.chosen)
    ? req.body.chosen.map(String)
    : [];
  if (!attemptId || !questionId) {
    return res.status(400).json({ error: "缺少 attemptId 或 questionId" });
  }

  const question = await Question.findByPk(questionId, { raw: true });
  if (!question) return res.status(404).json({ error: "题目不存在" });

  const right = parseJson(question.answer, []).slice().sort().join("");
  const user = chosen.slice().sort().join("");
  const isCorrect = right === user && user !== "";
  const earned = isCorrect ? Number(question.score) : 0;

  await sequelize.transaction(async transaction => {
    const payload = {
      attempt_id: attemptId,
      question_id: questionId,
      seq: question.seq,
      type: question.type,
      score: question.score,
      material: question.material,
      stem: question.stem,
      options: question.options,
      answer: question.answer,
      analysis: question.analysis,
      chosen: JSON.stringify(chosen),
      is_correct: isCorrect ? 1 : 0,
      earned,
      answered_at: nowLocal(),
    };

    const existing = await Answer.findOne({
      where: { attempt_id: attemptId, seq: question.seq },
      transaction,
    });

    if (existing) {
      await existing.update(payload, { transaction });
    } else {
      await Answer.create(payload, { transaction });
    }

    await refreshAttempt(attemptId, transaction);
  });

  res.json({ isCorrect, earned });
}));

/* ---------- 结束一次练习：结算成绩并收集错题 ---------- */
app.post("/api/attempts/:id/finish", asyncHandler(async (req, res) => {
  const attemptId = Number(req.params.id);
  if (!attemptId) return res.status(400).json({ error: "缺少记录 id" });

  const row = await sequelize.transaction(async transaction => {
    const attempt = await Attempt.findByPk(attemptId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!attempt) return null;

    // 只结算一次：重复调用不会重复累计错题次数。
    if (!attempt.finished_at) {
      await refreshAttempt(attemptId, transaction);
      await collectWrongAnswers(attempt, transaction);
      await attempt.update({ finished_at: nowLocal() }, { transaction });
    }

    return Attempt.findByPk(attemptId, { raw: true, transaction });
  });

  if (!row) return res.status(404).json({ error: "记录不存在" });
  res.json(row);
}));

/* 把本次已答错题写入错题集；按套题名 + 题号去重，多次做错累计次数。 */
async function collectWrongAnswers(attempt, transaction) {
  const rows = await Answer.findAll({
    where: { attempt_id: attempt.id, is_correct: 0 },
    order: [["seq", "ASC"]],
    raw: true,
    transaction,
  });
  const now = nowLocal();

  for (const row of rows) {
    const snapshot = {
      paper_id: attempt.paper_id,
      type: row.type,
      score: row.score,
      material: row.material,
      stem: row.stem,
      options: row.options,
      answer: row.answer,
      analysis: row.analysis,
      last_chosen: row.chosen || JSON.stringify([]),
    };
    const existing = await WrongQuestion.findOne({
      where: { paper_name: attempt.paper_name, seq: row.seq },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (existing) {
      await existing.update({
        ...snapshot,
        wrong_count: Number(existing.wrong_count) + 1,
        mastered: 0,
        mastered_at: null,
        last_wrong_at: now,
      }, { transaction });
    } else {
      await WrongQuestion.create({
        ...snapshot,
        paper_name: attempt.paper_name,
        seq: row.seq,
        wrong_count: 1,
        mastered: 0,
        first_wrong_at: now,
        last_wrong_at: now,
      }, { transaction });
    }
  }
}

async function refreshAttempt(attemptId, transaction) {
  const stats = await Answer.findOne({
    attributes: [
      [fn("COALESCE", fn("SUM", col("earned")), 0), "total_score"],
      [fn("COUNT", col("id")), "answered"],
      [fn("COALESCE", fn("SUM", col("is_correct")), 0), "correct"],
    ],
    where: { attempt_id: attemptId },
    raw: true,
    transaction,
  });

  await Attempt.update(
    {
      total_score: roundScore(stats.total_score),
      answered: Number(stats.answered) || 0,
      correct: Number(stats.correct) || 0,
    },
    { where: { id: attemptId }, transaction }
  );
}

/* ---------- 历史记录列表（全部返回，前端按套题筛选） ---------- */
app.get("/api/attempts", asyncHandler(async (req, res) => {
  const [rows, papers] = await Promise.all([
    Attempt.findAll({ order: [["id", "DESC"]], raw: true }),
    Paper.findAll({ attributes: ["name"], raw: true }),
  ]);
  const existingNames = new Set(papers.map(paper => paper.name));

  res.json(rows.map(row => ({
    ...row,
    paper_exists: existingNames.has(row.paper_name) ? 1 : 0,
  })));
}));

/* ---------- 删除一条历史记录 ---------- */
app.delete("/api/attempts/:id", asyncHandler(async (req, res) => {
  const attemptId = Number(req.params.id);
  if (!attemptId) return res.status(400).json({ error: "缺少记录 id" });

  const removed = await sequelize.transaction(async transaction => {
    await Answer.destroy({ where: { attempt_id: attemptId }, transaction });
    return Attempt.destroy({ where: { id: attemptId }, transaction });
  });

  if (!removed) return res.status(404).json({ error: "记录不存在" });
  res.json({ ok: true, deleted: attemptId });
}));

/* ---------- 历史记录详情（纯读快照，套题删了也完整） ---------- */
app.get("/api/attempts/:id", asyncHandler(async (req, res) => {
  const attempt = await Attempt.findByPk(req.params.id, { raw: true });
  if (!attempt) return res.status(404).json({ error: "记录不存在" });

  const [paper, detail] = await Promise.all([
    attempt.paper_name
      ? Paper.findOne({ where: { name: attempt.paper_name }, attributes: ["id"], raw: true })
      : null,
    Answer.findAll({
      attributes: [
        "seq", "type", "score", "material", "stem", "options", "answer", "analysis",
        "chosen", "is_correct", "earned", "answered_at",
      ],
      where: { attempt_id: attempt.id },
      order: [["seq", "ASC"]],
      raw: true,
    }),
  ]);

  res.json({
    // current_paper_id 供“继续作答”重新拉取题目：删除后重新导入同名套题时
    // attempts.paper_id 已被置空，这里按套题名重新解析。
    attempt: { ...attempt, paper_exists: paper ? 1 : 0, current_paper_id: paper ? paper.id : null },
    detail: detail.map(row => ({
      ...row,
      material: row.material || "",
      options: parseJson(row.options, []),
      answer: parseJson(row.answer, []),
      chosen: row.chosen ? parseJson(row.chosen, []) : [],
    })),
  });
}));

/* ================= 错题集 ================= */

function sessionSummary(row) {
  return {
    id: row.id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    total: Number(row.total) || 0,
    answered: Number(row.answered) || 0,
    correct: Number(row.correct) || 0,
  };
}

function decorateWrongQuestion(row, paperNames) {
  return {
    ...row,
    material: row.material || "",
    options: parseJson(row.options, []),
    answer: parseJson(row.answer, []),
    last_chosen: row.last_chosen ? parseJson(row.last_chosen, []) : [],
    mastered: Number(row.mastered) ? 1 : 0,
    paper_exists: paperNames.has(row.paper_name) ? 1 : 0,
  };
}

/* 错题列表 + 待复习/已掌握统计 + 可续做的练习会话 */
app.get("/api/wrong-questions", asyncHandler(async (req, res) => {
  const [rows, papers, active] = await Promise.all([
    WrongQuestion.findAll({
      order: [["mastered", "ASC"], ["last_wrong_at", "DESC"], ["id", "DESC"]],
      raw: true,
    }),
    Paper.findAll({ attributes: ["name"], raw: true }),
    ReviewSession.findOne({
      where: { finished_at: null },
      order: [["id", "DESC"]],
      raw: true,
    }),
  ]);
  const paperNames = new Set(papers.map(paper => paper.name));
  const items = rows.map(row => decorateWrongQuestion(row, paperNames));
  const mastered = items.filter(item => item.mastered).length;

  res.json({
    items,
    stats: { total: items.length, active: items.length - mastered, mastered },
    active_session: active ? sessionSummary(active) : null,
  });
}));

/* 随机错题练习：默认复用未完成会话；restart=true 时丢弃旧进度重新洗牌。 */
app.post("/api/wrong-questions/review-sessions", asyncHandler(async (req, res) => {
  const restart = !!(req.body && req.body.restart);
  const existing = await ReviewSession.findOne({
    where: { finished_at: null },
    order: [["id", "DESC"]],
    raw: true,
  });

  if (existing && !restart) {
    return res.json(await buildReviewPayload(existing.id));
  }

  const sessionId = await sequelize.transaction(async transaction => {
    if (existing) {
      await ReviewSession.destroy({ where: { id: existing.id }, transaction });
    }
    const rows = await WrongQuestion.findAll({
      where: { mastered: 0 },
      order: [["id", "ASC"]],
      raw: true,
      transaction,
    });
    if (!rows.length) return null;

    // 随机顺序固定写入会话，续做时不再变化。
    const shuffled = shuffleRows(rows);
    const session = await ReviewSession.create({
      started_at: nowLocal(),
      total: shuffled.length,
    }, { transaction });
    await ReviewItem.bulkCreate(shuffled.map((row, index) => ({
      session_id: session.id,
      wrong_question_id: row.id,
      position: index + 1,
    })), { transaction });
    return session.id;
  });

  if (!sessionId) return res.status(400).json({ error: "暂无待复习的错题" });
  res.json(await buildReviewPayload(sessionId));
}));

function shuffleRows(rows) {
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows;
}

async function buildReviewPayload(sessionId, transaction) {
  const session = await ReviewSession.findByPk(sessionId, { raw: true, transaction });
  if (!session) return null;

  const items = await ReviewItem.findAll({
    where: { session_id: sessionId },
    order: [["position", "ASC"]],
    raw: true,
    transaction,
  });
  const ids = items.map(item => item.wrong_question_id);
  const rows = ids.length
    ? await WrongQuestion.findAll({ where: { id: { [Op.in]: ids } }, raw: true, transaction })
    : [];
  const byId = new Map(rows.map(row => [Number(row.id), row]));

  return {
    session: sessionSummary(session),
    items: items.map(item => {
      const row = byId.get(Number(item.wrong_question_id));
      return {
        wrong_question_id: row.id,
        position: item.position,
        paper_id: row.paper_id,
        paper_name: row.paper_name,
        seq: row.seq,
        type: row.type,
        score: row.score,
        material: row.material || "",
        stem: row.stem,
        options: parseJson(row.options, []),
        answer: parseJson(row.answer, []),
        analysis: row.analysis,
        wrong_count: Number(row.wrong_count) || 0,
        mastered: Number(row.mastered) ? 1 : 0,
        chosen: item.chosen ? parseJson(item.chosen, []) : [],
        is_correct: item.is_correct === null ? null : Number(item.is_correct),
        answered_at: item.answered_at,
      };
    }),
  };
}

/* 读取一次错题练习（含随机顺序与已作答进度） */
app.get("/api/wrong-questions/review-sessions/:id", asyncHandler(async (req, res) => {
  const sessionId = Number(req.params.id);
  if (!sessionId) return res.status(400).json({ error: "缺少练习 id" });
  const payload = await buildReviewPayload(sessionId);
  if (!payload) return res.status(404).json({ error: "练习不存在" });
  res.json(payload);
}));

/* 提交一道错题：答对立即标记已掌握；答错次数 +1 并保留待复习。 */
app.post("/api/wrong-questions/review-sessions/:id/answers", asyncHandler(async (req, res) => {
  const sessionId = Number(req.params.id);
  const wrongQuestionId = Number(req.body && req.body.wrongQuestionId);
  const chosen = Array.isArray(req.body && req.body.chosen)
    ? req.body.chosen.map(String)
    : [];
  if (!sessionId || !wrongQuestionId) {
    return res.status(400).json({ error: "缺少练习 id 或错题 id" });
  }
  if (!chosen.length) return res.status(400).json({ error: "请先选择答案" });

  const outcome = await sequelize.transaction(async transaction => {
    const session = await ReviewSession.findByPk(sessionId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!session) return { status: 404, error: "练习不存在" };
    if (session.finished_at) return { status: 409, error: "本次错题练习已结束" };

    const item = await ReviewItem.findOne({
      where: { session_id: sessionId, wrong_question_id: wrongQuestionId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!item) return { status: 404, error: "题目不在本次练习中" };
    if (item.is_correct !== null) return { status: 409, error: "本题已提交" };

    const row = await WrongQuestion.findByPk(wrongQuestionId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!row) return { status: 404, error: "错题不存在" };

    const right = parseJson(row.answer, []).slice().sort().join("");
    const user = chosen.slice().sort().join("");
    const isCorrect = right === user;
    const now = nowLocal();
    let wrongCount = Number(row.wrong_count) || 0;

    await item.update({
      chosen: JSON.stringify(chosen),
      is_correct: isCorrect ? 1 : 0,
      answered_at: now,
    }, { transaction });

    if (isCorrect) {
      await row.update({ mastered: 1, mastered_at: now }, { transaction });
    } else {
      wrongCount += 1;
      await row.update({
        mastered: 0,
        mastered_at: null,
        last_chosen: JSON.stringify(chosen),
        wrong_count: wrongCount,
        last_wrong_at: now,
      }, { transaction });
    }

    const answered = Number(session.answered) + 1;
    const correct = Number(session.correct) + (isCorrect ? 1 : 0);
    const finishedAt = answered >= Number(session.total) ? now : session.finished_at;
    await session.update(
      { answered, correct, finished_at: finishedAt },
      { transaction }
    );

    return {
      status: 200,
      isCorrect,
      wrongCount,
      mastered: isCorrect ? 1 : 0,
      correct_answer: parseJson(row.answer, []),
      analysis: row.analysis,
      session: sessionSummary({ ...session.toJSON(), answered, correct, finished_at: finishedAt }),
    };
  });

  if (outcome.status !== 200) {
    return res.status(outcome.status).json({ error: outcome.error });
  }
  res.json(outcome);
}));

/* 结束错题练习；未答完也允许结束，未答题目保留待复习。 */
app.post("/api/wrong-questions/review-sessions/:id/finish", asyncHandler(async (req, res) => {
  const sessionId = Number(req.params.id);
  if (!sessionId) return res.status(400).json({ error: "缺少练习 id" });

  const session = await ReviewSession.findByPk(sessionId);
  if (!session) return res.status(404).json({ error: "练习不存在" });
  if (!session.finished_at) {
    await session.update({ finished_at: nowLocal() });
  }
  res.json({ ok: true, session: sessionSummary(session) });
}));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "服务器内部错误" });
});

module.exports = app;

// 本地运行（node server.js）时监听端口
if (require.main === module) {
  sequelize.authenticate()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`服务已启动：http://localhost:${PORT}`);
      });
    })
    .catch(err => {
      console.error("数据库连接失败：" + err.message);
      process.exit(1);
    });
}
