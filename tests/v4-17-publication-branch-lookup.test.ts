/**
 * V4 slice 17 — asking the unattended-publication audit store about one branch.
 *
 * Slice 15 made the store readable and slice 16 made each entry longer. What
 * neither did is let an operator ask a question: `L-V4-14-3` still says
 * "records are addressable only by event identity … finding the record for one
 * branch means reading every entry". This suite is written against the five
 * ways a filter over an accountability store goes wrong.
 *
 *  1. **matching on too little.** A ref is not a branch. `refs/heads/main` in
 *     one repository is not the same branch as the identical ref in another,
 *     and the record's own schema admits any host and any owner — so a key
 *     missing one of the four fields answers with somebody else's history.
 *     Every one-field-off fixture here is required to be a non-match;
 *  2. **matching on too much, or on the wrong thing.** Two publications of one
 *     branch differ in commit, in task, in the checkout they ran in and in the
 *     local name of the remote they went through. A key carrying any of those
 *     splits one branch's history in two and reports part of it as the whole;
 *  3. **helpful normalisation.** Folding case, prepending `refs/heads/`,
 *     trimming a suffix or matching a substring each make one query string mean
 *     two different stored values. The comparison here is character for
 *     character on all four fields, and a fixture differing only in case is
 *     required to be a non-match — deliberately, because the authority this
 *     store is about compares exactly too (`L-V4-13-3`);
 *  4. **a filter that quietly drops what it cannot judge.** An entry whose
 *     record this build could not read carries no host, owner, name or ref at
 *     all — the type puts `record` on one arm only — so it can be neither
 *     matched nor ruled out. Hiding it would turn "one of these might be your
 *     branch and I cannot tell" into "there is no record for this branch",
 *     which is the reassuring-absence failure this slice family exists against.
 *     Every broken shape is planted between two matches and required to survive;
 *  5. **a negative that overclaims.** "No record here names that branch" is one
 *     keystroke from "this branch was never authorised". The sentence has to be
 *     present rather than merely the assertion absent, and the store-wide grade
 *     and tally have to keep meaning what they meant before a query existed.
 *
 * What is deliberately not re-measured here: the writer, the binding, the
 * record's own contract, the outcome's contract and the ladder. Those are
 * `tests/v4-14-…`, `tests/v4-16-…` and `tests/v4-05-…`'s, and this suite drives
 * the real writers wherever it needs a whole record.
 */

import { Command } from 'commander';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildProgram } from '../src/cli/index.js';
import {
  AUTHORISATIONS_DESCRIPTION,
  BRANCH_QUERY_REFUSALS,
  BRANCH_QUERY_REFUSAL_DETAIL,
  readBranchQuery,
  registerPublicationCommand,
} from '../src/cli/publication-command.js';
import {
  AUDIT_QUERY_MEANING,
  AUDIT_QUERY_SENTENCES,
  AUDIT_PRINTED_TEXT,
  AUDIT_REPORT_LABELS,
  renderPublicationAuthorisations,
} from '../src/cli/render-publication-authorisations.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import {
  HEAD_PUBLICATION_BRANCH_QUERY_READINGS,
  branchQueryReading,
  listHeadPublicationAuthorisations,
  recordNamesQueriedBranch,
  selectQueriedBranch,
  type HeadPublicationAuditEntry,
  type HeadPublicationBranchQuery,
  type HeadPublicationBranchQueryReading,
} from '../src/deliver/head-publication-authorisation-listing.js';
import {
  isForgeHost,
  isForgeOwner,
  isForgeRepositoryName,
} from '../src/deliver/internal/forge-identity-grammar.js';
import {
  HEAD_PUBLICATION_AUDIT_FILE_NAME,
  headPublicationAuditRoot,
} from '../src/deliver/internal/head-publication-audit-location.js';
import {
  newHeadPublicationAuditEventId,
  recordHeadPublicationAuthorisation,
} from '../src/deliver/head-publication-authorisation-store.js';
import { recordHeadPublicationOutcome } from '../src/deliver/head-publication-outcome-store.js';
import { headPublicationAuthorisationBinding } from '../src/deliver/head-publication-authorisation.js';
import { EXIT_RUN_INPUT_UNUSABLE, EXIT_RUN_OK } from '../src/cli/run-exit-codes.js';

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
 * reason: this slice's headers name the very claims they refuse to make.
 */
function codeOnly(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*/gm, '$1 ');
}

const READER = 'src/deliver/head-publication-authorisation-listing.ts';
const RENDERER = 'src/cli/render-publication-authorisations.ts';
const COMMAND = 'src/cli/publication-command.ts';
const GRAMMAR = 'src/deliver/internal/forge-identity-grammar.ts';
/**
 * The files slice 17 adds to or changes on the read side.
 *
 * The grammar module is here rather than left out because a module outside
 * every sweep is a module the whole suite says nothing about — the blind spot
 * `tests/v4-15-…` names when it lists its own three files.
 */
const SLICE_17_SOURCE = [READER, RENDERER, COMMAND, GRAMMAR] as const;

/* ── scratch ──────────────────────────────────────────────────────────────── */

const roots: string[] = [];

function scratchRoot(prefix = 'ao-v417-'): string {
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

const TASK = 'V4-17';
const HEAD = 'a'.repeat(40);
const REF = 'refs/heads/ao/task/V4-17';
const DIGEST = 'b'.repeat(64);
const CHECKOUT = 'C:\\scratch\\repo';
const IDENTITY = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});

/** The branch every fixture in this file is about, in the query's own spelling. */
const BRANCH: HeadPublicationBranchQuery = Object.freeze({
  forgeHost: IDENTITY.host,
  forgeOwner: IDENTITY.owner,
  forgeName: IDENTITY.name,
  authorisedRef: REF,
});

function scratchHome(): string {
  const home = scratchRoot('ao-v417-home-');
  mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
  return home;
}

function auditRoot(home: string): string {
  return headPublicationAuditRoot(fixedPathProvider(home));
}

interface RecordOver {
  readonly taskId?: string;
  readonly repositoryRoot?: string;
  readonly host?: string;
  readonly owner?: string;
  readonly name?: string;
  readonly declaredRemote?: string;
  readonly ref?: string;
  readonly commit?: string;
  readonly at?: string;
  readonly outcome?: boolean;
}

/**
 * One real record, written by the real writer into a real directory.
 *
 * Nothing here fabricates a whole record where a whole record is what it needs:
 * a filter measured against hand-built bytes would be measuring this file's
 * idea of the format rather than the store's.
 */
function record(home: string, over: RecordOver = {}): string {
  const at = new Date(over.at ?? '2026-08-27T12:00:00.000Z');
  const eventId = newHeadPublicationAuditEventId(at);
  const taskId = over.taskId ?? TASK;
  const repositoryRoot = over.repositoryRoot ?? CHECKOUT;
  const written = recordHeadPublicationAuthorisation({
    eventId,
    taskId,
    repositoryRoot,
    host: over.host ?? IDENTITY.host,
    owner: over.owner ?? IDENTITY.owner,
    name: over.name ?? IDENTITY.name,
    declaredRemote: over.declaredRemote ?? 'origin',
    ref: over.ref ?? REF,
    commit: over.commit ?? HEAD,
    declarationDigest: DIGEST,
    authorisedAt: at.toISOString(),
    pathProvider: fixedPathProvider(home),
  });
  expect(written.code, 'the fixture writer must succeed').toBe('RECORDED');
  if (over.outcome === true) {
    const outcome = recordHeadPublicationOutcome({
      eventId,
      taskId,
      repositoryRoot,
      authorisationBinding: written.binding as string,
      outcome: 'DISPATCHED_REF_AT_SUBJECT_COMMIT_AFTER',
      commandReport: 'RAN_TO_EXIT_ZERO',
      recordedAt: at.toISOString(),
      pathProvider: fixedPathProvider(home),
    });
    expect(outcome.code, 'the fixture outcome writer must succeed').toBe('RECORDED');
  }
  return eventId;
}

function plantDirectory(home: string, name: string): string {
  const path = join(auditRoot(home), name);
  mkdirSync(path, { recursive: true });
  return path;
}

function plantFile(home: string, name: string, contents: string): void {
  mkdirSync(auditRoot(home), { recursive: true });
  writeFileSync(join(auditRoot(home), name), contents, 'utf8');
}

/** A syntactically valid event name that nothing wrote a record under. */
function eventName(stamp = '20260827T130000000Z', tail = '0'): string {
  return `${stamp}-${tail.repeat(8)}-0000-4000-8000-${tail.repeat(12)}`;
}

function recordPath(home: string, eventId: string): string {
  return join(auditRoot(home), eventId, HEAD_PUBLICATION_AUDIT_FILE_NAME);
}

/** Rewrites one field of a stored record without recomputing its digest. */
function edit(home: string, eventId: string, over: Record<string, unknown>): void {
  const file = recordPath(home, eventId);
  const stored = { ...(JSON.parse(readFileSync(file, 'utf8')) as object), ...over };
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
}

/** Rewrites one field and re-seals it, so the record reads as this build's own. */
function reseal(home: string, eventId: string, over: Record<string, unknown>): void {
  const file = recordPath(home, eventId);
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { binding: _replaced, ...rest } = { ...stored, ...over };
  const sealed = {
    ...rest,
    binding: headPublicationAuthorisationBinding(
      {
        eventId,
        taskId: String(rest.taskId),
        repositoryRoot: String(rest.repositoryRoot),
      },
      rest as never,
    ),
  };
  writeFileSync(file, `${JSON.stringify(sealed, null, 2)}\n`, 'utf8');
}

function list(home: string) {
  return listHeadPublicationAuthorisations(fixedPathProvider(home));
}

function select(home: string, query: HeadPublicationBranchQuery = BRANCH) {
  return selectQueriedBranch(list(home).entries, query);
}

/** The whole report an operator would see, with or without a query. */
function report(home: string, query: HeadPublicationBranchQuery | null = null): string {
  return renderPublicationAuthorisations(list(home), query);
}

function shownNames(home: string, query: HeadPublicationBranchQuery = BRANCH): readonly string[] {
  return select(home, query).shown.map((entry) => entry.name);
}

/* ── driving the real command ─────────────────────────────────────────────── */

interface Run {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
}

/**
 * The registered action, run for real against a scratch profile.
 *
 * `process.exitCode` is saved and restored: an action that sets it would
 * otherwise decide the exit status of the whole vitest worker.
 */
async function run(home: string, args: readonly string[]): Promise<Run> {
  const program = new Command();
  program.exitOverride();
  registerPublicationCommand(program, { pathProvider: fixedPathProvider(home) });

  const out: string[] = [];
  const err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const before = process.exitCode;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.exitCode = undefined;
  let exitCode: number | undefined;
  try {
    await program.parseAsync(['node', 'ao', 'publication', 'authorisations', ...args]);
    exitCode = process.exitCode as number | undefined;
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    process.exitCode = before;
  }
  return { stdout: out.join(''), stderr: err.join(''), exitCode };
}

/** The four flags, in the spelling an operator types. */
function argv(over: Partial<Record<'host' | 'owner' | 'name' | 'ref', string>> = {}): string[] {
  return [
    '--forge-host',
    over.host ?? IDENTITY.host,
    '--forge-owner',
    over.owner ?? IDENTITY.owner,
    '--forge-name',
    over.name ?? IDENTITY.name,
    '--ref',
    over.ref ?? REF,
  ];
}

/* ── measuring that nothing changed ───────────────────────────────────────── */

function treeDigest(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).slice().sort();
    } catch {
      hash.update(`UNREADABLE:${prefix}\n`);
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      const at = `${prefix}/${name}`;
      let stats;
      try {
        stats = statSync(path);
      } catch {
        hash.update(`GONE:${at}\n`);
        continue;
      }
      if (stats.isDirectory()) {
        hash.update(`D:${at}\n`);
        walk(path, at);
      } else {
        hash.update(`F:${at}:`);
        try {
          hash.update(readFileSync(path));
        } catch {
          hash.update('UNREADABLE');
        }
        hash.update('\n');
      }
    }
  };
  try {
    walk(root, '');
  } catch {
    hash.update('ROOT-UNREADABLE\n');
  }
  return hash.digest('hex');
}

/* ── 1. what a branch is ──────────────────────────────────────────────────── */

describe('what a branch is', () => {
  it('names a record whose four identity values are the four asked for', () => {
    const home = scratchHome();
    const wanted = record(home);

    const selection = select(home);

    expect(selection.named).toBe(1);
    expect(selection.elsewhere).toBe(0);
    expect(selection.unestablished).toBe(0);
    expect(selection.shown.map((entry) => entry.name)).toEqual([wanted]);
  });

  /**
   * The four one-field-off decoys, each written by the real writer.
   *
   * This is the case that makes the key four fields rather than one. A filter
   * matching on the ref alone answers all five of these; the record's own
   * schema admits any host and any owner, so none of the four can be dropped on
   * the grounds that this build only ever writes one value there.
   */
  it.each([
    ['a different repository name', { name: 'OtherRepo' }],
    ['a different owner', { owner: 'someone-else' }],
    ['a different host', { host: 'gitlab.com' }],
    ['a different ref', { ref: 'refs/heads/ao/task/V4-16' }],
  ])('does not name a record differing only in %s', (_label, over) => {
    const home = scratchHome();
    record(home, over as RecordOver);

    const selection = select(home);

    expect(selection.named).toBe(0);
    expect(selection.elsewhere).toBe(1);
    expect(selection.shown).toEqual([]);
  });

  /**
   * The three fields a branch key must NOT carry, each measured on a real
   * record rather than argued.
   *
   * `authorisedCommit` is what the branch pointed at, `declaredRemote` is the
   * local name of the pointer the identity was read through, and
   * `repositoryRoot` is a checkout — "two clones of one project are two of
   * these". A key carrying any of them splits one branch's history and reports
   * part of it as the whole.
   */
  it('names every publication of one branch, whatever the commit, remote or checkout', () => {
    const home = scratchHome();
    const first = record(home, { at: '2026-08-27T12:00:00.000Z' });
    const later = record(home, { at: '2026-08-27T12:01:00.000Z', commit: 'c'.repeat(40) });
    const elsewhere = record(home, {
      at: '2026-08-27T12:02:00.000Z',
      declaredRemote: 'upstream',
      repositoryRoot: 'D:\\a-second-clone',
    });
    const otherTask = record(home, { at: '2026-08-27T12:03:00.000Z', taskId: 'V4-99' });

    const selection = select(home);

    expect(selection.named).toBe(4);
    expect(selection.shown.map((entry) => entry.name)).toEqual([first, later, elsewhere, otherTask]);
  });

  /**
   * Two events for one branch at one commit stay two events.
   *
   * There is no collapsing rule here and there must not be: each event carries
   * its own instant, its own declaration digest and its own outcome, and two
   * that agree on the branch and the commit are still two things that happened.
   */
  it('keeps two events for one branch at one commit apart', () => {
    const home = scratchHome();
    const first = record(home, { at: '2026-08-27T12:00:00.000Z', outcome: true });
    const second = record(home, { at: '2026-08-27T12:01:00.000Z' });

    const selection = select(home);

    expect(selection.named).toBe(2);
    expect(selection.shown.map((entry) => entry.name)).toEqual([first, second]);
    // Neither of the two collapsing rules a convenience-minded filter reaches
    // for: not the newest, and not one per commit.
    expect(selection.shown).toHaveLength(2);
  });
});

/* ── 2. exact means exact ─────────────────────────────────────────────────── */

describe('exact means exact', () => {
  /**
   * Case is not folded on any of the four, and that is a decision rather than
   * an omission.
   *
   * github.com folds case in an owner and a repository name; this build does
   * not, and the permission path answers `NOT_DECLARED` for a differently
   * capitalised entry — `L-V4-13-3`. A lookup that folded would teach an
   * operator a rule the authority does not honour, and would apply one forge's
   * convention to records whose host field admits any string.
   */
  it.each([
    ['owner', { owner: 'm4xd4b0zz' }],
    ['repository name', { name: 'agentorchestrator' }],
    ['ref', { ref: 'refs/heads/AO/task/V4-17' }],
  ])('does not fold case in the %s', (_label, over) => {
    const home = scratchHome();
    record(home, over as RecordOver);

    expect(select(home).named).toBe(0);
    expect(select(home).elsewhere).toBe(1);
  });

  /**
   * Nothing here matches a part of a value.
   *
   * A prefix, a suffix and an infix of each of the four, measured against a
   * record that carries the whole value. A substring rule would make one query
   * name records the operator did not ask for, and on a store nothing prunes
   * that is a mistake with no undo.
   */
  it.each([
    ['a ref prefix', { authorisedRef: 'refs/heads/ao/task' }],
    ['a ref suffix', { authorisedRef: 'V4-17' }],
    ['a name prefix', { forgeName: 'Agent' }],
    ['an owner suffix', { forgeOwner: 'B0ZZ' }],
    ['a host suffix', { forgeHost: 'github.co' }],
  ])('does not match on %s', (_label, over) => {
    const home = scratchHome();
    record(home);

    expect(select(home, { ...BRANCH, ...over }).named).toBe(0);
  });

  it('compares the four fields and nothing else', () => {
    const home = scratchHome();
    record(home);
    const entry = list(home).entries[0] as HeadPublicationAuditEntry;
    expect(entry.record).not.toBeNull();
    const stored = entry.record as NonNullable<typeof entry.record>;

    expect(recordNamesQueriedBranch(stored, BRANCH)).toBe(true);
    // One field at a time, so a predicate that dropped any one of the four
    // fails here rather than only in a fixture that happened to differ.
    for (const field of [
      'forgeHost',
      'forgeOwner',
      'forgeName',
      'authorisedRef',
    ] as const) {
      expect(
        recordNamesQueriedBranch(stored, { ...BRANCH, [field]: 'something-else' }),
        `${field} must be part of the comparison`,
      ).toBe(false);
    }
  });

  /**
   * The query type may not carry the mint's own field names.
   *
   * `AuthorisedPublicationRecord` renames six fields so a handed-out record is
   * not structurally an argument to `mintHeadPublicationGrant`. A query object
   * is a second place that hole can open, and a brand, a branded string and a
   * `#private` field were each measured to be no defence — names are what work.
   */
  it('spells the query so it can never be an argument to a mint', () => {
    for (const forbidden of ['host', 'owner', 'name', 'commit', 'ref', 'remoteName']) {
      expect(Object.keys(BRANCH), `a query must not carry ${forbidden}`).not.toContain(forbidden);
    }
    expect(Object.keys(BRANCH).sort()).toEqual([
      'authorisedRef',
      'forgeHost',
      'forgeName',
      'forgeOwner',
    ]);
  });
});

/* ── 3. what cannot be judged is not judged ───────────────────────────────── */

describe('what cannot be judged is not judged', () => {
  /**
   * Every shape this store can hold that is not a record this build read, each
   * planted between two matching records.
   *
   * The load-bearing assertion is that all three survive: the two matches AND
   * the entry in between. An entry with no record carries no host, no owner, no
   * name and no ref — the type puts `record` on one arm only — so it can be
   * neither matched nor ruled out, and dropping it would make a filtered report
   * look complete when it is not.
   */
  const BROKEN: readonly [string, (home: string) => void][] = [
    ['an event directory with no record', (home) => void plantDirectory(home, eventName('20260827T120100000Z', '1'))],
    ['a record of no bytes', (home) => {
      const name = eventName('20260827T120100000Z', '2');
      plantDirectory(home, name);
      writeFileSync(join(auditRoot(home), name, HEAD_PUBLICATION_AUDIT_FILE_NAME), '', 'utf8');
    }],
    ['bytes that are not a record', (home) => {
      const name = eventName('20260827T120100000Z', '3');
      plantDirectory(home, name);
      writeFileSync(join(auditRoot(home), name, HEAD_PUBLICATION_AUDIT_FILE_NAME), '{not json', 'utf8');
    }],
    ['a contract version this build does not read', (home) => {
      const broken = record(home, { at: '2026-08-27T12:01:00.000Z' });
      edit(home, broken, { authorisationVersion: 2 });
    }],
    ['a record whose digest does not recompute', (home) => {
      const broken = record(home, { at: '2026-08-27T12:01:00.000Z' });
      edit(home, broken, { ref: 'refs/heads/edited-in-place' });
    }],
    ['a name this build would not mint', (home) => void plantDirectory(home, 'not-an-event')],
    ['a file directly in the store', (home) => plantFile(home, 'junk.txt', 'x')],
  ];

  it.each(BROKEN)('keeps %s beside two matching records', (_label, plant) => {
    const home = scratchHome();
    const first = record(home, { at: '2026-08-27T12:00:00.000Z' });
    plant(home);
    const last = record(home, { at: '2026-08-27T12:02:00.000Z' });

    const selection = select(home);

    expect(selection.named).toBe(2);
    expect(selection.unestablished).toBe(1);

    const names = selection.shown.map((entry) => entry.name);
    expect(names).toHaveLength(3);
    // Both matches survive, in the order the listing established, and the
    // entry this build could not judge is there too. Where it sits is the
    // listing's own two-tier rule and not this filter's — an entry read as an
    // event directory keeps its place among them, and one that is not comes
    // after all of them. That rule is measured on its own below rather than
    // restated per shape here.
    expect(names.filter((name) => name === first || name === last)).toEqual([first, last]);
    expect(names.filter((name) => name !== first && name !== last)).toHaveLength(1);
  });

  /**
   * A record whose digest does not recompute is never read for its ref, even
   * when the ref it carries is the one being asked for.
   *
   * The grader reports one reading for a divergence in any of nineteen digest
   * inputs, so it cannot say which field diverged and `ref` is a candidate
   * every time. Reading it to answer a query would be this build's strongest
   * sentence about a document it can prove it did not write.
   */
  it('does not answer from a record it refused, even one carrying the queried ref', () => {
    const home = scratchHome();
    const tampered = record(home, { at: '2026-08-27T12:00:00.000Z', ref: 'refs/heads/somewhere' });
    // The stored ref becomes the queried one, without the digest being redone.
    edit(home, tampered, { ref: REF });

    const selection = select(home);

    expect(selection.named).toBe(0);
    expect(selection.elsewhere).toBe(0);
    expect(selection.unestablished).toBe(1);
    // Present, and present as something this build could not judge — never as
    // a record naming another branch.
    expect(selection.shown).toHaveLength(1);
    expect((selection.shown[0] as HeadPublicationAuditEntry).reading).toBe('RECORD_NOT_THIS_EVENT');
    expect((selection.shown[0] as HeadPublicationAuditEntry).record).toBeNull();
  });

  /**
   * The other direction of the same limit, and it is conceded rather than
   * defended: a re-sealed record reads as this build's own.
   *
   * There is no key material here, so a binding is an integrity statement and
   * never an authentication one (`L-V4-14-2`). A forged record naming the
   * queried branch is named by the query, and no filter can do better.
   */
  it('names a re-sealed record, because a binding is not a signature', () => {
    const home = scratchHome();
    const forged = record(home, { at: '2026-08-27T12:00:00.000Z', ref: 'refs/heads/somewhere' });
    reseal(home, forged, { ref: REF });

    expect(select(home).named).toBe(1);
  });

  /** An outcome this build could not read does not change which branch the record names. */
  it.each([
    ['no bytes', ''],
    ['bytes that are not an outcome', '{not json'],
  ])('still names a record whose outcome is %s', (_label, bytes) => {
    const home = scratchHome();
    const wanted = record(home, { outcome: true });
    writeFileSync(join(auditRoot(home), wanted, 'outcome.json'), bytes, 'utf8');

    const selection = select(home);

    expect(selection.named).toBe(1);
    expect(selection.shown.map((entry) => entry.name)).toEqual([wanted]);
    // …and the store's own grade still says something is wrong with it.
    expect(list(home).outcome).toBe('READ_WITH_UNUSABLE_ENTRIES');
  });
});

/* ── 4. the store's own grade is about the store ──────────────────────────── */

describe("the store's own grade is about the store", () => {
  /**
   * The crux. A damaged entry outside the query must still grade the store
   * down, or `Listing : READ` becomes a claim about a subset while its own
   * sentence says "every entry in the store".
   *
   * That is why the filter is a projection applied after the listing rather
   * than a short circuit inside it: `entryWasRead` keeps seeing every entry.
   */
  it('grades a store down for damage outside the query', () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z' });
    const other = record(home, { at: '2026-08-27T12:01:00.000Z', name: 'OtherRepo' });
    writeFileSync(join(auditRoot(home), other, 'outcome.json'), '{not json', 'utf8');

    const listing = list(home);
    const selection = selectQueriedBranch(listing.entries, BRANCH);

    expect(listing.outcome).toBe('READ_WITH_UNUSABLE_ENTRIES');
    // The damaged entry is not shown — it names another branch, which this
    // build did establish — but the grade it caused is.
    expect(selection.named).toBe(1);
    expect(selection.elsewhere).toBe(1);
    expect(report(home, BRANCH)).toContain('Listing      : READ_WITH_UNUSABLE_ENTRIES');
  });

  it('counts the whole store on the Entries line, whatever was asked', () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z' });
    record(home, { at: '2026-08-27T12:01:00.000Z', name: 'OtherRepo' });
    plantFile(home, 'junk.txt', 'x');

    // Identical on both, because the tally is a statement about the store.
    expect(report(home)).toContain('Entries      : 3 (2 read, 1 not read)');
    expect(report(home, BRANCH)).toContain('Entries      : 3 (2 read, 1 not read)');
  });

  /**
   * The listing itself never learns there was a query.
   *
   * Measured on the one call site rather than on the function's arity, which
   * would say nothing: a default parameter does not count towards
   * `Function.length`, so an arity pin here reads as coverage and is not. What
   * this asserts is that no query value reaches the enumeration at all, which
   * is what keeps the store grade, the tally and the order the same objects
   * they were before this slice.
   */
  it('never hands the query to the enumeration', () => {
    const calls = [
      ...codeOnly(COMMAND).matchAll(/listHeadPublicationAuthorisations\(([^)]*)\)/g),
    ];
    expect(calls).toHaveLength(1);
    expect((calls[0] as RegExpMatchArray)[1]?.trim()).toBe('seams.pathProvider');

    // …and the enumeration's own body names no query at all. Sliced from its
    // signature to the first line at column zero after it, because the query
    // helpers sit further down the same file and a slice to end-of-file would
    // measure them instead — which is what a first version of this did, and it
    // failed for a reason that had nothing to do with the enumeration.
    const code = codeOnly(READER);
    const from = code.indexOf('export function listHeadPublicationAuthorisations');
    expect(from).toBeGreaterThan(-1);
    const end = code.indexOf('\n}\n', from);
    expect(end).toBeGreaterThan(from);
    const body = code.slice(from, end);
    expect(body).not.toContain('Query');
    expect(body).not.toContain('selectQueriedBranch');
  });
});

/* ── 5. order ─────────────────────────────────────────────────────────────── */

describe('order', () => {
  it('keeps the order the listing established, and repeats it', () => {
    const home = scratchHome();
    const names = [
      record(home, { at: '2026-08-27T12:00:00.000Z' }),
      record(home, { at: '2026-08-27T12:01:00.000Z' }),
      record(home, { at: '2026-08-27T12:02:00.000Z' }),
    ];
    plantFile(home, 'junk.txt', 'x');

    expect(shownNames(home)).toEqual([...names, 'junk.txt']);
    // Twice, byte for byte: nothing here depends on enumeration order.
    expect(report(home, BRANCH)).toBe(report(home, BRANCH));
  });

  /**
   * The two tiers survive a query: entries read as event directories first,
   * then everything else, each group by name.
   */
  it('keeps entries this build does not read as event directories last', () => {
    const home = scratchHome();
    const wanted = record(home, { at: '2026-08-27T12:05:00.000Z' });
    // A name sorting before the event's, so a filter that lost the partition
    // would place it first.
    plantFile(home, 'aaa.txt', 'x');

    expect(shownNames(home)).toEqual([wanted, 'aaa.txt']);
  });
});

/* ── 6. what the report says, and what it may not ─────────────────────────── */

describe('what a filtered report says', () => {
  it('shows the query it was given, and the three counts', () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z' });
    record(home, { at: '2026-08-27T12:01:00.000Z', name: 'OtherRepo' });
    plantFile(home, 'junk.txt', 'x');

    const text = report(home, BRANCH);

    expect(text).toContain(
      'Query        : github.com/M4XD4B0ZZ/AgentOrchestrator refs/heads/ao/task/V4-17',
    );
    expect(text).toContain(
      'Matching     : 1 named by this query, 1 naming another branch, 1 not established',
    );
  });

  it('shows every field of a named record, and its outcome', () => {
    const home = scratchHome();
    record(home, { outcome: true });

    const text = report(home, BRANCH);

    for (const label of [
      'Authorised at',
      'Act          ',
      'Task         ',
      'Checkout     ',
      'Delivery     ',
      'Ref          ',
      'Commit       ',
      'Declaration  ',
      'Outcome      ',
      'Recorded at  ',
      'Publication  ',
      'Command      ',
    ]) {
      expect(text, `a named record must still carry ${label.trim()}`).toContain(label);
    }
  });

  it('does not show a record that names another branch', () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z' });
    const other = record(home, {
      at: '2026-08-27T12:01:00.000Z',
      name: 'OtherRepo',
      outcome: true,
    });

    const text = report(home, BRANCH);

    expect(text).not.toContain(other);
    expect(text).not.toContain('OtherRepo');
  });

  /**
   * The three "print this paragraph only if" rules are about what is printed,
   * not about what was read.
   *
   * A store whose only outcome-bearing record names another branch used to be
   * the shape that would print "What an outcome here says:" above a report with
   * no `Command` line.
   */
  it('explains only the labels the filtered report actually carries', () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z', name: 'OtherRepo', outcome: true });

    const text = report(home, BRANCH);

    expect(text).not.toContain('What an outcome here says:');
    expect(text).not.toContain('What a record here says:');
    expect(text).not.toContain('How this list is ordered:');
    // The control: unfiltered, the same store prints all three.
    const whole = report(home);
    expect(whole).toContain('What an outcome here says:');
    expect(whole).toContain('What a record here says:');
    expect(whole).toContain('How this list is ordered:');
  });

  /**
   * One literal fragment per reading, and the reason it is a literal.
   *
   * Asserting `report` contains `AUDIT_QUERY_SENTENCES[reading]` compares the
   * emitter with itself: it holds for any wording, including a wrong one, and
   * it holds when two members' texts are exchanged. Measured, not supposed - a
   * mutant that swaps the two negatives' bodies survived every assertion in an
   * earlier version of this file, and so did one that swapped a negative with
   * the positive. The fragments below are written out here, so a rewrite of any
   * of the three has to come past this case.
   */
  const SENTENCE_FRAGMENT: Readonly<Record<HeadPublicationBranchQueryReading, string>> =
    Object.freeze({
      NAMED_RECORDS_PRESENT: 'are the ones naming that branch',
      NO_NAMED_RECORD_PRESENT: 'is one it did read a record for',
      NO_NAMED_RECORD_AND_EVIDENCE_UNREAD: 'are ones it read no record for at all',
    });

  /** Each fragment must belong to its own sentence and to no other. */
  function expectOnly(text: string, reading: HeadPublicationBranchQueryReading): void {
    for (const member of HEAD_PUBLICATION_BRANCH_QUERY_READINGS) {
      const fragment = SENTENCE_FRAGMENT[member];
      expect(AUDIT_QUERY_SENTENCES[member], `${member} must carry its own fragment`).toContain(
        fragment,
      );
      if (member === reading) expect(text, member).toContain(fragment);
      else expect(text, member).not.toContain(fragment);
    }
  }

  it('says what a clean store with no match does and does not mean', () => {
    const home = scratchHome();
    record(home, { name: 'OtherRepo' });

    const text = report(home, BRANCH);

    expect(text).toContain('Matching     : 0 named by this query, 1 naming another branch, 0 not established');
    expectOnly(text, 'NO_NAMED_RECORD_PRESENT');
  });

  it('does not describe a store holding unreadable evidence as a clean negative', () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z', name: 'OtherRepo' });
    plantDirectory(home, eventName('20260827T120100000Z', '1'));

    const text = report(home, BRANCH);

    expectOnly(text, 'NO_NAMED_RECORD_AND_EVIDENCE_UNREAD');
  });

  it('says which entries name the branch when some do', () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z' });
    record(home, { at: '2026-08-27T12:01:00.000Z', name: 'OtherRepo' });

    expectOnly(report(home, BRANCH), 'NAMED_RECORDS_PRESENT');
  });

  it('counts every entry in the store exactly once', () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z', outcome: true });
    record(home, { at: '2026-08-27T12:01:00.000Z' });
    record(home, { at: '2026-08-27T12:02:00.000Z', name: 'OtherRepo' });
    record(home, { at: '2026-08-27T12:03:00.000Z', owner: 'someone-else' });
    plantDirectory(home, eventName('20260827T120400000Z', '1'));
    plantFile(home, 'junk.txt', 'x');

    const listing = list(home);
    const selection = selectQueriedBranch(listing.entries, BRANCH);

    // The three counts partition the store. Without this an operator could be
    // shown three numbers that do not add up to the one above them.
    expect(selection.named + selection.elsewhere + selection.unestablished).toBe(
      listing.entries.length,
    );
    expect(selection.named).toBe(2);
    expect(selection.elsewhere).toBe(2);
    expect(selection.unestablished).toBe(2);
    expect(selection.shown).toHaveLength(selection.named + selection.unestablished);
  });

  /**
   * The two outcomes that produce no listing, and they are the dangerous pair.
   *
   * `entries` is empty on both because nothing was read, so a selection over it
   * would answer "no record names that branch" for a store this build could not
   * open — the reassuring absence this whole command exists to prevent, arriving
   * through a query. `STORE_ABSENT` is here beside `STORE_UNREADABLE` because it
   * is the one an operator is most likely to read as an answer: a store that is
   * simply not there looks like an empty one.
   */
  it.each([
    [
      'a store whose path is a file',
      'STORE_UNREADABLE',
      (home: string) => {
        mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
        writeFileSync(auditRoot(home), 'x', 'utf8');
      },
    ],
    ['a store that is not there', 'STORE_ABSENT', () => undefined],
  ])('never turns %s into an answer about a branch', (_label, outcome, prepare) => {
    const home = scratchHome();
    prepare(home);

    const text = report(home, BRANCH);

    expect(text).toContain(`Listing      : ${outcome}`);
    // The query is echoed, and no count and no answer about the branch is
    // printed: nothing was read, so nothing about the branch is established.
    expect(text).toContain('Query        : ');
    expect(text).not.toContain('Matching     : ');
    expect(text).not.toContain(AUDIT_QUERY_MEANING);
    for (const reading of HEAD_PUBLICATION_BRANCH_QUERY_READINGS) {
      expect(text, reading).not.toContain(AUDIT_QUERY_SENTENCES[reading]);
      expect(text, reading).not.toContain(SENTENCE_FRAGMENT[reading]);
    }
  });

  it('says that the whole store was read to answer the query', () => {
    const home = scratchHome();
    record(home);

    expect(report(home, BRANCH)).toContain(AUDIT_QUERY_MEANING);
    expect(AUDIT_QUERY_MEANING).toContain('no index');
    // …and does not say it where there is no query.
    expect(report(home)).not.toContain(AUDIT_QUERY_MEANING);
  });

  it('registers every new label and every new sentence with the sweeps', () => {
    expect(AUDIT_REPORT_LABELS as readonly string[]).toContain('Query');
    expect(AUDIT_REPORT_LABELS as readonly string[]).toContain('Matching');
    for (const reading of HEAD_PUBLICATION_BRANCH_QUERY_READINGS) {
      expect(AUDIT_PRINTED_TEXT, reading).toContain(AUDIT_QUERY_SENTENCES[reading]);
    }
    expect(AUDIT_PRINTED_TEXT).toContain(AUDIT_QUERY_MEANING);
  });

  it('states no outcome and no absence claim on any line carrying a value', () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z', outcome: true });
    record(home, { at: '2026-08-27T12:01:00.000Z', name: 'OtherRepo' });
    plantFile(home, 'junk.txt', 'x');

    const lines = report(home, BRANCH)
      .split('\n')
      .filter((raw) => AUDIT_REPORT_LABELS.some((label) => raw.trim().startsWith(label)));

    expect(lines.length).toBeGreaterThan(8);
    for (const raw of lines) {
      const lower = raw.toLowerCase();
      for (const forbidden of [
        'publish',
        'attempt',
        'creat',
        'succeed',
        'complete',
        'execut',
        'push',
        'valid',
        'current',
        'verif',
        'trust',
        'proof',
        'sign',
      ]) {
        expect(lower, `${forbidden} in: ${raw.trim()}`).not.toContain(forbidden);
      }
    }
  });

  it('never says a branch was never authorised', () => {
    const flat = [
      ...HEAD_PUBLICATION_BRANCH_QUERY_READINGS.map((r) => AUDIT_QUERY_SENTENCES[r]),
      AUDIT_QUERY_MEANING,
    ]
      .join(' ')
      .replace(/\s+/g, ' ')
      .toLowerCase();

    for (const forbidden of [
      'never authorised',
      'never published',
      'was published',
      'was created',
      'created the branch',
      'complete history',
      'proof of',
      'did not happen',
    ]) {
      expect(flat, forbidden).not.toContain(forbidden);
    }
    // ASCII only, for the reason every printed sentence here is.
    for (const reading of HEAD_PUBLICATION_BRANCH_QUERY_READINGS) {
      // eslint-disable-next-line no-control-regex
      expect(AUDIT_QUERY_SENTENCES[reading]).toMatch(/^[\x20-\x7e\n]+$/);
      expect(AUDIT_QUERY_SENTENCES[reading].length).toBeGreaterThan(40);
    }
    // eslint-disable-next-line no-control-regex
    expect(AUDIT_QUERY_MEANING).toMatch(/^[\x20-\x7e\n]+$/);
  });

  it('grades the query reading from the counts, totally', () => {
    expect(branchQueryReading({ named: 1, elsewhere: 0, unestablished: 9, shown: [] })).toBe(
      'NAMED_RECORDS_PRESENT',
    );
    expect(branchQueryReading({ named: 0, elsewhere: 3, unestablished: 0, shown: [] })).toBe(
      'NO_NAMED_RECORD_PRESENT',
    );
    expect(branchQueryReading({ named: 0, elsewhere: 0, unestablished: 1, shown: [] })).toBe(
      'NO_NAMED_RECORD_AND_EVIDENCE_UNREAD',
    );
    expect(Object.keys(AUDIT_QUERY_SENTENCES).sort()).toEqual(
      [...HEAD_PUBLICATION_BRANCH_QUERY_READINGS].sort(),
    );
  });
});

/* ── 7. the command line ──────────────────────────────────────────────────── */

describe('the command line', () => {
  it('lists the whole store when nothing is asked', async () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z' });
    const other = record(home, { at: '2026-08-27T12:01:00.000Z', name: 'OtherRepo' });

    const result = await run(home, []);

    expect(result.exitCode).toBe(EXIT_RUN_OK);
    expect(result.stdout).toContain(other);
    expect(result.stdout).not.toContain('Query        : ');
  });

  it('shows one branch when all four are asked', async () => {
    const home = scratchHome();
    const wanted = record(home, { at: '2026-08-27T12:00:00.000Z' });
    const other = record(home, { at: '2026-08-27T12:01:00.000Z', name: 'OtherRepo' });

    const result = await run(home, argv());

    expect(result.exitCode).toBe(EXIT_RUN_OK);
    expect(result.stdout).toContain(wanted);
    expect(result.stdout).not.toContain(other);
  });

  it('exits 0 when nothing names the branch', async () => {
    const home = scratchHome();
    record(home, { name: 'OtherRepo' });

    const result = await run(home, argv());

    // A produced listing is graded 0 whatever it contains. Anything else would
    // assert a blocking condition that does not exist, on a store nothing
    // prunes, for an answer that is simply the answer.
    expect(result.exitCode).toBe(EXIT_RUN_OK);
    expect(result.stderr).toBe('');
  });

  it.each([
    ['--forge-host'],
    ['--forge-owner'],
    ['--forge-name'],
    ['--ref'],
  ])('refuses a query missing %s', async (missing) => {
    const home = scratchHome();
    record(home);
    const args = argv();
    const at = args.indexOf(missing);
    args.splice(at, 2);

    const result = await run(home, args);

    expect(result.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(result.stdout).toContain('QUERY_FIELDS_MISSING');
    // Nothing was listed: a refused invocation answers about itself.
    expect(result.stdout).not.toContain('Listing      : ');
  });

  it.each([
    ['a host that is not a host', { host: 'GitHub.com' }, 'FORGE_HOST_UNUSABLE'],
    ['a host with a port', { host: 'github.com:443' }, 'FORGE_HOST_UNUSABLE'],
    ['an owner with a slash', { owner: 'a/b' }, 'FORGE_OWNER_UNUSABLE'],
    ['an owner that is a flag', { owner: '--forge-name' }, 'FORGE_OWNER_UNUSABLE'],
    ['a repository name of dots', { name: '..' }, 'FORGE_NAME_UNUSABLE'],
    ['a repository name with a slash', { name: 'a/b' }, 'FORGE_NAME_UNUSABLE'],
    ['a bare branch name', { ref: 'main' }, 'REF_UNUSABLE'],
    ['a tag', { ref: 'refs/tags/v1' }, 'REF_UNUSABLE'],
    ['a ref with a space', { ref: 'refs/heads/a b' }, 'REF_UNUSABLE'],
    ['a ref that is a flag', { ref: '--forge-owner' }, 'REF_UNUSABLE'],
  ])('refuses %s', async (_label, over, code) => {
    const home = scratchHome();
    record(home);

    const result = await run(home, argv(over));

    expect(result.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(result.stdout).toContain(code);
    expect(result.stdout).not.toContain('Listing      : ');
  });

  /**
   * A refusal must not depend on what is in the store.
   *
   * This is the V4 slice 12 defect in its own shape: an argument check placed
   * after a step that can return becomes conditional on repository state, and
   * one invocation then gets two answers. Measured as an equality between two
   * worlds rather than asserted twice.
   */
  it('refuses the same argv identically against an empty and a full store', async () => {
    const empty = scratchHome();
    const full = scratchHome();
    record(full, { at: '2026-08-27T12:00:00.000Z' });
    record(full, { at: '2026-08-27T12:01:00.000Z', name: 'OtherRepo' });
    plantFile(full, 'junk.txt', 'x');

    const a = await run(empty, argv({ ref: 'main' }));
    const b = await run(full, argv({ ref: 'main' }));

    expect(a.stdout).toBe(b.stdout);
    expect(a.exitCode).toBe(b.exitCode);
    expect(a.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
  });

  it('reads a query without touching the store at all', () => {
    // The reading is a pure function of the four strings: no path is built, no
    // profile is resolved and nothing is opened. A `..` in a ref is therefore a
    // string that names no record, not a path anything walks.
    expect(readBranchQuery({})).toEqual({ kind: 'WHOLE_STORE' });
    expect(
      readBranchQuery({
        forgeHost: IDENTITY.host,
        forgeOwner: IDENTITY.owner,
        forgeName: IDENTITY.name,
        ref: 'refs/heads/../../../etc/passwd',
      }),
    ).toEqual({
      kind: 'ONE_BRANCH',
      query: {
        forgeHost: IDENTITY.host,
        forgeOwner: IDENTITY.owner,
        forgeName: IDENTITY.name,
        authorisedRef: 'refs/heads/../../../etc/passwd',
      },
    });
  });

  it('names no record for a traversal-shaped ref, and opens nothing', async () => {
    const home = scratchHome();
    record(home);
    const before = treeDigest(home);

    const result = await run(home, argv({ ref: 'refs/heads/../../../etc/passwd' }));

    expect(result.exitCode).toBe(EXIT_RUN_OK);
    expect(result.stdout).toContain('0 named by this query');
    expect(treeDigest(home)).toBe(before);
  });

  it('offers exactly four options, and none that could ask for an effect', () => {
    const publication = buildProgram().commands.find((c) => c.name() === 'publication');
    const authorisations = publication?.commands.find((c) => c.name() === 'authorisations');

    expect(authorisations?.options.map((o) => o.long)).toEqual([
      '--forge-host',
      '--forge-owner',
      '--forge-name',
      '--ref',
    ]);
    expect(publication?.options.map((o) => o.long)).toEqual([]);
    // Bound by a rule as well as by the list, so a fifth option added later has
    // to answer this even if somebody widens the enumeration above.
    for (const option of authorisations?.options ?? []) {
      expect(option.long ?? '', option.long ?? '').not.toMatch(
        /force|unattended|adopt|takeover|steal/i,
      );
      expect(option.required || option.optional, `${option.long} must take a value`).toBe(true);
      expect(option.mandatory, `${option.long} must not be required`).toBe(false);
    }
  });

  it('has a total, sweepable refusal vocabulary', () => {
    expect(Object.keys(BRANCH_QUERY_REFUSAL_DETAIL).sort()).toEqual(
      [...BRANCH_QUERY_REFUSALS].sort(),
    );
    for (const refusal of BRANCH_QUERY_REFUSALS) {
      const sentence = BRANCH_QUERY_REFUSAL_DETAIL[refusal];
      expect(sentence.length, refusal).toBeGreaterThan(40);
      // eslint-disable-next-line no-control-regex
      expect(sentence, refusal).toMatch(/^[\x20-\x7e\n]+$/);
      expect(refusal, 'a refusal code is a value line').not.toMatch(
        /publish|attempt|creat|succeed|complete|execut|push|valid|current|verif|trust|proof|sign/i,
      );
    }
  });

  it('says in its own description what the query is and is not', () => {
    expect(AUTHORISATIONS_DESCRIPTION).toContain('Takes no repository checkout');
    expect(AUTHORISATIONS_DESCRIPTION).toContain('never an input to an authority');
    expect(AUTHORISATIONS_DESCRIPTION).toContain('delete one without trace');
    expect(AUTHORISATIONS_DESCRIPTION).toContain('there is no index');
  });
});

/* ── 8. the query grammar ─────────────────────────────────────────────────── */

describe('the query grammar', () => {
  it('accepts what this build can write and refuses what it cannot', () => {
    expect(isForgeHost('github.com')).toBe(true);
    expect(isForgeHost('GitHub.com')).toBe(false);
    expect(isForgeHost('github')).toBe(false);
    expect(isForgeOwner('M4XD4B0ZZ')).toBe(true);
    expect(isForgeOwner('-a')).toBe(false);
    expect(isForgeRepositoryName('.github')).toBe(true);
    expect(isForgeRepositoryName('..')).toBe(false);
    expect(isForgeRepositoryName('-x')).toBe(false);
  });

  /**
   * The grammar is the writer's own, reached through a module that imports
   * nothing.
   *
   * Both halves matter. Single-sourced, because a second copy is free to drift
   * from the first and this repository has already found one; and reached
   * without importing `delivery-target.ts`, which carries a type edge to
   * `repo/git-query.ts` and from there to `doctor/exec.ts` — the suite's
   * closure sweep follows type edges, so that import would put `spawn` in a
   * read-only command's swept graph.
   */
  it('is single-sourced, and reached without importing anything that can start a program', () => {
    const users = walkSource('src').filter((file) =>
      /forge-identity-grammar\.js/.test(codeOnly(file)),
    );
    expect(users.sort()).toEqual(['src/cli/publication-command.ts', 'src/deliver/delivery-target.ts']);

    // The grammar module reaches nothing at all.
    expect(codeOnly(GRAMMAR)).not.toMatch(/from '/);
    // …and the target no longer carries its own copy of the three patterns.
    for (const copy of ['HOST_PATTERN', 'OWNER_PATTERN', 'NAME_PATTERN', 'ALL_DOTS']) {
      expect(codeOnly('src/deliver/delivery-target.ts'), copy).not.toContain(`const ${copy}`);
    }
    expect(codeOnly(COMMAND)).not.toContain('delivery-target.js');
  });
});

/* ── 9. a lookup is not an authority ──────────────────────────────────────── */

describe('a lookup is not an authority', () => {
  it('names no way to write, spawn, reach a forge or read current policy', () => {
    for (const file of SLICE_17_SOURCE) {
      const code = codeOnly(file);
      for (const forbidden of [
        'mkdirSync',
        'writeFileSync',
        'renameSync',
        'unlinkSync',
        'rmSync',
        'recordHeadPublicationAuthorisation',
        'recordHeadPublicationOutcome',
        'child_process',
        'execFile',
        'spawn',
        'runCommand',
        'runGitCommand',
        'leasedGit',
        'createForgeCommandRunner',
        'acquireRepositoryExecutionLease',
        'resolveRepository',
        'loadTaskState',
        'saveTaskState',
        'loadDeliveryAutomation',
        'permitsUnattendedHeadPublication',
        'fetch(',
      ]) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('holds no authority artefact and no way to publish', () => {
    for (const file of SLICE_17_SOURCE) {
      const code = codeOnly(file);
      for (const forbidden of [
        'mintHeadPublicationGrant',
        'mintPullRequestCreationGrant',
        'mintMergeGrant',
        'HeadPublicationGrant',
        'MergeGrant',
        'claimHeadPublication',
        'publishDeliveryHead',
        'HeadPublicationSubject',
        'createPullRequest',
        'mergePullRequest',
      ]) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('names no scheduler, no sleep and no background work', () => {
    for (const file of SLICE_17_SOURCE) {
      const code = codeOnly(file);
      for (const forbidden of ['setTimeout', 'setInterval', 'setImmediate', 'cron', 'Atomics.wait']) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('is not read by anything on the publication authority path', () => {
    const readers = walkSource('src').filter((file) =>
      /\b(selectQueriedBranch|recordNamesQueriedBranch)\s*\(/.test(codeOnly(file)),
    );
    expect(readers.sort()).toEqual([
      'src/cli/render-publication-authorisations.ts',
      'src/deliver/head-publication-authorisation-listing.ts',
    ]);
    for (const file of [
      'src/cli/delivery-steps.ts',
      'src/cli/delivery-driver.ts',
      'src/deliver/publish-delivery-head.ts',
      'src/deliver/git-head-publisher.ts',
      'src/deliver/delivery-automation.ts',
    ]) {
      expect(codeOnly(file), file).not.toContain('selectQueriedBranch');
      expect(codeOnly(file), file).not.toContain('HeadPublicationBranchQuery');
    }
  });

  it('changes nothing in the store it was asked about', async () => {
    const home = scratchHome();
    record(home, { at: '2026-08-27T12:00:00.000Z', outcome: true });
    const damaged = record(home, { at: '2026-08-27T12:01:00.000Z', name: 'OtherRepo' });
    edit(home, damaged, { commit: 'e'.repeat(40) });
    plantDirectory(home, eventName('20260827T160000000Z', 'c'));
    plantFile(home, 'junk.txt', 'x');
    const before = treeDigest(home);

    await run(home, argv());
    await run(home, argv({ ref: 'refs/heads/nothing-here' }));
    await run(home, argv({ ref: 'main' }));

    expect(treeDigest(home)).toBe(before);
  });
});
