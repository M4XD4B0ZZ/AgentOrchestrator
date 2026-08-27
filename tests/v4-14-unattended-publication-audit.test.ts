/**
 * V4 slice 14 — durable audit evidence for the one unattended forge act.
 *
 * Slice 13 gave this build a publication it may perform with nobody present.
 * What it did not give it was an answer to "why did this branch appear?" after
 * the fact: the automatic path wrote nothing anywhere, so an operator finding an
 * unexpected work branch had the report of one run, in a terminal that had
 * scrolled away, and nothing else.
 *
 * This suite is written against the five ways a record like that goes wrong.
 *
 *  1. **best-effort accountability.** The single property the slice exists for
 *     is that the record is a *precondition* rather than a side effect. The
 *     load-bearing case blocks the store with a real obstruction and requires
 *     zero pushes — with a publishing control in the same case, so an absence
 *     that came from never getting there cannot pass for a refusal;
 *  2. **a record that claims more than it can.** The record is written before
 *     the delivery remote is contacted at all, so it cannot say a publication
 *     was attempted, cannot say a ref exists, and above all cannot say this
 *     build created one — the last of those is measured false in slice 13 and
 *     the vocabulary here is swept for every word that would imply it;
 *  3. **evidence becoming authority.** A record on disk must license nothing. A
 *     case leaves one behind, withdraws the permission, and requires the next
 *     invocation to refuse; a structural sweep requires the reader to be called
 *     in exactly one module of the source tree, which is not the one that mints
 *     the publication authority;
 *  4. **two invocations sharing one file.** The publication takes no lease and
 *     nothing local fences two unattended runs, so two of them are driven and
 *     required to leave two whole records under two identities, neither
 *     overwriting the other;
 *  5. **the record naming the wrong thing.** Every identity in it — the exact
 *     declaration bytes, the task, the repository, the remote, the ref, the
 *     commit — is asserted against what the run really acted on, and each one is
 *     substituted in turn and required to refuse on the way back in.
 *
 * The push itself is not re-measured here. Its vector, its create-only fence,
 * its grader and the no-retry rule belong to `tests/v4-05-…` and the
 * declaration's own contract to `tests/v4-13-…`.
 */

import { Command } from 'commander';
import { createHash } from 'node:crypto';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildProgram } from '../src/cli/index.js';
import { registerDeliveryCommand } from '../src/cli/delivery-command.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { DELIVERY_AUTOMATION_FILE_NAME, loadDeliveryAutomation, permitsUnattendedHeadPublication, HEAD_PUBLICATION_DECLARATIONS } from '../src/deliver/delivery-automation.js';
import {
  HEAD_PUBLICATION_AUTHORISATION_READINGS,
  HEAD_PUBLICATION_AUTHORISATION_VERSION,
  MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES,
  headPublicationAuthorisationBinding,
  readHeadPublicationAuthorisation,
  type HeadPublicationAuthorisation,
  type HeadPublicationAuthorisationPayload,
  type HeadPublicationAuthorisationSubject,
} from '../src/deliver/head-publication-authorisation.js';
import {
  HEAD_PUBLICATION_AUDIT_CODES,
  HEAD_PUBLICATION_AUDIT_DIR_NAME,
  HEAD_PUBLICATION_AUDIT_FILE_NAME,
  headPublicationAuditRoot,
  newHeadPublicationAuditEventId,
  recordHeadPublicationAuthorisation,
  type HeadPublicationAuditCode,
} from '../src/deliver/head-publication-authorisation-store.js';
import { HEAD_PUBLICATIONS, HEAD_PUBLICATION_DETAIL } from '../src/deliver/head-publication.js';
import { DELIVERY_DRIVES, DELIVERY_DRIVE_DETAIL } from '../src/cli/delivery-driver.js';
import { EXIT_RUN_NEEDS_OPERATOR, exitCodeForDrive } from '../src/cli/run-exit-codes.js';
import { taskRuntimeDirectory } from '../src/state/state-location.js';
import { loadTaskState, saveTaskState } from '../src/state/state-store.js';
import { validReadyForPrState } from './fixtures.js';

/* ── source sweeps ────────────────────────────────────────────────────────── */

function walkSource(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkSource(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

/**
 * Source with comments blanked, so a sweep measures code rather than prose.
 *
 * The same stripper the sibling slice files use, and it is needed here for the
 * same reason: these headers deliberately name the very claims they refuse to
 * make, and a sweep over raw text would forbid explaining the design.
 */
function codeOnly(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/gm, '$1 ');
}

/* ── scratch ──────────────────────────────────────────────────────────────── */

const roots: string[] = [];

function scratchRoot(prefix = 'ao-v414-'): string {
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

const TASK = 'V4-14';
/** H — the exact commit a publication is about. */
const HEAD = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
const BASE = 'main';
const BRANCH = 'ao/task/V4-14';
const REF = `refs/heads/${BRANCH}`;
const AT = '2026-08-27T12:00:00.000Z';
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

/** The same forge repository, declared under a different local remote name. */
const MOVED_REMOTE = Object.freeze({
  declared: true,
  remoteName: 'upstream',
  result: Object.freeze({
    outcome: 'RESOLVED',
    target: Object.freeze({ provider: 'github', ...IDENTITY }),
  }),
});

/** A remote URL carrying credentials, which no record may ever contain. */
const SECRET_URL = 'https://a-user:a-secret-token@github.com/M4XD4B0ZZ/AgentOrchestrator.git';

/* ── the operator's home, and the declaration in it ───────────────────────── */

function scratchHome(): string {
  const home = scratchRoot('ao-v414-home-');
  mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
  return home;
}

function declarationPath(home: string): string {
  return join(home, '.agent-orchestrator', DELIVERY_AUTOMATION_FILE_NAME);
}

function declare(home: string, text: string): void {
  writeFileSync(declarationPath(home), text, 'utf8');
}

function permitting(over: { readonly permission?: string; readonly extra?: string } = {}): string {
  return [
    'schemaVersion: 1',
    'repositories:',
    `  - host: ${IDENTITY.host}`,
    `    owner: ${IDENTITY.owner}`,
    `    name: ${IDENTITY.name}`,
    `    headPublication: ${over.permission ?? 'AUTOMATIC_ALLOWED'}`,
    ...(over.extra === undefined ? [] : [over.extra]),
    '',
  ].join('\n');
}

/** An entry for a repository nobody in this suite delivers. */
const ANOTHER_REPOSITORY = [
  'schemaVersion: 1',
  'repositories:',
  `  - host: ${IDENTITY.host}`,
  `    owner: ${IDENTITY.owner}`,
  '    name: some-other-project',
  '    headPublication: AUTOMATIC_ALLOWED',
  '',
].join('\n');

/* ── the store, read back the way an operator would ───────────────────────── */

function auditRoot(home: string): string {
  return headPublicationAuditRoot(fixedPathProvider(home));
}

function eventIds(home: string): string[] {
  try {
    return readdirSync(auditRoot(home), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function recordPath(home: string, eventId: string): string {
  return join(auditRoot(home), eventId, HEAD_PUBLICATION_AUDIT_FILE_NAME);
}

function recordBytes(home: string, eventId: string): Buffer {
  return readFileSync(recordPath(home, eventId));
}

/**
 * Every event directory that really holds a record.
 *
 * A directory with no record file in it is not a record and is not counted as
 * one — which is the reader's own rule: it opens the name and never enumerates,
 * so an event whose write did not complete is invisible rather than partial.
 */
function recordsIn(home: string): HeadPublicationAuthorisation[] {
  const out: HeadPublicationAuthorisation[] = [];
  for (const id of eventIds(home)) {
    let bytes: Buffer;
    try {
      bytes = recordBytes(home, id);
    } catch {
      continue;
    }
    out.push(JSON.parse(bytes.toString('utf8')) as HeadPublicationAuthorisation);
  }
  return out;
}

/** The one record this run left, or a failure naming how many there were. */
function onlyRecord(home: string): HeadPublicationAuthorisation {
  const all = recordsIn(home);
  expect(all.length, `expected exactly one audit record, found ${all.length}`).toBe(1);
  return all[0] as HeadPublicationAuthorisation;
}

/* ── a repository, and one finished task in it ───────────────────────────── */

const TASK_DIR = 'tasks';

function repositoryRoot(): string {
  const root = scratchRoot();
  mkdirSync(join(root, TASK_DIR), { recursive: true });
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  return root;
}

function writeReadyState(
  root: string,
  over: { readonly taskId?: string; readonly commit?: string; readonly branch?: string } = {},
): void {
  const saved = saveTaskState(
    validReadyForPrState({
      taskId: over.taskId ?? TASK,
      repositoryRoot: root,
      worktreePath: join(root, over.taskId ?? TASK),
      baseBranch: BASE,
      workBranch: over.branch ?? BRANCH,
      currentCommit: over.commit ?? HEAD,
      basePinnedCommit: OTHER,
      stateEnteredAt: AT,
    }),
    { repositoryRoot: root },
  );
  if (!saved.ok) throw new Error(`fixture state not saved: ${saved.code}`);
}

/**
 * Moves the task under a run that is already in flight.
 *
 * The revision has to be read first: `saveTaskState` refuses an overwrite
 * without one, which is the optimistic concurrency this repository's state store
 * is built on and is not something a fixture may work around.
 */
function moveReadyState(root: string, over: { readonly commit?: string; readonly branch?: string }): void {
  const loaded = loadTaskState(root, TASK);
  if (!loaded.ok) throw new Error(`fixture state not read: ${loaded.code}`);
  const saved = saveTaskState(
    validReadyForPrState({
      taskId: TASK,
      repositoryRoot: root,
      worktreePath: join(root, TASK),
      baseBranch: BASE,
      workBranch: over.branch ?? BRANCH,
      currentCommit: over.commit ?? HEAD,
      basePinnedCommit: OTHER,
      stateEnteredAt: AT,
    }),
    { repositoryRoot: root, expectedRevision: loaded.revision },
  );
  if (!saved.ok) throw new Error(`fixture state not moved: ${saved.code}`);
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
  /** Every Git question about the remote: both get-url calls and the ls-remote. */
  remoteReads: number;
}

interface Run {
  readonly out: string;
  readonly exitCode: number | undefined;
  readonly counts: Counts;
  readonly pushVectors: readonly (readonly string[])[];
}

/**
 * Drives the real registered CLI over a real repository and a real scratch home.
 *
 * The audit store is **not** a seam: the records this suite reads are the ones
 * the production module wrote, into a real directory, through the real
 * exclusive creation and the real crash-safe write.
 */
async function drive(
  argv: readonly string[],
  root: string,
  home: string,
  over: {
    readonly remoteRef?: 'absent' | 'at-head' | 'other';
    readonly pushFails?: boolean;
    readonly onResolve?: (n: number) => void;
    readonly task?: string;
    /** What Git answers about a repository-relative path. */
    readonly checkIgnored?: 'IGNORED' | 'NOT_IGNORED' | 'UNDETERMINED';
    /**
     * From this resolve onwards the resolver answers a different repository
     * root, which must hold the same task at the same commit.
     *
     * The one way to separate "the root this pass resolved" from "the root the
     * publication runs Git in": `publishDeliveryHead` is given the ladder's
     * root and never the re-check's, so a record built from the re-check's
     * would name a checkout the publication was never run in.
     */
    readonly rootMovesAt?: number;
    /** The root {@link rootMovesAt} switches to. Must hold the same task. */
    readonly otherRoot?: string;
    /**
     * From this resolve onwards the repository declares a different remote NAME
     * for the same forge identity.
     *
     * The one way a case can move the publication subject underneath a standing
     * permission: the identity is unchanged, so the declaration still permits,
     * and the grant the ladder minted names a remote the re-check no longer
     * resolves.
     */
    readonly remoteMovesAt?: number;
  } = {},
): Promise<Run> {
  const counts: Counts = {
    forge: 0,
    publish: 0,
    create: 0,
    merge: 0,
    resolves: 0,
    remoteReads: 0,
  };
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
            root:
              over.rootMovesAt !== undefined && counts.resolves >= over.rootMovesAt && over.otherRoot !== undefined
                ? over.otherRoot
                : root,
            gitCommonDir: join(root, '.git'),
            taskSource: { kind: 'MARKDOWN_DIRECTORY', path: TASK_DIR },
            verification: { phases: [] },
            delivery:
              over.remoteMovesAt !== undefined && counts.resolves >= over.remoteMovesAt
                ? MOVED_REMOTE
                : DECLARED_TARGET,
          },
        };
      }) as never,
      runner: (async (_command: string, args: readonly string[]) => {
        counts.forge += 1;
        const path = args.find((a) => a.startsWith('repos/')) ?? args.join(' ');
        if (/\/pulls\/\d+$/.test(path)) return commandResult({ exitCode: 1, stdout: '{}' });
        if (path.endsWith('/pulls')) return commandResult({ stdout: '[]' });
        if (path.endsWith('/check-runs')) {
          return commandResult({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) });
        }
        return commandResult({
          stdout: JSON.stringify({ sha: HEAD, state: 'success', total_count: 0, statuses: [] }),
        });
      }) as never,
      publicationRunner: (async (args: readonly string[]) => {
        const joined = args.join(' ');
        // A credential-bearing URL on both reads, so "no secret reaches the
        // record" is measured against a secret that really was in reach.
        if (joined.includes('remote get-url')) {
          counts.remoteReads += 1;
          return commandResult({ stdout: SECRET_URL });
        }
        if (joined.includes('ls-remote')) {
          counts.remoteReads += 1;
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
      checkIgnored: (async () => over.checkIgnored ?? 'IGNORED') as never,
      now: () => new Date(AT),
    });
    const named = over.task === undefined ? ['--task', TASK] : ['--task', over.task];
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

const published = (run: Run): string | null => lineOf(run, 'Publication');
const driven = (run: Run): string | null => lineOf(run, 'Drive');

const AUTOMATIC = ['--drive', '--publish-head', '--automatic-publish-head-only'];
const ATTENDED = ['--drive', '--publish-head', '--attended'];

/** Occupies the store root's own name with an ordinary file. */
function blockStore(home: string): void {
  writeFileSync(join(home, '.agent-orchestrator', HEAD_PUBLICATION_AUDIT_DIR_NAME), 'x', 'utf8');
}

/* ── a record built by hand, for the reader's own cases ───────────────────── */

const SUBJECT: HeadPublicationAuthorisationSubject = Object.freeze({
  eventId: '20260827T120000000Z-11111111-2222-4333-8444-555555555555',
  taskId: TASK,
  repositoryRoot: 'C:\\scratch\\repo',
});

function payloadFor(
  over: Partial<HeadPublicationAuthorisationPayload> = {},
): HeadPublicationAuthorisationPayload {
  return {
    authorisationVersion: HEAD_PUBLICATION_AUTHORISATION_VERSION as 1,
    eventId: SUBJECT.eventId,
    act: 'HEAD_PUBLICATION',
    invocationMode: 'AUTOMATIC',
    taskId: SUBJECT.taskId,
    repositoryRoot: SUBJECT.repositoryRoot,
    host: IDENTITY.host,
    owner: IDENTITY.owner,
    name: IDENTITY.name,
    declaredRemote: 'origin',
    ref: REF,
    commit: HEAD,
    declarationSchemaVersion: 1,
    declaredPermission: 'AUTOMATIC_ALLOWED',
    declarationDigest: 'b'.repeat(64),
    authorisedAt: AT,
    ...over,
  };
}

function bytesFor(
  payload: HeadPublicationAuthorisationPayload,
  subject: HeadPublicationAuthorisationSubject = SUBJECT,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      { ...payload, binding: headPublicationAuthorisationBinding(subject, payload) },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */

describe('the record is a precondition of the act, not a note about it', () => {
  it('publishes once and leaves exactly one record naming what it published', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    const run = await drive(AUTOMATIC, root, home);

    expect(published(run)).toBe('PUBLISHED');
    expect(run.counts.publish).toBe(1);

    const record = onlyRecord(home);
    expect(record.act).toBe('HEAD_PUBLICATION');
    expect(record.invocationMode).toBe('AUTOMATIC');
    expect(record.taskId).toBe(TASK);
    expect(record.repositoryRoot).toBe(root);
    expect(record.host).toBe(IDENTITY.host);
    expect(record.owner).toBe(IDENTITY.owner);
    expect(record.name).toBe(IDENTITY.name);
    expect(record.declaredRemote).toBe('origin');
    expect(record.ref).toBe(REF);
    expect(record.commit).toBe(HEAD);
    expect(record.declaredPermission).toBe('AUTOMATIC_ALLOWED');
    expect(record.authorisedAt).toBe(AT);

    // And it really is the subject the push carried, rather than a second
    // opinion assembled beside it.
    const vector = run.pushVectors[0] as readonly string[];
    expect(vector).toContain(`${record.commit}:${record.ref}`);
    expect(vector).toContain(record.declaredRemote);
  });

  it('sends nothing when the record cannot be written, and would have sent otherwise', async () => {
    const root = repositoryRoot();

    // The control first, so the absence below is attributable to the store and
    // not to a fixture that never reached the publication at all.
    const working = scratchHome();
    declare(working, permitting());
    const control = await drive(AUTOMATIC, root, working);
    writeReadyState(root);
    const controlAgain = await drive(AUTOMATIC, root, working);
    expect(controlAgain.counts.publish).toBe(1);
    expect(control.counts.publish + controlAgain.counts.publish).toBeGreaterThan(0);

    const blocked = scratchHome();
    declare(blocked, permitting());
    blockStore(blocked);

    const run = await drive(AUTOMATIC, root, blocked);

    expect(run.counts.publish).toBe(0);
    expect(run.counts.create).toBe(0);
    expect(run.counts.merge).toBe(0);
    expect(published(run)).toBe('PUBLICATION_AUDIT_UNWRITTEN');
    expect(driven(run)).toBe('PUBLICATION_AUDIT_NOT_DURABLE');
    expect(run.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
    expect(recordsIn(blocked)).toEqual([]);
  });

  it('writes the record before the remote is contacted at all', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());
    blockStore(home);

    // The control, so the counter below is known to be able to move.
    const working = scratchHome();
    declare(working, permitting());
    const control = await drive(AUTOMATIC, root, working);
    expect(published(control)).toBe('PUBLISHED');
    // Four, and counted rather than bounded: the two `git remote get-url`
    // calls, the pre-reading `ls-remote` and the reading taken afterwards. A
    // looser control would be satisfied by one `ls-remote` alone, and would not
    // notice if the get-url half of the counter had stopped matching its vector.
    expect(control.counts.remoteReads).toBe(4);

    const run = await drive(AUTOMATIC, root, home);

    // Not merely "no push": nothing was READ from the remote either. The two
    // `git remote get-url` calls and the `ls-remote` all come after the record,
    // so a run that refused here cannot have asked the remote anything — and
    // that is counted rather than argued from the ordering.
    expect(run.counts.remoteReads).toBe(0);
    expect(run.pushVectors).toEqual([]);
    expect(published(run)).toBe('PUBLICATION_AUDIT_UNWRITTEN');
  });

  it('leaves the repository exactly as it found it, record or no record', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());
    const runtime = join(root, '.agent-orchestrator', 'runtime');
    const before = readdirSync(runtime, { recursive: true }).map(String).sort();
    const stateBefore = readFileSync(join(taskRuntimeDirectory(root), `${TASK}.json`), 'utf8');

    const run = await drive(AUTOMATIC, root, home);

    expect(published(run)).toBe('PUBLISHED');
    expect(readdirSync(runtime, { recursive: true }).map(String).sort()).toEqual(before);
    expect(readFileSync(join(taskRuntimeDirectory(root), `${TASK}.json`), 'utf8')).toBe(stateBefore);
    // The record is outside the repository, and this is where that is measured
    // rather than argued: the only thing this run wrote is under the operator's
    // own profile.
    expect(recordsIn(home).length).toBe(1);
  });

  it('publishes attended with no record, no store and a declaration that denies', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting({ permission: 'ATTENDED_ONLY' }));
    blockStore(home);

    const run = await drive(ATTENDED, root, home);

    expect(published(run)).toBe('PUBLISHED');
    expect(run.counts.publish).toBe(1);
    // The attended path does not reach the store, so the blocked one above
    // cannot refuse it — and it writes nothing there either.
    expect(recordsIn(home)).toEqual([]);
  });

  it('writes a record for a run that finds the head already there and sends nothing', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    const run = await drive(AUTOMATIC, root, home, { remoteRef: 'at-head' });

    expect(published(run)).toBe('ALREADY_PUBLISHED');
    expect(run.counts.publish).toBe(0);
    // A durable record and no effect is a valid historical shape, and it is the
    // ordinary one: the record says an unattended publication was permitted and
    // about to be entered, which is exactly what happened.
    const record = onlyRecord(home);
    expect(record.commit).toBe(HEAD);
  });
});

describe('the record names the exact declaration it acted under', () => {
  it('carries the digest of the bytes on disk, and nothing else from the file', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    const text = permitting({ extra: '# a comment the operator wrote' });
    declare(home, text);

    await drive(AUTOMATIC, root, home);

    const record = onlyRecord(home);
    expect(record.declarationDigest).toBe(
      createHash('sha256').update(readFileSync(declarationPath(home))).digest('hex'),
    );
    expect(record.declarationSchemaVersion).toBe(1);
    // The digest is of the file, and the file is not in the record.
    const serialised = recordBytes(home, eventIds(home)[0] as string).toString('utf8');
    expect(serialised).not.toContain('schemaVersion');
    expect(serialised).not.toContain('# a comment');
  });

  it('changes the digest when the file changes, including in ways the parse forgives', async () => {
    const root = repositoryRoot();
    writeReadyState(root);

    const digests: string[] = [];
    for (const text of [
      permitting(),
      permitting({ extra: '# a trailing comment' }),
      `${permitting()}\n`,
      permitting().replace(/\n/g, '\r\n'),
    ]) {
      const home = scratchHome();
      declare(home, text);
      const run = await drive(AUTOMATIC, root, home);
      expect(published(run)).toBe('PUBLISHED');
      digests.push(onlyRecord(home).declarationDigest);
    }

    // All four documents parse to the same permission and all four produce a
    // different digest. That is the claim stated exactly: the digest says
    // "these bytes", never "this meaning".
    expect(new Set(digests).size).toBe(digests.length);
  });

  it('takes the digest from the bytes, not from this build’s reading of them', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    // A declaration this build accepts whose bytes are not valid UTF-8: the two
    // stray bytes sit in a trailing comment, so the document still parses and
    // still permits. Decoding them replaces both with one replacement
    // character, so a digest taken after a decode is a different number — and
    // it would be a claim about this build's reading rather than about the
    // operator's file.
    const bytes = Buffer.concat([
      Buffer.from(`${permitting()}# tail: `, 'utf8'),
      Buffer.from([0xff, 0xfe, 0x0a]),
    ]);
    writeFileSync(declarationPath(home), bytes);

    const run = await drive(AUTOMATIC, root, home);

    expect(published(run)).toBe('PUBLISHED');
    const record = onlyRecord(home);
    const overBytes = createHash('sha256').update(bytes).digest('hex');
    const overText = createHash('sha256').update(bytes.toString('utf8')).digest('hex');
    expect(overBytes).not.toBe(overText);
    expect(record.declarationDigest).toBe(overBytes);
  });

  it('copies no entry the permission did not come from', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(
      home,
      [
        'schemaVersion: 1',
        'repositories:',
        '  - host: github.com',
        '    owner: someone-else',
        '    name: a-private-project',
        '    headPublication: AUTOMATIC_ALLOWED',
        `  - host: ${IDENTITY.host}`,
        `    owner: ${IDENTITY.owner}`,
        `    name: ${IDENTITY.name}`,
        '    headPublication: AUTOMATIC_ALLOWED',
        '',
      ].join('\n'),
    );

    await drive(AUTOMATIC, root, home);

    const serialised = recordBytes(home, eventIds(home)[0] as string).toString('utf8');
    expect(serialised).not.toContain('someone-else');
    expect(serialised).not.toContain('a-private-project');
  });

  it('records the permission member that the grader answers ALLOWED for, and only that one', () => {
    // The record writes `AUTOMATIC_ALLOWED` as a constant, and this is what
    // makes that constant true rather than convenient: over the whole
    // declaration vocabulary, exactly one member grades to ALLOWED.
    const allowed = HEAD_PUBLICATION_DECLARATIONS.filter((member) => {
      const declaration = {
        state: 'DECLARED' as const,
        declarationDigest: 'c'.repeat(64),
        repositories: [{ ...IDENTITY, headPublication: member }],
      };
      return permitsUnattendedHeadPublication(declaration, IDENTITY) === 'ALLOWED';
    });
    expect(allowed).toEqual(['AUTOMATIC_ALLOWED']);
  });

  it('writes nothing when the declaration does not permit, whichever way it does not', async () => {
    const root = repositoryRoot();
    writeReadyState(root);

    for (const text of [
      permitting({ permission: 'ATTENDED_ONLY' }),
      ANOTHER_REPOSITORY,
      'schemaVersion: 1\nrepositories: [\n',
      'schemaVersion: 2\nrepositories: []\n',
    ]) {
      const home = scratchHome();
      declare(home, text);
      const run = await drive(AUTOMATIC, root, home);
      expect(run.counts.publish, text).toBe(0);
      expect(recordsIn(home), text).toEqual([]);
    }

    // And with no declaration at all.
    const empty = scratchHome();
    const run = await drive(AUTOMATIC, root, empty);
    expect(run.counts.publish).toBe(0);
    expect(recordsIn(empty)).toEqual([]);
  });

  it('writes nothing for a subject the authority was not minted for', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    // A control run first, to learn which resolution the re-check performs.
    const control = await drive(AUTOMATIC, root, home);
    expect(published(control)).toBe('PUBLISHED');
    const resolves = control.counts.resolves;

    // Now the repository declares a different remote NAME from the re-check's
    // own resolution onwards. The forge identity is unchanged, so the
    // declaration still permits and the authority is still established — but
    // the subject in front of this pass is not the one the grant was minted
    // for, and the effect refuses it a step later.
    const later = scratchHome();
    declare(later, permitting());
    const run = await drive(AUTOMATIC, root, later, { remoteMovesAt: resolves });

    expect(run.counts.resolves).toBe(resolves);
    expect(published(run)).toBe('SUBJECT_CHANGED');
    expect(run.counts.publish).toBe(0);
    // The record would otherwise name `upstream` — a remote no grant in this
    // build ever authorised a publication to.
    expect(recordsIn(later)).toEqual([]);
    expect(eventIds(later)).toEqual([]);
  });

  it('writes nothing for a repository root the publication is not run in', async () => {
    const root = repositoryRoot();
    const twin = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    // The same task, at the same commit, on the same branch, in a second
    // checkout. Everything the six subject fields compare is identical; the only
    // difference is which directory the record would name.
    writeReadyState(twin);
    declare(home, permitting());

    const control = await drive(AUTOMATIC, root, home);
    expect(published(control)).toBe('PUBLISHED');
    const resolves = control.counts.resolves;

    const later = scratchHome();
    declare(later, permitting());
    const run = await drive(AUTOMATIC, root, later, {
      remoteRef: 'absent',
      rootMovesAt: resolves,
      otherRoot: twin,
    });

    expect(published(run)).toBe('SUBJECT_CHANGED');
    expect(run.counts.publish).toBe(0);
    // Without the seventh comparison the record would name `twin`, while the
    // publication would have run Git in `root`.
    expect(recordsIn(later)).toEqual([]);
  });

  it('writes nothing for a commit the authority was not minted for', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    const control = await drive(AUTOMATIC, root, home);
    expect(published(control)).toBe('PUBLISHED');
    const resolves = control.counts.resolves;

    // The task advances between the ladder's reading and the re-check's — the
    // exact window the re-check exists for, and the one another process holding
    // this repository's execution lease can produce.
    const later = scratchHome();
    declare(later, permitting());
    const run = await drive(AUTOMATIC, root, later, {
      remoteRef: 'absent',
      onResolve: (n) => {
        if (n === resolves) moveReadyState(root, { commit: OTHER });
      },
    });

    expect(published(run)).toBe('SUBJECT_CHANGED');
    expect(run.counts.publish).toBe(0);
    expect(recordsIn(later)).toEqual([]);
  });

  it('writes nothing for a ref the authority was not minted for', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    const control = await drive(AUTOMATIC, root, home);
    expect(published(control)).toBe('PUBLISHED');
    const resolves = control.counts.resolves;

    // The work branch moves, so the publishable ref this pass derives is not the
    // one the grant carries — while the commit and every identity are unchanged.
    const later = scratchHome();
    declare(later, permitting());
    const run = await drive(AUTOMATIC, root, later, {
      remoteRef: 'absent',
      onResolve: (n) => {
        if (n === resolves) moveReadyState(root, { branch: `${BRANCH}-moved` });
      },
    });

    expect(published(run)).toBe('SUBJECT_CHANGED');
    expect(run.counts.publish).toBe(0);
    expect(recordsIn(later)).toEqual([]);
  });

  it('writes nothing when the permission is withdrawn between the two readings', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    // A control run first, to learn how many repository resolutions this path
    // takes. The last one is the re-proof's own, strictly after the ladder read
    // the declaration — so removing the file on that resolve is the only way to
    // put the two readings on opposite sides of a withdrawal.
    const control = await drive(AUTOMATIC, root, home);
    expect(published(control)).toBe('PUBLISHED');
    const resolves = control.counts.resolves;

    const later = scratchHome();
    declare(later, permitting());
    const run = await drive(AUTOMATIC, root, later, {
      remoteRef: 'absent',
      onResolve: (n) => {
        if (n === resolves) rmSync(declarationPath(later), { force: true });
      },
    });

    expect(run.counts.resolves).toBe(resolves);
    expect(published(run)).toBe('AUTOMATIC_PUBLICATION_NOT_DECLARED');
    expect(run.counts.publish).toBe(0);
    // The ordering is what this measures. A record written before the re-proof
    // would exist here, naming a permission that had already gone.
    expect(recordsIn(later)).toEqual([]);
    expect(eventIds(later)).toEqual([]);
  });

  it('cannot be satisfied by a declaration the repository being delivered carries', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    // The same permitting bytes, in every place the work being delivered can
    // write, and nowhere the operator's profile would look.
    writeFileSync(join(root, DELIVERY_AUTOMATION_FILE_NAME), permitting(), 'utf8');
    writeFileSync(join(root, '.agent-orchestrator', DELIVERY_AUTOMATION_FILE_NAME), permitting(), 'utf8');

    const run = await drive(AUTOMATIC, root, home);

    expect(run.counts.publish).toBe(0);
    expect(recordsIn(home)).toEqual([]);
    expect(published(run)).toBe('AUTOMATIC_PUBLICATION_NOT_DECLARED');
  });
});

describe('the record claims what happened before it, and nothing after it', () => {
  it('has no field, and no vocabulary, that could be read as an effect', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());
    await drive(AUTOMATIC, root, home);

    const record = onlyRecord(home);
    const keys = Object.keys(record);
    for (const forbidden of [
      'published',
      'attempted',
      'attempt',
      'outcome',
      'result',
      'created',
      'createdBy',
      'state',
      'phase',
      'status',
      'expiresAt',
      'retryAfter',
      'pending',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    // No member of the publication grader is copied in either — the record must
    // not be able to say `PUBLISHED` about itself.
    const serialised = JSON.stringify(record);
    for (const member of HEAD_PUBLICATIONS) {
      expect(serialised, member).not.toContain(member);
    }
  });

  it('carries no URL, no credential and no subprocess output', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());
    const run = await drive(AUTOMATIC, root, home);
    expect(run.counts.publish).toBe(1);

    const serialised = recordBytes(home, eventIds(home)[0] as string).toString('utf8');
    for (const forbidden of ['a-secret-token', SECRET_URL, 'https://', 'http://', '@github.com', '.git']) {
      expect(serialised, forbidden).not.toContain(forbidden);
    }
  });

  it('says in its own sentence that nothing was attempted', () => {
    expect(HEAD_PUBLICATION_DETAIL.PUBLICATION_AUDIT_UNWRITTEN).toMatch(/nothing was attempted/);
    expect(HEAD_PUBLICATION_DETAIL.PUBLICATION_AUDIT_UNWRITTEN.length).toBeGreaterThan(40);
    expect(DELIVERY_DRIVE_DETAIL.PUBLICATION_AUDIT_NOT_DURABLE).toMatch(/nothing was attempted/);
    expect(DELIVERY_DRIVES as readonly string[]).toContain('PUBLICATION_AUDIT_NOT_DURABLE');
    expect(exitCodeForDrive('PUBLICATION_AUDIT_NOT_DURABLE')).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('never claims this build created the ref, anywhere in the slice-14 surface', () => {
    for (const file of [
      'src/deliver/head-publication-authorisation.ts',
      'src/deliver/head-publication-authorisation-store.ts',
    ]) {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of ['CREATED_BY_AO', 'createdByAo', 'BRANCH_CREATED', 'PUBLICATION_ATTEMPTED']) {
        expect(text, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('a record is evidence and never authority', () => {
  it('does not let a previous record publish under a permission that has gone', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    const first = await drive(AUTOMATIC, root, home);
    expect(first.counts.publish).toBe(1);
    const before = eventIds(home);
    expect(before.length).toBe(1);

    // The permission is withdrawn and the world is put back to "not published".
    declare(home, permitting({ permission: 'ATTENDED_ONLY' }));
    const second = await drive(AUTOMATIC, root, home, { remoteRef: 'absent' });

    expect(second.counts.publish).toBe(0);
    expect(published(second)).toBe('AUTOMATIC_PUBLICATION_DENIED');
    // The old record is still there, unchanged, and it authorised nothing.
    expect(eventIds(home)).toEqual(before);
  });

  it('does not let a previous record publish for an invocation that did not ask', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());
    await drive(AUTOMATIC, root, home);
    expect(eventIds(home).length).toBe(1);

    const second = await drive(['--drive', '--publish-head'], root, home, { remoteRef: 'absent' });

    expect(second.counts.publish).toBe(0);
    expect(eventIds(home).length).toBe(1);
  });

  it('is read in exactly one module of the source tree, and not by the minter', () => {
    const all = walkSource('src');
    // The rule rather than the list. Slice 14 pinned an exact two-element array
    // here; slice 15 added an operator-facing reader and the array would have had
    // to be widened by hand every time — a literal that goes stale is a pin that
    // guards nothing. What must hold is that no module which decides whether a
    // publication may happen reads a stored record, whichever modules do.
    const readers = all.filter((file) =>
      /\b(?:read|inspect)HeadPublicationAuthorisation\s*\(/.test(codeOnly(file)),
    );
    // A positive control: the contract's own module and its writer are both
    // still in there, so an empty or collapsed match cannot pass this for free.
    expect(readers).toContain('src/deliver/head-publication-authorisation.ts');
    expect(readers).toContain('src/deliver/head-publication-authorisation-store.ts');
    for (const file of readers) {
      expect(file, `${file} decides publications and must not read a record`).not.toMatch(
        /delivery-steps|delivery-driver|publish-delivery-head|git-head-publisher|head-publication-grant|delivery-automation/,
      );
    }

    // The module that mints the publication authority writes records and never
    // reads one. A reader there would be the shape this rule exists to forbid.
    const steps = codeOnly('src/cli/delivery-steps.ts');
    expect(steps).toContain('recordHeadPublicationAuthorisation');
    expect(steps).not.toContain('readHeadPublicationAuthorisation');
    expect(codeOnly('src/cli/delivery-driver.ts')).not.toContain('HeadPublicationAuthorisation');
  });

  it('holds no authority artefact of its own', () => {
    for (const file of [
      'src/deliver/head-publication-authorisation.ts',
      'src/deliver/head-publication-authorisation-store.ts',
    ]) {
      const code = codeOnly(file);
      for (const forbidden of [
        'mintHeadPublicationGrant',
        'mintPullRequestCreationGrant',
        'mintMergeGrant',
        'HeadPublicationGrant',
        'MergeGrant',
        'claimHeadPublication',
        'publishDeliveryHead',
      ]) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('names no scheduler, no sleep and no background work', () => {
    for (const file of [
      'src/deliver/head-publication-authorisation.ts',
      'src/deliver/head-publication-authorisation-store.ts',
    ]) {
      const code = codeOnly(file);
      for (const forbidden of ['setTimeout', 'setInterval', 'setImmediate', 'cron', 'Atomics.wait']) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('two unattended invocations cannot share one record', () => {
  it('leaves two whole records under two identities', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    // Two runs against the same repository, task, remote, ref and commit, on a
    // clock pinned to one instant — so the only thing that can separate the two
    // records is the identity the store mints.
    const first = await drive(AUTOMATIC, root, home, { remoteRef: 'at-head' });
    const second = await drive(AUTOMATIC, root, home, { remoteRef: 'at-head' });

    expect(published(first)).toBe('ALREADY_PUBLISHED');
    expect(published(second)).toBe('ALREADY_PUBLISHED');

    const ids = eventIds(home);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(
        readHeadPublicationAuthorisation(recordBytes(home, id), {
          eventId: id,
          taskId: TASK,
          repositoryRoot: root,
        }),
      ).toBe('HISTORICAL_AUTHORISATION');
    }
  });

  it('refuses a name already taken rather than reusing it', () => {
    const home = scratchHome();
    const eventId = newHeadPublicationAuditEventId(new Date(AT));
    const request = {
      eventId,
      taskId: TASK,
      repositoryRoot: 'C:\\scratch\\repo',
      ...IDENTITY,
      declaredRemote: 'origin',
      ref: REF,
      commit: HEAD,
      declarationDigest: 'b'.repeat(64),
      authorisedAt: AT,
      pathProvider: fixedPathProvider(home),
    };

    expect(recordHeadPublicationAuthorisation(request).code).toBe('RECORDED');
    const bytes = readFileSync(recordPath(home, eventId));

    const again = recordHeadPublicationAuthorisation({ ...request, commit: OTHER });

    expect(again.code).toBe('EVENT_NAME_TAKEN');
    expect(again.recorded).toBe(false);
    // Nothing was replaced: the first record is byte-identical afterwards.
    expect(readFileSync(recordPath(home, eventId))).toEqual(bytes);
  });

  it('mints a different identity every time, for one instant', () => {
    const at = new Date(AT);
    const ids = Array.from({ length: 64 }, () => newHeadPublicationAuditEventId(at));
    expect(new Set(ids).size).toBe(ids.length);
    // The instant really is shared, so the uniqueness above is the random half's.
    for (const id of ids) expect(id.startsWith('20260827T120000000Z-')).toBe(true);
  });
});

describe('the store refuses everything short of bytes it can read back', () => {
  const base = {
    taskId: TASK,
    repositoryRoot: 'C:\\scratch\\repo',
    ...IDENTITY,
    declaredRemote: 'origin',
    ref: REF,
    commit: HEAD,
    declarationDigest: 'b'.repeat(64),
    authorisedAt: AT,
  };

  it('records, and reports the disk rather than the return value', () => {
    const home = scratchHome();
    const eventId = newHeadPublicationAuditEventId(new Date(AT));
    const result = recordHeadPublicationAuthorisation({
      ...base,
      eventId,
      pathProvider: fixedPathProvider(home),
    });
    expect(result.code).toBe('RECORDED');
    expect(result.recorded).toBe(true);
    expect(result.eventId).toBe(eventId);
    expect(
      readHeadPublicationAuthorisation(readFileSync(recordPath(home, eventId)), {
        eventId,
        taskId: TASK,
        repositoryRoot: base.repositoryRoot,
      }),
    ).toBe('HISTORICAL_AUTHORISATION');
  });

  it('refuses when the bytes never arrive', () => {
    const home = scratchHome();
    const result = recordHeadPublicationAuthorisation({
      ...base,
      eventId: newHeadPublicationAuditEventId(new Date(AT)),
      pathProvider: fixedPathProvider(home),
      // A rename that reports success and moves nothing — the shape Windows was
      // measured producing under concurrency, and the one no return value can
      // tell from a real move.
      replace: () => undefined,
    });
    expect(result.code).toBe('READBACK_FAILED');
    expect(result.recorded).toBe(false);
  });

  it('refuses when the bytes that arrive are not the ones intended', () => {
    const home = scratchHome();
    const eventId = newHeadPublicationAuditEventId(new Date(AT));
    const result = recordHeadPublicationAuthorisation({
      ...base,
      eventId,
      pathProvider: fixedPathProvider(home),
      // Something else lands under the target name. A well-formed record for a
      // different event, so the refusal is the binding rather than the parser.
      replace: (_from, to) => {
        writeFileSync(to, bytesFor(payloadFor()));
      },
    });
    expect(result.code).toBe('READBACK_MISMATCH');
    expect(result.recorded).toBe(false);
  });

  it('refuses a store root it cannot make, and one with a link on its path', () => {
    const home = scratchHome();
    blockStore(home);
    expect(
      recordHeadPublicationAuthorisation({
        ...base,
        eventId: newHeadPublicationAuditEventId(new Date(AT)),
        pathProvider: fixedPathProvider(home),
      }).code,
    ).toBe('STORE_UNAVAILABLE');
  });

  it('refuses to write through a junction on the store’s own path', () => {
    const home = scratchHome();
    const elsewhere = scratchRoot('ao-v414-elsewhere-');
    // A real Windows junction, created the way an attacker would: the store
    // root's own name, pointing somewhere this operator did not choose.
    symlinkSync(elsewhere, auditRoot(home), 'junction');
    expect(lstatSync(auditRoot(home)).isSymbolicLink()).toBe(true);

    const result = recordHeadPublicationAuthorisation({
      ...base,
      eventId: newHeadPublicationAuditEventId(new Date(AT)),
      pathProvider: fixedPathProvider(home),
    });

    expect(result.code).toBe('STORE_PATH_UNSAFE');
    expect(result.recorded).toBe(false);
    // And nothing was created on the other side of it.
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses an event name that is not a single safe segment', () => {
    const home = scratchHome();
    for (const eventId of ['..', 'a/b', 'a\\b', 'not-an-event-id', '.', 'a'.repeat(120)]) {
      const result = recordHeadPublicationAuthorisation({
        ...base,
        eventId,
        pathProvider: fixedPathProvider(home),
      });
      expect(result.code, eventId).toBe('EVENT_ID_UNSUITABLE');
    }
    // An empty name is refused one step earlier, by the record's own contract,
    // and that ordering is the point rather than an accident: the record is
    // judged before a path is derived, so a caller whose facts cannot make a
    // readable record causes no filesystem effect at all.
    expect(
      recordHeadPublicationAuthorisation({ ...base, eventId: '', pathProvider: fixedPathProvider(home) })
        .code,
    ).toBe('RECORD_CONTRACT_VIOLATION');
    expect(eventIds(home)).toEqual([]);
  });

  it('refuses a record it would not read back, before creating anything', () => {
    const home = scratchHome();
    const result = recordHeadPublicationAuthorisation({
      ...base,
      // Not an object name. The record's own contract refuses it, and the
      // refusal happens before a directory exists.
      commit: 'not-a-commit',
      eventId: newHeadPublicationAuditEventId(new Date(AT)),
      pathProvider: fixedPathProvider(home),
    });
    expect(result.code).toBe('RECORD_CONTRACT_VIOLATION');
    expect(eventIds(home)).toEqual([]);
  });

  it('refuses a record larger than it will read back', () => {
    const home = scratchHome();
    const result = recordHeadPublicationAuthorisation({
      ...base,
      repositoryRoot: `C:\\${'r'.repeat(MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES)}`,
      eventId: newHeadPublicationAuditEventId(new Date(AT)),
      pathProvider: fixedPathProvider(home),
    });
    expect(result.code).toBe('RECORD_TOO_LARGE');
    expect(eventIds(home)).toEqual([]);
  });

  it('puts no identity into the path, however the identities are spelled', () => {
    const home = scratchHome();
    const eventId = newHeadPublicationAuditEventId(new Date(AT));
    const result = recordHeadPublicationAuthorisation({
      ...base,
      eventId,
      // Every one of these is legal in its own contract and hostile as a path
      // segment: a Windows device name, a traversal, a trailing dot.
      taskId: 'NUL',
      owner: '..',
      name: 'COM1.',
      declaredRemote: '../../escape',
      pathProvider: fixedPathProvider(home),
    });
    expect(result.code).toBe('RECORDED');
    // One directory, named by the event and nothing else.
    expect(eventIds(home)).toEqual([eventId]);
    const record = JSON.parse(readFileSync(recordPath(home, eventId), 'utf8')) as HeadPublicationAuthorisation;
    expect(record.taskId).toBe('NUL');
    expect(record.owner).toBe('..');
    expect(record.name).toBe('COM1.');
  });

  it('keeps its vocabulary closed, distinct, and free of permission words', () => {
    expect(new Set(HEAD_PUBLICATION_AUDIT_CODES).size).toBe(HEAD_PUBLICATION_AUDIT_CODES.length);
    expect(HEAD_PUBLICATION_AUDIT_CODES[0]).toBe('RECORDED');
    // There is no idempotency member: a record already at the name refuses.
    expect(HEAD_PUBLICATION_AUDIT_CODES as readonly string[]).not.toContain('ALREADY_RECORDED');
    for (const code of HEAD_PUBLICATION_AUDIT_CODES) {
      expect(HEAD_PUBLICATION_AUTHORISATION_READINGS as readonly string[], code).not.toContain(code);
    }
    const codes: readonly HeadPublicationAuditCode[] = HEAD_PUBLICATION_AUDIT_CODES;
    expect(codes.filter((code) => code === 'RECORDED').length).toBe(1);
  });
});

describe('a record read back under another subject is refused', () => {
  it('reads as this event when nothing was substituted', () => {
    expect(readHeadPublicationAuthorisation(bytesFor(payloadFor()), SUBJECT)).toBe(
      'HISTORICAL_AUTHORISATION',
    );
  });

  it('refuses every substitution of the subject it is read under', () => {
    const bytes = bytesFor(payloadFor());
    for (const subject of [
      { ...SUBJECT, eventId: '20260827T120000000Z-99999999-2222-4333-8444-555555555555' },
      { ...SUBJECT, taskId: 'V4-13' },
      { ...SUBJECT, repositoryRoot: 'C:\\scratch\\another-repo' },
    ]) {
      expect(readHeadPublicationAuthorisation(bytes, subject), JSON.stringify(subject)).toBe(
        'NOT_THIS_EVENT',
      );
    }
  });

  it('refuses every field edited in place without recomputing the binding', () => {
    const record = JSON.parse(bytesFor(payloadFor()).toString('utf8')) as Record<string, unknown>;
    for (const [field, value] of [
      ['taskId', 'V4-13'],
      ['repositoryRoot', 'C:\\elsewhere'],
      ['host', 'gitlab.com'],
      ['owner', 'someone-else'],
      ['name', 'another-project'],
      ['declaredRemote', 'upstream'],
      ['ref', 'refs/heads/other'],
      ['commit', OTHER],
      ['declarationDigest', 'c'.repeat(64)],
      ['authorisedAt', '2020-01-01T00:00:00.000Z'],
      ['eventId', '20260827T120000000Z-99999999-2222-4333-8444-555555555555'],
    ] as const) {
      const edited = Buffer.from(`${JSON.stringify({ ...record, [field]: value }, null, 2)}\n`, 'utf8');
      expect(readHeadPublicationAuthorisation(edited, SUBJECT), field).toBe('NOT_THIS_EVENT');
    }
  });

  it('refuses a record moved into another event directory', () => {
    const home = scratchHome();
    const mine = newHeadPublicationAuditEventId(new Date(AT));
    const theirs = newHeadPublicationAuditEventId(new Date(AT));
    const request = {
      taskId: TASK,
      repositoryRoot: 'C:\\scratch\\repo',
      ...IDENTITY,
      declaredRemote: 'origin',
      ref: REF,
      commit: HEAD,
      declarationDigest: 'b'.repeat(64),
      authorisedAt: AT,
      pathProvider: fixedPathProvider(home),
    };
    expect(recordHeadPublicationAuthorisation({ ...request, eventId: mine }).code).toBe('RECORDED');
    expect(recordHeadPublicationAuthorisation({ ...request, eventId: theirs }).code).toBe('RECORDED');

    // Somebody copies one record over the other, keeping every byte.
    cpSync(recordPath(home, mine), recordPath(home, theirs), { force: true });

    expect(
      readHeadPublicationAuthorisation(readFileSync(recordPath(home, theirs)), {
        eventId: theirs,
        taskId: TASK,
        repositoryRoot: request.repositoryRoot,
      }),
    ).toBe('NOT_THIS_EVENT');
  });

  it('tells absence, malformation and a future contract apart', () => {
    expect(readHeadPublicationAuthorisation(Buffer.alloc(0), SUBJECT)).toBe('ABSENT');
    expect(readHeadPublicationAuthorisation(Buffer.from('not json', 'utf8'), SUBJECT)).toBe('MALFORMED');
    expect(readHeadPublicationAuthorisation(Buffer.from('[]', 'utf8'), SUBJECT)).toBe('MALFORMED');
    expect(readHeadPublicationAuthorisation(Buffer.from('{}', 'utf8'), SUBJECT)).toBe('MALFORMED');
    expect(
      readHeadPublicationAuthorisation(
        Buffer.from(JSON.stringify({ authorisationVersion: 2 }), 'utf8'),
        SUBJECT,
      ),
    ).toBe('UNSUPPORTED_VERSION');
    expect(
      readHeadPublicationAuthorisation(
        Buffer.alloc(MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES + 1, 0x20),
        SUBJECT,
      ),
    ).toBe('MALFORMED');
    // A record whose unknown key was added by a build that agrees about the
    // version is refused, not tolerated.
    const record = JSON.parse(bytesFor(payloadFor()).toString('utf8')) as Record<string, unknown>;
    expect(
      readHeadPublicationAuthorisation(
        Buffer.from(JSON.stringify({ ...record, somethingElse: true }), 'utf8'),
        SUBJECT,
      ),
    ).toBe('MALFORMED');
  });

  it('keeps the reading vocabulary closed and free of authority words', () => {
    expect(new Set(HEAD_PUBLICATION_AUTHORISATION_READINGS).size).toBe(
      HEAD_PUBLICATION_AUTHORISATION_READINGS.length,
    );
    for (const forbidden of ['AUTHORISED', 'VALID', 'CURRENT', 'ALLOWED', 'PERMITTED']) {
      expect(HEAD_PUBLICATION_AUTHORISATION_READINGS as readonly string[], forbidden).not.toContain(
        forbidden,
      );
    }
  });
});

describe('the slice adds no act, and takes none away', () => {
  it('opens nothing, merges nothing and writes no repository record', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    const run = await drive(AUTOMATIC, root, home);

    expect(run.counts.create).toBe(0);
    expect(run.counts.merge).toBe(0);
    expect(driven(run)).toBe('EFFECT_ATTEMPTED');
  });

  it('leaves an old record alone when a later run finds the head already there', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    await drive(AUTOMATIC, root, home);
    const [first] = eventIds(home);
    const bytes = recordBytes(home, first as string);

    const later = await drive(AUTOMATIC, root, home, { remoteRef: 'at-head' });
    expect(published(later)).toBe('ALREADY_PUBLISHED');

    expect(recordBytes(home, first as string)).toEqual(bytes);
    expect(eventIds(home).length).toBe(2);
  });

  it('leaves a record and no effect when the attempt itself is uncertain', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    const run = await drive(AUTOMATIC, root, home, { pushFails: true });

    expect(run.counts.publish).toBe(1);
    expect(driven(run)).toBe('EFFECT_ATTEMPTED');
    // The record says what was authorised. It does not say what the transport
    // did, and there is nothing in it a later invocation could resume from.
    const record = onlyRecord(home);
    expect(record.commit).toBe(HEAD);
    expect(JSON.stringify(record)).not.toContain('TIMED_OUT');
  });

  it('registers no new option on the delivery command', () => {
    const before = new Set([
      '--repository',
      '--task',
      '--select-task',
      '--observe',
      '--record',
      '--decide',
      '--publish-head',
      '--create-pr',
      '--merge-pr',
      '--reconcile-merge',
      '--verify-merge',
      '--conclude-delivery',
      '--drive',
      '--attended',
      '--automatic-publish-head-only',
    ]);
    const delivery = buildProgram()
      .commands.find((command) => command.name() === 'delivery');
    expect(delivery).toBeDefined();
    const registered = (delivery as Command).options.map((option) => option.long);
    for (const long of registered) {
      expect(before, `${String(long)} is new in this slice`).toContain(long);
    }
  });
});

describe('the store is where the authority is, and the repository cannot reach it', () => {
  it('resolves under the OS user profile and nowhere else', () => {
    const home = scratchHome();
    expect(auditRoot(home)).toBe(
      join(home, '.agent-orchestrator', HEAD_PUBLICATION_AUDIT_DIR_NAME),
    );
    // A pure function of the profile: no repository path, no environment, no
    // Git and no command line reaches it. Swept over both halves, because V4
    // slice 15 moved the location out of the writer so that a read-only listing
    // could learn a directory name without importing the exclusive `mkdir` — the
    // rule is about the whole derivation, not about which file it sits in.
    const store = codeOnly('src/deliver/head-publication-authorisation-store.ts');
    const location = codeOnly('src/deliver/internal/head-publication-audit-location.ts');
    for (const code of [store, location]) {
      for (const forbidden of ['process.env', 'execFile', 'spawn', 'GitRunner', 'cwd()']) {
        expect(code, forbidden).not.toContain(forbidden);
      }
    }
    expect(location).toContain('orchestratorHome');
    // The module that owns the location creates nothing. That is what makes the
    // reader's own closure free of a directory creator, and it is pinned here
    // rather than only in slice 15's suite, because it is this store's property.
    for (const forbidden of ['mkdirSync', 'writeFileSync', 'renameSync', 'createRunDirectory']) {
      expect(location, forbidden).not.toContain(forbidden);
    }
    expect(store.replace(/\s+/g, '').length).toBeGreaterThan(500);
  });

  it('survives the repository it describes being deleted', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());
    const run = await drive(AUTOMATIC, root, home);
    expect(run.counts.publish).toBe(1);
    const record = onlyRecord(home);

    // The whole checkout goes. The record is about a ref on a forge, and that
    // ref does not go with it.
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

    expect(onlyRecord(home)).toEqual(record);
  });

  it('needs no answer from the repository to be written', async () => {
    // The in-repository stores must ask Git whether their own path is ignored
    // before writing, and treat "could not tell" as a refusal. This one is
    // outside every repository, so it asks nothing — and a run whose ignore
    // probe can only answer UNDETERMINED still records and still publishes.
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, permitting());

    const run = await drive(AUTOMATIC, root, home, { checkIgnored: 'UNDETERMINED' });

    expect(published(run)).toBe('PUBLISHED');
    expect(run.counts.publish).toBe(1);
    expect(recordsIn(home).length).toBe(1);
  });

  it('does not fold two case-different declarations into one trail', () => {
    // NTFS folds case and the permission does not, so two entries differing
    // only in capitalisation are two different permissions. Nothing in the path
    // comes from either, which is what keeps them apart on disk.
    const home = scratchHome();
    const request = {
      taskId: TASK,
      repositoryRoot: 'C:\\scratch\\repo',
      host: IDENTITY.host,
      declaredRemote: 'origin',
      ref: REF,
      commit: HEAD,
      declarationDigest: 'b'.repeat(64),
      authorisedAt: AT,
      pathProvider: fixedPathProvider(home),
    };
    const upper = newHeadPublicationAuditEventId(new Date(AT));
    const lower = newHeadPublicationAuditEventId(new Date(AT));
    expect(
      recordHeadPublicationAuthorisation({
        ...request,
        eventId: upper,
        owner: 'M4XD4B0ZZ',
        name: 'AgentOrchestrator',
      }).code,
    ).toBe('RECORDED');
    expect(
      recordHeadPublicationAuthorisation({
        ...request,
        eventId: lower,
        owner: 'm4xd4b0zz',
        name: 'agentorchestrator',
      }).code,
    ).toBe('RECORDED');

    const owners = recordsIn(home).map((record) => record.owner).sort();
    expect(owners).toEqual(['M4XD4B0ZZ', 'm4xd4b0zz']);
    expect(eventIds(home).length).toBe(2);
  });
});

describe('a staging artefact is not a record', () => {
  it('leaves nothing readable behind when the write does not complete', () => {
    const home = scratchHome();
    const eventId = newHeadPublicationAuditEventId(new Date(AT));
    const result = recordHeadPublicationAuthorisation({
      eventId,
      taskId: TASK,
      repositoryRoot: 'C:\\scratch\\repo',
      ...IDENTITY,
      declaredRemote: 'origin',
      ref: REF,
      commit: HEAD,
      declarationDigest: 'b'.repeat(64),
      authorisedAt: AT,
      pathProvider: fixedPathProvider(home),
      tempSuffix: () => 'pinned',
      replace: () => {
        throw Object.assign(new Error('refused'), { code: 'EPERM' });
      },
    });

    expect(result.code).toBe('WRITE_FAILED');
    // The staging file is removed on the failure path, and in any case the
    // record's own name is not there: a reader opens by name and never
    // enumerates, so nothing here can be mistaken for evidence.
    const entries = readdirSync(join(auditRoot(home), eventId));
    expect(entries).not.toContain(HEAD_PUBLICATION_AUDIT_FILE_NAME);
    expect(recordsIn(home)).toEqual([]);
  });

  it('reads a directory under the record name as no record at all', () => {
    const home = scratchHome();
    const eventId = newHeadPublicationAuditEventId(new Date(AT));
    const request = {
      eventId,
      taskId: TASK,
      repositoryRoot: 'C:\\scratch\\repo',
      ...IDENTITY,
      declaredRemote: 'origin',
      ref: REF,
      commit: HEAD,
      declarationDigest: 'b'.repeat(64),
      authorisedAt: AT,
      pathProvider: fixedPathProvider(home),
      replace: (from: string, to: string) => {
        rmSync(from, { force: true });
        mkdirSync(to, { recursive: true });
      },
    };
    expect(recordHeadPublicationAuthorisation(request).code).toBe('READBACK_FAILED');
  });
});

describe('the declaration loader carries the digest and nothing more', () => {
  it('answers a digest of the bytes it read, on the member that permits', () => {
    const home = scratchHome();
    const text = permitting();
    declare(home, text);
    const outcome = loadDeliveryAutomation(fixedPathProvider(home));
    expect(outcome.state).toBe('DECLARED');
    if (outcome.state !== 'DECLARED') throw new Error('unreachable');
    expect(outcome.declarationDigest).toBe(
      createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    );
  });

  it('carries no digest on a refusal', () => {
    const home = scratchHome();
    declare(home, 'schemaVersion: 1\nrepositories: [\n');
    const outcome = loadDeliveryAutomation(fixedPathProvider(home));
    expect(outcome.state).toBe('UNUSABLE');
    expect(Object.keys(outcome)).not.toContain('declarationDigest');
    // And an absent declaration carries none either.
    const empty = scratchHome();
    expect(Object.keys(loadDeliveryAutomation(fixedPathProvider(empty)))).not.toContain(
      'declarationDigest',
    );
  });

  it('renames nothing and rewrites nothing in the operator profile', () => {
    const home = scratchHome();
    const text = permitting();
    declare(home, text);
    const before = readFileSync(declarationPath(home));
    loadDeliveryAutomation(fixedPathProvider(home));
    expect(readFileSync(declarationPath(home))).toEqual(before);
    // The store writes only under its own directory, which does not exist yet.
    expect(readdirSync(join(home, '.agent-orchestrator')).sort()).toEqual([
      DELIVERY_AUTOMATION_FILE_NAME,
    ]);
  });
});

