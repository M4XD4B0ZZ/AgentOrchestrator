# Claude and Codex quota-reset evidence, measured

**Date:** 2026-08-22
**Machine:** Windows 10 Pro N 10.0.19045, Node v24.18.1
**Base:** `main` @ `661baf94b56c6e458345d930c692efd9617a0dd0`
**Question:** does an installed agent CLI supply trustworthy structured evidence
of an absolute quota-reset instant, in the output mode AO already consumes?
**Verdict:** `RESET_EVIDENCE_REQUIRES_OUTPUT_MODE_CHANGE`. The evidence exists
and AO cannot see it. L-V3-08-1 stays open.

> **Addendum, same day — the output mode was changed, and the stream was
> captured.** V3-11 took decision 1 below. The section
> **"Addendum: the stream, exercised"** at the end of this record supersedes the
> "`stream-json` was **not** exercised" limit, corrects nothing above, and adds
> one finding the schema could not have given: the event arrives on healthy runs
> too.

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

1. ~~AO has no positive Codex quota classifier at all. `runCodexReviewer` has no
   `USAGE_LIMIT` arm; an exhausted Codex allowance lands in
   `AGENT_NEEDS_ATTENTION` — a human decision.~~ **Closed by M2 slice 6** —
   `src/agent/internal/codex-quota-signal.ts` reads the refusal off a
   `turn.failed` message and derives the instant from the time of day it names.
   Bullet 2 below is likewise superseded: `resets_at` was measured as unix
   seconds, and is not on the `codex exec --json` wire at all, which is why the
   message is read instead. Building that classifier is a new
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

Since the writer was, at the time of this measurement, the only agent that could
produce a usage limit, the intersection of "has a reset time" and "denial list is
exactly `[RESET_TIME_NOT_REACHED]`" was empty for every block production could
then create. That was F-10, and it is recorded here so that a future reader does
not mistake L-V3-08-1 for the last thing standing between V3-08 and a real run.

**Both halves have since closed, and the intersection is no longer empty.** V3-10
settles a quota-interrupted writer to a measured checkpoint; M2 slice 6 does the
same for the reviewer and gives it a quota classifier of its own. On both paths
the denial list is now exactly `[RESET_TIME_NOT_REACHED]`, which is the list the
wait sleeps on. The `mutatesRepository` field this paragraph cites no longer
exists: the checkpoint rule asks whether an *agent* ran, not whether it wrote —
see `core/agent-phases.ts`.

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

---

# Addendum: the stream, exercised

**Date:** 2026-08-22, later the same day
**Machine:** unchanged
**Base:** `main` @ `5dc386b7e3ece3fad1677a90f11676a3084bc6e9` (V3-10 merged)
**Question:** the record above closes with "`stream-json` was **not**
exercised". What does the stream actually contain?
**Verdict:** `RESET_EVIDENCE_REACHABLE`. Decision 1 was taken; L-V3-08-1 is
closed by V3-11.

## What was run

The production vector, with the one token changed, in a throwaway directory
outside any repository. Read-only prompt; no file was written.

```
printf 'Reply with exactly the word: ok' | claude \
  --print --output-format stream-json --verbose \
  --setting-sources "" --strict-mcp-config \
  --permission-mode acceptEdits --tools Read Edit Write Glob Grep
```

`--verbose` is mandatory rather than preferred, and that was measured directly
rather than read off the bundle this time. The same vector without it:

```
Error: When using --print, --output-format=stream-json requires --verbose
```

Removing that flag does not fall back to the old mode; it stops the writer from
starting.

Exit 0. **stdout 4741 bytes, stderr 0 bytes.** Four lines, newline-terminated:

```
0  system     init      1741 B
1  rate_limit_event      305 B
2  assistant             733 B
3  result     success   1958 B
```

## Finding 1 — the event arrives on a healthy run

This is the finding the shipped schema could not have given, and it changed the
design.

```json
{ "status": "allowed",
  "resetsAt": 1787418000,
  "rateLimitType": "five_hour",
  "overageStatus": "rejected",
  "overageDisabledReason": "out_of_credits",
  "isUsingOverage": false }
```

Nothing was refused. The run succeeded, `api_error_status` was `null`,
`stop_reason` was `end_turn` — and a `resetsAt` was still reported, for the
window that was still open.

So **`resetsAt` is not evidence that anything was refused.** A reader taking the
last one it saw would attach a reset instant to every completed pass, and — since
`rateLimitType` has six members — would happily pair a five-hour window's reset
with a seven-day exhaustion, authorising a resume days early. V3-11 therefore
reads only `status: "rejected"`, and attaches the result only to a positively
recognised `USAGE_LIMIT` verdict.

Three fields in that payload (`overageStatus`, `overageDisabledReason`,
`isUsingOverage`) are absent from the schema quote above, which is why the
reader ignores everything it does not name.

## Finding 2 — the unit, now observed as well as derived

`1787418000` is `2026-08-22T17:00:00.000Z`. The capture was taken at
`12:19Z`. A five-hour window resetting on the hour is what epoch **seconds**
predicts; no other unit puts it anywhere plausible. The bundle's two arithmetic
derivations already said this, and they now agree with an observation instead of
only with each other.

## Finding 3 — the CLI states the authority it granted

The `init` message carried, verbatim:

```
tools:          ["Edit","Glob","Grep","Read","Write"]
mcp_servers:    []
permissionMode: "acceptEdits"
```

Those are exactly the three hermeticity claims `CLAUDE_WRITER_ARGS` makes,
stated by the CLI rather than inferred from behaviour — including
`--strict-mcp-config` doing its job, which had previously been measured only as
"no MCP tool appeared in `permission_denials`". Nothing reads this yet
(**L-V3-11-1**).

`memory_paths`, `skills`, `slash_commands` and `agents` were **not** empty. That
is not a contradiction of `--setting-sources ''`: `--tools` grants five tools,
none of which can invoke a skill, a slash command or a subagent, and
`memory_paths` names a directory rather than loaded content. Recorded because it
looks like a finding and is not one.

## What this does not establish

- **No 429 was observed.** Quota was not exhausted to manufacture one. That a
  refusal emits `status: "rejected"` with a `resetsAt` is read from the shipped
  schema and from the CLI's own `status === "rejected" && resetsAt * 1000 <=
  Date.now()` helper, not from a capture. **If it does not,** the outcome is
  `reportedResetAt: null` → `RESET_TIME_MISSING` → a human decision, which is
  the pre-V3-11 behaviour: the failure mode of this assumption being wrong is
  the status quo, not a regression.
- **One prompt, one turn.** No tool call was made, so no `user`/tool-result
  message appears in the capture and the transcript's size under real work is
  unmeasured. That is what **L-V3-11-2** carries.
- **Codex was not re-measured.** Both gates on it are unchanged.

## Commands used

Read-only apart from the single agent turn above, which spent one short request
against the operator's subscription. No account-sensitive material is recorded
here: `utilization` and any usage figures were not transcribed, and the
`session_id`/`uuid` values were not.
