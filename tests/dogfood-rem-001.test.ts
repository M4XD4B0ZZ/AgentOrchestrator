/**
 * DOGFOOD-REM-001 — the two defects the first dogfood run exposed.
 *
 * The run reported a delivered task and delivered nothing. Two causes, and
 * this file holds the controls for both as they land:
 *
 *  1. the writing agent had no authority to edit anything, because the
 *     argument vector never granted it — and no test pinned that vector, so
 *     the absence was invisible;
 *  2. a run with no effect could still settle as complete.
 *
 * The first is pinned here **as a whole**. `tests/claude-writer.test.ts`
 * asserts only that whatever `CLAUDE_WRITER_ARGS` holds is passed through to
 * the seam, which is true of an empty vector too. Pass-through is not
 * authority.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CLAUDE_WRITER_ARGS } from '../src/agent/claude-writer.js';
import { readClaudeResultEnvelope } from '../src/agent/internal/claude-result-envelope.js';
import { renderRunResult } from '../src/cli/render-attended-run.js';
import { isShellInertArgument } from '../src/doctor/exec.js';
import { runImplementStep } from '../src/loop/loop-step.js';
import { readExecutionBrief } from '../src/plan/task-brief.js';
import { runTask, type RunResult } from '../src/run/run-driver.js';
import {
  commitTaskWork,
  executableDriverKeysIn,
  type CommitTaskWorkResult,
} from '../src/worktree/commit-task-work.js';
import { runGitCommand } from '../src/worktree/git-command.js';
import {
  addsFile,
  authorOf,
  committerOf,
  configOf,
  configureCleanFilter,
  headOf,
  isSigned,
  pathsInCommit,
  porcelainOf,
  recordingGit,
  removeCommitFixtures,
  scratchWorktree,
  setupGit,
  subjectOf,
  touches,
  writeHook,
  writeIn,
} from './helpers/commit-fixtures.js';
import { passingReview } from './fixtures.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces } from './helpers/worktree-fixtures.js';
import {
  findingsReview,
  recordedAgent,
  recordedVerify,
  reviewResult,
  seedState,
  startTask,
  tickingClock,
  writerSuccess,
  writerThatEdits,
  type StartedTask,
} from './helpers/e2e-fixtures.js';

afterAll(() => {
  releaseTestLeases();
  removeTrackedWorkspaces();
  removeRepoFixtures();
  removeCommitFixtures();
});

describe('the writer is configured hermetically and can actually edit', () => {
  // Pinned as a whole. Today NO test pins the contents of this constant —
  // tests/claude-writer.test.ts asserts only that whatever it holds is passed
  // through — so any change to it is currently invisible. That is the gap.
  it('is exactly the measured vector for CLI 2.1.233', () => {
    expect([...CLAUDE_WRITER_ARGS]).toEqual([
      '--print',
      '--output-format',
      'json',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
      '--tools',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
    ]);
  });

  it('is expressible as argv at all', () => {
    for (const token of CLAUDE_WRITER_ARGS) {
      expect(isShellInertArgument(token)).toBe(true);
    }
  });

  // The authority ceiling, asserted as absence with a live mutant (G7): each of
  // these tokens would widen authority past what the payload asks for.
  it.each([
    'bypassPermissions',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--add-dir',
  ])('does not grant authority through %s', (forbidden) => {
    expect(CLAUDE_WRITER_ARGS).not.toContain(forbidden);
  });

  it('grants no shell and no git tool', () => {
    const toolsAt = CLAUDE_WRITER_ARGS.indexOf('--tools');
    expect(toolsAt).toBeGreaterThanOrEqual(0);
    const tools = CLAUDE_WRITER_ARGS.slice(toolsAt + 1);
    expect(tools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('PowerShell');
  });

  it('bounds MCP authority, which --tools does not', () => {
    // Measured: without this flag the writer held the operator's MCP tools and
    // attempted mcp__claude_ai_Gmail__list_labels.
    expect(CLAUDE_WRITER_ARGS).toContain('--strict-mcp-config');
  });

  it('takes its settings from no ambient source', () => {
    const at = CLAUDE_WRITER_ARGS.indexOf('--setting-sources');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(CLAUDE_WRITER_ARGS[at + 1]).toBe('');
    // --bare would also be hermetic and would break subscription auth: its help
    // says OAuth and the keychain are never read. Measured from the binary.
    expect(CLAUDE_WRITER_ARGS).not.toContain('--bare');
    // --safe-mode's documented and measured behaviour disagree on CLAUDE.md.
    expect(CLAUDE_WRITER_ARGS).not.toContain('--safe-mode');
  });
});

/* ══════════ 2. A refused write is observable without reading prose ═════════ */

/** The envelope the real CLI printed for the dogfood's root cause, measured. */
const refusedButSuccessful = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  api_error_status: null,
  num_turns: 3,
  result: 'I could not do it. I am blocked. Write permission was not granted.',
  permission_denials: [
    { tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: { file_path: 'C:\\wt\\a.ts' } },
    { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: { command: 'git add -A' } },
  ],
});

/** A `RunResult` carrying nothing but the observation under test. */
function runResultWithDenials(denials: { count: number; tools: readonly string[] }): RunResult {
  return Object.freeze({
    outcome: 'TASK_COMPLETED' as const,
    taskId: 'REM-001',
    state: 'READY_FOR_PR' as const,
    steps: 3,
    reasonCodes: Object.freeze([]),
    reconciliation: null,
    resume: null,
    lastStep: null,
    permissionDenials: Object.freeze({ ...denials, tools: Object.freeze([...denials.tools]) }),
  });
}

/** Dependencies with **real** Git, as the e2e suite runs them. */
function deps(overrides: Record<string, unknown> = {}) {
  return { now: tickingClock(), git: runGitCommand, ...overrides };
}

/** The request shape the transport scenarios run under: attended, proven, bounded. */
function request(started: StartedTask) {
  return {
    repository: started.repository,
    taskId: started.taskId,
    taskBrief: 'Make the writer authority observable.',
    attendedContinuation: true,
    authEvidence: provenAuthEvidence(),
    lease: leaseFor(started.repository),
    maxSteps: 8,
  };
}

describe('a refused write is observable without reading prose', () => {
  it('reports the denials as structure', () => {
    const reading = readClaudeResultEnvelope(refusedButSuccessful);
    expect(reading.permissionDenials).toEqual({ count: 2, tools: ['Write', 'Bash'] });
  });

  // G6: denials are evidence, not a verdict. The CLI said the turn completed and
  // that remains what the verdict reports; whether the PASS was real is decided
  // by the measured delta in Task 3, not here.
  it('does not turn denials into a failed verdict', () => {
    expect(readClaudeResultEnvelope(refusedButSuccessful).verdict).toBe('COMPLETED');
  });

  it('reports no denials when the field is absent, and does not invent any', () => {
    const clean = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
    });
    expect(readClaudeResultEnvelope(clean).permissionDenials).toEqual({ count: 0, tools: [] });
  });

  // A foreign document must not be able to put free text into our observation.
  it('takes only string tool names, and nothing else from the entries', () => {
    const hostile = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      permission_denials: [
        { tool_name: 42 },
        { tool_name: 'Write', tool_input: { secret: 'sk-live-x' } },
        'nonsense',
      ],
    });
    const reading = readClaudeResultEnvelope(hostile);
    expect(reading.permissionDenials.tools).toEqual(['Write']);
    expect(JSON.stringify(reading)).not.toContain('sk-live-x');
  });

  // Printing, proven at the renderer. This is a unit control on the FORM only —
  // it feeds a hand-built RunResult and therefore proves nothing about whether a
  // real run ever puts the observation there. The transport control below is the
  // load-bearing one.
  it('prints the observation it is given: count and tool names, nothing else', () => {
    const rendered = renderRunResult(runResultWithDenials({ count: 2, tools: ['Write', 'Bash'] }));

    expect(rendered).toContain('2');
    expect(rendered).toContain('Write');
    expect(rendered).toContain('Bash');
    // Evidence, not prose: no tool_input, no agent sentence, ever.
    expect(rendered).not.toContain('C:\\wt\\a.ts');
    expect(rendered).not.toContain('git add -A');
  });

  it('says nothing about denials when there were none', () => {
    // The closest legitimate variant: a clean run must not gain a noise line.
    const rendered = renderRunResult(runResultWithDenials({ count: 0, tools: [] }));
    expect(rendered).not.toMatch(/denial/i);
  });

  // THE transport control. It must outlive the writer step, because the
  // successful case is exactly the one where the run does not stop there.
  //
  // The premise is asserted as "the run did not stop on the writer step", not as
  // a terminal state: an editing writer leaves the worktree dirty, and
  // `READY_FOR_PR` demands a settled tree that nothing commits yet. Task 3 is
  // what makes this same run settle; until then it walks implement → verify →
  // review and parks. Either way the writer step is three steps behind the end,
  // which is the whole point — a per-step carrier loses the observation exactly
  // here.
  it('survives every later step of a real run and still reaches the operator', async () => {
    const started = await startTask({ taskId: 'REM-001-T' });
    seedState(started, { state: 'IMPLEMENTING' });

    const verify = recordedVerify();
    const agent = recordedAgent({
      // A writer that really edits AND reports a denial it did not need.
      claude: writerThatEdits('src/work.ts', '// work\n', { permissionDenials: ['Bash'] }),
      codex: () => reviewResult(passingReview()),
    });

    const run = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    // The premise. Without these the case could pass by accidentally stopping on
    // the writer step — which is the shape a per-step carrier would also survive.
    expect(run.steps).toBe(3);
    expect(run.lastStep?.state).not.toBe('VERIFYING');
    expect(agent.countFor('claude')).toBe(1);
    expect(agent.countFor('codex')).toBe(1);

    const rendered = renderRunResult(run);
    expect(rendered).toContain('Bash');
  });

  it('accumulates across rounds instead of keeping only the last', async () => {
    // Round 1 denied, round 2 clean. Last-writer-wins would erase round 1.
    const started = await startTask({ taskId: 'REM-001-U' });
    seedState(started, { state: 'IMPLEMENTING' });

    const verify = recordedVerify();
    const agent = recordedAgent({
      claude: (call) =>
        call.index === 0
          ? writerThatEdits('src/a.ts', '// a\n', { permissionDenials: ['Bash'] })(call)
          : writerThatEdits('src/b.ts', '// b\n', { permissionDenials: [] })(call),
      codex: (call) =>
        reviewResult(call.index === 0 ? findingsReview('src/a.ts') : passingReview()),
    });

    const run = await runTask(
      request(started),
      deps({ verify: verify.runner, agent: agent.runner }),
    );

    // The premise: a second writing pass really happened, and it was clean.
    expect(agent.countFor('claude')).toBe(2);

    const rendered = renderRunResult(run);
    expect(rendered).toContain('Bash');
  });

  it('is not a prose matcher', () => {
    // The closest legitimate variant: a run that genuinely completed while its
    // answer happens to quote the words of a refusal — e.g. a writer editing
    // this very plan. It must read as COMPLETED with zero denials.
    const quoting = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      api_error_status: null,
      result: 'I added a test asserting the text "permission had not been granted".',
      permission_denials: [],
    });
    const reading = readClaudeResultEnvelope(quoting);
    expect(reading.verdict).toBe('COMPLETED');
    expect(reading.permissionDenials.count).toBe(0);
  });
});

/* ════════════════ 3. The orchestrator owns the commit ══════════════════════ */

/**
 * One request shape, so no case can pass by quietly omitting `approvedPaths`.
 *
 * It is a required parameter in production for a reason a default would defeat:
 * a path set derived *inside* the commit module would be measured after any
 * injection and would therefore agree with it. A helper that let a case forget
 * it would re-open exactly that hole in the test suite.
 */
function commitRequest(
  base: string,
  approvedPaths: readonly string[],
  overrides: { readonly taskId?: string; readonly round?: number } = {},
) {
  return {
    taskId: overrides.taskId ?? 'T-1',
    phase: 'IMPLEMENT' as const,
    round: overrides.round ?? 1,
    approvedPaths,
    basePinnedCommit: base,
  };
}

/** Narrows to the member carrying a commit, failing loudly rather than casting. */
function committedCommit(result: CommitTaskWorkResult): string {
  if (result.outcome !== 'COMMITTED' && result.outcome !== 'COMMITTED_BEYOND_APPROVED_SCOPE') {
    throw new Error(`expected a commit, got ${result.outcome}`);
  }
  return result.commit;
}

describe('the orchestrator commits the writer’s work', () => {
  it('refuses to commit when the writer changed nothing, and invents no empty commit', async () => {
    const { worktreePath, head } = scratchWorktree();

    const result = await commitTaskWork(runGitCommand, worktreePath, commitRequest(head, []));

    expect(result.outcome).toBe('NOTHING_TO_COMMIT');
    expect(headOf(worktreePath)).toBe(head); // no --allow-empty, ever
  });

  it('commits a real edit and leaves the tree clean', async () => {
    const { worktreePath, head } = scratchWorktree();
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['src/work.ts']),
    );

    expect(result.outcome).toBe('COMMITTED');
    expect(committedCommit(result)).not.toBe(head);
    expect(headOf(worktreePath)).toBe(committedCommit(result));
    expect(porcelainOf(worktreePath)).toBe('');
  });

  it('writes a message it authored itself, carrying no agent text', async () => {
    const { worktreePath, head } = scratchWorktree();
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['src/work.ts'], { round: 2 }),
    );
    const subject = subjectOf(worktreePath, committedCommit(result));

    expect(subject).toContain('T-1');
    expect(subject).toContain('r2');
    // Deterministic, ASCII, no transcript — and shell-inert, because -m takes
    // one argument and SAFE_ARG_PATTERN excludes the space (G11). A message
    // built as a sentence would return REFUSED_UNSAFE_ARGUMENT, not a commit.
    expect(isShellInertArgument(subject)).toBe(true);
  });

  it('refuses a task id it could not express as one argument, and commits nothing', async () => {
    const { worktreePath, head } = scratchWorktree();
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['src/work.ts'], { taskId: 'T 1; rm -rf /' }),
    );

    expect(result.outcome).toBe('REFUSED_UNSAFE_ARGUMENT');
    expect(headOf(worktreePath)).toBe(head);
  });
});

// G12 control one. It covers path-ADDING injection by any mechanism, known or
// not — and nothing else. A driver that rewrites an approved file's bytes leaves
// this set identical; that is control two's case, below, and the two are not
// interchangeable.
describe('the commit contains exactly the paths the scope gate approved', () => {
  it('commits only the approved paths when the repository tries to add one', async () => {
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    // The hook is the *sample* mechanism, not the property under test.
    writeHook(worktreePath, 'pre-commit', addsFile('forbidden/config.ts'));
    writeHook(worktreePath, 'post-commit', touches('.ao-sentinel'));
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['src/work.ts']),
    );

    expect(result.outcome).toBe('COMMITTED');
    expect(pathsInCommit(worktreePath, head, committedCommit(result))).toEqual(['src/work.ts']);
    expect(existsSync(join(worktreePath, 'forbidden', 'config.ts'))).toBe(false);
    expect(existsSync(join(worktreePath, '.ao-sentinel'))).toBe(false); // post-commit too
  });

  // The mechanism-independent half: the guard must fire even when nothing was
  // neutralised, because the enumeration will one day be incomplete.
  it('refuses, parks and does not undo when the committed set is not the approved set', async () => {
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    writeIn(worktreePath, 'src/work.ts', '// work\n');
    writeIn(worktreePath, 'forbidden/config.ts', '// injected\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['src/work.ts']),
    );

    expect(result.outcome).toBe('COMMITTED_BEYOND_APPROVED_SCOPE');
    if (result.outcome !== 'COMMITTED_BEYOND_APPROVED_SCOPE') return;
    expect(result.unapprovedPaths).toEqual(['forbidden/config.ts']);
    // The commit object stays. A rollback is an effect too, and the operator
    // needs the artefact to see what happened.
    expect(headOf(worktreePath)).toBe(result.commit);
  });

  // Control two (G12). The path-set check cannot see this case: the filter runs,
  // the blob is not the approved bytes, a sentinel lands outside the object, and
  // the committed path set is still exactly { src/work.ts }.
  it('refuses to commit into a repository that has configured an executable driver', async () => {
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    writeIn(worktreePath, '.gitattributes', '* -text\nsrc/work.ts filter=probe\n');
    configureCleanFilter(worktreePath);
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['.gitattributes', 'src/work.ts']),
    );

    expect(result.outcome).toBe('TARGET_CONFIG_EXECUTES_CODE');
    if (result.outcome !== 'TARGET_CONFIG_EXECUTES_CODE') return;
    expect(result.findings).toEqual([{ key: 'filter.probe.clean', scope: 'local' }]);
    expect(headOf(worktreePath)).toBe(head); // nothing committed
    expect(existsSync(join(worktreePath, '.filter-ran'))).toBe(false); // and it never ran
  });

  // The predicate is path-scoped, and this is the case that proves it. Every
  // machine with Git LFS has filter.lfs.* configured in system scope; a blanket
  // refusal would park every commit in every repository, measured on
  // git 2.55.0.windows.3. A configured driver that claims none of the approved
  // paths is not this task's business.
  it('commits when a configured driver applies to no approved path', async () => {
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    configureCleanFilter(worktreePath);
    writeIn(worktreePath, '.gitattributes', '* -text\nassets/*.bin filter=probe\n');
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['.gitattributes', 'src/work.ts']),
    );

    expect(result.outcome).toBe('COMMITTED');
    expect(existsSync(join(worktreePath, '.filter-ran'))).toBe(false);
  });

  // A driver Git honours that a --local scan cannot see. Two scratch-creatable
  // shapes; neither mutates this machine's configuration.
  it('refuses a driver configured in the worktree scope, not only in .git/config', async () => {
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    setupGit(worktreePath, ['config', 'extensions.worktreeConfig', 'true']);
    configureCleanFilter(worktreePath, 'probe', 'worktree');
    writeIn(worktreePath, '.gitattributes', '* -text\nsrc/work.ts filter=probe\n');
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['.gitattributes', 'src/work.ts']),
    );

    expect(result.outcome).toBe('TARGET_CONFIG_EXECUTES_CODE');
    if (result.outcome !== 'TARGET_CONFIG_EXECUTES_CODE') return;
    // The scope must survive as far as the result, not only as far as the
    // parser. This is the assertion that kills a production path which reads
    // the scope and then reports keys alone.
    expect(result.findings).toEqual([{ key: 'filter.probe.clean', scope: 'worktree' }]);
    expect(headOf(worktreePath)).toBe(head);
    expect(existsSync(join(worktreePath, '.filter-ran'))).toBe(false);
  });

  it('refuses a driver reached through include, which Git resolves and we do not', async () => {
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    // Relative include paths resolve against the directory of the config file
    // that names them — `.git/`, not the worktree root. Measured.
    writeIn(
      worktreePath,
      '.git/extra.cfg',
      '[filter "probe"]\n\tclean = sh -c "echo ran > .filter-ran; sed s/BASE/MANGLED/"\n',
    );
    setupGit(worktreePath, ['config', 'include.path', 'extra.cfg']);
    writeIn(worktreePath, '.gitattributes', '* -text\nsrc/work.ts filter=probe\n');
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['.gitattributes', 'src/work.ts']),
    );

    expect(result.outcome).toBe('TARGET_CONFIG_EXECUTES_CODE');
    if (result.outcome !== 'TARGET_CONFIG_EXECUTES_CODE') return;
    expect(result.findings).toEqual([{ key: 'filter.probe.clean', scope: 'local' }]);
  });

  // System scope cannot be exercised without mutating this machine, which is
  // forbidden. It is covered where it can be: the parser, fed Git's OWN measured
  // byte format. Pure and cheap, and it pins that the reader keys on the key
  // rather than on the scope label.
  it('refuses a system-scope driver, reading Git’s measured --name-only -z format', () => {
    // Measured, git 2.55.0.windows.3:  scope\0key\0scope\0key\0…
    // No value appears in this stream at all — see the argv assertion below.
    const listing = ['system', 'filter.probe.clean', 'local', 'core.bare'].join('\0') + '\0';
    expect(executableDriverKeysIn(listing)).toEqual([
      { key: 'filter.probe.clean', scope: 'system' },
    ]);
  });

  it('never asks Git for the configured values in the first place', async () => {
    // Stronger than filtering a value out after receiving it: with --name-only
    // the attacker-chosen command never enters this process. Asserted on the
    // argv the module builds, because that is where the property lives.
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    writeIn(worktreePath, 'src/work.ts', '// work\n');
    const git = recordingGit(runGitCommand);

    await commitTaskWork(git.runner, worktreePath, commitRequest(head, ['src/work.ts']));

    const configRead = git.calls.find((call) => call.args[0] === 'config');
    expect(configRead?.args).toEqual(['config', '--list', '--show-scope', '--name-only', '-z']);
  });

  // The commit invocation itself, asserted as argv.
  //
  // Three of these properties are only observable here. `--allow-empty` is
  // unreachable behind the effect gate, so its absence cannot be shown by any
  // outcome — a run with the flag added behaves identically. `--no-verify` was
  // measured insufficient (prepare-commit-msg and post-commit still ran), so its
  // presence would be a false comfort rather than a visible failure. And an
  // empty `core.hooksPath` produces the same result as a *relative* one right
  // up until the writer creates that directory, which no green test would show.
  it('asks Git for exactly the commit it decided to make', async () => {
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    writeIn(worktreePath, 'src/work.ts', '// work\n');
    const git = recordingGit(runGitCommand);

    await commitTaskWork(git.runner, worktreePath, commitRequest(head, ['src/work.ts']));

    const commit = git.calls.find((call) => call.args.includes('commit'));
    expect(commit?.args).toEqual([
      '-c', 'user.name=AgentOrchestrator',
      '-c', 'user.email=agent-orchestrator@local.invalid',
      '-c', 'core.hooksPath=',
      '-c', 'commit.gpgSign=false',
      'commit', '-m', 'AO:T-1:IMPLEMENT:r1',
    ]);
    // Never, on any path: an empty commit would move HEAD and satisfy every
    // "did anything happen?" rule without anything having happened.
    expect(commit?.args).not.toContain('--allow-empty');
    // Measured insufficient, so it is not carried as if it helped.
    expect(commit?.args).not.toContain('--no-verify');
  });

  // The closest legitimate variant, or the refusal is just a repo-shape allergy:
  // .gitattributes on its own configures no driver and must not block anything.
  it('commits normally when .gitattributes names a driver the config never defines', async () => {
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    writeIn(worktreePath, '.gitattributes', '* -text\nsrc/work.ts filter=undefined-driver\n');
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['.gitattributes', 'src/work.ts']),
    );

    expect(result.outcome).toBe('COMMITTED');
  });

  it('commits deterministically in a repository that demands signing', async () => {
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    setupGit(worktreePath, ['config', 'commit.gpgSign', 'true']);
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['src/work.ts']),
    );

    expect(result.outcome).toBe('COMMITTED');
    expect(isSigned(worktreePath, committedCommit(result))).toBe(false);
  });
});

// G11, and it is a pair: the identity must be supplied, and nothing else's
// identity may reach the commit.
describe('the commit carries the orchestrator’s own identity', () => {
  it('commits in a repository that has no git identity configured at all', async () => {
    // The counter-control. scratchWorktree() must NOT set user.name/user.email
    // for this case — a helper that quietly configures an identity would make
    // every assertion below vacuous, so assert the absence first.
    const { worktreePath, head } = scratchWorktree({ identity: 'none' });
    expect(configOf(worktreePath, 'user.email')).toBeNull();
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['src/work.ts']),
    );

    expect(result.outcome).toBe('COMMITTED');
    const commit = committedCommit(result);
    expect(authorOf(worktreePath, commit)).toEqual({
      name: 'AgentOrchestrator',
      email: 'agent-orchestrator@local.invalid',
    });
    expect(committerOf(worktreePath, commit)).toEqual({
      name: 'AgentOrchestrator',
      email: 'agent-orchestrator@local.invalid',
    });
  });

  it('does not let a foreign identity in the target repository leak into the commit', async () => {
    // Measured, and this is why the case is load-bearing rather than decorative:
    // the seam forwards PATH/PATHEXT only, and Git STILL reads the operator's
    // global ~/.gitconfig through it. Without -c, this commit is authored by
    // whoever is logged in.
    const { worktreePath, head } = scratchWorktree({ identity: 'foreign' });
    writeIn(worktreePath, 'src/work.ts', '// work\n');

    const result = await commitTaskWork(
      runGitCommand,
      worktreePath,
      commitRequest(head, ['src/work.ts']),
    );

    const author = authorOf(worktreePath, committedCommit(result));
    expect(author.name).toBe('AgentOrchestrator');
    expect(author.email).toBe('agent-orchestrator@local.invalid');
    // And the repository's own configuration is left exactly as it was found:
    // AO supplies identity, it does not install one.
    expect(configOf(worktreePath, 'user.email')).toBe('somebody@example.com');
  });
});

describe('a writer pass with no measured effect is not a success', () => {
  /** A task seeded at `IMPLEMENTING`, over a real repository and a real worktree. */
  async function atImplementing(taskId: string) {
    const started = await startTask({ taskId });
    const current = seedState(started, { state: 'IMPLEMENTING' });
    return { started, current, worktreePath: started.workspace.worktreePath };
  }

  function stepDeps(started: StartedTask, agent: ReturnType<typeof recordedAgent>) {
    return {
      now: '2026-08-15T10:00:00.000Z',
      authorisedWorktreePath: started.workspace.worktreePath,
      verification: started.repository.verification,
      taskBrief: 'Make the writer’s effect real.',
      brief: readExecutionBrief(started.repository, started.taskId, started.workspace.worktreePath),
      git: runGitCommand,
      agent: agent.runner,
      lease: { repository: started.repository, evidence: leaseFor(started.repository) },
    };
  }

  it('does not reach VERIFYING when the writer changed nothing', async () => {
    const { started, current, worktreePath } = await atImplementing('REM-001-N');
    const base = headOf(worktreePath);
    const agent = recordedAgent({ claude: () => writerSuccess() }); // edits nothing

    const step = await runImplementStep(current, stepDeps(started, agent));

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(step.commit?.outcome).toBe('NOTHING_TO_COMMIT');
    expect(headOf(worktreePath)).toBe(base);
  });

  it('reaches VERIFYING when the writer really edited, and AO committed it', async () => {
    const { started, current, worktreePath } = await atImplementing('REM-001-E');
    const base = headOf(worktreePath);
    const agent = recordedAgent({ claude: writerThatEdits('src/work.ts', '// work\n') });

    const step = await runImplementStep(current, stepDeps(started, agent));

    expect(step.outcome).toBe('ADVANCED');
    expect(step.state).toBe('VERIFYING');
    expect(step.commit?.outcome).toBe('COMMITTED');
    expect(headOf(worktreePath)).not.toBe(base);
    // The writer edits; AO commits; the tree it leaves behind is clean.
    expect(porcelainOf(worktreePath)).toBe('');
    expect(authorOf(worktreePath, headOf(worktreePath)).name).toBe('AgentOrchestrator');
  });

  // The order is the safety property, not an implementation detail.
  it('does not commit a change the scope guard refuses', async () => {
    const { started, current, worktreePath } = await atImplementing('REM-001-S');
    const base = headOf(worktreePath);
    const agent = recordedAgent({ claude: writerThatEdits('forbidden/x.ts', '// nope\n') });

    const step = await runImplementStep(current, stepDeps(started, agent));

    expect(step.state).toBe('SCOPE_VIOLATION');
    expect(step.commit).toBeNull(); // the commit was never attempted
    expect(headOf(worktreePath)).toBe(base); // nothing was committed
  });
});
