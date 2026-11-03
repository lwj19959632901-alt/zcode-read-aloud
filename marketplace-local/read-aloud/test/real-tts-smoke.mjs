// real-tts-smoke.mjs — 真实 edge-tts 合成冒烟（§十⑥）

// spawn server → tools/call speak_session（RA_DB_PATH=真实 db，_meta.sessionId=当前会话）
// → speak_chunk 0 → base64 解码断言 mp3 魔数（ID3 或 0xFF 0xFB）

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const SERVER = path.join(PLUGIN_ROOT, "dist", "server.mjs");

// 用真实 db（默认路径）
const DB_PATH = process.env.RA_DB_PATH || path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error("FAIL 数据库不存在: " + DB_PATH);
    return 1;
  }
  if (!fs.existsSync(SERVER)) {
    console.error("FAIL server.mjs 不存在: " + SERVER);
    return 1;
  }

  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: Object.assign({}, process.env, {
      RA_DB_PATH: DB_PATH,
    }),
  });

  let buffer = "";
  let nextId = 0;
  const pending = new Map();

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const entry = pending.get(msg.id);
        if (entry) {
          pending.delete(msg.id);
          entry.resolve(msg);
        }
      } catch { /* 忽略 */ }
    }
  });

  proc.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (text.trim()) console.error("STDERR: " + text.trim());
  });

  function call(method, params) {
    const id = ++nextId;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }) + "\n");
    });
  }

  async function run() {
    try {
      // initialize
      await call("initialize", { protocolVersion: "2025-06-18" });
      console.log("NOTE initialize 完成");

      // session_info 诊断
      const infoResp = await call("tools/call", {
        name: "session_info",
        arguments: {},
      });
      const info = JSON.parse(infoResp.result.content[0].text);
      console.log("NOTE session_info: sessionId=" + info.sessionId + " dbExists=" + info.dbExists + " pythonResolved=" + info.pythonResolved);

      if (info.pythonResolved === null) {
        console.error("FAIL python 未解析（edge-tts 环境不满足）");
        proc.kill();
        return 1;
      }

      // speak_session（用 fallback 解析当前会话）
      const sessionResp = await call("tools/call", {
        name: "speak_session",
        arguments: {},
      });
      if (sessionResp.error) {
        console.error("FAIL speak_session 失败: " + sessionResp.error.message);
        proc.kill();
        return 1;
      }
      const session = JSON.parse(sessionResp.result.content[0].text);
      console.log("NOTE speak_session: sessionId=" + session.sessionId + " chunks=" + session.chunks.length + " totalChars=" + session.totalChars);

      if (!session.chunks.length) {
        console.error("FAIL 无 chunks");
        proc.kill();
        return 1;
      }

      // speak_chunk 0
      const chunkResp = await call("tools/call", {
        name: "speak_chunk",
        arguments: { requestId: session.requestId, index: 0 },
      });
      if (chunkResp.error) {
        console.error("FAIL speak_chunk 失败: " + chunkResp.error.message);
        proc.kill();
        return 1;
      }
      const chunk = JSON.parse(chunkResp.result.content[0].text);
      console.log("NOTE speak_chunk: bytes=" + chunk.bytes + " cached=" + chunk.cached + " voice=" + chunk.voice);

      // 断言 mp3 魔数（ID3 或 0xFF 帧同步：0xFF 后跟 0xE0-0xFF 的同步字节）
      const base64 = chunk.dataUri.replace("data:audio/mpeg;base64,", "");
      const buf = Buffer.from(base64, "base64");
      const isID3 = buf.length >= 3 && buf.toString("ascii", 0, 3) === "ID3";
      const isFrameSync = buf.length >= 2 && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0;
      if (!isID3 && !isFrameSync) {
        console.error("FAIL mp3 魔数不匹配: ID3=" + isID3 + " frameSync=" + isFrameSync + " firstBytes=" + buf.slice(0, 4).toString("hex"));
        proc.kill();
        return 1;
      }
      console.log("NOTE mp3 魔数正确: " + (isID3 ? "ID3" : "0xFF 帧同步") + " bytes=" + buf.length);

      // 断言 bytes > 0
      if (chunk.bytes <= 0) {
        console.error("FAIL bytes <= 0");
        proc.kill();
        return 1;
      }

      console.log("real-tts-smoke: PASS");
      proc.kill();
      return 0;
    } catch (err) {
      console.error("FAIL 异常: " + (err && err.message || err));
      proc.kill();
      return 1;
    }
  }

  run().then((code) => {
    process.exit(code);
  });
}

main();
