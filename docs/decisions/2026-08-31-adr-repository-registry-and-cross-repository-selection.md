# ADR — the orchestrator reasons over a registry of repositories, and selects across them

*M2 slice 3. Supersedes nothing. It **amends one non-goal** —
`2026-08-26-adr-delivery-task-selection.md` §11, which lists "no cross-project
or cross-repository selection, no repository selection" — and takes up the third
of the three candidates `2026-08-29-adr-m1-release-gate.md` §9 named for a next
decision, "A second repository".*

## Why this needs a decision at all

Six ADRs list cross-repository selection as a non-goal. Every one of them is a
*slice's* non-goal list — what that slice did not build — rather than a standing
prohibition, and reading them as prohibitions would freeze the roadmap: no slice
could ever build what an earlier one declined to. But the repetition is
deliberate, and the M1 release gate says why it is worth a decision of its own:

> **A second repository.** Every measurement in this record was taken in the
> repository that contains the product. That is the strongest available proof of
> the chain and the weakest available proof of generality.

So this is not a delivery-infrastructure commit. It changes what the product is
able to reason about, and `CLAUDE.md` requires that to be its own decision.

## The limitation, as measured rather than as argued

On `main` at `d3345a4`, against two real Git repositories built for the purpose —
`alpha` with a task source at `tasks/`, `beta` with one at `ops/work-items/`,
each declaring a task called `shared-id`:

```text
resolve A -> alpha @ …\ao-pre-3RPl53
resolve B -> beta  @ …\ao-pre-aIrz5i
planNextTask(A)  TASK_SELECTED -> shared-id   ranking ["shared-id","a-only"]
planNextTask(B)  TASK_SELECTED -> shared-id   ranking ["shared-id","b-only"]

planNextTask arity              : 1
A.selected.id === B.selected.id : true
A root !== B root               : true

keys of a selection outcome : code, selected, eligibility, ranking
keys of a task definition   : id, title, status, kind, priority, currentFocus, dependsOn
```

Three facts, and the third is the one that matters:

1. `planNextTask` is a function of **one** repository, and no production value
   anywhere in `src/` holds more than one `ResolvedRepository`;
2. two repositories can nominate tasks with the same id, and do;
3. **neither the selection outcome nor the task definition carries the
   repository it came from.** The two selected values are `toStrictEqual` to
   each other. The binding that keeps work in the right repository today is
   entirely the caller still holding the `ResolvedRepository` it passed in.

That third fact is why this is a *selection* problem and not a configuration
one. An orchestrator handed both plans has no value in which the answer can be
written down.

## The decision

### There is one registry, it is the operator's, and it declares only *where*

    <OS user profile>/.agent-orchestrator/repositories.yaml

    schemaVersion: 1
    repositories:
      - path: D:\Some\Repo
      - path: D:\Other\Repo

The location, the byte ceiling before parsing, the safe-YAML boundary, the
`.strict()` schema, the literal `schemaVersion`, the closed refusal set carrying
nothing from the file it refused, and the digest over the exact bytes are all
`delivery-automation.ts`'s, unchanged. That module established the shape for a
machine-wide operator declaration and the reason applies here with more force: a
repository that could enlist itself — or another repository — by committing a
file would nominate work for an orchestrator nobody pointed at it.

An entry declares a path and nothing else. **Identity is read from each
repository's own committed profile**, by `resolveRepository`, which is the one
module whose job that is. A registry that also named repositories would be a
second source of truth for the name, and a durable `TaskState.repositoryId`
would then point at whichever of the two wrote it.

### Ambiguity is refused on facts a repository cannot rewrite

Two accepted entries may not be the same canonical **root**, and may not share a
**`gitCommonDir`**. Both are established by `realpathSync.native` inside the
resolver.

`DUPLICATE_REPOSITORY_ROOT` is the authoritative duplicate check.
`REGISTRY_DUPLICATE_PATH`, which compares the declared strings before
resolution, is kept as a cheap refusal of an obviously self-contradictory
document and is explicitly **not** the guarantee: `D:\Repo`, `d:\repo\` and a
junction to either are four spellings of one directory and only canonicalisation
settles them.

`DUPLICATE_EXECUTION_DOMAIN` is not implied by it. Two Git worktrees of one
clone are two canonical roots and one execution domain; they contend for one
lease, and `deriveTaskWorkspaceIdentity` gives a task of the same id in both the
same work branch `ao/task/<id>` in one object store. Reached and measured:

```text
host      alpha | …\ao-dom-kitwZk        | …\ao-dom-kitwZk\.git
worktree  beta  | …\ao-wt-jKw9ea\second  | …\ao-dom-kitwZk\.git
same gitCommonDir? true    different repository.id? true
REGISTRY VERDICT: DUPLICATE_EXECUTION_DOMAIN
```

### Two entries MAY declare the same `repository.id`

The first form of this decision refused that pair, to make the ranking tie-break
total. It was wrong three times over, and the third is decisive:

1. two clones of one remote answering the same id is the configuration
   `resolve-repository.ts`, `declared-identity.ts` and `lease-document.ts` each
   document as **supported and independent** — the lease keys on `gitCommonDir`,
   state files are per root, workspaces derive from the root. Nothing structural
   breaks;
2. this repository's own working practice is a scratch clone of itself, so the
   refusal would have fired on the first pair anyone registered;
3. **`repository.id` is read from a profile inside a repository this
   orchestrator writes to.** Making the global ordering depend on it would let
   one driven repository decide which repository is selected — and, under a
   whole-registry refusal, stop every other one — by committing an edit to its
   own file. An ordering a subject of the ordering can rewrite is not an
   ordering.

The remedy the refusal would have forced is also destructive: the only way to
register both clones would be to edit one `repository.id`, and that field is
what `block-store.ts` holds durable ledgers to on load, what
`automatic-resume.ts` gates a resume on, and what `reconcile.ts` compares. The
edit orphans the records.

So the id stays a declared label, carried for display and for the records that
already hold it.

### It does not live in `src/repo/`

It did, for one round, and a structural pin caught it: `tests/repo-resolution.test.ts`
sweeps `src/repo/` and refuses any module there that imports `config/paths.js`, because

> a resolver that consulted it would be deriving a target repository's contract
> from the orchestrator's own checkout, which is the exact coupling V1-01 exists
> to prevent.

The registry does import it — `orchestratorHome` — and is not a resolver, so the
letter of the pin caught something its reason does not describe. It was moved to
`src/registry/` rather than exempted. `src/repo/` is the layer that answers *what
is this one repository*, from that repository's own committed files and nothing
else; a module reading a machine-wide operator document does not belong in it
whatever the pin says, and an exemption would have been the first line of a
second rule about where a repository's contract may come from.

### The ranking tuple gains one element, and it goes last

`select-task.ts` ranks by `(kind, currentFocus, priority, -unlockCount, id)` and
argues its totality from the last element: *"the task id, which is unique, so
the order is total"*. Across repositories that argument does not hold. The tuple
becomes

    (kind, currentFocus, priority, -unlockCount, taskId, repositoryRoot)

built by **calling** `taskRankingKey` rather than restating its five elements, so
the two cannot drift.

Last, after the task id, and that placement is the decision:

- within one repository the sixth element is constant, so the answer is
  bit-for-bit what `selectNextTask` gives today. The test asserts that against
  `selectNextTask` itself rather than against a remembered list;
- across repositories no task's rank relative to another changes. The new
  element decides only the case the old contract had no answer for;
- putting the repository anywhere before the task id would state that one
  repository's work outranks another's. That is weighted scheduling, it is not
  in this slice, and a comparator is the quiet way to ship it.

Totality is not a property of the comparator. It is
`DUPLICATE_REPOSITORY_ROOT`: because no two enlisted repositories are the same
canonical root, no two candidates tie on all six elements.

### One unusable repository refuses the whole plan

`REPOSITORY_UNPLANNABLE` selects nothing and publishes nothing — not the
ranking, and not the plans of the repositories that succeeded. The winner of a
ranking is only *the* winner if the candidate set is complete; announcing one
computed over whichever repositories happened to read cleanly would turn a
configuration mistake into a scheduling decision, silently. `discoverTasks`
already takes this reading one level down, where an empty task source is
`TASK_SOURCE_EMPTY` and not "all tasks complete".

Whether a scheduler should later proceed without a broken repository is a policy
question with its own consequences. It is not answered here by defaulting.

An empty registry is three different things, and they stay three. No file is
`NOT_REGISTERED` — this build has not been told which repositories it may
orchestrate. A file declaring `repositories: []` reads cleanly and yields zero
entries; the *reader* reports what the file said, and the *planner* answers
`NO_REPOSITORIES_REGISTERED`. Neither is `ALL_TASKS_COMPLETE`, and neither exits
0: an operator who has enlisted nothing has a configuration to finish, which is
the reading `discoverTasks` already takes of an empty task source. Keeping the
policy in the planner rather than in the reader is what lets the reader stay a
description of the document.

### The surface is read-only, and that is a boundary rather than an omission

The slice ships one command, `agent-loop repositories`. It reads the registry,
resolves each repository, plans each, and prints. It takes no `--repository`,
because its subject is the registry.

It does **not** reach `run`. `run-command.ts` is not modified, and every grant
there still binds to a repository the operator named on the command line. That
is deliberate and it is load-bearing: `--recover-stale-lease` is the one
destructive grant on `run` that does not require `--task`, precisely because
`--repository` has always named its subject. A selector choosing the subject of
an irreversible lease removal would break the rule that file already states
twice in its own words —

> *"letting the selector choose which one to continue would make the operator
> authorise a task they never named."*

— on a different axis and with a larger blast radius. Wiring selection into
execution is a separate decision, and it has to carry that clause.

### The invariant this slice keeps by taking no lease

`owned-launch-accounting.ts` justifies its shape on a sentence that is now this
slice's to keep true:

> *"nothing in this build holds two leases in one process"*

`openOwnedLaunch()` takes no arguments and broadcasts to a process-global array,
and it is structurally forbidden from knowing what a lease is. So if an epoch
ever overlapped a second repository's work in one process, that repository's Git
children would be announced into the first's register — and a share violation on
the first's lease file would refuse *every* one of them, naming neither the
repository nor the reason.

This slice keeps the sentence true the only way available to it: **registry
resolution and cross-repository selection run while no execution lease is held,
and this slice takes none.** A structural test asserts that the four modules
name no lease acquisition, no accountant installation and no stale-lease
recovery. A later slice that holds a lease across a re-resolution has to make
that argument again, and this is the sentence it will have to answer.

## What is measured, and where

`tests/m2-03-cross-repository-selection.test.ts`, against real Git repositories
throughout, and a real registry document under a scratch OS-profile directory
reached through the internal `PathProvider` seam.

The four scenarios, and one preservation claim:

| | |
| --- | --- |
| two repositories seen through one path | both planned, both in the ranking |
| the same task id in two repositories | two candidates, distinguished by root |
| determinism | reversing the registry file order gives an identical answer |
| repository binding | the selected candidate's `repository` is `toStrictEqual` the one `resolveRepository` returns for that path, and is not `process.cwd()` |
| **preservation** | with one repository enlisted, the merged ranking equals `selectNextTask`'s own ranking element for element |

Plus, through the registered `agent-loop repositories` command surface — the
Commander action, its `try`/`catch` and its `process.exitCode`, reached the way
an operator reaches it — on two real fixture repositories: a report naming both,
the winner named in its own `Selected` block, its root, and exit code 0. Its
three refusal branches are driven too, each to exit code 2: an unreadable
document, an entry that does not resolve, and a readable registry enlisting
nothing. And the sixth element is shown to be load-bearing by making every
earlier element tie.

No test enlists **this** repository. `actions/checkout` fetches one commit and
leaves a detached HEAD, so `refs/heads/main` — the default branch this
repository's own profile declares — does not exist on CI, and a test enlisting
it would be green here and red there. That measurement is made instead as a
recorded manual run of the shipped CLI against a scratch registry naming this
repository and one fixture; the evidence is in the slice report, not in the
suite.

## Residuals

- **`R-M2-3-1` — a settled head is still the head.** `ACCEPTED_RESIDUAL`.
  Eligibility is decided from the task file's `status` and nothing writes a task
  file, so a task whose durable record is terminal stays the ranking head.
  Measured on this repository: all eleven task files say `status: OPEN` while
  all eleven runtime records are terminal or parked, and `M1-RELEASE-009` —
  `REMEDIATION`, `HIGH`, focused — is the minimum in all four numeric positions.
  Registered beside any second repository it is the merged head on every run.
  This is not new: the single-repository path selects it today and reports
  `TASK_COMPLETED`. What the registry changes is that one report now covers
  several repositories, and the report answers it — the full ranking and every
  repository's own first choice are published, so nothing is hidden. Fixing it
  means skipping a head whose durable record has settled, which reads durable
  state inside selection (`select-task.ts` refuses that in its header) and
  amends `run-driver.ts`'s one-task-per-call refusal. That is a scheduling
  decision and belongs to the slice that makes one.
- **`R-M2-3-2` — a transient resolution failure refuses every repository.**
  `ACCEPTED_RESIDUAL`. `resolveRepository` runs several Git children and reads a
  profile, so a `git pull` in one enlisted repository can make it briefly
  unresolvable, and the whole-registry refusal then covers the others. Failing
  closed is the right default for a gate, the operator re-runs, and nothing
  durable is wrong. A retry or degraded-operation policy belongs to the
  scheduler slice.
- **`R-M2-3-3` — `unlockCount` is compared across plans.** `ACCEPTED_RESIDUAL`.
  Five-unlocked in a six-task plan and five-unlocked in a five-hundred-task plan
  are not the same quantity. Preserving the element is the choice that keeps the
  merged ranking agreeing with the per-repository one; normalising it would be
  scheduling policy.
- **`R-M2-3-4` — nested enlisted roots.** `BACKLOG`. `D:\Mono` and
  `D:\Mono\vendor\lib` pass every duplicate check, and the inner repository's
  derived `…\lib.worktrees` parent lands inside the outer one's working tree,
  which `prepare-workspace.ts` refuses as `SOURCE_WORKTREE_DIRTY` for every
  outer task. Deliberately not fixed here: a root-containment rule is the shape
  that locked out submodules twice before, and if it is guarded at all it should
  be guarded at the derived worktree parent rather than at the root.
- **`R-M2-3-5` — two enlisted repositories may share a delivery target.**
  `BACKLOG`. Published refs are `refs/heads/ao/task/<taskId>` and carry no
  repository identity, so two clones of one remote contend for one ref
  namespace; the create-only `--force-with-lease` refuses the second
  permanently. It fails closed, it predates any registry, and adding a delivery
  gate to the registry would make a selection document into a delivery
  authority.
- **`R-M2-3-6` — three probes spawn under `process.cwd()`.** `BACKLOG`, and
  pre-existing. `doctor/capabilities.ts` and both `auth-preflight.ts` call sites
  omit `cwd`, so `effectiveSpawnCwd(undefined)` returns `process.cwd()`. They
  are machine-scoped auth and capability probes rather than repository work, and
  this slice neither uses nor changes them. Recorded because an earlier draft of
  this decision asserted that every production caller passes an explicit cwd,
  and that was false.
