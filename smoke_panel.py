#!/usr/bin/env python3
"""read-aloud 面板真实浏览器冒烟（Playwright + Chrome）。

加载 panel.html（standalone），用假 host 桥接 postMessage 协议，断言：
  1. DOM 控件齐（音色下拉、倍速、朗读、停止、进度、转写区、状态行）
  2. 无 fetch/XHR/WebSocket（CSP 合规）
  3. VOICE_LIST 8 音色（从 DOM option 数量验证）
  4. 点朗读 → host 收到 speak_session 调用 → 返回 chunks → 渲染转写 → 请求 chunk 0
  5. host 返回 dataUri → Audio play（stub）→ ended → 请求 chunk 1 → ended → 请求 chunk 2
  6. 走完 3 块 → finishRun → 状态行「朗读完成」
  7. 停止 → 无后续请求
  8. 倍速/音色控件存在且变更不报错
  9. 零 page error

用法：C:/Users/Nefelibata/AppData/Local/Programs/Python/Python312/python.exe smoke_panel.py <panel.html>
退出码：0 = 全部通过；1 = 有失败项；2 = 用法错误。
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

REQUIRED_SELECTORS = [
    "#ra-voice",
    "#ra-rate",
    "#ra-speak",
    "#ra-stop",
    "#ra-progress",
    "#ra-progress-bar",
    "#ra-transcript",
    "#ra-status",
    "#ra-hint",
    "#ra-session-note",
]

BANNED_APIS = ["fetch(", "XMLHttpRequest", "WebSocket"]


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: python smoke_panel.py <panel.html>")
        return 2
    target = Path(sys.argv[1]).resolve()
    if not target.is_file():
        print("FAIL 文件不存在: " + str(target))
        return 1

    failures: list[str] = []
    notes: list[str] = []
    page_errors: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", args=["--no-sandbox"])
        page = browser.new_page()
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))

        # 假 host 桥 + Audio patch：在页面加载前注入
        # panel.html 是 standalone（window.parent === window），所以 host 桥在同一页面
        # Audio patch：play() 返回 resolved promise，100ms 后触发 ended
        # 这样 ended 链能真实走完（不再因假音频 reject 而断在 chunk 0）
        page.add_init_script("""
        // 假 host 桥
        window.__raHost = {
          calls: [],
          stopped: false,
        };
        window.addEventListener('message', function (event) {
          var msg = event.data;
          if (!msg || typeof msg !== 'object') return;
          // 只处理请求（有 method 字段）
          if (!msg.method || msg.method !== 'tools/call') return;
          var params = msg.params || {};
          window.__raHost.calls.push({ name: params.name, args: params.arguments || {} });

          if (params.name === 'speak_session') {
            var payload = {
              ok: true,
              requestId: 'req_test_001',
              sessionId: 'sess_HOSTTEST',
              sessionSource: 'meta',
              voice: 'zh-CN-XiaoxiaoNeural',
              rate: 0,
              chunks: [
                { index: 0, role: 'user', label: '用户', text: '第一句。', charCount: 5 },
                { index: 1, role: 'assistant', label: '助手', text: '第二句。', charCount: 5 },
                { index: 2, role: 'user', label: '用户', text: '第三句。', charCount: 5 }
              ],
              totalChars: 15,
              truncated: false
            };
            window.postMessage({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: JSON.stringify(payload) }] }
            }, '*');
          } else if (params.name === 'speak_chunk') {
            if (window.__raHost.stopped) return;
            var idx = (params.arguments || {}).index || 0;
            var payload = {
              ok: true,
              requestId: 'req_test_001',
              index: idx,
              text: '第' + (idx + 1) + '句。',
              voice: 'zh-CN-XiaoxiaoNeural',
              rate: 0,
              dataUri: 'data:audio/mpeg;base64,//4A',
              bytes: 4,
              cached: false
            };
            window.postMessage({
              jsonrpc: '2.0', id: msg.id,
              result: { content: [{ type: 'text', text: JSON.stringify(payload) }] }
            }, '*');
          }
        });

        // Audio patch：拦截 src setter（阻止浏览器解码假音频触发 error），
        // play() 返回 resolved，100ms 后触发 ended
        // 必须在 panel 脚本加载前安装
        var OriginalAudio = window.Audio;
        window.Audio = function (src) {
          var audio = new OriginalAudio();
          // 拦截 src setter：不真正设置 src，避免浏览器尝试解码触发 error 事件
          Object.defineProperty(audio, 'src', {
            set: function(val) { this._src = val; },
            get: function() { return this._src || ''; },
            configurable: true
          });
          audio.play = function () {
            // 返回 resolved promise（不真正播放）
            setTimeout(function () {
              audio.dispatchEvent(new Event('ended'));
            }, 100);
            return Promise.resolve();
          };
          return audio;
        };
        """)

        page.goto(target.as_uri())
        page.wait_for_timeout(800)

        # 1. DOM 控件齐
        for selector in REQUIRED_SELECTORS:
            if page.locator(selector).count() == 0:
                failures.append("缺少 DOM 控件: " + selector)

        # 2. 静态扫描：无网络请求 API
        markup = page.content()
        for banned in BANNED_APIS:
            if banned in markup:
                failures.append("出现禁用 API: " + banned)

        # 3. 音色下拉 8 项
        options = page.eval_on_selector_all("#ra-voice option", "els => els.map(el => el.value)")
        notes.append("音色下拉选项 %d 个" % len(options))
        if len(options) != 8:
            failures.append("音色下拉应 8 项，实际 %d 项" % len(options))

        # 4. 点朗读 → host 收到 speak_session → 返回 chunks → 渲染转写
        page.locator("#ra-speak").click()
        page.wait_for_timeout(2000)

        calls = page.evaluate("window.__raHost.calls")
        notes.append("host 收到 %d 次调用" % len(calls))
        if not calls:
            failures.append("点朗读后 host 未收到 speak_session 调用")
        else:
            names = [c["name"] for c in calls]
            notes.append("调用序列: " + ", ".join(names))
            if "speak_session" not in names:
                failures.append("应先调用 speak_session")
            # 应至少请求 chunk 0 和 chunk 1（ended 链推进）
            chunk_calls = [c for c in calls if c["name"] == "speak_chunk"]
            notes.append("speak_chunk 调用 %d 次" % len(chunk_calls))
            if len(chunk_calls) < 2:
                failures.append("ended 链应推进到 chunk 1（至少 2 次 speak_chunk 调用），实际 %d 次" % len(chunk_calls))

        # 5. 转写区渲染
        transcript_text = page.locator("#ra-transcript").inner_text()
        notes.append("转写区文本: " + transcript_text[:80])
        if "第一句" not in transcript_text:
            failures.append("转写区未渲染 chunks")

        # 6. 进度条更新 + finishRun
        status_text = page.locator("#ra-status").inner_text()
        notes.append("状态行: " + status_text)
        # 等更长时间让 3 块都走完
        page.wait_for_timeout(2000)
        status_text_after = page.locator("#ra-status").inner_text()
        notes.append("等待后状态行: " + status_text_after)
        if "朗读完成" not in status_text_after:
            failures.append("3 块走完后应显示「朗读完成」，实际: " + status_text_after)

        calls_final = page.evaluate("window.__raHost.calls")
        chunk_calls_final = [c for c in calls_final if c["name"] == "speak_chunk"]
        notes.append("最终 speak_chunk 调用 %d 次" % len(chunk_calls_final))
        if len(chunk_calls_final) < 3:
            failures.append("3 块链应走完 3 次 speak_chunk，实际 %d 次" % len(chunk_calls_final))

        # 7. 停止 → 无后续请求
        page.evaluate("window.__raHost.stopped = true")
        page.locator("#ra-stop").click()
        page.wait_for_timeout(500)
        calls_after_stop = page.evaluate("window.__raHost.calls")
        chunk_calls_after_stop = [c for c in calls_after_stop if c["name"] == "speak_chunk"]
        notes.append("停止后 speak_chunk 调用 %d 次" % len(chunk_calls_after_stop))
        # 停止后不应有新请求
        if len(chunk_calls_after_stop) > len(chunk_calls_final) + 1:
            failures.append("停止后仍发出请求")

        # 8. 倍速变更不报错
        page.select_option("#ra-rate", "1.5")
        page.wait_for_timeout(200)
        page.select_option("#ra-rate", "1")
        page.wait_for_timeout(200)
        notes.append("倍速变更完成")

        # 9. 音色变更不报错
        page.select_option("#ra-voice", options[-1])
        page.wait_for_timeout(200)
        notes.append("音色变更完成")

        if page_errors:
            failures.append("page error %d 个: %s" % (len(page_errors), page_errors[:3]))

        browser.close()

    for note in notes:
        print("NOTE " + note)
    if failures:
        for item in failures:
            print("FAIL " + item)
        print("smoke_panel: FAIL（%d 项）" % len(failures))
        return 1
    print("smoke_panel: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
