/**
 * Reading a Codex quota refusal off `codex exec --json`.
 *
 * INTERNAL, for the reason `claude-result-stream.ts` and
 * `codex-review-transcript.ts` both give: this reads foreign text, and a caller
 * holding it could ask "does this look like a quota block" without any of the
 * process-level facts that make the question answerable.
 *
 * ── Evidence baseline (measured on this machine, 2026-09-02) ───────────────
 *
 * `codex --version` → `codex-cli 0.146.0` — the same build that produced every
 * recorded incident quoted below.
 *
 * **1. What the wire carries.** A failing run was forced (`-m
 * definitely-not-a-real-model-xyz`) and printed, on stdout, one JSON object per
 * line, ending:
 *
 *     {"type":"error","message":"{\"type\":\"error\",\"status\":400,…}"}
 *     {"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,…}"}}
 *
 * with exit status 1. `turn.failed` is the CLI's terminal failure event —
 * `codex.exe`'s own `ThreadEvent` string table pairs `TurnFailed` with
 * `turn.failed`, next to `turn.completed`, `item.completed` and the rest of the
 * vocabulary `codex-review-transcript.ts` already reads.
 *
 * **2. The structured category is NOT on the wire.** That same run's rollout
 * (`~/.codex/sessions/2026/09/02/rollout-…-01a06013-….jsonl`) recorded
 * internally
 *
 *     "error": { "message": "{…400…}", "codex_error_info": "other" }
 *
 * while stdout printed `{"error":{"message":…}}` and nothing else. So
 * `codex_error_info` — whose closed vocabulary in the binary includes
 * `usage_limit_exceeded`, `unauthorized`, `bad_request`, `server_overloaded` —
 * is an *internal* field of the app-server protocol. The only quota signal a
 * boundary reading `codex exec --json` can see is the failure **message text**.
 *
 * That is why this reader matches prose. It is not the only place that does —
 * `deliver/forge-observation.ts` reads GitHub's "No commit found for SHA"
 * sentence the same way and for the same reason, and scopes its own uniqueness
 * claim to that one transport, which is the honest form of the sentence.
 * `claude-result-stream.ts` reads an HTTP status because
 * one is offered; here none is, and the alternative to a narrow anchored match
 * is not a stronger signal but no signal at all — which is the state this module
 * replaces, in which a Codex quota block became `HUMAN_DECISION_REQUIRED` and
 * ended the task.
 *
 * **3. The one real message, 51 recorded occurrences.** Every
 * `codex_error_info: "usage_limit_exceeded"` error across
 * `~/.codex/sessions/**`, all from sessions whose `originator` is `codex_exec`
 * at `cli_version 0.146.0`, is one template with four different times:
 *
 *     You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro),
 *     visit https://chatgpt.com/codex/settings/usage to purchase more credits or
 *     try again at 5:35 PM.
 *
 * (one line on the wire; an ASCII apostrophe; times seen were 10:33 PM, 5:25 PM,
 * 5:35 PM and 9:25 PM).
 *
 * **4. The named time is the local rendering of the structured reset.** Each
 * incident's message was cross-checked against the last `token_count` event in
 * the same rollout, which carries `rate_limits.primary { used_percent,
 * window_minutes, resets_at }` with `resets_at` in unix seconds:
 *
 *     msg='10:33 PM' resets_at=1787949208 → 2026-08-28T20:33:28Z  local 10:33 PM  window 300 min
 *     msg='10:33 PM' resets_at=1787949209 → 2026-08-28T20:33:29Z  local 10:33 PM  window 300 min
 *     msg='5:25 PM'  resets_at=1787930737 → 2026-08-28T15:25:37Z  local  5:25 PM  window 300 min
 *     msg='5:35 PM'  resets_at=1788017730 → 2026-08-29T15:35:30Z  local  5:35 PM  window 300 min
 *     msg='9:25 PM'  resets_at=1788204324 → 2026-08-31T19:25:24Z  local  9:25 PM  window 300 min
 *
 * Five out of five. Three facts follow, and {@link deriveResetInstant} is built
 * out of exactly them:
 *
 *  - the rendering zone is the **process's local zone**, not UTC and not a
 *    fixed offset. Resolving the named time in local time is therefore reading
 *    the provider's own units, not guessing at them;
 *  - every observed exhaustion was the **primary** window, `window_minutes:
 *    300`. A named time is at most five hours away, which is why a bare `H:MM`
 *    is a complete answer at all and why the search below is bounded by a day;
 *  - **seconds are truncated** — `…:30` renders as `5:35 PM` — so a derived
 *    instant taken at `:00` would be up to 60 s *early*. It is rounded up to the
 *    end of the named minute instead. Late is a longer wait; early is a wasted
 *    call.
 *
 * `rate_limits` itself is not on the `codex exec --json` wire. Reading
 * `~/.codex/sessions` to recover it was considered and rejected: it is another
 * tool's private state directory, correlated to a run only through a file name,
 * and coupling a product contract to it buys an exactness the derivation below
 * already reaches to within one minute.
 */

/** The reset the provider named, as it appears in the message. */
export interface ReportedResetTimeOfDay {
  /** 0–23, converted from the 12-hour rendering. */
  readonly hour: number;
  /** 0–59. */
  readonly minute: number;
}

export interface CodexQuotaRefusal {
  /**
   * `USAGE_LIMIT` only for the positively recognised template. Everything
   * else — an unrecognised failure, an absent transcript, a message this reader
   * has never seen — is `NONE`, and the caller's existing fail-closed codes
   * apply unchanged.
   */
  readonly verdict: 'USAGE_LIMIT' | 'NONE';
  /**
   * The time of day the refusal named, or `null` when it named none.
   *
   * Independent of the verdict, deliberately. A recognised refusal without a
   * usable time is still a recognised refusal: the task is a quota pause, it
   * simply has no instant to wait for, which is exactly the `PREFERRED` shape
   * `resume-policy.ts` already describes for `reportedResetAt`.
   */
  readonly resetTimeOfDay: ReportedResetTimeOfDay | null;
}

const NO_REFUSAL: CodexQuotaRefusal = Object.freeze({
  verdict: 'NONE' as const,
  resetTimeOfDay: null,
});

/**
 * The sentence that *is* the recognition.
 *
 * A prefix rather than a search: the message must **begin** with it. A
 * substring test would recognise a quota block in any failure that happened to
 * quote one — including a reviewer's own prose about this very module, which is
 * a file the reviewer reads.
 */
const USAGE_LIMIT_PREFIX = "You've hit your usage limit.";

/**
 * The reset, read only from the end of the message.
 *
 * Anchored at `$` for the same reason the prefix is anchored at the start: the
 * time is the last thing the template says, and a floating match would take the
 * first `H:MM AM/PM` in whatever else a future message put in front of it.
 * JavaScript's `$` without `m` matches end of input only — never before a
 * trailing newline — so the anchor means here what it appears to mean.
 */
const RESET_SUFFIX_PATTERN = / or try again at (\d{1,2}):(\d{2}) (AM|PM)\.$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the message of the **last** `turn.failed` event, or `null`.
 *
 * The last, not the first, for the reason `readCodexTranscript` takes the last
 * agent message: a stream may carry more than one, and the one that ended the
 * run is the one that says why it ended.
 *
 * A malformed line is skipped rather than fatal — the CLI is entitled to emit
 * event kinds this reader has never seen. Only a top-level object whose `type`
 * is exactly `turn.failed` is read, so an agent's own words can never be one:
 * they arrive inside `item.completed`'s `item.text`, JSON-escaped, on a line
 * whose `type` is something else.
 */
function readTurnFailureMessage(stdout: string): string | null {
  let message: string | null = null;

  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isPlainObject(event)) continue;
    if (event['type'] !== 'turn.failed') continue;

    const error = event['error'];
    if (!isPlainObject(error)) continue;
    const reported = error['message'];
    if (typeof reported === 'string') message = reported;
  }

  return message;
}

/**
 * Reads a Codex quota refusal off the transcript, positively or not at all.
 *
 * The caller must already have established that the process ended under its own
 * control. This reads bytes, and bytes from a process that was killed are not a
 * verdict — the rule `agent-outcome.ts:endedUnderOwnControl` exists to state.
 */
export function readCodexQuotaRefusal(stdout: string): CodexQuotaRefusal {
  const message = readTurnFailureMessage(stdout);
  if (message === null || !message.startsWith(USAGE_LIMIT_PREFIX)) return NO_REFUSAL;

  const named = RESET_SUFFIX_PATTERN.exec(message);
  if (named === null) {
    return Object.freeze({ verdict: 'USAGE_LIMIT' as const, resetTimeOfDay: null });
  }

  const hour12 = Number(named[1]);
  const minute = Number(named[2]);
  const meridiem = named[3];

  // A 12-hour clock has no hour 0 and no hour 13. The pattern admits both, so
  // they are refused here rather than folded into something plausible: a message
  // this reader cannot read exactly is a message it reports no time for.
  if (hour12 < 1 || hour12 > 12 || minute > 59) {
    return Object.freeze({ verdict: 'USAGE_LIMIT' as const, resetTimeOfDay: null });
  }

  const hour = meridiem === 'AM' ? hour12 % 12 : (hour12 % 12) + 12;
  return Object.freeze({
    verdict: 'USAGE_LIMIT' as const,
    resetTimeOfDay: Object.freeze({ hour, minute }),
  });
}

/**
 * The local UTC offset in minutes at an instant, as `Date` reports it.
 *
 * A seam, and not for convenience: the derivation below is a statement about a
 * timezone's rules — including the hour that repeats when a fold ends daylight
 * saving — and a test that cannot choose the zone can only assert the
 * derivation against the zone it happens to run in. `process.env.TZ` is not that
 * seam: Node caches the resolved zone, and a test that mutates it is asserting
 * against the host's ICU data rather than against a stated rule.
 *
 * Positive west of UTC, exactly like `Date.prototype.getTimezoneOffset` — so
 * `local = utc - offset` — because a second sign convention in the same file is
 * a defect waiting for its first daylight-saving boundary.
 */
export type LocalOffsetMinutes = (epochMs: number) => number;

/** The process's own zone. The production {@link LocalOffsetMinutes}. */
export const systemLocalOffsetMinutes: LocalOffsetMinutes = (epochMs) =>
  new Date(epochMs).getTimezoneOffset();

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * How far the scan may walk before giving up.
 *
 * A **termination guard**, not a claim about the answer. Every measured refusal
 * named the 300-minute primary window, so a correct derivation is at most five
 * hours out; this bound only decides how long a *wrong* input is searched for
 * before the answer becomes `null`.
 *
 * Twenty-six hours rather than twenty-four, and the two extra are load-bearing.
 * A calendar day is not 24 hours: it is 23 on a spring-forward and 25 on a
 * fall-back, and a wall clock inside the spring-forward gap does not occur that
 * day at all — its next occurrence is 24.5 hours out, which a 24-hour horizon
 * misses. That case is not hypothetical; it was measured against a synthetic
 * zone in `tests/m2-06-reviewer-quota-resilience.test.ts` and returned `null`
 * until this bound moved.
 */
const SEARCH_HORIZON_MINUTES = 26 * 60;

/** The local wall-clock hour and minute at an instant. */
function localWallClock(epochMs: number, offsetAt: LocalOffsetMinutes): ReportedResetTimeOfDay {
  const shifted = new Date(epochMs - offsetAt(epochMs) * MINUTE_MS);
  return { hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes() };
}

function sameWallClock(a: ReportedResetTimeOfDay, b: ReportedResetTimeOfDay): boolean {
  return a.hour === b.hour && a.minute === b.minute;
}

/**
 * Turns the time of day the provider named into an absolute instant.
 *
 * ISO-8601 in UTC — `toISOString()` — so that no local wall-clock rendering
 * survives into the durable contract. `reportedResetAt` is compared with
 * `Date.parse` by `evaluateAutomaticResume`, and a string carrying a local
 * offset would be read correctly by that comparison and wrongly by a human.
 *
 * Three rules, each from the evidence in this file's header:
 *
 *  - **the search starts at the minute containing `now`, not the one after it.**
 *    The message truncates seconds, so a block observed at 17:35:10 whose
 *    message says `5:35 PM` names a reset later in *this* minute. Starting at
 *    the next minute would miss it and return tomorrow;
 *  - **the named minute is rounded up to its end.** `5:35 PM` was measured
 *    standing for `…:30`, so the instant returned is `…:36:00`. Waiting up to a
 *    minute longer costs nothing; returning a moment before the real reset costs
 *    a reviewer call;
 *  - **an ambiguous wall clock resolves to the later instant.** When daylight
 *    saving ends, one hour of wall clock happens twice, and the earlier of the
 *    two is before the reset. The check is direct: if the same wall clock still
 *    reads the same an hour on, the fold is here, and the later one is taken. A
 *    wall clock that does not exist at all — the spring-forward gap — is simply
 *    never matched by the scan, and the search continues past it.
 *
 * Returns `null` when the named time does not occur within the horizon. That is
 * the fail-closed answer, and it is the same one `reportedResetAt: null` already
 * means everywhere else: no unattended resume, the operator decides.
 */
export function deriveResetInstant(
  named: ReportedResetTimeOfDay,
  nowMs: number,
  offsetAt: LocalOffsetMinutes = systemLocalOffsetMinutes,
): string | null {
  if (!Number.isFinite(nowMs)) return null;

  const start = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;

  for (let step = 0; step <= SEARCH_HORIZON_MINUTES; step += 1) {
    const candidate = start + step * MINUTE_MS;
    if (!sameWallClock(localWallClock(candidate, offsetAt), named)) continue;

    const settled = sameWallClock(localWallClock(candidate + HOUR_MS, offsetAt), named)
      ? candidate + HOUR_MS
      : candidate;

    return new Date(settled + MINUTE_MS).toISOString();
  }

  return null;
}
