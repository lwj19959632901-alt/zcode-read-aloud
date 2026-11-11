# register-task.ps1 — 注册/更新计划任务 ZCode-ReadAloudWatcher（幂等）
#
# 任务丢了（被系统清理、换机、重装）就重跑这个脚本 —— 仓里有原件，可复现：
#   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -ExecutionPolicy Bypass -File .\register-task.ps1
#
# 任务定义：
#   触发器 1：当前用户登录时（AtLogOn）
#   触发器 2：每小时重复一次（持续 10 年）
#   动作    ：pwsh 全路径 -NoProfile -WindowStyle Hidden -File <本目录>\arm-watcher.ps1
#   主体    ：当前用户 + Interactive 登录类型。**不用 S4U、不存密码**：
#              S4U 会把任务丢进 Session 0（GUI 程序起不来、也拿不到用户会话）
#   设置    ：MultipleInstances=IgnoreNew（不叠开第二个实例）
#             ExecutionTimeLimit=0（不限时）——**防御性设置**。
#             arm-watcher.ps1 用 Start-Process（无 -Wait）启动 watcher 后立刻退出，
#             任务本体只活约 1 秒，从不拥有 watcher 进程，所以当前实现下
#             PT1H 与 PT0S 没有实际差别；
#             若将来 arm 脚本改成前台运行 watcher，PT1H 会在 1 小时后杀掉常驻进程，
#             那时 PT0S 才是必需的（watcher 自己管 7 天生命周期）。
#
# 幂等：已存在则更新同名任务（触发器/动作/主体/设置），并打印当前状态；重复跑不报错。

$ErrorActionPreference = 'Stop'

$TaskName = 'ZCode-ReadAloudWatcher'
$Pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'      # pwsh 一律全路径（禁短名 / WindowsApps 桩）
$Arm = Join-Path $PSScriptRoot 'arm-watcher.ps1'

if (-not (Test-Path -LiteralPath $Arm -PathType Leaf)) {
    Write-Output "找不到 arm-watcher.ps1：$Arm —— 无法注册（先确认脚本目录完整）"
    exit 1
}
if (-not (Test-Path -LiteralPath $Pwsh -PathType Leaf)) {
    Write-Output "找不到 pwsh：$Pwsh —— 无法注册（装 PS7 或改本脚本里的路径）"
    exit 1
}

$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $Pwsh -Argument ('-NoProfile -WindowStyle Hidden -File "' + $Arm + '"')
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn -User $User)
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Hours 1) `
        -RepetitionDuration (New-TimeSpan -Days 3650))
)
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Set-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
        -Principal $principal -Settings $settings | Out-Null
    Write-Output "已更新既有任务：$TaskName"
}
else {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
        -Principal $principal -Settings $settings `
        -Description 'readaloud 双补丁 watcher 武装入口（登录时 + 每小时）' | Out-Null
    Write-Output "已注册新任务：$TaskName"
}

# ---- 当前状态（注册/更新后回读，确认真的落库）----
$t = Get-ScheduledTask -TaskName $TaskName
Write-Output ("任务名={0} 状态={1} 主体={2} LogonType={3} RunLevel={4} MultipleInstances={5} ExecutionTimeLimit={6}" -f `
    $t.TaskName, $t.State, $t.Principal.UserId, $t.Principal.LogonType, $t.Principal.RunLevel, `
    $t.Settings.MultipleInstances, $t.Settings.ExecutionTimeLimit)
foreach ($tr in $t.Triggers) {
    if ($tr.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') {
        Write-Output ("触发器：AtLogOn 用户={0}" -f $tr.UserId)
    }
    else {
        Write-Output ("触发器：重复 间隔={0} 时长={1} 起始={2}" -f `
            $tr.Repetition.Interval, $tr.Repetition.Duration, $tr.StartBoundary)
    }
}
foreach ($ac in $t.Actions) {
    Write-Output ("动作：{0} {1}" -f $ac.Execute, $ac.Arguments)
}
