/**
 * The delivery observation contract — V4 slice 2.
 *
 * Slice 1 taught this build to *name* the repository a finished task would be
 * delivered to. This module is the contract for *asking a forge about it*, and
 * it is deliberately transport-free: everything here is a pure function over a
 * value that has already been parsed out of a response. The process that talks
 * to GitHub lives in `./github-observer.ts`, and it depends on this file rather
 * than the other way round.
 *
 * ── The subject is a commit, never a branch ────────────────────────────────
 *
 * Every observation this module describes is about exactly one tuple:
 *
 *     { host, owner, name }  +  one exact commit object name
 *
 * Not a branch, not a pull-request number remembered from an earlier run, not
 * "whatever the branch points at now". That is not a stylistic preference; it
 * is forced by a measured property of the endpoint this build uses as its
 * locator. Measured on 2026-08-23 against `github.com`:
 *
 *     GET /repos/M4XD4B0ZZ/AgentOrchestrator/commits/46629f0/pulls
 *       -> [ { number: 55, state: "open",
 *              head: { sha: "10583ee91a5747d0049f563ffaac64b0cf643aeb" } } ]
 *
 * `46629f0` is *not* that pull request's head. It is an earlier commit on the
 * same branch. The endpoint answers "which pull requests contain this commit",
 * and it reports each one's **current** head, which by then has moved. Reading
 * that array as an answer to "does an open pull request have this exact head"
 * would credit a new head with an old commit's identity — the precise failure
 * this slice exists to prevent.
 *
 * So the endpoint is treated as a **locator** and nothing more. Every candidate
 * it returns is checked against its own reported head object name, and only an
 * exact match counts. See {@link matchExactHead}.
 *
 * ── Both check mechanisms are consulted ────────────────────────────────────
 *
 * GitHub carries check state for a commit in two independent mechanisms, and
 * either can gate a merge. Measured for the same commit on the same day:
 *
 *     GET /repos/.../commits/<sha>/check-runs -> total_count 2, both success
 *     GET /repos/.../commits/<sha>/status     -> state "pending", 0 statuses
 *
 * The combined-status endpoint reports `pending` for a commit that has **no
 * legacy statuses at all**. A build that read only that endpoint would call a
 * green commit pending; a build that read only check runs would not see a
 * legacy status context that is blocking delivery. {@link aggregateCheckState}
 * therefore takes both, and counts a mechanism's contribution by its actual
 * records rather than by the summary word GitHub synthesises for an empty set.
 *
 * ── Fail closed, by construction ───────────────────────────────────────────
 *
 * Every result here is a discriminated union whose payload exists only on the
 * member that earned it: a pull-request number is reachable only through
 * {@link PullRequestMatched}, and check counts only through a graded outcome.
 * No caller can read an identity out of a refusal, because there is no field to
 * read. A value this build does not recognise — an unknown check conclusion, a
 * head that is not a 40-hex object name, a `total_count` that disagrees with
 * the array beside it — produces `RESPONSE_MALFORMED`, never a guess.
 */

import type { ForgeRepositoryIdentity } from './delivery-target.js';

// ── The supported forge ────────────────────────────────────────────────────

/**
 * The hosts this build will send a request to.
 *
 * One member, and the list is a constant **in code**. That is the whole point:
 * slice 1 parses a host out of a remote URL, and a remote URL is repository-
 * controlled data. Letting it choose a network destination would mean a
 * checked-out repository could point this build's authenticated client at a
 * host of its choosing. It cannot: a host that is not listed here is refused
 * before any process starts, and the request that is eventually built names
 * `github.com` from this constant rather than from the parsed identity.
 *
 * This is the same shape as the one egress path this build already had. The
 * notification transport is enabled by a file under the operator's own profile
 * directory, never by anything inside a repository. A second egress class
 * inherits that rule rather than inventing a weaker one.
 *
 * Slice 1 recorded "the host is carried, not judged" as residual `L-V4-01-2`.
 * This constant is that residual's decision, taken deliberately and narrowly:
 * the host is now judged, and judged against one name.
 */
export const SUPPORTED_FORGE_HOSTS: readonly ['github.com'] = Object.freeze([
  'github.com',
] as const);

export type SupportedForgeHost = (typeof SUPPORTED_FORGE_HOSTS)[number];

/**
 * Total predicate. Returns the narrowed host, or `null` for every other value.
 *
 * Slice 1 lower-cases a parsed host, so an exact comparison is the whole test.
 * It is not case-folded again here: doing so would accept a host that slice 1
 * would have refused, and the two grammars must not drift apart.
 */
export function supportedForgeHost(host: string): SupportedForgeHost | null {
  return SUPPORTED_FORGE_HOSTS.includes(host as SupportedForgeHost)
    ? (host as SupportedForgeHost)
    : null;
}

// ── The closed refusal vocabulary ──────────────────────────────────────────

/**
 * The refusals both questions share.
 *
 * Every one of them means "no observation was established". None of them is a
 * softer form of an answer: an operator reading any of these has learned
 * nothing about the pull request or the checks, which is exactly what should
 * happen when the forge, the client or the response cannot be trusted.
 */
export const OBSERVATION_REFUSALS = [
  /** The delivery target's host is not one this build contacts. Nothing ran. */
  'UNSUPPORTED_HOST',
  /**
   * The subject could not be turned into a request this build is willing to
   * make: a commit object name that is not 40 lowercase hex digits, or an owner
   * or repository name outside the grammar slice 1 produces.
   */
  'SUBJECT_UNUSABLE',
  /** No forge client was found on this machine. */
  'FORGE_CLIENT_ABSENT',
  /**
   * The client's environment could not be built unambiguously, so no process
   * was started.
   *
   * `createProbeEnv` refuses rather than resolves when the parent environment
   * holds two Windows spellings of one allow-listed name, and it refuses a
   * source whose properties cannot be read as plain data. Those are throws in
   * a module whose whole contract is that errors become data, so they are
   * caught at the seam and become this.
   */
  'ENVIRONMENT_UNUSABLE',
  /**
   * A forge client was started but produced no usable completion — it timed
   * out, exceeded its output budget, failed to spawn, or the ownership
   * boundary was lost before its exit could be observed.
   */
  'FORGE_CLIENT_UNUSABLE',
  /** The forge client reports that the request needs an authentication it does not have. */
  'NOT_AUTHENTICATED',
  /** The forge client completed, and the request did not succeed. */
  'REQUEST_FAILED',
  /**
   * The response was not JSON, was JSON of a shape this contract does not
   * accept, or carried a value this build does not recognise.
   */
  'RESPONSE_MALFORMED',
  /**
   * The response identifies a **different commit** than the one asked about.
   *
   * Both check endpoints name their own subject — every check run carries
   * `head_sha`, and the combined status carries a top-level `sha` — so the
   * evidence can be bound to the question rather than to the request that was
   * sent. This is the refusal that makes "evidence about commit X can never
   * describe commit Y" a property of the answer and not merely of the argument
   * vector.
   */
  'SUBJECT_MISMATCH',
  /**
   * The forge returned a full page of records, so a further record cannot be
   * ruled out. An answer computed from a page that may be a prefix would be an
   * answer about a subset, presented as one about the whole.
   *
   * Established two different ways, because the two endpoint families offer
   * different evidence. The check endpoints carry a `total_count` beside the
   * array, so a disagreement between them proves truncation outright. The
   * locator endpoint carries no total at all, so the test there is that the
   * page came back *full* — a heuristic, and deliberately the conservative one:
   * a commit that really is contained in exactly `OBSERVATION_PAGE_SIZE` open
   * pull requests is reported as truncated rather than answered. Carried as
   * `L-V4-02-8`.
   */
  'RESULTS_TRUNCATED',
] as const;

export type ObservationRefusal = (typeof OBSERVATION_REFUSALS)[number];

/**
 * One static sentence per refusal, written here and interpolated with nothing.
 *
 * Pinned by literal in `tests/v4-02-delivery-observation.test.ts`, not merely
 * for key completeness. Slice 1 shipped a map whose only binding test compared
 * the map with itself, and a README sample drifted away from the code
 * unnoticed. A completeness check proves a key exists; only a literal proves
 * the sentence is the one an operator will read.
 */
export const OBSERVATION_REFUSAL_DETAIL: Readonly<Record<ObservationRefusal, string>> =
  Object.freeze({
    UNSUPPORTED_HOST:
      'The delivery target is not on a host this build contacts. Nothing was requested.',
    SUBJECT_UNUSABLE:
      'The repository identity or the commit object name is not one this build will put in a request.',
    FORGE_CLIENT_ABSENT: 'No GitHub CLI was found on this machine, so nothing was asked.',
    ENVIRONMENT_UNUSABLE:
      'The environment for the GitHub CLI could not be built unambiguously, so nothing was started.',
    FORGE_CLIENT_UNUSABLE:
      'The GitHub CLI started but did not produce a usable answer, so nothing is established.',
    NOT_AUTHENTICATED:
      'The GitHub CLI reports that this request needs an authentication it does not have.',
    REQUEST_FAILED: 'The GitHub CLI ran and the request did not succeed.',
    RESPONSE_MALFORMED:
      'The answer was not of a shape this build accepts, so it was not read as evidence.',
    SUBJECT_MISMATCH:
      'The answer identifies a different commit than the one asked about, so it was not read as evidence.',
    RESULTS_TRUNCATED:
      'The forge returned a full page of records, so a further one cannot be ruled out.',
  });

// ── The observation subject ────────────────────────────────────────────────

/**
 * A commit object name this build will address on a forge.
 *
 * Forty lowercase hex digits. The durable task contract is wider than this on
 * purpose — `GIT_SHA_PATTERN` in `core/internal/task-state-object-schema.ts`
 * admits a 64-digit SHA-256 object name as well — and that width is correct for
 * Git. It is not correct for this request: GitHub's repositories are SHA-1, so
 * a 64-digit name is a subject no answer here could be about. It is refused as
 * `SUBJECT_UNUSABLE` before anything is contacted rather than sent and allowed
 * to come back as a 404 that reads like "no such pull request".
 */
const COMMIT_OBJECT_NAME = /^[0-9a-f]{40}$/;

/**
 * The owner and repository-name grammars, restated from slice 1.
 *
 * Deliberately restated rather than imported. Slice 1's patterns are the
 * grammar of *parsing a remote URL*; these are the grammar of *what may be
 * placed in a request path*. Sharing one constant would make a future widening
 * of the parser silently widen what is put on the wire, which is the direction
 * that matters.
 *
 * ── The cost of restating, paid once ───────────────────────────────────────
 *
 * A restatement can be an *incomplete* copy, and the first version of this was.
 * Slice 1 refuses a name in two steps — `NAME_PATTERN`, then a separate
 * `ALL_DOTS` check, because a leading dot is legitimate (`.github`) while a
 * name made only of dots is never a repository. Only the first step was
 * restated here, so `..` and `.` passed this module's grammar, at both the
 * factory and the re-check the transport makes immediately before building a
 * path. `..` also satisfies `SAFE_ARG_PATTERN`, so nothing further down would
 * have refused `repos/{owner}/../commits/{sha}/pulls`.
 *
 * It was not reachable from production — slice 1's own `ALL_DOTS` stops it at
 * the parser — but that is precisely the wrong place for the guarantee to rest:
 * this module states that a caller who *casts* its way to a subject must still
 * be refused, and that promise is only as good as the check made here.
 * {@link isAddressableSubject} therefore refuses an all-dots name too, and
 * `tests/v4-02-…` drives the same names through slice 1's parser and through
 * this predicate so the agreement is measured rather than asserted.
 */
const PATH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const PATH_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

/** A name that is only dots — `.`, `..`, `...` — is never a repository. */
const PATH_NAME_ALL_DOTS = /^\.+$/;

/**
 * A repository and one exact commit, both already judged addressable.
 *
 * Deliberately **not** branded or otherwise made unforgeable. A caller that
 * casts its way to a subject naming `evil.example.com` must still be refused,
 * and the only way to demonstrate that is to build such a value in a test and
 * watch nothing start. The guarantee therefore lives where the effect is — the
 * transport re-checks every field of this tuple immediately before it builds an
 * argument vector — and `createObservationSubject` is the ordinary way in, not
 * the only one.
 */
export interface ObservationSubject {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  /** Forty lowercase hex digits. */
  readonly commit: string;
}

export type ObservationSubjectResult =
  | { readonly ok: true; readonly subject: ObservationSubject }
  | { readonly ok: false; readonly refusal: ObservationRefusal };

/**
 * Builds the subject of an observation, or refuses to.
 *
 * The host is checked first and reported as its own refusal, because "your
 * delivery target is not on GitHub" is a different thing for an operator to
 * read than "that commit name is unusable" — the first is a statement about
 * what this build supports, the second about the record in front of it.
 */
export function createObservationSubject(
  identity: ForgeRepositoryIdentity,
  commit: string,
): ObservationSubjectResult {
  const host = supportedForgeHost(identity.host);
  if (host === null) return Object.freeze({ ok: false as const, refusal: 'UNSUPPORTED_HOST' as const });
  if (!isAddressableSubject(identity.owner, identity.name, commit)) {
    return Object.freeze({ ok: false as const, refusal: 'SUBJECT_UNUSABLE' as const });
  }
  return Object.freeze({
    ok: true as const,
    subject: Object.freeze({ host, owner: identity.owner, name: identity.name, commit }),
  });
}

/**
 * The check the transport repeats at the point of use.
 *
 * Exported so the guard is one predicate rather than two spellings of it. A
 * capability that is judged in one place and acted on in another is judged at
 * the wrong moment; this is the predicate both moments share.
 */
export function isAddressableSubject(owner: string, name: string, commit: string): boolean {
  return (
    PATH_OWNER.test(owner) &&
    PATH_NAME.test(name) &&
    !PATH_NAME_ALL_DOTS.test(name) &&
    COMMIT_OBJECT_NAME.test(commit)
  );
}

// ── Question 1: is there an open pull request at exactly this head? ────────

/**
 * The semantic answers, beside the shared refusals.
 *
 * `NO_MATCHING_PULL_REQUEST` is an *answer*: the forge was reached, the
 * candidate set was read in full, and none of its open members has this commit
 * as its head. It is not a refusal and must not be read as one.
 */
export type PullRequestOutcome =
  | 'MATCHED'
  | 'NO_MATCHING_PULL_REQUEST'
  | 'AMBIGUOUS'
  | ObservationRefusal;

export interface PullRequestMatched {
  readonly outcome: 'MATCHED';
  /** The one open pull request whose head object name is exactly the subject commit. */
  readonly pullRequest: number;
}

export interface PullRequestAmbiguous {
  readonly outcome: 'AMBIGUOUS';
  /** Every open pull request that claims this exact head. Ascending, deduplicated. */
  readonly pullRequests: readonly number[];
}

export interface PullRequestOther {
  readonly outcome: Exclude<PullRequestOutcome, 'MATCHED' | 'AMBIGUOUS'>;
}

export type PullRequestObservation =
  | PullRequestMatched
  | PullRequestAmbiguous
  | PullRequestOther;

export function pullRequestRefusal(refusal: ObservationRefusal): PullRequestOther {
  return Object.freeze({ outcome: refusal });
}

/** One candidate, after parsing and before the exact-head test. */
interface PullCandidate {
  readonly number: number;
  readonly state: string;
  readonly headSha: string;
}

/**
 * Reads the locator endpoint's array into candidates, or refuses.
 *
 * Total: every branch returns, and any departure from the accepted shape is
 * `RESPONSE_MALFORMED`. In particular a candidate whose head is not a 40-hex
 * object name is refused rather than skipped — a response that cannot describe
 * a head is not a response this build will draw a conclusion from, and quietly
 * dropping the odd member would let a malformed answer masquerade as "no match".
 */
export function parsePullCandidates(
  body: unknown,
  pageSize: number,
): { readonly ok: true; readonly candidates: readonly PullCandidate[] } | { readonly ok: false; readonly refusal: ObservationRefusal } {
  if (!Array.isArray(body)) return refusalOf('RESPONSE_MALFORMED');
  if (body.length >= pageSize) return refusalOf('RESULTS_TRUNCATED');

  const candidates: PullCandidate[] = [];
  for (const entry of body) {
    if (typeof entry !== 'object' || entry === null) return refusalOf('RESPONSE_MALFORMED');
    const record = entry as Record<string, unknown>;
    const number = record['number'];
    const state = record['state'];
    const head = record['head'];
    if (!Number.isSafeInteger(number) || (number as number) <= 0) return refusalOf('RESPONSE_MALFORMED');
    if (typeof state !== 'string') return refusalOf('RESPONSE_MALFORMED');
    if (typeof head !== 'object' || head === null) return refusalOf('RESPONSE_MALFORMED');
    const headSha = (head as Record<string, unknown>)['sha'];
    if (typeof headSha !== 'string' || !COMMIT_OBJECT_NAME.test(headSha)) {
      return refusalOf('RESPONSE_MALFORMED');
    }
    candidates.push(Object.freeze({ number: number as number, state, headSha }));
  }
  return Object.freeze({ ok: true as const, candidates: Object.freeze(candidates) });
}

/**
 * The exact-head test, and the reason this slice exists.
 *
 * A candidate counts only when it is open **and** its own reported head object
 * name is byte-for-byte the subject commit. The locator's membership answer is
 * discarded here: being returned for a commit means the commit is somewhere in
 * that pull request, which is not the question.
 */
export function matchExactHead(
  candidates: readonly { readonly number: number; readonly state: string; readonly headSha: string }[],
  subjectCommit: string,
): PullRequestObservation {
  const matching = candidates.filter(
    (candidate) => candidate.state === 'open' && candidate.headSha === subjectCommit,
  );
  if (matching.length === 0) return Object.freeze({ outcome: 'NO_MATCHING_PULL_REQUEST' as const });

  const numbers = Object.freeze([...new Set(matching.map((c) => c.number))].sort((a, b) => a - b));
  const first = numbers[0];
  if (numbers.length === 1 && first !== undefined) {
    return Object.freeze({ outcome: 'MATCHED' as const, pullRequest: first });
  }
  return Object.freeze({ outcome: 'AMBIGUOUS' as const, pullRequests: numbers });
}

// ── Question 2: what is the check state of exactly this commit? ────────────

/** Every `status` a check run may carry. Documented by GitHub's REST reference. */
export const CHECK_RUN_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'waiting',
  'requested',
  'pending',
] as const;

/** Every `conclusion` a completed check run may carry. */
export const CHECK_RUN_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
] as const;

/** Every `state` a legacy commit status may carry. */
export const COMMIT_STATUS_STATES = ['error', 'failure', 'pending', 'success'] as const;

/**
 * The conclusions this slice treats as **not blocking delivery**.
 *
 * This is a definition made here, not a guarantee obtained from GitHub. A
 * required check that ends `neutral` or `skipped` does not block a merge under
 * GitHub's own rules today, and treating either as a failure would report a
 * commit as broken when nothing is wrong with it. The counts are rendered
 * separately from the successes precisely so an operator can see that this
 * definition was applied rather than having it hidden inside one word.
 */
const NON_BLOCKING_CONCLUSIONS: ReadonlySet<string> = new Set(['neutral', 'skipped']);

/** The conclusions that block. Everything not here and not non-blocking is `success`. */
const BLOCKING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
]);

const CHECK_RUN_STATUS_SET: ReadonlySet<string> = new Set<string>(CHECK_RUN_STATUSES);
const CHECK_RUN_CONCLUSION_SET: ReadonlySet<string> = new Set<string>(CHECK_RUN_CONCLUSIONS);
const COMMIT_STATUS_STATE_SET: ReadonlySet<string> = new Set<string>(COMMIT_STATUS_STATES);

export interface ParsedCheckRun {
  readonly status: string;
  readonly conclusion: string | null;
}

export interface ParsedCommitStatus {
  readonly state: string;
}

/**
 * What was counted, so that one word is never the whole report.
 *
 * The two mechanism totals are carried separately because "both mechanisms
 * were consulted" is itself the claim most worth being able to check: a build
 * that silently stopped reading legacy statuses would still print a plausible
 * aggregate, and only a visible `commitStatuses` count makes that visible.
 */
export interface CheckCounts {
  readonly checkRuns: number;
  readonly commitStatuses: number;
  readonly failed: number;
  readonly pending: number;
  readonly succeeded: number;
  readonly neutralOrSkipped: number;
}

export type CheckStateOutcome =
  | 'SUCCESS'
  | 'PENDING'
  | 'FAILED'
  | 'NO_CHECKS'
  | ObservationRefusal;

export interface CheckStateGraded {
  readonly outcome: 'SUCCESS' | 'PENDING' | 'FAILED';
  readonly counts: CheckCounts;
}

export interface CheckStateOther {
  readonly outcome: Exclude<CheckStateOutcome, 'SUCCESS' | 'PENDING' | 'FAILED'>;
}

export type CheckStateObservation = CheckStateGraded | CheckStateOther;

export function checkStateRefusal(refusal: ObservationRefusal): CheckStateOther {
  return Object.freeze({ outcome: refusal });
}

/**
 * Reads the check-runs response, or refuses.
 *
 * `total_count` is compared with the array beside it. GitHub pages this
 * endpoint, and a page that is a prefix of the real set would let a failing
 * run sit unread while the visible ones aggregate to `SUCCESS`. A disagreement
 * is `RESULTS_TRUNCATED` — not a smaller answer.
 *
 * ── What an empty page binds, stated exactly ───────────────────────────────
 *
 * Nothing, on its own. This response carries no subject of its own: only each
 * record names one, through `head_sha`, so a page of zero records is accepted
 * for any subject. That is not a hole, because this parser is never the whole
 * answer — `observeCheckStateAtCommit` also requires `parseCommitStatuses`,
 * whose response *does* name its subject at the top level and is bound there.
 * So the pair is bound in every case, including `NO_CHECKS`; this half of it is
 * not, and saying "every record names the commit back" without that
 * qualification would be claiming a binding an empty set cannot provide.
 */
export function parseCheckRuns(
  body: unknown,
  subjectCommit: string,
): { readonly ok: true; readonly runs: readonly ParsedCheckRun[] } | { readonly ok: false; readonly refusal: ObservationRefusal } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refusalOf('RESPONSE_MALFORMED');
  }
  const record = body as Record<string, unknown>;
  const total = record['total_count'];
  const list = record['check_runs'];
  if (!Number.isSafeInteger(total) || (total as number) < 0) return refusalOf('RESPONSE_MALFORMED');
  if (!Array.isArray(list)) return refusalOf('RESPONSE_MALFORMED');
  if ((total as number) !== list.length) return refusalOf('RESULTS_TRUNCATED');

  const runs: ParsedCheckRun[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return refusalOf('RESPONSE_MALFORMED');
    const run = entry as Record<string, unknown>;
    const status = run['status'];
    const conclusion = run['conclusion'];
    // The run names the commit it is about. A run that names another one is
    // not evidence about this subject, whatever it says about itself.
    const headSha = run['head_sha'];
    if (typeof headSha !== 'string' || !COMMIT_OBJECT_NAME.test(headSha)) {
      return refusalOf('RESPONSE_MALFORMED');
    }
    if (headSha !== subjectCommit) return refusalOf('SUBJECT_MISMATCH');
    if (typeof status !== 'string' || !CHECK_RUN_STATUS_SET.has(status)) {
      return refusalOf('RESPONSE_MALFORMED');
    }
    if (conclusion !== null && conclusion !== undefined) {
      if (typeof conclusion !== 'string' || !CHECK_RUN_CONCLUSION_SET.has(conclusion)) {
        return refusalOf('RESPONSE_MALFORMED');
      }
    }
    runs.push(
      Object.freeze({
        status,
        conclusion: typeof conclusion === 'string' ? conclusion : null,
      }),
    );
  }
  return Object.freeze({ ok: true as const, runs: Object.freeze(runs) });
}

/**
 * Reads the combined-status response's **records**, never its summary word.
 *
 * The `state` field of this response is deliberately not read. Measured: a
 * commit with zero legacy statuses answers `"state": "pending"`, which is a
 * summary of an empty set and would make every modern GitHub Actions
 * repository look permanently pending. What is read is the `statuses` array,
 * which is empty exactly when this mechanism has nothing to say.
 */
export function parseCommitStatuses(
  body: unknown,
  subjectCommit: string,
): { readonly ok: true; readonly statuses: readonly ParsedCommitStatus[] } | { readonly ok: false; readonly refusal: ObservationRefusal } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return refusalOf('RESPONSE_MALFORMED');
  }
  const record = body as Record<string, unknown>;
  // This response names its own subject at the top level. Checked before the
  // records are read, so an answer about another commit is refused rather than
  // counted.
  const sha = record['sha'];
  if (typeof sha !== 'string' || !COMMIT_OBJECT_NAME.test(sha)) return refusalOf('RESPONSE_MALFORMED');
  if (sha !== subjectCommit) return refusalOf('SUBJECT_MISMATCH');

  const total = record['total_count'];
  const list = record['statuses'];
  if (!Number.isSafeInteger(total) || (total as number) < 0) return refusalOf('RESPONSE_MALFORMED');
  if (!Array.isArray(list)) return refusalOf('RESPONSE_MALFORMED');
  if ((total as number) !== list.length) return refusalOf('RESULTS_TRUNCATED');

  const statuses: ParsedCommitStatus[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) return refusalOf('RESPONSE_MALFORMED');
    const state = (entry as Record<string, unknown>)['state'];
    if (typeof state !== 'string' || !COMMIT_STATUS_STATE_SET.has(state)) {
      return refusalOf('RESPONSE_MALFORMED');
    }
    statuses.push(Object.freeze({ state }));
  }
  return Object.freeze({ ok: true as const, statuses: Object.freeze(statuses) });
}

/**
 * The aggregate, and the exact rule it applies.
 *
 * In order, and the order is the contract:
 *
 *  1. **A completed run with no conclusion is malformed.** GitHub's own
 *     documentation says a completed run carries one. A build that met this
 *     and picked a bucket anyway would be inventing the answer.
 *  2. **No records in either mechanism is `NO_CHECKS`** — never `SUCCESS`.
 *     `CLAUDE.md` states the same rule for this repository's own merge gate:
 *     zero checks is a blocking condition in its own right, distinct from
 *     failure, so that "CI is broken" is never delivered as "CI is fine".
 *  3. **A blocking record makes it `FAILED`**, even when another record is
 *     still running. A failure is already decisive, and reporting `PENDING`
 *     would invite an operator to wait for an answer that has arrived.
 *  4. **An unfinished record makes it `PENDING`.**
 *  5. Otherwise `SUCCESS`, meaning: every record in both mechanisms finished,
 *     and none of them blocks under the definition stated above.
 *
 * ── What `SUCCESS` does not claim ──────────────────────────────────────────
 *
 * It is a statement about the records that **exist** for this commit, not a
 * prediction that no further record will appear. GitHub has a third concept —
 * the check *suite* — and a suite that has registered but produced no check run
 * is invisible to both mechanisms read here. Measured on this repository's own
 * commit `10583ee…` on 2026-08-23: `check-suites` reported three suites, two of
 * them `queued` with `conclusion: null` and zero runs, while `check-runs`
 * reported two successful runs and GitHub's own `statusCheckRollup` reported
 * `SUCCESS`.
 *
 * Those two suites are not read, and that is a decision rather than an
 * oversight. Treating a runless queued suite as `PENDING` would leave this
 * repository permanently pending, because both of its dormant suites have sat
 * that way across every commit measured. So the narrower, true statement is the
 * one made here, and the one the operator-facing counts make checkable. It is
 * carried as a named residual rather than hidden inside the word `SUCCESS`.
 */
export function aggregateCheckState(
  runs: readonly ParsedCheckRun[],
  statuses: readonly ParsedCommitStatus[],
): CheckStateObservation {
  let failed = 0;
  let pending = 0;
  let succeeded = 0;
  let neutralOrSkipped = 0;

  for (const run of runs) {
    if (run.status !== 'completed') {
      pending += 1;
      continue;
    }
    if (run.conclusion === null) return checkStateRefusal('RESPONSE_MALFORMED');
    if (BLOCKING_CONCLUSIONS.has(run.conclusion)) failed += 1;
    else if (NON_BLOCKING_CONCLUSIONS.has(run.conclusion)) neutralOrSkipped += 1;
    else succeeded += 1;
  }

  for (const status of statuses) {
    if (status.state === 'pending') pending += 1;
    else if (status.state === 'success') succeeded += 1;
    else failed += 1;
  }

  const counts: CheckCounts = Object.freeze({
    checkRuns: runs.length,
    commitStatuses: statuses.length,
    failed,
    pending,
    succeeded,
    neutralOrSkipped,
  });

  if (runs.length === 0 && statuses.length === 0) {
    return Object.freeze({ outcome: 'NO_CHECKS' as const });
  }
  if (failed > 0) return Object.freeze({ outcome: 'FAILED' as const, counts });
  if (pending > 0) return Object.freeze({ outcome: 'PENDING' as const, counts });
  return Object.freeze({ outcome: 'SUCCESS' as const, counts });
}

function refusalOf(refusal: ObservationRefusal): { readonly ok: false; readonly refusal: ObservationRefusal } {
  return Object.freeze({ ok: false as const, refusal });
}
