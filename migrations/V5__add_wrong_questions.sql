-- 错题集：保存完整题目快照，独立于 questions / attempts / answers。
-- 删除套题或答题历史后，错题仍可继续复习。

CREATE TABLE IF NOT EXISTS wrong_questions (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  paper_id      INT UNSIGNED NULL DEFAULT NULL,
  paper_name    VARCHAR(100) NOT NULL,
  seq           INT UNSIGNED NOT NULL,
  `type`        VARCHAR(16) NOT NULL,
  score         DOUBLE NOT NULL,
  material      TEXT NULL,
  stem          TEXT NOT NULL,
  `options`     TEXT NOT NULL,
  `answer`      TEXT NOT NULL,
  analysis      TEXT NOT NULL,
  last_chosen   TEXT NULL,
  wrong_count   INT UNSIGNED NOT NULL DEFAULT 1,
  mastered      TINYINT(1) NOT NULL DEFAULT 0,
  first_wrong_at DATETIME NOT NULL,
  last_wrong_at  DATETIME NOT NULL,
  mastered_at   DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_wrong_paper_seq (paper_name, seq),
  KEY idx_wrong_mastered (mastered),
  KEY idx_wrong_paper (paper_id),
  CONSTRAINT fk_wrong_questions_paper FOREIGN KEY (paper_id)
    REFERENCES papers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 错题练习会话：保存随机顺序与进度，支持中断后续做。
CREATE TABLE IF NOT EXISTS review_sessions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  started_at  DATETIME NOT NULL,
  finished_at DATETIME NULL DEFAULT NULL,
  total       INT UNSIGNED NOT NULL DEFAULT 0,
  answered    INT UNSIGNED NOT NULL DEFAULT 0,
  correct     INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_review_sessions_finished (finished_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS review_items (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id        INT UNSIGNED NOT NULL,
  wrong_question_id INT UNSIGNED NOT NULL,
  position          INT UNSIGNED NOT NULL,
  chosen            TEXT NULL,
  is_correct        TINYINT(1) NULL DEFAULT NULL,
  answered_at       DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_review_items_question (session_id, wrong_question_id),
  UNIQUE KEY uk_review_items_position (session_id, position),
  CONSTRAINT fk_review_items_session FOREIGN KEY (session_id)
    REFERENCES review_sessions (id) ON DELETE CASCADE,
  CONSTRAINT fk_review_items_wrong FOREIGN KEY (wrong_question_id)
    REFERENCES wrong_questions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 用已完成的整套历史回填错题集：同一套题同一题号只保留一条，
-- 错误次数按历史错误作答累计，last_chosen 以最后一次错误作答为准。
INSERT INTO wrong_questions
  (paper_id, paper_name, seq, `type`, score, material, stem, `options`, `answer`, analysis,
   last_chosen, wrong_count, mastered, first_wrong_at, last_wrong_at)
SELECT
  t.paper_id, t.paper_name, a.seq, a.`type`, a.score, a.material, a.stem,
  a.`options`, a.`answer`, a.analysis,
  COALESCE(a.chosen, '[]'), 1, 0, a.answered_at, a.answered_at
FROM answers a
JOIN attempts t ON t.id = a.attempt_id
WHERE t.finished_at IS NOT NULL AND a.is_correct = 0
ORDER BY a.answered_at ASC, a.id ASC
ON DUPLICATE KEY UPDATE
  paper_id = VALUES(paper_id),
  `type` = VALUES(`type`),
  score = VALUES(score),
  material = VALUES(material),
  stem = VALUES(stem),
  `options` = VALUES(`options`),
  `answer` = VALUES(`answer`),
  analysis = VALUES(analysis),
  last_chosen = VALUES(last_chosen),
  wrong_count = wrong_count + 1,
  mastered = 0,
  mastered_at = NULL,
  last_wrong_at = VALUES(last_wrong_at);
