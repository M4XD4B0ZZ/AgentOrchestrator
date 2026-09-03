/**
 * V1-08 / F-8 — the production verification seam, with real processes.
 *
 * `runVerificationCommand` is the function that will run a target repository's
 * own `npm run build` and `npm run verify`. Until now **no test had ever
 * executed it**: `tests/verification-command.test.ts` covers only the pure
 * translation `toVerificationCommandResult`, and every caller-level suite
 * injects a `VerificationRunner`. So the layer that decides what directory a
 * repository's build runs in, what environment it inherits, and what an
 * exhausted output budget means was covered exactly as far as its own callers'
 * fakes agreed with it.
 *
 * That is the same gap `tests/agent-command.test.ts` already closes for the
 * agent seam by spawning real children, and this file is its counterpart.
 *
 * ── Why `node` and a written script ────────────────────────────────────────
 *
 * `SAFE_ARG_PATTERN` excludes spaces and quotes, so an inline `-e` program is
 * not expressible as an argument at all — which is itself part of the contract.
 * The subject is therefore a small `.mjs` file in a canonical temp directory,
 * run as `node <path>`. `makeCanonicalTempDir` is used rather than `tmpdir()`
 * directly because a Windows runner reports an 8.3 alias containing `~`, which
 * the argument grammar refuses before this file's subject is ever reached.
 *
 * ── What is deliberately not tested here ───────────────────────────────────
 *
 * The wall-clock timeout is 30 minutes and is not injectable at this seam, so
 * it is asserted as the constant it is; the timeout *mechanism* belongs to
 * `runCommand` and is exercised in `tests/exec.test.ts` and the tree-kill gate.
 * Claiming otherwise here would mean waiting half an hour or asserting nothing.
 */

import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { absolutePathsEqual } from '../src/core/path-identity.js';
import {
  runVerificationCommand,
  VERIFICATION_COMMAND_MAX_OUTPUT_BYTES,
  VERIFICATION_COMMAND_TIMEOUT_MS,
} from '../src/verify/verify-command.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';

const dirs: string[] = [];

function scratch(): string {
  const dir = makeCanonicalTempDir('ao-verify-boundary-');
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked file on Windows must not fail an otherwise passing suite.
    }
  }
});

/** Writes a helper script and returns its absolute path. */
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, 'utf8');
  return path;
}

describe('the production verification seam starts a real process', () => {
  it('runs the command in the cwd it was given, never in process.cwd()', async () => {
    const dir = scratch();
    const elsewhere = scratch();
    const path = script(dir, 'cwd.mjs', 'process.stdout.write(process.cwd());\n');

    const result = await runVerificationCommand('node', [path], elsewhere);

    expect(result.outcome).toBe('RAN');
    expect(result.exitCode).toBe(0);
    // The directory the child really stood in, reported by the child itself.
    expect(absolutePathsEqual(result.stdout.trim(), elsewhere)).toBe(true);
    expect(absolutePathsEqual(result.stdout.trim(), process.cwd())).toBe(false);
  });

  it('hands the argument vector through structurally, unaltered', async () => {
    const dir = scratch();
    const path = script(
      dir,
      'argv.mjs',
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    const args = [path, '--phase=VERIFY', 'a-b_c.d', '42'];

    const result = await runVerificationCommand('node', args, dir);

    expect(result.outcome).toBe('RAN');
    expect(JSON.parse(result.stdout)).toEqual(args.slice(1));
  });

  it('reports a non-zero exit as a completed run carrying that code', async () => {
    const dir = scratch();
    const path = script(dir, 'exit.mjs', 'process.exit(3);\n');

    const result = await runVerificationCommand('node', [path], dir);

    // `RAN` is the point: the process reached its own end, so the exit code is
    // meaningful and the verdict is the repository's, not an infrastructure
    // failure. `run-verification.ts` turns this into `FAILED`.
    expect(result.outcome).toBe('RAN');
    expect(result.exitCode).toBe(3);
    expect(result.signal).toBeNull();
    expect(result.failureCode).toBeNull();
  });

  it('keeps a failing run\'s output, because that is the evidence a human needs', async () => {
    const dir = scratch();
    const path = script(
      dir,
      'noisy.mjs',
      'process.stdout.write("build log line\\n"); process.stderr.write("the failure\\n"); process.exit(1);\n',
    );

    const result = await runVerificationCommand('node', [path], dir);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('build log line');
    expect(result.stderr).toContain('the failure');
    expect(result.outputTruncated).toBe(false);
  });

  it('reports a command that cannot be started as unavailable, not as a failure', async () => {
    const dir = scratch();

    const result = await runVerificationCommand('ao-no-such-program-v1-08', ['--version'], dir);

    // No process ran, so there is no verdict to read — distinct from exit 1,
    // which is a repository answering "no".
    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.failureCode).not.toBeNull();
  });

  it('refuses an argument that is not shell-inert, and starts nothing', async () => {
    const dir = scratch();
    const path = script(dir, 'never.mjs', 'process.stdout.write("ran");\n');

    const result = await runVerificationCommand('node', [path, 'a && b'], dir);

    // The evidence that there is no shell on this path: a metacharacter is not
    // quoted or escaped for one, it is refused before anything is spawned.
    expect(result.outcome).toBe('REFUSED_UNSAFE_ARGUMENT');
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe('');
    expect(result.durationMs).toBe(0);
  });

  /**
   * ── This case was inverted by M6, and the old sentence is quoted here ─────
   *
   * It used to read:
   *
   *   > Exceeding the budget is an *ending*, never a verdict — a run whose
   *   > output was cut off cannot be read as having passed, whatever it exited
   *   > with.
   *
   * That was measured false in a real target repository. Zera's canonical gate
   * exits 0 and writes 62.8 MiB to stderr, so under that rule AO terminated a
   * *passing* gate, recorded `OUTPUT_LIMIT_STDERR` with both excerpts empty —
   * because what would have been recorded is exactly what overflowed — and did
   * so on every retry, which made every task in that repository permanently
   * unable to reach `READY_FOR_PR`.
   *
   * The old sentence conflated two policies. **Bounded observation** — how much
   * this process holds in RAM — is unchanged and still enforced, and the
   * assertions below check it. **Termination for verbosity** is a separate
   * thing, right for an ordinary command and wrong for a gate, and
   * `verify-command.ts` is the one caller in the build that switches it off.
   *
   * The fear behind the old sentence is answered by its sibling case below
   * rather than by keeping the coupling: a truncated run cannot be *read as
   * having passed* because the verdict is the exit code, and truncation does
   * not touch the exit code. A failing flood still fails.
   */
  const FLOOD = (exitCode: number): string =>
    [
      'const chunk = "x".repeat(64 * 1024);',
      'let written = 0;',
      'const limit = 9 * 1024 * 1024;',
      'while (written < limit) { process.stdout.write(chunk); written += chunk.length; }',
      `process.exitCode = ${exitCode};`,
    ].join('\n');

  it('lets a command that floods its output budget reach its own exit code', async () => {
    const dir = scratch();
    const path = script(dir, 'flood-pass.mjs', FLOOD(0));

    const result = await runVerificationCommand('node', [path], dir);

    // The line this slice exists for. Before M6: `UNAVAILABLE`.
    expect(result.outcome).toBe('RAN');
    expect(result.exitCode).toBe(0);
    expect(result.failureCode).toBeNull();
    // Bounded observation, untouched: the excerpt is a prefix and says so, and
    // the count says what it is a prefix of.
    expect(result.outputTruncated).toBe(true);
    expect(result.outputBytesObserved).toBeGreaterThan(8 * 1024 * 1024);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(8 * 1024 * 1024);
  }, 60_000);

  it('still fails a command that floods its output budget and exits non-zero', async () => {
    const dir = scratch();
    const path = script(dir, 'flood-fail.mjs', FLOOD(3));

    const result = await runVerificationCommand('node', [path], dir);

    // The direction that must not have moved, and the answer to the sentence
    // this pair replaced: truncation is a fact about the excerpt, never about
    // the verdict.
    expect(result.outcome).toBe('RAN');
    expect(result.exitCode).toBe(3);
    expect(result.exitCode).not.toBe(0);
    expect(result.outputTruncated).toBe(true);
  }, 60_000);
});

describe('the verification child gets an environment it did not choose', () => {
  it('inherits PATH but not the caller\'s other variables', async () => {
    const dir = scratch();
    const path = script(
      dir,
      'env.mjs',
      'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));\n',
    );

    const sentinel = 'AO_V1_08_SENTINEL';
    const secret = 'ANTHROPIC_API_KEY';
    const previousSentinel = process.env[sentinel];
    const previousSecret = process.env[secret];
    process.env[sentinel] = 'present-in-the-parent';
    process.env[secret] = 'must-never-reach-a-child';

    let keys: string[];
    try {
      const result = await runVerificationCommand('node', [path], dir);
      expect(result.outcome).toBe('RAN');
      keys = JSON.parse(result.stdout) as string[];
    } finally {
      if (previousSentinel === undefined) delete process.env[sentinel];
      else process.env[sentinel] = previousSentinel;
      if (previousSecret === undefined) delete process.env[secret];
      else process.env[secret] = previousSecret;
    }

    // What a process needs in order to start at all.
    expect(keys).toContain('PATH');
    // What the policy exists to withhold. An arbitrary parent variable does not
    // reach a repository's own build, and neither does a credential.
    expect(keys).not.toContain(sentinel);
    expect(keys).not.toContain(secret);
    expect(keys).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  /**
   * The `capability:generic` policy, stated as the known narrowness it is (F-9).
   *
   * A repository's own build gets `PATH`/`PATHEXT` and whatever the platform
   * back-fills — on Windows libuv supplies `SYSTEMROOT`, `TEMP` and friends, so
   * a Windows build works; a POSIX toolchain that needs `HOME` would not. This
   * asserts what is actually true rather than what would be convenient, so that
   * widening the policy has to be a decision with a test to change.
   */
  it('gives the child no HOME of its own beyond what the platform back-fills', async () => {
    const dir = scratch();
    const path = script(
      dir,
      'home.mjs',
      'process.stdout.write(JSON.stringify({ home: process.env.HOME ?? null, npm: process.env.npm_config_registry ?? null }));\n',
    );

    const result = await runVerificationCommand('node', [path], dir);

    expect(result.outcome).toBe('RAN');
    const seen = JSON.parse(result.stdout) as { home: string | null; npm: string | null };
    // Not forwarded by the allow-list. Recorded so that F-9 is a documented
    // fact with a failing test behind any change, rather than a suspicion.
    expect(seen.npm).toBeNull();
    if (process.platform !== 'win32') expect(seen.home).toBeNull();
  });
});

describe('the seam\'s bounds are the ones it advertises', () => {
  it('carries an agent-sized wall clock and a per-stream byte budget', () => {
    // Asserted as constants because neither is injectable here. The timeout
    // *mechanism* is `runCommand`'s and is exercised in `tests/exec.test.ts`;
    // claiming to test it here would mean waiting thirty minutes.
    expect(VERIFICATION_COMMAND_TIMEOUT_MS).toBe(1_800_000);
    expect(VERIFICATION_COMMAND_MAX_OUTPUT_BYTES).toBe(8_388_608);
  });
});
