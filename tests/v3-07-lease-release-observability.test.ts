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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBlockCommand, type BlockCommandSeams } from '../src/cli/block-command.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import { registerReleaseCommand } from '../src/cli/release-command.js';
import {
  LEASE_RELEASE_SENTENCES,
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

describe('the release vocabulary is closed, shared and safe', () => {
  it('has one sentence per code and no more', () => {
    expect(Object.keys(LEASE_RELEASE_SENTENCES).sort()).toEqual([...LEASE_RELEASE_CODES].sort());
  });

  it('says something different about each one', () => {
    const sentences = LEASE_RELEASE_CODES.map((code) => LEASE_RELEASE_SENTENCES[code]);
    expect(new Set(sentences).size).toBe(LEASE_RELEASE_CODES.length);
  });

  it('is ASCII only, so a re-encoding pass cannot damage an operator sentence', () => {
    for (const code of LEASE_RELEASE_CODES) {
      const sentence = LEASE_RELEASE_SENTENCES[code];
      expect([...sentence].every((ch) => ch.codePointAt(0)! <= 0x7f)).toBe(true);
    }
  });

  it('never contains the word the notification harness scrapes', () => {
    // `tests/dist-artifact/notification-egress-dist-artifact.mjs` reads block's
    // stdout with `/reason (\S+)/`. This report is printed after the run report,
    // so a sentence carrying that word would answer that scrape with prose on
    // exactly the runs that carry no reason of their own.
    for (const code of LEASE_RELEASE_CODES) {
      expect(LEASE_RELEASE_SENTENCES[code]).not.toContain('reason ');
      expect(LEASE_RELEASE_SENTENCES[code]).not.toContain('Outcome');
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
      LEASE_ABSENT: 'the record this invocation took is already gone',
      NOT_OWNER: 'is not the record this invocation took',
      LEASE_UNREADABLE: 'could not be read at the end',
      LEASE_REMOVE_FAILED: 'The lease was not fully removed.',
    };
    for (const code of LEASE_RELEASE_CODES) {
      expect(LEASE_RELEASE_SENTENCES[code]).toContain(fragments[code]);
    }
  });

  it('claims nothing about a code that its producers do not all share', () => {
    // `NOT_OWNER` comes from three removal end states and `LEASE_REMOVE_FAILED`
    // from four, and they differ on the two facts that decide what an operator
    // does: whether a detached copy was left in quarantine, and whether anything
    // holds the lease name afterwards. `RECORD_QUARANTINED_LEASE_UNOWNED` is the
    // one that inverts both - the repository ends up with no owner at all - so a
    // sentence asserting a successor, or asserting that nothing was moved, is
    // false exactly when it matters most. `execution-lease.ts` records a review
    // that reproduced that harm once already.
    for (const code of ['NOT_OWNER', 'LEASE_REMOVE_FAILED'] as const) {
      const sentence = LEASE_RELEASE_SENTENCES[code];
      expect(sentence).not.toContain('Another invocation owns this repository');
      expect(sentence).not.toContain('left exactly as it is');
      expect(sentence).not.toContain('will refuse the next run.');
      // and each one points at the token that carries the difference. Wrapped
      // first: these strings are hard-wrapped for the console, so the phrase can
      // straddle a newline and two spaces of indent.
      expect(sentence.replace(/\s+/g, ' ')).toContain('token on the line above');
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

  it('does not report a lease it never took', async () => {
    // Above the lease line: no operator, no repository read, and therefore
    // nothing to give back. A `Lease` line here would be a report about an
    // authority this invocation never held.
    const fixture = await repoWith(['A-001']);

    await invokeRelease(['--repository', fixture.root, '--task', 'A-001']);

    expect(out()).toContain('not requested');
    expect(out()).not.toContain('Lease        :');
    expect(process.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
  }, 600_000);
});
