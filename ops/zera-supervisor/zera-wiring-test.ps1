# Structural proof that the supervisor cannot emit a grant flag outside its lane.
#
# The grant provers decide WHETHER a grant is authorised, and the lab proves
# that. This proves the other half: that the supervisor's dispatch can only
# reach a flag through the lane that proved it.
#
# It reads the script's own abstract syntax tree rather than grepping text, so
# a flag inside a comment, a string or a dead branch cannot pass for a command
# argument, and a flag moved into a different `if` clause is caught.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# The subject, overridable so a deliberately broken copy can be measured
# against this same test. A guarantee nobody has broken is a guarantee
# nobody has measured. By default, the supervisor deployed beside this file.
$Script = if ($args.Count -ge 1) { $args[0] } else { Join-Path $PSScriptRoot 'zera-supervisor.ps1' }

$errors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw "the supervisor does not parse: $($errors[0].Message)" }

$results = @()
function Check([string]$name, $got, $want) {
    $ok = ("$got" -eq "$want")
    $script:results += [pscustomobject]@{ name = $name; ok = $ok; got = $got; want = $want }
    Write-Host ("{0}  {1}  (got '{2}', expected '{3}')" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $got, $want)
}

# Every command invocation in the file, with its literal arguments.
$commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true))

function Find-FlagCommands([string]$flag) {
    $hits = @()
    foreach ($c in $commands) {
        foreach ($e in $c.CommandElements) {
            if ($e -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $e.Value -eq $flag) {
                $hits += $c
                break
            }
        }
    }
    return $hits
}

# Every `if` clause condition a node sits inside, innermost first.
#
# ALL of them, not the innermost one. The invocation the flag belongs to sits
# inside a `-DryRun` split nested inside the lane test, so an innermost-only
# answer reports `$DryRun` and proves nothing about the lane. Walking the whole
# chain is what makes the claim "this flag is reachable only through that lane"
# a measurement rather than a hope.
function Enclosing-IfConditions($node) {
    $conditions = @()
    $n = $node
    while ($null -ne $n) {
        $parent = $n.Parent
        if ($parent -is [System.Management.Automation.Language.IfStatementAst]) {
            foreach ($clause in $parent.Clauses) {
                # Item1 is the condition, Item2 the body. A node reached through
                # the body belongs to that clause.
                if ($clause.Item2.Extent.StartOffset -le $node.Extent.StartOffset -and
                    $clause.Item2.Extent.EndOffset -ge $node.Extent.EndOffset) {
                    $conditions += $clause.Item1.Extent.Text
                }
            }
        }
        $n = $parent
    }
    return $conditions
}

function Guarded-By($node, [string]$pattern) {
    foreach ($c in @(Enclosing-IfConditions $node)) {
        if ($c -match $pattern) { return $true }
    }
    return $false
}

# ---- 1. each grant flag appears exactly once, as a real command argument ----

$repairHits = @(Find-FlagCommands '--verify-operator-repair')
Check 'verify-operator-repair appears in exactly one command' $repairHits.Count 1

$writerHits = @(Find-FlagCommands '--continue-human-decision')
Check 'continue-human-decision appears in exactly one command' $writerHits.Count 1

$quotaHits = @(Find-FlagCommands '--continue-usage-limit')
Check 'continue-usage-limit appears in exactly one command' $quotaHits.Count 1

# ---- 2. each one sits in the clause its own lane guards --------------------

if ($repairHits.Count -eq 1) {
    Check 'verify-operator-repair is reachable only through the OPERATOR_REPAIR lane' `
        (Guarded-By $repairHits[0] "recoveryLane\s+-eq\s+'OPERATOR_REPAIR'") $true
    Write-Host "        guards: $(@(Enclosing-IfConditions $repairHits[0]) -join ' <- ')"
}
if ($writerHits.Count -eq 1) {
    Check 'continue-human-decision is reachable only through the WRITER_DEATH lane' `
        (Guarded-By $writerHits[0] "recoveryLane\s+-eq\s+'WRITER_DEATH'") $true
    Write-Host "        guards: $(@(Enclosing-IfConditions $writerHits[0]) -join ' <- ')"
}
if ($quotaHits.Count -eq 1) {
    Check 'continue-usage-limit is reachable only through the QUOTA lane' `
        (Guarded-By $quotaHits[0] "recoveryLane\s+-eq\s+'QUOTA'") $true
    Write-Host "        guards: $(@(Enclosing-IfConditions $quotaHits[0]) -join ' <- ')"
}

# Cross-check: no flag is reachable through ANOTHER lane's guard.
#
# Run only when all three flags were found exactly once. A count that is already
# wrong has been reported above, and indexing into an empty result to say so a
# second time would replace a clear failure with a crash.
if ($repairHits.Count -eq 1 -and $writerHits.Count -eq 1 -and $quotaHits.Count -eq 1) {
    Check 'verify-operator-repair is not under the WRITER_DEATH lane' `
        (Guarded-By $repairHits[0] "recoveryLane\s+-eq\s+'WRITER_DEATH'") $false
    Check 'continue-human-decision is not under the OPERATOR_REPAIR lane' `
        (Guarded-By $writerHits[0] "recoveryLane\s+-eq\s+'OPERATOR_REPAIR'") $false
    Check 'continue-usage-limit is not under either new lane' `
        (Guarded-By $quotaHits[0] "recoveryLane\s+-eq\s+'(OPERATOR_REPAIR|WRITER_DEATH)'") $false
} else {
    Write-Host '        cross-checks skipped: a flag count above is already wrong'
}

# ---- 3. the forbidden flags appear in no command at all --------------------

foreach ($forbidden in @('--recover-stale-lease', '--remediate-verify-failure', '--unattended')) {
    Check "$forbidden appears in no command" @(Find-FlagCommands $forbidden).Count 0
}

# ---- 4. the lane is only ever set from a proven verdict --------------------
#
# Every assignment to $recoveryLane in the file, with the value assigned. A lane
# set anywhere other than beside its own prover's exit code would be a lane the
# provers do not gate.
$assignments = @($ast.FindAll({
    param($n)
    $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $n.Left.Extent.Text -eq '$recoveryLane'
}, $true))
$assigned = @($assignments | ForEach-Object { $_.Right.Extent.Text })
Write-Host "        recoveryLane assignments: $($assigned -join ' | ')"
Check 'recoveryLane is assigned exactly four times' $assignments.Count 4
$wantLanes = @("'none'", "'QUOTA'", "'OPERATOR_REPAIR'", "'WRITER_DEATH'") | Sort-Object
Check 'recoveryLane values are none/QUOTA/OPERATOR_REPAIR/WRITER_DEATH' `
    (($assigned | Sort-Object) -join ',') ($wantLanes -join ',')

# ---- 4b. and each lane is set ONLY from its own prover's exit code ---------
#
# Section 4 proves the lane takes one of four values and section 2 proves the
# flag is reachable only through the lane. Neither of them sees a lane SET
# without a verdict: a mutant replacing `if ($repair.exit -eq 0)` with
# `if ($true)` survived both, and a supervisor like that would supply an
# operator grant on a refusal. Measured, then closed.
$laneGuards = @{
    "'QUOTA'"           = 'grantAuthorised'
    "'OPERATOR_REPAIR'" = 'repair\.exit\s+-eq\s+0'
    "'WRITER_DEATH'"    = 'writer\.exit\s+-eq\s+0'
}
foreach ($a in $assignments) {
    $value = $a.Right.Extent.Text
    if ($value -eq "'none'") { continue }
    $want = $laneGuards[$value]
    if ($null -eq $want) {
        Check "lane $value has a known guard" $false $true
        continue
    }
    Check "lane $value is set only under its own prover's verdict" (Guarded-By $a $want) $true
    Write-Host "        guards: $(@(Enclosing-IfConditions $a) -join ' <- ')"
}

# And that the quota lane's own boolean is the prover's exit code, so the
# indirection above cannot hide the same mutation one level down.
$grantAssign = @($ast.FindAll({
    param($n)
    $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $n.Left.Extent.Text -eq '$grantAuthorised'
}, $true))
Check 'grantAuthorised is assigned exactly once' $grantAssign.Count 1
if ($grantAssign.Count -eq 1) {
    Check 'grantAuthorised is the quota prover exit code' `
        ($grantAssign[0].Right.Extent.Text -match 'grant\.exit\s+-eq\s+0') $true
    Write-Host "        grantAuthorised = $($grantAssign[0].Right.Extent.Text)"
}

# ---- 4c. the whole chain, file -> prover -> variable -> guard -> flag ------
#
# Sections 2 and 4b prove the two ends. This is the middle: that the variable a
# lane guard tests really is the result of running that lane's own prover file.
# Without it, `$repair` could be assigned from anywhere and every other check
# here would still pass.
$srcText = Get-Content $Script -Raw -Encoding utf8

$chain = @(
    @{ lane = 'OPERATOR_REPAIR'; fn = 'Invoke-RepairGrant'; var = '$repair'; path = '$RepairGrant'; key = 'RepairGrant'; prefix = 'REPAIR_GRANT'; file = 'zera-operator-repair-grant.mjs' }
    @{ lane = 'WRITER_DEATH';    fn = 'Invoke-WriterGrant'; var = '$writer'; path = '$WriterGrant'; key = 'WriterGrant'; prefix = 'WRITER_GRANT'; file = 'zera-writer-death-grant.mjs' }
)
foreach ($c in $chain) {
    # a. the path variable names the prover file in the SOURCE folder. Two hops:
    # the variable is read from the path table, and the table joins the file
    # from $SourceDir. A prover joined from the state folder would be a script
    # run out of a folder that holds data, and fails here.
    Check "$($c['path']) names $($c['file']) in `$SourceDir" `
        (($srcText -match ([regex]::Escape($c['path']) + "\s*=\s*\`$ZeraPaths\['" + $c['key'] + "'\]")) -and
         ($srcText -match ("(?m)^\s*" + $c['key'] + "\s*=\s*Join-Path \`$SourceDir '" + [regex]::Escape($c['file']) + "'\s*$"))) $true

    # b. the wrapper function runs that path with that prefix
    Check "$($c['fn']) runs $($c['path']) with prefix $($c['prefix'])" `
        ($srcText -match ("function " + [regex]::Escape($c['fn']) + "[\s\S]{0,400}?-Script " + [regex]::Escape($c['path']) + " -Prefix '" + [regex]::Escape($c['prefix']) + "'")) $true

    # c. the guard variable carries the wrapper's result and nothing else.
    #
    # Not "assigned exactly once": `$writer` is also initialised to `$null`
    # before either prover runs, because Set-StrictMode throws on a read of an
    # unassigned variable and the writer prover is skipped when the repair lane
    # fires first. So the claim is the stronger and more useful one — EVERY
    # assignment is either that `$null` guard or the wrapper call, and exactly
    # one of them is the wrapper call.
    $varAssign = @($ast.FindAll({
        param($n)
        $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
        $n.Left.Extent.Text -eq $c['var']
    }, $true))
    $fromWrapper = @($varAssign | Where-Object { $_.Right.Extent.Text -eq $c['fn'] })
    $other = @($varAssign | Where-Object { $_.Right.Extent.Text -ne $c['fn'] -and $_.Right.Extent.Text -ne '$null' })
    Write-Host "        $($c['var']) assignments: $((@($varAssign | ForEach-Object { $_.Right.Extent.Text })) -join ' | ')"
    Check "$($c['var']) is the result of $($c['fn']) exactly once" $fromWrapper.Count 1
    Check "$($c['var']) is assigned from nothing else but `$null" $other.Count 0
}

# d. the shared wrapper fails closed when the prover printed no verdict.
Check 'Invoke-GrantProver returns exit 2 when no verdict was printed' `
    ($srcText -match "if \(-not \`$map\.ContainsKey\(`"\`$\{Prefix\}_VERDICT`"\)\) \{[\s\S]{0,200}?exit = 2") $true

# e. and when the prover file is missing at all.
Check 'Invoke-GrantProver returns exit 2 when the prover file is absent' `
    ($srcText -match "if \(-not \(Test-Path \`$Script\)\) \{[\s\S]{0,200}?exit = 2") $true

# ---- 5. the supervisor writes nothing into a worktree for the repair lane ---
#
# The one commit this supervisor authors is the delivery task-file flip, and it
# is confined to .agent-orchestrator/tasks. The repair lane must add no second
# writer. Proven by counting the commit invocations: there is still exactly one,
# and it is the flip.
$commits = @()
foreach ($c in $commands) {
    $text = $c.Extent.Text
    if ($text -match "Git-Out\s+@\('commit'" -or $text -match "'commit',") { $commits += $text }
}
Check 'the supervisor authors exactly one commit' $commits.Count 1
if ($commits.Count -ge 1) { Write-Host "        commit site: $($commits[0].Substring(0, [Math]::Min(90, $commits[0].Length)))" }

Write-Host ''
$failed = @($results | Where-Object { -not $_.ok })
Write-Host "WIRING_CASES = $($results.Count)"
Write-Host "WIRING_FAILED = $($failed.Count)"
foreach ($f in $failed) { Write-Host "FAILED: $($f.name) — got '$($f.got)', expected '$($f.want)'" }
Write-Host "WIRING_VERDICT = $(if ($failed.Count -eq 0) { 'ALL_PASS' } else { 'FAILURES' })"
exit $(if ($failed.Count -eq 0) { 0 } else { 1 })
