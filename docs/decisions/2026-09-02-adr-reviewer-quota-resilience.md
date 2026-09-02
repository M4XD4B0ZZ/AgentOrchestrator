# Reviewer quota resilience

**Date:** 2026-09-02 · **Status:** accepted, implemented by M2 slice 6.

M2 slice 5 made several repositories execute at once. It named the cost it did
not pay: "two concurrent repositories mean two writer agents and two reviewers
against one operator's quota. Quota resilience is a later M2 slice."

This is that slice, and it turned out to be about something worse than
throughput. When the reviewer's allowance ran out, AO **ended the task**.

## The sentence this slice is answerable for

> Temporary reviewer resource exhaustion must not be misclassified as a human
> decision, must retain enough structured information for later resumption, and
> must not cause avoidable duplicate reviewer consumption.

## The defect, measured before anything was changed

`tests/` on `main @ 9ac3d63`, driven with the real recorded provider bytes
through the production path:

| Scenario | Measured on main |
| --- | --- |
| the boundary classifies a recorded quota refusal | `AGENT_NONZERO_EXIT` → `AGENT_NEEDS_ATTENTION`, `block: null` |
| the reset the provider named | reaches no structured field; survives only inside the quarantined stdout excerpt |
| the task state written | `HUMAN_DECISION_REQUIRED`, `reportedResetAt: null`, `currentCommit: null`, `worktreeCleanAtCheckpoint: false` |
| `evaluateAutomaticResume` | denies, `STATE_NOT_ELIGIBLE_FOR_UNATTENDED_RESUME` |
| two repositories, one subscription | both call the reviewer; the second learns nothing from the first |

Measured 2026-09-02 in a scratch checkout of `9ac3d63` with `node_modules` and
`dist/native` junctioned in; 5/5 reproduction cases passed there. The lab is
outside the repository and is not part of the delivered suite.

## What was already true, and was measured rather than assumed

Almost the whole state machine was already correct, and that is what keeps this
slice small:

- `core/transitions.ts` has always declared `REVIEWING → BLOCKED_USAGE_LIMIT`
  and `BLOCKED_USAGE_LIMIT → REVIEWING`;
- `core/resume-policy.ts` has listed `allowedBlockedAgents: ['claude', 'codex']`
  for `BLOCKED_USAGE_LIMIT` since the file's first commit, and has carried the
  same meaning throughout — the state is eligible for an unattended resume, it
  re-enters directly, and a reported reset is preferred rather than required.
  (The field *names* `automaticResumeEligible` and `resumeReentry` are a day
  younger than the file; the semantics are not.);
- `agent/record-interruption.ts` has always mapped `AGENT_BLOCKED_USAGE_LIMIT`
  onto that state, and `AGENT_PHASES['REVIEWING']` has always named
  `{ agent: 'codex', resumePhase: 'REVIEW' }`;
- `loop/loop-step.ts:runReviewStep` has always routed a failed review through
  `recordAgentInterruption` with a codex fallback;
- `core/internal/task-state-object-schema.ts` has always carried
  `reportedResetAt` as a nullable ISO instant.

What was missing was a **producer**. `AGENT_USAGE_LIMIT` had exactly one source
in `src/` — `claude-writer.ts` — and `codexReviewResumePoint()` hard-coded
`reportedResetAt: null`. A declared edge with no producer is a claim, not a
contract; M1 learned the same thing about `HUMAN_DECISION_REQUIRED`'s missing
operator half.

## The evidence the recogniser is built on

All measured on `codex-cli 0.146.0` — the installed build, and the build that
produced every recorded incident.

1. **The failure envelope.** A forced failure (`-m
   definitely-not-a-real-model-xyz`) printed, on stdout,
   `{"type":"turn.failed","error":{"message":<string>}}` and exited 1.
2. **The structured category is not on that wire.** The same run's rollout
   recorded `codex_error_info: "other"` beside the message; stdout printed the
   message alone. `codex.exe`'s string table carries the closed vocabulary
   (`usage_limit_exceeded`, `unauthorized`, `bad_request`, …) and none of it is
   serialised to `exec --json`.
3. **One stable message.** All 51 recorded refusals across
   `~/.codex/sessions/**` — every one an `originator: codex_exec` session
   carrying `codex_error_info: "usage_limit_exceeded"` — are one template with
   four different times.
4. **The named time is the local rendering of the structured reset.** Each
   incident's message was cross-checked against the last `token_count` event in
   its own rollout, which carries `rate_limits.primary { used_percent,
   window_minutes, resets_at }`. **5/5 matched**, every one on the 300-minute
   primary window, with seconds truncated by the rendering.

## The decision

### 1. Classify from the message, narrowly, and fail closed

`agent/internal/codex-quota-signal.ts` classifies from prose, because point 2
above leaves nothing else to read. It is not the only such reader —
`deliver/forge-observation.ts` matches GitHub's "No commit found for SHA"
sentence the same way — but it is the only one on an agent boundary, where every
other verdict in this build comes from a structured field.

- recognition is a **prefix** match on the recorded sentence, not a search. A
  substring test would recognise a quota block in any failure that quoted one,
  including the reviewer's own prose about this file — a file the reviewer
  reads;
- the reset is read from an **end-anchored** suffix;
- only a top-level `turn.failed` event is read, so an agent message can never be
  one;
- anything unrecognised is `NONE`, and the boundary's existing fail-closed codes
  apply unchanged. Unknown output never becomes a quota wait.

The check sits **after** `endedUnderOwnControl` and **before** the exit-code
branch, exactly where the writer's does, and for the reason `agent-outcome.ts`
already states: a quota refusal legitimately exits non-zero, so classifying from
the status first loses every one of them.

### 2. Derive the instant, and say that it is derived

`try again at 5:35 PM` names no date and no zone. The derivation follows point 4
rather than taste:

- resolve in the **process's local zone**, which is the zone the CLI rendered in;
- round **up** to the end of the named minute, because the rendering truncates
  seconds and an instant a moment early costs a reviewer call;
- resolve an ambiguous wall clock — the hour a daylight-saving fold repeats — to
  the **later** instant, because the earlier one is before the reset;
- a wall clock inside a spring-forward gap is never matched, and the search
  continues past it;
- if the named time does not occur inside the search horizon, the answer is
  `null` — no reset, no unattended resume, the operator decides.

The zone is an injected function so the rules can be pinned against a *stated*
zone rather than the test host's. `reportedResetAt` is written as an absolute
UTC instant; no wall-clock rendering reaches the durable contract.

**Rejected: reading `~/.codex/sessions` for the structured `resets_at`.** It is
another tool's private state directory, correlated to a run only by filename,
and it would buy an exactness the derivation already reaches to within a minute.

### 3. Give the review phase the checkpoint half of F-10

Classifying correctly is not enough, and this was found before the code was
written. `evaluateAutomaticResume` grants a resume only against an exact
`currentCommit` and `worktreeCleanAtCheckpoint === true`. A task arriving at
`REVIEWING` carries **neither** — the writing phase withdrew both, correctly,
and the hop into `REVIEWING` restores nothing. Without this, a codex quota block
would be correctly classified and permanently non-resumable: F-10 exactly, on
the phase F-10 could not reach.

`runReviewStep` therefore observes the worktree **before** the reviewer starts
and again after a recognised refusal, and mints a checkpoint only when the two
agree on a clean tree at one HEAD. The pair is the point: `--sandbox read-only`
is a request to the CLI, and `REVIEWING → SCOPE_VIOLATION` exists in the
transition table because the request can be refused. A reviewer that committed
would leave a clean tree at a *different* HEAD, and one after-the-fact
observation would settle it.

**And the withdrawal had to widen with it, which review found before this
shipped.** Once `REVIEWING` can *carry* a checkpoint, a resumed quota pause
arrives at `REVIEWING` holding `clean: true` at an exact commit. Until this
slice, `withdrawnCheckpointFor` withdrew nothing for a read-only phase, so a
*second* interruption that measured nothing — an auth failure, a malformed
transcript, a non-zero exit — would have re-asserted both claims over a tree the
reviewer may have dirtied. `reconcile.ts` reads that as `WORKTREE_DIRTY` /
`CURRENT_COMMIT_MOVED` → `RESUME_STATE_DIVERGED`, which nothing resumes and no
operator command clears: strictly worse than the `HUMAN_DECISION_REQUIRED` it
replaced.

The rule is therefore now **"an agent ran here"**, not "a writer ran here". The
old premise — the reviewer could not have changed the worktree — is a claim
about a sandbox this process does not enforce, and the field it read
(`mutatesRepository`) is gone. Nothing else read it. States that run no agent
are unaffected: `VERIFYING` is absent from the table and withdraws nothing.

`record-interruption.ts:settledCheckpointFor` lost its `phaseMutatesRepository`
condition. Its argument — that a `REVIEWING` checkpoint could only overwrite a
true one — was refuted by the very assertion that pinned it: the values it
protected were `null` and `false`, the two withdrawals. **No safety moved with
it.** What makes a checkpoint trustworthy is that it cannot be written down,
only minted from an observation, and that the mint has exactly one importer in
`src/`. Both are still pinned, and a forged artefact is still refused for the
review phase.

### 4. Give `BLOCKED_USAGE_LIMIT` an operator half

A block that records no reset instant cannot clear itself, and until this slice
nothing could move it: the two operator escapes are pinned by their first terms
to `BLOCKED_VERIFY` and `HUMAN_DECISION_REQUIRED`, and `AUTOMATIC_ALLOWED` is
unreachable without an instant. The task was **unrecoverable**.

Not a new hazard — the Claude writer has produced that shape since V3-11 — but
the reviewer's quota block used to land in the continuable
`HUMAN_DECISION_REQUIRED` and now lands here, so shipping decisions 1-3 without
this would have added a producer to a dead end. That is why it is in the slice
rather than after it.

`--continue-usage-limit`, the third of exactly the shape M1 built twice:
requires `--attended` and `--task`, refused under `--automatic-resume-only`,
absent from `agent-loop repositories`, spent on one departure per invocation. It
waits for nothing, retries nothing and schedules nothing; if the allowance is
still gone the next run reports a fresh block.

**The conjunct that makes it safe is `state.reportedResetAt === null`.** A
recorded instant — future or past — is not this door's business. Future means
the machine knows when the window returns; past is already
`evaluateAutomaticResume`'s to grant, and when that denies it denies on the
world, about which this decision holds no evidence. Without the conjunct an
operator flag would become a way to start a reviewer before its window
returned — the exact waste the other decisions exist to prevent — and it is
pinned in both directions: a future reset moves nothing and starts no process,
and a past one is measured being taken by the *automatic* path with the
operator's decision unspent.

One asymmetry the siblings did not need: `BLOCKED_USAGE_LIMIT` is the eligible
state, so a denied automatic resume classifies `AUTOMATIC_RESUME_REFUSED` ->
`BLOCKED`, which no grant permits. The operator's decision is therefore also a
disjunct at the continuation gate, expressed at the call site so that
`permitsContinuation` stays a pure function of the two vocabularies.

### 5. One machine, one login, one reviewer call at a time

Slice 5's bound is the Git common directory, because that is the lease's key.
The reviewer's quota is not scoped that way: `codex` reads its login from the
operator's home, so every repository on the machine reviews against one
subscription window. `registry/repository-registry.ts` already said so where it
bounds concurrency at 8; it had nothing to enforce it with.

`loop/reviewer-provider-gate.ts` is two rules:

1. one in-flight reviewer call per provider;
2. a provider known exhausted is not called again before its reset — the caller
   is handed the instant and parks, spending nothing.

Both are answered **inside** the exclusion, because asked outside it two callers
can both read "available" before either has run. The exclusion is a promise
chain, not a flag and a wait loop: nothing polls, nothing times out, and the
tail is advanced through a promise that cannot reject so one failure strands
nobody. The slot is released when the call settles — on the Windows launch
boundary, when the helper reports an ending, and `boundary/owned-command.ts`
guarantees the streams have closed on every ending that can name a verdict. The
one that cannot, `BOUNDARY_TERMINATION_UNCONFIRMED`, is a kill that failed after
a timeout; releasing there is deliberate, because the alternative is to deadlock
every later reviewer behind a survivor.

The state is **process-scoped and deliberately volatile**. A fresh process knows
nothing, which is correct: the durable record of what a run learned is the task
state it wrote.

## What this slice deliberately does not do

No persistent scheduler, background daemon, cron, recurring operation,
restart-safe timer or wake-up service. No notification delivery. No provider
account switching, quota purchasing, billing or cost optimisation. No
generalised or cross-machine rate limiting. No dependency, priority, concurrency
or lease redesign. No automatic merge. No new state, no new transition, no
schema change, and `TASK_STATE_SCHEMA_VERSION` is untouched.

Making a quota pause resume by itself after a process restart is M3 slice 1.
This slice's job is to make sure there is something correct for it to resume.

## The costs this buys, stated rather than discovered later

- **an interrupted review spends a reviewer call and no round.** `reviewRound`
  advances only on the write that leaves `REVIEWING` — correct, since an
  interrupted review reviewed nothing — so a quota block costs one call for no
  progress;
- **reviewer work inside a round is not reused.** A completed round is never
  repeated (its findings are in `findingHistory`), but a round interrupted
  mid-flight is redone from the start. Caching a partial review would mean
  trusting a transcript that never completed, which is the one thing
  `codex-review-transcript.ts` exists to refuse;
- **the gate is one process's.** Two `agent-loop` processes on one machine share
  the subscription and not the gate. Nothing in this build starts a second one,
  and the execution lease refuses two drivers on one repository, but two
  operators driving two registries would not coordinate;
- **a weekly-window exhaustion would derive too early.** Every recorded refusal
  named the 300-minute primary window. If the 7-day secondary window ever
  renders the same bare `H:MM`, the derived instant would be the next occurrence
  of that time rather than days out, and a resume would spend one call and
  re-park with a fresh instant. Bounded and self-correcting, and not fixable
  without a fixture nobody has;
- **a gate wait occupies an admission slot.** `repository-coordinator.ts` frees
  a slot when the admitted lifecycle settles, and a reviewer waiting on the gate
  is inside one — holding that repository's execution lease and owned-launch
  epoch. That is the exclusion's definition rather than a side effect, and under
  the condition the slice is about it makes the queue drain *faster*, because
  the first recognised refusal answers every later waiter from
  `availability` without spawning anything. At the default
  `maxConcurrentRepositories: 1` the gate is a no-op. Nothing becomes
  unrecoverable over a long wait: lease staleness is decided by owner liveness,
  not elapsed time;
- **two extra Git observations per review round.** One before the reviewer —
  on every round, not only on refusals — and, on a recognised refusal only, one
  after. Each `observeCompletion` is an `observeRuntime`, which is four
  read-only Git commands (`worktree list --porcelain`, `rev-parse`, `status
  --porcelain`, `merge-base --is-ancestor`), so this is roughly four to eight
  subprocesses added to a step measured in minutes;
- **a recognised refusal that names no time spends a reviewer call to learn
  nothing**, and is then an operator decision rather than a wait — see decision
  4. No recorded Codex message reaches it; all 51 carry a time;
- **the writer half of slice 5's cost is unchanged.** Nothing coordinates two
  writing agents against the Claude window. The default of
  `maxConcurrentRepositories: 1` is still what keeps that a choice.
