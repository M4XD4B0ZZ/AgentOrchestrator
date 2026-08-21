/**
 * V3-07 — the execution-lease release, reported by the commands that take one.
 *
 * ── What was wrong ─────────────────────────────────────────────────────────
 *
 * `releaseRepositoryExecutionLease` answers with a code and a detail token, and
 * two of the three commands that held a lease threw that answer away. Both
 * called it as a bare expression statement inside a `finally`, so a lease that
 * came back quarantined, displaced, unreadable or not at all was invisible: the
 * command printed its own verdict, exited on its own verdict, and an operator
 * learned that something was still sitting in `.git` from the *next* run's
 * refusal. `block --attended` is the longer-running of the two and therefore the
 * likelier to meet the condition.
 *
 * ── What this file pins ────────────────────────────────────────────────────
 *
 * Three properties, and they are separable on purpose:
 *
 *   1. the result is **printed** — on every attended path that took a lease,
 *      including the input refusals and including the successful one;
 *   2. the primary result is **not rewritten** by it — a block that completed
 *      still says so, a workspace that was removed still says so;
 *   3. the process **cannot exit nominal** on an unproven release.
 *
 * Property 3 is the one a script reads, and it is the one that was wrong: exit 0
 * after a failed release told a caller "nothing to do here" about a repository
 * that now refuses its next run.
 *
 * ── Where the failing releases are ─────────────────────────────────────────
 *
 * In `tests/v3-07-lease-release-fault.test.ts`, not here. Reaching a
 * non-`RELEASED` release without weakening the lease means intercepting one
 * syscall, which needs a `vi.mock('node:fs')` factory, which is hoisted per
 * file. This file therefore holds everything a real lease can prove on its own —
 * the successful releases, the refusal paths, the throw paths and the closed
 * vocabulary — and the sibling holds the four cases that need the window.
 */

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBlockCommand, type BlockCommandSeams } from '../src/cli/block-command.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import { registerReleaseCommand } from '../src/cli/release-command.js';
import {
  LEASE_RELEASE_DETAILS,
  LEASE_RELEASE_DETAIL_SENTENCES,
  LEASE_RELEASE_SENTENCES,
  LEASE_RELEASE_UNREPORTED,
  LEASE_RELEASE_UNREPORTED_SENTENCE,
  leaseReleaseLine,
  renderLeaseRelease,
} from '../src/cli/render-lease.js';
import { renderLifecycleRun } from '../src/cli/render-lifecycle.js';
import {
  EXIT_RUN_CALL_AGAIN,
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  exitCodeWithLeaseRelease,
  type CliExitCode,
} from '../src/cli/run-exit-codes.js';
import {
  LEASE_RELEASE_CODES,
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  releaseRepositoryExecutionLease,
  type LeaseReleaseCode,
  type LeaseReleaseResult,
} from '../src/lease/execution-lease.js';
import type { ResolvedRepository } from '../src/repo/resolve-repository.js';
import { startTask } from '../src/run/start-task.js';
import type { ReplaceFn } from '../src/state/atomic-file.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import {
  e2eProfile,
  recordedAgent,
  recordedVerify,
  reviewResult,
  taskFile,
  tickingClock,
  writerThatEdits,
} from './helpers/e2e-fixtures.js';
import { passingReview } from './fixtures.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture, trackWorkspacesOf } from './helpers/worktree-fixtures.js';

const RUN_ID = 'run-0001';
const BLOCK_ID = 'V3-07';
const RELEASE_TASK_ID = 'V3-07-R';

let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  stdout = [];
  stderr = [];
  // Reset, or a fully passing run inherits whatever exit code the command last
  // set and vitest exits non-zero over a green suite.
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown): boolean => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
});

const out = (): string => stdout.join('');
const err = (): string => stderr.join('');

interface Fixture {
  readonly repository: ResolvedRepository;
  readonly root: string;
}

/** A real repository declaring the tasks asked for. */
async function repoWith(taskIds: readonly string[]): Promise<Fixture> {
  const files: Record<string, string> = {
    '.gitignore': '.agent-orchestrator/runtime/\n',
    'src/index.ts': 'export const start = true;\n',
  };
  for (const taskId of taskIds) files[`tasks/${taskId}.md`] = taskFile(taskId, { dependsOn: [] });
  const root = createRepoFixture({ defaultBranch: 'main', profile: e2eProfile(), files });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return { repository, root };
}

/** Seams that drive a task all the way to `READY_FOR_PR`. */
function drivingSeams() {
  let pass = 0;
  const agent = recordedAgent({
    claude: (call) => {
      pass += 1;
      return writerThatEdits(`src/work-${pass}.ts`, `export const pass = ${pass};\n`)(call);
    },
    codex: () => reviewResult(passingReview()),
  });
  return { agent: agent.runner, verify: recordedVerify().runner };
}

async function invokeBlock(args: readonly string[], seams: BlockCommandSeams = {}): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBlockCommand(program, seams);
  await program.parseAsync(['block', ...args], { from: 'user' });
}

async function invokeRelease(args: readonly string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerReleaseCommand(program);
  await program.parseAsync(['release', ...args], { from: 'user' });
}

/**
 * A repository whose first start crashed after creating the workspace.
 *
 * The lease the crashed start ran under is given back before returning, because
 * the command under test acquires its own and a test still holding one would be
 * refused rather than measured.
 */
async function afterCrashedStart(): Promise<Fixture & { readonly orphan: string }> {
  const fixture = await repoWith([RELEASE_TASK_ID]);
  const crashingReplace: ReplaceFn = () => {
    throw new Error('simulated crash before the first durable write landed');
  };
  const crashed = await startTask(
    { repository: fixture.repository, taskId: RELEASE_TASK_ID },
    {
      git: runGitCommand,
      now: tickingClock(),
      authPreflight: authPreflightPasses,
      lease: leaseFor(fixture.repository),
      replace: crashingReplace,
    },
  );
  expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
  const orphan = crashed.workspace?.worktreePath;
  if (orphan === undefined) throw new Error('the crashed start produced no workspace');
  releaseTestLeases();
  return { ...fixture, orphan };
}

/** Whether this repository can be taken by somebody else now. */
function leaseIsFree(repository: ResolvedRepository): boolean {
  const taken = acquireRepositoryExecutionLease(
    repository,
    { runId: 'run-0002', blockId: BLOCK_ID },
    { now: () => new Date().toISOString() },
  );
  if (!taken.ok) return false;
  releaseRepositoryExecutionLease(taken.evidence);
  return true;
}

/* ───────────────────────── 1. the shared vocabulary ─────────────────────── */

/** Every sentence this vocabulary can put on an operator's console. */
const printedSentences = (): readonly string[] => [
  ...LEASE_RELEASE_CODES.map((code) => LEASE_RELEASE_SENTENCES[code]),
  ...LEASE_RELEASE_DETAILS.map((token) => LEASE_RELEASE_DETAIL_SENTENCES[token]),
  LEASE_RELEASE_UNREPORTED_SENTENCE,
];

describe('the release vocabulary is closed, shared and safe', () => {
  it('has one sentence per code and no more', () => {
    expect(Object.keys(LEASE_RELEASE_SENTENCES).sort()).toEqual([...LEASE_RELEASE_CODES].sort());
  });

  it('keeps the unreported state outside the release vocabulary', () => {
    // It is the state of having no answer from the release, not an answer, so it
    // may not join the union - a member there would be a value the release could
    // be believed to have returned.
    expect(LEASE_RELEASE_UNREPORTED).toBe('RELEASE_NOT_REPORTED');
    expect([...LEASE_RELEASE_CODES] as string[]).not.toContain(LEASE_RELEASE_UNREPORTED);
  });

  it('says something different about each one', () => {
    // The seventh sentence is included everywhere the six are, here and below:
    // it reaches the console on the same footing, and a sentence no pin can
    // reach is the one that drifts.
    expect(new Set(printedSentences()).size).toBe(printedSentences().length);
  });

  it('is ASCII only, so a re-encoding pass cannot damage an operator sentence', () => {
    for (const sentence of printedSentences()) {
      expect([...sentence].every((ch) => ch.codePointAt(0)! <= 0x7f)).toBe(true);
    }
  });

  it('never contains the word the notification harness scrapes', () => {
    // `tests/dist-artifact/notification-egress-dist-artifact.mjs` reads block's
    // stdout with `/reason (\S+)/`. This report is printed after the run report,
    // so a sentence carrying that word would answer that scrape with prose on
    // exactly the runs that carry no reason of their own.
    for (const sentence of printedSentences()) {
      expect(sentence).not.toContain('reason ');
      expect(sentence).not.toContain('Outcome');
    }
  });

  it('names no command that does not exist, on one line where a reader can see it', () => {
    // The repository already scans shipped source for `lease <word>` naming a
    // subcommand that is not registered. That scan cannot see a name broken
    // across a string concatenation, and a name broken across one is unreadable
    // on the console anyway, so it is forbidden here rather than merely unlucky.
    for (const sentence of printedSentences()) {
      const opened = sentence.split('`').filter((_, index) => index % 2 === 1);
      for (const quoted of opened) expect(quoted).not.toContain('\n');
    }
  });

  it('prints the code always and the detail beside it when there is one', () => {
    expect(leaseReleaseLine('Release', { code: 'RELEASED', detail: null })).toBe(
      'Release      : RELEASED',
    );
    expect(
      leaseReleaseLine('Release', { code: 'LEASE_REMOVE_FAILED', detail: 'DETACH_REFUSED' }),
    ).toBe('Release      : LEASE_REMOVE_FAILED  (DETACH_REFUSED)');
    expect(leaseReleaseLine('Lease', { code: 'NOT_OWNER', detail: null })).toBe(
      'Lease        : NOT_OWNER',
    );
  });

  it('puts the line and its sentence in the report, for every code', () => {
    for (const code of LEASE_RELEASE_CODES) {
      const rendered = renderLeaseRelease('Release', { code, detail: null });
      expect(rendered).toContain(`Release      : ${code}`);
      expect(rendered).toContain(LEASE_RELEASE_SENTENCES[code]);
    }
  });

  it('cannot carry arbitrary exception text, because nothing interpolates one', () => {
    // The renderer prints `code` and `detail` and nothing else, so the question
    // is what production can put in `detail`. Every producer is a literal in the
    // release half of `execution-lease.ts`: a `detail:` that interpolated an
    // errno, a message or a path would put unbounded text on an operator's
    // console (AO-002) and would defeat the closed vocabulary above.
    const source = readFileSync(join(PACKAGE_ROOT, 'src', 'lease', 'execution-lease.ts'), 'utf8');
    const opens = source.indexOf('export function releaseRepositoryExecutionLease(');
    expect(opens).toBeGreaterThan(-1);
    // To the end of that function: the next brace in the first column. Type
    // declarations elsewhere in this module also write `detail:`, and they are
    // not producers.
    const closes = source.indexOf('\n}', opens);
    expect(closes).toBeGreaterThan(opens);
    const body = source.slice(opens, closes);
    const written = [...body.matchAll(/\bdetail:/g)].length;
    const safe = [...body.matchAll(/\bdetail:\s*(?:null|'[A-Z][A-Z0-9_]*')/g)].length;
    // Every `detail:` this function writes is a bare `null` or a SCREAMING_SNAKE
    // literal. The counts are compared rather than each value tested, because it
    // is the *difference* that a template string, an errno or a message would
    // produce: one more written than safe.
    // Exact, not a floor. `> 4` would still pass if the function were rewritten
    // down to five producers, silently halving the surface this guards; a count
    // that moves is a deliberate change to the release contract and should stop
    // here until somebody re-reads them.
    expect(written).toBe(12);
    expect(safe).toBe(written);
  });

  it('says the right thing about each code, and not merely a different thing', () => {
    // Total by type is not correct by value. The three tests above pin the keys,
    // the uniqueness and the character set, and every other assertion in this
    // suite reads a sentence back out of the same table it is checking - so
    // exchanging two bodies leaves all of them green while telling an operator
    // that a clean release lost its lease, or that a stuck one is fine. These
    // fragments are written out by hand for that reason.
    const fragments: Readonly<Record<LeaseReleaseCode, string>> = {
      RELEASED: 'was given back. Nothing of this invocation is left holding',
      EVIDENCE_INVALID: 'could not prove which lease it was holding',
      LEASE_ABSENT: 'no record was there to remove',
      NOT_OWNER: 'is not the one this invocation took',
      LEASE_UNREADABLE: 'what refused the read was not its absence',
      LEASE_REMOVE_FAILED: 'The removal did not complete.',
    };
    for (const code of LEASE_RELEASE_CODES) {
      expect(LEASE_RELEASE_SENTENCES[code].replace(/\s+/g, ' ')).toContain(fragments[code]);
    }
    const tokens: Readonly<Record<string, string>> = {
      DETACH_REFUSED: 'Nothing was moved at all',
      UNREADABLE_AFTER_DETACH: 'was put back at the lease name',
      RECORD_QUARANTINED: 'the lease name had been taken',
      RECORD_QUARANTINED_LEASE_UNOWNED: 'nothing holds the lease name now',
    };
    for (const token of LEASE_RELEASE_DETAILS) {
      expect(LEASE_RELEASE_DETAIL_SENTENCES[token].replace(/\s+/g, ' ')).toContain(tokens[token]!);
    }
  });

  it('leaves the on-disk state to the token, because the code cannot carry it', () => {
    // The rule three reviews in a row caught this file breaking: a sentence keyed
    // on a code may say only what every producer of that code shares. `NOT_OWNER`
    // has seven producers and `LEASE_REMOVE_FAILED` four, and they disagree on
    // both facts an operator acts on - what is at the lease name, and whether a
    // copy was kept aside. So neither code sentence may state either fact.
    //
    // A phrase blacklist would not pin this: the previous version of this test
    // forbade three historical wordings and passed a sentence that asserted
    // quarantine for a removal that had deleted the quarantine file.
    for (const code of ['NOT_OWNER', 'LEASE_REMOVE_FAILED'] as const) {
      const sentence = LEASE_RELEASE_SENTENCES[code].replace(/\s+/g, ' ');
      // no claim about a kept copy...
      expect(sentence).not.toMatch(/quarantin/i);
      expect(sentence).not.toContain('kept aside');
      // ...and no claim about who holds the name.
      expect(sentence).not.toMatch(/nothing holds/i);
      expect(sentence).not.toMatch(/somebody holds/i);
      // It points at the token instead, which is keyed on the end state itself.
      expect(sentence).toContain('the line under it says what state the removal stopped in');
    }
  });

  it('does not say a copy was kept where the removal put the record back', () => {
    // `UNREADABLE_AFTER_DETACH` reads like a record left in quarantine and is the
    // opposite: `removeVerifiedLease` restores it to the lease name and discards
    // the quarantine copy. `tests/v2-07lr-release-window.test.ts` asserts that by
    // value - the lease file holds the original bytes afterwards and nothing sits
    // beside it. A sentence claiming quarantine here sends an operator into the
    // administrative directory after a file the same call deleted.
    const restored = LEASE_RELEASE_DETAIL_SENTENCES.UNREADABLE_AFTER_DETACH.replace(/\s+/g, ' ');
    // It may not *claim* a kept copy. It may - and must - deny one, which is why
    // the assertion is on the claim rather than on the word.
    expect(restored).not.toContain('is kept');
    expect(restored).not.toContain('could not be put back');
    expect(restored).toContain('put back at the lease name');
    expect(restored).toContain('there is no quarantined copy to go and find');

    // And the two that really do keep one say so.
    for (const token of ['RECORD_QUARANTINED', 'RECORD_QUARANTINED_LEASE_UNOWNED'] as const) {
      expect(LEASE_RELEASE_DETAIL_SENTENCES[token].replace(/\s+/g, ' ')).toContain(
        'could not be put back',
      );
    }
    // The refused detach moved nothing, so it may not claim one either.
    expect(LEASE_RELEASE_DETAIL_SENTENCES.DETACH_REFUSED).not.toMatch(/quarantin/i);
  });

  it('carries a sentence for every token the release can actually produce', () => {
    // Completeness against the producer, not against itself. A new `detail:` in
    // `execution-lease.ts` with no sentence here would print a bare token under a
    // code sentence that deliberately says nothing about the on-disk state.
    const source = readFileSync(join(PACKAGE_ROOT, 'src', 'lease', 'execution-lease.ts'), 'utf8');
    const opens = source.indexOf('export function releaseRepositoryExecutionLease(');
    const body = source.slice(opens, source.indexOf('\n}', opens));
    const produced = new Set(
      [...body.matchAll(/\bdetail:\s*'([A-Z][A-Z0-9_]*)'/g)].map((match) => match[1]!),
    );
    expect([...produced].sort()).toEqual([...LEASE_RELEASE_DETAILS].sort());
  });

  it('does not claim an absent lease left nothing behind', async () => {
    // The counter-proof for the one claim that had to go. `LEASE_ABSENT`
    // establishes exactly one thing: nothing was at the lease name when the
    // release looked. It does **not** look anywhere else, so it cannot speak for
    // what the repository still holds - and the release path reaches this code
    // from an `ENOENT` on the verifying read, which inspects nothing at all.
    //
    // Produced with the real lease and no injection: take a lease, move its
    // record aside under a quarantine-shaped name, and release with the genuine
    // evidence. The code is `LEASE_ABSENT` and the record is still on disk.
    const fixture = await repoWith(['A-001']);
    const location = deriveExecutionLeaseLocation(fixture.repository);
    if (!location.ok) throw new Error(`no lease location: ${location.code}`);

    const taken = acquireRepositoryExecutionLease(
      fixture.repository,
      { runId: 'run-0002', blockId: BLOCK_ID },
      { now: () => new Date().toISOString() },
    );
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;

    const recordBefore = readFileSync(location.path);
    const movedAside = `${location.path}.breaking-moved-by-this-test`;
    renameSync(location.path, movedAside);
    try {
      const released = releaseRepositoryExecutionLease(taken.evidence);

      expect(released).toEqual({ code: 'LEASE_ABSENT', detail: null });
      // The record this invocation took is right there, and the release never
      // looked. Any sentence claiming otherwise is claiming this file away.
      // The record itself, byte for byte - not merely a path that exists.
      expect(existsSync(movedAside)).toBe(true);
      expect(readFileSync(movedAside)).toEqual(recordBefore);
      // So the sentence may not write it off. Two historical wordings and the
      // general claim they were instances of.
      const absent = LEASE_RELEASE_SENTENCES.LEASE_ABSENT.replace(/\s+/g, ' ');
      expect(absent).not.toContain('Nothing is left behind');
      expect(absent).not.toContain('already gone');
      expect(absent).toContain('it did not look anywhere else in the repository');
      // This case reaches one of the three producers - the verifying read's
      // `ENOENT`. The other two, a refused detach and a detach that moved
      // nothing, are produced by `tests/v2-07lr-release-window.test.ts`; the
      // sentence has to hold for all three, which is why it names none of them.
      expect(absent).not.toContain('when this invocation looked');
    } finally {
      rmSync(movedAside, { force: true });
    }
  });

  it('answers rather than throwing, which is what both `finally` blocks rest on', () => {
    // Both commands assign this call's result inside a `finally`. A `finally`
    // that throws **replaces** the exception that entered it, so a release able
    // to throw would swallow the original failure and hand the operator the
    // wrong one. It cannot: every syscall on its path is wrapped, and a value
    // that is not evidence is refused rather than dereferenced. Pinned here
    // rather than asserted in a comment, because it is the load-bearing half of
    // this slice's exception behaviour.
    const hostile: readonly unknown[] = [
      undefined,
      null,
      {},
      'not evidence',
      42,
      Object.create(null),
      new Proxy({}, { get: () => { throw new Error('hostile getter'); } }),
    ];
    for (const value of hostile) {
      expect(() => releaseRepositoryExecutionLease(value)).not.toThrow();
      expect(releaseRepositoryExecutionLease(value).code).toBe('EVIDENCE_INVALID');
    }
  });
});

/* ─────────────────── 2. the precedence, stated as one rule ──────────────── */

describe('an unproven release decides the exit code and nothing else', () => {
  const codes: readonly CliExitCode[] = [
    EXIT_RUN_OK,
    EXIT_RUN_INPUT_UNUSABLE,
    EXIT_RUN_NEEDS_OPERATOR,
    EXIT_RUN_REFUSED,
    EXIT_RUN_CALL_AGAIN,
  ];

  it('keeps the primary code when the lease provably came back', () => {
    const all: readonly CliExitCode[] = [...codes, EXIT_RUN_UNEXPECTED];
    for (const primary of all) {
      expect(exitCodeWithLeaseRelease(primary, { code: 'RELEASED', detail: null })).toBe(primary);
    }
  });

  it('refuses to exit nominal on any other answer, including a successful primary', () => {
    for (const code of LEASE_RELEASE_CODES.filter((c) => c !== 'RELEASED')) {
      const result: LeaseReleaseResult = { code, detail: null };
      expect(exitCodeWithLeaseRelease(EXIT_RUN_OK, result)).toBe(EXIT_RUN_NEEDS_OPERATOR);
      for (const primary of codes) {
        expect(exitCodeWithLeaseRelease(primary, result)).not.toBe(EXIT_RUN_OK);
      }
    }
  });

  it('treats a missing result as unproven rather than as nothing to report', () => {
    // `null` here is a release that produced no answer at all. It proves the
    // same amount as a failure - nothing - and inferring success from it would
    // be exactly the inference this slice removes.
    expect(exitCodeWithLeaseRelease(EXIT_RUN_OK, null)).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('exempts no primary code at all, including the unexpected one', () => {
    // A thrown operation never arrives here - both commands' `catch` blocks set
    // code 1 where they catch. The only caller that can pass a 1 is the block
    // exit mapping's own defect floor, and in that state the block ran and the
    // lease is stuck, so 3 is the code that names the thing an operator can act
    // on. An exemption here would have been the one hole in the rule.
    for (const code of LEASE_RELEASE_CODES.filter((c) => c !== 'RELEASED')) {
      expect(exitCodeWithLeaseRelease(EXIT_RUN_UNEXPECTED, { code, detail: null })).toBe(
        EXIT_RUN_NEEDS_OPERATOR,
      );
    }
    expect(exitCodeWithLeaseRelease(EXIT_RUN_UNEXPECTED, null)).toBe(EXIT_RUN_NEEDS_OPERATOR);
    // And a proven release still leaves it alone.
    expect(exitCodeWithLeaseRelease(EXIT_RUN_UNEXPECTED, { code: 'RELEASED', detail: null })).toBe(
      EXIT_RUN_UNEXPECTED,
    );
  });
});

/* ───────────────── 3. `run --attended` keeps what V3-06 gave it ─────────── */

describe('the lifecycle report still says what it said', () => {
  it('renders its release line through the shared renderer, byte for byte', () => {
    const release: LeaseReleaseResult = { code: 'LEASE_REMOVE_FAILED', detail: 'DETACH_REFUSED' };
    const text = renderLifecycleRun(
      { id: 'fixture', root: 'D:\\nowhere', defaultBranch: 'main' } as ResolvedRepository,
      {
        outcome: 'LEASE_RELEASE_FAILED',
        taskId: 'T-1',
        acquire: null,
        recovery: null,
        release,
        start: null,
        runs: [],
        invocations: 0,
        steps: 0,
        reasonCodes: [],
        permissionDenials: [],
      } as unknown as Parameters<typeof renderLifecycleRun>[1],
    );
    expect(text).toContain(leaseReleaseLine('Release', release));
    // And not the per-code sentence: this report has its own outcome sentence,
    // and printing a second one would say the same thing twice.
    expect(text).not.toContain(LEASE_RELEASE_SENTENCES.LEASE_REMOVE_FAILED);
  });
});

/* ─────────────────────────── 4. `block --attended` ──────────────────────── */

describe('block --attended reports the lease it gave back', () => {
  it('says so on a block that ran to the end, and still exits nominal', async () => {
    const fixture = await repoWith(['A-001', 'B-001']);
    const seams = drivingSeams();

    await invokeBlock(
      [
        '--repository', fixture.root,
        '--block', BLOCK_ID,
        '--tasks', 'A-001', 'B-001',
        '--run', RUN_ID,
        '--attended',
      ],
      { authPreflight: authPreflightPasses, agent: seams.agent, verify: seams.verify },
    );

    // Both facts, and the block's own one first.
    expect(out()).toContain('COMPLETE');
    expect(out()).toContain('Release      : RELEASED');
    expect(out()).toContain(LEASE_RELEASE_SENTENCES.RELEASED);
    expect(process.exitCode).toBe(EXIT_RUN_OK);
    // Which is a claim about the world, not about the string: the repository is
    // takeable by somebody else now.
    expect(leaseIsFree(fixture.repository)).toBe(true);
  }, 900_000);

  it('says so on an input refusal taken under the lease', async () => {
    // The refusal returns from inside the `try`, which is the shape that hid the
    // result: a `return` there runs the `finally` and leaves the function, so
    // until V3-07 there was no code left to report to.
    const fixture = await repoWith(['A-001']);

    await invokeBlock([
      '--repository', fixture.root,
      '--block', BLOCK_ID,
      '--tasks', 'A-001', 'GHOST-001',
      '--run', RUN_ID,
      '--attended',
    ]);

    expect(out()).toContain('TASK_NOT_IN_GRAPH');
    expect(out()).toContain('Release      : RELEASED');
    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(leaseIsFree(fixture.repository)).toBe(true);
  }, 600_000);

  it('says so on the definition refusal, which returns from further in', async () => {
    // A second early return, further down the same `try` than the projection
    // refusal above. One case would leave open the reading that the first return
    // happened to be special; two that sit either side of the projection do not.
    const fixture = await repoWith(['A-001']);

    await invokeBlock([
      '--repository', fixture.root,
      '--block', BLOCK_ID,
      '--tasks', 'A-001', 'A-001',
      '--run', RUN_ID,
      '--attended',
    ]);

    expect(out()).toContain('TASK_REPEATED');
    expect(out()).toContain('Release      : RELEASED');
    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(leaseIsFree(fixture.repository)).toBe(true);
  }, 600_000);

  it('still gives the lease back when the work throws, and still fails closed', async () => {
    const fixture = await repoWith(['A-001']);
    const boom = new Error('a path with a secret in it: D:\\\\somewhere\\\\private');

    await invokeBlock(
      [
        '--repository', fixture.root,
        '--block', BLOCK_ID,
        '--tasks', 'A-001',
        '--run', RUN_ID,
        '--attended',
      ],
      {
        authPreflight: () => {
          throw boom;
        },
      },
    );

    // The original failure keeps the exit code and the message stays withheld.
    expect(process.exitCode).toBe(EXIT_RUN_UNEXPECTED);
    expect(err()).toContain('agent-loop block:');
    expect(err()).not.toContain('private');
    expect(err()).not.toContain(boom.message);
    // The release still happened *and* is still reported. Reporting is the half
    // a language guarantee does not give: `finally` runs, but until V3-07 there
    // was nothing downstream of it and the `catch` printed only the error.
    expect(out()).toContain('Release      : RELEASED');
    // And the claim about the string is a claim about the world.
    expect(leaseIsFree(fixture.repository)).toBe(true);
  }, 600_000);
});

describe('block --attended reports the lease once, not twice', () => {
  it('does not print a second report when the step after it throws', async () => {
    // The one path where the once-only flag is load-bearing: the normal report
    // succeeds, something after it throws, and the `catch` calls the reporter
    // again. Without `leaseReleaseReported` the operator gets two release
    // reports for one release, which reads as two releases.
    //
    // Reached by refusing the write that follows the release report - in a
    // driven block that is the notification result, the last thing this command
    // prints.
    const fixture = await repoWith(['A-001']);
    const seams = drivingSeams();
    let armed = false;
    let writes = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      writes += 1;
      const text = String(chunk);
      if (armed) throw new Error('the console went away');
      if (text.includes('Release      :')) armed = true;
      stdout.push(text);
      return true;
    }) as typeof process.stdout.write);

    await invokeBlock(
      [
        '--repository', fixture.root,
        '--block', BLOCK_ID,
        '--tasks', 'A-001',
        '--run', RUN_ID,
        '--attended',
      ],
      { authPreflight: authPreflightPasses, agent: seams.agent, verify: seams.verify },
    );

    // Exactly one release report reached the console, and the retry from the
    // `catch` was refused by the flag rather than by luck.
    expect(out().match(/Release {6}: /g)).toHaveLength(1);
    expect(writes).toBe(stdout.length + 1);
    expect(process.exitCode).toBe(EXIT_RUN_UNEXPECTED);
  }, 900_000);
});

describe('block --attended reports no lease it never took', () => {
  it('stays silent about the lease when the throw is above the lease line', async () => {
    // The mirror of the `release` case below, on the command whose `catch` also
    // calls the reporter unconditionally. Refusing the first write throws inside
    // `renderNotifierState`, which is the last thing this command prints before
    // it acquires - so if `leaseReleaseAttempted` were ever initialised true,
    // this run would report a release for a lease that was never taken.
    const fixture = await repoWith(['A-001']);
    let writes = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      writes += 1;
      if (writes === 1) throw new Error('the console went away');
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await invokeBlock([
      '--repository', fixture.root,
      '--block', BLOCK_ID,
      '--tasks', 'A-001',
      '--run', RUN_ID,
      '--attended',
    ]);

    expect(writes).toBe(1);
    expect(out()).toBe('');
    expect(process.exitCode).toBe(EXIT_RUN_UNEXPECTED);
    // And nothing was taken, so nothing needed giving back.
    expect(leaseIsFree(fixture.repository)).toBe(true);
  }, 600_000);
});

/* ────────────────────────── 5. `release --attended` ─────────────────────── */

describe('release --attended keeps its two releases apart', () => {
  it('reports the workspace and the execution lease as two separate facts', async () => {
    const fixture = await afterCrashedStart();

    await invokeRelease([
      '--repository', fixture.root,
      '--task', RELEASE_TASK_ID,
      '--attended',
    ]);

    const text = out();
    // The workspace verdict, under its own label.
    expect(text).toContain('Outcome      : RELEASED');
    // The execution lease, under a different one. Sharing the word "Release"
    // with the command's own name is what made the two collapsible.
    expect(text).toContain('Lease        : RELEASED');
    expect(text).toContain(LEASE_RELEASE_SENTENCES.RELEASED);
    expect(process.exitCode).toBe(EXIT_RUN_OK);
    expect(leaseIsFree(fixture.repository)).toBe(true);
  }, 900_000);

  it('reports the lease even when the workspace refuses', async () => {
    const fixture = await repoWith(['A-001']);

    await invokeRelease([
      '--repository', fixture.root,
      '--task', 'GHOST-001',
      '--attended',
    ]);

    expect(out()).toContain('Outcome      : TASK_UNKNOWN');
    expect(out()).toContain('Lease        : RELEASED');
    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(leaseIsFree(fixture.repository)).toBe(true);
  }, 600_000);

  it('still reports the lease when the step after it throws', async () => {
    // The narrowest throw this command can be given. Nothing in `release
    // --attended` writes to stdout between the acquisition and the `finally`,
    // and every syscall on `releaseTaskWorkspace`'s path is wrapped by the
    // module that makes it - so no seam this build offers can raise an exception
    // *inside* that `try`. What can be raised is the write that follows it, and
    // that is enough for the property this case is about: after a throw, the
    // `catch` still prints what happened to the lease and still fails closed.
    //
    // The in-`try` half is proven where it is reachable: `block --attended`
    // above throws from a real seam under the lease, through the identical
    // `try`/`finally` construct.
    const fixture = await afterCrashedStart();
    let writes = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      writes += 1;
      if (writes === 1) throw new Error('the console went away');
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await invokeRelease([
      '--repository', fixture.root,
      '--task', RELEASE_TASK_ID,
      '--attended',
    ]);

    // The first write - the workspace report - was lost with the throw. The
    // second is the lease, printed from the `catch`.
    expect(writes).toBe(2);
    expect(out()).toContain('Lease        : RELEASED');
    expect(process.exitCode).toBe(EXIT_RUN_UNEXPECTED);
    expect(leaseIsFree(fixture.repository)).toBe(true);
  }, 900_000);

  it('does not report a lease it never took, even from the catch', async () => {
    // An absence assertion needs a reachable presence, or it pins nothing. The
    // presence here is the `catch`: it calls the reporter unconditionally, so
    // the only thing keeping a `Lease` line off a repository this invocation
    // never became the writer of is `leaseReleaseAttempted`. A throw is forced
    // above the lease line by refusing the first write - the withheld-attendance
    // report - which is the last thing this command does before it would have
    // gone on to acquire.
    const fixture = await repoWith(['A-001']);
    let writes = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      writes += 1;
      if (writes === 1) throw new Error('the console went away');
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await invokeRelease(['--repository', fixture.root, '--task', 'A-001']);

    // One write attempted and no second one: the `catch` reported the failure to
    // stderr and reported no lease, because there was none to report.
    expect(writes).toBe(1);
    expect(out()).toBe('');
    expect(process.exitCode).toBe(EXIT_RUN_UNEXPECTED);
  }, 600_000);

});
