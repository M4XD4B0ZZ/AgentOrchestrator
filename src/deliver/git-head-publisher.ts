/**
 * The two Git vectors this slice runs, and nothing else.
 *
 * One reads a single ref on the delivery remote. One creates a single ref on
 * the delivery remote. They are built here, frozen here, and pinned by exact
 * equality in the suite, because this is the file where a wrong token stops
 * being a bug and becomes an unintended effect on somebody else's repository.
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
 * slice whose whole subject is that push. It also carries `--editor`,
 * `--web`, `--fill` and an interactive prompt, none of which belongs in a
 * process with no terminal.
 *
 * `git push` has the opposite property: publishing is the only thing it does,
 * it takes a compare-and-swap, and it binds to an object name.
 *
 * ── Why the destination is a remote *name* ────────────────────────────────
 *
 * Not a URL. `delivery-target.ts` refuses to record a remote URL at all,
 * because a URL is the value most likely to carry a credential — and it reads
 * the *push* URL specifically (`git remote get-url --push --all`) to establish
 * the identity. So the identity in the grant and the destination in the vector
 * come from the same remote by construction, and no URL is ever assembled,
 * logged or rendered here.
 *
 * ── Why `--` ──────────────────────────────────────────────────────────────
 *
 * The remote name comes from a repository-authored profile. `--` stops Git
 * reading a name beginning with a dash as an option, the same guard
 * `delivery-target.ts` applies for the same reason. Measured: `git ls-remote
 * --exit-code -- origin refs/heads/main` and `git push --porcelain --atomic
 * --force-with-lease=<ref>: -- origin <sha>:<ref>` both accept it.
 *
 * ── Why nothing here parses Git's prose ───────────────────────────────────
 *
 * Both vectors are classified by exit code alone. Measured against github.com:
 * `ls-remote --exit-code` exits 0 with the ref present, 2 with it absent, and
 * 128 when it could not ask. That is a three-way answer with no English in it.
 * The push's own `--porcelain` output is requested and deliberately *not* read:
 * it exists so an operator running the same command by hand sees a stable
 * format, while this build takes its answer from a second `ls-remote`. Slice
 * 2's rule — a client's output stream carries whatever it wants, and none of it
 * is parsed, copied into a result, rendered or logged — applies unchanged.
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
 * The read vector. `--exit-code` is the token that turns "no output" into an
 * exit status, and it is what makes absence distinguishable from a failed
 * question without reading a byte of prose.
 */
export function remoteRefArgs(remoteName: string, ref: string): readonly string[] {
  return Object.freeze(['ls-remote', '--exit-code', '--', remoteName, ref]);
}

/**
 * The write vector, create-only.
 *
 * Token by token, and each was measured:
 *
 * `--porcelain` — a stable machine format for whoever reads the terminal. Not
 * parsed here.
 *
 * `--atomic` — one ref is pushed, so this changes nothing today. It is present
 * so that a later slice adding a second refspec cannot accidentally get a
 * partial push; a flag that has to be remembered later is a flag that will not
 * be.
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
 * The seam the orchestration runs its vectors through.
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

/**
 * Reads what the delivery remote holds under one exact ref.
 *
 * The first field of the first line is the object name. It is checked against
 * the object-name grammar rather than taken on trust: a value that reaches the
 * comparison in `gradeHeadPublication` decides whether this build claims an
 * effect, and an unparsable one must read as `UNKNOWN` — "I could not
 * establish it" — and never as a commit that will not match.
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

  const first = result.stdout.split('\n', 1)[0] ?? '';
  const commit = first.split('\t', 1)[0]?.trim() ?? '';
  if (!OBJECT_NAME.test(commit)) return READING_UNKNOWN;
  return Object.freeze({ outcome: 'AT_COMMIT' as const, commit });
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
