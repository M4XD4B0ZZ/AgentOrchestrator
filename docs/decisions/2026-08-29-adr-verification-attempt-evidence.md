# ADR — durable verification evidence, and the continuation it makes executable

**Status:** accepted, 2026-08-29
**Slice:** M1 blocker fix — not a feature slice, and deliberately not "slice 20".
Slice 19, the M1 release gate, stays open and is resumed after this merges.
**Supersedes nothing.** Narrows four standing sentences, each corrected in place
rather than deleted, and each named in *What this made false* below.

## 1. What happened

Slice 19 drove eight real tasks through AO against AO. Five verification runs
across four of them ended `BLOCKED_VERIFY`. The operator then ran the
repository's two declared phases — `npm ci` and `npm run verify` — on a produced
tree, and both exited 0.

The obvious reading is "AO's verification is wrong". It was measured, and it is
false.

## 2. The measured root cause

Two different causes, and **AO was correct in every case**.

| task | verify step began | state written | elapsed | `tsc --noEmit` today | class |
| --- | --- | --- | --- | --- | --- |
| `M1-RELEASE-002` | 13:26:18 | 13:38:08 | 11m50s | exit 0 | `TEST_FLAKE` |
| `M1-RELEASE-003` | 14:27:43 | 14:39:31 | 11m48s | exit 0 | `TEST_FLAKE` |
| `M1-RELEASE-006` | 22:53:09 | 22:53:19 | **10s** | **exit 1** | `VERIFICATION_COMMAND_DEFECT` |
| `M1-RELEASE-007` | 23:09:26 | 23:09:36 | **10s** | **exit 1** | `VERIFICATION_COMMAND_DEFECT` |
| `M1-RELEASE-008` | 23:24:23 | 23:46:52 | 22m29s | exit 0 | `TEST_FLAKE` |

`stateEnteredAt` is the instant the verify **step began** — `run-driver.ts`
evaluates `deps.now()` when it builds the step's dependencies, before
`runVerification` is awaited — so the elapsed column is the gate's own wall
time, recovered from the state file's mtime. That it had to be recovered that
way is the defect this ADR is about.

**006 and 007.** `tests/memoised-template-cleanup-effect.test.ts` fails
`tsc --noEmit` with `TS2339: Property 'unref' does not exist on type 'Readable'`,
reproduced today in a clean read-only check in both surviving worktrees. `npm run
verify` runs `typecheck` second, before `build`, which is why both runs ended in
ten seconds and why `M1-RELEASE-007` has no `dist/` at all. **The operator never
re-tested those two trees.** There was never a disagreement here.

**002, 003 and 008.** These reached the test suite. `M1-RELEASE-008`'s own new
test spawns a nested `vitest` run of `tests/v4-09-post-merge-verification.test.ts`
under a 90-second child timeout (`M1-RELEASE-002`'s uses 60 seconds), inside
`test:foundation-safe` — the *parallel* gate. `package.json` already records why
that file is excluded from that gate: 41 seconds solo here, **107 seconds on
CI**. The test is load-sensitive, and the writing agent wrote it.

The controlled measurement: `M1-RELEASE-008`'s exact commit `38a24a2` was run
through the **production** verification path — real `runVerification`, real
`runVerificationCommand`, `createProbeEnv('capability:generic')`, the task's own
worktree, the 30-minute bound and the 8 MiB budgets — in a scratch worktree with
no other AO work in flight:

```
BUILD   npm ci          RAN  exit 0     12,440 ms
VERIFY  npm run verify  RAN  exit 0  1,258,843 ms   (21m)
verdict PASSED
```

Twenty-one minutes against the failing run's twenty-two and a half. Same tree,
same commands, same environment policy, same seam; the difference is what else
was running. **`TEST_FLAKE`**, and specifically a load-sensitive test the task
itself introduced.

### The environment difference is real and is not the cause

Measured, because it was the leading hypothesis and had to be refuted rather than
dismissed. A verification child receives exactly twelve environment variables:
`PATH` and `PATHEXT` from `capability:generic`, plus the ten `exec.ts` back-fills
on Windows. `APPDATA` and `LOCALAPPDATA` are absent, with two visible
consequences:

- npm's cache resolves to `C:\Users\Max\npm-cache` instead of the operator's
  `%LOCALAPPDATA%\npm-cache`. That directory exists, created 2026-08-28 05:33 —
  AO's first dogfood — and holds 34 MB. Every AO `npm ci` used a separate,
  initially cold cache. It filled successfully;
- npm's global prefix is left literally unexpanded. Its own debug log records
  `config load:file:D:\...\wt008${APPDATA}\npm\etc\npmrc`.

Neither produced a failure. `npm ci` under this policy installs the identical
48-entry tree in 12 seconds, and the controlled run above passed the whole gate
under it. **The environment is not widened**, and the hard stop stands: a normal
shell passing is not a reason to give a repository's own commands more of the
operator's environment.

### What was refuted, and how

Ruled out by the state machine rather than by argument: a timeout, an output
flood, a lost lease, a refused argv, a lost process boundary and a spawn failure
**all map to `UNAVAILABLE`**, which routes to `HUMAN_DECISION_REQUIRED` with
`resumeFrom VERIFY`. All four surviving states are `BLOCKED_VERIFY` with
`resumeFrom REMEDIATE`, so a real process ran to its own end and exited non-zero
in every case. Measured alongside: the controlled run produced 129 KB of stdout
and 172 KB of stderr against an 8 MiB per-stream budget, with no truncation, and
used 70 % of the phase timeout.

## 3. The actual defect

Not the gate. **The explanation.**

`VerificationReport` was computed, returned to the caller as
`LoopStepResult.verification`, consumed by nothing, and dropped when the process
exited. `grep -rn "diagnostics" src/cli src/run src/loop` returned no reader.
An operator invoking `run --task M1-RELEASE-008` the next morning was told:

```
State        : BLOCKED_VERIFY  (entered 2026-08-28T21:24:23.082Z)
Continuation : ATTENDED_ONLY  (HUMAN_DECISION_REQUIRED)
Reasons      : none
```

A ten-second typecheck error and a twenty-two-minute load-sensitive test failure
produced **byte-identical** durable records. The two need opposite responses.

There was a second half. `BLOCKED_VERIFY -> REMEDIATING` has been in
`core/transitions.ts` since V1 and `core/resume-policy.ts` has said all along
that the state is `resumable: true`, `requiresHumanDecision: true`, resume phase
`REMEDIATE`. Nothing could take it, for two independent reasons:

- `run-driver.ts`'s blocking gate admitted exactly one verdict,
  `AUTOMATIC_ALLOWED`, which `BLOCKED_VERIFY` can never carry because it is
  `automaticResumeEligible: false`. `--attended` is checked *later* and never
  reached;
- even past that, `runRemediateStep` builds its brief from `findingHistory`,
  which a verification failure does not populate, and refuses to invent one. It
  would have parked at `HUMAN_DECISION_REQUIRED` one durable step later having
  started no writer. Its own comment named the case: *"the report is deliberately
  never persisted, so nothing durable makes it actionable."*

The two halves are one defect. Fixing either alone buys nothing.

## 4. What is unchanged, and stays unchanged

**One process per phase. No retries. Ever.** A flaky suite that passes on the
second attempt has not passed. This change adds no retry, and the store is
explicitly not one: `verification-attempt.ts` states that writing an attempt down
does not make another one permissible.

**A second green run does not erase the first failure.** The history is
append-only and a pass writes nothing at all, so a later `PASSED` leaves the
recorded failure exactly where it was. Pinned.

**`FAILED` and `UNAVAILABLE` stay apart.** Both are recorded, under distinct
verdicts, and they still route to different states.

**Raw stdout and stderr are still never persisted.** Nothing in the schema can
hold them.

**`BLOCKED_VERIFY` is still not automatically resumable.** The transition table,
the resume policy and `evaluateAutomaticResume` are untouched.

**`READY_FOR_PR` is still terminal.** Delivery code is untouched.

## 5. The record

```
.agent-orchestrator/runtime/verification-attempts/<taskId>.json
```

Its own directory, following `delivery-verification/` and `blocks/`: a task id
may contain dots, so `<id>.verification.json` is a legal *other task's* file
name — a collision a review has already reproduced once in this repository.

Under the **repository root**, never the worktree. That is a security boundary,
not tidiness. The writing agent's cwd is the worktree, and `scope/task-delta.ts`
passes `--exclude-standard`, so a record under the worktree's own ignored runtime
directory would be **writable by the agent whose work it describes and invisible
to the scope guard** — a forgery primitive with no detector.

The sentence it carries:

> At time T, the worktree at commit C was measured against verification profile
> P, and the run ended thus.

Bound to: schema version, task id, repository root, subject commit, profile
digest, attempt instant, verdict, stopping phase, the ordered phase reports —
each with outcome, exit code, signal, truncation flag, `failureCode`, `errnoCode`
and duration — and the two bounded excerpts. A `binding` digest covers every
field of every attempt **and every line of every excerpt**, computed field by
field rather than from `JSON.stringify`, so an edited stored diagnostic reads
back as `NOT_THIS_TASK`.

`failureCode` and `errnoCode` are new on `VerificationPhaseReport`. They were
computed by `verify-command.ts` and dropped. They are the only thing separating a
timeout from an output flood from a program that was never found, all three of
which arrive as `UNAVAILABLE` with a `null` exit code.

## 6. The diagnostics, and why this record carries what its sibling refuses

`deliver/post-merge-verification.ts` stores no repository output at all, and says
so: *"the way to keep that out of a durable file is to give it nowhere to go."*
This record stores an excerpt. The reason is measured, not preferred: **the
writing agent has no shell.** `claude-writer.ts` grants no `Bash`, so a
remediating writer cannot re-run the gate. A brief naming only a phase and an
exit code would send it to change a tree it has no way to inspect the failure of.
The excerpt is the only channel there is.

Three guarantees, three mechanisms, and **none of them is "the text is safe"**:

- **bounded** — the excerpt is `agentDiagnostics()`'s output unchanged: clamped
  *after* redaction, with the raw cut held outside the redactor's field of view.
  Bounded a second time here, *after* line-safety expands it;
- **redacted** — by `auth/redaction.ts`, whose own header is candid that it is *"a
  safety net, never the boundary"*. Repeated here rather than softened. An
  investigation measured its misses: GitHub PATs, AWS keys, Slack and npm tokens,
  GitLab PATs, `password=`, `ANTHROPIC_API_KEY=` and PEM blocks all survive it.
  The record is a Git-ignored file under the repository root and is transmitted
  nowhere, and that — not the redactor — is what bounds the exposure;
- **line-safe** — every character that could forge a line or reorder one is
  replaced by its code point *before* storage, and the excerpt is stored as an
  **array of lines**. There is no newline in any stored value, so no stored value
  can introduce a free-standing line into a report or a prompt. That is
  structural, not a convention.

`core/line-safe-text.ts` is the class and the substitution, **moved** out of
`cli/render-publication-authorisations.ts` rather than copied: `exec.ts` states
the standing objection, that a second copy would be free to drift.

There is **no `trusted` field on disk**. A stored boolean saying "do not trust
this" is a claim by whoever wrote the file — dead weight if it can only be
`false`, a forgery lever otherwise. The schema is `.strict()`, so a document
carrying one is refused; `trusted: false` is reconstituted by the reader.

## 7. Write ordering

```
run verification
  -> obtain the complete report
  -> a pass writes nothing and advances
  -> otherwise: read HEAD, build the attempt, prove the lease, write, read back
  -> only then persist the state transition
```

**The dangerous world is a `BLOCKED_VERIFY` with no explanation** — which is
precisely what the release gate produced. Reversing the order puts a durable
accusation against the repository on disk with its evidence still in flight.

So `BLOCKED_VERIFY` is written **only** when the record came back off the disk.
Where it did not, the task lands at `HUMAN_DECISION_REQUIRED` with `resumeFrom
VERIFY` — byte-identical to the existing `UNAVAILABLE` landing. **No new state
was invented.** That edge is already declared from `VERIFYING`, `VERIFY` is a
resume phase the loop drives, and re-running the gate is the right continuation.
It is also not a loss: a `BLOCKED_VERIFY` without evidence is a state whose one
continuation cannot be taken, so the alternative is the same park one durable
write later, at the resume phase that cannot help.

`UNAVAILABLE` records an attempt too — *"AO tried three times and could never
start the gate"* is otherwise unrecoverable — but its transition does not depend
on that having worked, because `HUMAN_DECISION_REQUIRED` is already the truthful
state for "nothing was learned".

The crash windows:

| window | on disk | what a later run sees |
| --- | --- | --- |
| after verification, before the record | state `VERIFYING`, no record | in flight; the gate runs again |
| after the record, before the state | an attempt, state `VERIFYING` | in flight; the gate runs again and appends a second attempt |
| the record write fails | no record, state `HUMAN_DECISION_REQUIRED` | a human decides; the store code was reported on the run that hit it |

The lease is re-proved **immediately before the write**. Not belt and braces: the
verification can take twenty minutes, so the check the *spawn* made is twenty
minutes stale, and a record written by a run that has stopped being the writer is
an artefact from an unauthorised process.

Read-before-write is **not a transaction**, and this is stated rather than
implied: two invocations racing on one task can both append and the second
replace wins, losing the first's attempt. Bounded by the execution lease, exactly
as `post-merge-verification-store.ts` records for itself.

## 8. Corruption, versioning and history

Version checked **before** the schema, so a newer build's record is
`UNSUPPORTED_VERSION` and not `MALFORMED`. `ENOENT` is the only errno that means
`ABSENT`; every other open failure is `MALFORMED`, because reporting a
permissions problem as "nobody wrote one" would also be permission to start a
fresh history over it. A directory standing where the file should be, an
oversized file, a short read, non-JSON and wrong-shaped JSON are all `MALFORMED`.

`MALFORMED`, `UNSUPPORTED_VERSION` and `NOT_THIS_TASK` all refuse the write and
**never replace** what is there.

Append-only, oldest first, bounded at six attempts. Full is **refused**, not
evicted: the oldest evidence is the evidence most likely to disagree with the
newest, and disagreement between attempts is exactly what the release gate needed
and did not have.

## 9. The continuation

```
agent-loop run --repository <path> --task <id> --attended --remediate-verify-failure
```

A **fourth authority**, in the shape `mayStartTask` and `mayRecoverStaleLease`
already have: a predicate over the grant conjoined with a request the operator
made now, not a fourth `InvocationGrant` member. `--attended` says a human is
*present*; it says nothing about what they decided, which is why it is
unconditional at `permitsContinuation`. Leaving a failed verification is a
**decision** — the block's own rationale calls it one.

Every conjunct is load-bearing: the state is `BLOCKED_VERIFY`; the operator asked
on this invocation; the grant is `ATTENDED` (`AUTOMATIC_RESUME_ONLY` is refused,
so no unattended run reaches it however invoked); the resume point names
`REMEDIATE`; and this invocation has not already spent it.

`resumeBlockedTask` is **unchanged**. It already read `resumeFrom` and moved to
the state it names.

### The cycle bound, and why it is not optional

`VERIFYING -> BLOCKED_VERIFY -> REMEDIATING -> VERIFYING` touches neither
`reviewRound` nor `maxReviewRounds` — remediation rounds are counted by
*reviews*, and a verification failure is not one. Until now that cycle was
bounded by the fact that **nothing could leave `BLOCKED_VERIFY` at all**, which
is a real bound and the one being removed. `DEFAULT_MAX_STEPS` is 8, enough for
roughly two and a half traversals.

So the decision buys exactly **one** departure, spent after the write lands and
never before, and refused a second time at both the driver and the lifecycle.

**What actually holds that today is not those refusals, and the difference is
worth stating.** A counter-proof mutant deleting the driver's limit survived
every test. Chasing why found two pre-existing rules that already stop the cycle:
a `BLOCKED` loop step ends the `runTask` call unconditionally, and
`driveLifecycle` re-enters `runTask` only on `STEP_BUDGET_EXHAUSTED`, so a
`BLOCKED_VERIFY` outcome ends the lifecycle rather than continuing it.

The limits are kept at both levels as **fail-closed floors**, described as floors
rather than as the bound. Adding the lifecycle-level one was not wasted work: it
was written because the driver-level one is per-`runTask` and the lifecycle
re-enters, which looked like a real hole until the `BLOCKED`-ends-the-run rule
was measured. The honest status is: redundant while both rules hold, and the
thing that would stop a runaway if either were ever changed.

### Semantics

It is **not** "retry verification". It is: operator decision -> `REMEDIATING` ->
the writer receives the recorded failure -> the writer may change the tree ->
`VERIFYING` runs again **on the new tree** -> the ordinary lifecycle continues.

The brief is written in AO's voice about a run AO performed. Every structural
claim — phase, exit code, duration, commit — comes from a record this build wrote
and read back. Only the excerpt is foreign: it is fenced, every line quoted with
a fixed prefix, labelled `UNTRUSTED`, and accompanied by the statement that it is
the *head* of the stream and not its end — an honest limitation of reusing the
existing representation unchanged, carried as a residual rather than repaired by
inventing a second one.

The brief is refused, and no writer is started, when the latest attempt's
`subjectCommit` is not HEAD **now**. A remediating writer moves HEAD, and a brief
built from an attempt about an earlier commit tells a writer that the tree in
front of it failed when what failed no longer exists. Review findings, where they
exist, win: they are the stronger cause.

### The unchanged-tree case, pinned rather than changed

If the writer changes nothing, `commitPassOrPark` answers `NOTHING_TO_COMMIT` and
the step parks at `HUMAN_DECISION_REQUIRED` with `resumeFrom REMEDIATE`. It does
**not** advance, re-verify, loop or error. *Nothing changed -> nothing recorded ->
the pass is inadmissible* is the existing rule and it is left exactly as it is.

The consequence is stated rather than hidden: `HUMAN_DECISION_REQUIRED` has the
same missing executable edge `BLOCKED_VERIFY` had, so an unchanged-tree
remediation moves the wall one hop rather than removing it. Extending this
authority to that state is a second decision and is **not** taken here. Carried
as a residual.

## 10. What this made false

Four sentences were true when written and are now narrower. Each is corrected in
place:

- `agent/agent-outcome.ts` — `AgentDiagnostics` was "never persisted", full stop.
  Now: no agent's diagnostics are persisted and `TaskState` holds none; the
  *verification* seam's excerpt is the input to a record outside `TaskState`;
- `verify/run-verification.ts` — the report's diagnostics are "never persisted
  **as they stand**", with the qualifier doing real work;
- `verify/verify-command.ts` — the **raw** streams are still never persisted
  anywhere, and the reason is restated: neither `TaskState` nor the attempt
  record has a field they could reach;
- `loop/loop-step.ts` — the comment naming `BLOCKED_VERIFY -> REMEDIATING` as the
  sharp case now records that it *was* the release blocker and what closed it.

## 11. What this record never means

Not that verification would fail now. Not that the repository is at fault
(`UNAVAILABLE` is in the vocabulary for that reason). Not that remediation is
authorised — that comes from an operator, and this is read *after* the decision,
never as it. Not that a retry is authorised. Not that the diagnostics are true.
And **its absence proves nothing**: nothing adds an entry to this failure
history for a pass, and a store that could not be written is a store that was
not written. M8 added a separate record for a pass — see
`verify/verification-pass.ts` — which does not change anything in this document:
this history is still failures only, still bounded, and still the only thing that
answers "why did AO stop". The report says
so in those words rather than printing "no diagnostics".

## 12. Non-goals

No automatic retry. No raw output persisted. No environment values persisted. No
widening of the environment policy. No change to the AO profile's verification
commands. No new task state. No `BLOCKED_VERIFY -> VERIFYING` edge. No retention
or indexing. No Codex quota work, no reviewer change, no review-round economics.
No release documentation. No M2. The first-publication proof is not restarted.

## 13. Residuals

- **L-M1-VR-1** — the stored excerpt is the *head* of the failing phase's stream.
  For a long test run that is the banner rather than the assertion. Repairing it
  means a second representation or a signature change to `agentDiagnostics`, and
  neither belongs in a blocker fix. The brief says which end it is.
- **L-M1-VR-2** — `HUMAN_DECISION_REQUIRED` has the same missing executable edge.
  An unchanged-tree remediation, and a `FAILED` whose evidence did not become
  durable, both land there and are then as stuck as `BLOCKED_VERIFY` was.
- **L-M1-VR-3** — the record is not tamper-proof. Anything running as this OS
  user can write one, and the binding detects an *edit* to a record this build
  wrote, not a forgery built with the digest. Same concession as `L-V4-14-2`.
- **L-M1-VR-4** — two invocations racing on one task can lose an attempt. Bounded
  by the execution lease, not excluded by the store.
- **L-M1-VR-5** — the four parked `M1-RELEASE-*` tasks predate the store and have
  no record, so this fix does not recover them. Their evidence is gone; their
  trees survive and `tsc` still answers for two of them. Whether to continue,
  abandon or re-run them is an operator decision this change does not make.
- **L-M1-VR-6** — `test:foundation-safe` runs a nested-`vitest` pattern that this
  investigation measured as load-sensitive. Three of five release-gate failures
  were that pattern. It is the task author's problem, not the gate's, but it will
  recur.

## 14. Next

Slice 19 — the M1 final release gate — resumes after this merges and is
post-merge verified. It is not restarted here.
