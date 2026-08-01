/**
 * INTERNAL — the trusted OS user profile directory
 * (AO-007-R1-RR1, AO-007-R1-RR3, AO-WINPROFILE-001).
 *
 * ── Why `os.homedir()` cannot be called ────────────────────────────────────
 *
 * On Windows, `uv_os_homedir` returns the profile-directory environment
 * variable when it is set, and only falls back to the Win32 token API when it
 * is not. In a normal interactive session it is always set, so `os.homedir()`
 * is an environment read wearing an OS-API costume: an attacker-controlled
 * value relocates every persistent artefact the orchestrator writes. The POSIX
 * passwd-lookup fallback variable, its Windows drive/path split, the two
 * application-data variables and the removed `AGENT_LOOP_HOME` are all in the
 * same category — none of them may decide where diagnostics land.
 *
 * ── Why `os.userInfo().homedir` is the answer ───────────────────────────────
 *
 * `uv_os_get_passwd`, which backs `os.userInfo()`, reads no environment at all:
 * on Windows it resolves the profile directory from the *process token* via
 * `GetUserProfileDirectoryW`, and on POSIX from the passwd database entry for
 * the real uid. Measured on this platform before the change (AO-WINPROFILE-001
 * section 4): with `USERPROFILE`, `HOME`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`,
 * `LOCALAPPDATA`, `SystemRoot`, `windir`, `ComSpec`, `PATH` and `PATHEXT` all
 * set to non-existent decoys, `os.homedir()` followed the decoy while
 * `os.userInfo().homedir` returned the real profile path unchanged, both in a
 * running process and in a freshly spawned one.
 *
 * ── Why there is no helper process any more ─────────────────────────────────
 *
 * This module used to answer the question by spawning a child: `node -e` with a
 * fixed source string on POSIX, and Windows PowerShell with a fixed
 * `GetFolderPath` one-liner on Windows. That worked, but the Windows branch had
 * to *locate* PowerShell, and it did so by taking the drive of
 * `process.execPath` and appending the well-known system path. The drive a Node
 * binary happens to be installed on is not a trustworthy statement about where
 * Windows lives: install Node on any non-system volume and the resolver built a
 * path that does not exist, failed closed, and took the entire doctor command
 * down with it (AO-007-R1-RR1-REVIEW-01).
 *
 * An in-process `os.userInfo()` call removes that whole class of problem. There
 * is no executable to locate, no PATH, no shell, no quoting, no output protocol
 * to parse, no timeout, and no spawn to fail — while the provenance is strictly
 * better than the mechanism it replaces, because the value never passes through
 * an environment block at all.
 *
 * ── Trust boundary ──────────────────────────────────────────────────────────
 *
 * The OS answer is still treated as an untrusted external value at runtime,
 * regardless of what the TypeScript declaration promises. It must be a string,
 * non-empty, not whitespace-only, free of embedded NUL, absolute, canonically
 * resolvable, and an existing directory. **There is no fallback.** Any failure
 * throws {@link TrustedProfileUnavailableError}; it never degrades to an
 * environment value, a shell, or a helper process, because a degraded answer is
 * exactly the attacker-chosen answer this module exists to prevent.
 *
 * This module is not referenced from `package.json#exports`, is not reachable
 * from the CLI, and reads nothing from `process.env`.
 */

import { realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';

import { TrustedProfileUnavailableError } from '../../core/errors.js';

/**
 * The closed dependency set of the resolver.
 *
 * `userInfo` is typed as returning `unknown` on purpose: the validation below
 * is what establishes the shape, and typing it faithfully here would let the
 * compiler quietly excuse the runtime checks that are the point of this module.
 */
export interface TrustedProfileDependencies {
  readonly userInfo: () => unknown;
  readonly realpath: (path: string) => string;
  readonly stat: (path: string) => { isDirectory: () => boolean };
}

/**
 * The productive dependency set. Frozen, module-private, and never swapped:
 * there is no setter and no global provider reference, so no caller — and no
 * test — can redirect what {@link trustedProfileDirectory} asks.
 */
const PRODUCTION_DEPENDENCIES: TrustedProfileDependencies = Object.freeze({
  userInfo: (): unknown => userInfo(),
  realpath: (path: string): string => realpathSync.native(path),
  stat: (path: string): { isDirectory: () => boolean } => statSync(path),
});

/**
 * Internal diagnosis reasons. These differentiate for a developer reading a
 * stack trace; they are never public API and never reach a report or the
 * console, which see only the static `TRUSTED_PROFILE_UNAVAILABLE` sentence.
 */
type ResolutionFailure =
  | 'OPERATING_SYSTEM_QUERY_FAILED'
  | 'OPERATING_SYSTEM_VALUE_INVALID'
  | 'PROFILE_CANONICALIZATION_FAILED'
  | 'PROFILE_NOT_DIRECTORY';

/**
 * Static texts, one per reason. Nothing is interpolated: not the raw path, not
 * the canonical path, not the user name, not an `errno`, not a caught
 * exception's message and not its stack. A failure must not become a channel
 * for the very value the caller was not allowed to learn.
 */
const FAILURE_DETAIL: Readonly<Record<ResolutionFailure, string>> = Object.freeze({
  OPERATING_SYSTEM_QUERY_FAILED: 'the operating system user query did not succeed',
  OPERATING_SYSTEM_VALUE_INVALID: 'the operating system returned no usable profile path',
  PROFILE_CANONICALIZATION_FAILED: 'the profile path could not be canonicalised',
  PROFILE_NOT_DIRECTORY: 'the canonical profile path is not an existing directory',
});

function fail(reason: ResolutionFailure): never {
  throw new TrustedProfileUnavailableError(
    `Trusted profile resolution failed: ${FAILURE_DETAIL[reason]}.`,
  );
}

/** The one character no filesystem path may contain. */
const NUL = '\u0000';

/**
 * A value usable as a path at all: a string with content that is not merely
 * whitespace and carries no embedded NUL.
 *
 * The whitespace test is an emptiness test only. The original string — not a
 * trimmed copy — is what gets resolved, because trimming would invent a path
 * the OS never returned.
 */
function isUsablePathString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !value.includes(NUL)
  );
}

/**
 * The single validation pipeline, shared by the productive resolver and by the
 * isolated test resolver so the two can never drift apart.
 *
 * A UNC path is not rejected for being UNC: `isAbsolute` accepts it, and what
 * matters is that canonicalisation succeeds and the target is a directory. A
 * junction or redirected profile is likewise not rejected for carrying a
 * reparse point — `realpath` resolving it is the whole point.
 */
function resolveTrustedProfile(dependencies: TrustedProfileDependencies): string {
  let info: unknown;
  try {
    info = dependencies.userInfo();
  } catch {
    fail('OPERATING_SYSTEM_QUERY_FAILED');
  }

  if (typeof info !== 'object' || info === null) fail('OPERATING_SYSTEM_VALUE_INVALID');

  const raw: unknown = (info as { homedir?: unknown }).homedir;
  if (!isUsablePathString(raw)) fail('OPERATING_SYSTEM_VALUE_INVALID');
  // `isAbsolute` from node:path, never a hand-rolled drive-letter pattern: the
  // platform's own rules cover UNC and POSIX roots that a regex would miss.
  if (!isAbsolute(raw)) fail('OPERATING_SYSTEM_VALUE_INVALID');

  let canonical: unknown;
  try {
    canonical = dependencies.realpath(raw);
  } catch {
    fail('PROFILE_CANONICALIZATION_FAILED');
  }

  // The canonical answer is re-validated rather than trusted for having come
  // out of `realpath`.
  if (!isUsablePathString(canonical)) fail('PROFILE_CANONICALIZATION_FAILED');
  if (!isAbsolute(canonical)) fail('PROFILE_CANONICALIZATION_FAILED');

  let stats: unknown;
  try {
    stats = dependencies.stat(canonical);
  } catch {
    fail('PROFILE_NOT_DIRECTORY');
  }

  if (typeof stats !== 'object' || stats === null) fail('PROFILE_NOT_DIRECTORY');
  const isDirectory: unknown = (stats as { isDirectory?: unknown }).isDirectory;
  if (typeof isDirectory !== 'function') fail('PROFILE_NOT_DIRECTORY');
  if (isDirectory.call(stats) !== true) fail('PROFILE_NOT_DIRECTORY');

  return canonical;
}

/**
 * Resolved once per process.
 *
 * Only a *successful* resolution is remembered. A failure is not cached, so a
 * transient problem does not poison the rest of the process — and a cached
 * success cannot be invalidated by anything an attacker can set later.
 */
let resolved: string | null = null;

/**
 * The trusted profile directory of the local OS user.
 *
 * Always uses the productive `os.userInfo` dependency set. There is no
 * parameter, so no caller can supply a profile path or weaken the validation.
 *
 * @throws TrustedProfileUnavailableError if it cannot be established. There is
 *         deliberately no environment, shell or helper-process fallback.
 */
export function trustedProfileDirectory(): string {
  if (resolved !== null) return resolved;

  const canonical = resolveTrustedProfile(PRODUCTION_DEPENDENCIES);
  resolved = canonical;
  return canonical;
}

/**
 * INTERNAL test seam: drops the memoised value so a test can observe a fresh
 * resolution. Not exported from any public module.
 */
export function resetTrustedProfileCacheForTests(): void {
  resolved = null;
}

/**
 * INTERNAL test seam: an isolated resolver over injected dependencies.
 *
 * It runs exactly the validation the productive resolver runs — the same
 * function, not a copy — and carries its own private cache, so it can neither
 * observe nor disturb the productive one. It accepts *dependencies*, never a
 * ready-made profile path, so there is no way to hand it a value that skips
 * validation.
 */
export function createTrustedProfileResolverForTests(
  dependencies: TrustedProfileDependencies,
): () => string {
  let memo: string | null = null;
  return (): string => {
    if (memo !== null) return memo;
    const canonical = resolveTrustedProfile(dependencies);
    memo = canonical;
    return canonical;
  };
}
