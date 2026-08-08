/**
 * Read-only Git queries for repository resolution.
 *
 * Two properties make this narrow on purpose.
 *
 * **It writes nothing.** V1-01 resolves a repository; it does not create a
 * branch, a worktree, a commit or a fetch. Every argument vector this module is
 * ever handed is a `rev-parse` / `remote` style question, and the module offers
 * no way to express anything else.
 *
 * **It inherits nothing that could redirect the answer.** The child environment
 * is built by `createProbeEnv('capability:generic', …)`, which forwards `PATH`
 * and `PATHEXT` and nothing else. That is what a `git` process needs to be
 * startable, and it is also what keeps `GIT_DIR`, `GIT_WORK_TREE`,
 * `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_*` and every other
 * `GIT_*` variable out of the child. Which repository answers a question is
 * therefore decided by the `cwd` this module passes — a canonical path the
 * resolver derived — and by nothing an operator or an attacker can set in the
 * environment. A developer's global `~/.gitconfig` cannot reach it either, so a
 * fixture and a production repository are read under identical rules.
 *
 * Execution goes through the hardened `runCommand` in `doctor/exec.ts`: no
 * shell, structural argument vector, bounded output, bounded wall clock, and
 * failures reported as data rather than as exceptions.
 */

import { createProbeEnv } from '../auth/env-guard.js';
import { runCommand } from '../doctor/exec.js';

/** How a query ended, in a closed vocabulary. Never an exception message. */
export type GitQueryOutcome =
  /** Git ran and exited 0. `stdout` is meaningful. */
  | 'OK'
  /** Git ran and exited non-zero. An answer of "no", not a broken tool. */
  | 'NONZERO_EXIT'
  /** Git could not be started, timed out, or flooded its output budget. */
  | 'UNAVAILABLE';

export interface GitQueryResult {
  readonly outcome: GitQueryOutcome;
  /** Trimmed stdout on `OK`, the empty string otherwise. */
  readonly stdout: string;
}

/** Wall-clock ceiling for a single local Git question. Generous but bounded. */
const GIT_QUERY_TIMEOUT_MS = 15_000;

/** A local `rev-parse` answers in bytes; a megabyte would already be absurd. */
const GIT_QUERY_MAX_OUTPUT_BYTES = 65_536;

const RESULT_UNAVAILABLE: GitQueryResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  stdout: '',
});

/**
 * Runs one read-only Git query inside `cwd`.
 *
 * `cwd` must already be a canonical, existing directory — this module does not
 * canonicalise, and in particular never falls back to `process.cwd()`.
 */
export async function gitQuery(
  cwd: string,
  args: readonly string[],
): Promise<GitQueryResult> {
  const result = await runCommand('git', args, {
    env: createProbeEnv('capability:generic', process.env),
    cwd,
    timeoutMs: GIT_QUERY_TIMEOUT_MS,
    maxStdoutBytes: GIT_QUERY_MAX_OUTPUT_BYTES,
    maxStderrBytes: GIT_QUERY_MAX_OUTPUT_BYTES,
  });

  if (result.outcome !== 'COMPLETED') return RESULT_UNAVAILABLE;
  if (result.exitCode !== 0) return Object.freeze({ outcome: 'NONZERO_EXIT' as const, stdout: '' });
  return Object.freeze({ outcome: 'OK' as const, stdout: result.stdout.trim() });
}
