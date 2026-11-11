# arm-watcher.ps1 — 武装 readaloud 双补丁 watcher v3（幂等）
#
# 计划任务 ZCode-ReadAloudWatcher（登录时 + 每小时）的入口，也可手动跑：
#   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -WindowStyle Hidden -File arm-watcher.ps1
# 已有 watcher 在跑则直接退出（watcher already armed），否则隐藏窗口启动常驻 watcher。
# 计划任务丢了就重跑 register-task.ps1 复现。

$ErrorActionPreference = 'Stop'

# python 解释器分级探测（P2-8：不写死单一路径）：
#   ① 默认安装位在 -> 用它
#   ② 否则 Get-Command python / python3 拿实际路径（跳过 WindowsApps 应用别名桩：
#      那是「应用执行别名」，可被系统关掉，会让计划任务静默失败）
#   ③ 都没有 -> 报错退出（非 0），让计划任务下次触发再试
$python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    $python = $null
    foreach ($name in @('python', 'python3')) {
        $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue |
            Where-Object { $_.Source -and $_.Source -notlike '*\WindowsApps\*' } |
            Select-Object -First 1
        if ($cmd) {
            $python = $cmd.Source
            break
        }
    }
    if (-not $python) {
        Write-Output '找不到 python 解释器（默认安装位不存在，Get-Command python/python3 也无结果）——本次退出（非 0），计划任务下次触发会重试'
        exit 1
    }
    Write-Output "python 走 Get-Command 探测：$python"
}

$watcher = Join-Path $PSScriptRoot 'readaloud-keys-watcher.py'

# 检测串运行时拼接构造：本脚本自身命令行含该字面量，拼接 + Name=python.exe 双保险，
# 保证过滤器命不中 arm 自己（arm 是 pwsh 进程，Name 过滤已排除，拼接更稳）。
$needle = 'readaloud' + '-keys-watcher'
$running = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like ('*' + $needle + '.py*') }

if ($running) {
    $pids = ($running | ForEach-Object { $_.ProcessId }) -join ','
    Write-Output "watcher already armed pid=$pids"
    exit 0
}

Start-Process -FilePath $python -ArgumentList ('"' + $watcher + '"') -WindowStyle Hidden
Write-Output 'watcher armed'
