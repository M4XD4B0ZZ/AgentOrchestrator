/**
 * M7 slice 1 — an operator learns before the silence, not after it.
 *
 * ── The defect this file pins ──────────────────────────────────────────────
 *
 * `cli/repositories-command.ts` carried this sentence:
 *
 *   > The notifier is built **before** the loop, so an operator with a broken
 *   > notify.yaml is told while they are still standing there rather than eight
 *   > hours later by the message that never arrives.
 *
 * Building it early was true. *Telling* was not. A recurring invocation prints
 * nothing until it ends (`L-M3-02-10`), and the only place the notifier's state
 * reached a console was `renderAttention`, written after `driveScheduler`
 * returned — so on a run that waits, "still standing there" meant "when the run
 * is over". It was measured false on a real overnight run: an invocation that
 * began at 07:52 would not have said `NOT_CONFIGURED` until it stopped.
 *
 * `cli/block-command.ts` already had the shape that closes it — it writes
 * `renderNotifierState(notifier)` the line after it builds one, above the lease.
 * The recurring path simply never took it.
 *
 * ── What is measured here, and what is measured elsewhere ──────────────────
 *
 * Here: that the readiness line exists, is total over the notifier's three
 * states, carries no configuration in it, is written **before the first pass**
 * rather than merely before the report, and that a `repositories --attended`
 * with no wait grant still prints exactly what it always printed.
 *
 * Not here: the attention chain itself. That a `HUMAN_DECISION_REQUIRED` task
 * raises exactly one `ESCALATED_DECISION_REQUIRED` item, that a refused send
 * leaves no receipt and is offered again, that an acknowledged one is never sent
 * twice, and that a re-entry through a new event is a new item are all measured
 * in `tests/m3-02-actionable-notifications.test.ts` and
 * `tests/m4-01-unattended-completion.test.ts`. Restating them here would be a
 * second opinion about a settled question rather than a new one.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Command } from 'commander';
import { afterAll, describe, expect, it } from 'vitest';

import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { registerRepositoriesCommand } from '../src/cli/repositories-command.js';
import {
  NOTIFICATION_READINESS_SENTENCES,
  renderNotificationReadiness,
  type NotificationReadiness,
} from '../src/cli/render-attention.js';
import {
  createAttentionNotifier,
  type AttentionNotifier,
} from '../src/notify/attention-notification.js';
import {
  loadRepositoryRegistry,
  repositoryRegistryPath,
} from '../src/registry/repository-registry.js';
import type { TaskState } from '../src/core/task-state.js';

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function home(): string {
  const dir = makeCanonicalTempDir('ao-m7s1-home-');
  created.push(dir);
  return dir;
}

/**
 * A real git repository with one task that genuinely needs a person.
 *
 * Real, because the registry refuses `NOT_A_GIT_REPOSITORY` before a notifier is
 * ever built — a bare scratch directory produced `REPOSITORY_UNRESOLVABLE` and
 * an empty console, which is the resolution boundary working and would have made
 * every assertion below vacuous.
 *
 * The identity is set on this repository rather than read from the machine, so
 * the fixture does not lean on whoever is committing today.
 */
function repositoryNeedingSomebody(id: string): string {
  const root = makeCanonicalTempDir('ao-m7s1-repo-');
  created.push(root);
  const git = (...args: string[]): void =>
    void execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'AO Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'README.md'), `# ${id}\n`, 'utf8');
  // The committed repository profile. Without it the resolution refuses
  // `PROFILE_MISSING`, again before any notifier exists.
  const profile = join(root, '.agent-orchestrator', 'repo-profile.yaml');
  mkdirSync(dirname(profile), { recursive: true });
  writeFileSync(
    profile,
    [
      'schemaVersion: 1',
      'repository:',
      `  id: ${id}`,
      '  defaultBranch: main',
      'taskSource:',
      '  kind: MARKDOWN_DIRECTORY',
      '  path: .agent-orchestrator/tasks',
      'context:',
      '  canonicalSources:',
      '    - README.md',
      'capabilities:',
      '  codegraph: OPTIONAL',
      'verification:',
      '  phases:',
      '    - phase: VERIFY',
      '      command: [node, --version]',
      'scope:',
      '  allowedPaths:',
      '    - src',
      '  protectedPaths: []',
      'completion:',
      '  maxReviewRounds: 1',
      'remote:',
      '  required: false',
      '',
    ].join('\n'),
    'utf8',
  );
  git('add', '-A');
  git('commit', '--quiet', '-m', 'fixture');
  const value: TaskState = Object.freeze({
    schemaVersion: 1,
    taskId: 'NEEDS-1',
    repositoryId: id,
    repositoryRoot: root,
    worktreePath: join(`${root}.worktrees`, 'NEEDS-1'),
    state: 'HUMAN_DECISION_REQUIRED',
    stateEnteredAt: '2026-09-04T07:53:07.497Z',
    baseBranch: 'main',
    basePinnedCommit: '0'.repeat(40),
    scopeAuthorityCommit: null,
    workBranch: 'ao/task/NEEDS-1',
    currentCommit: null,
    reviewRound: 3,
    maxReviewRounds: 3,
    blockedAgent: 'claude',
    resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: false,
    findingHistory: [],
  } as unknown as TaskState);
  const path = join(root, '.agent-orchestrator', 'runtime', 'NEEDS-1.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return root;
}

/** The registry, written with real newlines so it actually resolves. */
function registry(scratch: string, root: string): void {
  const path = join(scratch, '.agent-orchestrator', 'repositories.yaml');
  mkdirSync(dirname(path), { recursive: true });
  const lines = ['schemaVersion: 1', 'repositories:', `  - path: ${JSON.stringify(root)}`, ''];
  writeFileSync(path, lines.join('\n'), 'utf8');
}

function notifyConfig(scratch: string, body: string): void {
  const path = join(scratch, '.agent-orchestrator', 'notify.yaml');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

interface Driven {
  /** Everything written to the console at the instant the loop was entered. */
  readonly beforeFirstPass: string;
  /** Everything written by the time the invocation returned. */
  readonly whenFinished: string;
}

/**
 * Runs the command and captures the console twice: once at the moment
 * `driveScheduler` is called, and once at the end.
 *
 * The first capture is the whole point. "Before the report" is satisfied by any
 * write at all; "before the first pass" is the claim the comment makes, and only
 * a reading taken *inside* the seam can tell the two apart.
 */
async function drive(
  scratch: string,
  root: string,
  argv: readonly string[],
  notifier?: AttentionNotifier,
): Promise<Driven> {
  const provider = fixedPathProvider(scratch);
  let text = '';
  let beforeFirstPass = '';

  const program = new Command();
  program.exitOverride();
  registerRepositoriesCommand(program, {
    write: (chunk: string) => {
      text += chunk;
    },
    loadRepositoryRegistry: () => loadRepositoryRegistry(provider),
    repositoryRegistryPath: () => repositoryRegistryPath(provider),
    pathProvider: provider,
    ...(notifier === undefined ? {} : { attentionNotifier: notifier }),
    // The pass is substituted: the subject is what the command writes around
    // the loop, not what a coordinator does inside it.
    driveScheduler: async () => {
      beforeFirstPass = text;
      return Object.freeze({
        cycles: Object.freeze([]),
        ending: 'NOT_REQUESTED' as const,
        registryRefusal: null,
      });
    },
  });

  const previous = process.exitCode;
  try {
    await program.parseAsync(['node', 'agent-loop', 'repositories', ...argv]);
  } finally {
    process.exitCode = previous;
  }
  void root;
  return { beforeFirstPass, whenFinished: text };
}

// `--max-wait-ms` is not optional beside `--wait-for-reset`: the build refuses
// the pair without it rather than inventing how long it may sleep, and that
// refusal happens before the notifier is built. Omitting it here produced
// `MAX_WAIT_MS_REQUIRED` and an empty console — the boundary working, and a
// defect in the first draft of this file rather than in the command.
const WAITING = [
  '--attended',
  '--max-steps',
  '1',
  '--max-invocations',
  '1',
  '--wait-for-reset',
  '--max-wait-ms',
  '1000',
  '--max-cycles',
  '2',
] as const;

const NOT_WAITING = ['--attended', '--max-steps', '1', '--max-invocations', '1'] as const;

/* ═══════════════════ 1. the line itself, and its vocabulary ═══════════════ */

describe('M7 slice 1 — the readiness line', () => {
  it('has a sentence for every state the notifier can be in, and no spare', () => {
    // Read off the type rather than retyped, so a fourth state is a compile
    // error here before it is a missing sentence on somebody's console.
    const states: readonly NotificationReadiness[] = ['ARMED', 'NOT_CONFIGURED', 'CONFIG_UNUSABLE'];
    expect(Object.keys(NOTIFICATION_READINESS_SENTENCES).sort()).toEqual([...states].sort());
    for (const state of states) {
      expect(NOTIFICATION_READINESS_SENTENCES[state].length).toBeGreaterThan(20);
    }
    // The three sentences say three different things. A table whose entries can
    // be swapped is a table that has stopped distinguishing its cases.
    const said = new Set(Object.values(NOTIFICATION_READINESS_SENTENCES));
    expect(said.size).toBe(states.length);
  });

  it('names the state on the first line, and the refusal code beside it', () => {
    const armed = renderNotificationReadiness({ state: 'ARMED', configCode: null });
    expect(armed.split('\n')[0]).toContain('ARMED');

    const unusable = renderNotificationReadiness({
      state: 'CONFIG_UNUSABLE',
      configCode: 'CONFIG_CONTRACT_VIOLATION',
    });
    expect(unusable.split('\n')[0]).toContain('CONFIG_UNUSABLE');
    expect(unusable.split('\n')[0]).toContain('CONFIG_CONTRACT_VIOLATION');
  });

  it('says nothing about a code when there is none to say', () => {
    // `configCode` is null on the two states that are not a refusal. Printing
    // "null" beside them would be this renderer inventing a reason.
    for (const state of ['ARMED', 'NOT_CONFIGURED'] as const) {
      const text = renderNotificationReadiness({ state, configCode: null });
      expect(text).not.toContain('null');
    }
  });
});

/* ═════════════ 2. it reaches the console before the first pass ════════════ */

describe('M7 slice 1 — a waiting run says it before it goes quiet', () => {
  it('prints ARMED before the loop is entered, not only in the final report', async () => {
    const scratch = home();
    const root = repositoryNeedingSomebody('fixture');
    registry(scratch, root);

    const driven = await drive(scratch, root, WAITING, {
      state: 'ARMED',
      configCode: null,
      transport: async () => ({ ok: true as const }),
    });

    // The reading taken inside the seam. This is the assertion the old code
    // failed: everything below was also true of it, because the final report
    // did eventually carry the state.
    expect(driven.beforeFirstPass).toContain('Notifications');
    expect(driven.beforeFirstPass).toContain('ARMED');
    expect(driven.beforeFirstPass).toContain(NOTIFICATION_READINESS_SENTENCES.ARMED);
  });

  it('prints NOT_CONFIGURED before the loop on a machine with no notify.yaml', async () => {
    const scratch = home();
    const root = repositoryNeedingSomebody('fixture');
    registry(scratch, root);
    // No notify.yaml is written. The real factory decides from the file.
    expect(existsSync(join(scratch, '.agent-orchestrator', 'notify.yaml'))).toBe(false);

    const driven = await drive(scratch, root, WAITING);

    expect(driven.beforeFirstPass).toContain('NOT_CONFIGURED');
    expect(driven.beforeFirstPass).toContain(NOTIFICATION_READINESS_SENTENCES.NOT_CONFIGURED);
  });

  it('prints CONFIG_UNUSABLE with its closed code, and no configuration', async () => {
    const scratch = home();
    const root = repositoryNeedingSomebody('fixture');
    registry(scratch, root);
    // Plaintext to a host that is not a loopback literal: refused by the
    // production parser. The token and host are here so that the assertion
    // below is about a file that really did contain them.
    const HOST = 'ntfy.example.invalid';
    const TOKEN = 'tk_thisMustNeverBePrinted';
    notifyConfig(
      scratch,
      ['schemaVersion: 1', `endpoint: http://${HOST}`, 'topic: ao', `token: ${TOKEN}`, ''].join(
        '\n',
      ),
    );

    // What the production factory actually says about this file, read rather
    // than predicted — the assertion is then about the real refusal code and
    // survives a rename of it.
    const notifier = createAttentionNotifier(fixedPathProvider(scratch));
    expect(notifier.state).toBe('CONFIG_UNUSABLE');
    expect(notifier.configCode).not.toBeNull();

    const driven = await drive(scratch, root, WAITING);

    expect(driven.beforeFirstPass).toContain('CONFIG_UNUSABLE');
    expect(driven.beforeFirstPass).toContain(notifier.configCode as string);
    expect(driven.beforeFirstPass).toContain(NOTIFICATION_READINESS_SENTENCES.CONFIG_UNUSABLE);

    // The whole invocation, not just the early line: nothing anywhere in this
    // output is a piece of the operator's configuration.
    expect(driven.whenFinished).not.toContain(TOKEN);
    expect(driven.whenFinished).not.toContain(HOST);
    expect(driven.whenFinished).not.toContain('notify.yaml:');
  });

  it('prints the registry head exactly once across the whole invocation', async () => {
    // The early write carries the head so an operator has the registry and the
    // readiness together. The final write must then not repeat it: a head
    // printed twice reads as two runs.
    const scratch = home();
    const root = repositoryNeedingSomebody('fixture');
    registry(scratch, root);

    const driven = await drive(scratch, root, WAITING, {
      state: 'ARMED',
      configCode: null,
      transport: async () => ({ ok: true as const }),
    });

    const occurrences = driven.whenFinished.split('Notifications').length - 1;
    expect(occurrences).toBe(1);
    const heads = driven.whenFinished.split('Registry').length - 1;
    expect(heads).toBe(1);
  });
});

/* ═══════════ 3. the invocation that did not ask to wait is untouched ══════ */

describe('M7 slice 1 — without a wait grant nothing here is reached', () => {
  it('writes no readiness line and reads no notification configuration', async () => {
    const scratch = home();
    const root = repositoryNeedingSomebody('fixture');
    registry(scratch, root);
    // A configuration that would arm a notifier if anything read it.
    notifyConfig(
      scratch,
      ['schemaVersion: 1', 'endpoint: https://ntfy.example.invalid', 'topic: ao', ''].join('\n'),
    );

    const driven = await drive(scratch, root, NOT_WAITING);

    // The proof that this ran rather than refused: an invocation that fell over
    // on its registry would also contain no readiness line, and would prove
    // nothing at all.
    expect(driven.beforeFirstPass).toBe('');
    expect(driven.whenFinished).toContain('Registry');
    expect(driven.whenFinished).not.toContain('Notifications');
    expect(driven.whenFinished).not.toContain('ARMED');
  });
});
