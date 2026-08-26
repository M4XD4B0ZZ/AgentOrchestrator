/**
 * V4 slice 13 — unattended head publication.
 *
 * This is the first slice in which this build may change something outside the
 * machine with nobody present. The suite is written against the five ways that
 * goes wrong, and every one of them is a question about *authority* rather than
 * about the push, which is unchanged:
 *
 *  1. **the work authorising itself.** The whole slice turns on where the
 *     permission's bytes are. The load-bearing cases write a
 *     `delivery-automation.yaml` into the repository root, into the
 *     repository's own `.agent-orchestrator/` directory and into a task
 *     worktree, and require the loader to go on answering that nothing is
 *     declared. A structural sweep beside them requires the module to name no
 *     repository path, no Git subcommand and no environment variable at all —
 *     so the property is "there is no code that could read it" and not "the code
 *     that could read it does not";
 *  2. **capability becoming permission.** Two independent things are required
 *     and neither may stand in for the other: a declaration that permits *this*
 *     repository, and an invocation that explicitly asks. Each half alone is
 *     driven and required to send nothing;
 *  3. **a refusal that fails open.** A declaration that is missing, malformed,
 *     from a future contract, carrying a key this build does not know, carrying
 *     a permission this build does not know, or naming one repository twice is
 *     required to refuse — and the one that could not be *read* is required to
 *     refuse under its own answer, distinct from the one that says no, because
 *     a broken authority configuration must not be delivered as a working
 *     refusal;
 *  4. **the grant leaking into another act.** `--automatic-publish-head-only`
 *     is refused on the command line beside `--create-pr` and `--merge-pr`, and
 *     — independently, because one refusal is a rule about a command line and
 *     the other is a rule about an authority — a drive that publishes under it
 *     and finds the head already there is required to stop and name the
 *     creation rather than perform it;
 *  5. **a permission that goes stale.** The declaration is re-read immediately
 *     before the remote is contacted. A case removes it between the ladder's
 *     read and that moment and requires zero pushes.
 *
 * Nothing here re-measures the push. The vector, the create-only lease, the
 * grader and the no-retry rule are slice 5's and are pinned in
 * `tests/v4-05-delivery-head-publication.test.ts`. What is measured here about
 * the remote is the one thing this slice changes the risk of: two publishers
 * racing for one absent ref, against a real bare repository, because with nobody
 * present there is no operator reading the report.
 */

import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DELIVERY_AUTOMATION_FILE_NAME,
  DELIVERY_AUTOMATION_REFUSALS,
  DELIVERY_AUTOMATION_SCHEMA_VERSION,
  HEAD_PUBLICATION_DECLARATIONS,
  MAX_DELIVERY_AUTOMATION_BYTES,
  UNATTENDED_PUBLICATION_PERMISSIONS,
  deliveryAutomationPath,
  loadDeliveryAutomation,
  permitsUnattendedHeadPublication,
  type DeliveryAutomationOutcome,
} from '../src/deliver/delivery-automation.js';
import { buildProgram } from '../src/cli/index.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { orchestratorHome } from '../src/config/paths.js';
import {
  AUTOMATIC_PUBLISH_HEAD_ONLY_OPTION_DESCRIPTION,
  PUBLICATION_GRANT_REFUSALS,
  PUBLICATION_GRANT_REFUSAL_DETAIL,
  DELIVERY_COMMAND_DESCRIPTION,
  DRIVE_OPTION_DESCRIPTION,
  SELECT_TASK_OPTION_DESCRIPTION,
  refusePublicationGrants,
  registerDeliveryCommand,
  type DeliveryCommandInput,
  type PublicationGrantRefusal,
} from '../src/cli/delivery-command.js';
import {
  HEAD_PUBLICATIONS,
  HEAD_PUBLICATION_DETAIL,
  type HeadPublication,
} from '../src/deliver/head-publication.js';
import { DELIVERY_EFFECT_FLAG } from '../src/cli/delivery-driver.js';
import { DRIVE_TRAILER, SELECTION_TRAILER } from '../src/cli/render-delivery-observation.js';
import { EXIT_RUN_INPUT_UNUSABLE } from '../src/cli/run-exit-codes.js';
import {
  DELIVERY_CONCLUSION_VERSION,
  deliveryConclusionBinding,
  type DeliveryConclusionPayload,
} from '../src/deliver/delivery-conclusion.js';
import { deliveryConclusionDirectory } from '../src/deliver/delivery-conclusion-store.js';
import { taskRuntimeDirectory } from '../src/state/state-location.js';
import { saveTaskState } from '../src/state/state-store.js';
import { validCreatedState, validReadyForPrState } from './fixtures.js';

/**
 * Source with comments blanked, so a sweep measures code rather than prose.
 *
 * Newlines are kept, so a line-oriented reading of a failure still points at the
 * right line. The same stripper the sibling slice files use, and the reason it
 * exists here too is that these headers deliberately name the authorities they
 * are about — a sweep over raw text would forbid explaining the design.
 */
function codeOnly(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/gm, '$1 ');
}

/* ── scratch ──────────────────────────────────────────────────────────────── */

const roots: string[] = [];

function scratchRoot(prefix = 'ao-v413-'): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterAll(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked file on Windows must not fail an otherwise passing suite.
    }
  }
});

/* ── the identities under test ────────────────────────────────────────────── */

const TASK = 'V4-13';
/** H — the exact commit a publication is about. */
const HEAD = 'a'.repeat(40);
/** Neither H nor anything this build would publish. */
const OTHER = 'd'.repeat(40);
const BASE = 'main';
const BRANCH = 'ao/task/V4-13';
const AT = '2026-08-26T12:00:00.000Z';
const IDENTITY = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});
const DECLARED_TARGET = Object.freeze({
  declared: true,
  remoteName: 'origin',
  result: Object.freeze({
    outcome: 'RESOLVED',
    target: Object.freeze({ provider: 'github', ...IDENTITY }),
  }),
});

/** One open pull request at H, unmerged, on the declared base. */
const OPEN_PULL = Object.freeze({
  number: 13,
  state: 'open',
  draft: false,
  merged: false,
  merge_commit_sha: null,
  head: Object.freeze({ sha: HEAD }),
  base: Object.freeze({ ref: BASE }),
});

/** The same remote, naming a different repository. Nothing declares this one. */
const MOVED_TARGET = Object.freeze({
  declared: true,
  remoteName: 'origin',
  result: Object.freeze({
    outcome: 'RESOLVED',
    target: Object.freeze({ provider: 'github', ...IDENTITY, name: 'a-different-repository' }),
  }),
});

/* ── the operator's declaration, as bytes in a scratch home ───────────────── */

interface DeclarationEntry {
  readonly host?: string;
  readonly owner?: string;
  readonly name?: string;
  readonly headPublication?: string;
  readonly [key: string]: unknown;
}

/** A scratch OS user profile. Nothing here is inside any repository. */
function scratchHome(): string {
  const home = scratchRoot('ao-v413-home-');
  mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
  return home;
}

function declarationYaml(entries: readonly DeclarationEntry[], version = DELIVERY_AUTOMATION_SCHEMA_VERSION): string {
  const lines = [`schemaVersion: ${String(version)}`, 'repositories:'];
  if (entries.length === 0) lines[1] = 'repositories: []';
  for (const entry of entries) {
    let first = true;
    for (const [key, value] of Object.entries(entry)) {
      lines.push(`${first ? '  - ' : '    '}${key}: ${String(value)}`);
      first = false;
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Writes a declaration into a scratch home and answers the provider for it. */
function declare(home: string, entries: readonly DeclarationEntry[], version?: number): void {
  writeFileSync(
    join(home, '.agent-orchestrator', DELIVERY_AUTOMATION_FILE_NAME),
    declarationYaml(entries, version),
    'utf8',
  );
}

function writeRaw(home: string, text: string): void {
  writeFileSync(join(home, '.agent-orchestrator', DELIVERY_AUTOMATION_FILE_NAME), text, 'utf8');
}

function removeDeclaration(home: string): void {
  rmSync(join(home, '.agent-orchestrator', DELIVERY_AUTOMATION_FILE_NAME), { force: true });
}

const PERMITTING: readonly DeclarationEntry[] = Object.freeze([
  Object.freeze({ ...IDENTITY, headPublication: 'AUTOMATIC_ALLOWED' }),
]);

const DENYING: readonly DeclarationEntry[] = Object.freeze([
  Object.freeze({ ...IDENTITY, headPublication: 'ATTENDED_ONLY' }),
]);

function load(home: string): DeliveryAutomationOutcome {
  return loadDeliveryAutomation(fixedPathProvider(home));
}

function permission(
  home: string,
  target: { readonly host: string; readonly owner: string; readonly name: string } = IDENTITY,
): string {
  return permitsUnattendedHeadPublication(load(home), target);
}

/* ── the repository fixture ──────────────────────────────────────────────── */

const TASK_DIR = '.agent-orchestrator/tasks';

function repositoryRoot(): string {
  const root = scratchRoot();
  mkdirSync(join(root, TASK_DIR), { recursive: true });
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  return root;
}

function writeReadyState(root: string, taskId = TASK): void {
  const saved = saveTaskState(
    validReadyForPrState({
      taskId,
      repositoryRoot: root,
      worktreePath: join(root, taskId),
      baseBranch: BASE,
      workBranch: BRANCH,
      currentCommit: HEAD,
      basePinnedCommit: OTHER,
      stateEnteredAt: AT,
    }),
    { repositoryRoot: root },
  );
  if (!saved.ok) throw new Error(`fixture state not saved: ${saved.code}`);
}

/**
 * A task that exists, has a resolved head, and is NOT finished.
 *
 * Both halves matter. Without the head the *subject* step answers first and the
 * case would measure that instead — driven and measured: a `CREATED` fixture
 * with `currentCommit: null` answers `SUBJECT_NOT_ESTABLISHED`. With one, the
 * subject resolves and the state step is the one that refuses.
 */
function writeNotReadyState(root: string, taskId: string): void {
  const saved = saveTaskState(
    validCreatedState({
      taskId,
      repositoryRoot: root,
      worktreePath: join(root, taskId),
      state: 'IMPLEMENTING',
      baseBranch: BASE,
      workBranch: `${BRANCH}-b`,
      basePinnedCommit: OTHER,
      currentCommit: HEAD,
      stateEnteredAt: AT,
    }),
    { repositoryRoot: root },
  );
  if (!saved.ok) throw new Error(`fixture state not saved: ${saved.code}`);
}

function writeTaskMarkdown(root: string, taskId = TASK): void {
  writeFileSync(
    join(root, TASK_DIR, `${taskId}.md`),
    [
      '---',
      `id: ${taskId}`,
      `title: task ${taskId}`,
      'status: OPEN',
      'kind: NORMAL',
      'priority: NORMAL',
      'currentFocus: false',
      'dependsOn: []',
      '---',
      '',
      'Body prose, which nothing here interprets.',
      '',
    ].join('\n'),
    'utf8',
  );
}

function writeConclusion(root: string, taskId = TASK): void {
  const payload: DeliveryConclusionPayload = {
    conclusionVersion: DELIVERY_CONCLUSION_VERSION,
    taskId,
    repositoryRoot: root,
    subjectCommit: HEAD,
    mergeCommit: 'b'.repeat(40),
    provider: 'github',
    host: IDENTITY.host,
    owner: IDENTITY.owner,
    name: IDENTITY.name,
    pullRequestNumber: 13,
    baseRef: BASE,
    profileDigest: 'a'.repeat(64),
    verifiedAt: AT,
    receiptBinding: 'e'.repeat(64),
    verificationBinding: 'f'.repeat(64),
    concludedAt: AT,
  };
  mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
  writeFileSync(
    join(deliveryConclusionDirectory(root), `${taskId}.json`),
    `${JSON.stringify(
      { ...payload, binding: deliveryConclusionBinding({ taskId, repositoryRoot: root }, payload) },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/* ── the CLI, with every vector counted ───────────────────────────────────── */

function commandResult(over: Record<string, unknown> = {}) {
  return {
    display: 'gh',
    executable: 'gh',
    args: [],
    started: true,
    outcome: 'COMPLETED',
    exitCode: 0,
    failureCode: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    timedOut: false,
    ...over,
  } as never;
}

interface Counts {
  forge: number;
  publish: number;
  create: number;
  merge: number;
  resolves: number;
}

interface Run {
  readonly out: string;
  readonly exitCode: number | undefined;
  readonly counts: Counts;
  readonly pushVectors: readonly (readonly string[])[];
}

/**
 * Drives the real registered CLI over a real repository directory.
 *
 * Git is never asked anything: the resolver, the forge reader, the publication
 * runner and the ignore probe are all seams, and the acts this file drives stop
 * at the publication, which takes no execution lease and starts no process of
 * its own. The **task-state reader and the conclusion store are real**, because
 * both are inputs to the position the driver derives and a stub would answer
 * whatever the case wanted.
 */
async function drive(
  argv: readonly string[],
  root: string,
  home: string,
  over: {
    readonly remoteRef?: 'absent' | 'at-head' | 'other';
    readonly remoteUrlsDiverge?: boolean;
    readonly pushFails?: boolean;
    /** Runs on each resolve, so a case can move the world mid-ladder. */
    readonly onResolve?: (n: number) => void;
    /**
     * From this resolve onwards, the repository declares a DIFFERENT delivery
     * target. The one way a case can make the identity move under the ladder,
     * which is not something a file on disk can do.
     */
    readonly targetMovesAt?: number;
    /**
     * The forge answers with one open pull request at this head, whose only
     * check succeeded. The one world in which the driver reaches the merge
     * stage at all — and therefore the only one in which "this grant is not a
     * merge authority" can be measured rather than assumed.
     */
    readonly openPullRequest?: boolean;
    readonly task?: string;
  } = {},
): Promise<Run> {
  const counts: Counts = { forge: 0, publish: 0, create: 0, merge: 0, resolves: 0 };
  const pushVectors: (readonly string[])[] = [];
  let remoteRef: 'absent' | 'at-head' | 'other' = over.remoteRef ?? 'absent';
  const chunks: string[] = [];
  const outer = process.exitCode;
  process.exitCode = undefined;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const program = new Command();
    program.exitOverride();
    registerDeliveryCommand(program, {
      pathProvider: fixedPathProvider(home),
      resolveRepository: (async () => {
        counts.resolves += 1;
        over.onResolve?.(counts.resolves);
        return {
          ok: true,
          repository: {
            id: 'fixture-repo',
            root,
            gitCommonDir: join(root, '.git'),
            taskSource: { kind: 'MARKDOWN_DIRECTORY', path: TASK_DIR },
            verification: { phases: [] },
            delivery:
              over.targetMovesAt !== undefined && counts.resolves >= over.targetMovesAt
                ? MOVED_TARGET
                : DECLARED_TARGET,
          },
        };
      }) as never,
      runner: (async (_command: string, args: readonly string[]) => {
        counts.forge += 1;
        const path = args.find((a) => a.startsWith('repos/')) ?? args.join(' ');
        if (/\/pulls\/\d+$/.test(path)) {
          return over.openPullRequest === true
            ? commandResult({ stdout: JSON.stringify(OPEN_PULL) })
            : commandResult({ exitCode: 1, stdout: '{}' });
        }
        if (path.endsWith('/pulls')) {
          return commandResult({ stdout: over.openPullRequest === true ? JSON.stringify([OPEN_PULL]) : '[]' });
        }
        if (path.endsWith('/check-runs')) {
          return commandResult({
            stdout: JSON.stringify(
              over.openPullRequest === true
                ? { total_count: 1, check_runs: [{ head_sha: HEAD, status: 'completed', conclusion: 'success' }] }
                : { total_count: 0, check_runs: [] },
            ),
          });
        }
        return commandResult({ stdout: JSON.stringify({ sha: HEAD, state: 'success', total_count: 0, statuses: [] }) });
      }) as never,
      publicationRunner: (async (args: readonly string[]) => {
        const joined = args.join(' ');
        if (joined.includes('remote get-url')) {
          const url =
            over.remoteUrlsDiverge === true && joined.includes('--push')
              ? 'https://github.com/someone-else/AgentOrchestrator.git'
              : 'https://github.com/M4XD4B0ZZ/AgentOrchestrator.git';
          return commandResult({ stdout: url });
        }
        if (joined.includes('ls-remote')) {
          const ref = args[args.length - 1] ?? '';
          const at = remoteRef === 'absent' ? null : remoteRef === 'at-head' ? HEAD : OTHER;
          if (at === null) return commandResult({ exitCode: 2 });
          return commandResult({ stdout: `${at}\t${ref}` });
        }
        counts.publish += 1;
        pushVectors.push([...args]);
        if (over.pushFails === true) return commandResult({ exitCode: 1, outcome: 'TIMED_OUT' });
        remoteRef = 'at-head';
        return commandResult();
      }) as never,
      creationRunner: (async () => {
        counts.create += 1;
        return commandResult({ stdout: '{}' });
      }) as never,
      mergeRunner: (async () => {
        counts.merge += 1;
        return commandResult({ stdout: '{}' });
      }) as never,
      git: (async () => ({ outcome: 'FAILED', stdout: '', stderr: 'not a commit' })) as never,
      envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
      checkIgnored: (async () => 'IGNORED') as never,
      now: () => new Date(AT),
    });
    const named = over.task === undefined ? ['--task', TASK] : over.task === '' ? [] : ['--task', over.task];
    await program.parseAsync(
      ['node', 'agent-loop', 'delivery', '--repository', root, ...named, ...argv],
      { from: 'node' },
    );
    return { out: chunks.join(''), exitCode: process.exitCode as number | undefined, counts, pushVectors };
  } finally {
    process.stdout.write = write;
    process.exitCode = outer;
  }
}

function lineOf(run: Run, label: string): string | null {
  const m = new RegExp(`^${label} *: (.+)$`, 'm').exec(run.out);
  return m === null ? null : (m[1] as string).trim();
}

function published(run: Run): string | null {
  return lineOf(run, 'Publication');
}

function driven(run: Run): string | null {
  return lineOf(run, 'Drive');
}

function mutated(run: Run): number {
  return run.counts.publish + run.counts.create + run.counts.merge;
}

/** One scratch home reused by the cases that must publish whatever it holds. */
const homeForAttended = scratchHome();

const AUTOMATIC = ['--drive', '--publish-head', '--automatic-publish-head-only'];
const ATTENDED = ['--drive', '--publish-head', '--attended'];

/* ─────────────────────────────────────────────────────────────────────────── */

describe('the declaration is the operator\u2019s, and lives outside every repository', () => {
  it('resolves under the OS user profile and nowhere else', () => {
    const home = scratchHome();
    const path = deliveryAutomationPath(fixedPathProvider(home));
    expect(path).toBe(join(orchestratorHome(fixedPathProvider(home)), DELIVERY_AUTOMATION_FILE_NAME));
    expect(path.startsWith(home)).toBe(true);
    // A pure function of the profile directory: the same provider answers the
    // same path, and a different one answers a different path.
    expect(deliveryAutomationPath(fixedPathProvider(home))).toBe(path);
    expect(deliveryAutomationPath(fixedPathProvider(scratchHome()))).not.toBe(path);
  });

  it('cannot be placed by the repository being delivered', () => {
    const home = scratchHome();
    const root = repositoryRoot();
    // Three places a task could write, and does: the repository root, the
    // repository's own orchestrator directory, and a worktree beside it. Each
    // gets a declaration that would permit everything if it were ever read.
    const forged = declarationYaml(PERMITTING);
    mkdirSync(join(root, '.agent-orchestrator'), { recursive: true });
    mkdirSync(join(root, 'worktree', '.agent-orchestrator'), { recursive: true });
    for (const at of [
      join(root, DELIVERY_AUTOMATION_FILE_NAME),
      join(root, '.agent-orchestrator', DELIVERY_AUTOMATION_FILE_NAME),
      join(root, 'worktree', '.agent-orchestrator', DELIVERY_AUTOMATION_FILE_NAME),
    ]) {
      writeFileSync(at, forged, 'utf8');
    }
    // Positive control: the bytes really would permit it, read from the one
    // place that counts. Without this the assertion below could pass because
    // the fixture is malformed rather than because the location is refused.
    writeRaw(home, forged);
    expect(permission(home)).toBe('ALLOWED');
    removeDeclaration(home);
    expect(permission(home)).toBe('NOT_DECLARED');
  });

  it('reads no repository path, no Git and no environment', () => {
    const code = codeOnly('src/deliver/delivery-automation.ts');
    // Positive control: the stripper left real code behind.
    expect(code).toContain('loadDeliveryAutomation');
    expect(code.replace(/\s+/g, '').length).toBeGreaterThan(500);
    for (const forbidden of [
      'repoProfilePath',
      'REPO_PROFILE',
      'repositoryRoot',
      'process.env',
      'execFile',
      'spawn',
      'GitRunner',
      "'show'",
      'basePinnedCommit',
      'scopeAuthorityCommit',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
    // And the one path it does build is joined onto the orchestrator home.
    expect(code).toContain('orchestratorHome');
  });
});

describe('the declaration contract is closed, and every refusal fails closed', () => {
  it('answers ALLOWED only for an entry that names this repository and permits it', () => {
    const home = scratchHome();
    declare(home, PERMITTING);
    expect(permission(home)).toBe('ALLOWED');
  });

  it('answers NOT_DECLARED with no file at all', () => {
    expect(permission(scratchHome())).toBe('NOT_DECLARED');
  });

  it('answers NOT_DECLARED for an empty list', () => {
    const home = scratchHome();
    declare(home, []);
    expect(load(home).state).toBe('DECLARED');
    expect(permission(home)).toBe('NOT_DECLARED');
  });

  it('answers DENIED for an explicit ATTENDED_ONLY', () => {
    const home = scratchHome();
    declare(home, DENYING);
    expect(permission(home)).toBe('DENIED');
  });

  it('cannot be satisfied by another repository, in any of the three parts', () => {
    const home = scratchHome();
    declare(home, [
      { ...IDENTITY, owner: 'someone-else', headPublication: 'AUTOMATIC_ALLOWED' },
      { ...IDENTITY, name: 'another-repo', headPublication: 'AUTOMATIC_ALLOWED' },
    ]);
    expect(permission(home)).toBe('NOT_DECLARED');
    // …and the entries really are well-formed, so the answer is about identity
    // rather than about the document.
    expect(load(home).state).toBe('DECLARED');
    expect(permission(home, { host: IDENTITY.host, owner: 'someone-else', name: IDENTITY.name })).toBe(
      'ALLOWED',
    );
  });

  it('compares the host too, and not only the owner and the name', () => {
    // The declaration's own host is narrowed by the contract to the one forge
    // this build supports, so a wrong-host *entry* cannot be written. The
    // grading function is nonetheless total over any target it is handed — the
    // subject side is a different validation — and a mutant that dropped the
    // host comparison survived every other case in this file until this one.
    const home = scratchHome();
    declare(home, PERMITTING);
    expect(permission(home, { ...IDENTITY, host: 'gitlab.example' })).toBe('NOT_DECLARED');
    expect(permission(home, { ...IDENTITY, host: '' })).toBe('NOT_DECLARED');
    expect(permission(home)).toBe('ALLOWED');
  });

  it('does not fold case, and says so by refusing', () => {
    const home = scratchHome();
    declare(home, [{ ...IDENTITY, owner: IDENTITY.owner.toLowerCase(), headPublication: 'AUTOMATIC_ALLOWED' }]);
    expect(permission(home)).toBe('NOT_DECLARED');
  });

  it('refuses a contract version this build does not understand', () => {
    const home = scratchHome();
    declare(home, PERMITTING, DELIVERY_AUTOMATION_SCHEMA_VERSION + 1);
    expect(load(home)).toEqual({ state: 'UNUSABLE', code: 'DECLARATION_CONTRACT_VIOLATION' });
    expect(permission(home)).toBe('UNREADABLE');
  });

  it('refuses a key this build does not know, including one for another effect', () => {
    const home = scratchHome();
    // The exact shape a later slice would add for a second act. It must refuse
    // the whole document rather than be ignored beside a permission this build
    // does understand — otherwise a future member falls into "allowed" for the
    // act it names by being silently dropped for the act it does not.
    declare(home, [{ ...IDENTITY, headPublication: 'AUTOMATIC_ALLOWED', pullRequestCreation: 'AUTOMATIC_ALLOWED' }]);
    expect(load(home)).toEqual({ state: 'UNUSABLE', code: 'DECLARATION_CONTRACT_VIOLATION' });
    expect(permission(home)).toBe('UNREADABLE');
  });

  it('refuses a permission value that is not one of the two members', () => {
    const home = scratchHome();
    for (const value of ['ALLOWED', 'AUTOMATIC', 'true', 'yes', 'AUTOMATIC_ALLOWED_FOR_EVERYTHING']) {
      declare(home, [{ ...IDENTITY, headPublication: value }]);
      expect(load(home).state, value).toBe('UNUSABLE');
      expect(permission(home), value).toBe('UNREADABLE');
    }
  });

  it('refuses a host this build does not support', () => {
    const home = scratchHome();
    declare(home, [{ ...IDENTITY, host: 'gitlab.example', headPublication: 'AUTOMATIC_ALLOWED' }]);
    expect(load(home)).toEqual({ state: 'UNUSABLE', code: 'DECLARATION_CONTRACT_VIOLATION' });
  });

  it('refuses two entries naming one repository, rather than ranking them', () => {
    const home = scratchHome();
    declare(home, [
      { ...IDENTITY, headPublication: 'ATTENDED_ONLY' },
      { ...IDENTITY, headPublication: 'AUTOMATIC_ALLOWED' },
    ]);
    expect(load(home)).toEqual({ state: 'UNUSABLE', code: 'DECLARATION_AMBIGUOUS' });
    expect(permission(home)).toBe('UNREADABLE');
    // Reversed, so the answer cannot be "the last one wins" either.
    declare(home, [
      { ...IDENTITY, headPublication: 'AUTOMATIC_ALLOWED' },
      { ...IDENTITY, headPublication: 'ATTENDED_ONLY' },
    ]);
    expect(load(home)).toEqual({ state: 'UNUSABLE', code: 'DECLARATION_AMBIGUOUS' });
  });

  it('refuses a document that is not one warning-free YAML document', () => {
    const home = scratchHome();
    writeRaw(home, 'schemaVersion: 1\nrepositories: [\n');
    expect(load(home)).toEqual({ state: 'UNUSABLE', code: 'DECLARATION_MALFORMED' });
    writeRaw(home, 'schemaVersion: 1\n---\nschemaVersion: 1\n');
    expect(load(home).state).toBe('UNUSABLE');
  });

  it('refuses a mapping key this build will not put in an object', () => {
    const home = scratchHome();
    writeRaw(home, 'schemaVersion: 1\nrepositories: []\n__proto__:\n  polluted: true\n');
    expect(load(home)).toEqual({ state: 'UNUSABLE', code: 'DECLARATION_FORBIDDEN_KEY' });
  });

  it('refuses a file larger than it will parse, before parsing it', () => {
    const home = scratchHome();
    writeRaw(home, `${'#'.repeat(MAX_DELIVERY_AUTOMATION_BYTES + 1)}\n`);
    expect(load(home)).toEqual({ state: 'UNUSABLE', code: 'DECLARATION_TOO_LARGE' });
  });

  it('refuses a declaration it cannot read at all', () => {
    const home = scratchHome();
    // A directory where the file should be: present, and not readable as one.
    mkdirSync(join(home, '.agent-orchestrator', DELIVERY_AUTOMATION_FILE_NAME), { recursive: true });
    expect(load(home)).toEqual({ state: 'UNUSABLE', code: 'DECLARATION_UNREADABLE' });
    expect(permission(home)).toBe('UNREADABLE');
  });

  it('keeps the vocabularies closed and distinct', () => {
    expect([...HEAD_PUBLICATION_DECLARATIONS].sort()).toEqual(['ATTENDED_ONLY', 'AUTOMATIC_ALLOWED']);
    expect([...UNATTENDED_PUBLICATION_PERMISSIONS].sort()).toEqual(
      ['ALLOWED', 'DENIED', 'NOT_DECLARED', 'UNREADABLE'].sort(),
    );
    // Every refusal member is distinct, and none of them is a permission word.
    expect(new Set(DELIVERY_AUTOMATION_REFUSALS).size).toBe(DELIVERY_AUTOMATION_REFUSALS.length);
    for (const code of DELIVERY_AUTOMATION_REFUSALS) {
      expect(UNATTENDED_PUBLICATION_PERMISSIONS as readonly string[], code).not.toContain(code);
    }
  });

  it('never answers ALLOWED from an unusable declaration, whatever it says', () => {
    const home = scratchHome();
    // The adversarial shape: a document whose *text* contains the permitting
    // words and which the contract refuses. A reader that grepped rather than
    // parsed would answer ALLOWED here.
    writeRaw(
      home,
      `schemaVersion: 2\nrepositories:\n  - host: ${IDENTITY.host}\n    owner: ${IDENTITY.owner}\n    name: ${IDENTITY.name}\n    headPublication: AUTOMATIC_ALLOWED\n`,
    );
    expect(permission(home)).toBe('UNREADABLE');
  });
});

describe('the invocation must ask, and the declaration must permit', () => {
  it('publishes when both are true, exactly once, at exactly H', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    const run = await drive(AUTOMATIC, root, home);
    expect(published(run)).toBe('PUBLISHED');
    expect(run.counts.publish).toBe(1);
    expect(run.counts.create).toBe(0);
    expect(run.counts.merge).toBe(0);
    // The one vector, and what it names. The push is written `<commit>:<ref>`,
    // so a local branch that moved could not change what was published.
    const vector = run.pushVectors[0] ?? [];
    expect(vector).toContain(`${HEAD}:refs/heads/${BRANCH}`);
    expect(vector).toContain(`--force-with-lease=refs/heads/${BRANCH}:`);
    expect(vector.join(' ')).not.toContain(`--force-with-lease=refs/heads/${BRANCH}:${HEAD}`);
  });

  it('sends nothing when the declaration permits and the invocation did not ask', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    // Two invocations, because the two layers refuse in two different places
    // and a case that drove only one would leave the other unmeasured.
    //
    // Under `--drive` the refusal is the driver's: `mayPerform` reads flags
    // only, answers `false` for an act with no grant, and the ladder is never
    // called — so there is no Publication line at all, and the report names the
    // act that was not authorised.
    const driven_ = await drive(['--drive', '--publish-head'], root, home);
    expect(published(driven_)).toBeNull();
    expect(driven(driven_)).toBe('ATTENDED_AUTHORITY_REQUIRED');
    expect(mutated(driven_)).toBe(0);
    // Named directly, the ladder is reached and refuses on its own authority
    // step. Both paths send nothing, and a permitting declaration moved neither.
    const named = await drive(['--publish-head'], root, home);
    expect(published(named)).toBe('OPERATOR_ABSENT');
    expect(mutated(named)).toBe(0);
  });

  it('sends nothing when the invocation asks and nothing is declared', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    const run = await drive(AUTOMATIC, root, home);
    expect(published(run)).toBe('AUTOMATIC_PUBLICATION_NOT_DECLARED');
    expect(mutated(run)).toBe(0);
    expect(driven(run)).toBe('ATTENDED_AUTHORITY_REQUIRED');
  });

  it('sends nothing when the declaration says no', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, DENYING);
    const run = await drive(AUTOMATIC, root, home);
    expect(published(run)).toBe('AUTOMATIC_PUBLICATION_DENIED');
    expect(mutated(run)).toBe(0);
  });

  it('sends nothing, and says so distinctly, when the declaration cannot be read', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    writeRaw(home, 'schemaVersion: 1\nrepositories: [\n');
    const run = await drive(AUTOMATIC, root, home);
    expect(published(run)).toBe('PUBLICATION_POLICY_UNREADABLE');
    expect(mutated(run)).toBe(0);
  });

  it('publishes under --attended with no declaration anywhere', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    const run = await drive(ATTENDED, root, home);
    expect(published(run)).toBe('PUBLISHED');
    expect(run.counts.publish).toBe(1);
  });

  it('publishes under --attended even when the declaration denies or is broken', async () => {
    for (const write of [
      () => declare(homeForAttended, DENYING),
      () => writeRaw(homeForAttended, 'schemaVersion: 99\n'),
    ]) {
      const root = repositoryRoot();
      writeReadyState(root);
      write();
      const run = await drive(ATTENDED, root, homeForAttended);
      expect(published(run)).toBe('PUBLISHED');
    }
  });
});

describe('the grant is refused on the command line before anything is resolved', () => {
  const refusal = (over: Partial<DeliveryCommandInput>): PublicationGrantRefusal | null =>
    refusePublicationGrants({ repository: '/r', task: TASK, ...over } as DeliveryCommandInput);

  it('grades every combination, and grades nothing without the flag', () => {
    expect(refusal({})).toBeNull();
    expect(refusal({ attended: true, drive: true, publishHead: true })).toBeNull();
    expect(refusal({ automaticPublishHeadOnly: true, attended: true })).toBe('PUBLICATION_GRANT_CONFLICT');
    expect(refusal({ automaticPublishHeadOnly: true })).toBe('AUTOMATIC_PUBLICATION_WITHOUT_DRIVE');
    expect(refusal({ automaticPublishHeadOnly: true, drive: true })).toBe('AUTOMATIC_PUBLICATION_WITHOUT_ACT');
    expect(
      refusal({ automaticPublishHeadOnly: true, drive: true, publishHead: true, createPr: true }),
    ).toBe('AUTOMATIC_PUBLICATION_WITH_OTHER_ACT');
    expect(
      refusal({ automaticPublishHeadOnly: true, drive: true, publishHead: true, mergePr: true }),
    ).toBe('AUTOMATIC_PUBLICATION_WITH_OTHER_ACT');
    expect(refusal({ automaticPublishHeadOnly: true, drive: true, publishHead: true })).toBeNull();
  });

  it('has a distinct sentence for every member, and names the flag in each', () => {
    expect(new Set(PUBLICATION_GRANT_REFUSALS).size).toBe(PUBLICATION_GRANT_REFUSALS.length);
    const sentences = PUBLICATION_GRANT_REFUSALS.map((code) => PUBLICATION_GRANT_REFUSAL_DETAIL[code]);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) {
      expect(sentence).toContain('--automatic-publish-head-only');
    }
  });

  it('answers before the repository is resolved, for every refused combination', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    const combinations: readonly (readonly string[])[] = [
      ['--drive', '--publish-head', '--automatic-publish-head-only', '--attended'],
      ['--publish-head', '--automatic-publish-head-only'],
      ['--drive', '--automatic-publish-head-only'],
      ['--drive', '--publish-head', '--automatic-publish-head-only', '--create-pr'],
      ['--drive', '--publish-head', '--automatic-publish-head-only', '--merge-pr'],
    ];
    for (const argv of combinations) {
      const run = await drive(argv, root, home);
      expect(run.exitCode, argv.join(' ')).toBe(EXIT_RUN_INPUT_UNUSABLE);
      // Nothing was resolved, so the refusal cannot have depended on what is in
      // the repository — the property a review measured `--drive`'s own
      // combination check failing.
      expect(run.counts.resolves, argv.join(' ')).toBe(0);
      expect(mutated(run), argv.join(' ')).toBe(0);
      expect(run.out, argv.join(' ')).toContain('Grant        :');
    }
  });

  it('refuses the same combinations whatever is in the repository', async () => {
    // The same command line against a repository with no task state at all. One
    // invocation, one answer.
    const empty = repositoryRoot();
    const home = scratchHome();
    const run = await drive(['--drive', '--publish-head', '--automatic-publish-head-only', '--attended'], empty, home);
    expect(run.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(run.counts.resolves).toBe(0);
  });

  it('registers the flag with the sentence that was pinned', () => {
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    const option = (delivery?.options ?? []).find((o) => o.long === '--automatic-publish-head-only');
    expect(option).toBeDefined();
    expect(option?.required).toBe(false);
    expect(option?.description).toBe(AUTOMATIC_PUBLISH_HEAD_ONLY_OPTION_DESCRIPTION);
    // The name carries none of the five words this build refuses in an option.
    expect(option?.long ?? '').not.toMatch(/force|unattended|adopt|takeover|steal/i);
  });

  it('leaves no operator-facing text saying this act needs an operator', () => {
    // Four surfaces name the grants for the three acts, and every one of them
    // said `--attended` before this slice. Three were sentences a test already
    // pinned; `DRIVE_TRAILER` had no wording pin at all, which is how it went
    // stale unnoticed while it was printed on the very run that publishes.
    //
    // Pinned as a rule and not as a list, because a list goes stale at the next
    // slice: what each of these has to say is that an act needs its own flag AND
    // a grant naming that act, and none of them may say that presence is the
    // only grant for the publication.
    const RULE = 'flag and a grant that names that act';
    for (const [what, text] of [
      ['DRIVE_TRAILER', DRIVE_TRAILER],
      ['SELECTION_TRAILER', SELECTION_TRAILER],
      ['DRIVE_OPTION_DESCRIPTION', DRIVE_OPTION_DESCRIPTION],
      ['SELECT_TASK_OPTION_DESCRIPTION', SELECT_TASK_OPTION_DESCRIPTION],
    ] as const) {
      expect(text, what).toContain(RULE);
      expect(text, what).not.toContain('flag and --attended');
    }
    // And the front page, which names the acts one at a time.
    const front = DELIVERY_COMMAND_DESCRIPTION;
    expect(front).toContain('--publish-head and a grant for that act');
    expect(front).toContain('--automatic-publish-head-only');
    expect(front).not.toContain('With --publish-head and --attended');

    // The top-level `agent-loop --help` page too. It is not exported, so it is
    // read from the live program rather than from a constant — which is the
    // stronger reading anyway: what an operator sees is what commander holds.
    // It said "each needs `--attended` of its own" until this slice, and no test
    // looked at it; `L-V4-12-8` records the last time that cost a false claim.
    const help = buildProgram().description();
    expect(help).toContain('--publish-head');
    expect(help).toContain('--automatic-publish-head-only');
    expect(help).not.toContain('each needs `--attended` of its own');
    expect(help).toContain('a grant');
  });

  it('says the load-bearing things in that sentence', () => {
    const text = AUTOMATIC_PUBLISH_HEAD_ONLY_OPTION_DESCRIPTION;
    expect(text).toContain('NOBODY is present');
    expect(text).toContain('Requires --drive and --publish-head');
    expect(text).toContain('It is not sufficient on its own');
    expect(text).toContain(DELIVERY_AUTOMATION_FILE_NAME);
    expect(text).toContain('ATTENDED_ONLY');
    expect(text).toContain('Nothing in the repository being delivered can make that declaration');
    expect(text).toContain('At most one act is attempted per invocation');
  });
});

describe('the grant reaches one act and stops', () => {
  it('does not open a pull request when the head is already there', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    const run = await drive(AUTOMATIC, root, home, { remoteRef: 'at-head' });
    // Nothing was pushed, because the intended state was already true…
    expect(published(run)).toBe('ALREADY_PUBLISHED');
    expect(run.counts.publish).toBe(0);
    // …and the run stops at the act it may not perform, naming it.
    expect(driven(run)).toBe('ATTENDED_AUTHORITY_REQUIRED');
    expect(run.counts.create).toBe(0);
    expect(run.counts.merge).toBe(0);
    expect(run.out).toContain('--create-pr --attended');
  });

  it('stops after the attempt, and does not go on to the creation', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    const run = await drive(AUTOMATIC, root, home);
    expect(run.counts.publish).toBe(1);
    expect(driven(run)).toBe('EFFECT_ATTEMPTED');
    expect(run.counts.create).toBe(0);
  });

  it('does not merge a green pull request it finds waiting', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    // The one world in which the driver reaches the merge stage: the head is
    // already on the remote, one open pull request has it, and its only check
    // succeeded. An operator passing `--merge-pr --attended` here would merge.
    const run = await drive(AUTOMATIC, root, home, { remoteRef: 'at-head', openPullRequest: true });
    expect(run.counts.merge).toBe(0);
    expect(run.counts.create).toBe(0);
    expect(run.counts.publish).toBe(0);
    // Positive control: the stage really was reached, which is what makes the
    // zero above a measurement rather than a fixture that never got there.
    expect(driven(run)).toBe('ATTENDED_AUTHORITY_REQUIRED');
    expect(run.out).toContain('Next act     : MERGE_PULL_REQUEST');
  });

  it('names both grants for the publication and one for each other act', () => {
    expect(DELIVERY_EFFECT_FLAG.PUBLISH_HEAD).toContain('--automatic-publish-head-only');
    expect(DELIVERY_EFFECT_FLAG.CREATE_PULL_REQUEST).not.toContain('automatic');
    expect(DELIVERY_EFFECT_FLAG.MERGE_PULL_REQUEST).not.toContain('automatic');
  });
});

describe('the subject and the target are established freshly, and bound exactly', () => {
  it('refuses a ref holding another commit, and moves nothing', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    const run = await drive(AUTOMATIC, root, home, { remoteRef: 'other' });
    expect(published(run)).toBe('REF_HOLDS_ANOTHER_COMMIT');
    expect(run.counts.publish).toBe(0);
    expect(driven(run)).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('refuses a remote whose two URLs name different repositories', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    const run = await drive(AUTOMATIC, root, home, { remoteUrlsDiverge: true });
    expect(published(run)).toBe('REMOTE_URLS_DIVERGE');
    expect(run.counts.publish).toBe(0);
  });

  it('refuses a task with no record, and says so about the work rather than the grant', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    declare(home, PERMITTING);
    // No task state at all. The driver's own floor answers, above the ladder, so
    // this measures WHICH answer an unestablished subject gets under a
    // permitting declaration — not the order of the ladder's own steps, which
    // this run never reaches. The ordering inside the ladder is measured by the
    // case below, which reaches it.
    const run = await drive(AUTOMATIC, root, home);
    expect(driven(run)).toBe('SUBJECT_NOT_ESTABLISHED');
    expect(published(run)).toBeNull();
    expect(mutated(run)).toBe(0);
  });

  it('answers the work before the authority, inside the ladder that asks both', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    // A task record that exists and is not finished, named directly so the
    // ladder is reached, and a declaration that would refuse. The ladder must
    // answer about the work: an operator whose task is unfinished is not told to
    // go and write a permission file.
    writeReadyState(root);
    writeNotReadyState(root, 'V4-13-B');
    const run = await drive(['--publish-head'], root, home, { task: 'V4-13-B' });
    expect(published(run)).toBe('TASK_NOT_READY');
    expect(mutated(run)).toBe(0);
    // Control: the same invocation on the finished task reaches the authority
    // step instead, so the member above is the ladder choosing and not the only
    // thing it can say.
    const control = await drive(['--publish-head'], root, home);
    expect(published(control)).toBe('OPERATOR_ABSENT');
  });

  it('does not publish for a delivery that is already concluded', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    writeConclusion(root);
    declare(home, PERMITTING);
    const run = await drive(AUTOMATIC, root, home);
    expect(driven(run)).toBe('DELIVERY_CONCLUDED');
    expect(mutated(run)).toBe(0);
    expect(run.counts.forge).toBe(0);
  });

  it('re-reads the declaration immediately before the remote is contacted', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    // The ladder's read sees a permitting declaration. The second resolve is the
    // one `publishDeliveryHead` makes from inside its own `recheck`, which runs
    // before the URL agreement, before the pre-reading and before the push — so
    // removing the file there is removing it at the last moment this build could
    // still notice.
    //
    // Which resolve that is, is measured rather than guessed: a control run
    // establishes how many this path takes, and the hook fires on the last one.
    // Firing earlier would remove the declaration before the *ladder's* own read
    // and measure that step twice instead of measuring the re-proof at all.
    const control = await drive(AUTOMATIC, root, home);
    expect(published(control)).toBe('PUBLISHED');
    const last = control.counts.resolves;
    expect(last).toBeGreaterThan(1);

    const again = repositoryRoot();
    writeReadyState(again);
    const run = await drive(AUTOMATIC, again, home, {
      onResolve: (n) => {
        if (n === last) removeDeclaration(home);
      },
    });
    expect(published(run)).toBe('AUTOMATIC_PUBLICATION_NOT_DECLARED');
    expect(run.counts.publish).toBe(0);
    expect(run.counts.resolves).toBe(last);
  });

  it('reports a changed repository as a changed subject, not as a missing permission', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    // The declaration covers the repository the ladder resolves. The recheck
    // resolves a different one, which nothing declares — so the re-proof refuses
    // there. The honest report is that the subject moved, and the permission
    // sentence would be a true statement about the wrong event.
    declare(home, PERMITTING);
    const control = await drive(AUTOMATIC, root, home);
    expect(published(control)).toBe('PUBLISHED');
    const last = control.counts.resolves;

    const again = repositoryRoot();
    writeReadyState(again);
    const run = await drive(AUTOMATIC, again, home, { targetMovesAt: last });
    expect(published(run)).toBe('SUBJECT_CHANGED');
    expect(run.counts.publish).toBe(0);
  });

  it('reports the withdrawal only when there was one', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    // The same hook, moving the *subject* instead of the permission: the task
    // record is deleted, so the recheck cannot re-establish it. That must stay
    // `SUBJECT_CHANGED` — the rename is guarded on a withdrawal actually having
    // been recorded, and a subject that moved is not one.
    const control = await drive(AUTOMATIC, root, home);
    expect(published(control)).toBe('PUBLISHED');
    const last = control.counts.resolves;

    const again = repositoryRoot();
    writeReadyState(again);
    const run = await drive(AUTOMATIC, again, home, {
      onResolve: (n) => {
        if (n === last) rmSync(taskRuntimeDirectory(again), { recursive: true, force: true });
      },
    });
    expect(published(run)).toBe('SUBJECT_CHANGED');
    expect(run.counts.publish).toBe(0);
  });
});

describe('an uncertain attempt is never repeated', () => {
  it('pushes once and reads afterwards when the transport fails', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    const run = await drive(AUTOMATIC, root, home, { pushFails: true });
    expect(run.counts.publish).toBe(1);
    // The ref is still absent afterwards, and the honest member says so.
    expect(published(run)).toBe('PUBLICATION_REFUSED');
    expect(driven(run)).toBe('EFFECT_ATTEMPTED');
  });

  it('needs a live permission again on the next invocation, not a stored one', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    const first = await drive(AUTOMATIC, root, home, { pushFails: true });
    expect(first.counts.publish).toBe(1);
    // The declaration goes away between invocations. Nothing was stored by the
    // first one, so the second has no permission at all.
    removeDeclaration(home);
    const second = await drive(AUTOMATIC, root, home);
    expect(published(second)).toBe('AUTOMATIC_PUBLICATION_NOT_DECLARED');
    expect(second.counts.publish).toBe(0);
  });
});

describe('the selection composes, and still authorises nothing', () => {
  it('publishes the task the plan chooses', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeTaskMarkdown(root);
    writeReadyState(root);
    declare(home, PERMITTING);
    const run = await drive([...AUTOMATIC, '--select-task'], root, home, { task: '' });
    expect(run.out).toContain(TASK);
    expect(published(run)).toBe('PUBLISHED');
    expect(run.counts.publish).toBe(1);
  });

  it('publishes nothing for a chosen task whose delivery is concluded', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeTaskMarkdown(root);
    writeReadyState(root);
    writeConclusion(root);
    declare(home, PERMITTING);
    const run = await drive([...AUTOMATIC, '--select-task'], root, home, { task: '' });
    expect(mutated(run)).toBe(0);
  });

  it('selects nothing without the declaration either, and still sends nothing', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeTaskMarkdown(root);
    writeReadyState(root);
    const run = await drive([...AUTOMATIC, '--select-task'], root, home, { task: '' });
    expect(published(run)).toBe('AUTOMATIC_PUBLICATION_NOT_DECLARED');
    expect(mutated(run)).toBe(0);
  });
});

describe('the automatic path writes nothing and waits for nothing', () => {
  it('leaves the runtime directory exactly as it found it', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, PERMITTING);
    const runtime = join(root, '.agent-orchestrator', 'runtime');
    const before = readdirSync(runtime, { recursive: true }).map(String).sort();
    const stateBefore = readFileSync(join(taskRuntimeDirectory(root), `${TASK}.json`), 'utf8');
    const run = await drive(AUTOMATIC, root, home);
    expect(published(run)).toBe('PUBLISHED');
    expect(readdirSync(runtime, { recursive: true }).map(String).sort()).toEqual(before);
    expect(readFileSync(join(taskRuntimeDirectory(root), `${TASK}.json`), 'utf8')).toBe(stateBefore);
  });

  it('names no scheduler, no sleep and no background work', () => {
    for (const file of [
      'src/deliver/delivery-automation.ts',
      'src/cli/delivery-steps.ts',
      'src/cli/delivery-driver.ts',
    ]) {
      const code = codeOnly(file);
      for (const forbidden of ['setTimeout', 'setInterval', 'setImmediate', 'cron', 'Atomics.wait']) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('keeps the declaration module clear of every authority artefact', () => {
    // Deliberately NOT a claim about the automatic *path*: that path runs
    // through `cli/delivery-steps.ts`, which calls all three mints and is the
    // only module in `src/` that may — pinned in
    // `tests/v4-05-delivery-head-publication.test.ts`, unchanged by this slice.
    // What is measured here is that the module deciding the PERMISSION holds no
    // authority artefact of its own, so the permission cannot become one by
    // being read.
    //
    // Scanned on the code alone, so the header may go on explaining which
    // authority this declaration is about — which is the load-bearing part of
    // the design and the first thing a reader needs.
    const code = codeOnly('src/deliver/delivery-automation.ts');
    expect(code).toContain('loadDeliveryAutomation');
    for (const forbidden of [
      'mintHeadPublicationGrant',
      'mintPullRequestCreationGrant',
      'mintMergeGrant',
      'HeadPublicationGrant',
      'MergeGrant',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});

describe('the ladder produces every member the grader cannot', () => {
  it('drives the four authority members for real, and produces exactly them', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    const produced = new Set<HeadPublication>();

    // The four this case is responsible for all need a subject, so the state
    // arrives first. `SUBJECT_NOT_ESTABLISHED` and `TASK_NOT_READY` are the two
    // the ladder shares with every sibling act and are driven in
    // `tests/v4-05-delivery-head-publication.test.ts` and
    // `tests/v4-11-delivery-lifecycle-driver.test.ts`; what is new here, and
    // what would otherwise be a set of enum members nothing produces, is the
    // four below.
    writeReadyState(root);

    // OPERATOR_ABSENT: the act named directly, with no grant. Not under
    // `--drive`, where the driver refuses before the ladder is called.
    produced.add(publicationOf(await drive(['--publish-head'], root, home)));
    // The three authority members.
    produced.add(publicationOf(await drive(AUTOMATIC, root, home)));
    declare(home, DENYING);
    produced.add(publicationOf(await drive(AUTOMATIC, root, home)));
    writeRaw(home, 'schemaVersion: 1\nrepositories: [\n');
    produced.add(publicationOf(await drive(AUTOMATIC, root, home)));

    expect([...produced].sort()).toEqual(
      [
        'AUTOMATIC_PUBLICATION_DENIED',
        'AUTOMATIC_PUBLICATION_NOT_DECLARED',
        'OPERATOR_ABSENT',
        'PUBLICATION_POLICY_UNREADABLE',
      ].sort(),
    );
    // And every one of them really is in the vocabulary, with a sentence of its
    // own that says nothing was attempted.
    for (const member of produced) {
      expect(HEAD_PUBLICATIONS as readonly string[]).toContain(member);
      expect(HEAD_PUBLICATION_DETAIL[member]).toMatch(/nothing was attempted/);
    }
  });
});

function publicationOf(run: Run): HeadPublication {
  const value = published(run);
  if (value === null) throw new Error(`no Publication line in report:\n${run.out}`);
  return value as HeadPublication;
}

/* ── the fence, against a real remote ─────────────────────────────────────── */

function git(cwd: string, ...args: string[]): { status: number; out: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('two unattended publishers cannot both create one ref', () => {
  it('lets exactly one create it, and rejects the other', () => {
    const lab = scratchRoot('ao-v413-fence-');
    const remote = join(lab, 'remote.git');
    const seed = join(lab, 'seed');
    mkdirSync(remote, { recursive: true });
    mkdirSync(seed, { recursive: true });
    expect(git(lab, 'init', '--bare', '--quiet', remote).status).toBe(0);
    expect(git(seed, 'init', '--quiet', '-b', BASE, '.').status).toBe(0);
    git(seed, 'config', 'user.email', 'fixture@example.invalid');
    git(seed, 'config', 'user.name', 'Fixture');
    writeFileSync(join(seed, 'a.txt'), 'a\n', 'utf8');
    git(seed, 'add', 'a.txt');
    expect(git(seed, 'commit', '--quiet', '-m', 'base').status).toBe(0);
    const commit = git(seed, 'rev-parse', 'HEAD').out.trim();
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    git(seed, 'remote', 'add', 'origin', remote);

    // The exact vector. Driven three ways below, because two different
    // mechanisms refuse a publication and calling them one thing is what an
    // earlier draft of this file did.
    const push = (): { status: number; out: string } =>
      git(
        seed,
        '-c',
        'push.followTags=false',
        '-c',
        'push.recurseSubmodules=no',
        '-c',
        'push.gpgSign=false',
        '-c',
        'core.hooksPath=',
        'push',
        '--porcelain',
        '--atomic',
        '--receive-pack=git-receive-pack',
        `--force-with-lease=refs/heads/${BRANCH}:`,
        '--',
        'origin',
        `${commit}:refs/heads/${BRANCH}`,
      );

    const first = push();
    expect(first.status).toBe(0);
    expect(first.out).toContain('[new branch]');

    // A different commit onto the ref the first one created. This one is
    // refused **on this side**: git compares the ref the remote advertised
    // against the empty lease and answers `(stale info)` without sending an
    // update at all. The ref does not move.
    writeFileSync(join(seed, 'b.txt'), 'b\n', 'utf8');
    git(seed, 'add', 'b.txt');
    git(seed, 'commit', '--quiet', '-m', 'second');
    const other = git(seed, 'rev-parse', 'HEAD').out.trim();
    const rejected = git(
      seed,
      '-c',
      'push.followTags=false',
      '-c',
      'core.hooksPath=',
      'push',
      '--porcelain',
      '--atomic',
      `--force-with-lease=refs/heads/${BRANCH}:`,
      '--',
      'origin',
      `${other}:refs/heads/${BRANCH}`,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.out).toContain('rejected');
    expect(git(lab, '--git-dir', remote, 'rev-parse', `refs/heads/${BRANCH}`).out.trim()).toBe(commit);

    // And the measured residual this slice records rather than hides: a second
    // push of the SAME commit onto the ref that already holds it exits 0 and
    // reports `up to date`, without the lease being evaluated at all. In the
    // ladder that case is answered `ALREADY_PUBLISHED` from the pre-reading and
    // no push happens; it is only reachable when somebody creates the ref
    // between this build's reading and its push, where `PUBLISHED` is then
    // claimed by a process that created nothing. `L-V4-13-5`.
    const again = push();
    expect(again.status).toBe(0);
    expect(again.out).toContain('up to date');
  });

  it('lets exactly one of two SIMULTANEOUS creators win, whichever way the loser is refused', async () => {
    // The case the sequential ordering above cannot produce, and the one the
    // absence of an operator makes worth measuring: both publishers are told the
    // ref is absent and both send an update.
    //
    // What is asserted is the invariant, not the interleaving. Two children on a
    // loaded machine may genuinely race — and then the loser is refused by the
    // server's own ref transaction — or they may serialise, and then the loser
    // sees the ref already advertised at this commit and reports `up to date`.
    // Both are safe and both are DIFFERENT from the outcome an operator would
    // be told about, so the case requires the loser's outcome to be one of those
    // two known shapes rather than pinning which. A third shape fails here.
    const shapes = new Set<string>();
    for (let round = 0; round < 5; round += 1) {
      const lab = scratchRoot('ao-v413-race-');
      const remote = join(lab, 'remote.git');
      const seed = join(lab, 'seed');
      mkdirSync(remote, { recursive: true });
      mkdirSync(seed, { recursive: true });
      expect(git(lab, 'init', '--bare', '--quiet', remote).status).toBe(0);
      expect(git(seed, 'init', '--quiet', '-b', BASE, '.').status).toBe(0);
      git(seed, 'config', 'user.email', 'fixture@example.invalid');
      git(seed, 'config', 'user.name', 'Fixture');
      writeFileSync(join(seed, 'a.txt'), `round ${String(round)}\n`, 'utf8');
      git(seed, 'add', 'a.txt');
      expect(git(seed, 'commit', '--quiet', '-m', 'base').status).toBe(0);
      const commit = git(seed, 'rev-parse', 'HEAD').out.trim();

      // Two clones of one object database, so both really can offer the commit
      // and both are told the ref is absent, because it is.
      const clones = [join(lab, 'c1'), join(lab, 'c2')];
      for (const clone of clones) {
        expect(git(lab, 'clone', '--quiet', seed, clone).status).toBe(0);
        git(clone, 'remote', 'set-url', 'origin', remote);
      }

      const args = [
        '-c', 'push.followTags=false',
        '-c', 'push.recurseSubmodules=no',
        '-c', 'push.gpgSign=false',
        '-c', 'core.hooksPath=',
        'push', '--porcelain', '--atomic', '--receive-pack=git-receive-pack',
        `--force-with-lease=refs/heads/${BRANCH}:`,
        '--', 'origin', `${commit}:refs/heads/${BRANCH}`,
      ];
      const results = await Promise.all(
        clones.map(
          (cwd) =>
            new Promise<{ code: number; out: string }>((done) => {
              const child = spawn('git', args, { cwd });
              let out = '';
              child.stdout.on('data', (d: Buffer) => (out += d.toString()));
              child.stderr.on('data', (d: Buffer) => (out += d.toString()));
              child.on('close', (code) => done({ code: code ?? 1, out }));
            }),
        ),
      );

      // Exactly one process created the ref. This is the property that matters
      // and it holds in every interleaving.
      const created = results.filter((r) => r.out.includes('[new branch]'));
      expect(created, results.map((r) => r.out).join('\n---\n')).toHaveLength(1);
      expect(created[0]?.code).toBe(0);

      const loser = results.find((r) => !r.out.includes('[new branch]'));
      const out = loser?.out ?? '';
      const shape =
        loser?.code === 0 && out.includes('up to date')
          ? 'SERIALISED_UP_TO_DATE'
          : loser?.code !== 0 && /rejected|cannot lock ref/.test(out)
            ? 'RACED_REJECTED_BY_SERVER'
            : `UNKNOWN: code=${String(loser?.code)} ${out}`;
      expect(shape.startsWith('UNKNOWN'), shape).toBe(false);
      shapes.add(shape);

      // And whichever it was: one ref, at this commit, and nothing moved.
      expect(git(lab, '--git-dir', remote, 'rev-parse', `refs/heads/${BRANCH}`).out.trim()).toBe(commit);
      expect(
        git(lab, '--git-dir', remote, 'for-each-ref', `refs/heads/${BRANCH}`).out.trim().split('\n'),
      ).toHaveLength(1);
    }
    // A positive control on the loop: at least one round produced a loser at
    // all, so the assertions above ran against something.
    expect(shapes.size).toBeGreaterThan(0);
  });
});
