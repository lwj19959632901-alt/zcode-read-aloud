// server.test.mjs — MCP 协议自测 + 工具逻辑单测

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const SERVER = path.join(PLUGIN_ROOT, "dist", "server.mjs");

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "read-aloud-server-test-"));

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on("exit", cleanup);

// ---------------------------------------------------------------- MCP 客户端

class McpClient {
  constructor(serverPath, env) {
    this.proc = spawn(process.execPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.assign({}, process.env, env || {}),
    });
    this.buffer = "";
    this.nextId = 0;
    this.pending = new Map();
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.on("data", (chunk) => { /* 捕获但不阻塞 */ });
    this.proc.on("exit", (code) => { this._exited = code; });
  }
  _onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          entry.resolve(msg);
        }
      } catch { /* 忽略坏行 */ }
    }
  }
  call(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    });
  }
  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params: params || {} }) + "\n");
  }
  writeBadLine() {
    this.proc.stdin.write("{not valid json}\n");
  }
  close() {
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- fixture sqlite

async function sqliteModule() {
  const original = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
    if (type === "ExperimentalWarning" && String(warning).indexOf("SQLite") >= 0) return;
    return original.call(process, warning, ...rest);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

async function createFixtureDb() {
  const DatabaseSync = (await sqliteModule()).DatabaseSync;
  const dbPath = path.join(TMP, "fixture-" + Date.now() + ".sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_updated INTEGER, time_deleted INTEGER);" +
      "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, sequence INTEGER);" +
      "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, sequence INTEGER);"
  );
  const insertSession = db.prepare("INSERT INTO session (id, title, time_updated, time_deleted) VALUES (?, ?, ?, ?)");
  insertSession.run("sess_subagent_abc", "子代理", 9000, null);
  insertSession.run("sess_main", "主会话", 3000, null);
  const insertMessage = db.prepare("INSERT INTO message (id, session_id, data, sequence) VALUES (?, ?, ?, ?)");
  const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, data, sequence) VALUES (?, ?, ?, ?, ?)");
  insertMessage.run("m1", "sess_main", JSON.stringify({ role: "user" }), 0);
  insertPart.run("p1", "m1", "sess_main", JSON.stringify({ type: "text", text: "你好。世界。" }), 0);
  insertMessage.run("m2", "sess_main", JSON.stringify({ role: "assistant" }), 1);
  insertPart.run("p2", "m2", "sess_main", JSON.stringify({ type: "text", text: "回答一。回答二。" }), 0);
  db.close();
  return dbPath;
}

// ---------------------------------------------------------------- 真实 edge-tts 可用性探测
// 下面标注「真实 edge-tts 集成」的用例会真联网合成：先做一次一次性探测（python 可解析 +
// import edge_tts + 真合成一小句），不可用时 t.skip 并注明原因，而不是把网络故障报成 FAIL。

let edgeProbePromise = null;

function probeRealEdge() {
  if (!edgeProbePromise) edgeProbePromise = probeRealEdgeOnce();
  return edgeProbePromise;
}

async function probeRealEdgeOnce() {
  const candidates = [];
  const raPath = process.env.RA_PYTHON_PATH;
  if (raPath && String(raPath).trim()) candidates.push(String(raPath).trim());
  candidates.push("python", "python3", "py");
  const notes = [];
  let python = null;
  for (const cand of candidates) {
    const args = cand === "py" ? ["-3", "--version"] : ["--version"];
    const r = spawnSync(cand, args, { encoding: "utf8", timeout: 10000 });
    if (r.status === 0 && /Python\s/i.test(String(r.stdout || ""))) {
      python = cand;
      break;
    }
    notes.push(cand + ": " + (r.error ? r.error.message : "status=" + r.status));
  }
  if (!python) return { ok: false, reason: "python 不可用（" + notes.join("; ") + "）" };
  const imp = spawnSync(python, ["-c", "import edge_tts"], { encoding: "utf8", timeout: 15000 });
  if (imp.status !== 0) {
    return { ok: false, reason: "edge-tts 未安装: " + String(imp.stderr || "").trim().slice(0, 160) };
  }
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "read-aloud-edge-probe-"));
  const out = path.join(dir, "probe.mp3");
  try {
    const synth = spawnSync(
      python,
      ["-m", "edge_tts", "--voice", "zh-CN-XiaoxiaoNeural", "--rate=+0%", "--text", "可用性探测。", "--write-media", out],
      { encoding: "utf8", timeout: 45000 }
    );
    if (synth.error) return { ok: false, reason: "edge-tts 启动失败: " + synth.error.message };
    if (synth.status !== 0) {
      return { ok: false, reason: "edge-tts 合成失败（网络/服务不可用）: " + String(synth.stderr || "").trim().slice(0, 160) };
    }
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    if (size <= 0) return { ok: false, reason: "edge-tts 未产出音频" };
    return { ok: true, python, bytes: size };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 离线 edge_tts 桩（PYTHONPATH 注入）
// Windows 上 .mjs 无执行位、不能直接当 python 用，真机集成用例改走 probeRealEdge() 的可用性探测；
// 需要确定性的离线桩时，用 PYTHONPATH 注入同名 edge_tts 模块：`python -m edge_tts ...` 直接跑桩。

function createPythonEdgeStub() {
  const stubDir = path.join(TMP, "pystub-" + Date.now());
  fs.mkdirSync(stubDir, { recursive: true });
  const marker = path.join(stubDir, "marker.txt");
  const script = [
    "import os, sys, time",
    "",
    "def arg(name):",
    "    if name in sys.argv:",
    "        i = sys.argv.index(name)",
    "        if i + 1 < len(sys.argv):",
    "            return sys.argv[i + 1]",
    "    return None",
    "",
    'media = arg("--write-media")',
    "marker = os.environ.get('RA_TEST_STUB_MARKER')",
    "# 行为可由控制文件逐次切换（同一 server 进程内做「先失败后恢复」回归）：",
    "# 第一行 mode（healthy/fail/partial），第二行 sleep 秒数。控制文件存在时优先于环境变量。",
    "control = os.environ.get('RA_TEST_STUB_CONTROL')",
    "mode = None",
    "sleep_s = float(os.environ.get('RA_TEST_STUB_SLEEP', '0'))",
    "# RA_TEST_STUB_TAG：healthy 产物按 tag 变内容（长度不变），并发写同一 key 时可断言",
    "# 「最终文件 = 两者之一的完整内容」而非 merely 大小合法（并发回归用）。",
    "tag = os.environ.get('RA_TEST_STUB_TAG') or 'x'",
    "if control and os.path.exists(control):",
    "    with open(control, encoding='utf-8') as fh:",
    "        lines = [ln.strip() for ln in fh.read().splitlines()]",
    "    mode = lines[0] if lines and lines[0] else 'healthy'",
    "    if len(lines) > 1 and lines[1]:",
    "        sleep_s = float(lines[1])",
    "if mode is None:",
    "    if os.environ.get('RA_TEST_STUB_FAIL') == '1':",
    "        mode = 'fail'",
    "    elif os.environ.get('RA_TEST_STUB_PARTIAL') == '1':",
    "        mode = 'partial'",
    "    else:",
    "        mode = 'healthy'",
    "if marker:",
    "    with open(marker, 'a', encoding='utf-8') as fh:",
    "        fh.write('started' + chr(10))",
    "if mode == 'fail':",
    "    sys.stderr.write('stub edge_tts: forced failure' + chr(10))",
    "    sys.exit(1)",
    "if mode == 'partial':",
    "    with open(media, 'wb') as fh:",
    "        fh.write(bytes([73, 68, 51]) + bytes(10))  # 先写半截内容再挂起（模拟中断残留）",
    "if sleep_s > 0:",
    "    time.sleep(sleep_s)",
    "if media:",
    "    with open(media, 'wb') as fh:",
    "        fh.write(bytes([73, 68, 51, 3, 0, 0, 0, 0]) + (tag.encode('utf-8') * 1000) + bytes(64))",
    "if marker:",
    "    with open(marker, 'a', encoding='utf-8') as fh:",
    "        fh.write('done' + chr(10))",
    "sys.stderr.write('stub edge_tts media=' + str(media) + chr(10))",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(stubDir, "edge_tts.py"), script, "utf8");
  return { stubDir, marker };
}

async function waitForMarker(marker, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (fs.readFileSync(marker, "utf8").indexOf(needle) >= 0) return true;
    } catch { /* 文件还没建 */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// 与 dist/server.mjs 的 cacheKeyFor 保持一致：sha256(text + "\0" + voice + "\0" + rateArg)
function cacheKeyFor(text, voice, rateArg) {
  return createHash("sha256").update(text + "\0" + voice + "\0" + rateArg).digest("hex");
}

// 列出缓存目录里的所有残留文件（含 .part 临时文件）；目录不存在时返回空数组。
function listCacheFiles(cacheDir) {
  const chunksDir = path.join(cacheDir, "chunks");
  return fs.existsSync(chunksDir) ? fs.readdirSync(chunksDir) : [];
}

// ---------------------------------------------------------------- 协议自测

test("MCP 协议：initialize 返回 capabilities", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("initialize", { protocolVersion: "2025-06-18" });
    assert.ok(resp.result, "应有 result");
    assert.equal(resp.result.serverInfo.name, "read-aloud");
    assert.equal(resp.result.serverInfo.version, "1.0.0");
    assert.ok(resp.result.capabilities.tools);
    assert.ok(resp.result.capabilities.resources);
    assert.equal(resp.result.capabilities.tools.listChanged, false);
  } finally {
    client.close();
  }
});

test("MCP 协议：ping 有响应", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("ping", {});
    assert.ok(resp.result, "ping 应有 result");
  } finally {
    client.close();
  }
});

test("MCP 协议：tools/list 有 4 个工具 + _meta 正确", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("tools/list", {});
    assert.ok(resp.result.tools, "应有 tools");
    assert.equal(resp.result.tools.length, 4);
    const names = resp.result.tools.map((t) => t.name);
    assert.deepEqual(names, ["speak_session", "speak_chunk", "list_voices", "session_info"]);
    // speak_session 的 _meta
    const speak = resp.result.tools[0];
    assert.equal(speak._meta.ui.surface, "read-aloud");
    assert.deepEqual(speak._meta.ui.visibility, ["model", "app"]);
    // speak_chunk 的 _meta 是 app-only
    const chunk = resp.result.tools[1];
    assert.deepEqual(chunk._meta.ui.visibility, ["app"]);
  } finally {
    client.close();
  }
});

test("MCP 协议：resources/list 有面板 URI + CSP meta", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("resources/list", {});
    assert.ok(resp.result.resources, "应有 resources");
    assert.equal(resp.result.resources.length, 1);
    const res = resp.result.resources[0];
    assert.equal(res.uri, "ui://read-aloud/panel.html");
    assert.equal(res._meta.ui.csp.connectDomains.length, 0);
    assert.equal(res._meta.ui.csp.resourceDomains.length, 0);
  } finally {
    client.close();
  }
});

test("MCP 协议：resources/read 返回 panel.html < 4MiB + 含预期标记", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("resources/read", { uri: "ui://read-aloud/panel.html" });
    assert.ok(resp.result.contents, "应有 contents");
    const text = resp.result.contents[0].text;
    assert.ok(Buffer.byteLength(text, "utf8") < 4 * 1024 * 1024, "panel.html < 4MiB");
    assert.ok(text.indexOf("callTool") >= 0, "含 callTool 标记");
    assert.ok(text.indexOf("postMessage") >= 0, "含 postMessage 标记");
    assert.ok(text.indexOf("speak_session") >= 0, "含 speak_session 标记");
  } finally {
    client.close();
  }
});

test("MCP 协议：resources/read 未知 URI 报错", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("resources/read", { uri: "ui://read-aloud/unknown.html" });
    assert.ok(resp.error, "应有 error");
    assert.equal(resp.error.code, -32002);
  } finally {
    client.close();
  }
});

test("MCP 协议：未知 method -32601", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("nonexistent/method", {});
    assert.ok(resp.error, "应有 error");
    assert.equal(resp.error.code, -32601);
  } finally {
    client.close();
  }
});

test("MCP 协议：通知不回复", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const before = client.nextId;
    client.notify("ping", {});
    client.notify("notifications/initialized", {});
    // 通知后不应该有响应 pending
    // 等一小段时间看是否有响应被写入
    const resp = await client.call("ping", {});
    assert.ok(resp.result, "ping 应有响应");
    assert.equal(client.nextId, before + 1, "通知不应产生 id 递增");
  } finally {
    client.close();
  }
});

test("MCP 协议：坏 JSON 行跳过不崩", async () => {
  const client = new McpClient(SERVER, {});
  try {
    client.writeBadLine();
    const resp = await client.call("ping", {});
    assert.ok(resp.result, "坏 JSON 后 ping 仍有响应");
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------- 工具逻辑

test("tools/call：list_voices 返回 8 个音色", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("tools/call", { name: "list_voices", arguments: {} });
    assert.ok(resp.result.content, "应有 content");
    const payload = JSON.parse(resp.result.content[0].text);
    assert.ok(payload.ok);
    assert.equal(payload.voices.length, 8);
    assert.equal(payload.voices[0].name, "zh-CN-XiaoxiaoNeural");
    assert.equal(payload.voices[0].label, "晓晓");
  } finally {
    client.close();
  }
});

test("tools/call：session_info 透传 _meta.sessionId", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("tools/call", {
      name: "session_info",
      arguments: {},
      _meta: { sessionId: "sess_TEST" },
    });
    const payload = JSON.parse(resp.result.content[0].text);
    assert.equal(payload.sessionId, "sess_TEST");
    assert.ok(payload.dbExists !== undefined);
    assert.ok(payload.pythonResolved !== undefined);
  } finally {
    client.close();
  }
});

test("tools/call：speak_session 返回 chunks 结构", async () => {
  const dbPath = await createFixtureDb();
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath });
  try {
    const resp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
      _meta: { sessionId: "sess_main" },
    });
    const payload = JSON.parse(resp.result.content[0].text);
    assert.ok(payload.ok);
    assert.ok(payload.requestId, "应有 requestId");
    assert.equal(payload.sessionId, "sess_main");
    assert.equal(payload.sessionSource, "arg", "sessionSource=arg（显式传 sessionId）");
    assert.ok(payload.chunks.length >= 3, "应有至少 3 块");
    assert.ok(payload.totalChars > 0);
    assert.equal(payload.truncated, false);
    // chunk 结构
    const c0 = payload.chunks[0];
    assert.equal(typeof c0.index, "number");
    assert.equal(typeof c0.role, "string");
    assert.equal(typeof c0.label, "string");
    assert.equal(typeof c0.text, "string");
    assert.equal(typeof c0.charCount, "number");
  } finally {
    client.close();
  }
});

test("tools/call：speak_session 空会话报错", async () => {
  const dbPath = await createFixtureDb();
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath });
  try {
    const resp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_nonexistent" },
    });
    assert.ok(resp.error, "空会话应报错");
    assert.match(resp.error.message, /会话不存在或没有可朗读的消息/);
  } finally {
    client.close();
  }
});

test("tools/call：speak_session 缺 sessionId 时 fallback（sessionSource=fallback-latest）", async () => {
  const dbPath = await createFixtureDb();
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath });
  try {
    const resp = await client.call("tools/call", {
      name: "speak_session",
      arguments: {},
    });
    const payload = JSON.parse(resp.result.content[0].text);
    assert.ok(payload.ok);
    assert.equal(payload.sessionSource, "fallback-latest", "缺 sessionId 时 fallback");
    assert.equal(payload.sessionId, "sess_main", "fallback 应取最新主会话");
  } finally {
    client.close();
  }
});

test("tools/call：speak_session maxChars 截断（块边界、truncated 标记）", async () => {
  const dbPath = await createFixtureDb();
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath });
  try {
    // maxChars=10 应截断（"你好。"4字 + "世界。"4字 = 8，下一块 "回答一。" 5字会超）
    const resp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main", maxChars: 10 },
    });
    const payload = JSON.parse(resp.result.content[0].text);
    assert.ok(payload.ok);
    assert.equal(payload.truncated, true, "应标记 truncated");
    assert.ok(payload.chunks.length < 4, "应被截断到更少块");
  } finally {
    client.close();
  }
});

test("tools/call：speak_session voice 参数解析", async () => {
  const dbPath = await createFixtureDb();
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath });
  try {
    const resp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main", voice: "yunxi" },
    });
    const payload = JSON.parse(resp.result.content[0].text);
    assert.equal(payload.voice, "zh-CN-YunxiNeural", "短名 yunxi 应解析成全名");
  } finally {
    client.close();
  }
});

test("tools/call：speak_chunk 正常路径（真实 edge-tts 集成）", async (t) => {
  const probe = await probeRealEdge();
  if (!probe.ok) {
    t.skip("真实 edge-tts 不可用，跳过（" + probe.reason + "）");
    return;
  }
  const dbPath = await createFixtureDb();
  const cacheDir = path.join(TMP, "cache-test-17");
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath, ZCODE_PLUGIN_DATA: cacheDir });
  try {
    // 先 speak_session
    const resp1 = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const payload1 = JSON.parse(resp1.result.content[0].text);
    assert.ok(payload1.ok);
    // 再 speak_chunk 0
    const resp2 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 0 },
    });
    const payload2 = JSON.parse(resp2.result.content[0].text);
    assert.ok(payload2.ok, "speak_chunk 应成功");
    assert.ok(payload2.dataUri.startsWith("data:audio/mpeg;base64,"), "dataUri 格式正确");
    assert.equal(payload2.engine, "edge", "正常路径 engine 应为 edge");
    assert.equal(payload2.mimeType, "audio/mpeg");
    assert.ok(payload2.bytes > 0, "bytes > 0");
    assert.equal(payload2.cached, false, "首次合成 cached=false");
  } finally {
    client.close();
  }
});

test("tools/call：speak_chunk 未知 requestId 报错", async () => {
  const dbPath = await createFixtureDb();
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath });
  try {
    const resp = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: "req_nonexistent", index: 0 },
    });
    assert.ok(resp.error, "应报错");
    assert.match(resp.error.message, /未知 requestId/);
  } finally {
    client.close();
  }
});

test("tools/call：speak_chunk index 越界报错", async () => {
  const dbPath = await createFixtureDb();
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath });
  try {
    const resp1 = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const payload1 = JSON.parse(resp1.result.content[0].text);
    const resp2 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 999 },
    });
    assert.ok(resp2.error, "应报错");
    assert.match(resp2.error.message, /越界/);
  } finally {
    client.close();
  }
});

test("会话缓存：真 LRU（访问刷新，淘汰最久未用而非最早插入）", async () => {
  // 与 server.mjs MAX_SESSIONS=5 一致
  const MAX_SESSIONS = 5;
  const dbPath = await createFixtureDb();
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath });
  const ids = [];
  const newSession = async () => {
    const resp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const payload = JSON.parse(resp.result.content[0].text);
    ids.push(payload.requestId);
    return payload.requestId;
  };
  // index=999 → 越界报错（证明会话存在），且不触发任何合成
  const probe = async (requestId) =>
    client.call("tools/call", { name: "speak_chunk", arguments: { requestId, index: 999 } });
  try {
    for (let i = 0; i < MAX_SESSIONS; i++) await newSession();

    // 第 6 个：FIFO/LRU 都应淘汰最早的 req[0]
    await newSession();
    let resp = await probe(ids[0]);
    assert.ok(resp.error, "被淘汰会话应报错");
    assert.match(resp.error.message, /未知 requestId/);

    // 访问 req[1]（越界报错也算访问）→ 刷新到队尾
    resp = await probe(ids[1]);
    assert.match(resp.error.message, /越界/, "req[1] 应仍存在");

    // 再开第 7 个：LRU 应淘汰 req[2]，而不是刚被访问过的 req[1]
    await newSession();
    const err2 = await probe(ids[2]);
    assert.match(err2.error.message, /未知 requestId/, "req[2] 应为最久未用而被淘汰");
    const err1 = await probe(ids[1]);
    assert.match(err1.error.message, /越界/, "访问刷新过的 req[1] 不应被淘汰");

    // 已知 requestId 列表顺序 = LRU 顺序（队首最久未用）
    const knownMatch = /已知: (.+?)）/.exec(err2.error.message);
    assert.ok(knownMatch, "错误消息应带已知 requestId 列表: " + err2.error.message);
    assert.deepEqual(knownMatch[1].split(", "), [ids[3], ids[4], ids[5], ids[1], ids[6]], "应为 LRU 顺序");
  } finally {
    client.close();
  }
});

test("tools/call：speak_chunk 覆盖断言（P0-1 核心，真实 edge-tts 集成）", async (t) => {
  const probe = await probeRealEdge();
  if (!probe.ok) {
    t.skip("真实 edge-tts 不可用，跳过（" + probe.reason + "）");
    return;
  }
  const dbPath = await createFixtureDb();
  const cacheDir = path.join(TMP, "cache-test-18");
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath, ZCODE_PLUGIN_DATA: cacheDir });
  try {
    const resp1 = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const payload1 = JSON.parse(resp1.result.content[0].text);
    // 不带覆盖请求 chunk 0
    const resp2 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 0 },
    });
    const payload2 = JSON.parse(resp2.result.content[0].text);
    assert.equal(payload2.voice, "zh-CN-XiaoxiaoNeural", "默认音色");
    // 带 voice/rate 覆盖请求 chunk 0
    const resp3 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 0, voice: "zh-CN-YunxiNeural", rate: 5 },
    });
    const payload3 = JSON.parse(resp3.result.content[0].text);
    assert.equal(payload3.voice, "zh-CN-YunxiNeural", "覆盖音色应回显");
    assert.equal(payload3.rate, 5, "覆盖倍速应回显");
    // 覆盖后 cacheKey 不同 → 必重新合成
    assert.equal(payload3.cached, false, "覆盖 voice/rate 后应重新合成");
    // 核心断言：响应回显 effective voice/rate
    assert.notEqual(payload3.voice, payload2.voice, "覆盖后 voice 应不同");
  } finally {
    client.close();
  }
});

test("tools/call：speak_chunk 缓存命中（第二次同 text+voice+rate，真实 edge-tts 集成）", async (t) => {
  const probe = await probeRealEdge();
  if (!probe.ok) {
    t.skip("真实 edge-tts 不可用，跳过（" + probe.reason + "）");
    return;
  }
  const dbPath = await createFixtureDb();
  const cacheDir = path.join(TMP, "cache-test");
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath, ZCODE_PLUGIN_DATA: cacheDir });
  try {
    const resp1 = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const payload1 = JSON.parse(resp1.result.content[0].text);
    // 第一次合成
    const resp2 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 0 },
    });
    const payload2 = JSON.parse(resp2.result.content[0].text);
    assert.equal(payload2.engine, "edge", "应是 edge 合成（探测已确认可用）");
    assert.equal(payload2.cached, false, "首次 cached=false");
    // 第二次同参数应命中缓存
    const resp3 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 0 },
    });
    const payload3 = JSON.parse(resp3.result.content[0].text);
    assert.equal(payload3.cached, true, "第二次应命中缓存");
    assert.equal(payload3.bytes, payload2.bytes, "缓存字节数应一致");
  } finally {
    client.close();
  }
});

test("tools/call：未知工具报错", async () => {
  const client = new McpClient(SERVER, {});
  try {
    const resp = await client.call("tools/call", { name: "unknown_tool", arguments: {} });
    assert.ok(resp.error, "应报错");
    assert.equal(resp.error.code, -32602);
  } finally {
    client.close();
  }
});

test("tools/call：非法 rate 被钳制", async () => {
  const dbPath = await createFixtureDb();
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath });
  try {
    const resp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main", rate: 99 },
    });
    const payload = JSON.parse(resp.result.content[0].text);
    assert.equal(payload.rate, 10, "rate=99 应钳制到 10");
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------- 纯函数单测（P1-5：不经 spawn）

// cacheKeyFor 与 effective 值计算：从 server 模块直接导入纯函数
// 但 server.mjs 是 stdio 进程入口，不能直接 import。改为通过 speak_session/speak_chunk 的
// 响应间接验证：同 text+voice+rate → 同缓存文件；异 voice → 异缓存文件。
// 这里用真实 edge-tts（网络）验证缓存 key 逻辑，无 edge-tts/网络时 skip。

test("缓存 key：同 text+voice+rate → 同 key（第二次 cached=true，真实 edge-tts 集成）", async (t) => {
  const probe = await probeRealEdge();
  if (!probe.ok) {
    t.skip("真实 edge-tts 不可用，跳过缓存 key 验证（" + probe.reason + "）");
    return;
  }

  const dbPath = await createFixtureDb();
  const cacheDir = path.join(TMP, "cache-key-test");
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath, ZCODE_PLUGIN_DATA: cacheDir });
  try {
    const resp1 = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const payload1 = JSON.parse(resp1.result.content[0].text);
    // 第一次合成 chunk 0
    const resp2 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 0 },
    });
    const payload2 = JSON.parse(resp2.result.content[0].text);
    assert.equal(payload2.cached, false, "首次合成 cached=false");
    // 第二次同参数 → 缓存命中
    const resp3 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 0 },
    });
    const payload3 = JSON.parse(resp3.result.content[0].text);
    assert.equal(payload3.cached, true, "第二次同参数应命中缓存");
    assert.equal(payload3.bytes, payload2.bytes, "缓存字节数一致");
  } finally {
    client.close();
  }
});

test("缓存 key：异 voice → 异 key（覆盖后 cached=false，真实 edge-tts 集成）", async (t) => {
  const probe = await probeRealEdge();
  if (!probe.ok) {
    t.skip("真实 edge-tts 不可用，跳过缓存 key 验证（" + probe.reason + "）");
    return;
  }

  const dbPath = await createFixtureDb();
  const cacheDir = path.join(TMP, "cache-key-voice-test");
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath, ZCODE_PLUGIN_DATA: cacheDir });
  try {
    const resp1 = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const payload1 = JSON.parse(resp1.result.content[0].text);
    // 不带覆盖请求 chunk 0（默认音色）
    const resp2 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 0 },
    });
    const payload2 = JSON.parse(resp2.result.content[0].text);
    assert.equal(payload2.cached, false, "首次合成 cached=false");
    // 带 voice 覆盖请求 chunk 0（不同音色 → 不同 cacheKey → 必重新合成）
    const resp3 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: payload1.requestId, index: 0, voice: "zh-CN-YunxiNeural" },
    });
    const payload3 = JSON.parse(resp3.result.content[0].text);
    assert.equal(payload3.cached, false, "覆盖音色后必重新合成（cached=false）");
    assert.notEqual(payload3.voice, payload2.voice, "覆盖后 voice 应不同");
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------- K06：异步合成不阻塞事件循环

test("MCP 协议：长合成进行中 ping / tools 仍应答（异步 spawn）", async () => {
  const dbPath = await createFixtureDb();
  const { stubDir, marker } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-async-ping");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_SLEEP: "3",
    RA_TEST_STUB_MARKER: marker,
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);
    assert.ok(session.ok, "speak_session 应成功");

    const t0 = Date.now();
    const chunkPromise = client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    assert.ok(await waitForMarker(marker, "started", 10000), "桩合成应已开始");

    // 合成进行中：ping 必须被应答，且应答时合成尚未结束
    const pingResp = await client.call("ping", {});
    const pingMs = Date.now() - t0;
    assert.ok(pingResp.result, "合成期间 ping 应有 result");
    const midMarker = fs.readFileSync(marker, "utf8");
    assert.ok(midMarker.indexOf("started") >= 0, "ping 应答时合成应已开始");
    assert.equal(midMarker.indexOf("done"), -1, "ping 应答时合成不应已结束");
    assert.ok(pingMs < 2500, "ping 应在 3000ms 合成完成前应答，实测 " + pingMs + "ms");

    // 合成进行中：另一个 tools/call 也应被应答
    const voicesResp = await client.call("tools/call", { name: "list_voices", arguments: {} });
    const voices = JSON.parse(voicesResp.result.content[0].text);
    assert.equal(voices.voices.length, 8, "合成期间 tools/call 应正常应答");

    const chunkResp = await chunkPromise;
    const chunk = JSON.parse(chunkResp.result.content[0].text);
    assert.ok(chunk.ok, "speak_chunk 应成功");
    assert.ok(chunk.dataUri.startsWith("data:audio/mpeg;base64,"), "dataUri 格式正确");
    assert.ok(chunk.bytes > 0, "bytes > 0");
    assert.equal(chunk.cached, false, "首次合成 cached=false");
    assert.ok(Date.now() - t0 >= 2500, "合成确实耗时（≈3000ms）");

    // 缓存语义不变：同 text+voice+rate 第二次 → cached=true 且字节一致
    const againResp = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    const again = JSON.parse(againResp.result.content[0].text);
    assert.equal(again.cached, true, "第二次应命中缓存");
    assert.equal(again.bytes, chunk.bytes, "缓存字节数应一致");
  } finally {
    client.close();
  }
});

test("tools/call：合成超时被中止（RA_SYNTH_TIMEOUT_MS，超时语义不变）", async () => {
  const dbPath = await createFixtureDb();
  const { stubDir, marker } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-async-timeout");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_SLEEP: "2.5",
    RA_TEST_STUB_MARKER: marker,
    RA_SYNTH_TIMEOUT_MS: "600",
    // K11 起 edge 失败会回退 SAPI；这里把 PS7 指向不存在的路径，隔离出"edge 超时中止"本身
    RA_PS7_PATH: path.join(TMP, "no-such-pwsh.exe"),
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);

    const t0 = Date.now();
    const resp = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    const elapsed = Date.now() - t0;
    assert.ok(resp.error, "超时应报错（无 SAPI 可兜底时）");
    assert.match(String(resp.error.message), /超时/);
    assert.match(String(resp.error.message), /SAPI 兜底失败/);
    assert.ok(elapsed < 2200, "应按 RA_SYNTH_TIMEOUT_MS 中止，实测 " + elapsed + "ms");

    // 子进程应已被终止：等过桩的睡眠时长后不应出现 done 标记
    await new Promise((r) => setTimeout(r, 2600));
    const marks = fs.readFileSync(marker, "utf8");
    assert.ok(marks.indexOf("started") >= 0, "桩应已启动");
    assert.equal(marks.indexOf("done"), -1, "超时后子进程应被终止（不应写出 done）");
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------- P0-2 评审修复回归

test("tools/call：edge 超时中断不在缓存位留半截 mp3（原子写回归）", async () => {
  const dbPath = await createFixtureDb();
  const { stubDir, marker } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-atomic-edge");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_PARTIAL: "1", // 桩先写半截文件再挂起（复现评审探针场景）
    RA_TEST_STUB_SLEEP: "2.5",
    RA_TEST_STUB_MARKER: marker,
    RA_SYNTH_TIMEOUT_MS: "600",
    // 无 SAPI 可兜底：隔离出 edge 超时本身
    RA_PS7_PATH: path.join(TMP, "no-such-pwsh.exe"),
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);

    const resp = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    assert.ok(resp.error, "edge 超时且无 SAPI 兜底应报错");
    assert.match(String(resp.error.message), /超时/);

    // 关键断言：缓存位不留任何音频文件。修复前 --write-media 直写最终路径，
    // 半截 mp3 会占据缓存 key 被 existsSync 当有效缓存命中，永久遮蔽 SAPI 兜底 wav。
    // 注意 getCacheDir 会在 ZCODE_PLUGIN_DATA 下再建 chunks 子目录，必须列那一层。
    const chunksDir = path.join(cacheDir, "chunks");
    const leftovers = fs.existsSync(chunksDir)
      ? fs.readdirSync(chunksDir).filter((f) => f.endsWith(".mp3") || f.endsWith(".wav"))
      : [];
    assert.deepEqual(leftovers, [], "超时中断后缓存目录不应残留音频文件，实测: " + leftovers.join(", "));
  } finally {
    client.close();
  }
});

test("tools/call：edge 超时失败后第二次请求（换健康桩）重新合成，不被残留遮蔽", async () => {
  const dbPath = await createFixtureDb();
  const { stubDir, marker } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-retry-after-timeout");
  const control = path.join(TMP, "stub-control-retry.txt");
  // 第一次：桩写 13 字节后挂起（复现评审探针）；第二次：改成健康桩，同一 server 进程内重试
  fs.writeFileSync(control, "partial\n2.5\n", "utf8");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_CONTROL: control,
    RA_TEST_STUB_MARKER: marker,
    RA_SYNTH_TIMEOUT_MS: "600",
    RA_PS7_PATH: path.join(TMP, "no-such-pwsh.exe"), // 隔离出 edge 超时本身
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);

    const first = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    assert.ok(first.error, "第一次应失败（edge 超时且无 SAPI 可兜底）");
    assert.match(String(first.error.message), /超时/);
    // 失败后缓存目录必须干净：既无最终 mp3，也无 .part 临时文件
    assert.deepEqual(listCacheFiles(cacheDir), [], "失败后缓存目录不应有任何残留（含 .part）");

    fs.writeFileSync(control, "healthy\n0\n", "utf8"); // 换健康桩
    const second = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    assert.ok(second.result, "第二次应成功: " + JSON.stringify(second.error || {}));
    const chunk = JSON.parse(second.result.content[0].text);
    assert.equal(chunk.engine, "edge", "健康桩应走 edge 引擎");
    assert.equal(chunk.cached, false, "第一次失败未留缓存，第二次必须重新合成");
    assert.ok(chunk.bytes >= 1024, "重合成产物应达有效大小下限，实测 " + chunk.bytes + " 字节");
    const files = listCacheFiles(cacheDir);
    assert.equal(files.filter((f) => f.indexOf(".part") >= 0).length, 0, "不应有 .part 残留: " + files.join(", "));
    assert.equal(files.filter((f) => f.endsWith(".mp3")).length, 1, "应恰好有一个完整 mp3 缓存: " + files.join(", "));
  } finally {
    client.close();
  }
});

test("tools/call：0 字节 mp3 缓存不被当有效命中（大小校验下限）", async () => {
  const dbPath = await createFixtureDb();
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-empty-mp3");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);

    // 预埋 0 字节 mp3：修复前 existsSync 即命中，会返回 bytes=0 的空音频
    const chunksDir = path.join(cacheDir, "chunks");
    fs.mkdirSync(chunksDir, { recursive: true });
    const emptyPath = path.join(chunksDir, cacheKeyFor("你好。", "zh-CN-XiaoxiaoNeural", "+0%") + ".mp3");
    fs.writeFileSync(emptyPath, Buffer.alloc(0));

    const resp = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    const chunk = JSON.parse(resp.result.content[0].text);
    assert.ok(chunk.ok, "speak_chunk 应成功");
    assert.equal(chunk.cached, false, "0 字节 mp3 不应被当有效缓存命中");
    assert.ok(chunk.bytes >= 1024, "重合成产物应达有效大小下限，实测 " + chunk.bytes + " 字节");
    assert.ok(fs.statSync(emptyPath).size >= 1024, "缓存位应被完整产物替换");
  } finally {
    client.close();
  }
});

test("tools/call：voice/rate 覆盖回写会话（后续无覆盖请求沿用新值）", async () => {
  const dbPath = await createFixtureDb();
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-override-writeback");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);
    assert.equal(session.voice, "zh-CN-XiaoxiaoNeural", "会话默认音色应为晓晓");
    assert.equal(session.rate, 0, "会话默认倍速应为 0");

    // chunk 0 带 voice/rate 覆盖（面板切音色/倍速走的就是这条路径）
    const resp2 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0, voice: "zh-CN-YunxiNeural", rate: 5 },
    });
    const payload2 = JSON.parse(resp2.result.content[0].text);
    assert.ok(payload2.ok, "覆盖请求应成功");
    assert.equal(payload2.voice, "zh-CN-YunxiNeural", "覆盖音色应回显");
    assert.equal(payload2.rate, 5, "覆盖倍速应回显");

    // chunk 1 不带覆盖（面板预取与 audio ended 直请的形态）：应沿用回写后的新值，而不是退回会话旧值
    const resp3 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 1 },
    });
    const payload3 = JSON.parse(resp3.result.content[0].text);
    assert.ok(payload3.ok, "后续请求应成功");
    assert.equal(payload3.voice, "zh-CN-YunxiNeural", "后续无覆盖请求应沿用回写后的新音色（修复前退回晓晓）");
    assert.equal(payload3.rate, 5, "后续无覆盖请求应沿用回写后的新倍速（修复前退回 0）");
  } finally {
    client.close();
  }
});

test("tools/call：缓存位上的历史半截 mp3 不被当有效缓存（大小下限防御）", async () => {
  const dbPath = await createFixtureDb();
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-junk-mp3");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);

    // 预埋一个 13 字节半截 mp3 到精确的缓存 key 上（复现修复前非原子写遗留物；
    // key 算法同 server.mjs cacheKeyFor：sha256(text + "\\0" + voice + "\\0" + rateArg)）
    const { createHash } = await import("node:crypto");
    const key = createHash("sha256")
      .update("你好。" + "\0" + "zh-CN-XiaoxiaoNeural" + "\0" + "+0%")
      .digest("hex");
    const chunksDir = path.join(cacheDir, "chunks");
    fs.mkdirSync(chunksDir, { recursive: true });
    const junkPath = path.join(chunksDir, key + ".mp3");
    fs.writeFileSync(junkPath, Buffer.from([73, 68, 51, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));

    const resp = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    const chunk = JSON.parse(resp.result.content[0].text);
    assert.ok(chunk.ok, "speak_chunk 应成功");
    assert.equal(chunk.cached, false, "13 字节半截 mp3 不应被当有效缓存命中（必须重合成）");
    assert.ok(chunk.bytes >= 1024, "重合成产物应达有效大小下限，实测 " + chunk.bytes + " 字节");
    assert.ok(fs.existsSync(junkPath), "同 key 缓存位应已被新产物占据");
    assert.ok(fs.statSync(junkPath).size >= 1024, "缓存位上的文件应是完整合成产物");
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------- K11：SAPI 离线兜底

const PS7_PATH = "C:/Program Files/PowerShell/7/pwsh.exe";

// 遍历 RIFF chunk，取 fmt 与 data 信息（验证真机合成出的是可播音频，不是空壳）
function readWavFmt(buf) {
  let pos = 12;
  const out = { channels: 0, sampleRate: 0, bits: 0, dataSize: 0 };
  while (pos + 8 <= buf.length) {
    const id = buf.slice(pos, pos + 4).toString("latin1");
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      out.channels = buf.readUInt16LE(pos + 10);
      out.sampleRate = buf.readUInt32LE(pos + 12);
      out.bits = buf.readUInt16LE(pos + 22);
    } else if (id === "data") {
      out.dataSize = size;
    }
    pos += 8 + size + (size % 2);
  }
  return out;
}

test("SAPI 兜底：命令构造单测（PS7 全路径 + System.Speech + 文本经文件）", async () => {
  const server = await import(pathToFileURL(path.join(PLUGIN_ROOT, "dist", "server.mjs")).href);
  const script = server.buildSapiScript();

  assert.match(script, /Add-Type -AssemblyName System\.Speech/);
  assert.match(script, /SetOutputToWaveFile\(\$OutFile, \$fmt\)/);
  assert.match(script, /AudioBitsPerSample\]::Sixteen/);
  assert.match(script, /AudioChannel\]::Mono/);
  // 正文经文件读入（-Encoding utf8），不经命令行
  assert.match(script, /@\(Get-Content -Raw -Encoding utf8 -LiteralPath \$TextFile \| ConvertFrom-Json\)/);
  // 单元素数组退化坑：ConvertFrom-Json 必须且只能被 @() 包一次
  const jsonLines = script.split("\n").filter((line) => line.indexOf("ConvertFrom-Json") >= 0);
  assert.equal(jsonLines.length, 1, "PS 脚本里只应有一处 ConvertFrom-Json");
  assert.ok(jsonLines[0].indexOf("@(Get-Content") >= 0, "ConvertFrom-Json 必须被 @() 包裹: " + jsonLines[0].trim());
  assert.match(script, /\$text = \[string\]\$chunks\[0\]/);

  const args = server.buildSapiArgs({
    psFile: "speak.ps1",
    textFile: "chunks.json",
    outFile: "chunk.wav",
    voiceHint: "Kangkang",
    rate: 5,
  });
  assert.deepEqual(args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.equal(args[4], "speak.ps1");
  assert.equal(args[args.indexOf("-TextFile") + 1], "chunks.json");
  assert.equal(args[args.indexOf("-OutFile") + 1], "chunk.wav");
  assert.equal(args[args.indexOf("-Rate") + 1], "5");
  assert.equal(args[args.indexOf("-Voice") + 1], "Kangkang");
  // 命令构造不携带正文
  assert.equal(args.some((a) => String(a).indexOf("你好") >= 0), false);

  // PS7 全路径（不走短名 pwsh，避开 WindowsApps 应用别名桩）
  assert.match(server.sapiPwshPath(), /PowerShell[/\\]7[/\\]pwsh\.exe$/);
  assert.equal(server.sapiPwshPath(), "C:/Program Files/PowerShell/7/pwsh.exe");
  // edge 音色 → SAPI 音色提示（按性别就近）
  assert.equal(server.sapiVoiceHint("zh-CN-YunxiNeural"), "Kangkang");
  assert.equal(server.sapiVoiceHint("zh-CN-XiaoxiaoNeural"), "Huihui");
  assert.equal(server.sapiVoiceHint(""), "Huihui");
});

test("SAPI 兜底：UTF-8 无 BOM 纪律（Node utf8 写文件不产生 BOM）", () => {
  const probe = path.join(TMP, "bom-probe.json");
  fs.writeFileSync(probe, JSON.stringify(["你好。"]), "utf8");
  const raw = fs.readFileSync(probe);
  assert.notEqual(raw[0], 0xef, "不应有 UTF-8 BOM 首字节");
  assert.equal(raw[0], 0x5b, "首字节应为 '['");
  assert.equal(raw[raw.length - 1], 0x5d, "末字节应为 ']'");
  assert.deepEqual(JSON.parse(raw.toString("utf8")), ["你好。"]);
});

test("SAPI 兜底：edge 失败时真机合成 wav（PS7 System.Speech）", async (t) => {
  if (!fs.existsSync(PS7_PATH)) {
    t.skip("PowerShell 7 不存在（" + PS7_PATH + "），跳过 SAPI 真机冒烟");
    return;
  }
  const dbPath = await createFixtureDb();
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-sapi-fallback");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_FAIL: "1",
    RA_PS7_PATH: PS7_PATH,
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);

    const resp = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    assert.ok(resp.result, "edge 失败后 SAPI 兜底应返回结果: " + JSON.stringify(resp.error || {}));
    const chunk = JSON.parse(resp.result.content[0].text);
    assert.ok(chunk.ok, "应成功回退");
    assert.equal(chunk.engine, "sapi", "engine 字段应为 sapi");
    assert.equal(chunk.mimeType, "audio/wav");
    assert.ok(chunk.dataUri.startsWith("data:audio/wav;base64,"), "dataUri 应为 audio/wav");
    const wav = Buffer.from(chunk.dataUri.slice("data:audio/wav;base64,".length), "base64");
    assert.equal(wav.slice(0, 4).toString("latin1"), "RIFF", "wav 头 RIFF");
    assert.equal(wav.slice(8, 12).toString("latin1"), "WAVE", "wav 头 WAVE");
    assert.ok(wav.length > 1000, "真机合成应有实质音频，实测 " + wav.length + " 字节");
    const fmt = readWavFmt(wav);
    assert.equal(fmt.sampleRate, 44100, "请求 44100Hz");
    assert.equal(fmt.channels, 1, "请求单声道");
    assert.equal(fmt.bits, 16, "请求 16bit");
    const seconds = fmt.dataSize / ((fmt.sampleRate * fmt.channels * fmt.bits) / 8);
    assert.ok(seconds > 0.3 && seconds < 60, "应有真实语音时长，实测 " + seconds.toFixed(2) + "s");
    assert.equal(chunk.cached, false, "首次 SAPI 合成 cached=false");

    // 第二次：edge 仍失败，但 wav 缓存命中
    const resp2 = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    const chunk2 = JSON.parse(resp2.result.content[0].text);
    assert.equal(chunk2.engine, "sapi");
    assert.equal(chunk2.cached, true, "第二次应命中 wav 缓存");
    assert.equal(chunk2.bytes, chunk.bytes, "缓存字节数应一致");
  } finally {
    client.close();
  }
});

test("SAPI 兜底：缓存位有毒 mp3 时 edge 失败仍能回退 SAPI（毒缓存不遮蔽兜底）", async (t) => {
  if (!fs.existsSync(PS7_PATH)) {
    t.skip("PowerShell 7 不存在（" + PS7_PATH + "），跳过 SAPI 真机冒烟");
    return;
  }
  const dbPath = await createFixtureDb();
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-sapi-poison-mp3");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_FAIL: "1", // edge 必失败 → 只能走 SAPI
    RA_PS7_PATH: PS7_PATH,
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);

    // 预埋评审复现出来的 13 字节毒 mp3：修复前它会被 existsSync 命中，SAPI 永远没机会被尝试
    const chunksDir = path.join(cacheDir, "chunks");
    fs.mkdirSync(chunksDir, { recursive: true });
    const key = cacheKeyFor("你好。", "zh-CN-XiaoxiaoNeural", "+0%");
    const poisonPath = path.join(chunksDir, key + ".mp3");
    fs.writeFileSync(poisonPath, Buffer.from([73, 68, 51, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));

    const resp = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    assert.ok(resp.result, "毒缓存存在时也应返回结果: " + JSON.stringify(resp.error || {}));
    const chunk = JSON.parse(resp.result.content[0].text);
    assert.equal(chunk.engine, "sapi", "edge 失败后应触达 SAPI 兜底（修复前被毒 mp3 遮蔽）");
    assert.equal(chunk.cached, false, "SAPI 首次合成 cached=false");
    assert.ok(chunk.bytes >= 1024, "SAPI wav 应达有效大小下限，实测 " + chunk.bytes + " 字节");
    assert.equal(fs.existsSync(poisonPath), false, "毒 mp3 应被 unlink，不得继续占据缓存 key");
    assert.ok(fs.existsSync(path.join(chunksDir, key + ".wav")), "SAPI 兜底 wav 应已落盘");
  } finally {
    client.close();
  }
});

test("SAPI 兜底：edge 与 SAPI 都失败时错误含两段原因", async () => {
  const dbPath = await createFixtureDb();
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-sapi-both-fail");
  const client = new McpClient(SERVER, {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_FAIL: "1",
    RA_PS7_PATH: path.join(TMP, "no-such-pwsh.exe"),
  });
  try {
    const sessionResp = await client.call("tools/call", {
      name: "speak_session",
      arguments: { sessionId: "sess_main" },
    });
    const session = JSON.parse(sessionResp.result.content[0].text);
    const resp = await client.call("tools/call", {
      name: "speak_chunk",
      arguments: { requestId: session.requestId, index: 0 },
    });
    assert.ok(resp.error, "两边都失败应报错");
    assert.match(String(resp.error.message), /edge-tts 合成失败/);
    assert.match(String(resp.error.message), /SAPI 兜底失败/);
    assert.match(String(resp.error.message), /未找到 PowerShell 7/);
  } finally {
    client.close();
  }
});

// ---------------------------------------------------------------- 原子写收尾回归（2026-11-09）
// 缓存位落盘 = 「同目录唯一 .part 临时文件 → fsync → 原子 rename」。这里补齐两个 MCP 黑盒
// 测不到的场景：① 有效缓存永远先命中、黑盒打不出「失败重写覆盖既有版本」，须直调
// synthesizeEdge；② 同 key 去重（inflightSynth）只在单进程内生效，跨进程并发须双 server。

import { synthesizeEdge, flushThenRename } from "../dist/server.mjs";

function findPythonSync() {
  const candidates = [];
  if (process.env.RA_PYTHON_PATH) candidates.push(String(process.env.RA_PYTHON_PATH).trim());
  candidates.push("python", "python3", "py");
  for (const cand of candidates) {
    const args = cand === "py" ? ["-3", "--version"] : ["--version"];
    const r = spawnSync(cand, args, { encoding: "utf8", timeout: 10000 });
    if (r.status === 0 && /Python\s/i.test(String(r.stdout || ""))) return cand;
  }
  return null;
}

// 与 createPythonEdgeStub 的 healthy 输出逐字节对齐：header 8 字节 + tag×1000 + 64 字节 = 1072
function stubHealthyBytes(tag) {
  return Buffer.concat([
    Buffer.from([73, 68, 51, 3, 0, 0, 0, 0]),
    Buffer.from(String(tag).repeat(1000), "utf8"),
    Buffer.alloc(64),
  ]);
}

async function withTestEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) {
    saved[k] = process.env[k];
    process.env[k] = overrides[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(overrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function waitUntil(fn, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 40));
  }
  return fn();
}

function seedPreviousVersion(target) {
  const previous = Buffer.concat([Buffer.from([73, 68, 51, 3]), Buffer.alloc(4096, 0x5a)]);
  fs.writeFileSync(target, previous);
  return previous;
}

test("原子写（直调）：rename 前合成失败，既有缓存版本完整保留且无 .part 残留", async (t) => {
  const python = findPythonSync();
  if (!python) return t.skip("python 不可用");
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "atomic-unit-fail");
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, "seeded.mp3");
  const previous = seedPreviousVersion(target);
  const control = path.join(TMP, "stub-control-atomic-fail.txt");
  fs.writeFileSync(control, "fail\n0\n", "utf8"); // 桩退出码 1、不产文件
  await withTestEnv({
    RA_PYTHON_PATH: python,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_CONTROL: control,
  }, async () => {
    await assert.rejects(
      () => synthesizeEdge("存量覆盖场景。", "zh-CN-XiaoxiaoNeural", "+0%", target),
      /退出码 1/,
      "fail 桩应让 synthesizeEdge 抛错"
    );
  });
  assert.ok(fs.readFileSync(target).equals(previous), "目标缓存位必须保持上一次的完整版本");
  const residue = fs.readdirSync(cacheDir).filter((f) => f.indexOf(".part") >= 0);
  assert.deepEqual(residue, [], "不得残留 .part 临时文件: " + residue.join(", "));
});

test("原子写（直调）：超时 SIGKILL 留下的半截 .part 被清理，既有缓存版本完整保留", async (t) => {
  const python = findPythonSync();
  if (!python) return t.skip("python 不可用");
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "atomic-unit-partial");
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, "seeded.mp3");
  const previous = seedPreviousVersion(target);
  const control = path.join(TMP, "stub-control-atomic-partial.txt");
  fs.writeFileSync(control, "partial\n2.5\n", "utf8"); // 先写 13 字节半截再挂起
  await withTestEnv({
    RA_PYTHON_PATH: python,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_CONTROL: control,
    RA_SYNTH_TIMEOUT_MS: "600",
  }, async () => {
    await assert.rejects(
      () => synthesizeEdge("半截中断场景。", "zh-CN-XiaoxiaoNeural", "+0%", target),
      /超时/,
      "挂起桩应触发超时中止"
    );
  });
  const residueOk = await waitUntil(
    () => fs.readdirSync(cacheDir).filter((f) => f.indexOf(".part") >= 0).length === 0
  );
  assert.ok(residueOk, "半截 .part 应被清理，实测: " + fs.readdirSync(cacheDir).join(", "));
  assert.ok(fs.readFileSync(target).equals(previous), "半截中断后目标缓存位必须保持上一次的完整版本");
});

test("原子写（直调）：成功合成经 fsync + 原子 rename 完整替换既有缓存位", async (t) => {
  const python = findPythonSync();
  if (!python) return t.skip("python 不可用");
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "atomic-unit-success");
  fs.mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, "seeded.mp3");
  seedPreviousVersion(target);
  const control = path.join(TMP, "stub-control-atomic-success.txt");
  fs.writeFileSync(control, "healthy\n0\n", "utf8");
  await withTestEnv({
    RA_PYTHON_PATH: python,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_CONTROL: control,
    RA_TEST_STUB_TAG: "U",
  }, async () => {
    await synthesizeEdge("成功替换场景。", "zh-CN-XiaoxiaoNeural", "+0%", target);
  });
  assert.ok(fs.readFileSync(target).equals(stubHealthyBytes("U")), "成功路径应原子替换为完整新内容");
  const residue = fs.readdirSync(cacheDir).filter((f) => f.indexOf(".part") >= 0);
  assert.deepEqual(residue, [], "成功路径同样不得残留 .part: " + residue.join(", "));
});

test("原子写（直调）：flushThenRename 把 .part 完整替换到已有旧版本的最终位", () => {
  const dir = path.join(TMP, "atomic-flushrename");
  fs.mkdirSync(dir, { recursive: true });
  const finalFile = path.join(dir, "final.mp3");
  const partFile = path.join(dir, "final.mp3." + process.pid + ".abc.part.mp3");
  fs.writeFileSync(finalFile, Buffer.alloc(2048, 0x11));
  const fresh = Buffer.concat([Buffer.from([73, 68, 51, 3]), Buffer.alloc(1072, 0x22)]);
  fs.writeFileSync(partFile, fresh);
  return flushThenRename(partFile, finalFile).then(() => {
    assert.ok(fs.readFileSync(finalFile).equals(fresh), "最终位应被 .part 的完整内容原子替换");
    assert.equal(fs.existsSync(partFile), false, "rename 后 .part 不应存在");
  });
});

test("原子写（跨进程）：两个 server 并发写同一缓存 key，最终文件为两者之一的完整内容", async () => {
  const dbPath = await createFixtureDb();
  const { stubDir } = createPythonEdgeStub();
  const cacheDir = path.join(TMP, "cache-race-crossproc");
  const control = path.join(TMP, "stub-control-crossproc.txt");
  fs.writeFileSync(control, "healthy\n0\n", "utf8");
  const baseEnv = {
    RA_DB_PATH: dbPath,
    ZCODE_PLUGIN_DATA: cacheDir,
    PYTHONPATH: stubDir,
    RA_TEST_STUB_CONTROL: control,
    RA_PS7_PATH: path.join(TMP, "no-such-pwsh.exe"), // 隔离：只允许 edge 命中 mp3 位，排除 SAPI 兜底搅局
  };
  const c1 = new McpClient(SERVER, Object.assign({}, baseEnv, { RA_TEST_STUB_TAG: "A" }));
  const c2 = new McpClient(SERVER, Object.assign({}, baseEnv, { RA_TEST_STUB_TAG: "B" }));
  try {
    const sessions = await Promise.all([
      c1.call("tools/call", { name: "speak_session", arguments: { sessionId: "sess_main" } }),
      c2.call("tools/call", { name: "speak_session", arguments: { sessionId: "sess_main" } }),
    ]);
    const s1 = JSON.parse(sessions[0].result.content[0].text);
    const s2 = JSON.parse(sessions[1].result.content[0].text);
    // 同一 db 同一块文本 + 同默认音色/倍速 → 同一 cacheKey → 同一最终缓存位
    const [r1, r2] = await Promise.all([
      c1.call("tools/call", { name: "speak_chunk", arguments: { requestId: s1.requestId, index: 0 } }),
      c2.call("tools/call", { name: "speak_chunk", arguments: { requestId: s2.requestId, index: 0 } }),
    ]);
    assert.ok(r1.result, "进程 A 应成功: " + JSON.stringify(r1.error || {}));
    assert.ok(r2.result, "进程 B 应成功: " + JSON.stringify(r2.error || {}));
    const p1 = JSON.parse(r1.result.content[0].text);
    const p2 = JSON.parse(r2.result.content[0].text);
    assert.equal(p1.engine, "edge", "A 应走 edge");
    assert.equal(p2.engine, "edge", "B 应走 edge");

    const files = listCacheFiles(cacheDir);
    const mp3s = files.filter((f) => f.endsWith(".mp3"));
    assert.equal(mp3s.length, 1, "同 key 应恰好落一个最终 mp3: " + files.join(", "));
    const final = fs.readFileSync(path.join(cacheDir, "chunks", mp3s[0]));
    const contentA = stubHealthyBytes("A");
    const contentB = stubHealthyBytes("B");
    const isA = final.equals(contentA);
    const isB = final.equals(contentB);
    assert.ok(isA || isB, "最终文件必须是 A/B 之一的完整内容，不得是半截或交错产物（实测 " + final.length + " 字节）");
    const residue = files.filter((f) => f.indexOf(".part") >= 0);
    assert.deepEqual(residue, [], "并发结束后不得残留 .part: " + residue.join(", "));
  } finally {
    c1.close();
    c2.close();
  }
});
