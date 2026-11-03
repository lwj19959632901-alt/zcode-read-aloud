// 从 server.mjs 抽取面板 HTML（走 resources/read），落盘到 tmp-probe/panel-extracted.html
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const cp = spawn("node", ["marketplace-local/read-aloud-probe/dist/server.mjs"], { cwd: process.cwd() });
let buf = "";
cp.stdout.setEncoding("utf8");
cp.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === 1) {
      cp.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "ui://read-aloud-probe/panel.html" } }) + "\n"
      );
    } else if (m.id === 2) {
      writeFileSync("tmp-probe/panel-extracted.html", m.result.contents[0].text, "utf8");
      console.log("EXTRACTED bytes=" + m.result.contents[0].text.length);
      cp.kill();
    }
  }
});
cp.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n"
);
setTimeout(() => {
  cp.kill();
  console.log("TIMEOUT");
}, 8000);
