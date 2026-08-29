# ADR — the M1 release gate: the first complete delivery, and the verdict

- Date: 2026-08-29
- Status: **Accepted. M1 is closed: `M1_PASS` for attended use.**
- Slice: **19, the M1 release gate.** This record closes it. It is a gate, not a
  feature slice: it adds no product code and changes no behaviour.
- Supersedes nothing. **Amends two sentences in place** in
  `2026-08-23-adr-autonomous-delivery-m1.md` — see §8.

## 1. What this records

`2026-08-23-adr-autonomous-delivery-m1.md` wrote down a pipeline and twelve
invariants, and deliberately built none of it. Fifteen slices built it. Every one
of them was reviewed and merged on its own, and every one of them ended with the
same honest sentence: the chain had **never run end to end**. Seven residual ids
say so in as many words (`L-V4-05-6`, `06-7`, `09-7`, `10-10`, `11-8`, `12-9`,
`13-8`).

On 2026-08-29 it ran. This record is what was measured, what that establishes,
and what it still does not.

Everything below is read off durable artefacts — task state, the four delivery
documents, the reviewer's own transcripts, the GitHub API and the invocation
logs. Where a sentence could not be read off one of those, it is marked as not
established rather than reasoned into place.

## 2. The subject

Task `M1-RELEASE-009`, in this repository, against `github.com`.

| | |
| --- | --- |
| Base | `87e90bad5e5a700e8592f59e1505f512f2c34f7e` (PR #77) |
| Branch | `ao/task/M1-RELEASE-009` |
| Delivered commit | `7d4e0c3e27277f94bf69f00b6d7a8a0cfaf5fd47` |
| Merge commit | `ec974271ee423731b79692d384540814e6fe1fc0` |
| Pull request | #79 |
| Delta | **one new file**, `tests/fixture-template-cleanup-effect.test.ts`, 549 lines added, 0 removed |

The subject was chosen to sit inside the profile's `scope.allowedPaths`
(`[src, tests]`), because a writer that touches `README.md` or `docs/` reaches
`SCOPE_VIOLATION`, whose outgoing set is
`['HUMAN_DECISION_REQUIRED', 'ABORTED']` — it can never reach `READY_FOR_PR`, so
no such task could have run this gate at all.

## 3. The chain, as measured

All times UTC. Exit codes are the command's own
(`src/cli/run-exit-codes.ts`): `5` is `EXIT_RUN_CALL_AGAIN`, produced here by
`EFFECT_ATTEMPTED`; `2` is `EXIT_RUN_INPUT_UNUSABLE`, produced by
`DRIVE_NOT_COMBINABLE`; `3` is the escalation code.

| # | UTC | invocation | measured result | exit |
| --- | --- | --- | --- | --- |
| 1 | ~10:22 | `run --attended` | `STARTED`. Worktree and branch created from `87e90ba`. 11 steps. Ended `HUMAN_DECISION_REQUIRED` | — |
| — | 10:35 | review round 1 | `FINDINGS`: 2 × **medium**, `timeout.child-error-bypasses-grace`, `timeout.claims-unobserved-termination` | — |
| — | 11:03 | review round 2 | `FINDINGS`: 1 × **low**, `test.temp-root-leak-on-name-filter` | — |
| — | 11:28 | review round 3, attempt 1 | **not a review result.** The reviewer CLI returned `usage_limit_exceeded`, naming a reset at 17:35 local. The loop escalated | — |
| 2 | 15:40:59 | `run --attended` (resume) | `HUMAN_DECISION_REQUIRED`, **0 steps**, record untouched. Nothing could leave the state | 3 |
| — | 17:39:14 | PR #78 merged as `069de2e` | `--continue-human-decision` exists from here on | — |
| 3 | 17:39:41 | `run --attended --continue-human-decision` | 2 steps. Review round 3 re-ran → **`PASS`, no findings** → `READY_FOR_PR` at 17:39:47.931 | 0 |
| 4 | 18:47:11 | `delivery --drive --attended --publish-head` | one forge effect attempted, run stopped | 5 |
| 5 | 18:47:20 | same invocation again | `ALREADY_PUBLISHED` / `Attempt: NOT_ATTEMPTED`. Remote before: `AT_COMMIT 7d4e0c3` | — |
| 6 | 18:47:32 | `delivery --drive --attended --create-pr` | `CREATED`. `Forge before: NONE` → `Forge after: OPEN_ONE #79 (draft: false)` | 5 |
| — | 18:47:43 → 19:13:27 | CI on the exact head | `verify (windows, node 22)` **SUCCESS**, `verify (windows, node 24)` **SUCCESS** | — |
| 7 | 19:13:58 | `delivery --drive --attended --merge-pr` | Checks graded `SUCCESS` **at that exact commit**, then `MERGED`. `Forge after: MERGED ec97427`, *read back from the forge, not taken from the response*. GitHub records `mergedAt 19:14:05` | 5 |
| 8 | 19:14:27 | `--drive … --reconcile-merge --verify-merge --conclude-delivery` | **`DRIVE_NOT_COMBINABLE`.** Nothing contacted, nothing written | 2 |
| 9 | 19:14:55 | `delivery --drive --attended` | receipt `RECORDED`; verification `VERIFIED_PASS` in a detached checkout *proved to be at* `ec97427`; conclusion `CONCLUSION_RECORDED`; lease `RELEASED` → **`DELIVERY_CONCLUDED`** | 0 |

### The four documents this left on disk

Beside the task state, under the **repository root** — never the worktree:

```
.agent-orchestrator/runtime/delivery-merge/M1-RELEASE-009.json
.agent-orchestrator/runtime/delivery-verification/M1-RELEASE-009.json
.agent-orchestrator/runtime/delivery-conclusion/M1-RELEASE-009.json
.agent-orchestrator/runtime/M1-RELEASE-009.json          (state: READY_FOR_PR)
```

The conclusion carries both upstream bindings —
`receiptBinding 86eba4bd…`, `verificationBinding 7c530c6d…` — and its own
`binding 7405311b…`, so a conclusion names the exact two records it was built
from. The verification record holds one attempt, `VERIFIED_PASS`, `phasesRun: 2`,
against profile digest `12f6b83e…`.

## 4. What this run establishes that no earlier slice could

Each of these is a property of the **chain**, not of any one slice, which is
precisely why fifteen green slices could not establish it.

1. **Every act was performed by the product, each under its own flag, in its own
   invocation.** Publish, create, merge and conclude are four commands, and no
   invocation performed two forge mutations. Steps 4, 6 and 7 each stopped after
   one attempt with exit `5`.
2. **A combined invocation is refused, not accommodated.** Step 8 asked for
   reconcile + verify + conclude in one `--drive` and was refused
   `DRIVE_NOT_COMBINABLE` before contacting anything. That refusal is the
   authority model holding under an operator who was in a hurry.
3. **Re-invocation is the mechanism, not a workaround.** Nine invocations, each
   re-deriving its position from disk and the forge. The driver keeps no memory
   between runs, and step 5 shows the idempotence that makes that safe: the same
   command twice, the second one pushing nothing.
4. **The merge was gated on the check state of the exact delivered commit**, and
   the resulting commit was read back from the forge rather than trusted from the
   merge response.
5. **Post-merge verification ran the repository's own declared phases against the
   merge commit**, in a checkout proved to be at that commit — not against the
   branch, not against `main`, not against the worktree.
6. **An outside interruption did not corrupt the run.** The reviewer's
   subscription allowance ran out mid-round. The round was **not consumed**:
   after the operator's continuation, round 3 ran to a `PASS`. This is the first
   time the interruption and resume path has been exercised by the world rather
   than by a test.
7. **`READY_FOR_PR` stayed terminal throughout**, and the task's `currentCommit`
   is still the implementation head rather than the merge commit. Delivery
   happened entirely beside the state machine, which is the boundary
   `CLAUDE.md` demands.

### One honest gap in (1)

Step 4's output was captured through `tail -30`, so its own `Publication` line
was cut and the sentence *"`PUBLISHED` / `Attempt: COMPLETED`"* was **not
recorded**. What is recorded: the invocation exited `5`, which this build
produces only for `EFFECT_ATTEMPTED`; the session contains **no** manual
`git push` of `ao/task/M1-RELEASE-009` (the one manual push in the window names a
different branch); and 9 seconds later the ref was read at exactly `7d4e0c3`.
That is a strong chain and it is not the direct observation. Recorded as it is
rather than rounded up.

## 5. The twelve invariants, restated at HEAD (`ec97427`)

`[held]` means this build holds it on the acting path, not merely the reading
path. Where a half is open, the open half is named.

| # | Invariant | At HEAD |
| --- | --- | --- |
| 1 | A green check for an old head never authorises the current head | `[held]` — the merge in step 7 graded the checks of `7d4e0c3` and named that commit in the request |
| 2 | "A pull request exists" is not "mergeable" | `[held]` — no mergeability concept exists; existence and merge are separate acts under separate flags |
| 3 | "Mergeable" is not "CI passed" | `[held]` — the check grade is its own value and nothing combines it with anything |
| 4 | "CI passed" is not "review requirements passed" | `[held]` — **no review state is read, and none is implied.** See §8: the contract's own arrow claimed otherwise |
| 5 | A moved head invalidates evidence attached to the previous head | `[held]` — every act re-reads the subject and re-checks it after the answers return (`Local subject re-checked … UNCHANGED` appears in steps 5, 6 and 7) |
| 6 | Ambiguous or unavailable forge state fails closed | `[held]` — and measured in this run as `NO_CHECKS … This is not success` at step 5, which is the invariant refusing to read absence as permission |
| 7 | A merge observes the exact resulting commit, **returned by the operation and confirmed against the repository** | **`[held]` for the first half, `[open]` for the second.** The commit is read back from a fresh reading of the pull request. It is **not** confirmed locally: there is no `git fetch` anywhere in `src/`, deliberately. Carried as `L-V4-07-8` and `L-V4-09-3` |
| 8 | A successful merge API call is not completion | `[held]` — step 7 merged and step 9 concluded; they are different invocations, and the conclusion required a passing verification of the merge commit |
| 9 | Delivery authority is separate from execution authority | `[held]` — the profile declares the target; the acts each need their own flag |
| 10 | No repository gains delivery because AO can perform it | `[held]` |
| 11 | Existing execution guarantees do not widen | `[held]` — this gate changed no gate. The lease was taken only where verification needed it, and released |
| 12 | Delivery state survives restart where called durable | `[held]` — three records, each binding-sealed, each read back before the run moved on |

**Invariant 7 is the one open contract call in M1, and it is open by decision
rather than by omission.** Fetching is a local Git act the delivery slices do not
perform; M1 is attended at the merge step, so the operator's own checkout answers
the question. Ruling the other way costs one slice and changes nothing else.

## 6. The verdict

```text
M1 Release Gate: PASS for attended use.
The complete chain ran end to end, on a real task, against github.com:
  writer -> review round 1 -> remediation -> review round 2 -> remediation
         -> quota interruption -> operator continuation -> review round 3 PASS
         -> READY_FOR_PR -> publish -> pull request -> checks -> merge
         -> post-merge verification of the merge commit -> conclusion.
Eleven of twelve invariants held on the acting path.
Invariant 7 holds by half, and the open half is named (L-V4-07-8).
No M1_BLOCKER found.
Unattended operation remains unsupported: U1-U4 are unchanged by this gate.
```

### What the verdict does not say

- It is not a claim that `ec97427` is on `main` now, that it is still reachable,
  or that `main` passes today. Every record this run wrote says so itself.
- It is not a claim that AO merged **because** it was safe to merge in general.
  Draft status, mergeability, required reviews, branch protection and repository
  rulesets are **not observed by this build**, and their absence is not provable
  — the rule endpoints answer identically for "there are none" and "you may not
  read them".
- It is not a statement about a second repository. One repository, one task.
- It is not an unattended result. Every invocation carried `--attended`.

## 7. Residuals

### 7.1 One new residual

- **`L-M1-RG-1` — a task brief is clamped to 8192 UTF-8 bytes, and a task file
  the writer cannot open loses the remainder.** `MAX_TASK_BODY_BYTES = 8_192`
  (`src/plan/task-brief.ts`) clamps the task body before
  `buildImplementPayload` ever sees it. The prompt is honest about it — it
  appends *"[The task text above was truncated at the payload budget. Read the
  task file in the repository for the remainder.]"* — and that instruction is
  only actionable when the task file is **inside the worktree**. It was not here:
  every `M1-RELEASE-*` task file is excluded through `.git/info/exclude`, so it
  is untracked, absent from the worktree, and unopenable by the writer. A
  truncated brief would therefore have silently dropped acceptance criteria.

  **It did not happen in this run, and the margin was five bytes.** The gate
  task's body measures **8187** UTF-8 bytes after frontmatter and trim, against a
  ceiling of 8192, because the operator shortened it before the run. The proof
  above is therefore uncompromised, and the limit is recorded rather than
  discovered again later. Two independent repairs exist and neither belongs to a
  gate: raise or report the bound at the seam that clamps, or refuse a brief
  whose file the writer cannot reach.

### 7.2 One residual this gate did not create but did measure

- **`L-M1-HD-1` is now measured live, not only read.** It already says a reviewer
  quota block is not recognised as one: `AGENT_USAGE_LIMIT` has exactly one
  producer, `agent/claude-writer.ts`, and `agent/codex-reviewer.ts` has no path
  to it. This run is the first observation of that in the wild. The reviewer CLI
  reported `usage_limit_exceeded` **with a reset instant in the message**, the
  run diagnosed it as one of the fail-closed codes, and the task parked at
  `HUMAN_DECISION_REQUIRED` rather than `BLOCKED_USAGE_LIMIT` — with the reset
  time discarded although it was on the wire.

  **Attended, this cost one operator decision and no data.** Unattended it is
  fatal in the ordinary way: `--automatic-resume-only` can never apply to this
  state, so a scheduled run would stop and stay stopped. It is therefore **not**
  an M1 attended blocker, and it is a named prerequisite for any unattended
  build. No new id: the existing one is the right one, and duplicating it would
  make one defect look like two.

### 7.3 The six ADR-only ids

Measured, not estimated: the residual ids that appear in `docs/decisions/` and
**never** in `README.md` are exactly six.

| id | its ADR |
| --- | --- |
| `L-V4-03-7` | `2026-08-23-adr-durable-delivery-evidence.md` |
| `L-V4-03-8` | `2026-08-23-adr-durable-delivery-evidence.md` |
| `L-V4-05-10` | `2026-08-24-adr-delivery-head-publication.md` |
| `L-V4-15-9` | `2026-08-27-adr-publication-authorisation-listing.md` |
| `L-V4-15-10` | `2026-08-27-adr-publication-authorisation-listing.md` |
| `L-V4-15-11` | `2026-08-27-adr-publication-authorisation-listing.md` |

They are **not promoted into the README register here.** Naming them is what the
gate owes; deciding each one's disposition is six decisions, and a gate that
silently re-dispositions six residuals is doing the thing this repository keeps
finding in its own past work. They are recorded as *ADR-resident*, discoverable
from this table, and the next slice that touches each ADR's subject inherits it.

### 7.4 The two `--attended` claims that nothing enforces

Both are stated limits already; this gate names them together because the M1
verdict rests on the flag.

- **"An operator is present for this invocation" is satisfied by passing the
  flag.** `README.md`'s own grant table says so in the "How it is satisfied"
  column: *Passing the flag*. Nothing measures presence, and nothing can. The
  companion requirement — auth evidence — is deliberately the opposite shape: it
  is *produced* by a real preflight and carries a `#private` field so no object
  literal can claim it. The asymmetry is the design, not an oversight: a login
  can be proven, a human cannot.
- **The grant says nothing about what the operator decided.** `ATTENDED` is
  unconditional at `permitsContinuation`
  (`src/run/invocation-grant.ts`), which is exactly why continuing a blocked task
  needs its **own** request — `--remediate-verify-failure` and
  `--continue-human-decision` are separate predicates, each with its own bound
  and its own argument refusals. An ordinary `--attended` run over a repository
  full of blocked tasks must move none of them, and does not.

Consequence for this verdict, stated plainly: **`M1_PASS` is a pass for a mode
whose central premise is asserted rather than measured.** That is the meaning of
"attended", and it is why U1–U4 remain blockers for anything else.

## 8. The contract's own sentences, amended

`2026-08-23-adr-autonomous-delivery-m1.md` describes the eventual pipeline as

```
… -> PR -> CI -> review state -> remediation if required -> merge -> …
```

and lists, among the distinctions the vocabulary must draw, *"a review state
where the repository requires one"*.

**No slice implemented a review state, and none was going to.** Reading a
forge's review requirements means reading branch protection and repository
rulesets, and this build's own sentence is that those endpoints answer
identically for "there are none" and "you may not read them" — so a review state
derived from them would be a value that cannot distinguish absence from refusal.
Inventing one would have made invariant 4 false in the worst way: by giving
"review requirements passed" a representation that is sometimes a permission
error wearing a green label.

Both sentences are amended in place in that ADR, with the reason attached. The
arrow is removed from the pipeline and the distinction is struck from the list.
Invariant 4 is unchanged and is `[held]` for the reason it was always held: **no
review state is read, and none is implied.**

## 9. Next

M1 is closed. Nothing here opens M2 — the repository defines no second
milestone, and a milestone is a decision, not a leftover.

The three things a next decision would choose between, named without ranking:

- **Invariant 7's open half** — one slice, a local confirmation of the merge
  commit, and the only item inside M1's own contract still marked open.
- **`U1`–`U4`, and `L-M1-HD-1` with them** — the unattended prerequisites. The
  quota residual joins that list on the strength of this run rather than on
  reasoning.
- **A second repository.** Every measurement in this record was taken in the
  repository that contains the product. That is the strongest available proof of
  the chain and the weakest available proof of generality.
