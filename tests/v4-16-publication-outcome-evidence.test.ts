/**
 * V4 slice 16 — the record written after the one unattended forge act.
 *
 * Slice 14 gave this build a durable answer to "what was this invocation
 * permitted to attempt?", written before the delivery remote was contacted, and
 * slice 15 gave an operator a way to read it. What neither gave was an answer to
 * "what then happened?": rows 4 to 7 of slice 14's own crash table are locally
 * indistinguishable, so a person holding a record could not tell a run that sent
 * nothing from one that may have created a branch.
 *
 * This suite is written against the six ways a record like that goes wrong.
 *
 *  1. **a record that claims an author.** The strongest reading available here
 *     is "a command was handed to the process boundary and afterwards the ref
 *     held this commit", and `L-V4-13-5` measures that a publisher which changed
 *     nothing reaches exactly that reading. Every member, every printed
 *     sentence and every byte of the record is swept for a word that would imply
 *     otherwise;
 *  2. **an absent outcome read as an absent effect.** There is no transaction
 *     between github.com and this machine's disk, so an authorisation with no
 *     outcome beside it is permanent and ordinary. It means no durable outcome
 *     was established, and never that nothing happened — a sentence that is
 *     asserted in the code, printed in the report and pinned here;
 *  3. **an unknown outcome collapsing into a failure.** The member for "the
 *     command went out and the reading afterwards did not answer" is the one
 *     under which a mutation is most likely to be unrecorded, and it may never
 *     be graded as a refusal;
 *  4. **evidence becoming authority.** An outcome licenses nothing. It cannot
 *     mint a grant, cannot satisfy a declaration, cannot make a retry safe and
 *     is never read by the effect path;
 *  5. **an outcome attached to the wrong event.** Every binding field is
 *     substituted in turn and required to refuse on the way back in, and the
 *     anchor is the authorisation's own digest rather than anything the outcome
 *     document can claim about itself;
 *  6. **an accountability failure hidden behind a success.** The outcome is
 *     written after an act that cannot be undone, so a write that fails there
 *     has to change what the invocation reports — and must not be reported as
 *     "one act was attempted, ask again", which is an instruction no invocation
 *     can carry out.
 *
 * The push vector, its create-only fence and the publication grader belong to
 * `tests/v4-05-…`; the declaration's contract to `tests/v4-13-…`; the
 * authorisation record and its store to `tests/v4-14-…`; and the listing's own
 * path safety to `tests/v4-15-…`. None of that is re-measured here.
 */

import { Command } from 'commander';
import {
  chmodSync,
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

import { registerDeliveryCommand } from '../src/cli/delivery-command.js';
import { registerPublicationCommand } from '../src/cli/publication-command.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import { DELIVERY_AUTOMATION_FILE_NAME } from '../src/deliver/delivery-automation.js';
import {
  HEAD_PUBLICATION_AUDIT_FILE_NAME,
  headPublicationAuditRoot,
  newHeadPublicationAuditEventId,
  recordHeadPublicationAuthorisation,
} from '../src/deliver/head-publication-authorisation-store.js';
import {
  DISPATCHED_PUBLICATION_OUTCOMES,
  HEAD_PUBLICATION_OUTCOME_READINGS,
  HEAD_PUBLICATION_OUTCOME_RECORD_FIELDS,
  HEAD_PUBLICATION_OUTCOME_VERSION,
  MAX_HEAD_PUBLICATION_OUTCOME_BYTES,
  PUBLICATION_COMMAND_REPORTS,
  PUBLICATION_OUTCOMES,
  REF_OBSERVED_AT_SUBJECT_COMMIT,
  headPublicationOutcomeBinding,
  inspectHeadPublicationOutcome,
  publicationCommandWasDispatched,
  publicationOutcomeFor,
  readHeadPublicationOutcome,
  type HeadPublicationOutcomePayload,
  type HeadPublicationOutcomeSubject,
  type PublicationOutcome,
} from '../src/deliver/head-publication-outcome.js';
import {
  HEAD_PUBLICATION_OUTCOME_CODES,
  HEAD_PUBLICATION_OUTCOME_FILE_NAME,
  recordHeadPublicationOutcome,
  type HeadPublicationOutcomeCode,
} from '../src/deliver/head-publication-outcome-store.js';
import { classifyPublicationCommand } from '../src/deliver/git-head-publisher.js';
import { gradeHeadPublication, HEAD_PUBLICATIONS, type RemoteRefReading } from '../src/deliver/head-publication.js';
import {
  HEAD_PUBLICATION_OUTCOME_ENTRY_READINGS,
  CLEAN_OUTCOME_ENTRY_READINGS,
  listHeadPublicationAuthorisations,
} from '../src/deliver/head-publication-authorisation-listing.js';
import {
  AUDIT_OUTCOME_SENTENCES,
  AUDIT_PRINTED_TEXT,
  AUDIT_REPORT_LABELS,
  renderPublicationAuthorisations,
} from '../src/cli/render-publication-authorisations.js';
import { DELIVERY_DRIVES, DELIVERY_DRIVE_DETAIL } from '../src/cli/delivery-driver.js';
import {
  EXIT_RUN_CALL_AGAIN,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_UNEXPECTED,
  exitCodeForDrive,
} from '../src/cli/run-exit-codes.js';
import { writeRunArtifact, type RunArtifactCode, type RunArtifactResult } from '../src/doctor/safe-write.js';
import { saveTaskState } from '../src/state/state-store.js';
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
 * The same stripper the sibling slice files use, and needed here for the same
 * reason: this slice's headers deliberately name the very claims they refuse to
 * make, and a sweep over raw text would forbid explaining the design.
 */
function codeOnly(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/gm, '$1 ');
}

const CONTRACT = 'src/deliver/head-publication-outcome.ts';
const STORE = 'src/deliver/head-publication-outcome-store.ts';
const READER = 'src/deliver/head-publication-authorisation-listing.ts';
const RENDERER = 'src/cli/render-publication-authorisations.ts';
const COMMAND = 'src/cli/publication-command.ts';
/**
 * The whole read side, listed by hand.
 *
 * Slice 15 kept a constant like this and a review found nothing pinning it
 * against the modules the command really imports, so a new module would have
 * been invisible to every sweep beneath it. The case below closes that: this
 * list is compared against what the reader's own import closure contains.
 */
const READ_SIDE = [READER, RENDERER, COMMAND, CONTRACT] as const;

/* ── scratch ──────────────────────────────────────────────────────────────── */

const roots: string[] = [];

function scratchRoot(prefix = 'ao-v416-'): string {
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

const TASK = 'V4-16';
/** H — the exact commit a publication is about. */
const HEAD = 'a'.repeat(40);
const OTHER = 'd'.repeat(40);
const BASE = 'main';
const BRANCH = 'ao/task/V4-16';
const REF = `refs/heads/${BRANCH}`;
const AT = '2026-08-27T12:00:00.000Z';
const DIGEST = 'b'.repeat(64);
const CHECKOUT = 'C:\\scratch\\repo';
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

const ABSENT: RemoteRefReading = Object.freeze({ outcome: 'ABSENT', commit: null });
const UNKNOWN: RemoteRefReading = Object.freeze({ outcome: 'UNKNOWN', commit: null });
const at = (commit: string): RemoteRefReading => Object.freeze({ outcome: 'AT_COMMIT', commit });

/* ── the operator's home ──────────────────────────────────────────────────── */

function scratchHome(): string {
  const home = scratchRoot('ao-v416-home-');
  mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
  return home;
}

function declare(home: string, permission = 'AUTOMATIC_ALLOWED'): void {
  writeFileSync(
    join(home, '.agent-orchestrator', DELIVERY_AUTOMATION_FILE_NAME),
    [
      'schemaVersion: 1',
      'repositories:',
      `  - host: ${IDENTITY.host}`,
      `    owner: ${IDENTITY.owner}`,
      `    name: ${IDENTITY.name}`,
      `    headPublication: ${permission}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

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

function onlyEvent(home: string): string {
  const ids = eventIds(home);
  expect(ids.length, `expected exactly one event, found ${ids.length}`).toBe(1);
  return ids[0] as string;
}

function outcomePath(home: string, eventId: string): string {
  return join(auditRoot(home), eventId, HEAD_PUBLICATION_OUTCOME_FILE_NAME);
}

function readOutcome(home: string, eventId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(outcomePath(home, eventId), 'utf8')) as Record<string, unknown>;
}

function outcomeExists(home: string, eventId: string): boolean {
  try {
    readFileSync(outcomePath(home, eventId));
    return true;
  } catch {
    return false;
  }
}

/* ── a repository, and one finished task in it ───────────────────────────── */

const TASK_DIR = 'tasks';

function repositoryRoot(): string {
  const root = scratchRoot();
  mkdirSync(join(root, TASK_DIR), { recursive: true });
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  return root;
}

function writeReadyState(root: string): void {
  const saved = saveTaskState(
    validReadyForPrState({
      taskId: TASK,
      repositoryRoot: root,
      worktreePath: join(root, TASK),
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
  publish: number;
  remoteReads: number;
}

interface Run {
  readonly out: string;
  readonly exitCode: number | undefined;
  readonly counts: Counts;
}

/** What `ls-remote` answers, in the two positions it is asked. */
type RefState = 'absent' | 'at-head' | 'other' | 'unreadable';

/**
 * Drives the real registered CLI over a real repository and a real scratch home.
 *
 * Neither store is a seam: the records this suite reads are the ones the
 * production modules wrote, into real directories, through the real exclusive
 * `mkdir`, the real crash-safe write and the real exclusive create.
 *
 * `outcomeWrite` is the one exception and it substitutes **only** the artefact
 * primitive, only for the answers no filesystem can be made to give on demand —
 * a write that goes out part-way, a flush that fails, a handle that will not
 * close. Every other store answer in this file is measured against the real one.
 */
async function drive(
  argv: readonly string[],
  root: string,
  home: string,
  over: {
    readonly before?: RefState;
    readonly after?: RefState;
    /** What the process boundary reports about the push command. */
    readonly push?: { readonly outcome?: string; readonly exitCode?: number | null };
    readonly outcomeWrite?: RunArtifactCode;
    /**
     * The locator answers github.com's measured missing-commit document for the
     * subject commit — the world a **first** publication starts in, and the one
     * V4 slice 18R exists for. Measured 2026-08-28: exit 1, and this body.
     */
    readonly locatorMissing?: boolean;
  } = {},
): Promise<Run> {
  const counts: Counts = { publish: 0, remoteReads: 0 };
  const chunks: string[] = [];
  const outer = process.exitCode;
  process.exitCode = undefined;
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  const answerFor = (state: RefState, ref: string) => {
    if (state === 'unreadable') return commandResult({ exitCode: 128 });
    if (state === 'absent') return commandResult({ exitCode: 2 });
    return commandResult({ stdout: `${state === 'at-head' ? HEAD : OTHER}\t${ref}` });
  };

  try {
    const program = new Command();
    program.exitOverride();
    registerDeliveryCommand(program, {
      pathProvider: fixedPathProvider(home),
      resolveRepository: (async () => ({
        ok: true,
        repository: {
          id: 'fixture-repo',
          root,
          gitCommonDir: join(root, '.git'),
          taskSource: { kind: 'MARKDOWN_DIRECTORY', path: TASK_DIR },
          verification: { phases: [] },
          delivery: DECLARED_TARGET,
        },
      })) as never,
      runner: (async (_command: string, args: readonly string[]) => {
        const path = args.find((a) => a.startsWith('repos/')) ?? args.join(' ');
        if (/\/pulls\/\d+$/.test(path)) return commandResult({ exitCode: 1, stdout: '{}' });
        if (path.endsWith('/pulls')) {
          if (over.locatorMissing === true) {
            return commandResult({
              exitCode: 1,
              stdout: JSON.stringify({
                message: `No commit found for SHA: ${HEAD}`,
                documentation_url:
                  'https://docs.github.com/rest/commits/commits#list-pull-requests-associated-with-a-commit',
                status: '422',
              }),
            });
          }
          return commandResult({ stdout: '[]' });
        }
        if (path.endsWith('/check-runs')) {
          return commandResult({ stdout: JSON.stringify({ total_count: 0, check_runs: [] }) });
        }
        return commandResult({
          stdout: JSON.stringify({ sha: HEAD, state: 'success', total_count: 0, statuses: [] }),
        });
      }) as never,
      publicationRunner: (async (args: readonly string[]) => {
        const joined = args.join(' ');
        if (joined.includes('remote get-url')) return commandResult({ stdout: 'origin-url' });
        if (joined.includes('ls-remote')) {
          counts.remoteReads += 1;
          const ref = args[args.length - 1] ?? '';
          // The first reading is the pre-push one; every later one is after.
          const state =
            counts.publish === 0 ? (over.before ?? 'absent') : (over.after ?? 'at-head');
          return answerFor(state, ref);
        }
        counts.publish += 1;
        return commandResult({
          outcome: over.push?.outcome ?? 'COMPLETED',
          exitCode: over.push?.exitCode === undefined ? 0 : over.push.exitCode,
        });
      }) as never,
      creationRunner: (async () => commandResult({ stdout: '{}' })) as never,
      mergeRunner: (async () => commandResult({ stdout: '{}' })) as never,
      git: (async () => ({ outcome: 'FAILED', stdout: '', stderr: 'not a commit' })) as never,
      envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
      checkIgnored: (async () => 'IGNORED') as never,
      now: () => new Date(AT),
      ...(over.outcomeWrite === undefined
        ? {}
        : { outcomeWriter: refusingWriter(over.outcomeWrite) }),
    });
    await program.parseAsync(
      ['node', 'agent-loop', 'delivery', '--repository', root, '--task', TASK, ...argv],
      { from: 'node' },
    );
    return { out: chunks.join(''), exitCode: process.exitCode as number | undefined, counts };
  } finally {
    process.stdout.write = write;
    process.exitCode = outer;
  }
}

/**
 * An artefact writer that answers one code and touches nothing.
 *
 * It stands in only for the three answers a real filesystem will not produce on
 * demand, and for the containment floors. Every case that uses it says which
 * answer it is reaching and why no real obstruction would do.
 */
function refusingWriter(code: RunArtifactCode): typeof writeRunArtifact {
  return ((request: { readonly runDirectory: string; readonly fileName: string }): RunArtifactResult =>
    Object.freeze({
      code,
      written: code === 'WRITTEN',
      path: join(request.runDirectory, request.fileName),
      bytesWritten: 0,
      synced: false,
      errnoCode: null,
    })) as typeof writeRunArtifact;
}

function lineOf(run: Run, label: string): string | null {
  const m = new RegExp(`^${label} *: (.+)$`, 'm').exec(run.out);
  return m === null ? null : (m[1] as string).trim();
}

const drivenLine = (run: Run): string | null => lineOf(run, 'Drive');

const AUTOMATIC = ['--drive', '--publish-head', '--automatic-publish-head-only'];
const ATTENDED = ['--drive', '--publish-head', '--attended'];

/* ── an outcome built by hand, for the reader's own cases ─────────────────── */

const SUBJECT: HeadPublicationOutcomeSubject = Object.freeze({
  eventId: '20260827T120000000Z-11111111-2222-4333-8444-555555555555',
  taskId: TASK,
  repositoryRoot: CHECKOUT,
  authorisationBinding: 'c'.repeat(64),
});

function payloadFor(
  over: Partial<HeadPublicationOutcomePayload> = {},
): HeadPublicationOutcomePayload {
  return {
    outcomeVersion: HEAD_PUBLICATION_OUTCOME_VERSION as 1,
    eventId: SUBJECT.eventId,
    act: 'HEAD_PUBLICATION',
    outcome: 'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER',
    commandReport: 'RAN_TO_EXIT_ZERO',
    recordedAt: AT,
    ...over,
  };
}

function bytesFor(
  payload: HeadPublicationOutcomePayload,
  subject: HeadPublicationOutcomeSubject = SUBJECT,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      { ...payload, binding: headPublicationOutcomeBinding(subject, payload) },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/* ── a store on disk, without the CLI ─────────────────────────────────────── */

interface Planted {
  readonly home: string;
  readonly eventId: string;
  readonly binding: string;
}

/** Writes one real authorisation record and hands back its anchor. */
function plantAuthorisation(
  home: string,
  over: { readonly taskId?: string; readonly repositoryRoot?: string } = {},
): Planted {
  const eventId = newHeadPublicationAuditEventId(new Date(AT));
  const result = recordHeadPublicationAuthorisation({
    eventId,
    taskId: over.taskId ?? TASK,
    repositoryRoot: over.repositoryRoot ?? CHECKOUT,
    host: IDENTITY.host,
    owner: IDENTITY.owner,
    name: IDENTITY.name,
    declaredRemote: 'origin',
    ref: REF,
    commit: HEAD,
    declarationDigest: DIGEST,
    authorisedAt: AT,
    pathProvider: fixedPathProvider(home),
  });
  expect(result.code, 'the fixture authorisation must be recorded').toBe('RECORDED');
  expect(result.binding, 'a recorded authorisation must carry its digest').not.toBeNull();
  return { home, eventId, binding: result.binding as string };
}

function recordOutcome(
  planted: Planted,
  over: {
    readonly outcome?: PublicationOutcome;
    readonly commandReport?: 'NOT_CALLED' | 'NO_PROCESS' | 'RAN_TO_EXIT_ZERO' | 'RAN_TO_ANOTHER_ENDING' | 'ENDING_NOT_ESTABLISHED';
    readonly eventId?: string;
    readonly taskId?: string;
    readonly repositoryRoot?: string;
    readonly authorisationBinding?: string;
    readonly recordedAt?: string;
    readonly writeArtifact?: typeof writeRunArtifact;
  } = {},
) {
  return recordHeadPublicationOutcome({
    eventId: over.eventId ?? planted.eventId,
    taskId: over.taskId ?? TASK,
    repositoryRoot: over.repositoryRoot ?? CHECKOUT,
    authorisationBinding: over.authorisationBinding ?? planted.binding,
    outcome: over.outcome ?? 'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER',
    commandReport: over.commandReport ?? 'RAN_TO_EXIT_ZERO',
    recordedAt: over.recordedAt ?? AT,
    pathProvider: fixedPathProvider(planted.home),
    ...(over.writeArtifact === undefined ? {} : { writeArtifact: over.writeArtifact }),
  });
}

function report(home: string): string {
  return renderPublicationAuthorisations(
    listHeadPublicationAuthorisations(fixedPathProvider(home)),
  );
}

/* ═════════════════════════════════════════════════════════════════════════ */

describe('what this invocation did, decided from its own calls and readings', () => {
  /**
   * The classifier's whole input space, driven directly.
   *
   * It is a pure function of three values and it is exported, so every arm is
   * reachable here whether or not the ladder above it can produce that
   * combination today. That is deliberate: an arm reachable only by argument is
   * still an arm, and calling one "unreachable" is a claim this repository has
   * had measured false three times.
   */
  const CASES: readonly (readonly [string, RemoteRefReading | null, 'NOT_ATTEMPTED' | 'COMPLETED' | 'FAILED', RemoteRefReading | null, PublicationOutcome])[] = [
    ['no reading taken at all', null, 'NOT_ATTEMPTED', null, 'NOT_DISPATCHED_REMOTE_NOT_ASKED'],
    ['the ref could not be read', UNKNOWN, 'NOT_ATTEMPTED', null, 'NOT_DISPATCHED_REF_NOT_READ'],
    ['the ref already held H', at(HEAD), 'NOT_ATTEMPTED', null, 'NOT_DISPATCHED_REF_AT_SUBJECT_COMMIT'],
    ['the ref held another commit', at(OTHER), 'NOT_ATTEMPTED', null, 'NOT_DISPATCHED_REF_AT_OTHER_COMMIT'],
    ['the ref was absent and nothing was sent', ABSENT, 'NOT_ATTEMPTED', null, 'NOT_DISPATCHED_REF_ABSENT'],
    ['sent, and no reading afterwards', ABSENT, 'COMPLETED', null, 'DISPATCHED_REF_NOT_READ_AFTER'],
    ['sent, and the reading afterwards did not answer', ABSENT, 'FAILED', UNKNOWN, 'DISPATCHED_REF_NOT_READ_AFTER'],
    ['sent, and the ref is absent afterwards', ABSENT, 'FAILED', ABSENT, 'DISPATCHED_REF_ABSENT_AFTER'],
    ['sent, and the ref holds H afterwards', ABSENT, 'COMPLETED', at(HEAD), 'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER'],
    ['sent without a definite result, and the ref holds H', ABSENT, 'FAILED', at(HEAD), 'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER'],
    ['sent, and the ref holds another commit afterwards', ABSENT, 'COMPLETED', at(OTHER), 'DISPATCHED_REF_AT_OTHER_COMMIT_AFTER'],
  ];

  it.each(CASES)('answers %s', (_name, before, attempt, after, expected) => {
    expect(publicationOutcomeFor(HEAD, before, attempt, after)).toBe(expected);
  });

  it('reaches every member of the vocabulary from the cases above', () => {
    const reached = new Set(CASES.map(([, , , , member]) => member));
    expect([...reached].sort()).toEqual([...PUBLICATION_OUTCOMES].sort());
  });

  it('separates the dispatch fact from the reading, over the whole vocabulary', () => {
    // A partition rather than a name test: adding a member cannot silently widen
    // or narrow the set, because a member neither side claims fails here.
    const dispatched = PUBLICATION_OUTCOMES.filter((m) => DISPATCHED_PUBLICATION_OUTCOMES.has(m));
    const not = PUBLICATION_OUTCOMES.filter((m) => !DISPATCHED_PUBLICATION_OUTCOMES.has(m));
    expect(dispatched.length + not.length).toBe(PUBLICATION_OUTCOMES.length);
    expect(dispatched.length).toBe(4);
    for (const member of PUBLICATION_OUTCOMES) {
      expect(publicationCommandWasDispatched(member), member).toBe(member.startsWith('DISPATCHED_'));
    }
  });

  it('never reports a dispatch where the ladder did not reach the command', () => {
    for (const [, before, attempt, after, member] of CASES) {
      const sent = publicationOutcomeFor(HEAD, before, attempt, after);
      expect(publicationCommandWasDispatched(sent), member).toBe(attempt !== 'NOT_ATTEMPTED');
    }
  });

  /**
   * The one thing the outcome and the publication grade both speak about.
   *
   * They are two classifications of one set of readings and neither is derived
   * from the other, which is what keeps a change to either from silently
   * changing the other. What may never differ is whether the ref was observed at
   * the authorised commit, so that is asserted across the whole space rather
   * than trusted.
   */
  it('agrees with the publication grade about the ref being seen at the commit', () => {
    const readings: readonly (RemoteRefReading | null)[] = [null, ABSENT, UNKNOWN, at(HEAD), at(OTHER)];
    /**
     * Only the triples the ladder can produce, and that bound is the finding
     * rather than a convenience.
     *
     * `publishDeliveryHead` hands the command over on a **confirmed absence**
     * and on nothing else, so a dispatch always carries `before === ABSENT`.
     * Outside that, the two classifications legitimately part company — with a
     * pre-reading that failed, the grader answers `REMOTE_STATE_UNKNOWN`
     * whatever came afterwards, because its subject is the postcondition of a
     * publication it will not say happened. Comparing them there would be
     * comparing answers to two questions on an input neither is asked.
     *
     * That the ladder really holds the invariant is measured elsewhere in this
     * file rather than assumed: with the pre-reading unreadable, the run sends
     * nothing.
     */
    const reachable = (before: RemoteRefReading | null, attempt: string): boolean =>
      attempt === 'NOT_ATTEMPTED' || before === ABSENT;

    let agreements = 0;
    for (const before of readings) {
      for (const attempt of ['NOT_ATTEMPTED', 'COMPLETED', 'FAILED'] as const) {
        for (const after of readings) {
          // The grader is total only over a non-null pre-reading; the ladder
          // never hands it one, and neither does this.
          if (before === null || !reachable(before, attempt)) continue;
          const outcome = publicationOutcomeFor(HEAD, before, attempt, after);
          const grade = gradeHeadPublication(HEAD, before, attempt, after);
          const observed = REF_OBSERVED_AT_SUBJECT_COMMIT.has(outcome);
          const established = grade === 'PUBLISHED' || grade === 'ALREADY_PUBLISHED' || grade === 'CONVERGED_AFTER_UNCERTAIN_EFFECT';
          expect(observed, `${outcome} vs ${grade}`).toBe(established);
          agreements += 1;
        }
      }
    }
    expect(agreements, 'the comparison must actually have run').toBeGreaterThan(20);
    // A positive control: the comparison is worthless unless it really reached
    // the members on both sides of the question.
    expect(REF_OBSERVED_AT_SUBJECT_COMMIT.size).toBe(2);
  });
});

describe('what the process boundary reported, and what it did not', () => {
  /**
   * The mapping, hand-written here and deliberately not derived from the
   * production function. A test that called the same function twice would pass
   * for any mapping at all.
   */
  const REPORTS: readonly (readonly [string, number | null, string])[] = [
    ['COMPLETED', 0, 'RAN_TO_EXIT_ZERO'],
    ['COMPLETED', 1, 'RAN_TO_ANOTHER_ENDING'],
    ['COMPLETED', null, 'RAN_TO_ANOTHER_ENDING'],
    ['OUTPUT_LIMIT_EXCEEDED', null, 'RAN_TO_ANOTHER_ENDING'],
    ['OUTPUT_LIMIT_EXCEEDED', 0, 'RAN_TO_ANOTHER_ENDING'],
    ['NOT_FOUND', null, 'NO_PROCESS'],
    ['SPAWN_FAILED', null, 'ENDING_NOT_ESTABLISHED'],
    ['TIMED_OUT', null, 'ENDING_NOT_ESTABLISHED'],
    ['BOUNDARY_LOST', null, 'ENDING_NOT_ESTABLISHED'],
    ['TERMINATED_BY_CALLER', null, 'ENDING_NOT_ESTABLISHED'],
    ['', null, 'ENDING_NOT_ESTABLISHED'],
    ['ANYTHING-AT-ALL', 0, 'ENDING_NOT_ESTABLISHED'],
  ];

  it.each(REPORTS)('reads %s with exit %s as %s', (outcome, exitCode, expected) => {
    expect(classifyPublicationCommand(outcome, exitCode)).toBe(expected);
  });

  it('reads a report that is not a string at all as establishing nothing', () => {
    // The seam types `outcome` as a plain string, and two doubles in this
    // repository already return objects with no `outcome` field. `undefined`
    // must not read as anything but the weakest member.
    expect(classifyPublicationCommand(undefined as unknown as string, 0)).toBe(
      'ENDING_NOT_ESTABLISHED',
    );
  });

  it('refuses a start for exactly one member, and it is the negative one', () => {
    // Driven from the boundary's own vocabulary rather than from a hand-written
    // list of the ones expected to fail, and rather than from a filter over the
    // member names — a first version asserted that filtering this vocabulary for
    // the string `NO_PROCESS` yields `['NO_PROCESS']`, which is true of every
    // array containing it once and would have passed a build that added a second
    // negative-settling member.
    //
    // The rule: of everything the process boundary can answer, exactly one value
    // may reach `NO_PROCESS`, and it is the one whose own contract says nothing
    // was found to run. Reading a refused launch, a deadline or a lost boundary
    // that way would assert the one inference the boundary says it does not
    // support.
    const boundaryOutcomes = [
      'COMPLETED',
      'TIMED_OUT',
      'OUTPUT_LIMIT_EXCEEDED',
      'NOT_FOUND',
      'SPAWN_FAILED',
      'BOUNDARY_LOST',
    ] as const;
    const negative = boundaryOutcomes.filter(
      (o) => classifyPublicationCommand(o, null) === 'NO_PROCESS',
    );
    expect(negative).toEqual(['NOT_FOUND']);
    // …and no value outside that vocabulary reaches it either.
    for (const other of ['', 'TERMINATED_BY_CALLER', 'ANYTHING']) {
      expect(classifyPublicationCommand(other, 0), other).not.toBe('NO_PROCESS');
    }
    expect(PUBLICATION_COMMAND_REPORTS).toContain('NO_PROCESS');
  });

  it('keeps the one shape that ever meant a definite result', () => {
    // The boolean this replaced was `outcome === 'COMPLETED' && exitCode === 0`,
    // and the grade still turns on exactly that pair. A member that widened it
    // would change what `PUBLISHED` means without touching the grader.
    for (const [outcome, exitCode, expected] of REPORTS) {
      const definite = outcome === 'COMPLETED' && exitCode === 0;
      expect(expected === 'RAN_TO_EXIT_ZERO', `${outcome}/${exitCode}`).toBe(definite);
    }
  });
});

describe('an outcome is bound to one authorisation, and to no other', () => {
  it('reads back the bytes it wrote', () => {
    expect(readHeadPublicationOutcome(bytesFor(payloadFor()), SUBJECT)).toBe('HISTORICAL_OUTCOME');
  });

  it('answers absence, malformation and an unknown version apart', () => {
    expect(readHeadPublicationOutcome(Buffer.alloc(0), SUBJECT)).toBe('ABSENT');
    expect(readHeadPublicationOutcome(Buffer.from('{', 'utf8'), SUBJECT)).toBe('MALFORMED');
    expect(readHeadPublicationOutcome(Buffer.from('[]', 'utf8'), SUBJECT)).toBe('MALFORMED');
    expect(
      readHeadPublicationOutcome(
        Buffer.from(JSON.stringify({ outcomeVersion: 2 }), 'utf8'),
        SUBJECT,
      ),
    ).toBe('UNSUPPORTED_VERSION');
    expect(
      readHeadPublicationOutcome(
        Buffer.from(JSON.stringify({ outcomeVersion: 'one' }), 'utf8'),
        SUBJECT,
      ),
    ).toBe('MALFORMED');
  });

  it('refuses one past the bound rather than reading it', () => {
    const long = Buffer.alloc(MAX_HEAD_PUBLICATION_OUTCOME_BYTES + 1, 0x20);
    expect(readHeadPublicationOutcome(long, SUBJECT)).toBe('MALFORMED');
  });

  it('refuses a field the contract does not declare', () => {
    const payload = payloadFor();
    const bytes = Buffer.from(
      `${JSON.stringify({
        ...payload,
        binding: headPublicationOutcomeBinding(SUBJECT, payload),
        extra: 'x',
      })}\n`,
      'utf8',
    );
    expect(readHeadPublicationOutcome(bytes, SUBJECT)).toBe('MALFORMED');
  });

  /**
   * Every binding input, substituted one at a time.
   *
   * Four of them are the reader's own subject and three of those never appear in
   * the document at all — so an outcome cannot claim its own task, its own
   * checkout or its own authorisation. The fourth, the event identity, is in
   * both places and is compared as well as digested, because a digest recomputed
   * over a pair that disagrees is self-consistent.
   */
  const SUBSTITUTIONS: readonly (readonly [string, HeadPublicationOutcomeSubject])[] = [
    ['another event directory', { ...SUBJECT, eventId: '20260827T120000000Z-99999999-2222-4333-8444-555555555555' }],
    ['another task', { ...SUBJECT, taskId: 'V4-99' }],
    ['another checkout', { ...SUBJECT, repositoryRoot: 'C:\\scratch\\other' }],
    ['another authorisation', { ...SUBJECT, authorisationBinding: 'e'.repeat(64) }],
  ];

  it.each(SUBSTITUTIONS)('refuses an outcome read under %s', (_name, subject) => {
    expect(readHeadPublicationOutcome(bytesFor(payloadFor()), subject)).toBe('NOT_THIS_EVENT');
  });

  it('refuses an outcome whose own event identity was edited', () => {
    const payload = payloadFor({ eventId: 'somebody-elses-event' });
    // Digested consistently over the edited pair — the shape a hand-recomputed
    // document has — so only the explicit comparison can catch it.
    expect(readHeadPublicationOutcome(bytesFor(payload), SUBJECT)).toBe('NOT_THIS_EVENT');
  });

  it.each([
    ['the outcome member', { outcome: 'DISPATCHED_REF_ABSENT_AFTER' as const }],
    ['the command report', { commandReport: 'NO_PROCESS' as const }],
    ['the instant', { recordedAt: '2020-01-01T00:00:00.000Z' }],
  ])('refuses a document whose %s was edited without recomputing', (_name, over) => {
    const original = payloadFor();
    const bytes = Buffer.from(
      `${JSON.stringify({
        ...original,
        ...over,
        binding: headPublicationOutcomeBinding(SUBJECT, original),
      })}\n`,
      'utf8',
    );
    expect(readHeadPublicationOutcome(bytes, SUBJECT)).toBe('NOT_THIS_EVENT');
  });

  it('hands out a view whose field names are the record\'s, one at a time', () => {
    const inspected = inspectHeadPublicationOutcome(bytesFor(payloadFor()), SUBJECT);
    expect(inspected.reading).toBe('HISTORICAL_OUTCOME');
    const record = JSON.parse(bytesFor(payloadFor()).toString('utf8')) as Record<string, unknown>;
    for (const [from, to] of HEAD_PUBLICATION_OUTCOME_RECORD_FIELDS) {
      expect(
        (inspected.record as unknown as Record<string, unknown>)[to],
        `${from} -> ${to}`,
      ).toEqual(record[from]);
    }
    expect(Object.keys(record).sort()).toEqual(
      HEAD_PUBLICATION_OUTCOME_RECORD_FIELDS.map(([from]) => from).sort(),
    );
  });

  it('carries no record on any reading it refused', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('{', 'utf8')]) {
      expect(inspectHeadPublicationOutcome(bytes, SUBJECT).record).toBeNull();
    }
  });
});

describe('the outcome store writes once and never over', () => {
  it('writes a real outcome beside a real authorisation', () => {
    const planted = plantAuthorisation(scratchHome());
    expect(recordOutcome(planted).code).toBe('RECORDED');
    const stored = readOutcome(planted.home, planted.eventId);
    expect(stored.eventId).toBe(planted.eventId);
    expect(stored.act).toBe('HEAD_PUBLICATION');
    expect(stored.outcome).toBe('DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER');
    expect(stored.commandReport).toBe('RAN_TO_EXIT_ZERO');
    // …and the authorisation beside it is untouched, byte for byte.
    const authorisation = readFileSync(
      join(auditRoot(planted.home), planted.eventId, HEAD_PUBLICATION_AUDIT_FILE_NAME),
    );
    expect(recordOutcome(planted).code).not.toBe('RECORDED');
    expect(
      readFileSync(join(auditRoot(planted.home), planted.eventId, HEAD_PUBLICATION_AUDIT_FILE_NAME)),
    ).toEqual(authorisation);
  });

  it('refuses a second outcome for the same event, and leaves the first', () => {
    const planted = plantAuthorisation(scratchHome());
    expect(recordOutcome(planted, { outcome: 'DISPATCHED_REF_ABSENT_AFTER' }).code).toBe('RECORDED');
    const first = readFileSync(outcomePath(planted.home, planted.eventId));

    const second = recordOutcome(planted, { outcome: 'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER' });
    expect(second.code).toBe('OUTCOME_ALREADY_PRESENT');
    expect(second.recorded).toBe(false);
    expect(readFileSync(outcomePath(planted.home, planted.eventId))).toEqual(first);
  });

  it('refuses a byte-identical second outcome too, and never opens the first', () => {
    // Idempotency is a property of retried operations and nothing on this path
    // retries. The event name carries a UUID this process minted and the
    // directory was created exclusively by it, so anything already at the name
    // was written by something else — and reporting it as recorded would
    // attribute a foreign document to this run.
    const planted = plantAuthorisation(scratchHome());
    expect(recordOutcome(planted).code).toBe('RECORDED');
    expect(recordOutcome(planted).code).toBe('OUTCOME_ALREADY_PRESENT');
  });

  it('refuses an occupied name whatever occupies it', () => {
    const planted = plantAuthorisation(scratchHome());
    mkdirSync(outcomePath(planted.home, planted.eventId), { recursive: true });
    expect(recordOutcome(planted).code).toBe('OUTCOME_ALREADY_PRESENT');
  });

  it('refuses an event directory that is not there', () => {
    const planted = plantAuthorisation(scratchHome());
    rmSync(join(auditRoot(planted.home), planted.eventId), { recursive: true, force: true });
    const result = recordOutcome(planted);
    expect(result.code).toBe('EVENT_DIRECTORY_UNUSABLE');
    expect(result.recorded).toBe(false);
  });

  it('refuses an event name it would not mint, before touching anything', () => {
    const planted = plantAuthorisation(scratchHome());
    for (const bad of ['..', 'a/b', '', 'not-an-event-name']) {
      const result = recordOutcome(planted, { eventId: bad });
      expect(result.code, bad).toBe('EVENT_ID_UNSUITABLE');
    }
    // Nothing was written under the real event either.
    expect(outcomeExists(planted.home, planted.eventId)).toBe(false);
  });

  it('refuses a store whose path runs through a link', () => {
    const planted = plantAuthorisation(scratchHome());
    const real = join(auditRoot(planted.home), planted.eventId);
    const elsewhere = scratchRoot('ao-v416-link-');
    rmSync(real, { recursive: true, force: true });
    let linked = false;
    try {
      symlinkSync(elsewhere, real, 'junction');
      linked = true;
    } catch {
      // A machine that will not create one cannot measure this. The case says
      // so rather than passing on an absence.
    }
    if (!linked) return;
    expect(recordOutcome(planted).code).toBe('STORE_PATH_UNSAFE');
  });

  /**
   * The three answers a real filesystem will not give on demand.
   *
   * Each one is a write that reached the name and did not carry through, and the
   * difference between them and `WRITE_REFUSED` is what an operator will find
   * later: a consumed name holding something unreadable, rather than a free one.
   */
  it.each([
    ['WRITE_FAILED', 'WRITE_UNCONFIRMED'],
    ['SYNC_FAILED', 'WRITE_UNCONFIRMED'],
    ['CLOSE_FAILED', 'WRITE_UNCONFIRMED'],
    ['OPEN_FAILED', 'WRITE_REFUSED'],
    ['PATH_ESCAPES_RUN_DIRECTORY', 'WRITE_REFUSED'],
    ['PATH_CONTAINS_LINK', 'STORE_PATH_UNSAFE'],
    ['RUN_DIRECTORY_UNUSABLE', 'EVENT_DIRECTORY_UNUSABLE'],
    ['TARGET_EXISTS', 'OUTCOME_ALREADY_PRESENT'],
  ] as const)('turns the artefact writer\'s %s into %s', (given, expected) => {
    const planted = plantAuthorisation(scratchHome());
    const result = recordOutcome(planted, { writeArtifact: refusingWriter(given) });
    expect(result.code).toBe(expected);
    expect(result.recorded).toBe(false);
  });

  it('refuses a writer that claims success without leaving bytes', () => {
    // The read-back is a statement about the disk rather than about a function
    // that returned, and this is the shape that separates the two.
    const planted = plantAuthorisation(scratchHome());
    const result = recordOutcome(planted, { writeArtifact: refusingWriter('WRITTEN') });
    expect(result.code).toBe('READBACK_FAILED');
  });

  it('refuses bytes on the disk that this invocation did not intend', () => {
    const planted = plantAuthorisation(scratchHome());
    const liar = ((request: { readonly runDirectory: string; readonly fileName: string }) => {
      writeFileSync(join(request.runDirectory, request.fileName), 'not what was built', 'utf8');
      return Object.freeze({
        code: 'WRITTEN' as const,
        written: true,
        path: join(request.runDirectory, request.fileName),
        bytesWritten: 1,
        synced: true,
        errnoCode: null,
      });
    }) as typeof writeRunArtifact;
    expect(recordOutcome(planted, { writeArtifact: liar }).code).toBe('READBACK_MISMATCH');
  });

  it('uses the real exclusive primitive when nothing is injected', () => {
    // The seam is beside the real thing and never instead of it. Two real writes
    // into one real directory: the first creates the name and the second is
    // refused by the kernel, in the same syscall that would have created it.
    const planted = plantAuthorisation(scratchHome());
    expect(recordOutcome(planted).code).toBe('RECORDED');
    expect(recordOutcome(planted).code).toBe('OUTCOME_ALREADY_PRESENT');
    expect(codeOnly(STORE)).toContain('writeRunArtifact');
    expect(codeOnly(STORE)).not.toContain('renameSync');
    expect(codeOnly(STORE)).not.toContain('writeFileAtomically');
  });

  it('grades every store code, and every one of them apart', () => {
    expect(new Set(HEAD_PUBLICATION_OUTCOME_CODES).size).toBe(
      HEAD_PUBLICATION_OUTCOME_CODES.length,
    );
    expect(HEAD_PUBLICATION_OUTCOME_CODES[0]).toBe('RECORDED');
    for (const forbidden of ['ALREADY_RECORDED', 'RETRY', 'BRANCH_CREATED', 'PUBLICATION_ATTEMPTED']) {
      expect(HEAD_PUBLICATION_OUTCOME_CODES as readonly string[], forbidden).not.toContain(forbidden);
    }
  });
});


/**
 * V4 slice 18R — the first publication, with nobody present.
 *
 * The dogfood defect and the accountability contract meet here. On a delivery
 * head github.com cannot address, the driver now reaches the publication — and
 * every gate the automatic path has always had must still be the thing that
 * decides whether anything is sent. The locator's answer changes **when**
 * `performPublication` runs, and nothing about what it is allowed to do.
 */
describe('a first publication is still authorised, recorded and fenced', () => {
  const MISSING = { locatorMissing: true } as const;

  it('publishes once, and leaves the whole event behind', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, {
      ...MISSING,
      before: 'absent',
      after: 'at-head',
    });

    expect(run.counts.publish).toBe(1);
    // The authorisation was durable before the remote was contacted, and the
    // outcome is beside it afterwards — the two halves of V4 slices 14 and 16,
    // unchanged by a slice that only moved where the act is reached from.
    const stored = readOutcome(home, onlyEvent(home));
    expect(stored.outcome).toBe('DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER');
    expect(stored.commandReport).toBe('RAN_TO_EXIT_ZERO');
    expect(drivenLine(run)).toBe('EFFECT_ATTEMPTED');
    expect(run.exitCode).toBe(EXIT_RUN_CALL_AGAIN);
  });

  it('sends nothing where this machine’s operator declared nothing', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    const run = await drive(AUTOMATIC, root, home, { ...MISSING, before: 'absent' });

    expect(run.counts.publish).toBe(0);
    expect(eventIds(home)).toEqual([]);
    expect(drivenLine(run)).toBe('ATTENDED_AUTHORITY_REQUIRED');
  });

  it('sends nothing where the declaration says an operator must be present', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, 'ATTENDED_ONLY');
    const run = await drive(AUTOMATIC, root, home, { ...MISSING, before: 'absent' });

    expect(run.counts.publish).toBe(0);
    expect(eventIds(home)).toEqual([]);
    expect(drivenLine(run)).toBe('ATTENDED_AUTHORITY_REQUIRED');
  });

  it('stops for accountability when the outcome cannot be written', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, {
      ...MISSING,
      before: 'absent',
      after: 'at-head',
      outcomeWrite: 'WRITE_FAILED',
    });

    // The act happened and the record of it did not. That is the one thing the
    // driver may not report as "ask again".
    expect(run.counts.publish).toBe(1);
    expect(drivenLine(run)).toBe('PUBLICATION_OUTCOME_NOT_DURABLE');
  });

  /**
   * The race, with nobody present.
   *
   * The locator said the forge does not resolve this commit; the ref already
   * holds it. Nothing is sent — and the outcome is still recorded, because an
   * authorisation was written and every authorised run leaves one, including the
   * four that send nothing.
   */
  it('records a run that found the ref already there, and opens nothing', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { ...MISSING, before: 'at-head' });

    expect(run.counts.publish).toBe(0);
    expect(readOutcome(home, onlyEvent(home)).outcome).toBe(
      'NOT_DISPATCHED_REF_AT_SUBJECT_COMMIT',
    );
    expect(drivenLine(run)).toBe('FORGE_READINGS_DISAGREE');
  });

  /**
   * The precondition, on this path specifically.
   *
   * An unattended publication writes its authorisation record and reads it back
   * *before* the delivery remote is contacted, and refuses if it cannot. The
   * store's own root name is occupied with an ordinary file, which is the same
   * real obstruction `tests/v4-14-…` uses — no seam, no stub.
   *
   * Added because the ADR claimed this was pinned on the new branch and a review
   * measured that it was not: the arm lives in the shared closure and is correct
   * by construction, which is exactly the kind of claim that needs a case rather
   * than an argument.
   */
  it('publishes nothing when the record of the permission cannot be written', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    writeFileSync(join(home, '.agent-orchestrator', 'head-publication-authorisations'), 'x', 'utf8');

    const run = await drive(AUTOMATIC, root, home, { ...MISSING, before: 'absent' });

    expect(run.counts.publish, 'nothing may be sent').toBe(0);
    expect(run.counts.remoteReads, 'the remote is not read either').toBe(0);
    expect(drivenLine(run)).toBe('PUBLICATION_AUDIT_NOT_DURABLE');
  });

  it('refuses to move a ref that holds another commit', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { ...MISSING, before: 'other' });

    expect(run.counts.publish).toBe(0);
    expect(readOutcome(home, onlyEvent(home)).outcome).toBe('NOT_DISPATCHED_REF_AT_OTHER_COMMIT');
    expect(drivenLine(run)).toBe('HUMAN_DECISION_REQUIRED');
  });
});

describe('every authorised run leaves an outcome, so an absent one means one thing', () => {
  it('records what it did when the ref already held the commit', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { before: 'at-head' });

    expect(run.counts.publish, 'nothing may be sent').toBe(0);
    const stored = readOutcome(home, onlyEvent(home));
    expect(stored.outcome).toBe('NOT_DISPATCHED_REF_AT_SUBJECT_COMMIT');
    expect(stored.commandReport).toBe('NOT_CALLED');
  });

  it('records what it did when the ref held another commit', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { before: 'other' });

    expect(run.counts.publish).toBe(0);
    expect(readOutcome(home, onlyEvent(home)).outcome).toBe('NOT_DISPATCHED_REF_AT_OTHER_COMMIT');
    expect(drivenLine(run)).toBe('HUMAN_DECISION_REQUIRED');
  });

  it('records what it did when the ref could not be read at all', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { before: 'unreadable' });

    expect(run.counts.publish).toBe(0);
    expect(readOutcome(home, onlyEvent(home)).outcome).toBe('NOT_DISPATCHED_REF_NOT_READ');
    expect(drivenLine(run)).toBe('FORGE_STATE_UNKNOWN');
  });

  it('records a definite result when the command ran and the ref holds the commit', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { before: 'absent', after: 'at-head' });

    expect(run.counts.publish).toBe(1);
    const stored = readOutcome(home, onlyEvent(home));
    expect(stored.outcome).toBe('DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER');
    expect(stored.commandReport).toBe('RAN_TO_EXIT_ZERO');
    expect(drivenLine(run)).toBe('EFFECT_ATTEMPTED');
    expect(run.exitCode).toBe(EXIT_RUN_CALL_AGAIN);
  });

  it('keeps the unknown as an unknown when the reading afterwards fails', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { before: 'absent', after: 'unreadable' });

    expect(run.counts.publish).toBe(1);
    const stored = readOutcome(home, onlyEvent(home));
    expect(stored.outcome).toBe('DISPATCHED_REF_NOT_READ_AFTER');
    // Not a refusal, not "not published", and not a failure. The member says
    // exactly what happened: a command went out and the ref could not be read.
    expect(String(stored.outcome)).not.toContain('ABSENT');
    expect(drivenLine(run)).toBe('EFFECT_ATTEMPTED');
  });

  it.each([
    ['a spawn the boundary refused', { outcome: 'SPAWN_FAILED', exitCode: null }, 'ENDING_NOT_ESTABLISHED'],
    ['a run that exceeded its deadline', { outcome: 'TIMED_OUT', exitCode: null }, 'ENDING_NOT_ESTABLISHED'],
    ['a run that exceeded a byte budget', { outcome: 'OUTPUT_LIMIT_EXCEEDED', exitCode: null }, 'RAN_TO_ANOTHER_ENDING'],
    ['a boundary this build could not account for', { outcome: 'BOUNDARY_LOST', exitCode: null }, 'ENDING_NOT_ESTABLISHED'],
    ['a report this build does not recognise', { outcome: 'SOMETHING-ELSE', exitCode: 0 }, 'ENDING_NOT_ESTABLISHED'],
    ['a command that ended non-zero', { outcome: 'COMPLETED', exitCode: 1 }, 'RAN_TO_ANOTHER_ENDING'],
    ['nothing to run at all', { outcome: 'NOT_FOUND', exitCode: null }, 'NO_PROCESS'],
  ] as const)('records %s as it was reported', async (_name, push, expected) => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { before: 'absent', after: 'absent', push });

    expect(run.counts.publish, 'the command must have been handed over').toBe(1);
    const stored = readOutcome(home, onlyEvent(home));
    expect(stored.commandReport).toBe(expected);
    // The dispatch half is decided by control flow and never by the report, so
    // every one of these is a dispatch — including the one where no process
    // existed.
    expect(String(stored.outcome).startsWith('DISPATCHED_')).toBe(true);
  });

  it('writes no outcome where nothing authorised one', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home, 'ATTENDED_ONLY');
    const run = await drive(AUTOMATIC, root, home);

    expect(run.counts.publish).toBe(0);
    expect(eventIds(home)).toEqual([]);
  });

  it('leaves the attended path exactly as it was', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    const run = await drive(ATTENDED, root, home, { before: 'absent', after: 'at-head' });

    expect(run.counts.publish, 'an attended publication still publishes').toBe(1);
    // No declaration, no authorisation record and no outcome: an operator was
    // present, which is the whole reason the automatic path needs either.
    expect(eventIds(home)).toEqual([]);
    expect(drivenLine(run)).toBe('EFFECT_ATTEMPTED');
    expect(run.exitCode).toBe(EXIT_RUN_CALL_AGAIN);
  });

  it('leaves two whole events when two runs publish, neither over the other', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    await drive(AUTOMATIC, root, home, { before: 'at-head' });
    await drive(AUTOMATIC, root, home, { before: 'at-head' });

    const ids = eventIds(home);
    expect(ids.length).toBe(2);
    for (const id of ids) {
      expect(outcomeExists(home, id), id).toBe(true);
      expect(readOutcome(home, id).eventId).toBe(id);
    }
  });
});

describe('an accountability failure after the act is never hidden behind it', () => {
  it('reports its own grade rather than the act\'s when the outcome cannot be written', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, {
      before: 'absent',
      after: 'at-head',
      outcomeWrite: 'WRITE_FAILED',
    });

    expect(run.counts.publish, 'the act still happened').toBe(1);
    expect(drivenLine(run)).toBe('PUBLICATION_OUTCOME_NOT_DURABLE');
    expect(run.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
    // …and emphatically not "ask again", which is an instruction nothing can
    // carry out: no invocation of anything will write this event's outcome now.
    expect(run.exitCode).not.toBe(EXIT_RUN_CALL_AGAIN);
  });

  it('prints the line its own sentence sends the operator to', async () => {
    // The detail says "what this invocation called and what it last read is on
    // the Publication line beside this". Advice that names a line is advice
    // about a line that has to be there — on both halves of this member's
    // producers, because the sentence is the same for both.
    const sent = repositoryRoot();
    const sentHome = scratchHome();
    writeReadyState(sent);
    declare(sentHome);
    const dispatched = await drive(AUTOMATIC, sent, sentHome, {
      before: 'absent',
      after: 'at-head',
      outcomeWrite: 'WRITE_FAILED',
    });
    expect(drivenLine(dispatched)).toBe('PUBLICATION_OUTCOME_NOT_DURABLE');
    expect(lineOf(dispatched, 'Publication')).not.toBeNull();
    // …and the store's own code, which is what separates the remedies.
    expect(lineOf(dispatched, ' *Outcome')).toBe('WRITE_UNCONFIRMED');

    const quiet = repositoryRoot();
    const quietHome = scratchHome();
    writeReadyState(quiet);
    declare(quietHome);
    const refused = await drive(AUTOMATIC, quiet, quietHome, {
      before: 'at-head',
      outcomeWrite: 'OPEN_FAILED',
    });
    expect(refused.counts.publish).toBe(0);
    expect(drivenLine(refused)).toBe('PUBLICATION_OUTCOME_NOT_DURABLE');
    // The line that tells the operator nothing was sent, on the run whose Drive
    // member deliberately does not say it.
    expect(lineOf(refused, 'Publication')).toBe('ALREADY_PUBLISHED');
    expect(lineOf(refused, ' *Outcome')).toBe('WRITE_REFUSED');
  });

  it('reports it after a refusal that sent nothing, too', async () => {
    // Precedence does not depend on whether the remote changed. The record is
    // missing either way, and a run that cannot say what it did is a run an
    // operator has to look at.
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, {
      before: 'at-head',
      outcomeWrite: 'OPEN_FAILED',
    });

    expect(run.counts.publish).toBe(0);
    expect(drivenLine(run)).toBe('PUBLICATION_OUTCOME_NOT_DURABLE');
    expect(run.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('reports it when the outcome is unknown and the record cannot be written', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, {
      before: 'absent',
      after: 'unreadable',
      outcomeWrite: 'SYNC_FAILED',
    });

    expect(run.counts.publish).toBe(1);
    expect(drivenLine(run)).toBe('PUBLICATION_OUTCOME_NOT_DURABLE');
  });

  it('sends nothing a second time when the record could not be written', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, {
      before: 'absent',
      after: 'at-head',
      outcomeWrite: 'CLOSE_FAILED',
    });

    // One push, and no compensating act: nothing is deleted, moved or retried
    // to obtain a record. There is nothing this build could undo.
    expect(run.counts.publish).toBe(1);
  });

  it('is a member of its own, and says nothing its producers do not share', () => {
    expect(DELIVERY_DRIVES as readonly string[]).toContain('PUBLICATION_OUTCOME_NOT_DURABLE');
    expect(exitCodeForDrive('PUBLICATION_OUTCOME_NOT_DURABLE')).toBe(EXIT_RUN_NEEDS_OPERATOR);
    // Its sibling says in its own words that nothing was attempted. This one may
    // say neither that nor its opposite: it is reachable from four paths that
    // sent nothing and from one that may have changed the remote, so its
    // sentence may claim only what is true of all five.
    //
    // The negative half alone is not enough, and a first draft had only that: it
    // let "One publication was attempted with nobody present" stand, which three
    // review lenses caught and which is the overclaim this slice exists to
    // prevent, pointing the other way.
    const detail = DELIVERY_DRIVE_DETAIL.PUBLICATION_OUTCOME_NOT_DURABLE;
    expect(DELIVERY_DRIVE_DETAIL.PUBLICATION_AUDIT_NOT_DURABLE).toMatch(/nothing was attempted/);
    expect(detail).not.toMatch(/nothing was attempted/);
    expect(detail.length).toBeGreaterThan(40);
    // The rule rather than a list of phrasings: an outcome verb may appear only
    // in a clause that denies it.
    //
    // Three things about this instrument were measured wrong before it settled,
    // and each is why it looks the way it does.
    //
    //  1. **a flat substring list is the wrong shape.** A first version banned
    //     "was sent" and failed on "nothing was sent a second time", which is a
    //     denial and is the sentence doing the work;
    //  2. **the verb list has to reach the main clause.** The second version's
    //     list did not contain `ran`, and the sentence it was guarding opened
    //     "A publication … ran" — the same overclaim in weaker clothing, and
    //     invisible to the guard written to catch it;
    //  3. **the negation has to be in the same clause.** A backwards window
    //     across sentence boundaries is a co-occurrence control: prepend
    //     "Nothing was undone." to the exact sentence Review 1 blocked and it
    //     passes. The window is now one clause, split on the punctuation that
    //     ends one, and the negations are whole words so `another` and `note` do
    //     not license anything.
    //
    // What it is **not**: a bound on the proposition. An independent
    // confirmation wrote two sentences that pass it and still assert the act —
    // "was performed", "took place" — because no closed word list can fence a
    // natural-language claim. This is a regression fence over the phrasings that
    // have actually been written here, and each of the two blockers put one more
    // word in it. It is stated as that rather than as a proof, and the sentence
    // itself is held true by the producer enumeration in the member's own doc.
    const negation = /(^|[^a-z])(not|never|no|nothing|none|cannot|without)([^a-z]|$)/;
    const outcomes =
      /\b(attempted|published|created|sent|pushed|changed|ran|happened|occurred|performed|executed|took place)\b/g;
    const flat = detail.replace(/\s+/g, ' ').toLowerCase();
    let seen = 0;
    for (const match of flat.matchAll(outcomes)) {
      seen += 1;
      const index = match.index;
      // The clause this verb sits in: back to the nearest full stop, semicolon
      // or comma, and no further.
      const start = Math.max(
        flat.lastIndexOf('.', index),
        flat.lastIndexOf(';', index),
        flat.lastIndexOf(',', index),
      );
      const clause = flat.slice(start + 1, index);
      expect(
        negation.test(clause),
        `"${match[0]}" is asserted rather than denied in the clause: "${clause}${match[0]}"`,
      ).toBe(true);
    }
    expect(seen, 'the denial must actually use one of the words it denies').toBeGreaterThan(0);

    // …and the instrument is proved against the sentence it exists to refuse,
    // in both of the shapes that got past its earlier versions. Without this a
    // green result says nothing about whether the sweep can see anything.
    const refuse = (text: string): boolean => {
      const one = text.replace(/\s+/g, ' ').toLowerCase();
      for (const match of one.matchAll(outcomes)) {
        const index = match.index;
        const start = Math.max(
          one.lastIndexOf('.', index),
          one.lastIndexOf(';', index),
          one.lastIndexOf(',', index),
        );
        if (!negation.test(one.slice(start + 1, index))) return true;
      }
      return false;
    };
    expect(refuse('One publication was attempted with nobody present.')).toBe(true);
    expect(
      refuse('Nothing was undone. One publication was attempted with nobody present.'),
      'a denial in an earlier sentence must not license a later clause',
    ).toBe(true);
    expect(refuse('A publication this build was permitted to make ran.')).toBe(true);
    expect(refuse('Nothing was sent a second time and nothing was undone.')).toBe(false);
    // …and it must send the operator to the line that does carry the difference,
    // rather than leaving the distinction unsaid.
    expect(detail).toContain('Publication line');
  });

  it('grades every store code one at a time rather than with one number', () => {
    const graded = new Set<number>();
    for (const code of HEAD_PUBLICATION_OUTCOME_CODES) {
      graded.add(
        exitCodeForDrive('PUBLICATION_OUTCOME_NOT_DURABLE', { publicationOutcome: code }),
      );
    }
    // Two grades, and neither of them is "nothing is wrong" or "call again":
    // a person has to look, or the tool has a defect in it.
    expect([...graded].sort((a, b) => a - b)).toEqual(
      [EXIT_RUN_UNEXPECTED, EXIT_RUN_NEEDS_OPERATOR].sort((a, b) => a - b),
    );
    expect(graded.has(0)).toBe(false);
    expect(graded.has(EXIT_RUN_CALL_AGAIN)).toBe(false);
  });

  it('keeps the floor when no store code came back', () => {
    expect(exitCodeForDrive('PUBLICATION_OUTCOME_NOT_DURABLE')).toBe(EXIT_RUN_NEEDS_OPERATOR);
    expect(
      exitCodeForDrive('PUBLICATION_OUTCOME_NOT_DURABLE', { publicationOutcome: null }),
    ).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('does not let the store code change any other member\'s grade', () => {
    for (const member of DELIVERY_DRIVES) {
      if (member === 'PUBLICATION_OUTCOME_NOT_DURABLE') continue;
      expect(
        exitCodeForDrive(member, { publicationOutcome: 'WRITE_REFUSED' }),
        member,
      ).toBe(exitCodeForDrive(member));
    }
  });
});

describe('the chain, end to end: a run writes it and the reader reads it', () => {
  /**
   * The one guarantee this slice exists for, measured across every module that
   * carries it rather than in two halves that never meet.
   *
   * Every other case here builds its store with a fixture that hands the same
   * literals to both writers, so it cannot see a ladder that hands them two
   * different subjects — and it would not: `taskId` and `repositoryRoot` are not
   * fields of the outcome document, they are inputs to its digest, so a raw read
   * of `outcome.json` shows nothing wrong. A review found that a one-word change
   * in `performPublication` would make **every outcome this build ever writes**
   * read as `OUTCOME_NOT_THIS_EVENT` for ever, with the whole suite green.
   *
   * So this drives the real CLI over a real repository and a real profile, and
   * then reads the store with the real listing.
   */
  it('reads back what an unattended publication wrote, through the real listing', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { before: 'absent', after: 'at-head' });
    expect(run.counts.publish).toBe(1);

    const listed = listHeadPublicationAuthorisations(fixedPathProvider(home));
    expect(listed.outcome).toBe('READ');
    const entry = listed.entries[0];
    if (entry === undefined || entry.record === null) throw new Error('expected one read record');
    expect(entry.reading).toBe('HISTORICAL_AUTHORISATION');
    expect(entry.outcome).toBe('HISTORICAL_OUTCOME');
    expect(entry.outcomeRecord?.outcome).toBe('DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER');
    expect(entry.outcomeRecord?.commandReport).toBe('RAN_TO_EXIT_ZERO');
    // The two halves the document does not carry, proven equal by the fact that
    // the digest recomputed at all: the reader takes them off the authorisation
    // and the writer took them off the ladder.
    expect(entry.record.taskId).toBe(TASK);
    expect(entry.record.repositoryRoot).toBe(root);

    const text = report(home);
    expect(text).toContain('Outcome      : HISTORICAL_OUTCOME');
    expect(text).toContain('Publication  : DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER');
    expect(text).toContain('1 (1 read, 0 not read)');
  });

  it('reads back a run that sent nothing, and says so in the same shape', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const run = await drive(AUTOMATIC, root, home, { before: 'at-head' });
    expect(run.counts.publish).toBe(0);

    const listed = listHeadPublicationAuthorisations(fixedPathProvider(home));
    expect(listed.outcome).toBe('READ');
    const entry = listed.entries[0];
    if (entry === undefined || entry.record === null) throw new Error('expected one read record');
    expect(entry.outcome).toBe('HISTORICAL_OUTCOME');
    expect(entry.outcomeRecord?.outcome).toBe('NOT_DISPATCHED_REF_AT_SUBJECT_COMMIT');
    expect(entry.outcomeRecord?.commandReport).toBe('NOT_CALLED');
  });
});

describe('reading it back, without a repository, a forge or a policy', () => {
  it('says an authorisation with no outcome establishes no outcome', () => {
    const planted = plantAuthorisation(scratchHome());
    const text = report(planted.home);

    expect(text).toContain('Outcome      : OUTCOME_ABSENT');
    expect(text.replace(/\s+/g, ' ')).toContain(
      'It is not a statement that nothing reached the delivery remote',
    );
    // …and an event with no outcome does not grade the store down. Nothing
    // backfills, so every event older than this slice has this shape forever.
    expect(text).toContain('Listing      : READ');
  });

  it('shows an outcome it read, beside the record it belongs to', () => {
    const planted = plantAuthorisation(scratchHome());
    expect(recordOutcome(planted).code).toBe('RECORDED');
    const text = report(planted.home);

    expect(text).toContain('Outcome      : HISTORICAL_OUTCOME');
    expect(text).toContain('Publication  : DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER');
    expect(text).toContain('Command      : RAN_TO_EXIT_ZERO');
    expect(text).toContain('Listing      : READ');
  });

  it('partitions the entry vocabulary against the set that grades a store clean', () => {
    // The claim the constant's own comment makes, measured. Its sibling
    // `DISPATCHED_PUBLICATION_OUTCOMES` is partitioned and this one was not, so
    // adding a member to it would have widened what counts as a clean store with
    // nothing failing. One member, and it is the one that means "read".
    expect([...CLEAN_OUTCOME_ENTRY_READINGS].sort()).toEqual(
      ['HISTORICAL_OUTCOME', 'OUTCOME_ABSENT'].sort(),
    );
    const rest = HEAD_PUBLICATION_OUTCOME_ENTRY_READINGS.filter(
      (r) => !CLEAN_OUTCOME_ENTRY_READINGS.has(r),
    );
    // Deliberately not `clean.length + rest.length === vocabulary.length`: that
    // holds for every array and every predicate, including one that answers true
    // for all of them, and a review found it standing in for the partition this
    // case is named after. The exact-set assertion above and the exact-rest
    // assertion below are what carry it.
    // Every member that means "there is a document here I could not read" grades
    // the store down, and none of them is missing from the second half.
    expect(rest.sort()).toEqual(
      [
        'OUTCOME_EMPTY',
        'OUTCOME_UNREADABLE',
        'OUTCOME_MALFORMED',
        'OUTCOME_UNSUPPORTED_VERSION',
        'OUTCOME_NOT_THIS_EVENT',
      ].sort(),
    );
  });

  it('surfaces an outcome it could not read, and grades the store down', () => {
    const planted = plantAuthorisation(scratchHome());
    writeFileSync(outcomePath(planted.home, planted.eventId), 'not a record', 'utf8');
    const text = report(planted.home);

    expect(text).toContain('Outcome      : OUTCOME_MALFORMED');
    expect(text).toContain('Listing      : READ_WITH_UNUSABLE_ENTRIES');
    // The authorisation is still read. An unreadable outcome does not take the
    // record beside it down with it.
    expect(text).toContain('Reading      : HISTORICAL_AUTHORISATION');
  });

  it('tells an empty outcome from an unreadable one from a foreign one', () => {
    const empty = plantAuthorisation(scratchHome());
    writeFileSync(outcomePath(empty.home, empty.eventId), '', 'utf8');
    expect(report(empty.home)).toContain('Outcome      : OUTCOME_EMPTY');

    const future = plantAuthorisation(scratchHome());
    writeFileSync(
      outcomePath(future.home, future.eventId),
      JSON.stringify({ outcomeVersion: 2 }),
      'utf8',
    );
    expect(report(future.home)).toContain('Outcome      : OUTCOME_UNSUPPORTED_VERSION');

    const foreign = plantAuthorisation(scratchHome());
    writeFileSync(outcomePath(foreign.home, foreign.eventId), bytesFor(payloadFor()));
    expect(report(foreign.home)).toContain('Outcome      : OUTCOME_NOT_THIS_EVENT');
  });

  it('refuses anything at the outcome\'s name that is not an ordinary file', () => {
    // A directory at the name, which needs no privilege and reaches the same
    // refusal a link does. It is here rather than only in the link case below
    // because that one needs `SeCreateSymbolicLinkPrivilege` on this build's own
    // stated platform, and a review found it returning early with no assertion
    // at all on a machine without it — a case that reported green having
    // measured nothing.
    const planted = plantAuthorisation(scratchHome());
    mkdirSync(outcomePath(planted.home, planted.eventId), { recursive: true });
    expect(report(planted.home)).toContain('Outcome      : OUTCOME_UNREADABLE');
  });

  it('never follows a link at the outcome\'s name', () => {
    const planted = plantAuthorisation(scratchHome());
    const elsewhere = join(scratchRoot('ao-v416-target-'), 'outcome.json');
    const other = plantAuthorisation(scratchHome());
    expect(recordOutcome(other).code).toBe('RECORDED');
    writeFileSync(elsewhere, readFileSync(outcomePath(other.home, other.eventId)));
    let linked = false;
    try {
      symlinkSync(elsewhere, outcomePath(planted.home, planted.eventId), 'file');
      linked = true;
    } catch {
      // A file symlink needs a privilege this build does not require of an
      // operator. The unconditional half of this refusal is the case above.
    }
    if (!linked) return;
    // The bytes at the far end are a real, readable outcome — for another event.
    // Following the link would file them under this one's name, which is the
    // single thing an accountability listing may not do.
    expect(report(planted.home)).toContain('Outcome      : OUTCOME_UNREADABLE');
    expect(report(planted.home)).not.toContain('Outcome      : HISTORICAL_OUTCOME');
  });

  it('never attaches an outcome to a record it refused', () => {
    // The type puts the field on one arm of the union, so this is a property of
    // the shape rather than of care — and it is asserted anyway, because a later
    // change could widen the union.
    const home = scratchHome();
    const eventId = newHeadPublicationAuditEventId(new Date(AT));
    mkdirSync(join(auditRoot(home), eventId), { recursive: true });
    writeFileSync(join(auditRoot(home), eventId, HEAD_PUBLICATION_AUDIT_FILE_NAME), '{}', 'utf8');
    writeFileSync(
      join(auditRoot(home), eventId, HEAD_PUBLICATION_OUTCOME_FILE_NAME),
      bytesFor(payloadFor()),
    );

    const listed = listHeadPublicationAuthorisations(fixedPathProvider(home));
    const entry = listed.entries[0];
    expect(entry?.reading).toBe('RECORD_MALFORMED');
    expect('outcome' in (entry as object)).toBe(false);
    const text = report(home);
    expect(text).not.toContain('Outcome      :');
    expect(text).not.toContain('Publication  :');
    expect(text).not.toContain('Command      :');
  });

  it('anchors the outcome to the directory name, which the record cannot differ from', () => {
    // Why a mutant that swapped `name` for the record's own claimed event id
    // survives, written down rather than left as an unexplained survivor: on the
    // arm where an outcome is read at all, the authorisation's grader has
    // already refused every record whose `eventId` is not the directory it sits
    // in, so the two values are provably equal there. This pins that invariant,
    // which is what the equivalence rests on — if it ever stops holding, the
    // reader's anchor becomes a value out of a document.
    const home = scratchHome();
    const planted = plantAuthorisation(home);
    expect(recordOutcome(planted).code).toBe('RECORDED');
    const listed = listHeadPublicationAuthorisations(fixedPathProvider(home));
    let read = 0;
    for (const entry of listed.entries) {
      if (entry.record === null) continue;
      read += 1;
      expect(entry.record.recordedEventId).toBe(entry.name);
    }
    expect(read, 'the invariant must have been asked of something').toBe(1);
  });

  it('does not let one damaged outcome hide the events beside it', () => {
    const home = scratchHome();
    const first = plantAuthorisation(home);
    expect(recordOutcome(first).code).toBe('RECORDED');
    const second = plantAuthorisation(home);
    writeFileSync(outcomePath(second.home, second.eventId), '{', 'utf8');
    const third = plantAuthorisation(home);

    const text = report(home);
    for (const id of [first.eventId, second.eventId, third.eventId]) {
      expect(text, id).toContain(id);
    }
    expect(text).toContain('Listing      : READ_WITH_UNUSABLE_ENTRIES');
    // The tally counts the same thing the grade does. It counted records alone
    // in a first draft, so this store read as "3 read, 0 not read" three lines
    // under a grade saying one of them was not — the line whose whole purpose is
    // that a damaged store cannot pass for a clean one at a glance.
    expect(text).toContain('3 (2 read, 1 not read)');
  });

  it('reads the store with no git, no forge client, no lease and no network', () => {
    const code = codeOnly(READER) + codeOnly(RENDERER) + codeOnly(COMMAND) + codeOnly(CONTRACT);
    for (const forbidden of [
      'runCommand',
      'runGitCommand',
      'GitPublicationRunner',
      'ForgeCommandRunner',
      'acquireExecutionLease',
      'loadDeliveryAutomation',
      'loadTaskState',
      'resolveRepository',
      'fetch(',
      'https',
      'spawn',
      'execFile',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it('creates nothing and writes nothing on the read side', () => {
    for (const file of READ_SIDE) {
      const code = codeOnly(file);
      for (const forbidden of ['mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync', 'rmSync', 'writeRunArtifact', 'createRunDirectory']) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('sweeps every module the reader can reach, and no fewer', () => {
    // The pin slice 15 did not have, and a first draft of this one did not
    // either: it asserted that one hard-coded import string was present and that
    // one hard-coded constant was in the list. Both assertions are in the
    // direction that cannot fail when a module is *added*, which is exactly the
    // blind spot the case is named after. This computes the closure.
    //
    // `import type` is erased under this build's `verbatimModuleSyntax`, so a
    // type-only edge puts nothing in the graph. It is followed anyway: a sweep
    // that measured less than the source names would be the weaker instrument,
    // and the cost of following it is one more file in a list of six.
    const closure = new Set<string>();
    const walk = (file: string): void => {
      if (closure.has(file)) return;
      closure.add(file);
      const here = file.slice(0, file.lastIndexOf('/'));
      for (const match of readFileSync(file, 'utf8').matchAll(/from '(\.[^']*)\.js'/g)) {
        const relative = match[1] as string;
        const parts = `${here}/${relative}`.split('/');
        const resolved: string[] = [];
        for (const part of parts) {
          if (part === '.') continue;
          if (part === '..') resolved.pop();
          else resolved.push(part);
        }
        walk(`${resolved.join('/')}.ts`);
      }
    };
    walk(READER);

    // The reader's whole graph, and what it may not contain. This is the sweep
    // slice 15 ran over three hand-listed files, over every file instead.
    expect(closure.size).toBeGreaterThan(5);
    expect([...closure]).toContain(CONTRACT);
    // The staging write and the publishing rename are outside the graph
    // entirely, which is what importing the location module rather than either
    // store buys. Asserted rather than described, because a review measured the
    // stronger claim — that no create primitive is reachable — and found it
    // false: `doctor/safe-write.ts` and `doctor/run-directory.ts` are both in
    // here, for their path-safety helpers and their name grammar.
    expect([...closure]).not.toContain('src/state/atomic-file.ts');
    expect([...closure]).not.toContain('src/deliver/head-publication-outcome-store.ts');
    expect([...closure]).not.toContain('src/deliver/head-publication-authorisation-store.ts');
    expect([...closure], 'the honest bound, stated as a fact').toContain('src/doctor/safe-write.ts');
    for (const file of closure) {
      const code = codeOnly(file);
      for (const forbidden of [
        'runCommand',
        'runGitCommand',
        'GitPublicationRunner',
        'ForgeCommandRunner',
        'acquireExecutionLease',
        'loadDeliveryAutomation',
        'loadTaskState',
        'resolveRepository',
        'mintHeadPublicationGrant',
        'fetch(',
        'spawn',
        'execFile',
      ]) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }

    // …and the hand-written list this file sweeps elsewhere is a subset of that
    // graph plus the two CLI modules above it, so it cannot name a module the
    // reader cannot reach.
    for (const file of READ_SIDE) {
      if (file === RENDERER || file === COMMAND) continue;
      expect([...closure], file).toContain(file);
    }
  });
});

describe('an outcome grants nothing, and repairs nothing', () => {
  it('is read by no module that mints or claims the publication authority', () => {
    const readers: string[] = [];
    for (const file of walkSource('src')) {
      // The module that declares the graders is not a caller of them. Excluded
      // by name rather than by a pattern, so a second declaring module would
      // show up here rather than be absorbed.
      if (file === CONTRACT) continue;
      const code = codeOnly(file);
      if (code.includes('inspectHeadPublicationOutcome') || code.includes('readHeadPublicationOutcome')) {
        readers.push(file);
      }
    }
    // Two, and neither is the ladder: the store grades the bytes it just built,
    // and the listing grades the bytes an operator asked about.
    expect(readers.sort()).toEqual([READER, STORE].sort());
    for (const file of readers) {
      expect(codeOnly(file), file).not.toContain('mintHeadPublicationGrant');
      expect(codeOnly(file), file).not.toContain('claimHeadPublication');
    }
  });

  it('is never read by the module that decides whether to publish', () => {
    const ladder = codeOnly('src/cli/delivery-steps.ts');
    // It writes one and never reads one. A path that read an outcome back would
    // be a path on which yesterday's evidence could answer today's question.
    expect(ladder).toContain('recordHeadPublicationOutcome');
    expect(ladder).not.toContain('inspectHeadPublicationOutcome');
    expect(ladder).not.toContain('readHeadPublicationOutcome');
    expect(ladder).not.toContain('listHeadPublicationAuthorisations');
  });

  it('does not let an outcome on disk publish under a permission that has gone', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    const first = await drive(AUTOMATIC, root, home, { before: 'absent', after: 'at-head' });
    expect(first.counts.publish).toBe(1);
    expect(outcomeExists(home, onlyEvent(home))).toBe(true);

    declare(home, 'ATTENDED_ONLY');
    const second = await drive(AUTOMATIC, root, home, { before: 'absent', after: 'at-head' });
    expect(second.counts.publish, 'a stored outcome authorises nothing').toBe(0);
    expect(drivenLine(second)).toBe('ATTENDED_AUTHORITY_REQUIRED');
  });

  it('does not let an outcome on disk stand in for a fresh reading', async () => {
    const root = repositoryRoot();
    const home = scratchHome();
    writeReadyState(root);
    declare(home);
    await drive(AUTOMATIC, root, home, { before: 'absent', after: 'at-head' });
    const first = eventIds(home);

    // The next invocation reads the remote for itself, finds the commit there
    // and sends nothing — from the reading, not from the record.
    const second = await drive(AUTOMATIC, root, home, { before: 'at-head' });
    expect(second.counts.publish).toBe(0);
    expect(second.counts.remoteReads).toBeGreaterThan(0);
    // Identified by difference and not by position: both events carry the same
    // stamped instant, so their order between them is the random half of the
    // name and means nothing.
    const added = eventIds(home).filter((id) => !first.includes(id));
    expect(added.length).toBe(1);
    expect(readOutcome(home, added[0] as string).outcome).toBe(
      'NOT_DISPATCHED_REF_AT_SUBJECT_COMMIT',
    );
  });

  it('opens no pull request and merges nothing from any of it', () => {
    for (const file of [CONTRACT, STORE, READER, RENDERER, COMMAND]) {
      const code = codeOnly(file);
      for (const forbidden of ['createPullRequest', 'mergePullRequest', 'setTimeout', 'setInterval', 'cron']) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('writes no task state and no ledger', () => {
    for (const file of [CONTRACT, STORE]) {
      const code = codeOnly(file);
      for (const forbidden of ['saveTaskState', 'appendBlockLedger', 'READY_FOR_PR']) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe('the record claims what it saw, and never who acted', () => {
  it('has no field, and no vocabulary, that names an author', () => {
    const planted = plantAuthorisation(scratchHome());
    expect(recordOutcome(planted).code).toBe('RECORDED');
    const stored = readOutcome(planted.home, planted.eventId);

    for (const forbidden of ['createdBy', 'created', 'published', 'author', 'state', 'phase', 'status', 'retryAfter', 'pending']) {
      expect(Object.keys(stored), forbidden).not.toContain(forbidden);
    }
    // No member of the publication grader is copied in either — the outcome must
    // not be able to say `PUBLISHED` about itself.
    const serialised = JSON.stringify(stored);
    for (const member of HEAD_PUBLICATIONS) {
      expect(serialised, member).not.toContain(member);
    }
  });

  it('never names an author anywhere on the slice\'s own surface', () => {
    for (const file of [CONTRACT, STORE]) {
      const text = readFileSync(file, 'utf8');
      for (const forbidden of ['CREATED_BY_AO', 'createdByAo', 'BRANCH_CREATED', 'PUBLICATION_ATTEMPTED', 'AO_CREATED']) {
        expect(text, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('keeps every member free of a verb whose subject is this build', () => {
    for (const member of [...PUBLICATION_OUTCOMES, ...PUBLICATION_COMMAND_REPORTS, ...HEAD_PUBLICATION_OUTCOME_READINGS]) {
      for (const forbidden of ['PUBLISHED', 'CREATED', 'SUCCESS', 'FAILED', 'VALID', 'CURRENT']) {
        expect(member, `${member} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('states no outcome word on any line of the report that carries a value', () => {
    const planted = plantAuthorisation(scratchHome());
    expect(recordOutcome(planted).code).toBe('RECORDED');
    const lines = report(planted.home)
      .split('\n')
      .filter((raw) =>
        AUDIT_REPORT_LABELS.some(
          (label) => raw.trimStart().startsWith(`${label} `) || raw.trimStart().startsWith(`${label}:`),
        ),
      );

    // A positive control first: the filter must be selecting the new lines, or
    // an empty selection would pass this for free.
    expect(lines.some((l) => l.includes('DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER'))).toBe(true);
    expect(lines.some((l) => l.includes('RAN_TO_EXIT_ZERO'))).toBe(true);
    for (const raw of lines) {
      const lower = raw.toLowerCase();
      for (const forbidden of ['publish', 'attempt', 'creat', 'succeed', 'complete', 'execut', 'push', 'valid', 'current', 'verif', 'trust', 'proof', 'sign']) {
        expect(lower, `${forbidden} in: ${raw.trim()}`).not.toContain(forbidden);
      }
    }
  });

  it('uses an outcome verb only inside a denial, in every sentence it prints', () => {
    const negations = ['not', 'never', 'no ', 'nothing', 'cannot', 'does not', 'without'];
    const outcomes = ['published', 'publishes', 'created', 'creates', 'succeeded', 'succeeds', 'pushed', 'attempted', 'executed', 'completed'];
    let seen = 0;
    for (const sentence of AUDIT_PRINTED_TEXT) {
      const one = sentence.replace(/\s+/g, ' ').toLowerCase();
      for (const word of outcomes) {
        let index = one.indexOf(word);
        while (index !== -1) {
          seen += 1;
          const before = one.slice(Math.max(0, index - 80), index);
          expect(
            negations.some((no) => before.includes(no)),
            `"${word}" is asserted rather than denied in: ...${one.slice(Math.max(0, index - 80), index + 30)}`,
          ).toBe(true);
          index = one.indexOf(word, index + 1);
        }
      }
    }
    expect(seen, 'the denials must actually use the words they deny').toBeGreaterThan(2);
  });

  it('bounds the outcome in its own words, rather than leaving it unsaid', () => {
    const planted = plantAuthorisation(scratchHome());
    expect(recordOutcome(planted).code).toBe('RECORDED');
    const text = report(planted.home).replace(/\s+/g, ' ');

    // The heading is pinned with the sentences under it. A mutant that left the
    // denials in place and retitled them survived without this: every sentence
    // stayed true and the framing that makes them bounds rather than trivia was
    // gone. The sibling paragraph learned the same thing in review.
    expect(text).toContain('What an outcome here says:');
    expect(text).toContain('What an outcome does not say:');
    for (const required of [
      'not that this build put the commit on the delivery remote',
      'not that the ref holds this now',
      'not that bytes reached the delivery remote',
      'not that anything may be sent again',
    ]) {
      expect(text, required).toContain(required);
    }
  });

  it('discloses that nothing beside a refused record was looked at', () => {
    // The loss the listing takes on purpose, and the one place it can be said.
    // The entry sentences cannot carry it — each has to hold for every producer
    // of its reading, and they are about the record — so a first draft of the
    // code comment claimed they did and a review measured that none of the eight
    // mentions an outcome at all. It is said once, in the paragraph printed
    // about the store, and it is printed on every listing.
    const home = scratchHome();
    const planted = plantAuthorisation(home);
    writeFileSync(
      join(auditRoot(home), planted.eventId, HEAD_PUBLICATION_AUDIT_FILE_NAME),
      'not a record',
      'utf8',
    );
    writeFileSync(outcomePath(home, planted.eventId), bytesFor(payloadFor()));
    const text = report(home).replace(/\s+/g, ' ');

    // The whole disclosure, clause by clause. Pinning only the tail of it left a
    // mutant that deleted the opening alive, and the opening is the half that
    // says which entries the rule is about.
    expect(text).toContain('An entry whose record this build could not read is listed');
    expect(text).toContain('nothing beside that record is looked at');
    expect(text).toContain('no outcome is read, graded or shown there');
    expect(text).toContain('an outcome is only ever shown against a record that was read');
    // …and the report really is in that shape: a refused record, an outcome
    // sitting beside it, and not one line about the outcome.
    expect(text).toContain('Reading : RECORD_MALFORMED');
    expect(report(home)).not.toContain('Outcome      :');
  });

  it('explains the outcome labels only in a report that has them', () => {
    // The rule the record's own paragraph learned in review: a store with no
    // outcome in it used to be told what `Command` means, in a report with no
    // such line.
    const without = plantAuthorisation(scratchHome());
    const bare = report(without.home);
    expect(bare).toContain('Outcome      : OUTCOME_ABSENT');
    expect(bare).not.toContain('What an outcome here says:');
    expect(bare).not.toContain('What an outcome does not say:');

    // …and a store with one does get it. Without this half the case above would
    // pass for a build that never printed the paragraph at all.
    const with_ = plantAuthorisation(scratchHome());
    expect(recordOutcome(with_).code).toBe('RECORDED');
    expect(report(with_.home)).toContain('What an outcome here says:');
  });

  it('says in its own words what an absent outcome does not mean', () => {
    const flat = AUDIT_OUTCOME_SENTENCES.OUTCOME_ABSENT.replace(/\s+/g, ' ');
    expect(flat).toContain('not a statement that nothing reached the delivery remote');
    expect(flat).toContain('no durable outcome was established');
    // …and the same sentence is load-bearing in the code it describes.
    expect(readFileSync(CONTRACT, 'utf8')).toContain('It does not mean no effect happened');
  });

  it('prints only ASCII', () => {
    for (const text of [...Object.values(AUDIT_OUTCOME_SENTENCES), ...AUDIT_PRINTED_TEXT]) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x20-\x7e\n]*$/.test(text), text.slice(0, 60)).toBe(true);
    }
  });

  it('grades every entry reading, and prints a sentence for each', () => {
    expect(Object.keys(AUDIT_OUTCOME_SENTENCES).sort()).toEqual(
      [...HEAD_PUBLICATION_OUTCOME_ENTRY_READINGS].sort(),
    );
    for (const reading of HEAD_PUBLICATION_OUTCOME_ENTRY_READINGS) {
      expect(AUDIT_OUTCOME_SENTENCES[reading].length, reading).toBeGreaterThan(60);
    }
  });
});

describe('the store keeps its shape when nothing writes to it', () => {
  it('leaves an event written by an older build readable forever', () => {
    // No backfill, no migration, no guess. An authorisation with no outcome is a
    // legitimate historical shape and stays one.
    const planted = plantAuthorisation(scratchHome());
    const listed = listHeadPublicationAuthorisations(fixedPathProvider(planted.home));
    expect(listed.outcome).toBe('READ');
    const entry = listed.entries[0];
    if (entry === undefined || entry.record === null) throw new Error('expected one read record');
    expect(entry.reading).toBe('HISTORICAL_AUTHORISATION');
    expect(entry.outcome).toBe('OUTCOME_ABSENT');
    expect(entry.outcomeRecord).toBeNull();
  });

  it('never writes into an event it did not authorise', () => {
    const home = scratchHome();
    const mine = plantAuthorisation(home);
    const theirs = plantAuthorisation(home);
    expect(recordOutcome(mine).code).toBe('RECORDED');
    expect(outcomeExists(home, theirs.eventId)).toBe(false);
  });

  it('refuses an outcome filed against another event\'s authorisation', () => {
    const home = scratchHome();
    const first = plantAuthorisation(home);
    const second = plantAuthorisation(home);
    // Written into the second event's directory carrying the first's anchor:
    // the bytes are well formed and the reader refuses them.
    expect(recordOutcome(second, { authorisationBinding: first.binding }).code).toBe('RECORDED');
    expect(report(home)).toContain('Outcome      : OUTCOME_NOT_THIS_EVENT');
  });

  it('refuses an outcome moved from one event directory into another', () => {
    const home = scratchHome();
    const source = plantAuthorisation(home);
    const target = plantAuthorisation(home);
    expect(recordOutcome(source).code).toBe('RECORDED');
    writeFileSync(
      outcomePath(home, target.eventId),
      readFileSync(outcomePath(home, source.eventId)),
    );

    const listed = listHeadPublicationAuthorisations(fixedPathProvider(home));
    const moved = listed.entries.find((e) => e.name === target.eventId);
    expect(moved?.record !== null && moved?.outcome).toBe('OUTCOME_NOT_THIS_EVENT');
    // The one it came from is untouched and still reads.
    const original = listed.entries.find((e) => e.name === source.eventId);
    expect(original?.record !== null && original?.outcome).toBe('HISTORICAL_OUTCOME');
  });
});
