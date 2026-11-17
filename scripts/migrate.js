#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");
const config = require("../db/config");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const SHOW_STATUS = process.argv.includes("--status");

function versionOf(file) {
  return Number(file.match(/^V(\d+)__/)[1]);
}

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(file => /^V\d+__.+\.sql$/.test(file))
    .sort((a, b) => versionOf(a) - versionOf(b))
    .map(file => {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      return {
        file,
        version: String(versionOf(file)),
        description: file.replace(/^V\d+__/, "").replace(/\.sql$/, "").replace(/_/g, " "),
        sql,
        checksum: crypto.createHash("sha256").update(sql).digest("hex"),
      };
    });
}

function connectionOptions(withDatabase) {
  const options = {
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    charset: "utf8mb4",
    multipleStatements: true,
  };
  if (withDatabase) options.database = config.database;
  return options;
}

function quoteId(name) {
  return "`" + String(name).replace(/`/g, "``") + "`";
}

async function ensureDatabase(conn) {
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS ${quoteId(config.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
}

async function ensureHistory(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     VARCHAR(32) NOT NULL,
      description VARCHAR(200) NOT NULL,
      checksum    CHAR(64) NOT NULL,
      applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function main() {
  const serverConn = await mysql.createConnection(connectionOptions(false));
  try {
    await ensureDatabase(serverConn);
  } finally {
    await serverConn.end();
  }

  const conn = await mysql.createConnection(connectionOptions(true));
  try {
    await ensureHistory(conn);

    const [rows] = await conn.query(
      "SELECT version, description, checksum, applied_at FROM schema_migrations ORDER BY version"
    );
    const applied = new Map(rows.map(row => [String(row.version), row]));
    const migrations = listMigrations();

    if (!migrations.length) {
      console.log("没有迁移脚本。");
      return;
    }

    if (SHOW_STATUS) {
      for (const m of migrations) {
        const row = applied.get(m.version);
        if (!row) {
          console.log(`PENDING  V${m.version} ${m.description}`);
        } else if (row.checksum !== m.checksum) {
          console.log(`CHANGED  V${m.version} ${m.description}（文件已被修改）`);
        } else {
          console.log(`APPLIED  V${m.version} ${m.description} @ ${row.applied_at}`);
        }
      }
      const pending = migrations.filter(m => !applied.has(m.version)).length;
      console.log(pending ? `\n${pending} 个待执行迁移。` : "\n数据库已是最新。");
      return;
    }

    let count = 0;
    for (const m of migrations) {
      const row = applied.get(m.version);
      if (row) {
        if (row.checksum !== m.checksum) {
          throw new Error(
            `迁移 V${m.version} 已执行，但文件内容已变化（checksum 不一致）。` +
            `请恢复原文件，或新增 V${Number(m.version) + 1}__*.sql 做变更。`
          );
        }
        continue;
      }

      console.log(`执行 V${m.version} ${m.description} ...`);
      await conn.beginTransaction();
      try {
        await conn.query(m.sql);
        await conn.query(
          "INSERT INTO schema_migrations (version, description, checksum) VALUES (?, ?, ?)",
          [m.version, m.description, m.checksum]
        );
        await conn.commit();
        count++;
      } catch (err) {
        await conn.rollback();
        throw new Error(`迁移 V${m.version} 失败：${err.message}`);
      }
    }

    console.log(count ? `完成，执行了 ${count} 个迁移。` : "数据库已是最新。");
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
