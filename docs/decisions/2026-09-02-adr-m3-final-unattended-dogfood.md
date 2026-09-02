# The final multi-project dogfood, and what it settles

**Date:** 2026-09-02 · **Status:** accepted. No production code changed.

M1 closed autonomous delivery for attended use. M2 gave this build a registry of
several repositories, cross-repository selection, bounded concurrency and
reviewer-quota resilience. M3 slice 1 gave it a scheduler whose wait outlives the
process that made it, and slice 2 gave it recurring operation, a durable
operator-attention outbox and a notification for the conditions in it.

Every one of those was measured on its own. **None of them had ever been asked
the question the product exists to answer**, which is a single sentence:

> Can one AgentOrchestrator process centrally operate across several
> repositories for a meaningful interval — making progress where it owns the
> decision, waiting where the machine can resume, surfacing operator-owned
> conditions, preserving repository and process safety, and recovering correctly
> across interruption and restart?

This record is the run that asked it. It changed no production code, because
nothing it found made the defined product wrong, unsafe or unrecoverable.

## What this run is, and what it is not

Every invocation below carries `--attended`, because that is the only grant
`repositories` offers and this build defines it as an authorisation rather than
as a claim that somebody is looking. What was demonstrated is **one invocation
driving three repositories across several cycles with no re-invocation between
them**, and a restart that lost nothing.

It is **not** a demonstration that unattended operation is supported. **U1–U4 are
untouched** and the Status section's claim is left exactly as it stands. A human
intervened deliberately six times over twenty-five minutes, and each intervention
is named in this record.

## Why the real operator home, and not a test profile

The product resolves its operator home through `os.userInfo()`
(`src/config/internal/path-provider.ts`). It consults **no environment block**:
`AGENT_LOOP_HOME` was removed and is only detected and reported
(`src/config/paths.ts:100`). The two environment names that can relocate it —
`AGENT_LOOP_TEST_PROFILE` and `AGENT_LOOP_TEST_EGRESS` — exist only under
`tests/dist-artifact/`, where the harnesses set them and the preloads read them
by monkey-patching `os.userInfo` under `node --require`. `grep -rn
'AGENT_LOOP_TEST_' src/` returns nothing.

A dogfood driven through that preload would be driving a test seam. So this one
used the operator's real home, `<user profile>\.agent-orchestrator\`, with its
real `repositories.yaml` (backed up and restored afterwards, byte-identical) and
its real `notify.yaml`. No `--require`, no environment seam, and
`src/cli/index.ts:242` registers `repositories` with one argument, so every seam
resolved to its production default.

## The topology

Three distinct physical repository roots, each a real `git init` with a real
commit, none of them this repository:

| Repository | Id | Task(s) | The condition it exists for |
| --- | --- | --- | --- |
| `dogfood\alpha` | `alpha-service` | `SHARED-1` | machine-owned progress, driven to a terminal state by real production execution |
| `dogfood\bravo` | `bravo-service` | `WAIT-1`, later `WAIT-2` and `WAIT-3` | a durable machine-owned wait, then a real resume; and the ownership counter-proof |
| `dogfood\charlie` | `charlie-service` | `SHARED-1` | a real operator-owned condition, produced by production |

`alpha` and `charlie` deliberately carry **the same task id**. Their verification
phases are committed files under `scripts/`, which is outside each profile's
`scope.allowedPaths` (`src` only), so the writing agent cannot weaken the gate it
has to pass.

`charlie`'s declared verification can never succeed — its script is built with
`wanted = null` and exits 1 unconditionally. That is the point: the writer really
ran and really committed `hello, charlie` first, and the `BLOCKED_VERIFY` that
followed was written by AgentOrchestrator and not by a fixture.

## The hand-written surface, stated rather than buried

Six deliberate human acts, all of them by the operator running the dogfood:

1. **`bravo`'s three quota records were written by hand**, in the shipped durable
   shape, by `park-bravo.mjs` and `park-pair.mjs`. A genuine subscription quota
   block needs an exhausted allowance and cannot be produced on demand. Their
   worktrees and branches were created by those scripts with `git worktree add`,
   not by the orchestrator's own workspace preparation;
2. **the orchestrator was killed** with `taskkill /F` (see the restart section);
3. **the `WAIT-2`/`WAIT-3` fixtures were rebuilt** after the first pair was
   rejected — see immediately below;
4. **the operator-attention store was deleted** on purpose, to prove
   reconstruction;
5. **the operator escape was run by hand**, which is the point of that section;
6. **the `WAIT-3` fixture was retired** — its task set to `DONE` and its durable
   record removed — which is what made the `NO_FUTURE_WAKE` ending reachable.

### The hand-written records were not accepted on trust

Each is validated on the way back in by `loadTaskState`. `WAIT-1` also reconciled
on merit at the first attempt, and the product was asked before the run began.
This is `WAIT-1`'s own read:

```text
State        : BLOCKED_USAGE_LIMIT  (entered 2026-09-02T18:27:42.470Z)
Reconcile    : RECONCILED
Continuation : BLOCKED  (AUTOMATIC_RESUME_REFUSED)
Reasons      : RESET_TIME_NOT_REACHED, AUTH_PREFLIGHT_NOT_PASSED
```

The **first** `WAIT-2`/`WAIT-3` pair did *not* reconcile: it pinned the commit
that preceded the one its worktrees were created from, and both admissions came
back `RECONCILIATION_DIVERGED / CURRENT_COMMIT_MOVED` (`H-run3.log`). That is the
reconciler refusing a bad fixture, which is the right outcome and worth recording
as one. The script was corrected to capture `HEAD` after its own commit and the
pair was rebuilt; only the second pair produced the table below.

What such a record cannot claim is the recovery of partial work: with
`currentCommit === basePinnedCommit` and a clean tree, resuming from
`IMPLEMENT/1` is identical in effect to a first `IMPLEMENT`. It proves the
**wake** and the **resume decision**, and it is not offered as more.

## What the run did

One command, no re-invocation between cycles:

```text
agent-loop repositories --attended --max-steps 12 --max-invocations 1 \
  --wait-for-reset --max-wait-ms 900000 --max-cycles 6 --idle-poll-ms 20000
```

### The productive pass, and why it has no report

The first process drove `alpha` and `charlie` to real endings. **It printed
nothing**, because it was killed before it returned: `E-run1.log` is 0 bytes,
which is residual `L-M3-02-10` behaving exactly as recorded. That is the single
most useful thing this run learned about that residual — the pass that does the
work is the pass whose report you do not get.

So what is known of that pass is durable state, two real commits, the process
table and a third-party timestamp, observed while it ran:

```text
18:36:11Z   alpha    lease=HELD   SHARED-1=REVIEWING
            charlie  lease=FREE   SHARED-1=BLOCKED_VERIFY
            bravo    lease=FREE   WAIT-1=BLOCKED_USAGE_LIMIT@18:42:12.423Z
            processes: 14760 ao-launch.exe, 14916 codex.exe
18:37:53Z   alpha    lease=FREE   SHARED-1=READY_FOR_PR
            outbox: 1 item, charlie-service/SHARED-1
```

Two repositories were driven in one pass: `charlie` had already reached its
ending while `alpha` was still holding its lease with a live `codex.exe` under
the native `ao-launch.exe` boundary. That is also the evidence that the reviewer
really ran — a real reviewer process was observed executing, and `READY_FOR_PR`
appeared only in a later observation. It is **not** derived from `stateEnteredAt`
arithmetic: `now` is taken when a step *begins* (`src/run/run-driver.ts:1215`)
and stamped on the state that step writes at its end, so a step containing a
review carries a stamp earlier than its own write.

`alpha`'s commit `AO:SHARED-1:IMPLEMENT:r1` contains `return 'hello, world';`, so
the work is graded from the commit and not from an exit code — which matters,
because the declared verification is a substring check.

### The reported pass

`Peak concurrency: 3` against `Capacity: 3` comes from the **restarted** process's
cycle 1 (`E-run2.log`), four minutes later, over the same three repositories. Its
three admissions were a terminal re-read (`alpha`), an unchanged block
(`charlie`) and a refusal (`bravo`) — so it is the measurement of three-way
concurrent *admission*, not of three-way concurrent productive work. The
coordinator's own counter (`maxObservedConcurrency`) is what prints it, and the
exclusion it respects is on `gitCommonDir`, not on `repository.id`.

In that cycle **`bravo/WAIT-1` was admitted** — admission #3, `concurrent: 3` —
took and gave back its execution lease, and its automatic resume was then refused
`RESET_TIME_NOT_REACHED`. That is accepted residual `L-M3-01-3` behaving as
recorded: every cycle re-admits every settled task and the refusal arrives as
data from inside the run, not from an admission filter. What it **raised** is
nothing at all, and that is the interesting half: a wait the machine owns is not
a person's problem.

### Cross-repository isolation, from disk

The two `SHARED-1` tasks each got their own worktree under their own repository
root, on a branch of the same name in two different object stores, at different
commits:

```text
alpha  .worktrees\SHARED-1   00fb88e [ao/task/SHARED-1]   return 'hello, world';
charlie.worktrees\SHARED-1   0f38960 [ao/task/SHARED-1]   return 'hello, charlie';
```

Reversing the order of the registry file did not move the binding: the selection
stayed `alpha-service/SHARED-1` and the listing stayed in canonical root order.
That is the case a tie-break test can pass on sort stability, so it was fed the
wrong order deliberately.

### The restart, at the boundary the contract names

The process was terminated with `taskkill /F` — no `/T` — while it was sleeping
between passes. The pre-kill observation is the part that makes it a restart
rather than a crash-recovery test: **all three repositories reported a free lease
and no lease file existed for any of them.**

Measured two seconds after the kill: nothing the run started survived it, and the
only `claude`/`codex` processes left were two that predate the dogfood by a day.
Four durable documents were hashed before the kill and after it — the three task
states and the attention item — and all four were byte-identical.

A second process was then started with the identical arguments, and:

```text
Durable wakes   : 1
    waits until     : 2026-09-02T18:42:12.423Z
    task            : WAIT-1
Scheduler       : WAITED
Waited          : 132460 ms of wall clock
```

It was told no task and no instant. It re-read the wake from the same durable
record, slept 132 seconds to it, and in the next cycle drove `WAIT-1` to
`READY_FOR_PR`. It did not repeat `alpha`'s finished work and it did not
duplicate `charlie`'s item.

**This is a restart between passes, where the invocation holds nothing.** A kill
*inside* a pass leaves a lease naming a dead pid, and `repositories` may not
recover it — see the residuals below.

## The ownership discriminator, isolated

`BLOCKED_USAGE_LIMIT` is the only state whose owner is a function of the record
and the clock rather than a constant (`core/task-attention.ts`,
`BY_QUOTA_READING`). Two records were parked in **one** repository, in **one**
state name, differing in **one** field. Both were admitted; the difference is
what the resume decision and the outbox then made of them:

| Task | `reportedResetAt` | Resume decision | Outbox |
| --- | --- | --- | --- |
| `WAIT-2` | `null` | `RESET_TIME_MISSING` | `QUOTA_CONTINUATION_REQUIRED`, reading `RESET_UNRECORDED` |
| `WAIT-3` | one hour ahead | `RESET_TIME_NOT_REACHED` | **nothing**, and it is the durable wake |

A pair differing only there is what makes the answer attributable to the
discriminator. Charlie's `BLOCKED_VERIFY` is a table lookup and could never have
proved this on its own.

## The operator loop, closed end to end

The operator then ran **the command the notification named**:

```text
agent-loop run --repository <bravo> --task WAIT-2 --attended --continue-usage-limit
```

`WAIT-2` departed the quota block and the loop escalated to
`HUMAN_DECISION_REQUIRED` — its review budget is one round, and the review had a
finding. The machine did not invent the decision; it recorded one and stopped.
That invocation ran in the foreground and was not redirected, so the bundle
carries a transcript of its console output rather than a captured log; its
outcome is corroborated by `bravo/WAIT-2.json` (`reviewRound: 1`) and by the
writer's commit on the bravo work branch.

The next scheduler pass then reported:

```text
Open         : 2
Raised now   : 1
Resolved     : 1
```

The old `QUOTA_CONTINUATION_REQUIRED` item was **removed** because its condition
was gone, a new `ESCALATED_DECISION_REQUIRED` item was raised for the new one,
and `charlie`'s item in the other repository was untouched.

## The notification, proven from outside this machine

The local report can only ever say `Delivery : DELIVERED`, and it renders the
**last** pass's push — so a run whose raise happened in cycle 1 prints
`NOTHING_TO_SEND` at the end and looks like a failure that is not one.

So delivery was measured at the other end. Polling the configured ntfy topic
returned the message, with a timestamp matching the attention record's
`observedAt` to the second:

```text
2026-09-02T18:36:16.000Z | charlie-service / SHARED-1 needs an operator
  reason: VERIFICATION_REMEDIATION_REQUIRED
  tags: warning   priority: 4
```

Two things that observation settles and nothing local could: an HTTPS request
really left this machine, and **no filesystem path is on the wire** — the durable
record carries `repositoryRoot`, the push carries the ids and a `<path>`
placeholder and nothing else.

Across the six cycles of one invocation and across two processes, that condition
was sent **once**. A second message for the same condition appears in the topic
later, and it is attributable: the outbox directory was deliberately deleted to
prove reconstruction, and an item whose name is free is by design a new item.

Note the whole mechanism is conditional on a flag: the outbox is scanned, settled
and pushed **only under `--wait-for-reset`** (`cli/repositories-command.ts:455-469`).
An invocation without it reads no notification configuration and touches no store.

## Failure injection

| Injection | Result |
| --- | --- |
| one registered repository renamed away | `Resolution : REFUSED`, `REPOSITORY_UNRESOLVABLE / REPOSITORY_NOT_FOUND`, entry index named, exit 2 — read-only **and** under `--attended`. No lease was taken anywhere, so no repository could execute with another's binding — **and no attention item was raised**, which is the measurement behind residual `L-M3-F-3` below |
| process interrupted | above |
| repeated observation | six cycles, two processes, one file per condition, `Raised now : 0` |
| condition resolved | `Resolved : 1`, and only that one |
| recovery against a live owner | `RECOVERY_UNSAFE / OWNER_RUNNING`, lease document byte-identical across the attempt |
| outbox deleted | a different process re-derived the same `attentionId` from state production wrote |

## Endings, and what "complete" may not be read from

With `--idle-poll-ms` given, `NO_FUTURE_WAKE` is unreachable: `BOUND_EXCEEDED`
also falls back to the idle poll, so the loop polls until the cycle budget is
spent and `Ending : CYCLE_BUDGET_SPENT` is the only normal ending. It **must not
be read as "the work finished"**.

A separate invocation without that flag reached the legitimate ending — but only
after the `WAIT-3` fixture was retired by hand, which is what emptied the wake
horizon:

```text
Durable wakes   : 0
Scheduler       : NO_FUTURE_WAKE
Ending          : NO_FUTURE_WAKE
```

**Every admission in that pass ended `AUTH_PREFLIGHT_FAILED`**, so nothing in it
could execute. The ending is a property of the durable wake scan, which runs
after the pass, and not of the work — which is exactly why it is quoted for the
ending and for nothing else.

Likewise, `outcome : COMPLETED` for `alpha` on cycles 2 to 6 is a **re-admission
that the terminal state refuses**, not six pieces of work: `L-M3-01-3` and
`L-M3-02-6` describe the cost, which is a real repository resolution, a real
lease acquisition and a real planning pass each time. The run above shows it is
not a cheap re-read: the same admissions came back `AUTH_PREFLIGHT_FAILED` when
the preflight stopped passing.

## Performance, measured and not optimised

| Measurement | Value |
| --- | --- |
| idle poll asked for 20 000 ms | slept 20 002 / 20 012 / 20 016 / 20 002 ms |
| the one durable wait | 132 460 ms against a reset that far away |
| read-only plan over three repositories | 1 981 / 2 025 / 2 043 ms |
| outbox after the whole run | 1 616 bytes, 2 files |
| owned-launch register, as left by the final pass | `open: 0`, `historyComplete: true` in all three |

The register is replaced by each lease epoch and is not a history of the whole
dogfood — `bravo` ran two writers and stands at `nextSlot: 1`. What it shows is
that no owned subprocess slot was left open.

Nothing here prevents the operating contract from functioning, so nothing here
was optimised.

## Why no production code changed

The completion rule for this slice permitted a code change only where a concrete
production execution path made the defined product wrong, unsafe or
unrecoverable. Three independent reviews and this run found no such path. Every
substantive finding was either an already-accepted residual behaving exactly as
recorded, a rendering artefact of the last pass, a defect in the dogfood's own
fixtures (fixed in the fixtures), or a defect in this record's own prose (fixed
here). Three capability gaps that no register named are added to the register by
this slice as `L-M3-F-1` to `L-M3-F-3`; none of them is reachable as a product
defect on the path this run drove, and each is a limit on fault tolerance rather
than on correctness.

**U1–U4 are untouched, and unattended operation stays unsupported.** The
interrupt landed between passes, where no lease is held, so U1's
pre-establishment window was not entered. U2 is *mitigated but not closed* by the
durable outbox, which is written whether or not an endpoint is configured and
survives the process. **U3 is untouched**: an above-runner refusal produces no
task state and therefore no outbox item, which this run measured directly when a
registered repository was renamed away. U4 is about `block` run ids and
`release`, neither of which this path uses. Changing the Status section's claim
would be a product-contract change resting on evidence this run does not
provide, so it is left exactly as it stands.
