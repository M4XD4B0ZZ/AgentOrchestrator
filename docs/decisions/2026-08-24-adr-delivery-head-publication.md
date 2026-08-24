# V4 slice 5 — publishing the delivery head

Date: 2026-08-24
Status: accepted

## The slice this was going to be, and why it is not

The plan was pull-request creation: `PULL_REQUEST_REQUIRED` is the commonest
answer slice 4 gives, and the missing effect is obvious. The investigation
refused it, on four measurements.

**Nothing in this repository publishes a branch.** An exhaustive search of
`src/`, the scripts and the dist harnesses for `git push`, `remote add`,
`--set-upstream` and `push -u` returns no product code at all. The only hits are
prose, and `git remote get-url --push`, which is a query. AO's most privileged
Git action today is a local commit inside a worktree
(`src/worktree/commit-task-work.ts`).

**Pushing is documented as a human step.** `CLAUDE.md:29-38` lists it as step 2
of the delivery flow a person performs, and
`docs/decisions/2026-08-23-adr-autonomous-delivery-m1.md:18-21` says the finished
work is handed to a human "who pushes the branch, opens the pull request,
watches CI, and merges."

**A pull request is created from a remote ref that already exists.** GitHub's
`POST /repos/{owner}/{repo}/pulls` documents `head` as "the name of the branch
where your changes are implemented", optionally `user:branch`. There is no SHA
form and the endpoint creates no refs.

So a pull-request-creation slice would answer `HEAD_NOT_PUBLISHED` for every
task AO itself produced. That is the "unusable in the real lifecycle" condition,
and the honest response is the smaller prerequisite rather than a capability
that refuses on every input.

**And the tool that hides the problem is the one that makes it worse.**
`gh pr create --help`, gh 2.97.0, verbatim: "When the current branch isn't fully
pushed to a git remote, a prompt will ask where to push the branch and offer an
option to fork the base repository. Use `--head` to explicitly skip any forking
or pushing behavior." Its dry run adds: "Print details instead of creating the
PR. **May still push git changes.**" Using it would have smuggled a second,
unnamed forge mutation into a slice named after the first.

The slice is therefore **remote delivery head publication**, and pull-request
creation is the next one.

## What was measured, and how

Every external behaviour below was measured before any code was written, against
`github.com` and the real repository, with `--dry-run` so nothing moved. The
remote's 17 branches were counted before and after and are unchanged.

### Can `git push` authenticate under AO's child environment?

AO runs Git under `capability:generic` — `PATH` and `PATHEXT`
(`src/auth/env-guard.ts:277`) — plus the eleven-name Windows back-fill
`runCommand` adds to every child. The origin is HTTPS and the credential helper
is Git Credential Manager at system scope, which had no obvious reason to work
with twelve environment variables.

Measured by spawning `git push --dry-run` the way AO spawns, not with `env -i`
in a shell, because the back-fill only exists for a real spawned process:

| Environment | Names | Result |
| --- | --- | --- |
| `capability:generic` + back-fill, exactly as AO supplies it | 12 | **authenticated** |
| the same plus `APPDATA` | 13 | authenticated |
| the same plus `LOCALAPPDATA` | 14 | authenticated |
| full inherited environment (positive control) | 75 | authenticated |

No new environment policy was needed. Git runs here exactly as every other Git
command in the build does.

### What does `--force-with-lease` with an empty expected value mean?

This is the primitive the whole idempotency claim rests on. The first attempt to
measure it **measured nothing**, and that is worth recording: the cases pushed a
SHA the ref already held, so git answered `Everything up-to-date` and never
evaluated the lease. Re-run with real ref updates:

| Case | Result |
| --- | --- |
| `--force-with-lease=<ref>:` (empty), ref **absent** | accepted — creates |
| `--force-with-lease=<ref>:` (empty), ref **exists** | **rejected, `(stale info)`** |
| `--force-with-lease=<ref>:<wrong>` , ref exists | rejected, `(stale info)` |
| `--force-with-lease=<ref>:<correct>`, ref exists | accepted — **forced update, rewrites the branch** |
| plain push, ref absent (control) | accepted — creates, no CAS at all |
| plain push, divergent (control) | rejected, non-fast-forward |

So the empty form is an atomic **create-only** compare-and-swap, evaluated by
the server during the ref update. The non-empty form is exactly what this build
must never send, which is why the expected value is not a parameter, not a
variable and not derived from anything — the vector is built with the colon and
nothing after it, and a test reads the vector for every input to prove it.

### What does the push report?

Measured with `--porcelain`:

| Remote ref | Output | Exit |
| --- | --- | --- |
| absent | `*  <sha>:<ref>  [new branch]` | 0 |
| already at the pushed SHA | `=  <sha>:<ref>  [up to date]` | 0 |
| at a different SHA | `!  <sha>:<ref>  [rejected] (stale info)` | 1 |

**Two different events share exit 0.** A build that reported "published" for
exit 0 would claim an effect it did not have, and would do so first on the run
that changed nothing. This is why a reading is taken *before* the attempt, and
why the transport's exit code is allowed to decide only between explanations the
readings cannot separate.

### The postcondition instrument

`git ls-remote --exit-code -- <remote> <ref>`: exit 0 with `<sha>\t<ref>`, exit 2
when the pattern matched nothing, exit 128 when it could not ask. A three-way
answer with no English in it, so nothing here parses Git's prose — the same rule
`github-observer.ts:34-41` applies to the GitHub CLI's stderr.

## The contract

`agent-loop delivery --repository <p> --task <id> --publish-head --attended`
creates `refs/heads/<workBranch>` on the delivery remote at exactly the task's
`currentCommit`, create-only, or explains why it did not.

Eleven outcomes, closed, ordered weakest claim first:

`SUBJECT_NOT_ESTABLISHED`, `TASK_NOT_READY`, `OPERATOR_ABSENT`,
`AUTHORITY_REFUSED`, `SUBJECT_CHANGED`, `REMOTE_STATE_UNKNOWN`,
`REF_HOLDS_ANOTHER_COMMIT`, `PUBLICATION_REFUSED`, `OUTCOME_UNCERTAIN`,
`ALREADY_PUBLISHED`, `CONVERGED_AFTER_UNCERTAIN_EFFECT`, `PUBLISHED`.

Three of them — `PUBLISHED`, `ALREADY_PUBLISHED`,
`CONVERGED_AFTER_UNCERTAIN_EFFECT` — mean the remote holds this exact commit
under this exact ref. They are one established state with three provenances, and
`remoteHeadIsEstablished` is the predicate callers use, because a caller that
compared against `PUBLISHED` alone would push again for no reason.

There is no `NOT_REQUESTED`. Without `--publish-head` there is no publication
and the report has no publication block, exactly as `--decide` behaves. A member
that only a test could reach would be a dead enum member.

## The authority

`HeadPublicationGrant` — opaque, one-shot, minted in exactly one place.

Three layers, the shape `internal/delivery-observation-proof.ts` and
`core/internal/interruption-checkpoint.ts` already prove: a `#private` field for
nominal typing, a module-private `WeakSet` with `has` bound at module load, and
a deleted prototype `constructor` with both objects frozen. Both forgeries
reproduced against earlier artefacts in this codebase — a prototype borrowed
through `Object.create`, and a constructor reached through
`Object.getPrototypeOf(value).constructor` — are closed by that shape.

It binds six fields: `{host, owner, name}` (the exact repository), `remoteName`
(the local name of the remote, never a URL), `ref` (the full `refs/heads/...`),
and `commit` (the exact object name).

**One-shot is structural, not a rule.** There is no accessor that reads the
facts without spending them: `claimHeadPublication` moves the artefact into a
spent registry in the same call that returns them. A grant that could be read
twice is a grant that could publish twice.

**`CREATE_AUTHORIZED != MERGE_AUTHORIZED` is a compile error.** There is no
`MergeGrant`, no `PullRequestGrant`, no widening conversion and no common
supertype. A future slice that opens a pull request must mint its own artefact
and say so; it cannot pass this one where its own is demanded.

The mint is called from the CLI's refusal ladder and nowhere else, and a tree
walk proves it.

## Why the execution lease is not taken

The lease was the obvious candidate and it was refused, on three grounds.

**It would over-claim.** The lease asserts "this invocation is the repository's
writer". A publication writes nothing locally. `release` does take the lease for
a non-executing purpose, so the precedent exists — but it takes it because it
deletes a local branch and a directory and cannot otherwise tell a crashed run's
leftovers from a live run's workspace. Publishing has no such ambiguity.

**It would couple delivery to execution.** `src/deliver/delivery-evidence-store.ts:16-24`
refused the lease for slice 3 because taking one "would make an observation
contend with a run for the repository". That argument is *weaker* for slice 3
than it is here: a publication that held the lease would block a running task
for the duration of two network round trips, and inherit
`LEASE_FILESYSTEM_UNSUPPORTED`, `LEASE_LOCATION_*` and the whole stale-recovery
vocabulary as new refusals on a delivery command. It would also sit against M1
invariant 9 — delivery authority is separate from execution authority.

**It would not fence the case that matters.** The lease keys on the Git common
directory, so two clones of one remote are two leases. The race worth fencing is
two publishers, and they need not share a checkout — or a machine.

**What fences instead:** the ref update. `--force-with-lease=<ref>:` is a
compare-and-swap the server evaluates, so two publishers racing to create the
same ref cannot both win, in any arrival order. That is a stronger guarantee
than a local lock, and it is the only one that holds across clones.

The local window that remains — the task advancing while this command runs — is
closed by re-reading the whole subject before the remote is contacted, and
refusing with `SUBJECT_CHANGED` if anything moved.

## The order, and the step that is refused

1. spend the authority — before anything is read, so an unauthorised caller
   cannot make this build emit even a read;
2. re-establish the local subject, and refuse if it moved;
3. read the remote ref;
4. push **at most once**, and only when the ref is absent;
5. read the remote ref again, whatever the transport said.

There is no sixth step. If the postcondition is not what was intended, nothing
is deleted, moved or retried — the outcome is named and handed back. A
compensating action is another mutation, it runs at the moment least is known,
and undo paths are where this codebase's most destructive defects have lived.

There is no blind retry. A create is not idempotent in the transport, and the
endpoint offers no idempotency key. Idempotency here is a property of the ladder:
every invocation re-derives the state from a reading, so an explicit retry
converges rather than repeating.

## Content and egress

The grant carries six fields and the push vector can only carry what the grant
holds. No task title, no brief, no findings, no diff, no log, no path, no URL
and no free text of any kind reaches the network by this path — enforced by the
shape rather than by a filtering step somebody has to remember to run. Slice 3
reached the same conclusion for the same reason.

Every token in both vectors is checked against `isShellInertArgument`, and the
suite asserts no token contains whitespace at all: a token carrying a space is a
token carrying something a person wrote.

No credential enters AO. Git authenticates with the helper the machine already
has, exactly as it does for every other Git command in this build.

## Draft versus ready

Not applicable, and deliberately recorded as such rather than silently skipped.
This slice creates a branch, not a pull request; `draft` is a property of a pull
request. The measurement was taken anyway for the next slice: all 58 pull
requests in this repository are non-draft, and both `gh pr create` and the REST
endpoint default to ready.

## Product state

`READY_FOR_PR` remains terminal. No transition, no state, no schema field, no
`publishedAt`, no `remoteHead`. That a branch exists on a remote is an external
fact, established externally and observable through slice 2 — which is what the
delivery stack is for.

## Invariants

1. Exactly one module in the delivery surface runs a push, and it runs one
   create-only vector. Derived from the tree.
2. The lease token always ends at the colon. No expected value, for any input.
3. The refspec's left side is an object name, never a branch name.
4. At most one push per invocation, on every path including uncertain ones.
5. Success is established by a reading, never by an exit code.
6. The mint is imported by three modules and called by one.
7. No task state is written and no execution lease is taken.

## Residuals

- **`L-V4-05-1`** — republishing a moved head is not implemented. Once the ref
  exists, a task that advances to a new commit gets `REF_HOLDS_ANOTHER_COMMIT`,
  because the vector is create-only by design. Updating a published head is a
  different act with a different blast radius and needs its own decision.
- **`L-V4-05-2`** — the remote race is fenced but not eliminated. A publisher
  that loses is told `REF_HOLDS_ANOTHER_COMMIT` or
  `CONVERGED_AFTER_UNCERTAIN_EFFECT`; nothing prevents a human from moving the
  ref a second later, and nothing here would notice.
- **`L-V4-05-3`** — `git push` authentication was measured on this machine only:
  Windows, HTTPS origin, Git Credential Manager at system scope. A host whose
  helper needs an environment variable `capability:generic` does not carry would
  fail, and would surface as `PUBLICATION_REFUSED` with no diagnosis, because
  Git's stderr is not read.
- **`L-V4-05-4`** — the duplicate-PR and closed-PR behaviours of GitHub's
  pull-request endpoint remain unmeasured; establishing them requires a POST.
  They belong to the next slice, and `L-V4-02-7` — whether two open pull
  requests can share a head commit — is still open beside them.
- **`L-V4-05-5`** — the publication is not recorded anywhere. "AO published this
  head at this time" is not a durable fact; the remote is the record, and slice
  2 is how it is read back.
- **`L-V4-05-6`** — the CLI ladder requires `READY_FOR_PR`, which means the live
  dogfood exercised the module and the real transport but not the ladder: this
  repository has no AO task state for its own slices, and fabricating one to
  make a dogfood possible is precisely what the handoff forbids.
- **`L-V4-05-7`** — `--attended` is now registered on `delivery` as well as on
  `run`, `block` and `release`. It means the same thing in all four, but nothing
  proves that: there is no shared constant, and four independently worded help
  strings can drift.

## Next slice

Pull-request creation. The prerequisite this slice was blocked on now exists,
the transport question is already answered against `gh pr create` and in favour
of a direct API call, and the authority pattern is proven. What it still needs
is its own artefact — `CREATE_AUTHORIZED` is not this grant — and measurements
of the duplicate and closed-PR cases that only a POST can settle.
