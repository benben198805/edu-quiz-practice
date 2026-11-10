const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

/*
 * Vercel 等 serverless 运行目录只读，只能写 /tmp。
 * 因此把随仓库打包的 quiz.db 在冷启动时复制到 /tmp 再打开；
 * 注意：/tmp 是按实例隔离且冷启动会重置，写入不会跨实例共享。
 * 需要持久化时用 QUIZ_DB_PATH 指向可写磁盘，或改用托管数据库。
 */
const IS_SERVERLESS = Boolean(process.env.VERCEL);
const BUNDLED_DB = path.join(__dirname, "quiz.db");
const DB_PATH = process.env.QUIZ_DB_PATH
  || (IS_SERVERLESS ? path.join("/tmp", "quiz.db") : BUNDLED_DB);

function openDB() {
  if (IS_SERVERLESS && !process.env.QUIZ_DB_PATH && !fs.existsSync(DB_PATH)) {
    if (!fs.existsSync(BUNDLED_DB)) {
      throw new Error(`数据库文件缺失：${BUNDLED_DB}（需随部署包一起上传）`);
    }
    fs.copyFileSync(BUNDLED_DB, DB_PATH);
  }
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}

/*
 * answers 表存的是“作答当时的题目快照”：
 * 删除套题会连 questions 一起删掉，但历史记录仍要能完整还原原题、原解析。
 * 因此题干/选项/答案/解析/分值全部在提交作答时复制一份到这里，
 * answers.question_id 仅作为“当时那道题”的弱引用（题目被删后置 NULL）。
 */
const SNAPSHOT_DDL = `
  seq       INTEGER NOT NULL DEFAULT 0,
  type      TEXT    NOT NULL DEFAULT '',
  score     REAL    NOT NULL DEFAULT 0,
  stem      TEXT    NOT NULL DEFAULT '',
  options   TEXT    NOT NULL DEFAULT '[]',
  answer    TEXT    NOT NULL DEFAULT '[]',
  analysis  TEXT    NOT NULL DEFAULT ''
`;

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS papers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL UNIQUE,
      description TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS questions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id  INTEGER NOT NULL,
      seq       INTEGER NOT NULL,
      type      TEXT    NOT NULL,
      score     REAL    NOT NULL,
      stem      TEXT    NOT NULL,
      options   TEXT    NOT NULL,
      answer    TEXT    NOT NULL,
      analysis  TEXT    NOT NULL,
      UNIQUE (paper_id, seq),
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attempts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id    INTEGER,
      paper_name  TEXT    NOT NULL DEFAULT '',
      started_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      finished_at TEXT,
      total_score REAL    NOT NULL DEFAULT 0,
      max_score   REAL    NOT NULL DEFAULT 0,
      answered    INTEGER NOT NULL DEFAULT 0,
      correct     INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS answers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      attempt_id  INTEGER NOT NULL,
      question_id INTEGER,
      ${SNAPSHOT_DDL},
      chosen      TEXT,
      is_correct  INTEGER NOT NULL DEFAULT 0,
      earned      REAL    NOT NULL DEFAULT 0,
      answered_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      FOREIGN KEY (attempt_id)  REFERENCES attempts(id)  ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE SET NULL,
      UNIQUE (attempt_id, question_id)
    );
  `);

  // 兼容旧库：如果 questions 表是旧结构（没有 paper_id），做一次迁移
  const qCols = columnNames(db, "questions");
  if (!qCols.includes("paper_id")) {
    console.log("检测到旧版 questions 表，正在迁移到多套题结构…");
    db.exec(`ALTER TABLE questions ADD COLUMN paper_id INTEGER;`);
    // 旧数据统一归到“进阶版第10套”
    let paper = db.prepare("SELECT id FROM papers WHERE name = ?").get("进阶版第10套");
    if (!paper) {
      const info = db.prepare("INSERT INTO papers (name, description) VALUES (?, ?)")
        .run("进阶版第10套", "教育公共基础笔试 · 进阶版第10套");
      paper = { id: info.lastInsertRowid };
    }
    db.prepare("UPDATE questions SET paper_id = ? WHERE paper_id IS NULL").run(paper.id);
  }

  migrateAttemptPaperName(db);
  migrateAnswerSnapshots(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_answers_attempt ON answers(attempt_id);
    CREATE INDEX IF NOT EXISTS idx_questions_paper ON questions(paper_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_paper  ON attempts(paper_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_paper_name ON attempts(paper_name);
  `);
}

/* attempts 增加 paper_name 快照：套题删除后历史列表仍能显示套题名、按套题筛选 */
function migrateAttemptPaperName(db) {
  if (!columnNames(db, "attempts").includes("paper_name")) {
    db.exec(`ALTER TABLE attempts ADD COLUMN paper_name TEXT NOT NULL DEFAULT ''`);
  }
  db.prepare(`
    UPDATE attempts
    SET paper_name = (SELECT p.name FROM papers p WHERE p.id = attempts.paper_id)
    WHERE (paper_name IS NULL OR paper_name = '') AND paper_id IS NOT NULL
  `).run();
}

/* 旧库 answers 没有快照列：重建表并用现有 questions 回填 */
function migrateAnswerSnapshots(db) {
  if (columnNames(db, "answers").includes("stem")) return;

  console.log("检测到旧版 answers 表，正在重建并回填题目快照…");
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE answers_new (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          attempt_id  INTEGER NOT NULL,
          question_id INTEGER,
          ${SNAPSHOT_DDL},
          chosen      TEXT,
          is_correct  INTEGER NOT NULL DEFAULT 0,
          earned      REAL    NOT NULL DEFAULT 0,
          answered_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
          FOREIGN KEY (attempt_id)  REFERENCES attempts(id)  ON DELETE CASCADE,
          FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE SET NULL,
          UNIQUE (attempt_id, question_id)
        );

        INSERT INTO answers_new
          (id, attempt_id, question_id, seq, type, score, stem, options, answer, analysis,
           chosen, is_correct, earned, answered_at)
        SELECT a.id, a.attempt_id, a.question_id,
               COALESCE(q.seq, 0), COALESCE(q.type, ''), COALESCE(q.score, 0),
               COALESCE(q.stem, '（题目内容缺失）'), COALESCE(q.options, '[]'),
               COALESCE(q.answer, '[]'), COALESCE(q.analysis, ''),
               a.chosen, a.is_correct, a.earned, a.answered_at
        FROM answers a
        LEFT JOIN questions q ON q.id = a.question_id;

        DROP TABLE answers;
        ALTER TABLE answers_new RENAME TO answers;
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }

  const broken = db.pragma("foreign_key_check");
  if (broken.length) console.warn("⚠️ 外键检查发现异常：", broken);
}

if (require.main === module) {
  const db = openDB();
  initSchema(db);
  db.close();
  console.log("数据库与表已创建/迁移：", DB_PATH);
}

module.exports = { openDB, initSchema, DB_PATH };
