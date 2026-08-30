# ADR — a stale lease is removed only when every owned subprocess of its epoch is accounted for

*M2 slice 2. Supersedes nothing; narrows `R-M2-2` / `L-V3-05-1` to closed, and
leaves `R-M2-1` exactly where it was.*

## The defect, as measured rather than as argued

On `main` at `fba4cfd`, with real processes and the shipped artefact:

```text
resolveRepository -> acquireRepositoryExecutionLease
  -> beginWriterLaunch -> a real launch through the real native boundary
  -> attestWriterLaunchEstablished -> the writer ends -> confirmWriterLaunch
     => the launch history reads ALL_LAUNCHES_CONTAINED
  -> runVerificationCommand(node, [beater.mjs], root)
     the PRODUCTION verification path: verify/verify-command.ts
     -> doctor/exec.ts -> boundary/owned-command.ts -> the boundary
  -> that subprocess confirmed ALIVE by heartbeat
  -> taskkill /PID <owner> /F        (no /T)
```

measured:

```text
assessStaleLeaseRecovery   verdict SAFE_TO_RECOVER, refusal null
agent-loop lease recover   RECOVERED — the lease file was deleted
```

The removal was licensed having probed **one** process, the owner. Nothing in
the predicate named the verification subprocess and nothing ever could: the
writer-launch ledger records `claude` and nothing else, which its own header
already said in so many words.

### The subprocess had in fact already died, and that is why this is a defect

Three rounds, sampling every 4 ms for six seconds after the kill, with liveness
at each instant established **backwards** from a later heartbeat advance: the
owned tree was gone at the first sample, 44–69 ms in. There is no window on this
host in which the recovery observes a live owned subprocess.

Two AO-owned couplings do that, and one inherited one:

- `native/ao-launch/AoLaunch.cs` `WatchOwner` waits on the owner's handle and
  calls `TerminateJobObject` when it signals;
- the job carries `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` and its only handle is the
  helper's — non-inheritable, verified from the handle rather than from the
  intent — so a helper that is gone took its job and everything in it;
- node puts every child it spawns into libuv's own kill-on-close job, which is
  not AO's and which AO does not claim.

**None of the three is consulted by the predicate.** That is the defect, and it
is a defect and not a wording bug because this build *refuses that exact
inference everywhere else*. For a writer launch that was established and never
seen to end, the predicate re-probes `helperPid` and `childPid` inside the call
that removes — "rather than inheriting that measurement" — and phase B of the
crash-recovery gate exists to prove that re-probe can tell a live process from a
dead one. Every non-writer class was getting the inference for free, silently.

`boundary/owned-command.ts` names the case where the inference is false, in its
own words, about `BOUNDARY_LOST`: *"the boundary stopped being accountable for
the tree. That is precisely the case where 'the owner's death took the writer
with it' stops being true."* A verification or reviewer run that ends that way
wrote nothing, anywhere.

## The decision

**A second durable record beside the writer history, in the same document: the
owned-launch register.** It holds the AO-owned subprocesses that are **open right
now** under one lease, and the recovery predicate gains a further conjunct over
it, after the ones it already had.

```text
lease acquired      → register published empty, historyComplete: true
before each launch  → a slot appended as ANNOUNCED, published
launch happens      → only after that publish is known to have landed
kernel confirms job → the slot replaced by ESTABLISHED, published
launch seen to end  → the slot REMOVED, published
anything else       → the slot stays where it got to, for good
```

### Why a register and not more of the ledger

The writer ledger is append-only and that works because a writer launches a
handful of times under one lease. Every productive owned spawn is accounted here
— the commit's `git add`, every `rev-parse`, every verification phase, the
reviewer — which is tens of launches per step, and a publish rewrites the whole
document. Append-only would be quadratic in bytes written and would reach
`MAX_WRITER_LAUNCH_ENTRIES` in a long run.

Removal is affordable because the question this record answers is not *what
happened* but *what is still open*.

### The leftover is a refusal, which is the whole of why it is cheap

The ledger's hazard is a **stale affirmative** entry: a mark left standing by a
launch that is over reads as a proof and is a lie, which is why
`loop/leased-spawns.ts` carries a withdrawal, consumes its answer, and stops the
run when it cannot take the mark back.

Nothing of that shape is needed here. An entry that could not be removed is a
**stale refusal**: the predicate probes the processes it names, permits only if
they are gone, and over-refuses if they cannot be probed. There is no leftover in
this format that permits anything, so a failed settlement costs this lease
nothing and never stops a run.

The *announcement* is the other way round and is guarded the way
`beginWriterLaunch` guards its own: the write comes first, its one fallback is to
discard the whole document — which asserts nothing — and only when even that is
impossible does the launch lose (`LAUNCH_MUST_NOT_START`, surfaced as
`CommandFailureCode.LAUNCH_NOT_ACCOUNTED`).

### Slots are minted, never positional

The ledger checks generations positionally, `1..N`, so a deleted entry is
`MALFORMED` before the binding is consulted. Entries here are removed in the
ordinary course of business, so that check cannot exist and is paid for by a
`nextSlot` counter that only increases. Without it a settled slot could be handed
out again, and a settlement for the *old* launch arriving after the new one was
announced would remove a live launch's record — the one edit in this format that
turns a refusal into a permission. Both `open` and `nextSlot` are covered by the
binding digest.

## Where the accounting is emitted, and why there

`src/doctor/exec.ts`'s `runCommand`, and nowhere else.

It is the single execution abstraction, and that is structure rather than
convention: `tests/v2-07l-execution-lease.test.ts` already pins that exactly two
modules import `node:child_process`, that the launch boundary has exactly one
route into the product and it is this one, and that exactly one module imports
each link of the chain. A seam anywhere above it is a seam some caller can be
written around — which is how the verification command, the reviewer and every
Git subprocess came to be invisible in the first place.

### The alternative that was rejected, and the measurement that rejected it

A required accounting argument on `RunOptions`, so that every call site must
declare. It is compile-visible, which is the property to want, and it does not
work here. An inventory of this build's spawn sites found that most of the ones
running under a lease reach `runCommand` from code that holds no lease evidence — `loop/loop-step.ts:276`, `run/run-driver.ts:739`,
`run/start-task.ts:558`, `block/block-runner.ts:815`,
`cli/release-command.ts:186`, `cli/delivery-steps.ts:1488`, and the read-only
probes. Every one of those would have declared itself unaccounted: a hole by
declaration, which is a documented hole rather than a closed one.

So the fact travels the other way. `boundary/owned-launch-accounting.ts` is a
registry with no lease in it: the boundary layer *announces*, and whoever holds
an epoch *subscribes*. `acquireRepositoryExecutionLease` installs the
subscription and `releaseRepositoryExecutionLease` disposes of it, so an install
a caller could forget does not exist.

### Closing a record is a claim, so it is not made on every path

Closing says *this launch ended*, and a recovery reads that as "nothing of it can
still be running". `endingWasAccountedFor` closes on exactly two answers —
nothing was started, or the boundary attested the ending — and leaves the record
**open** for every `BOUNDARY_LOST`, for the `LAUNCH_REFUSED` that follows a throw
out of the boundary's start call (whose `targetStarted` is deliberately
`UNKNOWN`), and for every POSIX run, which has no boundary and nothing to attest.
A blanket close would have deleted the record of exactly the launch that can
outlive its owner.

## The predicate, restated

```text
SAFE_TO_RECOVER
iff  a lease document is at this repository's lease path
and  the process it names does not exist
and  the launch history beside it is complete, bound to this exact lease,
     and every writer launch in it is CONTAINED — or every one is ESTABLISHED
     and the processes those entries name are all gone, re-probed here
and  the owned-launch register in the same document has no open slot — or every
     open slot is ESTABLISHED and the processes those slots name are all gone,
     re-probed here                                                      ← new
```

The new conjunct is **last**, and the order is the contract. `LAUNCH_HISTORY_ABSENT`,
`LAUNCH_HISTORY_UNPROVEN` and the rest are what an operator is shown for a lease
from an older build, for a launch killed before the kernel answered, and for a
writer whose mark was withdrawn. A conjunct placed above them would answer for
all three and make those gates vacuous — which is the difference between adding a
proof and replacing one.

Three new refusals: `OWNED_LAUNCH_UNPROVEN`, `OWNED_LAUNCH_STILL_RUNNING`,
`OWNED_LAUNCH_LIVENESS_UNDETERMINED`. Pid reuse pushes the middle one exactly the
way it pushes its writer twin: a recycled pid reads `ALIVE` and over-refuses,
which is the only kind of error the comparison can make.

## The version bump, and what it costs

`WRITER_LAUNCH_LEDGER_VERSION` goes from 2 to 3. A document written by a
version-2 build carries no register, so it cannot say whether an owned subprocess
of that epoch was open, and a lease left behind by that build now reads
`UNSUPPORTED_VERSION` rather than being read as though it had answered. There is
deliberately no arm that treats a missing register as an empty one. That is the
conservative direction and the same rule `LAUNCH_HISTORY_ABSENT` already applies.

## What is measured, and where

- `tests/m2-02-owned-launch-quiescence.test.ts` — the format, the lifecycle, the
  seam and the refusal in process.
- `tests/dist-artifact/crash-recovery-dist-artifact.mjs`, phases **H**, **I** and
  **J**, against the shipped artefact with real processes:
  - **H** the counterexample: the writer history is a proof, an owned launch is
    recorded through the production functions over processes that are really
    running, the owner dies, and the recovery must refuse
    `OWNED_LAUNCH_STILL_RUNNING` and leave the lease byte-identical — then the
    *same* lease must become recoverable once those processes are killed, which
    is what makes the refusal attributable to liveness;
  - **I** the wiring proof, and the case that dies if the accounting stops being
    emitted: a real owned subprocess started by `runVerificationCommand` with no
    accounting argument of any kind, and the register on disk must name its helper
    and child while it runs;
  - **J** the other half of the lifecycle: the verification is asked to stop, its
    ending is observed while the owner is alive, and the register must be empty
    afterwards with the slot counter not gone back.

### Counter-proof

Nineteen mutants, run against `tests/m2-02-owned-launch-quiescence.test.ts` and
`tests/v3-05-stale-lease-recovery.test.ts`, with a **green baseline** and one
known-surviving control (a comment-only edit, which survived as required):
accounting removed; accounting made opt-in; establishment dropped; settlement
removed; always-close; liveness ignored; only the helper probed; a permissive
`OWNED_LAUNCH_UNPROVEN`; a permissive `REGISTER_NOT_READABLE`; the conjunct
skipped; a foreign register accepted; slot reuse; the positive arm disabled;
`ANNOUNCED` no longer dominating; the binding dropping the register; the slot
rules dropped; a writer launch wiping the register; the accountant never
installed.

Two survived the in-process suite and neither is a pass:

- **establishment dropped** — killed by the dist gate instead, phase I, twelve
  failures. Measured rather than argued: the mutant was applied to a real tree,
  built, and the gate run.
- **only the helper probed** — a genuine gap. Every fixture made the two
  recorded pids alive or dead together, so neither alone was ever the reason for
  a refusal. The case that closes it is in the file with a comment saying why it
  exists, and the mutant is killed after it.

**H's processes are detached, and that is stated rather than hidden.** An owned
subprocess started through the real boundary cannot be made to outlive its owner
— see the measurement above — so a live survivor has to be arranged the way phase
B already arranges one for the writer. What is real is everything the predicate
touches: the record is minted and written by the production functions, and the
processes it names are real processes.

## Phases F and G are unchanged, and still discriminate

Their "later owned subprocess" was never owned: it is a plain detached spawn
inside the owner script. It therefore goes through no owned boundary, appears in
no register, and phase G still **recovers** — which is what makes it F's control.
The `package.json` description said "owned" and now says what it is.

## Residuals

- **`R-M2-1` — the pre-establishment window.** Untouched. Still the next
  prerequisite for closing `U1`, and still needs a kernel-authoritative identity
  for the launch.
- **`R-M2-2` / `L-V3-05-1` — closed.** Every AO-owned productive spawn under a
  lease now passes one accounting seam, and a future one cannot avoid it without
  breaking a structural pin that already exists.
- **`R-M2-2b` — the unleased forge surface, stated rather than closed.** Nothing
  under `src/deliver/` acquires an execution lease, so `git push
  --force-with-lease` and the two `gh` mutations run with no epoch held. They are
  announced like every other launch and the announcement reaches nobody, which is
  a different sentence from "they are excluded" and is the true one.
- **`R-M2-2c` — an attestation replayed across a *settled* slot is not
  detectable.** The guard is complete over the open set and cannot be complete
  over a settled one, because a settled slot leaves nothing to compare against.
  Not reachable from production, where one slot and one attestation live in one
  closure; the same bound the binding digest has.
- **POSIX.** A run there has no boundary, no job and nothing to attest, so no
  ending is ever accounted for and slots accumulate until the register is
  discarded — after which the lease is honestly unrecoverable. The shipped CLI
  refuses to run anywhere but `win32`, so no product path reaches it.

**`U1` is narrowed, not resolved**, and this slice does not change that: `R-M2-1`
remains open, and the milestone contract that `U1` needs both is unchanged.
