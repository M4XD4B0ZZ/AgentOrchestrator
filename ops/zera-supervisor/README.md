# Zera unattended operation

Everything in this directory is a **wrapper**. Nothing here is inside
`D:\AgentOrchestrator` and nothing here changes it.

## What runs what

```
Windows Task Scheduler  \Zera\Zera unattended supervisor
        │  at startup (+3 min), and every 30 min
        ▼
zera-supervisor.ps1 ──► ao-classify.mjs                (read-only: is there machine work?)
        │          ──► zera-quota-grant.mjs            (read-only: may the quota grant be used?)
        │          ──► zera-operator-repair-grant.mjs  (read-only: may the repair be adopted?)
        │          ──► zera-writer-death-grant.mjs     (read-only: may the writer be restarted?)
        │          ──► AgentOrchestrator               (repositories, or run + ONE grant flag)
        │          ──► zera-delivery-gate.mjs          (read-only: may this be merged?)
        │          ──► git / gh                        (fast-forward, push, PR, merge)
        ▼
zera-unattended-status.txt   one overwritten status line-set
transcripts/                 one full transcript per entry
```

## Division of authority

AgentOrchestrator is the authority for **selection, dependencies, durable runtime
state, resume eligibility, quota continuation, attention, and the
verification / review / remediation lifecycle**. Nothing here re-decides any of
that. `ao-classify.mjs` imports AO's own `attentionForTaskState`,
`usageLimitContinuation` and `safeParseTaskState` out of the shipped `dist/`, and
takes its eligible set from AO's own planner ranking.

The three grant provers follow the same rule and go further where AO ships the
judgement as a function. `zera-operator-repair-grant.mjs` **calls**
`assessOperatorRepair`, the same gate `run-driver.ts` consults, rather than
restating its eight conditions; `zera-writer-death-grant.mjs` computes AO's own
`grantReviewRound` with AO's own `reviewBudget` / `reviewBudgetExhausted` /
`MAX_REVIEW_BUDGET`. A second copy of a gate is a gate that can disagree with the
first, and it goes stale the moment AO adds a case.

**The provers run against the shipped `dist/`, so a stale runtime is a stale
decision.** Run `npm run deploy` in `D:\AgentOrchestrator` after any AO change
before the supervisor is enabled.

> **Correction, 2026-09-15.** This paragraph used to say `npm run build`. That
> is now wrong, and the reason it changed matters here. `npm run build` wrote
> `D:\AgentOrchestrator\dist` — the very directory every script in this folder
> executes — and `npm run verify` runs `npm run build`. So an ordinary
> verification run on an AO feature branch deployed unmerged code into this
> supervisor. It happened on 2026-09-14/15: a verify for PR #103 rebuilt `dist/`
> before that pull request was merged, and the next scheduled pass ran it.
>
> The fix is AO commit `ba1b93c` on branch
> `fix/build-output-vs-deployed-runtime`, open as
> [PR #104](https://github.com/M4XD4B0ZZ/AgentOrchestrator/pull/104).
> **It is not merged yet**, and this
> supervisor is still running the pre-fix runtime — `dist/` currently holds
> `main @ 2036198`'s build and carries no provenance record. Once the branch is
> merged, `npm run deploy` on clean `main` puts the new runtime in place and this
> paragraph becomes simply true.
>
> After that: `npm run build` writes `build/` and **never** `dist/`;
> `npm run deploy` is the only thing that writes `dist/`, it refuses a dirty tree
> and a non-canonical commit, and it records the commit it deployed in
> `dist/.ao-provenance.json`. Nothing in this folder changed: the path these
> scripts execute is still `D:\AgentOrchestrator\dist\cli\index.js`.
>
> To see which AO commit this supervisor is running:
> `Get-Content D:\AgentOrchestrator\dist\.ao-provenance.json`
>
> A `dist/` with no such record refuses to run at all, with exit code 7. That is
> deliberate: it is how the residue of the old in-place build stops being
> executed as though somebody had deployed it.
>
> Full decision:
> `D:\AgentOrchestrator\docs\decisions\2026-09-15-adr-build-output-and-deployed-runtime.md`

Delivery to github.com is **not** an AO rule for this repository. Measured:

```
agent-loop delivery --repository D:\Workspaces_VSCode\HealthApp --task CAPTURE-003
Delivery : DELIVERY_NOT_DECLARED — This repository declares no delivery target,
           so there is nothing to observe.
```

HealthApp's `.agent-orchestrator/repo-profile.yaml` has no `delivery:` section,
so AO will not publish a head, open a pull request or merge one here. Doing it in
the supervisor therefore duplicates no AO authority. **If that profile ever gains
a delivery target, hand these steps back to AO rather than keep two
implementations.**

## Stale-pin check — before any task starts or resumes (added 2026-09-23)

**Rule.** A task that has dependencies and was pinned before a dependency merged must not resume
merely because its `dependsOn` later became satisfied. The required invariant:

> a task's `basePinnedCommit` must contain the merge commit of every satisfied dependency.

AO does not check this today. The planner decides eligibility from task-file status alone
(`select-task.ts:247-249`), and automatic resume checks only that the pin is an ancestor of HEAD.
So a stale-pinned task resumes on a tree that lacks its dependency. That is recorded as an open AO
defect and is not fixed yet.

**AO has no supported re-pin.** `basePinnedCommit` is written once, when a task id first starts
(`start-task.ts:389`). `release` refuses any task that already has durable state, and writes no
state. AO's own README records the gap as D-REM-001-7: a used task id cannot be made runnable
again, and the answer is a fresh task id with the old record kept as evidence. Never edit or delete
a runtime JSON file to get around it.

**Check, read-only, for every non-terminal task whose dependencies are now `DONE`:**

```
git -C D:\Workspaces_VSCode\HealthApp merge-base --is-ancestor <dependency merge commit> <task basePinnedCommit>
```

Exit 0 means the pin contains the dependency. Exit 1 means the pin is stale: do not resume the
task, replace it with a fresh task id instead.

**Known stale pins, 2026-09-23 — keep the supervisor Disabled until they are replaced:**

| Task | Pin | Dependency | Dependency merged at | Status |
| --- | --- | --- | --- | --- |
| V1GAP-005 | `50340eb` | V1GAP-004 | `78ebbb6` (PR #248) | replaced by V1GAP-005R (PR #249, `d402198`) |
| V1GAP-006 | `50340eb` | V1GAP-004 | `78ebbb6` (PR #248) | replaced by V1GAP-006R (PR #249) |
| V1GAP-014 | `50340eb` | V1GAP-004 | `78ebbb6` (PR #248) | replaced by V1GAP-014R (PR #249) |
| V1GAP-009 | `50340eb` | V1GAP-008 | not merged | goes stale when V1GAP-008 merges; replacement owed |
| V1GAP-016 | `50340eb` | V1GAP-012 | not merged | goes stale when V1GAP-012 merges; replacement owed |

All five have zero commits, so a replacement loses nothing. Update 2026-09-23: the three
replacements are on the default, and the old files sit in `.agent-orchestrator/tasks/superseded/`,
so AO no longer discovers them. Their runtime records stay as evidence. V1GAP-009 and V1GAP-016
must be replaced the same way before V1GAP-008 or V1GAP-012 is delivered. Drafts are in
`D:\scratch_ao\meta-prep\drafts\`, and V1GAP-016R has an open scope decision.

## Open control-plane defects (recorded 2026-09-23; the memory-write defect was fixed 2026-09-25)

Open work, not accepted residuals. Each one was measured during attended runs on HealthApp.

- **A writer can edit the shared Claude memory outside its worktree.** The `claude` writer runs
  with auto-memory, so it can edit `~/.claude/projects/D--Workspaces-VSCode-HealthApp/memory/`,
  which is loaded into every later writer. AO's scope check is a git delta, so it cannot see this.
  This was measured three times, each by a fix-round writer:
  - V1GAP-004 r2 (2026-09-19) rewrote a scope rule;
  - V1GAP-005R r1 (2026-09-23) inserted one paragraph;
  - V1GAP-023 r1 (2026-09-24) edited `MEMORY.md` and one project note.

  The 005R and 023 changes were restored byte-exact on operator decision. The 023 evidence is in
  `D:\scratch_ao\v1gap-023\incident-memory-write-r1\`.

  Root cause, measured 2026-09-24:
  - the writer's system prompt carries a `# Memory` section, and `--setting-sources ''` does not
    remove it;
  - `acceptEdits` exempts the auto-memory folder;
  - every worktree maps to the main checkout's memory folder.

  Details: `D:\scratch_ao\ao-memory-hardening\root-cause-2026-09-24.md`.

  **FIXED 2026-09-25: AO-MEMGUARD-001.** AgentOrchestrator PR #108 was merged as `05dfc5d`. Exact-head CI
  and the push CI are green on Node 22 and 24. The runtime is deployed: `dist/` is at `05dfc5d`, `CANONICAL`.
  - **Prevention:**
    - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` is in the writer environment;
    - every launch passes `--settings` with `autoMemoryEnabled: false` and the deny rules
      `Edit/Write/MultiEdit/NotebookEdit(~/.claude/**)`.
  - **Detection:** a write outside the worktree in the stream, or a change to the memory folder's
    bytes, ends the run as `AGENT_FORBIDDEN_WRITE`. The task goes to `HUMAN_DECISION_REQUIRED`,
    nothing is committed, and nothing is restored.
  - **Evidence:** `<orchestrator home>\writer-violations\<worktree>\`.
  - **Quarantine:** while a record is open, no writer starts in that worktree
    (`AGENT_WRITE_QUARANTINED`). To lift it, review the record and move it into `acknowledged\`.
  - **Proof:** the opt-in real-CLI gate `npm run verify:writer-memory-guard` passed on the branch and
    on `05dfc5d`. Its unguarded control still writes; the three incident prompts leave the folder
    byte-identical; the absolute-path attempt is refused, recorded and quarantined.
  - **Still open:** the writer can *read* the folder, though it no longer loads it.
  - The ad-hoc operator hash guard is no longer required for writer steps. Keeping it costs nothing.
- **`--max-steps` cannot stop between review findings and the fix round.** This is by design
  (`run-driver.ts:964-967`: a pending remediation payload extends the budget by one step). The only
  enforceable scope guard around a fix round is therefore the audit after its commit.
- **A shell-free writer cannot do the handoff archive rotation.** Every task then draws
  `governance.handoff-rotation-missing` in review, and a round is spent on it. V1GAP-021 ended at
  HUMAN_DECISION_REQUIRED on that finding alone. Done by hand at delivery since 2026-09-23 (the
  delivery commit runs `git show <default>:handoffs/latest-handoff.md > handoffs/archive/...`).
  The archive also has a gap: nothing between CAPTURE-005 (2026-09-13) and V1GAP-004 was archived,
  and those handoffs survive only in git.
- **One review round costs about 4 Codex sessions** (1 lead plus 3 parallel slices). On
  2026-09-23, three review rounds after the 04:06Z window reset brought the 5-hour window to 90-96%
  (from the sessions' own `rate_limits`), and the fourth round stopped at BLOCKED_USAGE_LIMIT.

## Files

| File | What it is |
| --- | --- |
| `zera-supervisor.ps1` | the loop. The entry point. |
| `zera-delivery-gate.mjs` | read-only prover for the standing merge authorisation. |
| `zera-quota-grant.mjs` | read-only prover for the standing quota-continuation authorisation. |
| `zera-operator-repair-grant.mjs` | read-only prover for the standing operator-repair authorisation. Calls AO's own `assessOperatorRepair`. |
| `zera-writer-death-grant.mjs` | read-only prover for the standing writer-restart authorisation. Computes AO's own `grantReviewRound` and refuses unless it is false. |
| `zera-register-task.ps1` | registers / enables / removes the scheduled task. |
| `zera-grant-lab.mjs` | the dry-test lab for the grant provers. Builds a disposable AO repository per case and measures the verdict. Touches nothing real. |
| `zera-wiring-test.ps1` | structural proof, over the supervisor's own syntax tree, that a grant flag is reachable only through the lane that proved it. |
| `ao-classify.mjs` | read-only "is there machine-progressable work?" classifier. |
| `zera-unattended-status.txt` | current status, overwritten atomically. |
| `zera-retry-budget.json` | the bounded retry ledger. Keyed by task for quota continuations, and by `<task>#writer-restart` for writer restarts, so neither allowance can spend the other's. |
| `zera-last-notify.txt` | hash of the last notification sent, so an unchanged condition is not re-sent. |
| `zera-supervisor.lock` | pid lock; only honoured while that pid is alive. |
| `transcripts/` | one full transcript per supervisor entry. |
| `ao-overnight-run.ps1` | **superseded.** The 2026-09-11 night wrapper, kept for its history. Not the entry point. |
| `ao-capture-00*.ps1` | one-off operator commands from earlier waves. Not used by the supervisor. |

## Controlling it

```powershell
# see what it is doing
Get-Content C:\Users\Max\AO-runs\zera-unattended-status.txt

# dry run: classify and report, start nothing, change nothing
powershell -ExecutionPolicy Bypass -File C:\Users\Max\AO-runs\zera-supervisor.ps1 -DryRun

# ask the provers, read-only, without running the loop
node C:\Users\Max\AO-runs\zera-quota-grant.mjs --repository D:\Workspaces_VSCode\HealthApp
node C:\Users\Max\AO-runs\zera-operator-repair-grant.mjs --repository D:\Workspaces_VSCode\HealthApp
node C:\Users\Max\AO-runs\zera-writer-death-grant.mjs --repository D:\Workspaces_VSCode\HealthApp
node C:\Users\Max\AO-runs\zera-delivery-gate.mjs --repository D:\Workspaces_VSCode\HealthApp --task CAPTURE-003 --canonical-branch chore/clean-arch-structure

# re-verify the two new lanes. Both are read-only and touch nothing real.
node C:\Users\Max\AO-runs\zera-grant-lab.mjs            # 49 cases, expects LAB_VERDICT = ALL_PASS
powershell -ExecutionPolicy Bypass -File C:\Users\Max\AO-runs\zera-wiring-test.ps1   # 30 cases, expects WIRING_VERDICT = ALL_PASS

# turn it on / off
powershell -ExecutionPolicy Bypass -File C:\Users\Max\AO-runs\zera-register-task.ps1 -Enable
Disable-ScheduledTask -TaskName 'Zera unattended supervisor' -TaskPath '\Zera\'

# remove it entirely
powershell -ExecutionPolicy Bypass -File C:\Users\Max\AO-runs\zera-register-task.ps1 -Unregister
```

## The three grants it may supply, and the ones it may never

Every one of them is an **operator** grant and stays one. AO's state machine is
unchanged, and AO still refuses an automatic departure in all three cases. What
the operator issued is a narrow **standing** authorisation per case, proved
fresh every pass by a read-only file outside AO. Never describe any of this as
AO granting itself a continuation.

The lanes are **mutually exclusive**: at most one grant is supplied per pass,
and exactly one flag appears in the invocation it makes. Each prover requires a
different exact AO state, and a task has exactly one state.

| Lane | Flag | Prover | Issued |
| --- | --- | --- | --- |
| `QUOTA` | `--continue-usage-limit` | `zera-quota-grant.mjs` | 2026-09-12 |
| `OPERATOR_REPAIR` | `--verify-operator-repair` | `zera-operator-repair-grant.mjs` | 2026-09-13 |
| `WRITER_DEATH` | `--continue-human-decision` | `zera-writer-death-grant.mjs` | 2026-09-13 |

The status file reports which lane a pass took, as `recoveryLane`. `none` is the
ordinary case and the one every healthy task takes: neither new prover is even
consulted unless the classifier **names an operator blocker**.

The gate is the blocker list, not the classifier's exit code, and that is a
correction a review forced. `autoProgress` is
`machineProgressable.length > 0 || futureWake !== null` over every ranked task in
every enlisted repository, so one unstarted task anywhere makes the classifier
exit 0 — while AO always selects `ranking[0]`, which may be the blocked one.
Gating on exit 10 would leave both lanes unconsulted for exactly the task that is
stuck. Stopping the whole run still requires exit 10, exactly as before.

Never, in any shape, automatically:

| Grant | Why it stays the operator's |
| --- | --- |
| `--recover-stale-lease` | lease recovery or steal |
| `--remediate-verify-failure` | a verification override that starts a writer against a recorded failure |
| any scope override | the scope grant is the profile's |

It also never force-pushes, never resets, never deletes a worktree, and never
merges without the delivery gate proving every standing condition first.

### The operator-repair authorisation

For the case where **the operator has already repaired the exact tree AO
measured as failed**, and that repair is sitting uncommitted in the worktree.
The grant lets AO adopt it.

**The supervisor does not commit the repair and never may.** It writes no file
in the worktree, stages nothing and commits nothing. AO's own
`commitOperatorRepair` makes the one write, under AO's commit controls, against
an assessment that already said yes.

Eight of the ten conditions are AO's own, and AO ships them as one exported
function. `assessOperatorRepair` (`src/verify/operator-repair.ts`) is the gate
`run-driver.ts` itself consults before adopting, it writes nothing, and its
refusal vocabulary is closed — one member per proven condition:

| Condition | AO's refusal if it fails |
| --- | --- |
| state is exactly `BLOCKED_VERIFY` | `STATE_NOT_BLOCKED_VERIFY` |
| `resumeFrom.phase == REMEDIATE` | `RESUME_POINT_NOT_REMEDIATE` |
| a verification attempt history exists | `NO_VERIFICATION_ATTEMPT` |
| the **latest** attempt is `FAILED` | `LATEST_ATTEMPT_NOT_FAILED` |
| HEAD is still that attempt's `subjectCommit` | `HEAD_MOVED` / `HEAD_UNREADABLE` |
| the worktree carries a repair | `NOTHING_TO_ADOPT` / `WORKTREE_UNREADABLE` |
| the whole delta is `WITHIN_SCOPE` | `REPAIR_OUT_OF_SCOPE` |
| the scope is not indeterminate | `SCOPE_INDETERMINATE` |

That is eight conditions against ten refusal codes, because two of the codes are
the "Git would not answer" halves of their neighbours. Counted from
`OPERATOR_REPAIR_REFUSALS`, not from memory.

The prover **calls** that gate rather than re-deciding it. A hand-copied list
would be free to disagree with the gate it is predicting, and would go stale the
first time AO adds a refusal.

Two conditions are not AO's, because `assessOperatorRepair`'s own header says
identity, the lease, the authorised worktree and reconciliation are
`run-driver.ts`'s to prove. Those are proved from outside instead: `lease status`
says `FREE`, the task is still planner-selected, and its task file is not `DONE`.
The prover also checks that Git registers the worktree where the record says,
because it is not the driver and must not pass the record's claim through
unchecked.

Measured while testing this: a `BLOCKED_VERIFY` record naming any resume phase
other than `REMEDIATE` is **unrepresentable**. `resume-policy.ts` declares
`REMEDIATE` as the only one, and `safeParseTaskState` enforces it, so AO's
`RESUME_POINT_NOT_REMEDIATE` is unreachable from a stored record and the prover
fails closed one layer earlier — `UNDECIDABLE`, and the supervisor stops.

### The writer-restart authorisation

For **one producer** of `HUMAN_DECISION_REQUIRED`, measured repeatedly in real
CAPTURE-004 operation: the writing agent was interrupted during the implement
pass. AO parked the task with `blockedAgent: 'claude'` and
`resumeFrom: { phase: 'IMPLEMENT' }`. Nothing was decided, nothing reviewed, no
finding recorded. The useful move is to start the writer again.

**One producer is not one cause.** Read the next section before relying on the
narrower sentence — an earlier draft of this page used it and a review caught
it.

#### It is wider than "the process died", and that is stated rather than hidden

An earlier draft of the prover said this conjunction identifies a *dead* writer.
It does not, and the difference is not recoverable from any record. A review
caught it.

`AGENT_FAILURE_DISPOSITION` (`src/agent/agent-outcome.ts:140-156`) maps **four**
writer failure codes onto `AGENT_NEEDS_ATTENTION`, and all four are reachable
from `claude-writer.ts`:

| Code | What happened |
| --- | --- |
| `AGENT_PROCESS_UNAVAILABLE` | the process never reached its own end |
| `AGENT_NONZERO_EXIT` | it ran and exited non-zero |
| `AGENT_RESULT_MALFORMED` | it ran but printed no recognisable envelope |
| `AGENT_ARGUMENT_REFUSED` | it was never started: an argument was not shell-inert |

All four reach `recordInterruption` with the same fallback evidence
(`loop-step.ts:944-946`) and produce a **byte-identical** record: the failure
code is not persisted, because `TaskState` is `.strict()` and has no field for
it. So no predicate reading durable state can separate them.

What the authorisation therefore covers, honestly: **a writing agent that did not
complete its implement pass, whatever the diagnosis.** Three of the four are
worth one more attempt on their face. `AGENT_ARGUMENT_REFUSED` is deterministic
and a restart reproduces it — which is what the durable budget below is for: at
most four attempts in a day, then a person is told.

`HUMAN_DECISION_REQUIRED` has many producers in `src/loop/loop-step.ts`, and
every other one is excluded by the conjunction. Enumerated from the build at
`d813456`:

| Producer | Excluded by |
| --- | --- |
| review budget exceeded | `resumeFrom REMEDIATE` |
| findings at the last permitted round | `resumeFrom REMEDIATE` |
| no durable findings to remediate | `resumeFrom REMEDIATE` |
| reviewer brief incomplete | `resumeFrom REVIEW` |
| completion not settled | `resumeFrom REVIEW` |
| verification evidence not durable | `resumeFrom VERIFY` |
| reviewer interrupted | `blockedAgent 'codex'` |
| task brief / context / capability missing | `blockedAgent null` |
| scope indeterminate during implement | `blockedAgent null` |
| **the writing agent failed** | **this is the one** |

The last two share a phase and are told apart by `blockedAgent`, which is a
contract rather than a coincidence: `task-state.ts` invariant 4 requires
`blockedAgent` to be null in every non-blocking state, and both brief-failure
writes spread it from `CONTEXT_LOADING` / `IMPLEMENTING`. Only
`recordAgentInterruption` names an agent, and only because one ran.

**The review round is proved twice, deliberately.** `run-driver.ts:1569`
computes, verbatim:

```
grantReviewRound = continuingHumanDecision
                   && reviewBudgetExhausted(state)
                   && reviewBudget(state) < MAX_REVIEW_BUDGET
```

The invocation makes `continuingHumanDecision` true by construction, so the
prover evaluates the remaining two conjuncts with AO's own exported functions and
**requires the result to be `false`**. Today it cannot be true while the
"budget not exhausted" condition holds — and that is the point: if AO ever
changes which continuations refill a budget, this blocks rather than silently
buying a round nobody authorised. The value is printed as
`WRITER_GRANT_WOULD_GRANT_ROUND`.

This authorisation does **not** cover: `REMEDIATE` review-budget exhaustion, a
product or design decision, review findings waiting to be answered, or
`HUMAN_DECISION_REQUIRED` reached through any **other producer**. Those stay
human-only.

"Any other producer", and deliberately not "any other reason": within this one
producer the four writer failure codes are indistinguishable on disk, as the
table above says.

#### It is bounded, and the bound is durable

This is the only lane that **starts an agent against an unchanged tree**. A
writer that dies again returns the task to the identical shape, so the identical
grant is provable next pass, and the scheduler re-enters every thirty minutes.
Unbounded, it would spend a writer invocation on a dead writer about a hundred
times a day and tell nobody.

Two bounds, and only the second is a real one:

- **per run**: `$WriterDeathMaxPerRun` = 2. Cheap, and it stops one run looping.
  On its own it is not a bound at all — the scheduler hands each run a fresh
  allowance.
- **per day, on disk**: `$WriterRestartMaxPerDay` = 4, with
  `$WriterRestartRetryHours` = 1 spacing, recorded in `zera-retry-budget.json`
  under the key `<task>#writer-restart`.

The suffix is the point rather than a convenience. `zera-quota-grant.mjs` looks
up `tasks[<taskId>]` with the **plain** id, so a restart is invisible to it: one
file, two allowances, and neither can spend the other's. A shared key would let
a dead writer exhaust the budget a provider outage needs.

A refusal for the budget is reported differently from a refusal for the shape,
because they are different sentences and only one needs a person:

| Budget state | What the supervisor does | Who is told |
| --- | --- | --- |
| `SPACING` | parks, `WRITER_RESTART_WINDOW_NOT_OPEN`, sets `nextWake` | nobody — the scheduler takes it |
| `EXHAUSTED` | parks, `WRITER_RESTART_BUDGET_EXHAUSTED` | the operator, once |

The split keys on the prover's **reason being exactly the budget condition**,
never on the budget state alone. A task can carry spent restarts and then move to
a state this lane does not cover at all — a `BLOCKED_AUTH` after two restarts,
say — and parking that silently because the ledger happens to read `SPACING`
would hide a real blocker behind an unrelated timer.

A writer that will not stay alive is a person's problem, not a retry's.

### The ten conditions for the quota grant

All must hold. `zera-quota-grant.mjs` prints one line per condition, and its
default answer is no.

1. `planner-selected-a-task` — AO's own ranking names a live task
2. `task-is-already-started` — a durable record exists naming a branch and worktree
3. `state-is-exactly-blocked-usage-limit`
3b. `the-block-is-not-the-reviewers` — `blockedAgent` is not `codex` (added 2026-10-01; see below)
4. `ao-says-an-operator-grant-may-continue` — `usageLimitContinuation(...).permitted`
5. `a-resume-point-exists` — mirrors AO's own gate term
6. `the-only-attention-owed-is-quota-continuation`
7. `task-file-is-not-done`
8. `no-lease-conflict` — AO reports `Lease: FREE`
9. `retry-budget-permits-an-attempt`

**Condition 6 is doing most of the work, and it is worth knowing why.** AO's
`STATE_ATTENTION` map is total over `ALL_STATES` by `satisfies`, and a task has
exactly one state:

```
BLOCKED_AUTH            -> AGENT_LOGIN_REQUIRED
BLOCKED_VERIFY          -> VERIFICATION_REMEDIATION_REQUIRED
SCOPE_VIOLATION         -> SCOPE_REVIEW_REQUIRED
RESUME_STATE_DIVERGED   -> DIVERGENCE_REVIEW_REQUIRED
HUMAN_DECISION_REQUIRED -> ESCALATED_DECISION_REQUIRED
BLOCKED_USAGE_LIMIT     -> QUOTA_CONTINUATION_REQUIRED
```

Requiring the reason to be exactly `QUOTA_CONTINUATION_REQUIRED` therefore rules
out a simultaneous human decision, a product or design blocker, a scope
violation, a divergence and every auth condition needing judgement — in one
check, against AO's own map rather than a hand-copied list that would go stale
the first time AO adds a state.

Condition 4 is AO's own line too: `RESET_AHEAD` is the machine's wait and is
refused, a reset passed over an intact record belongs to the automatic path and
is refused, and only `RESET_UNRECORDED`, `RESET_UNREADABLE` and
`RESUME_RECORD_WITHDRAWN` permit. This prover never widens that.

**Condition 3b — never the reviewer's block. Do not remove it.** Operator rule,
2026-10-01: a Codex review is a one-shot gate on one verified commit, and it is
relaunched only by a person at the keyboard. Before that date a reviewer's quota
block was resumed on the clock, and timers placed at its resets gave 7 Codex
launches for 3 completed review rounds and used up the 7-day window. AO #110
(merge `0a74697`) made AO refuse the automatic path for a reviewer's block
(`REVIEWER_BLOCK_REQUIRES_OPERATOR`) and made `--continue-usage-limit` its only
way on (`REVIEWER_RESUME_BY_OPERATOR`) — which condition 4 would accept. Without
3b this standing grant would supply that operator flag by itself and become the
timed relaunch again. So 3b refuses every `codex` block, whatever AO permits; a
writer's (`claude`) quota block is unaffected. The file before the change is
kept at `D:\scratch_ao\codex-retry-fix\zera-quota-grant.mjs.before`. The
supervisor's other quota path, `repositories --attended --wait-for-reset`, needs
nothing here: since AO #110 it never schedules a wake for a reviewer's block.

### The retry bound

At most once every 2 hours, and at most 4 attempts per rolling 24 hours, **per
task**. The ledger is `zera-retry-budget.json` (schema 2, keyed by task id), so
the bound survives a reboot, a killed supervisor and a scheduler restart.

The attempt is spent **before** the AO invocation. A supervisor killed
mid-invocation does not get it back — that is how a bound stays a bound instead
of becoming advice.

`zera-quota-grant.mjs` only reads the ledger; the supervisor writes it. A prover
that crashed cannot burn an attempt. An **unreadable** ledger is `UNDECIDABLE`,
never "treat as empty" — that would hand back a full budget.

No reset timestamp is ever invented.

## What the gate proves, and what it only approximates

The gate prints its own tally as `GATE_CONDITIONS = <n> (<n> PROVEN, <n> PROXY)`.
No count is written down here or in the gate's own header, because a number in a
comment goes stale the first time a condition is added and then lies with
authority.

Most conditions are **PROVEN** from data — a commit id, a byte, a check bucket.
Three are labelled **PROXY** in the output because a machine cannot read intent:

- `pr-stays-inside-the-projected-scope` stands in for *"no new product decision
  was invented"*. It proves reach, not intent: a diff confined to the paths the
  repository profile granted cannot have edited a contract, a migration or a
  workflow.
- `roadmap-marks-this-task-done` stands in for *"ROADMAP accurately describes
  what was delivered"*. It proves the status line for this exact task, not the
  truth of the prose.
- `handoff-is-this-tasks-and-complete` stands in for the same about the handoff.
  It proves the handoff names this task and carries the eight binding fields.

A failing PROXY blocks a merge exactly like a failing PROVEN. The label says what
a **pass** means, not how much it is trusted.

Zero checks is never success. It is its own blocking condition, so "CI is broken"
can never be delivered as "CI is fine".

## The one commit the supervisor authors

The repository profile's scope grant excludes `.agent-orchestrator/tasks`, so the
writing agent cannot flip its own task file to DONE — and a task merged while its
file still says OPEN keeps being selected and blocks the wave.

So the supervisor authors exactly one commit, confined to that one task file.
That **is** a head drift from the verified commit, and the gate says so rather
than pretending otherwise: it admits a head above the verified one only when the
difference is precisely one commit touching precisely that file. CI then runs
`npm run verify` on the real head, so the merged commit is verified in its own
right and not by inheritance.

## If you edit the PowerShell files, keep the BOM

Both `.ps1` files start with a UTF-8 BOM (`EF BB BF`) and must keep it.

Windows PowerShell 5.1 reads a `.ps1` **without** a BOM as the system ANSI
codepage. The UTF-8 bytes of an em-dash (`e2 80 94`) then decode as `a-EUR-"`,
whose last character is U+201D RIGHT DOUBLE QUOTATION MARK -- and PowerShell
accepts a curly quote as a closing `"`. A string containing one ends early, the
real closing quote opens a new one, and everything after it is swallowed.

Measured here on 2026-09-12: one em-dash inside a `Set-Error "..."` string broke
the whole script, and the parser blamed a line sixteen lines further down.

Two things did NOT catch it, so do not rely on them:

- `[System.Management.Automation.Language.Parser]::ParseFile` reported PARSE OK
  on an earlier build carrying the same latent bytes;
- every earlier dry run passed, because until then every em-dash was in a
  **comment**, where a stray quote character is harmless.

`Set-Content -Encoding utf8` on 5.1 writes the BOM. Most editors and every
scripted rewrite through Python do not. After any edit, run the dry run -- that
is the only check that actually exercises it.

## Notifications are de-duplicated

The scheduler re-enters every 30 minutes and a blocker needing a person does not
go away when it is reported. Without suppression the same message would arrive 48
times a day, which trains the operator to ignore the channel — the opposite of
the point.

So a notification is sent at most once per distinct condition, keyed by its title
plus body and recorded in `zera-last-notify.txt`. When either changes, something
genuinely changed and it is sent again. A pass that moves durable state clears
the record, so the next distinct condition always gets through. Delete that file
by hand to force a re-send.

An unreadable stamp never silences a notification.

## Known limits, stated rather than hidden

- **The task runs only while this OS user is logged on.** The writing agent AO
  starts is a CLI whose credentials live in this user's profile, and AO resolves
  its home through the OS profile rather than the environment. A detached session
  is the configuration none of that was measured in. After a reboot the loop
  resumes at next logon, not before.
- **A `RESET_UNRECORDED` quota block is now handled without waking anybody.**
  AO raises `QUOTA_CONTINUATION_REQUIRED/RESET_UNRECORDED` and refuses an
  automatic resume, exactly as before. What changed is that the supervisor
  supplies the operator's `--continue-usage-limit` grant itself, under the
  standing authorisation above. It still cannot conjure allowance: if the
  provider is genuinely out, AO returns to `BLOCKED_USAGE_LIMIT`, the attempt is
  recorded, and the scheduler takes the next one after the bound. That is a
  normal outcome, not an error, and nobody is told about it.
- **The standing merge authorisation covers CAPTURE-003 through CAPTURE-006 and
  nothing else.** The list is `$MergeAuthorisedTasks` in the supervisor. Later
  decision tasks, provider/privacy tasks and unrelated work are not in it.
- **The writer-restart lane covers four writer failure codes, not one.** AO does
  not persist the code, so no predicate can narrow it further. See the table
  above. The bound is four restarts per task per day, and then a person is told.
- **A granted adoption that ends in `COMMITTED_BEYOND_APPROVED_SCOPE` leaves a
  commit behind.** AO keeps it deliberately — the evidence is the point — and
  reports the task as not adopted, still `BLOCKED_VERIFY`. The supervisor's
  notification therefore does **not** tell an operator the worktree is unchanged;
  it says to read `git log` on the work branch. An earlier draft said the
  opposite and a review caught it.
- **The retry ledger is read fail-closed per entry as of 2026-09-13.** An entry
  whose `attempts` is not an array used to read as an empty list — a full budget
  off a shape the reader did not understand. Both `zera-quota-grant.mjs` and
  `zera-writer-death-grant.mjs` now refuse it.
