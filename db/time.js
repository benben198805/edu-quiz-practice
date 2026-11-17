const OFFSET_MS = 8 * 60 * 60 * 1000;

/* 固定输出北京时间 "YYYY-MM-DD HH:mm:ss"，不依赖容器/MySQL 的时区设置。 */
function nowLocal() {
  return new Date(Date.now() + OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

module.exports = { nowLocal };
