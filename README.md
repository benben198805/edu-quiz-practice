# EduQuiz Practice

教育公共基础笔试模拟练习应用。Express + Sequelize + MySQL 5.7，前端为单文件静态页面。

## 本地运行

```bash
# Intel / Linux
docker compose up -d mysql     # MySQL 5.7，root 空密码，库 edu_quiz

# Apple Silicon（mysql:5.7 只有 amd64 镜像，需 Rosetta）
colima --profile mysql57 start --vz-rosetta
docker --context colima-mysql57 compose up -d mysql

npm install
npm run db:migrate             # 建库、建表、导入旧 SQLite 数据
./restart.sh                   # 自动迁移后启动，http://127.0.0.1:3000
```

- `npm run db:status` 查看迁移状态。
- `npm start` 只启动、不迁移；`npm run dev` 迁移后前台启动。
- 配置见 `.env.example`，本地可复制为 `.env`。
- Apple Silicon 请用上面的 Rosetta profile；默认 QEMU 下 `mysql:5.7` 可能启动崩溃。

## 数据库迁移

采用 Flyway 风格的版本化 SQL：

- `migrations/V1__init.sql`：MySQL 5.7 表结构。
- `migrations/V2__seed_papers.sql`：20 套题、1800 题。
- `migrations/V3__seed_attempts.sql`：4 次历史、360 条作答快照。
- 执行记录写入 `schema_migrations`，已执行脚本带 SHA-256 校验和。

新增结构变更时新建 `migrations/V4__xxx.sql`，不要修改已执行的脚本。

## 微信云托管

1. 使用根目录 `Dockerfile` 构建，容器端口 **80**，启动命令 `node server.js`。
2. 在云托管控制台配置环境变量：
   `MYSQL_ADDRESS`（`host:port`）、`MYSQL_USERNAME`、`MYSQL_PASSWORD`、`MYSQL_DATABASE`。
3. 容器启动**不会自动迁移**。首次部署或结构变更后，在本地直连云端 MySQL 手动执行：

```bash
ENV_FILE=.env.remote npm run db:migrate
```

`.env.remote` 填云端数据库公网地址、账号、密码和库名。迁移记录由 `schema_migrations` 维护，请通过该命令执行；云端 MySQL 需要先开启公网地址。

`container.config.json` 仅用于模板部署生成初始服务设置；自行新建服务时以控制台配置为准。

## 说明

- 历史详情只读 `answers` 中的题目快照，删除套题不会让历史变空。
- 时间统一按北京时间字符串存储，前端显示与旧版一致。
- 旧 `quiz.db` 已从 git 跟踪移除，仅保留本地备份；数据已固化在 `V2`/`V3` 迁移中。
