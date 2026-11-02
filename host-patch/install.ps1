#Requires -Version 5.1
<#
.SYNOPSIS
  安装 ZCode 朗读按钮（往 app.asar 入口追加一行注入）。

.DESCRIPTION
  - ZCode 运行中直接拒绝（不做 .tmp 待替换：自动更新会让 pending 的旧 asar 覆盖新版本 = 客户端降级）。
  - 不创建任何 asar 备份（现有 *.orig / *.bak 都比现役 asar 旧，回滚只能 strip-only）。
  - 本脚本自身用 PS7 全路径重启（短名 pwsh 可能解析到 WindowsApps 别名桩）。

.EXAMPLE
  & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  .\install.ps1 -Selftest
#>
[CmdletBinding()]
param(
  [string]$Asar = "",
  [switch]$Selftest,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$PwshFull = 'C:\Program Files\PowerShell\7\pwsh.exe'

# 若从 PS5 或短名 pwsh 进来，用 PS7 全路径重跑自己
if ($PSVersionTable.PSVersion.Major -lt 7 -and (Test-Path -LiteralPath $PwshFull)) {
  $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($Asar) { $fwd += @('-Asar', $Asar) }
  if ($Selftest) { $fwd += '-Selftest' }
  if ($Check) { $fwd += '-Check' }
  & $PwshFull @fwd
  exit $LASTEXITCODE
}

$Here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Patch = Join-Path $Here 'patch-readaloud.py'

function Write-Step($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Write-Bad($msg) { Write-Host "[install] $msg" -ForegroundColor Red }

if (-not (Test-Path -LiteralPath $Patch)) {
  Write-Bad "找不到 patch-readaloud.py：$Patch"
  exit 1
}

# 1) 只有「真的安装」才要求 ZCode 已退出（-Check / -Selftest 是只读的）
if (-not $Selftest -and -not $Check) {
  $procs = @(Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue)
  if ($procs.Count -gt 0) {
    Write-Bad "检测到 ZCode 正在运行（$($procs.Count) 个进程），拒绝安装。"
    Write-Host "    请完全退出 ZCode（含托盘/后台进程）后重跑本脚本。" -ForegroundColor Yellow
    Write-Host "    不做待下次启动替换：自动更新会用 pending 的旧 asar 覆盖新版本。" -ForegroundColor DarkGray
    exit 2
  }
}

# 2) 找 python（跳过 Microsoft Store 的 App Execution Alias 桩）
$candidates = @()
if ($env:READALOUD_PYTHON) { $candidates += $env:READALOUD_PYTHON }
try {
  $whereOut = & where.exe python 2>$null
  if ($whereOut) { $candidates += ($whereOut -split "`r?`n" | Where-Object { $_ -and $_.Trim() }) }
} catch { }
try {
  $whereOut3 = & where.exe python3 2>$null
  if ($whereOut3) { $candidates += ($whereOut3 -split "`r?`n" | Where-Object { $_ -and $_.Trim() }) }
} catch { }
$localPy = Join-Path $env:LOCALAPPDATA 'Programs\Python'
if (Test-Path -LiteralPath $localPy) {
  Get-ChildItem -LiteralPath $localPy -Directory -Filter 'Python3*' -ErrorAction SilentlyContinue |
    ForEach-Object { $candidates += (Join-Path $_.FullName 'python.exe') }
}

$python = $null
foreach ($cand in $candidates) {
  if (-not $cand) { continue }
  if ($cand -match '\\WindowsApps\\') { continue }
  if (-not (Test-Path -LiteralPath $cand)) { continue }
  & $cand -c "import edge_tts" 2>$null
  if ($LASTEXITCODE -eq 0) { $python = $cand; break }
}

if (-not $python) {
  Write-Bad "找不到可用的 python（需要 `import edge_tts` 成功）。"
  Write-Host "    安装：python -m pip install edge-tts" -ForegroundColor Yellow
  Write-Host "    或用环境变量指定：`$env:READALOUD_PYTHON='C:\path\to\python.exe'" -ForegroundColor Yellow
  exit 1
}
Write-Step "python: $python"

# 3) 调补丁器
$cmdArgs = @($Patch)
if ($Selftest) { $cmdArgs += 'selftest' }
elseif ($Check) { $cmdArgs += 'check' }
else { $cmdArgs += 'install' }
if ($Asar) { $cmdArgs += @('--asar', $Asar) }

& $python @cmdArgs
$code = $LASTEXITCODE

if ($code -eq 0 -and -not $Selftest -and -not $Check) {
  Write-Host ""
  Write-Step "安装完成。启动 ZCode 后，每条助手回复操作栏会多一个 🔊 朗读按钮。"
  Write-Step "回滚：运行 uninstall.ps1（只剥离注入行，不用旧备份覆盖）。"
}
exit $code
