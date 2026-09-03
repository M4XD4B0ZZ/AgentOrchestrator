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

import { CLAUDE_WRITER_ARGS, claudeWriterArgs } from '../src/agent/claude-writer.js';
import { readClaudeResultStream } from '../src/agent/internal/claude-result-stream.js';
import { renderRunResult } from '../src/cli/render-attended-run.js';
import { isShellInertArgument } from '../src/doctor/exec.js';
import { buildReviewPayload } from '../src/loop/findings.js';
import { runImplementStep, runReviewStep } from '../src/loop/loop-step.js';
import { readExecutionBrief, type ExecutionBrief } from '../src/plan/task-brief.js';
import { runTask, type RunResult } from '../src/run/run-driver.js';
import {
  commitTaskWork,
  executableDriverKeysIn,
  type CommitTaskWorkResult,
} from '../src/worktree/commit-task-work.js';
import { classifyAncestry } from '../src/worktree/commit-probes.js';
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
import { claudeResultStream, passingReview } from './fixtures.js';
import { provenAuthEvidence } from './helpers/auth-evidence.js';
import { leaseFor, releaseTestLeases } from './helpers/lease.js';
import { removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces } from './helpers/worktree-fixtures.js';
import {
  findingsReview,
  recordedAgent,
  recordedVerify,
  reviewResult,
  reload,
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
  it('is exactly the measured vector, at CLI 2.1.239', () => {
    expect([...CLAUDE_WRITER_ARGS]).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
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

  // The ceiling has had two shapes since M5: with a capability granted and
  // without. Every absence asserted above is asserted for BOTH in
  // `m5-01-trusted-mcp-capability.test.ts`, because a ceiling that held for one
  // producer and not the other would be no ceiling at all.
  it('is what the argv builder produces when nothing is granted', () => {
    expect(claudeWriterArgs(null)).toEqual([...CLAUDE_WRITER_ARGS]);
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

/**
 * The envelope the real CLI printed for the dogfood's root cause, measured —
 * now carried inside the JSONL stream the writer has read since V3-11, so these
 * cases exercise the transport layer instead of bypassing it.
 */
const refusedButSuccessful = claudeResultStream({
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
    remediatedVerifyFailure: false,
    continuedUsageLimit: false,
    usageLimitContinuation: null,
    continuedHumanDecision: false,
    reconciliation: null,
    resume: null,
    lastStep: null,
    permissionDenials: Object.freeze({ ...denials, tools: Object.freeze([...denials.tools]) }),
  });
}

/** Distinct task ids, so two payload fixtures never share a workspace. */
let payloadCase = 0;

/** Dependencies with **real** Git, as the e2e suite runs them. */
function deps(overrides: Record<string, unknown> = {}) {
  return { now: tickingClock(), git: runGitCommand, ...overrides };
}

/** The request shape the transport scenarios run under: attended, proven, bounded. */
function request(started: StartedTask) {
  return {
    repository: started.repository,
    taskId: started.taskId,
    continuationGrant: 'ATTENDED' as const,
    authEvidence: provenAuthEvidence(),
    writerMcp: null,
    lease: leaseFor(started.repository),
    maxSteps: 8,
  };
}

describe('a refused write is observable without reading prose', () => {
  it('reports the denials as structure', () => {
    const reading = readClaudeResultStream(refusedButSuccessful);
    expect(reading.permissionDenials).toEqual({ count: 2, tools: ['Write', 'Bash'] });
  });

  // G6: denials are evidence, not a verdict. The CLI said the turn completed and
  // that remains what the verdict reports; whether the PASS was real is decided
  // by the measured delta in Task 3, not here.
  it('does not turn denials into a failed verdict', () => {
    expect(readClaudeResultStream(refusedButSuccessful).verdict).toBe('COMPLETED');
  });

  it('reports no denials when the field is absent, and does not invent any', () => {
    const clean = claudeResultStream();
    expect(readClaudeResultStream(clean).permissionDenials).toEqual({ count: 0, tools: [] });
  });

  // A foreign document must not be able to put free text into our observation.
  it('takes only string tool names, and nothing else from the entries', () => {
    const hostile = claudeResultStream({
      permission_denials: [
        { tool_name: 42 },
        { tool_name: 'Write', tool_input: { secret: 'sk-live-x' } },
        'nonsense',
      ],
    });
    const reading = readClaudeResultStream(hostile);
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
    const quoting = claudeResultStream({
      result: 'I added a test asserting the text "permission had not been granted".',
      permission_denials: [],
    });
    const reading = readClaudeResultStream(quoting);
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

/* ═══════════ 3b. The reviewer is told what the task requires ═══════════════ */

describe('the reviewer is told what the task requires', () => {
  /**
   * The payload a real review step really built, captured at the seam.
   *
   * Expensive — a real repository, a real worktree, a real step — so it is paid
   * for **once**, by the case that needs it: the defect was never that the
   * builder was wrong, it was that the step handed it nothing but an id, and
   * only a real step can show that it now hands over the repository's own
   * account of the task. Every other property below is a property of the
   * builder, which is a pure function and is called as one.
   */
  async function reviewPayloadFromRealStep(body: string): Promise<string> {
    const taskId = `REM-001-RV${payloadCase++}`;
    const started = await startTask({
      taskId,
      files: {
        [`tasks/${taskId}.md`]: [
          '---',
          `id: ${taskId}`,
          `title: task ${taskId}`,
          'status: OPEN',
          'kind: NORMAL',
          'priority: NORMAL',
          'currentFocus: true',
          'dependsOn: []',
          '---',
          '',
          body,
          '',
        ].join('\n'),
        'README.md': '# fixture\n\nCANARY-README-BODY\n',
      },
    });
    const current = seedState(started, { state: 'REVIEWING', reviewRound: 0 });
    const agent = recordedAgent({ codex: () => reviewResult(passingReview()) });

    await runReviewStep(current, { writerMcp: null,
      now: '2026-08-16T10:00:00.000Z',
      authorisedWorktreePath: started.workspace.worktreePath,
      verification: started.repository.verification,
      brief: readExecutionBrief(started.repository, taskId, started.workspace.worktreePath),
      git: runGitCommand,
      agent: agent.runner,
      lease: { repository: started.repository, evidence: leaseFor(started.repository) },
    });

    const payload = agent.calls.find((call) => call.agent === 'codex')?.payload;
    if (payload === undefined) throw new Error('the reviewer was never started');
    return payload;
  }

  /** A brief as `readExecutionBrief` produces one, for the pure cases. */
  function briefFor(overrides: Partial<ExecutionBrief> = {}): ExecutionBrief {
    return {
      taskId: 'REM-001-RV',
      body: 'Add a widget. ACCEPTANCE: src/widget.ts exports createWidget.',
      bodyTruncated: false,
      contextSources: [],
      contextComplete: true,
      ...overrides,
    };
  }

  // THE transport control, and the only one here that pays for a real run: the
  // reviewer is handed the repository's own account of the task rather than its
  // id. It also pins that a declared context source appears as a **path** with
  // its contents left in the worktree.
  it('hands the reviewer the repository’s own account of the task', async () => {
    const payload = await reviewPayloadFromRealStep(
      'Add a widget. ACCEPTANCE: src/widget.ts exports createWidget.',
    );

    expect(payload).toContain('src/widget.ts exports createWidget');
    // Non-vacuous by construction: the canary is real text in a real file the
    // brief had a path to.
    //
    // Where the guarantee actually lives, measured: the builder cannot leak a
    // file's contents even if it wanted to, because `ContextSourceReport` gives
    // it a repository-relative path and a status and no root to resolve them
    // against. A mutant pasting contents *in the builder* stays green — it
    // reads the wrong file. The mutant that reddens this is in `task-brief.ts`,
    // which is the component that does hold the bytes.
    expect(payload).toContain('README.md');
    expect(payload).not.toContain('CANARY-README-BODY');
  });

  // The rest are properties of a pure builder, asserted on the builder. The
  // control asserts on the constructed PAYLOAD, not on a verdict: the product's
  // obligation is to hand over the discriminating semantics, and a scripted
  // agent's verdict is whatever the fixture says and asserts nothing.
  it('gives two tasks with the same diff materially different payloads', () => {
    const a = buildReviewPayload(
      briefFor({ body: 'Add a widget. ACCEPTANCE: src/widget.ts exports createWidget.' }),
      1,
    );
    const b = buildReviewPayload(
      briefFor({ body: 'Document the widget. ACCEPTANCE: README gains a Widget section.' }),
      1,
    );

    expect(a).not.toBe(b);
    expect(a).toContain('src/widget.ts exports createWidget');
    expect(a).not.toContain('README gains a Widget section');
    expect(b).toContain('README gains a Widget section');
    expect(b).not.toContain('src/widget.ts exports createWidget');
  });

  it('tells the reviewer which round it is', () => {
    expect(buildReviewPayload(briefFor(), 3)).toContain('round 3');
  });

  it('asks whether the tree satisfies the task, not only what it broke', () => {
    // Without this the round-3 PASS recurs: an empty diff introduces no defects.
    expect(buildReviewPayload(briefFor(), 1)).toMatch(/satisf/i);
  });

  it('says so when the body was truncated', () => {
    expect(buildReviewPayload(briefFor({ bodyTruncated: true }), 1)).toMatch(/truncat/i);
  });

  it('parks rather than degrading when the brief is unavailable', async () => {
    const started = await startTask({ taskId: 'REM-001-RVX' });
    const current = seedState(started, { state: 'REVIEWING', reviewRound: 0 });
    const agent = recordedAgent({});

    const step = await runReviewStep(current, { writerMcp: null,
      now: '2026-08-16T10:00:00.000Z',
      authorisedWorktreePath: started.workspace.worktreePath,
      verification: started.repository.verification,
      // No brief at all: the caller failed to read one.
      git: runGitCommand,
      agent: agent.runner,
      lease: { repository: started.repository, evidence: leaseFor(started.repository) },
    });

    expect(step.outcome).toBe('BLOCKED');
    expect(step.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(agent.countFor('codex')).toBe(0); // the reviewer was never started
  });
});

/* ════ 3c. A step budget does not cost the remediation its detail ═══════════ */

describe('a step-budget boundary does not cost the remediation its detail', () => {
  /**
   * Drives one task from `REVIEWING` under `maxSteps` and returns the
   * instructions the writer was actually handed.
   *
   * The review reports a finding naming a real path and a real rule. Those two
   * strings are the only actionable content a review produces — the durable
   * record keeps `{round, severity, fingerprint}` and fingerprints are one-way
   * — so whether they reach the writer is the whole question.
   */
  async function remediationPayloadWith(options: {
    readonly maxSteps: number;
  }): Promise<{ payload: string; steps: number }> {
    const taskId = `REM-001-BD${payloadCase++}`;
    const started = await startTask({ taskId });
    seedState(started, { state: 'REVIEWING', reviewRound: 0 });
    const agent = recordedAgent({
      codex: () => reviewResult(findingsReview('src/named.ts', 'e2e.named')),
      claude: writerThatEdits('src/named.ts', '// fixed\n'),
    });

    let steps = 0;
    // Re-entered the way `block --attended` does, so the boundary is crossed by
    // a real second call rather than simulated inside one. Two calls are the
    // most that can be needed: the call that produces the brief is the call
    // that discharges it.
    for (let call = 0; call < 2; call += 1) {
      const run = await runTask(
        { ...request(started), maxSteps: options.maxSteps },
        deps({ verify: recordedVerify().runner, agent: agent.runner }),
      );
      steps += run.steps;
      if (agent.countFor('claude') > 0 || run.steps === 0) break;
    }

    const payload = agent.calls.find((call) => call.agent === 'claude')?.payload;
    if (payload === undefined) throw new Error('the writer was never briefed');
    return { payload, steps };
  }

  // One case, two properties, two fixtures — merged deliberately (G8). Each
  // half needs a real repository driven through a real review, and split they
  // paid for three of them to assert two things about one string.
  it('hands the writer the same actionable finding across the boundary, byte for byte', async () => {
    // maxSteps: 1 from REVIEWING puts the boundary exactly at the problematic
    // edge, with no timing dependence: the review step is the whole budget.
    const crossed = await remediationPayloadWith({ maxSteps: 1 });

    expect(crossed.payload).toContain('src/named.ts');
    expect(crossed.payload).toContain('e2e.named');
    expect(crossed.payload).not.toContain('did not survive');
    // The overrun is bounded at one: the extra iteration discharges an
    // obligation it then clears, so it cannot recur.
    expect(crossed.steps).toBeLessThanOrEqual(3);

    // Specificity: without this half, a fix that ALWAYS degrades passes the
    // assertions above. `buildRemediationPayload` is documented deterministic,
    // so byte equality against a run that never met the boundary is the
    // strongest available assertion.
    const uncrossed = await remediationPayloadWith({ maxSteps: 4 });
    expect(crossed.payload).toBe(uncrossed.payload);
  });
});

/* ═══════ 4. READY_FOR_PR refuses a task that delivered nothing ═════════════ */

describe('a task that delivered nothing does not reach READY_FOR_PR', () => {
  // ── Where the stale-record TOCTOU is actually closed, measured ───────────
  //
  // This case was designed to drive the settlement predicate with a record
  // claiming a commit the worktree does not have. It never reaches it: the run
  // stops at reconciliation with `CURRENT_COMMIT_MOVED`, 0 steps, before any
  // loop step is dispatched.
  //
  // That is kept as the finding rather than smoothed away. The guarantee
  // belongs to `src/state/reconcile.ts`, not to the conjunct in
  // `runReviewStep`, and attributing it to the wrong line is how the empty-delta
  // defect survived review the first time. The conjunct's own discriminating
  // fixture is the case below, which reconciliation does admit.
  it('never reaches the settlement gate at all when the record names a commit the worktree lost', async () => {
    const started = await startTask({ taskId: 'REM-001-STALE' });
    const worktreePath = started.workspace.worktreePath;
    const base = started.workspace.basePinnedCommit;

    // A real commit object, then the worktree is put back where it was: HEAD is
    // BASE and clean, while the record still names the descendant. This is the
    // stale-record shape a crash between commit and write produces.
    writeIn(worktreePath, 'src/stale.ts', '// stale\n');
    const stale = await commitTaskWork(runGitCommand, worktreePath, {
      taskId: 'REM-001-STALE',
      phase: 'IMPLEMENT',
      round: 1,
      approvedPaths: ['src/stale.ts'],
      basePinnedCommit: base,
    });
    expect(stale.outcome).toBe('COMMITTED');
    setupGit(worktreePath, ['reset', '--hard', base]);

    const current = seedState(started, {
      state: 'REVIEWING',
      reviewRound: 0,
      currentCommit: committedCommit(stale), // the record's claim …
    });
    expect(headOf(worktreePath)).toBe(base); // … and the truth
    expect(committedCommit(stale)).not.toBe(base);
    expect(current.state.currentCommit).not.toBe(base);

    const agent = recordedAgent({ codex: () => reviewResult(passingReview()) });
    const run = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: agent.runner }),
    );
    const final = reload(started.root, 'REM-001-STALE').state;

    // Measured, and this is the assertion that names the owner: nothing ran,
    // nothing was written, and the reason is the reconciliation finding.
    expect(run.outcome).toBe('STATE_DIVERGED');
    expect(run.reasonCodes).toContain('CURRENT_COMMIT_MOVED');
    expect(run.reconciliation?.outcome).toBe('STATE_DIVERGED');
    expect(run.steps).toBe(0);
    expect(final.state).toBe('REVIEWING');
    // The reviewer was never started, so no settlement gate was ever consulted.
    expect(agent.countFor('codex')).toBe(0);
  });

  // The conjunct's own discriminating fixture, and the shape a real run has.
  //
  // A writing phase withdraws the checkpoint, so `currentCommit` is **null** on
  // the way into `VERIFYING` and stays null through `REVIEWING` — reconciliation
  // admits that record precisely because withdrawal is what it is for. So this
  // reaches the settlement predicate, and the two readings disagree here:
  // `null !== basePinnedCommit` is true, while the observed HEAD really is the
  // base pin. The record-vs-record mutant settles this task; the correct
  // comparison parks it.
  it('parks for an operator when the observed head is still the base pin', async () => {
    const started = await startTask({ taskId: 'REM-001-NULL' });
    seedState(started, {
      state: 'REVIEWING',
      reviewRound: 0,
      currentCommit: null,
      worktreeCleanAtCheckpoint: false,
    });
    expect(headOf(started.workspace.worktreePath)).toBe(started.workspace.basePinnedCommit);

    const agent = recordedAgent({ codex: () => reviewResult(passingReview()) });
    const run = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: agent.runner }),
    );
    const final = reload(started.root, 'REM-001-NULL').state;

    // The positive successor, not merely "not READY_FOR_PR".
    expect(final.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(final.resumeFrom).toEqual({ phase: 'REVIEW', round: 1 });
    expect(run.outcome).toBe('HUMAN_DECISION_REQUIRED');
    // The reviewer really ran and really passed: the refusal is the gate's.
    expect(agent.countFor('codex')).toBe(1);
  });

  // The plain shape, kept as well: the record agrees with the worktree and both
  // say nothing was delivered. This is the dogfood's own record, and it is the
  // case that would still pass under the mutant — which is exactly why it is
  // not sufficient on its own and is not the mutation target.
  it('parks when the record and the worktree agree that nothing was delivered', async () => {
    const started = await startTask({ taskId: 'REM-001-AGREE' });
    seedState(started, { state: 'REVIEWING', reviewRound: 0 });

    const run = await runTask(
      request(started),
      deps({
        verify: recordedVerify().runner,
        agent: recordedAgent({ codex: () => reviewResult(passingReview()) }).runner,
      }),
    );
    const final = reload(started.root, 'REM-001-AGREE').state;

    expect(final.state).toBe('HUMAN_DECISION_REQUIRED');
    expect(final.currentCommit).toBe(final.basePinnedCommit);
    expect(run.outcome).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('still settles a task whose commit is a real descendant', async () => {
    const started = await startTask({ taskId: 'REM-001-REAL' });
    seedState(started, { state: 'IMPLEMENTING' });
    const agent = recordedAgent({
      claude: writerThatEdits('src/work.ts', '// work\n'),
      codex: () => reviewResult(passingReview()),
    });

    const run = await runTask(
      request(started),
      deps({ verify: recordedVerify().runner, agent: agent.runner }),
    );
    const final = reload(started.root, 'REM-001-REAL').state;

    expect(run.outcome).toBe('TASK_COMPLETED');
    expect(final.state).toBe('READY_FOR_PR');
    expect(final.worktreeCleanAtCheckpoint).toBe(true);
    expect(final.currentCommit).not.toBe(final.basePinnedCommit);
    expect(final.currentCommit).toBe(headOf(started.workspace.worktreePath));
    // A real descendant, and git says so — not merely a different string.
    await expect(
      classifyAncestry(
        runGitCommand,
        started.workspace.worktreePath,
        final.basePinnedCommit ?? '',
        'HEAD',
      ),
    ).resolves.toBe('ANCESTOR');
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
      brief: readExecutionBrief(started.repository, started.taskId, started.workspace.worktreePath),
      git: runGitCommand,
      agent: agent.runner,
      writerMcp: null,
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
