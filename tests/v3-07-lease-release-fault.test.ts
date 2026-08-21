/**
 * V3-07 — what the two commands do when the lease does not come back.
 *
 * ── Why this is a separate file ────────────────────────────────────────────
 *
 * Its sibling `tests/v3-07-lease-release-observability.test.ts` proves that the
 * release result is printed and consumed. It cannot prove the half that matters
 * most — that a *failed* release survives a *successful* primary operation —
 * because a real block run that completes gives its lease back cleanly, and the
 * only ways to stop it are to weaken the lease or to intervene in the window
 * between the run finishing and the release running. The first is out: a
 * production semantic loosened to make a test easy is a semantic that is no
 * longer being tested. The second needs a `vi.mock('node:fs')` factory, and
 * those are hoisted per test file.
 *
 * ── The instrument, and why it is honest ───────────────────────────────────
 *
 * One `renameSync` is refused, once, and only when its **source** is the lease
 * file itself. That is the detach at `execution-lease.ts:1475`, and it is the
 * only rename in the build whose source is that name. It cannot fire on
 * acquisition at all: acquisition does not rename, it `link`s a finished staging
 * file into place — the rename fallback was withdrawn — so there is no rename to
 * intercept there, let alone one sourced at the lease name. Production then produces the consequence itself, all
 * the way through: `DETACH_FAILED` -> `LEASE_REMOVE_FAILED` with detail
 * `DETACH_REFUSED`, and a lease record still sitting in the repository.
 *
 * Nothing else is faked. The repository is real, the lease is real, the block
 * runs for real, and the workspace is really removed. What each command does
 * with the answer is the subject.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The fault, hoisted so the `vi.mock` factory can see it.
 *
 * One-shot and disarmed the moment it fires, which is what keeps it from also
 * refusing the assertions and the cleanup afterwards.
 */
const io = vi.hoisted(() => ({
  refuseLeaseDetach: false,
  /**
   * Make the release itself throw, once.
   *
   * `removeVerifiedLease` names its quarantine file with `randomBytes(6)`
   * **before** it opens any `try`, so a refusal there is the one way to get
   * `releaseRepositoryExecutionLease` to throw without editing it - which is
   * what the guard inside both commands' `finally` exists for, and what no seam
   * this build offers can produce. Armed late, from inside a seam that is
   * already past acquisition, because acquisition names its staging file the
   * same way.
   */
  refuseRandomBytes: false,
  /**
   * Arm {@link refuseRandomBytes} after a named file is read.
   *
   * `release --attended` offers no seam at all, so the throwing release has to be
   * armed from something the command itself does between taking the lease and
   * giving it back. Reading the task file is that: `releaseTaskWorkspace` plans
   * before it removes, and planning opens every task file. Arming any earlier
   * would refuse the acquisition's own staging name instead.
   */
  armOnReadOf: null as string | null,
}));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    default: actual,
    randomBytes: (...args: Parameters<typeof actual.randomBytes>): unknown => {
      if (io.refuseRandomBytes) {
        io.refuseRandomBytes = false;
        throw new Error('injected: no entropy');
      }
      return (actual.randomBytes as (...a: unknown[]) => unknown)(...args);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const LEASE_FILE = 'agent-orchestrator-execution-lease.json';

  return {
    ...actual,
    default: actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>): unknown => {
      const result = actual.readFileSync(...args);
      const path = String(args[0]);
      if (io.armOnReadOf !== null && path.endsWith(io.armOnReadOf)) {
        io.armOnReadOf = null;
        io.refuseRandomBytes = true;
      }
      return result;
    },
    renameSync: (
      from: Parameters<typeof actual.renameSync>[0],
      to: Parameters<typeof actual.renameSync>[1],
    ): void => {
      const source = String(from);
      const basename = source.slice(source.replace(/\\/g, '/').lastIndexOf('/') + 1);
      if (io.refuseLeaseDetach && basename === LEASE_FILE) {
        io.refuseLeaseDetach = false;
        throw Object.assign(new Error('injected EPERM'), { code: 'EPERM' });
      }
      actual.renameSync(from, to);
    },
  };
});

const { Command } = await import('commander');
const { registerBlockCommand } = await import('../src/cli/block-command.js');
const { registerReleaseCommand } = await import('../src/cli/release-command.js');
const { LEASE_RELEASE_DETAIL_SENTENCES, LEASE_RELEASE_SENTENCES, LEASE_RELEASE_UNREPORTED } =
  await import('../src/cli/render-lease.js');
const { EXIT_RUN_NEEDS_OPERATOR, EXIT_RUN_UNEXPECTED } = await import(
  '../src/cli/run-exit-codes.js'
);
const { startTask } = await import('../src/run/start-task.js');
const { runGitCommand } = await import('../src/worktree/git-command.js');
const { authPreflightPasses } = await import('./helpers/auth-evidence.js');
const {
  e2eProfile,
  recordedAgent,
  recordedVerify,
  reviewResult,
  taskFile,
  tickingClock,
  writerThatEdits,
} = await import('./helpers/e2e-fixtures.js');
const { passingReview } = await import('./fixtures.js');
const { leaseFor, releaseTestLeases } = await import('./helpers/lease.js');
const { createRepoFixture, removeRepoFixtures } = await import('./helpers/repo-fixtures.js');
const { removeTrackedWorkspaces, resolveFixture, trackWorkspacesOf } = await import(
  './helpers/worktree-fixtures.js'
);

type BlockCommandSeams = Parameters<typeof registerBlockCommand>[1];
type ResolvedRepository = Awaited<ReturnType<typeof resolveFixture>>;

const RUN_ID = 'run-0001';
const BLOCK_ID = 'V3-07F';
const RELEASE_TASK_ID = 'V3-07-RF';

/** The one answer this file's instrument produces, spelled once. */
const REFUSED_DETACH = 'LEASE_REMOVE_FAILED  (DETACH_REFUSED)';

let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  stdout = [];
  stderr = [];
  process.exitCode = undefined;
  io.refuseLeaseDetach = false;
  io.refuseRandomBytes = false;
  io.armOnReadOf = null;
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
  io.refuseLeaseDetach = false;
  io.refuseRandomBytes = false;
  io.armOnReadOf = null;
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

async function afterCrashedStart(): Promise<Fixture> {
  const fixture = await repoWith([RELEASE_TASK_ID]);
  const crashed = await startTask(
    { repository: fixture.repository, taskId: RELEASE_TASK_ID },
    {
      git: runGitCommand,
      now: tickingClock(),
      authPreflight: authPreflightPasses,
      lease: leaseFor(fixture.repository),
      replace: () => {
        throw new Error('simulated crash before the first durable write landed');
      },
    },
  );
  expect(crashed.outcome).toBe('STATE_NOT_RECORDED');
  releaseTestLeases();
  return fixture;
}

/* ─────────────────────────── the instrument itself ──────────────────────── */

describe('the fault reaches the release and nothing else', () => {
  it('does not fire on acquisition, so a run under it is a real run', async () => {
    const fixture = await repoWith(['A-001']);
    io.refuseLeaseDetach = true;

    // A refusal path: it acquires, refuses the input, then releases. If the
    // fault could fire on the acquisition the command would print a lease
    // refusal instead, and every case below would be measuring the wrong thing.
    await invokeBlock([
      '--repository', fixture.root,
      '--block', BLOCK_ID,
      '--tasks', 'GHOST-001',
      '--run', RUN_ID,
      '--attended',
    ]);

    // The refusal really is the block's own, reached under a lease this command
    // took: a fault that had fired on acquisition would have printed a lease
    // refusal and no plan reading at all.
    expect(out()).toContain('TASK_NOT_IN_GRAPH');
    expect(out()).toContain(REFUSED_DETACH);
    // Fired once and disarmed.
    expect(io.refuseLeaseDetach).toBe(false);
  }, 600_000);
});

describe('a release that throws does not become the failure the operator is shown', () => {
  it('keeps the original exception and reports the release refusal separately', async () => {
    // The one condition both commands' `finally` is wrapped against, produced
    // rather than argued: an operation under the lease throws, and the release
    // that follows it throws too. Without the guard the second exception
    // replaces the first inside the `finally`, and the operator is handed the
    // failure of the cleanup instead of the failure of the work.
    const fixture = await repoWith(['A-001']);

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
          // Armed here: acquisition names its staging file the same way, so an
          // earlier arming would refuse the lease instead of the release.
          io.refuseRandomBytes = true;
          throw new Error('the work failed first');
        },
      },
    );

    // Two lines, from two different failures. One line would mean one of them
    // had swallowed the other, and which one it would be is not a guess: without
    // the guard the `finally`'s exception replaces the pending one, so the
    // survivor would be the cleanup's failure and the work's would be gone.
    expect(err().trim().split('\n')).toHaveLength(2);
    expect(err()).toContain('giving the execution lease back failed');
    expect(err()).toContain('agent-loop block:');
    // Neither is quoted raw: both go through the safe formatter.
    expect(err()).not.toContain('no entropy');
    expect(err()).not.toContain('the work failed first');
    // The original failure keeps the exit code.
    expect(process.exitCode).toBe(EXIT_RUN_UNEXPECTED);
    // Nothing claims a release that did not happen...
    expect(out()).not.toContain('Release      : RELEASED');
    // ...and the absence of a claim is not the signal either. This is the one
    // case where the lease is provably still in the repository, so it is the
    // last place a missing line would be acceptable.
    expect(out()).toContain(`Release      : ${LEASE_RELEASE_UNREPORTED}`);
    expect(out()).toContain('Assume a lease record is still there');
  }, 600_000);
});

/* ──────────────────────────── `block --attended` ────────────────────────── */

describe('block --attended cannot exit nominal on a lease it did not give back', () => {
  it('keeps the block result whole and still refuses to exit 0', async () => {
    const fixture = await repoWith(['A-001', 'B-001']);
    const seams = drivingSeams();
    io.refuseLeaseDetach = true;

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

    const text = out();
    // The block really did complete, and the report still says so. A failed
    // release may not rewrite history into "the block failed".
    //
    // The whole outcome line, not the word: `COMPLETE` alone is a substring of
    // the per-task `TASK_COMPLETED`, and on this path the exit code is 3 whether
    // the block ended `COMPLETE` or `TASK_BLOCKED` - so a loose match here would
    // leave the property this case exists for pinned by nothing at all.
    expect(text).toContain('Outcome      : BLOCK_RUN_ENDED   reason COMPLETE');
    // And the second fact, beside it rather than instead of it.
    expect(text).toContain(`Release      : ${REFUSED_DETACH}`);
    expect(text).toContain(LEASE_RELEASE_SENTENCES.LEASE_REMOVE_FAILED);
    // Written out rather than read from the table, and that is the point: the
    // line above compares the output with the same constant the output was
    // built from, so exchanging two sentences in the table would satisfy it
    // while telling the operator the wrong thing about their repository.
    expect(text).toContain('The removal did not complete.');
    // And the token's own line, under it. The code sentence deliberately says
    // nothing about what is on disk, so without this line the report would name
    // a state and never say what it is.
    expect(text).toContain(LEASE_RELEASE_DETAIL_SENTENCES.DETACH_REFUSED);
    expect(text).toContain('Nothing was moved at all');
    // The one a script reads. Before V3-07 this was 0.
    expect(process.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
  }, 900_000);

  it('reports both facts when the block refused as well', async () => {
    const fixture = await repoWith(['A-001']);
    io.refuseLeaseDetach = true;

    await invokeBlock([
      '--repository', fixture.root,
      '--block', BLOCK_ID,
      '--tasks', 'A-001', 'GHOST-001',
      '--run', RUN_ID,
      '--attended',
    ]);

    // Neither erases the other: the input was unusable *and* the lease is stuck.
    expect(out()).toContain('TASK_NOT_IN_GRAPH');
    expect(out()).toContain(`Release      : ${REFUSED_DETACH}`);
    // The release condition decides the code, because it is the one that
    // outlives this invocation: the bad argument is gone when the operator
    // retypes it, and the record in the repository is not.
    expect(process.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
  }, 600_000);
});

describe('release --attended contains a throwing release too', () => {
  it('keeps the workspace verdict and reports that the release gave no answer', async () => {
    // The same property `block --attended` proves above, on the command that has
    // no seam. With the guard, the throw never leaves the `finally`: the
    // workspace verdict survives, the release is reported as unanswered, and the
    // exit code is the operator one. Without it, the throw escapes, the workspace
    // report is never printed and the exit code becomes 1 - so both halves of
    // this case bite.
    const fixture = await afterCrashedStart();
    io.armOnReadOf = `${RELEASE_TASK_ID}.md`;

    await invokeRelease([
      '--repository', fixture.root,
      '--task', RELEASE_TASK_ID,
      '--attended',
    ]);

    expect(out()).toContain('Outcome      : RELEASED');
    expect(out()).toContain(`Lease        : ${LEASE_RELEASE_UNREPORTED}`);
    expect(err()).toContain('giving the execution lease back failed');
    expect(err()).not.toContain('no entropy');
    expect(process.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
  }, 900_000);
});

/* ─────────────────────────── `release --attended` ───────────────────────── */

describe('release --attended cannot exit nominal on a lease it did not give back', () => {
  it('keeps the workspace verdict whole and still refuses to exit 0', async () => {
    const fixture = await afterCrashedStart();
    io.refuseLeaseDetach = true;

    await invokeRelease([
      '--repository', fixture.root,
      '--task', RELEASE_TASK_ID,
      '--attended',
    ]);

    const text = out();
    // The worktree really was removed. Saying otherwise would send an operator
    // looking for a directory that is gone.
    expect(text).toContain('Outcome      : RELEASED');
    expect(text).toContain('Worktree     : removed');
    // The execution lease, under its own label and its own verdict.
    expect(text).toContain(`Lease        : ${REFUSED_DETACH}`);
    expect(process.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
  }, 900_000);

  it('reports both facts when the workspace refused as well', async () => {
    const fixture = await repoWith(['A-001']);
    io.refuseLeaseDetach = true;

    await invokeRelease([
      '--repository', fixture.root,
      '--task', 'GHOST-001',
      '--attended',
    ]);

    expect(out()).toContain('Outcome      : TASK_UNKNOWN');
    expect(out()).toContain(`Lease        : ${REFUSED_DETACH}`);
    expect(process.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
  }, 600_000);
});
