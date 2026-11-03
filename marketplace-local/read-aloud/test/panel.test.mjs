// panel.test.mjs — panel.html 静态检查 + VOICE_LIST 一致性

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const PANEL_PATH = path.join(PLUGIN_ROOT, "dist", "panel.html");
const CORE_PATH = path.join(PLUGIN_ROOT, "dist", "core.mjs");

const panelHtml = fs.readFileSync(PANEL_PATH, "utf8");

// ---------------------------------------------------------------- 禁用 API

test("panel.html：无 fetch/XHR/WebSocket", () => {
  assert.ok(panelHtml.indexOf("fetch(") < 0, "不应出现 fetch(");
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
