# ADR — recording containment while the writer runs, so a crashed run can be recovered without an operator

- **Date:** 2026-08-30
- **Status:** accepted
- **Slice:** M2 slice 1
- **Supersedes nothing.** The M1 release verdict
  (`docs/decisions/2026-08-29-adr-m1-release-gate.md`) is unchanged: `PASS for
  attended use`, and unattended operation stays unsupported. **U1 is narrowed by
  this slice and is not resolved** - the window named under Consequences remains -
  and U2–U4 are untouched. This line said "U2–U4 remain unattended blockers",
  which by omission read as U1 being closed; it is not, and this ADR's own body
  says so.

## The problem, measured rather than described

M1 recorded four unattended blockers. `U1` is the first:

> an interrupted run leaves the lease, and no product command removes it.

That sentence was already narrower than it read. Since V3 slice 5 the product
*has* had a command — `agent-loop lease recover` — and that command has no
attendance gate: it takes `--repository` and nothing else, grants nothing and
starts nothing, and it exits `EXIT_RUN_OK` for a refusal - the comment above that
line in `src/cli/lease-command.ts` gives the reason as "a non-zero exit would
make the command unusable in the scripts that would ask it". (The command's
printed `--help` description says none of that; an earlier draft of this
paragraph attributed the sentence to it.) A scheduler could therefore already
recover *some* crashes.

What it could not recover is the crash that actually happens. The reproduction
is in this repository's history and was re-run for this slice, with real
processes against a disposable real repository: an owner took a real lease,
opened a writer generation, started a real target behind the native launch
boundary, and was terminated with `taskkill /F` on its own pid alone.

```text
before          : lease HELD, owner 10840 ALIVE, writer beating
interruption    : taskkill /PID 10840 /F      (no /T — nothing else is asked to die)
after           : owner NOT_FOUND, helper NOT_FOUND, child NOT_FOUND
                  writer heartbeat frozen     <- the tree really was gone
ledger          : generation 1, state PENDING
fresh acquire   : STALE_LEASE_RECOVERY_UNSAFE
lease recover   : RECOVERY_UNSAFE / LAUNCH_HISTORY_UNPROVEN
```

Two things in that transcript matter and neither was obvious from reading the
code.

**The containment held.** The writer tree died with its owner, measured by
heartbeat rather than by a process walk.

**And nothing could say so.** The launch ledger's `PENDING` entry is a strict
object of four fields — generation, state, writerId, openedAt — and names no
process at all. It is published *before* the launch, so a pid cannot be in it
even in principle. The kernel-witnessed facts that would have settled the
question — helper pid, child pid, confirmed job membership — existed the whole
time and were written down only *after* the run ended. An owner killed
mid-writer never reaches that write.

So the repository was left unrunnable by **every** product command, attended or
not. That is U1's real content, and it is the state a run spends most of its
wall-clock time in: a `claude` launch lasts minutes, and the two marks were
written before and after it.

## Decision

Add a third launch state, `ESTABLISHED`, written at the instant the kernel
confirms job membership — and let the
recovery predicate accept a history containing it **only** after re-establishing,
at the removal, that the processes those entries name are gone.

```text
lease acquired      → ledger published, historyComplete: true, no entries
before each launch  → generation N appended as PENDING, published
launch happens      → only after that publish is known to have landed
kernel confirms job → generation N replaced by ESTABLISHED, published   ← new
launch seen to end  → generation N replaced by CONTAINED, published
launch over, unproved → generation N withdrawn to PENDING, published   ← new
anything else       → generation N stays where it got to, for good
```

The withdrawal is the second half of the decision and is not optional: an
`ESTABLISHED` entry proves a recovery only while the launch it names is the last
thing that happened under the lease. See `R-M2-2` below for the sequence that
made it necessary and the phases that measure it.

The last row is what is attempted, and it can fail. Publishing the withdrawal
can be refused and so can its fallback — discarding the history — which leaves
the affirmative entry untouched on disk. The ledger has nothing left to try and
answers `LAUNCH_MUST_NOT_START`; what closes the hazard there is the *caller*,
which refuses to return the writer's result, so the step stops before the commit.
See `R-M2-4`.

### The predicate, stated exactly

```text
SAFE_TO_RECOVER
iff  a lease document is at this repository's lease path
and  the process it names does not exist
and  the launch history beside it is complete, bound to this exact lease,
     and about this exact owner and run
and  either every launch in it is proven contained and observed to end
     or   every launch in it was placed in the owner's job by the kernel, and
          every process the unended ones name — helper and child alike — is
          observed not to exist, now, by this call's own probe
```

The first arm is unchanged. The second is new, and it is deliberately not a
loosening of the first: `provesEveryLaunchContained` still admits exactly one
reading, and the new reading is admitted by a **separate** predicate whose
disjointness from the first is asserted by value. A caller cannot reach the
removal through the weaker reading without also paying the liveness proof,
because the two answers are not the same answer.

### Why the liveness re-check, and not inheritance

`ESTABLISHED` could have been treated as sufficient on its own by inheritance:
a helper dies when its owner does, so the job goes, so the tree goes. That
reasoning is rejected here, because its first step is a **measurement and not a
contract** — `boundary/start-owned-process.ts` says so in as many words, and the
native helper's source says the watcher "normally wins" while nothing enforces
it. A removal built on a step described that way is exactly what
`execution-lease.ts`'s header refuses.

So the arm asks instead, at the removal, with the real probe. A helper that is
gone has closed the only handle to a job created with `KILL_ON_JOB_CLOSE` and
neither breakaway flag, and the kernel has therefore destroyed everything inside
it, grandchildren included. That inference is a contract — it is what the job
flags *are* — and it does not pass through the owner at all.

**Process-id reuse pushes this one way only.** A recycled pid now belonging to an
unrelated process reads `ALIVE` and refuses; the reading that would be dangerous
is a live process whose pid reads `NOT_FOUND`, and that cannot happen, because a
running process's pid is by definition in use. The cost is an over-refusal that
clears itself; there is no direction in which reuse permits a removal.

## What was rejected

- **Treating a dead owner as sufficient.** Unchanged and still refused. The
  premise that a dead owner does not prove a dead writer is what this whole
  contract is built on, and this slice does not weaken it — it supplies the
  missing observation rather than assuming it away.
- **Widening the authority instead.** Letting `--automatic-resume-only` reach
  `recoverStaleLease` was considered first and is not needed: `agent-loop lease
  recover` already runs with no operator, and separating the recovery from the
  productive run gives the stronger proof. `mayRecoverStaleLease` is untouched,
  `unattended-resume.ts` still fixes `recoverStaleLease: false`, and the CLI still
  refuses `--recover-stale-lease` with `--automatic-resume-only`.
- **Confirming the generation early instead of adding a state.** Writing
  `CONTAINED` at establishment needs no format change and was measured to work —
  and it is wrong. Today's `CONTAINED` is written after `runOwnedCommand` has
  awaited the helper's close, so it implies the helper is already gone. Writing
  it while the writer runs would quietly weaken every existing recovery that
  rests on it.
- **A named Job Object, or process creation times.** Either would make the
  liveness question kernel-authoritative rather than pid-shaped. Both are native
  changes to the launch boundary, and neither is needed for a predicate whose
  only error direction is refusal. Named as the next prerequisite if the
  remaining window ever has to close.
- **Recording every owned launch, not just the writer.** The ledger describes the
  productive writer and nothing else. Widening it is a contract change the
  ledger's own header already names, it would put a ledger write before every
  `git` subprocess, and it is not what U1 asks for. Carried as a residual below.

## Consequences

- **U1 is narrowed, not closed.** The unprovable window shrinks from a writer's
  whole runtime to the interval between announcing a launch and the kernel
  confirming it, which was **observed once at 76 ms** on the reference machine,
  against launches that last minutes. One observation, not a bound: nothing in
  the repository measures it and no gate holds it, and a loaded machine will be
  slower. It is offered for the order of magnitude and for nothing else. An owner killed inside that window still leaves
  `LAUNCH_HISTORY_UNPROVEN`, and that case still needs a human. It is pinned as
  its own phase in the real-process gate rather than left as an implied gap.
- **Unattended use is still unsupported.** U2, U3 and U4 are untouched. This slice
  makes a crashed repository recoverable; it does not make an interrupted *task*
  continue, and it says nothing about whether anybody was told.
- **The ledger version is now 2.** A history written by a version-1 build reads
  `UNSUPPORTED_VERSION`, so a stale lease left by an older build is refused where
  it might once have been recovered. That is the conservative direction and the
  same rule `LAUNCH_HISTORY_ABSENT` already applies: no lease from an earlier
  build is retroactively safe.
- **Two new refusals**, `LAUNCH_TREE_STILL_RUNNING` and
  `LAUNCH_TREE_LIVENESS_UNDETERMINED`, each with its own operator sentence and
  each produced in the coverage table. They deliberately share **one** fixture,
  driven by two probes: what separates them is precisely the liveness answer, and
  two fixtures would let a defect that mixed the two look like two independent
  passes.
- **One existing operator sentence was false and is corrected.**
  `LAUNCH_HISTORY_UNPROVEN` told operators it was "what a run killed while its
  agent was working leaves behind". After this slice that run leaves
  `ESTABLISHED`, and the sentence now describes the window it actually names.

## Residuals, stated rather than discovered later

- **`R-M2-1` — the pre-establishment window.** Above. The next prerequisite for
  closing it is a kernel-authoritative identity for the launch (a named job, or
  pid + creation time), which is a change to the native boundary.
- **`R-M2-2` — the ledger describes the writer only.** **Closed by M2 slice 2**;
  see [that ADR](2026-08-30-adr-owned-subprocess-quiescence.md), which reproduced
  the sequence below on `main` at `fba4cfd` with the shipped CLI before closing
  it. What follows is the item as it stood. It was not a new one: it
  is the already-open `L-V3-05-1`, restated here because this slice was checked
  against it rather than around it. A verification command, the
  reviewer and `git` subprocesses go through the same owned boundary and are
  therefore contained in fact, and none of them is recorded, so no reading here
  is evidence about them. The hole is pre-existing and it is largest on the arm
  that already shipped: a crash *between* writer launches — during the
  verification command, say — leaves an all-`CONTAINED` history and has been
  recoverable since V3 slice 5 while an unrecorded subprocess may have been in
  flight. That is `L-V3-05-1` and this slice does not close it.

  **What this slice added to it, and then closed.** A first draft argued that the
  new arm could fire only while a writer was in flight, and that launches are
  sequential, so nothing else could be running. The second half is true and the
  first is not: an `ESTABLISHED` entry is not evidence that a writer is *now*
  running. It persists after the launch ends whenever the `CONTAINED` upgrade
  could not be published, and permanently when the ending could not be attested
  at all. A run that reached that state and then crashed later — mid-commit,
  mid-verification, mid-review — presented an `ESTABLISHED` history whose
  recorded pids were long gone, and the new arm recovered it. A review refused
  the slice on exactly that, and was right: before this slice such a writer left
  `PENDING` and the sequence was refused, so it was a widening the slice owned.

  It is closed by {@link retractWriterLaunchEstablishment}: a writer launch that
  ends without reaching `CONTAINED` has its establishment mark **withdrawn back
  to `PENDING`** before control returns to a step that can start anything — on
  the ordinary path by the code that consumes the withdrawal's answer, and on a
  throw by a `finally`, so no exit from the runner skips it. `PENDING` is not a
  conservative invention — it is the exact state
  this build left such a launch in before the mark existed — so the arm can no
  longer license a recovery the previous build refused. The lease is then
  unrecoverable for the same reason and to the same extent as before: no wider,
  and no narrower.

  Measured, not argued. `tests/dist-artifact/crash-recovery-dist-artifact.mjs`
  phase **F** builds the sequence with real processes — a real writer that ends
  unproved, a real later detached subprocess left alive, a real owner death — and
  requires a refusal. Phase **G** is its control: the identical fixture with the
  withdrawal switched off must *recover*, which reproduces the defect and stops F
  passing in a build that had merely broken the arm.

  What remains is the pre-existing `L-V3-05-1` hole on the `ALL_LAUNCHES_CONTAINED`
  arm, unchanged and not this slice's to close.

- **`R-M2-3` — ledger forgery is bounded exactly as before.** Anyone who can create
  a file in the Git common directory can write a history that reads as a proof.
  The format states this; the new state changes nothing about it, since write
  access to that directory already subsumes deleting the lease by hand.

- **`R-M2-4` — a withdrawal can fail twice, and then the entry stays.** The
  retraction has two writes: publish the entry back to `PENDING`, and — if that
  is refused — discard the whole history. Both can be refused at once; the state
  was reproduced with the ledger held open by another process (`rename` → `EPERM`,
  `unlink` → `EBUSY`), and it is what a read-only or vanished administrative
  directory does. The affirmative `ESTABLISHED` entry then remains, readable and
  bound to a live lease, and **nothing in this build can remove it** — the two
  writes that would have are the two that failed.

  What is closed is the *consequence*, not the state. `loop/leased-spawns.ts`
  consumes the withdrawal's answer and refuses to return the writer's result, so
  the step stops: no commit, no verification, no reviewer.

  The refusal is aimed at a stale mark bound to a **live** lease, and it is
  scoped to that. When the withdrawal reports that the lease at the path is not
  this run's, or that there is none, the mark it could not take back is
  unreadable to every future recovery — a recovery derives its subject from the
  lease document beside the ledger — and the run is already fenced by the same
  gate everywhere else. Refusing there as well was tried and measured wrong: it
  turned a quota block into `HUMAN_DECISION_REQUIRED` before the settlement
  could run, and `tests/v3-10-quota-checkpoint.test.ts` lost the assertion that
  proves the commit was attempted and refused. `LEASE_UNREADABLE` stays with the
  refusals, because there the lease may still be this run's. A first version of
  this slice discarded that answer and argued the next `beginWriterLaunch` would
  catch the broken directory; it would not, because nothing after a writer opens
  a generation. The sequence was reproduced through the production seam before
  it was fixed — the run got the ordinary writer result and
  `assessStaleLeaseRecovery` answered `SAFE_TO_RECOVER` — and both halves are
  pinned in `tests/v3-05-stale-lease-recovery.test.ts` and
  `tests/v2-07l-execution-lease.test.ts`, each with a positive control.

  The price is stated rather than left to be found in an incident, because it is
  higher than "a lost pass". The refusal is an `UNAVAILABLE` result, which
  `runClaudeWriter` diagnoses as `AGENT_PROCESS_UNAVAILABLE` and
  `recordAgentInterruption` parks at **`HUMAN_DECISION_REQUIRED`** — a durable
  move, `automaticResumeEligible: false`, and a state this loop does not drive.
  So the run stops until an operator continues it by hand, and the writer's edits
  stay uncommitted in the worktree. In a slice about *unattended* recovery that
  matters, and it is still the right trade: a stopped run is recoverable by a
  person, a lease removed from under a live commit is not recoverable at all.

  One case is sharper. A writer refused for quota still carries an attestation,
  so it can reach this refusal — and `endedUnderOwnControl` is asked above the
  usage-limit check, so a block that would have parked at `BLOCKED_USAGE_LIMIT`
  (the one state a timer may resume, and the one whose settlement commits the
  partial work) parks at `HUMAN_DECISION_REQUIRED` instead. Conservative and
  correct — nothing may be committed while the ledger cannot be written — and a
  self-clearing pause becomes a human-only stop.

  Three things are deliberately **not** claimed. If the run is killed before it
  can stop, the entry is still there and a later recovery may act on it — this
  build closes a continuation, not a crash window. If the agent runner *throws*,
  the withdrawal still happens in a `finally` but its answer cannot be returned;
  the throw is what stops the step, and no caller between the seam and the CLI
  swallows it today, which is a measurement of this build and not a guarantee
  about the next one. And the fail-closed value written before the withdrawal —
  which stops a throwing withdrawal being retried by that `finally` — is
  defensive code no case pins, because nothing available here can make
  `retractWriterLaunchEstablishment` throw. The operator's move for a lease left
  in this state is unchanged: the lease path is printed by
  `agent-loop lease status`.
