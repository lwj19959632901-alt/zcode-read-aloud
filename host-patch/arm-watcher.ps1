# arm-watcher.ps1 — 武装 readaloud 双补丁 watcher v3（幂等）
#
# 计划任务 ZCode-ReadAloudWatcher（登录时 + 每小时）的入口，也可手动跑：
#   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -WindowStyle Hidden -File arm-watcher.ps1
# 已有 watcher 在跑则直接退出（watcher already armed），否则隐藏窗口启动常驻 watcher。

$ErrorActionPreference = 'Stop'

$python = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'
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
