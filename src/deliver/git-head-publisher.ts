/**
 * The Git vectors this slice runs, and nothing else.
 *
 * They are built here, frozen here, and pinned by exact equality in the suite,
 * because this is the file where a wrong token stops being a bug and becomes an
 * unintended effect on somebody else's repository.
 *
 * ── Why `git` and not the GitHub CLI ──────────────────────────────────────
 *
 * Slice 2 chose `gh` for reading, and the reasons still hold there: it owns the
 * credential material, the host is a literal in the vector, and the answers are
 * structured. For *this* operation the write path was re-evaluated from
 * scratch and `gh` lost, on measured grounds.
 *
 * `gh pr create --help`, gh 2.97.0, verbatim: "When the current branch isn't
 * fully pushed to a git remote, a prompt will ask where to push the branch and
 * offer an option to fork the base repository. Use `--head` to explicitly skip
 * any forking or pushing behavior." And on its dry run: "Print details instead
 * of creating the PR. **May still push git changes.**" A tool that pushes as a
 * side effect of a command named after something else is the wrong tool for the
 * slice whose whole subject is that push. It also carries `--editor`, `--web`,
 * `--fill` and an interactive prompt, none of which belongs in a process with
 * no terminal.
 *
 * `git push` has the opposite property: publishing is the only thing it does,
 * it takes a compare-and-swap, and it binds to an object name.
 *
 * ── Why the effect has to be pinned against the operator's own config ─────
 *
 * A vector is not the effect. Git reads three config scopes, and a review
 * measured that the child sees all of them under this build's environment
 * policy — the system file, the user's `~/.gitconfig`, and the repository's
 * own `.git/config`. Two of those settings add refs or arbitrary code to a push
 * that names neither, and both are ordinary things for a person to have:
 *
 *  - `push.followTags = true` — measured: the exact vector below, without the
 *    pins, created `refs/heads/feat` **and** an annotated tag on the
 *    destination. With `--atomic`, a tag the server refuses would also abort
 *    the branch create;
 *  - a `pre-push` hook — measured: it ran, was handed the remote URL, wrote to
 *    the terminal, and by exiting non-zero **aborted the publication**.
 *
 * So the four `-c` tokens are part of the contract, not hygiene.
 * `commit-task-work.ts` already pins `core.hooksPath=` for a purely *local*
 * commit; the one command in this build that changes a forge cannot pin less.
 *
 * Measured and deliberately *not* pinned: a configured `remote.<name>.push`
 * refspec adds nothing, because an explicit command-line refspec supersedes it,
 * and `remote.<name>.mirror = true` fails closed (`fatal: --mirror can't be
 * combined with refspecs`, exit 128, remote unchanged). Both were tried.
 *
 * ── Why the fetch and push URLs must agree before anything happens ────────
 *
 * `git ls-remote <remote>` reads the remote's **fetch** URL. `git push
 * <remote>` writes to its **push** URL when `remote.<name>.pushurl` is set.
 * Slice 1 binds the delivery identity to the push URL, deliberately and with
 * its own measurement. So when the two diverge, this build would read one
 * repository and write another — and every outcome it reported would be about
 * the wrong one. Measured: with `url` and `pushurl` pointing at different
 * repositories, `ls-remote` answered from the first and `push` wrote to the
 * second.
 *
 * `ls-remote` has no `--push` (measured: `error: unknown option 'push'`), and
 * putting a URL in an argument vector is exactly what `delivery-target.ts`
 * refuses to do, because a URL is the value most likely to carry a credential.
 * So the divergence is *detected* and refused rather than worked around. The
 * two URL lists are compared in memory and neither is recorded, rendered or
 * logged.
 *
 * ── Why the destination is a remote *name* ────────────────────────────────
 *
 * Not a URL, for the reason just given. `delivery-target.ts` reads the push URL
 * to establish the identity and refuses to record it; the vectors here name the
 * remote, so no URL is ever assembled here at all.
 *
 * ── Why `--` ──────────────────────────────────────────────────────────────
 *
 * The remote name comes from a repository-authored profile. `--` stops Git
 * reading a name beginning with a dash as an option, the same guard
 * `delivery-target.ts` applies for the same reason. Measured on all four
 * vectors below.
 *
 * ── Why nothing here parses Git's prose ───────────────────────────────────
 *
 * Every vector is classified by exit code and by fields whose grammar this
 * build checks. Measured against github.com: `ls-remote --exit-code` exits 0
 * with the matches, 2 when the pattern matched nothing, and 128 when it could
 * not ask. The push's own `--porcelain` output is requested and deliberately
 * *not* read: it exists so an operator running the same command by hand sees a
 * stable format, while this build takes its answer from a second `ls-remote`.
 * Slice 2's rule — a client's error stream carries whatever it wants, and none
 * of it is parsed, copied into a result, rendered or logged — applies
 * unchanged.
 */

import { createProbeEnv } from '../auth/env-guard.js';
import { runCommand } from '../doctor/exec.js';
import type { RemoteRefReading } from './head-publication.js';

/** The program. Named distinctly: the forge client constant belongs to slice 2. */
export const GIT_PUBLICATION_COMMAND = 'git';

/**
 * A network round trip to a forge, not a local object-database question.
 *
 * `git-query.ts` allows fifteen seconds for a `rev-parse`; this is two orders
 * of magnitude more work. The ceiling is `runGitCommand`'s, which is the one
 * this build already uses for Git operations that do real work.
 */
export const PUBLICATION_TIMEOUT_MS = 120_000;

/** One ref name and one object name. A kilobyte would already be generous. */
export const PUBLICATION_MAX_OUTPUT_BYTES = 65_536;

/** `git ls-remote --exit-code` exits with this when the pattern matched nothing. */
const LS_REMOTE_NO_MATCH = 2;

/**
 * The config this build refuses to let an operator's environment supply.
 *
 * Every entry was measured, and the first two were measured *changing the
 * effect* of the vector below. They are `-c` tokens rather than a checked
 * precondition because a precondition can be read at one moment and the child
 * started at another, and because refusing a person's own reasonable config
 * would be the wrong answer: the fix is that their config does not reach this
 * one command.
 */
export const PUBLICATION_CONFIG_PINS: readonly string[] = Object.freeze([
  /** Measured: `true` makes the push carry annotated tags the vector never names. */
  'push.followTags=false',
  /** A submodule push would touch refs in another repository entirely. */
  'push.recurseSubmodules=no',
  /** A signing prompt in a process with no terminal is a hang, not a signature. */
  'push.gpgSign=false',
  /** Measured: a `pre-push` hook ran, saw the remote URL, and aborted the push. */
  'core.hooksPath=',
]);

const configTokens = (): readonly string[] =>
  PUBLICATION_CONFIG_PINS.flatMap((pin) => ['-c', pin]);

/**
 * The two local questions that establish the remote is one repository.
 *
 * `--all` because a remote may carry more than one URL and a push goes to every
 * one of them; `--push` on the second because that is the list a push actually
 * writes to. Both run locally and contact nothing.
 */
export function remoteFetchUrlArgs(remoteName: string): readonly string[] {
  return Object.freeze(['remote', 'get-url', '--all', '--', remoteName]);
}

export function remotePushUrlArgs(remoteName: string): readonly string[] {
  return Object.freeze(['remote', 'get-url', '--push', '--all', '--', remoteName]);
}

/**
 * The read vector. `--exit-code` turns "no output" into an exit status, which
 * is what makes absence distinguishable from a failed question without reading
 * a byte of prose.
 *
 * The trailing argument is a **pattern**, not an exact ref, and that is a
 * property of the command rather than a choice: `git-ls-remote(1)` matches a
 * pattern "against the tail of a ref, starting either from the start of the ref
 * or from a slash separator". Measured — `refs/heads/foo` matches a remote's
 * `refs/heads/aaa/refs/heads/foo` when the real ref does not exist at all. The
 * exactness therefore cannot live in the vector, and lives in
 * {@link readRemoteRef}, which compares the ref name the remote answered with.
 */
export function remoteRefArgs(remoteName: string, ref: string): readonly string[] {
  return Object.freeze(['ls-remote', '--exit-code', '--', remoteName, ref]);
}

/**
 * The write vector, create-only.
 *
 * Token by token, and each was measured:
 *
 * the `-c` pins — see {@link PUBLICATION_CONFIG_PINS}. Without them the effect
 * is whatever the operator's Git config says it is.
 *
 * `--porcelain` — a stable machine format for whoever reads the terminal. Not
 * parsed here.
 *
 * `--atomic` — one ref is pushed, so this changes nothing today. It is present
 * so that a later slice adding a second refspec cannot accidentally get a
 * partial push; a flag that has to be remembered later is a flag that will not
 * be. With `push.followTags` pinned off there is no second ref for it to
 * couple this one to.
 *
 * `--force-with-lease=<ref>:` — the compare-and-swap, with an **empty** expected
 * value. Measured: empty means *this ref must not exist*, so an existing ref is
 * rejected with `(stale info)` even when the update would fast-forward cleanly.
 * The expected value is not a parameter and cannot be supplied by a caller,
 * because the same flag with a *correct* expected value performs a forced
 * update and rewrites the branch — measured, and never wanted here.
 *
 * `<commit>:<ref>` — an object name on the left, never a branch name. A local
 * branch that moves between the grant and the push cannot change what is
 * published.
 *
 * Note what is absent: no `--force`, no `--delete`, no `--mirror`, no `--all`,
 * no `--tags`, no `--set-upstream`, no second refspec.
 */
export function publishHeadArgs(
  remoteName: string,
  ref: string,
  commit: string,
): readonly string[] {
  return Object.freeze([
    ...configTokens(),
    'push',
    '--porcelain',
    '--atomic',
    `--force-with-lease=${ref}:`,
    '--',
    remoteName,
    `${commit}:${ref}`,
  ]);
}

/**
 * The seam the vectors go through.
 *
 * Shaped so a test can answer without a network and without a `git`. It carries
 * no `stdin` field, for the reason slice 2 gives: nothing on this path has
 * anything to say to the child, and a channel that exists is a channel someone
 * will put a task title down.
 */
export interface GitPublicationRunner {
  (
    args: readonly string[],
    options: {
      readonly env: NodeJS.ProcessEnv;
      readonly cwd: string;
      readonly timeoutMs: number;
      readonly maxStdoutBytes: number;
      readonly maxStderrBytes: number;
    },
  ): Promise<{
    readonly outcome: string;
    readonly exitCode: number | null;
    readonly stdout: string;
  }>;
}

const defaultRunner: GitPublicationRunner = (args, options) =>
  runCommand(GIT_PUBLICATION_COMMAND, args, options);

function optionsFor(cwd: string) {
  return {
    env: createProbeEnv('capability:generic', process.env),
    cwd,
    timeoutMs: PUBLICATION_TIMEOUT_MS,
    maxStdoutBytes: PUBLICATION_MAX_OUTPUT_BYTES,
    maxStderrBytes: PUBLICATION_MAX_OUTPUT_BYTES,
  };
}

const READING_UNKNOWN: RemoteRefReading = Object.freeze({
  outcome: 'UNKNOWN' as const,
  commit: null,
});

const READING_ABSENT: RemoteRefReading = Object.freeze({
  outcome: 'ABSENT' as const,
  commit: null,
});

/** Forty or sixty-four lowercase hex digits, anchored. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Whether one remote is one repository for both reading and writing. */
export const URL_AGREEMENTS = ['AGREE', 'DIVERGE', 'UNKNOWN'] as const;
export type UrlAgreement = (typeof URL_AGREEMENTS)[number];

/**
 * Establishes that the remote this build would read is the one it would write.
 *
 * Compares the two URL lists as opaque strings. Neither is parsed, split,
 * normalised or kept: the question is only whether they are the same answer,
 * and any difference at all is a divergence, because a difference this build
 * decided to forgive would be a difference it had to understand.
 *
 * What it establishes is that the two *lists* are the same list — not that
 * either names one repository. A remote with two fetch URLs and the same two
 * push URLs agrees here, and a push would write to both. That case cannot reach
 * this build because slice 1 refuses a remote whose `get-url --push --all`
 * answers with more than one line (`delivery-target.ts`,
 * `REMOTE_URL_AMBIGUOUS`), so the delivery target never resolves and no grant
 * is minted. The dependency is stated because it is load-bearing and lives in
 * another module.
 *
 * Both questions are local. Nothing is contacted here. They are a precondition
 * read a moment before the push child starts, which is the shape
 * {@link PUBLICATION_CONFIG_PINS} argues against — and it is unavoidable:
 * `ls-remote` has no `--push`, so there is no way to fold this into the vector.
 * The window is small, real, and named rather than hidden.
 */
export async function readUrlAgreement(
  repositoryRoot: string,
  remoteName: string,
  runner: GitPublicationRunner = defaultRunner,
): Promise<UrlAgreement> {
  const options = optionsFor(repositoryRoot);
  const fetched = await runner(remoteFetchUrlArgs(remoteName), options);
  if (fetched.outcome !== 'COMPLETED' || fetched.exitCode !== 0) return 'UNKNOWN';
  const pushed = await runner(remotePushUrlArgs(remoteName), options);
  if (pushed.outcome !== 'COMPLETED' || pushed.exitCode !== 0) return 'UNKNOWN';
  const fetchUrls = fetched.stdout.trim();
  const pushUrls = pushed.stdout.trim();
  // Two empty answers are equal and establish nothing. `delivery-target.ts`
  // guards the analogous case explicitly; this one did not, which made the sole
  // fail-closed precondition in this file fail open.
  if (fetchUrls.length === 0 || pushUrls.length === 0) return 'UNKNOWN';
  return fetchUrls === pushUrls ? 'AGREE' : 'DIVERGE';
}

/**
 * Reads what the delivery remote holds under one exact ref.
 *
 * The exactness is enforced here and not by the vector, because `ls-remote`
 * takes a pattern that matches ref *tails* — measured, `refs/heads/foo` is
 * answered by a remote's `refs/heads/aaa/refs/heads/foo`. So every line is
 * scanned for one whose ref field is exactly the ref asked about, and the
 * commit is taken from that line or from none.
 *
 * A pattern that matched something, none of which is the ref, reads as
 * `ABSENT` — because that is what it means: this ref is not there. Only a
 * question that could not be asked, or an answer whose object name is not one,
 * reads as `UNKNOWN`. Getting that distinction wrong in the other direction
 * would let a stranger's nested branch decide whether this build publishes.
 */
export async function readRemoteRef(
  repositoryRoot: string,
  remoteName: string,
  ref: string,
  runner: GitPublicationRunner = defaultRunner,
): Promise<RemoteRefReading> {
  const result = await runner(remoteRefArgs(remoteName, ref), optionsFor(repositoryRoot));
  if (result.outcome !== 'COMPLETED') return READING_UNKNOWN;
  if (result.exitCode === LS_REMOTE_NO_MATCH) return READING_ABSENT;
  if (result.exitCode !== 0) return READING_UNKNOWN;

  for (const line of result.stdout.split('\n')) {
    const [commit, name] = line.split('\t');
    if (name?.trim() !== ref) continue;
    const object = commit?.trim() ?? '';
    // The ref is there. If its object name is not one this build recognises,
    // that is a failure to establish what it holds — never an absence, and
    // never a value carried forward into a comparison.
    return OBJECT_NAME.test(object)
      ? Object.freeze({ outcome: 'AT_COMMIT' as const, commit: object })
      : READING_UNKNOWN;
  }
  return READING_ABSENT;
}

/**
 * Runs the create-only push exactly once.
 *
 * Returns only whether the command completed with a zero status. Nothing about
 * *what* it did is read from here — that is the second `ls-remote`'s job — and
 * there is deliberately no retry: a non-idempotent effect whose outcome is
 * unknown is re-attempted by a human asking again, which begins with a reading.
 */
export async function pushDeliveryHead(
  repositoryRoot: string,
  remoteName: string,
  ref: string,
  commit: string,
  runner: GitPublicationRunner = defaultRunner,
): Promise<boolean> {
  const result = await runner(publishHeadArgs(remoteName, ref, commit), optionsFor(repositoryRoot));
  return result.outcome === 'COMPLETED' && result.exitCode === 0;
}
