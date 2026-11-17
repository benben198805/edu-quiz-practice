const { Sequelize } = require("sequelize");
const config = require("./config");

const sequelize = new Sequelize(config.database, config.username, config.password, {
  host: config.host,
  port: config.port,
  dialect: "mysql",
  logging: false,
  timezone: config.timezone,
  dialectOptions: {
    charset: "utf8mb4",
    // Sequelize 默认会把 DATETIME 转成 Date（JSON 输出成 UTC ISO）。
    // 这里直接返回 "YYYY-MM-DD HH:mm:ss" 字符串，保持旧版 API 的时间格式。
    typeCast(field, next) {
      if (field.type === "DATETIME" || field.type === "TIMESTAMP" || field.type === "DATE") {
        return field.string();
      }
      return next();
    },
  },
  define: {
    charset: "utf8mb4",
    collate: "utf8mb4_unicode_ci",
    timestamps: false,
    underscored: true,
  },
  pool: {
    max: 10,
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
});

module.exports = sequelize;
