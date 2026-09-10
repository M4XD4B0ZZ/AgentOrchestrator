/**
 * How many review rounds a task may have, and who may raise that number.
 *
 * ── The defect this exists for ─────────────────────────────────────────────
 *
 * A task whose last permitted review round found something parked at
 * `HUMAN_DECISION_REQUIRED` with `resumeFrom {REMEDIATE, round}`. An operator
 * continued it; the writer remediated; verification ran; and the next review
 * computed `round = reviewRound + 1`, which was again above the budget, so it
 * parked again — with the same resume point. Measured on RESOLVER-V3-034R on
 * 2026-09-10: **the task could never reach `READY_FOR_PR` through that path, no
 * matter how many times the operator continued it.** A closed loop, not a slow
 * one.
 *
 * ── What changes, and what deliberately does not ───────────────────────────
 *
 * The repository still declares its budget, and this build still refuses to run
 * a review the budget cannot pay for. What is new is that **an operator's
 * continuation out of an exhausted budget buys exactly one more round** — the
 * same shape every other operator escape here has, "one departure per
 * invocation".
 *
 * The alternative was considered and rejected: letting a remediation reach
 * `READY_FOR_PR` on a passing verification without a review would mean the last
 * change to a task arrives unreviewed, and that terminal state's whole promise
 * is that nothing unreviewed passes it.
 *
 * ── Why a counter rather than raising `maxReviewRounds` ────────────────────
 *
 * `maxReviewRounds` is what the *repository declared*, written once by
 * `run/start-task.ts` and never re-derived. Overwriting it would make the record
 * misreport the profile and erase the only evidence that a person intervened,
 * after which no report could honestly answer "how many rounds were granted, and
 * by whom" — the delta against the profile is not an answer, because the profile
 * is a file the operator may have edited since.
 *
 * So the grant is its own field and the budget is their sum. Two precedents in
 * the state schema already split a role into its own field for this reason
 * rather than overloading a neighbour.
 *
 * ── The ceiling is arithmetic, not taste ───────────────────────────────────
 *
 * A finding record may carry a path of 1024 characters and a rule of 128, so one
 * record costs at most ~1308 bytes serialised; a review document carries at most
 * 64 findings; and a durable state may not exceed
 * `MAX_TASK_STATE_BYTES` (1 048 576). 12 x 64 x 1308 = 1 004 544 bytes, so
 * **twelve is the largest budget whose worst case provably fits**, and the
 * thirteenth is the first that does not.
 *
 * That bound is older than the grant it now limits. `maxReviewRounds` was
 * constrained only by `MAX_ROUND` (1000), so a profile could always declare a
 * budget whose finding history could not be persisted — and the comment that
 * called this arithmetic closed has been false since the fingerprint was the
 * only stored string. The profile is where it is refused, because an impossible
 * budget is a configuration error a person fixes in one line, and refusing it at
 * the thirteenth round instead would refuse it after the work.
 */

/** The largest review budget whose worst-case finding history fits a durable state. */
export const MAX_REVIEW_BUDGET = 12;

/**
 * The two numbers a budget is made of.
 *
 * Structural rather than a `TaskState`, deliberately: this is read from inside
 * `core/internal/task-state-object-schema.ts`, and importing the assembled type
 * back into the module that builds it would be a cycle.
 */
export interface ReviewBudgetInput {
  /** What the repository declared. Never changed by a grant. */
  readonly maxReviewRounds: number;
  /** How many rounds operators have granted on top of it. */
  readonly grantedReviewRounds: number;
}

/** The rounds this task may actually have: what it declared, plus what was granted. */
export function reviewBudget(state: ReviewBudgetInput): number {
  return state.maxReviewRounds + state.grantedReviewRounds;
}

/**
 * Whether the budget is spent.
 *
 * `>=` rather than `>`: `reviewRound` counts rounds that have *happened*, so a
 * task whose third round is recorded against a budget of three has no fourth to
 * spend. This is the predicate a grant is conditioned on, so that continuing an
 * escalation which was never about the budget — a refused scope, a missing
 * brief — buys nothing and the ceiling cannot creep on unrelated parks.
 */
export function reviewBudgetExhausted(
  state: ReviewBudgetInput & { readonly reviewRound: number },
): boolean {
  return state.reviewRound >= reviewBudget(state);
}
