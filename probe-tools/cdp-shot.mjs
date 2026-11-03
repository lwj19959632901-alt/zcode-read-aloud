// CDP 截图：node cdp-shot.mjs <out.png> [port]
import fs from "node:fs";

const OUT = process.argv[2] || "D:/ZCodeData/workspace/default/read-aloud/tmp-probe/page.png";
const PORT = process.argv[3] || "9222";

const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((t) => t.type === "page" && t.url.includes("index.html")) || list.find((t) => t.type === "page");
if (!page) throw new Error("no page");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.addEventListener("open", r));
await send("Page.enable", {});
const r = await send("Page.captureScreenshot", { format: "png" });
const data = r.result && r.result.data;
if (!data) { console.log("NO-DATA"); process.exit(1); }
fs.writeFileSync(OUT, Buffer.from(data, "base64"));
console.log("SAVED", OUT, fs.statSync(OUT).size);
ws.close();
