/**
 * The GitHub pull-request creation transport — V4 slice 6.
 *
 * The second forge *mutation* class in this build, and the first one that is an
 * HTTP request rather than a Git ref update. Everything the observation
 * transport establishes about destination, environment and credentials holds
 * here unchanged, and is re-stated where it is re-applied rather than inherited
 * by proximity: the host is the constant `github.com`, the environment is built
 * by `createProbeEnv('forge:github', …)` and never inherited, and no token is
 * read, held or written by this build at any point.
 *
 * ── Why `gh api` and not `gh pr create` ───────────────────────────────────
 *
 * Measured, not assumed. `gh pr create --help` says, verbatim:
 *
 *   "When the current branch isn't fully pushed to a git remote, a prompt will
 *    ask where to push the branch and offer an option to fork the base
 *    repository."
 *
 * and its `--dry-run` is documented as *"Print details instead of creating the
 * PR. May still push git changes."* Its flag set carries `--editor`, `--web`,
 * `--fill`, `--fill-first`, `--fill-verbose` and `--template`: an editor, a
 * browser, and three ways to compose a pull-request body out of commit messages
 * this build never read. A command whose *non-creating* mode is documented as
 * possibly pushing is not a command a slice named after one mutation can use.
 *
 * `gh api` issues one request to the endpoint it is given and touches no Git
 * state. That is not the same as "exactly one HTTP request": the client makes
 * calls of its own — telemetry, and a periodic update check — which this build
 * does not suppress, and which `L-V4-02-6` records and every egress trailer
 * discloses. The claim that survives is about what *this build asks for*.
 *
 * ── `-X POST` is not decoration ───────────────────────────────────────────
 *
 * The observation transport pins `-X GET` because `gh api` documents its
 * default method as "GET normally and POST if any parameters were added". The
 * same switch fires on `--input`: with a body supplied and no `-X`, the method
 * becomes POST on its own. So the token is written out here for the mirror-image
 * reason it is written out there — the method must never be a consequence of
 * which other flags happen to be present — and the suite pins the whole vector
 * by exact equality rather than checking that `POST` occurs somewhere in it.
 *
 * ── The body goes on stdin, and that is a safety property ─────────────────
 *
 * `--input -` reads the request body from standard input. A pull request
 * carries a title and a body, which are the first values in this build's forge
 * traffic that are not identities or object names, and putting them in an
 * argument vector would mean quoting text — the transport this repository
 * refuses for data everywhere else. `JSON.stringify` produces the bytes,
 * `runCommand` writes them to the child and reports whether the whole payload
 * was handed over, and no shell is involved at any point.
 *
 * That report is load-bearing. A body that was only partly delivered produces
 * whatever GitHub makes of a truncated document, so this module grades the
 * attempt `FAILED` unless the payload was `DELIVERED` in full — the postcondition
 * reading then decides what actually happened, which is the same discipline the
 * exit code gets.
 *
 * ── What this module cannot promise ───────────────────────────────────────
 *
 * That the request did not take effect. Measured: `gh api` has no retry and no
 * deadline of its own, so the only deadline is this build's, and it is enforced
 * by killing the process rather than by cancelling the request. A timeout, a
 * lost process boundary or a killed child can therefore all land *after* GitHub
 * has committed the pull request and fired its notifications. Nothing here can
 * tell those apart from a request that never arrived — which is exactly why the
 * caller reads the forge afterwards and why this module returns a word about
 * the *attempt* and never about the effect.
 */

import { createProbeEnv } from '../auth/env-guard.js';
import { runCommand, UnsafeArgumentError, type CommandResult } from '../doctor/exec.js';
import { isAddressableSubject, supportedForgeHost } from './forge-observation.js';
import type { PullRequestAttempt } from './pull-request-creation.js';
import type { PullRequestCreationSubject } from './internal/pull-request-creation-grant.js';

/**
 * The program and the environment policy, imported and not restated.
 *
 * `tests/v4-02-…` proves that exactly one module in `src/` declares the forge
 * client's name, and that pin is the second egress pin in this repository: a
 * subprocess is invisible to the in-process socket pin, so "which files can
 * start a forge client" is the property that keeps a new egress class from
 * arriving unannounced. Declaring the client's name a second time here would
 * have made that pin measure less while adding nothing — the name is the same
 * name, and it should have one home. (The sentence avoids spelling the
 * declaration out, because the pin greps for exactly that spelling and a
 * comment is not an exception to it.)
 *
 * The same argument applies to the environment policy: two spellings of one
 * policy are two things that have to agree, and nothing that makes them.
 */
export { FORGE_CLIENT_COMMAND, FORGE_ENV_POLICY } from './github-observer.js';
import { FORGE_CLIENT_COMMAND, FORGE_ENV_POLICY } from './github-observer.js';

/**
 * A mutation, not a read. Thirty seconds, then nothing is *established* — which
 * is not the same as nothing having happened.
 *
 * Longer than the observation budget on purpose. A read that gives up too early
 * costs a retry; a *creation* that gives up too early leaves an effect nobody
 * can attribute, so the deadline is set where a premature kill is less likely
 * rather than where a fast answer is. It does not remove the window and this
 * module does not pretend it does.
 */
export const CREATION_TIMEOUT_MS = 30_000;

/**
 * The output budget.
 *
 * Generous on purpose, and larger than the response needs: a `201` pull-request
 * document measures about 23 KB. Nothing here parses the body, so the budget is
 * not about reading it — it is about not manufacturing uncertainty. A response
 * that overran its budget would be `OUTPUT_LIMIT_EXCEEDED`, which this module
 * must grade as a failed attempt, which would then make a perfectly successful
 * creation look uncertain.
 */
export const CREATION_MAX_RESPONSE_BYTES = 4_194_304;

/**
 * Where the client is run, and deliberately not a caller's choice.
 *
 * The same constant and the same measurement as the observation transport: the
 * client resolves its state directory relative to the working directory when
 * the environment does not name a home, and a client started outside any
 * repository has no working directory to infer repository context from.
 */
export { FORGE_CLIENT_WORKING_DIRECTORY } from './github-observer.js';
import { FORGE_CLIENT_WORKING_DIRECTORY } from './github-observer.js';

/**
 * The fixed leading arguments of the one request this module makes.
 *
 * `--hostname github.com` is the destination, written here rather than taken
 * from the parsed identity, so repository configuration cannot choose where an
 * authenticated client points. `-X POST` is the method, written out for the
 * reason in this module's header.
 */
export const FORGE_CREATE_PREFIX: readonly string[] = Object.freeze([
  'api',
  '--hostname',
  'github.com',
  '-X',
  'POST',
]);

/**
 * The trailing arguments: read the body from standard input.
 *
 * A constant rather than two loose tokens so the suite can pin that the body
 * never has another source — a filename here would be a path this build put in
 * an argument vector, and a `-f`/`-F` field would be the text back in the
 * vector it was moved out of.
 */
export const FORGE_CREATE_BODY_SOURCE: readonly string[] = Object.freeze(['--input', '-']);

/** The one endpoint. One repository, one collection, no query. */
export function pullRequestsPath(owner: string, name: string): string {
  return `repos/${owner}/${name}/pulls`;
}

/** The whole argument vector for the one request. */
export function createPullRequestArgs(owner: string, name: string): readonly string[] {
  return Object.freeze([
    ...FORGE_CREATE_PREFIX,
    pullRequestsPath(owner, name),
    ...FORGE_CREATE_BODY_SOURCE,
  ]);
}

/**
 * The head value GitHub is asked for, owner-qualified.
 *
 * Measured against github.com, all four on the real API:
 *
 *   `main`                       -> resolved
 *   `M4XD4B0ZZ:main`             -> resolved
 *   `refs/heads/main`            -> resolved
 *   `someone-else:main`          -> 422 {"field":"head","code":"invalid"}
 *   `5874deed…` (a real commit)  -> 422 {"field":"head","code":"invalid"}
 *
 * The owner-qualified form is used because it is the one that names a
 * repository. The bare form resolves against whatever GitHub decides the head
 * repository is, and this build has an exact answer for that and should say it.
 * The last measurement is the load-bearing one: **an object name is not
 * accepted here**, so the exact commit cannot be sent and can only be checked,
 * before and after.
 */
export function qualifiedHead(subject: PullRequestCreationSubject): string {
  return `${subject.owner}:${subject.headRef.slice('refs/heads/'.length)}`;
}

/**
 * The request body: five fields, all of them named.
 *
 * `draft` is written out even though the schema makes it optional, because
 * GitHub declares no default for it and this build never marks a pull request
 * ready or back to draft afterwards. A property nobody stated is a property
 * nobody decided.
 *
 * `maintainer_can_modify` is deliberately **absent**, and so is every other
 * field the endpoint accepts — `issue`, `head_repo`. A field this build does
 * not set is a field an operator's repository settings still own.
 */
export function pullRequestCreateBody(subject: PullRequestCreationSubject): string {
  return JSON.stringify({
    title: subject.title,
    head: qualifiedHead(subject),
    base: subject.baseRef,
    body: subject.body,
    draft: subject.draft,
  });
}

/**
 * The seam the one mutation vector goes through.
 *
 * Separate from the observation transport's `ForgeCommandRunner`, and not a
 * widening of it, for the reason slice 5 gives about its Git runner: a test
 * that stubs reading must not be able to accidentally stub writing, and a build
 * that stubbed one would still have to say so about the other. This one carries
 * `stdin`, which the reading seam deliberately does not.
 */
export type ForgeMutationRunner = (
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
export function createForgeMutationRunner(): ForgeMutationRunner {
  return async (command, args, options) => runCommand(command, args, options);
}

export interface PullRequestCreatorDependencies {
  readonly runner: ForgeMutationRunner;
  /** The environment the policy is applied to. The command passes `process.env`. */
  readonly envSource: NodeJS.ProcessEnv;
}

/**
 * Sends exactly one creation request, and reports what became of the attempt.
 *
 * Never the effect. The three words it can return say what this process
 * observed about its own child, and the caller establishes the effect by
 * reading the forge afterwards.
 *
 * `NOT_ATTEMPTED` is returned only where no process existed: an unsupported
 * host, an unusable environment, or an argument the grammar refuses. Those are
 * the three points before the child is started, and they are the only ones that
 * carry the guarantee "nothing happened".
 *
 * The host, the owner and the repository name are re-tested here, at the point
 * where the vector is built, rather than trusted from whoever produced the
 * subject. A capability checked at one moment and used at another is checked at
 * the wrong moment: this is the last moment before a process exists, and the
 * last two of the three are what the request path is made of.
 */
export async function createPullRequestVia(
  subject: PullRequestCreationSubject,
  deps: PullRequestCreatorDependencies,
): Promise<PullRequestAttempt> {
  if (supportedForgeHost(subject.host) === null) return 'NOT_ATTEMPTED';
  // The owner and the repository name are two thirds of the request path, and
  // they are re-tested here for the reason the host is: a guard read at another
  // moment is a guard about another moment, and this is the last one before a
  // process exists. `createObservationSubject` applies the same predicate
  // upstream — the point is that this module does not depend on it having.
  if (!isAddressableSubject(subject.owner, subject.name, subject.headCommit)) {
    return 'NOT_ATTEMPTED';
  }

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
      createPullRequestArgs(subject.owner, subject.name),
      {
        env,
        cwd: FORGE_CLIENT_WORKING_DIRECTORY,
        timeoutMs: CREATION_TIMEOUT_MS,
        maxStdoutBytes: CREATION_MAX_RESPONSE_BYTES,
        maxStderrBytes: CREATION_MAX_RESPONSE_BYTES,
        stdin: pullRequestCreateBody(subject),
      },
    );
  } catch (error) {
    // `runCommand` is documented to throw exactly one error — `UnsafeArgumentError`,
    // for a token outside the argument grammar — and that is a programming error
    // in this repository rather than a runtime condition. It is mapped to
    // `NOT_ATTEMPTED` because it is raised before a process exists, so the
    // guarantee it carries is the true one: nothing happened. Everything else
    // propagates, so a defect anywhere under this call is not laundered into a
    // forge that did not answer.
    if (error instanceof UnsafeArgumentError) return 'NOT_ATTEMPTED';
    throw error;
  }

  // Three independent conditions, and all three must hold. The outcome says the
  // process ran to a regular completion; the exit code says the client accepted
  // the request; the delivery says the body it sent was the whole body. A run
  // that satisfies two of the three has not been shown to have asked for what
  // this build intended, and `FAILED` here does not mean "no effect" — it means
  // "not established", which is what the reading afterwards is for.
  if (result.outcome !== 'COMPLETED') return 'FAILED';
  if (result.exitCode !== 0) return 'FAILED';
  if (result.stdinDelivery !== 'DELIVERED') return 'FAILED';
  return 'COMPLETED';
}
