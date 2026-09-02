# Bounded cross-repository concurrency

**Date:** 2026-09-01 · **Status:** accepted, implemented by M2 slice 5.

M2 slice 3 gave the orchestrator a registry of repositories and a deterministic
ranking across them. M2 slice 4 gave a repository dependencies and priorities.
Neither made anything run: `agent-loop repositories` planned across every
enlisted repository and stopped at a printed report, and every command that acts
still bound itself to one `--repository` the operator named.

This slice makes the plan executable, for more than one repository at a time,
under a bound the operator writes down.

## The three sentences this slice is answerable for

> Different repositories may execute concurrently.
> The same repository must never receive overlapping owned task execution.
> Global concurrency must be bounded and deterministic.

Everything below is in service of those three, and nothing else is in scope.

## What was already true, and was measured rather than assumed

The ownership design turned out to be **already** per-repository almost
everywhere. This was checked surface by surface before anything was changed, and
the finding is worth writing down because it is what keeps this slice small:

- the **execution lease** is keyed on the normalised absolute Git *common
  directory* (`execution-lease.ts`'s `deriveExecutionLeaseLocation`), never on
  the process and never on `repository.id`. Two different repositories are two
  different lease files. Measured: two `acquireRepositoryExecutionLease` calls
  for two repositories in one process both answered `ACQUIRED`;
- **release** takes only opaque evidence and removes by nonce, so there is no
  parameter a caller could aim at another repository's lease;
- **stale recovery** derives its location from the repository it is handed and
  reads and removes at that key alone;
- the **writer fence** (`loop/leased-spawns.ts`) is a pure function of the
  `(repository, evidence)` pair and refuses a mismatched one as
  `LEASE_FOR_ANOTHER_REPOSITORY`;
- **containment** is per *launch*: each owned launch spawns its own helper, which
  creates its own Job Object and holds the only handle to it. Two repositories'
  launches share no kernel structure;
- **task state, worktrees, branches, block ledgers, delivery and verification
  evidence** are all already qualified by canonical repository root;
- `process.chdir` appears nowhere in `src/`, and `process.env` is never written.

So the lease model is **not** redesigned here, and this ADR does not propose to.

## The one thing that was not per-repository, and the measurement

`boundary/owned-launch-accounting.ts` keeps a process-wide array of installed
accountants, and `openOwnedLaunch()` announces **every** launch to **every** one
of them through an interface that carries no subject. An accountant is installed
by the lease acquisition itself and closes over its own `(repository, evidence)`
pair, so it writes whatever it is told about into *its* register.

That is fine while nothing holds two leases in one process — which the module's
own header states as the reason its registry is an array rather than a slot. This
slice makes it false, so it had to be measured rather than argued. On this branch
at `86028bd`, against the **built** artefact, with two real Git repositories and
one real owned subprocess started for repository A only:

```
Q1  two leases in ONE process
    A: ACQUIRED          key: …\repo-a\.git
    B: ACQUIRED          key: …\repo-b\.git

Q2  one owned subprocess started FOR REPOSITORY A only
    WHILE RUNNING  register A: open=1  helperPid 4148  childPid 18860
    WHILE RUNNING  register B: open=1  helperPid 4148  childPid 18860
```

Repository B's durable owned-launch register named repository A's helper and
child, with A's launch digest, in B's own Git directory. The register's headline
sentence — *"the durable set of AO-owned subprocesses that are open right now
**under one lease**"* — was false the moment the second lease existed.

Three consequences follow, and they are not of one severity:

1. **pollution** (certain). B's register names processes that are not B's. A
   crash recovery for B probes them and answers `OWNED_LAUNCH_STILL_RUNNING` for
   a repository that owns nothing of the kind;
2. **cross-repository refusal** (live). A refusal from *any* installed accountant
   refuses the launch for *all* of them, and `doctor/exec.ts` turns that into a
   command that never ran (`SPAWN_FAILED` / `LAUNCH_NOT_ACCOUNTED`). A transient
   share violation on B's lease file therefore kills A's next `git`, verification
   or agent subprocess mid-run — and a loaded gate with two repositories on it is
   exactly what makes that transient likely;
3. **destruction** (conditional). The announcement's discard fallback unlinks the
   launch document at *its own* location. A launch of A's, announced into B's
   accountant, can reach a discard of B's document — which holds B's writer
   history as well as its register — leaving B's lease unrecoverable.

## The decision

### 1. An owned launch has an execution domain, and it is ambient

The announcement gains a subject, and the subject travels the way the fact
already travels in this design: the boundary layer does not learn what a lease
is, and no runner signature is widened.

- `boundary/owned-launch-accounting.ts` gains an opaque `OwnedLaunchDomain`,
  minted by `createOwnedLaunchDomain()` and compared only by identity. Nothing in
  that module can say what a domain *is*, which is the property that keeps the
  lease out of it;
- `runInOwnedLaunchDomain(domain, fn)` establishes it for `fn` and everything
  `fn` awaits, through `AsyncLocalStorage`;
- `installOwnedLaunchAccountant(accountant, domain)` records the domain an
  accountant answers for. The parameter is **required**, so a caller that does
  not decide does not compile;
- `openOwnedLaunch()` announces a launch to exactly the accountants whose domain
  is *identical* to the ambient one. `null` is a domain like any other and
  matches `null`.

Threading an explicit accounting argument through `RunOptions` was rejected, and
not on taste: the module header already records the inventory that killed it —
most spawn sites running under a lease reach `runCommand` from code that holds no
evidence, so each of them would have had to declare itself unaccounted. That is a
documented hole rather than a closed one.

**Why exact identity rather than "no domain means everybody".** The fallback
looks safer and is not. A register's sentence is *"these launches belong to this
epoch"*, and a launch that belongs to no epoch belongs in no register. Announcing
an un-domained launch to every live epoch is precisely the pollution above,
reintroduced for the one case nobody would look at. The rule is total, it is one
identity comparison, and with no domain anywhere it is bit-for-bit today's
behaviour — which is what every pre-existing command gets, because none of them
establishes a domain.

**Where the lease reads it.** `acquireRepositoryExecutionLease` installs its
accountant with `currentOwnedLaunchDomain()` — the domain ambient at the moment
of acquisition. No lease call site changes: a lease taken inside a domain belongs
to it, and a lease taken outside every domain belongs to `null`, as all four
pre-existing acquisition sites do.

### 2. A coordinator, not a scheduler

`run/repository-coordinator.ts` is the whole of the new execution machinery. It
holds an active set, a capacity, and a deterministic admission rule. It is not
persistent, it has no queue, it has no timers and it polls nothing.

**Exclusion key.** The canonical Git common directory — the *lease's own key*,
compared with `comparePathIdentity`. Not the root and not `repository.id`. The
policy and the authority therefore agree by construction: a repository the
coordinator considers active is exactly a repository whose lease would refuse.

**Capacity.** `maxConcurrentRepositories` in the operator's `repositories.yaml`,
an integer in `1..8`, **defaulting to 1**. One is the safest existing behaviour
and stays the default; the ceiling is a bound rather than a policy, chosen so a
mistyped registry cannot decide how many writer agents one machine runs.

**Per-repository capacity is 1 and is not configurable.** That is the second of
the three sentences, and a knob for it would be a knob for breaking it.

**Admission.** Per pass: plan across every repository with the existing
`planAcrossRepositories`, then walk its merged ranking best-first and admit a
candidate when its repository is neither active nor already admitted this pass,
and when that `(repository, task)` pair has not been attempted in this run. Stop
at capacity.

No new priority semantics: the ranking is the one slice 3 published and slice 4
refined, consumed in the order it was published. Within a repository nothing is
reinterpreted — the first entry the merged ranking holds for a repository *is*
that repository's own top choice.

**The top-ranked repository does not stall the others.** When the best candidate
belongs to an active repository, the walk continues to the next entry. This is
not a fairness policy and not a departure from priority: priority orders the work
*inside* a repository, and the cross-repository ranking has always said in so
many words that no repository outranks another. Skipping a repository that cannot
accept work is the only reading of that sentence which lets a second repository
exist at all.

**Completion.** A repository becomes admissible again when its `driveLifecycle`
promise settles — resolved or rejected. That is strictly after the lease has been
given back, and after `runCommand`'s own `finally` has closed every owned launch
of the epoch. The slot is never released at launch, and never on a path that
skips the lifecycle's release.

**Termination is proved, not bounded by a guess.** Each `(repository, task)` pair
is admitted at most once per coordinator run, and the candidate set is finite, so
the loop ends. `MAX_COORDINATOR_ADMISSIONS` is a floor under that argument rather
than the argument.

### 3. The command

`agent-loop repositories --attended`, mirroring `run` exactly: without the grant
the command is the read-only report it has always been, and the grant is the
second way to ask for execution rather than a change to the first.

It carries `--max-steps` and `--max-invocations` with `run`'s own vocabulary and
refusals, and it carries **none** of the destructive grants —
`--recover-stale-lease`, `--remediate-verify-failure`, `--continue-human-decision`
stay bound to a repository an operator named on the command line. That rule is
the one `repositories-command.ts` wrote down when it refused to reach `run` at
all, and this slice narrows it rather than dropping it: a selector may now choose
what *starts*, and still may not choose the subject of a destructive act.

## What this slice deliberately does not do

No persistent scheduler, daemon, recurring job or cron semantics. No restart-safe
external waits and no persisted queue. No notifications. No reviewer or API quota
resilience, no backoff, no provider health scoring and no concurrency that adapts
to a rate limit. No cross-machine orchestration, distributed lock or worker pool.
No general CPU or memory scheduling, no weighted queues and no resource classes.
No merge automation. No change to dependency or priority semantics.
`READY_FOR_PR` remains terminal.

## The costs this buys, stated rather than discovered later

- **the shared subscription window.** Two concurrent repositories mean two writer
  agents and two reviewers against one operator's quota. Quota resilience is a
  later M2 slice, and until it lands, capacity above 1 spends a shared budget
  faster. The default of 1 is what keeps that a choice;
- **fixed wall-clock budgets.** The 20-second default for `git` and owned
  commands, and the 30-minute budgets for agents and verification, were
  calibrated for one repository per machine. They are unchanged here;
- **the lease module is synchronous by contract**, and its publish retry spins
  for up to ~8 ms. Under two epochs that is a stall for the sibling. The safety
  argument is untouched — nothing can interleave with a synchronous sequence —
  and the cost is latency, measured rather than assumed in the slice report.
