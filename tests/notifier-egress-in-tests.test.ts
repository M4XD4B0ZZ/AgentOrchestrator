/**
 * No suite in this repository may reach the operator's real notification target.
 *
 * ── The incident, measured ─────────────────────────────────────────────────
 *
 * 2026-09-13, 23:50 local: a push arrived on the operator's phone reading
 * `A-001 BLOCKED / B-001 PLANNED / run-1 / BLOCK_RUN_ENDED / TASK_BLOCKED`.
 * Nothing was being orchestrated. It was `npm run verify`.
 *
 * `cli/block-command.ts` falls back to `createOperatorNotifier()` when no
 * notifier seam is supplied, and that default reads the **real** operator home.
 * `tests/v2-09-dependent-commit-chain.test.ts` drove that CLI six times with no
 * seam, so six real notifications went out with fixture task ids in them.
 *
 * ── Why a scan, and not only the two fixes ─────────────────────────────────
 *
 * The two suites are sealed at their own helpers, which stops today's leak. It
 * does not stop tomorrow's: the fallback is a *default*, so the failure mode is
 * a file that simply does not mention notification at all, and nothing about
 * writing such a file feels like a mistake. The whole reason this reached a
 * phone is that the omission was invisible.
 *
 * So the gate is on the shape rather than on the behaviour: a test file that
 * constructs the block CLI must also name a notifier. That is checkable by
 * reading the file, it fails at `npm run verify` rather than on someone's
 * phone, and it costs one import.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 *
 * It does not disable notification globally, and it does not change what
 * production does: the fallback in `block-command.ts` is still the real
 * notifier, because a machine that reports its endings is the point of the
 * feature. The pin below says so, so that a future "fix" which quietly makes
 * production silent fails here.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SILENT_NOTIFIER } from './helpers/silent-notifier.js';

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const SOURCE_DIR = join(TESTS_DIR, '..', 'src');

/** Every `.ts` under `tests/`, including helpers, as `{ name, text }`. */
function testFiles(): readonly { readonly name: string; readonly text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const name = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path, name);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.mjs')) continue;
      out.push({ name, text: readFileSync(path, 'utf8') });
    }
  };
  walk(TESTS_DIR, '');
  return out;
}

describe('a test may not reach the operator’s real notification target', () => {
  /**
   * The gate. A file that builds the block CLI has to say what its notifier is,
   * because the alternative — saying nothing — is what sent the push.
   */
  it('names a notifier wherever a test constructs the block CLI', () => {
    const offenders = testFiles()
      .filter((file) => file.text.includes('registerBlockCommand('))
      .filter((file) => !file.text.includes('notifier'))
      .map((file) => file.name);

    expect(offenders).toEqual([]);
  });

  /**
   * The same question asked of the value rather than the word, for the two
   * suites the incident actually came from. `notifier` appearing somewhere in a
   * long file is weak evidence; these two are pinned to the silent one at the
   * single helper each of them drives the CLI through.
   */
  it('seals the two suites the pushes came from, at their own helper', () => {
    for (const name of [
      'v2-08-attended-block-runner.test.ts',
      'v2-09-dependent-commit-chain.test.ts',
    ]) {
      const file = testFiles().find((candidate) => candidate.name === name);
      expect(file, `${name} should exist`).toBeDefined();
      expect(file?.text).toContain('SILENT_NOTIFIER');
      expect(file?.text).toContain('registerBlockCommand(program, { notifier: SILENT_NOTIFIER,');
    }
  });

  /**
   * The silent notifier cannot send, structurally. `transport: null` means
   * there is no function to call — not a stub that records, not one that
   * resolves; nothing. A test cannot send by accident even if the code under
   * test decides to.
   */
  it('offers no transport to send through', () => {
    expect(SILENT_NOTIFIER.transport).toBeNull();
    expect(SILENT_NOTIFIER.state).toBe('NOT_CONFIGURED');
    expect(Object.isFrozen(SILENT_NOTIFIER)).toBe(true);
  });

  /**
   * Production is unchanged, and this is the half a "fix" could quietly break.
   * The command still falls back to the real notifier when no seam is given,
   * because a machine that reports its endings is the point of the feature —
   * what changed is that the *tests* now always give one.
   */
  it('leaves the production fallback reaching the real notifier', () => {
    const command = readFileSync(join(SOURCE_DIR, 'cli', 'block-command.ts'), 'utf8');

    expect(command).toContain('seams.notifier ?? createOperatorNotifier()');
    // And no environment sniffing crept in: the fix is at the test boundary, so
    // production must not have learned what a test runner is.
    expect(command).not.toContain('NODE_ENV');
    expect(command).not.toContain('VITEST');
  });
});
