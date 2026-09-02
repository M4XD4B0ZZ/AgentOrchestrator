/**
 * The reviewer provider gate — one reviewer call at a time, per machine
 * (M2 slice 6).
 *
 * ── The resource this is about ─────────────────────────────────────────────
 *
 * Slice 5 made repositories execute concurrently. Its bound is the Git common
 * directory, because that is what the execution lease keys on, and every other
 * mechanism in the build is scoped the same way: the task state lives under a
 * repository root, the owned-launch register lives under a Git directory, and
 * `boundary/owned-launch-accounting.ts` filters announcements by a domain the
 * coordinator mints fresh per admission. Concurrency in this build is *across*
 * registers, never inside one.
 *
 * The reviewer's quota is not scoped that way. `codex` reads its login from the
 * operator's home directory, so every repository on this machine reviews
 * against **one** subscription window. `registry/repository-registry.ts` already
 * says so where it bounds concurrency at 8 — "each concurrent repository is a
 * writer agent, a reviewer and a verification run on one machine against one
 * operator's subscription window" — it simply had nothing to enforce it with.
 *
 * Measured, that window pays for roughly two and a half reviews in five hours.
 * With `maxConcurrentRepositories: 8` and no gate, eight repositories can each
 * burn a review against it, each independently rediscover the exhaustion, and
 * each park a different task. The quota is spent; nothing is reviewed.
 *
 * ── What this is, and what it deliberately is not ──────────────────────────
 *
 * Two rules, and nothing else:
 *
 *  1. **one in-flight reviewer call per provider.** A caller waits for the
 *     previous one to settle;
 *  2. **a known-exhausted provider is not called again before its reset.** A
 *     caller told this is told the instant instead, and spends no quota
 *     learning what the previous caller already learned.
 *
 * It is **not** a scheduler, a queue that outlives the process, a timer, a
 * backoff, a poll, a fairness policy, a rate limiter, or a persisted record. It
 * holds no history. Nothing here wakes anything up: rule 2 refuses a call that
 * a caller was about to make anyway, and the durable answer to "when may this
 * task run again" stays where it already lives — `TaskState.reportedResetAt`,
 * written by the caller, read by `evaluateAutomaticResume`. Restart-safe
 * scheduling is M3's, and putting any part of it here would be smuggling.
 *
 * The state is therefore **process-scoped and deliberately volatile**. A fresh
 * process knows nothing, which is the correct default: it makes the first call
 * of a run, learns from it, and the durable record of what it learned is the
 * task state it wrote.
 *
 * ── Why the exclusion is a promise chain and not a flag ────────────────────
 *
 * A boolean plus a wait loop is the shape that hangs: two callers read `false`
 * in the same turn, or one exits on a flag another never sets. This chains
 * instead — each caller awaits the previous *result*, so the ordering is the
 * event loop's and there is nothing to poll and nothing to time out. The tail
 * is advanced to a promise that cannot reject, so one caller's failure does not
 * strand every caller behind it.
 *
 * The slot is released when the callback's promise **settles**, which for the
 * one production caller is after `runCodexReviewer` has resolved. A release
 * keyed on anything earlier would let the next reviewer start while the
 * previous one still held the connection it is being serialised against.
 *
 * *When* that is, precisely, belongs to the launch boundary rather than here,
 * and it is worth naming exactly because an earlier draft of this comment got
 * it wrong. On Windows an agent runs through `boundary/owned-command.ts`, not
 * through `doctor/exec.ts`'s own `close` handler, and that module states the
 * property this gate needs: on every ending that can name a verdict, the
 * helper's streams have closed too. The one ending that cannot is
 * `BOUNDARY_TERMINATION_UNCONFIRMED` — a kill that failed after a timeout —
 * which returns with `sideEffectsPossible: true` while the tree may still be
 * alive. There the slot is released over a process that may still be running.
 * The alternative is to deadlock every later reviewer behind a survivor, which
 * is worse; the condition is recorded here rather than papered over.
 */

import type { AgentId } from '../core/states.js';

/**
 * The providers this gate knows about.
 *
 * `codex` alone, and the narrowness is evidence-bound rather than shy. The
 * writer's quota is a different subscription with a different window, its
 * refusals are recognised through a different channel, and nothing has measured
 * the two against each other. A gate that serialised both would be asserting a
 * shared resource nobody has observed.
 */
export type ReviewerProviderId = Extract<AgentId, 'codex'>;

/** Whether a provider may be called right now, and if not, until when. */
export type ProviderAvailability =
  | { readonly available: true }
  | {
      readonly available: false;
      /**
       * The reset a previous call in this process was told about, ISO-8601.
       *
       * Never `null`: a refusal with no instant would leave a caller nothing to
       * record and nothing to wait for, so an exhaustion reported without a
       * reset is not remembered at all. The next caller then makes the call and
       * learns for itself, which spends one reviewer call and is the honest
       * price of not knowing.
       */
      readonly resetAt: string;
    };

const AVAILABLE: ProviderAvailability = Object.freeze({ available: true as const });

export interface ReviewerProviderGate {
  /**
   * Runs `call` with no other reviewer call to this provider in flight.
   *
   * Rejects exactly as `call` rejects, after releasing the slot.
   */
  runExclusively<T>(provider: ReviewerProviderId, call: () => Promise<T>): Promise<T>;
  /**
   * Whether a call to `provider` is worth making at `now` (ISO-8601).
   *
   * Answer it **inside** {@link runExclusively}. Asked outside, two callers can
   * both be told "available" before either has run, which is the exact race
   * this gate exists to close.
   */
  availability(provider: ReviewerProviderId, now: string): ProviderAvailability;
  /**
   * Records that `provider` positively reported exhaustion until `resetAt`.
   *
   * `null` — a recognised refusal that named no time — is accepted and
   * remembered as nothing, so that the caller does not have to decide. A
   * `resetAt` that is not a parseable instant is likewise ignored: this gate
   * withholds calls, and withholding them on an unreadable value would be a
   * self-inflicted outage.
   *
   * The **later** of a remembered reset and a new one wins. Two repositories
   * can report the same window seconds apart and derive instants a minute
   * apart; taking the earlier would let the second caller through before the
   * first's evidence said it could.
   */
  noteExhausted(provider: ReviewerProviderId, resetAt: string | null): void;
}

/** No-op, for advancing the tail without ever rejecting it. */
const IGNORE = (): void => undefined;

/**
 * Builds a gate.
 *
 * Exported so that a test can hold one nobody else shares. Production uses
 * {@link REVIEWER_PROVIDER_GATE}, because the resource being guarded is the
 * machine's, and a per-call gate would guard nothing.
 */
export function createReviewerProviderGate(): ReviewerProviderGate {
  const tails = new Map<ReviewerProviderId, Promise<unknown>>();
  const exhaustedUntil = new Map<ReviewerProviderId, number>();

  return Object.freeze({
    runExclusively<T>(provider: ReviewerProviderId, call: () => Promise<T>): Promise<T> {
      const previous = tails.get(provider) ?? Promise.resolve();
      // `then(call, call)` rather than `finally(call)`: the next call must run
      // whether the previous one resolved or threw. A chain that only continues
      // on success deadlocks every later caller on one failure.
      const result = previous.then(call, call);
      tails.set(
        provider,
        result.then(IGNORE, IGNORE),
      );
      return result;
    },

    availability(provider: ReviewerProviderId, now: string): ProviderAvailability {
      const until = exhaustedUntil.get(provider);
      if (until === undefined) return AVAILABLE;

      const nowMs = Date.parse(now);
      // An unreadable `now` is not permission to refuse. The caller's clock is
      // its own contract; this gate is not the place to fail a run over it, and
      // letting the call through means the provider itself answers.
      if (!Number.isFinite(nowMs)) return AVAILABLE;

      // Expiry is forgetting, not merely reporting available. A record kept past
      // its reset is a record that outlives the fact it states, and the next
      // exhaustion writes a fresh one anyway.
      if (nowMs >= until) {
        exhaustedUntil.delete(provider);
        return AVAILABLE;
      }

      return Object.freeze({ available: false as const, resetAt: new Date(until).toISOString() });
    },

    noteExhausted(provider: ReviewerProviderId, resetAt: string | null): void {
      if (resetAt === null) return;
      const untilMs = Date.parse(resetAt);
      if (!Number.isFinite(untilMs)) return;

      const held = exhaustedUntil.get(provider);
      if (held !== undefined && held >= untilMs) return;
      exhaustedUntil.set(provider, untilMs);
    },
  });
}

/**
 * The gate the loop uses.
 *
 * One per process, because one process drives one machine's repositories
 * against one operator's login. `repository-coordinator.ts` runs its admissions
 * inside a single Node process — `Promise.race` over an active set, not a
 * worker pool — so a module-level instance is exactly co-extensive with the
 * resource it guards.
 */
export const REVIEWER_PROVIDER_GATE: ReviewerProviderGate = createReviewerProviderGate();
