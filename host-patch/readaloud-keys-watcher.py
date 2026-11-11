#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""readaloud + statusbar 双补丁 watcher（v3，常驻版）

常驻等 ZCode 完全退出 -> 等自动更新器静默（换包期间不动 asar）
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

v3 后审修复（2026-11-11）：
  - 更新器探测改为**按可执行文件路径判定**（P1-1）：ZCode 3.18.0 走 electron-updater
    generic provider（app-update.yml: provider: generic），不是 Squirrel——更新器产物在
    %LOCALAPPDATA%\\@zcodedesktop-updater\\（installer.exe、pending\\ZCode-*-win-x64.exe），
    旧的 tasklist 全表子串匹配 "update.exe" 既盯不到真更新器，又会被 GoogleUpdate.exe /
    DropboxUpdate.exe 误命中；
  - 重启前复检客户端（P1-2）：杀 ZCode 到重启之间用户可能自己拉起客户端，此时不再重复拉起；
  - install 退出码非 0/2 一律中止本轮（P2-7）：装完校验失败之类不许继续走 sha 对比与重启；
  - 轮询 5s（P2-3）：tasklist 全量查询实测 1.6-2.5s，2s 名义周期实际约 4s，日均枚举 2.16 万次；
  - 陈旧大文件只记录不删（P2-6）：app.asar.orig 是插件回滚备份，绝不当恢复源。

v3 复审 P2 修复（2026-11-11）：
  - null-path 不再按进程名兜底（P2-2）：ExecutablePath 读不到（SYSTEM/受保护进程，本机约 24 个）
    的进程**一律不视为更新器**，只计数上报。旧口径在 null-path 分支按进程名匹配，而名单里
    有 installer.exe 这种通用名 —— 机器上只要有一个 SYSTEM 级同名进程，每轮都判「更新器
    在跑」，自愈永久静默失效且只留一行日志；
  - Squirrel provider 兼容（P2-3）：同时读 app-update.yml 的 provider 字段；provider 含
    squirrel 时额外认 %LOCALAPPDATA% 下的 Squirrel 产物（历史布局
    %LOCALAPPDATA%\\<appId>\\app-<ver>\\Update.exe，既不在缓存目录也不在安装目录）；
  - 连续轮次告警（P2-4）：fail-closed（查不到/出错按「在跑」）的失败模式是永久静默 ——
    连续 N 轮判定「在跑」就追加一条写明两种可能的告警，某轮判「不在跑」即清零；
  - ExecutionTimeLimit 因果注释修正（P2-1）：register-task.ps1 里「每小时任务会砍掉 watcher」
    的说法不成立（arm 脚本 Start-Process 无 -Wait，任务本体只活约 1 秒，从不拥有 watcher
    进程），改成防御性表述。

用法：
  python readaloud-keys-watcher.py            # 常驻主循环
  python readaloud-keys-watcher.py selftest   # 离线决策链自检（不碰真实 asar、不杀真进程、不真重启）
"""
import errno
import hashlib
import json
import os
import re
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
POLL_SECS = 5          # P2-3：tasklist 全量查询实测 1.6-2.5s，2s 名义周期实际约 4s，日均 2.16 万次枚举

# P2-4：更新器探测 fail-closed（查不到/出错一律按「在跑」）的失败模式是**永久静默** ——
# 若探测持续异常（探测过宽 / CIM 挂了），自愈会无声地一直不生效，而每轮只留一行日志。
# 故记「连续判定为在跑」的轮数：达到阈值就追加一条写明两种可能的告警；
# 某轮判定为「不在跑」即清零（UPDATER_ALERT_REPEAT 只控制超过阈值后多久再报一次，避免刷屏）。
UPDATER_ALERT_AFTER = 3       # 连续判定「在跑」达到该轮数即告警
UPDATER_ALERT_REPEAT = 12     # 超过阈值后每多少轮再报一次（3、12、24、36…）
UPDATER_RUNNING_STREAK = 0    # 连续判定为「更新器在跑」的轮数（0 = 上一轮不在跑）
_UPDATER_NOPATH_LAST = -1     # 上次上报的 null-path 进程数（变化时才记日志）

# P2-6：resources 下的陈旧大文件。每轮开始只记录存在与大小，**禁止删除**：
#   - app.asar.zusage.tmp       ：zusage 状态条重打包中间产物（384MB）
#   - app.asar.orig             ：插件回滚备份，比现役旧一个月 —— 绝不可当恢复源
#   - app.asar.readaloud-stage  ：中断的 readaloud repack 残留（384MB）
STALE_BIG_FILES = ("app.asar.zusage.tmp", "app.asar.orig", "app.asar.readaloud-stage")

# 单实例独占锁文件。选 ~/.zcode/ 而不是脚本同目录（HERE）有三个理由：
#   1) host-patch/ 是 git 仓库目录，丢一个 .lock 在那儿会让 `git status` 常驻一条
#      未跟踪噪声（而仓库只该有那一个被改的源码文件）；
#   2) ~/.zcode/ 已经是本 watcher 的运行态目录（日志就写在那儿），运行态归一处；
#      （注：~/.zcode 是指向 D:\ZCodeData\app-data 的 junction，锁文件实体即
#      D:\ZCodeData\app-data\readaloud-keys-watcher.lock，与日志同目录）
#   3) 路径与「从哪份脚本启动」无关 —— README 的手动兜底路径和计划任务路径指向同一把
#      锁，跨副本也只有一个实例能跑。
LOCK = HOME / ".zcode" / "readaloud-keys-watcher.lock"

_LOCK_FD = None   # 持锁的裸 fd（int，不会被 GC 关闭；main() 局部变量亦持有同一引用）


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


def acquire_lock(path: Path | None = None):
    """跨进程独占锁（单实例守卫）。返回 (fd, reason)：拿到锁时 (fd, "")，拿不到时 (None, 中文原因)。

    语义要点：
      - OS 级锁：进程退出/被杀时由 OS 自动释放 —— 不留死锁，崩了下次照常拿锁；
      - 非阻塞：锁被占时立刻失败（第二个实例必须马上退出，不能等超时）；
      - Windows 用 msvcrt.locking(LK_NBLCK) 锁 1 字节，POSIX 用 fcntl.flock(LOCK_EX|LOCK_NB)。
      写法与同机 zusage 插件 runtime_lock.py 的 file_lock() 同款（那边是带超时重试的变体，
      这里要求「拿不到立刻退出」，故不重试）。
    fd 是裸 int，Python 不会替我们关闭它；调用方必须持有到进程结束（见 main()）。
    """
    target = LOCK if path is None else Path(path)
    try:
        fd = os.open(os.fspath(target), os.O_RDWR | os.O_CREAT, 0o600)
    except OSError as e:
        return None, f"独占锁不可用（打不开锁文件 {target}：{e}）"
    try:
        if os.name == "nt":
            import msvcrt
            if os.fstat(fd).st_size == 0:
                os.write(fd, b"\0")
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as e:
        os.close(fd)
        if e.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
            return None, "已有 watcher 在跑（独占锁被占用）"
        return None, f"独占锁不可用（加锁失败：{e}）"
    return fd, ""


def release_lock(fd: int) -> None:
    """释放独占锁并关 fd（正常退出路径用；进程被杀时 OS 会自动回收）。"""
    try:
        if os.name == "nt":
            import msvcrt
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass
    finally:
        try:
            os.close(fd)
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
    """ZCode 自动更新器是否在跑；**按可执行文件路径判定**（P1-1）。

    查不到 / 出错 / 解析不出标记 -> 一律按「在跑」处理（保守：宁可不装，也不与
    安装器并发改 app.asar）。这种 fail-closed 若**持续**发生就等于自愈静默失效，
    故连续多轮判定「在跑」会追加一条明确告警（P2-4，见 record_updater_verdict）。
    """
    running, reason = probe_updater()
    record_updater_verdict(running, reason)
    return running


def probe_updater() -> tuple[bool, str]:
    """真正去探一次更新器，返回 (running, reason)。

    running=True 有两种来源，reason 里写明：
      - 命中更新器路径规则（真更新器在跑）；
      - 探测本身失败（pwsh 起不来 / 退出码非 0 / 输出无法解析）—— fail-closed 保守
        按「在跑」处理，但 reason 会标明，让 P2-4 的连续告警能看出是哪一种。
    """
    script = build_updater_script()
    env = dict(os.environ)
    env["READALOUD_UPDATER_DIR_NAME"] = resolve_updater_cache_dir_name()
    env["READALOUD_UPDATER_PROVIDER"] = resolve_updater_provider()
    try:
        r = subprocess.run([str(PWSH), "-NoProfile", "-Command", script],
                           capture_output=True, text=True, timeout=120,
                           encoding="utf-8", errors="replace", env=env)
    except Exception as e:
        return True, f"pwsh 调用异常（fail-closed）：{e}"
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    # null-path 计数（读不到 ExecutablePath 的进程数）：只上报，不参与判定（P2-2）
    m_np = re.search(r"NOPATH=(\d+)", out)
    if m_np:
        note_nullpath_count(int(m_np.group(1)))
    if r.returncode != 0:
        return True, f"pwsh 退出码 {r.returncode}（fail-closed）"
    m = re.search(r"UPDATER=(\d)", out)
    if m is None:
        return True, "pwsh 输出无法解析（fail-closed）"
    if m.group(1) != "0":
        return True, "命中更新器路径规则"
    return False, "未命中更新器路径规则"


def record_updater_verdict(running: bool, reason: str = "") -> int:
    """记录一轮「更新器是否在跑」的判定；连续在跑达阈值就打一条明确告警。

    P2-4：fail-closed（查不到/出错一律按「在跑」）的失败模式是**永久静默** ——
    探测若持续异常（探测过宽、CIM 挂了），自愈会无声地一直不生效，而每轮只留一行日志。
    这里把连续「在跑」的轮数记下来，达到阈值就追加一条**写明两种可能**的告警：
      - 更新器真的在跑（等它换完包即可）；
      - 探测过宽 / CIM 异常（机器上有个通用名的进程就会这样）导致自愈被静默卡死。
    判定为「不在跑」时计数清零。返回当前连续轮数。
    """
    global UPDATER_RUNNING_STREAK
    if not running:
        if UPDATER_RUNNING_STREAK:
            log(f"更新器探测恢复为「不在跑」，连续在跑计数清零（此前 {UPDATER_RUNNING_STREAK} 轮）")
        UPDATER_RUNNING_STREAK = 0
        return 0
    UPDATER_RUNNING_STREAK += 1
    n = UPDATER_RUNNING_STREAK
    if n == UPDATER_ALERT_AFTER or (n > UPDATER_ALERT_AFTER and n % UPDATER_ALERT_REPEAT == 0):
        log(f"更新器探测连续 {n} 轮判定为在跑：可能是更新器真的在跑，"
            f"也可能是探测过宽/CIM 异常导致自愈静默，请检查"
            f"（本轮判定依据：{reason or '未记录'}）")
    return n


def updater_streak_reset() -> None:
    """把「连续在跑」计数清零（selftest 用；正常运行靠「不在跑」自动清零）。"""
    global UPDATER_RUNNING_STREAK
    UPDATER_RUNNING_STREAK = 0


def note_nullpath_count(n: int) -> None:
    """null-path 进程数上报（P2-2）：读不到 ExecutablePath 的进程数变化时记一行。

    这类进程（SYSTEM / 受保护进程，本机约 24 个）**一律不视为更新器**，也不按进程名
    兜底；这里只把数量报出来，便于事后判断「探测口径是不是太宽」。
    """
    global _UPDATER_NOPATH_LAST
    if n == _UPDATER_NOPATH_LAST:
        return
    _UPDATER_NOPATH_LAST = n
    if n > 0:
        log(f"更新器探测：{n} 个进程读不到 ExecutablePath（SYSTEM/受保护进程），"
            f"按「不视为更新器」处理（null-path 不按进程名匹配）")


def resolve_updater_cache_dir_name(yml_text: str | None = None) -> str:
    """读 app-update.yml 的 updaterCacheDirName（electron-updater 缓存目录名）。

    本机实测 D:\\ZCode\\resources\\app-update.yml：
        provider: generic
        updaterCacheDirName: "@zcodedesktop-updater"
    electron-updater 的缓存目录 = %LOCALAPPDATA%\\<updaterCacheDirName>\\（里面是
    installer.exe 与 pending\\<包名>.exe）。从配置文件读，宿主改 appId 也不会失效；
    读不到就退回内置默认名。

    yml_text：仅供 selftest 注入样本（None 时读真实文件）。
    """
    default = "@zcodedesktop-updater"
    text = yml_text
    if text is None:
        try:
            text = (ASAR.parent / "app-update.yml").read_text(encoding="utf-8", errors="replace")
        except OSError:
            return default
    m = re.search(r"^\s*updaterCacheDirName:\s*[\"']?([^\"'\s#]+)", text, re.M)
    if m and m.group(1):
        return m.group(1)
    return default


def resolve_updater_provider(yml_text: str | None = None) -> str:
    """读 app-update.yml 的 provider 字段（generic / squirrel / ...）。

    本机实测 D:\\ZCode\\resources\\app-update.yml 是 provider: generic（electron-updater）。
    P2-3：历史 Squirrel 布局（provider: squirrel）的更新器产物在
    %LOCALAPPDATA%\\<appId>\\app-<ver>\\Update.exe —— 既不在 updaterCacheDirName 缓存目录、
    也不在 ZCode 安装目录，只靠路径规则会漏判，故 provider 也要读。

    yml_text：仅供 selftest 注入样本（None 时读真实文件）。
    """
    default = "generic"
    text = yml_text
    if text is None:
        try:
            text = (ASAR.parent / "app-update.yml").read_text(encoding="utf-8", errors="replace")
        except OSError:
            return default
    m = re.search(r"^\s*provider:\s*[\"']?([^\"'\s#]+)", text, re.M)
    if m and m.group(1):
        return m.group(1)
    return default


def build_updater_script() -> str:
    """构造「更新器是否在跑」的 pwsh 脚本文本（selftest 断言按路径判定）。

    口径（P1-1 按路径 + P2-2 null-path 不按名 + P2-3 squirrel provider）：
      - 进程可执行路径位于 %LOCALAPPDATA%\\<updaterCacheDirName>\\ 下 -> 更新器在跑
        （installer.exe 与 pending\\ZCode-<版本>-win-x64.exe 都在这个目录里；
         目录名由 app-update.yml 的 updaterCacheDirName 给出，经环境变量传给 pwsh，
         读不到则用内置默认名 '@zcodedesktop' + '-updater'）；
      - 进程可执行路径位于 ZCode 安装目录（由 asar 路径反推）且进程名属于
        {Update.exe, elevate.exe, installer.exe, ZCode-*-win-x64.exe} -> 更新器在跑；
      - provider 含 squirrel 时（P2-3，经环境变量 READALOUD_UPDATER_PROVIDER 传入）：
        可执行路径位于 %LOCALAPPDATA% 下且进程名属于 {Update.exe, elevate.exe} ->
        更新器在跑（Squirrel 布局 %LOCALAPPDATA%\\<appId>\\app-<ver>\\Update.exe 既不在
        缓存目录也不在安装目录）；非 squirrel provider 下这条规则不生效；
      - **ExecutablePath 读不到（SYSTEM / 受保护进程）一律不视为更新器**（P2-2）：
        旧口径在这里按进程名兜底，而名单里有 installer.exe 这种通用名 —— 机器上只要
        有一个 SYSTEM 级同名进程，每轮都判「更新器在跑」，自愈永久静默失效且只留一行
        日志。真实更新器进程位于用户可读的更新器缓存目录，路径本就读得到；这类进程
        只计数上报（输出 NOPATH=<n>），不参与判定；
      - 其余进程一律不管：**不再**做 tasklist 全表子串匹配（旧口径既盯不到真更新器，
        又会被 GoogleUpdate.exe / DropboxUpdate.exe 之类误命中，白白中止 180s）。

    匹配串在 pwsh 里运行时拼接（'Update' + '.exe' 等），本函数自己起的 pwsh 子进程
    命令行里不出现完整字面量（防自命中）；且本进程的可执行路径既不在更新器目录、
    也不在 ZCode 安装目录，双重保证不会把自己当成更新器。
    输出：NOPATH=<n>（读不到路径的进程数，只上报）+ UPDATER=1 / UPDATER=0。
    """
    return "\n".join([
        "$ErrorActionPreference = 'Stop'",
        "$updName = $env:READALOUD_UPDATER_DIR_NAME",
        "if (-not $updName) { $updName = '@zcodedesktop' + '-updater' }",
        "$updDir = (Join-Path $env:LOCALAPPDATA $updName).TrimEnd('\\')",
        "$localDir = $env:LOCALAPPDATA.TrimEnd('\\')",
        "$instDir = (Split-Path -Parent (Split-Path -Parent '" + str(ASAR) + "')).TrimEnd('\\')",
        "$prov = $env:READALOUD_UPDATER_PROVIDER",
        "if (-not $prov) { $prov = 'gen' + 'eric' }",
        "$isSquirrel = $prov.ToLower().Contains('squir' + 'rel')",
        "# 名字集合每项都要加括号：PowerShell 数组字面量里 ',' 的结合比 '+' 更紧，",
        "# @('a' + 'b', 'c' + 'd') 会被拼成单个字符串 'ab cd'（实测 Count=1），-contains 永远 False",
        "$names = @(('Update' + '.exe'), ('elevate' + '.exe'), ('install' + 'er.exe'))",
        "$sqNames = @(('Update' + '.exe'), ('elevate' + '.exe'))",
        "$pat = 'ZCode-' + '*-win-x64.exe'",
        "$hit = 0",
        "$nopath = 0",
        "foreach ($p in (Get-CimInstance Win32_Process -ErrorAction Stop)) {",
        "    $name = $p.Name",
        "    if (-not $name) { continue }",
        "    $path = $p.ExecutablePath",
        "    if (-not $path) {",
        "        # NULLPATH-BEGIN：读不到 ExecutablePath（SYSTEM / 受保护进程）",
        "        #   一律不视为更新器，也不按进程名兜底（通用名进程会永久把自愈卡死），",
        "        #   只计数上报。",
        "        $nopath++",
        "        continue",
        "        # NULLPATH-END",
        "    }",
        "    $np = $path.TrimEnd('\\')",
        "    if ($np.StartsWith($updDir + '\\', [System.StringComparison]::OrdinalIgnoreCase)) { $hit++; continue }",
        "    if ($np.StartsWith($instDir + '\\', [System.StringComparison]::OrdinalIgnoreCase)) {",
        "        if ($names -contains $name -or $name -like $pat) { $hit++ }",
        "        continue",
        "    }",
        "    if ($isSquirrel -and $np.StartsWith($localDir + '\\', [System.StringComparison]::OrdinalIgnoreCase)) {",
        "        if ($sqNames -contains $name) { $hit++ }",
        "    }",
        "}",
        "'NOPATH=' + $nopath",
        "if ($hit -gt 0) { 'UPDATER=1' } else { 'UPDATER=0' }",
    ])


def build_kill_script() -> str:
    """构造「清残留 monitor」的 pwsh 脚本文本（selftest 会断言防自杀不变量）。

    匹配口径收窄为**脚本名** install_monitor.py（P2-1）：旧口径是裸子串 "install_monitor"
    匹配整条命令行，任何命令行里提到这个词的无关 python 进程都会被强杀。现在按
    「路径分隔符/空白 + install_monitor.py + 非单词字符」的脚本名 token 匹配，
    只有真的在跑 zusage 那个 install_monitor.py 的进程才会被杀。

    匹配串必须在 pwsh 里运行时拼接（'install' + '_monitor'），保证 "install_monitor"
    字面量不出现在任何进程命令行里——否则本函数自己起的 pwsh 子进程命令行会命中
    过滤器（自杀）。另加 Name 过滤双保险（python.exe / pythonw.exe：zusage 的监控
    既可能由 python.exe 拉起，也可能由 WMI 脱离式 pythonw.exe 拉起，两者都算）。
    输出一行：KILLED=<n>（已清净）或 LEFT=<n>（杀完复查仍有存活）。
    """
    return "\n".join([
        "$ErrorActionPreference = 'Stop'",
        "$m = 'install' + '_monitor'",
        r"$re = '(?:^|[\s\\/])' + $m + '\.py(?![A-Za-z0-9_])'",
        "$targets = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -match $re })",
        "$killed = 0",
        "foreach ($t in $targets) { try { Stop-Process -Id $t.ProcessId -Force -ErrorAction Stop; $killed++ } catch { } }",
        "Start-Sleep -Milliseconds 400",
        "$left = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('python.exe','pythonw.exe') -and $_.CommandLine -match $re })",
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


def run(label: str, script, arg: str, env: dict | None = None):
    """跑安装器子命令，尾部 12 行进日志（沿用 v2 run_installer 的日志格式）。

    env：额外注入的环境变量（覆盖式叠加在本进程环境之上，不传则继承）。
    返回退出码；启动/超时异常返回 None（调用方按非 0/2 处理，安装器输出已自证）。
    """
    log(f"[{label}] 执行 {Path(script).name} {arg}")
    child_env = None
    if env:
        child_env = dict(os.environ)
        child_env.update(env)
    try:
        r = subprocess.run([str(PY), str(script), arg], capture_output=True, text=True,
                           timeout=900, encoding="utf-8", errors="replace", env=child_env)
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


def log_stale_big_files() -> None:
    """P2-6：每轮开始只**记录** resources 下陈旧大文件的存在与大小（禁止删除）。

    app.asar.orig 是插件的回滚备份（比现役旧一个月），既不能删也不能当恢复源；
    app.asar.zusage.tmp / app.asar.readaloud-stage 是中断的 repack 残留，同理只记录。
    """
    d = ASAR.parent
    for name in STALE_BIG_FILES:
        p = d / name
        try:
            if p.is_file():
                mb = p.stat().st_size / (1024 * 1024)
                log(f"陈旧大文件（只记录不删）：{p} {mb:.1f} MB")
        except OSError as e:
            log(f"陈旧大文件探查失败（忽略）：{p} {e}")


def one_round() -> str:
    """ZCode 已完全退出后的一轮装补丁决策。返回动作标签（selftest 逐个断言）。"""
    # P2-6：每轮开头记录陈旧大文件（只记录，不删）
    log_stale_big_files()
    # 自动更新器静默期：更新器正在换包时不动 asar（等它结束或 ZCode 复活）
    waited = 0
    while update_or_elevate_running() and waited < 180:
        time.sleep(POLL_SECS)
        waited += POLL_SECS
    if update_or_elevate_running():
        log(f"更新器（按路径判定）静默期 {waited}s 后仍在跑，本轮中止"
            f"（连续判定在跑 {UPDATER_RUNNING_STREAK} 轮；见上方连续轮次告警）")
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
        # P2-5：zusage 的 launch_monitor 在 Windows 走 CREATE_NEW_CONSOLE —— 自愈时会在
        # 桌面弹一个黑窗。ZUSAGE_MONITOR_QUIET=1 是 zusage 自带的静默开关（已实测：
        # patch_install.py:294 / overlay_install.py:994 都认它，走 WMI 脱离式 pythonw
        # 或 CREATE_NO_WINDOW，无窗口）。只给状态条 install 这一步加，不影响别的步骤。
        run("状态条", overlay, "install", env={"ZUSAGE_MONITOR_QUIET": "1"})
        # 非零退出：记日志，继续装朗读键（v2 语义）
    else:
        log("跳过状态条（zusage 插件路径解析失败），继续装朗读键")
    r1 = run("朗读键", PATCH, "install")
    if r1 == 2:
        # exit 2 = 客户端又在跑（安装器自己的输出已自证），本轮结束回等待
        log("安装时客户端又在运行（exit 2），本轮结束")
        return "abort-client-running"
    if r1 not in (0, 2):
        # P2-7：非 0/2 = 安装本身失败（装完校验失败、权限、磁盘……）。这种状态绝不能
        # 继续走 sha 对比与重启：asar 可能处于半截状态，重启等于把坏包送给用户。
        log(f"安装未成功（exit={r1}），本轮中止（不重启、不动 asar）")
        return "abort-install-failed"
    run("朗读键check", PATCH, "check")             # 非零只记日志：重启与否只看 sha 对比
    try:
        asar_after = sha256_file(ASAR)
    except OSError as e:
        log(f"装后读 asar 指纹失败，不重启（留待下一轮）：{e}")
        return "abort-asar-read-after"
    if asar_after != asar_before:
        # P1-2：重启前复检客户端 —— 从杀 ZCode 到这里的几十秒里用户可能自己拉起了
        # 客户端，此时再拉一个就是双开窗口。
        if zcode_alive():
            log("客户端已自行启动，不重复重启")
            return "skip-restart-client-alive"
        log(f"补丁已落地（asar sha {asar_before[:12]}… -> {asar_after[:12]}…），重启 ZCode")
        restart_zcode()
        return "restart"
    log("asar 无变化，不重启")
    return "no-change"


def main() -> None:
    global _LOCK_FD
    # 单实例守卫：先抢跨进程独占锁。锁由 OS 随进程退出自动释放（崩了/被杀都不留
    # 死锁，下次启动照常拿锁）；锁被占说明已有 watcher 在跑（计划任务与 README 手动
    # 兜底各起了一份），必须立刻退出——两个 watcher 并发会对同一个 app.asar 同时
    # repack（竞态，可能产出半截包）并各重启一次 ZCode（双开）。
    lock_fd, lock_reason = acquire_lock()
    if lock_fd is None:
        log(f"{lock_reason}，本次退出，避免并发改 asar")
        return
    _LOCK_FD = lock_fd                    # 全局持有引用，确保 fd 活到进程结束
    try:
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
            log(f"ZCode 已完全退出（tasklist {POLL_SECS}s 轮询捕获）")
            try:
                action = one_round()
            except Exception as e:                     # 常驻兜底：单轮异常不倒整个 watcher
                action = f"abort-exception:{type(e).__name__}"
                log(f"本轮异常（已吞掉，回等待）：{e}")
            seen_alive = False
            log(f"本轮结束（{action}），回等待下一次 ZCode 退出")
    finally:
        release_lock(lock_fd)
        _LOCK_FD = None


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

    # --- 1b) P2-1：kill 匹配收窄到脚本名 install_monitor.py（不再是裸子串全表匹配）
    if (".py" in script and "'_monitor'" in script
            and "'*' + $m + '*'" not in script and "-like ('*' + $m" not in script):
        ok_("kill script 只匹配 install_monitor.py 脚本名（不再是裸子串全表匹配）")
    else:
        bad_("kill script 匹配未收窄到 install_monitor.py 脚本名")

    # --- 1c) P1-1：更新器探测按可执行文件路径判定，无裸 'update.exe' 全表子串匹配
    uscript = build_updater_script()
    ulow = uscript.lower()
    if ("executablepath" in ulow and "zcodedesktop" in ulow
            and "update.exe" not in ulow and "elevate.exe" not in ulow):
        ok_("更新器探测按 ExecutablePath 判定（zcodedesktop-updater 目录），无裸 update.exe 全表匹配")
    else:
        bad_("更新器探测脚本不符合按路径判定（缺 ExecutablePath / zcodedesktop，或仍含裸 update.exe 匹配）")

    # --- 1d) 名字集合每项加括号：PowerShell 数组字面量里 ',' 比 '+' 结合更紧，
    #     @('a' + 'b', 'c' + 'd') 会拼成单个字符串（实测 Count=1），-contains 永远 False
    if "$names = @(('Update' + '.exe')" in uscript:
        ok_("更新器名字集合每项加括号（防 PowerShell 数组字面量把三项拼成一串）")
    else:
        bad_("更新器名字集合未逐项加括号（PowerShell 会拼成单串，-contains 永远 False）")

    # --- 1e) P2-2：null-path（ExecutablePath 读不到）分支**不按进程名匹配** ——
    #     旧口径在这里按名字兜底，名单里的通用名（install + er.exe）会让机器上任意
    #     一个同名 SYSTEM 进程永久把自愈卡死（只留一行日志）
    npath_block = ""
    if "NULLPATH-BEGIN" in uscript and "NULLPATH-END" in uscript:
        npath_block = uscript.split("NULLPATH-BEGIN", 1)[1].split("NULLPATH-END", 1)[0]
    if (npath_block and "$nopath++" in npath_block
            and "-contains $name" not in npath_block
            and "-like $pat" not in npath_block
            and "$names" not in npath_block):
        ok_("null-path 分支不做进程名匹配（只计数上报，不视为更新器）")
    else:
        bad_(f"null-path 分支仍按名字匹配：block={npath_block!r}")

    # --- 1f) P2-2：脚本输出 null-path 计数，供日志上报
    if "NOPATH=" in uscript and "$nopath = 0" in uscript:
        ok_("更新器脚本输出 null-path 计数（NOPATH=<n>）供日志上报")
    else:
        bad_("更新器脚本未输出 null-path 计数")

    # --- 1g) P2-3：读 app-update.yml 的 provider 字段（本机 generic；样本 squirrel）
    prov_real = resolve_updater_provider()
    prov_squ = resolve_updater_provider("provider: squirrel\nupdaterCacheDirName: \"x-updater\"\n")
    prov_gen = resolve_updater_provider("provider: generic\n")
    if prov_real == "generic" and prov_squ == "squirrel" and prov_gen == "generic":
        ok_(f"app-update.yml provider 读取正确（本机={prov_real}，样本 squirrel={prov_squ}）")
    else:
        bad_(f"provider 读取异常：real={prov_real} squ={prov_squ} gen={prov_gen}")

    # --- 1h) P2-3：provider 含 squirrel 时才启用 %LOCALAPPDATA% 下的 squirrel 规则
    if ("READALOUD_UPDATER_PROVIDER" in uscript and "$isSquirrel" in uscript
            and "$localDir" in uscript and "$sqNames" in uscript):
        ok_("Squirrel 规则按 provider 字段启用（%LOCALAPPDATA% 下 + 专属进程名集合）")
    else:
        bad_("Squirrel provider 规则缺失（未读 provider 或无 %LOCALAPPDATA% 分支）")

    # --- 1i) P2-3：squirrel 名字集合只含 Update/elevate 两个，不含通用名
    sq_line = next((ln for ln in uscript.splitlines() if "$sqNames" in ln and "@(" in ln), "")
    if sq_line and "install" not in sq_line:
        ok_("Squirrel 名字集合只含 Update/elevate（不含通用名 installer）")
    else:
        bad_(f"Squirrel 名字集合异常：{sq_line!r}")

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
        # 单实例锁也换成临时文件：selftest 内部会调 main()，不能跟真 watcher 抢锁
        # （真 watcher 持锁时 main() 会立刻返回，导致主循环断言误判）。
        swap("LOCK", tmpdir / "selftest-watch.lock")

        # --- 3i) P2-4：连续 N 轮判定「更新器在跑」-> 追加一条写明两种可能的告警；
        #     判定「不在跑」即清零（fail-closed 的永久静默不再无声）
        streak_log = tmpdir / "streak.log"
        swap("LOG", streak_log)
        updater_streak_reset()
        n1 = record_updater_verdict(True, "自测：命中更新器路径")
        n2 = record_updater_verdict(True, "自测：命中更新器路径")
        mid_log = streak_log.read_text(encoding="utf-8", errors="replace") if streak_log.exists() else ""
        n3 = record_updater_verdict(True, "自测：命中更新器路径")
        end_log = streak_log.read_text(encoding="utf-8", errors="replace") if streak_log.exists() else ""
        if (n1 == 1 and n2 == 2 and n3 == 3
                and "连续" not in mid_log
                and "连续 3 轮判定为在跑" in end_log
                and "探测过宽" in end_log and "请检查" in end_log):
            ok_("连续轮次告警：连续 3 轮判定在跑才打告警（前 2 轮静默），告警写明两种可能")
        else:
            bad_(f"连续轮次告警异常：n={n1},{n2},{n3} mid={mid_log!r} end={end_log!r}")
        n0 = record_updater_verdict(False, "自测：更新器未在跑")
        n_again = record_updater_verdict(True, "自测：命中更新器路径")
        if n0 == 0 and n_again == 1:
            ok_("连续计数：判定「不在跑」即清零（再次在跑从 1 重新计）")
        else:
            bad_(f"连续计数清零异常：n0={n0} n_again={n_again}")
        updater_streak_reset()
        swap("LOG", stub_log)

        # 3a) 更新器不死等：永远在跑 -> 静默期 180s 封顶后中止，不动 asar
        swap("zcode_alive", lambda: False)
        swap("update_or_elevate_running", lambda: True)
        swap("kill_install_monitors", lambda: True)
        run_calls = []
        env_calls = []          # 记录每次 run() 传下去的 env（断言 P2-5 静默开关）

        def run_rec(label, script, arg, env=None):
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
        if len(sleep_log) * POLL_SECS >= 180 and all(s == POLL_SECS for s in sleep_log):
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
        def run_patch_applies(label, script, arg, env=None):
            run_calls.append((label, arg))
            env_calls.append((label, env))
            if label == "朗读键" and arg == "install":
                stub_asar.write_bytes(b"stub-asar-payload-v1" + b"\n;import patched")
            return 0
        swap("run", run_patch_applies)
        run_calls.clear()
        restarted.clear()
        env_calls.clear()
        fresh_asar()
        action = one_round()
        if action == "restart" and len(restarted) == 1:
            ok_("sha 变了才重启：restart 且仅重启一次")
        else:
            bad_(f"restart 场景异常：action={action} restart={len(restarted)}")

        # 3d-2) P2-5：状态条 install 这一步带 ZUSAGE_MONITOR_QUIET=1（zusage 自带静默开关，
        #       自愈时不弹黑窗）；别的步骤不带这个变量
        bar_env = next((e for lb, e in env_calls if lb == "状态条"), None)
        other_env = [e for lb, e in env_calls if lb != "状态条"]
        if (bar_env and bar_env.get("ZUSAGE_MONITOR_QUIET") == "1"
                and all(not e for e in other_env)):
            ok_("状态条 install 带 ZUSAGE_MONITOR_QUIET=1（静默，不弹黑窗），其余步骤不带")
        else:
            bad_(f"状态条 env 异常：bar={bar_env} others={other_env}")

        # 3e) install exit 2（客户端又在跑）-> 本轮结束回等待：不跑 check、不动 asar、不重启
        def run_exit2(label, script, arg, env=None):
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

        # 3f) P1-2 重启前复检客户端：用户自己拉起了 ZCode -> 跳过重启（不双开窗口）
        #     打桩：zcode_alive 第 1 次调用（轮次开头）返回 False，第 2 次（重启前）返回 True
        alive_calls = []

        def alive_alive_on_recheck():
            alive_calls.append(1)
            return len(alive_calls) >= 2
        swap("zcode_alive", alive_alive_on_recheck)

        def run_patch_applies2(label, script, arg, env=None):
            run_calls.append((label, arg))
            if label == "朗读键" and arg == "install":
                stub_asar.write_bytes(b"stub-asar-payload-v1" + b"\n;import patched")
            return 0
        swap("run", run_patch_applies2)
        run_calls.clear()
        restarted.clear()
        alive_calls.clear()
        fresh_asar()
        action = one_round()
        if (action == "skip-restart-client-alive" and not restarted
                and len(alive_calls) >= 2):
            ok_("重启前复检客户端：用户已自行启动 -> 跳过重启，不重复拉起（非 abort）")
        else:
            bad_(f"重启前复检异常：action={action} restart={len(restarted)} alive_calls={len(alive_calls)}")

        # 3g) P2-7 install 退出码 1（非 0/2，装完校验失败等）-> 本轮中止：不跑 check、
        #     不动 asar、不重启
        def run_exit1(label, script, arg, env=None):
            run_calls.append((label, arg))
            return 1 if arg == "install" else 0
        swap("run", run_exit1)
        swap("zcode_alive", lambda: False)
        run_calls.clear()
        restarted.clear()
        sha0 = fresh_asar()
        action = one_round()
        if (action == "abort-install-failed" and not restarted
                and sha256_file(stub_asar) == sha0
                and not any(arg == "check" for _, arg in run_calls)):
            ok_("install exit 1：abort-install-failed，不跑 check、不动 asar、不重启")
        else:
            bad_(f"exit1 场景异常：action={action} run={run_calls} restart={len(restarted)}")

        # 3h) 常驻回等待：装完一轮后 ZCode 未再跑不重复处理；再见 alive 后才处理下一次退出
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
        swap("run", lambda label, script, arg, env=None: 0)
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

    # --- 4) 单实例独占锁：同进程内两个不同 fd 抢同一把锁 -> 第二个必须立刻失败
    #     （本机实测：Windows msvcrt.locking 对同一区域重复锁定抛 PermissionError
    #      errno 13(EACCES)；POSIX fcntl.flock 同进程第二个 fd 拿 EX 锁也会 EAGAIN）
    lock_dir = Path(tempfile.mkdtemp(prefix="readaloud-watcher-lock-"))
    try:
        same_path = lock_dir / "same-proc.lock"
        fd_a, why_a = acquire_lock(same_path)
        fd_b, why_b = acquire_lock(same_path)
        if fd_a is not None and fd_b is None and "独占锁被占用" in why_b:
            ok_(f"独占锁：同进程第二个 fd 抢锁立刻失败（{why_b}）")
        else:
            bad_(f"独占锁同进程抢锁异常：fd_a={fd_a} why_a={why_a} fd_b={fd_b} why_b={why_b}")
        if fd_a is not None:
            release_lock(fd_a)

        # --- 5) 持锁进程退出后锁可再次获得（OS 随进程退出释放，不留死锁残留）
        #     用真子进程验证：子进程持锁期间父进程拿不到锁；子进程退出后父进程能拿到。
        child_lock = lock_dir / "child.lock"
        ready = lock_dir / "child.ready"
        child_code = "\n".join([
            "import importlib.util, sys",
            "spec = importlib.util.spec_from_file_location('rw_lockchild', sys.argv[1])",
            "mod = importlib.util.module_from_spec(spec)",
            "spec.loader.exec_module(mod)",
            "fd, why = mod.acquire_lock(mod.Path(sys.argv[2]))",
            "open(sys.argv[3], 'w', encoding='utf-8').write('OK' if fd is not None else 'FAIL:' + why)",
            "sys.stdin.read()",
        ])
        child = subprocess.Popen([sys.executable, "-c", child_code, str(Path(__file__).resolve()),
                                  str(child_lock), str(ready)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 30
        while not ready.is_file() and time.monotonic() < deadline:
            if child.poll() is not None:
                break
            time.sleep(0.05)
        ready_text = ready.read_text(encoding="utf-8").strip() if ready.is_file() else ""
        fd_p, why_p = acquire_lock(child_lock)
        blocked_ok = fd_p is None and "独占锁被占用" in why_p
        if fd_p is not None:
            release_lock(fd_p)
        if child.stdin:
            child.stdin.close()
        try:
            child.wait(timeout=30)
        except subprocess.TimeoutExpired:
            child.kill()
        fd_q, why_q = acquire_lock(child_lock)
        if fd_q is not None:
            release_lock(fd_q)
        if (ready_text == "OK" and blocked_ok and fd_q is not None):
            ok_(f"独占锁：子进程持锁时父进程拿不到（{why_p}）；子进程退出后可再获得（无死锁残留）")
        else:
            bad_(f"独占锁跨进程异常：child={ready_text} blocked={blocked_ok}/{why_p} "
                 f"reacquire={fd_q is not None}/{why_q}")
    finally:
        try:
            for f in lock_dir.iterdir():
                f.unlink(missing_ok=True)
            lock_dir.rmdir()
        except OSError:
            print(f"  ..    锁测试临时目录未清理干净：{lock_dir}")

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
