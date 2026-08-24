/**
 * The GitHub pull-request merge transport — V4 slice 7.
 *
 * The third forge *mutation* class in this build, and the second that is an HTTP
 * request. Everything the observation transport establishes about destination,
 * environment and credentials holds here unchanged, and is re-stated where it is
 * re-applied rather than inherited by proximity: the host is the constant
 * `github.com`, the environment is built by `createProbeEnv('forge:github', …)`
 * and never inherited, and no token is read, held or written by this build at
 * any point.
 *
 * ── Why `gh api` and not `gh pr merge` ────────────────────────────────────
 *
 * Measured, not assumed, and the reasons are different from slice 6's.
 *
 * `gh pr merge` does expose the fence — its `--match-head-commit SHA` is
 * documented as "Commit SHA that the pull request head must match to allow
 * merge" — but it does not issue this request. It issues a GraphQL
 * `mergePullRequest` mutation and selects only `ClientMutationId` from the
 * result, so **the resulting commit is structurally unavailable through it**.
 * That commit is the one field this slice must report and cannot recompute, so a
 * client that cannot return it would force a second, separate read to recover
 * what the mutation already knew.
 *
 * Worse for a product path, its own help documents that *"If required checks
 * have not yet passed, auto-merge will be enabled"*. A command that silently
 * converts a merge into an auto-merge is a command that can leave a repository
 * armed to merge later, unattended, from an invocation an operator watched
 * finish. This build has no auto-merge and must not acquire one by transport.
 *
 * `gh api` issues one request to the endpoint it is given and touches no Git
 * state. That is not the same as "exactly one HTTP request": the client makes
 * calls of its own — telemetry, and a periodic update check — which this build
 * does not suppress, and which `L-V4-02-6` records and every egress trailer
 * discloses. The claim that survives is about what *this build asks for*.
 *
 * ── `-X PUT` is not decoration ────────────────────────────────────────────
 *
 * The observation transport pins `-X GET` because `gh api` documents its default
 * method as "GET normally and POST if any parameters were added". The same
 * switch fires on `--input`: with a body supplied and no `-X`, the method
 * becomes POST on its own — which on this path would be a request to a different
 * endpoint shape entirely. So the token is written out, and the suite pins the
 * whole vector by exact equality rather than checking that `PUT` occurs
 * somewhere in it.
 *
 * ── The body goes on stdin, and it carries exactly two fields ─────────────
 *
 * `--input -` reads the request body from standard input. Unlike slice 6's, this
 * body contains no free text at all: a forty-hex object name and a constant.
 * Both are bounded by a grammar the mint enforced, and neither could carry
 * anything an operator wrote. It goes on stdin anyway, for slice 6's reason —
 * quoting data into an argument vector is the transport this repository refuses
 * for data everywhere — and because `runCommand` reports whether the whole
 * payload was handed over.
 *
 * That report is load-bearing. A body that was only partly delivered produces
 * whatever GitHub makes of a truncated document — and a truncated body here
 * means a request with no `sha`, which is a request with **no fence**. So this
 * module grades the attempt `FAILED` unless the payload was `DELIVERED` in full.
 *
 * ── What the `sha` field buys, measured ───────────────────────────────────
 *
 * It is the server-evaluated compare-and-swap slice 6 had no equivalent of and
 * slice 5 has in `--force-with-lease`. Measured against github.com on a
 * disposable pull request whose base was a scratch branch:
 *
 *   sha != current head, PR open   -> 409 "Head branch was modified. Review and
 *                                     try the merge again."  Nothing merged.
 *   sha = 40 hex that exists nowhere -> the same 409. The refusal does not
 *                                     distinguish stale from unknown.
 *   sha abbreviated, or not hex    -> 422 "The sha parameter must be exactly 40
 *                                     characters and contain only [0-9a-f]."
 *   merge_method outside the three -> 422 naming the set.
 *
 * And the limit of it, which is why the caller reads afterwards and never trusts
 * the answer:
 *
 *   PR ALREADY MERGED              -> 200 {"merged":true}, replaying the
 *                                     ORIGINAL merge commit, with the `sha` and
 *                                     the `merge_method` both IGNORED.
 *
 * The fence protects the open case. It does not make a `200` a proof.
 *
 * ── What this module cannot promise ───────────────────────────────────────
 *
 * That the request did not take effect. Measured: `gh api` has no retry and no
 * deadline of its own, so the only deadline is this build's, and it is enforced
 * by killing the process rather than by cancelling the request. A timeout, a
 * lost process boundary or a killed child can therefore all land *after* GitHub
 * has committed the merge, moved the base branch and fired its notifications.
 * Nothing here can tell those apart from a request that never arrived — which is
 * exactly why the caller reads the pull request afterwards and why this module
 * returns a word about the *attempt* and never about the effect.
 */

import { createProbeEnv } from '../auth/env-guard.js';
import { runCommand, UnsafeArgumentError, type CommandResult } from '../doctor/exec.js';
import { isAddressableSubject, supportedForgeHost } from './forge-observation.js';
import type { MergeAttempt } from './pull-request-merge.js';
import type { MergeSubject } from './internal/merge-grant.js';

/**
 * The program and the environment policy, imported and not restated.
 *
 * `tests/v4-02-…` proves that exactly one module in `src/` declares the forge
 * client's name, and that pin is this repository's second egress pin: a
 * subprocess is invisible to the in-process socket pin, so "which files can
 * start a forge client" is the property that keeps a new egress class from
 * arriving unannounced. Declaring the client's name a second time here would
 * have made that pin measure less while adding nothing.
 */
export { FORGE_CLIENT_COMMAND, FORGE_ENV_POLICY } from './github-observer.js';
import { FORGE_CLIENT_COMMAND, FORGE_ENV_POLICY } from './github-observer.js';

export { FORGE_CLIENT_WORKING_DIRECTORY } from './github-observer.js';
import { FORGE_CLIENT_WORKING_DIRECTORY } from './github-observer.js';

/**
 * A mutation, and the most consequential one this build makes. Sixty seconds.
 *
 * Twice slice 6's budget, and set where a premature kill is least likely rather
 * than where a fast answer is. The reasoning is GitHub's own: it ships a second,
 * asynchronous merge endpoint whose stated purpose is to avoid "the risk of
 * timeouts for particularly complex merges", which is a statement that the
 * synchronous one can be slow. A read that gives up too early costs a retry; a
 * *merge* that gives up too early leaves the base branch possibly moved and
 * nobody able to attribute it. The window is not removed by a longer budget and
 * this module does not pretend it is — `OBSERVATION_UNAVAILABLE` exists for
 * exactly what is left.
 */
export const MERGE_TIMEOUT_MS = 60_000;

/**
 * The output budget.
 *
 * Generous on purpose and far larger than the response needs: a successful merge
 * answers three fields and about a hundred bytes. Nothing here parses the body,
 * so the budget is not about reading it — it is about not manufacturing
 * uncertainty. A response that overran its budget would be
 * `OUTPUT_LIMIT_EXCEEDED`, which this module must grade as a failed attempt,
 * which would then make a merge that really happened look uncertain.
 */
export const MERGE_MAX_RESPONSE_BYTES = 4_194_304;

/**
 * The fixed leading arguments of the one request this module makes.
 *
 * `--hostname github.com` is the destination, written here rather than taken
 * from the parsed identity, so repository configuration cannot choose where an
 * authenticated client points. `-X PUT` is the method, written out for the
 * reason in this module's header.
 */
export const FORGE_MERGE_PREFIX: readonly string[] = Object.freeze([
  'api',
  '--hostname',
  'github.com',
  '-X',
  'PUT',
]);

/**
 * The trailing arguments: read the body from standard input.
 *
 * A constant rather than two loose tokens so the suite can pin that the body
 * never has another source — a filename here would be a path this build put in
 * an argument vector, and a `-f`/`-F` field would be the two request fields back
 * in the vector they were moved out of.
 */
export const FORGE_MERGE_BODY_SOURCE: readonly string[] = Object.freeze(['--input', '-']);

/** The one endpoint. One repository, one pull request, one sub-resource. */
export function mergePath(owner: string, name: string, pullRequestNumber: number): string {
  return `repos/${owner}/${name}/pulls/${String(pullRequestNumber)}/merge`;
}

/** The whole argument vector for the one request. */
export function mergeRequestArgs(
  owner: string,
  name: string,
  pullRequestNumber: number,
): readonly string[] {
  return Object.freeze([
    ...FORGE_MERGE_PREFIX,
    mergePath(owner, name, pullRequestNumber),
    ...FORGE_MERGE_BODY_SOURCE,
  ]);
}

/**
 * The request body: two fields, both named, neither defaulted.
 *
 * `sha` is the fence and is the whole reason this slice can exist — omitting it
 * does not weaken the check, it removes it, and GitHub says nothing when it is
 * absent. The sibling asynchronous endpoint documents the consequence in words:
 * "If not provided, the current head of the PR at the time of the request will
 * be used." A caller who forgot it would merge whatever the branch holds.
 *
 * `merge_method` is written out because the REST schema declares **no default**
 * for it. A request that omitted it would take whatever GitHub chooses, which is
 * a repository policy decision made by silence.
 *
 * `commit_title` and `commit_message` are deliberately **absent**. They are the
 * only fields on this endpoint that would carry free text, this build has none
 * to send, and leaving them out means the merge commit's message is composed by
 * the repository's own configured convention rather than by AO.
 */
export function mergeRequestBody(subject: MergeSubject): string {
  return JSON.stringify({
    sha: subject.expectedHeadCommit,
    merge_method: subject.mergeMethod,
  });
}

/**
 * The seam the one mutation vector goes through.
 *
 * Separate from the observation transport's `ForgeCommandRunner` and from slice
 * 6's `ForgeMutationRunner`, and not a widening of either. The argument is slice
 * 6's about slice 5's Git runner, one step stronger: a test that stubs opening a
 * pull request must not be able to accidentally stub merging one, and a build
 * that stubbed either would still have to say so about the other. Three
 * mutations, three seams, and a fixture has to name the one it means.
 */
export type ForgeMergeRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxStdoutBytes: number;
    readonly maxStderrBytes: number;
    readonly stdin: string;
  },
) => Promise<CommandResult>;

/** The real runner: `exec.ts`, which spawns through the owned Windows boundary. */
export function createForgeMergeRunner(): ForgeMergeRunner {
  return async (command, args, options) => runCommand(command, args, options);
}

export interface PullRequestMergerDependencies {
  readonly runner: ForgeMergeRunner;
  /** The environment the policy is applied to. The command passes `process.env`. */
  readonly envSource: NodeJS.ProcessEnv;
}

/**
 * Sends exactly one merge request, and reports what became of the attempt.
 *
 * Never the effect. The three words it can return say what this process observed
 * about its own child, and the caller establishes the effect by reading the pull
 * request afterwards.
 *
 * `NOT_ATTEMPTED` is returned only where no process existed: an unsupported
 * host, an unusable environment, or an argument the grammar refuses. Those are
 * the three points before the child is started, and they are the only ones that
 * carry the guarantee "nothing happened".
 *
 * The host, the owner, the repository name and the expected head are re-tested
 * here, at the point where the vector is built, rather than trusted from whoever
 * produced the subject. A capability checked at one moment and used at another is
 * checked at the wrong moment: this is the last moment before a process exists,
 * two of these four are what the request path is made of, and the third is the
 * fence itself — a head that is not forty lowercase hex digits would be answered
 * `422` and would have spent a request to learn it.
 */
export async function mergePullRequestVia(
  subject: MergeSubject,
  deps: PullRequestMergerDependencies,
): Promise<MergeAttempt> {
  if (supportedForgeHost(subject.host) === null) return 'NOT_ATTEMPTED';
  if (!isAddressableSubject(subject.owner, subject.name, subject.expectedHeadCommit)) {
    return 'NOT_ATTEMPTED';
  }
  // The pull-request number is the third path segment and is re-tested for the
  // same reason. `String(1.5)` and `String(-1)` are both shell-inert and both
  // name no pull request; the mint refuses them, and this module does not depend
  // on it having.
  if (!Number.isSafeInteger(subject.pullRequestNumber)) return 'NOT_ATTEMPTED';
  if (subject.pullRequestNumber <= 0) return 'NOT_ATTEMPTED';

  let env: NodeJS.ProcessEnv;
  try {
    env = createProbeEnv(FORGE_ENV_POLICY, deps.envSource);
  } catch {
    return 'NOT_ATTEMPTED';
  }

  let result: CommandResult;
  try {
    result = await deps.runner(
      FORGE_CLIENT_COMMAND,
      mergeRequestArgs(subject.owner, subject.name, subject.pullRequestNumber),
      {
        env,
        cwd: FORGE_CLIENT_WORKING_DIRECTORY,
        timeoutMs: MERGE_TIMEOUT_MS,
        maxStdoutBytes: MERGE_MAX_RESPONSE_BYTES,
        maxStderrBytes: MERGE_MAX_RESPONSE_BYTES,
        stdin: mergeRequestBody(subject),
      },
    );
  } catch (error) {
    // `runCommand` is documented to throw exactly one error —
    // `UnsafeArgumentError`, for a token outside the argument grammar — and that
    // is a programming error in this repository rather than a runtime condition.
    // It is mapped to `NOT_ATTEMPTED` because it is raised before a process
    // exists, so the guarantee it carries is the true one: nothing happened.
    // Everything else propagates, so a defect anywhere under this call is not
    // laundered into a forge that did not answer.
    if (error instanceof UnsafeArgumentError) return 'NOT_ATTEMPTED';
    throw error;
  }

  // Three independent conditions, and all three must hold. The outcome says the
  // process ran to a regular completion; the exit code says the client accepted
  // the request; the delivery says the body it sent was the whole body — and a
  // partly delivered body here is a request that may have carried no `sha`, so
  // it is the condition that matters most. A run that satisfies two of the three
  // has not been shown to have asked for what this build intended, and `FAILED`
  // does not mean "no effect" — it means "not established", which is what the
  // reading afterwards is for.
  if (result.outcome !== 'COMPLETED') return 'FAILED';
  if (result.exitCode !== 0) return 'FAILED';
  if (result.stdinDelivery !== 'DELIVERED') return 'FAILED';
  return 'COMPLETED';
}
