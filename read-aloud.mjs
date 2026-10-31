#!/usr/bin/env node
// read-aloud.mjs — 「朗读」按钮的后端：CLI + 内联片段生成器（全自研，零复制）。
//
// 子命令：
//   dump     从 ZCode db.sqlite（只读）提取会话上下文 → 纯文本（角色标注 + 代码块占位）
//            会话定位：--session <id> 显式指定 / --session-by-text <指纹> 文本指纹定位（互斥）；
//            指纹只认真实用户消息（role=user + type=text + 非合成注入）；
//            都不给才走默认解析（最近更新的主会话，多窗口并行时会取错，故只在明确知道时用）
//   speak    无头朗读（引擎 sapi 默认 / minimax / edge；--dry-run 只打印命令）
//   widget   把 dump 文本生成内联 HTML 片段（ZCode Gen UI，宿主唯一受支持的 UI 面）
//   voices   列 SAPI 语音（标注 zh-CN，并说明与浏览器语音表的差异）
//   sessions 列最近会话（过滤子代理会话），便于选 --session
//
// 硬约束：db.sqlite 一律 readOnly 打开、单次查询、零写入；正文默认经文件传递（不经命令行），
// 书面例外只有 minimax 与 edge 两个引擎（llm.mjs 只收位置参数、edge-tts 只收 --text，两者均无
// stdin/文件模式；minimax 分块 ≤3000 字）；sapi 的正文一律经 UTF-8 无 BOM 文件传递。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------- 常量

const ROLE_LABELS = { user: "用户", assistant: "助手", system: "系统", tool: "工具" };
const ROLE_TAGS = { user: "【用户】", assistant: "【助手】", system: "【系统】", tool: "【工具】" };
const TAG_TO_ROLE = {};
for (const [key, tag] of Object.entries(ROLE_TAGS)) TAG_TO_ROLE[tag] = key;

const ZWSP = "​"; // 行首转义用零宽空格：不可见、朗读无影响，用于防止正文被误判成角色标记
const CODE_PLACEHOLDER = "（代码略）";
const DEFAULT_MAX_CHARS = 12000;
const SAPI_MAX_CHUNK = 120; // SAPI 单块上限（超长走二次切分）
const MINIMAX_MAX_CHUNK = 3000; // llm.mjs tts 的位置参数上限（Windows 命令行安全区）
const WIDGET_MAX_SENTENCE = 200; // 片段里单句展示上限
const SAPI_VOICE_PREFERENCE = ["Microsoft Huihui", "Yaoyao", "Kangkang"];
const SESSION_TEXT_SEARCH_LIMIT = 10; // --session-by-text 默认在最近 10 个主会话里找指纹
const PS7 = "C:/Program Files/PowerShell/7/pwsh.exe";
const LOCAL_AI_LLM = path.join(os.homedir(), ".zcode", "skills", "local-ai", "llm.mjs");
const WIDGET_ROOT_ID = "read-aloud-widget";

// ---------------------------------------------------------------- 小工具

function defaultDbPath() {
  return path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        out[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out[body] = next;
          i++;
        } else {
          out[body] = true;
        }
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function die(message, code = 2) {
  process.stderr.write("read-aloud: " + message + "\n");
  process.exit(code);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// node:sqlite 在 Node 22 仍是实验特性，加载时会打 ExperimentalWarning；只针对 SQLite 静音，
// 其余警告照旧。用动态 import 以便在 import 之前装好过滤器。
async function openDatabase(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error("数据库不存在: " + dbPath);
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    // 调用形态可能是 (warning, type, code) 或 (warning, options)
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

// ---------------------------------------------------------------- 合成消息过滤（预审 P0）

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

// 用 substr 做精确前缀匹配：LIKE 里的下划线是单字符通配符，会把 sess_subagentX... 之类也误伤。
const SESSION_FILTER =
  "WHERE time_deleted IS NULL AND substr(id, 1, 14) <> 'sess_subagent_' AND substr(id, 1, 9) <> 'sess_dwf-'";

function listSessions(db, limit) {
  return db
    .prepare("SELECT id, title, time_updated FROM session " + SESSION_FILTER + " ORDER BY time_updated DESC LIMIT ?")
    .all(Math.max(1, limit));
}

// 默认会话：time_updated 最新，且排除子代理/工作流会话前缀（库内子代理会话近两千个，不排除会取错）。
function resolveSessionId(db, explicit) {
  if (explicit) return explicit;
  const row = db.prepare("SELECT id FROM session " + SESSION_FILTER + " ORDER BY time_updated DESC LIMIT 1").get();
  if (!row) throw new Error("找不到可用会话（已排除子代理/工作流会话）");
  return row.id;
}

// 会话行的一行展示（sessions 列表与多命中候选共用同一格式，保证两处信息一致）。
function formatSessionLine(row) {
  const when = new Date(row.time_updated).toISOString().replace("T", " ").slice(0, 19);
  const title = String(row.title || "").replace(/\s+/g, " ").slice(0, 60);
  return "  " + when + "  " + row.id + "  " + title;
}

// 指纹定位会话：在最近 limit 个主会话里找「真实用户消息的正文含该子串」的会话。
//
// 为什么需要它：默认解析取的是「最近更新的主会话」，多窗口并行时会静默取到另一个窗口的会话
// （本机实测默认取到并行窗口的会话、当前对话在另一个 id，且不报错）。
// 命中判定（三条同时成立才算命中，缺一不可）：
//   1) part.data.type === 'text'（reasoning / tool 里也会出现原文片段，不能算命中）；
//   2) 消息与 part 都不是合成注入（复用 isSyntheticRecord）——宿主注入的 synthetic 块
//      （role=user/type=text/synthetic=true/visibility=model-only/src=tool_search_announcement
//      等）在本机散布于上千个会话里，不滤掉就会伪多命中；更危险的是「当前会话不在候选集 +
//      恰好只有一个别的候选只在 synthetic 块里命中」时会**唯一命中且静默取错会话**；
//   3) 消息 role === 'user'（真实用户消息即 role=user + type=text；助手复述不算）。
// 匹配用 JS 侧的 indexOf（大小写敏感）；SQL LIKE 只作预筛（宽进严出），
// 预筛用 JSON 转义后的指纹形态（引号/反斜杠在库里是转义过的）。
function findSessionsByText(db, fingerprint, limit) {
  const needle = String(fingerprint == null ? "" : fingerprint);
  if (!needle.trim()) throw new Error("--session-by-text 需要非空的指纹文本");
  const candidates = listSessions(db, limit == null ? SESSION_TEXT_SEARCH_LIMIT : limit);
  const escaped = JSON.stringify(needle).slice(1, -1);
  const patterns = escaped === needle ? [needle] : [escaped, needle];
  const hits = [];
  for (const session of candidates) {
    let matched = false;
    for (const pattern of patterns) {
      const rows = db
        .prepare(
          "SELECT m.data AS mdata, p.data AS pdata FROM message m JOIN part p ON p.message_id = m.id " +
            "WHERE m.session_id = ? AND p.data LIKE ?"
        )
        .all(session.id, "%" + pattern + "%");
      for (const row of rows) {
        const mdata = parseJson(row.mdata) || {};
        const pdata = parseJson(row.pdata) || {};
        if (pdata.type !== "text") continue;
        if (isSyntheticRecord(mdata) || isSyntheticRecord(pdata)) continue;
        if (mdata.role !== "user") continue;
        const text = typeof pdata.text === "string" ? pdata.text : "";
        if (text.indexOf(needle) >= 0) {
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (matched) hits.push(session);
  }
  return hits;
}

// 过滤后的逐条消息（一条 DB 消息一项；同一消息的多个 text part 用空行相接）。
// 注意：这里【不并块】——--last 要按消息数切，必须作用在并块之前的列表上。
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

// 连续的同类角色消息合并为一个展示块（仅影响展示，不影响 --last 的计数口径）。
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

function extractMessages(db, sessionId) {
  return mergeConsecutive(readTextMessages(db, sessionId));
}

function replaceCodeBlocks(text) {
  let out = String(text).replace(/```[\s\S]*?```/g, CODE_PLACEHOLDER);
  out = out.replace(/```[\s\S]*$/g, CODE_PLACEHOLDER); // 未闭合围栏：剩余全部算代码
  return out;
}

function roleLabel(role) {
  if (!role) return "文本";
  return ROLE_LABELS[role] || role;
}

// ---------------------------------------------------------------- dump 会话解析

// dump 的会话解析：--session（显式 id）与 --session-by-text（文本指纹）互斥，都不给才走默认解析。
// 默认解析取「最近更新的主会话」——多窗口并行时会静默取到另一个窗口的会话，因此指纹命中唯一时
// 必须显式带 --session；零命中 / 多命中一律报错退出，绝不猜。
function resolveDumpSessionId(db, options) {
  const explicit = options.session === undefined ? undefined : valueOption(options.session, "session");
  const fingerprint =
    options["session-by-text"] === undefined ? undefined : valueOption(options["session-by-text"], "session-by-text");
  if (explicit !== undefined && fingerprint !== undefined) {
    die("--session 与 --session-by-text 互斥：只能给其中一个");
  }
  if (fingerprint !== undefined) {
    if (!String(fingerprint).trim()) die("--session-by-text 需要非空的指纹文本");
    const limit =
      options["session-by-text-limit"] === undefined
        ? SESSION_TEXT_SEARCH_LIMIT
        : Number(valueOption(options["session-by-text-limit"], "session-by-text-limit"));
    if (!Number.isInteger(limit) || limit <= 0) die("--session-by-text-limit 需要正整数");
    const hits = findSessionsByText(db, fingerprint, limit);
    if (!hits.length) {
      die(
        "指纹未命中任何会话（在最近 " + limit + " 个主会话的真实用户消息里没找到该子串）：" + fingerprint +
          "\n三步补救：① 原样重试一次（会话可能还没落盘）；" +
          "② 加 --session-by-text-limit 50 扩大候选集；" +
          "③ 才换更短的指纹片段重试。"
      );
    }
    if (hits.length > 1) {
      die(
        "指纹命中多个会话，无法自动判定（" + hits.length + " 个候选）：\n" +
          hits.map(formatSessionLine).join("\n") +
          "\n请用 --session <id> 明确指定其中一个。"
      );
    }
    return hits[0].id;
  }
  if (explicit !== undefined && !String(explicit).trim()) {
    die("--session 需要一个非空的会话 id");
  }
  return resolveSessionId(db, explicit);
}

// ---------------------------------------------------------------- dump 文本格式（可往返）

function formatDump(messages) {
  const lines = [];
  messages.forEach(function (message, index) {
    if (index > 0) lines.push("");
    const tag = ROLE_TAGS[message.role] || "【" + roleLabel(message.role) + "】";
    const body = replaceCodeBlocks(message.text).replace(/\r\n/g, "\n").split("\n");
    body.forEach(function (line, position) {
      let safe = line;
      if (/^【[^】]{1,12}】/.test(safe)) safe = ZWSP + safe; // 防正文被误判成角色标记
      lines.push(position === 0 ? tag + safe : safe);
    });
  });
  return lines.join("\n");
}

// dump 文本 → 消息块。行首零宽空格先剥掉再匹配角色标记，保证 formatDump/parseDump 往返无损。
function parseDump(text) {
  const lines = String(text == null ? "" : text).replace(/\r\n/g, "\n").split("\n");
  const messages = [];
  let current = null;
  for (const raw of lines) {
    const line = raw.charAt(0) === ZWSP ? raw.slice(1) : raw;
    const matched = /^【([^】]{1,12})】/.exec(line);
    const role = matched ? TAG_TO_ROLE["【" + matched[1] + "】"] || matched[1] : null;
    if (role) {
      const rest = line.slice(matched[0].length);
      current = { role: role, text: rest.charAt(0) === ZWSP ? rest.slice(1) : rest };
      messages.push(current);
    } else if (current) {
      current.text += "\n" + line;
    } else if (line.trim()) {
      current = { role: null, text: line };
      messages.push(current);
    }
  }
  for (const message of messages) {
    message.text = message.text.replace(/^\n+/, "").replace(/\s+$/, "");
  }
  return messages.filter(function (message) {
    return message.text.length > 0;
  });
}

// ---------------------------------------------------------------- 句子分块器

const SENTENCE_ENDERS = "。！？；…!?;\n";
const REPEATABLE_ENDERS = "…！？!?"; // 这些符号连续出现时不切，避免产生孤儿块

// 先按中英文句末标点切（标点留在前块），超长块再按逗号/空格二次切分；不产生空块。
function splitSentences(text, maxLen) {
  const limit = Math.max(20, Number(maxLen) || SAPI_MAX_CHUNK);
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

function buildSpeechChunks(messages, maxLen) {
  const chunks = [];
  for (const message of messages) {
    const sentences = splitSentences(replaceCodeBlocks(message.text), maxLen);
    for (const sentence of sentences) chunks.push(sentence);
  }
  return chunks;
}

// ---------------------------------------------------------------- SAPI（PowerShell 侧脚本）

// 文本一律经文件传递（chunks.json + manifest.txt），不经命令行，规避引号/编码坑。
//
// 单元素数组退化（PowerShell 坑）：`ConvertFrom-Json` 对 **单元素** JSON 数组会把它摊平成标量
// （`["你好"]` → 字符串 "你好"），于是 `$chunks[0]` 取到的是**第一个字符**，只念一个字还照样退出码 0。
// 修法：分块清单解析必须用 `@(...)` 包住，保证数组语义（`@()` 对多元素无副作用）。
// 同类点已全量审过：
//   - 分块清单解析（ConvertFrom-Json）→ 已用 @() 包裹（本 bug 的根因，单测有回归断言）；
//   - voices 枚举（GetInstalledVoices | ForEach-Object）→ 走管道不涉 JSON，无退化面；
//   - manifest 读取（Add-Content 逐行写、Node 侧按行读）→ 纯文本逐行，无退化面。
function buildSapiScript() {
  return [
    "param(",
    "  [Parameter(Mandatory = $true)][string]$ChunksFile,",
    '  [string]$Voice = "",',
    "  [int]$Rate = 0,",
    '  [string]$WavDir = "",',
    '  [string]$Manifest = ""',
    ")",
    "$ErrorActionPreference = \"Stop\"",
    "Add-Type -AssemblyName System.Speech",
    "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(",
    "  44100,",
    "  [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,",
    "  [System.Speech.AudioFormat.AudioChannel]::Mono)",
    "try {",
    "  if ($Voice -ne \"\") {",
    "    $hit = $synth.GetInstalledVoices() | Where-Object {",
    "      $_.VoiceInfo.Name -like (\"*\" + $Voice + \"*\") -or $_.VoiceInfo.Culture -like (\"*\" + $Voice + \"*\")",
    "    } | Select-Object -First 1",
    "    if ($hit -ne $null) { $synth.SelectVoice($hit.VoiceInfo.Name) }",
    "  }",
    "  if ($Rate -ne 0) { $synth.Rate = $Rate }",
    "  $chunks = @(Get-Content -Raw -Encoding utf8 -LiteralPath $ChunksFile | ConvertFrom-Json)",
    "  $total = @($chunks).Count",
    "  for ($i = 0; $i -lt $total; $i++) {",
    "    $text = [string]$chunks[$i]",
    "    if ($WavDir -ne \"\") {",
    '      $wav = Join-Path $WavDir (("chunk_{0:d3}.wav" -f ($i + 1)))',
    "      $synth.SetOutputToWaveFile($wav, $fmt)",
    "      $synth.Speak($text)",
    "      $synth.SetOutputToNull()",
    '      if ($Manifest -ne "") { Add-Content -LiteralPath $Manifest -Value $wav -Encoding utf8 }',
    "    } else {",
    "      $synth.Speak($text)",
    "    }",
    '    $head = $text.Substring(0, [Math]::Min(24, $text.Length))',
    '    Write-Output (("[{0}/{1}] {2}" -f ($i + 1), $total, $head))',
    "  }",
    "} finally {",
    "  try { $synth.SetOutputToNull() } catch { }",
    "  $synth.Dispose()",
    "}",
  ].join("\n");
}

// voices 子命令：只读枚举，输出 name|culture|gender|age
const VOICES_SCRIPT = [
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "try {",
  "  $s.GetInstalledVoices() | ForEach-Object {",
  "    $v = $_.VoiceInfo",
  '    ("" + $v.Name + "|" + $v.Culture + "|" + $v.Gender + "|" + $v.Age)',
  "  }",
  "} finally {",
  "  $s.Dispose()",
  "}",
].join("\n");

function pathOption(value, name) {
  if (value === true) die("--" + name + " 需要一个路径值");
  return value;
}

// 取值型参数缺值（如 --voice 后没跟值）时 parseArgs 会给 true，必须当场报错：
// 否则 true 会泄漏进命令行（dry-run 可见 -Voice true，真实执行抛 ERR_INVALID_ARG_TYPE），
// 或被 Number(true)===1 蒙混过关（--last/--max-chars/--rate 静默取 1）。
function valueOption(value, name) {
  if (value === true) die("--" + name + " 需要一个值");
  return value;
}

function runPs(script, args) {
  return spawnSync(PS7, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script].concat(args || []), {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function listSapiVoices() {
  const result = runPs(VOICES_SCRIPT);
  if (result.error) throw new Error("无法启动 PowerShell 7: " + result.error.message);
  if (result.status !== 0) throw new Error("SAPI 枚举失败: " + String(result.stderr || "").trim());
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map(function (line) {
      return line.trim();
    })
    .filter(Boolean)
    .map(function (line) {
      const parts = line.split("|");
      return { name: parts[0] || "", culture: parts[1] || "", gender: parts[2] || "", age: parts[3] || "" };
    });
}

function pickSapiVoice(voices, hint) {
  const zh = voices.filter(function (voice) {
    return /^zh/i.test(voice.culture || "");
  });
  if (hint) {
    const hit = zh.filter(function (voice) {
      return voice.name.toLowerCase().indexOf(String(hint).toLowerCase()) >= 0;
    });
    if (hit.length) return hit[0];
    const any = voices.filter(function (voice) {
      return voice.name.toLowerCase().indexOf(String(hint).toLowerCase()) >= 0;
    });
    if (any.length) return any[0];
  }
  for (const preference of SAPI_VOICE_PREFERENCE) {
    const hit = zh.filter(function (voice) {
      return voice.name.indexOf(preference) >= 0;
    });
    if (hit.length) return hit[0];
  }
  return zh[0] || voices[0] || null;
}

// ---------------------------------------------------------------- wav 工具

function readWavInfo(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.length < 44) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12;
  let byteRate = 0;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      byteRate = buf.readUInt32LE(offset + 16); // fmt 块内：byteRate 位于块头之后第 16 字节
    } else if (id === "data") {
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) return null;
  const available = buf.length - (offset + 8);
  return { bytes: buf.length, dataSize: dataSize, byteRate: byteRate, seconds: dataSize / byteRate, truncated: available < dataSize };
}

function ffprobeDuration(file) {
  const result = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1", file], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  const matched = /([0-9.]+)/.exec(String(result.stdout || ""));
  return matched ? Number(matched[1]) : null;
}

function ffmpegConcatWav(parts, target) {
  if (!parts.length) throw new Error("没有可合并的分块 wav");
  const dir = path.dirname(target);
  const list = path.join(dir, "read-aloud-concat.txt");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    list,
    parts
      .map(function (part) {
        return "file '" + part.replace(/'/g, "'\\''") + "'";
      })
      .join("\n") + "\n",
    "utf8"
  );
  let result = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", target], {
    encoding: "utf8",
  });
  if (result.error) throw new Error("找不到 ffmpeg: " + result.error.message);
  if (result.status !== 0) {
    result = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:a", "pcm_s16le", "-ar", "44100", "-ac", "1", target], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error("ffmpeg 合并失败: " + String(result.stderr || "").trim());
  }
  return target;
}

// ---------------------------------------------------------------- speak 计划构造

function sapiPlan(chunks, options) {
  let preferred = "";
  try {
    preferred = (pickSapiVoice(listSapiVoices(), options.voiceHint) || {}).name || "";
  } catch (err) {
    preferred = ""; // 探测失败不阻断 dry-run，交给 PowerShell 侧默认语音
  }
  const voice = options.voice || preferred;
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "<tmp>/speak.ps1", "-ChunksFile", "<tmp>/chunks.json", "-Rate", String(options.rate)];
  if (voice) args.push("-Voice", voice);
  let wavDir = null;
  let manifest = null;
  if (options.wav) {
    wavDir = path.join(path.dirname(path.resolve(options.wav)), "read-aloud-parts");
    manifest = "<tmp>/manifest.txt";
    args.push("-WavDir", wavDir, "-Manifest", manifest);
  }
  return { engine: "sapi", chunks: chunks, voice: voice, rate: options.rate, command: PS7, args: args, wavDir: wavDir, wav: options.wav || null };
}

function minimaxPlan(chunks, options) {
  const llm = options.llm || LOCAL_AI_LLM;
  if (!fs.existsSync(llm)) throw new Error("找不到 local-ai 入口: " + llm);
  const dir = options.wav ? path.dirname(path.resolve(options.wav)) : path.join(os.tmpdir(), "read-aloud-minimax");
  const commands = chunks.map(function (chunk, index) {
    return {
      command: process.execPath,
      args: [llm, "tts", chunk, "--out", path.join(dir, "part" + String(index + 1).padStart(3, "0") + ".mp3")],
    };
  });
  return { engine: "minimax", chunks: chunks, commands: commands, dir: dir, wav: options.wav || null };
}

function edgePlan(chunks, options) {
  const probe = spawnSync("edge-tts", ["--version"], { encoding: "utf8" });
  if (probe.error) {
    die("未检测到 edge-tts CLI（" + probe.error.message + "）。安装：pip install edge-tts；本引擎为可选提质，默认 sapi 离线可用", 2);
  }
  const commands = chunks.map(function (chunk, index) {
    return {
      command: "edge-tts",
      args: ["--text", chunk, "--write-media", path.join(os.tmpdir(), "read-aloud-edge", "part" + String(index + 1).padStart(3, "0") + ".mp3")],
    };
  });
  return { engine: "edge", chunks: chunks, commands: commands };
}

function buildSpeakPlan(text, options) {
  const messages = parseDump(text);
  const engine = options.engine || "sapi";
  const maxLen = engine === "minimax" ? MINIMAX_MAX_CHUNK : SAPI_MAX_CHUNK;
  const chunks = buildSpeechChunks(messages, maxLen);
  if (!chunks.length) throw new Error("输入文本没有可朗读内容");
  if (engine === "sapi") return sapiPlan(chunks, options);
  if (engine === "minimax") return minimaxPlan(chunks, options);
  if (engine === "edge") return edgePlan(chunks, options);
  throw new Error("未知引擎: " + engine + "（可选 sapi / minimax / edge）");
}

function printPlan(plan) {
  const lines = [];
  lines.push("[dry-run] engine=" + plan.engine + " chunks=" + plan.chunks.length);
  if (plan.engine === "sapi") {
    lines.push("[dry-run] voice=" + (plan.voice || "(系统默认)") + " rate=" + plan.rate);
    lines.push("[dry-run] " + plan.command + " " + plan.args.join(" "));
    lines.push("[dry-run] 脚本内容为内置 PowerShell（System.Speech），分块清单经 UTF-8 无 BOM 文件传递");
    if (plan.wav) {
      lines.push("[dry-run] --wav " + plan.wav + "（只落盘不播音；分块目录 " + plan.wavDir + "，ffmpeg concat 合并）");
    } else {
      lines.push("[dry-run] 无 --wav：直接发声（Ctrl+C 可中途停）");
    }
  } else {
    plan.commands.forEach(function (command, index) {
      const preview = String(plan.chunks[index] || "").slice(0, 24);
      lines.push("[dry-run] " + command.command + " " + command.args.map(quoteArg).join(" "));
      lines.push("[dry-run]   块 " + (index + 1) + "/" + plan.chunks.length + " 预览: " + preview);
    });
    if (plan.engine === "minimax") {
      lines.push("[dry-run] 分块经 argv 传递（llm.mjs 只收位置参数，无 stdin/文件模式；≤" + MINIMAX_MAX_CHUNK + " 字）");
    } else {
      lines.push("[dry-run] 分块经 argv 传递（edge-tts 只收 --text，无 stdin/文件模式；≤" + SAPI_MAX_CHUNK + " 字）");
    }
  }
  plan.chunks.forEach(function (chunk, index) {
    lines.push("[dry-run] 块 " + (index + 1) + "/" + plan.chunks.length + " (" + chunk.length + " 字): " + chunk.slice(0, 60));
  });
  return lines.join("\n");
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? '"' + text.replace(/"/g, '\\"') + '"' : text;
}

// spawn 可注入（测试用）：默认 node:child_process 的 spawnSync。
function runSapi(plan, spawn) {
  const spawnFn = typeof spawn === "function" ? spawn : spawnSync;
  const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "read-aloud-"));
  try {
    const chunksFile = path.join(tmpDir, "chunks.json");
    fs.writeFileSync(chunksFile, JSON.stringify(plan.chunks), "utf8"); // node 写 UTF-8 不带 BOM
    const psFile = path.join(tmpDir, "speak.ps1");
    fs.writeFileSync(psFile, buildSapiScript(), "utf8");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psFile, "-ChunksFile", chunksFile, "-Rate", String(plan.rate)];
    if (plan.voice) args.push("-Voice", plan.voice);
    let manifest = null;
    if (plan.wav) {
      fs.mkdirSync(plan.wavDir, { recursive: true });
      manifest = path.join(tmpDir, "manifest.txt");
      args.push("-WavDir", plan.wavDir, "-Manifest", manifest);
    }
    const result = spawnFn(PS7, args, { stdio: "inherit", encoding: "utf8" });
    // fail-closed：spawn 失败（如 PS7 不在硬编码路径）时 result.error 有值、status 为 null，
    // 不检查就会被下面的 interrupted 判成"干净结束"，把 FAIL 报成 PASS。与 listSapiVoices 同款写法。
    if (result.error) throw new Error("无法启动 PowerShell 7: " + result.error.message);
    const interrupted = result.signal != null || (result.status != null && result.status !== 0);
    if (!plan.wav) {
      return { interrupted: interrupted, status: result.status };
    }
    // 只合并「干净结束」的块：未完成块的 wav 头未 finalize，吃了就是损坏音频。
    const listed =
      manifest && fs.existsSync(manifest)
        ? stripBom(fs.readFileSync(manifest, "utf8"))
            .split(/\r?\n/)
            .map(function (line) {
              return line.trim();
            })
            .filter(Boolean)
        : [];
    const usable = [];
    for (const wav of listed) {
      const info = readWavInfo(wav);
      if (!info || info.truncated) {
        process.stderr.write("read-aloud: 跳过损坏/未完成的分块 wav: " + wav + "\n");
        continue;
      }
      usable.push(wav);
    }
    if (!usable.length) {
      const why = result.status != null && result.status !== 0 ? "（PowerShell 退出码 " + result.status + "）" : "（可能被中途打断）";
      throw new Error("没有完整的分块 wav 可合并" + why);
    }
    ffmpegConcatWav(usable, plan.wav);
    const info = readWavInfo(plan.wav);
    const seconds = info ? info.seconds : ffprobeDuration(plan.wav);
    return { interrupted: interrupted, status: result.status, wav: plan.wav, seconds: seconds, parts: usable.length };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}

function runCommandList(plan) {
  const dir = plan.dir || path.join(os.tmpdir(), "read-aloud-" + plan.engine);
  fs.mkdirSync(dir, { recursive: true });
  const parts = [];
  plan.commands.forEach(function (command, index) {
    process.stdout.write("[read-aloud] (" + (index + 1) + "/" + plan.commands.length + ") " + command.command + "\n");
    const result = spawnSync(command.command, command.args, { stdio: "inherit", encoding: "utf8" });
    if (result.error) throw new Error("启动失败: " + command.command + " — " + result.error.message);
    if (result.status !== 0) throw new Error("命令退出码 " + result.status + ": " + command.command);
    const out = command.args[command.args.length - 1];
    if (out && fs.existsSync(out)) parts.push(out);
  });
  return parts;
}

// ---------------------------------------------------------------- widget 片段生成

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 内联脚本：vm-safe —— 加载期只用 getElementById/addEventListener/classList/textContent/
// style/scrollIntoView/setAttribute + 全部 typeof 守卫的 window.zcode.*、speechSynthesis、
// SpeechSynthesisUtterance。不用 rAF/fetch/matchMedia 等未守卫的浏览器 API。
const WIDGET_SCRIPT = `(function () {
  "use strict";
  var speakBtn = document.getElementById("ra-speak");
  var pauseBtn = document.getElementById("ra-pause");
  var pauseLabel = document.getElementById("ra-pause-label");
  var stopBtn = document.getElementById("ra-stop");
  var rateLabel = document.getElementById("ra-rate-label");
  var rateSel = document.getElementById("ra-rate");
  var statusEl = document.getElementById("ra-status");
  var hintEl = document.getElementById("ra-hint");
  var bar = document.getElementById("ra-progress-bar");
  var progress = document.getElementById("ra-progress");
  var dataEl = document.getElementById("ra-data");

  var synth = null;
  if (typeof window.speechSynthesis !== "undefined" && window.speechSynthesis) {
    synth = window.speechSynthesis;
  }
  var Utter = null;
  if (typeof window.SpeechSynthesisUtterance !== "undefined") {
    Utter = window.SpeechSynthesisUtterance;
  }

  var queue = [];
  if (dataEl) {
    try {
      var parsed = JSON.parse(dataEl.textContent || "[]");
      if (Object.prototype.toString.call(parsed) === "[object Array]") queue = parsed;
    } catch (err) {
      queue = [];
    }
  }

  var sentEls = [];
  (function cacheSentences() {
    for (var k = 0; ; k++) {
      var el = document.getElementById("ra-sent-" + k);
      if (!el) break;
      sentEls.push(el);
    }
  })();

  var rate = 1;
  var voice = null;
  var pos = 0;
  var runId = 0;
  var state = "idle";

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function setExpanded(on) {
    if (pauseBtn) pauseBtn.style.display = on ? "" : "none";
    if (stopBtn) stopBtn.style.display = on ? "" : "none";
    if (rateLabel) rateLabel.style.display = on ? "" : "none";
  }

  function setActive(index) {
    for (var k = 0; k < sentEls.length; k++) {
      var el = sentEls[k];
      if (k === index) el.classList.add("is-active");
      else el.classList.remove("is-active");
      if (k < index) el.classList.add("is-read");
      else el.classList.remove("is-read");
    }
    var current = sentEls[index];
    if (current && typeof current.scrollIntoView === "function") {
      current.scrollIntoView({ block: "nearest" });
    }
    // index 为 -1（停止）时进度归零，不能出现负百分比
    var pct = index >= 0 && sentEls.length ? Math.round((index / sentEls.length) * 100) : 0;
    if (bar) bar.style.width = pct + "%";
    // aria-valuenow 与视觉进度同步更新，屏幕阅读器才读得到朗读进度
    if (progress) progress.setAttribute("aria-valuenow", String(pct));
  }

  function pickVoice() {
    if (!synth || typeof synth.getVoices !== "function") return null;
    var list = synth.getVoices() || [];
    for (var i = 0; i < list.length; i++) {
      var lang = String((list[i] && list[i].lang) || "").toLowerCase();
      if (lang.indexOf("zh") === 0) return list[i];
    }
    return null;
  }

  function refreshVoices() {
    voice = pickVoice();
    var usable = !!voice && !!Utter && queue.length > 0;
    if (speakBtn) speakBtn.disabled = !usable;
    if (hintEl) hintEl.style.display = usable ? "none" : "";
    if (!usable) {
      if (queue.length === 0) setStatus("没有可朗读的文本");
      else setStatus("未检测到中文语音，朗读不可用");
    }
    return usable;
  }

  function speakFrom(myRun) {
    if (myRun !== runId) return;
    if (pos >= queue.length) {
      finishRun();
      return;
    }
    var item = queue[pos] || {};
    var utterance = new Utter(String(item.text || ""));
    utterance.lang = "zh-CN";
    utterance.rate = rate;
    if (voice) {
      try {
        utterance.voice = voice;
      } catch (err) {
        /* 个别浏览器不允许直接指派 voice，忽略即可 */
      }
    }
    utterance.onend = function () {
      if (myRun !== runId) return;
      pos = pos + 1;
      speakFrom(myRun);
    };
    utterance.onerror = function () {
      if (myRun !== runId) return;
      pos = pos + 1;
      speakFrom(myRun);
    };
    setActive(pos);
    setStatus("正在朗读 " + (pos + 1) + " / " + queue.length);
    try {
      synth.speak(utterance);
    } catch (err) {
      // 个别环境（无音频设备等）speak 直接抛异常，不能把 UI 卡在「朗读中」
      state = "idle";
      setExpanded(false);
      if (speakBtn) speakBtn.setAttribute("aria-pressed", "false");
      setStatus("朗读启动失败，可改用 CLI: node read-aloud.mjs speak <文本文件>");
    }
  }

  function startRun() {
    refreshVoices();
    if (!synth || !Utter || queue.length === 0 || !voice) return;
    runId = runId + 1;
    var myRun = runId;
    if (typeof synth.cancel === "function") synth.cancel();
    pos = 0;
    state = "speaking";
    setExpanded(true);
    if (speakBtn) speakBtn.setAttribute("aria-pressed", "true");
    if (pauseLabel) pauseLabel.textContent = "暂停";
    speakFrom(myRun);
  }

  function stopRun() {
    runId = runId + 1;
    if (synth && typeof synth.cancel === "function") synth.cancel();
    state = "idle";
    setExpanded(false);
    if (speakBtn) speakBtn.setAttribute("aria-pressed", "false");
    setActive(-1);
    if (bar) bar.style.width = "0%";
    setStatus("已停止");
  }

  function finishRun() {
    state = "done";
    setExpanded(false);
    if (speakBtn) speakBtn.setAttribute("aria-pressed", "false");
    setActive(sentEls.length - 1);
    if (bar) bar.style.width = "100%";
    if (progress) progress.setAttribute("aria-valuenow", "100");
    setStatus("朗读完成，共 " + queue.length + " 句");
  }

  function togglePause() {
    if (state === "speaking") {
      if (synth && typeof synth.pause === "function") synth.pause();
      state = "paused";
      if (pauseLabel) pauseLabel.textContent = "继续";
      setStatus("已暂停 " + (pos + 1) + " / " + queue.length);
    } else if (state === "paused") {
      if (synth && typeof synth.resume === "function") synth.resume();
      state = "speaking";
      if (pauseLabel) pauseLabel.textContent = "暂停";
      setStatus("正在朗读 " + (pos + 1) + " / " + queue.length);
    }
  }

  function restartCurrent() {
    if (state !== "speaking" && state !== "paused") return;
    runId = runId + 1;
    var myRun = runId;
    if (synth && typeof synth.cancel === "function") synth.cancel();
    state = "speaking";
    if (pauseLabel) pauseLabel.textContent = "暂停";
    speakFrom(myRun);
  }

  function readRate(saved) {
    if (!saved || typeof saved !== "object") return 1;
    var priv = saved.privateContent;
    if (!priv || typeof priv !== "object") return 1;
    var value = priv.rate;
    if (typeof value !== "number" || !isFinite(value) || value < 0.5 || value > 2) return 1;
    return value;
  }

  function applyRate(saved) {
    rate = readRate(saved);
    if (rateSel) rateSel.value = String(rate);
  }

  function saveRate() {
    try {
      if (window.zcode && typeof window.zcode.setWidgetState === "function") {
        var pending = window.zcode.setWidgetState({ modelContent: null, privateContent: { rate: rate } });
        if (pending && typeof pending.then === "function") {
          pending.then(null, function () {});
        }
      }
    } catch (err) {
      /* 宿主未提供状态持久化（如 standalone 导出）时忽略 */
    }
  }

  function hostState() {
    try {
      if (window.zcode && typeof window.zcode.widgetState !== "undefined") {
        return window.zcode.widgetState;
      }
    } catch (err) {
      /* 忽略 */
    }
    return null;
  }

  applyRate(hostState());
  refreshVoices();

  if (speakBtn) speakBtn.addEventListener("click", startRun);
  if (pauseBtn) pauseBtn.addEventListener("click", togglePause);
  if (stopBtn) stopBtn.addEventListener("click", stopRun);
  if (rateSel) {
    rateSel.addEventListener("change", function () {
      var value = parseFloat(rateSel.value);
      if (!isFinite(value) || value < 0.5 || value > 2) value = 1;
      rate = value;
      saveRate();
      restartCurrent();
    });
  }
  if (synth && typeof synth.addEventListener === "function") {
    synth.addEventListener("voiceschanged", refreshVoices);
  }
  window.addEventListener("zcode:set_globals", function (event) {
    var globals = event && event.detail ? event.detail.globals : null;
    applyRate(globals ? globals.widgetState : null);
  });
})();`;

function buildWidgetFragment(messages) {
  const body = [];
  const items = [];
  let index = 0;
  for (const message of messages) {
    const sentences = splitSentences(replaceCodeBlocks(message.text), WIDGET_MAX_SENTENCE);
    if (!sentences.length) continue;
    body.push('      <p class="ra-msg"><span class="ra-role text-small text-muted">' + escapeHtml(roleLabel(message.role)) + "</span>");
    for (const sentence of sentences) {
      items.push({ role: message.role, label: roleLabel(message.role), text: sentence });
      body.push('        <span class="ra-sent" id="ra-sent-' + index + '">' + escapeHtml(sentence) + "</span> ");
      index++;
    }
    body.push("      </p>");
  }
  if (!items.length) throw new Error("输入文本没有可朗读内容");
  // < 一律转成 \u003c，杜绝正文里的 </script> 提前闭合数据块
  const dataJson = JSON.stringify(items).replace(/</g, "\\u003c");
  const transcript = body.join("\n");
  return `<div id="${WIDGET_ROOT_ID}">
  <style>
    #${WIDGET_ROOT_ID} { display: flex; flex-direction: column; gap: 8px; }
    #ra-transcript { max-height: 360px; overflow: auto; }
    .ra-msg { margin: 0 0 10px; }
    .ra-msg:last-child { margin-bottom: 0; }
    .ra-role { display: block; margin-bottom: 2px; font-weight: 500; }
    .ra-sent { border-radius: 3px; }
    .ra-sent.is-read { color: var(--muted-foreground); }
    .ra-sent.is-active { background: var(--accent); color: var(--accent-foreground); }
  </style>
  <div class="viz-controls">
    <button type="button" class="btn btn-primary btn-sm" id="ra-speak" data-tooltip="朗读" aria-pressed="false">
      <i data-lucide="volume-2" aria-hidden="true"></i>朗读
    </button>
    <button type="button" class="btn btn-secondary btn-sm" id="ra-pause" data-tooltip="暂停或继续" style="display:none">
      <i data-lucide="pause" aria-hidden="true"></i><span id="ra-pause-label">暂停</span>
    </button>
    <button type="button" class="btn btn-secondary btn-sm" id="ra-stop" data-tooltip="停止朗读" style="display:none">
      <i data-lucide="square" aria-hidden="true"></i>停止
    </button>
    <label class="form-label" id="ra-rate-label" for="ra-rate" style="display:none">倍速
      <select class="form-select form-select-xs" id="ra-rate">
        <option value="0.5">0.5×</option>
        <option value="0.75">0.75×</option>
        <option value="1" selected>1×</option>
        <option value="1.25">1.25×</option>
        <option value="1.5">1.5×</option>
        <option value="2">2×</option>
      </select>
    </label>
    <span class="text-small text-muted" id="ra-status" role="status" aria-live="polite"></span>
  </div>
  <div class="progress" id="ra-progress" role="progressbar" aria-label="朗读进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
    <div class="progress-bar" id="ra-progress-bar" style="width:0%"></div>
  </div>
  <p class="text-small text-destructive" id="ra-hint" style="display:none">当前环境没有检测到中文语音，朗读不可用。</p>
  <div class="card">
    <div id="ra-transcript">
${transcript}
    </div>
  </div>
  <script type="application/json" id="ra-data">${dataJson}</script>
  <script>
${WIDGET_SCRIPT}
  </script>
</div>`;
}

// ---------------------------------------------------------------- 子命令实现

async function cmdDump(options) {
  const dbPath = pathOption(options.db, "db") || defaultDbPath();
  const db = await openDatabase(dbPath);
  try {
    const sessionId = resolveDumpSessionId(db, options);
    // --last 按【消息】计：先取过滤后的逐条消息，切完再并块（并块会吞掉同类相邻消息的条数）。
    const raw = readTextMessages(db, sessionId);
    // 会话不存在（或全被合成过滤掉）时不得静默空转：rc=0 + 空输出会把「取错会话」扮成成功。
    if (!raw.length) die("会话不存在或没有可朗读的消息: " + sessionId);
    const total = raw.length;
    let selected = raw;
    if (options.last) {
      const last = Number(valueOption(options.last, "last"));
      if (!Number.isInteger(last) || last <= 0) die("--last 需要正整数");
      selected = raw.slice(Math.max(0, raw.length - last));
    }
    const messages = mergeConsecutive(selected);
    const maxChars =
      options["max-chars"] === undefined ? DEFAULT_MAX_CHARS : Number(valueOption(options["max-chars"], "max-chars"));
    if (!Number.isFinite(maxChars) || maxChars <= 0) die("--max-chars 需要正整数");
    const full = formatDump(messages);
    let text = full;
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    // 截断说明只进 stderr 摘要，不写进正文——否则会被 widget/speak 当正文念出来。
    if (options.out) {
      const target = path.resolve(pathOption(options.out, "out"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text, "utf8");
      process.stderr.write(dumpSummary(sessionId, selected.length, total, messages.length, text.length, truncated, full.length, maxChars) + " → " + target + "\n");
    } else {
      process.stdout.write(text + "\n");
      process.stderr.write(dumpSummary(sessionId, selected.length, total, messages.length, text.length, truncated, full.length, maxChars) + "\n");
    }
  } finally {
    db.close();
  }
}

// 摘要同时报消息数与并块后的块数：--last 按消息计，块数是展示口径，两者可能不同。
// 截断说明（全文 N 字符 / --max-chars N）也只出现在这里，不进正文。
function dumpSummary(sessionId, usedMessages, totalMessages, blocks, chars, truncated, fullChars, maxChars) {
  return (
    "dump: 会话 " + sessionId +
    "，消息 " + usedMessages + "/" + totalMessages + " 条" +
    "（并块后 " + blocks + " 块）" +
    "，字符 " + chars +
    (truncated ? "（全文 " + fullChars + " 字符，已按 --max-chars " + maxChars + " 截断）" : "")
  );
}

function cmdSpeak(positional, options) {
  const file = positional[0];
  if (!file) die("用法: node read-aloud.mjs speak <dump文本文件> [--engine sapi|minimax|edge] [--voice 名字] [--rate -10..10] [--wav out.wav] [--dry-run]");
  if (!fs.existsSync(file)) die("文件不存在: " + file);
  const text = stripBom(fs.readFileSync(file, "utf8"));
  const voice = valueOption(options.voice, "voice");
  const rate = options.rate === undefined ? 0 : Number(valueOption(options.rate, "rate"));
  if (!Number.isInteger(rate) || rate < -10 || rate > 10) die("--rate 需要 -10..10 的整数");
  const plan = buildSpeakPlan(text, {
    engine: options.engine,
    voice: voice,
    voiceHint: voice,
    rate: rate,
    wav: pathOption(options.wav, "wav"),
    llm: pathOption(options.llm, "llm"),
  });
  if (options["dry-run"]) {
    process.stdout.write(printPlan(plan) + "\n");
    return;
  }
  if (plan.engine === "sapi") {
    const outcome = runSapi(plan);
    if (outcome.wav) {
      process.stdout.write("speak: sapi 已合成 " + outcome.parts + " 块 → " + outcome.wav + "（" + (outcome.seconds || 0).toFixed(2) + " 秒）\n");
    } else if (outcome.interrupted) {
      process.stdout.write("speak: 已中断\n");
    } else {
      process.stdout.write("speak: sapi 朗读完成\n");
    }
    return;
  }
  const parts = runCommandList(plan);
  if (plan.wav && parts.length) {
    ffmpegConcatWav(parts, plan.wav);
    const info = readWavInfo(plan.wav);
    process.stdout.write("speak: " + plan.engine + " 已合成 " + parts.length + " 块 → " + plan.wav + "（" + (info ? info.seconds.toFixed(2) : "?") + " 秒）\n");
  } else {
    process.stdout.write("speak: " + plan.engine + " 完成 " + parts.length + " 块（未指定 --wav，分块 mp3 已留在各自 --out）\n");
  }
}

function cmdWidget(positional, options) {
  const file = positional[0];
  if (!file) die("用法: node read-aloud.mjs widget <dump文本文件> (--out <路径> | --vizdir <目录> [--title 标题])");
  if (!fs.existsSync(file)) die("文件不存在: " + file);
  if (!options.out && !options.vizdir) {
    die("必须显式指定 --out <文件> 或 --vizdir <目录>；不接受 cwd 相对默认路径", 2);
  }
  const title = String(valueOption(options.title, "title") || "context").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "context";
  let target;
  if (options.out) {
    target = path.resolve(pathOption(options.out, "out"));
  } else {
    target = path.join(path.resolve(pathOption(options.vizdir, "vizdir")), "read-aloud-" + title + ".html");
  }
  const messages = parseDump(stripBom(fs.readFileSync(file, "utf8")));
  const fragment = buildWidgetFragment(messages);
  if (Buffer.byteLength(fragment, "utf8") > 1024 * 1024) die("片段超过 1MB 上限，请调小 --last/--max-chars", 2);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, fragment, "utf8");
  const items = fragment.match(/id="ra-sent-/g);
  process.stdout.write("widget: " + target + "（句数 " + (items ? items.length : 0) + "，片段 " + Buffer.byteLength(fragment, "utf8") + " 字节）\n");
}

function cmdVoices() {
  const voices = listSapiVoices();
  const zh = voices.filter(function (voice) {
    return /^zh/i.test(voice.culture || "");
  });
  process.stdout.write("SAPI 已安装语音 " + voices.length + " 个（zh-CN " + zh.length + " 个）：\n");
  for (const voice of voices) {
    const mark = /^zh/i.test(voice.culture || "") ? "  ← zh-CN" : "";
    process.stdout.write("  " + voice.name + "  [" + voice.culture + "]  " + voice.gender + "/" + voice.age + mark + "\n");
  }
  process.stdout.write("\n与浏览器 speechSynthesis 语音表的差异：\n");
  process.stdout.write("  - 片段（widget）走浏览器 speechSynthesis，实测无头 Chrome 只有 3 个 zh-CN，且没有 \"Microsoft Huihui Desktop\" 这个变体；\n");
  process.stdout.write("  - 本 CLI 的 sapi 引擎直调 System.Speech，可用全部 " + zh.length + " 个 zh-CN；两者是同一套 Windows 语音的不同暴露面。\n");
}

async function cmdSessions(options) {
  const limit = Number(options.last || 20);
  const db = await openDatabase(pathOption(options.db, "db") || defaultDbPath());
  try {
    const rows = listSessions(db, limit);
    if (!rows.length) {
      process.stdout.write("（没有会话）\n");
      return;
    }
    process.stdout.write("最近会话（已排除 sess_subagent_* / sess_dwf-* 前缀的子代理与工作流会话）：\n");
    for (const row of rows) {
      process.stdout.write(formatSessionLine(row) + "\n");
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- 入口

const USAGE = [
  "read-aloud.mjs — 朗读当前会话上下文",
  "",
  "  dump      [--session ID | --session-by-text 指纹] [--session-by-text-limit N] [--last N] [--max-chars N] [--out 文件] [--db 路径]",
  "  speak     <文本文件> [--engine sapi|minimax|edge] [--voice 名字] [--rate -10..10] [--wav out.wav] [--dry-run] [--llm 路径]",
  "  widget    <文本文件> (--out 文件 | --vizdir 目录 [--title 标题])",
  "  voices",
  "  sessions  [--last N] [--db 路径]",
].join("\n");

async function main(argv) {
  const options = parseArgs(argv);
  const command = options._[0];
  const positional = options._.slice(1);
  switch (command) {
    case "dump":
      return await cmdDump(options);
    case "speak":
      return cmdSpeak(positional, options);
    case "widget":
      return cmdWidget(positional, options);
    case "voices":
      return cmdVoices();
    case "sessions":
      return await cmdSessions(options);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      die("未知子命令: " + command + "\n" + USAGE, 2);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main(process.argv.slice(2)).catch(function (error) {
    die(error && error.message ? error.message : String(error), 1);
  });
}

export {
  buildSapiScript,
  buildSpeechChunks,
  buildSpeakPlan,
  buildWidgetFragment,
  defaultDbPath,
  escapeHtml,
  extractMessages,
  findSessionsByText,
  formatDump,
  openDatabase,
  parseDump,
  parseJson,
  pickSapiVoice,
  printPlan,
  readTextMessages,
  mergeConsecutive,
  readWavInfo,
  replaceCodeBlocks,
  resolveSessionId,
  roleLabel,
  runSapi,
  splitSentences,
  WIDGET_ROOT_ID,
  WIDGET_SCRIPT,
};
