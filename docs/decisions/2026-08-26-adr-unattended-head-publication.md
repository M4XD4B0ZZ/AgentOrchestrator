# ADR — unattended head publication: the operator's declaration, not the repository's

**Date** 2026-08-26
**Status** accepted
**Slice** V4 slice 13
**Supersedes** nothing. **Superseded by** nothing.
**Amends** two.

`2026-08-24-adr-delivery-head-publication.md`, which stated that a head
publication requires an operator to be present for the invocation. That stops
being unconditionally true here, in one bounded way and for one act. It amends
nothing else in that decision: the mechanism, the create-only fence, the
one-shot grant and the no-retry rule are all unchanged.

`2026-08-26-adr-delivery-lifecycle-driver.md`, whose second load-bearing
sentence reads "**Every act still requires its own flag and `--attended`,
separately.**" The rule survives with one word replaced — every act still
requires its own flag and *a grant that names that act*, separately — and the
driver is unchanged: it adds no act, grants none, and still attempts at most one
forge mutation per invocation. Two of the three acts still have exactly one
grant, and it is `--attended`.

## The decision

AO gains one new capability: **it may create one work branch on one delivery
remote with nobody present, when the operator of this machine has declared that
permission for that exact repository.**

One new flag, `delivery --automatic-publish-head-only`. One new production
module, `src/deliver/delivery-automation.ts`. One new operator-owned file,
`<OS user profile>/.agent-orchestrator/delivery-automation.yaml`. No new grant
type, no new push implementation, no new remote effect, and no durable record.

Nothing else becomes unattended. Opening a pull request and merging one still
require `--attended`, and this slice adds no route to either.

## The three sentences the contract rests on

> **The permission is the operator's, on the operator's machine, about a named
> forge repository. The work being delivered cannot write it.**

> **Capability is not permission. An unattended publication needs the operator's
> standing declaration AND this invocation asking for it, and neither implies
> the other.**

> **The declaration permits one act. There is no key in it for a second one, and
> an unknown key refuses the whole document.**

## 1. The trust source, and the two candidates that lost

### 1.1 What was measured

Three modules in `src/` read a repository profile. Two read the working tree
(`repo/resolve-repository.ts:465`, `repo/declared-identity.ts:87`). Exactly one
reads a profile out of a commit: `scope/pinned-scope.ts:109-114`, which runs

    git --no-replace-objects show --end-of-options <rev>:.agent-orchestrator/repo-profile.yaml

at `scopeAuthorityCommit ?? basePinnedCommit` (`scope/assess-scope.ts:169-173`),
both read off the persisted task state and never off the invocation.

That module is the right *pattern*. Its header already argues this slice's
central case — "The obvious repair — read the profile out of the authorised
worktree — is worse than the problem. That tree is the one the writing agent has
write access to … Self-authorisation, one file edit away." — and
`scopeAuthorityCommit` exists precisely because a chained task's base pin is a
commit its predecessor's agent wrote.

It is nonetheless **not** the source this slice uses, for two measured reasons.

**The profile is in no commit of this repository.** `.gitignore:32` ignores
`.agent-orchestrator/`, `git ls-files .agent-orchestrator` is empty, and

    $ git show HEAD:.agent-orchestrator/repo-profile.yaml
    fatal: path '.agent-orchestrator/repo-profile.yaml' exists on disk, but not in 'HEAD'

A permission read from a commit is therefore unreadable in the one repository
this build is dogfooded against. Every unattended publication here would refuse,
and a mechanism that can only refuse is not a mechanism — it is a feature nobody
can use, whose refusal path is the only one any test would ever exercise.

> **Addendum, 2026-08-28 (V4 slice 18, the M1 dogfood).** The measurement above
> was true when this decision was taken and is no longer true. `.gitignore` now
> ignores `.agent-orchestrator/runtime/` only, and the profile is committed,
> because `src/scope/pinned-scope.ts` reads a task's scope declaration out of the
> commit the task was pinned to and refuses when it is not there — so this
> repository could not have driven a single task of its own until the profile
> was in a commit. The decision recorded here stands unchanged: it rests on the
> second reason below, which is about what a repository profile *is* and never
> about where it happens to live. This paragraph is kept, not corrected, because
> an ADR records what was measured on the day it was written.

**A repository profile is repository-authored input.** The publication mint
already refuses to carry repository-authored prose into an argument vector, for
a reason that applies with more force to a permission than to a title. Pinning
the read to a commit closes the worktree-edit vector; it does not close the one
where `--repository` is pointed at a tree the writer owns, and it makes the
permission a property of code review in a repository whose review is exactly what
the unattended act is skipping.

### 1.2 What was chosen

    <OS user profile>/.agent-orchestrator/delivery-automation.yaml

`orchestratorHome()` (`config/paths.ts:77-79`) resolves through
`config/internal/path-provider.ts`, which reads the profile directory from
`os.userInfo()` — the process token on Windows, the passwd entry on POSIX — and
so consults no environment variable, no CLI flag and no repository file. The
loader is `notify-config.ts`'s, copied deliberately rather than invented: same
absence-is-off shape, same size ceiling before parsing, same shared safe-YAML
boundary, same `.strict()` contract, same rule that a refusal carries a closed
code and never a byte of the file.

This is not a second configuration ecosystem. It is one more document in the
directory that already holds `notify.yaml`, under the same trust argument, in
the same place the forge credential already lives.

## 2. Why the task being delivered cannot authorise itself

Enumerated as attacks, each answered by where the bytes are rather than by a
check that could be removed:

| Attack | Answer |
| --- | --- |
| H edits `.agent-orchestrator/repo-profile.yaml` in its worktree | not read. The permission is not in the profile at all. |
| H commits that edit into H | not read. |
| H writes `<repo>/.agent-orchestrator/delivery-automation.yaml` | not read. The path is under the OS user profile, never under a repository root. |
| H sets `AGENT_LOOP_HOME` or any environment variable | not read. `trusted-profile.ts` consults no environment block; the removed override is ignored by name. |
| H edits the operator's home file | outside its worktree. The writer runs under `acceptEdits` with no shell, and this is the same boundary `notify.yaml` already relies on. |
| A predecessor task in a block hands its successor permission | there is nothing to hand. The permission is not in a commit, so it does not travel with code. |
| Another repository's declaration | refused. Each entry names `{host, owner, name}` and is matched exactly against the delivery target the grant is minted for. |
| A declaration for another effect | there is no other effect key. `.strict()` refuses the document. |

The residual is stated rather than hidden: this slice does not add process
containment. If the writing agent could execute arbitrary commands as this OS
user it could write the operator's home file, exactly as it could write
`notify.yaml`. That is the containment contract's problem and it is recorded, not
re-litigated, here.

## 3. The policy vocabulary

```yaml
schemaVersion: 1
repositories:
  - host: github.com
    owner: M4XD4B0ZZ
    name: AgentOrchestrator
    headPublication: AUTOMATIC_ALLOWED   # or ATTENDED_ONLY
```

Closed in every direction that matters:

- `schemaVersion` is `z.literal(1)`. A future contract is refused, never
  reinterpreted — the rule `repo-profile.ts` already applies;
- every object is `.strict()`. An unknown key refuses the **whole document**,
  which is what makes "a future effect member cannot fall into allowed" a
  property of the parser rather than of a reviewer's attention;
- `headPublication` is a two-member `z.enum`. Anything else is a contract
  violation. The grading function switches exhaustively over the two members, so
  a third would be a compile error rather than a silent arm;
- entries are keyed by `{host, owner, name}` and a duplicate key refuses the
  document. Which of two contradictory permissions is in force must not depend on
  which line came first;
- identity is compared **exactly**. github.com folds case in an owner and a
  repository name; this build does not, because case-folding a permission means
  deciding that two strings name one repository on the strength of a rule it does
  not own. A differently-capitalised entry answers `NOT_DECLARED`, which is the
  fail-closed direction.

**The default is deny, and it is the absence of a file rather than the default of
a field.** No file, an empty list, an entry for another repository, and
`ATTENDED_ONLY` are four different ways of not permitting it, and three of them
are reported under distinct members because the remedies differ.

## 4. Capability is not permission

An unattended publication requires **both**, independently:

1. the invocation explicitly asks for it — `--automatic-publish-head-only`,
   alongside `--drive` and `--publish-head`;
2. the operator's declaration permits it for this exact repository.

Neither implies the other. The declaration alone changes nothing: an invocation
that does not ask still refuses `OPERATOR_ABSENT`. The flag alone changes
nothing: it refuses `AUTOMATIC_PUBLICATION_NOT_DECLARED`.

This is `InvocationGrant`'s shape, deliberately. V3-08 conjoined an invocation
authority (`AUTOMATIC_RESUME_ONLY`, chosen by a flag) with a task authority
(`AUTOMATIC_ALLOWED`, derived from the world) and let neither manufacture the
other. The same two halves appear here with different contents.

**Absence is never authority.** The automatic path is not "no `--attended`"; it
is a flag of its own, and passing both is refused before anything is resolved.

## 5. The flag

`--automatic-publish-head-only`, and the name is chosen under two constraints
this build already enforces.

No registered option name in this build may contain `force`, `unattended`,
`adopt`, `takeover` or `steal`. The rule is enforced by more than one instrument
and the difference matters: `tests/v2-07lr-…` scans the *source* for `.option(`
declarations across the tree, while the per-slice copies build a program — the
whole one in `tests/v4-05-…`, the delivery command alone in the rest — and read
the flags commander holds. Neither is a superset of the other, which is why both
exist. How many copies there are is deliberately not stated: a number beside a
set nothing enforces is the shape this repository has been caught by three
times, and an earlier draft of this paragraph both wrote one and then said it
would not.

`--unattended-publish-head` fails that sweep, and widening the sweep would be the
wrong repair: the guard is right and the name would be the problem, exactly as
`run-command.ts` records for `--automatic-resume-only`.

So the spelling mirrors that flag: the act it permits, and `-only` carrying the
restriction. It is the CLI spelling of what it does, and the trailing word says
what it is not.

**It requires `--drive` and `--publish-head`.** That is a deliberate narrowing
and it is load-bearing rather than decorative. Under `--drive` the publication is
reached only after the driver has, in this invocation, re-derived the delivery's
position from disk and from github.com: the conclusion is read (and a concluded
delivery stops), the receipt and verification history are read, the observation
is taken fresh, and the decision must be `PULL_REQUEST_REQUIRED` — no open pull
request has this head. A bare `--publish-head --automatic-publish-head-only`
would skip all of that, and the measured consequence is concrete: a delivery that
has already been merged and whose branch the forge deleted presents an absent ref
again, and an unattended publisher with no conclusion read would re-create it.

Refused before the repository is resolved, each with its own code:

| Combination | Code |
| --- | --- |
| with `--attended` | `PUBLICATION_GRANT_CONFLICT` |
| without `--drive` | `AUTOMATIC_PUBLICATION_WITHOUT_DRIVE` |
| without `--publish-head` | `AUTOMATIC_PUBLICATION_WITHOUT_ACT` |
| with `--create-pr` or `--merge-pr` | `AUTOMATIC_PUBLICATION_WITH_OTHER_ACT` |

All four are argument defects, graded 2, and answered while nothing has happened
— the rule `block-command.ts` states and `delivery-command.ts` already applies to
`--drive`'s own combinations: whether an invocation is refused for its flags must
not depend on what is in the repository.

## 6. The effect grant is unchanged

`HeadPublicationGrant` is not modified, not widened, not subclassed and not
joined. It was measured to encode no attendedness at all — six fields, all
identities and object names; a mint taking three arguments, none about presence;
six refusal arms, all grammar and identity; and a point of effect that never
reads `attended`. Attendedness was one line's *position* in a ladder, and this
slice changes what that line asks, not what the artefact is.

A fourth grant type was considered and rejected. It would bind identical facts,
authorise an identical effect, and need its own registry, its own one-shot claim,
its own substitution matrix against three siblings and its own reachability test
— while the three properties that make the artefact an authority (an unreachable
constructor, a private registry, a one-shot claim) are none of them per-call-site.
The authority that had to be new is the *invocation's*, and that is where it went.

The mint is still called in exactly one module, and it is still the same module:
`src/cli/delivery-steps.ts`. The reachability pins in `tests/v4-05-…` are
unchanged and still pass.

## 7. The attended path is unchanged

`--publish-head --attended` behaves exactly as it did. The authority resolver
answers on `attended === true` before it looks at anything else, so no attended
invocation reads the declaration file, and an unreadable or absent declaration
cannot refuse an attended publication. That is asserted, not assumed.

## 8. The automatic path, exactly

```
argument refusals (no repository resolved)
        ↓
--drive: conclusion, receipt, verification read from disk
        ↓
fresh observation of github.com, fresh decision -> PULL_REQUEST_REQUIRED
        ↓
mayPerform(PUBLISH_HEAD): --publish-head AND (--attended OR --automatic-publish-head-only)
        ↓
performPublication ladder: subject -> READY_FOR_PR -> AUTHORITY
        ↓
   authority = attended ? AUTHORISED
             : automatic ? grade(operator declaration, delivery identity)
             : OPERATOR_ABSENT
        ↓
mintHeadPublicationGrant  (unchanged)
        ↓
publishDeliveryHead       (unchanged)
   claim -> recheck -> URL agreement -> read ref -> at most one push -> read ref
             └── the recheck re-proves the authority as well as the subject
        ↓
STOP. One forge mutation attempted, and the invocation is over.
```

No pull request follows. On `ALREADY_PUBLISHED` — where no mutation was
attempted — the driver reports that creating one is the next missing act and
settles `ATTENDED_AUTHORITY_REQUIRED`, because `mayPerform` answers `false` for
`CREATE_PULL_REQUEST` under every invocation that lacks `--attended`, and this
one is refused for naming `--create-pr` at all.

## 9. Freshness, and what "revocation" can honestly mean

The declaration is re-read and re-graded inside `publishDeliveryHead`'s
`recheck`, which is the last thing that runs before the remote is contacted. A
declaration that stopped permitting this repository between the ladder's read and
that moment refuses there, under the same member the first read would have
produced, with nothing read from the remote and nothing attempted.

That it is the *last read from disk* is measured rather than asserted. The suite
takes a control run to establish how many repository resolutions this path makes,
and then removes the declaration on the last one — which is the resolution the
`recheck` closure itself performs, strictly after the ladder's own read. A hook
that fired earlier would remove the declaration before the ladder read it and
would measure that step twice while measuring the re-proof not at all.

What this does **not** claim, and an earlier draft did: that the re-proof is
"immediately before" the remote is contacted. It is not. `publishDeliveryHead`
runs the recheck second, and after it come two local `git remote get-url` calls
and then `ls-remote` — a network round trip with a 120-second ceiling — before
the push. Nothing is consulted inside that window. It is inherent to the existing
mechanism, it is the same window an attended publication has, and closing it
would mean a further subprocess whose answer could go stale in its own turn. It
is recorded as `L-V4-13-4`, widened to name the whole window rather than only its
last two steps.

Between invocations there is nothing to revoke: no permission is stored, no
grant survives a process, and the next invocation reads the file again.

## 10. Concurrency, measured

The fence is unchanged and it is the server's. Measured on a real bare remote
with the exact pinned vector:

| Case | Measured | Decided by |
| --- | --- | --- |
| ref absent, one publisher | `[new branch]`, exit 0 → `PUBLISHED` | the server accepts the create |
| two publishers create the same ref at once | exactly one `[new branch]` exit 0; the loser is refused, and which way depends on the interleaving — `[remote rejected] (atomic transaction failed)` / `cannot lock ref … reference already exists` exit 1 when they genuinely race, `[up to date]` exit 0 when they serialise | **the server**, in receive-pack's ref transaction, on the racing interleaving |
| ref already at this commit before the push | `[up to date]`, exit 0 — the empty lease is not evaluated | this side, from the ref advertisement |
| ref at another commit | `[rejected] (stale info)`, exit 1, ref unchanged → `REF_HOLDS_ANOTHER_COMMIT` | **this side**, from the ref advertisement, before any update is sent |

The race is driven five times and what the suite pins is the invariant that holds
in every interleaving — exactly one process reports `[new branch]`, the ref ends
holding that commit, and there is exactly one such ref — plus that the loser's
outcome is one of the two shapes above and never a third. Pinning *which* shape
would be pinning the scheduler.

Two mechanisms, and the slice measures both rather than calling them one thing.
An earlier draft of this section called the `(stale info)` row "the server-side
compare-and-swap"; a review measured that it is decided locally, and the row that
really fences two concurrent publishers is the second one, which that draft
reasoned about rather than measured. Both are now driven against a real bare
repository in `tests/v4-13-…`.

The third row is the honest residual. In the real ladder a ref already at this
commit is answered `ALREADY_PUBLISHED` from the pre-reading and no push happens;
the row matters only for the window in which somebody else creates the ref at
this commit *between* AO's pre-reading and AO's push, where AO reports
`PUBLISHED` although it created nothing. The remote state that member asserts is
true; the authorship it implies is not. Nothing durable records it.
`L-V4-13-5`.

No execution lease is taken, deliberately and unchanged: a local lock cannot
fence a second clone, another machine or a human with a terminal, which are the
cases that matter.

## 11. Unknown outcomes

Unchanged, and inherited rather than re-argued. One push call site, no loop in
the file, and every uncertain transport result — timeout, boundary lost, output
limit, spawn failure, a claimed success the reading afterwards contradicts —
lands in the same place: nothing is retried, and the next invocation begins with
a reading. Nothing about this slice persists an "automatic publication pending"
state, because there is no state to persist.

## 12. Durability

**The publication writes nothing.** No task state, no block ledger, no delivery
record, no selection record, no publication record, no cached permission. Nothing
about the grant survives the process, which is why the next invocation reads the
declaration again rather than trusting one.

**The invocation is a `--drive`, and that is a different question.** A drive can
write the merge receipt, the post-merge verification history and the delivery
conclusion; and when it verifies the merge commit it takes this repository's
execution lease, makes a detached worktree, and runs the verification commands
the repository's own profile declares. None of that is new, none of it is a forge
mutation, and none of it takes a grant — `--drive` has done all of it since
slices 8 to 11, with no grant at all. What is new is that it can now happen on an
invocation nobody is watching, and the two cannot be separated because this grant
requires the drive. That is `L-V4-13-9`, and it is the price of §5's narrowing:
the drive is what makes the publication safe to perform unattended, and the drive
brings its own local acts with it.

An earlier draft of this section said "nothing new is written anywhere", which is
true of the publication and false of the invocation. A review measured it.

## 13. Non-goals

Explicitly outside this slice, and each needs its own decision:

unattended pull-request creation; unattended merge; autonomous merge eligibility;
review-policy evaluation; CI polling; a scheduler; a daemon; recurring execution;
draining more than one task per invocation; cross-project orchestration; a
generic risk engine; automatic remediation; a blanket automatic-delivery switch;
branch deletion; force-updating an existing ref; and process containment for the
writing agent.

`READY_FOR_PR` remains terminal and the transition table is untouched.

## 14. What is carried, and what it costs

**`L-V4-13-1` — the declaration is a file, and containment is not this slice's.**
The permission is outside every repository and every worktree, and the writing
agent runs under an edit-only profile with no shell. That is the same boundary
`notify.yaml` already stands on. It is not process containment: an agent that
could execute arbitrary commands as this OS user could write either file. The
consequence is stated so that a future slice does not read this one as having
closed it.

**`L-V4-13-2` — the declaration is not repository-reviewable.** Choosing the
operator's home over a tracked profile buys immunity from the work being
delivered and gives up review: nobody but the operator sees the permission, and
it is not in any history. For a create-only branch push that is the right trade;
for an act with a larger blast radius it may not be, and this ADR does not decide
that in advance.

**`L-V4-13-3` — identity is compared exactly.** A declaration whose owner or
repository name differs from the delivery target's only in case answers
`NOT_DECLARED`. Fail-closed, and it will look like a bug to whoever hits it.

**`L-V4-13-4` — nothing is re-read between the authority re-proof and the push.**
Two local `git remote get-url` calls and one `ls-remote` — a network round trip
with a 120-second ceiling — run in that window. Inherited from slice 5 and
unchanged; what this slice changes is that the fact proved before the window is a
permission and not only a subject.

**`L-V4-13-5` — a publisher that created nothing can report `PUBLISHED`.**
Measured, with the exact vector: a push of the same commit onto a ref that
already holds it exits 0 and reports `up to date` without the lease being
evaluated. In the ladder this is normally answered `ALREADY_PUBLISHED` from the
pre-reading and no push happens; it is reachable when somebody else creates the
ref at this commit inside `L-V4-13-4`'s window. The remote state the member
asserts is true and the authorship it implies is not. Nothing durable records
it, and this slice does not change the grader.

**`L-V4-13-6` — a credential prompt would stall an unattended push.**
`GIT_TERMINAL_PROMPT` is set nowhere and the child receives `USERPROFILE`, so a
machine whose credential helper wants an answer burns the 120-second ceiling and
lands as a failed attempt with nobody to resolve it. Not unsafe — the no-retry
rule holds — but it is a two-minute stall per invocation, and changing it would
be changing the push, which this slice does not do.

**`L-V4-13-7` — `OPERATOR_ABSENT` is not reachable under `--drive`.** Measured:
`mayPerform` answers `false` for an act with no grant, so the driver settles
`ATTENDED_AUTHORITY_REQUIRED` and the ladder is never called. The member is
reached by naming `--publish-head` directly. Two layers refuse the same thing in
two places, which is deliberate, and the suite drives both.

**`L-V4-12-1` is unchanged and now matters more.** `--select-task` claims a
snapshot rather than a lock, and nothing re-establishes the plan's order between
the walk and the effect. Attended, an operator named the task. Under the
automatic grant the subject is chosen by a walk nothing revalidates — bounded by
everything else in this ADR (the act is create-only, the target is re-derived,
the conclusion is read, one mutation per invocation), and stated rather than
absorbed.

**`L-V4-13-8` — no live product dogfood was possible.** This repository has no
orchestrated task and no runtime state, so no legitimate delivery could exercise
the automatic path end to end. What is measured against real bytes is the
declaration — a real file in a real scratch profile, read by the real loader —
and the fence, against a real bare repository. Unchanged from `L-V4-12-9`.

**`L-V4-13-9` — the grant requires `--drive`, and a drive does more than
publish.** See §12. Local records, the execution lease and the repository's own
verification commands can all run on an invocation nobody is watching. Not new,
not a forge mutation, not separable from the narrowing that makes the publication
safe — and therefore stated rather than absorbed. An operator not prepared for
their profile's verify commands to run unattended should not make the
declaration.

**`L-V4-13-10` — the racing interleaving is observed, not required.** The
concurrent case pins the invariant that holds in every interleaving and
classifies the loser's outcome into the two known shapes. It does not require
that any round actually raced, because requiring that would be requiring a
scheduler. On a runner where the two children always serialise, the server's own
ref transaction is exercised by nothing in this suite and the case is still
green. The row in §10 attributed to the server is therefore measured *when it
occurs* and not on every run — which is the honest reading of that table, and an
earlier draft of it did not say so.

**Not carried, because it was measured false:** the concern that two racing
publishers could both create the ref. Against a real bare repository, driven five
times, exactly one process reports `[new branch]` every time; the loser is
refused by the server's own ref transaction when the two genuinely race and sees
the ref already advertised when they serialise. The refusal of a push to an occupied ref at
*another* commit is a different mechanism and is decided on this side, from the
ref advertisement, before an update is sent — see §10.
