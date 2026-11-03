// panel.test.mjs — panel.html 静态检查 + VOICE_LIST 一致性

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const PANEL_PATH = path.join(PLUGIN_ROOT, "dist", "panel.html");
const CORE_PATH = path.join(PLUGIN_ROOT, "dist", "core.mjs");

const panelHtml = fs.readFileSync(PANEL_PATH, "utf8");

// ---------------------------------------------------------------- 禁用 API

test("panel.html：无 fetch/XHR/WebSocket", () => {
  // 只禁「真正的 fetch 调用」：允许 prefetchChunk 这类标识符出现（前一个字符是词字符）
  assert.ok(!/(^|[^\w$])fetch\s*\(/.test(panelHtml), "不应出现 fetch(");
  assert.ok(panelHtml.indexOf("XMLHttpRequest") < 0, "不应出现 XMLHttpRequest");
  assert.ok(panelHtml.indexOf("WebSocket") < 0, "不应出现 WebSocket");
});

// ---------------------------------------------------------------- 音色表一致性

test("panel.html：VOICE_LIST 8 项与 server EDGE_ZH_VOICES 一致", async () => {
  // 从 panel.html 提取 VOICE_LIST
  const voiceMatched = /var VOICE_LIST = \[([\s\S]*?)\];/.exec(panelHtml);
  assert.ok(voiceMatched, "应能提取 VOICE_LIST");
  const voiceBlock = voiceMatched[1];
  const names = [];
  const nameRegex = /name:\s*"([^"]+)"/g;
  let m;
  while ((m = nameRegex.exec(voiceBlock)) !== null) {
    names.push(m[1]);
  }
  assert.equal(names.length, 8, "VOICE_LIST 应有 8 项");

  // 从 core.mjs 导入 EDGE_ZH_VOICES
  const coreModule = await import(new URL("../dist/core.mjs", import.meta.url).href);
  assert.deepEqual(names, coreModule.EDGE_ZH_VOICES, "VOICE_LIST 与 EDGE_ZH_VOICES 完全一致");
});

test("panel.html：8 音色 name/label/gender/style 齐全", () => {
  const voiceMatched = /var VOICE_LIST = \[([\s\S]*?)\];/.exec(panelHtml);
  assert.ok(voiceMatched, "应能提取 VOICE_LIST");
  const voiceBlock = voiceMatched[1];
  // 每个音色应有 name/label/gender/style 四个字段
  const entries = voiceBlock.split(/\n\s*\{/);
  assert.equal(entries.length - 1, 8, "应有 8 个音色条目");
  for (const entry of entries.slice(1)) {
    for (const field of ["name", "label", "gender", "style"]) {
      assert.ok(entry.indexOf(field + ":") >= 0, "音色条目应含字段 " + field);
    }
  }
});

// ---------------------------------------------------------------- 尺寸

test("panel.html：< 4MiB", () => {
  assert.ok(Buffer.byteLength(panelHtml, "utf8") < 4 * 1024 * 1024, "panel.html < 4MiB");
});

// ---------------------------------------------------------------- 协议标记

test("panel.html：含 callTool/postMessage 协议标记", () => {
  assert.ok(panelHtml.indexOf("callTool") >= 0, "含 callTool");
  assert.ok(panelHtml.indexOf("postMessage") >= 0, "含 postMessage");
  assert.ok(panelHtml.indexOf("tools/call") >= 0, "含 tools/call");
  assert.ok(panelHtml.indexOf("jsonrpc") >= 0, "含 jsonrpc");
});

test("panel.html：含 speak_session/speak_chunk 工具调用", () => {
  assert.ok(panelHtml.indexOf("speak_session") >= 0, "含 speak_session");
  assert.ok(panelHtml.indexOf("speak_chunk") >= 0, "含 speak_chunk");
  // list_voices/session_info 是模型侧工具（命令/技能调用），面板不直接调用
});

// ---------------------------------------------------------------- DOM 结构

test("panel.html：DOM 控件齐全", () => {
  const selectors = [
    'id="ra-voice"',
    'id="ra-rate"',
    'id="ra-speak"',
    'id="ra-stop"',
    'id="ra-progress"',
    'id="ra-progress-bar"',
    'id="ra-transcript"',
    'id="ra-status"',
    'id="ra-hint"',
    'id="ra-session-note"',
  ];
  for (const sel of selectors) {
    assert.ok(panelHtml.indexOf(sel) >= 0, "应含 DOM 控件 " + sel);
  }
});

test("panel.html：倍速选项 6 个（0.5/0.75/1/1.25/1.5/2）", () => {
  const rateMatched = /id="ra-rate"[\s\S]*?<\/select>/.exec(panelHtml);
  assert.ok(rateMatched, "应能提取倍速 select");
  const block = rateMatched[0];
  for (const val of ["0.5", "0.75", "1", "1.25", "1.5", "2"]) {
    assert.ok(block.indexOf('value="' + val + '"') >= 0, "倍速选项应含 " + val);
  }
});

test("panel.html：RATE_MAP 映射表存在", () => {
  assert.ok(panelHtml.indexOf("RATE_MAP") >= 0, "应含 RATE_MAP");
  // 0.5×→-10, 0.75×→-5, 1×→0, 1.25×→5, 1.5×→10, 2×→10（-10..10 标度）
  const rateMapMatched = /var RATE_MAP = \{([\s\S]*?)\};/.exec(panelHtml);
  assert.ok(rateMapMatched, "应能提取 RATE_MAP");
  assert.ok(rateMapMatched[1].indexOf('"0.5": -10') >= 0, "0.5×→-10");
  assert.ok(rateMapMatched[1].indexOf('"0.75": -5') >= 0, "0.75×→-5");
  assert.ok(rateMapMatched[1].indexOf('"1": 0') >= 0, "1×→0");
  assert.ok(rateMapMatched[1].indexOf('"1.25": 5') >= 0, "1.25×→5");
  assert.ok(rateMapMatched[1].indexOf('"1.5": 10') >= 0, "1.5×→10");
  assert.ok(rateMapMatched[1].indexOf('"2": 10') >= 0, "2×→10（edge-tts 上限）");
});

test("panel.html：超时 150s + 重试一次", () => {
  assert.ok(panelHtml.indexOf("150000") >= 0, "超时 150s");
  assert.ok(panelHtml.indexOf("retries") >= 0, "含重试逻辑");
  assert.ok(panelHtml.indexOf("重试一次") >= 0, "重试提示");
});

test("panel.html：自动播放策略处理", () => {
  assert.ok(panelHtml.indexOf("自动播放") >= 0, "含自动播放处理");
  assert.ok(panelHtml.indexOf("playPromise") >= 0 || panelHtml.indexOf("play()") >= 0, "含 play 调用");
  assert.ok(panelHtml.indexOf("浏览器拦截") >= 0, "含拦截提示");
});

test("panel.html：停止语义（runId 作废）", () => {
  assert.ok(panelHtml.indexOf("currentRunId") >= 0, "含 runId");
  assert.ok(panelHtml.indexOf("stopSpeak") >= 0, "含 stopSpeak");
  assert.ok(panelHtml.indexOf("audio.pause") >= 0 || panelHtml.indexOf("audio.pause()") >= 0, "含 pause");
});

test("panel.html：会话身份透明化", () => {
  assert.ok(panelHtml.indexOf("sessionSource") >= 0, "含 sessionSource");
  assert.ok(panelHtml.indexOf("fallback-latest") >= 0, "含 fallback-latest");
  assert.ok(panelHtml.indexOf("host 未注入身份") >= 0, "含透明提示");
});

test("panel.html：CSP 合规（无外部资源引用）", () => {
  // 不应有 http/https 外部引用
  assert.ok(panelHtml.indexOf("http://") < 0, "不应有 http:// 引用");
  assert.ok(panelHtml.indexOf("https://") < 0, "不应有 https:// 引用");
  assert.ok(panelHtml.indexOf("src=") < 0 || panelHtml.indexOf("<script src=") < 0, "不应有外部 script src");
});

test("panel.html：finishRun 已定义", () => {
  assert.ok(panelHtml.indexOf("function finishRun") >= 0, "应定义 finishRun");
  assert.ok(panelHtml.indexOf("朗读完成") >= 0, "finishRun 含完成状态文案");
  assert.ok(panelHtml.indexOf("aria-pressed") >= 0, "finishRun 重置 aria-pressed");
});

test("panel.html：runId 校验（requestChunk 捕获 myRun）", () => {
  assert.ok(panelHtml.indexOf("var myRun = currentRunId") >= 0, "requestChunk 应捕获 myRun");
  assert.ok(panelHtml.indexOf("myRun !== currentRunId") >= 0, "应校验 runId 失效");
});

test("panel.html：stopSpeak 清空 pending 表", () => {
  assert.ok(panelHtml.indexOf("pending = {}") >= 0, "stopSpeak 应清空 pending");
  assert.ok(panelHtml.indexOf("clearTimeout") >= 0, "stopSpeak 应清除定时器");
});

test("panel.html：handleInbound 置 speaking 态", () => {
  assert.ok(panelHtml.indexOf("handleInbound") >= 0, "含 handleInbound");
  // handleInbound 内应有 state = "speaking" 和 currentRunId++
  const inboundSection = /function handleInbound[\s\S]*?\n  \}/.exec(panelHtml);
  assert.ok(inboundSection, "应能提取 handleInbound");
  assert.ok(inboundSection[0].indexOf('state = "speaking"') >= 0, "handleInbound 应置 speaking");
  assert.ok(inboundSection[0].indexOf("currentRunId++") >= 0, "handleInbound 应递增 runId");
});

// ---------------------------------------------------------------- K10 背景预取（行为测试）
// 用 vm + 最小 DOM 桩真实执行 panel.html 内联脚本，断言：
//  · 播放第 N 块时后台预请求第 N+1 块
//  · 预取结果供下一块无缝起播（同一 index 不二次请求 = 防双发）
//  · runId 守卫丢弃陈旧响应（停止/重启/换音色后旧预取不误播）

function extractPanelScript() {
  const matched = /<script>([\s\S]*?)<\/script>/.exec(panelHtml);
  assert.ok(matched, "应能提取 panel.html 内联脚本");
  return matched[1];
}

function makeEl(name) {
  return {
    id: name,
    innerHTML: "",
    textContent: "",
    value: "",
    disabled: false,
    style: {},
    attrs: {},
    listeners: {},
    children: [],
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    scrollIntoView() {},
    fire(type, ev) {
      for (const fn of this.listeners[type] || []) fn(ev || {});
    },
  };
}

const flush = async (times = 8) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
};

function createPanelHarness(chunkCount = 3) {
  const els = new Map();
  const sent = [];
  const messageListeners = [];
  const audioInstances = [];

  const el = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };

  class FakeAudio {
    constructor() {
      this.listeners = {};
      this.error = null;
      this.playCalls = 0;
      this.paused = false;
      this.srcHistory = [];
      const self = this;
      let src = null;
      Object.defineProperty(this, "src", {
        get() { return src; },
        set(v) { src = v; self.srcHistory.push(v); },
        enumerable: true,
        configurable: true,
      });
      audioInstances.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
      return this;
    }
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    fireEnded() { for (const fn of this.listeners.ended || []) fn({}); }
  }

  const sandbox = {
    window: {
      parent: { postMessage(msg) { sent.push(msg); } },
      addEventListener(type, fn) {
        if (type === "message") messageListeners.push(fn);
      },
    },
    document: {
      getElementById: (id) => el(id),
      createElement: (tag) => makeEl("created:" + tag),
    },
    Audio: FakeAudio,
    // 超时/重试在本测试内不触发：桩掉定时器，测试保持确定性
    setTimeout: () => 0,
    clearTimeout: () => {},
    console,
  };

  vm.runInNewContext(extractPanelScript(), sandbox, { filename: "panel.html<script>" });

  const deliver = (data) => {
    for (const fn of messageListeners) fn({ data });
  };

  const api = {
    el,
    els,
    sent,
    audio: () => audioInstances[0],
    audioCount: () => audioInstances.length,
    msgWith: (name) => sent.filter((m) => m.method === "tools/call" && m.params.name === name),
    chunkIndexes: () =>
      sent.filter((m) => m.method === "tools/call" && m.params.name === "speak_chunk")
        .map((m) => m.params.arguments.index),
    chunkMsgs: () => sent.filter((m) => m.method === "tools/call" && m.params.name === "speak_chunk"),
    clickSpeak: () => el("ra-speak").fire("click"),
    clickStop: () => el("ra-stop").fire("click"),
    changeVoice: (voice) => {
      el("ra-voice").value = voice;
      el("ra-voice").fire("change");
    },
    respondSession(msg, payload) {
      deliver({
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      });
    },
    respondChunk(msg, overrides) {
      const args = msg.params.arguments;
      const payload = Object.assign(
        {
          ok: true,
          requestId: args.requestId,
          index: args.index,
          voice: args.voice || "zh-CN-XiaoxiaoNeural",
          rate: args.rate === undefined ? 0 : args.rate,
          engine: "edge",
          mimeType: "audio/mpeg",
          dataUri: "data:audio/mpeg;base64,chunk-" + args.index,
          cached: false,
        },
        overrides || {}
      );
      deliver({
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      });
      return payload.dataUri;
    },
    failChunk(msg, message) {
      deliver({ id: msg.id, error: { message: message || "合成失败" } });
    },
    flush,
  };

  api.sessionPayload = (requestId) => ({
    ok: true,
    requestId: requestId || "req-1",
    voice: "zh-CN-XiaoxiaoNeural",
    rate: 0,
    sessionId: "sess-1",
    chunks: Array.from({ length: chunkCount }, (_, i) => ({
      role: "assistant",
      label: "第" + (i + 1) + "段",
      text: "文本" + i,
    })),
  });

  return api;
}

// 启动到「第 1 块开播」的公共前奏
async function startAndPlayFirst(h) {
  h.clickSpeak();
  await flush();
  const sessionMsg = h.msgWith("speak_session")[0];
  assert.ok(sessionMsg, "点击朗读应发出 speak_session");
  h.respondSession(sessionMsg, h.sessionPayload());
  await flush();
  const chunk0 = h.chunkMsgs().find((m) => m.params.arguments.index === 0);
  assert.ok(chunk0, "应请求第 1 块（index 0）");
  h.respondChunk(chunk0);
  await flush();
  return chunk0;
}

test("K10：播放第 1 块时背景预请求第 2 块", async () => {
  const h = createPanelHarness(3);
  await startAndPlayFirst(h);

  assert.deepEqual(h.chunkIndexes(), [0, 1], "第 0 块开播后应立即预取第 1 块（index 1）");
  assert.equal(h.audio().srcHistory.at(-1), "data:audio/mpeg;base64,chunk-0", "当前仍在播第 0 块");
});

test("K10：预取结果供下一块无缝起播，且同一 index 不重复请求（防双发）", async () => {
  const h = createPanelHarness(3);
  await startAndPlayFirst(h);
  const prefetch1 = h.chunkMsgs().find((m) => m.params.arguments.index === 1);
  assert.ok(prefetch1, "应有 index 1 的预取在途");

  // 第 0 块播完 → 第 1 块：预取仍在途，应复用而非再发一次
  h.audio().fireEnded();
  await flush();
  assert.equal(
    h.chunkIndexes().filter((i) => i === 1).length,
    1,
    "index 1 只应发出一次请求（预取在途时复用，不双发）"
  );

  // 预取响应到达 → 无缝起播
  h.respondChunk(prefetch1);
  await flush();
  assert.equal(h.audio().srcHistory.at(-1), "data:audio/mpeg;base64,chunk-1", "第 1 块直接使用预取音频起播");
  assert.equal(h.audio().playCalls, 2, "第 1 块应正常播放（无需等第二次合成）");
  assert.equal(h.audio().srcHistory.length, 2, "第 1 块不应再切一次 src");
  // 第 1 块开播后应预取第 2 块
  assert.ok(h.chunkIndexes().includes(2), "第 1 块开播后应预取第 2 块");
});

test("K10：预取响应先到（已缓存）时下一块直接用缓存", async () => {
  const h = createPanelHarness(3);
  await startAndPlayFirst(h);
  const prefetch1 = h.chunkMsgs().find((m) => m.params.arguments.index === 1);
  h.respondChunk(prefetch1);
  await flush();
  const before = h.chunkIndexes().filter((i) => i === 1).length;
  h.audio().fireEnded();
  await flush();
  assert.equal(
    h.chunkIndexes().filter((i) => i === 1).length,
    before,
    "缓存命中时不应再为 index 1 发请求"
  );
  assert.equal(h.audio().srcHistory.at(-1), "data:audio/mpeg;base64,chunk-1", "用缓存音频起播");
});

test("K10：runId 守卫——换音色后旧预取响应不误播", async () => {
  const h = createPanelHarness(3);
  await startAndPlayFirst(h);
  const staleMsg = h.chunkMsgs().find((m) => m.params.arguments.index === 1);
  assert.ok(staleMsg, "应有 index 1 预取在途（旧 run）");
  const playsBefore = h.audio().playCalls;

  // 换音色 → restartCurrent：currentRunId++ + resetPrefetch
  h.changeVoice("zh-CN-YunxiNeural");
  await flush();
  const restartMsg = h.chunkMsgs().filter((m) => m.params.arguments.index === 0).at(-1);
  assert.ok(restartMsg, "换音色后应重新请求当前块");
  assert.equal(restartMsg.params.arguments.voice, "zh-CN-YunxiNeural", "重启请求应带新音色覆盖");

  // 旧 run 的预取响应迟到 → runId 守卫丢弃
  h.respondChunk(staleMsg, { dataUri: "data:audio/mpeg;base64,STALE" });
  await flush();
  assert.ok(
    !h.audio().srcHistory.includes("data:audio/mpeg;base64,STALE"),
    "陈旧的预取响应不得进入播放"
  );
  assert.equal(h.audio().playCalls, playsBefore, "陈旧响应不应触发 play");

  // 新一轮预取应重新发出（旧缓存未被复用）
  assert.equal(
    h.chunkMsgs().filter((m) => m.params.arguments.index === 1).length,
    1,
    "此时 index 1 只应存在旧 run 的那次请求（未被复用）"
  );
  h.respondChunk(restartMsg);
  await flush();
  assert.equal(
    h.chunkMsgs().filter((m) => m.params.arguments.index === 1).length,
    2,
    "新 run 第 0 块开播后应重新预取 index 1（旧缓存已作废）"
  );
});

test("K10：停止后旧预取响应静默丢弃", async () => {
  const h = createPanelHarness(3);
  await startAndPlayFirst(h);
  const staleMsg = h.chunkMsgs().find((m) => m.params.arguments.index === 1);
  const playsBefore = h.audio().playCalls;
  h.clickStop();
  await flush();
  h.respondChunk(staleMsg, { dataUri: "data:audio/mpeg;base64,AFTER-STOP" });
  await flush();
  assert.ok(
    !h.audio().srcHistory.includes("data:audio/mpeg;base64,AFTER-STOP"),
    "停止后迟到的预取响应不得播放"
  );
  assert.equal(h.audio().playCalls, playsBefore, "停止后不应再 play");
});

test("K10：预取失败静默回退，下一块按需重请", async () => {
  const h = createPanelHarness(3);
  await startAndPlayFirst(h);
  const prefetch1 = h.chunkMsgs().find((m) => m.params.arguments.index === 1);
  assert.ok(prefetch1, "应有 index 1 预取在途");
  h.failChunk(prefetch1, "预取超时");
  await flush();
  assert.equal(
    h.audio().srcHistory.at(-1),
    "data:audio/mpeg;base64,chunk-0",
    "预取失败不影响当前块播放"
  );
  assert.equal(h.el("ra-hint").textContent, "", "预取失败不应打扰用户（不显示错误）");

  h.audio().fireEnded();
  await flush();
  const retry = h.chunkMsgs().filter((m) => m.params.arguments.index === 1);
  assert.equal(retry.length, 2, "预取失败后下一块应按需重新请求");
  h.respondChunk(retry.at(-1));
  await flush();
  assert.equal(
    h.audio().srcHistory.at(-1),
    "data:audio/mpeg;base64,chunk-1",
    "回退请求应正常起播"
  );
});

test("K10：末块不预取（越界不发请求）", async () => {
  const h = createPanelHarness(1);
  await startAndPlayFirst(h);
  assert.deepEqual(h.chunkIndexes(), [0], "单块会话不应发出任何预取请求");
  h.audio().fireEnded();
  await flush();
  assert.deepEqual(h.chunkIndexes(), [0], "末尾结束后不应再有 speak_chunk");
  assert.ok(h.el("ra-status").textContent.indexOf("朗读完成") >= 0, "应进入完成态");
});

test("K10：模型触发的会话（handleInbound）同样预取下一块", async () => {
  const h = createPanelHarness(3);
  // 未匹配 id 的消息 → handleInbound → 渲染 + 自动播放
  h.respondSession({ id: 99999 }, h.sessionPayload("req-inbound"));
  await flush();
  const chunk0 = h.chunkMsgs().find((m) => m.params.arguments.index === 0);
  assert.ok(chunk0, "handleInbound 应自动请求第 1 块");
  h.respondChunk(chunk0);
  await flush();
  assert.deepEqual(h.chunkIndexes(), [0, 1], "handleInbound 起播后也应预取第 2 块");
});

// ---------------------------------------------------------------- K09 迟到 speak_session 不自动重启

test("K09：state==='stopped' 时忽略迟到的 speak_session（不自动重启朗读）", async () => {
  const h = createPanelHarness(3);
  await startAndPlayFirst(h); // 播放中
  h.clickStop();
  await flush();
  assert.equal(h.el("ra-status").textContent, "已停止", "停止后应处于 stopped 态");

  const chunksBefore = h.chunkIndexes().length;
  const playsBefore = h.audio().playCalls;
  // 迟到的模型触发结果（未匹配 id → handleInbound）
  h.respondSession({ id: 88888 }, h.sessionPayload("req-late"));
  await flush();

  assert.equal(h.chunkIndexes().length, chunksBefore, "stopped 态不得发起新的 speak_chunk");
  assert.equal(h.audio().playCalls, playsBefore, "stopped 态不得自动播放");
  assert.equal(h.el("ra-status").textContent, "已停止", "状态应保持已停止");
});

test("K09：从未起播就按停止，也会拦住迟到 speak_session", async () => {
  const h = createPanelHarness(3);
  h.clickStop();
  await flush();
  h.respondSession({ id: 77777 }, h.sessionPayload("req-late-2"));
  await flush();
  assert.deepEqual(h.chunkIndexes(), [], "stopped 态下迟到的会话结果不得触发朗读");
  assert.equal(h.audioCount(), 0, "不应创建 Audio 实例");
  assert.equal(h.el("ra-status").textContent, "已停止", "状态应保持已停止");
});

test("K09：speaking 中迟到的 speak_session 也不覆盖当前朗读", async () => {
  const h = createPanelHarness(3);
  await startAndPlayFirst(h);
  const chunksBefore = h.chunkIndexes().length;
  h.respondSession({ id: 66666 }, h.sessionPayload("req-late-3"));
  await flush();
  assert.equal(
    h.chunkIndexes().filter((i) => i === 0).length,
    1,
    "speaking 中不得因迟到结果重新从第 1 块起播"
  );
  assert.ok(h.chunkIndexes().length >= chunksBefore, "已有请求不应回退");
});

test("K09：idle 态仍按原语义自动播放（回归保护）", async () => {
  const h = createPanelHarness(3);
  h.respondSession({ id: 55555 }, h.sessionPayload("req-idle"));
  await flush();
  assert.deepEqual(h.chunkIndexes(), [0], "idle 态应自动请求第 1 块");
  assert.equal(h.el("ra-status").textContent, "正在合成第 1 块…", "应进入合成态");
});

// ---------------------------------------------------------------- K09 音色表校准一致性
// 校准结论：VOICE_LIST 与 server VOICE_META 的音色英文键与性别完全一致，无需修正；
// 用测试把「两份硬编码必须一致」锁住，防止后续漂移。

test("K09：VOICE_LIST 与 server VOICE_META 四项字段完全一致（无校准修正）", () => {
  const serverSrc = fs.readFileSync(path.join(PLUGIN_ROOT, "dist", "server.mjs"), "utf8");
  const entryRe = /\{\s*name:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*gender:\s*"([^"]+)",\s*style:\s*"([^"]+)"\s*\}/g;

  const collect = (src, blockRe, what) => {
    const block = blockRe.exec(src);
    assert.ok(block, "应能提取 " + what);
    const out = [];
    let m;
    while ((m = entryRe.exec(block[1])) !== null) {
      out.push({ name: m[1], label: m[2], gender: m[3], style: m[4] });
    }
    entryRe.lastIndex = 0;
    return out;
  };

  const serverVoices = collect(serverSrc, /const VOICE_META = \[([\s\S]*?)\];/, "VOICE_META");
  const panelVoices = collect(panelHtml, /var VOICE_LIST = \[([\s\S]*?)\];/, "VOICE_LIST");

  assert.equal(serverVoices.length, 8, "VOICE_META 应为 8 项");
  assert.equal(panelVoices.length, 8, "VOICE_LIST 应为 8 项");
  assert.deepEqual(panelVoices, serverVoices, "面板与 server 音色记录应逐字段一致");
  for (const v of panelVoices) {
    assert.ok(v.gender === "女" || v.gender === "男", "性别只能是 女/男：" + v.name);
    assert.ok(v.name.indexOf("zh-CN-") === 0, "音色键应为 zh-CN-*：" + v.name);
  }
});
