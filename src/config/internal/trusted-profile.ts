/**
 * INTERNAL — the trusted OS user profile directory (AO-007-R1-RR1, AO-007-R1-RR3).
 *
 * ── Why `os.homedir()` cannot be called in this process ────────────────────
 *
 * On Windows, `uv_os_homedir` returns the profile-directory environment
 * variable when it is set, and only falls back to the Win32 token API when it
 * is not. In a normal interactive session it is always set, so a direct
 * `os.homedir()` in *this* process is an environment read wearing an OS-API
 * costume: an attacker-controlled value relocates every persistent artefact
 * the orchestrator writes. The POSIX passwd-lookup fallback variable, its
 * Windows drive/path split, the two application-data variables and the
 * removed `AGENT_LOOP_HOME` are all in the same category — none of them may
 * decide where diagnostics land.
 *
 * ── Why a plain "spawn with an empty environment" is not enough on Windows ──
 *
 * The obvious fix — spawn a helper with `env: {}` and let its own
 * `os.homedir()` fall through to the token API — does not hold on Windows.
 * Windows Node.js (via libuv's process spawning) silently backfills a small,
 * fixed set of OS-required variables into *any* child process whose `env`
 * omits them, reading their values from the parent's real, live environment
 * regardless of what the caller passed. That fixed set includes exactly the
 * profile-directory variable this module exists to neutralise, so a child
 * spawned with `env: {}` still sees the attacker's value — verified
 * empirically, not assumed. POSIX does not exhibit this backfill: an empty
 * environment there is genuinely empty.
 *
 * ── The strategy ───────────────────────────────────────────────────────────
 *
 *  - On POSIX, the profile path is resolved by a child process started with
 *    an **empty** environment map, running {@link HELPER_SOURCE} — a fixed
 *    string constant, nothing composed from input — which calls
 *    `os.homedir()`. With no fallback variable in scope, that call is forced
 *    onto the passwd database entry.
 *  - On Windows, the profile path is resolved through a mechanism that does
 *    not consult environment variables at all: the platform's own
 *    known-folder API for the profile directory, invoked via a fixed,
 *    argument-array PowerShell one-liner ({@link WINDOWS_HELPER_COMMAND}).
 *    That API resolves the path from the process token against the profile
 *    registry, the same source the Win32 token API uses, and is immune to the
 *    backfill described above — verified empirically by spoofing every
 *    relevant variable at once and observing the real path returned regardless.
 *  - Either helper is started with `shell: false` and an absolute executable
 *    path, so no `PATH` lookup and no shell parsing is involved, and with an
 *    empty environment map besides — which still blocks every variable
 *    outside the small OS-required set, including any loader or injection
 *    variable;
 *  - the child prints exactly one line, carrying a fixed prefix and nothing
 *    else. Anything else — extra output, a missing prefix — is rejected.
 *
 * The returned path must then be absolute, exist, be a directory, and resolve
 * canonically. **There is no fallback.** A spawn, parse or validation failure
 * throws {@link TrustedProfileUnavailableError}; it never degrades to an
 * environment value, because a degraded answer is exactly the attacker-chosen
 * answer this module exists to prevent.
 *
 * This module is not referenced from `package.json#exports`, is not reachable
 * from the CLI, and reads nothing from `process.env`.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, parse as parsePath } from 'node:path';

import { TrustedProfileUnavailableError } from '../../core/errors.js';

/** The one line shape either helper is allowed to produce. */
export const HELPER_OUTPUT_PREFIX = 'AGENT-LOOP-TRUSTED-PROFILE-V1 ';

/**
 * The POSIX helper the child executes. A fixed constant: no interpolation, no
 * input.
 *
 * `node:os` is a builtin, so it cannot be shadowed by a module-path
 * environment variable or a `node_modules` directory even if one were
 * reachable — and with an empty environment none is.
 */
export const HELPER_SOURCE =
  'const os = require("node:os");' +
  `process.stdout.write(${JSON.stringify(HELPER_OUTPUT_PREFIX)} + os.homedir() + "\\n");`;

/**
 * The Windows helper command. A fixed constant: no interpolation, no input.
 *
 * `[Environment]::GetFolderPath` for the profile special folder resolves
 * through the OS known-folder mechanism, not through any environment
 * variable, which is exactly why it is used here instead of `os.homedir()`.
 */
export const WINDOWS_HELPER_COMMAND =
  `Write-Output (${JSON.stringify(HELPER_OUTPUT_PREFIX)} + ` +
  '[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))';

/** Bounded: the helper prints one short line, so anything larger is wrong. */
const MAX_OUTPUT_BYTES = 8 * 1024;

/** The child does one syscall and exits; a slow answer is a failed answer. */
const RESOLUTION_TIMEOUT_MS = 15_000;

/**
 * Resolved once per process.
 *
 * Only a *successful* resolution is remembered. A failure is not cached, so a
 * transient spawn problem does not poison the rest of the process — and a
 * cached success cannot be invalidated by anything an attacker can set later.
 */
let resolved: string | null = null;

function fail(detail: string): never {
  // The detail is developer-facing only; `formatSafeError` displays the static
  // TRUSTED_PROFILE_UNAVAILABLE sentence and never this text.
  throw new TrustedProfileUnavailableError(`Trusted profile resolution failed: ${detail}.`);
}

/** Parses the single expected line, or fails. Never returns a guess. */
function parseHelperOutput(stdout: string): string {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) fail(`expected exactly one output line, saw ${lines.length}`);

  const line = lines[0] ?? '';
  if (!line.startsWith(HELPER_OUTPUT_PREFIX)) fail('output did not carry the expected prefix');

  const candidate = line.slice(HELPER_OUTPUT_PREFIX.length).trim();
  if (candidate.length === 0) fail('output carried no home path');
  return candidate;
}

interface HelperInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The fixed, well-known location of the Windows PowerShell that ships with
 * every Windows install, rooted at the same drive as this running Node
 * binary rather than at any environment-supplied path. If it is not there,
 * resolution fails closed rather than searching further.
 */
function windowsPowerShellPath(): string {
  const { root } = parsePath(process.execPath);
  const candidate = join(root, 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

  let stats;
  try {
    stats = statSync(candidate);
  } catch {
    fail('the platform PowerShell helper could not be located');
  }
  if (!stats.isFile()) fail('the platform PowerShell helper is not a regular file');
  return candidate;
}

/** Which fixed helper to run, per platform. Never composed from input. */
function helperInvocation(): HelperInvocation {
  if (process.platform !== 'win32') {
    return { command: process.execPath, args: ['-e', HELPER_SOURCE] };
  }
  return {
    command: windowsPowerShellPath(),
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      WINDOWS_HELPER_COMMAND,
    ],
  };
}

/** Every structural requirement a trusted write root must meet. */
function validateProfilePath(candidate: string): string {
  if (!isAbsolute(candidate)) fail('the resolved profile path is not absolute');

  let canonical: string;
  try {
    canonical = realpathSync.native(candidate);
  } catch {
    fail('the resolved profile path could not be canonicalised');
  }

  let stats;
  try {
    stats = statSync(canonical);
  } catch {
    fail('the resolved profile path does not exist');
  }
  if (!stats.isDirectory()) fail('the resolved profile path is not a directory');

  return canonical;
}

/**
 * The trusted profile directory of the local OS user.
 *
 * @throws TrustedProfileUnavailableError if it cannot be established. There is
 *         deliberately no environment fallback.
 */
export function trustedProfileDirectory(): string {
  if (resolved !== null) return resolved;

  const invocation = helperInvocation();
  const child = spawnSync(invocation.command, invocation.args, {
    // An empty environment map besides. It cannot suppress the small,
    // OS-required set Windows backfills regardless (see the module header),
    // but it still blocks every variable outside that set — including any
    // loader or injection variable — on both platforms.
    env: {},
    cwd: undefined,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
    timeout: RESOLUTION_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (child.error !== undefined) fail('the resolver process could not be started');
  if (child.signal !== null) fail('the resolver process was terminated by a signal');
  if (child.status !== 0) fail(`the resolver process exited with status ${String(child.status)}`);

  const home = parseHelperOutput(child.stdout ?? '');
  const canonical = validateProfilePath(home);
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
