-- 教育公共基础笔试练习应用：MySQL 5.7 初始结构
-- 注意：answers 保存作答当时的完整题目快照，历史详情不依赖 questions。

CREATE TABLE IF NOT EXISTS papers (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(100) NOT NULL,
  description TEXT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_papers_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS questions (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  paper_id  INT UNSIGNED NOT NULL,
  seq       INT UNSIGNED NOT NULL,
  `type`    VARCHAR(16) NOT NULL,
  score     DOUBLE NOT NULL,
  stem      TEXT NOT NULL,
  `options` TEXT NOT NULL,
  `answer`  TEXT NOT NULL,
  analysis  TEXT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_questions_paper_seq (paper_id, seq),
  KEY idx_questions_paper (paper_id),
  CONSTRAINT fk_questions_paper FOREIGN KEY (paper_id)
    REFERENCES papers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS attempts (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  paper_id    INT UNSIGNED NULL DEFAULT NULL,
  paper_name  VARCHAR(100) NOT NULL DEFAULT '',
  started_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL DEFAULT NULL,
  total_score DOUBLE NOT NULL DEFAULT 0,
  max_score   DOUBLE NOT NULL DEFAULT 0,
  answered    INT UNSIGNED NOT NULL DEFAULT 0,
  correct     INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_attempts_paper (paper_id),
  KEY idx_attempts_paper_name (paper_name),
  CONSTRAINT fk_attempts_paper FOREIGN KEY (paper_id)
    REFERENCES papers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS answers (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  attempt_id  INT UNSIGNED NOT NULL,
  question_id INT UNSIGNED NULL DEFAULT NULL,
  seq         INT UNSIGNED NOT NULL DEFAULT 0,
  `type`      VARCHAR(16) NOT NULL DEFAULT '',
  score       DOUBLE NOT NULL DEFAULT 0,
  stem        TEXT NOT NULL,
  `options`   TEXT NOT NULL,
  `answer`    TEXT NOT NULL,
  analysis    TEXT NOT NULL,
  chosen      TEXT NULL,
  is_correct  TINYINT(1) NOT NULL DEFAULT 0,
  earned      DOUBLE NOT NULL DEFAULT 0,
  answered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_answers_attempt_seq (attempt_id, seq),
  KEY idx_answers_attempt (attempt_id),
  KEY idx_answers_question (question_id),
  CONSTRAINT fk_answers_attempt FOREIGN KEY (attempt_id)
    REFERENCES attempts (id) ON DELETE CASCADE,
  CONSTRAINT fk_answers_question FOREIGN KEY (question_id)
    REFERENCES questions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
