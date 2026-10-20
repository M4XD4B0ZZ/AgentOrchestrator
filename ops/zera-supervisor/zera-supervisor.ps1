# Zera unattended supervisor — wrapper only. Changes nothing inside AgentOrchestrator.
#
# ── What this is ────────────────────────────────────────────────────────────
#
# A durable operator loop that keeps Zera moving across prepared CAPTURE tasks
# and stops only for a genuine human decision. It is re-entrant by design: it
# holds no long-lived state of its own, reads everything from durable AO and Git
# state on each entry, and is expected to be started repeatedly by Windows Task
# Scheduler rather than kept alive for days.
#
# It supersedes ao-overnight-run.ps1, which did the same job for one night and
# stopped at READY_FOR_PR. That file is kept for its history and is no longer the
# entry point.
#
# ── Division of authority ───────────────────────────────────────────────────
#
# AgentOrchestrator remains the authority for selection, dependencies, durable
# runtime state, resume eligibility, quota continuation, attention, and the
# verification / review / remediation lifecycle. This script re-decides none of
# that: ao-classify.mjs imports AO's own attentionForTaskState,
# usageLimitContinuation and safeParseTaskState, and ranks from AO's own planner.
#
# Delivery to github.com is NOT an AO rule for this repository. Measured:
#
#   agent-loop delivery --repository D:\Workspaces_VSCode\HealthApp --task <id>
#   -> Delivery : DELIVERY_NOT_DECLARED — This repository declares no delivery
#      target, so there is nothing to observe.
#
# HealthApp's .agent-orchestrator/repo-profile.yaml declares no `delivery:`
# section, so AO will not publish a head, open a pull request or merge one here.
# Doing it in this script therefore duplicates no AO authority. If that profile
# ever gains a delivery target, the right move is to hand these steps back to AO
# rather than keep two implementations.
#
# -- The three grants it may supply, and the ones it may never ---------------
#
# Every one of them is an OPERATOR grant and stays one. AO's state machine is
# unchanged, and AO still refuses an automatic departure in all three cases.
# What the operator issued is a narrow STANDING authorisation per case, proved
# fresh every pass by a read-only file outside AO. Never describe any of this as
# AO granting itself a continuation.
#
# Each lane is mutually exclusive with the others: at most one grant is supplied
# per pass, and exactly one flag appears in the invocation it makes.
#
#   1. --continue-usage-limit      (2026-09-12)  zera-quota-grant.mjs
#      Ordinary quota recovery, so a provider allowance running out does not
#      need a person at a keyboard. Bounded by a retry ledger.
#
#   2. --verify-operator-repair    (2026-09-13)  zera-operator-repair-grant.mjs
#      The operator has ALREADY repaired the exact tree AO measured as failed,
#      and that repair is sitting uncommitted in the worktree. The grant lets AO
#      adopt it. THE SUPERVISOR DOES NOT COMMIT THE REPAIR AND NEVER MAY: it
#      writes no file in the worktree, stages nothing and commits nothing. AO
#      commits, under AO's own commit controls, inside the invocation. The
#      prover calls AO's own `assessOperatorRepair` rather than re-deciding any
#      of its eight conditions.
#
#   3. --continue-human-decision   (2026-09-13)  zera-writer-death-grant.mjs
#      ONE PRODUCER of HUMAN_DECISION_REQUIRED, measured repeatedly in real
#      CAPTURE-004 operation: the writing agent was interrupted during the
#      implement pass, and AO parked at HUMAN_DECISION_REQUIRED with
#      blockedAgent 'claude' and resumeFrom phase IMPLEMENT. Nothing was
#      decided, nothing reviewed, no finding recorded. The prover additionally
#      computes AO's own `grantReviewRound` and refuses unless it is false, so
#      the grant can never buy a review round.
#
#      ONE PRODUCER IS NOT ONE CAUSE, and the difference is not recoverable from
#      any record. `AGENT_FAILURE_DISPOSITION` maps FOUR writer failure codes
#      onto the same disposition -- AGENT_PROCESS_UNAVAILABLE,
#      AGENT_NONZERO_EXIT, AGENT_RESULT_MALFORMED and AGENT_ARGUMENT_REFUSED --
#      and AO persists none of them, because TaskState is .strict(). So what
#      this lane really covers is "a writing agent that did not complete its
#      implement pass, WHATEVER the diagnosis". The fourth is deterministic and
#      a restart reproduces it; the durable restart budget is what bounds that.
#      See the prover's own header. An earlier draft of this paragraph said
#      "the process did not run to its own end" and a review caught it.
#
#      It does NOT cover: REMEDIATE review-budget exhaustion; a product or
#      design decision; review findings; or HUMAN_DECISION_REQUIRED reached
#      through any OTHER producer. Those stay human-only.
#
# Never, in any shape, automatically:
#   --recover-stale-lease        lease recovery or steal
#   --remediate-verify-failure   a verification override that starts a writer
# and no scope override of any kind. Those stay the operator's, and a state that
# needs one is a state this supervisor stops on.
#
# It also never force-pushes, never resets, never deletes a worktree, and never
# merges without zera-delivery-gate.mjs proving every standing condition.


$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

# ── Paths ───────────────────────────────────────────────────────────────────
#
# Two folders, never mixed (ADR 2026-10-19, phase 2):
#
#   source  the folder this script runs from ($PSScriptRoot). The five helper
#           scripts are joined from it, and nothing else is.
#   state   -StateDir, else $env:ZERA_STATE_DIR, else today's folder. The status
#           file, the retry ledger, the lock, the last-notify stamp and the
#           transcripts are joined from it, and no script is.
#
# With no parameter both are today's folder, so the scheduled task's action path
# and working directory need no change and a rollback is a copy of the old files.
#
# Parameters are read from $args by hand, as -DryRun always was. A param() block
# would make every parameter positional, and a bare `--dry-run` would then bind
# to the first of them instead of meaning a dry run.

# The value after a named argument, or $null when it is absent. A name with no
# value after it, or with an empty or blank one, is refused rather than read as
# "absent": falling back to the default would put the state in a folder the
# operator did not ask for.
function Get-ZeraArg([object[]]$argv, [string]$name) {
    for ($i = 0; $i -lt $argv.Count; $i++) {
        if ("$($argv[$i])" -eq $name) {
            if ($i + 1 -ge $argv.Count -or "$($argv[$i + 1])" -like '-*' -or [string]::IsNullOrWhiteSpace("$($argv[$i + 1])")) {
                throw "$name needs a value"
            }
            return "$($argv[$i + 1])"
        }
    }
    return $null
}

# Every parameter is written as its name and, for a folder, a separate value. The colon form
# (-StateDir:D:\x, -DryRun:$true) and a splat arrive in $args as "-StateDir:" and a value, which
# Get-ZeraArg and the -DryRun check would not see: the state would silently go to the default
# folder, and a dry run would run live. Refused instead, before anything is read or written.
function Assert-ZeraArgForms([object[]]$argv) {
    foreach ($a in $argv) {
        if ("$a" -match '^-(StateDir|AoRoot|RepoRoot|DryRun):') {
            throw "write -$($Matches[1]) without a colon: the colon form and a splat are refused"
        }
    }
}

# The whole path table, and the only place a path is decided. Pure: it reads
# nothing but its arguments (the environment variable is the default of one of
# them) and touches no file, so a test can call it alone.
#
# Every folder must be fully qualified: a drive letter and a backslash, or a UNC
# share. A relative folder, and a rooted one that is not fully qualified (D:state,
# \state), changes meaning with the current location or drive -- under the
# Push-Location into the AO root below, the retry ledger would be read and
# written somewhere other than the state folder. A ZERA_STATE_DIR that is set
# but blank is refused, as a blank -StateDir is. The match is case-exact: -match
# folds case by culture and reads a Kelvin sign as the drive letter K.
function Resolve-ZeraPaths {
    param(
        [string]$SourceDir,
        [string]$StateDir,
        [string]$EnvStateDir = $env:ZERA_STATE_DIR,
        [string]$AoRoot,
        [string]$RepoRoot
    )
    if ([string]::IsNullOrWhiteSpace($StateDir) -and $EnvStateDir.Length -gt 0 -and [string]::IsNullOrWhiteSpace($EnvStateDir)) {
        throw 'ZERA_STATE_DIR is set but blank'
    }
    if ([string]::IsNullOrWhiteSpace($StateDir)) { $StateDir = $EnvStateDir }
    if ([string]::IsNullOrWhiteSpace($StateDir)) { $StateDir = 'C:\Users\Max\AO-runs' }
    if ([string]::IsNullOrWhiteSpace($AoRoot))   { $AoRoot   = 'D:\AgentOrchestrator' }
    if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = 'D:\Workspaces_VSCode\HealthApp' }
    foreach ($dir in @($SourceDir, $StateDir, $AoRoot, $RepoRoot)) {
        if ([string]::IsNullOrWhiteSpace($dir) -or -not ($dir -cmatch '^[A-Za-z]:\\' -or $dir -cmatch '^\\\\[^\\]+\\[^\\]+')) {
            throw "not an absolute folder: '$dir'"
        }
    }
    return [ordered]@{
        SourceDir     = $SourceDir
        StateDir      = $StateDir
        AoRoot        = $AoRoot
        RepoRoot      = $RepoRoot
        Classifier    = Join-Path $SourceDir 'ao-classify.mjs'
        DeliveryGate  = Join-Path $SourceDir 'zera-delivery-gate.mjs'
        QuotaGrant    = Join-Path $SourceDir 'zera-quota-grant.mjs'
        RepairGrant   = Join-Path $SourceDir 'zera-operator-repair-grant.mjs'
        WriterGrant   = Join-Path $SourceDir 'zera-writer-death-grant.mjs'
        StatusFile    = Join-Path $StateDir 'zera-unattended-status.txt'
        RetryFile     = Join-Path $StateDir 'zera-retry-budget.json'
        LockFile      = Join-Path $StateDir 'zera-supervisor.lock'
        NotifyStamp   = Join-Path $StateDir 'zera-last-notify.txt'
        TranscriptDir = Join-Path $StateDir 'transcripts'
    }
}

Assert-ZeraArgForms $args

$ZeraPaths = Resolve-ZeraPaths -SourceDir $PSScriptRoot `
    -StateDir (Get-ZeraArg $args '-StateDir') `
    -AoRoot (Get-ZeraArg $args '-AoRoot') `
    -RepoRoot (Get-ZeraArg $args '-RepoRoot')

$SourceDir        = $ZeraPaths['SourceDir']
$StateDir         = $ZeraPaths['StateDir']
$AoRoot           = $ZeraPaths['AoRoot']
$RepoRoot         = $ZeraPaths['RepoRoot']

$Classifier       = $ZeraPaths['Classifier']
$DeliveryGate     = $ZeraPaths['DeliveryGate']
$QuotaGrant       = $ZeraPaths['QuotaGrant']
$RepairGrant      = $ZeraPaths['RepairGrant']
$WriterGrant      = $ZeraPaths['WriterGrant']
$StatusFile       = $ZeraPaths['StatusFile']
$RetryFile        = $ZeraPaths['RetryFile']
$LockFile         = $ZeraPaths['LockFile']
$NotifyStamp      = $ZeraPaths['NotifyStamp']
$TranscriptDir    = $ZeraPaths['TranscriptDir']

# Every helper reads AO_ROOT and falls back to a built-in path without it. Set
# here, once, for this process, so every node child the supervisor starts --
# classifier, provers, delivery gate -- inherits the AO root this run was given,
# whatever the caller's environment said.
$env:AO_ROOT = $AoRoot

# ── Configuration ───────────────────────────────────────────────────────────

$CanonicalBranch  = 'chore/clean-arch-structure'
$CanonicalRemote  = 'origin'

# The standing merge authorisation covers exactly these tasks and no others.
# CAPTURE-007 and later carry open provider/privacy decisions; unrelated
# Resolver, Auth and Account work was never in scope.
$MergeAuthorisedTasks = @('CAPTURE-003', 'CAPTURE-004', 'CAPTURE-005', 'CAPTURE-006')

# Hard caps, not the stop rule. The state logic below is the stop rule.
$MaxOuterPasses   = 12
$AoMaxCycles      = 10
$AoMaxSteps       = 12
$AoMaxInvocs      = 1
$AoMaxWaitMs      = 21600000    # 6 h — one quota reset window, AO waits holding no lease
$CiWaitMaxMs      = 2700000     # 45 min — one verify run here is ~20 min
$CiPollMs         = 60000
# How long "this PR has no checks yet" is allowed to mean "GitHub has not
# registered them", before it becomes MERGE_BLOCKED_NO_CHECKS for good.
$CiNoChecksGraceMs = 300000     # 5 min

# Bounded retry for a quota block that records no reset instant. Never a guess
# at when the quota returns: just a refusal to hammer.
$ResetUnrecordedRetryHours   = 2
$ResetUnrecordedMaxPerDay    = 4

# How many automatic writer restarts one supervisor run may grant.
#
# A floor, and rarely the binding one. The durable spacing below refuses a second
# restart within an hour, and most runs are shorter than that -- so in a typical
# run this cap is never reached and `WRITER_DEATH_RETRIES_EXHAUSTED` never fires.
# It binds only in a long run: AO may wait up to six hours for a quota reset and
# CI up to forty-five minutes, and a run that spans two spacing windows would
# otherwise keep going to $MaxOuterPasses. Kept for that case rather than
# deleted, and described as what it is rather than as the bound.
$WriterDeathMaxPerRun        = 2

# And the same bound made DURABLE, because the per-run cap alone is not one: the
# scheduler re-enters every 30 minutes with a fresh run and therefore a fresh
# allowance, so two per run is roughly a hundred writer starts a day against an
# unchanged tree. These are spent in the shared ledger under the key
# `<taskId>#writer-restart`, which zera-quota-grant.mjs cannot see.
$WriterRestartRetryHours     = 1
$WriterRestartMaxPerDay      = 4

$DryRun = $args -contains '-DryRun' -or $args -contains '--dry-run'

# ── Small helpers ───────────────────────────────────────────────────────────

function Now-Iso { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }

$script:Report = [ordered]@{
    timestamp        = Now-Iso
    mode             = if ($DryRun) { 'DRY_RUN' } else { 'LIVE' }
    canonicalSha     = 'unknown'
    currentTask      = 'none'
    aoState          = 'unknown'
    worktreeBranch   = 'none'
    prNumber         = 'none'
    prHead           = 'none'
    ciState          = 'none'
    lastMergeSha     = 'none'
    autoProgress     = 'unknown'
    futureWake       = 'unknown'
    operatorBlockers = 'unknown'
    # Which standing authorisation, if any, this pass proved and supplied.
    # 'none' means the pass ran AO with no operator grant at all, which is the
    # ordinary case and the one every healthy task takes.
    recoveryLane     = 'none'
    nextWake         = 'none'
    lastAction       = 'starting'
    lastError        = 'none'
    stopReason       = 'UNSET'
}

# Overwrite atomically: write a sibling temp file, then replace. A reader never
# sees half a status, and a crash mid-write leaves the previous one intact.
function Write-Status {
    $script:Report['timestamp'] = Now-Iso
    $lines = @()
    $lines += "# Zera unattended supervisor status"
    foreach ($k in $script:Report.Keys) { $lines += ("{0,-17}= {1}" -f $k, $script:Report[$k]) }
    $tmp = "$StatusFile.tmp"
    try {
        Set-Content -Path $tmp -Value $lines -Encoding utf8 -Force
        Move-Item -Path $tmp -Destination $StatusFile -Force
    } catch {
        Write-Host "status write failed: $($_.Exception.Message)"
    }
}

# What the last quota-grant proof said. Remembered at SCRIPT scope because the
# correction below has to be applied every time the classifier is read, including
# the final report in the finally block. Without that, the last read would
# overwrite the correction and put the operator back on the hook for a quota
# state they had already authorised.
$script:GrantAuthorised = $false
$script:GrantNextRetry  = 'none'

# What a PROVEN recovery grant covers this pass, as (task, attention reason)
# pairs. Empty until a prover has actually said yes: it is never a list of what
# MIGHT be covered, because a list of possibilities would mask a real blocker
# before anything had proved it was answerable.
#
# The PAIR, not the reason alone. The classifier emits one entry per ranked task
# across every enlisted repository, shaped `<repo>/<task> <STATE> <REASON>`, and
# masking by reason alone would let a grant proved for one task hide an
# identical-sounding blocker on another. Today one repository is enlisted and
# the chain is linear, so the list is a singleton -- a fact about the
# configuration, not a property of this code.
$script:CoveredEntries  = @()

# How the status should NAME the authorisation that covered those entries. Set
# beside the entries themselves, because the lane variable is not always the
# answer: a writer restart whose window is merely shut is covered by the
# authorisation and is not a lane this pass took.
$script:CoveredNote     = ''

# The instant a parked writer restart becomes permitted again, carried at SCRIPT
# scope for the reason $script:GrantNextRetry is: `Set-Classification`
# unconditionally reassigns futureWake from the classifier, and the finally block
# calls it once more after the break. Without this the final status would read
# `futureWake = none` beside `stopReason = WRITER_RESTART_WINDOW_NOT_OPEN`.
$script:WriterNextRetry = 'none'

# Write the classifier's answer into the status, corrected for the operator's
# standing quota authorisation.
#
# The classifier can only report what AO's attention map says, and AO correctly
# says a person must supply --continue-usage-limit. The operator supplied it,
# standing. So a quota state the authorisation covers is NOT an operator blocker:
#
#   retry window open now    -> machine-progressable
#   next retry in the future -> a wake, and nobody is needed
#   authorisation not met    -> a real operator blocker, reported unchanged
#
# AO's own vocabulary is untouched. This decides only how THIS supervisor reports
# what AO said.
function Set-Classification($classifier) {
    $script:Report['autoProgress']     = $classifier.map['AUTO_PROGRESS_REMAINING']
    $script:Report['futureWake']       = $classifier.map['FUTURE_WAKE']
    $script:Report['operatorBlockers'] = $classifier.map['OPERATOR_BLOCKERS']

    # Correct PER ENTRY, never by substring over the joined list.
    #
    # The classifier joins one entry per ranked task across every enlisted
    # repository with '; '. Testing the whole string and replacing the whole
    # string means a single quota entry anywhere would erase a SCOPE_VIOLATION or
    # HUMAN_DECISION_REQUIRED sitting beside it - the exact conditions the
    # standing authorisation forbids auto-granting. Today's chain is linear and
    # one repository is enlisted, so the list is a singleton; that is a fact
    # about the configuration, not a property of the code.
    $raw = $script:Report['operatorBlockers']
    if ($raw -and $raw -ne 'none' -and $raw -ne 'unknown') {
        $kept = @()
        $covered = 0
        # Entries a proven recovery grant covers and can act on NOW. Kept apart
        # from $covered because the quota lane has a third answer the other two
        # do not -- "the retry window is not open yet" -- and folding them would
        # report a recovery lane as a wake nobody is waiting for.
        $coveredNow = 0
        foreach ($entry in ($raw -split ';')) {
            $e = $entry.Trim()
            if ($e -eq '') { continue }
            if ($e -match 'QUOTA_CONTINUATION_REQUIRED' -and
                ($script:GrantAuthorised -or ($script:GrantNextRetry -and $script:GrantNextRetry -ne 'none'))) {
                $covered = $covered + 1
                continue
            }
            # The task id is matched as a WHOLE FIELD, not as a substring. The
            # classifier emits `<repo>/<task> <STATE> <REASON>`, so a bare
            # substring test would let a grant proved for CAPTURE-004 mask a real
            # blocker on CAPTURE-004R — the same class of error as correcting by
            # substring over the joined list, one level down.
            $matchedLane = $false
            foreach ($pair in $script:CoveredEntries) {
                if ($pair['task'] -and $pair['reason'] -and
                    $e -match ('(?:^|/)' + [regex]::Escape($pair['task']) + '(?:\s|$)') -and
                    $e -match ('(?:^|\s)' + [regex]::Escape($pair['reason']) + '(?:\s|/|$)')) {
                    $matchedLane = $true
                    break
                }
            }
            if ($matchedLane) { $coveredNow = $coveredNow + 1; continue }
            $kept += $e
        }
        if ($covered -gt 0 -or $coveredNow -gt 0) {
            if ($script:GrantAuthorised -or $coveredNow -gt 0) {
                $script:Report['autoProgress'] = 'yes'
            } else {
                $script:Report['futureWake'] = $script:GrantNextRetry
                $script:Report['nextWake']   = $script:GrantNextRetry
            }
            if ($kept.Count -eq 0) {
                $note = if ($coveredNow -gt 0) {
                    if ($script:CoveredNote -ne '') { $script:CoveredNote } else { "covered by the proven standing $($script:Report['recoveryLane']) authorisation" }
                } elseif ($script:GrantAuthorised) {
                    'covered by the standing quota authorisation'
                } else {
                    'quota retry window not open yet; the scheduler takes it'
                }
                $script:Report['operatorBlockers'] = "none ($note)"
            } else {
                # Something else still needs a person. Say so, and do not let the
                # quota correction hide it.
                $script:Report['operatorBlockers'] = ($kept -join '; ')
                $script:Report['autoProgress'] = 'no'
            }
        }
    }
    # Re-applied AFTER the block above, which reassigns futureWake from the
    # classifier every time it runs -- including from the finally block, long
    # after the pass that proved this instant has ended.
    if ($script:WriterNextRetry -and $script:WriterNextRetry -ne 'none') {
        $script:Report['futureWake'] = $script:WriterNextRetry
        $script:Report['nextWake']   = $script:WriterNextRetry
    }
    Write-Status
}

function Set-Action([string]$text) {
    $script:Report['lastAction'] = $text
    Write-Host "[$(Now-Iso)] $text"
    Write-Status
}

function Set-Error([string]$text) {
    $script:Report['lastError'] = $text
    Write-Host "[$(Now-Iso)] ERROR: $text"
    Write-Status
}

# Notify at most once per distinct condition.
#
# The scheduler re-enters every 30 minutes. A blocker that needs a person does
# not go away when it is reported, so an un-deduplicated notify would send the
# same message 48 times a day and train the operator to ignore the channel,
# which is the opposite of the point. The condition is keyed by title plus body:
# when either changes, something genuinely changed and it is sent again.
#
# The record lives on disk, because the process exiting between triggers is the
# normal case and an in-memory guard would suppress nothing.
function Test-NotifyIsNew([string]$title, [string]$body) {
    $stamp = $NotifyStamp
    $key = $title + '|' + $body
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($key))).Replace('-', '')
    if (Test-Path $stamp) {
        try {
            $previous = (Get-Content $stamp -Raw -Encoding utf8).Trim()
            if ($previous -eq $hash) { return $false }
        } catch {
            # An unreadable stamp must never silence a notification.
        }
    }
    if (-not $DryRun) {
        try { Set-Content -Path $stamp -Value $hash -Encoding utf8 -Force } catch { }
    }
    return $true
}

# Called once a pass has actually moved durable state: whatever was last
# reported is no longer the current condition, so the next distinct one should
# get through even if its text happens to match.
function Clear-NotifyStamp {
    $stamp = $NotifyStamp
    if (Test-Path $stamp) { Remove-Item $stamp -Force -ErrorAction SilentlyContinue }
}

# The topic is the channel's only credential: anyone who knows it can read and
# post. So no line this writes -- console, transcript, status -- names the topic
# or the URL built from it. A web exception's text is not printed either: it is
# not this script's to vouch for, and a transcript keeps it for good. Nine old
# transcripts hold the topic because the dry-run line once printed the URL.
function Notify([string]$title, [string]$body) {
    if (-not (Test-NotifyIsNew $title $body)) {
        Write-Host "notification suppressed (unchanged since the last one): $title"
        return
    }
    $notifyFile = Join-Path $env:USERPROFILE '.agent-orchestrator\notify.yaml'
    if (-not (Test-Path $notifyFile)) { return }
    $endpoint = $null; $topic = $null
    foreach ($line in (Get-Content $notifyFile)) {
        if ($line -match '^\s*endpoint:\s*(.+?)\s*$') { $endpoint = $Matches[1] }
        if ($line -match '^\s*topic:\s*(.+?)\s*$')    { $topic    = $Matches[1] }
    }
    if (-not $endpoint -or -not $topic) { return }
    $url = ($endpoint.TrimEnd('/')) + '/' + $topic
    if ($DryRun) { Write-Host "DRY-RUN: would notify -- $title"; return }
    try {
        Invoke-RestMethod -Uri $url -Method Post -Body $body -Headers @{ Title = $title } -TimeoutSec 20 `
            -ErrorAction Stop -Verbose:$false | Out-Null
    } catch {
        Write-Host "notify failed: the notification endpoint did not take the message -- $title"
    }
}

# ── Single writer ───────────────────────────────────────────────────────────
#
# Task Scheduler's own MultipleInstances=IgnoreNew is the primary guard. This
# lock catches a manual launch alongside a scheduled one. It stores the pid and
# is only honoured while that pid is alive, so a reboot or a killed run cannot
# leave a lock nobody can clear. AO's own repository execution lease remains the
# real guard on the writer itself; this one only stops two supervisors.

function Acquire-Lock {
    if (Test-Path $LockFile) {
        $ownerPid = (Get-Content $LockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        $alive = $false
        if ($ownerPid -match '^\d+$') {
            try { Get-Process -Id ([int]$ownerPid) -ErrorAction Stop | Out-Null; $alive = $true } catch { $alive = $false }
        }
        if ($alive) { return $false }
        Write-Host "clearing a lock whose owner pid $ownerPid is gone"
        Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    }
    Set-Content -Path $LockFile -Value $PID -Encoding utf8 -Force
    return $true
}

function Release-Lock {
    if (Test-Path $LockFile) {
        $ownerPid = (Get-Content $LockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($ownerPid -eq "$PID") { Remove-Item $LockFile -Force -ErrorAction SilentlyContinue }
    }
}

# -- Bounded retry ledger ---------------------------------------------------
#
# A quota block that records no reset instant names no time to wait for, and
# inventing one would be a lie about a provider. So the operator's standing
# authorisation is bounded instead: no more often than every N hours, and at
# most M attempts in any rolling 24 hours, per task.
#
# The ledger is keyed BY TASK. A flat list would let one task's refusals spend
# the allowance another task has not touched. It lives on disk, so the bound
# survives a reboot, a killed supervisor and a scheduler restart.
#
# This file only READS and WRITES it. Whether an attempt is permitted is decided
# by zera-quota-grant.mjs, which reads the same ledger and never writes it, so a
# prover that crashed cannot burn an attempt.

function Read-RetryLedger {
    if (-not (Test-Path $RetryFile)) { return @{} }
    try {
        $obj = Get-Content $RetryFile -Raw -Encoding utf8 | ConvertFrom-Json
    } catch {
        # NOT "treat as empty": an unreadable ledger must never hand back a full
        # budget. Refuse, and let the caller fail closed.
        throw "retry ledger unreadable at $RetryFile; refusing to guess how much budget is left"
    }
    $out = @{}
    $props = @($obj.PSObject.Properties.Name)
    if ($props -contains 'tasks' -and $null -ne $obj.tasks) {
        foreach ($t in $obj.tasks.PSObject.Properties) {
            $list = @()
            if ($null -ne $t.Value -and @($t.Value.PSObject.Properties.Name) -contains 'attempts') {
                foreach ($a in $t.Value.attempts) { $list += "$a" }
            }
            $out[$t.Name] = $list
        }
    }
    return $out
}

function Spend-RetryBudget {
    param([Parameter(Mandatory = $true)][string]$TaskId)
    if ($DryRun) { Write-Host "DRY-RUN: would spend one attempt for $TaskId"; return }
    $ledger = Read-RetryLedger
    $list = @()
    if ($ledger.ContainsKey($TaskId)) { $list = @($ledger[$TaskId]) }
    $list += (Get-Date).ToUniversalTime().ToString('o')
    $ledger[$TaskId] = $list

    $tasks = [ordered]@{}
    foreach ($k in ($ledger.Keys | Sort-Object)) { $tasks[$k] = [pscustomobject]@{ attempts = @($ledger[$k]) } }
    $obj = [pscustomobject]@{ schemaVersion = 2; tasks = [pscustomobject]$tasks }

    # Atomic: write a sibling, then replace. A crash mid-write leaves the
    # previous ledger intact rather than a truncated one that reads as empty.
    $tmp = "$RetryFile.tmp"
    $obj | ConvertTo-Json -Depth 6 | Set-Content -Path $tmp -Encoding utf8 -Force
    Move-Item -Path $tmp -Destination $RetryFile -Force
    Write-Host "spent one attempt for $TaskId; ledger now holds $($list.Count) for it"
}


# ── Git, read-mostly ────────────────────────────────────────────────────────

function Git-Out([string[]]$argv, [string]$cwd = $RepoRoot) {
    $out = & git -C $cwd @argv 2>&1
    return @{ exit = $LASTEXITCODE; out = ($out -join "`n") }
}

# Fast-forward only, from the explicit remote ref. Never a bare local branch
# name as authority, never a reset, never a force.
function Update-Canonical {
    $status = Git-Out @('status', '--porcelain', '-uall')
    if ($status['exit'] -ne 0) { return @{ ok = $false; why = "git status failed: $($status.out)" } }
    if ($status['out'].Trim() -ne '') { return @{ ok = $false; why = 'source checkout is not clean' } }

    $branch = (Git-Out @('branch', '--show-current')).out.Trim()
    if ($branch -ne $CanonicalBranch) {
        return @{ ok = $false; why = "source checkout is on '$branch', not '$CanonicalBranch'" }
    }

    $fetch = Git-Out @('fetch', $CanonicalRemote, '--prune')
    if ($fetch.exit -ne 0) { return @{ ok = $false; why = "git fetch failed: $($fetch.out)" } }

    $remoteRef = "$CanonicalRemote/$CanonicalBranch"
    $remoteSha = (Git-Out @('rev-parse', $remoteRef)).out.Trim()
    $localSha  = (Git-Out @('rev-parse', 'HEAD')).out.Trim()
    if ($remoteSha -eq $localSha) { return @{ ok = $true; sha = $localSha; moved = $false } }

    if ($DryRun) {
        return @{ ok = $true; sha = $localSha; moved = $false; why = "DRY-RUN: would fast-forward to $remoteSha" }
    }
    $ff = Git-Out @('merge', '--ff-only', $remoteRef)
    if ($ff.exit -ne 0) { return @{ ok = $false; why = "fast-forward refused: $($ff.out)" } }
    $newSha = (Git-Out @('rev-parse', 'HEAD')).out.Trim()
    return @{ ok = $true; sha = $newSha; moved = $true }
}

# ── The classifier, AO's judgement ──────────────────────────────────────────

# The operator's standing quota authorisation, proved fresh every pass by a
# read-only file that writes nothing, not even the ledger it reads.
function Invoke-QuotaGrant {
    $lines = & node $QuotaGrant --repository $RepoRoot `
        --budget $RetryFile `
        --retry-hours $ResetUnrecordedRetryHours `
        --max-per-day $ResetUnrecordedMaxPerDay 2>&1
    $code = $LASTEXITCODE
    $map = @{}
    foreach ($l in $lines) {
        if ("$l" -match '^([A-Z_]+)\s*=\s*(.*)$') { $map[$Matches[1]] = $Matches[2].Trim() }
    }
    # Fail closed on a shape this cannot read: no verdict line means no grant.
    if (-not $map.ContainsKey('GRANT_VERDICT')) {
        return @{ exit = 2; map = @{ GRANT_REASON = "the prover printed no GRANT_VERDICT (exit $code)" }; lines = $lines }
    }
    return @{ exit = $code; map = $map; lines = $lines }
}

# The two 2026-09-13 standing authorisations, each proved fresh every pass by a
# read-only file that writes nothing.
#
# One helper for both, because they differ only in which script is run and which
# key prefix its verdict carries. Two copies would be two chances for one of
# them to lose the fail-closed guard below -- which is the whole safety property
# here: a prover that CRASHED prints no verdict, and a caller that read a
# missing verdict as anything but "no" would supply an operator grant on the
# strength of a script that never ran.
function Invoke-GrantProver {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [Parameter(Mandatory = $true)][string]$Prefix,
        [string[]]$ExtraArgs = @()
    )
    if (-not (Test-Path $Script)) {
        return @{ exit = 2; map = @{ "${Prefix}_REASON" = "no prover at $Script" }; lines = @() }
    }
    $lines = & node $Script --repository $RepoRoot @ExtraArgs 2>&1
    $code = $LASTEXITCODE
    $map = @{}
    foreach ($l in $lines) {
        if ("$l" -match '^([A-Z_]+)\s*=\s*(.*)$') { $map[$Matches[1]] = $Matches[2].Trim() }
    }
    if (-not $map.ContainsKey("${Prefix}_VERDICT")) {
        return @{ exit = 2; map = @{ "${Prefix}_REASON" = "the prover printed no ${Prefix}_VERDICT (exit $code)" }; lines = $lines }
    }
    return @{ exit = $code; map = $map; lines = $lines }
}

function Invoke-RepairGrant { return Invoke-GrantProver -Script $RepairGrant -Prefix 'REPAIR_GRANT' }

# The writer lane shares the retry ledger file with the quota lane, under the
# key `<taskId>#writer-restart`. The quota prover looks up the PLAIN task id, so
# the two allowances live in one file and neither can spend the other's.
function Invoke-WriterGrant {
    return Invoke-GrantProver -Script $WriterGrant -Prefix 'WRITER_GRANT' -ExtraArgs @(
        '--budget', $RetryFile,
        '--retry-hours', "$WriterRestartRetryHours",
        '--max-per-day', "$WriterRestartMaxPerDay"
    )
}

# The ledger key one automatic writer restart is spent against.
function Writer-RestartLedgerKey([string]$TaskId) { return "$TaskId#writer-restart" }

function Invoke-Classifier {
    $lines = & node $Classifier 2>&1
    $code = $LASTEXITCODE
    $map = @{}
    foreach ($l in $lines) {
        if ("$l" -match '^([A-Z_]+)\s*=\s*(.*)$') { $map[$Matches[1]] = $Matches[2].Trim() }
    }
    return @{ exit = $code; map = $map; lines = $lines }
}

# ── Delivery ────────────────────────────────────────────────────────────────
#
# Runs only for a task AO has left in READY_FOR_PR, which is terminal: the
# lifecycle is over and AO will not touch this task again. Nothing here changes
# a runtime record, a lease or AO itself.
#
# ── The one commit this supervisor authors, and why ─────────────────────────
#
# The repository profile's scope grant does not include
# .agent-orchestrator/tasks, so the writing agent cannot flip its own task file
# to DONE. That flip belongs in the delivery pull request — a task merged while
# its file still says OPEN blocks the whole wave, because AO keeps selecting it.
#
# So the supervisor authors exactly one commit on top of the verified head, and
# its diff is confined to that one task file. That IS a head drift, and pretending
# otherwise would be the lie this gate exists to prevent. It is handled honestly
# instead: zera-delivery-gate.mjs accepts a head above the verified commit only
# when the difference is precisely one commit touching precisely that file, and
# says so in its evidence. CI then runs `npm run verify` on the real head, so the
# merged commit is verified in its own right and not by inheritance.

function Invoke-Delivery {
    param([string]$TaskId)

    $recPath = Join-Path $RepoRoot ".agent-orchestrator\runtime\$TaskId.json"
    $rec = Get-Content $recPath -Raw -Encoding utf8 | ConvertFrom-Json
    # Read by property-existence, not by dot: under Set-StrictMode a record
    # physically missing a key throws HERE, before the guards below can report
    # RECORD_NAMES_NO_BRANCH — making them unreachable for the very case they
    # were written for.
    $recProps = @($rec.PSObject.Properties.Name)
    $branch   = if ($recProps -contains 'workBranch')   { $rec.workBranch }   else { $null }
    $worktree = if ($recProps -contains 'worktreePath') { $rec.worktreePath } else { $null }
    $script:Report['worktreeBranch'] = $branch

    if (-not $branch) { return @{ ok = $false; stop = 'RECORD_NAMES_NO_BRANCH'; why = "$TaskId's record names no work branch" } }
    if (-not $worktree -or -not (Test-Path $worktree)) {
        return @{ ok = $false; stop = 'WORKTREE_MISSING'; why = "$TaskId's worktree is not at $worktree" }
    }

    $wtStatus = Git-Out @('status', '--porcelain', '-uall') $worktree
    if ($wtStatus.exit -ne 0 -or $wtStatus.out.Trim() -ne '') {
        return @{ ok = $false; stop = 'WORKTREE_DIRTY'; why = "$TaskId's worktree has uncommitted changes" }
    }
    $wtBranch = (Git-Out @('branch', '--show-current') $worktree).out.Trim()
    if ($wtBranch -ne $branch) {
        return @{ ok = $false; stop = 'WORKTREE_ON_WRONG_BRANCH'; why = "$TaskId's worktree is on '$wtBranch', not '$branch'" }
    }

    # ---- 1. the delivery flip, if it is not already there -------------------
    $taskRel = ".agent-orchestrator/tasks/$TaskId.md"
    $taskAbs = Join-Path $worktree ".agent-orchestrator\tasks\$TaskId.md"
    if (-not (Test-Path $taskAbs)) {
        return @{ ok = $false; stop = 'TASK_FILE_MISSING'; why = "no $taskRel in $TaskId's worktree" }
    }
    $taskText = Get-Content $taskAbs -Raw -Encoding utf8
    if ($taskText -notmatch '(?m)^status:\s*DONE\s*$') {
        if ($taskText -notmatch '(?m)^status:\s*\S+\s*$') {
            return @{ ok = $false; stop = 'TASK_FILE_UNREADABLE'; why = "$taskRel has no status line" }
        }
        if ($DryRun) {
            Set-Action "DRY-RUN: would flip $taskRel to status: DONE and commit it"
        } else {
            Set-Action "flipping $taskRel to status: DONE"
            $flipped = [regex]::Replace($taskText, '(?m)^status:\s*\S+\s*$', 'status: DONE', 1)
            [System.IO.File]::WriteAllText($taskAbs, $flipped, (New-Object System.Text.UTF8Encoding($false)))
            $add = Git-Out @('add', '--', $taskRel) $worktree
            if ($add.exit -ne 0) { return @{ ok = $false; stop = 'FLIP_ADD_FAILED'; why = $add.out } }
            $msg = "chore(ao): mark $TaskId done in its delivery pull request`n`nDelivery packaging only. The repository profile's scope grant excludes`n.agent-orchestrator/tasks, so the writing agent could not flip its own task`nfile; a task merged while its file still says OPEN keeps being selected and`nblocks the wave. This commit's diff is confined to ${taskRel}."
            $commit = Git-Out @('commit', '--no-gpg-sign', '-m', $msg) $worktree
            if ($commit.exit -ne 0) { return @{ ok = $false; stop = 'FLIP_COMMIT_FAILED'; why = $commit.out } }
        }
    }

    $head = (Git-Out @('rev-parse', 'HEAD') $worktree).out.Trim()
    $script:Report['prHead'] = $head

    # ---- 2. publish the branch, create-only, never forced -------------------
    if ($DryRun) {
        Set-Action "DRY-RUN: would push $branch to $CanonicalRemote at $head"
    } else {
        Set-Action "pushing $branch to $CanonicalRemote"
        $push = Git-Out @('push', '--set-upstream', $CanonicalRemote, $branch) $worktree
        if ($push.exit -ne 0) {
            return @{ ok = $false; stop = 'PUSH_REFUSED'; why = "push of $branch refused: $($push.out)" }
        }
    }

    # ---- 3. open the pull request if there is not one already ---------------
    $prJson = & gh pr view $branch --repo (Get-RepoSlug) --json number,state,headRefOid 2>$null
    $prExists = ($LASTEXITCODE -eq 0)
    if (-not $prExists) {
        if ($DryRun) {
            Set-Action "DRY-RUN: would open a pull request for $branch against $CanonicalBranch"
        } else {
            Set-Action "opening a pull request for $branch"
            $body = "Delivered by the Zera unattended supervisor.`n`nAgentOrchestrator drove this task to READY_FOR_PR, which is terminal in its`nstate contract. Verification and review ran inside that lifecycle; this pull`nrequest carries the result plus one delivery-packaging commit flipping`n$taskRel to DONE.`n`nNo merge happens until zera-delivery-gate.mjs proves every standing`nauthorisation condition on this exact head, including that CI checks exist and`nall pass. Zero checks is a blocking condition, never success."
            Push-Location $worktree
            & gh pr create --base $CanonicalBranch --head $branch --title "$TaskId" --body $body | Out-Null
            $created = $LASTEXITCODE
            Pop-Location
            if ($created -ne 0) { return @{ ok = $false; stop = 'PR_CREATE_FAILED'; why = "gh pr create exited $created" } }
        }
    }
    if ($DryRun) {
        Set-Action "DRY-RUN: would now wait for CI on $head, then run the delivery gate"
        return @{ ok = $true; dryRun = $true }
    }

    $prJson = & gh pr view $branch --repo (Get-RepoSlug) --json number,headRefOid 2>$null
    if ($LASTEXITCODE -ne 0) { return @{ ok = $false; stop = 'PR_NOT_READABLE'; why = "could not read the pull request for $branch" } }
    $pr = $prJson | ConvertFrom-Json
    $script:Report['prNumber'] = $pr.number
    $script:Report['prHead'] = $pr.headRefOid
    Write-Status

    # ---- 4. wait for CI on that exact head, bounded ------------------------
    #
    # NO_CHECKS is two different things depending on when you ask, and treating
    # them alike breaks a healthy delivery.
    #
    # At MERGE time it is a blocking condition in its own right — that rule is
    # CI_REQUIRED and the gate enforces it. But in the seconds after `gh pr
    # create`, GitHub has not registered the workflow's check runs yet, and `gh
    # pr checks` writes its "no checks" message to STDERR and nothing to stdout.
    # So the first poll sees an empty array. Breaking there would end the wait
    # roughly 30 seconds into a perfectly healthy delivery, the gate would block
    # on checks-exist, and the run would stop with a false alarm.
    #
    # So NO_CHECKS gets its own grace window and only becomes terminal after it.
    $waited = 0
    $noChecksWaited = 0
    while ($true) {
        $checksRaw = & gh pr checks $pr.number --repo (Get-RepoSlug) --json name,bucket,state 2>$null
        $checks = @()
        if ($checksRaw) { try { $checks = @($checksRaw | ConvertFrom-Json) } catch { $checks = @() } }
        $pending = @($checks | Where-Object { $_.bucket -eq 'pending' })
        $script:Report['ciState'] = if ($checks.Count -eq 0) { 'NO_CHECKS' } elseif ($pending.Count -gt 0) { 'PENDING' } elseif (@($checks | Where-Object { $_.bucket -ne 'pass' }).Count -gt 0) { 'FAILED' } else { 'SUCCESS' }
        Write-Status

        if ($script:Report['ciState'] -eq 'NO_CHECKS') {
            if ($noChecksWaited -ge $CiNoChecksGraceMs) {
                return @{ ok = $false; stop = 'MERGE_BLOCKED_NO_CHECKS'; why = "PR #$($pr.number) still reports zero checks after $([int]($CiNoChecksGraceMs/60000)) min; under CI_REQUIRED that blocks, and it is not the same as a failure" }
            }
            Set-Action "PR #$($pr.number) reports no checks yet; giving GitHub time to register them"
            Start-Sleep -Milliseconds $CiPollMs
            $noChecksWaited += $CiPollMs
            $waited += $CiPollMs
            continue
        }
        if ($script:Report['ciState'] -ne 'PENDING') { break }
        if ($waited -ge $CiWaitMaxMs) {
            return @{ ok = $false; stop = 'CI_WAIT_EXHAUSTED'; why = "CI still pending on $($pr.headRefOid) after $([int]($CiWaitMaxMs/60000)) min" }
        }
        Set-Action "CI pending on PR #$($pr.number); waiting"
        Start-Sleep -Milliseconds $CiPollMs
        $waited += $CiPollMs
    }

    # ---- 5. the standing merge authorisation, proved condition by condition -
    Set-Action "running the delivery gate for $TaskId"
    $gateOut = & node $DeliveryGate --repository $RepoRoot --task $TaskId --pr $pr.number `
        --canonical-branch $CanonicalBranch 2>&1
    $gateExit = $LASTEXITCODE
    $gateOut | ForEach-Object { Write-Host $_ }

    # A gate that CRASHED prints no verdict. Reaching for `.Line` on the $null
    # that Select-String then returns throws under Set-StrictMode, which would
    # kill the supervisor instead of reporting a refusal — fail-closed on the
    # merge, but the stop reason and the notification would both be lost.
    $verdictMatch = $gateOut | Select-String '^GATE_VERDICT = ' | Select-Object -First 1
    $reasonMatch  = $gateOut | Select-String '^GATE_REASON = '  | Select-Object -First 1
    $headMatch    = $gateOut | Select-String '^GATE_PROVEN_HEAD = ' | Select-Object -First 1
    $verdict = if ($null -ne $verdictMatch) { $verdictMatch.Line } else { 'GATE_VERDICT = (none printed; the gate did not finish)' }
    $reason  = if ($null -ne $reasonMatch)  { $reasonMatch.Line }  else { "GATE_REASON = gate exited $gateExit without a reason" }

    if ($gateExit -ne 0) {
        $stopCode = if ($gateExit -eq 11) { 'NO_PULL_REQUEST' } else { 'MERGE_NOT_AUTHORISED' }
        return @{ ok = $false; stop = $stopCode; why = "$verdict`n$reason" }
    }

    # ---- 6. merge, pinned to the head the gate actually judged -------------
    #
    # Every condition the gate proved was evaluated against ONE oid. The CI wait
    # above can run 45 minutes, and a branch can move in that time — a manual
    # push from the worktree, an amended flip, a second writer that beat the
    # lock. Merging by PR number alone would merge whatever the head is NOW,
    # which the gate may never have seen: unverified, unscoped, unchecked.
    # `--match-head-commit` makes the server refuse exactly that.
    if ($null -eq $headMatch) {
        return @{ ok = $false; stop = 'GATE_PRINTED_NO_HEAD'; why = 'the gate authorised a merge but printed no GATE_PROVEN_HEAD; refusing to merge an unpinned head' }
    }
    $provenHead = ($headMatch.Line -replace '^GATE_PROVEN_HEAD = ', '').Trim()
    if ($provenHead -notmatch '^[0-9a-f]{40}$') {
        return @{ ok = $false; stop = 'GATE_HEAD_UNREADABLE'; why = "GATE_PROVEN_HEAD was '$provenHead', which is not a commit id" }
    }

    Set-Action "merge authorised for $TaskId; merging PR #$($pr.number) pinned to $provenHead"
    & gh pr merge $pr.number --repo (Get-RepoSlug) --merge --match-head-commit $provenHead 2>&1 |
        ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { return @{ ok = $false; stop = 'MERGE_FAILED'; why = "gh pr merge exited $LASTEXITCODE (the head may have moved away from $provenHead)" } }

    # The merge has already happened by this point. Anything that throws here
    # loses the record of it, so every hop is guarded rather than chained.
    $script:Report['lastMergeSha'] = 'unknown'
    try {
        $mergedRaw = & gh pr view $pr.number --repo (Get-RepoSlug) --json mergeCommit 2>$null
        if ($LASTEXITCODE -eq 0 -and $mergedRaw) {
            $merged = $mergedRaw | ConvertFrom-Json
            if ($null -ne $merged -and $null -ne $merged.mergeCommit -and $null -ne $merged.mergeCommit.oid) {
                $script:Report['lastMergeSha'] = $merged.mergeCommit.oid
            }
        }
    } catch {
        Write-Host "merge commit could not be read back: $($_.Exception.Message)"
    }
    Set-Action "$TaskId merged as $($script:Report['lastMergeSha'])"

    # ---- 7. fast-forward canonical ----------------------------------------
    $ff = Update-Canonical
    if (-not $ff['ok']) { return @{ ok = $false; stop = 'POST_MERGE_FF_FAILED'; why = $ff.why } }
    $script:Report['canonicalSha'] = $ff['sha']
    Write-Status
    return @{ ok = $true }
}

function Get-RepoSlug {
    $url = (Git-Out @('remote', 'get-url', $CanonicalRemote)).out.Trim()
    if ($url -match 'github\.com[:/]+([^/]+)/([^/.]+)') { return "$($Matches[1])/$($Matches[2])" }
    return $null
}

# ── Main ────────────────────────────────────────────────────────────────────

if (-not (Test-Path $TranscriptDir)) { New-Item -ItemType Directory -Path $TranscriptDir -Force | Out-Null }
$transcript = Join-Path $TranscriptDir "zera-supervisor-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
Start-Transcript -Path $transcript | Out-Null

if (-not (Acquire-Lock)) {
    $script:Report['stopReason'] = 'ANOTHER_SUPERVISOR_IS_RUNNING'
    Set-Action 'another supervisor holds the lock; exiting without doing anything'
    Write-Status
    Stop-Transcript | Out-Null
    exit 0
}

$aoExitCodes = @()
$pass = 0
# Per RUN, not per pass. Resetting it each pass would make the cap vacuous:
# every pass would get its own fresh allowance and the loop it exists to bound
# would run to $MaxOuterPasses exactly as if the cap were absent.
$writerDeathGrantsThisRun = 0

try {
    Set-Action "supervisor starting ($($script:Report['mode'])); source $SourceDir; state $StateDir; transcript $transcript"

    while ($pass -lt $MaxOuterPasses) {
        $pass = $pass + 1
        $deliveryFailed = $false
        # Reset per pass. A verdict left over from the previous pass would be
        # applied by Set-Classification before this pass has proved anything -
        # including in the finally block and on the crash path, where the status
        # would end up saying "no operator blockers" next to a stop reason that
        # says the opposite.
        $script:GrantAuthorised = $false
        $script:GrantNextRetry  = 'none'
        $script:CoveredEntries  = @()
        $script:CoveredNote     = ''
        $script:WriterNextRetry = 'none'
        $script:Report['recoveryLane'] = 'none'
        $recoveryLane = 'none'
        $recoveryTask = 'none'
        Write-Host ""
        Write-Host "===== supervisor pass $pass of $MaxOuterPasses ====="

        # ---- 1. canonical fast-forward, from the explicit remote ref --------
        Set-Action "updating canonical $CanonicalBranch from $CanonicalRemote"
        $ff = Update-Canonical
        if (-not $ff['ok']) {
            $script:Report['stopReason'] = 'CANONICAL_NOT_UPDATABLE'
            Set-Error $ff['why']
            Notify 'Zera supervisor stopped' "Canonical branch could not be updated: $($ff['why'])"
            break
        }
        $script:Report['canonicalSha'] = $ff['sha']
        if ($ff.ContainsKey('why')) { Write-Host $ff['why'] }

        # ---- 2. classify, read-only, before spending anything ---------------
        Set-Action 'classifying durable AO state (read-only)'
        $before = Invoke-Classifier
        $before.lines | ForEach-Object { Write-Host $_ }
        Set-Classification $before

        if ($before.exit -eq 2) {
            $script:Report['stopReason'] = 'CLASSIFIER_UNDECIDABLE'
            Set-Error "classifier could not decide: $($before.map['CLASSIFIER'])"
            Notify 'Zera supervisor stopped' "Durable state is undecidable. $($before.map['CLASSIFIER'])"
            break
        }
        # ---- 2b. the operator's standing quota authorisation ---------------
        #
        # `--continue-usage-limit` is and stays an OPERATOR grant. What changed
        # on 2026-09-12 is who stands behind it: the operator issued a narrow
        # standing authorisation so ordinary quota recovery does not need a
        # person at a keyboard. zera-quota-grant.mjs is that authorisation as a
        # predicate, evaluated fresh, read-only, outside AO.
        #
        # This is NOT AO granting itself continuation. AO refuses an automatic
        # resume here exactly as before; the supervisor supplies the operator
        # grant, on the operator's recorded instruction, and only when every
        # condition holds. Never describe it the other way round.
        $grant = Invoke-QuotaGrant
        $grant.lines | ForEach-Object { Write-Host $_ }

        if ($grant.exit -eq 2) {
            $script:Report['stopReason'] = 'QUOTA_GRANT_UNDECIDABLE'
            Set-Error "the standing quota authorisation could not be decided: $($grant.map['GRANT_REASON'])"
            Notify 'Zera supervisor stopped' ("The standing quota authorisation is undecidable, so nothing was granted." + [Environment]::NewLine + $grant.map['GRANT_REASON'])
            break
        }

        # The classifier's RAW blocker list, read before Set-Classification has
        # corrected anything. The correction is about how this supervisor
        # REPORTS what AO said; deciding which lanes to consult has to look at
        # what AO actually said.
        $blockersBefore = $before.map['OPERATOR_BLOCKERS']
        if (-not $blockersBefore) { $blockersBefore = 'none' }

        $grantAuthorised = ($grant.exit -eq 0)
        $grantTask = $grant.map['GRANT_TASK']
        $grantNextRetry = $grant.map['GRANT_NEXT_RETRY_AT']
        $grantBudget    = $grant.map['GRANT_BUDGET_STATE']
        $script:GrantAuthorised = $grantAuthorised
        $script:GrantNextRetry  = $grantNextRetry

        # ---- 2c. classification, corrected for the standing authorisation ---
        #
        # A quota state the authorisation covers is NOT an operator blocker. The
        # classifier can only report what AO's attention map says, and AO
        # correctly says a person must supply the grant. The operator already
        # supplied it, standing, so the honest status here is:
        #
        #   retry window open now      -> machine-progressable
        #   next retry in the future   -> FUTURE_WAKE, nobody is needed
        #   authorisation not met      -> a real operator blocker
        #
        # The classifier's own vocabulary is untouched; this only decides how
        # THIS supervisor reports and acts on it.
        if ($grantAuthorised) {
            $recoveryLane = 'QUOTA'
            $recoveryTask = $grantTask
            $script:Report['recoveryLane'] = $recoveryLane
            $script:Report['currentTask'] = $grantTask
            Set-Classification $before
        }
        elseif ($grantNextRetry -and $grantNextRetry -ne 'none') {
            Set-Classification $before
            if ($grantBudget -eq 'EXHAUSTED') {
                # The operating policy is explicit: park AND notify when the
                # budget is exhausted. Previously both refusals parked silently
                # and were indistinguishable to this script, so a task could sit
                # unreported for a full day while the scheduler re-parked it
                # every half hour.
                $script:Report['stopReason'] = 'QUOTA_RETRY_BUDGET_EXHAUSTED'
                Set-Action "quota retry budget exhausted for $grantTask; parking until $grantNextRetry"
                Notify 'Zera parked: quota retry budget exhausted' `
                    "$grantTask has spent every permitted continuation attempt in the last 24 h and is still quota-blocked.`nNext permitted attempt: $grantNextRetry`n`nThe standing authorisation is working as written; the provider allowance is the thing that has not come back. Nothing is wrong with the repository."
            } else {
                # An ordinary bounded wait. Nobody is told: the scheduler's next
                # trigger is exactly what should take this.
                $script:Report['stopReason'] = 'QUOTA_RETRY_WINDOW_NOT_OPEN'
                Set-Action "quota retry window is not open; next permitted attempt $grantNextRetry. The scheduler takes it from here."
            }
            break
        }
        elseif ($blockersBefore -ne 'none') {
            # ---- 2d. the two narrow 2026-09-13 recovery lanes ---------------
            #
            # Reached when the classifier names ANY operator blocker and the
            # quota authorisation does not cover it. Tried IN THIS ORDER, and at
            # most one of them can succeed, because each prover requires a
            # different exact AO state and a task has exactly one state.
            #
            # Gated on the BLOCKER LIST, not on the classifier's exit code, and
            # that is a correction rather than a preference. `autoProgress` is
            # `machineProgressable.length > 0 || futureWake !== null` over every
            # ranked task in every enlisted repository, so one unstarted task
            # anywhere makes the classifier exit 0 — while AO always selects
            # `ranking[0]`, which may be the blocked one. Gating on exit 10 would
            # leave both lanes unconsulted for exactly the task that is stuck.
            # Latent today, because one repository is enlisted and the CAPTURE
            # chain is linear; that is a fact about the configuration, not a
            # property of this code.
            #
            # Cost is still bounded: neither prover runs on a pass with no
            # operator blocker at all, which is every healthy pass.

            # Declared before either prover runs. Under Set-StrictMode a read of
            # an unassigned variable throws, and the writer prover is skipped
            # entirely when the repair lane fires first.
            $repairWhy = 'not consulted'
            $writerWhy = 'not consulted'
            $writer = $null

            $repair = Invoke-RepairGrant
            $repair.lines | ForEach-Object { Write-Host $_ }
            $repairWhy = $repair.map['REPAIR_GRANT_REASON']
            if ($repair.exit -eq 2) {
                $script:Report['stopReason'] = 'REPAIR_GRANT_UNDECIDABLE'
                Set-Error "the standing operator-repair authorisation could not be decided: $repairWhy"
                Notify 'Zera supervisor stopped' ("The standing operator-repair authorisation is undecidable, so nothing was granted." + [Environment]::NewLine + $repairWhy)
                break
            }
            if ($repair.exit -eq 0) {
                $recoveryLane = 'OPERATOR_REPAIR'
                $recoveryTask = $repair.map['REPAIR_GRANT_TASK']
                $script:Report['recoveryLane'] = $recoveryLane
                $script:Report['currentTask'] = $recoveryTask
                # BLOCKED_VERIFY is the only state that raises this reason, so
                # the pair names exactly the entry the grant answers.
                $script:CoveredEntries = @(@{ task = $recoveryTask; reason = 'VERIFICATION_REMEDIATION_REQUIRED' })
                $script:CoveredNote = 'covered by the proven standing operator-repair authorisation'
                Set-Classification $before
            }
            else {
                $writer = Invoke-WriterGrant
                $writer.lines | ForEach-Object { Write-Host $_ }
                $writerWhy = $writer.map['WRITER_GRANT_REASON']
                # A refusal for the RESTART BUDGET is a different sentence from a
                # refusal for the shape, and the operator needs them apart: one
                # says "this is not a dead writer", the other says "this writer
                # has died too often to keep restarting". Both refuse; only the
                # second means a person should look at the writer itself.
                if ($writer.map.ContainsKey('WRITER_GRANT_BUDGET_STATE') -and
                    $writer.map['WRITER_GRANT_BUDGET_STATE'] -ne 'OPEN' -and
                    $writer.map['WRITER_GRANT_BUDGET_STATE'] -ne 'UNKNOWN') {
                    $writerWhy = "$writerWhy (restart budget $($writer.map['WRITER_GRANT_BUDGET_STATE']); next permitted $($writer.map['WRITER_GRANT_NEXT_RETRY_AT']))"
                }
                if ($writer.exit -eq 2) {
                    $script:Report['stopReason'] = 'WRITER_GRANT_UNDECIDABLE'
                    Set-Error "the standing writer-death authorisation could not be decided: $writerWhy"
                    Notify 'Zera supervisor stopped' ("The standing writer-death authorisation is undecidable, so nothing was granted." + [Environment]::NewLine + $writerWhy)
                    break
                }
                if ($writer.exit -eq 0) {
                    $recoveryLane = 'WRITER_DEATH'
                    $recoveryTask = $writer.map['WRITER_GRANT_TASK']
                    $script:Report['recoveryLane'] = $recoveryLane
                    $script:Report['currentTask'] = $recoveryTask
                    $script:CoveredEntries = @(@{ task = $recoveryTask; reason = 'ESCALATED_DECISION_REQUIRED' })
                    $script:CoveredNote = 'covered by the proven standing writer-restart authorisation'
                    Set-Classification $before
                }
            }

            # ---- 2e. a writer-restart refusal that is only a CLOSED WINDOW ---
            #
            # The same split the quota lane already makes, and for the same
            # reason: "the authorisation does not cover this" and "the
            # authorisation covers this and the window is shut" are different
            # sentences, and only the first needs a person.
            #
            # Keyed on the prover's REASON being EXACTLY the budget condition,
            # never on the budget state alone. A task can carry spent restarts
            # and then move to a state this lane does not cover at all — a
            # BLOCKED_AUTH after two restarts, say — and parking that silently
            # because the ledger happens to say SPACING would hide a real
            # blocker behind an unrelated timer.
            #
            # `$before.exit -eq 10` is a term here for the same reason it is a
            # term on the stop below, and leaving it out was a defect a review
            # caught: with the lane gate widened to "a blocker is NAMED", a pass
            # whose writer window happens to be shut WHILE something else is
            # machine-progressable would have stopped without invoking AO at
            # all, where before it ran `repositories --attended` and made
            # progress. Parking is only correct when there is nothing else to do.
            if ($recoveryLane -eq 'none' -and $before.exit -eq 10 -and $null -ne $writer -and
                $writer.map['WRITER_GRANT_REASON'] -eq 'restart-budget-permits-an-attempt') {
                $writerTask  = $writer.map['WRITER_GRANT_TASK']
                $writerState = $writer.map['WRITER_GRANT_BUDGET_STATE']
                $writerNext  = $writer.map['WRITER_GRANT_NEXT_RETRY_AT']

                # The authorisation DOES cover this task; only its window is
                # shut. So its own entry is masked -- and every other entry is
                # not, because this park says nothing about them.
                $script:CoveredEntries = @(@{ task = $writerTask; reason = 'ESCALATED_DECISION_REQUIRED' })
                $script:CoveredNote = "covered by the standing writer-restart authorisation; its window reopens at $writerNext"
                Set-Classification $before

                if ($writerState -eq 'EXHAUSTED') {
                    $script:Report['stopReason'] = 'WRITER_RESTART_BUDGET_EXHAUSTED'
                    Set-Action "writer restart budget exhausted for $writerTask; parking until $writerNext"
                    Notify 'Zera parked: writer restart budget exhausted' `
                        "$writerTask has spent every permitted automatic writer restart in the last 24 h and came back to the same shape each time.`nNext permitted restart: $writerNext`n`nThe standing authorisation is working as written. A writer that will not stay alive is the thing that needs a person."
                } else {
                    # An ordinary bounded wait. Nobody is told ABOUT THIS TASK:
                    # the scheduler's next trigger is exactly what should take it.
                    $script:Report['stopReason'] = 'WRITER_RESTART_WINDOW_NOT_OPEN'
                    $script:WriterNextRetry = $writerNext
                    $script:Report['futureWake'] = $writerNext
                    $script:Report['nextWake']   = $writerNext
                    Set-Action "writer restart window is not open; next permitted attempt $writerNext. The scheduler takes it from here."

                    # But a SECOND blocker sitting beside it is nobody's timer.
                    # The prover only ever judges ranking[0], so anything the
                    # corrected list still names is unanswered by this park and
                    # a person has to hear about it.
                    if ($script:Report['operatorBlockers'] -ne 'none' -and
                        $script:Report['operatorBlockers'] -notlike 'none *') {
                        Notify 'Zera needs a decision' ($script:Report['operatorBlockers'] + [Environment]::NewLine + [Environment]::NewLine +
                            "$writerTask is parked until $writerNext under the standing writer-restart authorisation, and that park answers nothing above.")
                    }
                }
                break
            }

            if ($recoveryLane -eq 'none' -and $before.exit -eq 10) {
                # No standing authorisation covers this, and nothing a machine
                # can move. THIS is when a person is genuinely needed.
                #
                # The `$before.exit -eq 10` term is what keeps this branch from
                # widening with the lane gate above: the lanes are now consulted
                # whenever a blocker is NAMED, but stopping the whole run is
                # still reserved for a pass with nothing machine-progressable in
                # it, exactly as before.
                $script:Report['stopReason'] = if ($pass -eq 1) { 'OPERATOR_ONLY_BEFORE_FIRST_PASS' } else { 'OPERATOR_ONLY' }
                Set-Action "nothing a machine can move; blockers: $($script:Report['operatorBlockers'])"
                $grantWhy = $grant.map['GRANT_REASON']
                if ($script:Report['operatorBlockers'] -ne 'none') {
                    Notify 'Zera needs a decision' ($script:Report['operatorBlockers'] + [Environment]::NewLine + [Environment]::NewLine +
                        "No standing authorisation covers this." + [Environment]::NewLine +
                        "  quota           : $grantWhy" + [Environment]::NewLine +
                        "  operator-repair : $repairWhy" + [Environment]::NewLine +
                        "  writer-death    : $writerWhy")
                }
                break
            }
        }

        $digestBefore = $before.map['STATE_DIGEST']
        $wakeBefore   = $before.map['FUTURE_WAKE']

        # ---- 3. one AO invocation ------------------------------------------
        # Called directly: no pipe, no Tee-Object, so the exit code is AO's own.
        # No --idle-poll-ms, so AO itself stops idling when nothing is recorded.
        #
        # Four shapes, and AT MOST ONE grant ever appears in any of them. Which
        # one is decided above, by $recoveryLane, and the lanes are mutually
        # exclusive because each prover requires a different exact AO state.
        #
        #   none            `repositories --attended`. No grant at all. This is
        #                   the ordinary pass and the one a healthy task takes.
        #   QUOTA           `run --attended --task <id> --continue-usage-limit`
        #   OPERATOR_REPAIR `run --attended --task <id> --verify-operator-repair`
        #   WRITER_DEATH    `run --attended --task <id> --continue-human-decision`
        #
        # All three grants need --attended and --task by their own CLI contract,
        # all three are bought ONE task at a time, and none of them waits,
        # retries or asserts anything about the world: only that the operator
        # decided, standing, that this exact shape may proceed.
        #
        # These stay forbidden automatically, in every shape and forever:
        #   --recover-stale-lease       lease recovery or steal
        #   --remediate-verify-failure  a verification override that starts a
        #                               writer against a recorded failure
        # and no scope override of any kind.
        if ($recoveryLane -eq 'QUOTA') {
            if ($DryRun) {
                Set-Action "DRY-RUN: would spend one attempt for $grantTask and invoke: run --attended --task $grantTask --continue-usage-limit --max-steps $AoMaxSteps"
            } else {
                # Spend BEFORE invoking. A supervisor killed mid-invocation must
                # not get the attempt back for free: that is how a bound becomes
                # advisory.
                Spend-RetryBudget -TaskId $grantTask
                Set-Action "standing authorisation covers $grantTask; invoking AO with --continue-usage-limit"
                Push-Location $AoRoot
                & node .\dist\cli\index.js run --repository $RepoRoot --attended `
                    --task $grantTask `
                    --continue-usage-limit `
                    --max-steps $AoMaxSteps
                $lastAoExit = $LASTEXITCODE
                Pop-Location
                $aoExitCodes += $lastAoExit
                Write-Host "AO exit code (pass ${pass}, granted continuation): $lastAoExit"

                # ---- what the predicate could not see ----------------------
                #
                # attentionForTaskState is a pure function of the task's state,
                # and AO's own module says so: it "cannot see conditions that are
                # not in a task record at all. A repository whose profile stopped
                # parsing, a lease whose owner cannot be proven dead, an auth
                # preflight that failed". Those are checked INSIDE the invocation,
                # after the lease is taken, so the grant is issued and the attempt
                # is spent before any of them can refuse.
                #
                # That is unavoidable. What is avoidable is repeating it three
                # more times in silence. An expired agent login moves the task to
                # BLOCKED_AUTH, and a task that left the quota block for any state
                # that is not itself a quota block is exactly the case a person
                # must hear about at once.
                $postPath = Join-Path $RepoRoot (Join-Path ".agent-orchestrator" (Join-Path "runtime" "${grantTask}.json"))
                if (Test-Path $postPath) {
                    $postState = $null
                    try { $postState = (Get-Content $postPath -Raw -Encoding utf8 | ConvertFrom-Json).state } catch { $postState = $null }
                    if ($postState -and $postState -ne 'BLOCKED_USAGE_LIMIT') {
                        $stillBlocking = @('BLOCKED_AUTH','BLOCKED_VERIFY','SCOPE_VIOLATION','RESUME_STATE_DIVERGED','HUMAN_DECISION_REQUIRED')
                        if ($stillBlocking -contains $postState) {
                            $script:Report['aoState'] = $postState
                            $script:Report['stopReason'] = "GRANTED_ATTEMPT_ENDED_IN_$postState"
                            Set-Error "$grantTask left the quota block and is now $postState; the standing quota authorisation does not cover that"
                            Notify "Zera needs a decision: $grantTask is $postState" `
                                "A granted usage-limit continuation was spent, and $grantTask did not come back to BLOCKED_USAGE_LIMIT. It is now ${postState} instead.`n`nThat is not a quota condition and the standing authorisation does not cover it. No further attempts will be spent on it automatically."
                            $deliveryFailed = $true
                        }
                    }
                }
            }
        }
        elseif ($recoveryLane -eq 'OPERATOR_REPAIR') {
            # The operator's own repair, already in the worktree, adopted by AO.
            #
            # NOTHING IS COMMITTED HERE. This branch writes no file in the
            # worktree, stages nothing and commits nothing. AO's own
            # `commitOperatorRepair` does the one write, under AO's commit
            # controls, against an assessment that already said yes.
            if ($DryRun) {
                Set-Action "DRY-RUN: would invoke: run --attended --task $recoveryTask --verify-operator-repair --max-steps $AoMaxSteps"
            } else {
                Set-Action "standing authorisation covers $recoveryTask; invoking AO with --verify-operator-repair"
                Push-Location $AoRoot
                & node .\dist\cli\index.js run --repository $RepoRoot --attended `
                    --task $recoveryTask `
                    --verify-operator-repair `
                    --max-steps $AoMaxSteps
                $lastAoExit = $LASTEXITCODE
                Pop-Location
                $aoExitCodes += $lastAoExit
                Write-Host "AO exit code (pass ${pass}, granted operator repair): $lastAoExit"

                # The same residual the quota lane carries: the predicate cannot
                # see a lease taken since, a profile that stopped parsing or an
                # auth preflight that failed. Those refuse INSIDE the invocation.
                #
                # Two endings are reported, not one. A review found this branch
                # testing only BLOCKED_VERIFY, where the quota lane tests five:
                # an adoption that ran and then left the task in SCOPE_VIOLATION
                # or BLOCKED_AUTH would have gone unreported in the pass that
                # caused it.
                $postPath = Join-Path $RepoRoot (Join-Path ".agent-orchestrator" (Join-Path "runtime" "${recoveryTask}.json"))
                if (Test-Path $postPath) {
                    $postState = $null
                    try { $postState = (Get-Content $postPath -Raw -Encoding utf8 | ConvertFrom-Json).state } catch { $postState = $null }
                    $repairStillBlocking = @('BLOCKED_VERIFY','BLOCKED_AUTH','SCOPE_VIOLATION','RESUME_STATE_DIVERGED','HUMAN_DECISION_REQUIRED')
                    if ($postState -and ($repairStillBlocking -contains $postState)) {
                        $script:Report['aoState'] = $postState
                        $script:Report['stopReason'] = if ($postState -eq 'BLOCKED_VERIFY') { 'GRANTED_REPAIR_NOT_ADOPTED' } else { "GRANTED_REPAIR_ENDED_IN_$postState" }
                        Set-Error "$recoveryTask is $postState after a granted adoption; the standing authorisation goes no further"
                        # DELIBERATELY NOT "the worktree is unchanged". That was
                        # written here and it is false in a reachable AO outcome:
                        # `COMMITTED_BEYOND_APPROVED_SCOPE` KEEPS the commit --
                        # `operator-repair.ts` says the evidence is the point --
                        # and reports the task as not adopted with HEAD moved. A
                        # notification telling an operator the tree is untouched
                        # would send them looking in the wrong place.
                        Notify "Zera needs a decision: $recoveryTask is $postState" `
                            "The standing operator-repair authorisation was proven and supplied, and $recoveryTask came back as ${postState}.`n`nAO either refused the adoption for a condition the prover cannot see — a lease taken since, a profile that stopped parsing, an auth preflight, a reconciliation that diverged — or made a commit it then judged to reach beyond the approved paths, which it KEEPS as evidence rather than unwinding.`n`nSo do not assume the worktree is unchanged: read the run's own output, and the work branch's git log, before deciding. Nothing further is attempted on it automatically."
                        $deliveryFailed = $true
                    }
                }
            }
        }
        elseif ($recoveryLane -eq 'WRITER_DEATH') {
            # A writing agent that did not run to its own end, restarted.
            #
            # Bounded per supervisor run, and that bound is not decoration. This
            # is the only lane that STARTS AN AGENT against an unchanged tree: a
            # writer that dies again returns the task to the identical shape, the
            # prover proves the identical grant, and without a cap one run would
            # spend twelve writer starts on the same dead writer.
            #
            # The cap is the house rule -- retry, then hand the decision back --
            # and hitting it is a notification, because a writer dying twice in a
            # row is exactly the condition a person needs to hear about rather
            # than have silently re-attempted every half hour.
            if ($writerDeathGrantsThisRun -ge $WriterDeathMaxPerRun) {
                $script:Report['stopReason'] = 'WRITER_DEATH_RETRIES_EXHAUSTED'
                Set-Action "writer-death retries exhausted for $recoveryTask ($writerDeathGrantsThisRun of $WriterDeathMaxPerRun this run)"
                Notify "Zera needs a decision: $recoveryTask keeps losing its writer" `
                    "$recoveryTask has had $writerDeathGrantsThisRun automatic writer restarts in this supervisor run and came back to the same shape each time.`n`nThe standing authorisation covers a writer that died once, not a writer that will not stay alive. Nothing further is attempted automatically in this run."
                $deliveryFailed = $true
            }
            elseif ($DryRun) {
                Set-Action "DRY-RUN: would spend one restart for $(Writer-RestartLedgerKey $recoveryTask) and invoke: run --attended --task $recoveryTask --continue-human-decision --max-steps $AoMaxSteps"
            } else {
                # Counted and SPENT before invoking, for the reason the quota
                # ledger is spent before invoking: a supervisor killed
                # mid-invocation must not get the attempt back for free. That is
                # how a bound becomes advisory.
                $writerDeathGrantsThisRun = $writerDeathGrantsThisRun + 1
                Spend-RetryBudget -TaskId (Writer-RestartLedgerKey $recoveryTask)
                Set-Action "standing authorisation covers $recoveryTask; invoking AO with --continue-human-decision (restart $writerDeathGrantsThisRun of $WriterDeathMaxPerRun this run)"
                Push-Location $AoRoot
                & node .\dist\cli\index.js run --repository $RepoRoot --attended `
                    --task $recoveryTask `
                    --continue-human-decision `
                    --max-steps $AoMaxSteps
                $lastAoExit = $LASTEXITCODE
                Pop-Location
                $aoExitCodes += $lastAoExit
                Write-Host "AO exit code (pass ${pass}, granted writer restart): $lastAoExit"

                # A task that left HUMAN_DECISION_REQUIRED for a DIFFERENT
                # blocking state is not this authorisation's business, and the
                # prover would refuse it next pass anyway. Saying so at once is
                # the difference between an operator learning today and learning
                # when they next read a status file.
                $postPath = Join-Path $RepoRoot (Join-Path ".agent-orchestrator" (Join-Path "runtime" "${recoveryTask}.json"))
                if (Test-Path $postPath) {
                    $postState = $null
                    try { $postState = (Get-Content $postPath -Raw -Encoding utf8 | ConvertFrom-Json).state } catch { $postState = $null }
                    $notCovered = @('BLOCKED_AUTH','SCOPE_VIOLATION','RESUME_STATE_DIVERGED')
                    if ($postState -and ($notCovered -contains $postState)) {
                        $script:Report['aoState'] = $postState
                        $script:Report['stopReason'] = "GRANTED_RESTART_ENDED_IN_$postState"
                        Set-Error "$recoveryTask left the writer-death shape and is now $postState; the standing authorisation does not cover that"
                        Notify "Zera needs a decision: $recoveryTask is $postState" `
                            "A granted writer restart ran, and $recoveryTask is now ${postState}.`n`nThat is not a dead writer and the standing authorisation does not cover it. Nothing further is attempted on it automatically."
                        $deliveryFailed = $true
                    }
                }
            }
        }
        elseif ($DryRun) {
            Set-Action 'DRY-RUN: would invoke AO `repositories --attended --wait-for-reset` here; skipping'
        } else {
            Set-Action 'invoking AgentOrchestrator'
            Push-Location $AoRoot
            & node .\dist\cli\index.js repositories --attended `
                --max-steps $AoMaxSteps `
                --max-invocations $AoMaxInvocs `
                --wait-for-reset `
                --max-wait-ms $AoMaxWaitMs `
                --max-cycles $AoMaxCycles
            $lastAoExit = $LASTEXITCODE
            Pop-Location
            $aoExitCodes += $lastAoExit
            Write-Host "AO exit code (pass ${pass}): $lastAoExit"
        }

        # ---- 3b. the coverage expires with the state it was proved against --
        #
        # A grant proves that a standing authorisation covers ONE state, the one
        # the prover read before this invocation. It says nothing about the state
        # the invocation produced. Carrying the correction past this point is how
        # a second writer death became SILENT:
        #
        #   pass 1 grants WRITER_DEATH and sets the covered pair;
        #   the writer dies again, so the state is HUMAN_DECISION_REQUIRED again;
        #   `Set-Classification $after` matches the stale pair and rewrites the
        #   blockers to "none (covered by ...)";
        #   the OPERATOR_ONLY notify below is guarded by `-notlike 'none *'` and
        #   therefore does not fire.
        #
        # The run would stop naming an operator blocker and wake nobody — the
        # exact failure the note in the no-progress guard exists to prevent. A
        # review found it; this line is the fix.
        $script:CoveredEntries = @()
        $script:CoveredNote    = ''

        # ---- 4. delivery for anything AO has finished ----------------------
        foreach ($taskId in $MergeAuthorisedTasks) {
            $recPath = Join-Path $RepoRoot ".agent-orchestrator\runtime\$taskId.json"
            if (-not (Test-Path $recPath)) { continue }
            # Deliberately NOT $state. PowerShell variable names are
            # case-insensitive and a loop body runs at SCRIPT scope, so `$state`
            # here and the status object are one variable. The 2026-09-12 dry
            # run proved it: this assignment replaced the whole status object
            # with $null and then with a string, and every later write to it
            # failed with "property not found for this object".
            $recordState = $null
            try { $recordState = (Get-Content $recPath -Raw -Encoding utf8 | ConvertFrom-Json).state } catch { continue }
            if ($recordState -ne 'READY_FOR_PR') { continue }

            # READY_FOR_PR is TERMINAL — AO never leaves it. So a task stays in
            # that state after its pull request has been merged, forever. Without
            # this guard the next pass re-enters delivery on an already-merged
            # task: the flip is there, the push says "everything up-to-date",
            # `gh pr view <branch>` resolves the merged PR, and the gate then
            # blocks on pr-is-open. The supervisor would read that as a delivery
            # refusal, stop the whole run, and notify the operator — every 30
            # minutes, forever, starting the moment it first SUCCEEDS. The tasks
            # queued behind it would never be reached.
            $alreadyMerged = $false
            try {
                $prState = & gh pr view "ao/task/$taskId" --repo (Get-RepoSlug) --json state 2>$null
                if ($LASTEXITCODE -eq 0 -and $prState) {
                    $parsedPr = $prState | ConvertFrom-Json
                    if ($null -ne $parsedPr -and $parsedPr.state -eq 'MERGED') { $alreadyMerged = $true }
                }
            } catch {
                # Unreadable is not "merged". Fall through and let the gate decide.
            }
            if ($alreadyMerged) {
                Write-Host "$taskId is READY_FOR_PR but its pull request is already MERGED; nothing to deliver"
                continue
            }

            $script:Report['currentTask'] = $taskId
            $script:Report['aoState'] = $recordState
            Set-Action "$taskId is READY_FOR_PR; entering delivery"

            $delivered = Invoke-Delivery -TaskId $taskId
            if (-not $delivered['ok']) {
                # NO_PULL_REQUEST is a stage, not a refusal: the branch is not
                # published yet and the next pass will publish it. It must not
                # stop the run or wake the operator.
                if ($delivered['stop'] -eq 'NO_PULL_REQUEST') {
                    Write-Host "$taskId has no pull request yet; leaving it for the next pass"
                    continue
                }
                $script:Report['stopReason'] = $delivered['stop']
                Set-Error $delivered['why']
                Notify "Zera delivery stopped on $taskId" $delivered['why']
                $deliveryFailed = $true
                break
            }
        }

        # A delivery that stopped owns the stop reason. Falling through to the
        # no-progress guard below would let it overwrite MERGE_NOT_AUTHORISED or
        # CI_WAIT_EXHAUSTED with NO_PROGRESS_AND_NO_FUTURE_WAKE, which reads as
        # "nothing to do" rather than "a delivery was refused".
        if ($deliveryFailed) { break }

        # ---- 5. no-progress guard ------------------------------------------
        $after = Invoke-Classifier
        $digestAfter = $after.map['STATE_DIGEST']
        $wakeAfter   = $after.map['FUTURE_WAKE']
        Set-Classification $after

        if ($DryRun) { $script:Report['stopReason'] = 'DRY_RUN_SINGLE_PASS'; break }

        # Durable state moved, so whatever was last reported is no longer the
        # current condition. Let the next distinct one through.
        if ($digestAfter -ne $digestBefore) { Clear-NotifyStamp }

        if ($digestAfter -eq $digestBefore -and $wakeAfter -eq 'none') {
            $after.lines | ForEach-Object { Write-Host $_ }
            $script:Report['stopReason'] = 'NO_PROGRESS_AND_NO_FUTURE_WAKE'
            break
        }
        if ($after.exit -eq 10) {
            # Measured live 2026-09-12: CAPTURE-003 left the quota block for
            # HUMAN_DECISION_REQUIRED DURING a pass, the run stopped here, and
            # nobody was told - the only notify for that sat in the arm at the
            # START of a pass, which had already run while the state was still
            # quota. A stop that names an operator blocker must wake the operator
            # wherever in the pass it happens.
            $script:Report['stopReason'] = 'OPERATOR_ONLY'
            Set-Action "nothing a machine can move after this pass; blockers: $($script:Report['operatorBlockers'])"
            if ($script:Report['operatorBlockers'] -ne 'none' -and $script:Report['operatorBlockers'] -notlike 'none *') {
                Notify 'Zera needs a decision' "$($script:Report['operatorBlockers'])`n`nThis appeared during a supervisor pass, not before it. Nothing further is attempted automatically."
            }
            break
        }
        if ($after.exit -eq 2) {
            $script:Report['stopReason'] = 'CLASSIFIER_UNDECIDABLE'
            Set-Error "durable state became undecidable during this pass: $($after.map['CLASSIFIER'])"
            Notify 'Zera supervisor stopped' "Durable state is undecidable. $($after.map['CLASSIFIER'])"
            break
        }
    }

    if ($script:Report['stopReason'] -eq 'UNSET') { $script:Report['stopReason'] = 'OUTER_PASS_CAP_REACHED' }
}
catch {
    # Without this, a terminating error anywhere above unwinds straight through
    # the finally and out of the script: the status file keeps stopReason=UNSET,
    # no notification is sent, and the operator sees a supervisor that looks like
    # it simply had nothing to do. A crash must be loud.
    # A throw between a lane's grant and the expiry in step 3b -- Spend-RetryBudget
    # refusing an unreadable ledger is the live one -- reaches here with the
    # coverage still set, and the finally block's classification would then be
    # corrected by a pair nothing has proved about the state it is reading.
    $script:CoveredEntries = @()
    $script:CoveredNote    = ''
    $script:Report['stopReason'] = 'SUPERVISOR_CRASHED'
    $where = if ($null -ne $_.InvocationInfo) { " at line $($_.InvocationInfo.ScriptLineNumber)" } else { '' }
    Set-Error "supervisor crashed$where — $($_.Exception.Message)"
    Notify 'Zera supervisor crashed' "$($_.Exception.Message)$where`n`nThe loop stopped. Nothing was merged by this run."
}
finally {
    # ---- final report -------------------------------------------------------
    $final = Invoke-Classifier
    Set-Classification $final

    Write-Host ""
    Write-Host "===== FINAL ====="
    $final.lines | ForEach-Object { Write-Host $_ }
    Write-Host "STOP_REASON = $($script:Report['stopReason'])"
    Write-Host "SUPERVISOR_PASSES = $pass of $MaxOuterPasses"
    Write-Host "AO_EXIT_CODES = $($aoExitCodes -join ',')"

    Release-Lock
    Stop-Transcript | Out-Null
}

# AO's real exit code is the WORST of the passes, not the last. That is AO's own
# convention: exitCodeForScheduler folds every cycle and
# exitCodeForCrossRepositoryRun every admission, by EXIT_CODE_SEVERITY
# (src/cli/run-exit-codes.ts), whose order is 1, 3, 2, 4, 5, 0. Taking the last
# pass would let a clean final pass hide an earlier operator stop.
$severity = @(1, 3, 2, 4, 5, 0)
if ($aoExitCodes.Count -eq 0) {
    $exitCode = 0
} else {
    $exitCode = $aoExitCodes[0]
    foreach ($code in $aoExitCodes) {
        $iCode = $severity.IndexOf([int]$code)
        $iBest = $severity.IndexOf([int]$exitCode)
        if ($iCode -lt 0) { $exitCode = $code; break }
        if ($iCode -lt $iBest) { $exitCode = $code }
    }
}
exit $exitCode
