const { DataTypes } = require("sequelize");
const sequelize = require("./connection");

/*
 * 时间列在 MySQL 中是 DATETIME，这里用 STRING 映射：
 * 连接层的 typeCast 返回 "YYYY-MM-DD HH:mm:ss" 字符串，
 * 应用层也统一写入同样格式的北京时间字符串。
 */
function timestamp(allowNull = false) {
  return { type: DataTypes.STRING(19), allowNull };
}

const Paper = sequelize.define("Paper", {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
  description: { type: DataTypes.TEXT, allowNull: true },
  created_at: timestamp(),
}, {
  tableName: "papers",
  timestamps: false,
});

const Question = sequelize.define("Question", {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  paper_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  seq: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  type: { type: DataTypes.STRING(16), allowNull: false },
  score: { type: DataTypes.DOUBLE, allowNull: false },
  /* 案例分析题共用材料；其他题型为 NULL */
  material: { type: DataTypes.TEXT, allowNull: true },
  stem: { type: DataTypes.TEXT, allowNull: false },
  options: { type: DataTypes.TEXT, allowNull: false },
  answer: { type: DataTypes.TEXT, allowNull: false },
  analysis: { type: DataTypes.TEXT, allowNull: false },
}, {
  tableName: "questions",
  timestamps: false,
});

const Attempt = sequelize.define("Attempt", {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  paper_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  paper_name: { type: DataTypes.STRING(100), allowNull: false, defaultValue: "" },
  started_at: timestamp(),
  finished_at: timestamp(true),
  total_score: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
  max_score: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
  answered: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  correct: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
}, {
  tableName: "attempts",
  timestamps: false,
});

const Answer = sequelize.define("Answer", {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  attempt_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  question_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  seq: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  type: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "" },
  score: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
  /* 案例材料快照，历史详情不依赖 questions */
  material: { type: DataTypes.TEXT, allowNull: true },
  stem: { type: DataTypes.TEXT, allowNull: false },
  options: { type: DataTypes.TEXT, allowNull: false },
  answer: { type: DataTypes.TEXT, allowNull: false },
  analysis: { type: DataTypes.TEXT, allowNull: false },
  chosen: { type: DataTypes.TEXT, allowNull: true },
  is_correct: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
  earned: { type: DataTypes.DOUBLE, allowNull: false, defaultValue: 0 },
  answered_at: timestamp(),
}, {
  tableName: "answers",
  timestamps: false,
});

Paper.hasMany(Question, { foreignKey: "paper_id", as: "questions" });
Question.belongsTo(Paper, { foreignKey: "paper_id", as: "paper" });

Paper.hasMany(Attempt, { foreignKey: "paper_id", as: "attempts" });
Attempt.belongsTo(Paper, { foreignKey: "paper_id", as: "paper" });

Attempt.hasMany(Answer, { foreignKey: "attempt_id", as: "answers" });
Answer.belongsTo(Attempt, { foreignKey: "attempt_id", as: "attempt" });

Question.hasMany(Answer, { foreignKey: "question_id", as: "answers" });
Answer.belongsTo(Question, { foreignKey: "question_id", as: "question" });

/* 错题集：独立快照，不依赖 questions / answers，删套题或历史后仍可复习。 */
const WrongQuestion = sequelize.define("WrongQuestion", {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  paper_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  paper_name: { type: DataTypes.STRING(100), allowNull: false },
  seq: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  type: { type: DataTypes.STRING(16), allowNull: false },
  score: { type: DataTypes.DOUBLE, allowNull: false },
  material: { type: DataTypes.TEXT, allowNull: true },
  stem: { type: DataTypes.TEXT, allowNull: false },
  options: { type: DataTypes.TEXT, allowNull: false },
  answer: { type: DataTypes.TEXT, allowNull: false },
  analysis: { type: DataTypes.TEXT, allowNull: false },
  last_chosen: { type: DataTypes.TEXT, allowNull: true },
  wrong_count: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
  mastered: { type: DataTypes.TINYINT, allowNull: false, defaultValue: 0 },
  first_wrong_at: timestamp(),
  last_wrong_at: timestamp(),
  mastered_at: timestamp(true),
}, {
  tableName: "wrong_questions",
  timestamps: false,
});

/* 一次错题练习；finished_at 为空表示可继续。 */
const ReviewSession = sequelize.define("ReviewSession", {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  started_at: timestamp(),
  finished_at: timestamp(true),
  total: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  answered: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
  correct: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
}, {
  tableName: "review_sessions",
  timestamps: false,
});

/* 会话中的题目与随机顺序；is_correct 为 NULL 表示本次尚未作答。 */
const ReviewItem = sequelize.define("ReviewItem", {
  id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
  session_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  wrong_question_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  position: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
  chosen: { type: DataTypes.TEXT, allowNull: true },
  is_correct: { type: DataTypes.TINYINT, allowNull: true },
  answered_at: timestamp(true),
}, {
  tableName: "review_items",
  timestamps: false,
});

Paper.hasMany(WrongQuestion, { foreignKey: "paper_id", as: "wrong_questions" });
WrongQuestion.belongsTo(Paper, { foreignKey: "paper_id", as: "paper" });

ReviewSession.hasMany(ReviewItem, { foreignKey: "session_id", as: "items" });
ReviewItem.belongsTo(ReviewSession, { foreignKey: "session_id", as: "session" });
WrongQuestion.hasMany(ReviewItem, { foreignKey: "wrong_question_id", as: "review_items" });
ReviewItem.belongsTo(WrongQuestion, { foreignKey: "wrong_question_id", as: "wrong_question" });

module.exports = { Paper, Question, Attempt, Answer, WrongQuestion, ReviewSession, ReviewItem };
