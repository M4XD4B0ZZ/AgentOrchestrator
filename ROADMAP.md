# AgentOrchestrator roadmap

> **Status: PROPOSED, 2026-10-19.** Nothing in this file is approved, scheduled or built. It is a
> proposal to reopen development in named, bounded steps. `README.md` stays the record of what is
> built; where this file and the code disagree, the code wins. Each step reopens work only by its own
> operator decision, as `README.md` ("Status, and where to start") demands for every residual.

## Contents

1. [What this file is](#1-what-this-file-is)
2. [Objective and the one metric](#2-objective-and-the-one-metric)
3. [Dashboard](#3-dashboard)
4. [Critical path](#4-critical-path)
5. [Governance boundaries for every milestone](#5-governance-boundaries-for-every-milestone)
6. [RM0 — Baseline and measurements](#rm0--baseline-and-measurements)
7. [RM1 — Reliable unattended operation](#rm1--reliable-unattended-operation)
8. [RM2 — Better remediation](#rm2--better-remediation)
9. [RM3 — Approved task to verified pull request](#rm3--approved-task-to-verified-pull-request)
10. [RM4 — Controlled learning](#rm4--controlled-learning)
11. [RM5 — Visual regression capability](#rm5--visual-regression-capability)
12. [RM6 — Optimisation and project knowledge](#rm6--optimisation-and-project-knowledge)
13. [What not to build](#13-what-not-to-build)
14. [Operator decisions](#14-operator-decisions)
15. [Sources and how this file was checked](#15-sources-and-how-this-file-was-checked)
16. [Appendix A — Overnight pilot P1](#appendix-a--overnight-pilot-p1-proposed)

## 1. What this file is

- **The canonical roadmap of AgentOrchestrator** (AO), at `ROADMAP.md` in the repository root. No
  earlier roadmap file existed in any branch or commit (checked 2026-10-18 with
  `git log --all -- ROADMAP.md`). The operator chose this path on 2026-10-18 (option A).
- **Authority order.** The code and its tests say what AO does. `README.md` records what was built
  and why. `CLAUDE.md` governs how work is delivered in this repository. This file is the leading
  development plan: it orders future work and records the operator's decisions (section 14).
- **Names.** The operator's brief calls the milestones M0 to M6. `README.md` already uses M1 to M8
  for finished milestones (for example "Autonomous delivery (M1)", M3 persistent scheduler, M4
  unattended completion, M8). To keep the two apart, this file writes **RM0 to RM6** ("roadmap
  milestone") and task IDs **RM<n>-<nn>**. Checked 2026-10-19: no ID of that form exists in
  `README.md` or in `.agent-orchestrator/tasks/`. An RM ID is a roadmap item, not an AO task file;
  it gets a task file only when the operator approves it.
- **Status words.** `BASELINE` = measured fact. `PROPOSED` = written here, not approved.
  `APPROVED` = the operator approved it. `IN PROGRESS`, `DONE`, `DROPPED`. Only the operator moves
  an item from `PROPOSED` to `APPROVED`. A `DONE` item names its pull request.
- **Gap IDs** (`G1.1` to `G7.2`) and candidate IDs (`C1` to `C12`) come from the read-only
  capability-gap audit of 2026-10-17 at HEAD `0a74697`. Every claim was checked again against the
  code on 2026-10-18 (section 15). No claim was refuted; six are only partly true, and this file
  states the corrected form.

## 2. Objective and the one metric

**Objective.** AO implements, verifies, gets independently reviewed, repairs and prepares approved
tasks for delivery, with as little human intervention as is safe. A person still decides what is
approved, what is merged, and every question the code cannot answer.

**Optimise: verified useful work per human intervention (VWHI).**

- _Verified useful work_ = a task that reaches a delivery-ready state (`READY_FOR_PR`, or a
  delivery pull request with green CI) **and** whose change the operator accepts without a code
  change of their own.
- _Human intervention_ = every human act that moves a task forward: `resolve`, a granted review
  round, `--continue-human-decision`, `--verify-operator-repair` (the repair itself),
  `--remediate-verify-failure`, `--continue-usage-limit` by hand, a hand-written task done outside
  AO because AO could not do it, and every hand step of a delivery (flip, push, pull request, CI
  watch).
- **Not counted as cost:** the merge release and the approval of a task. They stay human by design
  (section 5); the metric must never reward removing them.

**Do not optimise:** the number of agents that run at the same time. One writer per repository is a
property (`lease/execution-lease.ts`), not a limit to remove.

**VWHI today (estimate, lower bound on the denominator):** 16 tasks finished alone as
`READY_FOR_PR`, against at least 67 counted interventions (28 `resolve`, 8 granted rounds, 31
adopted operator repairs), and every one of the 48 delivery pull requests was opened and merged by
hand. So VWHI ≈ 0.2. Source: section 6.

## 3. Dashboard

| Milestone                        | Goal in one line                                                              | Status                                   | Depends on                 | First step   | Done when                                                         |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- | -------------------------- | ------------ | ----------------------------------------------------------------- |
| **RM0** Baseline                 | One repeatable, trusted set of numbers                                        | `BASELINE` recorded here; tasks PROPOSED | —                          | RM0-01       | One command reproduces section 6's table                          |
| **RM1** Unattended operation     | A 6–8 h night runs only approved tasks, stops safely, never merges, reports   | D2, D6 decided; RM1-03a approved; D5 open | RM0-01                     | RM1-03a      | Two pilot nights pass Appendix A's success criteria               |
| **RM2** Better remediation       | A fix round knows what to fix; a failure keeps its cause                      | PROPOSED                                 | RM0-01; RM1-03             | RM2-01       | Fewer rounds per finished task; fewer resolves at a spent budget  |
| **RM3** Verified pull request    | An approved task reaches a green pull request with no human step; merge stays human | PROPOSED; needs decision D3        | RM1, RM2-01..02            | RM3-01 (ADR) | A pilot task reaches a green PR unattended, with zero merges      |
| **RM4** Controlled learning      | Recurring failures become reviewed lesson candidates; nothing self-applies    | PROPOSED                                 | RM1-03, RM2-01, RM2-06     | RM4-01       | One candidate reviewed and applied by a person through a PR       |
| **RM5** Visual regression        | A repository declares a reproducible visual check; a person approves baselines | PROPOSED                                | RM2-05 (before blocking)   | RM5-01       | A HealthApp screen pair is produced and compared by a declared phase |
| **RM6** Optimisation, knowledge  | Know what a task costs and the writer level it ran at; find past findings and attempts fast | PROPOSED; RM6-07..09 need D7  | RM1-03                     | RM6-01       | Cost per finished task is reported; a findings search answers     |

**Key numbers today (HealthApp, 2026-09-03 to 2026-10-18; method in RM0):**

| Measure                                   | Value                                                 |
| ----------------------------------------- | ----------------------------------------------------- |
| AO task records                           | 68                                                    |
| Reached `REVIEWING` at least once         | 55                                                    |
| Finished alone as `READY_FOR_PR`          | 16 (24 %); 11 of them clean in round 1                |
| Closed by `resolve`                       | 28; 24 of them at a spent review budget               |
| Codex review rounds with findings         | 73 of 89 (82 %); 202 findings                         |
| Failed verification attempts              | 45, on 31 of 59 verified tasks (53 %)                 |
| Delivery pull requests merged by hand     | 48; 0 by the unattended supervisor                    |
| One verify cycle                          | about 18 min (BUILD median 201 s, VERIFY median 854 s) |
| Writer and review durations, token cost   | not recorded (G6.1)                                   |

## 4. Critical path

The brief's order (M0 to M6) was provisional until a dependency analysis. The analysis below keeps
it, with one item moved forward.

```text
RM0 baseline ──► RM1 unattended ──► RM2 remediation ──► RM3 verified PR
                   │   ▲               │      │
                   │   └── RM1-03 ◄────┘      ├──► RM4 learning (needs durable evidence)
                   │   (writer outcome         └──► RM5 visual (blocking only after RM2-05)
                   │    record, pulled
                   │    forward from RM2)
                   └──► RM6-01 usage capture rides on RM1-03
```

1. **RM0 before everything.** Without a repeatable count, no later milestone can show that it
   helped. RM0-01 is small and read-only.
2. **RM1 before RM2.** The last unattended nights produced no finished task for reasons RM1 fixes
   (a classifier that predates AO #110 and looped silently 1,644 times; a checkout that was not
   updatable all night; codex-quota tasks that only a person can move). Better remediation does not
   help a night that cannot run.
3. **One move: the writer-outcome record (audit C3, gap G2.1) is RM1-03, not RM2.** The
   writer-restart lane of the supervisor restarts four writer failure codes, one of them
   deterministic (`AGENT_ARGUMENT_REFUSED`), because AO does not keep the code. A safe night needs
   that record first, so RM1-03 is a prerequisite of pilot P1 (Appendix A.2). RM2 and RM6 then
   reuse it.
4. **RM2 before RM3.** 24 of 28 `resolve` acts came after a spent review budget, and 82 % of review
   rounds had findings. More automatic pull requests on top of that loop would mean more `resolve`,
   not more useful work.
5. **RM4 after RM2.** Learning needs durable, structured evidence (RM1-03, RM2-01, RM2-06). Without
   it a "lesson" is a guess.
6. **RM5 is mostly a repository-side harness** and can be built in parallel with RM2 and RM3, but it
   stays non-blocking evidence until RM2-05 gives emulator flakes an operator-only re-run door.
7. **RM6** starts with usage capture inside RM1-03; the rest waits for data.

**The critical path is** RM0-01 → RM1-03a → RM1-10 → RM1-01, RM1-02, RM1-03b → RM1-04 → RM1-08 →
D5 → pilot P1 → RM2-01, RM2-02 → RM3-01 (decision) → RM3-02.

### The way to pilot P1 (operator decisions of 2026-10-19)

The operator fixed this order on 2026-10-19 (D2 = A, D6 = A, RM1-03a approved, D5 open). Steps
without a hard dependency on each other may be prepared in parallel. Heavy runs — an AO or HealthApp
verification, a HealthApp CI job on the self-hosted runner — still run one at a time on the shared
machine.

| #   | Step                              | Item                                          | Hard dependency                              | May be prepared in parallel with |
| --- | --------------------------------- | --------------------------------------------- | -------------------------------------------- | -------------------------------- |
| 1   | Baseline                          | RM0-01                                        | —                                            | 2, 3, 6                          |
| 2   | Writer outcomes in AO             | RM1-03a (approved; contract PR #112)          | its contract merged on `main`                | 1, 3, 6                          |
| 3   | Supervisor under version control  | RM1-10 (D6 = A; ADR + phase 1: PR #114)       | its ADR accepted                             | 1, 2, 6                          |
| 4   | Night allow-list                  | RM1-01                                        | RM1-10                                       | 5                                |
| 5   | Stagnation detection              | RM1-02                                        | RM1-10                                       | 4                                |
| 5b  | Restart lane reads the record     | RM1-03b                                       | RM1-03a, RM1-10                              | 4, 5                             |
| 6   | Declared review mode              | RM1-04 (D2 = A: `stop-at-reviewing` for P1)   | —                                            | 1, 2, 3                          |
| 7   | Safety and deployment preflight   | RM1-08                                        | 1 to 6 done; `dist` deployed from `main`     | —                                |
| 8   | Pilot release                     | D5                                            | 7 passes                                     | —                                |
| 9   | Two controlled pilot nights       | RM1-09                                        | D5                                           | —                                |

- **RM1-03 is done in two parts.** RM1-03a is AO's record. RM1-03b is the supervisor's restart lane
  reading it, so it needs the supervisor in this repository first (RM1-10). Appendix A.2 counts
  RM1-03 only when both parts are done.
- **RM1-05 is not a P1 prerequisite.** With D2 = A no Codex review runs at night. The machine-wide
  reviewer lock is needed before the first night in mode `codex`.
- **RM1-06 and RM1-07 stay optional for P1.** A.2 allows a morning report written by hand from the
  records for the first night.

## 5. Governance boundaries for every milestone

These hold for every item in this file. An item that needs one of them changed is not a roadmap item;
it is a separate decision record (ADR in `docs/decisions/`) that the operator takes first.

1. **`READY_FOR_PR` stays terminal** (`src/core/transitions.ts:107`). No outgoing edge.
2. **AO never decides that a merge is warranted** (`README.md:12-21`). A merge needs the operator's
   explicit release, for every pull request.
3. **At most one forge act per invocation** (`src/cli/delivery-driver.ts:96-101`). Pull request
   creation and merge require `--attended` today (`src/cli/index.ts:236-243`).
4. **Merge only through a pull request with real checks** (`CLAUDE.md`, `PR_REQUIRED`,
   `CI_REQUIRED`). Zero checks is never success.
5. **No automatic verification retry, no flake averaging** (`src/verify/run-verification.ts:35-41`).
   `BLOCKED_VERIFY → VERIFYING` stays operator-only (`src/core/transitions.ts:242-245`).
6. **A Codex review is one-shot.** It is never relaunched on the clock (`src/core/automatic-resume.ts:221`,
   commit `3ac9943`).
7. **Review independence.** The writer never reviews its own change. A task is not delivery-ready
   without a review by Codex or by a person.
8. **Scope and pins are fixed at start.** Scope is read from the pinned authority commit
   (`src/scope/`); the brief is read from the pinned worktree. No roadmap item weakens either.
9. **MEMGUARD** (`src/agent/writer-write-guard.ts`): no agent writes auto-memory, `CLAUDE.md` or a
   brief. No automatic instruction change, ever.
10. **No shell for the writer** (`src/loop/orchestrator-briefing.ts:16-19`).
11. **Operator grants stay per invocation and named** (`src/run/invocation-grant.ts`). The
    unattended supervisor keeps at most its three standing lanes (writer quota, writer restart,
    adopting a repair a person made) until an ADR adds one.
12. **The unattended supervisor stays disabled** until the operator approves pilot P1 (Appendix A).

**A contradiction to settle first (decision D1).** `CLAUDE.md:98-100` says opening pull requests,
reading CI results and merging "remain outside v1" of the runtime. Since V4 (merged 2026-08-24) the
code does all three behind attended grants (`src/deliver/`), and `README.md:12-21` says so.
`CLAUDE.md` was last changed in PR #1 (2026-08-09). This file does not change `CLAUDE.md`; RM0-03
asks the operator to decide its wording.

## RM0 — Baseline and measurements

**Goal.** One trusted, repeatable baseline, so that each later milestone can show a measured change.

**Existing baseline (`BASELINE`, counted 2026-10-18 from the HealthApp records).**

- Method: all 68 records in `HealthApp/.agent-orchestrator/runtime/*.json`, the 54 verification
  passes and 31 attempt files, `git log` of HealthApp (AO commits are `AO:<id>:IMPLEMENT|REMEDIATE:r<n>`,
  adopted repairs `OPERATOR-REPAIR:<id>:VERIFY:r<n>`), and 266 supervisor transcripts. Work written by
  hand outside AO (DESIGN-001..022, V1GAP-055..062) is not counted as AO tasks.
- Final states: `OPERATOR_RESOLVED` 28, `READY_FOR_PR` 16, `BLOCKED_USAGE_LIMIT` 11 (6 Codex, 5
  writer), `REVIEWING` 7 (the no-Codex policy of 2026-10-02), `BLOCKED_VERIFY` 2, `SCOPE_VIOLATION`
  2, `VERIFYING` 2 (stranded).
- `HUMAN_DECISION_REQUIRED` events: at least 38 (estimate; the record keeps only its last state).
- Granted review rounds: 8 on 6 tasks. Adopted operator repairs: 31 commits on 24 tasks.
- Supervisor: 7 standing grants used, all ended with AO exit 3; 1,678 AO invocations in 159 runs,
  1,644 of them in 137 runs that changed nothing (2026-09-15 to 09-18).
- Time: IMPLEMENT commit to `READY_FOR_PR` median 0.8 h (n = 16); to `OPERATOR_RESOLVED` median
  12.5 h (n = 27, includes waiting for the operator).

**Proven gaps.**

- No command reproduces these numbers; they were counted by hand (scripts in a scratch folder).
- Writer duration, review duration, tokens and cost are not recorded (G6.1).
- `README.md` "Status, and where to start" is stale: it calls REVIEW-INSTRUMENT-001 unbuilt (merged
  in #101) and lists none of #99 to #110. L-M8-1 (`README.md:14590`) says path and rule are not
  persisted (they are, since #98). `README.md:9045-9047` says an operator sees observed byte counts
  in a report (no renderer reads them; G2.5). `README.md:15094-15096` predates MEMGUARD.
- `CLAUDE.md:98-100` contradicts the delivery code (section 5).
- **AO's own task list is stale** (measured 2026-10-19). `REVIEW-INSTRUMENT-001`, `M1-DOGFOOD-001`
  and `M1-DOGFOOD-002` say `OPEN` in Git although their work is merged; nine `M1-RELEASE-*` files
  exist only in the local checkout (`.git/info/exclude`) and say `OPEN` too. A `run` on this
  repository without `--task` therefore selects an old task. Until RM0-05 is done, every AO run on
  this repository names its task.

**Dependencies.** None.

**Tasks.**

| ID     | Task                                                                                                                                                                       | Status   | Acceptance                                                                                       |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| RM0-01 | A read-only baseline report over a registered repository's records (states, rounds, findings counts, attempts, passes, durations where recorded), as a CLI subcommand or a script under `scripts/` | PROPOSED | Reproduces this section's table exactly on the HealthApp records of 2026-10-18; writes nothing    |
| RM0-02 | Refresh the `README.md` status block and the four stale sentences above                                                                                                    | PROPOSED | Each sentence matches the code; the status block names every merged PR since #97                 |
| RM0-03 | Operator decision on the `CLAUDE.md` sentence about PR, CI and merge "outside v1" (D1)                                                                                     | PROPOSED | A decision is recorded; `CLAUDE.md` changes only on that decision                                |
| RM0-04 | Record the VWHI counting rules (section 2) as the operator's accepted definition                                                                                           | PROPOSED | The operator accepts or changes section 2                                                        |
| RM0-05 | Bring AO's own task list in line: each delivered task `DONE`, local-only task files resolved                                                                               | PROPOSED | A read-only `run --repository <AO root>` ranks no delivered task                                  |

**Regression requirements.** RM0-01 reads only; a test asserts it writes no file and starts no
process. RM0-02 keeps every README sentence that a test pins (for example
`tests/v2-07p-platform-contract.test.ts`, `tests/v4-02-delivery-observation.test.ts`).

**Measurable success.** The baseline table is produced by one command, and a second run on the same
records gives the same output.

**Governance.** Read-only. No task state is touched.

**Completion.** RM0-01, -02 and -04 are `DONE`; RM0-03 has a recorded decision.

## RM1 — Reliable unattended operation

**Goal.** A 6–8 hour night works only on tasks the operator approved for that night, one after
another, stops safely at the first condition it may not handle, never opens or merges a pull request
on its own, and leaves a morning report a person can act on in minutes.

**Existing baseline (`BASELINE`).**

- AO, unattended inside an attended-grant invocation: task selection (`src/plan/select-task.ts`:
  eligible = task file `OPEN` and every `dependsOn` file `DONE`; ranked by kind, focus, priority,
  unlock count, id), the writer, verification, the Codex review, remediation within the review
  budget, waiting for a recorded writer reset (`repositories --attended --wait-for-reset`, holding
  no lease), and recovery of a lease it can prove dead.
- The external Zera supervisor (`C:\Users\Max\AO-runs\zera-supervisor.ps1`, Windows Task Scheduler,
  every 30 min, killed after 8 h): three narrow standing lanes (writer quota, writer restart,
  adopting a repair a person left uncommitted), notifications through ntfy, and a delivery path
  (DONE flip, push, pull request, CI wait, a read-only gate, merge) that **never ran**: 0 deliveries
  and 0 merges in 266 transcripts.
- The scheduled task has been **disabled** since 2026-09-18.

**What the last nights produced.**

| Night               | Result                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-09-11/12       | All productive work done by 04:10, then 28 idle cycles on one decision and one quota block                  |
| 2026-09-12/13, 13/14 | Every pass stopped before work: one task waited for a human decision                                       |
| 2026-09-14/15       | Three quota grants, then a silent loop from 03:31 that lasted until 09-18 (1,644 invocations, no message)   |
| 2026-09-17/18       | No AO call all night: the checkout was on another branch, then dirty                                         |
| 2026-09-18 day      | 0 `READY_FOR_PR`; 7 failed verifications, 6 green tasks stuck on Codex quota, 5 on writer quota             |

**Proven gaps.**

1. **The supervisor's classifier predates AO #110.** It still treats a Codex block with a reset
   ahead as machine-progressable with a future wake (`ao-classify.mjs:242-268`). AO no longer wakes
   for it. Result: the silent no-progress loop can come back.
2. **The writer failure code is not kept** (G2.1, partly true: `AGENT_FORBIDDEN_WRITE` leaves an
   evidence record). Eight codes collapse into one state; the restart lane restarts a deterministic
   failure up to 4 times a day.
3. **No "approved for tonight" boundary.** Eligibility is `OPEN` plus dependencies `DONE`. Any open
   task with merged dependencies can start.
4. **The review policy and the code disagree.** Since 2026-10-02 attended runs stop before Codex by
   policy, done by stepping `--max-steps` by hand. Under the code, any attended run continues a
   `REVIEWING` task into a Codex review. It was DESIGN-023 until its delivery on 2026-10-19
   (HealthApp #356; the task file says `DONE`, so the planner no longer selects it).
5. **The reviewer lock is per process** (`src/loop/reviewer-provider-gate.ts:45-48`). Two AO
   processes on one machine can both launch Codex (the audit's "per machine" claim is only partly
   true).
6. **Nothing summarises a night.** One overwritten status file, 266 transcripts without an index,
   ntfy for stops only (success is silent), a dashboard with no heartbeat, 13 stale attention items.
7. **An empty queue is a silent stop every 30 minutes.**
8. **The supervisor's merge list names only CAPTURE-003..006**, and its scheduled-task comment says
   it passes no grant flag (it passes three kinds). Both are stale.
9. **The supervisor is not under version control** (measured 2026-10-19). `C:\Users\Max\AO-runs` is
   no Git repository, so a change there gets no pull request and no CI, and its labs run only by
   hand. Decision D6 = A moves its source into this repository (RM1-10).

**Dependencies.** RM0-01 (to measure the pilot). RM1-10 for every item whose "Where" is the
supervisor.

**Tasks.**

| ID     | Task                                                                                                                                                                                                       | Where           | Status   | Acceptance                                                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| RM1-01 | **Night allow-list.** The operator writes the IDs approved for one night into a file outside every repository; the supervisor admits nothing else                                                           | supervisor      | PROPOSED | A wiring test: an eligible task that is not on the list is never started; an empty list starts nothing and says so once     |
| RM1-02 | **Classifier after AO #110.** A Codex block is an operator item, never a future wake; two passes with no state change stop the run and notify once                                                           | supervisor      | PROPOSED | Replayed records of 2026-09-15 give `OPERATOR_ONLY` and one notification, not 12 silent passes                               |
| RM1-03a | **Writer-outcome record** (C3), AO part. Bounded, per-task evidence record `runtime/writer-outcomes/<task>.json`: original failure code, its static cause, closed process facts. Evidence only, never authority. Contract: `.agent-orchestrator/tasks/RM1-03A.md` (PR #112) | AO | APPROVED 2026-10-19 | Tests per failure class; task state byte-equal; an import pin and plan equality show it decides nothing |
| RM1-03b | **Restart lane reads the record.** The supervisor's writer-restart lane refuses a recorded deterministic code (`AGENT_ARGUMENT_REFUSED`) | supervisor | PROPOSED | A supervisor-lab case: a recorded `AGENT_ARGUMENT_REFUSED` is never restarted |
| RM1-04 | **Declared review mode** per repository in the operator registry: `codex` or `stop-at-reviewing` (today's hand practice, made declarative). D2 = A (2026-10-19): `stop-at-reviewing` for pilot P1 | AO + operator | PROPOSED; D2 decided | With `stop-at-reviewing` a run ends at `REVIEWING` with an attention item and zero reviewer launches (asserted by a test) |
| RM1-05 | **Machine-wide reviewer lock**: a file lock under the user profile, so two AO processes cannot both launch Codex                                                                                             | AO              | PROPOSED | A dist-artefact test with two processes: one launch, one refusal                                                              |
| RM1-06 | **Morning report.** A read-only roll-up over a time window, built on the dashboard read model: tasks started, states reached, rounds and finding counts, attempts (phase, exit), blockers with the exact next command, quota state, time spent; successes included | AO (read-only)  | PROPOSED | Built from fixtures; every line traceable to a record; one short ntfy line at the end of a night                              |
| RM1-07 | **Heartbeat and stale items.** The supervisor writes a heartbeat; the dashboard shows the last pass; attention items of unregistered repositories show as stale                                              | supervisor + AO | PROPOSED | The dashboard tells "running", "stopped at <time>" and "never ran" apart                                                      |
| RM1-08 | **Supervisor hygiene and safety/deployment preflight.** Merge list emptied (no merge lane in RM1); scheduled-task comment corrected; `dist` deployed from `main`; the A.2 checklist as one read-only check | supervisor + AO | PROPOSED | The preflight passes on the evening before a pilot night and names every failed item |
| RM1-09 | **Pilot P1** (Appendix A): an evening rehearsal, then two nights                                                                                                                                            | operation       | PROPOSED | Appendix A's success criteria                                                                                                 |
| RM1-11 | **Scope per task.** A task may narrow the profile's scope, never widen it, and the scope gate enforces the task's own list. Today AO enforces only the repository profile, so one task's need widens it for every task that starts later (RM1-10S, section 14). The list is read from the task file at the task's base commit, never from the worktree; the frontmatter key ships in `dist` before any task file uses it (`.strict()` schema). Not a P1 prerequisite; before more parallel work | AO | PROPOSED | Tests: a change outside the task's own list is a scope violation; a task cannot add a path the profile does not allow; a task without the key keeps today's scope |
| RM1-10 | **Supervisor under version control** (D6 = A, 2026-10-19). Its source moves from `C:\Users\Max\AO-runs` into this repository: an ADR first, no secret committed, its labs in CI, a deployment to the Windows machine from a canonical commit, a way back, the Task Scheduler entry unchanged until the pilot. ADR and phase 1 (byte-equal copy, CI guards): PR #114 | AO repository | APPROVED (D6 = A); ADR first | The labs pass in CI; the deployed copy is byte-equal to a named commit; nothing secret is in Git |

**Regression requirements.** All AO tests stay green, including `m4-01-unattended-completion`,
`m3-01-persistent-scheduler` and the dist-artefact suites. The supervisor's own lab
(`zera-grant-lab.mjs`, `zera-wiring-test.ps1`) passes, with new cases for RM1-01 and RM1-02, and
for RM1-03 a case where the writer-restart lane refuses a recorded `AGENT_ARGUMENT_REFUSED`.

**Measurable success.** Per night: approved tasks started; tasks that reached `REVIEWING` or
`READY_FOR_PR`; human acts needed the next morning; passes with no progress (target: at most 2 before
a stop and one message); morning-report lines that disagree with the records (target: 0).

**Governance boundaries.** No pull request and no merge in RM1. No new standing lane. A Codex
relaunch stays human. The supervisor is enabled only for the approved pilot window and disabled
after it.

**Completion.** RM1-01, -02, -03a, -03b, -04, -06, -07, -08 and -10 `DONE` (RM1-05 before the first
night in mode `codex`), and two pilot nights meet Appendix A's success criteria.

**RM1-10 phase 2 (task RM1-10B) delivery record (2026-10-20).** RM1-10 stays `APPROVED`: phases 3
to 5 remain.

- **Implementation.** `fed1880` (`AO:RM1-10B:IMPLEMENT:r1`), written by AO's writer in an attended
  run on 2026-10-19 under the temporary RM1-10S scope (PR #116). Five files:
  `ops/zera-supervisor/{zera-supervisor.ps1, zera-wiring-test.ps1, zera-grant-lab.mjs, README.md}`
  and `tests/ops-zera-supervisor.test.ts`. AO's verify passed on `fed1880` (BUILD exit 0, VERIFY
  exit 0); the task stopped at `REVIEWING`. No Codex review ran.
- **Checks (overnight 2026-10-20).** An independent read-only review (a Claude agent) and break-tests
  in an isolated copy: 25 planted faults, 16 caught. A notification-privacy probe against a local
  endpoint (200, 500, 404) with verbose, debug and transcript on: no channel name and no endpoint in
  any output, live or dry run. The grant lab with explicit folders: 49 of 49 cases pass. Defaults
  unchanged: the scheduled task needs no change.
- **Operator repair before delivery (2026-10-20; operator decision "option B", no new AO task).**
  Written by hand, not by AO's writer, in three commits on top of `fed1880`:
  - `178d84d`: an empty or blank `-StateDir` is refused (it fell back to the production folder); a
    folder must be fully qualified (`D:state` and `\state` passed); a `ZERA_STATE_DIR` that is set
    but blank is refused; the README's grant-lab line names its four folders; tests for the
    surviving faults (the `Resolve-ZeraPaths` call and every path binding, read from the syntax
    tree; `Notify` with verbose on; the grant lab's argument checks).
  - `1e4c0d8`, after an independent review (a Claude agent) of `178d84d`: the colon form and a
    splat (`-StateDir:D:\x`, `-DryRun:$true`), which reach `$args` as `-StateDir:` and a value, are
    refused — before, the state silently went to the production folder and a dry run would run
    live (measured; the defect dates from `fed1880`); the drive check is case-exact (`-match` read a
    Kelvin sign as `K`); tighter tests.
  - `f0648ee`: `Notify` posts through `System.Net.WebRequest`. Measured: a transcript records a
    cmdlet's caught terminating error, and `Invoke-RestMethod`'s named the whole URL with the topic
    (a malformed endpoint) or the host (a name that does not resolve). The .NET call is not recorded.
  - Checks: red first (the final tests fail 6, 4 and 1 times on the supervisor of `fed1880`,
    `178d84d` and `1e4c0d8`), 19 of 19 on `f0648ee`; break-tests 38 of 38 caught (the 25 of the
    night plus 13 for the repair). The grant lab, the provers and `src/` are unchanged since
    `fed1880`. The full `npm run verify` and CI on the pull request's final head are the gates;
    their results are in the pull request, not in this file.
- **Open.** A fully qualified folder on a drive that does not exist (`-StateDir Q:\x`, Q unmounted)
  still passes the check; `Join-Path` then yields nothing and the run goes on without lock, status
  or transcript (reasoned by the review; predates `fed1880`'s repair; outside the authorised
  change list). The lock and the retry ledger are per state folder, so a run with another
  `-StateDir` is a second supervisor the production lock does not see. A misspelled parameter name
  is ignored.
- **No approval of this delivery is claimed.** A person's review is owed before merge.

## RM2 — Better remediation

**Goal.** A fix round knows what to fix, a repeated finding is seen as repeated, and every failure
keeps its cause, so fewer rounds are wasted and fewer tasks end in `resolve`.

**Existing baseline (`BASELINE`).** The loop is bounded (`src/core/review-budget.ts:77-94`, ceiling
12). `findingHistory` keeps every round with severity, path and rule, repeats included
(`src/loop/findings.ts:63-96`). Verification has three verdicts and keeps its failure code; the
attempt record is written before the block; at most 6 attempts are kept. Two operator doors leave
`BLOCKED_VERIFY`. Agents are briefed with measured facts (`src/loop/orchestrator-briefing.ts`).

**Proven gaps** (all CONFIRMED on 2026-10-18 unless marked).

- **G1.1** No stagnation detection: nothing compares one round with another; the fingerprint is
  `sha256(severity, path, rule)`, so a severity change breaks a match.
- **G1.2** Neither agent sees earlier rounds.
- **G1.3** A fix round guesses from a rule name: the reply schema allows only severity, path and
  rule (`src/loop/findings.ts:277-285`), and the parser silently drops any extra key.
- **G1.4** (partly) Decisions read only the newest attempt; the 6-attempt cap ends in
  `HUMAN_DECISION_REQUIRED` without the reason. `run --task` does list every attempt.
- **G2.2** The stored excerpt is the first 4,000 characters (`DIAGNOSTIC_EXCERPT_LIMIT`); a test
  runner prints its verdict at the end.
- **G2.3** No infrastructure lane: a corrupt download records as a failed verification.
- **G2.5** Observed byte counts are computed and then written as 0.
- **G5.3** 18 or more causes share one attention reason, `ESCALATED_DECISION_REQUIRED`.
- **G7.1** No operator view shows findings.
- Measured cost: 82 % of review rounds had findings; 24 of 28 `resolve` acts followed a spent budget;
  45 failed verification attempts.

**Dependencies.** RM0-01; RM1-03 (the writer-outcome record).

**Tasks.**

| ID     | Task                                                                                                                                                                  | Audit | Status   | Acceptance                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------ |
| RM2-01 | Mark a repeated (path, rule) in the remediation payload; give the reviewer the previous round's list and ask it to repeat a finding only if it is still present      | C1    | PROPOSED | Pure functions in `src/loop/findings.ts`; tests in `tests/verify-remediation-loop.test.ts`; no schema change         |
| RM2-02 | Review document v2 with a bounded, line-safe `detail` per finding, fenced as untrusted for the writer; the parser refuses unknown keys instead of dropping them     | C2    | PROPOSED | README, prompt and parser stay equal; payload stays inside 16 KiB; injection tests                                   |
| RM2-03 | Measure the repeat rate of (path, rule) on stored HealthApp states, then park early with a precise reason when a round repeats every earlier finding                 | C5    | PROPOSED | The measurement is recorded first; a false-positive test on a reused rule slug                                       |
| RM2-04 | Head and tail excerpt in the verification attempt record (schema v2). Reopens residual L-M1-VR-1; fresh reason: 45 failed attempts whose verdict lines are at the tail | C4    | PROPOSED | Byte arithmetic tests at the record limit; the tail reaches `--remediate-verify-failure` and `run --task`             |
| RM2-05 | An operator-only door to re-verify an unchanged HEAD from `BLOCKED_VERIFY`, recorded as a new attempt                                                                 | C6    | PROPOSED | Refused without the operator flag; never reachable from an automatic path; recorded as its own attempt              |
| RM2-06 | Show `findingHistory` in `run --task` and in the dashboard                                                                                                           | C7    | PROPOSED | Paths pass the existing allow-list; changes the `render-run-plan.ts:20` rule on purpose                              |
| RM2-07 | Separate attention reasons for the main `HUMAN_DECISION_REQUIRED` causes (spent budget, writer failure, dirty tree after a clean review, incomplete brief)            | G5.3  | PROPOSED | Each reason has its own sentence and next command                                                                    |
| RM2-08 | Keep the observed byte counts in the attempt record, or remove the README claim                                                                                      | G2.5  | PROPOSED | Either the record carries the value or `README.md:9045-9047` is corrected                                            |

**Regression requirements.** `tests/verify-remediation-loop.test.ts`, `tests/operator-repair.test.ts`
and `tests/m1-verify-recovery-evidence.test.ts` stay green. A test asserts that no path retries a
verification automatically. Every new text an agent sees passes the existing redaction and
line-safe rules (`src/auth/redaction.ts`, `src/core/line-safe-text.ts`).

**Measurable success.** Rounds per finished task; the share of `resolve` acts at a spent budget
(today 24 of 28); failed verifications that end without a named cause.

**Governance boundaries.** No automatic retry. A park is always safe (it reduces autonomy). Agent
text is evidence, never authority; it is not persisted in `TaskState` without a decision.

**Completion.** RM2-01, -02, -04, -06 `DONE`, and the measured share of `resolve` at a spent budget is
lower over the next 10 tasks than the baseline.

## RM3 — Approved task to verified pull request

**Goal.** An approved task reaches an open pull request with green CI and its review record, with no
human step on the way. The merge stays a human release.

**Existing baseline (`BASELINE`).** AO performs real forge acts through `agent-loop delivery`
(`src/deliver/`): `--publish-head` (attended, or unattended with `--automatic-publish-head-only`,
`--drive` and a `delivery-automation.yaml`), `--create-pr` and `--merge-pr` (attended only; the merge
needs a fresh `PULL_REQUEST_MATCHED_CHECKS_SUCCESS` from the same invocation). Check states SUCCESS,
PENDING, FAILED and NO_CHECKS are classified, NO_CHECKS never as success
(`src/deliver/forge-observation.ts:1034-1084`). AO uses this on repositories that declare `delivery:`
(AO itself does). HealthApp declares none; its delivery path is the supervisor's
(`gh pr create`, `gh pr merge --match-head-commit`, gated by `zera-delivery-gate.mjs`), and it never
ran. All 48 HealthApp delivery pull requests were made by hand.

**Proven gaps.**

- Unattended pull request creation is not in the build (`README.md:14896-14931`). Deciding whether it
  may be is decision D3.
- The three acts do not compose on a first delivery (L-V4-06-10, L-V4-07-1): three invocations.
- CI causes are merged into one failed count, and check names are not read (G2.4).
- An operator-resolved task can never be delivered (G5.4, by design): 28 of 51 finished HealthApp
  tasks ended that way.
- Two delivery paths exist for different repositories (AO's own and the supervisor's).
- A dependent task cannot start before its dependency's DONE flip is merged (eligibility reads the
  task file on the canonical checkout).

**Dependencies.** RM1 done; RM2-01 and RM2-02 (otherwise more pull requests means more `resolve`).

**Tasks.**

| ID     | Task                                                                                                                                                           | Status   | Acceptance                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| RM3-01 | **ADR**: may AO open a pull request unattended for an approved task that is `READY_FOR_PR`? Options, risks, and what stays human                                 | PROPOSED | The operator decides (D3). No code before the ADR is accepted                                  |
| RM3-02 | **One delivery path for HealthApp**: either HealthApp declares `delivery:` and uses AO's chain, or the supervisor path stays; not both                          | PROPOSED | One path is named in README and the supervisor README; the other is retired or documented as unused |
| RM3-03 | CI evidence per conclusion, with check names (C8)                                                                                                              | PROPOSED | The delivery evidence record version is raised; FAILED keeps its cause (failure, cancelled, timed out, startup failure) |
| RM3-04 | **Operator acceptance as a deliverable ending** (an alternative to `resolve` for a task the operator reviewed and accepts as it is). Decision D4             | PROPOSED | Only a person can record it; the delivery gate accepts it; `READY_FOR_PR` stays terminal        |
| RM3-05 | **Merge release record**: the supervisor merges only a pull request for which the operator recorded a release (replaces the hard-coded list)                    | PROPOSED | No release record, no merge; a test proves it                                                  |

**Regression requirements.** `tests/v4-02-delivery-observation.test.ts` (NO_CHECKS is never
SUCCESS), `tests/v4-04-*`, the dist-artefact suites, and the supervisor's delivery-gate lab.

**Measurable success.** Delivery steps done by hand per finished task (today: every one); minutes
from `READY_FOR_PR` to a green pull request.

**Governance boundaries.** `READY_FOR_PR` stays terminal; one forge act per invocation; the merge
needs the operator's release every time; CI is required.

**Completion.** RM3-01 decided; RM3-02, -03 and -05 `DONE`; one approved pilot task reaches a green
pull request unattended, and nothing is merged without a release.

## RM4 — Controlled learning

**Goal.** Recurring failures become evidence-backed lesson candidates that a person reviews. Nothing
changes an instruction, a brief or memory by itself.

**Existing baseline (`BASELINE`).** AO has no learning or recurrence analysis (grep for learn,
lesson, recurr and skill finds comments only). MEMGUARD-001 stops writers from writing lessons into
auto-memory (`src/agent/writer-write-guard.ts`). Today's lessons are written by hand by the operator's
Claude sessions, outside AO.

**Proven gaps.** No recurring-failure analysis (audit area 3). No task reuses another task's findings,
attempts or outcomes (G7.2).

**Dependencies.** RM1-03, RM2-01, RM2-06 (durable, structured evidence).

**Tasks.**

| ID     | Task                                                                                                                                                      | Status   | Acceptance                                                                                   |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| RM4-01 | A read-only recurring-failure report: groups by phase and exit, writer code, rule slug and path, across tasks and repositories (C9)                      | PROPOSED | Built from fixtures and from the stored HealthApp records; writes nothing                     |
| RM4-02 | A lesson-candidate format: the evidence (record links), a proposed text, the file it would go to, and the counter-evidence                                 | PROPOSED | A candidate without evidence links is refused                                                 |
| RM4-03 | The human path: a person turns an accepted candidate into a normal pull request to a brief template, a skill or a guide                                   | PROPOSED | No AO code writes the target file; the change arrives only by a person's pull request         |
| RM4-04 | MEMGUARD regression for candidates: AO never writes them to auto-memory, `CLAUDE.md`, a task brief or a prompt                                           | PROPOSED | A test plants a candidate and asserts no such write                                           |

**Regression requirements.** `tests/memguard-001-writer-write-guard.test.ts` stays green.

**Measurable success.** Candidates produced per 10 tasks; candidates a person accepted; repeat rate of
the same failure class after a lesson was applied.

**Governance boundaries.** No automatic instruction change. No LLM classifier that moves a task state.

**Completion.** RM4-01..04 `DONE`; one candidate was reviewed and applied by a person through a pull
request.

## RM5 — Visual regression capability

**Goal.** A repository can declare a reproducible visual check (viewports, data, screens); AO keeps its
evidence; a person approves every baseline.

**Existing baseline (`BASELINE`).** AO has no visual phase. A repository can declare BUILD, TEST and
VERIFY argv phases only; the exit code is the verdict
(`src/repo/internal/repo-profile-object-schema.ts:157-176`). Agent and gate environments carry only
`PATH` and `PATHEXT` (`src/auth/env-guard.ts`), so no Android SDK or Java home. Outside AO, the
HealthApp review practice is proven over DESIGN-010 to DESIGN-025: a release build of an exact commit,
the Pixel_7 emulator, adb-driven walks at 411 dp / font 1.0, 411 dp / 1.3 and 360 dp / 1.3, and
before/after picture pairs.

**Proven gaps.** No artefact capture. Untracked output makes the tree dirty, and a clean review over a
dirty tree parks the task. The 30-minute cap. No infrastructure lane for an emulator flake (G2.3).

**Dependencies.** RM2-05 before any visual check may block a task.

**Tasks.**

| ID     | Task                                                                                                                                                         | Where     | Status   | Acceptance                                                                                  |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------- | ------------------------------------------------------------------------------------------- |
| RM5-01 | A repository-side harness in HealthApp: scripts, fixed data, the three viewports, git-ignored output                                                         | HealthApp | PROPOSED | Two runs on one commit give the same pictures within a stated pixel tolerance               |
| RM5-02 | An optional, non-blocking evidence phase in the repository profile, whose environment allow-list is set in the operator registry (never by the repository) | AO        | PROPOSED | Output is git-ignored and listed in the run report; a failure never changes the task state  |
| RM5-03 | Baseline approval: a person approves reference pictures through a pull request; a comparison reports differences and never replaces a baseline             | HealthApp | PROPOSED | No code path writes a baseline                                                              |
| RM5-04 | Only after RM2-05: the visual phase may be declared blocking                                                                                                 | AO        | PROPOSED | An emulator flake reaches the operator-only re-run door, never an automatic retry           |

**Regression requirements.** The environment guard tests stay green; a test proves a repository
cannot widen its own environment.

**Measurable success.** Visual defects found before a person's walk; time of a person's walk per
design task.

**Governance boundaries.** No AO-owned emulator harness; no automatic baseline replacement.

**Completion.** RM5-01..03 `DONE`; one HealthApp screen pair is produced and compared by the declared
phase.

## RM6 — Optimisation and project knowledge

**Goal.** Know what each task costs, give each repository a measured budget and a writer level the
operator chose, and find past findings, attempts and outcomes quickly.

**Existing baseline (`BASELINE`).** AO counts no tokens, cost or turns (G6.1). Every repository gets
the same 30-minute writer cap and no `--max-turns` or `--model` (G6.2). A quota-cut Codex review loses
its partial work (G6.3; 4 of 7 launches were cut off on 2026-09-30/10-01). The dashboard read model
loads states, attempts, passes, attention and delivery records across repositories (read-only).
Measured 2026-10-19: the installed CLI (2.1.303) lists `--model`, `--effort` and `--max-budget-usd`
in `claude --help`, and no `--max-turns`. The writer passes none of them, and AO does not record
which model or effort a writer ran at (details in "Writer model and effort per task" below).

**Dependencies.** RM1-03. RM6-07 to RM6-09 also need decision D7.

**Tasks.**

| ID     | Task                                                                                                           | Status   | Acceptance                                                                    |
| ------ | -------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| RM6-01 | Usage capture (tokens, turns, cost where the agent reports them) into the writer-outcome record (RM1-03)      | PROPOSED | Present on success and failure; missing values are recorded as missing        |
| RM6-02 | Writer budget per repository in the operator registry, not in the repository profile (C10)                    | PROPOSED | A repository cannot choose its own budget; measured with RM6-01 data first    |
| RM6-03 | A read-only, structured search over findings, attempts and outcomes across tasks                              | PROPOSED | Answers "where did rule X fail before" from the records                       |
| RM6-04 | A cost and duration benchmark per task kind                                                                    | PROPOSED | Reported in the morning report (RM1-06)                                       |
| RM6-05 | Semantic search only if RM6-03 is measured as not enough                                                       | PROPOSED | A written measurement shows the gap first                                     |
| RM6-06 | **Writer level evidence.** For every writer run, success and failure, record the requested, effective and reported model and effort beside the task, closed values only. One per-run record shared with RM6-01, a sibling of RM1-03a's failure record, not inside it | PROPOSED | Present on success and failure; a value the CLI did not report is recorded as `NOT_REPORTED`; an import pin and plan equality show it decides nothing |
| RM6-07 | **Writer level policy** in an operator file outside every repository, per repository and per phase (IMPLEMENT, REMEDIATE): allowed model keys, an effort ceiling, a default. No policy means today's vector. Shares its file with RM6-02. Needs D7 | PROPOSED | `.strict()` schema, an unknown key refuses the file; a test proves no repository file (profile, task file, `.claude/`, `CLAUDE.md`) can set or raise it |
| RM6-08 | **Task-file request.** An optional, closed `writer` key in the task frontmatter that may only request one model key and one effort per phase; the effective value is the request clamped by RM6-07 | PROPOSED | A request above the ceiling runs at the ceiling and is recorded as clamped; without a policy a request changes nothing; deployed in `dist` before any task file uses the key |
| RM6-09 | **Level into the writer argv.** `--model` and `--effort` from closed tables in AO's source, before `--tools`; resolved once at task start for both phases and kept with the task for every later launch and resume. Never ultracode | PROPOSED | Pinned argv per level; every token shell-inert; `ultracode`, `--fallback-model` and `[1m]` aliases refused by test; a real-CLI measurement shows repository text cannot change the reported level |

**Regression requirements.** The writer argv tests and the result-stream tests stay green; a
missing usage value never changes a task state; the dashboard stays GET-only
(`src/dashboard/http-contract.ts`). With no level policy the writer vector stays
`CLAUDE_WRITER_ARGS` token for token (`tests/dogfood-rem-001.test.ts:91-109`).

**Measurable success.** Cost per finished task; share of writer runs that hit the cap.

**Governance boundaries.** Read-only knowledge; budgets and writer levels set by the operator.

**Completion.** RM6-01..04 `DONE`. RM6-06..09 `DONE` once D7 allows them, or `DROPPED` by D7.

### Writer model and effort per task (RM6-06 to RM6-09)

**Aim.** AO can give a task the writer effort it needs, and no repository content can raise the
model, the effort, the permissions or the cost on its own.

**What was checked (2026-10-19, code at `ec74e98`).**

- **CLI.** `claude --version` prints `2.1.303 (Claude Code)`. `claude --help` lists
  `--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)` and
  `--model <model>  Model for the current session. Provide an alias for the latest model (e.g.
  'fable', 'opus', or 'sonnet') or a model's full name.` It also lists `--fallback-model`,
  `--max-budget-usd` ("only works with --print") and `--disable-slash-commands` ("Disable all
  skills"). It lists no `--max-turns` and does not name ultracode.
- **Levels** (docs, `code.claude.com/docs/en/model-config`). The five levels are real, but per
  model: Opus 4.6 and Sonnet 4.6 have no `xhigh`. The default is `high`, except Opus 5.5, Sonnet
  5.5 and Haiku 5.5 (`medium`) and Opus 4.7 (`xhigh`). Order of resolution: an explicit choice
  (`CLAUDE_CODE_EFFORT_LEVEL`, `--effort`, `/effort`), then settings, then the model default.
  `max` lasts for one session unless set through `CLAUDE_CODE_EFFORT_LEVEL`.
- **Ultracode** (docs, `model-config` and `workflows`). Not an effort level: a setting with which
  Claude runs dynamic workflows (many subagents) for substantive tasks. It is turned on by
  `/effort ultracode`, `--effort ultracode` (starts at `xhigh`; accepted per the docs although the
  help names only five levels), the `ultracode` settings key or `--settings`, or the word
  `ultracode` in a prompt a person typed — not in a prompt passed with `-p`. The docs say each
  request then "uses more tokens and takes longer" and reaches a session or weekly limit sooner. In
  `-p` a workflow launch is the `Workflow` tool call under the normal permission rules, and a
  workflow does not pause at a usage limit; its agents fail.
- **The writer today.** Its vector is `CLAUDE_WRITER_ARGS` (`src/agent/claude-writer.ts:213-247`),
  plus `--mcp-config`/`--allowedTools` for a granted capability (`:318-328`) and the guard's
  `--settings` before `--tools` (`:304-316`). No `--model`, no `--effort`. Its environment carries
  no `CLAUDE_CODE_EFFORT_LEVEL` or `ANTHROPIC_MODEL` (`src/auth/env-guard.ts:354`, `:452`), and
  `--setting-sources ''` keeps user, project and local settings out. So, by the docs, the writer runs
  on the account's default model at that model's default effort, unless the machine's managed
  settings say otherwise. **Not measured:** AO reads the `system/init` message only for MCP tools
  and servers (`src/agent/mcp-capability-preflight.ts:262-294`) and never its model
  (`src/agent/internal/claude-result-stream.ts:199-207`).
- **Workflows are out of the writer's reach today.** Its tools are `Read Edit Write Glob Grep`, with
  no `Workflow` and no `Agent` tool; `init.tools` was measured as exactly those five on 2.1.239
  (`claude-result-stream.ts:57-61`), not again on 2.1.303.

**Where the level comes from.**

| Source                                             | May say                                                                     | May never say                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Operator file outside every repository (RM6-07)    | Per repository and phase: allowed model keys, effort ceiling, default       | —                                                                   |
| Task-file frontmatter (RM6-08)                     | A request: one model key and one effort per phase, from closed sets         | A model string, a level above the ceiling, ultracode, tools, MCP, permissions, budget |
| Repository profile, task body, `CLAUDE.md`, `.claude/`, handoff | Nothing                                                        | Any of it                                                           |

- **Effective level.** Effort = the request (or the default) lowered to the ceiling. Model = the
  requested key if the policy allows it, else the default. No policy for the repository = no flag,
  whatever the task asks (today's vector).
- **Resolved once, at task start, for both phases**, from the task file as selection read it and the
  operator file as it was then. It is kept with the task: a `TaskState` field, with the schema
  version raised — the one state-contract change here. It is never re-read from the worktree,
  because the writer edits that tree (the run brief is read there, `src/plan/task-brief.ts:19-22`).
- **IMPLEMENT and REMEDIATE have separate values.** A fix round is narrower and may need less; the
  numbers come from RM6-01 data, not from a guess.

**Into the argv, safely.** A closed table in AO's source maps each model key to one argv token and
lists the levels each key accepts; an operator file names keys, never strings. `--model <token>
--effort <level>` go in before `--tools`, which is variadic and stays last (`claude-writer.ts:225-238`),
and the whole vector is still checked by `isShellInertArgument` (`claude-writer.ts:489-500`,
`:522-525`; pattern at `src/doctor/exec.ts:138`). Never: `--effort ultracode`, `--fallback-model`
(it changes the model without a record), an alias with `[1m]` (not shell-inert), a model, effort or
ultracode key in the guard's settings file (its bytes stay fixed, `src/agent/writer-write-guard.ts:83-96`),
or an environment variable for any of them. Every payload starts with AO's own line
(`src/loop/implement-payload.ts:40`, `src/loop/findings.ts:372` and `:562`), so task prose never
opens the prompt. The docs say a `-p` prompt accepts `/effort`, `/model`, `/config key=value` and
`/skill-name`, and a skill's frontmatter may set `effort`. **Not verified:** whether any of these
acts from later in the prompt. RM6-09 measures it on the real CLI (opt-in, like
`npm run verify:writer-authority`) before any flag ships, and adds the measured counter-measure (for
example `--disable-slash-commands`) if one of them changes the reported level.

**Quota, timeout and resume.**

- A higher level costs more tokens and time. How much, on AO's tasks, is not measured: RM6-01 first.
- The 30-minute cap (`AGENT_COMMAND_TIMEOUT_MS`, `src/agent/agent-command.ts:66`, used at `:398`) and
  the 64 MiB stdout cap (`:142`) stay. A run cut by either is `AGENT_PROCESS_UNAVAILABLE`
  (`claude-writer.ts:581`) and parks the task, so a higher level makes that likelier. The cap per
  repository is RM6-02's, not this item's.
- Every launch is a new CLI session: the vector has no `--resume`, `--continue` or `--session-id`.
  After a writer quota block AO commits the partial work (`src/loop/loop-step.ts:794-903`) and the
  resumed phase starts afresh, so the CLI's "a resumed session keeps its model" does not apply. The
  pinned level does.
- A usage-limit block never changes the level, up or down. The wait for a reported reset is unchanged
  (`src/core/automatic-resume.ts:232-241`).
- If the operator lowers a ceiling below a running task's pinned level, the next launch refuses with
  a named reason; it does not change the level silently.

**Evidence (RM6-06).** Per run, closed values only: `requested` (key and level, or `NONE`), the
policy applied (or `NO_POLICY`), `effective` (the argv tokens, or `CLI_DEFAULT`), `clamped`, the
reported model (the `system/init` `model`, kept only if it matches a strict model-id pattern, else
`UNRECOGNISED`), the reported effort (`NOT_REPORTED` until a capture shows the CLI reports it), and
the models in the result's `modelUsage` (listed on both result variants,
`docs/decisions/2026-08-22-claude-quota-reset-evidence-measurement.md:160-174`). A mismatch between
effective and reported is shown, never acted on.

**Ultracode stays off for writers.** AO never passes it, and the writer has no `Workflow` or `Agent`
tool. The docs say the keyword does not act in a prompt passed with `-p`; AO's prompt arrives on
stdin under `--print`, a case the docs do not name, so the RM6-09 measurement includes a task body
that carries the word `ultracode`. Turning ultracode on would add subagents, a new cost class and a
new failure mode in `-p`; it needs D7 and an ADR first.

**Dependencies and order.**

1. **RM1-03a merged.** RM6-06 reuses its store discipline (binding digest, byte cap, window,
   `git check-ignore`, lease check), not its schema. That record keeps failures only (every entry
   needs a failure code and a failed disposition, at least one entry:
   `src/agent/writer-outcome.ts:75-79`, `:97-112`, `:125` in the RM1-03a worktree) and is evidence
   only (contract invariant 2). So RM6-01's "into the writer-outcome record" cannot hold
   success-run data without a new version of that contract, and the pinned level, which decides
   argv, can never live there. Proposal: RM6-01 and RM6-06 share one sibling per-run record; the
   operator chooses between that and a version 2 when RM6-01 gets its contract.
2. **RM6-01 and RM6-06** before any flag is passed, so that today's model, effort, tokens and
   durations are measured first.
3. **D7.**
4. **RM6-02 and RM6-07** in one operator file, read once per invocation on every path that starts a
   writer. `repositories.yaml` is not that file today: an entry carries only `path` (`.strict()`,
   `src/registry/repository-registry.ts:246-255`) and only two modules read it (`:30-36`), so
   `run --repository` never sees it. The precedent is `mcp-capabilities.yaml`: a repository names a
   closed word, the operator grants (`src/config/mcp-capability-registry.ts:18-30`).
5. **RM6-09.**
6. **RM6-08 last**, and deployed before any task file uses the key: the frontmatter schema refuses
   an unknown key (`.strict()`, `src/plan/internal/task-definition-object-schema.ts:108-126`) and
   discovery is all or nothing (`src/plan/discover-tasks.ts:389-392`), so one such file on an older
   `dist` stops planning for the whole repository.

**Out of scope.** The Codex reviewer's model and effort. Any automatic level change — raising the
level after findings, a failure or a quota block is a retry in disguise. Ultracode, workflows and
subagents for the writer. `--max-turns` (not in 2.1.303's help) and `--max-budget-usd` (RM6-02).
A level in the repository profile. Any change to the operator's global or managed Claude settings.

## 13. What not to build

Confirmed by the audit and the code; each would break a property in section 5.

- Automatic verification retries or flake averaging.
- Lessons or skills applied automatically to prompts, briefs, `CLAUDE.md` or auto-memory.
- A shell for the writer.
- Timed or scheduled Codex review retries.
- Test-count parsing of runner output as a regression verdict (the exit code stays the verdict).
- An AO-owned emulator or visual harness (keep it repository-side, declared as a phase).
- An LLM-based failure classifier that moves state.
- A second retry or supervisor layer inside `src/` (extend the records so the external supervisor
  decides with less guessing).
- Any outgoing edge from `READY_FOR_PR`, or a merge decision in the task loop.
- More agents in parallel as a goal in itself.
- Ultracode, workflows or subagents for the writer, or a writer model or effort that repository
  content can raise (RM6-06..09).

## 14. Operator decisions

| ID | Decision                                                                                                         | Needed before | State                                                       |
| -- | ---------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------- |
| D1 | Wording of `CLAUDE.md:98-100` (PR, CI and merge "outside v1") against the delivery code                          | RM0-03        | open                                                        |
| D2 | Night review mode: Codex within its quota, or stop at `REVIEWING` for a review by a person the next morning      | RM1-04, P1    | **decided 2026-10-19: A, `stop-at-reviewing` for pilot P1** |
| D3 | May AO open a pull request unattended for an approved `READY_FOR_PR` task (RM3-01)?                              | RM3           | open                                                        |
| D4 | An operator acceptance that the delivery gate accepts, as an alternative to `resolve` (RM3-04)                   | RM3-04        | open                                                        |
| D5 | Approve pilot P1 (Appendix A): window, tasks, review mode                                                        | RM1-09        | **open: the night pilot stays disabled**                    |
| D6 | Where the supervisor's source lives                                                                              | RM1-10        | **decided 2026-10-19: A, in this repository (ADR first)**   |
| D7 | Writer model and effort: may AO pass `--model` and `--effort`; which model keys (alias or pinned ID) and levels each repository may use; ultracode stays off | RM6-07        | open                                                        |

**Operator release of 2026-10-19.** RM1-03a and RM1-10 are `APPROVED`: RM1-03a for its contract
and implementation, RM1-10 for its ADR, migration plan and CI tests. The
release covers no merge: every pull request still needs its own release. This file is the leading
development plan for AgentOrchestrator; a decision that changes it is recorded here.

**Temporary scope for RM1-10B (operator decision of 2026-10-19).** AO implements RM1-10B. For that,
PR #116 (merge `ca1658f`, task RM1-10S) added four file entries to `scope.allowedPaths`:
`ops/zera-supervisor/zera-supervisor.ps1`, `zera-wiring-test.ps1`, `zera-grant-lab.mjs` and
`README.md` in the same folder. Not `ops/`: the provers and `zera-register-task.ps1` stay outside,
and no file can be added there.

- **Why it is temporary.** AO enforces only the repository profile, read at each task's base commit
  (`src/scope/pinned-scope.ts`). It has no scope per task (RM1-11). So the four entries reach every
  task of this repository that starts while they stand, not only RM1-10B. Tasks that started before
  keep `src` and `tests`; on 2026-10-19 that was 12 of 13 `OPEN` tasks. `REVIEW-INSTRUMENT-001` had
  no state yet.
- **Conditions while the entries stand.** No AO run on this repository without an explicit
  `--task`. No unattended AO run on this repository. No other new AO task starts here. Only
  RM1-10B runs, attended.
- **Way back.** After RM1-10B is delivered, a separate pull request removes the four entries. A task
  that has already started keeps the scope of its base commit, RM1-10B included, so the removal
  changes no running task. Check before the removal that no task with a state has a base commit
  that carries the entries and still needs them.

## 15. Sources and how this file was checked

- **The capability-gap audit of 2026-10-17** (read-only, HEAD `0a74697`): gaps G1.1 to G7.2,
  candidates C1 to C12, top 3 (C1/C2, C3, C4/C6), "what not to build". It is not in this repository.
- **Its verification, 2026-10-18**, claim by claim against the code at `0a74697`: no claim refuted;
  partly true: the exact-command claim (3 of 6 attention reasons name no command), ntfy push (only with
  `notify.yaml`, only from `repositories --attended`), the per-machine reviewer lock (it is per
  process), G1.4 (`run --task` lists every attempt), G2.1 (`AGENT_FORBIDDEN_WRITE` leaves an evidence
  record), G5.4 (the code claim holds; the cited residual is about chains). Missed by the audit and
  listed here as existing capability: the delivery chain and its evidence stores, the registry and
  cross-repository selection, the execution lease and its recovery, the block runner, scope
  enforcement, the MCP capability preflight, redaction and line-safe text, runtime provenance.
- **Operations research, 2026-10-18**, read-only: the 68 HealthApp records, 54 passes, 31 attempt
  files, `git log`, 266 supervisor transcripts, the supervisor scripts and its README, and
  `schtasks /query`. The numbers in RM0 come from it; estimates are marked.
- Code references are file:line at `0a74697`. A line number can move; the named symbol is the
  reference.
- **Writer model and effort (RM6-06..09), checked 2026-10-19** at `ec74e98`: `claude --version`,
  `claude --help`, `claude agents --help` and `claude ultrareview --help` of the installed CLI
  2.1.303 (no session was started); the official docs `code.claude.com/docs/en/model-config`,
  `/workflows` and `/headless`; the RM1-03a code in its unmerged worktree. Its code references are at
  `ec74e98`.

## Appendix A — Overnight pilot P1 (PROPOSED)

A concrete plan for the first 6–8 hour nights after RM1. It reuses what exists: AO's
`repositories --attended`, the supervisor and its lanes, the Task Scheduler entry, ntfy. It designs no
new orchestrator. It needs decision D5.

### A.1 Answers to the ten questions (state of 2026-10-18)

| #  | Question                                   | Answer                                                                                                                                                                                                                     |
| -- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | What already works unattended?             | AO: selection, writer, verify, Codex review, remediation within budget, writer-quota wait, provable lease recovery. Supervisor: three standing lanes, notifications. The supervisor's delivery path exists but never ran. |
| 2  | Why do tasks stop before review or delivery? | Spent review budget (24 of 28 resolves); failed verification, never retried (45 attempts); the no-Codex policy (7 tasks parked at `REVIEWING`); Codex quota (human-only); writer quota; scope violations; the delivery gate accepts no resolved task and no task outside a hard-coded list. |
| 3  | Which limits are intentional governance?   | Section 5 of this file, plus the supervisor's own refusals (no stale-lease recovery, no `--remediate-verify-failure`, no scope override, no force push, no merge without its gate).                                         |
| 4  | Which manual actions can go safely?        | The DONE flip, CI polling, the fast-forward after a merge, handoff archive rotation, writer quota and restart (already standing lanes), stepping `--max-steps` by hand (RM1-04), writing the morning status (RM1-06).       |
| 5  | How can approved tasks run in sequence?    | One `repositories --attended` invocation walks the whole ranking, one task per repository at a time. A dependent task needs its dependency's DONE flip merged first. RM1-01 adds the night boundary.                        |
| 6  | What happens when the queue is empty?      | AO admits nothing; the supervisor stops silently every 30 min. RM1-02 and RM1-06 turn it into one message.                                                                                                                  |
| 7  | How are quota problems handled?            | Writer: a recorded reset is waited for (bounded); otherwise the quota lane continues (1 per 2 h, 4 per day). Codex: never automatic; an operator item. RM1-02 fixes the classifier gap.                                     |
| 8  | What happens after repeated failures?      | No verify retry; review budget then `HUMAN_DECISION_REQUIRED`; writer restarts at most 2 per run, 4 per day; every granted attempt that ends blocked stops the run and notifies.                                              |
| 9  | How can AO produce an actionable morning summary? | RM1-06 (roll-up over the night, built on the dashboard read model) and RM1-07 (heartbeat). Until then: a person runs `run --repository <root>` and reads the status file.                                              |
| 10 | Which changes give the most benefit?       | In order: RM1-02 (stops the silent loop), RM1-01 (night boundary), RM1-04 (review mode without hand stepping), RM1-03 (writer cause; safer restarts), RM1-06 (morning report), then RM2-01/02 (fewer wasted rounds).        |

### A.2 Entry prerequisites (all must hold; checked the evening before)

1. RM0-01, RM1-01, RM1-02, RM1-03a, RM1-03b, RM1-04, RM1-08 and RM1-10 are `DONE`; RM1-06 is
   `DONE` or the operator accepts a morning report written by hand from the records for the first
   night. RM1-03 counts only when both parts are done: the supervisor's writer-restart lane reads the
   writer-outcome record and does not restart a deterministic code (`AGENT_ARGUMENT_REFUSED`); see
   section 4, point 3.
2. Decision D2 (review mode) is recorded (A, 2026-10-19); D5 (this pilot) is recorded.
3. `dist/` is deployed from `main` (`dist/.ao-provenance.json` names the `main` HEAD, `CANONICAL`).
   `agent-loop doctor` passes. `agent-loop lease status` is `FREE` for every registered repository.
4. The project checkout is on its default branch, clean and fast-forwardable from `origin`.
5. **No task is left in a state the night would continue against policy.** A task at `REVIEWING`
   under a no-Codex policy is delivered or parked first (DESIGN-023 was delivered on 2026-10-19);
   otherwise any attended run would start its Codex review.
6. Every task on the night list has a merged contract and task file, a declared scope, all
   dependencies `DONE` on the default branch, and a brief that fits the brief limit.
7. The supervisor's lab (`zera-grant-lab.mjs`, `zera-wiring-test.ps1`) passes on the deployed `dist`.
8. No HealthApp pull request is in CI: its CI runs on the self-hosted runner on the same machine and
   competes with AO's verification.

### A.3 Existing commands and interfaces

- Scheduler: the Task Scheduler entry `\Zera\Zera unattended supervisor` (enable for the window,
  disable after).
- Supervisor: `C:\Users\Max\AO-runs\zera-supervisor.ps1` with its caps (`$MaxOuterPasses`, AO
  `--max-cycles`, `--max-steps`, `--max-invocations 1`).
- AO: `agent-loop repositories --attended --wait-for-reset --max-wait-ms <ms> --max-cycles <n>`;
  read-only `agent-loop run --repository <root> [--task <id>]`, `agent-loop attention`,
  `agent-loop lease status`, `agent-loop dashboard serve`.
- Notifications: ntfy (wrapper and AO); one message per distinct condition.

### A.4 Task-selection conditions

A task starts only if it is on the night list (RM1-01) **and** AO ranks it eligible (`OPEN`, every
dependency `DONE`). At most 3 tasks per night. Risk class low or medium only (no data migration, no
change to storage, no new dependency). One repository, one task at a time.

### A.5 Independent review requirements

- Mode `codex` (D2): at most the review budget of the profile; Codex is one-shot; a Codex quota block
  stops the review lane and becomes one operator message. Plan for about 2 to 3 reviews per 5-hour
  quota window.
- Mode `stop-at-reviewing` (D2): the task stops at `REVIEWING` after a passing verification; a person
  (or an attended Claude session on the operator's order) reviews it in the morning.
- In both modes the writer never reviews its own change, and no task is reported as delivery-ready
  without a review.
- **For P1 the mode is `stop-at-reviewing`** (D2 = A, 2026-10-19).

### A.6 Stop conditions (each ends the night or the task, and sends one message)

| Condition                                                       | Effect                       |
| --------------------------------------------------------------- | ---------------------------- |
| Two passes with no state change                                  | Stop the night               |
| `SCOPE_VIOLATION`, `RESUME_STATE_DIVERGED`, `BLOCKED_AUTH`        | Stop that task               |
| Codex quota block                                                | Stop the review lane         |
| A lease that cannot be proven dead                               | Stop that repository         |
| The checkout is not on its branch, not clean, or not updatable   | Stop the night               |
| A standing lane spent its budget                                 | Stop that task               |
| Any forge act (push, pull request, merge) attempted in RM1       | Stop the night; a defect     |
| 06:30 local                                                      | Stop the night               |

### A.7 Resource limits

One repository, one task at a time (lease). Writer and verification are each capped at 30 minutes by
AO. One verify cycle takes about 18 minutes. No other heavy job on the machine during the window (no
local `npm run verify`, no emulator, no self-hosted CI run). Codex: at most the reviews one quota window
allows.

### A.8 Recovery procedure (morning)

1. Read the morning report (RM1-06), then `agent-loop run --repository <root>` for each task named.
2. For each stop, run the next command the report names, or decide. Never edit a runtime JSON file by
   hand.
3. A held lease: `agent-loop lease status`; recovery only on AO's proof.
4. A crashed supervisor: the next scheduled pass re-enters; after a reboot, the entry runs only after
   logon ("Nur interaktiv").
5. Disable the scheduled task after the window, then record the night's numbers (A.9).

### A.9 Success metrics (per night; the pilot passes after two nights)

| Metric                                                           | Pass                                 |
| ---------------------------------------------------------------- | ------------------------------------ |
| Unauthorised acts (a task off the list started, a forge act)     | 0                                    |
| Silent no-progress passes before a stop                          | at most 2, then one message          |
| Morning-report lines that disagree with the records              | 0                                    |
| Approved tasks that reached `REVIEWING` or `READY_FOR_PR`         | at least 1 of the night list         |
| Stops without a named cause and next command                      | 0                                    |
| Human acts needed in the morning per finished task               | recorded; compared with RM0           |
