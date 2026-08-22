# Claude and Codex quota-reset evidence, measured

**Date:** 2026-08-22
**Machine:** Windows 10 Pro N 10.0.19045, Node v24.18.1
**Base:** `main` @ `661baf94b56c6e458345d930c692efd9617a0dd0`
**Question:** does an installed agent CLI supply trustworthy structured evidence
of an absolute quota-reset instant, in the output mode AO already consumes?
**Verdict:** `RESET_EVIDENCE_REQUIRES_OUTPUT_MODE_CHANGE`. The evidence exists
and AO cannot see it. L-V3-08-1 stays open.

This record exists because the repository's previous answer — "none was observed
in either CLI's output" — was measured against a *healthy* envelope only, and is
no longer precise enough to govern a decision. What follows is the structural
measurement that replaces it.

---

## Versions measured

```
claude --version   ->  2.1.239 (Claude Code)
codex  --version   ->  codex-cli 0.146.0
```

`codex` on `PATH` resolves to the native install at
`C:\Users\Max\AppData\Local\Programs\OpenAI\Codex\bin\codex`, not to the
`@openai/codex@0.147.0` npm package also present on the machine. The binary that
would actually run is the one measured.

`claude` resolves through `C:\Users\Max\AppData\Roaming\npm\claude` to the
native `bin\claude.exe` shipped inside `@anthropic-ai/claude-code@2.1.239`.

## AO's production output mode

`src/agent/claude-writer.ts` freezes the vector and takes no argv parameter, so
this is the only mode the writer can ever run in:

```
claude --print --output-format json --setting-sources "" --strict-mcp-config \
       --permission-mode acceptEdits --tools Read Edit Write Glob Grep
```

Prompt on stdin. **One JSON object on stdout.**

## Evidence tier, and where the reset instant actually lives

**Tier B — an authoritative schema belonging to the installed CLI, for a field
the installed CLI cannot emit in AO's mode.**

The measurement was taken from the shipped `bin/claude.exe` bundle, which
carries the CLI's own emitted-message schemas verbatim. Three findings, each
independently decisive.

### 1. An absolute reset instant exists, in a stream message

```js
kGb = ve(() => _e({
  type: kt("rate_limit_event"),
  rate_limit_info: wGb(),
  uuid: sd(),
  session_id: L()
}).describe("Rate limit event emitted when rate limit info changes."))
```

and `wGb`, the payload:

```js
_e({
  status:        Or(["allowed","allowed_warning","rejected"]),
  resetsAt:      Xe().int().optional(),
  rateLimitType: Or(["five_hour","seven_day","seven_day_opus",
                     "seven_day_sonnet","seven_day_overage_included","overage"]).optional(),
  utilization:   Xe().optional(),
  ...
})
```

**Field:** `rate_limit_event.rate_limit_info.resetsAt`
**Type:** optional integer
**Semantics:** absolute Unix epoch **seconds**, and this is proven rather than
assumed. The CLI mirrors the field into the `retry-after` header by subtracting
epoch-seconds-now from it:

```js
let r = Math.max(0, e.resetsAt - Math.floor(Date.now() / 1000));
this.headers["retry-after"] = String(r);
```

A value from which `Math.floor(Date.now()/1000)` is subtracted to yield a
seconds duration is an absolute instant in epoch seconds. A second, independent
site multiplies it back the other way to compare against a millisecond clock:

```js
function aJg(e) {
  return e.status === "rejected" && e.resetsAt !== void 0
      && e.resetsAt * 1000 <= Date.now();
}
```

Two derivations in opposite directions agree, so the unit is not inferred from
the field's name. It carries no timezone because epoch needs none — the instant
is unambiguous.

The field's origin is the `anthropic-ratelimit-unified-reset` response header,
read as `{ ...n && { resetsAt: Math.round(Number(n)) } }`.

Had this field been reachable, normalising it would have been representation
conversion and not estimation — `new Date(resetsAt * 1000).toISOString()` reads
no clock. That path stays available to a future slice.

### 2. AO's output mode discards it

The print-mode loop writes every message only under `stream-json`, and keeps
just the last one for `json`:

```js
if (c.outputFormat === "stream-json" && c.verbose) { await _.write(Ge) }
if (xqy(Ge)) { ... Fe = Ge ... }
switch (c.outputFormat) {
  case "json": if (!Fe || Fe.type !== "result") { ...error... }
```

The event is genuinely produced in print mode — the listener that builds it is
tagged `[print]` in its own error path and enqueues onto the same queue the pump
drains:

```js
let ur = xVr((Tr) => {
  try {
    let An = ZSn(Tr);          // builds the rate_limit_event
    if (!An) return;
    Ie.enqueue(An);            // the queue the print pump drains
    ...
  } catch (An) { E(`[print] rate_limit listener failed: ...`) }
```

So under `--output-format json` a `rate_limit_event` is generated, enqueued, and
never written to stdout. The output-format gate is the only thing standing
between AO and the field. Two further facts bound the alternative: `--output-format stream-json`
with `--print` **requires `--verbose`** —

```
Error: When using --print, --output-format=stream-json requires --verbose
```

— and the stream would arrive as JSONL, which the current whole-document reader
is built to refuse.

### 3. The `result` envelope carries no reset field, on either variant

Both variants of the terminal message, from the shipped schema:

*success*
`type, subtype:"success", duration_ms, duration_api_ms, ttft_ms?, ttft_stream_ms?,
time_to_request_ms?, user_message_uuid?, request_sent_wall_ms?,
time_to_request_from_spawn_ms?, warm_spare_claimed?, time_origin_ms?, is_error,
api_error_status?, num_turns, result, stop_reason, total_cost_usd, usage,
modelUsage, subagent_stats?, permission_denials, structured_output?,
deferred_tool_use?, terminal_reason?, fast_mode_state?, fast_mode_disabled_reason?,
origin?, uuid, session_id`

*error*
`type, subtype in {error_during_execution, error_max_turns, error_max_budget_usd,
error_max_structured_output_retries}, duration_ms, duration_api_ms, is_error,
num_turns, stop_reason, total_cost_usd, usage, modelUsage, subagent_stats?,
permission_denials, errors[], terminal_reason?, fast_mode_state?,
fast_mode_disabled_reason?, origin?, uuid, session_id`

No reset field, under any spelling, in either.

This closes a gap the repository had left open. The previous measurement
observed a *healthy* envelope and concluded no reset time was present. That
conclusion was right but under-argued — it could not distinguish "absent from
this run" from "absent from the contract". The schema answers the stronger
question. **A real 429 envelope cannot carry a reset instant either**, because
the field does not exist in the document type.

Two corollaries worth recording, since both were candidates:

- `terminal_reason: "blocking_limit"` is **not** a quota signal. It is the
  context-window limit — the CLI produces it when auto-compact reports
  `level === "blocked"`, and classifies it as `"context_limit"`.
- `api_error_status` — the field AO's classifier already reads — appears **only**
  on the `subtype:"success"` variant, and is read by the CLI itself only when
  `subtype === "success"`. AO's existing recogniser is aimed correctly. A quota
  refusal surfacing instead as `subtype:"error_during_execution"` would carry no
  `api_error_status` and would classify as `UNRECOGNISED`, not `USAGE_LIMIT`.
  That is fail-closed, and it is unchanged by this record.

### No side channel

`claude --help` lists no usage, quota, or limits command
(`agents, auth, auto-mode, doctor, gateway, import, install, mcp, plugin,
project, setup-token, ultrareview, update`). There is no benign second
invocation that would report a reset instant, and undocumented local account
state is not admissible evidence in any case.

## Codex — measurement only

`codex exec --json` prints events as JSONL. The installed 0.146.0 binary carries
these structures:

```
RateLimitWindow  { used_percent, window_minutes, resets_at }
TokenCountEvent  { info, rate_limits }
UsageErrorBody   { type, plan_type, resets_at }
```

So Codex does carry a structured `resets_at`. It is **not** ingested, and not
because of scope discipline alone:

1. AO has no positive Codex quota classifier at all. `runCodexReviewer` has no
   `USAGE_LIMIT` arm; an exhausted Codex allowance lands in
   `AGENT_NEEDS_ATTENTION` — a human decision. Building that classifier is a new
   blocking classification for another agent, which is a different product
   change with its own review.
2. The **units of Codex's `resets_at` are not established** by the installed
   binary. No doc comment, no epoch or second annotation, no arithmetic that
   pins it the way Claude's `retry-after` derivation pins `resetsAt`. On its own
   that is `EVIDENCE_CONTRACT_AMBIGUOUS` — not enough to grant automatic
   execution.

Recorded as a follow-up candidate, gated on both.

## What this does *not* unblock, even if the field were reachable

Ingesting a reset instant would not have made V3-08 fire for a Claude block. A
second, independent lock holds.

`recordAgentInterruption` spreads `...withdrawnCheckpointFor(current.state.state)`
after the reset time. Both Claude writer phases are mutating (`IMPLEMENTING`,
`REMEDIATING` -> `mutatesRepository: true`), so every `BLOCKED_USAGE_LIMIT`
production can create arrives with `currentCommit: null` and
`worktreeCleanAtCheckpoint: false`. `evaluateAutomaticResume` then denies
`CURRENT_COMMIT_MISMATCH` and `WORKTREE_NOT_CLEAN`, and the wait sleeps only
when the denial list is **exactly** `[RESET_TIME_NOT_REACHED]`:

```ts
if (denials.length !== 1 || denials[0] !== RESET_TIME_NOT_REACHED) { ... refuse ... }
```

Since the writer is the only agent that can produce a usage limit, the
intersection of "has a reset time" and "denial list is exactly
`[RESET_TIME_NOT_REACHED]`" is empty for every block production can create. This
is F-10, already carried in the README and deliberately not remediated. It is
recorded here so that a future reader does not mistake L-V3-08-1 for the last
thing standing between V3-08 and a real run.

## Limits of this measurement

- **No live 429 was observed.** Quota was not exhausted to manufacture one, by
  instruction. The claim about a real refusal rests on the shipped document
  schema, which is strictly stronger than a single observation but weaker than a
  measured refusal that contradicts it. If a 429 envelope is ever captured in
  the ordinary course of work, it belongs here.
- The Claude bundle is a compiled native binary. The schemas were read out of it
  verbatim, but identifiers are minified; the reading rests on the `.describe()`
  strings, the literal field names, and the arithmetic quoted above.
- `stream-json` was **not** exercised. That it carries `rate_limit_event` is read
  from the emission gate, not from a captured stream.
- Codex's `--json` event stream was likewise not exercised.
- No account-sensitive material was read, and none is recorded here. The
  structural example below is synthesised from the schema, not captured.

## Smallest structural example (synthesised from the schema, not captured)

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "rejected",
    "rateLimitType": "five_hour",
    "resetsAt": 1755856800
  },
  "uuid": "00000000-0000-0000-0000-000000000000",
  "session_id": "00000000-0000-0000-0000-000000000000"
}
```

## Commands used

All read-only. No agent request was made and no quota was spent.

```
claude --version
claude --help
codex --version
codex exec --help
grep -a ...  bin/claude.exe                          # shipped Claude bundle
grep -a ...  Programs/OpenAI/Codex/bin/codex
```

## What would close L-V3-08-1

Either of two decisions, each its own slice:

1. **Migrate the writer to `--output-format stream-json --verbose`** and read
   `rate_limit_event.rate_limit_info.resetsAt`. This is not a parser fix. It
   replaces a whole-document JSON contract with a JSONL stream contract, which
   changes what "the process ended under its own control and its output is
   complete" means, changes the truncation model, and needs its own boundary
   review.
2. **Accept an operator-supplied reset instant**, which changes the durable
   meaning of `reportedResetAt` from "reported by the CLI" to "reported by the
   CLI or asserted by a human", and needs a provenance decision.

Until one is taken, `reportedResetAt` stays `null` in production,
`evaluateAutomaticResume` denies `RESET_TIME_MISSING`, and the block waits for a
human. That remains the correct outcome for evidence AO cannot see.
