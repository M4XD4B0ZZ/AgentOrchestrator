/**
 * The structured resume point and the bounds every round counter obeys.
 *
 * This lives in its own module so that the Zod state contract
 * (`task-state.ts`) and the pure policy layer (`resume-policy.ts`) validate
 * against *literally the same schema object* without an import cycle. Before,
 * `parseResumePoint` had its own hand-rolled bounds and could produce points
 * the schema rejected (AO-012).
 */

import { z } from 'zod';

import { RESUME_PHASES, type ResumePhase } from './states.js';

/**
 * Absolute ceiling for every round counter in the contract.
 *
 * A review budget is a small human-chosen number; a value anywhere near this
 * ceiling is a corrupt or hostile input, not a configuration. Having an
 * explicit upper bound means a parser can never produce a round that the
 * schema would reject, and it keeps unbounded digit sequences (`1e999`-style
 * overflow to `Infinity`, or a million-digit literal) out of the contract.
 */
export const MAX_ROUND = 1000;

/** Digits a round may have in the `PHASE_ROUND_N` display form. */
const MAX_ROUND_DIGITS = String(MAX_ROUND).length;

/** `PHASE_ROUND_N`, with the digit count bounded so no huge literal is parsed. */
export const RESUME_POINT_DISPLAY_PATTERN = new RegExp(
  `^(${RESUME_PHASES.join('|')})_ROUND_(\\d{1,${MAX_ROUND_DIGITS}})$`,
);

/**
 * A structured re-entry point. `IMPLEMENT_ROUND_1` and friends are expressible
 * as `{ phase: "IMPLEMENT", round: 1 }`; the round is a number, never a
 * substring, so it can be compared against `maxReviewRounds`.
 */
export const ResumePointSchema = z
  .object({
    phase: z.enum(RESUME_PHASES),
    round: z
      .int()
      .min(1, 'Resume round must be at least 1.')
      .max(MAX_ROUND, `Resume round must not exceed ${MAX_ROUND}.`),
  })
  .strict();

/** A structured re-entry point: phase plus 1-based review round. */
export interface ResumePoint {
  readonly phase: ResumePhase;
  readonly round: number;
}

/** Round schema reused for `reviewRound` / `maxReviewRounds` / finding rounds. */
export const RoundSchema = (label: string, minimum: number) =>
  z
    .int()
    .min(minimum, `${label} must be ${minimum} or greater.`)
    .max(MAX_ROUND, `${label} must not exceed ${MAX_ROUND}.`);
