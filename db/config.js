const path = require("path");

require("dotenv").config({
  path: process.env.ENV_FILE || path.join(__dirname, "..", ".env"),
});

function parseAddress(value) {
  const raw = String(value || "127.0.0.1:3306").trim();
  const idx = raw.lastIndexOf(":");
  if (idx === -1) return { host: raw || "127.0.0.1", port: 3306 };
  return {
    host: raw.slice(0, idx) || "127.0.0.1",
    port: Number(raw.slice(idx + 1)) || 3306,
  };
}

const { host, port } = parseAddress(process.env.MYSQL_ADDRESS);

module.exports = {
  host,
  port,
  username: process.env.MYSQL_USERNAME || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "edu_quiz",
  timezone: process.env.APP_TIMEZONE || "+08:00",
};
