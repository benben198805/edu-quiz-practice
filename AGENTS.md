# AGENTS.md

项目名：**EduQuiz Practice**（仓库/包名 `edu-quiz-practice`）
教育公共基础笔试 · 模拟练习应用（v2）。单页前端 + Express API + MySQL 5.7，部署在微信云托管。

## 技术栈

|层|选型|
|---|---|
|运行时|Node.js >= 20（Dockerfile 使用 `alpine:3.20` + `apk nodejs npm`，Node 20.15）|
|服务端|Express 4.21（`express.json`，请求体上限 8MB）|
|ORM/驱动|Sequelize 6 + `mysql2`|
|数据库|MySQL 5.7，`utf8mb4` / `utf8mb4_unicode_ci`|
|迁移|Node 版 Flyway 风格：`migrations/VN__*.sql` + `schema_migrations` 表|
|前端|原生 HTML/CSS/JS 单文件，无构建步骤、无框架|

> 不需要 SQLite / better-sqlite3。旧 `quiz.db` 仅作为历史数据来源的本地备份，已不入库，运行时不读取。

## 目录结构

```
.
├── server.js                 Express 入口与全部 API
├── db/
│   ├── index.js              Sequelize 实例 + 模型统一出口
│   ├── connection.js         MySQL 连接池配置
│   ├── config.js             MYSQL_* / .env 解析
│   ├── models.js             Paper / Question / Attempt / Answer
│   └── time.js               北京时间字符串 nowLocal()
├── migrations/
│   ├── V1__init.sql          MySQL 5.7 初始表结构
│   ├── V2__seed_papers.sql   旧库导出：20 套题、1800 题
│   └── V3__seed_attempts.sql 旧库导出：4 次历史、360 条作答快照
├── scripts/migrate.js        迁移执行器（migrate / --status）
├── public/index.html         唯一前端文件：样式、页面、全部交互
├── papers_data/              题目源 JSON（paper-01.json … paper-20.json）
├── Dockerfile                云托管镜像
├── container.config.json     云托管「服务设置」模板初始化配置
├── docker-compose.yml        本地 MySQL 5.7
├── .env.example              本地环境变量示例
├── restart.sh                本地重启脚本（先迁移、再启动）
├── package.json / package-lock.json
└── quiz.db                   旧 SQLite 本地备份（已 gitignore）
```

## 本地服务启停

```bash
# 1. 本地 MySQL 5.7（root 空密码，库 edu_quiz，端口 3306）
docker compose up -d mysql

# Apple Silicon 替代方案（mysql:5.7 只有 amd64 镜像）
colima --profile mysql57 start --vz-rosetta
docker --context colima-mysql57 compose up -d mysql

# 2. 安装依赖
npm install

# 3. 迁移（建库 + 建表 + 导入旧数据）
npm run db:migrate
npm run db:status

# 4. 启动
./restart.sh              # 自动迁移后启动，默认 3000 端口
npm run dev               # 前台：迁移 + node server.js
npm start                 # 前台：只启动，不迁移
PORT=3100 ./restart.sh    # 换端口
SKIP_MIGRATE=1 ./restart.sh
```

- `restart.sh`：执行 `npm run db:migrate` → 用 `lsof` 找到监听端口的进程 → `SIGTERM`（最多等 10s）→ 必要时 `SIGKILL` → `nohup node server.js` → 轮询 `/api/health`。
- 停止：`kill "$(cat .server.pid)"`，或 `lsof -nP -t -iTCP:3000 -sTCP:LISTEN | xargs kill`。
- 日志/健康：`server.log`；`curl -s localhost:3000/api/health`、`curl -s localhost:3000/api/papers`。
- Docker Hub 拉取超时时，可先通过镜像站拉取再打标签：
  `docker pull --platform linux/amd64 docker.m.daocloud.io/library/mysql:5.7 && docker tag docker.m.daocloud.io/library/mysql:5.7 mysql:5.7`。
- Apple Silicon 请用上面的 Rosetta profile；默认 QEMU 下 `mysql:5.7` 可能启动崩溃。目标是 MySQL 5.7 语法，不要用 MySQL 8 的 CTE/窗口函数。

## 环境变量

|变量|默认|说明|
|---|---|---|
|`MYSQL_ADDRESS`|`127.0.0.1:3306`|`host:port`，微信云托管直接使用控制台给的地址|
|`MYSQL_USERNAME`|`root`||
|`MYSQL_PASSWORD`|空||
|`MYSQL_DATABASE`|`edu_quiz`||
|`PORT`|`3000`（镜像内为 80）||
|`APP_TIMEZONE`|`+08:00`|Sequelize 连接时区；业务时间统一由 `nowLocal()` 写北京时间|
|`ENV_FILE`|`.env`|迁移/启动时加载的另一份环境文件|

- 本地复制 `.env.example` 为 `.env`；容器环境由云托管控制台注入，镜像内不打包 `.env`。
- 远端迁移：`ENV_FILE=.env.remote npm run db:migrate`，`.env.remote` 填云端 MySQL 公网地址、账号、密码、库名。
- `.env` / `.env.*` 已被 gitignore（`.env.example` 除外）。

## 微信云托管部署

- 直接使用仓库根目录的 `Dockerfile` 构建，容器端口 **80**，启动命令 `node server.js`。
- 在云托管「服务设置 → 环境变量」配置 `MYSQL_ADDRESS`、`MYSQL_USERNAME`、`MYSQL_PASSWORD`、`MYSQL_DATABASE`。数据库密码留空时 `MYSQL_PASSWORD` 可省略。
- `container.config.json` 只用于模板部署生成初始服务设置；自行新建服务时以控制台配置为准。
- **容器启动不会自动迁移**。首次部署/结构变更后，在本地直连云端 MySQL 手动执行：
  ```bash
  ENV_FILE=.env.remote npm run db:migrate
  ```
- `public/index.html` 由 Express 静态托管，不再依赖 Vercel CDN；没有 `/tmp` 数据库复制逻辑。
- 云托管实例无状态，数据库是唯一持久化位置；不要重新引入本地文件持久化。

## 数据模型与关键约束

|表|说明|
|---|---|
|`papers`|套题，`name` 唯一|
|`questions`|套题题目，`UNIQUE(paper_id, seq)`，随套题级联删除|
|`attempts`|一次练习，带 `paper_id` 与 `paper_name` 快照|
|`answers`|一次作答，**同时保存完整题目快照**（seq/type/score/stem/options/answer/analysis）|
|`schema_migrations`|已执行的迁移版本、描述、SHA-256 校验和、执行时间|

必须保持的规则：

1. **历史不依赖题目表**。历史详情只读 `answers` 快照；`answers.question_id` 为弱引用（题目删除后 `SET NULL`）。任何“查询历史时 join questions 取题干/解析”的改法都会让删套题后历史变空。
2. **删除套题是硬删除**：删 `papers` 行 → 级联删 `questions` → `answers.question_id` 置空、`attempts.paper_id` 置空，但快照保留，历史列表显示套题名 + “套题已删除”。
3. **同名导入 = 覆盖题目**：按 `(paper_id, seq)` upsert，并删除尾部多余题号；已产生的历史按快照展示，不受影响。
4. 时间统一写北京时间字符串 `YYYY-MM-DD HH:mm:ss`（`db/time.js` 的 `nowLocal()`）。MySQL 的 `DATETIME` 在 Sequelize 模型里映射成 `STRING(19)`，连接层的 `typeCast` 也把 DATETIME 直接返回字符串，避免前端显示 UTC。
5. `answers` 的唯一键是 `(attempt_id, seq)`，不是 `question_id`：题目删除后 `question_id` 会变成 NULL，而 MySQL 唯一索引允许多个 NULL，用 seq 才能保证同一题位只保留一条作答。
6. 迁移只增不改：已执行的 `VN__*.sql` 不要修改，校验和不一致时执行器会拒绝运行；结构变更新增 `V(N+1)__*.sql`。
7. MySQL 5.7 语法：不要使用 CTE、窗口函数；索引列总长度控制在 767 字节内（`papers.name` / `attempts.paper_name` 为 `VARCHAR(100)` utf8mb4，安全）。
8. `sequelize.sync()` 不参与运行；表结构以 `migrations/` 为准。

## 核心功能

- **套题列表**：响应式卡片网格铺满内容区、不分页，卡片显示题数与满分。
- **答题**：逐题作答，支持判断题/单选题/多项选择题；键盘 `A~E` 选择、`Enter` 提交/下一题；侧边题号总览用颜色标识对错。
- **结果页**：总分、按题型统计、逐题回顾，可按全部/正确/错误筛选，导出 PDF（浏览器打印）。
- **答题历史**：按套题下拉筛选（客户端筛选，选项带次数，已删套题标注），可查看任意历史详情、删除单条记录；首次提交作答才创建记录，未答则不留痕。
- **套题管理**：卡片显示题数/满分/答题次数（点击次数跳转该套题历史）；「＋ 导入套题」弹窗导入 JSON；「查看题目」为只读详情（可按题型筛选，正确答案高亮）；「删除套题」二次确认并提示历史保留。

## API

|方法|路径|说明|
|---|---|---|
|GET|`/api/health`|数据库连通性检查，云托管探针可用|
|GET|`/api/papers`|套题列表，含 `question_count`、`max_score`、`attempt_count`、`last_attempt_at`|
|GET|`/api/papers/:id/questions`|某套题全部题目（解析后的 options/answer），管理页详情复用|
|POST|`/api/papers/import`|导入 `{ name, description, questions }`，同名覆盖|
|DELETE|`/api/papers/:id`|删除套题（历史快照保留）|
|POST|`/api/attempts`|开始练习，返回 `attemptId`、`maxScore`|
|POST|`/api/attempts/:id/answers`|提交单题，同时写入题目快照|
|POST|`/api/attempts/:id/finish`|结束练习|
|GET|`/api/attempts`|全部历史（不截断），含 `paper_exists`|
|GET|`/api/attempts/:id`|历史详情，纯读快照|
|DELETE|`/api/attempts/:id`|删除一条历史及其作答|

## 题目源与导入格式

- 源文件：`papers_data/paper-NN.json`，一套一文件（当前 01–20，每套 90 题），命名对应「进阶版第 N 套」，描述为 `教育公共基础笔试 · 进阶版第 N 套`。
- 结构：题目数组；也接受 `{ name, description, questions }` 对象。
- 单题字段：

```json
{
  "type": "judge | single | multi",
  "score": 0.6,
  "stem": "题干",
  "options": [["A", "正确"], ["B", "错误"]],
  "answer": ["B"],
  "analysis": "解析"
}
```

- 导入校验（`server.js` 的 `normalizeQuestions()`）：`type` 三选一；`score` 非负数字；`stem` 非空；至少 2 个选项且字母不重复；`answer` 非空、必须是已有选项；判断/单选恰好 1 个正确答案，多选至少 2 个。不通过返回 400 + 逐条错误，事务回滚、不落库。
- 导入后题号按数组顺序重排为 `seq = 1..N`。
- 所有套题统一通过「套题管理 → 导入套题」入库；`papers_data/` 只是源文件存档，服务不会自动扫描。重名导入会按 seq 覆盖该套题题目，历史快照不受影响。

## 运维

- 查看表：`docker compose exec mysql mysql -uroot edu_quiz -e "SELECT COUNT(*) FROM papers;"`。
- 备份：`docker compose exec mysql mysqldump -uroot edu_quiz > backup.sql`。
- 迁移状态：`npm run db:status`；执行：`npm run db:migrate`。
- 旧的 `quiz.db` 已从 git 跟踪中移除，仅保留本地备份；`V2`/`V3` 已包含其全部业务数据。
