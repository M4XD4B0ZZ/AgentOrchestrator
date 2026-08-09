/**
 * DELIVERY-001A-R1: the scratch paths the real-process suites hand to
 * `runCommand` are canonical before they get there.
 *
 * This contract had no test. It held on every developer machine by accident —
 * `os.tmpdir()` happens to be a long path under `C:\Users\<short-name>` — and
 * broke the first time the suites ran on a GitHub Actions Windows runner,
 * whose temp directory is the 8.3 alias `C:\Users\RUNNER~1\AppData\Local\Temp`.
 * `SAFE_ARG_PATTERN` excludes `~` on purpose, so `runCommand` refused those
 * arguments fail-closed and six real-process tests failed for a reason that had
 * nothing to do with what they were testing.
 *
 * What is pinned here is the *test layer's* obligation, not a product change:
 * the product was right to refuse the alias, and this suite deliberately does
 * not assert that `~` is acceptable — it asserts the opposite, and that the
 * canonical form is what the helper produces.
 *
 * Asserting only that `makeCanonicalTempDir` returns its own canonical form
 * would be vacuous on exactly the machines where the bug hid: where
 * `os.tmpdir()` is already canonical, that holds with or without the
 * canonicalisation. So the decisive case below points the temp root at a real
 * 8.3 alias for the duration of one test — reproducing the runner's condition
 * rather than waiting for a runner to find it again.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { runCommand, UnsafeArgumentError } from '../src/doctor/exec.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';

const IS_WINDOWS = process.platform === 'win32';

const created: string[] = [];
function scratch(prefix: string): string {
  const dir = makeCanonicalTempDir(prefix);
  created.push(dir);
  return dir;
}

afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Runs one argument through the real argument contract without starting
 * anything: `assertSafeArgs` is the first statement in `runCommand`, and a bare
 * command name against an empty environment resolves to no candidate at all,
 * so an accepted argument settles as NOT_FOUND rather than spawning a process.
 */
async function argumentIsAccepted(argument: string): Promise<boolean> {
  try {
    const result = await runCommand('ao-no-such-command', [argument], {
      env: {},
      timeoutMs: 10_000,
    });
    expect(result.outcome).toBe('NOT_FOUND');
    return true;
  } catch (error) {
    if (error instanceof UnsafeArgumentError) return false;
    throw error;
  }
}

/**
 * The 8.3 alias Windows minted for `directory`, or `null` when it minted none.
 *
 * `dir /x` prints the alias in its own column beside the long name. A volume
 * with 8.3 creation disabled is a real and permitted configuration and simply
 * has no alias to report — the cases below then declare themselves
 * inapplicable instead of failing.
 */
function shortNameAliasOf(directory: string): string | null {
  const parent = join(directory, '..');
  const name = directory.slice(parent.length + 1);
  const listing = execFileSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/ad', parent], {
    encoding: 'utf8',
  });
  const row = listing.split(/\r?\n/).find((line) => line.endsWith(name));
  const alias = row?.trim().split(/\s+/).at(-2) ?? '';
  return alias.includes('~') ? join(parent, alias) : null;
}

describe('makeCanonicalTempDir', () => {
  it('returns a path that is already its own canonical form', () => {
    const dir = scratch('ao-canon-');
    expect(realpathSync.native(dir)).toBe(dir);
  });

  it('produces a real directory, not merely a canonical-looking string', () => {
    const dir = scratch('ao-canon-real-');
    const nested = mkdtempSync(join(dir, 'nested-'));
    expect(realpathSync.native(nested)).toBe(nested);
  });

  it('yields a path runCommand accepts as an argument', async () => {
    const dir = scratch('ao-canon-arg-');
    expect(await argumentIsAccepted(join(dir, 'helper.cjs'))).toBe(true);
  });

  it.runIf(IS_WINDOWS)('canonicalises even when the temp root itself is an 8.3 alias', async () => {
    const parent = scratch('ao-canon-root-');
    // Long enough that Windows has to mint an alias for it, if it mints any.
    const root = mkdtempSync(join(parent, 'a-deliberately-long-directory-name-'));
    const aliasedRoot = shortNameAliasOf(root);
    if (aliasedRoot === null) return; // 8.3 creation disabled for this volume

    // Precisely the runner's situation: os.tmpdir() answers with an alias.
    // Scoped to this test and restored unconditionally — the machine's own
    // TMP/TEMP are not what is under test, and nothing outside this block sees
    // the substitution.
    const savedTemp = process.env['TEMP'];
    const savedTmp = process.env['TMP'];
    let underAliasedRoot: string;
    try {
      process.env['TEMP'] = aliasedRoot;
      process.env['TMP'] = aliasedRoot;
      expect(realpathSync.native(aliasedRoot)).toBe(root); // the alias is genuine
      underAliasedRoot = makeCanonicalTempDir('ao-canon-aliased-');
    } finally {
      if (savedTemp === undefined) delete process.env['TEMP'];
      else process.env['TEMP'] = savedTemp;
      if (savedTmp === undefined) delete process.env['TMP'];
      else process.env['TMP'] = savedTmp;
    }

    // The helper's whole reason for existing: what comes back is the long form,
    // and it survives the argument contract that the alias does not.
    expect(underAliasedRoot.startsWith(root)).toBe(true);
    expect(realpathSync.native(underAliasedRoot)).toBe(underAliasedRoot);
    expect(await argumentIsAccepted(join(underAliasedRoot, 'helper.cjs'))).toBe(true);
  });
});

describe('the 8.3 alias this canonicalisation exists for', () => {
  it('is refused by the argument contract in the shape CI produced', async () => {
    // The exact argument from the failing run, so the reason the helper exists
    // is pinned even where no 8.3 alias can be minted.
    const ciArgument =
      'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\agent-loop-exec-4PGsr5\\sleep.cjs';
    expect(await argumentIsAccepted(ciArgument)).toBe(false);
  });

  it.runIf(IS_WINDOWS)('is refused where its canonical long form is not', async () => {
    const parent = scratch('ao-canon-8dot3-');
    const real = mkdtempSync(join(parent, 'a-deliberately-long-directory-name-'));
    const alias = shortNameAliasOf(real);
    if (alias === null) return; // 8.3 creation disabled for this volume

    expect(alias).not.toBe(real);
    expect(await argumentIsAccepted(join(alias, 'helper.cjs'))).toBe(false);
    expect(realpathSync.native(alias)).toBe(real);
    expect(await argumentIsAccepted(join(real, 'helper.cjs'))).toBe(true);
  });
});
