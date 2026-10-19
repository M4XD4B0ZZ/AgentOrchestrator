# Registers (or re-registers) the Windows Task Scheduler entry that hosts the
# Zera unattended supervisor. Run this once; after that the scheduler owns the
# supervisor's lifetime and no Claude session, terminal or editor does.
#
# ── Why Task Scheduler and not a long-lived process ─────────────────────────
#
# The supervisor holds no state of its own. Every entry re-reads durable AO
# state and Git, decides, acts, and exits. That makes the scheduler the right
# host: a reboot, a killed process, a closed terminal or a six-hour quota wait
# all resolve the same way — the next trigger starts a fresh supervisor that
# picks up from whatever the durable state now says.
#
# A process kept alive for days would have to survive all four, and the one that
# ran on 2026-09-11 did not.
#
# ── Why the interval is not polling ─────────────────────────────────────────
#
# The blind five-minute idle poll is gone and is not coming back. On an entry
# with nothing to do the supervisor runs ao-classify.mjs once, reads
# AUTO_PROGRESS_REMAINING = no with no future wake and no retry due, and exits in
# a few seconds having started no agent and spent no quota. The interval exists
# to make the loop restartable, not to make it busy.
#
# ── Overlap ────────────────────────────────────────────────────────────────
#
# MultipleInstances = IgnoreNew. The scheduler itself refuses a second instance,
# which is the primary single-writer guard at this level. The supervisor's own
# pid lock catches a manual launch alongside a scheduled one, and AO's repository
# execution lease remains the real guard on the writer.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File C:\Users\Max\AO-runs\zera-register-task.ps1
#   powershell -ExecutionPolicy Bypass -File ...\zera-register-task.ps1 -Enable
#   powershell -ExecutionPolicy Bypass -File ...\zera-register-task.ps1 -Unregister

param(
    [switch]$Enable,
    [switch]$Unregister,
    [int]$IntervalMinutes = 30
)

$ErrorActionPreference = 'Stop'

$TaskName   = 'Zera unattended supervisor'
$TaskPath   = '\Zera\'
$Script     = 'C:\Users\Max\AO-runs\zera-supervisor.ps1'

if ($Unregister) {
    try {
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
        "Unregistered '$TaskName'."
    } catch {
        "Nothing to unregister: $($_.Exception.Message)"
    }
    return
}

if (-not (Test-Path $Script)) { throw "supervisor not found at $Script" }

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Script`"" `
    -WorkingDirectory 'C:\Users\Max\AO-runs'

# Two triggers, and between them they cover every way the loop can be
# interrupted. The startup one brings it back after a reboot; the repeating one
# brings it back after a killed process, a closed session or a quota wait that
# outlived its invocation.
$atStartup = New-ScheduledTaskTrigger -AtStartup
$atStartup.Delay = 'PT3M'

# An indefinite repetition is an EMPTY Duration in the task XML, not a very
# large one. `[TimeSpan]::MaxValue` renders as P99999999DT23H59M59S, which the
# scheduler rejects outright — measured on 2026-09-12:
#   Register-ScheduledTask : The task XML contains a value which is incorrectly
#   formatted or out of range. (14,42):Duration:P99999999DT23H59M59S
$repeating = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1)
$repeating.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
    -RepetitionDuration (New-TimeSpan -Days 1)).Repetition
$repeating.Repetition.Duration = ''

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 10) `
    -ExecutionTimeLimit (New-TimeSpan -Hours 8)

# Interactive, as this OS user.
#
# Deliberately NOT "run whether the user is logged on or not": the writing agent
# AO starts is a CLI whose credentials live in this user's own profile, and AO
# resolves its home through the OS profile rather than the environment. A task
# run in a detached session is the configuration none of that was measured in.
# The cost is stated rather than hidden: after a reboot the loop resumes when
# this user next logs on, not before.
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Highest

$task = New-ScheduledTask `
    -Action $action `
    -Trigger @($atStartup, $repeating) `
    -Settings $settings `
    -Principal $principal `
    -Description 'Keeps Zera moving across prepared CAPTURE tasks. Re-enters from durable AgentOrchestrator and Git state on every trigger; merges only when zera-delivery-gate.mjs proves every standing authorisation condition. Never passes AO a grant flag.'

try { Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false } catch {}

Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $task | Out-Null

if ($Enable) {
    Enable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath | Out-Null
    "Registered and ENABLED '$TaskPath$TaskName' (every $IntervalMinutes min, plus at startup)."
} else {
    Disable-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath | Out-Null
    "Registered and left DISABLED '$TaskPath$TaskName'."
    "Enable it with:  powershell -ExecutionPolicy Bypass -File $PSCommandPath -Enable"
}

Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath |
    Select-Object TaskName, TaskPath, State |
    Format-List
