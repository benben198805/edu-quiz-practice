#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_BASE_URL = "https://express-5tx0-349536-13-1534869626.sh.run.tcloudbase.com";
const BODY_LIMIT = 8 * 1024 * 1024; // server.js: express.json({ limit: "8mb" })

function usage() {
  console.log(`用法：
  node scripts/upload-paper.js <题目文件.json> --name "套题名称" [选项]

选项：
  --name <名称>          套题名称；文件为 { name, ... } 对象时可省略
  --description <描述>   套题描述；文件里有 description 时以本参数为准
  --base-url <地址>      线上服务地址，默认 ${DEFAULT_BASE_URL}
                         （也可用环境变量 EDUQUIZ_BASE_URL）
  --timeout <秒>         请求超时，默认 120
  --dry-run              只校验并打印将要提交的内容，不调用接口
  -h, --help             显示本帮助

示例：
  node scripts/upload-paper.js papers_data/paper-21.json --name "第 21 套"
  node scripts/upload-paper.js /tmp/paper.json --name "高阶版第 6 套" --description "高阶版" --dry-run
  EDUQUIZ_BASE_URL=http://127.0.0.1:3000 node scripts/upload-paper.js /tmp/paper.json --name "本地测试"

说明：
  - 题目文件可以是题目数组，也可以是 { name, description, questions } 对象。
  - 调用的是 POST /api/papers/import；同名套题会覆盖题目，历史快照不受影响。
  - 请求体上限 8MB，超限会被服务端拒绝。`);
}

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    file: null,
    name: null,
    description: null,
    baseUrl: process.env.EDUQUIZ_BASE_URL || DEFAULT_BASE_URL,
    timeoutSeconds: 120,
    dryRun: false,
    help: false,
  };

  const takeValue = (arg, inlineValue, rest, index) => {
    if (inlineValue != null) return { value: inlineValue, index };
    const value = rest[index + 1];
    if (value == null || value.startsWith("--")) fail(`${arg} 缺少参数值`);
    return { value, index: index + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const key = eq === -1 ? arg : arg.slice(0, eq);
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);

    switch (key) {
      case "-h":
      case "--help":
        opts.help = true;
        return opts;
      case "--name": {
        const pick = takeValue(key, inlineValue, argv, i);
        opts.name = pick.value;
        i = pick.index;
        break;
      }
      case "--description": {
        const pick = takeValue(key, inlineValue, argv, i);
        opts.description = pick.value;
        i = pick.index;
        break;
      }
      case "--base-url": {
        const pick = takeValue(key, inlineValue, argv, i);
        opts.baseUrl = pick.value;
        i = pick.index;
        break;
      }
      case "--timeout": {
        const pick = takeValue(key, inlineValue, argv, i);
        const seconds = Number(pick.value);
        if (!Number.isFinite(seconds) || seconds <= 0) fail("--timeout 必须是正数（秒）");
        opts.timeoutSeconds = seconds;
        i = pick.index;
        break;
      }
      case "--dry-run":
        opts.dryRun = true;
        break;
      default:
        if (arg.startsWith("-")) fail(`未知参数：${arg}（用 --help 查看用法）`);
        if (opts.file) fail(`只能指定一个题目文件，多余的：${arg}`);
        opts.file = arg;
    }
  }
  return opts;
}

function readSource(file) {
  const absolute = path.resolve(process.cwd(), file);
  let text;
  try {
    text = fs.readFileSync(absolute, "utf8");
  } catch (err) {
    fail(`读取文件失败：${absolute}（${err.message}）`);
  }
  text = text.replace(/^\uFEFF/, "");
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`JSON 解析失败：${absolute}（${err.message}）`);
  }
}

function normalizeSource(source, file) {
  if (Array.isArray(source)) return { name: "", description: "", questions: source };
  if (source && typeof source === "object") {
    return {
      name: typeof source.name === "string" ? source.name : "",
      description: typeof source.description === "string" ? source.description : "",
      questions: source.questions,
    };
  }
  fail(`题目文件格式不对：${file} 应为题目数组或 { name, description, questions } 对象`);
}

function countByType(questions) {
  const order = ["judge", "single", "multi", "case"];
  const labels = { judge: "判断", single: "单选", multi: "多选", case: "案例" };
  const counts = new Map();
  for (const q of questions) {
    const type = q && typeof q === "object" ? String(q.type) : "未知";
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
    })
    .map(([type, count]) => `${labels[type] || `未知(${type})`} ${count}`)
    .join(" · ");
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function describePayload(payload, bytes) {
  const total = round(payload.questions.reduce((sum, q) => sum + Number(q && q.score), 0));
  return [
    `套题名称：${payload.name}`,
    `套题描述：${payload.description || "（空）"}`,
    `题目数量：${payload.questions.length}`,
    `题目构成：${countByType(payload.questions)}`,
    `满分合计：${total}`,
    `请求体大小：${(bytes / 1024).toFixed(1)} KB`,
  ].join("\n");
}

function importUrl(baseUrl) {
  let base = String(baseUrl).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;
  return base + "/api/papers/import";
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return usage();
  if (!opts.file) {
    usage();
    fail("缺少题目文件");
  }

  const source = readSource(opts.file);
  const normalized = normalizeSource(source, opts.file);

  const name = String(opts.name != null ? opts.name : normalized.name).trim();
  const description = String(opts.description != null ? opts.description : normalized.description);
  if (!name) fail("缺少套题名称（用 --name 指定，或文件里提供 name）");
  if ([...name].length > 100) fail("套题名称过长（最多 100 字）");
  if (!Array.isArray(normalized.questions) || normalized.questions.length === 0) {
    fail("题目数组（questions）为空或不是数组");
  }

  const payload = { name, description, questions: normalized.questions };
  const body = JSON.stringify(payload);
  const bytes = Buffer.byteLength(body);
  if (bytes > BODY_LIMIT) {
    fail(`请求体 ${(bytes / 1024 / 1024).toFixed(2)} MB 超过服务端 8MB 上限`);
  }

  console.log(describePayload(payload, bytes));

  if (opts.dryRun) {
    console.log("（dry-run）未调用接口。");
    return;
  }

  const url = importUrl(opts.baseUrl);
  console.log(`→ POST ${url}`);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(opts.timeoutSeconds * 1000),
    });
  } catch (err) {
    const cause = err.cause && (err.cause.code || err.cause.message);
    const reason = err.name === "TimeoutError"
      ? `超时（${opts.timeoutSeconds}s）`
      : err.message + (cause && cause !== err.message ? `（${cause}）` : "");
    fail(`请求失败：${reason}`);
  }

  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 非 JSON（网关错误页等），下面统一按文本处理
  }

  if (!res.ok) {
    console.error(`✗ 导入失败：HTTP ${res.status}`);
    if (data && data.error) {
      console.error(`  ${data.error}`);
      if (Array.isArray(data.details)) {
        for (const detail of data.details) console.error(`  - ${detail}`);
        if (data.errorCount > data.details.length) {
          console.error(`  …共 ${data.errorCount} 处错误，仅显示前 ${data.details.length} 处`);
        }
      }
    } else {
      console.error(`  ${data ? JSON.stringify(data) : text.slice(0, 800)}`);
    }
    if (res.status === 413) console.error("  请求体超过 8MB：请精简题目或上传更小的文件。");
    process.exit(1);
  }

  if (!data || !data.ok) {
    fail(`接口返回异常：${data ? JSON.stringify(data) : text.slice(0, 800)}`);
  }

  console.log(
    `✓ 导入成功：${data.name}（paperId=${data.paperId}，${data.created ? "新建套题" : "覆盖同名套题"}，${data.questionCount} 题）`
  );
}

main().catch(err => fail(err && err.stack ? err.stack : String(err)));
