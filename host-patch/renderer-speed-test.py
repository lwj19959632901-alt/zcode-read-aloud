"""倍速按钮离线自检（Playwright + 本机 Chrome，不碰 ZCode、不跑真实 TTS）。

覆盖：
  1. 倍速按钮存在、紧随 🔊（直系子节点）、文案 1.0×、aria-label/title/type 正确
  2. 样式不撑高操作栏（18px / 11px / 透明背景 / padding 0 2px）
  3. 点击循环 1.0 → 1.25 → 1.5 → 2.0 → 0.75 → 1.0，每次文案 + localStorage 同步
  4. ttsUrl() 的 rate 参数固定 +0%（合成统一原速；倍速由播放器 playbackRate 实现，
     切速不重合成、不发新请求——server 路径另有 CDP 在线验收）
  5. 降级路径 speechSynthesis 的 u.rate 跟随倍速（0.1–10 夹紧）
  6. 播放中改倍速：不中断，下一块按新倍速合成（降级路径；server 路径切速即 playbackRate）
  7. 多回合倍速按钮文案全局同步；≠1.0 时 accent 色提示
  8. MutationObserver 补回被冲掉的倍速按钮；整栏 clone 重渲染后仍恰好 1 个
  9. __readaloudReload() 与整页 reload 后倍速从 localStorage 恢复
 10. __readaloudDispose() 连倍速按钮一起摘掉
 11. 点击倍速按钮不冒泡到宿主操作栏、不触发播放

用法：python renderer-speed-test.py
"""
import functools
import http.server
import json
import shutil
import sys
import tempfile
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
RENDERER = HERE / "readaloud-renderer.js"

FIXTURE = """<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><link rel="icon" href="data:,"><title>readaloud speed fixture</title></head>
<body>
<div id="root">
  <div class="group/assistant-turn flex w-full flex-col gap-5" data-turn="1">
    <div class="flex flex-col gap-5">
      <div data-testid="v4-row-1" class="group/assistant-row">
        <div data-conversation-selectable="true" class="w-full">
          <div class="markdown"><p>第一段倍速测试文字。</p><p>第二段文字。</p></div>
        </div>
      </div>
    </div>
    <div class="flex items-center gap-1 opacity-0 group-hover/assistant:opacity-100">
      <button aria-label="复制" type="button" data-slot="tooltip-trigger" data-state="closed"><svg class="lucide-copy"></svg><span class="sr-only">复制</span></button>
      <button aria-label="赞" type="button"><span class="sr-only">赞</span></button>
    </div>
  </div>

  <div class="group/assistant-turn flex w-full flex-col gap-5" data-turn="2">
    <div class="flex flex-col gap-5">
      <div data-testid="v4-row-2" class="group/assistant-row">
        <div data-conversation-selectable="true" class="w-full">
          <div class="markdown"><p>__LONG_TEXT__</p></div>
        </div>
      </div>
    </div>
    <div class="flex items-center gap-1 opacity-0 group-hover/assistant:opacity-100">
      <button aria-label="复制" type="button" data-slot="tooltip-trigger" data-state="closed"><span class="sr-only">复制</span></button>
    </div>
  </div>
</div>
</body>
</html>
"""

# turn2 需要 >900 字才会切成多块（节奏：每句 20 字 × 100 句 = 2000 字）
LONG_TEXT = "这是用来验证倍速分块生效的长句子。" * 100

STUB = r"""
Object.defineProperty(window, "speechSynthesis", {
  configurable: true,
  value: {
    __log: [],
    __pending: null,
    getVoices: function () { return [{ name: "Microsoft Xiaoxiao Online", lang: "zh-CN" }]; },
    cancel: function () { this.__log.push({ type: "cancel" }); },
    speak: function (u) {
      this.__log.push({ type: "speak", text: u.text, rate: u.rate });
      this.__pending = u;
      if (window.__autoEnd && u.onend) setTimeout(function () { u.onend({}); }, 3);
    },
    pendingUtterance: function () { return this.__pending; },
  },
});
window.__autoEnd = false;
window.SpeechSynthesisUtterance = function (text) {
  this.text = text;
  this.lang = "";
  this.rate = 1;
  this.voice = null;
  this.onend = null;
  this.onerror = null;
};
"""

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS  " if cond else "FAIL  ") + name + ("  — " + str(detail) if detail else ""))


def serve_fixture(tmpdir):
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args):
            pass

    handler = functools.partial(Quiet, directory=tmpdir)
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def launch_args(p):
    kw = {"headless": True}
    chrome = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    edge = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
    if chrome.is_file():
        kw["executable_path"] = str(chrome)
    elif edge.is_file():
        kw["executable_path"] = str(edge)
    return p.chromium.launch(**kw)


def inject(page, src):
    cfg = "window.__readaloudConfig = {base: '', token: '', voice: 'zh-CN-XiaoxiaoNeural', version: 'speed-test'};"
    return page.evaluate(
        """(src) => {
            const errs = [];
            try { (new Function(src))(); } catch (e) { errs.push(String((e && e.message) || e)); }
            return errs;
        }""",
        cfg + "\n" + src,
    )


def main():
    src = RENDERER.read_text(encoding="utf-8")
    tmpdir = tempfile.mkdtemp(prefix="readaloud-speed-")
    Path(tmpdir, "fixture.html").write_text(FIXTURE.replace("__LONG_TEXT__", LONG_TEXT), encoding="utf-8")
    httpd, port = serve_fixture(tmpdir)
    url = f"http://127.0.0.1:{port}/fixture.html"

    try:
        with sync_playwright() as p:
            browser = launch_args(p)
            page = browser.new_page()
            page.add_init_script(STUB)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on(
                "console",
                lambda m: errors.append("console.error: " + m.text) if m.type == "error" else None,
            )
            page.goto(url)

            js_errors = inject(page, src)
            check("渲染脚本注入无异常", not js_errors, js_errors)
            page.wait_for_timeout(150)

            # ---------- 1. 存在 / 位置 / 属性 ----------
            base = page.evaluate(
                """() => {
                    const bar = document.querySelector('[data-turn="1"] > div:last-child');
                    const ours = bar.querySelector('button[data-readaloud="1"]');
                    const spd = bar.querySelector('button[data-readaloud-speed="1"]');
                    const bar2 = document.querySelector('[data-turn="2"] > div:last-child');
                    const spd2 = bar2.querySelector('button[data-readaloud-speed="1"]');
                    const cs = spd ? getComputedStyle(spd) : null;
                    return {
                      count: document.querySelectorAll('button[data-readaloud-speed="1"]').length,
                      hasSpeed1: !!spd, hasSpeed2: !!spd2,
                      text: spd && spd.textContent,
                      aria: spd && spd.getAttribute('aria-label'),
                      title: spd && spd.getAttribute('title'),
                      type: spd && spd.getAttribute('type'),
                      ownFlag: spd && spd.getAttribute('data-readaloud'),
                      indexGap: spd ? [...bar.children].indexOf(spd) - [...bar.children].indexOf(ours) : -99,
                      fontSize: cs && cs.fontSize,
                      height: cs && parseFloat(cs.height),
                      padding: cs && (cs.paddingLeft + ' ' + cs.paddingRight),
                      bg: cs && cs.backgroundColor,
                      rate: window.__readaloudDebug.getRate(),
                    };
                }"""
            )
            check("两个助手操作栏各 1 个倍速按钮", base["count"] == 2 and base["hasSpeed1"] and base["hasSpeed2"],
                  json.dumps(base, ensure_ascii=False)[:180])
            check("倍速按钮文案 1.0×", base["text"] == "1.0×", base["text"])
            check("aria-label / title = 朗读倍速", base["aria"] == "朗读倍速" and base["title"] == "朗读倍速",
                  f"{base['aria']}/{base['title']}")
            check("type=button 且不带 data-readaloud（不与 🔊 计数混淆）",
                  base["type"] == "button" and base["ownFlag"] is None, f"{base['type']}/{base['ownFlag']}")
            check("紧跟在 🔊 之后（index gap = 1）", base["indexGap"] == 1, base["indexGap"])
            check("样式：11px / 高 18px（≤24 不撑高）/ 透明背景 / padding 0 2px",
                  base["fontSize"] == "11px" and base["height"] <= 24
                  and base["bg"] in ("rgba(0, 0, 0, 0)", "transparent")
                  and base["padding"] == "2px 2px",
                  f"font={base['fontSize']} h={base['height']} bg={base['bg']} pad={base['padding']}")
            check("初始倍速 1.0（localStorage 空）", base["rate"] == 1, base["rate"])

            # ---------- 2. 点击循环：文案 + localStorage + ttsUrl ----------
            steps = [(1.25, "1.25×"), (1.5, "1.5×"), (2, "2.0×"), (0.75, "0.75×"), (1, "1.0×")]
            labels, stored, urls, debug_rates = [], [], [], []
            for _ in range(5):
                page.click('[data-turn="1"] button[data-readaloud-speed="1"]')
                snap = page.evaluate(
                    """() => ({
                        label: document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]').textContent,
                        label2: document.querySelector('[data-turn="2"] button[data-readaloud-speed="1"]').textContent,
                        stored: window.localStorage.getItem('readaloud.rate'),
                        url: window.__readaloudDebug.ttsUrl('测试文本'),
                        rate: window.__readaloudDebug.getRate(),
                    })"""
                )
                labels.append(snap["label"])
                stored.append(snap["stored"])
                urls.append(snap["url"])
                debug_rates.append(snap["rate"])
                check("两回合文案同步", snap["label"] == snap["label2"], f"{snap['label']}/{snap['label2']}")

            check("连续 5 次点击文案依次 1.25× → 1.5× → 2.0× → 0.75× → 1.0×",
                  labels == [s[1] for s in steps], labels)
            check("localStorage['readaloud.rate'] 依次等于 1.25 / 1.5 / 2 / 0.75 / 1",
                  [float(x) for x in stored] == [s[0] for s in steps], stored)
            check("debug.getRate() 与点击序列一致", debug_rates == [s[0] for s in steps], debug_rates)
            check("ttsUrl() 的 rate 参数固定 +0%（不再随倍速换算，切速不重合成）",
                  all("%2B0%25" in u for u in urls),
                  [u.split("&")[2] for u in urls])

            # ---------- 3. accent 提示 ----------
            page.click('[data-turn="1"] button[data-readaloud-speed="1"]')  # 1.0 -> 1.25
            page.wait_for_timeout(300)  # 等 color/.15s ease 过渡跑完再读实算色
            accent = page.evaluate(
                """() => {
                    const b = document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]');
                    return { on: b.getAttribute('data-readaloud-speed-on'), color: getComputedStyle(b).color };
                }"""
            )
            page.evaluate("""() => { for (let i = 0; i < 4; i++) document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]').click(); }""")
            plain = page.evaluate(
                """() => {
                    const b = document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]');
                    return { on: b.getAttribute('data-readaloud-speed-on'), color: getComputedStyle(b).color, label: b.textContent };
                }"""
            )
            check("倍速 ≠ 1.0 时 accent 色提示（#4f9cf9 = rgb(79, 156, 249)）",
                  accent["on"] == "1" and accent["color"] == "rgb(79, 156, 249)", accent)
            check("回到 1.0 时取消提示", plain["on"] is None and plain["label"] == "1.0×", plain)

            # ---------- 4. 点击不冒泡、不触发播放 ----------
            page.evaluate(
                """() => {
                    window.__hostClicks = 0;
                    document.querySelector('[data-turn="1"] > div:last-child')
                      .addEventListener('click', () => { window.__hostClicks += 1; });
                    window.speechSynthesis.__log.length = 0;
                }"""
            )
            page.click('[data-turn="1"] button[data-readaloud-speed="1"]')
            bubble = page.evaluate(
                """() => ({
                    host: window.__hostClicks,
                    speaks: window.speechSynthesis.__log.filter(x => x.type === 'speak').length,
                    playing: !!document.querySelector('[data-turn="1"] button[data-readaloud="1"][aria-pressed="true"]'),
                })"""
            )
            check("点击倍速不冒泡到宿主操作栏、不启动播放",
                  bubble["host"] == 0 and bubble["speaks"] == 0 and not bubble["playing"], bubble)

            # ---------- 5. 降级路径 rate 跟随（当前 1.25） ----------
            page.evaluate("""() => window.speechSynthesis.__log.length = 0""")
            page.click('[data-turn="1"] button[data-readaloud="1"]')
            page.wait_for_timeout(80)
            fb = page.evaluate(
                """() => {
                    const u = window.speechSynthesis.pendingUtterance();
                    return { rate: u && u.rate, speaks: window.speechSynthesis.__log.filter(x => x.type === 'speak').length };
                }"""
            )
            check("speechSynthesis 降级 u.rate = 当前倍速 1.25",
                  fb["speaks"] >= 1 and fb["rate"] == 1.25, fb)

            # ---------- 6. 播放中改倍速：不中断，下一块生效 ----------
            page.evaluate("""() => { window.speechSynthesis.__log.length = 0; }""")
            page.click('[data-turn="2"] button[data-readaloud="1"]')
            page.wait_for_timeout(80)
            mid = page.evaluate(
                """() => ({
                    rate: window.speechSynthesis.pendingUtterance() && window.speechSynthesis.pendingUtterance().rate,
                    label: document.querySelector('[data-turn="2"] button[data-readaloud-speed="1"]').textContent,
                    playing: document.querySelector('[data-turn="2"] button[data-readaloud="1"]').getAttribute('data-readaloud-state'),
                })"""
            )
            # 此时倍速 1.25；点一次 → 1.5，然后手动结束第一块
            page.click('[data-turn="2"] button[data-readaloud-speed="1"]')
            page.evaluate("""() => { const u = window.speechSynthesis.pendingUtterance(); if (u && u.onend) u.onend({}); }""")
            page.wait_for_timeout(80)
            nextblk = page.evaluate(
                """() => {
                    const log = window.speechSynthesis.__log.filter(x => x.type === 'speak');
                    const b = document.querySelector('[data-turn="2"] button[data-readaloud="1"]');
                    return { rates: log.map(x => x.rate), n: log.length,
                             state: b.getAttribute('data-readaloud-state'), label: b.getAttribute('aria-label') };
                }"""
            )
            check("播放中改倍速不中断，下一块按新倍速 1.5 合成",
                  mid["rate"] == 1.25 and mid["playing"] == "playing"
                  and nextblk["n"] >= 2 and nextblk["rates"][0] == 1.25 and nextblk["rates"][1] == 1.5
                  and nextblk["state"] == "playing",
                  f"mid={mid} next={nextblk}")
            page.click('[data-turn="2"] button[data-readaloud="1"]')  # 停止

            # ---------- 7. MutationObserver 补回 ----------
            page.evaluate(
                """() => {
                    const b = document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]');
                    b.parentNode.removeChild(b);
                }"""
            )
            page.wait_for_timeout(500)
            back = page.evaluate(
                """() => {
                    const bar = document.querySelector('[data-turn="1"] > div:last-child');
                    const list = [...bar.querySelectorAll('button[data-readaloud-speed="1"]')];
                    const ours = bar.querySelector('button[data-readaloud="1"]');
                    return { n: list.length, text: list[0] && list[0].textContent,
                             gap: list[0] ? [...bar.children].indexOf(list[0]) - [...bar.children].indexOf(ours) : -99 };
                }"""
            )
            check("MutationObserver 补回倍速按钮（恰好 1 个、仍在 🔊 之后、文案保持 1.5×）",
                  back["n"] == 1 and back["gap"] == 1 and back["text"] == "1.5×", back)

            # ---------- 8. 整栏 clone 重渲染 ----------
            page.evaluate(
                """() => {
                    const turn = document.querySelector('[data-turn="1"]');
                    const bar = turn.lastElementChild;
                    turn.replaceChild(bar.cloneNode(true), bar);
                }"""
            )
            page.wait_for_timeout(500)
            cloned = page.evaluate(
                """() => {
                    const bar = document.querySelector('[data-turn="1"] > div:last-child');
                    return { n: bar.querySelectorAll('button[data-readaloud-speed="1"]').length,
                             text: (bar.querySelector('button[data-readaloud-speed="1"]') || {}).textContent };
                }"""
            )
            check("整栏 clone 重渲染后仍恰好 1 个倍速按钮", cloned["n"] == 1 and cloned["text"] == "1.5×", cloned)

            # ---------- 9. __readaloudReload() 从 localStorage 恢复 ----------
            reload_info = page.evaluate(
                """() => {
                    window.__readaloudReload();
                    const b = document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]');
                    return { label: b && b.textContent, rate: window.__readaloudDebug.getRate(),
                             stored: window.localStorage.getItem('readaloud.rate'),
                             count: document.querySelectorAll('button[data-readaloud-speed="1"]').length };
                }"""
            )
            check("__readaloudReload() 后倍速从 localStorage 恢复（1.5×）",
                  reload_info["label"] == "1.5×" and reload_info["rate"] == 1.5
                  and float(reload_info["stored"]) == 1.5 and reload_info["count"] == 2,
                  reload_info)

            # ---------- 10. dispose ----------
            disposed = page.evaluate(
                """() => {
                    window.__readaloudDispose();
                    return { speed: document.querySelectorAll('button[data-readaloud-speed="1"]').length,
                             main: document.querySelectorAll('button[data-readaloud="1"]').length };
                }"""
            )
            check("__readaloudDispose() 连倍速按钮一起摘掉", disposed["speed"] == 0 and disposed["main"] == 0, disposed)

            # ---------- 11. 整页 reload：localStorage 持久 ----------
            page.reload()
            page.wait_for_timeout(80)
            js_errors2 = inject(page, src)
            page.wait_for_timeout(120)
            persisted = page.evaluate(
                """() => {
                    const b = document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]');
                    return { label: b && b.textContent, rate: window.__readaloudDebug.getRate(),
                             stored: window.localStorage.getItem('readaloud.rate') };
                }"""
            )
            check("整页 reload 后倍速仍从 localStorage 恢复（1.5×）",
                  not js_errors2 and persisted["label"] == "1.5×" and persisted["rate"] == 1.5,
                  json.dumps(persisted, ensure_ascii=False))

            # ---------- 12. localStorage 非法值 / 非档位值 ----------
            page.evaluate("""() => window.localStorage.setItem('readaloud.rate', 'abc')""")
            page.evaluate("""() => window.__readaloudReload()""")
            invalid = page.evaluate(
                """() => {
                    const b = document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]');
                    return { label: b && b.textContent, rate: window.__readaloudDebug.getRate() };
                }"""
            )
            check("localStorage 非法值（abc）回落 1.0×", invalid["label"] == "1.0×" and invalid["rate"] == 1, invalid)

            page.evaluate("""() => window.localStorage.setItem('readaloud.rate', '1.75')""")
            page.evaluate("""() => window.__readaloudReload()""")
            custom = page.evaluate(
                """() => {
                    const b = document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]');
                    return { label: b && b.textContent, rate: window.__readaloudDebug.getRate() };
                }"""
            )
            page.click('[data-turn="1"] button[data-readaloud-speed="1"]')
            after_custom = page.evaluate(
                """() => ({
                    label: document.querySelector('[data-turn="1"] button[data-readaloud-speed="1"]').textContent,
                    stored: window.localStorage.getItem('readaloud.rate'),
                })"""
            )
            check("非档位值 1.75 正常保留，点击后进下一档 2.0×",
                  custom["label"] == "1.75×" and custom["rate"] == 1.75
                  and after_custom["label"] == "2.0×" and float(after_custom["stored"]) == 2,
                  f"{custom} -> {after_custom}")

            check("页面无 JS 运行时错误", not errors, errors[:3] or "none")
            browser.close()
    finally:
        httpd.shutdown()
        shutil.rmtree(tmpdir, ignore_errors=True)

    failed = [r for r in results if not r[1]]
    print()
    print(("ALL PASS (%d checks)" % len(results)) if not failed
          else ("%d FAILED / %d" % (len(failed), len(results))))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
