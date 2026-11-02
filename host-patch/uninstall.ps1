#Requires -Version 5.1
<#
.SYNOPSIS
  卸载 ZCode 朗读按钮（只剥离自己的注入行，不动 zusage、不用旧备份覆盖）。

.DESCRIPTION
  - ZCode 运行中直接拒绝。
  - strip-only 回滚：不碰 app.asar.orig / *.bak-*（它们比现役 asar 旧，覆盖 = 降级）。
  - 支持重复执行：本来没注入就报「未注入」并退 0。

.EXAMPLE
  & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
#>
[CmdletBinding()]
param(
  [string]$Asar = ""
)

$ErrorActionPreference = 'Stop'
$PwshFull = 'C:\Program Files\PowerShell\7\pwsh.exe'

if ($PSVersionTable.PSVersion.Major -lt 7 -and (Test-Path -LiteralPath $PwshFull)) {
  $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($Asar) { $fwd += @('-Asar', $Asar) }
  & $PwshFull @fwd
  exit $LASTEXITCODE
}

$Here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$Patch = Join-Path $Here 'patch-readaloud.py'

function Write-Step($msg) { Write-Host "[uninstall] $msg" -ForegroundColor Cyan }
function Write-Bad($msg) { Write-Host "[uninstall] $msg" -ForegroundColor Red }

if (-not (Test-Path -LiteralPath $Patch)) {
  Write-Bad "找不到 patch-readaloud.py：$Patch"
  exit 1
}

$procs = @(Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue)
if ($procs.Count -gt 0) {
  Write-Bad "检测到 ZCode 正在运行（$($procs.Count) 个进程），拒绝改动 asar。"
  Write-Host "    请完全退出 ZCode 后再运行。" -ForegroundColor Yellow
  exit 2
}

$candidates = @()
if ($env:READALOUD_PYTHON) { $candidates += $env:READALOUD_PYTHON }
try {
  $whereOut = & where.exe python 2>$null
  if ($whereOut) { $candidates += ($whereOut -split "`r?`n" | Where-Object { $_ -and $_.Trim() }) }
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
  $python = $cand
  break
}
if (-not $python) {
  Write-Bad "找不到 python。可用环境变量指定：`$env:READALOUD_PYTHON='C:\path\to\python.exe'"
  exit 1
}
Write-Step "python: $python"

$cmdArgs = @($Patch, 'remove')
if ($Asar) { $cmdArgs += @('--asar', $Asar) }
& $python @cmdArgs
$code = $LASTEXITCODE

if ($code -eq 0) {
  Write-Host ""
  Write-Step "已卸载。重启 ZCode 后生效。"
}
exit $code
