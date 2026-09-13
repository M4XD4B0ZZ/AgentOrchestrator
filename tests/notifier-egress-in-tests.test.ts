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
 * ── What the rule is, after a review round ─────────────────────────────────
 *
 * The first version asked whether the file *mentioned* a notifier. A review
 * broke it in one line: `registerBlockCommand(program); // notifier:` passes a
 * whole-file text filter while doing exactly what sent the push. So the rule
 * moved onto the **call**:
 *
 *   1. every `registerBlockCommand(` call must pass a second argument. A
 *      one-argument call IS the incident — no seams at all, straight to the
 *      real notifier — and no comment anywhere in the file can make a
 *      one-argument call into a two-argument one;
 *   2. if that second argument is written inline as an object literal, it must
 *      name `notifier`. `{ runner }` is the same hole with extra steps;
 *   3. a file that reaches the CLI some other way and *runs* `block` through it
 *      must name {@link SILENT_NOTIFIER}. `src/cli/index.ts`'s `buildProgram()`
 *      wires the block command with no seams and contains no direct needle, so
 *      a file taking that route would otherwise pass unexamined.
 *
 * Rule 3's needle tolerates a leading `node`/`agent-loop` argv pair, because
 * `parseAsync(['node', 'agent-loop', 'block', ...])` is the same run written
 * two elements longer — also a review finding.
 *
 * ── What it still does not claim ───────────────────────────────────────────
 *
 * It is a source scan, so a sufficiently determined file evades it: build the
 * argv at runtime, alias the import, shell out to the built CLI. That is not
 * the threat model. The measured failure mode is the *accidental* omission — a
 * suite whose subject is not notification, written by someone who never thought
 * about it — and the negative fixtures below pin the evasions that are one
 * keystroke away rather than the ones that take intent.
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

/** This file. Excluded from its own scan — see the case that says why. */
const SCANNER = 'notifier-egress-in-tests.test.ts';

interface ScannedFile {
  readonly name: string;
  readonly text: string;
}

/** Every `.ts` under `tests/`, including helpers, as `{ name, text }`. */
function testFiles(): readonly ScannedFile[] {
  const out: ScannedFile[] = [];
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

/**
 * The text of each `registerBlockCommand(...)` argument list in one file.
 *
 * Brace- and paren-counted rather than matched with one regex, because the
 * seams argument is an object literal that regularly contains both. A call this
 * cannot find the end of is reported as `null`, which the rule treats as an
 * offence: "I could not read it" must not read as "it was fine".
 */
function registerBlockCommandArguments(text: string): readonly (string | null)[] {
  const needle = 'registerBlockCommand(';
  const calls: (string | null)[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) return calls;
    from = at + needle.length;
    let depth = 1;
    let end = -1;
    for (let i = from; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(end === -1 ? null : text.slice(from, end));
  }
}

/** Whether a file *runs* the `block` command through a program it built. */
function runsBlockThroughArgv(text: string): boolean {
  // Up to two leading argv elements, so the `['node', 'agent-loop', 'block']`
  // form is caught as well as the bare `['block']` one.
  return /parseAsync\(\s*\[\s*(?:['"`][^'"`]*['"`]\s*,\s*){0,2}['"`]block['"`]/.test(text);
}

/**
 * The rule, as a pure function so it can be run against fixtures that must
 * fail as well as against the tree that must pass.
 */
function offenders(files: readonly ScannedFile[]): readonly string[] {
  const bad: string[] = [];
  for (const file of files) {
    const calls = registerBlockCommandArguments(file.text);
    const callIsUnsealed = calls.some((args) => {
      // Unreadable call: refuse rather than excuse.
      if (args === null) return true;
      // Rule 1 — no second argument at all. This is the measured incident.
      const comma = args.indexOf(',');
      if (comma === -1) return true;
      const seams = args.slice(comma + 1).trim();
      // Rule 2 — an inline object literal must name the seam.
      if (seams.startsWith('{')) return !/\bnotifier\s*:/.test(seams);
      return false;
    });
    if (callIsUnsealed) {
      bad.push(file.name);
      continue;
    }
    // Rule 3 — reached the CLI some other way and ran `block` through it.
    if (calls.length === 0 && runsBlockThroughArgv(file.text)) {
      if (!file.text.includes('SILENT_NOTIFIER')) bad.push(file.name);
    }
  }
  return bad;
}

describe('a test may not reach the operator’s real notification target', () => {
  /**
   * The gate itself, over the real tree.
   *
   * This file is excluded, and that is not a convenience: the fixtures below
   * are unsealed calls written as *string literals*, so a scanner reading its
   * own source reports itself. The exclusion is one name, and the next case
   * makes it safe by proving this file cannot be the place someone hides a real
   * call.
   */
  it('seals every test that constructs or drives the block CLI', () => {
    const scanned = testFiles().filter((file) => file.name !== SCANNER);
    expect(scanned.length).toBeGreaterThan(100);
    expect(offenders(scanned)).toEqual([]);
  });

  /**
   * The exclusion, closed. This file never imports the block CLI, so it cannot
   * construct one however its own text reads.
   */
  it('cannot itself reach the block CLI', () => {
    const self = testFiles().find((file) => file.name === SCANNER);
    expect(self, 'the scanner should find itself').toBeDefined();
    // The import statements only. The helpers above mention the needle by name,
    // which is why this asks what the file *imports* rather than what it says.
    const imports = (self?.text ?? '')
      .split('\n')
      .filter((line) => line.startsWith('import '))
      .join('\n');
    expect(imports).not.toContain('/src/');
    expect(imports).not.toContain('../src');
    expect(imports).not.toContain('registerBlockCommand');
    expect(imports).not.toContain('buildProgram');
  });

  /**
   * The half a rule like this usually lacks. Each fixture is a file that must
   * be reported, and each corresponds to a way the previous version of this
   * scan was broken or could have been.
   */
  it('reports the evasions that are one keystroke away', () => {
    const fixtures: readonly ScannedFile[] = [
      // The measured incident, exactly.
      { name: 'incident.test.ts', text: 'registerBlockCommand(program);' },
      // The review's one-line bypass of the old whole-file text filter.
      {
        name: 'comment-bypass.test.ts',
        text: 'registerBlockCommand(program); // notifier: honestly, none\nparseAsync(["block"]);',
      },
      // A whole-file mention, which the old filter also accepted.
      {
        name: 'mention-elsewhere.test.ts',
        text: 'const notifier: unknown = null;\nregisterBlockCommand(program);',
      },
      // Seams supplied, but not that seam.
      { name: 'other-seams.test.ts', text: 'registerBlockCommand(program, { runner });' },
      // The indirect route, with the longer argv the narrow needle missed.
      {
        name: 'full-argv.test.ts',
        text: 'const program = buildProgram();\nawait program.parseAsync(["node", "agent-loop", "block", "--repository", root]);',
      },
      // One sealed call and one unsealed one in the same file.
      {
        name: 'one-of-two.test.ts',
        text: 'registerBlockCommand(program, { notifier: SILENT_NOTIFIER });\nregisterBlockCommand(second);',
      },
    ];

    expect(offenders(fixtures)).toEqual(fixtures.map((fixture) => fixture.name));
  });

  /**
   * And the rule is not vacuous in the other direction: the shapes the repo
   * actually uses must pass, or the gate becomes noise and stops being read.
   */
  it('accepts the sealed shapes the repository uses', () => {
    const fixtures: readonly ScannedFile[] = [
      { name: 'inline.test.ts', text: 'registerBlockCommand(program, { notifier: SILENT_NOTIFIER });' },
      // A seams variable, which `v2-10` uses because its subject IS notification
      // and its notifier is a recording fake.
      { name: 'variable.test.ts', text: 'registerBlockCommand(program, seams);\nparseAsync(["block"]);' },
      // Multi-line, with braces inside the seams object.
      {
        name: 'multiline.test.ts',
        text: 'registerBlockCommand(program, {\n  notifier: SILENT_NOTIFIER,\n  runner: (a) => ({ ok: true }),\n});',
      },
      // Never touches the block CLI at all.
      { name: 'unrelated.test.ts', text: 'await program.parseAsync(["doctor", "--repository", root]);' },
      // Mentions `block` as a path segment, which is why the needle is an argv
      // position and not a word.
      { name: 'path-segment.test.ts', text: 'expect(source).toContain("src/block/block-runner.ts");' },
    ];

    expect(offenders(fixtures)).toEqual([]);
  });

  /**
   * The two suites the incident actually came from, pinned by name at the one
   * helper each of them drives the CLI through.
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
   *
   * A source pin, and it is worth saying what that is and is not worth. It
   * cannot prove the fallback still *behaves*; it can and does fail the moment
   * someone deletes or inverts it, which is the change this is guarding
   * against. Behaviour is `v2-10-operator-notification.test.ts`'s subject.
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
