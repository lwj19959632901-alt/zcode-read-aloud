// server.mjs — 朗读插件 MCP stdio server（零依赖，2026-11-03）。
//
// 换行分隔 JSON-RPC 2.0。4 工具：speak_session / speak_chunk / list_voices / session_info。
// 面板资源 ui://read-aloud/panel.html 由 resources/read 读出独立 panel.html。
//
// 设计：§三 server.mjs 设计（PLAN-2026-11-03-read-aloud-formal.md）。
//
// 合成（edge-tts）与 Python 探测一律用异步 spawn：长合成期间事件循环保持可应答
// ping / tools/call（K06）。缓存与超时语义与早期 spawnSync 版本一致。
//
// 离线兜底（K11）：edge-tts 合成失败时回退 PS7 System.Speech 合成 wav，响应
// dataUri 变 audio/wav 并附 engine="sapi"；engine="edge" 为正常路径。
// 正文一律经 UTF-8 无 BOM 文件传递（chunks.json + speak.ps1），不经命令行。

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync, renameSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { pathToFileURL } from "node:url";

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
const SAPI_PS7 = "C:/Program Files/PowerShell/7/pwsh.exe"; // 全路径：短名 pwsh 会落到 WindowsApps 桩
const SAPI_TIMEOUT_MS = 60000;
const MAX_SESSIONS = 5; // LRU

// ---------------------------------------------------------------- 传输：换行分隔 JSON

let buffer = "";

function main() {
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
}

// 作为入口运行时才接管 stdin；被单测 import（命令构造单测）时不得产生副作用。
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isMainModule()) main();

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
let pythonResolveError = null; // 已试全失败时的错误原文（重抛用）
let pythonProbe = null; // 进行中的探测（并发调用共用一次，避免重复 spawn）

function probePython() {
  const candidates = [];
  const raPath = process.env.RA_PYTHON_PATH;
  if (raPath && String(raPath).trim()) candidates.push(String(raPath).trim());
  candidates.push("python", "python3", "py");
  const errors = [];
  return new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (idx >= candidates.length) {
        reject(new Error("未找到可用的 Python（已尝试: " + candidates.join(", ") + "）。" + errors.join("; ")));
        return;
      }
      const cand = candidates[idx++];
      const args = cand === "py" ? ["-3", "--version"] : ["--version"];
      let settled = false;
      let stdout = "";
      let child;
      try {
        child = spawn(cand, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      } catch (e) {
        errors.push(cand + ": " + e.message);
        tryNext();
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        errors.push(cand + ": 探测超时");
        tryNext();
      }, PYTHON_VERIFY_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      child.stdout.on("data", (d) => { if (stdout.length < 4096) stdout += d.toString("utf8"); });
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        errors.push(cand + ": " + e.message);
        tryNext();
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0 && /Python\s/i.test(stdout)) {
          resolve({ path: cand });
          return;
        }
        errors.push(cand + ": status=" + code);
        tryNext();
      });
    };
    tryNext();
  });
}

async function resolvePython() {
  if (pythonResolved !== null) {
    if (pythonResolved) return { path: pythonResolved };
    throw new Error(pythonResolveError || "未找到可用的 Python");
  }
  if (!pythonProbe) {
    pythonProbe = probePython()
      .then((probed) => {
        pythonResolved = probed.path;
        return probed;
      })
      .catch((e) => {
        pythonResolved = false;
        pythonResolveError = String((e && e.message) || e);
        throw e;
      })
      .finally(() => {
        pythonProbe = null;
      });
  }
  return pythonProbe;
}

// ---------------------------------------------------------------- 会话存储 + 合成缓存

const sessions = new Map(); // requestId → { sessionId, sessionIdSource, voice, rate, chunks[], createdAt }
let requestCounter = 0;

function newRequestId() {
  return "req_" + process.pid + "_" + requestCounter++ + "_" + Math.random().toString(16).slice(2, 10);
}

function storeSession(entry) {
  if (sessions.has(entry.requestId)) sessions.delete(entry.requestId); // 重存时先摘除，保证插到队尾
  sessions.set(entry.requestId, entry);
  while (sessions.size > MAX_SESSIONS) {
    const oldestKey = sessions.keys().next().value;
    if (oldestKey === undefined) break;
    sessions.delete(oldestKey);
  }
}

// 真 LRU：命中也算访问，把该会话移到 Map 队尾（Map 迭代顺序 = 插入顺序，队首即最久未用）。
function touchSession(requestId) {
  const entry = sessions.get(requestId);
  if (entry === undefined) return undefined;
  sessions.delete(requestId);
  sessions.set(requestId, entry);
  return entry;
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

const inflightSynth = new Map(); // cacheKey → Promise（同 key 并发共用一次合成，避免并发写同一音频文件）

// 小于该值的缓存音频文件视为无效（历史非原子写遗留的半截/空文件防御）。
// 真实 edge mp3 与 SAPI wav（44100Hz/16bit/单声道）都远大于 1KB；只挡明显垃圾，不做内容级解析。
const MIN_CACHE_BYTES = 1024;

function validCacheFile(p) {
  try {
    return existsSync(p) && statSync(p).size >= MIN_CACHE_BYTES;
  } catch {
    return false;
  }
}

function evictCacheFile(p) {
  try { if (existsSync(p)) rmSync(p, { force: true }); } catch { /* ignore */ }
}

function synthTimeoutMs() {
  const env = Number(process.env.RA_SYNTH_TIMEOUT_MS);
  return Number.isFinite(env) && env > 0 ? env : SYNTH_TIMEOUT_MS;
}

// 异步跑外部进程；超时语义与 spawnSync(timeout) 版本一致：到点中止子进程并报错。
function runProcess(label, exe, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (e) {
      reject(new Error(label + " 启动失败: " + e.message));
      return;
    }
    let settled = false;
    let stderr = "";
    let timer = null;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish(new Error(label + " 超时（" + timeoutMs + "ms 未完成）"));
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stderr.on("data", (d) => { if (stderr.length < 4096) stderr += d.toString("utf8"); });
    child.on("error", (e) => finish(new Error(label + " 启动失败: " + e.message)));
    child.on("close", (code) => {
      if (code === 0) return finish();
      finish(new Error(label + " 退出码 " + code + ": " + String(stderr || "").trim().slice(0, 200)));
    });
  });
}

// edge 合成与 SAPI 路径同款原子写：先写 .part 临时文件，子进程成功退出后再原子改名到最终缓存位。
// 直写最终路径时，超时 SIGKILL / 中途失败会留下半截 mp3 永久占据该缓存 key，
// 被 existsSync 当有效缓存命中并永久遮蔽 SAPI 兜底 wav（P0-2 评审修复）。
async function synthesizeEdge(text, voice, rateArg, mp3) {
  const { path: python } = await resolvePython();
  const partFile = mp3 + "." + process.pid + "." + Math.random().toString(16).slice(2, 10) + ".part.mp3";
  try {
    const args = ["-m", "edge_tts", "--voice", voice, "--rate=" + rateArg, "--text", text, "--write-media", partFile];
    await runProcess("edge-tts", python, args, synthTimeoutMs());
    if (!existsSync(partFile)) throw new Error("合成未产出 mp3 文件");
    renameSync(partFile, mp3);
  } finally {
    try { if (existsSync(partFile)) rmSync(partFile, { force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- SAPI 离线兜底（PS7 System.Speech）

// 正文经文件传递（chunks.json），脚本经文件传递（speak.ps1），两者都用 fs.writeFileSync(..., "utf8")
// 写出——Node 默认不带 BOM，PS 侧用 -Encoding utf8 读回。
// 单元素数组退化坑（与 read-aloud.mjs buildSapiScript 同款）：ConvertFrom-Json 对单元素数组会
// 摊平成标量，$chunks[0] 取到首字符；必须用 @(...) 包住保证数组语义。
export function buildSapiScript() {
  return [
    "param(",
    "  [Parameter(Mandatory = $true)][string]$TextFile,",
    "  [Parameter(Mandatory = $true)][string]$OutFile,",
    '  [string]$Voice = "",',
    "  [int]$Rate = 0",
    ")",
    '$ErrorActionPreference = "Stop"',
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(",
    "  44100,",
    "  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,",
    "  [System.Speech.AudioFormat.AudioChannel]::Mono)",
    "try {",
    '  if ($Voice -ne "") {',
    "    $hit = $synth.GetInstalledVoices() | Where-Object {",
    '      $_.VoiceInfo.Name -like ("*" + $Voice + "*") -or $_.VoiceInfo.Culture -like ("*" + $Voice + "*")',
    "    } | Select-Object -First 1",
    "    if ($hit -ne $null) { $synth.SelectVoice($hit.VoiceInfo.Name) }",
    "  }",
    "  if ($Rate -ne 0) { $synth.Rate = $Rate }",
    "  $chunks = @(Get-Content -Raw -Encoding utf8 -LiteralPath $TextFile | ConvertFrom-Json)",
    "  $text = [string]$chunks[0]",
    "  $synth.SetOutputToWaveFile($OutFile, $fmt)",
    "  $synth.Speak($text)",
    "  $synth.SetOutputToNull()",
    "} finally {",
    "  try { $synth.SetOutputToNull() } catch { }",
    "  $synth.Dispose()",
    "}",
  ].join("\n");
}

// edge 音色 → SAPI 音色提示（按性别就近挑；找不到同名/同文化时 PS 侧保持默认音色）。
export function sapiVoiceHint(edgeVoice) {
  const name = String(edgeVoice || "");
  const male = ["zh-CN-YunjianNeural", "zh-CN-YunxiNeural", "zh-CN-YunxiaNeural", "zh-CN-YunyangNeural"];
  return male.indexOf(name) >= 0 ? "Kangkang" : "Huihui";
}

export function sapiPwshPath() {
  return process.env.RA_PS7_PATH || SAPI_PS7;
}

export function buildSapiArgs(opts) {
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    opts.psFile,
    "-TextFile",
    opts.textFile,
    "-OutFile",
    opts.outFile,
    "-Rate",
    String(opts.rate || 0),
  ];
  if (opts.voiceHint) args.push("-Voice", opts.voiceHint);
  return args;
}

// 合成到 outFile；先写临时文件再原子改名，避免中断留下半截 wav 被当成缓存命中。
async function synthesizeSapi(text, edgeVoice, rate, outFile) {
  const ps7 = sapiPwshPath();
  if (!existsSync(ps7)) throw new Error("未找到 PowerShell 7（" + ps7 + "）");
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "read-aloud-sapi-"));
  const partFile = outFile + "." + process.pid + "." + Math.random().toString(16).slice(2, 10) + ".part.wav";
  try {
    const textFile = path.join(tmpDir, "chunks.json");
    writeFileSync(textFile, JSON.stringify([text]), "utf8"); // UTF-8 无 BOM
    const psFile = path.join(tmpDir, "speak.ps1");
    writeFileSync(psFile, buildSapiScript(), "utf8"); // UTF-8 无 BOM
    const args = buildSapiArgs({
      psFile,
      textFile,
      outFile: partFile,
      voiceHint: sapiVoiceHint(edgeVoice),
      rate,
    });
    await runProcess("SAPI（PowerShell 7）", ps7, args, SAPI_TIMEOUT_MS);
    if (!existsSync(partFile)) throw new Error("合成未产出 wav 文件");
    renameSync(partFile, outFile);
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (existsSync(partFile)) rmSync(partFile, { force: true }); } catch { /* ignore */ }
  }
}

// 返回 { buf, engine: "edge"|"sapi", cached }；edge 失败即回退 SAPI（wav）。
async function synthesizeChunk(text, voice, rateArg, sapiRate) {
  const cacheDir = getCacheDir();
  mkdirSync(cacheDir, { recursive: true });
  const key = cacheKeyFor(text, voice, rateArg);
  const mp3 = path.join(cacheDir, key + ".mp3");
  const wav = path.join(cacheDir, key + ".wav");
  if (validCacheFile(mp3)) return { buf: readFileSync(mp3), engine: "edge", cached: true };
  evictCacheFile(mp3); // 半截/空 mp3 清掉再重合成，别让它永久占位遮蔽 SAPI 兜底 wav

  let job = inflightSynth.get(key);
  if (!job) {
    job = produce(text, voice, rateArg, sapiRate, mp3, wav).finally(() => inflightSynth.delete(key));
    inflightSynth.set(key, job);
  }
  const got = await job;
  return { buf: readFileSync(got.file), engine: got.engine, cached: got.cached };
}

async function produce(text, voice, rateArg, sapiRate, mp3, wav) {
  try {
    await synthesizeEdge(text, voice, rateArg, mp3);
    return { file: mp3, engine: "edge", cached: false };
  } catch (edgeErr) {
    // 回退 SAPI：已有有效 wav 缓存直接复用（edge 恢复后下次请求会重新尝试 edge）
    if (validCacheFile(wav)) return { file: wav, engine: "sapi", cached: true };
    evictCacheFile(wav); // 无效 wav 同样清掉，避免占位
    try {
      await synthesizeSapi(text, voice, sapiRate, wav);
    } catch (sapiErr) {
      throw new Error(
        "edge-tts 合成失败（" + ((edgeErr && edgeErr.message) || edgeErr) + "）；SAPI 兜底失败（" +
          ((sapiErr && sapiErr.message) || sapiErr) + "）"
      );
    }
    return { file: wav, engine: "sapi", cached: false };
  }
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
            description: "按 requestId+index 逐块取音频（base64 data URI）。voice/rate 可覆盖 speak_session 请求记录值（切音色/倍速时透传，变更生效不需重调 speak_session）；覆盖会回写会话记录，后续不带覆盖的请求沿用新值。",
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
        return reply(msg.id, await toolSessionInfo(meta));
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

  const entry = touchSession(requestId); // 命中也刷新 LRU 位置（含后续越界报错的访问）
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
  // P0-1 变更语义：chunk 请求带 voice/rate 则覆盖请求记录值。
  // P0-2 评审修复：覆盖同时回写会话记录——面板预取与 audio ended 直请都不带覆盖参数，
  // 不回写的话后续块会退回旧音色/旧倍速，且响应回显旧 voice 会把面板 selectedVoice 悄悄改回去。
  const effectiveVoice = resolveEdgeVoice(args.voice !== undefined ? args.voice : entry.voice);
  const effectiveRate = normalizeRate(args.rate !== undefined ? args.rate : entry.rate);
  if (args.voice !== undefined || args.rate !== undefined) {
    entry.voice = effectiveVoice;
    entry.rate = effectiveRate;
  }
  const rateArg = edgeRateArg(effectiveRate);

  const { buf, engine, cached } = await synthesizeChunk(chunk.text, effectiveVoice, rateArg, effectiveRate);
  const mime = engine === "sapi" ? "audio/wav" : "audio/mpeg";

  const payload = {
    ok: true,
    requestId,
    index,
    text: chunk.text,
    voice: effectiveVoice,
    rate: effectiveRate,
    engine,
    mimeType: mime,
    dataUri: "data:" + mime + ";base64," + buf.toString("base64"),
    bytes: buf.length,
    cached,
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

// ---------------------------------------------------------------- list_voices / session_info

function toolListVoices() {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, voices: VOICE_META }) }] };
}

async function toolSessionInfo(meta) {
  const dbPath = process.env.RA_DB_PATH || defaultDbPath();
  let pythonResolvedStr = null;
  try {
    const r = await resolvePython();
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
