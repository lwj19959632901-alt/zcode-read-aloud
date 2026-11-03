// 通用 CDP eval：node cdp-eval.mjs "<expression>" [port]
import fs from "node:fs";

const PORT = process.argv[3] || "9222";
const EXPR = process.argv[2];
const OUT = "D:/ZCodeData/workspace/default/read-aloud/tmp-probe/cdp-eval.out.json";

if (!EXPR) {
  console.error("usage: node cdp-eval.mjs \"<expr>\" [port]");
  process.exit(2);
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const pages = list.filter((t) => t.type === "page");
  const page = pages.find((t) => t.url.includes("index.html")) || pages[0];
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) =>
    new Promise((res) => {
      const myId = ++id;
      pending.set(myId, res);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  await new Promise((r) => ws.addEventListener("open", r));
  await send("Runtime.enable", {});
  const r = await send("Runtime.evaluate", {
    expression: EXPR,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  const res = r.result || {};
  const out = res.exceptionDetails
    ? { error: res.exceptionDetails.text, desc: res.exceptionDetails.exception && res.exceptionDetails.exception.description }
    : { value: res.result && res.result.value };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out).slice(0, 4000));
  ws.close();
}
main().catch((e) => {
  console.log("ERR", e.message);
  process.exit(1);
});
