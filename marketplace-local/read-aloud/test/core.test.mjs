// core.test.mjs — vendor core 单测 + 与正本等价断言

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
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
} from "../dist/core.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const WORKSPACE_ROOT = path.resolve(PLUGIN_ROOT, "..", "..");
const ORIGINAL_CLI = path.join(WORKSPACE_ROOT, "read-aloud.mjs");

const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "read-aloud-core-test-"));

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on("exit", cleanup);

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

// ---------------------------------------------------------------- fixture sqlite

const FIXTURE_MESSAGES = [
  ["m1", 0, "user", {}, [["p1a", 0, { type: "text", text: "第一轮提问。" }]]],
  [
    "m2", 1, "assistant", {},
    [
      ["p2a", 2, { type: "tool", text: "工具调用，不应入朗读" }],
      ["p2b", 0, { type: "reasoning", text: "思考过程，不应入朗读" }],
      ["p2c", 1, { type: "text", text: "第一轮回答。" }],
    ],
  ],
  ["m3", 2, "user", { synthetic: true }, [["p3a", 0, { type: "text", text: "合成消息，不应入朗读。" }]]],
  [
    "m4", 3, "user", { metadata: { visibility: "model-only" } },
    [["p4a", 0, { type: "text", text: "模型可见消息，不应入朗读。" }]],
  ],
  [
    "m5", 4, "user", { metadata: { runtimeMessage: { source: "environment" } } },
    [["p5a", 0, { type: "text", text: "运行时环境消息，不应入朗读。" }]],
  ],
  [
    "m6", 5, "assistant", {},
    [["p6a", 0, { type: "text", text: "部件级合成，不应入朗读。", synthetic: true }]],
  ],
  [
    "m7", 6, "assistant", {},
    [
      ["p7b", 1, { type: "text", text: "段落B。" }],
      ["p7a", 0, { type: "text", text: "段落A。" }],
      ["p7c", 2, { type: "text", text: "   " }],
    ],
  ],
  [
    "m8", 7, "user", {},
    [["p8a", 0, { type: "text", text: "看代码：\n```js\nconst a = 1;\n```\n结束。" }]],
  ],
  [
    "m9", 8, "assistant", {},
    [
      ["p9a", 0, { type: "text", text: "" }],
      ["p9b", 1, { type: "text", text: "最后一句。" }],
    ],
  ],
  [
    "m10", 9, "user", {},
    [["p10a", 0, { type: "text", text: "部件级模型可见，不应入朗读。", metadata: { visibility: "model-only" } }]],
  ],
  [
    "m11", 10, "user", {},
    [["p11a", 0, { type: "text", text: "部件级运行时消息，不应入朗读。", metadata: { runtimeMessage: { source: "environment" } } }]],
  ],
];

let fixtureCounter = 0;

async function createFixtureDb() {
  const DatabaseSync = (await sqliteModule()).DatabaseSync;
  const dbPath = path.join(TMP, "fixture-" + fixtureCounter++ + ".sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(
      "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, time_updated INTEGER, time_deleted INTEGER);" +
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, sequence INTEGER);" +
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, sequence INTEGER);"
    );
    const insertSession = db.prepare("INSERT INTO session (id, title, time_updated, time_deleted) VALUES (?, ?, ?, ?)");
    insertSession.run("sess_subagent_abc", "子代理会话", 9000, null);
    insertSession.run("sess_dwf-xyz", "工作流会话", 8000, null);
    insertSession.run("sess_deleted", "已删除会话", 9500, 1);
    insertSession.run("sess_main", "主会话", 3000, null);

    const insertMessage = db.prepare("INSERT INTO message (id, session_id, data, sequence) VALUES (?, ?, ?, ?)");
    const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, data, sequence) VALUES (?, ?, ?, ?, ?)");
    for (const target of ["sess_main"]) {
      for (const [messageId, sequence, role, extra, parts] of FIXTURE_MESSAGES) {
        const data = Object.assign({ role: role }, extra);
        insertMessage.run(messageId + "_" + target, target, JSON.stringify(data), sequence);
        for (const [partId, partSequence, partData] of parts) {
          insertPart.run(partId + "_" + target, messageId + "_" + target, target, JSON.stringify(partData), partSequence);
        }
      }
    }
  } catch (err) {
    db.close();
    throw err;
  }
  db.close();
  return dbPath;
}

// ---------------------------------------------------------------- 1. 等价断言（防漂移）

test("等价断言：vendor extractMessages 与正本逐字节相等", async (t) => {
  if (!fs.existsSync(ORIGINAL_CLI)) {
    t.skip("正本 read-aloud.mjs 不存在，跳过等价断言（不算失败）");
    return;
  }
  const originalModule = await import(new URL("../../../read-aloud.mjs", import.meta.url).href);
  const dbPath = await createFixtureDb();
  const vendorDb = await openDatabase(dbPath);
  try {
    const vendorOut = extractMessages(vendorDb, "sess_main");
    const originalOut = originalModule.extractMessages(vendorDb, "sess_main");
    assert.deepStrictEqual(vendorOut, originalOut, "vendor 与正本 extractMessages 输出必须逐字节相等");
  } finally {
    vendorDb.close();
  }
});

// ---------------------------------------------------------------- 2. isSyntheticRecord

test("isSyntheticRecord：四态过滤", () => {
  assert.equal(isSyntheticRecord({ synthetic: true }), true);
  assert.equal(isSyntheticRecord({ metadata: { visibility: "model-only" } }), true);
  assert.equal(isSyntheticRecord({ metadata: { runtimeMessage: { source: "environment" } } }), true);
  assert.equal(isSyntheticRecord({ role: "user", text: "干净消息" }), false);
  assert.equal(isSyntheticRecord(null), false);
  assert.equal(isSyntheticRecord("not object"), false);
});

// ---------------------------------------------------------------- 3. readTextMessages

test("readTextMessages：排序/多part合并/过滤/role缺省", async () => {
  const dbPath = await createFixtureDb();
  const db = await openDatabase(dbPath);
  try {
    const messages = readTextMessages(db, "sess_main");
    assert.equal(messages.length, 5, "应得 5 条真实消息");
    assert.equal(messages[0].text, "第一轮提问。");
    assert.equal(messages[1].text, "第一轮回答。");
    assert.equal(messages[2].text, "段落A。\n\n段落B。", "同一消息多个 text part 用空行相接");
    assert.equal(messages[4].text, "最后一句。", "空文本 part 被过滤");
    const joined = messages.map((m) => m.text).join("\n");
    for (const banned of ["合成消息", "模型可见消息", "运行时环境消息", "部件级合成", "部件级模型可见", "部件级运行时消息", "工具调用", "思考过程"]) {
      assert.ok(joined.indexOf(banned) < 0, "不应出现: " + banned);
    }
  } finally {
    db.close();
  }
});

test("readTextMessages：role 缺省 assistant", async () => {
  const dbPath = await createFixtureDb();
  const db = await openDatabase(dbPath);
  try {
    // m2 的 role 是 assistant，但消息 data 没有 role 字段时应缺省 assistant
    // 在 fixture 里 m2 有 role=assistant，所以这里测的是 mdata.role 缺失的情况
    const DatabaseSync = (await sqliteModule()).DatabaseSync;
    const db2 = new DatabaseSync(dbPath);
    db2.exec("INSERT INTO message (id, session_id, data, sequence) VALUES ('no_role_msg', 'sess_main', '{}', 100)");
    db2.exec("INSERT INTO part (id, message_id, session_id, data, sequence) VALUES ('no_role_part', 'no_role_msg', 'sess_main', '{\"type\":\"text\",\"text\":\"无角色消息。\"}', 0)");
    const msgs = readTextMessages(db2, "sess_main");
    const last = msgs[msgs.length - 1];
    assert.equal(last.role, "assistant", "缺 role 应缺省 assistant");
    db2.close();
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------- 4. splitSentences

test("splitSentences：基本标点切分", () => {
  assert.deepEqual(splitSentences("你好。世界！测试？"), ["你好。", "世界！", "测试？"]);
  assert.deepEqual(splitSentences("测试……结束。好啊！！"), ["测试……", "结束。", "好啊！！"]);
  assert.deepEqual(splitSentences("第一段\n第二段"), ["第一段", "第二段"]);
});

test("splitSentences：超长二次切（逗号/空格）", () => {
  const hard = splitSentences("啊".repeat(350), 120);
  assert.deepEqual(hard.map((s) => s.length), [120, 120, 110]);
  const soft = splitSentences("甲，".repeat(80), 40);
  assert.deepEqual(soft.map((s) => s.length), [40, 40, 40, 40]);
});

test("splitSentences：REPEATABLE_ENDERS 不切", () => {
  assert.deepEqual(splitSentences("测试……结束。"), ["测试……", "结束。"]);
  assert.deepEqual(splitSentences("好啊！！"), ["好啊！！"]);
});

test("splitSentences：无空块 + limit 下限 20", () => {
  assert.deepEqual(splitSentences("\n\n  \n。；；"), ["。", "；", "；"]);
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences("   "), []);
  // limit 下限 20：传 5 也要按 20 切
  const s = splitSentences("啊".repeat(50), 5);
  assert.ok(s.length >= 2);
  for (const chunk of s) assert.ok(chunk.length > 0, "不应有空块");
});

// ---------------------------------------------------------------- 5. buildSpeechChunks

test("buildSpeechChunks：代码块替换成（代码略）", () => {
  const chunks = buildSpeechChunks(
    [
      { role: "user", text: "看代码：\n```js\nlet a=1;\n```\n结束。" },
      { role: "assistant", text: "回答一。回答二。" },
    ],
    120
  );
  assert.deepEqual(chunks, ["看代码：", "（代码略）", "结束。", "回答一。", "回答二。"]);
});

// ---------------------------------------------------------------- 6. resolveEdgeVoice

test("resolveEdgeVoice：短名→全名/全名透传/未知透传/空→默认/大小写", () => {
  assert.equal(resolveEdgeVoice("yunxi"), "zh-CN-YunxiNeural");
  assert.equal(resolveEdgeVoice("zh-CN-YunxiNeural"), "zh-CN-YunxiNeural");
  assert.equal(resolveEdgeVoice("nosuch"), "nosuch");
  assert.equal(resolveEdgeVoice(""), EDGE_DEFAULT_VOICE);
  assert.equal(resolveEdgeVoice(undefined), EDGE_DEFAULT_VOICE);
  assert.equal(resolveEdgeVoice("Yunyang"), "zh-CN-YunyangNeural");
  assert.equal(resolveEdgeVoice("xiaoxiao"), "zh-CN-XiaoxiaoNeural");
});

// ---------------------------------------------------------------- 7. edgeRateArg

test("edgeRateArg：-10→-50%、0→+0%、10→+50%、越界钳制、非数字→+0%", () => {
  assert.equal(edgeRateArg(-10), "-50%");
  assert.equal(edgeRateArg(0), "+0%");
  assert.equal(edgeRateArg(10), "+50%");
  assert.equal(edgeRateArg(99), "+50%");
  assert.equal(edgeRateArg(-99), "-50%");
  assert.equal(edgeRateArg(Number.NaN), "+0%");
  assert.equal(edgeRateArg(undefined), "+0%");
  assert.equal(edgeRateArg(1), "+5%");
  assert.equal(edgeRateArg(-1), "-5%");
});

// ---------------------------------------------------------------- 8. resolveSessionId

test("resolveSessionId：显式 id 透传 / 默认取最新主会话 / 排除子代理工作流前缀", async () => {
  const dbPath = await createFixtureDb();
  const db = await openDatabase(dbPath);
  try {
    assert.equal(resolveSessionId(db, "sess_subagent_abc"), "sess_subagent_abc", "显式 id 透传");
    assert.equal(resolveSessionId(db, undefined), "sess_main", "默认取最新主会话（排除子代理/工作流/已删除）");
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------- 常量断言

test("常量：SENTENCE_ENDERS / REPEATABLE_ENDERS 存在", () => {
  assert.ok(typeof SENTENCE_ENDERS === "string" && SENTENCE_ENDERS.length > 0);
  assert.ok(typeof REPEATABLE_ENDERS === "string" && REPEATABLE_ENDERS.length > 0);
});

test("常量：EDGE_ZH_VOICES 8 项", () => {
  assert.equal(EDGE_ZH_VOICES.length, 8);
});

test("常量：EDGE_MAX_CHUNK = 120", () => {
  assert.equal(EDGE_MAX_CHUNK, 120);
});

test("常量：EDGE_RATE_STEP = 5", () => {
  assert.equal(EDGE_RATE_STEP, 5);
});

test("常量：ROLE_LABELS 四角色", () => {
  assert.deepEqual(ROLE_LABELS, { user: "用户", assistant: "助手", system: "系统", tool: "工具" });
});

test("常量：CODE_PLACEHOLDER = （代码略）", () => {
  assert.equal(CODE_PLACEHOLDER, "（代码略）");
});

test("常量：SESSION_FILTER 排除子代理/工作流前缀", () => {
  assert.ok(SESSION_FILTER.indexOf("sess_subagent_") >= 0);
  assert.ok(SESSION_FILTER.indexOf("sess_dwf-") >= 0);
});

// ---------------------------------------------------------------- 小工具

test("parseJson：合法/非法", () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson("not json"), null);
  assert.equal(parseJson(""), null);
});

test("stripBom：有/无 BOM", () => {
  assert.equal(stripBom("\uFEFFhello"), "hello");
  assert.equal(stripBom("hello"), "hello");
});

test("roleLabel：四角色/未知/空", () => {
  assert.equal(roleLabel("user"), "用户");
  assert.equal(roleLabel("assistant"), "助手");
  assert.equal(roleLabel("system"), "系统");
  assert.equal(roleLabel("tool"), "工具");
  assert.equal(roleLabel("unknown"), "unknown");
  assert.equal(roleLabel(""), "文本");
  assert.equal(roleLabel(null), "文本");
});

test("mergeConsecutive：同角色合并/不同角色分开", () => {
  const msgs = [
    { role: "user", text: "一" },
    { role: "user", text: "二" },
    { role: "assistant", text: "三" },
  ];
  const merged = mergeConsecutive(msgs);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "一\n\n二");
  assert.equal(merged[1].text, "三");
});

test("replaceCodeBlocks：闭合/未闭合/无代码", () => {
  assert.equal(replaceCodeBlocks("前文\n```js\nlet a=1;\n```\n后文"), "前文\n（代码略）\n后文");
  assert.equal(replaceCodeBlocks("前文\n```js\n没闭合"), "前文\n（代码略）");
  assert.equal(replaceCodeBlocks("没有代码块"), "没有代码块");
});

test("defaultDbPath：返回 ~/.zcode/cli/db/db.sqlite 形态", () => {
  const p = defaultDbPath();
  assert.ok(p.indexOf(".zcode") >= 0);
  assert.ok(p.indexOf("db.sqlite") >= 0);
});
