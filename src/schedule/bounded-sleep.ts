/**
 * The bounded, chunked, cancellable wait for an absolute instant (M3-01).
 *
 * ── Why chunks, when 24 hours already fits in one timer ────────────────────
 *
 * `MAX_WAIT_MS_CEILING` is 24 hours and Node's timer takes 2_147_483_647 ms
 * (~24.8 days), so a single `setTimeout` could express every wait this build
 * accepts. Chunking is not about the timer limit. It is about the **clock**.
 *
 * A single timer sleeps for a *duration*. The thing being waited for is an
 * *instant*. Those are the same only while the wall clock runs at one second per
 * second, and the two events this product must survive — an NTP correction after
 * a CMOS drift, a virtual machine resumed from a snapshot — are exactly the
 * events that break the identity. A forward step of two hours during a
 * five-hour sleep means the reset arrived two hours ago and a duration-timer is
 * still counting. Re-reading the clock every chunk bounds that error to one
 * chunk, whatever the step was.
 *
 * The timer maximum is still respected, and for free: a chunk is at most
 * {@link SLEEP_CHUNK_MS}, four orders of magnitude below the edge, so no delay
 * this module hands to a timer can approach the value that fires immediately
 * while reporting a wait.
 *
 * ── Why the chunk budget exists, and what it is for ────────────────────────
 *
 * Re-reading the clock fixes a forward step and creates a way to be trapped by a
 * backward one: a clock stepped back by a week makes the deadline a week away
 * again, and a loop that only ever asks "have we arrived?" would keep sleeping
 * long past the bound the operator gave. So the loop also counts chunks, which
 * is a monotone quantity no clock can move. When the count exceeds what the
 * bound could possibly need, the wait ends as {@link CHUNK_BUDGET_SPENT} rather
 * than continuing on a clock that is no longer describing the same world.
 *
 * That ending is deliberately not a failure: nothing is held, nothing was
 * written, and the caller's next act is to look at durable state again.
 *
 * ── Cancellation ──────────────────────────────────────────────────────────
 *
 * The sleep takes a `cancel` promise and the production sleep clears its timer
 * when that promise settles, so an interrupted wait returns at once and leaves
 * no timer holding the event loop open. A caller that never cancels passes a
 * promise that never settles, which costs one registered continuation.
 *
 * Nothing here is authority. A wait that ends early, late, or on the chunk
 * budget produces the same next step: read the durable state again and decide
 * from that. This module can make the scheduler slow; it cannot make it wrong.
 */

/**
 * The longest single timer this module will ever start: one minute.
 *
 * Chosen so that a clock step costs at most a minute of lateness while an idle
 * scheduler wakes 60 times an hour to compare two numbers — which is not a poll
 * in any sense that matters: it opens nothing, reads no file and starts no
 * process. A shorter chunk buys precision nothing needs (a quota window is
 * measured in hours); a longer one buys nothing at all.
 */
export const SLEEP_CHUNK_MS = 60_000;

/** How a bounded wait ended. A closed set. */
export const BOUNDED_SLEEP_OUTCOMES = [
  /** The clock reached the deadline. The ordinary ending. */
  'DEADLINE_REACHED',
  /** A shutdown was requested. Nothing was waited for further. */
  'STOP_REQUESTED',
  /**
   * More chunks elapsed than the operator's bound could account for.
   *
   * Reachable only when the wall clock moved backwards during the wait; see the
   * module header. Its own member rather than folded into `DEADLINE_REACHED`,
   * because the deadline was **not** reached and a caller that reported it as
   * reached would be asserting an instant had passed on no evidence.
   */
  'CHUNK_BUDGET_SPENT',
  /** A clock reading during the wait was not a timestamp. Nothing further slept. */
  'CURRENT_TIME_UNPARSEABLE',
] as const;

export type BoundedSleepOutcome = (typeof BOUNDED_SLEEP_OUTCOMES)[number];

export interface BoundedSleepResult {
  readonly outcome: BoundedSleepOutcome;
  /** How many timers were started. Zero when the deadline had already passed. */
  readonly chunks: number;
  /**
   * What the clock says elapsed, in milliseconds, or `null` when a reading
   * during the wait was unusable.
   *
   * Measured from the same clock the deadline is expressed in, so a clock step
   * shows up here rather than being hidden — which is the honest reading, since
   * there is no monotonic source in this build that survives the process.
   */
  readonly elapsedMs: number | null;
}

export interface BoundedSleepDependencies {
  readonly now: () => string;
  /**
   * Sleeps for `ms`, or until `cancel` settles, whichever is first.
   *
   * The cancel argument is part of the seam rather than an afterthought: a
   * sleep that cannot be cancelled leaves its timer holding the event loop for
   * up to a chunk after the caller has stopped caring, and a scheduler asked to
   * shut down would appear to ignore it.
   */
  readonly sleep: (ms: number, cancel: Promise<void>) => Promise<void>;
  /** `true` once a shutdown has been requested. Read between chunks. */
  readonly shouldStop: () => boolean;
  /** Settles when a shutdown is requested. Handed to {@link sleep}. */
  readonly cancel: Promise<void>;
}

/**
 * The production sleep: one timer, cleared on cancellation.
 *
 * `settle` is idempotent by construction — the promise's own resolution
 * discards the second call — and the timer is cleared on both paths, so a
 * cancelled wait leaves nothing behind that could keep the process alive.
 */
export const realCancellableSleep = (ms: number, cancel: Promise<void>): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(settle, ms);
    function settle(): void {
      clearTimeout(timer);
      resolve();
    }
    void cancel.then(settle, settle);
  });

/**
 * Waits until `deadlineMs`, in chunks, re-reading the clock between each.
 *
 * `maxWaitMs` is the operator's bound on this one wait. It is **not** re-checked
 * against the remaining distance — the caller has already refused a deadline
 * beyond it — and is used here only to size the chunk budget described in the
 * module header.
 *
 * Never throws. Returns the moment the deadline has passed, a stop is requested,
 * a clock reading is unusable, or the chunk budget is spent.
 */
export async function sleepUntilInstant(
  deadlineMs: number,
  maxWaitMs: number,
  deps: BoundedSleepDependencies,
): Promise<BoundedSleepResult> {
  const startedMs = Date.parse(deps.now());
  if (!Number.isFinite(startedMs)) {
    return Object.freeze({ outcome: 'CURRENT_TIME_UNPARSEABLE' as const, chunks: 0, elapsedMs: null });
  }

  // One extra chunk beyond what the bound needs, so that an ordinary wait whose
  // final chunk is a partial one is never cut short by its own budget. The
  // budget is a guard against a clock that stopped describing the world, not a
  // second expression of the bound.
  const maxChunks = Math.ceil(maxWaitMs / SLEEP_CHUNK_MS) + 1;

  let chunks = 0;
  for (;;) {
    // Before the first sleep as well as between them: a stop requested while
    // the previous cycle was still finishing must not buy one more chunk.
    if (deps.shouldStop()) {
      return Object.freeze({ outcome: 'STOP_REQUESTED' as const, chunks, elapsedMs: elapsed() });
    }

    const nowMs = Date.parse(deps.now());
    if (!Number.isFinite(nowMs)) {
      return Object.freeze({ outcome: 'CURRENT_TIME_UNPARSEABLE' as const, chunks, elapsedMs: null });
    }

    const remaining = deadlineMs - nowMs;
    if (remaining <= 0) {
      return Object.freeze({
        outcome: 'DEADLINE_REACHED' as const,
        chunks,
        elapsedMs: nowMs - startedMs,
      });
    }

    if (chunks >= maxChunks) {
      return Object.freeze({
        outcome: 'CHUNK_BUDGET_SPENT' as const,
        chunks,
        elapsedMs: nowMs - startedMs,
      });
    }

    chunks += 1;
    await deps.sleep(Math.min(remaining, SLEEP_CHUNK_MS), deps.cancel);
  }

  function elapsed(): number | null {
    const nowMs = Date.parse(deps.now());
    return Number.isFinite(nowMs) ? nowMs - startedMs : null;
  }
}
