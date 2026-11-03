// server.mjs — 朗读插件 MCP stdio server（零依赖，2026-11-03）。
//
// 换行分隔 JSON-RPC 2.0。4 工具：speak_session / speak_chunk / list_voices / session_info。
// 面板资源 ui://read-aloud/panel.html 由 resources/read 读出独立 panel.html。
//
// 设计：§三 server.mjs 设计（PLAN-2026-11-03-read-aloud-formal.md）。

import { spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import process from "node:process";

import {
  EDGE_DEFAULT_VOICE,
  EDGE_MAX_CHUNK,
  extractMessages,
  openDatabase,
  defaultDbPath,
  resolveEdgeVoice,
  edgeRateArg,
  resolveSessionId,
  roleLabel,
  splitSentences,
  replaceCodeBlocks,
} from "./core.mjs";

const RESOURCE_URI = "ui://read-aloud/panel.html";
const SERVER_NAME = "read-aloud";
const SERVER_VERSION = "1.0.0";
const DEFAULT_MAX_CHARS = 12000;
const HARD_CHAR_CAP = 200000; // 预审 P2-6：防极端会话撞 8MiB read 上限
const SYNTH_TIMEOUT_MS = 120000;
const PYTHON_VERIFY_TIMEOUT_MS = 10000;
const MAX_SESSIONS = 5; // LRU

// ---------------------------------------------------------------- 传输：换行分隔 JSON

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, "");
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // 坏 JSON 行跳过不崩
    }
    handleMessage(msg).catch((e) => {
      if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(e && e.message || e));
    });
  }
});
process.stdin.on("end", () => process.exit(0));

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// ---------------------------------------------------------------- python 解析

let pythonResolved = null; // null=未解析，false=已试全失败，string=已解析路径

function resolvePython() {
  if (pythonResolved !== null) return pythonResolved ? { path: pythonResolved } : null;
  const candidates = [];
  const raPath = process.env.RA_PYTHON_PATH;
  if (raPath && String(raPath).trim()) candidates.push(String(raPath).trim());
  candidates.push("python", "python3", "py");
  const errors = [];
  for (const cand of candidates) {
    const args = cand === "py" ? ["-3", "--version"] : ["--version"];
    const r = spawnSync(cand, args, { encoding: "utf8", timeout: PYTHON_VERIFY_TIMEOUT_MS });
    if (r.status === 0 && /Python\s/i.test(String(r.stdout || ""))) {
      pythonResolved = cand;
      return { path: cand };
    }
    errors.push(cand + ": " + (r.error ? r.error.message : "status=" + r.status));
  }
  pythonResolved = false;
  throw new Error("未找到可用的 Python（已尝试: " + candidates.join(", ") + "）。" + errors.join("; "));
}

// ---------------------------------------------------------------- 会话存储 + 合成缓存

const sessions = new Map(); // requestId → { sessionId, sessionIdSource, voice, rate, chunks[], createdAt }
let requestCounter = 0;

function newRequestId() {
  return "req_" + process.pid + "_" + requestCounter++ + "_" + Math.random().toString(16).slice(2, 10);
}

function storeSession(entry) {
  sessions.set(entry.requestId, entry);
  if (sessions.size > MAX_SESSIONS) {
    const oldestKey = sessions.keys().next().value;
    if (oldestKey) sessions.delete(oldestKey);
  }
}

function getCacheDir() {
  const dataDir =
    process.env.ZCODE_PLUGIN_DATA ||
    path.join(os.homedir(), ".zcode", "cli", "plugins", "data", "read-aloud");
  return path.join(dataDir, "chunks");
}

function cacheKeyFor(text, voice, rateArg) {
  return createHash("sha256").update(text + "\0" + voice + "\0" + rateArg).digest("hex");
}

function synthesizeChunk(text, voice, rateArg) {
  const { path: python } = resolvePython();
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const key = cacheKeyFor(text, voice, rateArg);
  const mp3 = path.join(cacheDir, key + ".mp3");
  if (existsSync(mp3)) return { buf: readFileSync(mp3), cached: true };
  const r = spawnSync(
    python,
    ["-m", "edge_tts", "--voice", voice, "--rate=" + rateArg, "--text", text, "--write-media", mp3],
    { encoding: "utf8", timeout: SYNTH_TIMEOUT_MS }
  );
  if (r.error) throw new Error("edge-tts 启动失败: " + r.error.message);
  if (r.status !== 0) {
    throw new Error("edge-tts 退出码 " + r.status + ": " + String(r.stderr || "").trim().slice(0, 200));
  }
  const buf = readFileSync(mp3);
  return { buf, cached: false };
}

// ---------------------------------------------------------------- 8 音色元数据

const VOICE_META = [
  { name: "zh-CN-XiaoxiaoNeural", label: "晓晓", gender: "女", style: "温暖" },
  { name: "zh-CN-XiaoyiNeural", label: "晓伊", gender: "女", style: "温柔" },
  { name: "zh-CN-YunjianNeural", label: "云健", gender: "男", style: "磁性" },
  { name: "zh-CN-YunxiNeural", label: "云希", gender: "男", style: "阳光" },
  { name: "zh-CN-YunxiaNeural", label: "云夏", gender: "男", style: "沉稳" },
  { name: "zh-CN-YunyangNeural", label: "云扬", gender: "男", style: "专业" },
  { name: "zh-CN-liaoning-XiaobeiNeural", label: "晓北", gender: "女", style: "东北口音" },
  { name: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮", gender: "女", style: "陕西口音" },
];

// ---------------------------------------------------------------- MCP 方法分发

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const isNotification = msg.id === undefined;
  if (isNotification) return; // 通知一律不回复

  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: (msg.params && msg.params.protocolVersion) || "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "ping":
      return reply(msg.id, {});

    case "tools/list":
      return reply(msg.id, {
        tools: [
          {
            name: "speak_session",
            description: "准备朗读会话：dump 当前会话 → 分块 → 返回分块索引与文本（供面板渲染转写）。不含音频。",
            inputSchema: {
              type: "object",
              properties: {
                voice: { type: "string", description: "音色全名/短名（如 yunxi），缺省用 RA_DEFAULT_VOICE 或 zh-CN-XiaoxiaoNeural" },
                rate: { type: "number", description: "-10..10（edge 百分比步长 5），缺省 0" },
                maxChars: { type: "number", description: "字符预算，缺省 RA_MAX_CHARS（默认 12000）；0=不限制；截断按块边界" },
                sessionId: { type: "string", description: "显式覆盖会话 id（测试用）；缺省依次取 _meta.sessionId → fallback 解析" },
              },
            },
            _meta: { ui: { surface: "read-aloud", visibility: ["model", "app"] } },
          },
          {
            name: "speak_chunk",
            description: "按 requestId+index 逐块取音频（base64 data URI）。voice/rate 可覆盖 speak_session 请求记录值（切音色/倍速时透传，变更生效不需重调 speak_session）。",
            inputSchema: {
              type: "object",
              properties: {
                requestId: { type: "string", description: "speak_session 返回的 requestId" },
                index: { type: "number", description: "块索引（0 起）" },
                voice: { type: "string", description: "可选覆盖音色" },
                rate: { type: "number", description: "可选覆盖倍速（-10..10）" },
              },
              required: ["requestId", "index"],
            },
            _meta: { ui: { surface: "read-aloud", visibility: ["app"] } },
          },
          {
            name: "list_voices",
            description: "列出 8 个中文 edge 神经音色（name/label/gender/style）。",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model"] } },
          },
          {
            name: "session_info",
            description: "诊断：返回当前会话身份（_meta 注入值或 null）、db 路径、db 是否存在、python 是否已解析。",
            inputSchema: { type: "object", properties: {} },
            _meta: { ui: { visibility: ["model"] } },
          },
        ],
      });

    case "resources/list":
      return reply(msg.id, {
        resources: [
          {
            uri: RESOURCE_URI,
            name: "朗读面板",
            mimeType: "text/html;profile=mcp-app",
            _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
          },
        ],
      });

    case "resources/read": {
      const uri = msg.params && msg.params.uri;
      if (uri !== RESOURCE_URI) return replyError(msg.id, -32002, "资源不存在: " + uri);
      const text = readFileSync(new URL("./panel.html", import.meta.url), "utf8");
      return reply(msg.id, {
        contents: [{ uri: RESOURCE_URI, mimeType: "text/html;profile=mcp-app", text }],
      });
    }

    case "tools/call":
      return await handleToolsCall(msg);

    default:
      return replyError(msg.id, -32601, "method not found: " + msg.method);
  }
}

async function handleToolsCall(msg) {
  const params = msg.params || {};
  const args = params.arguments || {};
  const meta = params._meta || {};
  const name = params.name;
  try {
    switch (name) {
      case "speak_session":
        return reply(msg.id, await toolSpeakSession(args, meta));
      case "speak_chunk":
        return reply(msg.id, await toolSpeakChunk(args));
      case "list_voices":
        return reply(msg.id, toolListVoices());
      case "session_info":
        return reply(msg.id, toolSessionInfo(meta));
      default:
        return replyError(msg.id, -32602, "未知工具: " + name);
    }
  } catch (e) {
    return replyError(msg.id, -32603, String(e && e.message || e));
  }
}

// ---------------------------------------------------------------- speak_session

async function toolSpeakSession(args, meta) {
  const voice = resolveEdgeVoice(
    args.voice !== undefined ? args.voice : (process.env.RA_DEFAULT_VOICE || EDGE_DEFAULT_VOICE)
  );
  const rate = normalizeRate(args.rate !== undefined ? args.rate : 0);
  const maxChars = normalizeMaxChars(args.maxChars);

  const dbPath = process.env.RA_DB_PATH || defaultDbPath();
  const db = await openDatabase(dbPath);
  try {
    let sessionId, sessionSource;
    if (args.sessionId !== undefined && args.sessionId !== null && String(args.sessionId).trim()) {
      sessionId = String(args.sessionId).trim();
      sessionSource = "arg";
    } else if (meta.sessionId && String(meta.sessionId).trim()) {
      sessionId = String(meta.sessionId).trim();
      sessionSource = "meta";
    } else {
      sessionId = resolveSessionId(db, undefined);
      sessionSource = "fallback-latest";
    }

    const messages = extractMessages(db, sessionId);
    if (!messages.length) throw new Error("会话不存在或没有可朗读的消息: " + sessionId);

    const { chunks: roleChunks, truncated } = buildRoleChunks(messages, EDGE_MAX_CHUNK, maxChars);
    if (!roleChunks.length) {
      // 区分：maxChars 太小导致首句放不下 vs 会话真的没有可读内容
      if (maxChars > 0 && messages.length > 0) {
        const firstChunkLen = buildRoleChunks(messages, EDGE_MAX_CHUNK, 0).chunks[0];
        throw new Error("朗读预算 maxChars=" + maxChars + " 小于首句长度（" + (firstChunkLen ? firstChunkLen.charCount : 0) + " 字符），请增大 maxChars 或设 0 不限制");
      }
      throw new Error("会话不存在或没有可朗读的消息: " + sessionId);
    }

    const totalChars = roleChunks.reduce((s, c) => s + c.charCount, 0);
    if (totalChars > HARD_CHAR_CAP) throw new Error("会话过长，超过 200000 字符上限");

    const requestId = newRequestId();
    storeSession({
      requestId,
      sessionId,
      sessionIdSource: sessionSource,
      voice,
      rate,
      chunks: roleChunks,
      createdAt: Date.now(),
    });

    const payload = {
      ok: true,
      requestId,
      sessionId,
      sessionSource,
      voice,
      rate,
      chunks: roleChunks,
      totalChars,
      truncated,
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  } finally {
    db.close();
  }
}

// 按消息分块以保留 role/label（buildSpeechChunks 返回纯文本数组，丢失角色信息）。
function buildRoleChunks(messages, maxLen, maxChars) {
  const out = [];
  let total = 0;
  let truncated = false;
  for (const message of messages) {
    const sentences = splitSentences(replaceCodeBlocks(message.text), maxLen);
    for (const sentence of sentences) {
      if (maxChars > 0 && total + sentence.length > maxChars) {
        truncated = true;
        break;
      }
      out.push({
        index: out.length,
        role: message.role,
        label: roleLabel(message.role),
        text: sentence,
        charCount: sentence.length,
      });
      total += sentence.length;
    }
    if (truncated) break;
  }
  return { chunks: out, truncated };
}

// ---------------------------------------------------------------- speak_chunk

async function toolSpeakChunk(args) {
  const requestId = String(args.requestId || "");
  const index = Number(args.index);
  if (!Number.isInteger(index) || index < 0) throw new Error("index 必须是非负整数");

  const entry = sessions.get(requestId);
  if (!entry) {
    const known = [...sessions.keys()];
    throw new Error(
      "未知 requestId: " + requestId + (known.length ? "（已知: " + known.join(", ") + "）" : "（无已知 requestId）")
    );
  }
  if (index >= entry.chunks.length) {
    throw new Error("index 越界: " + index + "（该会话共 " + entry.chunks.length + " 块）");
  }

  const chunk = entry.chunks[index];
  // P0-1 变更语义：chunk 请求带 voice/rate 则覆盖请求记录值
  const effectiveVoice = resolveEdgeVoice(args.voice !== undefined ? args.voice : entry.voice);
  const effectiveRate = normalizeRate(args.rate !== undefined ? args.rate : entry.rate);
  const rateArg = edgeRateArg(effectiveRate);

  const { buf, cached } = synthesizeChunk(chunk.text, effectiveVoice, rateArg);

  const payload = {
    ok: true,
    requestId,
    index,
    text: chunk.text,
    voice: effectiveVoice,
    rate: effectiveRate,
    dataUri: "data:audio/mpeg;base64," + buf.toString("base64"),
    bytes: buf.length,
    cached,
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// ---------------------------------------------------------------- list_voices / session_info

function toolListVoices() {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, voices: VOICE_META }) }] };
}

function toolSessionInfo(meta) {
  const dbPath = process.env.RA_DB_PATH || defaultDbPath();
  let pythonResolvedStr = null;
  try {
    const r = resolvePython();
    pythonResolvedStr = r.path;
  } catch {
    pythonResolvedStr = null;
  }
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: true,
          sessionId: meta && meta.sessionId ? String(meta.sessionId) : null,
          dbPath,
          dbExists: existsSync(dbPath),
          pythonResolved: pythonResolvedStr,
        }),
      },
    ],
  };
}

// ---------------------------------------------------------------- 参数校验

function normalizeRate(rate) {
  const numeric = Number(rate);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(-10, Math.min(10, Math.round(numeric)));
}

function normalizeMaxChars(maxChars) {
  if (maxChars === undefined || maxChars === null) {
    const env = Number(process.env.RA_MAX_CHARS);
    return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_CHARS;
  }
  const numeric = Number(maxChars);
  if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_MAX_CHARS;
  return numeric;
}
