// core.mjs — 朗读插件的 vendor 核心（从 read-aloud.mjs 裁剪，2026-11-03）。
//
// 只含插件真正用到的 dump/分块/音色逻辑；SAPI/minimax/widget/playWav 等 CLI 专属逻辑一律不带。
// 同步流程：正本 read-aloud.mjs 改动下列任一函数/常量 → 复制改动到本文件 →
// 跑 test/core.test.mjs 等价断言（必须绿）→ git commit。
// 等价断言同时 import 本文件与正本，对同一 fixture sqlite 跑 extractMessages，逐字节比对。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- 常量
// [vendor] 同步自 read-aloud.mjs ROLE_LABELS，2026-11-03
const ROLE_LABELS = { user: "用户", assistant: "助手", system: "系统", tool: "工具" };

// [vendor] 同步自 read-aloud.mjs EDGE_DEFAULT_VOICE，2026-11-03
const EDGE_DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

// [vendor] 同步自 read-aloud.mjs EDGE_ZH_VOICES，2026-11-03
const EDGE_ZH_VOICES = [
  "zh-CN-XiaoxiaoNeural",
  "zh-CN-XiaoyiNeural",
  "zh-CN-YunjianNeural",
  "zh-CN-YunxiNeural",
  "zh-CN-YunxiaNeural",
  "zh-CN-YunyangNeural",
  "zh-CN-liaoning-XiaobeiNeural",
  "zh-CN-shaanxi-XiaoniNeural",
];

// [vendor] 同步自 read-aloud.mjs EDGE_RATE_STEP，2026-11-03
const EDGE_RATE_STEP = 5; // --rate -10..10 → edge 的百分比参数：-10→-50%，0→+0%，10→+50%

// [vendor] 等价语义自 read-aloud.mjs SAPI_MAX_CHUNK，2026-11-03
// edge-tts --text argv 上限；正本命名 SAPI_MAX_CHUNK，vendor 改 EDGE_MAX_CHUNK。
const EDGE_MAX_CHUNK = 120;

// [vendor] 同步自 read-aloud.mjs CODE_PLACEHOLDER，2026-11-03
const CODE_PLACEHOLDER = "（代码略）";

// [vendor] 同步自 read-aloud.mjs SESSION_FILTER，2026-11-03
// 用 substr 做精确前缀匹配：LIKE 里的下划线是单字符通配符，会把 sess_subagentX... 之类也误伤。
const SESSION_FILTER =
  "WHERE time_deleted IS NULL AND substr(id, 1, 14) <> 'sess_subagent_' AND substr(id, 1, 9) <> 'sess_dwf-'";

// [vendor] 同步自 read-aloud.mjs SENTENCE_ENDERS，2026-11-03
const SENTENCE_ENDERS = "。！？；…!?;\n";

// [vendor] 同步自 read-aloud.mjs REPEATABLE_ENDERS，2026-11-03
const REPEATABLE_ENDERS = "…！？!?";

// ---------------------------------------------------------------- 小工具

// [vendor] 同步自 read-aloud.mjs defaultDbPath，2026-11-03
function defaultDbPath() {
  return path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}

// [vendor] 同步自 read-aloud.mjs parseJson，2026-11-03
function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// [vendor] 同步自 read-aloud.mjs stripBom，2026-11-03
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// [vendor] 同步自 read-aloud.mjs openDatabase，2026-11-03
// node:sqlite 在 Node 22 仍是实验特性，加载时会打 ExperimentalWarning；只针对 SQLite 静音，
// 其余警告照旧。用动态 import 以便在 import 之前装好过滤器。
async function openDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error("数据库不存在: " + dbPath);
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
    if (type === "ExperimentalWarning" && String(warning).indexOf("SQLite") >= 0) return;
    return original.call(process, warning, ...rest);
  };
  try {
    const mod = await import("node:sqlite");
    return new mod.DatabaseSync(dbPath, { readOnly: true });
  } finally {
    process.emitWarning = original;
  }
}

// ---------------------------------------------------------------- 合成消息过滤

// [vendor] 同步自 read-aloud.mjs isSyntheticRecord，2026-11-03
// 排除：synthetic===true、metadata.visibility==='model-only'、带 metadata.runtimeMessage.source。
// message.data 与 part.data 都要查——实测两类记录都会带这些字段。
function isSyntheticRecord(data) {
  if (!data || typeof data !== "object") return false;
  if (data.synthetic === true) return true;
  const meta = data.metadata;
  if (meta && typeof meta === "object") {
    if (meta.visibility === "model-only") return true;
    if (meta.runtimeMessage && meta.runtimeMessage.source) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 上下文提取

// [vendor] 同步自 read-aloud.mjs resolveSessionId，2026-11-03
// 默认会话：time_updated 最新，且排除子代理/工作流会话前缀。
function resolveSessionId(db, explicit) {
  if (explicit) return explicit;
  const row = db.prepare("SELECT id FROM session " + SESSION_FILTER + " ORDER BY time_updated DESC LIMIT 1").get();
  if (!row) throw new Error("找不到可用会话（已排除子代理/工作流会话）");
  return row.id;
}

// [vendor] 同步自 read-aloud.mjs readTextMessages，2026-11-03
// 过滤后的逐条消息（一条 DB 消息一项；同一消息的多个 text part 用空行相接）。
function readTextMessages(db, sessionId) {
  const rows = db
    .prepare(
      "SELECT m.id AS mid, m.sequence AS mseq, m.data AS mdata, p.sequence AS pseq, p.data AS pdata " +
        "FROM message m JOIN part p ON p.message_id = m.id " +
        "WHERE m.session_id = ? ORDER BY m.sequence ASC, p.sequence ASC"
    )
    .all(sessionId);
  const out = [];
  let lastMessageId = null;
  for (const row of rows) {
    const mdata = parseJson(row.mdata) || {};
    const pdata = parseJson(row.pdata) || {};
    if (pdata.type !== "text") continue; // reasoning / tool / timeline / step-* 不入朗读
    if (isSyntheticRecord(mdata) || isSyntheticRecord(pdata)) continue;
    const text = typeof pdata.text === "string" ? pdata.text : "";
    if (!text.trim()) continue;
    const role = typeof mdata.role === "string" && mdata.role ? mdata.role : "assistant";
    if (row.mid !== lastMessageId) {
      out.push({ role: role, text: text });
      lastMessageId = row.mid;
    } else {
      out[out.length - 1].text += "\n\n" + text;
    }
  }
  return out;
}

// [vendor] 同步自 read-aloud.mjs mergeConsecutive，2026-11-03
function mergeConsecutive(messages) {
  const out = [];
  for (const message of messages) {
    if (!out.length || out[out.length - 1].role !== message.role) {
      out.push({ role: message.role, text: message.text });
    } else {
      out[out.length - 1].text += "\n\n" + message.text;
    }
  }
  return out;
}

// [vendor] 等价断言与 server 都用它（预审 P1-1 补）。
function extractMessages(db, sessionId) {
  return mergeConsecutive(readTextMessages(db, sessionId));
}

// [vendor] 同步自 read-aloud.mjs replaceCodeBlocks，2026-11-03
function replaceCodeBlocks(text) {
  let out = String(text).replace(/```[\s\S]*?```/g, CODE_PLACEHOLDER);
  out = out.replace(/```[\s\S]*$/g, CODE_PLACEHOLDER); // 未闭合围栏：剩余全部算代码
  return out;
}

// [vendor] 同步自 read-aloud.mjs roleLabel，2026-11-03
function roleLabel(role) {
  if (!role) return "文本";
  return ROLE_LABELS[role] || role;
}

// ---------------------------------------------------------------- 句子分块器

// [vendor] 同步自 read-aloud.mjs splitSentences，2026-11-03
// 预审 P0-2 修正：正本默认 limit 形参引用 SAPI_MAX_CHUNK；vendor 里这处引用改为 EDGE_MAX_CHUNK。
// 其余引用 SENTENCE_ENDERS/REPEATABLE_ENDERS 的行照抄不变。
function splitSentences(text, maxLen) {
  const limit = Math.max(20, Number(maxLen) || EDGE_MAX_CHUNK);
  const coarse = [];
  let buf = "";
  const chars = Array.from(String(text == null ? "" : text));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    buf += ch;
    if (SENTENCE_ENDERS.indexOf(ch) >= 0) {
      const next = chars[i + 1];
      if (next !== undefined && REPEATABLE_ENDERS.indexOf(next) >= 0) continue;
      const trimmed = buf.trim();
      if (trimmed) coarse.push(trimmed);
      buf = "";
    }
  }
  const tail = buf.trim();
  if (tail) coarse.push(tail);

  const out = [];
  for (const piece of coarse) {
    let rest = piece;
    while (rest.length > limit) {
      const head = rest.slice(0, limit);
      const soft = Math.max(
        head.lastIndexOf("，"),
        head.lastIndexOf(","),
        head.lastIndexOf(" "),
        head.lastIndexOf("、"),
        head.lastIndexOf("："),
        head.lastIndexOf(":"),
        head.lastIndexOf("）"),
        head.lastIndexOf(")")
      );
      const cut = soft >= Math.floor(limit / 2) ? soft + 1 : limit;
      const part = rest.slice(0, cut).trim();
      if (part) out.push(part);
      rest = rest.slice(cut).trim();
      if (!rest) break;
    }
    if (rest) out.push(rest);
  }
  return out.filter(function (sentence) {
    return sentence.length > 0;
  });
}

// [vendor] 同步自 read-aloud.mjs buildSpeechChunks，2026-11-03
function buildSpeechChunks(messages, maxLen) {
  const chunks = [];
  for (const message of messages) {
    const sentences = splitSentences(replaceCodeBlocks(message.text), maxLen);
    for (const sentence of sentences) chunks.push(sentence);
  }
  return chunks;
}

// ---------------------------------------------------------------- edge 音色/语速

// [vendor] 同步自 read-aloud.mjs edgeRateArg，2026-11-03
// --rate -10..10 → edge 的百分比参数：-10→-50%，0→+0%，10→+50%
function edgeRateArg(rate) {
  const numeric = Number(rate);
  const value = Number.isFinite(numeric) ? Math.max(-10, Math.min(10, Math.round(numeric))) : 0;
  const pct = value * EDGE_RATE_STEP;
  return (pct >= 0 ? "+" : "") + pct + "%";
}

// [vendor] 同步自 read-aloud.mjs resolveEdgeVoice，2026-11-03
// --voice 可给全名（zh-CN-YunxiNeural）也可给短名（yunxi / Xiaoxiao）；
// 未知值原样透传，让 edge-tts 自己报「音色不存在」，不静默换成默认音色。
function resolveEdgeVoice(hint) {
  const text = String(hint == null ? "" : hint).trim();
  if (!text) return EDGE_DEFAULT_VOICE;
  if (/^zh-/i.test(text)) return text;
  const lower = text.toLowerCase();
  const hit = EDGE_ZH_VOICES.filter(function (name) {
    return name.toLowerCase().indexOf(lower) >= 0;
  });
  return hit.length ? hit[0] : text;
}

export {
  buildSpeechChunks,
  CODE_PLACEHOLDER,
  defaultDbPath,
  EDGE_DEFAULT_VOICE,
  EDGE_MAX_CHUNK,
  EDGE_RATE_STEP,
  EDGE_ZH_VOICES,
  edgeRateArg,
  extractMessages,
  isSyntheticRecord,
  mergeConsecutive,
  openDatabase,
  parseJson,
  readTextMessages,
  replaceCodeBlocks,
  resolveEdgeVoice,
  resolveSessionId,
  roleLabel,
  SESSION_FILTER,
  SENTENCE_ENDERS,
  REPEATABLE_ENDERS,
  splitSentences,
  stripBom,
  ROLE_LABELS,
};
