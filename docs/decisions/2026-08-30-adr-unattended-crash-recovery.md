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
anything else       → generation N stays where it got to, for good
```

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
- **`R-M2-2` — the ledger describes the writer only.** This is not a new item: it
  is the already-open `L-V3-05-1`, restated here because this slice was checked
  against it rather than around it. A verification command, the
  reviewer and `git` subprocesses go through the same owned boundary and are
  therefore contained in fact, and none of them is recorded, so no reading here
  is evidence about them. The hole is pre-existing and it is largest on the arm
  that already shipped: a crash *between* writer launches — during the
  verification command, say — leaves an all-`CONTAINED` history and has been
  recoverable since V3 slice 5 while an unrecorded subprocess may have been in
  flight.

  **This slice adds one further, narrow route to it, and the first draft of this
  paragraph denied that on a false premise.** It argued that the new arm can fire
  only while a writer launch is in flight, and that launches are sequential
  (which they are — there is no `Promise.all` or `Promise.race` anywhere under
  `src/loop`, `src/run` or `src/block`), so nothing else of that epoch could be
  running. The second half is true and the first is not: an `ESTABLISHED` entry
  is not evidence that a writer is *now* running. It persists after the launch
  ends whenever the `CONTAINED` upgrade could not be published, and permanently
  when the ending could not be attested at all. A run that reached that state and
  then crashed later — possibly mid-verification — presents an `ESTABLISHED`
  history, and the new arm may recover it where the old build would have refused
  `LAUNCH_UNPROVEN`.

  It is narrow: it needs a failed or unattested ending *and* a later crash. It is
  not a new class, and it does not change what the ledger claims. It is recorded
  here because an adversarial review had to find it, which means the argument was
  doing work the code was not.
- **`R-M2-3` — ledger forgery is bounded exactly as before.** Anyone who can create
  a file in the Git common directory can write a history that reads as a proof.
  The format states this; the new state changes nothing about it, since write
  access to that directory already subsumes deleting the lease by hand.
