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

module.exports = { Paper, Question, Attempt, Answer };
