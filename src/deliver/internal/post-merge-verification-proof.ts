/**
 * The post-merge verification proof — the mint, and the only place one can be
 * made.
 *
 * ── What this artefact says ────────────────────────────────────────────────
 *
 * *This process ran the repository's canonical verification profile, identified
 * by this digest, in a workspace it had proved was checked out at exactly this
 * merge commit, and the run ended this way.*
 *
 * Three parts, and the middle one is the reason the artefact exists. A verdict
 * and a commit are two values; a *proof* is what makes them one sentence. The
 * mint below refuses to build one unless the workspace HEAD that was proved
 * equals the merge commit being attested — so **there is no representable
 * value that says "M passed" and was produced by a run against something
 * else**. That is not a validation nicety; it is the whole guarantee of the
 * slice, expressed as a type rather than as a rule somebody has to remember.
 *
 * ── What it emphatically does not say ──────────────────────────────────────
 *
 *  - **not** that M is currently the tip of the base branch, or currently
 *    reachable from it. The base moves. A revert, a force push or a branch
 *    reset changes what is on it and changes nothing here;
 *  - **not** that the merge has not been reverted;
 *  - **not** that the base branch passes now. A different commit is a different
 *    subject;
 *  - **not** that the task is complete. The task's lifecycle is not this
 *    artefact's subject and is not touched by it;
 *  - **not** freshness. A proof minted an hour ago and one minted now are
 *    indistinguishable to every consumer, deliberately: the only honest use of
 *    either is "AO ran this at `attemptedAt`";
 *  - **not** a statement about the machine. See
 *    `verify/verification-profile.ts`: the digest identifies the *contract*,
 *    never the toolchain that executed it.
 *
 * ── Why it is opaque ───────────────────────────────────────────────────────
 *
 * The durable record downstream carries the sentence *commit M passed the
 * canonical gate*, and such a sentence may only come from a run that actually
 * happened. A structural type cannot carry that: `{ outcome: 'VERIFIED_PASS' }`
 * is a shape any caller can write down, and a richer shape is only a longer
 * thing to write down. The same reasoning, and the same mechanism, as
 * `internal/merge-observation-proof.ts` — whose header records the two attacks
 * (`Object.create` for the prototype, `#facts in value` for the private field)
 * that shaped it.
 *
 * The boundary is exactly: **ordinary product code cannot manufacture a
 * verification verdict without going through the execution boundary.** It is an
 * in-process product-code provenance boundary. It is not a guarantee against a
 * caller that imports this module, and it is **not** filesystem authenticity —
 * nothing here would detect a record written into the runtime directory by
 * something else.
 *
 * ── The mint re-derives; it does not take the caller's word ────────────────
 *
 * The outcome is derived here from the verification report, not accepted as a
 * summary. The one function that can produce the artefact is the wrong place to
 * trust a caller's account of what the gate said.
 */

import type { VerificationReport } from '../../verify/run-verification.js';

/**
 * The registry. A `WeakSet` a value cannot be reached from — an instance can
 * hand out its prototype and its constructor, and neither of those is this.
 */
const MINTED = new WeakSet<object>();

/**
 * Captured and bound at module load, so a later
 * `WeakSet.prototype.has = () => true` cannot turn the gate off process-wide.
 * The same defence every other opaque artefact here carries.
 */
const registryHas: (value: object) => boolean = WeakSet.prototype.has.bind(MINTED);

function isMinted(value: object): boolean {
  return registryHas(value);
}

const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;

/** Restated rather than imported, for the reason `lease-document.ts` gives. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * How one post-merge verification attempt ended. A closed vocabulary of three,
 * and the third is the one this build refuses to collapse into the second.
 *
 * The distinction is not new here: `verify/run-verification.ts` already draws
 * it, and this vocabulary is that one renamed for a durable record rather than
 * a second opinion about it. `PASSED`/`FAILED`/`UNAVAILABLE` are what a *run*
 * produced; these are what a *record* says about a commit.
 */
export const POST_MERGE_VERIFICATION_OUTCOMES = [
  /**
   * Every declared phase ran to its own end and exited 0. The repository
   * answered yes about this exact commit.
   */
  'VERIFIED_PASS',
  /**
   * A phase ran to its own end and said no. **The repository answering the
   * question it was asked** — this is a statement about the code at M.
   */
  'VERIFIED_FAIL',
  /**
   * No phase reached a verdict: a process that could not start, a timeout, an
   * output budget flooded, a kill from outside, an argv refused, or a
   * workspace that could not be established.
   *
   * **Nothing was learned about the code.** Reporting this as `VERIFIED_FAIL`
   * would tell an operator their merge is broken when what broke was the
   * machine — the fail-*wrong* direction, and the one this repository has
   * measured most often (a busy workstation produces timeouts with zero
   * assertion failures).
   */
  'VERIFICATION_NOT_ESTABLISHED',
] as const;

export type PostMergeVerificationOutcome = (typeof POST_MERGE_VERIFICATION_OUTCOMES)[number];

/**
 * What one verification attempt looked like, in plain values.
 *
 * These are the facts the durable record is built from. They are readable — the
 * artefact hides its *constructibility*, not its content.
 *
 * Note what is **not** here: no stdout, no stderr, no diagnostics excerpt, no
 * environment, no command line, no host path, no repository configuration. The
 * record downstream can only hold what this carries, so the hygiene rule is
 * enforced by the shape rather than by a filtering step somebody has to
 * remember to run. A repository's own test runner may print anything at all,
 * including a secret it read; none of it becomes durable through this route.
 */
export interface PostMergeVerificationFacts {
  /** The subject: the merge commit named by the task's merge receipt. */
  readonly mergeCommit: string;
  /**
   * The object name HEAD was **proved** to be, inside the workspace the gate
   * ran in. Required by the mint to equal {@link mergeCommit}.
   *
   * Carried rather than dropped once checked, so the durable record states the
   * thing that was measured instead of asserting the conclusion drawn from it.
   */
  readonly workspaceHeadCommit: string;
  /** Which contract ran. See `verify/verification-profile.ts`. */
  readonly profileDigest: string;
  readonly outcome: PostMergeVerificationOutcome;
  /** The phase that failed or could not be run, or `null` on a pass. */
  readonly stoppedAt: string | null;
  /** The stopping phase's exit code, or `null` when no process completed. */
  readonly exitCode: number | null;
  /** The signal that killed the stopping phase, when one did. */
  readonly signal: string | null;
  /** How many phases were actually run, in order, before the run ended. */
  readonly phasesRun: number;
  /** When this process started the attempt. ISO-8601 with an explicit offset. */
  readonly attemptedAt: string;
}

export class PostMergeVerificationEvidence {
  readonly #facts: PostMergeVerificationFacts;

  constructor(facts: PostMergeVerificationFacts) {
    this.#facts = facts;
  }

  /** Whether the mint built this value. See the header for what this is not. */
  static holds(value: unknown): value is PostMergeVerificationEvidence {
    return typeof value === 'object' && value !== null && isMinted(value as object);
  }

  /**
   * The facts this proof carries.
   *
   * A static reading a private field rather than a getter, for the reason the
   * lease proof gives: an own property shadows a prototype getter, so a getter
   * would be a member a forgery can define and the private field would never be
   * read.
   */
  static factsOf(proof: PostMergeVerificationEvidence): PostMergeVerificationFacts {
    return proof.#facts;
  }
}

/**
 * What the caller says it ran. Every field is re-checked below; the outcome is
 * re-derived rather than accepted.
 */
export interface AttemptedVerification {
  /** The subject, taken from the task's merge receipt. */
  readonly mergeCommit: string;
  /**
   * The HEAD the workspace was proved to be at, by
   * `worktree/verification-workspace.ts`.
   *
   * Passed separately from {@link mergeCommit} on purpose. Handing in one value
   * for both would make the comparison below compare a value with itself, which
   * is the shape of a check that always passes and proves nothing.
   */
  readonly workspaceHeadCommit: string;
  readonly profileDigest: string;
  /** What `runVerification` produced. */
  readonly report: VerificationReport;
  /** When this process started the attempt. */
  readonly attemptedAt: string;
}

/** How a report's verdict becomes a record's outcome. Total, and exhaustive. */
const OUTCOME_OF: Readonly<Record<VerificationReport['verdict'], PostMergeVerificationOutcome>> =
  Object.freeze({
    PASSED: 'VERIFIED_PASS',
    FAILED: 'VERIFIED_FAIL',
    UNAVAILABLE: 'VERIFICATION_NOT_ESTABLISHED',
  });

/**
 * Mints a proof, or answers `null`.
 *
 * `null` for every input this build will not attest to, and the list is short
 * because most of it is one condition:
 *
 *  - the workspace HEAD that was proved is not the merge commit. **The
 *    load-bearing refusal.** A run against another commit produces no artefact
 *    at all, so no downstream code has to remember to check;
 *  - either object name is not a full 40-hex commit name;
 *  - the profile digest is not a digest;
 *  - the attempt instant is not ISO-8601;
 *  - the report claims a `PASSED` verdict while naming a phase it stopped at,
 *    or a non-`PASSED` verdict naming none. Those two shapes are unreachable
 *    through `runVerification` and are refused here rather than trusted,
 *    because this is the boundary at which a hand-built report would arrive.
 */
export function mintPostMergeVerification(
  attempt: AttemptedVerification,
): PostMergeVerificationEvidence | null {
  if (!COMMIT_OBJECT_NAME.test(attempt.mergeCommit)) return null;
  if (!COMMIT_OBJECT_NAME.test(attempt.workspaceHeadCommit)) return null;
  // The sentence this whole slice is about.
  if (attempt.workspaceHeadCommit !== attempt.mergeCommit) return null;

  if (!HEX_64.test(attempt.profileDigest)) return null;
  if (!ISO_8601.test(attempt.attemptedAt)) return null;

  const report = attempt.report;
  const outcome = OUTCOME_OF[report.verdict];
  if (outcome === undefined) return null;

  const passed = outcome === 'VERIFIED_PASS';
  if (passed !== (report.stoppedAt === null)) return null;

  const stopping = report.phases.length === 0 ? null : report.phases[report.phases.length - 1];

  const evidence = new PostMergeVerificationEvidence(
    Object.freeze({
      mergeCommit: attempt.mergeCommit,
      workspaceHeadCommit: attempt.workspaceHeadCommit,
      profileDigest: attempt.profileDigest,
      outcome,
      stoppedAt: report.stoppedAt,
      exitCode: passed ? null : (stopping?.exitCode ?? null),
      signal: passed ? null : (stopping?.signal ?? null),
      phasesRun: report.phases.length,
      attemptedAt: attempt.attemptedAt,
    }),
  );
  MINTED.add(evidence);
  return evidence;
}

// The class is reachable from any genuine artefact as
// `Object.getPrototypeOf(value).constructor`, with no import at all. Closing it
// here means that route hands back a value the registry does not know, so
// `holds` refuses it — which is the attack `internal/merge-observation-proof.ts`
// records having been used against this codebase's other opaque artefacts.
Object.freeze(PostMergeVerificationEvidence);
Object.freeze(PostMergeVerificationEvidence.prototype);
