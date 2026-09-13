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
 * The five suites are sealed at their own helpers, which stops today's leak. It
 * does not stop tomorrow's: the fallback is a *default*, so the failure mode is
 * a file that simply does not mention notification at all, and nothing about
 * writing such a file feels like a mistake. The whole reason this reached a
 * phone is that the omission was invisible.
 *
 * ── What the rule is, after two review rounds ──────────────────────────────
 *
 * The first version asked whether the file *mentioned* a notifier. A review
 * broke it in one line: `registerBlockCommand(program); // notifier:` passes a
 * whole-file text filter while doing exactly what sent the push.
 *
 * The second version moved onto the call but asked the wrong thing of it, and a
 * review measured how wrong: it refused calls with **no** second argument and
 * inspected second arguments only when they were written inline as object
 * literals. Every one of the four leaking suites called
 * `registerBlockCommand(program, seams)` from a helper declared
 * `(args, seams: BlockCommandSeams = {})` — two arguments, the second a
 * variable whose default was nothing at all. That rule was green over the exact
 * tree that reached the phone. It is not an argument; it is a case below.
 *
 * What the rule is now:
 *
 *   0. comments **and string literals** are stripped before anything is read,
 *      so no rule can be satisfied by prose. That alone closes the one-line
 *      comment bypass structurally, rather than by adding another substring to
 *      look for. Both halves are needed and the second was learned late: a
 *      string literal is prose the compiler keeps, and a review satisfied the
 *      rule with `{ runner: make("notifier: none") }`;
 *   1. every `registerBlockCommand(` call must pass a second argument;
 *   2. a second argument written inline as an object literal must name
 *      `notifier`. `{ runner }` is the same hole with extra steps;
 *   3. a second argument that is a **variable**, a spread or a call — the shape
 *      the real incident took — obliges the file to bind a notifier somewhere,
 *      because the argument itself says nothing;
 *   4. a file that reaches the CLI some other way and *runs* `block` through it
 *      must bind one too. `src/cli/index.ts`'s `buildProgram()` wires the block
 *      command with no seams and contains no direct needle, so a file taking
 *      that route would otherwise pass unexamined.
 *
 * Rule 4's needle tolerates a leading `node`/`agent-loop` argv pair, because
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
 * Comments removed, so no rule below can be satisfied by prose.
 *
 * This is the structural half of the fix for the one-line bypass a review
 * found: `registerBlockCommand(program); // notifier:` passed a rule that
 * searched the file's text. With comments gone there is no text to write the
 * word into, and every rule can then read plainly.
 *
 * Deliberately crude — it does not know about `//` inside a string literal, and
 * it does not need to: it only ever makes the scan see LESS, so its failure
 * mode is a false offence a reader immediately understands, never a miss.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Comments **and string literals** removed, for the question "does this file
 * bind a notifier anywhere".
 *
 * A review fed the previous version three files that satisfied it without
 * binding anything: one whose only `notifier:` sat inside
 * `expect(src).toContain('notifier: SILENT_NOTIFIER')`, one where it was a type
 * member, and one that bound a notifier in one case and forgot it in the next.
 * Rule 0 promised no rule could be satisfied by prose; a string literal is
 * prose the compiler happens to keep.
 *
 * Type members are not addressed by this and are not pretended to be — a
 * declaration is a value position as far as a regex is concerned. What closes
 * the case that actually occurred is the seams-default rule below.
 */
function withoutCommentsOrStrings(text: string): string {
  return withoutComments(text)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * Whether a seams argument named `name` is declared with an empty default.
 *
 * This is the incident, named exactly. Every one of the five suites that
 * reached the block CLI wrote the same helper —
 * `async function invokeBlock(args, seams: BlockCommandSeams = {})` — and
 * passed `seams` straight through. A caller that supplies none gets `{}`, and
 * `{}` is the production fallback: the real notifier, reading the operator's
 * real `notify.yaml`.
 *
 * A whole-file "does it mention a notifier" cannot see this, because such a
 * file usually DOES bind one somewhere — `v2-10` bound recording fakes in most
 * of its cases and forgot one in another, and that is the file that would have
 * sent the next push. The default is the thing to refuse.
 */
function hasEmptySeamsDefault(text: string, name: string): boolean {
  const identifier = name.replace(/[^A-Za-z0-9_$]/g, '');
  if (identifier === '') return false;
  return new RegExp(`\\b${identifier}\\s*(?::[^=,)]*)?=\\s*\\{\\s*\\}`).test(text);
}

/**
 * The rule, as a pure function so it can be run against fixtures that must fail
 * as well as against the tree that must pass.
 *
 * ── The shape the first two versions of this both missed ───────────────────
 *
 * A review measured it, and the measurement is the reason this function looks
 * the way it does. All four suites that actually sent the pushes called the CLI
 * as `registerBlockCommand(program, seams)` — a **two-argument** call whose
 * second argument is a variable, from a helper declared
 * `(args, seams: BlockCommandSeams = {})`. A rule that only refused calls with
 * no second argument, and only inspected second arguments written inline as
 * object literals, was green over the exact tree that reached the operator's
 * phone. It is checked in the case below rather than asserted here.
 *
 * So an identifier second argument is not evidence of anything on its own: the
 * file has to show, somewhere, that a notifier is bound into it.
 */
function offenders(files: readonly ScannedFile[]): readonly string[] {
  const bad: string[] = [];
  for (const file of files) {
    const text = withoutComments(file.text);
    const values = withoutCommentsOrStrings(file.text);
    // Calls are read from the STRING-stripped text, not merely the
    // comment-stripped text. Rule 0 says no rule can be satisfied by prose, and
    // a string literal is prose the compiler keeps: with only comments removed,
    // `registerBlockCommand(program, { runner: make("notifier: none") })`
    // satisfied rule 2 on the word inside that string. Measured. Stripping
    // strings first also makes the brace counter more accurate, since a brace
    // inside a string can no longer unbalance it.
    const calls = registerBlockCommandArguments(values);
    // Does this file bind a notifier at all, anywhere? Only ever consulted for
    // a call whose seams are a variable, where the binding is necessarily
    // somewhere other than the call.
    const bindsANotifier = /\bnotifier\s*:/.test(values) || values.includes('SILENT_NOTIFIER');

    const callIsUnsealed = calls.some((args) => {
      // Unreadable call: refuse rather than excuse. "I could not read it" must
      // not read as "it was fine".
      if (args === null) return true;
      // No second argument: no seams at all, straight to the production
      // fallback. Not the shape the incident took, but the shape it is one
      // deletion away from.
      const comma = args.indexOf(',');
      if (comma === -1) return true;
      const seams = args.slice(comma + 1).trim();
      // Written inline: it must name the seam here, where a reader sees it.
      if (seams.startsWith('{')) return !/\bnotifier\s*:/.test(seams);
      // A variable, a spread, a call — THE INCIDENT'S OWN SHAPE. The argument
      // says nothing by itself, so two things must hold: the file has to bind a
      // notifier somewhere, and the argument must not be a parameter whose
      // default is `{}`, because that default IS the production fallback and a
      // file can bind notifiers in nine cases and forget the tenth.
      if (hasEmptySeamsDefault(values, seams)) return true;
      return !bindsANotifier;
    });
    if (callIsUnsealed) {
      bad.push(file.name);
      continue;
    }
    // Reached the CLI some other way and ran `block` through it. Asked of every
    // file, not only of files with no direct call: one sealed
    // `registerBlockCommand` and one `buildProgram()`-driven `block` run in the
    // same file is two routes, and an earlier version examined only the first.
    //
    // The `calls.length === 0` term that used to stand here made that sentence
    // false while changing nothing — any file whose direct calls survived the
    // check above necessarily binds a notifier, so `!bindsANotifier` had
    // already excluded it. An inert term holding a false comment in place is
    // the shape this branch has now removed twice.
    if (runsBlockThroughArgv(text) && !bindsANotifier) {
      bad.push(file.name);
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
   * narrows what it can hide by proving this file imports nothing from `src/`.
   */
  it('seals every test that constructs or drives the block CLI', () => {
    const scanned = testFiles().filter((file) => file.name !== SCANNER);
    expect(scanned.length).toBeGreaterThan(100);
    expect(offenders(scanned)).toEqual([]);
  });

  /**
   * The exclusion, narrowed. This file imports nothing from `src/` but its own
   * silent-notifier helper, so whatever its text says, it holds no reference to
   * the block CLI to call.
   *
   * Not "closed", which is what this said before. It read only lines beginning
   * `import `, and for this repository's dominant multi-line import style that
   * is the single token `import {` — every assertion passed while the next line
   * named the CLI. Measured. It now looks for a module specifier anywhere,
   * which the fixture literals cannot produce because they carry no `from`
   * clause, and it looks at comment-stripped text so the header's own mention
   * of `block-command.ts` is not read as an import.
   */
  it('cannot itself reach the block CLI', () => {
    const self = testFiles().find((file) => file.name === SCANNER);
    expect(self, 'the scanner should find itself').toBeDefined();
    // Module specifiers, wherever they sit. A multi-line import puts the
    // specifier three lines below the word `import`, which is how the previous
    // version of this passed while importing the CLI.
    const code = withoutComments(self?.text ?? '');
    // Any module specifier under `src/`, static or dynamic, wherever it sits.
    expect(code).not.toMatch(/from\s+['"][^'"]*src\//);
    expect(code).not.toMatch(/import\s*\(\s*['"][^'"]*src\//);
    // And the one helper it does import is the silent notifier, nothing else.
    //
    // An exact list, order included, and that is deliberate rather than
    // careless: this case exists because the file excludes itself from the
    // scan, so "what else did it grow an import of" is the question, and a
    // subset check would answer it only for the imports someone thought of.
    // The cost is that reordering imports fails a case whose subject is not
    // import order — which is the right way round for a gate guarding an
    // exclusion.
    const specifiers = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers).toEqual([
      'node:fs',
      'node:path',
      'node:url',
      'vitest',
      './helpers/silent-notifier.js',
    ]);
  });


  /**
   * The case this whole file exists to be able to pass, written as the question
   * it should always have asked: **would this rule have caught the tree that
   * actually paged the operator?**
   *
   * The first two versions would not have, and neither said so. Both refused a
   * `registerBlockCommand(program)` with no second argument and called that
   * "the incident". It was not. All five suites that reached the block CLI
   * shared one helper — two arguments, the second a parameter whose default was
   * `{}` — so a rule that inspected only argument-less calls and inline object
   * literals never looked at the shape that sent six pushes.
   *
   * The helper is transcribed rather than read out of Git, and that is
   * deliberate. The first version of this case ran
   * `git show 51c8be4:tests/<name>`, which is green on a full clone and throws
   * on CI: `.github/workflows/verify.yml` checks out with `actions/checkout@v4`
   * and no `fetch-depth`, which is a single-commit clone where that object does
   * not exist. A gate that only runs on the author's machine is the failure
   * mode this repository calls reproducing the bare machine. Deepening the
   * checkout would be a delivery-infrastructure change smuggled in as a test
   * fix, so the measurement moved instead of the workflow.
   *
   * A reader who wants to check the transcription against history can run
   * `git show 51c8be4:tests/v2-09-dependent-commit-chain.test.ts` on a full
   * clone; the assertion below keeps it from drifting from what the repository
   * ships today.
   */
  it('would have caught the shape that actually sent the pushes', () => {
    // Verbatim from the four leaking suites at the commit before this branch.
    const helper = [
      'async function invokeBlock(args: readonly string[], seams: BlockCommandSeams = {}): Promise<void> {',
      '  const program = new Command();',
      '  program.exitOverride();',
      '  registerBlockCommand(program, seams);',
      "  await program.parseAsync(['block', ...args], { from: 'user' });",
      '}',
    ].join('\n');

    const leaked = [
      'v2-08-attended-block-runner.test.ts',
      'v2-09-dependent-commit-chain.test.ts',
      'v3-07-lease-release-fault.test.ts',
      'v3-07-lease-release-observability.test.ts',
    ];

    expect(offenders(leaked.map((name) => ({ name, text: helper })))).toEqual(leaked);

    // The harder one, and the reason the seams-default rule exists rather than
    // a whole-file "does it mention a notifier". `v2-10`'s subject IS
    // notification, so it bound recording fakes in most of its cases and forgot
    // one — a file that mentions notifiers everywhere and still had a call that
    // would reach the operator's real profile.
    const notificationSuite = [
      'const recording = { notifier: recordingNotifier() };',
      helper,
      "await invokeBlock(['--repository', root, '--attended'], recording);",
      "await invokeBlock(['--repository', root, '--attended']);",
    ].join('\n');

    expect(offenders([{ name: 'v2-10-like.test.ts', text: notificationSuite }])).toEqual([
      'v2-10-like.test.ts',
    ]);
  });

  /**
   * And the files that leaked are sealed today, asserted against what the
   * repository actually ships so the transcription above cannot quietly become
   * a description of nothing.
   */
  it('seals all four suites the pushes came from', () => {
    const files = testFiles();
    for (const name of [
      'v2-08-attended-block-runner.test.ts',
      'v2-09-dependent-commit-chain.test.ts',
      'v3-07-lease-release-fault.test.ts',
      'v3-07-lease-release-observability.test.ts',
    ]) {
      const file = files.find((candidate) => candidate.name === name);
      expect(file, `${name} should exist`).toBeDefined();
      expect(file?.text).toContain('registerBlockCommand(program, { notifier: SILENT_NOTIFIER,');
    }
    // And the notification suite, which seals at its helper's DEFAULT rather
    // than at each call, because its cases legitimately override it.
    const v210 = files.find((f) => f.name === 'v2-10-operator-notification.test.ts');
    expect(v210?.text).toContain('registerBlockCommand(program, { notifier: SILENT_NOTIFIER, ...seams });');
  });

  /**
   * The half a rule like this usually lacks. Each fixture is a file that must
   * be reported, and each corresponds to a way the previous version of this
   * scan was broken or could have been.
   */
  it('reports the evasions that are one keystroke away', () => {
    const fixtures: readonly ScannedFile[] = [
      // No seams at all. Not what the incident looked like, but one deletion
      // away from it, and the shape the production fallback exists for.
      { name: 'no-seams.test.ts', text: 'registerBlockCommand(program);' },
      // THE INCIDENT'S OWN SHAPE: two arguments, the second a variable
      // defaulting to nothing, and no notifier bound anywhere in the file.
      {
        name: 'seams-variable.test.ts',
        text: 'async function invokeBlock(args, seams = {}) {\n  registerBlockCommand(program, seams);\n}',
      },
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
      // The word inside the INLINE seams object is a string, so rule 2 must
      // not accept it. This is the second half of the same review finding: the
      // calls themselves are read from string-stripped text, not only the
      // whole-file binding question.
      // No argv line on purpose: with one, rule 4 would report this file for
      // binding nothing and the case would not isolate rule 2 at all. This way
      // the direct call is the only thing that can decide it.
      {
        name: 'notifier-inside-the-seams-string.test.ts',
        text: 'registerBlockCommand(program, { runner: make("notifier: none") });',
      },
      // The only `notifier:` in the file is inside a STRING, so it binds
      // nothing. A review fed exactly this to the previous version and it
      // passed: rule 0 promised no rule could be satisfied by prose, and a
      // string literal is prose the compiler keeps. The seams here has no
      // empty default, so this fixture isolates the string-stripping rather
      // than being caught by the seams-default rule.
      {
        name: 'notifier-in-a-string.test.ts',
        text: [
          "expect(source).toContain('notifier: SILENT_NOTIFIER');",
          'const seams = buildSeams();',
          'registerBlockCommand(program, seams);',
        ].join('\n'),
      },
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
      // A seams variable WITH a notifier bound into it, which is what `v2-10`
      // now does: its subject is notification, so its default is the silent one
      // and each case may override with a recording fake. The variable alone is
      // not enough -- that is the incident's shape and is refused above.
      {
        name: 'variable.test.ts',
        text: 'const seams = { notifier: SILENT_NOTIFIER };\nregisterBlockCommand(program, seams);\nparseAsync(["block"]);',
      },
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
