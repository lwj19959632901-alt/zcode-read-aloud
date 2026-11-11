#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""readaloud + statusbar 双补丁 watcher（v3，常驻版）

常驻等 ZCode 完全退出 -> 等 Update.exe / elevate.exe 静默（Squirrel 换包期间不动 asar）
-> 清残留 install_monitor（防 asar 竞态）-> 装 zusage 状态条补丁 -> 装 readaloud 消息栏
按键补丁 -> check -> 对比 app.asar sha256：变化才重启 ZCode，无变化不重启；本轮结束后
回等待下一次退出（7 天超时退出，由计划任务 ZCode-ReadAloudWatcher 重新武装）。

对 v2 三个缺陷的修复：
  1. wmic 在 Win11 26300 已不存在（清 monitor 永远失败，日志 WinError 2 实证）
     -> 改走 pwsh 全路径 + Get-CimInstance；匹配串在 pwsh 里运行时拼接，
     "install_monitor" 字面量不出现在任何进程命令行里（防自杀）；
  2. 硬编码 1.5.3 插件路径（插件已升 1.5.16）-> 从 installed_plugins.json 动态解析
     zusage 插件当前版本目录；
  3. 一次性、装完必重启 -> 常驻多轮自愈，且仅当 app.asar sha256 真的变化才重启
     （只在补丁实际落地后重启宿主是 2026-11-04 已验收的既定流程）。

用法：
  python readaloud-keys-watcher.py            # 常驻主循环
  python readaloud-keys-watcher.py selftest   # 离线决策链自检（不碰真实 asar、不杀真进程、不真重启）
"""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

HOME = Path(os.path.expanduser("~"))
LOG = HOME / ".zcode" / "readaloud-keys-watcher.log"    # 追加写，不截断（沿用 v2 同一文件）
HERE = Path(__file__).resolve().parent
PATCH = HERE / "patch-readaloud.py"
ASAR = Path(r"D:\ZCode\resources\app.asar")
ZCODE_EXE = Path(r"D:\ZCode\ZCode.exe")
PWSH = Path(r"C:\Program Files\PowerShell\7\pwsh.exe")  # pwsh 一律全路径（禁短名/WindowsApps 桩）
DEADLINE_DAYS = 7
POLL_SECS = 2


def _resolve_py() -> Path:
    """安装器用的 python 全路径：优先当前解释器，兜底本机默认安装位（不硬编码用户名）。"""
    exe = Path(sys.executable) if getattr(sys, "executable", "") else None
    if exe is not None and exe.is_file():
        return exe
    return HOME / "AppData" / "Local" / "Programs" / "Python" / "Python312" / "python.exe"


PY = _resolve_py()


def log(msg: str) -> None:
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    try:
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def zcode_alive() -> bool:
    """ZCode 是否在跑（tasklist 全量查，写法同 v2）；异常按在跑处理（保守，不动 asar）。"""
    try:
        out = subprocess.run(["tasklist"], capture_output=True, text=True,
                             timeout=30, encoding="gbk", errors="replace").stdout or ""
        return "zcode.exe" in out.lower()
    except Exception:
        return True


def update_or_elevate_running() -> bool:
    """Squirrel 更新器（Update.exe / elevate.exe，大小写不敏感）是否在跑；异常按在跑处理。"""
    try:
        out = subprocess.run(["tasklist"], capture_output=True, text=True,
                             timeout=30, encoding="gbk", errors="replace").stdout or ""
    except Exception:
        return True
    low = out.lower()
    return "update.exe" in low or "elevate.exe" in low


def build_kill_script() -> str:
    """构造「清残留 monitor」的 pwsh 脚本文本（selftest 会断言防自杀不变量）。

    匹配串必须在 pwsh 里运行时拼接（'install' + '_monitor'），保证 "install_monitor"
    字面量不出现在任何进程命令行里——否则本函数自己起的 pwsh 子进程命令行会命中
    过滤器（自杀）。另加 Name=python.exe 过滤双保险。
    输出一行：KILLED=<n>（已清净）或 LEFT=<n>（杀完复查仍有存活）。
    """
    return "\n".join([
        "$ErrorActionPreference = 'Stop'",
        "$m = 'install' + '_monitor'",
        "$targets = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like ('*' + $m + '*') })",
        "$killed = 0",
        "foreach ($t in $targets) { try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop; $killed++ } catch { } }",
        "Start-Sleep -Milliseconds 400",
        "$left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like ('*' + $m + '*') })",
        "if ($left.Count -gt 0) { 'LEFT=' + $left.Count } else { 'KILLED=' + $killed }",
    ])


def kill_install_monitors() -> bool:
    """清残留 install_monitor（zusage 的等待安装进程，会与本次安装竞态换入旧包）。

    返回 True=已清净；False=杀完复查仍有存活，或 pwsh 执行失败（fail-safe：本轮不动 asar）。
    """
    try:
        r = subprocess.run([str(PWSH), "-NoProfile", "-Command", build_kill_script()],
                           capture_output=True, text=True, timeout=120,
                           encoding="utf-8", errors="replace")
    except Exception as e:
        log(f"  清 monitor 异常（fail-safe 中止）：{e}")
        return False
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    if r.returncode != 0:
        log(f"  清 monitor pwsh 退出码 {r.returncode}（fail-safe 中止）：{out[:200]}")
        return False
    if out.startswith("LEFT="):
        log(f"  杀完复查仍有 {out[5:].split()[0]} 个 monitor 存活，未清净")
        return False
    log(f"  残留 monitor 已清净（{out}）")
    return True


def sha256_file(path) -> str:
    """流式块哈希（不整包读进内存）。"""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def resolve_overlay_install():
    """从 installed_plugins.json 动态解析 zusage 状态条插件的 overlay_install.py。

    插件升级会换版本目录（v2 硬编码 1.5.3 已随 1.5.16 失效）；按 name + id 前缀
    定位当前安装版本。任何失败返回 None（调用方跳过状态条，继续装朗读键）。
    """
    try:
        raw = (HOME / ".zcode" / "cli" / "plugins" / "installed_plugins.json").read_text(encoding="utf-8")
        entries = json.loads(raw).get("plugins") or []
    except (OSError, ValueError) as e:
        log(f"  installed_plugins.json 读取/解析失败：{e}")
        return None
    for ent in entries:
        if not isinstance(ent, dict):
            continue
        if (ent.get("name") == "zcode-token-usage-statusbar"
                and str(ent.get("id", "")).startswith("zcode-token-usage-statusbar@")):
            cand = Path(str(ent.get("installPath", ""))) / "overlay_install.py"
            if cand.is_file():
                return cand
            log(f"  zusage installPath 下无 overlay_install.py：{cand}")
            return None
    log("  installed_plugins.json 未找到 zcode-token-usage-statusbar 条目")
    return None


def run(label: str, script, arg: str):
    """跑安装器子命令，尾部 12 行进日志（沿用 v2 run_installer 的日志格式）。

    返回退出码；启动/超时异常返回 None（调用方按非 2 处理，安装器输出已自证）。
    """
    log(f"[{label}] 执行 {Path(script).name} {arg}")
    try:
        r = subprocess.run([str(PY), str(script), arg], capture_output=True, text=True,
                           timeout=900, encoding="utf-8", errors="replace")
    except Exception as e:
        log(f"[{label}] 启动异常：{e}")
        return None
    tail = []
    for line in ((r.stdout or "") + "\n" + (r.stderr or "")).splitlines():
        if line.strip():
            tail.append(line.strip()[:260])
    for line in tail[-12:]:
        log(f"  {label}> {line}")
    if r.returncode != 0:
        log(f"[{label}] 失败 exit={r.returncode}")
    else:
        log(f"[{label}] 成功 exit=0")
    return r.returncode


def restart_zcode() -> bool:
    """重启 ZCode（仅在补丁实际落地、asar sha 变化后调用）。"""
    try:
        subprocess.Popen([str(ZCODE_EXE)], close_fds=True)
        return True
    except Exception as e:
        log(f"重启 ZCode 失败：{e}")
        return False


def one_round() -> str:
    """ZCode 已完全退出后的一轮装补丁决策。返回动作标签（selftest 逐个断言）。"""
    # Update.exe 静默期：Squirrel 正在换包时不动 asar（等它结束或 ZCode 复活）
    waited = 0
    while update_or_elevate_running() and waited < 180:
        time.sleep(POLL_SECS)
        waited += POLL_SECS
    if update_or_elevate_running():
        log(f"更新器（Update/elevate）静默期 {waited}s 后仍在跑，本轮中止")
        return "abort-updater"
    if zcode_alive():
        log("更新器静默期后 ZCode 已复活，本轮中止")
        return "abort-revived"
    # 清残留 monitor（防竞态：它会换入不含朗读行的旧 tmp）
    if not kill_install_monitors():
        log("install monitor 未清净，本轮中止（不动 asar）")
        return "abort-monitor"
    # zusage 状态条安装器：动态解析（插件升级会换版本目录，v2 硬编码 1.5.3 已失效）
    overlay = resolve_overlay_install()
    try:
        asar_before = sha256_file(ASAR)
    except OSError as e:
        log(f"装前读 asar 指纹失败，本轮中止（不动 asar）：{e}")
        return "abort-asar-read"
    if overlay is not None:
        run("状态条", overlay, "install")          # 非零退出：记日志，继续装朗读键（v2 语义）
    else:
        log("跳过状态条（zusage 插件路径解析失败），继续装朗读键")
    r1 = run("朗读键", PATCH, "install")
    if r1 == 2:
        # exit 2 = 客户端又在跑（安装器自己的输出已自证），本轮结束回等待
        log("安装时客户端又在运行（exit 2），本轮结束")
        return "abort-client-running"
    run("朗读键check", PATCH, "check")             # 非零只记日志：重启与否只看 sha 对比
    try:
        asar_after = sha256_file(ASAR)
    except OSError as e:
        log(f"装后读 asar 指纹失败，不重启（留待下一轮）：{e}")
        return "abort-asar-read-after"
    if asar_after != asar_before:
        log(f"补丁已落地（asar sha {asar_before[:12]}… -> {asar_after[:12]}…），重启 ZCode")
        restart_zcode()
        return "restart"
    log("asar 无变化，不重启")
    return "no-change"


def main() -> None:
    log("=== watcher v3 启动（常驻：等退出装双补丁，仅 sha 变化才重启；7 天超时）===")
    if not PATCH.is_file():
        log(f"patch-readaloud.py 不存在：{PATCH} —— watcher 退出（检查仓库位置）")
        return
    deadline = datetime.now() + timedelta(days=DEADLINE_DAYS)
    # 启动即视为「已见过 ZCode 在跑」：开机 ZCode 未跑也直接处理一轮（设计行为，
    # 见 README「升级 ZCode 之后」）。本轮结束后必须再见到 ZCode 在跑，才会处理
    # 它的下一次退出——否则 ZCode 一直关着时会空转反复装。
    seen_alive = True
    while True:
        if datetime.now() > deadline:
            log(f"{DEADLINE_DAYS} 天超时——watcher 退出（计划任务 ZCode-ReadAloudWatcher 会重新武装）")
            return
        if zcode_alive():
            seen_alive = True
            time.sleep(POLL_SECS)
            continue
        if not seen_alive:
            time.sleep(POLL_SECS)
            continue
        log("ZCode 已完全退出（tasklist 2s 轮询捕获）")
        try:
            action = one_round()
        except Exception as e:                     # 常驻兜底：单轮异常不倒整个 watcher
            action = f"abort-exception:{type(e).__name__}"
            log(f"本轮异常（已吞掉，回等待）：{e}")
        seen_alive = False
        log(f"本轮结束（{action}），回等待下一次 ZCode 退出")


# ---------------------------------------------------------------- selftest

def cmd_selftest() -> int:
    print("[selftest] watcher v3 离线决策链自检（不碰真实 asar、不杀真进程、不真重启）")
    failures = 0

    def ok_(msg):
        print("  PASS  " + msg, flush=True)

    def bad_(msg):
        nonlocal failures
        failures += 1
        print("  FAIL  " + msg, flush=True)

    # --- 1) 防自杀回归：杀 monitor 的 pwsh script 不含 install_monitor 字面量（运行时拼接构造）
    script = build_kill_script()
    if "install_monitor" not in script and "'install'" in script and "'_monitor'" in script:
        ok_("kill script 运行时拼接构造，不含 install_monitor 字面量（防自杀）")
    else:
        bad_("kill script 含 install_monitor 字面量或未用拼接构造")

    # --- 2) 动态解析 zusage 插件路径（读真实 installed_plugins.json）
    overlay = resolve_overlay_install()
    if overlay is not None and "1.5.16" in str(overlay) and overlay.is_file():
        ok_(f"overlay_install.py 动态解析成功：{overlay}")
    else:
        bad_(f"overlay 解析失败或路径不含 1.5.16：{overlay}")

    # --- 3) 决策链打桩（tempfile 临时目录 + monkeypatch，跑完整一轮）
    tmpdir = Path(tempfile.mkdtemp(prefix="readaloud-watcher-selftest-"))
    stub_asar = tmpdir / "app.asar"
    stub_log = tmpdir / "watcher.log"

    saved = {}

    def swap(name, value):
        saved.setdefault(name, globals()[name])
        globals()[name] = value

    orig_sleep = time.sleep
    sleep_log = []
    time.sleep = lambda s: sleep_log.append(s)

    def fresh_asar(payload=b"stub-asar-payload-v1"):
        stub_asar.write_bytes(payload)
        return sha256_file(stub_asar)

    class _SeqDone(Exception):
        pass

    try:
        swap("LOG", stub_log)
        swap("ASAR", stub_asar)

        # 3a) 更新器不死等：永远在跑 -> 静默期 180s 封顶后中止，不动 asar
        swap("zcode_alive", lambda: False)
        swap("update_or_elevate_running", lambda: True)
        swap("kill_install_monitors", lambda: True)
        run_calls = []

        def run_rec(label, script, arg):
            run_calls.append((label, arg))
            return 0
        swap("run", run_rec)
        restarted = []
        swap("restart_zcode", lambda: restarted.append(1) or True)
        sha0 = fresh_asar()
        action = one_round()
        if (action == "abort-updater" and sha256_file(stub_asar) == sha0
                and not run_calls and not restarted):
            ok_("更新器不死等：静默期封顶后 abort-updater，不动 asar、不装、不重启")
        else:
            bad_(f"更新器场景异常：action={action} run={run_calls} restart={len(restarted)}")
        if len(sleep_log) >= 90 and all(s == POLL_SECS for s in sleep_log):
            ok_(f"静默期按 {POLL_SECS}s 步进封顶 180s（{len(sleep_log)} 次等待）")
        else:
            bad_(f"静默期步进异常：{len(sleep_log)} 次等待 {sorted(set(sleep_log))}")

        # 3b) monitor 杀不净 -> 本轮中止且不动 asar（更新器先忙两步再静默）
        updater_seq = iter([True, True, False, False, False])
        swap("update_or_elevate_running", lambda: next(updater_seq))
        swap("kill_install_monitors", lambda: False)
        run_calls.clear()
        restarted.clear()
        sha0 = fresh_asar()
        action = one_round()
        if (action == "abort-monitor" and sha256_file(stub_asar) == sha0
                and not run_calls and not restarted):
            ok_("monitor 杀不净：abort-monitor，不动 asar、不装、不重启")
        else:
            bad_(f"monitor 场景异常：action={action} run={run_calls} restart={len(restarted)}")

        # 3c) 装完 sha 不变 -> 不重启（check 已跑）
        swap("update_or_elevate_running", lambda: False)
        swap("kill_install_monitors", lambda: True)
        run_calls.clear()
        restarted.clear()
        sha0 = fresh_asar()
        action = one_round()
        if (action == "no-change" and not restarted
                and sha256_file(stub_asar) == sha0
                and any(arg == "check" for _, arg in run_calls)):
            ok_("装完 sha 不变：no-change，不重启（check 已跑）")
        else:
            bad_(f"no-change 场景异常：action={action} run={run_calls} restart={len(restarted)}")

        # 3d) sha 变了才重启（朗读键 install 落盘 = sha 变化）
        def run_patch_applies(label, script, arg):
            run_calls.append((label, arg))
            if label == "朗读键" and arg == "install":
                stub_asar.write_bytes(b"stub-asar-payload-v1" + b"\n;import patched")
            return 0
        swap("run", run_patch_applies)
        run_calls.clear()
        restarted.clear()
        fresh_asar()
        action = one_round()
        if action == "restart" and len(restarted) == 1:
            ok_("sha 变了才重启：restart 且仅重启一次")
        else:
            bad_(f"restart 场景异常：action={action} restart={len(restarted)}")

        # 3e) install exit 2（客户端又在跑）-> 本轮结束回等待：不跑 check、不动 asar、不重启
        def run_exit2(label, script, arg):
            run_calls.append((label, arg))
            return 2 if arg == "install" else 0
        swap("run", run_exit2)
        run_calls.clear()
        restarted.clear()
        sha0 = fresh_asar()
        action = one_round()
        if (action == "abort-client-running" and not restarted
                and sha256_file(stub_asar) == sha0
                and not any(arg == "check" for _, arg in run_calls)):
            ok_("install exit 2：abort-client-running，不跑 check、不动 asar、不重启")
        else:
            bad_(f"exit2 场景异常：action={action} run={run_calls} restart={len(restarted)}")

        # 3f) 常驻回等待：装完一轮后 ZCode 未再跑不重复处理；再见 alive 后才处理下一次退出
        round_log = []
        swap("one_round", lambda: round_log.append(datetime.now()) or "no-change")
        alive_seq = iter([False, False, True, False, False])

        def fake_alive():
            try:
                return next(alive_seq)
            except StopIteration:
                raise _SeqDone()
        swap("zcode_alive", fake_alive)
        swap("update_or_elevate_running", lambda: False)
        swap("kill_install_monitors", lambda: True)
        swap("run", lambda label, script, arg: 0)
        try:
            main()
        except _SeqDone:
            pass
        if len(round_log) == 2:
            ok_("常驻回等待：一轮后 ZCode 未再跑不重复处理，再见 alive 后才处理下一次退出（共 2 轮）")
        else:
            bad_(f"主循环轮次异常：{len(round_log)} 轮（期望 2）")
    finally:
        time.sleep = orig_sleep
        for name, value in saved.items():
            globals()[name] = value
        try:
            for f in tmpdir.iterdir():
                f.unlink(missing_ok=True)
            tmpdir.rmdir()
        except OSError:
            print(f"  ..    临时目录未清理干净：{tmpdir}")

    print()
    if failures == 0:
        print("[selftest] PASS")
        return 0
    print(f"[selftest] FAIL（{failures} 项）")
    return 1


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        sys.exit(cmd_selftest())
    main()
