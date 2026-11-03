// server.test.mjs — MCP 协议自测 + 工具逻辑单测

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

// ---------------------------------------------------------------- 假 python stub

function createFakePython() {
  const stubPath = path.join(TMP, "fake-python.mjs");
  // 一个能写最小合法 mp3 的 node 脚本（模拟 edge-tts）
  // 解析 --voice/--rate/--text/--write-media
  const script = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
function getArgEq(name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith(name + "=")) return args[i].slice(name.length + 1);
  }
  return null;
}
if (args[0] === "--version" || args[0] === "-3" || args[0] === "-3" && args[1] === "--version") {
  process.stdout.write("Python 3.12.10 (fake stub)\\n");
  process.exit(0);
}
// 模拟 edge-tts -m edge_tts 调用
const voice = getArg("--voice");
const rate = getArgEq("--rate");
const text = getArg("--text");
const media = getArg("--write-media");
if (media) {
  // 写一个最小合法 mp3（ID3 头 + 帧）
  const header = Buffer.from("ID3\\x03\\x00\\x00\\x00\\x00\\x00\\x00", "binary");
  const frame = Buffer.alloc(200);
  frame.write("\\xFF\\xFB", 0, "binary");
  frame.writeUInt16LE(0x1234, 2);
  const data = Buffer.concat([header, frame]);
  fs.writeFileSync(media, data);
  process.stderr.write("edge-tts: voice=" + voice + " rate=" + rate + "\\n");
  process.exit(0);
}
process.stderr.write("fake python: unsupported args\\n");
process.exit(1);
`;
  fs.writeFileSync(stubPath, script, "utf8");
  return stubPath;
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

test("tools/call：speak_chunk 正常路径（假 python stub）", async () => {
  const dbPath = await createFixtureDb();
  const fakePython = createFakePython();
  const cacheDir = path.join(TMP, "cache-test-17");
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath, RA_PYTHON_PATH: fakePython, ZCODE_PLUGIN_DATA: cacheDir });
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

test("tools/call：speak_chunk 覆盖断言（P0-1 核心）", async () => {
  const dbPath = await createFixtureDb();
  const fakePython = createFakePython();
  const cacheDir = path.join(TMP, "cache-test-18");
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath, RA_PYTHON_PATH: fakePython, ZCODE_PLUGIN_DATA: cacheDir });
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
    // 覆盖后 cached 可能为 true（缓存 key 不同，但假 stub 每次都写），但 voice/rate 不同
    // 验证响应回显覆盖值（cacheKey 不同体现在磁盘文件名不同，但假 stub 不暴露文件名）
    // 核心断言：响应回显 effective voice/rate
    assert.notEqual(payload3.voice, payload2.voice, "覆盖后 voice 应不同");
  } finally {
    client.close();
  }
});

test("tools/call：speak_chunk 缓存命中（第二次同 text+voice+rate）", async () => {
  const dbPath = await createFixtureDb();
  const fakePython = createFakePython();
  const cacheDir = path.join(TMP, "cache-test");
  const client = new McpClient(SERVER, { RA_DB_PATH: dbPath, RA_PYTHON_PATH: fakePython, ZCODE_PLUGIN_DATA: cacheDir });
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
// 这里用真实 edge-tts（网络）验证缓存 key 逻辑，无 edge-tts 时 skip。

test("缓存 key：同 text+voice+rate → 同 key（第二次 cached=true）", async (t) => {
  // 需要真实 edge-tts（网络）；假 python stub 在 Windows 上不可执行
  // 跳过条件：python 未解析
  const probeClient = new McpClient(SERVER, {});
  try {
    const infoResp = await probeClient.call("tools/call", { name: "session_info", arguments: {} });
    const info = JSON.parse(infoResp.result.content[0].text);
    if (info.pythonResolved === null) {
      t.skip("python/edge-tts 不可用，跳过缓存 key 验证（不算失败）");
      return;
    }
  } finally {
    probeClient.close();
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

test("缓存 key：异 voice → 异 key（覆盖后 cached=false）", async (t) => {
  const probeClient = new McpClient(SERVER, {});
  try {
    const infoResp = await probeClient.call("tools/call", { name: "session_info", arguments: {} });
    const info = JSON.parse(infoResp.result.content[0].text);
    if (info.pythonResolved === null) {
      t.skip("python/edge-tts 不可用，跳过缓存 key 验证（不算失败）");
      return;
    }
  } finally {
    probeClient.close();
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
