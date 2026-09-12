---
id: REVIEW-INSTRUMENT-001
title: A reviewer whose mandatory instrument answered for another repository still produced findings
status: OPEN
kind: NORMAL
priority: HIGH
currentFocus: false
dependsOn: []
---

## 1. The one hard requirement, first

Four invariants. Nothing outside them is in this task.

1. The reviewer's CodeGraph preflight is **explicitly bound** to the task's actual
   worktree path.
2. The reviewer must **prove the returned graph belongs to that worktree** before
   relying on it.
3. If mandatory review instrumentation is unavailable, or answers for a different
   project, the review fails as an **instrument / review-execution failure**: **no
   finding** appended, **no review round** spent, nothing manufactured from prose.
4. **No** CodeGraph or MCP architecture redesign, and **no** AO lifecycle redesign.

## 2. Two things that make this task not ordinary

**Repair item 6 is outside this repository's own scope.** `repo-profile.yaml` declares
`scope.allowedPaths: [src, tests]`, so the required `README.md` edit is a scope refusal
and AO cannot drive this task to completion unattended as written. Split item 6 into an
operator commit. Do **not** silently widen `allowedPaths`.

**Invariant 2 stays prompt-level and AO-unverifiable.** AO parses only `turn.completed`
and `agent_message` from the reviewer transcript
(`src/agent/internal/codex-review-transcript.ts:282-313`), never MCP tool traffic, so it
cannot see that a call omitted `projectPath`. This repair makes the obligation *stated*
and the refusal *expressible*; it does not make compliance *measurable*. Say that in the
handoff, not the stronger thing. `ReviewFinding` (`:101`) also carries no provenance
field, so a finding made from prose stays byte-identical to one derived from source.

## 3. The measured incident

`healthapp/CAPTURE-003` round 2, 2026-09-12, codex session
`rollout-2026-09-12T15-43-03`, `cwd` = the CAPTURE-003 worktree. All six
`codegraph_explore` calls in that session tree **omitted `projectPath`** and were
answered from **AgentOrchestrator's** index. The reviewer correctly refused to
substitute `grep`, so it **never inspected CAPTURE-003 source** - and still emitted a
well-formed `FINDINGS` document. Two `high` findings taken from
`handoffs/latest-handoff.md` prose consumed round 2 of 2 and drove
`HUMAN_DECISION_REQUIRED`. A false escalation.

## 4. Root cause: two causes compose, and only the second is AO's

**Proximate, operator-side, already repaired.** `~/.codex/config.toml` pinned
`cwd = "D:\\AgentOrchestrator"` on `mcp_servers.codegraph`, so every call omitting
`projectPath` resolved AgentOrchestrator whatever the codex process's own directory
was. Removed 2026-09-12. **Do not re-fix this. It is outside AO.**

**AO's own root cause: the reviewer's contract makes the wrong answer the only
articulate one.** Two halves, both measured:

- AO tells the reviewer an index exists and **never which tree**. `codegraphLines`
  emits `status : INDEX_PRESENT` and no path
  (`src/loop/orchestrator-briefing.ts:155-158`); the payload's referents are deictic,
  "this repository" (`src/loop/findings.ts:139`) and "this worktree" (`:169`); and
  `buildReviewPayload` (`:133-137`) structurally **cannot** state a path, taking only
  `(brief, round, briefing)`. The incident's 8020-character payload held zero drive
  prefixes and zero occurrences of "HealthApp"; `projectPath` occurs **0 times** in
  `src/`, `tests/`, `docs/`, `README.md`.
- The reply contract offered **two verdicts and no third**:
  `"verdict": "PASS" | "FINDINGS"` (`src/loop/findings.ts:184`), enforced at
  `src/agent/internal/codex-review-transcript.ts:234`. Nothing can say "the review did
  not happen". The reviewer chose `FINDINGS`, and a well-formed `FINDINGS` document is
  `AGENT_COMPLETED` however it was obtained (`src/agent/codex-reviewer.ts:267-272`).

**One correction to the sizing.** An honest refusal is already *safe*, merely
*unnameable*: a non-conforming document becomes `AGENT_RESULT_MALFORMED`, then the
`if (!review.ok)` branch at `src/loop/loop-step.ts:1762`, which returns **before**
`appendFindings` (`:1784`) and the budget gate (`:1790`). Invariant 3 needs a **name and
a prompt asking for it**, not a new lifecycle path.

## 5. The repair boundary, smallest measured

1. **`src/loop/findings.ts:133-204`, load-bearing; every other item is inert without
   it.** (a) Take a fourth parameter `worktreePath` and state the absolute path in the
   opening lines, rendered through `lineSafe`
   (`src/loop/orchestrator-briefing.ts:36-40`). (b) Above `reviewerBriefingLines` at
   `:154`, in the head half so the tail clamp cannot cut it, insert a reviewer-only
   obligation: every code-intelligence call taking a project path is given **this** path
   as `projectPath`, and the returned symbols confirmed to come from this tree before
   being relied on. Gate the mandatory half on
   `brief.codegraph.requirement === 'REQUIRED'` (`src/plan/task-brief.ts:194`).
   (c) Add the third verdict to the quoted schema at `:184`, requiring an empty findings
   array, and amend `:202-203` so "anything else is unreadable" stops pushing a blocked
   reviewer toward `FINDINGS`. Fix the now-false comment at `:148-153`.
2. **`src/loop/loop-step.ts:1716`**: pass the path. One line; `authorisedWorktreePath`
   is destructured at `:1626` and already passed to `runCodexReviewer` at `:1714`.
3. **`codex-review-transcript.ts:110-114` and `:234`**: one new
   `CodexTranscriptVerdict` member, accepted only with an empty findings array. Keep
   `UNRECOGNISED` for genuinely malformed output; the two must not collapse.
4. **`src/agent/codex-reviewer.ts:267-268`**: one branch before the `!== 'REVIEWED'`
   line, returning `reviewFailure(evidence, <new>)`.
5. **`src/agent/agent-outcome.ts:34, :90, :109`**: one new `AgentFailureCode` with its
   own sentence, mapped to the **existing** `AGENT_NEEDS_ATTENTION` disposition. No new
   disposition, no new task state. Both records are total over the closed set, so the
   compiler forces all three edits together.
6. **`README.md:2582-2617`**, plus the twin at `:2568`: the review document's canonical
   text is the declared integration anchor (`codex-review-transcript.ts:33-39`), so
   prompt, parser and anchor must state one vocabulary.

## 6. Counter-proofs this task must carry

- Payload contains the absolute worktree path. **Fails today**: it cannot appear.
- Payload names the `projectPath` obligation when the capability is `REQUIRED`, not
  when `OPTIONAL`.
- A transcript carrying the new verdict yields `ok:false` with the **new** code, not
  `AGENT_RESULT_MALFORMED`; and at `round === reviewBudget` it leaves `findingHistory`
  **and** `reviewRound` unchanged. The incident, inverted.
- **Mutant:** revert only `codex-review-transcript.ts:234` - the no-findings test still
  passes and only the code assertion fails, so items 3-5 buy *diagnosis fidelity*, not
  safety. **Mutant:** delete the third verdict from the quoted schema only - parser
  tests all still pass, so that branch is dead without the prompt half.
- No regression: ordinary `FINDINGS` still appends and spends a round, ordinary `PASS`
  still reaches `READY_FOR_PR`, and `tests/codex-reviewer.test.ts:667` (the argv
  equality pin) passes **untouched** - it keeps this repair out of the MCP config.

## 7. Explicitly out of scope

- `src/agent/mcp-capability-preflight.ts` in every form. Its grant has two consumers,
  both the **writer**; this agent was codex. Also impossible at its first call site:
  `src/run/lifecycle-driver.ts:886` runs before `startTask` (`:894`) makes the worktree.
- `-C/--cd <worktree>` on `CODEX_REVIEWER_ARGS`. Measured no-op:
  `src/agent/codex-reviewer.ts:213` already passes `request.worktreePath` as child `cwd`.
- An AO-owned MCP config for the reviewer. Measured on CLI 0.146.0: `codex exec --help`
  has no `--mcp-config` and no `--strict-mcp-config`. Unimplementable, not unverified.
- `-c mcp_servers.codegraph.cwd=<worktree>` on the reviewer argv. Premises measured,
  end-to-end effect **not** measured, and keyed on a server name in an operator file AO
  never reads. A separate decision.
- Extending `codegraphLines` or `OrchestratorBriefing`: shared with the writer payload,
  which `tests/m8-01-verification-truth.test.ts:400` pins.
- How a state derives its operator reason (`task-attention.ts:259`).
