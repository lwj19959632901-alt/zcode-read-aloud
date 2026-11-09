// read-aloud.test.mjs — node:test 单测（必须显式传文件路径：node --test read-aloud/read-aloud.test.mjs）
// 覆盖：dump 提取（排序/角色/代码略/--last/--max-chars/合成消息过滤/子代理会话过滤）、
//       句子分块器、widget 片段生成与转义、speak --dry-run 命令构造、
//       widget 交互冒烟（vm 沙箱 + fake DOM + fake speechSynthesis）。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildSapiScript,
  buildSpeechChunks,
  buildSpeakPlan,
  buildWidgetFragment,
  classifySapiCompletion,
  cleanupPlanDir,
  edgeRateArg,
  escapeHtml,
  extractMessages,
  findSessionsByText,
  formatDump,
  isEdgeUnavailable,
  isInterruptedResult,
  listEdgeVoices,
  mergeConsecutive,
  openDatabase,
  parseDump,
  parseEdgeVoiceTable,
  pickSapiVoice,
  playWav,
  PLAY_WAV_SCRIPT,
  printPlan,
  readTextMessages,
  readWavInfo,
  replaceCodeBlocks,
  resolveEdgeVoice,
  resolveSessionId,
  roleLabel,
  runMp3Plan,
  runSapi,
  splitSentences,
  WIDGET_ROOT_ID,
  WIDGET_SCRIPT,
} from "./read-aloud.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "read-aloud.mjs");
const TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "read-aloud-test-"));

function cleanup() {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 忽略临时目录清理失败 */
  }
}
process.on("exit", cleanup);

async function sqliteModule() {
  // node:sqlite 在 Node 22 仍是实验特性，加载即打 ExperimentalWarning；只针对 SQLite 静音
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
  // [messageId, sequence, role, extraMessageData, parts: [[partId, sequence, partData]]]
  ["m1", 0, "user", {}, [["p1a", 0, { type: "text", text: "第一轮提问。" }]]],
  [
    "m2",
    1,
    "assistant",
    {},
    [
      ["p2a", 2, { type: "tool", text: "工具调用，不应入朗读" }],
      ["p2b", 0, { type: "reasoning", text: "思考过程，不应入朗读" }],
      ["p2c", 1, { type: "text", text: "第一轮回答。" }],
    ],
  ],
  ["m3", 2, "user", { synthetic: true }, [["p3a", 0, { type: "text", text: "合成消息，不应入朗读。" }]]],
  [
    "m4",
    3,
    "user",
    { metadata: { visibility: "model-only" } },
    [["p4a", 0, { type: "text", text: "模型可见消息，不应入朗读。" }]],
  ],
  [
    "m5",
    4,
    "user",
    { metadata: { runtimeMessage: { source: "environment" } } },
    [["p5a", 0, { type: "text", text: "运行时环境消息，不应入朗读。" }]],
  ],
  [
    "m6",
    5,
    "assistant",
    {},
    [["p6a", 0, { type: "text", text: "部件级合成，不应入朗读。", synthetic: true }]],
  ],
  [
    "m7",
    6,
    "assistant",
    {},
    [
      ["p7b", 1, { type: "text", text: "段落B。" }],
      ["p7a", 0, { type: "text", text: "段落A。" }],
      ["p7c", 2, { type: "text", text: "   " }],
    ],
  ],
  [
    "m8",
    7,
    "user",
    {},
    [["p8a", 0, { type: "text", text: "看代码：\n```js\nconst a = 1;\n```\n结束。" }]],
  ],
  [
    "m9",
    8,
    "assistant",
    {},
    [
      ["p9a", 0, { type: "text", text: "" }],
      ["p9b", 1, { type: "text", text: "最后一句。" }],
    ],
  ],
  // part 级合成标记：消息本身不带任何 synthetic 标记，但 text part 的 metadata 命中过滤条件
  [
    "m10",
    9,
    "user",
    {},
    [["p10a", 0, { type: "text", text: "部件级模型可见，不应入朗读。", metadata: { visibility: "model-only" } }]],
  ],
  [
    "m11",
    10,
    "user",
    {},
    [["p11a", 0, { type: "text", text: "部件级运行时消息，不应入朗读。", metadata: { runtimeMessage: { source: "environment" } } }]],
  ],
  // 宿主注入的合成块（role=user/type=text，但带合成标记）：真实用户消息长这样，
  // 指纹匹配必须把它们排除，否则会出现伪多命中，甚至「唯一命中且静默取错会话」。
  ["m12", 11, "user", { synthetic: true }, [["p12a", 0, { type: "text", text: "宿主合成注入指纹甲。" }]]],
  [
    "m13",
    12,
    "user",
    {},
    [["p13a", 0, { type: "text", text: "宿主部件注入指纹乙。", metadata: { visibility: "model-only" } }]],
  ],
  [
    "m14",
    13,
    "user",
    {},
    [["p14a", 0, { type: "text", text: "宿主运行时注入指纹丙。", metadata: { runtimeMessage: { source: "tool_search_announcement" } } }]],
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
  // sess_subagent_* / sess_dwf-* 时间更新更近，但默认会话必须跳过它们
  insertSession.run("sess_subagent_abc", "子代理会话", 9000, null);
  insertSession.run("sess_dwf-xyz", "工作流会话", 8000, null);
  insertSession.run("sess_deleted", "已删除会话", 9500, 1);
  insertSession.run("sess_main", "主会话", 3000, null);
  // 连续同角色消息：用来钉死 --last 按「消息」计、不按「并块后」计
  insertSession.run("sess_consecutive", "连续同角色会话", 2000, null);
  // 两个都含同一段指纹文本的主会话：用来钉死「多命中必须报错并列候选」，绝不静默取第一个
  insertSession.run("sess_dup_a", "重复指纹会话甲", 2500, null);
  insertSession.run("sess_dup_b", "重复指纹会话乙", 2400, null);
  // 更旧的主会话（用户消息）：证明指纹搜索会扫到候选集里的较早会话，不只扫最新那个
  insertSession.run("sess_older_user", "较早的用户消息会话", 1500, null);

  const insertMessage = db.prepare("INSERT INTO message (id, session_id, data, sequence) VALUES (?, ?, ?, ?)");
  const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, data, sequence) VALUES (?, ?, ?, ?, ?)");
  for (const target of ["sess_main", "sess_subagent_abc"]) {
    for (const [messageId, sequence, role, extra, parts] of FIXTURE_MESSAGES) {
      const data = Object.assign({ role: role }, extra);
      insertMessage.run(messageId + "_" + target, target, JSON.stringify(data), sequence);
      for (const [partId, partSequence, partData] of parts) {
        insertPart.run(partId + "_" + target, messageId + "_" + target, target, JSON.stringify(partData), partSequence);
      }
    }
  }
  for (let i = 1; i <= 5; i++) {
    const messageId = "c" + i;
    insertMessage.run(messageId, "sess_consecutive", JSON.stringify({ role: "assistant" }), i - 1);
    insertPart.run("cp" + i, messageId, "sess_consecutive", JSON.stringify({ type: "text", text: "连续助手消息" + i + "。" }), 0);
  }
  // 指纹定位用的共享文本：sess_dup_a / sess_dup_b 各一条，另在 sess_dup_a 里塞一条
  // reasoning part 复述同一段文字——只有 text part 才算命中（reasoning 不算）。
  for (const target of ["sess_dup_a", "sess_dup_b"]) {
    insertMessage.run("dup_msg_" + target, target, JSON.stringify({ role: "user" }), 0);
    insertPart.run(
      "dup_part_" + target,
      "dup_msg_" + target,
      target,
      JSON.stringify({ type: "text", text: "共享指纹文本，用于多命中测试。" }),
      0
    );
  }
  insertMessage.run("dup_msg_reasoning", "sess_dup_a", JSON.stringify({ role: "assistant" }), 1);
  insertPart.run(
    "dup_part_reasoning",
    "dup_msg_reasoning",
    "sess_dup_a",
    JSON.stringify({ type: "reasoning", text: "共享指纹文本，用于多命中测试。" }),
    0
  );
  // 更旧会话里的真实用户消息：证明搜索覆盖候选集里的较早会话
  insertMessage.run("older_msg", "sess_older_user", JSON.stringify({ role: "user" }), 0);
  insertPart.run(
    "older_part",
    "older_msg",
    "sess_older_user",
    JSON.stringify({ type: "text", text: "较早会话的用户消息指纹。" }),
    0
  );
  } catch (err) {
    db.close();
    throw err;
  }
  db.close();
  return dbPath;
}

// ---------------------------------------------------------------- 1. dump 提取

test("dump：默认会话排除子代理/工作流/已删除前缀", async () => {
  const dbPath = await createFixtureDb();
  const db = await openDatabase(dbPath);
  try {
    assert.equal(resolveSessionId(db, undefined), "sess_main");
    assert.equal(resolveSessionId(db, "sess_subagent_abc"), "sess_subagent_abc");
  } finally {
    db.close();
  }
});

test("dump：合成消息全部被过滤，只剩真实对话", async () => {
  const dbPath = await createFixtureDb();
  const db = await openDatabase(dbPath);
  try {
    const messages = extractMessages(db, "sess_main");
    // m2 与 m7 同为 assistant 且相邻 → 合并为一个展示块
    assert.equal(messages.length, 4, "应得 4 个真实消息块（消息级与部件级合成记录共 6 条被过滤）");
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "user", "assistant"]
    );
    assert.equal(messages[0].text, "第一轮提问。");
    assert.equal(messages[1].text, "第一轮回答。\n\n段落A。\n\n段落B。");
    // part.sequence 乱序插入，输出必须按 sequence 升序
    assert.equal(messages[3].text, "最后一句。");
    const joined = messages.map((m) => m.text).join("\n");
    for (const banned of [
      "合成消息",
      "模型可见消息",
      "运行时环境消息",
      "部件级合成",
      "部件级模型可见",
      "部件级运行时消息",
      "工具调用",
      "思考过程",
    ]) {
      assert.ok(joined.indexOf(banned) < 0, "不应出现: " + banned);
    }
    // 并块前的逐条消息：m1/m2/m7/m8/m9 共 5 条（同角色相邻不并）
    const raw = readTextMessages(db, "sess_main");
    assert.equal(raw.length, 5, "并块前应得 5 条真实消息");
    assert.equal(raw[1].text, "第一轮回答。");
    assert.equal(raw[2].text, "段落A。\n\n段落B。", "同一消息的多个 text part 用空行相接");
    assert.deepEqual(mergeConsecutive(raw).length, 4, "并块后 4 块");
  } finally {
    db.close();
  }
});

test("dump：part 级合成标记（消息本身非 synthetic）也被过滤", async () => {
  const dbPath = await createFixtureDb();
  const db = await openDatabase(dbPath);
  try {
    // m10/m11 的 message.data 完全干净，但 text part 的 metadata 命中
    // model-only / runtimeMessage.source —— isSyntheticRecord 必须对 part.data 同样生效
    const raw = readTextMessages(db, "sess_main");
    assert.equal(raw.length, 5, "part 级合成标记的两条消息不得进入朗读列表");
    const joined = raw.map((m) => m.text).join("\n");
    for (const banned of ["部件级模型可见", "部件级运行时消息"]) {
      assert.ok(joined.indexOf(banned) < 0, "不应出现: " + banned);
    }
  } finally {
    db.close();
  }
  const cli = spawnSync(process.execPath, [CLI, "dump", "--db", dbPath], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(cli.stdout.indexOf("部件级模型可见") < 0, "CLI 输出不应含 part 级 model-only 正文");
  assert.ok(cli.stdout.indexOf("部件级运行时消息") < 0, "CLI 输出不应含 part 级 runtimeMessage 正文");
});

test("dump：--last N 按消息计（不是按并块后的块计）", async () => {
  const dbPath = await createFixtureDb();
  const cli = [CLI, "dump", "--db", dbPath, "--session", "sess_consecutive"];

  const db = await openDatabase(dbPath);
  let rawCount = 0;
  try {
    rawCount = readTextMessages(db, "sess_consecutive").length;
  } finally {
    db.close();
  }
  assert.equal(rawCount, 5, "fixture 应有 5 条连续同角色消息");

  // 不带 --last：5 条同角色消息并成 1 个展示块
  const all = spawnSync(process.execPath, cli, { encoding: "utf8" });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stderr, /消息 5\/5 条（并块后 1 块）/);
  for (let i = 1; i <= 5; i++) assert.ok(all.stdout.indexOf("连续助手消息" + i + "。") >= 0, "全量应含消息 " + i);

  // --last 2：只含最后 2 条消息的文本（并块后仍只有 1 块，若按块切就会返回全量）
  const last2 = spawnSync(process.execPath, cli.concat(["--last", "2"]), { encoding: "utf8" });
  assert.equal(last2.status, 0, last2.stderr);
  assert.match(last2.stderr, /消息 2\/5 条（并块后 1 块）/);
  assert.ok(last2.stdout.indexOf("连续助手消息4。") >= 0, "应含倒数第 2 条消息");
  assert.ok(last2.stdout.indexOf("连续助手消息5。") >= 0, "应含最后 1 条消息");
  for (const banned of ["连续助手消息1。", "连续助手消息2。", "连续助手消息3。"]) {
    assert.ok(last2.stdout.indexOf(banned) < 0, "--last 2 不应包含: " + banned);
  }

  // --last 超过总数时取全部，不报错
  const last99 = spawnSync(process.execPath, cli.concat(["--last", "99"]), { encoding: "utf8" });
  assert.equal(last99.status, 0, last99.stderr);
  assert.match(last99.stderr, /消息 5\/5 条（并块后 1 块）/);

  // --last 0 / 非整数：拒绝
  const zero = spawnSync(process.execPath, cli.concat(["--last", "0"]), { encoding: "utf8" });
  assert.notEqual(zero.status, 0);
  assert.match(zero.stderr, /--last 需要正整数/);
});

test("dump：代码块替换为占位符，未闭合围栏也替换", () => {
  assert.equal(replaceCodeBlocks("前文\n```js\nlet a=1;\n```\n后文"), "前文\n（代码略）\n后文");
  assert.equal(replaceCodeBlocks("前文\n```js\n没闭合"), "前文\n（代码略）");
  assert.equal(replaceCodeBlocks("没有代码块"), "没有代码块");
});

test("dump：formatDump/parseDump 往返无损（含正文伪装角色标记）", () => {
  const messages = [
    { role: "user", text: "第一行\n第二行" },
    { role: "assistant", text: "【用户】这是正文里的伪装标记" },
  ];
  const round = parseDump(formatDump(messages));
  assert.equal(round.length, 2);
  assert.deepEqual(round[0], { role: "user", text: "第一行\n第二行" });
  assert.deepEqual(round[1], { role: "assistant", text: "【用户】这是正文里的伪装标记" });
  assert.equal(parseDump("纯文本，没有角色标记。").length, 1);
});

test("dump：CLI --last / --max-chars / 默认会话", async () => {
  const dbPath = await createFixtureDb();
  const cli = [CLI, "dump", "--db", dbPath];

  const last2 = spawnSync(process.execPath, cli.concat(["--last", "2"]), { encoding: "utf8" });
  assert.equal(last2.status, 0, last2.stderr);
  assert.match(last2.stdout, /【用户】看代码/);
  assert.match(last2.stdout, /【助手】最后一句。/);
  assert.ok(last2.stdout.indexOf("第一轮提问") < 0, "--last 2 不应包含更早的消息");

  const capped = spawnSync(process.execPath, cli.concat(["--max-chars", "40"]), { encoding: "utf8" });
  assert.equal(capped.status, 0, capped.stderr);
  // 截断说明只进 stderr 摘要，不得混进正文——否则 widget/speak 会把它当正文念出来
  assert.doesNotMatch(capped.stdout, /max-chars/);
  assert.match(capped.stderr, /已按 --max-chars 40 截断/);
  assert.ok(capped.stdout.length < 200, "截断后应很短");

  const all = spawnSync(process.execPath, cli, { encoding: "utf8" });
  assert.equal(all.status, 0, all.stderr);
  for (const banned of ["合成消息", "模型可见消息", "运行时环境消息", "部件级合成", "部件级模型可见", "部件级运行时消息"]) {
    assert.ok(all.stdout.indexOf(banned) < 0, "不应出现: " + banned);
  }
  assert.match(all.stdout, /（代码略）/);
  assert.match(all.stdout, /【用户】/);
  assert.match(all.stdout, /【助手】/);

  const out = path.join(TMP, "nested", "ctx.txt");
  const toFile = spawnSync(process.execPath, cli.concat(["--out", out]), { encoding: "utf8" });
  assert.equal(toFile.status, 0, toFile.stderr);
  assert.ok(fs.existsSync(out), "--out 应落盘");
  assert.equal(fs.readFileSync(out, "utf8").indexOf("第一轮提问。") >= 0, true);
});

test("dump：--session 显式指定时可读子代理会话（过滤只作用于默认解析）", async () => {
  const dbPath = await createFixtureDb();
  const result = spawnSync(process.execPath, [CLI, "dump", "--db", dbPath, "--session", "sess_subagent_abc"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /【用户】第一轮提问。/);
  const def = spawnSync(process.execPath, [CLI, "dump", "--db", dbPath], { encoding: "utf8" });
  assert.equal(def.status, 0, def.stderr);
  assert.match(def.stdout, /【用户】第一轮提问。/);
  assert.equal(def.stderr.indexOf("sess_main") >= 0, true, "默认会话应为 sess_main");
});

// ---------------------------------------------------------------- 2. 会话指纹定位

test("dump：--session-by-text 唯一命中选中正确会话（且与 --session 互斥）", async () => {
  const dbPath = await createFixtureDb();
  const db = await openDatabase(dbPath);
  try {
    const hits = findSessionsByText(db, "第一轮提问。", 10);
    assert.equal(hits.length, 1, "指纹应只命中 sess_main");
    assert.equal(hits[0].id, "sess_main");
    // 指纹命中不等于「最近更新的会话」：更旧会话里的真实用户消息也必须能被搜到
    const older = findSessionsByText(db, "较早会话的用户消息指纹。", 10);
    assert.equal(older.length, 1);
    assert.equal(older[0].id, "sess_older_user");
    // 命中判定必须是「真实用户消息」：助手消息不算命中
    assert.equal(findSessionsByText(db, "连续助手消息3。", 10).length, 0, "助手消息不参与匹配");
    // 宿主注入的合成块（role=user/type=text 但带合成标记）不参与匹配：
    // 不滤会伪多命中；更危险的是「唯一命中且静默取错会话」。
    assert.equal(findSessionsByText(db, "宿主合成注入指纹甲。", 10).length, 0, "消息级合成注入不参与匹配");
    assert.equal(findSessionsByText(db, "宿主部件注入指纹乙。", 10).length, 0, "part 级 model-only 不参与匹配");
    assert.equal(
      findSessionsByText(db, "宿主运行时注入指纹丙。", 10).length,
      0,
      "part 级 runtimeMessage 不参与匹配"
    );
  } finally {
    db.close();
  }

  const cli = spawnSync(process.execPath, [CLI, "dump", "--db", dbPath, "--session-by-text", "第一轮提问。"], {
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /【用户】第一轮提问。/);
  assert.match(cli.stderr, /sess_main/, "摘要里应报出解析到的会话 id");

  // 与 --session 互斥：两个都给必须报错，不许静默取其中一个
  const both = spawnSync(
    process.execPath,
    [CLI, "dump", "--db", dbPath, "--session", "sess_main", "--session-by-text", "第一轮提问。"],
    { encoding: "utf8" }
  );
  assert.notEqual(both.status, 0, "--session 与 --session-by-text 同时给必须非 0 退出");
  assert.match(both.stderr, /互斥/);
});

test("dump：--session-by-text 零命中报错（指纹未命中任何会话，含合成注入文本）", async () => {
  const dbPath = await createFixtureDb();
  for (const fingerprint of ["绝对不会出现在任何会话里的指纹串", "宿主合成注入指纹甲。"]) {
    const cli = spawnSync(process.execPath, [CLI, "dump", "--db", dbPath, "--session-by-text", fingerprint], {
      encoding: "utf8",
    });
    assert.notEqual(cli.status, 0, "零命中必须非 0 退出: " + fingerprint);
    assert.match(cli.stderr, /指纹未命中任何会话/);
    assert.equal(cli.stdout.trim(), "", "零命中不得输出正文");
  }
  // 空指纹与「值缺」同样走退出码 2（与其余错误路径一致）
  const empty = spawnSync(process.execPath, [CLI, "dump", "--db", dbPath, "--session-by-text", ""], {
    encoding: "utf8",
  });
  assert.equal(empty.status, 2, "空指纹应退出码 2");
  assert.match(empty.stderr, /需要非空的指纹文本/);
  const missing = spawnSync(process.execPath, [CLI, "dump", "--db", dbPath, "--session-by-text"], {
    encoding: "utf8",
  });
  assert.equal(missing.status, 2, "缺值应退出码 2");
  assert.match(missing.stderr, /--session-by-text 需要一个值/);
});

test("dump：--session-by-text 多命中报错并列候选（绝不静默取第一个）", async () => {
  const dbPath = await createFixtureDb();
  const cli = spawnSync(process.execPath, [CLI, "dump", "--db", dbPath, "--session-by-text", "共享指纹文本"], {
    encoding: "utf8",
  });
  assert.notEqual(cli.status, 0, "多命中必须非 0 退出");
  assert.match(cli.stderr, /命中多个会话/);
  assert.match(cli.stderr, /sess_dup_a/);
  assert.match(cli.stderr, /sess_dup_b/);
  assert.match(cli.stderr, /重复指纹会话甲/);
  assert.match(cli.stderr, /重复指纹会话乙/);
  assert.match(cli.stderr, /--session/, "必须提示用 --session 明确指定");
  assert.equal(cli.stdout.trim(), "", "多命中不得输出正文");
});

test("sessions：输出为「时间 / 会话 id / 标题」三列，候选信息完整", async () => {
  const dbPath = await createFixtureDb();
  const cli = spawnSync(process.execPath, [CLI, "sessions", "--db", dbPath, "--last", "10"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const lines = cli.stdout.split(/\r?\n/).filter((line) => line.trim());
  assert.match(lines[0], /最近会话/);
  assert.match(lines[0], /sess_subagent_\* \/ sess_dwf-\*/);
  const row = lines.find((line) => line.indexOf("sess_main") >= 0);
  assert.ok(row, "应列出 sess_main");
  // 格式：两空格 + ISO 时间 + 两空格 + 会话 id + 两空格 + 标题（与多命中候选列表同一格式）
  assert.match(row, /^\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+sess_main\s+\S/);
  assert.ok(row.indexOf("主会话") >= 0, "行内应含标题");
  // 子代理 / 工作流 / 已删除会话都不该出现
  assert.ok(cli.stdout.indexOf("sess_subagent_abc") < 0, "不得列出子代理会话");
  assert.ok(cli.stdout.indexOf("sess_dwf-xyz") < 0, "不得列出工作流会话");
  assert.ok(cli.stdout.indexOf("sess_deleted") < 0, "不得列出已删除会话");
});

// ---------------------------------------------------------------- 3. 句子分块器

test("分块器：中文标点切分，标点保留在前块", () => {
  assert.deepEqual(splitSentences("你好。世界！测试？"), ["你好。", "世界！", "测试？"]);
  assert.deepEqual(splitSentences("测试……结束。好啊！！"), ["测试……", "结束。", "好啊！！"]);
  assert.deepEqual(splitSentences("第一段\n第二段"), ["第一段", "第二段"]);
});

test("分块器：超长二次切分且无空块", () => {
  const hard = splitSentences("啊".repeat(350), 120);
  assert.deepEqual(hard.map((s) => s.length), [120, 120, 110]);
  const soft = splitSentences("甲，".repeat(80), 40);
  assert.deepEqual(soft.map((s) => s.length), [40, 40, 40, 40]);
  assert.deepEqual(splitSentences("\n\n  \n。；；"), ["。", "；", "；"]);
  assert.deepEqual(splitSentences(""), []);
  assert.deepEqual(splitSentences("   "), []);
  for (const chunk of hard.concat(soft)) assert.ok(chunk.length > 0, "不应有空块");
});

test("分块器：buildSpeechChunks 跳过代码块正文并flatten所有消息", () => {
  const chunks = buildSpeechChunks(
    [
      { role: "user", text: "看代码：\n```js\nlet a=1;\n```\n结束。" },
      { role: "assistant", text: "回答一。回答二。" },
    ],
    120
  );
  assert.deepEqual(chunks, ["看代码：", "（代码略）", "结束。", "回答一。", "回答二。"]);
});

// ---------------------------------------------------------------- 4. widget 片段生成

function widgetHtml() {
  return buildWidgetFragment([
    { role: "user", text: "你好。<script>alert(\"x\")</script> & '引号' \"双引号\"" },
    { role: "assistant", text: "看代码：\n```js\nlet a=1;\n```\n好的。" },
  ]);
}

test("widget：HTML 转义（< > & 单双引号）", () => {
  const html = widgetHtml();
  assert.ok(html.indexOf("<script>alert") < 0, "正文里的 script 标签必须被转义");
  assert.ok(html.indexOf("&lt;script&gt;alert") >= 0);
  assert.ok(html.indexOf("&amp;") >= 0);
  assert.ok(html.indexOf("&#39;") >= 0);
  assert.ok(html.indexOf("&quot;") >= 0);
  assert.ok(html.indexOf("（代码略）") >= 0, "代码块应念占位符");
});

test("widget：片段硬约束（仅 fragment / 根 id / 无网络 API / <1MB / 主题变量 / lucide）", () => {
  const html = widgetHtml();
  assert.ok(html.indexOf("<!doctype") < 0 && html.indexOf("<html") < 0 && html.indexOf("<head") < 0 && html.indexOf("<body") < 0);
  assert.ok(html.indexOf('id="' + WIDGET_ROOT_ID + '"') >= 0, "根节点唯一 id");
  assert.equal((html.match(new RegExp('id="' + WIDGET_ROOT_ID + '"', "g")) || []).length, 1, "根 id 只能出现一次");
  assert.ok(WIDGET_SCRIPT.indexOf('document.getElementById("' + WIDGET_ROOT_ID + '")') < 0, "根节点由 HTML 里的 getElementById 选取，脚本内不重复取根");
  assert.ok(html.indexOf("currentScript") < 0, "不得用 currentScript 反推根节点");
  assert.ok(!/fetch/i.test(html), "不得出现 fetch");
  assert.ok(html.indexOf("XMLHttpRequest") < 0);
  assert.ok(html.indexOf("WebSocket") < 0);
  assert.ok(Buffer.byteLength(html, "utf8") < 1024 * 1024);
  assert.ok(html.indexOf("var(--accent)") >= 0 && html.indexOf("var(--muted-foreground)") >= 0, "必须用主题变量");
  assert.ok(html.indexOf('data-lucide="volume-2"') >= 0, "图标必须走 lucide data-lucide");
  assert.ok(html.indexOf("<svg") < 0, "不得手写内联 SVG 图标");
  assert.ok(html.indexOf('class="btn btn-primary btn-sm"') >= 0, "必须用宿主 utility 类");
  assert.ok(html.indexOf("max-height: 360px") >= 0, "transcript 容器限高 360px");
  assert.ok(WIDGET_SCRIPT.indexOf('scrollIntoView({ block: "nearest" })') >= 0);
  assert.ok(html.indexOf("window.zcode.setWidgetState") >= 0);
  assert.ok(html.indexOf("zcode:set_globals") >= 0);
  assert.ok(html.indexOf("window.zcode.widgetState") >= 0);
  assert.ok(WIDGET_SCRIPT.indexOf("${") < 0, "内联脚本不得残留模板占位符");
  assert.ok(!/requestAnimationFrame|matchMedia|rAF/i.test(html), "不得用未守卫的浏览器 API");
});

test("widget：内联 script 抽出后 node --check 通过，数据块可解析", () => {
  const html = widgetHtml();
  const matched = /<script>([\s\S]*?)<\/script>/.exec(html);
  assert.ok(matched, "应抽出内联脚本");
  const scriptFile = path.join(TMP, "widget-inline.mjs");
  fs.writeFileSync(scriptFile, matched[1], "utf8");
  const check = spawnSync(process.execPath, ["--check", scriptFile], { encoding: "utf8" });
  assert.equal(check.status, 0, "node --check 失败: " + check.stderr);

  const dataMatched = /<script type="application\/json" id="ra-data">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(dataMatched, "应有 JSON 数据块");
  const items = JSON.parse(dataMatched[1]);
  assert.ok(Array.isArray(items) && items.length >= 3);
  assert.equal(items[0].text, "你好。");
  assert.equal(items[1].text, '<script>alert("x")</script> & \'引号\' "双引号"');
  assert.equal(items[2].text, "看代码：");
  assert.equal(items[3].text, "（代码略）");
  assert.equal(items[4].text, "好的。");
  for (const item of items) assert.ok(item.text.length > 0);
  // 每个句子 span 与数据块一一对应
  assert.equal((html.match(/id="ra-sent-\d+"/g) || []).length, items.length);
});

test("widget：escapeHtml 单测", () => {
  assert.equal(escapeHtml('<a href="x">&\''), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(escapeHtml(null), "");
});

// ---------------------------------------------------------------- 5. speak --dry-run 命令构造

test("speak：PS 脚本分块清单必须用 @() 包裹（单元素数组会被 ConvertFrom-Json 摊平成标量）", () => {
  // 回归：ConvertFrom-Json 对单元素 JSON 数组会摊平成标量，$chunks[0] 只取到第一个字符，
  // 于是「只念一个字、退出码 0」——单块路径此前完全无自动化覆盖，bug 就这么溜过去的。
  const script = buildSapiScript();
  const jsonLines = script.split("\n").filter((line) => line.indexOf("ConvertFrom-Json") >= 0);
  assert.equal(jsonLines.length, 1, "PS 脚本里只应有一处 ConvertFrom-Json（分块清单解析）");
  for (const line of jsonLines) {
    assert.ok(line.indexOf("@(") >= 0, "ConvertFrom-Json 必须被 @() 包裹: " + line.trim());
    assert.ok(line.indexOf("@(Get-Content") >= 0, "包裹形态应为 @(Get-Content … | ConvertFrom-Json): " + line.trim());
  }
  assert.match(script, /@\(Get-Content -Raw -Encoding utf8 -LiteralPath \$ChunksFile \| ConvertFrom-Json\)/);
  // 分块索引访问依赖数组语义
  assert.match(script, /\$text = \[string\]\$chunks\[\$i\]/);
});

test("speak --dry-run：sapi 命令构造（PS7 全路径 + System.Speech + 分块文件）", () => {
  const plan = buildSpeakPlan("【用户】你好。世界。", { engine: "sapi", rate: 0, wav: path.join(TMP, "out.wav") });
  assert.equal(plan.engine, "sapi");
  assert.equal(plan.chunks.length, 2);
  assert.match(plan.command, /pwsh\.exe$/);
  assert.ok(plan.command.indexOf("PowerShell/7") >= 0);
  assert.ok(plan.args.indexOf("-ChunksFile") >= 0);
  assert.ok(plan.args.indexOf("-WavDir") >= 0);
  assert.equal(plan.rate, 0);
  const printed = printPlan(plan);
  assert.match(printed, /pwsh\.exe/);
  assert.match(printed, /System\.Speech/);
  assert.match(printed, /UTF-8 无 BOM/);
  assert.match(printed, /--wav/);
});

test("speak --dry-run：minimax 走 local-ai 入口且分块 ≤3000 字", () => {
  const long = "啊".repeat(5000);
  const plan = buildSpeakPlan("【用户】" + long, { engine: "minimax" });
  assert.equal(plan.engine, "minimax");
  assert.ok(plan.commands.length >= 2, "5000 字应切两块以上");
  for (const chunk of plan.chunks) assert.ok(chunk.length <= 3000, "minimax 分块不得超过 3000 字");
  assert.match(plan.commands[0].args[0], /llm\.mjs$/);
  assert.equal(plan.commands[0].args[1], "tts");
  assert.equal(plan.commands[0].args[3], "--out");
  assert.match(plan.commands[0].args[4], /part001\.mp3$/);
  const printed = printPlan(plan);
  assert.match(printed, /llm\.mjs/);
  assert.match(printed, /--out/);
  assert.match(printed, /≤3000/);
});

// ---------------------------------------------------------------- 5b. edge 引擎：音色/语速/产物路径

// 注入用的 spawn 桩：edge-tts 未安装（ENOENT）时 node 的 spawnSync 返回 { error, status: null }
function missingEdgeSpawn() {
  const spy = function (command) {
    if (command === "edge-tts") return { error: Object.assign(new Error("spawn edge-tts ENOENT"), { code: "ENOENT" }), status: null, signal: null };
    return { status: 0, stdout: "", stderr: "" };
  };
  return spy;
}

// edge 可用的 spawn 桩（只用于构造计划，不真跑）
function presentEdgeSpawn() {
  return function () {
    return { status: 0, stdout: "", stderr: "" };
  };
}

function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = function (chunk) {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { value: fn(), stderr: () => chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

test("edge：--rate 映射成 edge 的百分比参数（-10→-50%，0→+0%，10→+50%）", () => {
  assert.equal(edgeRateArg(-10), "-50%");
  assert.equal(edgeRateArg(-1), "-5%");
  assert.equal(edgeRateArg(0), "+0%");
  assert.equal(edgeRateArg(1), "+5%");
  assert.equal(edgeRateArg(10), "+50%");
  // 越界与非法值一律夹到合法区间，绝不产出裸数字（edge 只认带符号百分比）
  assert.equal(edgeRateArg(99), "+50%");
  assert.equal(edgeRateArg(-99), "-50%");
  assert.equal(edgeRateArg(Number.NaN), "+0%");
  assert.equal(edgeRateArg(undefined), "+0%");
});

test("edge：--voice 支持全名/短名/未知值，未给时用默认 Xiaoxiao", () => {
  assert.equal(resolveEdgeVoice(undefined), "zh-CN-XiaoxiaoNeural");
  assert.equal(resolveEdgeVoice(""), "zh-CN-XiaoxiaoNeural");
  assert.equal(resolveEdgeVoice("zh-CN-YunxiNeural"), "zh-CN-YunxiNeural");
  assert.equal(resolveEdgeVoice("yunxi"), "zh-CN-YunxiNeural");
  assert.equal(resolveEdgeVoice("xiaoxiao"), "zh-CN-XiaoxiaoNeural");
  assert.equal(resolveEdgeVoice("Yunyang"), "zh-CN-YunyangNeural");
  // 未知值原样透传，交给 edge-tts 自己报错，不静默换成默认音色
  assert.equal(resolveEdgeVoice("nosuch"), "nosuch");
});

test("speak --dry-run：edge 默认引擎带上 voice/rate/wav，产物路径按块号命名", () => {
  const plan = buildSpeakPlan("【用户】你好。世界。", { rate: 3, voice: "yunxi", wav: path.join(TMP, "edge-out.wav"), spawn: presentEdgeSpawn() });
  try {
    assert.equal(plan.engine, "edge", "未指定 --engine 时应默认 edge");
    assert.equal(plan.voice, "zh-CN-YunxiNeural");
    assert.equal(plan.rateArg, "+15%");
    assert.equal(plan.wav, path.join(TMP, "edge-out.wav"), "plan.wav 必须按 --wav 设置（否则主流程不出声也不落盘）");
    // 分块目录是本次运行的独占目录（mkdtemp，tmp 下 read-aloud-edge- 前缀，不随 --wav 漂移到别处）
    assert.ok(
      plan.dir.startsWith(path.join(fs.realpathSync(os.tmpdir()), "read-aloud-edge-")),
      "分块目录应是 tmp 下 read-aloud-edge- 前缀的独占子目录: " + plan.dir
    );
    assert.ok(fs.existsSync(plan.dir), "计划期独占目录必须已存在（dry-run 会原样打印它）");
    assert.equal(plan.ownsDir, true, "mkdtemp 目录必须带 ownsDir 标记（收尾清理依据）");
    assert.equal(plan.commands.length, 2);
    const args = plan.commands[0].args;
    assert.equal(args[0], "--text");
    assert.ok(args.indexOf("--voice") >= 0, "命令必须显式带音色");
    assert.equal(args[args.indexOf("--voice") + 1], "zh-CN-YunxiNeural");
    assert.ok(args.indexOf("--rate=+15%") >= 0, "语速必须用 edge 的 =百分比 形态");
    assert.ok(args.indexOf("--write-media") >= 0);
    assert.match(plan.commands[0].out, /part001\.mp3$/);
    assert.match(plan.commands[1].out, /part002\.mp3$/);
    assert.ok(plan.commands[0].out.indexOf(plan.dir) === 0, "产物必须落在 plan.dir 下");
    // 第二块的 out 与命令里 --write-media 的值必须一致（否则收不到产物）
    assert.equal(plan.commands[1].out, plan.commands[1].args[plan.commands[1].args.indexOf("--write-media") + 1]);
    const printed = printPlan(plan);
    assert.match(printed, /engine=edge/);
    assert.match(printed, /voice=zh-CN-YunxiNeural/);
    assert.match(printed, /--rate=\+15%/);
    assert.match(printed, /--wav/);
    assert.match(printed, /转 44\.1k 单声道 wav/);
    // dry-run 打印的目录必须与真实使用的目录一致（否则照着日志找产物会落空）
    assert.ok(printed.indexOf(plan.dir) >= 0, "dry-run 必须打印真实分块目录: " + plan.dir);
    // 无 --wav 时计划里要说清「会经 SoundPlayer 真出声」（不是只留 mp3 不出声）
    const playPlan = buildSpeakPlan("【用户】你好。", { rate: 0, spawn: presentEdgeSpawn() });
    try {
      assert.equal(playPlan.wav, null);
      assert.match(printPlan(playPlan), /SoundPlayer 直接发声/);
    } finally {
      cleanupPlanDir(playPlan);
    }
  } finally {
    cleanupPlanDir(plan);
  }
});

test("edge：分块目录按运行独占——两次计划不同目录、产物各归各、互不互踩", () => {
  const first = buildSpeakPlan("【用户】你好。世界。", { rate: 0, spawn: presentEdgeSpawn() });
  const second = buildSpeakPlan("【用户】你好。世界。", { rate: 0, spawn: presentEdgeSpawn() });
  try {
    const prefix = path.join(fs.realpathSync(os.tmpdir()), "read-aloud-edge-");
    assert.notEqual(first.dir, second.dir, "两次计划必须拿到不同目录（固定共享目录会让并发的两个 CLI 互踩 partNNN.mp3）");
    for (const plan of [first, second]) {
      assert.ok(plan.dir.startsWith(prefix), "独占目录应在 tmp 下且带 read-aloud-edge- 前缀: " + plan.dir);
      assert.ok(fs.existsSync(plan.dir), "计划期 mkdtemp 目录应已存在");
      assert.equal(plan.ownsDir, true, "mkdtemp 目录必须标记 ownsDir（收尾清理依据）");
      for (const command of plan.commands) {
        assert.ok(command.out.indexOf(plan.dir) === 0, "产物必须落在本计划自己的目录下: " + command.out);
      }
    }
    assert.notEqual(first.commands[0].out, second.commands[0].out, "同名 partNNN.mp3 也必须隔离在各自目录下");
  } finally {
    cleanupPlanDir(first);
    cleanupPlanDir(second);
  }
});

test("edge：cleanupPlanDir 只清 ownsDir 的目录，非自有目录一律不碰", () => {
  const owned = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "read-aloud-edge-"));
  const foreign = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "read-aloud-edge-foreign-"));
  try {
    fs.writeFileSync(path.join(owned, "part001.mp3"), "x", "utf8");
    assert.equal(cleanupPlanDir({ engine: "edge", dir: owned, ownsDir: true }), true, "owned 目录应被清理");
    assert.equal(fs.existsSync(owned), false, "owned 目录连同内部产物应一并清掉");
    // 非 owned（minimax 固定目录 / 用户 --wav 所在目录）：返回 false 且原样保留
    assert.equal(cleanupPlanDir({ engine: "minimax", dir: foreign, ownsDir: false }), false);
    assert.equal(fs.existsSync(foreign), true, "非 owned 目录必须原样保留");
    assert.equal(cleanupPlanDir(null), false);
    assert.equal(cleanupPlanDir({ engine: "edge", dir: owned, ownsDir: true }), true, "目录已不存在时 force 清理不算失败、不抛");
  } finally {
    try {
      fs.rmSync(foreign, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

test("edge：runMp3Plan 命令失败（抛错路径）也清掉独占分块目录", () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "read-aloud-edge-"));
  const plan = {
    engine: "edge",
    chunks: ["块"],
    dir: dir,
    ownsDir: true,
    voice: "test",
    // 不存在的命令：spawnSync 返回 error，runCommandList 对 edge 抛「启动失败」
    commands: [{ command: "read-aloud-no-such-edge-cmd-xyz", args: ["--write-media", path.join(dir, "part001.mp3")], out: path.join(dir, "part001.mp3") }],
  };
  assert.throws(() => runMp3Plan(plan), /启动失败|退出码/, "命令失败必须抛出（fail-closed 不变）");
  assert.equal(fs.existsSync(dir), false, "失败路径必须经 finally 清掉独占目录（成功失败都收尾）");
});

test("edge：isInterruptedResult 只把 SIGINT 与 STATUS_CONTROL_C_EXIT 认成中断", () => {
  assert.equal(isInterruptedResult({ status: null, signal: "SIGINT" }), true, "POSIX 信号终止");
  assert.equal(isInterruptedResult({ status: 3221225786, signal: null }), true, "Windows STATUS_CONTROL_C_EXIT");
  assert.equal(isInterruptedResult({ status: -1073741510, signal: null }), true, "同一状态码的有符号写法也要认");
  assert.equal(isInterruptedResult({ status: 0, signal: null }), false);
  assert.equal(isInterruptedResult({ status: 1, signal: null }), false, "普通失败码不是中断");
  assert.equal(isInterruptedResult({ status: 2, signal: null }), false);
  assert.equal(isInterruptedResult(null), false);
});

// ---------------------------------------------------------------- SIGINT 清理（真实信号）

// Windows 没有 POSIX 信号：child.kill("SIGINT") 在 win32 上等价 TerminateProcess，跑不到 JS
// handler。这里用 PS7 复刻终端 Ctrl+C——CREATE_NEW_CONSOLE 建子进程 → 附着到该控制台 →
// GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0)。CreateProcess 前先 SetConsoleCtrlHandler(NULL,FALSE)
// 恢复本进程的 Ctrl+C（否则子进程继承「忽略 Ctrl+C」后收不到事件）；事件发出前再 (NULL,TRUE)
// 保护 helper 自己不被同一次 Ctrl+C 带走。子进程正常退出码经 CHILD_EXITCODE 回传。
const SIGINT_SENDER_PS1 = `param([string]$NodeExe, [string]$Script, [string]$ScriptArg = "", [string]$ArgsFile = "", [string]$WorkDir, [string]$Marker, [int]$WaitMs = 8000)
$ErrorActionPreference = "Stop"
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SigIntSender {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize; public uint dwXCountChars;
    public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags; public ushort wShowWindow;
    public ushort cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PI { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessW(string app, string cmdline, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PI pi);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GenerateConsoleCtrlEvent(uint evt, uint group);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);
}
"@
[void][SigIntSender]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)
$si = New-Object SigIntSender+STARTUPINFO
$si.cb = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([Type][SigIntSender+STARTUPINFO])
$si.dwFlags = 1
$si.wShowWindow = 0
$pi = New-Object SigIntSender+PI
$cmdline = '"' + $NodeExe + '" "' + $Script + '"'
if ($ScriptArg -ne "") { $cmdline = $cmdline + ' "' + $ScriptArg + '"' }
if ($ArgsFile -ne "") {
  $argList = @(Get-Content -Raw -Encoding utf8 -LiteralPath $ArgsFile | ConvertFrom-Json)
  foreach ($a in $argList) { $cmdline = $cmdline + ' "' + [string]$a + '"' }
}
$ok = [SigIntSender]::CreateProcessW($NodeExe, $cmdline, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0x00000010, [IntPtr]::Zero, $WorkDir, [ref]$si, [ref]$pi)
if (-not $ok) { Write-Output ("CREATE_FAILED=" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()); exit 2 }
Write-Output ("CHILD_PID=" + $pi.dwProcessId)
$deadline = (Get-Date).AddMilliseconds($WaitMs)
while (-not (Test-Path -LiteralPath $Marker) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 25 }
if (-not (Test-Path -LiteralPath $Marker)) {
  [void][SigIntSender]::TerminateProcess($pi.hProcess, 1)
  Write-Output "MARKER_TIMEOUT"
  [void][SigIntSender]::CloseHandle($pi.hProcess); [void][SigIntSender]::CloseHandle($pi.hThread)
  exit 3
}
Start-Sleep -Milliseconds 150
[void][SigIntSender]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
[void][SigIntSender]::FreeConsole()
if (-not [SigIntSender]::AttachConsole($pi.dwProcessId)) {
  Write-Output ("ATTACH_FAILED=" + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
  [void][SigIntSender]::TerminateProcess($pi.hProcess, 1)
  [void][SigIntSender]::CloseHandle($pi.hProcess); [void][SigIntSender]::CloseHandle($pi.hThread)
  exit 4
}
$sent = [SigIntSender]::GenerateConsoleCtrlEvent(0, 0)
Write-Output ("CTRL_C_SENT=" + $sent)
$w = [SigIntSender]::WaitForSingleObject($pi.hProcess, $WaitMs)
$code = 0
[void][SigIntSender]::GetExitCodeProcess($pi.hProcess, [ref]$code)
Write-Output ("WAIT_RESULT=" + $w)
Write-Output ("CHILD_EXITCODE=" + $code)
if ($w -ne 0) { [void][SigIntSender]::TerminateProcess($pi.hProcess, 1) }
[void][SigIntSender]::CloseHandle($pi.hProcess); [void][SigIntSender]::CloseHandle($pi.hThread)
`;

function waitForPath(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(function (resolve) {
    (function poll() {
      if (fs.existsSync(file)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, 25);
    })();
  });
}

// 真 Ctrl+C 跑 CLI 的中继：把 CLI 的 stdout/stderr 同时写进日志文件（helper 用 CREATE_NEW_CONSOLE
// 建子进程，输出不进本进程的管道），再按 CLI 自己的退出码退出——等价于 shell 转交退出码。
// 注意 SIGINT 必须被吞掉：中继和 CLI 同属一个控制台，不吞就会被同一次 Ctrl+C 带走，丢掉日志。
const CTRL_C_RELAY_MJS = [
  'import fs from "node:fs";',
  'import { spawn } from "node:child_process";',
  "const [logPath, ...args] = process.argv.slice(2);",
  'const log = fs.openSync(logPath, "w");',
  'process.on("SIGINT", function () {});',
  'const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });',
  "child.stdout.on(\"data\", function (d) { fs.writeSync(log, d); });",
  "child.stderr.on(\"data\", function (d) { fs.writeSync(log, d); });",
  // 'close' 一定在 stdio 全关 + 进程退出之后触发（'exit' 可能早于管道读完，退出码还没到）
  'child.on("close", function (code, signal) {',
  "  fs.closeSync(log);",
  '  process.exit(code == null ? (signal === "SIGINT" ? 130 : 1) : code);',
  "});",
  "",
].join("\n");

// 真信号跑一次 CLI：等 helper 打印 CHILD_PID（子进程已创建）→ 可选等某个路径出现（如 --wav 的
// 分块目录，出现即说明探测已结束、合成已开始）→ 再等 delayMs 落 marker，helper 见到 marker 后
// 150ms 发 CTRL_C_EVENT。
function runCliWithRealCtrlC(cliArgs, options) {
  const opts = options || {};
  const delayMs = opts.delayMs == null ? 1300 : opts.delayMs;
  const waitMs = opts.waitMs == null ? 25000 : opts.waitMs;
  const until = opts.until || null;
  const seed = Date.now() + "-" + Math.random().toString(16).slice(2);
  const relay = path.join(TMP, "ctl-relay-" + seed + ".mjs");
  const logPath = relay + ".log";
  const argsFile = relay + ".args.json";
  const marker = relay + ".marker";
  const sender = path.join(TMP, "sigint-sender-cli.ps1");
  fs.writeFileSync(relay, CTRL_C_RELAY_MJS, "utf8");
  fs.writeFileSync(sender, SIGINT_SENDER_PS1, "utf8");
  fs.writeFileSync(argsFile, JSON.stringify([logPath].concat(cliArgs)), "utf8");
  const started = Date.now();
  return new Promise(function (resolve, reject) {
    const helper = spawn(
      "C:/Program Files/PowerShell/7/pwsh.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", sender, "-NodeExe", process.execPath, "-Script", relay, "-ArgsFile", argsFile, "-WorkDir", TMP, "-Marker", marker, "-WaitMs", String(waitMs)],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let markerScheduled = false;
    const guard = setTimeout(function () {
      try {
        helper.kill();
      } catch {
        /* 已退出 */
      }
      reject(new Error("真 Ctrl+C helper 超时（" + (waitMs + 30000) + "ms）：" + out));
    }, waitMs + 30000);
    function scheduleMarker() {
      if (markerScheduled) return;
      markerScheduled = true;
      setTimeout(function () {
        try {
          fs.writeFileSync(marker, "go", "utf8");
        } catch {
          /* helper 已退出 */
        }
      }, delayMs);
    }
    function waitForUntil(deadline) {
      if (!until || fs.existsSync(until)) return scheduleMarker();
      if (Date.now() >= deadline) return scheduleMarker(); // 超时也照发，让断言把问题暴露出来
      setTimeout(function () {
        waitForUntil(deadline);
      }, 20);
    }
    helper.stdout.on("data", function (d) {
      out += d.toString("utf8");
      if (markerScheduled || out.indexOf("CHILD_PID=") < 0) return;
      waitForUntil(Date.now() + 15000);
    });
    helper.stderr.on("data", function (d) {
      out += d.toString("utf8");
    });
    helper.on("close", function () {
      clearTimeout(guard);
      const codeMatch = /CHILD_EXITCODE=(\d+)/.exec(out);
      const waitMatch = /WAIT_RESULT=(\d+)/.exec(out);
      let log = "";
      try {
        log = fs.readFileSync(logPath, "utf8");
      } catch {
        /* CLI 没跑起来：日志不存在 */
      }
      resolve({
        exitCode: codeMatch ? Number(codeMatch[1]) : null,
        waitResult: waitMatch ? Number(waitMatch[1]) : null,
        log: log,
        helperOut: out,
        elapsedMs: Date.now() - started,
      });
    });
  });
}

test("edge：SIGINT 清理——子进程运行中收到真实 Ctrl+C 后独占目录不存在", async () => {
  const fixture = path.join(TMP, "sigint-fixture.mjs");
  const ownedMarker = path.join(TMP, "sigint-owned.txt");
  const startedMarker = ownedMarker + ".started";
  const cliUrl = pathToFileURL(CLI).href;
  fs.writeFileSync(
    fixture,
    [
      "import fs from \"node:fs\";",
      "import path from \"node:path\";",
      "import os from \"node:os\";",
      "const mod = await import(" + JSON.stringify(cliUrl) + ");",
      "const ownedMarker = process.argv[2];",
      "const startedMarker = ownedMarker + \".started\";",
      "const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), \"read-aloud-edge-\"));",
      "fs.writeFileSync(path.join(dir, \"part001.mp3\"), \"half\", \"utf8\");",
      "mod.installSigintCleanup();",
      "fs.writeFileSync(ownedMarker, dir, \"utf8\");",
      "try {",
      "  mod.runMp3Plan({",
      "    engine: \"edge\",",
      "    chunks: [\"x\"],",
      "    voice: \"test\",",
      "    dir: dir,",
      "    ownsDir: true,",
      "    commands: [{",
      "      command: process.execPath,",
      "      args: [\"-e\", \"require('fs').writeFileSync(process.argv[1], 'x'); setTimeout(function () {}, 30000)\", startedMarker],",
      "      out: path.join(dir, \"part002.mp3\"),",
      "    }],",
      "  });",
      "  process.stdout.write(\"fixture: completed\\n\");",
      "} catch (err) {",
      "  if (!(err && err.interrupted)) throw err;",
      "  fs.writeFileSync(ownedMarker + \".interrupted\", \"1\", \"utf8\");",
      "  process.stdout.write(\"speak: 已中断\\n\");",
      "}",
      // 与 CLI 入口一致：留一圈 0ms 定时器，让排队的 SIGINT 回调在自然退出前得到派发。
      "setTimeout(function () {}, 0);",
      "",
    ].join("\n"),
    "utf8"
  );

  let exitCode = null;
  if (process.platform === "win32") {
    const sender = path.join(TMP, "sigint-sender.ps1");
    fs.writeFileSync(sender, SIGINT_SENDER_PS1, "utf8");
    const result = spawnSync(
      "C:/Program Files/PowerShell/7/pwsh.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", sender, "-NodeExe", process.execPath, "-Script", fixture, "-ScriptArg", ownedMarker, "-WorkDir", TMP, "-Marker", startedMarker],
      { encoding: "utf8", timeout: 60000 }
    );
    assert.equal(result.status, 0, "真实 Ctrl+C helper 应正常结束：" + String(result.stdout || "") + String(result.stderr || ""));
    const match = /CHILD_EXITCODE=(\d+)/.exec(String(result.stdout || ""));
    assert.ok(match, "helper 输出里应有 CHILD_EXITCODE：" + String(result.stdout || ""));
    exitCode = Number(match[1]);
  } else {
    const child = spawn(process.execPath, [fixture, ownedMarker], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    try {
      assert.ok(await waitForPath(startedMarker, 10000), "慢命令应在超时前启动");
      process.kill(-child.pid, "SIGINT"); // 负 pid：整个前台进程组，等价终端 Ctrl+C
      exitCode = await new Promise(function (resolve) {
        child.on("exit", function (code, signal) {
          resolve(code == null ? signal : code);
        });
      });
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        /* 已退出 */
      }
    }
  }

  assert.equal(exitCode, 130, "SIGINT 应按 130 退出（128+SIGINT），实际 " + exitCode);
  assert.equal(fs.existsSync(ownedMarker + ".interrupted"), true, "必须是 interrupted 路径（不得回落/崩成其它错误）");
  const ownedDir = fs.readFileSync(ownedMarker, "utf8");
  assert.ok(ownedDir.indexOf("read-aloud-edge-") >= 0, "标记文件应记录本计划的独占目录");
  assert.equal(fs.existsSync(ownedDir), false, "Ctrl+C 后独占目录（含半截分块）必须不存在: " + ownedDir);
});


test("speak：默认引擎 edge 不可用（ENOENT）时回落 sapi 并在 stderr 提示", () => {
  const outcome = captureStderr(() => buildSpeakPlan("【用户】你好。", { rate: 0, spawn: missingEdgeSpawn() }));
  assert.equal(outcome.value.engine, "sapi", "edge 不可用时应回落离线 sapi");
  assert.match(outcome.stderr(), /edge 不可用/);
  assert.match(outcome.stderr(), /已回落离线 sapi/);
  // 显式 --engine edge 不回落（点名要神经音色，不能偷偷降级成机械音）
  assert.throws(
    () => buildSpeakPlan("【用户】你好。", { engine: "edge", rate: 0, spawn: missingEdgeSpawn() }),
    /未检测到 edge-tts/
  );
  // 显式 --engine sapi 根本不探测 edge，也就不可能有回落提示
  const sapi = captureStderr(() => buildSpeakPlan("【用户】你好。", { engine: "sapi", rate: 0 }));
  assert.equal(sapi.value.engine, "sapi");
  assert.ok(sapi.stderr().indexOf("回落") < 0, "显式 sapi 不应出现回落提示");
});

test("speak：非 edge 可用性错误不触发回落（fail-closed 不被放宽成 fail-open）", () => {
  // 未知引擎仍是硬错误
  assert.throws(() => buildSpeakPlan("【用户】你好。", { engine: "nope", spawn: missingEdgeSpawn() }), /未知引擎/);
  // minimax 入口缺失也是硬错误（与 edge 无关，不受回落影响）
  assert.throws(() => buildSpeakPlan("【用户】你好。", { engine: "minimax", llm: path.join(TMP, "no-such-llm.mjs") }), /找不到 local-ai 入口/);
  // 只有带 engineUnavailable 标记的错误才被认定为「引擎可用性/网络」问题
  assert.equal(isEdgeUnavailable(new Error("任意错误")), false);
  assert.equal(isEdgeUnavailable(null), false);
});

test("edge：--list-voices 解析只留 zh-CN，并认出默认/推荐音色", () => {
  assert.equal(listEdgeVoices(missingEdgeSpawn()), null, "edge 不可用时应返回 null 而不是抛错");
  const table = [
    "Name                               Gender    ContentCategories      VoicePersonalities",
    "---------------------------------  --------  ---------------------  --------------------------------------",
    "en-US-AriaNeural                   Female    News, Novel            Positive, Confident",
    "zh-CN-XiaoxiaoNeural               Female    News, Novel            Warm",
    "zh-CN-YunxiNeural                  Male      Novel                  Lively, Sunshine",
    "zh-CN-liaoning-XiaobeiNeural       Female    Dialect                Humorous",
  ].join("\n");
  const parsed = parseEdgeVoiceTable(table);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { name: "zh-CN-XiaoxiaoNeural", gender: "Female", personalities: "Warm" });
  assert.equal(parsed[1].name, "zh-CN-YunxiNeural");
  assert.equal(parsed[2].name, "zh-CN-liaoning-XiaobeiNeural");
  // 非 zh-CN 行一条都不留
  assert.ok(parsed.every((voice) => voice.name.indexOf("zh-CN-") === 0));
});

test("speak：playWav 的 spawn 失败 fail-closed（不把「没出声」报成播放完成）", () => {
  // 播放走 PS7 + System.Media.SoundPlayer（只吃 wav）；PS7 缺失时 status 为 null，
  // 不查 error 就会被当成"播完了"。与 runSapi 同款 fail-closed 写法。
  const wav = path.join(TMP, "play.wav");
  fs.writeFileSync(wav, makeWavBytes(8820, 44100, 8820));
  assert.throws(() => playWav(wav, () => ({ error: new Error("spawn ENOENT"), status: null, signal: null })), /无法启动 PowerShell 7 播放/);
  // 正常路径：spawn 收到 PS7 全路径 + -File 播放脚本 + -Path wav
  const calls = [];
  const ok = playWav(wav, (command, args) => {
    calls.push({ command: command, args: args });
    return { status: 0, signal: null };
  });
  assert.equal(ok.status, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0].command, /PowerShell\/7\/pwsh\.exe$/);
  assert.ok(calls[0].args.indexOf("-File") >= 0);
  assert.equal(calls[0].args[calls[0].args.indexOf("-Path") + 1], wav);
  // 播放脚本必须用 PlaySync（异步 Play 会让进程立刻退出）并释放句柄
  assert.match(PLAY_WAV_SCRIPT, /PlaySync\(\)/);
  assert.match(PLAY_WAV_SCRIPT, /System\.Media\.SoundPlayer/);
  assert.match(PLAY_WAV_SCRIPT, /Dispose\(\)/);
});

test("speak：拒绝未知引擎与空文本", () => {
  assert.throws(() => buildSpeakPlan("【用户】你好。", { engine: "nope" }), /未知引擎/);
  assert.throws(() => buildSpeakPlan("   ", { engine: "sapi" }), /没有可朗读内容/);
});

test("speak：spawnSync 失败（如 PS7 缺失）时 fail-closed，不把 FAIL 报成 PASS", () => {
  // 依赖注入：runSapi(plan, spawn) 的第二参可替换 spawnSync，测试不真调 PS7。
  // PS7 不在硬编码路径时 result.error 有值、status 为 null——不检查 error 就会被判成"干净结束"。
  const plan = buildSpeakPlan("【用户】你好。", { engine: "sapi", rate: 0 });
  assert.equal(plan.engine, "sapi");
  assert.throws(
    () => runSapi(plan, () => ({ error: new Error("spawn ENOENT"), status: null, signal: null })),
    /无法启动 PowerShell 7/
  );
  // --wav 模式同样 fail-closed（不落入"没有完整的分块 wav 可合并"的次要分支），且不产出 wav
  const wavPath = path.join(TMP, "never.wav");
  const wavPlan = buildSpeakPlan("【用户】你好。", { engine: "sapi", rate: 0, wav: wavPath });
  assert.throws(
    () => runSapi(wavPlan, () => ({ error: new Error("spawn ENOENT"), status: null, signal: null })),
    /无法启动 PowerShell 7/
  );
  assert.ok(!fs.existsSync(wavPath), "spawn 失败路径不得产出 wav");
});

test("sapi：--wav 被 Ctrl+C 打断按中断返回（不是「没有完整的分块 wav 可合并」），并回收本次新建的分块目录", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "sapi-int-"));
  const wavPath = path.join(dir, "out.wav");
  const plan = buildSpeakPlan("【用户】你好。世界。", { engine: "sapi", rate: 0, wav: wavPath });
  const calls = [];
  const outcome = runSapi(plan, (command, args) => {
    calls.push(command);
    assert.equal(command, plan.command, "中断后不得继续调用 ffmpeg");
    // 模拟 PowerShell 已写出一块完成分块后被打断（分块目录里留下半成品）
    const wavDir = args[args.indexOf("-WavDir") + 1];
    fs.mkdirSync(wavDir, { recursive: true });
    fs.writeFileSync(path.join(wavDir, "chunk_001.wav"), makeWavBytes(8820, 44100, 8820));
    return { status: 3221225786, signal: null };
  });
  assert.deepEqual(outcome, { interrupted: true, status: 3221225786 }, "STATUS_CONTROL_C_EXIT 必须走 isInterruptedResult 的中断分支");
  assert.deepEqual(calls, [plan.command], "中断即返回，不合并半截分块");
  assert.equal(fs.existsSync(plan.wavDir), false, "中断后本次新建的分块目录必须回收（不留残留目录）");
  assert.equal(fs.existsSync(wavPath), false, "中断不得产出目标 wav");
});

test("sapi：非中断的非零退出是失败，不冒充「已中断」（isInterruptedResult 是唯一中断判据）", () => {
  const plan = buildSpeakPlan("【用户】你好。", { engine: "sapi", rate: 0 });
  assert.throws(() => runSapi(plan, () => ({ status: 1, signal: null })), /朗读未正常完成/);
});

// 阻断级回归（2026-11-10 终验收复核）：PS7 用 -File 跑脚本、被 Ctrl+C 停掉时退出码是 **0**，
// 不是 0xC000013A——旧实现只认 isInterruptedResult，于是 SAPI 路径的中断永远漏判（落进
// 「没有完整的分块 wav 可合并」→ die(1)，或直接报「朗读完成」）。现在改看完成度哨兵：
// 实际完成块数（manifest 行数）与计划块数比对，没跑满且退出码干净即判中断。
test("sapi：完成度哨兵——退出码为 0 但分块没跑满必须判中断（PS7 -File 的实机退出码就是 0）", () => {
  const plan = buildSpeakPlan("【用户】你好。世界。", { engine: "sapi", rate: 0 });
  assert.equal(plan.chunks.length, 2, "夹具应是 2 块");
  // 纯判定：优先级「中断 > 失败」，跑满才算 ok
  assert.equal(classifySapiCompletion({ status: 0, signal: null }, 1, 2), "interrupted", "退出码 0 + 只完成 1/2 块 = 被信号停掉");
  assert.equal(classifySapiCompletion({ status: 0, signal: null }, 0, 2), "interrupted");
  assert.equal(classifySapiCompletion({ status: 0, signal: null }, 2, 2), "ok");
  assert.equal(classifySapiCompletion({ status: 1, signal: null }, 1, 2), "failed", "非零退出是脚本报错，不许冒充中断");
  assert.equal(classifySapiCompletion({ status: 3221225786, signal: null }, 2, 2), "interrupted", "STATUS_CONTROL_C_EXIT 照旧认中断");
  assert.equal(classifySapiCompletion({ status: null, signal: "SIGINT" }, 0, 2), "interrupted", "POSIX SIGINT 照旧认中断");

  // 直接发声（无 --wav）没有产物可看，全靠 manifest 行数：只写 1 行 = 只念完 1 块
  const partial = runSapi(plan, (command, args) => {
    assert.ok(args.indexOf("-Manifest") > 0, "直接发声也必须带 -Manifest（哨兵载体）");
    fs.writeFileSync(args[args.indexOf("-Manifest") + 1], "1\n", "utf8");
    return { status: 0, signal: null };
  });
  assert.deepEqual(partial, { interrupted: true, status: 0 }, "旧实现这里会返回 interrupted:false 并打印「朗读完成」");
  // 跑满 → 正常完成（哨兵不能把成功误判成中断）
  const ok = runSapi(plan, (command, args) => {
    fs.writeFileSync(args[args.indexOf("-Manifest") + 1], "1\n2\n", "utf8");
    return { status: 0, signal: null };
  });
  assert.deepEqual(ok, { interrupted: false, status: 0 });
  // 非零退出 + 没跑满 = 失败（不是中断）：中断只在退出码干净时才成立
  assert.throws(
    () =>
      runSapi(plan, (command, args) => {
        fs.writeFileSync(args[args.indexOf("-Manifest") + 1], "1\n", "utf8");
        return { status: 1, signal: null };
      }),
    /朗读未正常完成/
  );
});

test("sapi：语音探测被停掉（退出码 0 但没有哨兵行）→ 按中断收口，不再整段开念", () => {
  // 探测（-Command）返回「干净退出 + 零输出」= 枚举脚本没跑到最后一行就被 Ctrl+C 停掉。
  // 旧实现把 sapiPlan 里的一切探测错误都吞掉，于是接着把全文念完（实机 19.2s 全部念完）。
  const dir = fs.mkdtempSync(path.join(TMP, "sapi-probe-int-"));
  const textFile = path.join(dir, "text.txt");
  fs.writeFileSync(textFile, "【用户】你好。世界。", "utf8");
  const stub = path.join(dir, "stub.cjs");
  fs.writeFileSync(
    stub,
    [
      'const cp = require("node:child_process");',
      "cp.spawnSync = function () {",
      '  return { status: 0, signal: null, stdout: "", stderr: "" };',
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  const result = spawnSync(process.execPath, ["--require", stub, CLI, "speak", textFile, "--engine", "sapi"], { encoding: "utf8" });
  assert.equal(result.status, 130, "探测窗中断应按 130 退出（128+SIGINT），实际 " + result.status + "；stderr=" + result.stderr);
  assert.match(result.stdout, /speak: 已中断/, "必须打印统一的「已中断」");
  assert.ok(result.stdout.indexOf("sapi 朗读完成") < 0, "探测已中断就不许再报朗读完成");
  assert.ok(result.stdout.indexOf("[1/2]") < 0, "探测已中断就不许继续开念");
});

// 真信号 (a)：--wav 合成中途收到真实 CTRL_C_EVENT。旧实现 exit 1 + stderr「没有完整的分块 wav
// 可合并」+ 分块目录残留；现在必须 exit 130 + speak: 已中断 + 无目标 wav + 无分块残留。
test("sapi：--wav 合成中途真 Ctrl+C → exit 130 + 已中断 + 无目标 wav + 分块目录不残留", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "sapi-wav-real-"));
  const textFile = path.join(dir, "text.txt");
  const sentence = "这是一段用于实机验证中断行为的朗读文本，句子长度接近分块上限，用来保证每一块都要合成一会儿。";
  fs.writeFileSync(textFile, Array.from({ length: 20 }, (_, i) => "【用户】" + (i + 1) + "、" + sentence + sentence).join("\n"), "utf8");
  const wavPath = path.join(dir, "out.wav");
  const partsDir = path.join(dir, "read-aloud-parts");
  // 分块目录由 runSapi 在「探测之后、spawn pwsh 之前」建好：等它出现再等 400ms 发信号，
  // 保证中断落在合成中途（40 块约 7s，400ms 时在第 2-3 块），不会误落进探测窗。
  const run = await runCliWithRealCtrlC([CLI, "speak", textFile, "--engine", "sapi", "--wav", wavPath], { delayMs: 400, waitMs: 25000, until: partsDir });
  assert.equal(run.waitResult, 0, "Ctrl+C 后 CLI 必须在等待窗内退出，否则仍在中途：\n" + run.helperOut);
  assert.equal(run.exitCode, 130, "中断应按 130 退出（128+SIGINT），实际 " + run.exitCode + "；log=" + run.log);
  assert.match(run.log, /speak: 已中断/, "中断必须打印统一提示（不是「合成失败」）");
  assert.ok(run.log.indexOf("没有完整的分块 wav") < 0, "不得再落回「合成失败」的兜底错误");
  assert.ok(run.log.indexOf("sapi 已合成") < 0, "中断不得报成合成成功");
  assert.equal(fs.existsSync(wavPath), false, "中断不得产出目标 wav");
  assert.equal(fs.existsSync(partsDir), false, "中断后分块目录（含半截 chunk_*.wav）必须回收：" + (fs.existsSync(partsDir) ? fs.readdirSync(partsDir).join(",") : ""));
});

// 真信号 (b)：直发声在探测窗内被打断。旧实现吞掉探测错误后照样整段念完（实机 19.2s 念完 5 块，
// 只在最后被排队的 SIGINT handler 补一个 130）——「已中断」与「朗读完成」同时出现。
test("sapi：直发声在探测窗内真 Ctrl+C → 不得念完整段（无朗读完成 / 无末块标记）", async () => {
  const dir = fs.mkdtempSync(path.join(TMP, "sapi-direct-real-"));
  const textFile = path.join(dir, "text.txt");
  const sentence = "这是一段用于实机验证中断行为的朗读文本，句子长度接近分块上限，用来保证每一块都要念十几秒。";
  const text = Array.from({ length: 4 }, (_, i) => "【用户】" + (i + 1) + "、" + sentence + sentence).join("\n");
  fs.writeFileSync(textFile, text, "utf8");
  const chunks = buildSpeakPlan(text, { engine: "sapi", rate: 0 }).chunks.length; // 只取块数（会跑一次真探测）
  // 500ms 发信号：node 启动 + SIGINT handler 已就绪（太早会落到 OS 默认终止，拿不到 130），
  // 又远在整段念完之前（8 块约 90s）。落点可能在探测窗、也可能在第一块，两种都必须中断收口。
  const run = await runCliWithRealCtrlC([CLI, "speak", textFile, "--engine", "sapi"], { delayMs: 500, waitMs: 30000 });
  assert.equal(run.waitResult, 0, "Ctrl+C 后 CLI 必须在等待窗内退出（整段念完要好几分钟）：\n" + run.helperOut);
  assert.equal(run.exitCode, 130, "中断应按 130 退出，实际 " + run.exitCode + "；log=" + run.log);
  assert.ok(run.log.indexOf("朗读完成") < 0, "探测窗中断后绝不许再报「朗读完成」：" + run.log);
  assert.ok(run.log.indexOf("[" + chunks + "/" + chunks + "]") < 0, "不得把最后一块也念完（" + chunks + " 块）：" + run.log);
});

test("sapi：ffmpeg 合并阶段被 Ctrl+C 打断也归为中断，不报「ffmpeg 合并失败」", () => {
  // ffmpegConcatWav 直接用模块级 spawnSync，runSapi 的注入参数够不到它；
  // 改在 CLI 子进程里用 --require 全局替换 spawnSync（pwsh 正常跑满全部块，ffmpeg 返回中断码）。
  const dir = fs.mkdtempSync(path.join(TMP, "sapi-ff-int-"));
  const textFile = path.join(dir, "text.txt");
  fs.writeFileSync(textFile, "【用户】你好。世界。", "utf8");
  const wavPath = path.join(dir, "out.wav");
  const template = path.join(dir, "template.wav");
  fs.writeFileSync(template, makeWavBytes(8820, 44100, 8820));
  const stub = path.join(dir, "stub.cjs");
  fs.writeFileSync(
    stub,
    [
      'const cp = require("node:child_process");',
      'const fs = require("node:fs");',
      "const template = process.env.RA_STUB_WAV;",
      "cp.spawnSync = function (command, args) {",
      '  if (/ffmpeg$/i.test(String(command))) return { status: 3221225786, signal: null, stdout: "", stderr: "" };',
      '  if (/pwsh\\.exe$/i.test(String(command))) {',
      '    if (args.indexOf("-Command") >= 0) {', // 语音枚举探测：哨兵行必须齐全，否则会先判中断
      '      return { status: 0, signal: null, stdout: "Microsoft Huihui Desktop|zh-CN|Female|Adult\\n__READ_ALOUD_VOICES_DONE__\\n", stderr: "" };',
      "    }",
      '    const wavDir = args[args.indexOf("-WavDir") + 1];',
      '    const manifest = args[args.indexOf("-Manifest") + 1];',
      "    fs.mkdirSync(wavDir, { recursive: true });",
      "    // 完成度哨兵要求「manifest 行数 === 计划块数」，否则会被判成中断（到不了 ffmpeg）",
      "    const lines = [];",
      "    for (let i = 1; i <= 2; i++) {",
      '      const chunk = wavDir + "\\\\chunk_" + String(i).padStart(3, "0") + ".wav";',
      "      fs.copyFileSync(template, chunk);",
      "      lines.push(chunk);",
      "    }",
      '    fs.writeFileSync(manifest, lines.join("\\n") + "\\n", "utf8");',
      '    return { status: 0, signal: null, stdout: "", stderr: "" };',
      "  }",
      '  return { status: 0, signal: null, stdout: "", stderr: "" };',
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  const result = spawnSync(process.execPath, ["--require", stub, CLI, "speak", textFile, "--engine", "sapi", "--wav", wavPath], {
    encoding: "utf8",
    env: Object.assign({}, process.env, { RA_STUB_WAV: template }),
  });
  assert.equal(result.status, 130, "ffmpeg 阶段中断应按 130 退出，实际 " + result.status + "；stderr=" + result.stderr);
  assert.match(result.stdout, /speak: 已中断/, "ffmpeg 中断必须走统一的「已中断」提示");
  assert.ok(result.stdout.indexOf("ffmpeg 合并失败") < 0, "不得把中断报成合并失败");
  assert.equal(fs.existsSync(path.join(dir, "read-aloud-parts")), false, "ffmpeg 阶段中断同样回收本次新建的分块目录");
});

// 子进程级中断桩：--require 预载 CJS 补丁，把 spawnSync 换成「指定阶段返回 STATUS_CONTROL_C_EXIT」。
// 这样不用真发 Ctrl+C 也能走完整 CLI 退出路径；真实信号路径由上面的 SIGINT 测试覆盖。
test("sapi：CLI 收到 Ctrl+C（子进程回传 STATUS_CONTROL_C_EXIT）→ 打印 speak: 已中断 + exit 130", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "sapi-cli-int-"));
  const textFile = path.join(dir, "text.txt");
  fs.writeFileSync(textFile, "【用户】你好。世界。", "utf8");
  const wavPath = path.join(dir, "out.wav");
  const stub = path.join(dir, "stub.cjs");
  // 探测阶段（-Command）正常返回（含完成哨兵），中断落在朗读阶段（-File），走 runSapi 的中断分支。
  fs.writeFileSync(
    stub,
    [
      'const cp = require("node:child_process");',
      "cp.spawnSync = function (command, args) {",
      '  if (args && args.indexOf("-Command") >= 0) {',
      '    return { status: 0, signal: null, stdout: "Microsoft Huihui Desktop|zh-CN|Female|Adult\\n__READ_ALOUD_VOICES_DONE__\\n", stderr: "" };',
      "  }",
      '  return { status: 3221225786, signal: null, stdout: "", stderr: "" };',
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  const result = spawnSync(process.execPath, ["--require", stub, CLI, "speak", textFile, "--engine", "sapi", "--wav", wavPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 130, "中断应按 130 退出（128+SIGINT），实际 " + result.status + "；stderr=" + result.stderr);
  assert.match(result.stdout, /speak: 已中断/, "必须打印与 edge 路径同一句提示");
  assert.ok(result.stdout.indexOf("没有完整的分块 wav 可合并") < 0, "不得再落回「合成失败」的兜底错误");
  assert.ok(result.stdout.indexOf("sapi 朗读完成") < 0, "中断不得报成朗读完成");
  assert.equal(fs.existsSync(path.join(dir, "read-aloud-parts")), false, "中断后分块目录必须回收");
  assert.equal(fs.existsSync(wavPath), false, "中断不得产出目标 wav");
  // 无 --wav（直接发声）同样是中断收口：此前会打印「已中断」但退出码 0，现在统一为 130。
  const direct = spawnSync(process.execPath, ["--require", stub, CLI, "speak", textFile, "--engine", "sapi"], { encoding: "utf8" });
  assert.equal(direct.status, 130, "直接发声模式的中断也应按 130 退出，实际 " + direct.status);
  assert.match(direct.stdout, /speak: 已中断/);
  assert.ok(direct.stdout.indexOf("sapi 朗读完成") < 0, "中断不得报成朗读完成");
});

test("edge：播放阶段被 Ctrl+C 打断也打印 speak: 已中断并按 130 退出（与合成阶段一致）", () => {
  const dir = fs.mkdtempSync(path.join(TMP, "edge-play-int-"));
  const textFile = path.join(dir, "text.txt");
  fs.writeFileSync(textFile, "【用户】你好。世界。", "utf8");
  const template = path.join(dir, "template.wav");
  fs.writeFileSync(template, makeWavBytes(8820, 44100, 8820));
  const stub = path.join(dir, "stub.cjs");
  // 桩按阶段分流：edge-tts 探测/合成与 ffmpeg 转码成功（写出产物），pwsh 播放返回中断码。
  fs.writeFileSync(
    stub,
    [
      'const cp = require("node:child_process");',
      'const fs = require("node:fs");',
      "const template = process.env.RA_STUB_WAV;",
      "cp.spawnSync = function (command, args) {",
      '  const name = String(command);',
      '  if (/edge-tts$/i.test(name)) {',
      '    if (args.indexOf("--version") >= 0) return { status: 0, signal: null, stdout: "edge-tts 6.1.0\\n", stderr: "" };',
      '    fs.writeFileSync(args[args.indexOf("--write-media") + 1], "ID3", "utf8");',
      '    return { status: 0, signal: null, stdout: "", stderr: "" };',
      "  }",
      '  if (/ffmpeg$/i.test(name)) {',
      "    fs.copyFileSync(template, args[args.length - 1]);",
      '    return { status: 0, signal: null, stdout: "", stderr: "" };',
      "  }",
      '  if (/pwsh\\.exe$/i.test(name)) return { status: 3221225786, signal: null, stdout: "", stderr: "" };',
      '  return { error: new Error("unexpected spawn: " + name), status: null, signal: null };',
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const before = new Set(fs.readdirSync(tmpRoot).filter((name) => name.indexOf("read-aloud-edge-") === 0));
  const result = spawnSync(process.execPath, ["--require", stub, CLI, "speak", textFile, "--engine", "edge"], {
    encoding: "utf8",
    env: Object.assign({}, process.env, { RA_STUB_WAV: template }),
  });
  assert.equal(result.status, 130, "播放阶段中断应按 130 退出，实际 " + result.status + "；stderr=" + result.stderr);
  assert.match(result.stdout, /正在播放/, "应先进入播放阶段");
  assert.match(result.stdout, /speak: 已中断/, "播放阶段中断必须打印统一提示");
  assert.ok(result.stdout.indexOf("播放完成") < 0, "中断不得报成播放完成");
  const leftovers = fs.readdirSync(tmpRoot).filter((name) => name.indexOf("read-aloud-edge-") === 0 && !before.has(name));
  assert.deepEqual(leftovers, [], "播放中断后不得留下独占分块目录");
});

test("speak/dump/widget：取值型标志缺值时当场报错，不把 true 泄漏进命令行", async () => {
  const file = path.join(TMP, "value-opt.txt");
  fs.writeFileSync(file, "【用户】你好。世界。", "utf8");
  const dbPath = await createFixtureDb();
  const cases = [
    [[CLI, "speak", file, "--voice"], /--voice 需要一个值/],
    [[CLI, "speak", file, "--rate"], /--rate 需要一个值/],
    [[CLI, "dump", "--db", dbPath, "--session"], /--session 需要一个值/],
    [[CLI, "dump", "--db", dbPath, "--last"], /--last 需要一个值/],
    [[CLI, "dump", "--db", dbPath, "--max-chars"], /--max-chars 需要一个值/],
    [[CLI, "widget", file, "--vizdir"], /--vizdir 需要一个路径值/],
    [[CLI, "widget", file, "--vizdir", TMP, "--title"], /--title 需要一个值/],
  ];
  for (const [argv, pattern] of cases) {
    const result = spawnSync(process.execPath, argv, { encoding: "utf8" });
    assert.notEqual(result.status, 0, "缺值应非 0 退出: " + argv.join(" "));
    assert.match(result.stderr, pattern, argv.join(" "));
  }
});

// ---------------------------------------------------------------- 6. wav 头解析

function makeWavBytes(dataSize, byteRate, actualDataBytes) {
  const buf = Buffer.alloc(44 + actualDataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(byteRate / 2, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

test("wav 头解析：时长=dataSize/byteRate，截断可识别", () => {
  const ok = path.join(TMP, "ok.wav");
  fs.writeFileSync(ok, makeWavBytes(88200, 44100, 88200));
  const info = readWavInfo(ok);
  assert.ok(info);
  assert.equal(info.seconds, 2);
  assert.equal(info.truncated, false);

  const bad = path.join(TMP, "truncated.wav");
  fs.writeFileSync(bad, makeWavBytes(88200, 44100, 44100));
  assert.equal(readWavInfo(bad).truncated, true);

  const junk = path.join(TMP, "junk.wav");
  fs.writeFileSync(junk, Buffer.from("not a wav at all"));
  assert.equal(readWavInfo(junk), null);
  assert.equal(readWavInfo(path.join(TMP, "missing.wav")), null);
});

// ---------------------------------------------------------------- 7. voices 选择

test("voices：pickSapiVoice 优先 zh-CN 与 Huihui", () => {
  const voices = [
    { name: "Microsoft David Desktop", culture: "en-US" },
    { name: "Microsoft Yaoyao", culture: "zh-CN" },
    { name: "Microsoft Huihui", culture: "zh-CN" },
  ];
  assert.equal(pickSapiVoice(voices).name, "Microsoft Huihui");
  assert.equal(pickSapiVoice(voices, "Yaoyao").name, "Microsoft Yaoyao");
  assert.equal(pickSapiVoice([{ name: "Microsoft David", culture: "en-US" }]).name, "Microsoft David");
  assert.equal(pickSapiVoice([]), null);
  assert.equal(roleLabel("user"), "用户");
  assert.equal(roleLabel(null), "文本");
});

// ---------------------------------------------------------------- 8. widget 交互冒烟（vm + fake DOM）

function makeElement(id, scrolled) {
  const listeners = {};
  const classes = new Set();
  const attrs = {};
  return {
    id: id,
    tagName: "DIV",
    style: {},
    disabled: false,
    hidden: false,
    value: "",
    textContent: "",
    innerHTML: "",
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, on) => {
        if (on === undefined) {
          if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        } else if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    setAttribute: (name, value) => {
      attrs[name] = String(value);
    },
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    addEventListener: (type, fn) => {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener: () => {},
    scrollIntoView: (options) => scrolled.push({ id: id, options: options }),
    dispatch: (type, event) => {
      for (const fn of listeners[type] || []) fn(event || { type: type });
    },
    _classes: classes,
    _attrs: attrs,
  };
}

function makeFakeSynth(voices) {
  const spoken = [];
  const cancelled = [];
  const utterances = [];
  let current = null;
  class FakeUtterance {
    constructor(text) {
      this.text = String(text);
      this.lang = "";
      this.rate = 1;
      this.voice = null;
      this.onend = null;
      this.onerror = null;
    }
  }
  const api = {
    getVoices: () => voices,
    speak: (utterance) => {
      spoken.push(utterance.text);
      utterances.push(utterance);
      current = utterance;
      // 真实浏览器异步发 onend；用 setImmediate 发，守住 node:test 悬空坑
      setImmediate(() => {
        if (typeof utterance.onend === "function") utterance.onend();
      });
    },
    cancel: () => {
      cancelled.push(current ? current.text : null);
      const utterance = current;
      current = null;
      if (utterance && typeof utterance.onend === "function") {
        setImmediate(() => utterance.onend());
      }
    },
    pause: () => {},
    resume: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { spoken: spoken, cancelled: cancelled, utterances: utterances, api: api, Utterance: FakeUtterance };
}

function runWidgetScript(html, options) {
  const opts = options || {};
  const scrolled = [];
  const registry = new Map();
  // 逐标签扫描：id 与 style 属性在同一标签上，顺手把内联 style 灌进 fake style 对象
  const tagRe = /<[a-zA-Z][^>]*\bid="([^"]+)"[^>]*>/g;
  let matched;
  while ((matched = tagRe.exec(html)) !== null) {
    if (registry.has(matched[1])) continue;
    const element = makeElement(matched[1], scrolled);
    const styleMatched = /\bstyle="([^"]*)"/.exec(matched[0]);
    if (styleMatched) {
      for (const declaration of styleMatched[1].split(";")) {
        const colon = declaration.indexOf(":");
        if (colon > 0) element.style[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim();
      }
    }
    registry.set(matched[1], element);
  }
  const dataMatched = /<script type="application\/json" id="ra-data">([\s\S]*?)<\/script>/.exec(html);
  if (dataMatched && registry.has("ra-data")) registry.get("ra-data").textContent = dataMatched[1];

  const scriptMatched = /<script>([\s\S]*?)<\/script>/.exec(html);
  const synth = opts.speech === false ? null : makeFakeSynth(opts.voices || [{ name: "Microsoft Huihui", lang: "zh-CN" }]);
  const windowListeners = {};
  const stateWrites = [];

  const sandbox = {
    document: { getElementById: (id) => registry.get(id) || null },
    console: console,
  };
  sandbox.window = sandbox;
  if (synth) {
    sandbox.speechSynthesis = synth.api;
    sandbox.SpeechSynthesisUtterance = synth.Utterance;
  }
  sandbox.addEventListener = (type, fn) => {
    (windowListeners[type] = windowListeners[type] || []).push(fn);
  };
  sandbox.removeEventListener = () => {};
  sandbox.zcode = {
    widgetState: opts.initialState === undefined ? null : opts.initialState,
    setWidgetState: (next) => {
      stateWrites.push(next);
      return Promise.resolve();
    },
  };
  vm.createContext(sandbox);
  new vm.Script(scriptMatched[1], { filename: "read-aloud-widget-inline.js" }).runInContext(sandbox);
  return {
    sandbox: sandbox,
    registry: registry,
    scrolled: scrolled,
    spoken: synth ? synth.spoken : [],
    cancelled: synth ? synth.cancelled : [],
    utterances: synth ? synth.utterances : [],
    stateWrites: stateWrites,
    dispatchWindow: (type, event) => {
      for (const fn of windowListeners[type] || []) fn(event || { type: type });
    },
  };
}

function widgetQueue(html) {
  const dataMatched = /<script type="application\/json" id="ra-data">([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(dataMatched[1]).map((item) => item.text);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

async function waitFor(predicate, label) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("waitFor 超时: " + label);
}

function smokeHtml() {
  return buildWidgetFragment([
    { role: "user", text: "第一句。第二句。" },
    { role: "assistant", text: "第三句。" },
  ]);
}

function longHtml() {
  const sentences = [];
  for (let i = 1; i <= 8; i++) sentences.push("第" + i + "句。");
  return buildWidgetFragment([{ role: "assistant", text: sentences.join("") }]);
}

test("widget 冒烟：加载后按钮可用、展开控件隐藏、状态不写", () => {
  const html = smokeHtml();
  const harness = runWidgetScript(html, {});
  assert.equal(harness.registry.get("ra-speak").disabled, false, "有中文语音时按钮应可用");
  assert.equal(harness.registry.get("ra-hint").style.display, "none", "不应显示缺语音提示");
  assert.equal(harness.registry.get("ra-pause").style.display, "none");
  assert.equal(harness.registry.get("ra-stop").style.display, "none");
  assert.equal(harness.registry.get("ra-rate-label").style.display, "none");
  assert.equal(harness.registry.get("ra-progress-bar").style.width, "0%");
  assert.equal(harness.stateWrites.length, 0, "加载时不得写 widgetState");
});

test("widget 冒烟：点朗读 → 逐句 onend → 高亮推进 → 全队列完成", async () => {
  const html = smokeHtml();
  const expected = widgetQueue(html);
  const harness = runWidgetScript(html, {});
  const status = harness.registry.get("ra-status");
  const bar = harness.registry.get("ra-progress-bar");
  const progress = harness.registry.get("ra-progress");

  harness.registry.get("ra-speak").dispatch("click");
  assert.equal(harness.registry.get("ra-speak")._attrs["aria-pressed"], "true");
  assert.equal(harness.registry.get("ra-pause").style.display, "", "朗读中应展开暂停/停止/倍速");
  assert.equal(harness.registry.get("ra-rate-label").style.display, "");
  assert.equal(status.textContent, "正在朗读 1 / " + expected.length);
  // aria-valuenow 必须随朗读推进同步更新（屏幕阅读器才有进度），不能停在静态 0
  assert.equal(progress._attrs["aria-valuenow"], "0", "首句激活时 aria-valuenow 为 0");

  // 用可控 speak 把队列钉在第 2 句：第二句起扣住 onend 不派发，
  // setActive(1) 已同步执行完 → aria-valuenow 稳定停在 33，断言不带竞态
  // （fake 的 onend 走 setImmediate，整条短队列会在一次 poll 间隙里跑完）。
  const synth = harness.sandbox.speechSynthesis;
  const realSpeak = synth.speak;
  const held = [];
  synth.speak = function (utterance) {
    if (harness.spoken.length >= 1) {
      held.push(utterance);
      return;
    }
    return realSpeak(utterance);
  };

  await waitFor(() => progress._attrs["aria-valuenow"] === "33", "推进到第 2 句（队列钉住）");
  assert.equal(status.textContent, "正在朗读 2 / " + expected.length, "队列应停在句 2");
  assert.equal(progress._attrs["aria-valuenow"], "33", "读完 1/3 句应报 33");

  // 释放扣住的句，队列继续走完
  synth.speak = realSpeak;
  for (const utterance of held) realSpeak(utterance);

  await waitFor(() => harness.spoken.length === expected.length && status.textContent.indexOf("朗读完成") >= 0, "队列跑完");

  assert.deepEqual(harness.spoken, expected, "必须按队列顺序逐句朗读");
  assert.equal(status.textContent, "朗读完成，共 " + expected.length + " 句");
  assert.equal(bar.style.width, "100%");
  assert.equal(progress._attrs["aria-valuenow"], "100", "完成后 aria-valuenow 应为 100");
  assert.equal(harness.registry.get("ra-speak")._attrs["aria-pressed"], "false");
  assert.equal(harness.registry.get("ra-pause").style.display, "none", "完成后应收起展开控件");
  // 高亮推进：过程中至少滚动过一次，最后一句为激活态、其余为已读
  assert.ok(harness.scrolled.length >= expected.length, "每句都应 scrollIntoView");
  assert.ok(harness.scrolled.every((entry) => entry.options && entry.options.block === "nearest"));
  const last = harness.registry.get("ra-sent-" + (expected.length - 1));
  assert.ok(last._classes.has("is-active"), "最后一句应保持高亮");
  assert.ok(harness.registry.get("ra-sent-0")._classes.has("is-read"), "已读句子应标记 is-read");
  assert.equal(harness.stateWrites.length, 0, "朗读过程不应写 widgetState");
});

test("widget 冒烟：停止即 cancel 且不再继续朗读", async () => {
  const html = longHtml();
  const expected = widgetQueue(html);
  assert.ok(expected.length >= 6, "该用例需要足够长的队列");
  const harness = runWidgetScript(html, {});
  harness.registry.get("ra-speak").dispatch("click");
  // speak() 是同步发出的，此刻只读了第一句，onend 尚未派发
  assert.equal(harness.spoken.length, 1, "点击后应同步朗读第一句");
  harness.registry.get("ra-stop").dispatch("click");
  const spokenAtStop = harness.spoken.length;
  await tick();
  await tick();
  assert.equal(harness.spoken.length, spokenAtStop, "停止后不得再 speak");
  assert.ok(harness.cancelled.length >= 1, "停止必须调 cancel");
  assert.equal(harness.registry.get("ra-status").textContent, "已停止");
  assert.equal(harness.registry.get("ra-pause").style.display, "none");
  assert.equal(harness.registry.get("ra-progress-bar").style.width, "0%");
  assert.equal(harness.registry.get("ra-progress")._attrs["aria-valuenow"], "0", "停止后 aria-valuenow 归零");
  assert.ok(spokenAtStop < expected.length, "应确为中途停止");
});

test("widget 冒烟：倍速偏好读写双侧", () => {
  const html = smokeHtml();
  const loaded = runWidgetScript(html, { initialState: { modelContent: null, privateContent: { rate: 1.5 } } });
  assert.equal(loaded.registry.get("ra-rate").value, "1.5", "加载时应读回倍速偏好");
  assert.equal(loaded.stateWrites.length, 0, "加载时不得写");

  const rateSel = loaded.registry.get("ra-rate");
  rateSel.value = "0.75";
  rateSel.dispatch("change");
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.stateWrites[loaded.stateWrites.length - 1])), {
    modelContent: null,
    privateContent: { rate: 0.75 },
  });

  // zcode:set_globals 事件只应用、不写
  loaded.dispatchWindow("zcode:set_globals", { detail: { globals: { widgetState: { privateContent: { rate: 2 } } } } });
  assert.equal(loaded.registry.get("ra-rate").value, "2");
  assert.equal(loaded.stateWrites.length, 1, "状态事件不得触发写");

  // 非法状态值回退默认
  const bad = runWidgetScript(html, { initialState: { privateContent: { rate: 99 } } });
  assert.equal(bad.registry.get("ra-rate").value, "1");
});

test("widget 冒烟：无 speechSynthesis 时按钮禁用并给可见提示", () => {
  const html = smokeHtml();
  const harness = runWidgetScript(html, { speech: false });
  assert.equal(harness.registry.get("ra-speak").disabled, true, "无语音引擎必须禁用按钮");
  assert.equal(harness.registry.get("ra-hint").style.display, "", "缺语音提示必须可见");
  assert.match(harness.registry.get("ra-status").textContent, /未检测到中文语音/);
  harness.registry.get("ra-speak").dispatch("click");
  assert.equal(harness.spoken.length, 0);
});

test("widget 冒烟：音色下拉存在、默认优先级、切换写入 widgetState", () => {
  const html = smokeHtml();
  // ① 下拉与标签都在片段里（拼装层，不依赖运行时）
  assert.ok(html.indexOf('id="ra-voice"') >= 0, "应有音色下拉");
  assert.ok(html.indexOf('id="ra-voice-label"') >= 0, "应有音色标签");
  assert.match(html, /for="ra-voice"/);

  // ② 默认音色优先级：Natural/Online/Xiaoxiao/Yunxi > Yaoyao/Huihui > 任意 zh
  const mixed = runWidgetScript(html, {
    voices: [
      { name: "Microsoft David", lang: "en-US" },
      { name: "Microsoft Yaoyao", lang: "zh-CN" },
      { name: "Microsoft Huihui", lang: "zh-CN" },
      { name: "Microsoft Xiaoxiao Online (Natural)", lang: "zh-CN" },
    ],
  });
  assert.equal(mixed.registry.get("ra-voice").value, "Microsoft Xiaoxiao Online (Natural)", "应优先神经/在线音色");

  const legacy = runWidgetScript(html, {
    voices: [
      { name: "Some Zh Voice", lang: "zh-CN" },
      { name: "Microsoft Huihui", lang: "zh-CN" },
    ],
  });
  assert.equal(legacy.registry.get("ra-voice").value, "Microsoft Huihui", "无神经音色时优先 Huihui/Yaoyao");

  const anyZh = runWidgetScript(html, { voices: [{ name: "Microsoft David", lang: "en-US" }, { name: "Other Zh", lang: "zh-CN" }] });
  assert.equal(anyZh.registry.get("ra-voice").value, "Other Zh", "最后兜底任意 zh 语音");

  // 下拉只列 zh 语音（不把 en-US 拉进来）
  assert.ok(String(mixed.registry.get("ra-voice").innerHTML).indexOf("Microsoft David") < 0, "下拉不应列非 zh 语音");

  // ③ 切换即写入 widgetState（privateContent.voice）并生效到后续 utterance
  const voiceSel = mixed.registry.get("ra-voice");
  voiceSel.value = "Microsoft Yaoyao";
  voiceSel.dispatch("change");
  const lastWrite = mixed.stateWrites[mixed.stateWrites.length - 1];
  assert.deepEqual(JSON.parse(JSON.stringify(lastWrite)), { modelContent: null, privateContent: { voice: "Microsoft Yaoyao" } });
  mixed.registry.get("ra-speak").dispatch("click");
  assert.equal(mixed.utterances.length, 1, "切换音色后点朗读应发声");
  assert.equal(mixed.utterances[0].voice && mixed.utterances[0].voice.name, "Microsoft Yaoyao", "切换后的音色必须真的用上");

  // ④ 加载时读回保存的音色（且不写）
  const restored = runWidgetScript(html, {
    voices: [{ name: "Microsoft Huihui", lang: "zh-CN" }, { name: "Microsoft Yunxi Online", lang: "zh-CN" }],
    initialState: { modelContent: null, privateContent: { voice: "Microsoft Yunxi Online" } },
  });
  assert.equal(restored.registry.get("ra-voice").value, "Microsoft Yunxi Online", "应读回私有状态里的音色");
  assert.equal(restored.stateWrites.length, 0, "加载时不得写");

  // ⑤ 状态里的音色已不在候选表里 → 回落到默认优先级，不崩
  const stale = runWidgetScript(html, {
    voices: [{ name: "Microsoft Huihui", lang: "zh-CN" }],
    initialState: { privateContent: { voice: "Gone Voice" } },
  });
  assert.equal(stale.registry.get("ra-voice").value, "Microsoft Huihui");

  // ⑥ zcode:set_globals 事件只应用不写
  restored.dispatchWindow("zcode:set_globals", { detail: { globals: { widgetState: { privateContent: { voice: "Microsoft Huihui" } } } } });
  assert.equal(restored.registry.get("ra-voice").value, "Microsoft Huihui");
  assert.equal(restored.stateWrites.length, 0, "状态事件不得触发写");
});

test("widget 冒烟：无中文语音时同样禁用", () => {
  const html = smokeHtml();
  const harness = runWidgetScript(html, { voices: [{ name: "Microsoft David", lang: "en-US" }] });
  assert.equal(harness.registry.get("ra-speak").disabled, true);
  assert.equal(harness.registry.get("ra-hint").style.display, "");
});

test("widget 冒烟：speak 抛异常时降级提示且不卡在朗读态", () => {
  const html = smokeHtml();
  const harness = runWidgetScript(html, {});
  harness.sandbox.speechSynthesis.speak = function () {
    throw new Error("no audio device");
  };
  harness.registry.get("ra-speak").dispatch("click");
  assert.equal(harness.spoken.length, 0);
  assert.match(harness.registry.get("ra-status").textContent, /朗读启动失败/);
  assert.equal(harness.registry.get("ra-speak")._attrs["aria-pressed"], "false");
  assert.equal(harness.registry.get("ra-pause").style.display, "none");
});

test("widget 冒烟：空文本不生成片段", () => {
  assert.throws(() => buildWidgetFragment([{ role: "user", text: "   " }]), /没有可朗读内容/);
});
