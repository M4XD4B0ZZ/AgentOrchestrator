# Verification truth, the tree a capability is judged in, and an ending an operator owns

**Date:** 2026-09-04 · **Status:** accepted, implemented by M8.

One task produced this slice. `RESOLVER-V3-054`, a real task in a real
repository driven by this build, burned all three of its review rounds and
escalated on a finding the reviewer was right to raise every time —
`verification.blocking-checks-not-passed`.

**Verification had passed. Twice.**

## The sentence this slice is answerable for

> Verification truth is explicit evidence tied to the worktree state. Never prose
> in the tree, never an inference from a state the task happens to be in.

## The defect, measured before anything was changed

Measured on `main @ a3779f6` against the incident's own durable state and
transcripts:

| Fact | Measured |
| --- | --- |
| `buildReviewPayload` carries a verification status | no — task body, context paths, reply schema, nothing else |
| a pass is recorded anywhere | no — `runVerifyStep` advances to `REVIEWING` and drops the report |
| a pass is inferable from the state | no — `REVIEWING` is reachable from `HUMAN_DECISION_REQUIRED` and `BLOCKED_USAGE_LIMIT`, and a resume clears the resume point |
| what the reviewer could read instead | a handoff sentence from an earlier writer saying `verify` exited 1 — stale prose about a commit that no longer existed, and a declared context source |
| what the writer could do about it | nothing: `--tools Read Edit Write Glob Grep`, no shell |
| findings that demanded a command | 3 of 5 (`npm run verify`, `git status`, `codegraph init`) |
| `.codegraph` in the worktree the writer opened | absent in 12 of 12 worktrees, while present at the root AO probed |
| a way to end the task once it was delivered by hand | none — nothing in `src/` writes `ABORTED`, and `READY_FOR_PR` is withheld from `HUMAN_DECISION_REQUIRED` |

## The decision, in four parts

### 1. A pass is a durable record, in its own store

`<runtime>/verification-passes/<taskId>.json`: one document per task,
latest-wins, carrying an instant, the subject commit, the profile digest and one
entry per passing phase (`phase` from the closed enum, `exitCode: 0`,
`outputTruncated`, `durationMs`). No excerpt, no command tokens, no paths — on a
pass `runVerification` returns `NO_DIAGNOSTICS`, so there is no foreign text to
carry.

**Not** an entry in the failure history: that store is bounded at six attempts
and *refuses* the seventh rather than evicting, and `runVerifyStep` reads that
refusal as a reason not to write `BLOCKED_VERIFY` at all. Spending it on passes
would let a task that passed six times become one whose next genuine failure
cannot be recorded. **Not** a field on `TaskState`, which is `.strict()` and
whose strictness two module headers cite as the reason process results are not
persisted on it.

The pass is written **before** the advance and the advance does not depend on it:
the opposite ordering from the failure path, deliberately, because good news that
could not be filed must never turn a passing gate into a stopped task.

### 2. What a reader gets is a five-member statement, not a boolean

`PASSED_ON_THIS_TREE`, `FAILED_ON_THIS_TREE`, `PASSED_ELSEWHERE` (naming which of
the commit or the profile differed), `NOT_OBSERVABLE`, `NOT_MEASURED`. A failure
for the same commit outranks a pass unless the pass is *provably* newer; an
unorderable pair resolves to the failure.

Worktree cleanliness is reported and is **not** in the predicate. A passing gate
routinely leaves untracked output behind, and `--untracked-files=normal` then
calls the tree dirty — a predicate demanding cleanliness would degrade the
ordinary passing path to "not on this tree", reproducing the incident with the
fix as its cause.

### 3. AO delivers the diagnostics unasked; the writer still has no shell

Every agent briefing opens with what this orchestrator measured: the verification
statement, the CodeGraph status of *its* worktree, and the paths the task has
changed as the scope guard measured them. No request channel, no marker protocol,
no second launch, no new argv token. The facts are ones the loop already produced
for its own purposes.

The rejected shapes, each on measured grounds:

| Shape | Why not |
| --- | --- |
| a Bash allow-list for the writer | `Bash(npm run verify)` cannot pass `SAFE_ARG_PATTERN` (no space, no parenthesis); the settings-file route differs between safe and unsafe by two characters; and anything spawned in the writer's session inherits `HOME`/`USERPROFILE`, where the subscription login lives |
| an AO-provided MCP server | the grant would be **self-issued**, and M5's whole safety argument is that the operator supplies the command and the repository supplies one word |
| a writer request channel with a re-launch loop | three extra failure windows between `writer.ok` and `commitPassOrPark`, a lost permission-denial observation, and an answer the payload clamp can delete |
| re-verifying at every writer start | up to 8 phases × 30 minutes, and it would make a writing step run verification — a property this build states in source and pins in tests |

### 4. `OPERATOR_RESOLVED`, and only from two states

A third terminal state, written only by `agent-loop resolve --attended --task
<id>`, and only out of `HUMAN_DECISION_REQUIRED` or `BLOCKED_VERIFY`. It claims
one thing: a person ended this task. Its provenance —
`operatorResolution.closedFrom` — is taken from the record the command read, and
the contract makes the state and the provenance biconditional.

Rejected, each measured:

| Alternative | Why not |
| --- | --- |
| reuse `ABORTED` | `block-ledger.ts` reads it as *given up on*, `abandonBlockTask` records `ABANDONED`, and `COMPLETE` then makes the block permanently uncompletable |
| an edge to `READY_FOR_PR` | the table withholds it from `HUMAN_DECISION_REQUIRED` on purpose; its invariants demand a review round, a resolved commit and a clean checkpoint; and delivery would open a pull request for work a human already delivered |
| an `<id>.acknowledged` file in the attention store | silences the notification while the task stays blocked for ever — the escape hatch, exactly |
| require a `--delivered-commit` | `rev-parse --verify` exits 0 for any 40-hex string; the peeled spelling cannot be spawned by this build; AO does not fetch, so an honest operator often has no local commit. A guard that refuses truthful closures and admits fabricated ones is worse than none |
| a fourth conjunct on `run` | `run`'s ladder puts an auth preflight, an MCP preflight and a full reconciliation in front of the write, and each refuses in exactly the situation this exists for |
| `settleAttention` from the closure | it also *raises* records for every attention-worthy task in the repository, and it settles only where the whole scan succeeded. Removal by id is deterministic and touches nothing else |

The block ledger gained a matching disposition, `RESOLVED`, and it is not
optional: `firstUnprovenClaim` re-proves **every** entry on any write that moves a
disposition, so a `BLOCKED` entry whose record became terminal would freeze the
whole run — no settle, no park, no abandon, no progress-claiming stop.
`COMPLETE` accepts `RESOLVED` beside `SETTLED`.

## Capability provisioning: the orchestrator's job, the operator's command

The corrected probe alone would make every `codegraph: REQUIRED` repository
permanently unrunnable, because `git worktree add` cannot produce an ignored
directory. So AO prepares the index itself — once per invocation, in the
worktree, only when the profile requires it, only when the index is absent, only
when Git ignores the artefact *in that tree*, and only with a command the
**operator** declared in `mcp-capabilities.yaml` under `capabilities.codegraph.prepare`.

Not the repository, which would be a repository choosing what this machine runs.
Not the writing agent, which would let it mint the proof of the capability AO
fails closed on. The result is measured by probing the directory afterwards,
never taken from an exit code.

## What this slice deliberately does not do

- it grants the writer no tool it did not have, and changes `CLAUDE_WRITER_ARGS`
  by not one token;
- it starts no verification inside a writing step. Where no evidence matches the
  tree, the briefing says `NOT MEASURED` rather than paying for a fresh run;
- it opens no pull request from an operator-ended task, and mints no
  `DeliveryConclusion` from an operator's word;
- it does not unblock a *dependent* task: `chain-fitness.ts` still requires a
  predecessor `SETTLED`. An operator's word unblocks the ledger, not the next
  task's start.

## The costs, stated rather than discovered later

- **A new terminal state and a new field, at contract version 1.** Additive and
  defaulted, on the `scopeAuthorityCommit` precedent. An older build meeting
  either fails closed — but as `CONTRACT_VIOLATION`, i.e. reported as a broken
  record rather than as a version boundary. That is the price of not forcing a
  migration on every existing state file, and it is a real one.
- **A remediation payload is no longer byte-identical across two runs.** The
  briefing carries measured facts — an instant, a commit, a path set — so two
  runs that measured different trees are briefed differently. The determinism
  claim is narrowed in source rather than left standing, and the boundary case
  that pinned byte equality now pins it from the findings heading down.
- **Two store reads and one Git observation per writing step.** Cheap, and paid
  every time; the alternative was an agent asking, which costs a launch.
- **A repository whose worktrees cannot carry an index and whose operator names
  no `prepare` command parks every task.** That is the fail-closed answer and it
  is visible: the run report prints `CodeGraph index : NO_OPERATOR_COMMAND` and
  says what to do about it.
