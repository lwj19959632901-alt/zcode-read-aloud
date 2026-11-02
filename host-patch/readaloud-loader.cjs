/* ZCode 朗读按钮注入 loader（主进程）。
 *
 * 由 patch-readaloud.py 在 app.asar 入口尾部追加一行 dynamic import 引入。
 * 职责：
 *   1) 解析可用的 python（跳过 Microsoft Store 的 App Execution Alias 桩），预检
 *      `import edge_tts`；
 *   2) 起一个只绑 127.0.0.1、监听临时端口（listen(0)）的 HTTP 桥：
 *        GET  /health            -> {ok, tts, pending, voice, version}
 *        GET  /voices            -> 中文神经音色列表（进程内缓存）
 *        GET/POST /tts           -> 流式 audio/mpeg（python -m edge_tts 的 stdout 直出）
 *      安全：每次启动随机 token（所有路由必带）+ 校验 Host == 127.0.0.1:<port>；
 *      不发 Access-Control-Allow-Origin: *（媒体请求不需要 CORS；JSON 路由按需
 *      回报具体 Origin，鉴权靠 token）。
 *   3) 向宿主自己的渲染页注入 readaloud-renderer.js（URL 含 app.asar/out/renderer）：
 *        browser-window-created / web-contents-created / 现有窗口补注入 /
 *        dom-ready / did-finish-load；渲染脚本 mtime 变化时直接对现存窗口
 *        injectInto() 热重注入（不走 attach 的已 hook 短路）。
 *   任何失败只写日志，绝不影响客户端启动。
 *
 * 零依赖，仅用 node 内置模块 + electron 主进程 API。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const VERSION = "0.1.1";
const HERE = __dirname;
const RENDERER = path.join(HERE, "readaloud-renderer.js");
const LOG_PREFIX = "[readaloud]";

const MAX_TEXT_CHARS = 1200;     // 单次 /tts 请求正文上限（渲染层按 <=900 字切块）
const MAX_CONCURRENT_TTS = 4;    // 防 fork 炸弹
const TTS_TIMEOUT_MS = 25000;    // 单块合成看门狗：超时 kill 子进程并回 504
/* 只向宿主自己的渲染页注入。ZCode 的主窗口 URL 是
   file:///<root>/resources/app.asar/out/renderer/index.html?...
   宿主要用 BrowserWindow 打开外部页面时，token / 桥端口绝不能下发过去。 */
const RENDERER_URL_MARK = "app.asar/out/renderer";
const VOICES_TTL_MS = 60 * 60 * 1000;
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_RATE = "+0%";
const RATE_RE = /^[+-]\d{1,3}%$/;
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2,3}-[A-Za-z0-9]+Neural$/;

function LOG(...args) {
  try {
    console.error(LOG_PREFIX, ...args);
  } catch (e) {
    /* 日志本身不能成为故障源 */
  }
}

/* ---------------------------------------------------------------- electron */

let electron = null;
try {
  electron = require("electron");
} catch (e) {
  electron = null;
}
const app = electron && electron.app;
const BrowserWindow = electron && electron.BrowserWindow;
const webContentsMod = electron && electron.webContents;
const HAS_ELECTRON = !!(app && BrowserWindow);

/* ---------------------------------------------------------------- 状态 */

const state = {
  python: null,          // {file, prefix:[]}
  ttsReady: false,
  pending: true,
  detectError: null,
  port: 0,
  token: "",
  server: null,
  voice: DEFAULT_VOICE,
  voices: null,
  voicesAt: 0,
  voicesPending: null,
  ttsActive: 0,
  rendererCache: null,
  closing: false,
};

function randomToken() {
  return crypto.randomBytes(24).toString("hex");
}

/* ---------------------------------------------------------------- python 发现 */

function isStoreAlias(p) {
  // Microsoft Store 的 python.exe 是 0 字节 App Execution Alias，跑起来只会弹商店
  const lower = String(p || "").toLowerCase();
  return lower.indexOf("\\windowsapps\\") !== -1 || lower.indexOf("/windowsapps/") !== -1;
}

function execCapture(file, args, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    try {
      execFile(file, args, {
        windowsHide: true,
        timeout: timeout || 20000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      }, (err, stdout, stderr) => {
        finish({
          ok: !err,
          code: err && typeof err.code === "number" ? err.code : (err ? -1 : 0),
          stdout: stdout || "",
          stderr: stderr || "",
          error: err ? String(err.message || err) : null,
        });
      });
    } catch (e) {
      finish({ ok: false, code: -1, stdout: "", stderr: "", error: String(e && e.message) });
    }
  });
}

function whereAll(name) {
  const tool = process.platform === "win32" ? "where.exe" : "which";
  return execCapture(tool, [name], 8000).then((r) => {
    if (!r.stdout) return [];
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  });
}

function scanWindowsPythonDirs() {
  const out = [];
  const roots = [
    path.join(os.homedir(), "AppData", "Local", "Programs", "Python"),
    "C:\\",
    "C:\\Program Files",
  ];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (!/^Python3\d{1,2}$/i.test(ent.name)) continue;
      const exe = path.join(root, ent.name, "python.exe");
      try {
        if (fs.statSync(exe).size > 0) out.push(exe);
      } catch (e) {
        /* 不存在就跳过 */
      }
    }
  }
  return out;
}

async function collectPythonCandidates() {
  const seen = new Set();
  const list = [];
  const push = (file, prefix) => {
    if (!file) return;
    const key = file.toLowerCase() + "|" + (prefix || []).join(" ");
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ file, prefix: prefix || [] });
  };

  if (process.env.READALOUD_PYTHON) push(process.env.READALOUD_PYTHON, []);

  if (process.platform === "win32") {
    for (const p of await whereAll("python")) {
      if (!isStoreAlias(p)) push(p, []);
    }
    for (const p of await whereAll("python3")) {
      if (!isStoreAlias(p)) push(p, []);
    }
    for (const p of scanWindowsPythonDirs()) push(p, []);
    // py 启动器（candidates 里 prefix 用来补 -3）
    for (const p of await whereAll("py")) {
      if (!isStoreAlias(p)) push(p, ["-3"]);
    }
  } else {
    for (const p of await whereAll("python3")) push(p, []);
    for (const p of await whereAll("python")) push(p, []);
    push("/usr/bin/python3", []);
  }
  return list;
}

async function detectPython() {
  try {
    const candidates = await collectPythonCandidates();
    const tried = [];
    for (const cand of candidates) {
      if (isStoreAlias(cand.file)) {
        tried.push(cand.file + " (Store alias, skipped)");
        continue;
      }
      const probe = await execCapture(
        cand.file,
        cand.prefix.concat(["-c", "import sys, edge_tts; sys.stdout.write('OK|' + sys.executable)"]),
        25000
      );
      if (probe.ok && probe.stdout.indexOf("OK|") === 0) {
        state.python = cand;
        state.ttsReady = true;
        state.pending = false;
        state.detectError = null;
        LOG("python ready:", cand.file, "->", probe.stdout.slice(3).trim());
        return;
      }
      tried.push(cand.file + " -> " + (probe.stderr || probe.error || "no edge_tts").trim().slice(0, 160));
    }
    state.pending = false;
    state.ttsReady = false;
    state.detectError = tried.length ? tried.join(" | ") : "no python candidate found";
    LOG("no usable python with edge_tts; falling back to speechSynthesis:", state.detectError);
  } catch (e) {
    state.pending = false;
    state.ttsReady = false;
    state.detectError = String((e && e.message) || e);
    LOG("python detection failed:", state.detectError);
  }
}

function pythonArgs(extra) {
  const base = state.python ? state.python.prefix.slice() : [];
  return base.concat(extra);
}

/* ---------------------------------------------------------------- /voices */

function parseVoices(text) {
  const out = [];
  const lines = String(text || "").split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.indexOf("zh-") !== 0) continue;
    const m = /^(zh-[A-Za-z]{2,3}-[A-Za-z0-9]+Neural)\s+(\w+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    if (!VOICE_RE.test(name)) continue;
    out.push({ name, gender: m[2], lang: name.slice(0, 5), tags: m[4] || "" });
  }
  return out;
}

function loadVoices() {
  if (state.voices && Date.now() - state.voicesAt < VOICES_TTL_MS) {
    return Promise.resolve({ ok: true, cached: true, voices: state.voices });
  }
  if (state.voicesPending) return state.voicesPending;
  if (!state.ttsReady || !state.python) {
    return Promise.resolve({ ok: false, error: state.detectError || "tts not ready", voices: [] });
  }
  state.voicesPending = execCapture(state.python.file, pythonArgs(["-m", "edge_tts", "--list-voices"]), 60000)
    .then((r) => {
      if (!r.ok) return { ok: false, error: (r.stderr || r.error || "list-voices failed").slice(0, 300), voices: [] };
      const voices = parseVoices(r.stdout);
      if (!voices.length) return { ok: false, error: "no chinese voices parsed", voices: [] };
      state.voices = voices;
      state.voicesAt = Date.now();
      if (!voices.some((v) => v.name === state.voice)) {
        const zhCN = voices.filter((v) => v.name.indexOf("zh-CN-") === 0);
        state.voice = (zhCN[0] || voices[0]).name;
      }
      LOG("voices loaded:", voices.length);
      return { ok: true, cached: false, voices };
    })
    .catch((e) => ({ ok: false, error: String((e && e.message) || e), voices: [] }))
    .then((v) => {
      state.voicesPending = null;
      return v;
    });
  return state.voicesPending;
}

/* ---------------------------------------------------------------- HTTP 桥 */

function corsHeaders(req) {
  // 反射具体 Origin（绝不发 *）；file:// 页面的 Origin 是字面量 "null"
  const origin = req.headers.origin;
  if (!origin) return {};
  const allow =
    origin === "null" ||
    origin.indexOf("file://") === 0 ||
    origin.indexOf("http://127.0.0.1") === 0 ||
    origin.indexOf("http://localhost") === 0 ||
    origin.indexOf("zcode://") === 0;
  if (!allow) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function sendJson(req, res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const headers = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.length),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
    corsHeaders(req)
  );
  try {
    res.writeHead(code, headers);
    res.end(body);
  } catch (e) {
    try {
      res.destroy();
    } catch (e2) {
      /* ignore */
    }
  }
}

function tokenOk(req, url) {
  const fromQuery = url.searchParams.get("t") || "";
  const auth = String(req.headers.authorization || "");
  const fromHeader = auth.toLowerCase().indexOf("bearer ") === 0 ? auth.slice(7).trim() : "";
  const got = fromQuery || fromHeader;
  if (!got || !state.token) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(state.token, "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

function hostOk(req) {
  const host = String(req.headers.host || "");
  return host === "127.0.0.1:" + state.port;
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let total = 0;
    const chunks = [];
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) {
        finish({ ok: false, error: "body too large" });
        try {
          req.destroy();
        } catch (e) {
          /* ignore */
        }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", (e) => finish({ ok: false, error: String((e && e.message) || e) }));
  });
}

function sanitizeVoice(v) {
  const s = String(v || "").trim();
  return VOICE_RE.test(s) ? s : state.voice || DEFAULT_VOICE;
}

function sanitizeRate(r) {
  const s = String(r || "").trim();
  return RATE_RE.test(s) ? s : DEFAULT_RATE;
}

function streamTts(req, res, params) {
  const text = String(params.text || "");
  if (!text.trim()) {
    sendJson(req, res, 400, { ok: false, error: "empty text" });
    return;
  }
  if (text.length > MAX_TEXT_CHARS) {
    sendJson(req, res, 413, { ok: false, error: "text too long", max: MAX_TEXT_CHARS });
    return;
  }
  if (!state.ttsReady || !state.python) {
    sendJson(req, res, 503, { ok: false, error: "tts not ready", detail: state.detectError });
    return;
  }
  if (state.ttsActive >= MAX_CONCURRENT_TTS) {
    sendJson(req, res, 503, { ok: false, error: "too many concurrent syntheses" });
    return;
  }

  const voice = sanitizeVoice(params.voice);
  const rate = sanitizeRate(params.rate);
  // 带值的选项一律用 --opt=<值> 单参数形式：负向倍速（"-25%"）和以 "-" 开头的正文
  // （如 "-项目"）若拆成 ["--text", "-项目"]，argparse 会当成未知选项，edge_tts 直接
  // exit 2（桥回 502）。--voice 不用改：VOICE_RE 已限定首字符是字母。
  const args = pythonArgs([
    "-m", "edge_tts",
    "--text=" + text,
    "--voice", voice,
    "--rate=" + rate,
  ]);

  state.ttsActive += 1;
  let started = false;
  let timedOut = false;
  let stderrTail = "";
  let child = null;
  let watchdog = null;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (watchdog) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    state.ttsActive = Math.max(0, state.ttsActive - 1);
  };

  try {
    child = spawn(state.python.file, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    cleanup();
    sendJson(req, res, 502, { ok: false, error: "spawn failed: " + String((e && e.message) || e) });
    return;
  }

  // 合成看门狗：edge-tts 卡在网络上时不能无限挂着。25s 一到就 kill，
  // 还没出音频 → 504（渲染层据此提示「合成超时」并降级）；已出音频 → 断流让 <audio> 报错。
  watchdog = setTimeout(() => {
    watchdog = null;
    timedOut = true;
    LOG("tts synthesis timeout after " + TTS_TIMEOUT_MS + "ms; killing python");
    try {
      if (child && !child.killed) child.kill();
    } catch (e) {
      /* ignore */
    }
    if (!started) {
      sendJson(req, res, 504, { ok: false, error: "synthesis timeout", timeoutMs: TTS_TIMEOUT_MS });
    } else {
      try {
        res.destroy();
      } catch (e) {
        /* ignore */
      }
    }
  }, TTS_TIMEOUT_MS);

  child.stdout.on("data", (chunk) => {
    if (!started) {
      started = true;
      try {
        res.writeHead(200, {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Accept-Ranges": "none",
        });
      } catch (e) {
        try {
          child.kill();
        } catch (e2) {
          /* ignore */
        }
        return;
      }
    }
    try {
      res.write(chunk);
    } catch (e) {
      try {
        child.kill();
      } catch (e2) {
        /* ignore */
      }
    }
  });

  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d.toString("utf8")).slice(-1200);
  });

  child.on("error", (e) => {
    cleanup();
    if (timedOut) return;   // 504 已经回过，别再补一个 502
    if (!started) {
      sendJson(req, res, 502, { ok: false, error: "edge_tts failed", detail: String((e && e.message) || e) });
    } else {
      try {
        res.destroy();
      } catch (e2) {
        /* ignore */
      }
    }
  });

  child.on("close", (code) => {
    cleanup();
    if (timedOut) {
      if (started) {
        try {
          res.end();
        } catch (e) {
          /* ignore */
        }
      }
      return;   // 未出音频时 504 已回过；已出音频时响应已 destroy，都不能再写
    }
    if (!started) {
      sendJson(req, res, 502, {
        ok: false,
        error: "no audio produced",
        exit: code,
        detail: stderrTail.trim().slice(-400),
      });
      return;
    }
    try {
      res.end();
    } catch (e) {
      /* ignore */
    }
  });

  // 客户端中途断开（切块、停止朗读、关闭窗口）就杀掉子进程，别留着空转
  const onClose = () => {
    if (res.writableEnded) return;
    try {
      if (child && !child.killed) child.kill();
    } catch (e) {
      /* ignore */
    }
  };
  req.on("close", onClose);
  req.on("aborted", onClose);
}

async function handleRequest(req, res) {
  try {
    if (!hostOk(req)) {
      sendJson(req, res, 403, { ok: false, error: "bad host" });
      return;
    }
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1:" + state.port);
    } catch (e) {
      sendJson(req, res, 400, { ok: false, error: "bad url" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204, Object.assign({ "Content-Length": "0" }, corsHeaders(req)));
      res.end();
      return;
    }

    if (!tokenOk(req, url)) {
      sendJson(req, res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    const route = url.pathname;

    if (route === "/health" && req.method === "GET") {
      sendJson(req, res, 200, {
        ok: true,
        tts: !!state.ttsReady,
        pending: !!state.pending,
        voice: state.voice,
        voices: state.voices ? state.voices.length : 0,
        port: state.port,
        version: VERSION,
        python: state.python ? path.basename(state.python.file) : null,
      });
      return;
    }

    if (route === "/voices" && req.method === "GET") {
      const v = await loadVoices();
      sendJson(req, res, 200, {
        ok: !!v.ok,
        cached: !!v.cached,
        error: v.error || null,
        default: state.voice,
        voices: v.voices || [],
      });
      return;
    }

    if (route === "/tts") {
      if (req.method === "GET") {
        streamTts(req, res, {
          text: url.searchParams.get("text") || "",
          voice: url.searchParams.get("voice") || "",
          rate: url.searchParams.get("rate") || "",
        });
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req, 64 * 1024);
        if (!body.ok) {
          sendJson(req, res, 413, { ok: false, error: body.error });
          return;
        }
        let payload = {};
        try {
          payload = JSON.parse(body.body || "{}");
        } catch (e) {
          sendJson(req, res, 400, { ok: false, error: "bad json" });
          return;
        }
        streamTts(req, res, payload || {});
        return;
      }
      sendJson(req, res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    sendJson(req, res, 404, { ok: false, error: "not found" });
  } catch (e) {
    LOG("request failed:", e && e.message);
    try {
      if (!res.headersSent) sendJson(req, res, 500, { ok: false, error: "internal error" });
      else res.destroy();
    } catch (e2) {
      /* ignore */
    }
  }
}

function startServer() {
  return new Promise((resolve) => {
    let server;
    try {
      server = http.createServer((req, res) => {
        handleRequest(req, res).catch((e) => LOG("handler crashed:", e && e.message));
      });
      server.on("error", (e) => {
        LOG("http server error:", e && e.message);
        resolve(null);
      });
      server.on("clientError", (e, socket) => {
        try {
          socket.destroy();
        } catch (e2) {
          /* ignore */
        }
      });
      server.keepAliveTimeout = 5000;
      server.listen(0, "127.0.0.1", () => {
        try {
          state.port = server.address().port;
        } catch (e) {
          resolve(null);
          return;
        }
        state.server = server;
        LOG("bridge listening on 127.0.0.1:" + state.port);
        resolve(server);
      });
    } catch (e) {
      LOG("http server create failed:", e && e.message);
      resolve(null);
    }
  });
}

/* ---------------------------------------------------------------- 渲染层注入 */

function safeJson(obj) {
  return JSON.stringify(obj).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

function loadRendererSource() {
  try {
    const st = fs.statSync(RENDERER);
    if (state.rendererCache && state.rendererCache.mtime === st.mtimeMs) {
      return state.rendererCache.src;
    }
    const src = fs.readFileSync(RENDERER, "utf8");
    // 语法预校验：避免把写到一半的文件注进页面（热迭代时常见）
    // eslint-disable-next-line no-new-func
    new Function(src);
    state.rendererCache = { mtime: st.mtimeMs, src };
    return src;
  } catch (e) {
    LOG("renderer load failed:", e && e.message);
    if (state.rendererCache) return state.rendererCache.src;
    return null;
  }
}

function isWindowType(wc) {
  try {
    return !!wc && !wc.isDestroyed() && wc.getType() === "window";
  } catch (e) {
    return false;
  }
}

/* 注入门控必须在「注入那一刻」判 URL：窗口刚创建时 getURL() 还是空串，
   若在 attach 阶段就按 URL 拒绝，dom-ready / did-finish-load 的监听器根本挂不上。 */
function isInjectable(wc) {
  if (!isWindowType(wc)) return false;
  try {
    const url = String(typeof wc.getURL === "function" ? wc.getURL() : "");
    return url.indexOf(RENDERER_URL_MARK) !== -1;
  } catch (e) {
    return false;
  }
}

function injectInto(wc) {
  try {
    if (!isInjectable(wc)) return false;
    const src = loadRendererSource();
    if (!src) return false;
    const cfg = {
      // 桥起不来也要注入：渲染层 base 为空会直接走 speechSynthesis 降级
      base: state.port ? "http://127.0.0.1:" + state.port : "",
      token: state.token || "",
      voice: state.voice,
      version: VERSION,
    };
    const js =
      "(function(){\n" +
      "  try { if (window.__readaloudDispose) window.__readaloudDispose(); } catch (e) {}\n" +
      "  window.__readaloudConfig = " + safeJson(cfg) + ";\n" +
      src +
      "\n})();";
    const p = wc.executeJavaScript(js, true);
    if (p && typeof p.then === "function") {
      p.then(null, (e) => LOG("executeJavaScript rejected:", e && e.message));
    }
    return true;
  } catch (e) {
    LOG("inject failed:", e && e.message);
    return false;
  }
}

const hooked = new Set();

function attach(wc) {
  try {
    if (!isWindowType(wc)) return;
    const id = wc.id;
    if (hooked.has(id)) return;
    hooked.add(id);
    wc.on("dom-ready", () => injectInto(wc));
    wc.on("did-finish-load", () => injectInto(wc));
    wc.once("destroyed", () => hooked.delete(id));
    if (!wc.isLoading()) injectInto(wc);
  } catch (e) {
    LOG("attach failed:", e && e.message);
  }
}

function injectAll() {
  try {
    if (webContentsMod && webContentsMod.getAllWebContents) {
      for (const wc of webContentsMod.getAllWebContents()) attach(wc);
    }
  } catch (e) {
    LOG("injectAll failed:", e && e.message);
  }
  try {
    if (BrowserWindow && BrowserWindow.getAllWindows) {
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) attach(win.webContents);
        } catch (e) {
          /* ignore */
        }
      }
    }
  } catch (e) {
    LOG("injectAll windows failed:", e && e.message);
  }
}

function watchRenderer() {
  try {
    fs.watchFile(RENDERER, { interval: 2000 }, (cur, prev) => {
      if (!cur || !prev) return;
      if (cur.mtimeMs === prev.mtimeMs) return;
      state.rendererCache = null;
      /* 先确认新文件能读且语法可解析，避免把「写到一半」的中间态注入页面；
         读失败时保留旧实例，日志也不能谎报已注入。 */
      if (!loadRendererSource()) {
        LOG("renderer changed, but the new source failed to load/parse; not re-injecting");
        return;
      }
      /* 热重载必须绕过 attach()：它对已 hook 的 webContents 直接 return，
         只调 injectAll() 等于什么都没做（旧实现的假热重载）。
         这里直接对每个现存窗口调 injectInto；重复注入由注入前缀里的
         __readaloudDispose() 兜住。日志只在真的注入过之后才打印。 */
      let injected = 0;
      try {
        if (webContentsMod && webContentsMod.getAllWebContents) {
          for (const wc of webContentsMod.getAllWebContents()) {
            if (injectInto(wc)) injected += 1;
          }
        }
      } catch (e) {
        LOG("hot re-inject failed:", e && e.message);
      }
      if (!injected && BrowserWindow && BrowserWindow.getAllWindows) {
        try {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed() && injectInto(win.webContents)) injected += 1;
          }
        } catch (e) {
          LOG("hot re-inject (windows) failed:", e && e.message);
        }
      }
      if (injected > 0) LOG("renderer changed, hot re-injected into " + injected + " window(s)");
      else LOG("renderer changed, but no injectable window matched the URL gate");
    });
  } catch (e) {
    LOG("watchFile failed:", e && e.message);
  }
  if (app && app.on) {
    app.once("will-quit", () => {
      try {
        fs.unwatchFile(RENDERER);
      } catch (e) {
        /* ignore */
      }
    });
  }
}

/* ---------------------------------------------------------------- 生命周期 */

async function boot() {
  if (state.closing) return;
  try {
    state.token = randomToken();
    const server = await startServer();
    if (!server) {
      LOG("bridge unavailable; renderer will use speechSynthesis fallback");
      state.port = 0;
      state.token = "";
      state.pending = false;
      state.ttsReady = false;
      state.detectError = "http bridge failed to start";
    } else {
      // python 检测放后台，绝不阻塞窗口
      detectPython().then(() => {
        injectAll();
      }).catch((e) => LOG("detectPython threw:", e && e.message));
    }

    app.on("browser-window-created", (e, win) => {
      try {
        attach(win.webContents);
      } catch (err) {
        LOG("browser-window-created failed:", err && err.message);
      }
    });
    if (webContentsMod && webContentsMod.getAllWebContents) {
      app.on("web-contents-created", (e, wc) => attach(wc));
    }

    injectAll();
    watchRenderer();

    app.on("will-quit", shutdown);
    app.on("before-quit", () => {
      state.closing = true;
    });

    LOG("v" + VERSION + " loaded (port " + state.port + ")");
  } catch (e) {
    LOG("boot failed (ignored):", e && e.message);
  }
}

function shutdown() {
  state.closing = true;
  const server = state.server;
  state.server = null;
  if (!server) return;
  // 先断开 keep-alive 连接再 close，否则 close 会一直等活跃连接
  try {
    if (server.closeAllConnections) server.closeAllConnections();
  } catch (e) {
    /* ignore */
  }
  try {
    server.close();
  } catch (e) {
    /* ignore */
  }
}

if (HAS_ELECTRON) {
  app.whenReady().then(boot).catch((e) => LOG("whenReady failed:", e && e.message));
  /* 注意：绝不监听 window-all-closed——Electron 里一旦有该事件的监听器，
     客户端「关最后一个窗口就退出」的默认行为会被取消。 */
} else {
  LOG("electron main API unavailable; loader is inert");
}

/* 测试接缝（离线自检用；生产加载方不依赖） */
module.exports.__readaloudTest = {
  state,
  parseVoices,
  sanitizeVoice,
  sanitizeRate,
  isStoreAlias,
  collectPythonCandidates,
  detectPython,
  startServer,
  shutdown,
  VERSION,
};
