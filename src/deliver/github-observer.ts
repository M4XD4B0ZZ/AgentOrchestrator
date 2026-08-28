/**
 * The GitHub observation transport — V4 slice 2.
 *
 * This is the second intentional network-egress class in this build, and the
 * first one a repository can be the *subject* of. The first — the ntfy
 * notification — is enabled by a file under the operator's own profile
 * directory and can never be switched on by anything inside a checkout. This
 * one keeps the same property by a different means, because its subject
 * unavoidably comes from repository configuration:
 *
 *  - the **destination** is a constant in this build. `--hostname github.com`
 *    is written here, and `SUPPORTED_FORGE_HOSTS` refuses every other host
 *    before a process is started. A remote URL cannot choose where the
 *    authenticated client points;
 *  - the **environment** is built, not inherited. `createProbeEnv('forge:github', …)`
 *    supplies `PATH`, `PATHEXT` and `APPDATA` and nothing else, so none of
 *    `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GH_HOST`, `GH_REPO`,
 *    `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `GH_DEBUG`, `GH_PAGER` or any proxy
 *    variable reaches the client. Each of those is documented by `gh help
 *    environment` as able to redirect authentication, host selection, the
 *    config location, or — for `GH_DEBUG=api` — to log HTTP traffic.
 *
 *    "Supplies" and not "is the child's environment": on Windows `runCommand`
 *    merges eleven fixed OS names into every child block — `SYSTEMROOT`,
 *    `USERPROFILE`, `TEMP` and eight more — so the client really does receive
 *    those. `tests/v4-02-…` pins that none of the eleven is one of the client's
 *    own documented override variables; the limits of that check, and the two
 *    names worth naming anyway, are set out at the policy itself and carried as
 *    `L-V4-02-9`;
 *  - the **credential** is never seen. `gh` reads its own stored login from the
 *    operator's config directory and attaches it itself. No token is passed in,
 *    none is read out, and no code path here handles credential bytes.
 *
 * ── stderr is not read, anywhere ───────────────────────────────────────────
 *
 * A forge client's error stream carries whatever it wants: an account name, a
 * URL, an upgrade notice, a proxy's error page. None of it is parsed, copied
 * into a result, rendered or logged. Every failure this module reports is
 * derived from the *outcome and exit code* of the process and from `stdout`
 * parsed as JSON — the same discipline `doctor/capabilities.ts` adopted when it
 * stopped persisting probe output at all.
 *
 * ── Why the GitHub CLI ─────────────────────────────────────────────────────
 *
 * `gh` is the transport because it owns the credential and this build then does
 * not have to. Writing an HTTP client here would mean AO reading a token,
 * holding it in a TypeScript value and putting it in a header — which is
 * exactly the material every other part of this repository is built to never
 * touch.
 *
 * ── Why REST and not GraphQL ───────────────────────────────────────────────
 *
 * Not because GraphQL is unreachable. It is reachable: a query document cannot
 * be an argument — `SAFE_ARG_PATTERN` in `doctor/exec.ts` refuses braces and
 * spaces — but `gh api graphql -F query=@-` takes the document on **stdin**,
 * which is a channel this build already uses for the agent prompt. It was
 * measured working. So the grammar narrows the shape; it does not decide the
 * question, and claiming it did would be a tidier story than the true one.
 *
 * The deciding property is how each one fails. A GraphQL response can be HTTP
 * 200 carrying `data` **and** `errors` together — measured, with the paginated
 * rollup returning `{"data":{…"statusCheckRollup":null},"errors":[…]}`. A
 * reader that took `data` at face value would read that as "this commit has no
 * checks", which is a fail-open produced by the successful path. A REST non-2xx
 * is a non-zero exit and no body this module will parse.
 *
 * GraphQL's one real advantage is that `GitObjectID!` refuses anything but a
 * full 40-hex object name at the type level, where REST's `{ref}` accepts an
 * abbreviation or a branch name. That guarantee is not given up — it is moved
 * into this build, where `isAddressableSubject` enforces it before a path is
 * built, and `tests/v4-02-…` hands the transport a subject whose commit is a
 * branch name and asserts the client is never started at all. Removing the
 * check turns that case red — measured by hand against this file, which is the
 * only place such a mutant can live. Owning the check is better than borrowing
 * it, because a borrowed one cannot be mutation-tested.
 */

import { tmpdir } from 'node:os';

import { createProbeEnv } from '../auth/env-guard.js';
import { runCommand, UnsafeArgumentError, type CommandResult } from '../doctor/exec.js';
import {
  aggregateCheckState,
  checkStateRefusal,
  COMMIT_UNRESOLVED,
  isAddressableSubject,
  locatorReportsNoCommit,
  matchExactHead,
  parseCheckRuns,
  parseCommitStatuses,
  parsePullCandidates,
  parsePullRequestRecord,
  pullRequestRefusal,
  supportedForgeHost,
  type CheckStateObservation,
  type ObservationRefusal,
  type ObservationSubject,
  type PullCandidate,
  type PullCandidatesRefusal,
  type PullRequestObservation,
} from './forge-observation.js';
import type { MergeReading, MergeReadingOutcome } from './pull-request-merge.js';

/** The program. Resolved on `PATH` by `exec.ts`; never a path from a variable. */
export const FORGE_CLIENT_COMMAND = 'gh';

/**
 * The page size asked for, and the size a full page is recognised by.
 *
 * One constant for both, deliberately: the truncation test is "did the forge
 * fill the page we asked for", and two numbers that could drift apart would
 * turn that test into a guess.
 */
export const OBSERVATION_PAGE_SIZE = 100;

/** A network request, not a local probe. Twenty seconds, then nothing is established. */
export const OBSERVATION_TIMEOUT_MS = 20_000;

/**
 * The output budget.
 *
 * Measured against `github.com` on 2026-08-23: one pull-request record is about
 * 23 KB and one check-run record about 3.6 KB, so a full page of either fits
 * inside this with room to spare. Exceeding it is `FORGE_CLIENT_UNUSABLE` — a
 * refusal, never a truncated body that gets parsed anyway.
 */
export const OBSERVATION_MAX_RESPONSE_BYTES = 4_194_304;

/** The environment policy this transport runs under. */
export const FORGE_ENV_POLICY = 'forge:github' as const;

/**
 * The fixed leading arguments of every request. Every token is load-bearing.
 *
 *  - `--hostname github.com` is the destination, written here rather than taken
 *    from the parsed identity, so repository configuration cannot choose where
 *    an authenticated client points.
 *  - **`-X GET` is not decoration.** `gh api` documents its default method as
 *    "GET normally and POST if any parameters were added", and every request
 *    below adds parameters. Without this pair, a read-only observation becomes
 *    a POST to the same path. It is the single token in this vector whose
 *    removal changes a read into a write, so `tests/v4-02-…` pins the whole
 *    vector by exact equality — not that `-X GET` occurs somewhere within it —
 *    and a second case reads back the token that follows `-X`. A committed test
 *    cannot delete a production token from this file; that mutant was run by
 *    hand and killed, and the equality pin is what keeps it killed.
 */
export const FORGE_REQUEST_PREFIX: readonly string[] = Object.freeze([
  'api',
  '--hostname',
  'github.com',
  '-X',
  'GET',
]);

/** The locator endpoint. Its answer is a candidate set, never a verdict. */
export function pullCandidatesPath(subject: ObservationSubject): string {
  return `repos/${subject.owner}/${subject.name}/commits/${subject.commit}/pulls`;
}

/** Check runs attached to exactly this commit. */
export function checkRunsPath(subject: ObservationSubject): string {
  return `repos/${subject.owner}/${subject.name}/commits/${subject.commit}/check-runs`;
}

/**
 * One pull request by number. The endpoint the merge path reads.
 *
 * The only endpoint in this build addressed by a pull-request number rather
 * than by an object name, and the reason is in
 * {@link parsePullRequestRecord}'s header: a merge is addressed by number, so
 * its postcondition has to be read by number too.
 */
export function pullRequestPath(subject: ObservationSubject, pullRequestNumber: number): string {
  return `repos/${subject.owner}/${subject.name}/pulls/${String(pullRequestNumber)}`;
}

/** The legacy commit-status mechanism for exactly this commit. */
export function commitStatusPath(subject: ObservationSubject): string {
  return `repos/${subject.owner}/${subject.name}/commits/${subject.commit}/status`;
}

/**
 * The page size, asked for on every request.
 *
 * The same number is the truncation test, so the two cannot drift apart.
 */
export const PER_PAGE_PARAM = `per_page=${String(OBSERVATION_PAGE_SIZE)}`;

/**
 * `filter=latest` on the check-runs endpoint, stated rather than inherited.
 *
 * It **is** that endpoint's documented default, and it is written out anyway.
 * A default is a decision somebody else can change; a repository whose check
 * has been re-run needs the most recent run per name rather than every run that
 * ever attached to the commit, and this build should say so where it can be
 * read and pinned. It is not applied to the other two endpoints, which have no
 * such parameter.
 */
export const CHECK_RUNS_FILTER_PARAM = 'filter=latest';

/** The whole argument vector for one request. */
export function forgeRequestArgs(path: string, params: readonly string[]): readonly string[] {
  const tail = params.flatMap((param) => ['-F', param]);
  return Object.freeze([...FORGE_REQUEST_PREFIX, path, ...tail]);
}

/**
 * The process seam.
 *
 * Required, with no default. Slice 1 learned this the same way: a seam with a
 * fallback is a seam a test can forget to supply, and the thing it would fall
 * back to here starts a real network client. A caller that wants the real one
 * asks for it by name.
 */
export type ForgeCommandRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly maxStdoutBytes: number;
    readonly maxStderrBytes: number;
  },
) => Promise<CommandResult>;

/** The real runner: `exec.ts`, which spawns through the owned Windows boundary. */
export function createForgeCommandRunner(): ForgeCommandRunner {
  return async (command, args, options) => runCommand(command, args, options);
}

export interface ForgeObserverDependencies {
  readonly runner: ForgeCommandRunner;
  /** The environment the policy is applied to. The command passes `process.env`. */
  readonly envSource: NodeJS.ProcessEnv;
}

/**
 * Where the client is run, and deliberately **not** a caller's choice.
 *
 * The first version of this module ran the client in the repository root, on
 * the reasoning that a spawned process needs some directory and the request
 * does not depend on which. The second half of that is true. The first half was
 * measured to be a defect:
 *
 *     cd <empty dir>
 *     env -i PATH=… PATHEXT=… APPDATA=… gh api --hostname github.com -X GET …
 *     -> exit 0, and  ./.local/state/gh/device-id  now exists
 *
 * The client keeps a telemetry device id under its state directory, and given
 * only the names this policy supplies — no `HOME`, no `USERPROFILE`, no
 * `XDG_STATE_HOME` — that directory resolves **relative to the working
 * directory**.
 *
 * ── How far that goes on the shipped path, measured rather than assumed ────
 *
 * Not that far, and the first version of this paragraph did not say so. The
 * environment above is the block this module *supplies*; on Windows
 * `runCommand` back-fills `USERPROFILE` into every child, and re-measured with
 * `USERPROFILE` present the same call wrote **nothing** into the working
 * directory. So the dirtied checkout is a real property of the policy block
 * alone and is **not** reproduced by the shipped Windows path.
 *
 * The constant stays anyway, on three grounds that survive that correction.
 * It costs nothing. It is the answer that is still right if the back-fill ever
 * narrows, and a guarantee that depends on another module's list not changing
 * is not one this module can make. And it closes a second hole independently of
 * the first: a client started outside any repository has no working directory
 * to infer repository context from, so the last path by which a checkout could
 * influence the request is gone too.
 *
 * It is a constant rather than a parameter because a parameter is something a
 * future caller can get wrong, and the wrong value runs an authenticated client
 * inside an operator's checkout.
 */
export const FORGE_CLIENT_WORKING_DIRECTORY = tmpdir();

type RequestResult<E extends string> =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly refusal: ObservationRefusal | E };

/**
 * Reads the error document of a request that did not succeed, or `null` for an
 * endpoint whose error documents this build does not read.
 *
 * Required at every call site, with no default, for the reason
 * {@link ForgeCommandRunner} gives about seams: a parameter with a fallback is
 * one a new endpoint can forget to think about, and the fallback here would
 * decide whether a body that came with a failing exit code is read at all.
 * Three of the four call sites pass `null`, which is what makes "the check
 * endpoints' errors are never read" a property of this file rather than a
 * sentence in it — and `E` then infers as `never`, so their results carry
 * exactly {@link ObservationRefusal} and nothing wider.
 */
type ErrorDocumentReader<E extends string> = ((stdout: string) => E | null) | null;

/**
 * One read-only request, classified into the closed vocabulary.
 *
 * The guard on the subject is repeated **here**, at the point where an argument
 * vector is built, rather than being trusted from whoever produced the subject.
 * A capability checked at one moment and used at another is checked at the
 * wrong moment: this is the moment that matters, because it is the last one
 * before a process exists.
 */
async function request<E extends string = never>(
  subject: ObservationSubject,
  path: string,
  params: readonly string[],
  deps: ForgeObserverDependencies,
  readError: ErrorDocumentReader<E>,
): Promise<RequestResult<E>> {  if (supportedForgeHost(subject.host) === null) {
    return Object.freeze({ ok: false as const, refusal: 'UNSUPPORTED_HOST' as const });
  }
  // The commit is re-tested here for a reason that is specific to REST: this
  // endpoint family takes a `{ref}`, and a ref is not an object name. Measured
  // against `github.com` — `commits/10583ee/check-runs` and even
  // `commits/main/check-runs` both answer 200. Nothing on the far side will
  // insist that the subject is a full object name, so this side must.
  if (!isAddressableSubject(subject.owner, subject.name, subject.commit)) {
    return Object.freeze({ ok: false as const, refusal: 'SUBJECT_UNUSABLE' as const });
  }

  // `createProbeEnv` throws on an ambiguous or unreadable source. This module
  // reports facts and refusals rather than raising, for every condition it has
  // a name for — which is not the same as never raising: a throw it has no name
  // for is a defect, and the runner guard below lets those through rather than
  // dressing them as a forge that did not answer. Caught here so that a machine
  // with two Windows spellings of one allow-listed name produces a closed answer
  // instead of an exception out of an observation.
  let env: NodeJS.ProcessEnv;
  try {
    env = createProbeEnv(FORGE_ENV_POLICY, deps.envSource);
  } catch {
    return Object.freeze({ ok: false as const, refusal: 'ENVIRONMENT_UNUSABLE' as const });
  }

  // `runCommand` is documented to throw exactly one error — `UnsafeArgumentError`,
  // for a token outside the argument grammar — and that is a programming error
  // in this repository rather than a runtime condition. The three existing seams
  // over it (`worktree/git-command.ts`, `agent/agent-command.ts`,
  // `verify/verify-command.ts`) all handle it the same way: turn that one error
  // into a typed refusal, and let everything else propagate. This does the same.
  //
  // The first version of this guard was a bare `catch` returning
  // `FORGE_CLIENT_UNUSABLE`, which was wrong twice. It laundered a programming
  // error into an operator-facing sentence that says the client *started* — and
  // it caught every other throw as well, so a defect anywhere under this call
  // would have been reported as a forge that did not answer.
  //
  // Unreachable today, and asserted so: every token this module can emit is
  // built from a validated subject and two module constants, and the suite
  // checks each one against `isShellInertArgument`. It is mapped rather than
  // rethrown because the vocabulary already has the honest name for it — an
  // argument this build will not put in a request is `SUBJECT_UNUSABLE`, which
  // is also true of the only way one could arise here. Nothing from the error
  // is read: it quotes the offending token.
  let result: CommandResult;
  try {
    result = await deps.runner(FORGE_CLIENT_COMMAND, forgeRequestArgs(path, params), {
      env,
      cwd: FORGE_CLIENT_WORKING_DIRECTORY,
      timeoutMs: OBSERVATION_TIMEOUT_MS,
      maxStdoutBytes: OBSERVATION_MAX_RESPONSE_BYTES,
      maxStderrBytes: OBSERVATION_MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    if (error instanceof UnsafeArgumentError) {
      return Object.freeze({ ok: false as const, refusal: 'SUBJECT_UNUSABLE' as const });
    }
    throw error;
  }

  if (result.outcome === 'NOT_FOUND') {
    return Object.freeze({ ok: false as const, refusal: 'FORGE_CLIENT_ABSENT' as const });
  }
  if (result.outcome !== 'COMPLETED') {
    // TIMED_OUT, OUTPUT_LIMIT_EXCEEDED, SPAWN_FAILED, BOUNDARY_LOST. None of
    // them produced an answer, and none of them is a smaller kind of answer.
    return Object.freeze({ ok: false as const, refusal: 'FORGE_CLIENT_UNUSABLE' as const });
  }
  // `gh help exit-codes` documents 4 as "a command requires authentication".
  // A completed run with no exit code at all is not a success either: it is a
  // completion this build cannot grade, so it is refused with the failures.
  if (result.exitCode === 4) {
    return Object.freeze({ ok: false as const, refusal: 'NOT_AUTHENTICATED' as const });
  }
  if (result.exitCode !== 0) {
    // The one place a body that came with a failing exit code is read at all,
    // and it is read as an **error document** — never handed to the parser
    // below, which turns a response into evidence. Three of the four call sites
    // supply no reader, so for them this branch is the same single line it was
    // before V4 slice 18R.
    //
    // Deliberately after the exit-code judgements above and not before them: a
    // client that timed out, could not be found or reports that it needs an
    // authentication has produced no answer, and a document on its stdout would
    // not be one either.
    const read = readError === null ? null : readError(result.stdout);
    if (read !== null) return Object.freeze({ ok: false as const, refusal: read });
    return Object.freeze({ ok: false as const, refusal: 'REQUEST_FAILED' as const });
  }

  // Only now. A non-2xx from `gh api` still writes GitHub's error document to
  // stdout — measured: a 404 prints `{"message":"Not Found",…,"status":"404"}`
  // and exits 1. Parsing before the exit code was judged would read that
  // object as an answer.
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    // The parser's message quotes the input it choked on. It is not surfaced.
    return Object.freeze({ ok: false as const, refusal: 'RESPONSE_MALFORMED' as const });
  }
  return Object.freeze({ ok: true as const, body });
}

/**
 * Question 1 — is there exactly one **open** pull request whose current head
 * object name is exactly the subject commit?
 *
 * The endpoint is a locator: it answers "which pull requests contain this
 * commit", and reports each one's head as it stands now. Every candidate is
 * therefore re-tested against its own head. See `forge-observation.ts` for the
 * measurement that forced this.
 */
export async function observePullRequestAtHead(
  subject: ObservationSubject,
  deps: ForgeObserverDependencies,
): Promise<PullRequestObservation> {
  const read = await readPullCandidatesAtHead(subject, deps);
  if (!read.ok) {
    // The locator can now answer one thing this question has no word for: that
    // the forge would not resolve the subject to a commit at all. It is graded
    // back down to `REQUEST_FAILED` here, deliberately, and the decision is
    // narrow rather than lazy.
    //
    // This question's vocabulary is `MATCHED`, `NO_MATCHING_PULL_REQUEST`,
    // `AMBIGUOUS` and the shared refusals, and every member of it is about a
    // pull request. "The forge would not resolve this object name" is not an
    // answer about a pull request; it is the refusal to give one, which is what
    // `REQUEST_FAILED` already says here and says truthfully. Giving it a
    // member of its own would put a fourth non-refusal word in front of the
    // settled allow-list and in front of the durable record contract, for the
    // sake of one report line — and the one caller that needs the distinction
    // reads the locator directly and gets it unchanged.
    return pullRequestRefusal(
      read.refusal === COMMIT_UNRESOLVED ? 'REQUEST_FAILED' : read.refusal,
    );
  }

  return matchExactHead(read.candidates, subject.commit);
}

/**
 * The same request and the same parse, stopping one step earlier.
 *
 * V4 slice 6 asks a wider question than question 1 does — not "is there exactly
 * one open pull request at this head" but "what is the whole pull-request
 * situation at this head, open or not, and what does each one target". It needs
 * the candidate set rather than the verdict.
 *
 * Factored out rather than reimplemented, and {@link observePullRequestAtHead}
 * now goes through it: one request vector, one parse, one place where the
 * endpoint's shape is known. Two readers of one endpoint that had to agree, and
 * nothing that made them, is the defect this avoids — the same argument
 * `publishableRef` lost when a review found its second copy of a regex.
 */
export async function readPullCandidatesAtHead(
  subject: ObservationSubject,
  deps: ForgeObserverDependencies,
): Promise<
  | { readonly ok: true; readonly candidates: readonly PullCandidate[] }
  | { readonly ok: false; readonly refusal: PullCandidatesRefusal }
> {
  const response = await request(
    subject,
    pullCandidatesPath(subject),
    [PER_PAGE_PARAM],
    deps,
    // The one endpoint whose error document is read, and the only reading taken
    // from one. `locatorReportsNoCommit` says what it establishes and — at
    // greater length — what it does not; the short form is that it is the
    // forge's own answer that it will not resolve this object name to a commit
    // in this repository, and that it is not a statement about the world.
    //
    // The subject bound into the closure is the same `subject.commit` the path
    // above was built from, which is what makes a crossed or replayed answer
    // unclassifiable rather than accepted.
    (stdout) => (locatorReportsNoCommit(stdout, subject.commit) ? COMMIT_UNRESOLVED : null),
  );
  if (!response.ok) return Object.freeze({ ok: false as const, refusal: response.refusal });

  const parsed = parsePullCandidates(response.body, OBSERVATION_PAGE_SIZE);
  if (!parsed.ok) return Object.freeze({ ok: false as const, refusal: parsed.refusal });

  return Object.freeze({ ok: true as const, candidates: parsed.candidates });
}

/**
 * Reads one pull request by number, and turns it into a merge reading.
 *
 * The same request vector, the same environment policy and the same budgets as
 * every other reading this build takes — `-X GET`, `--hostname github.com`, the
 * probe environment, the temporary working directory. What is new is the path
 * and the parse, and nothing else.
 *
 * It is deliberately not merge-eligibility logic. It reports what the pull
 * request *is* — open, closed unmerged, or merged, at which head, into which
 * base, draft or not, and the resulting commit when there is one — and decides
 * nothing about whether it may be merged. That decision is the operator's, and
 * the enforcement is GitHub's.
 *
 * The number is re-tested here rather than trusted, for the reason
 * {@link request} gives about the host and the subject: it is a path segment,
 * and this is the last moment before a process exists. `SUBJECT_UNUSABLE` is the
 * vocabulary's name for "an argument this build will not put in a request",
 * which is what a number that is not a positive safe integer is.
 *
 * The mapping from the parsed record to one word is narrow on purpose:
 *
 *   merged === true   -> MERGED
 *   state === 'open'  -> OPEN
 *   state === 'closed'-> CLOSED_UNMERGED
 *   anything else     -> UNKNOWN
 *
 * The last arm is the fail-closed one and it is not decoration. GitHub's `state`
 * is documented as `open` or `closed` today, and a third value from a future API
 * must not be read as either — it arrives as "I could not establish what this
 * is", which is the only honest reading of a word this build has never seen.
 */
export async function readPullRequestByNumber(
  subject: ObservationSubject,
  pullRequestNumber: number,
  deps: ForgeObserverDependencies,
): Promise<
  | { readonly ok: true; readonly reading: MergeReading }
  | { readonly ok: false; readonly refusal: ObservationRefusal }
> {
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    return Object.freeze({ ok: false as const, refusal: 'SUBJECT_UNUSABLE' as const });
  }

  // The path is built into a local first, and that is not style. The suite
  // reads every `request(...)` call site's third argument to prove the `-F`
  // params are this module's own constants, and it requires that argument to be
  // an array literal it can see. A path expression carrying its own comma
  // splits that read and hides the params behind it — measured: the sweep
  // captured `pullRequestNumber` and refused it.
  const path = pullRequestPath(subject, pullRequestNumber);
  // No params at all: this endpoint takes none, so this request carries no `-F`.
  // No error document is read here. A pull request addressed by number is a
  // different question with a different vocabulary, and the one document this
  // build recognises is the locator's.
  const response = await request(subject, path, [], deps, null);
  if (!response.ok) return Object.freeze({ ok: false as const, refusal: response.refusal });

  const parsed = parsePullRequestRecord(response.body);
  if (!parsed.ok) return Object.freeze({ ok: false as const, refusal: parsed.refusal });

  const record = parsed.record;
  const outcome: MergeReadingOutcome = record.merged
    ? 'MERGED'
    : record.state === 'open'
      ? 'OPEN'
      : record.state === 'closed'
        ? 'CLOSED_UNMERGED'
        : 'UNKNOWN';
  const settled = outcome !== 'UNKNOWN';

  return Object.freeze({
    ok: true as const,
    reading: Object.freeze({
      outcome,
      // A reading whose state this build does not recognise establishes nothing
      // about the pull request, so it carries nothing about it either. Handing
      // back a number and a head under `UNKNOWN` would invite a consumer to use
      // them.
      number: settled ? record.number : null,
      headSha: settled ? record.headSha : null,
      baseRef: settled ? record.baseRef : null,
      draft: settled ? record.draft : null,
      mergeCommit: outcome === 'MERGED' ? record.mergeCommitSha : null,
    }),
  });
}

/**
 * Question 2 — what is the check state of exactly this commit?
 *
 * Two requests, because GitHub carries check state in two independent
 * mechanisms and either can gate a merge. Both must succeed: an aggregate
 * computed from one of them while the other went unread would be a claim about
 * a subset. If either request or either parse refuses, the whole answer is that
 * refusal.
 *
 * ── The order is load-bearing ──────────────────────────────────────────────
 *
 * Check runs are asked for **first**, and that is not arbitrary. Measured
 * against `github.com`: for a commit object name that does not exist in the
 * repository, `commits/{sha}/check-runs` answers HTTP 422 — a non-zero exit —
 * while `commits/{sha}/status` answers **HTTP 200** with
 * `{"state":"pending","total_count":0,"statuses":[]}`, echoing the requested
 * sha back. The combined-status endpoint cannot tell "no legacy statuses" from
 * "no such commit", so on its own it would turn a typo into a permanent
 * `PENDING` an operator would sit and wait on. Asking check runs first means a
 * commit that is not in the repository is refused before the endpoint that
 * would have invented an answer is ever reached.
 */
export async function observeCheckStateAtCommit(
  subject: ObservationSubject,
  deps: ForgeObserverDependencies,
): Promise<CheckStateObservation> {
  const runsResponse = await request(
    subject,
    checkRunsPath(subject),
    [PER_PAGE_PARAM, CHECK_RUNS_FILTER_PARAM],
    deps,
    // **No error document is read here, and that is the guard, not an
    // omission.** Measured: for a commit the repository cannot resolve, this
    // endpoint answers the byte-identical missing-commit message the locator
    // does. Reading it here would put a member this build invented in front of
    // the settled-check allow-list, which is one refactor away from a commit
    // with no checks being graded as though it had some. The check state of a commit
    // the forge will not resolve is not a smaller answer; it is no answer.
    null,
  );
  if (!runsResponse.ok) return checkStateRefusal(runsResponse.refusal);
  const runs = parseCheckRuns(runsResponse.body, subject.commit);
  if (!runs.ok) return checkStateRefusal(runs.refusal);

  const statusResponse = await request(
    subject,
    commitStatusPath(subject),
    [PER_PAGE_PARAM],
    deps,
    // And none here either — this endpoint answers HTTP 200 for a commit that
    // is not in the repository, so it has no error document to read.
    null,
  );
  if (!statusResponse.ok) return checkStateRefusal(statusResponse.refusal);
  const statuses = parseCommitStatuses(statusResponse.body, subject.commit);
  if (!statuses.ok) return checkStateRefusal(statuses.refusal);

  return aggregateCheckState(runs.runs, statuses.statuses);
}
