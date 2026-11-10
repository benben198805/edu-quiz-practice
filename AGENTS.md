# AGENTS.md

项目名：**EduQuiz Practice**（仓库/包名 `edu-quiz-practice`）
教育公共基础笔试 · 模拟练习应用（v2）。单页前端 + Express API + SQLite，本地单机运行。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 运行时 | Node.js（已在 v24.20.0 验证） |
| 服务端 | Express 4.21（`express.json`，请求体上限 8MB） |
| 数据库 | SQLite（WAL 模式），`better-sqlite3` 13.0.3 |
| 前端 | 原生 HTML/CSS/JS 单文件，无构建步骤、无框架 |

> `better-sqlite3` 必须是 **13.x（N-API 版本）**。11.x/12.x 基于 `node::ObjectWrap`，在 Node 24.19/24.20 上会于 GC 回收 prepared statement 时原生 abort（`Assertion failed: (env) != nullptr`），整进程退出。升级不改任何调用代码。

## 目录结构

```
v2/
├── server.js              Express 入口与全部 API
├── db.js                  开库、建表、schema 迁移（含旧库升级）
├── public/index.html      唯一前端文件：样式、页面、全部交互
├── papers_data/           题目源 JSON（paper-01.json … paper-20.json）
├── quiz.db                SQLite 数据库（纳入 git；提交前先停服或 checkpoint）
├── quiz.db-wal / -shm     WAL 临时文件（不纳入 git）
├── quiz.db.bak-*          某次迁移前的备份，确认无误后可删
├── restart.sh             服务重启脚本（占用则先停再启）
├── server.log             由 restart.sh 写入的服务日志（不纳入 git）
├── .server.pid            restart.sh 写入的当前 PID（不纳入 git）
├── .gitignore             node_modules、数据库、日志、系统文件等排除规则
├── package.json / package-lock.json
└── deepseek_html_20261109_faa41b.html   早期独立原型稿，不被静态托管，不参与运行
```

`node_modules/`、`.dsh-project-memory/` 为依赖与本地会话缓存，不参与业务。

## 服务启停

```bash
cd v2

npm install              # 首次
./restart.sh             # 启动/重启（默认 3000 端口）
PORT=3100 ./restart.sh   # 换端口

npm start                # 前台调试启动（不写 pid/日志）
npm run init             # node db.js，建表/迁移 schema（空库时用）
```

- `restart.sh`：用 `lsof` 找到监听该端口的进程 → `SIGTERM`（最多等 10s）→ 必要时 `SIGKILL` → `nohup node server.js` 后台启动 → 轮询 `/api/papers` 健康检查。成功输出 URL，失败打印 `server.log` 末尾并返回非零。
- 停止：`kill "$(cat .server.pid)"`，或 `lsof -nP -t -iTCP:3000 -sTCP:LISTEN | xargs kill`。
- 日志/健康：`server.log`；`curl -s localhost:3000/api/papers`。
- 隔离测试：支持 `QUIZ_DB_PATH=/tmp/quiz-test.db PORT=3101 node server.js`，不会动真实库。
- 改完代码需执行 `./restart.sh`，Express 不热重载。

## 部署（Vercel）

- 零配置部署：`server.js` 位于根目录并 `module.exports = app`；只有本地 `node server.js` 才 `app.listen`。
- 函数目录 `/var/task` 只读：`db.js` 在 `VERCEL=1` 时把随包发布的 `quiz.db` 复制到 `/tmp/quiz.db` 再以 WAL 打开（`QUIZ_DB_PATH` 可覆盖，优先级最高）。
- `express.static()` 在 Vercel 上被忽略：`public/index.html` 由 Vercel CDN 直接托管，`/api/*` 进函数。
- **持久化限制**：`/tmp` 按实例隔离、冷启动会重置，多实例之间不共享。部署后可以正常浏览/答题，但答题历史、导入/删除套题只在该实例存活期间有效，不能作为真实数据存储。
- 需要真正持久化时，选择带持久磁盘的 Node 主机，或迁移到 Turso/Postgres 等托管数据库，再替换 `db.js` 的数据访问层。

## 数据模型与关键约束

| 表 | 说明 |
| --- | --- |
| `papers` | 套题，`name` 唯一 |
| `questions` | 套题题目，`UNIQUE(paper_id, seq)`，随套题级联删除 |
| `attempts` | 一次练习，带 `paper_id` 与 `paper_name` 快照 |
| `answers` | 一次作答，**同时保存完整题目快照**（seq/type/score/stem/options/answer/analysis） |

必须保持的规则：

1. **历史不依赖题目表**。历史详情只读 `answers` 快照；`answers.question_id` 为弱引用（题目删除后 `SET NULL`）。任何“查询历史时 join questions 取题干/解析”的改法都会让删套题后历史变空。
2. **删除套题是硬删除**：删 `papers` 行 → 级联删 `questions` → `answers.question_id` 置空、`attempts.paper_id` 置空，但快照保留，历史列表显示套题名 + “套题已删除”。
3. **同名导入 = 覆盖题目**：按 `(paper_id, seq)` upsert，并删除尾部多余题号；已产生的历史按快照展示，不受影响。
4. 时间统一用 `datetime('now','localtime')`；分数用 REAL，前端 `formatScore()` 负责四舍五入到 1 位小数。
5. 旧库迁移在 `db.js` 的 `initSchema()` 中自动完成（补 `paper_name`、重建 `answers` 并回填快照），重复执行安全。
6. `quiz.db` 是纳入 git 的二进制文件，`-wal`/`-shm` 被忽略。提交数据库前先停服（`kill "$(cat .server.pid)"`），确认 WAL 已合并、`PRAGMA integrity_check` 为 ok，再 `git add quiz.db`；运行中直接提交可能缺少 WAL 里尚未 checkpoint 的事务。重启用 `./restart.sh`。

## 核心功能

- **套题列表**：响应式卡片网格铺满内容区、不分页，卡片显示题数与满分。
- **答题**：逐题作答，支持判断题/单选题/多项选择题；键盘 `A~E` 选择、`Enter` 提交/下一题；侧边题号总览用颜色标识对错。
- **结果页**：总分、按题型统计、逐题回顾，可按全部/正确/错误筛选，导出 PDF（浏览器打印）。
- **答题历史**：按套题下拉筛选（客户端筛选，选项带次数，已删套题标注），可查看任意历史详情、删除单条记录；首次提交作答才创建记录，未答则不留痕。
- **套题管理**：卡片显示题数/满分/答题次数（点击次数跳转该套题历史）；「＋ 导入套题」弹窗导入 JSON；「查看题目」为只读详情（可按题型筛选，正确答案高亮）；「删除套题」二次确认并提示历史保留。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/papers` | 套题列表，含 `question_count`、`max_score`、`attempt_count`、`last_attempt_at` |
| GET | `/api/papers/:id/questions` | 某套题全部题目（解析后的 options/answer），管理页详情复用 |
| POST | `/api/papers/import` | 导入 `{ name, description, questions }`，同名覆盖 |
| DELETE | `/api/papers/:id` | 删除套题（历史快照保留） |
| POST | `/api/attempts` | 开始练习，返回 `attemptId`、`maxScore` |
| POST | `/api/attempts/:id/answers` | 提交单题，同时写入题目快照 |
| POST | `/api/attempts/:id/finish` | 结束练习 |
| GET | `/api/attempts` | 全部历史（不截断），含 `paper_exists` |
| GET | `/api/attempts/:id` | 历史详情，纯读快照 |
| DELETE | `/api/attempts/:id` | 删除一条历史及其作答 |

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
