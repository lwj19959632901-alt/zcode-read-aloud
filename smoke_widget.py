#!/usr/bin/env python3
"""read-aloud widget 真实浏览器冒烟（Playwright + Chrome）。

加载 render.py 产出的 standalone HTML（片段在沙箱 iframe 内），断言：
  1. DOM 标记齐、根 id 唯一、无 page error
  2. 片段内无 fetch / XMLHttpRequest / WebSocket
  3. speechSynthesis 有 zh-CN 语音
  4. 点朗读 → onend 真实触发、高亮推进
  5. 倍速变更 → window.zcode.setWidgetState 写入 privateContent.rate
  6. 停止 → cancel 被调用、状态回到「已停止」

用法：python3 smoke_widget.py <standalone.html>
退出码：0 = 全部通过；1 = 有失败项；2 = 用法错误。
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

REQUIRED_SELECTORS = [
    "#read-aloud-widget",
    "#ra-speak",
    "#ra-pause",
    "#ra-stop",
    "#ra-rate",
    "#ra-progress",
    "#ra-progress-bar",
    "#ra-transcript",
    "#ra-data",
    "#ra-status",
    "#ra-hint",
]

BANNED_APIS = ["fetch(", "XMLHttpRequest", "WebSocket"]

PATCH_SCRIPT = """
() => {
  const record = { spoken: 0, ended: 0, cancelled: 0, stateWrites: [] };
  window.__raProbe = record;
  const synth = window.speechSynthesis;
  if (synth) {
    const originalSpeak = synth.speak.bind(synth);
    synth.speak = function (utterance) {
      record.spoken += 1;
      const previous = typeof utterance.onend === "function" ? utterance.onend : null;
      utterance.onend = function (event) {
        record.ended += 1;
        if (previous) previous(event);
      };
      return originalSpeak(utterance);
    };
    const originalCancel = synth.cancel.bind(synth);
    synth.cancel = function () {
      record.cancelled += 1;
      return originalCancel();
    };
  }
  if (window.zcode && typeof window.zcode.setWidgetState === "function") {
    const originalSet = window.zcode.setWidgetState.bind(window.zcode);
    window.zcode.setWidgetState = function (next) {
      record.stateWrites.push(next);
      return Promise.resolve(originalSet(next)).then(
        function () {},
        function () {}
      );
    };
  }
}
"""


def main() -> int:
    if len(sys.argv) != 2:
        print("用法: python3 smoke_widget.py <standalone.html>")
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
        page.goto(target.as_uri())
        page.wait_for_timeout(900)

        frame = next((candidate for candidate in page.frames if candidate != page.main_frame), None)
        if frame is None:
            failures.append("找不到片段 iframe（render.py 应把 fragment 包在沙箱 iframe 里）")
            frame = None

        if frame is not None:
            frame.wait_for_timeout(300)

            # 1. DOM 标记 + 根 id 唯一
            for selector in REQUIRED_SELECTORS:
                if frame.locator(selector).count() == 0:
                    failures.append("缺少 DOM 标记: " + selector)
            root_count = frame.locator("#read-aloud-widget").count()
            if root_count != 1:
                failures.append("根 id #read-aloud-widget 应唯一，实际 %d 个" % root_count)
            sentences = frame.locator('[id^="ra-sent-"]').count()
            notes.append("句子 span 数量: %d" % sentences)
            if sentences <= 0:
                failures.append("没有渲染出句子 span")

            # 2. 静态扫描：无网络请求 API
            markup = frame.content()
            for banned in BANNED_APIS:
                if banned in markup:
                    failures.append("片段出现禁用 API: " + banned)

            # 3. zh-CN 语音
            voices = frame.evaluate(
                "() => { try {"
                " const synth = window.speechSynthesis;"
                " return synth ? synth.getVoices().map((v) => v.lang) : [];"
                "} catch (err) { return []; } }"
            )
            zh_voices = [lang for lang in voices if str(lang).lower().startswith("zh")]
            notes.append("speechSynthesis 语音 %d 个，其中 zh-CN %d 个" % (len(voices), len(zh_voices)))
            if not zh_voices:
                failures.append("浏览器没有 zh-CN 语音，朗读按钮应被禁用")

            # 4/5/6. 交互
            speak_button = frame.locator("#ra-speak")
            if speak_button.is_disabled():
                failures.append("朗读按钮被禁用")
            else:
                frame.evaluate(PATCH_SCRIPT)
                speak_button.click()
                if speak_button.get_attribute("aria-pressed") != "true":
                    failures.append("朗读中 aria-pressed 应为 true")
                try:
                    frame.wait_for_function(
                        "() => window.__raProbe && window.__raProbe.ended >= 1", timeout=45000
                    )
                    notes.append("点朗读后 onend 已触发（真实浏览器链路通）")
                except Exception as exc:  # noqa: BLE001 - Playwright 超时即失败项
                    failures.append("点朗读后 onend 未触发: " + str(exc).splitlines()[0])

                active_index = frame.evaluate(
                    "() => { const el = document.querySelector('.ra-sent.is-active');"
                    " return el ? Number(el.id.replace('ra-sent-', '')) : -1; }"
                )
                notes.append("当前高亮句索引: %s" % active_index)
                if isinstance(active_index, int) and active_index < 0:
                    failures.append("没有高亮句")

                # 倍速偏好写入
                try:
                    frame.select_option("#ra-rate", "1.5")
                    frame.wait_for_function(
                        "() => window.__raProbe && window.__raProbe.stateWrites.length >= 1", timeout=10000
                    )
                    writes = frame.evaluate("() => window.__raProbe.stateWrites")
                    last = writes[-1]
                    rate = (last or {}).get("privateContent", {}).get("rate")
                    notes.append("setWidgetState 写入倍速: %s" % rate)
                    if rate != 1.5:
                        failures.append("倍速偏好未正确写入，实际: %r" % (rate,))
                except Exception as exc:  # noqa: BLE001
                    failures.append("倍速写入未触发: " + str(exc).splitlines()[0])

                # 停止
                frame.locator("#ra-stop").click()
                try:
                    frame.wait_for_function(
                        "() => { const el = document.getElementById('ra-status');"
                        " return el && el.textContent.indexOf('已停止') >= 0; }",
                        timeout=10000,
                    )
                except Exception as exc:  # noqa: BLE001
                    failures.append("点击停止后状态未回到已停止: " + str(exc).splitlines()[0])
                probe = frame.evaluate("() => window.__raProbe")
                notes.append(
                    "speak %d 次 / onend %d 次 / cancel %d 次"
                    % (probe["spoken"], probe["ended"], probe["cancelled"])
                )
                if probe["cancelled"] < 1:
                    failures.append("停止未调用 speechSynthesis.cancel()")
                if frame.locator("#ra-hint").is_visible():
                    failures.append("有中文语音时不应显示缺语音提示")

        if page_errors:
            failures.append("page error %d 个: %s" % (len(page_errors), page_errors[:3]))

        browser.close()

    for note in notes:
        print("NOTE " + note)
    if failures:
        for item in failures:
            print("FAIL " + item)
        print("smoke_widget: FAIL（%d 项）" % len(failures))
        return 1
    print("smoke_widget: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
