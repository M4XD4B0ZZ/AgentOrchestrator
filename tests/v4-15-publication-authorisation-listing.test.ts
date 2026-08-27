/**
 * V4 slice 15 — the operator-facing read of the unattended-publication audit
 * store.
 *
 * Slice 14 wrote evidence nobody could read. `L-V4-14-3` said so in the words
 * this suite exists to retire: "the store is not indexed, and nothing reads it
 * for you… there is no command that does it." Evidence nobody can read is not
 * accountability.
 *
 * This suite is written against the five ways a read like that goes wrong.
 *
 *  1. **enumeration trusting what it finds.** Slice 14 only ever opened one
 *     record, by a name it had just minted, inside a directory it had just
 *     created exclusively — so it never had to treat a directory entry as
 *     untrusted. A listing does. Every shape a crash, an operator or anything
 *     else running as this OS user can leave in the store is planted here and
 *     required to be classified rather than followed, including the two that
 *     read as valid history if a link is followed: a junction standing in for an
 *     event directory, and an `authorisation.json` that is a link to a file
 *     outside the store;
 *  2. **evidence disappearing quietly.** A damaged entry must be listed and must
 *     change the listing's grade. The load-bearing cases put a broken entry
 *     between two whole ones and require all three in the output — a listing
 *     that skipped what it could not read would look complete and would not be;
 *  3. **the filesystem choosing the order.** Measured here: on this NTFS volume
 *     `readdir` answers in the directory index's own case-folded collation,
 *     which is not the order this build prints. A fixture whose entries separate
 *     the two is what makes the sort load-bearing rather than incidental;
 *  4. **a report that says more than the record.** The record establishes a
 *     permission and a subject at one instant and nothing after it. Every
 *     printed sentence is swept for the words that would widen that — published,
 *     created, attempted, succeeded, verified, tamper-proof — and for every
 *     member of the publication vocabulary;
 *  5. **history becoming authority.** A record on disk must license nothing. The
 *     structural half is measured rather than asserted: the type this reader
 *     hands out is required to be unusable as an argument to the publication
 *     mint, which is a property of the field *names* and was measured to be
 *     nothing a brand or a private field could buy.
 *
 * What is deliberately not re-measured here: the writer, the binding, the
 * record's own contract and the publication ladder. Those are
 * `tests/v4-14-…`'s and `tests/v4-05-…`'s, and this suite drives the real writer
 * rather than fabricating records wherever a whole record is what it needs.
 */

import { Command } from 'commander';
import { createHash } from 'node:crypto';
import {
  chmodSync,
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
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { buildProgram } from '../src/cli/index.js';
import {
  AUDIT_LISTING_EXIT,
  AUTHORISATIONS_DESCRIPTION,
  PUBLICATION_GROUP_DESCRIPTION,
  registerPublicationCommand,
} from '../src/cli/publication-command.js';
import {
  AUDIT_ENTRY_SENTENCES,
  AUDIT_LISTING_SENTENCES,
  AUDIT_PRINTED_TEXT,
  AUDIT_REPORT_LABELS,
  renderPublicationAuthorisations,
} from '../src/cli/render-publication-authorisations.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import {
  HEAD_PUBLICATION_AUDIT_ENTRY_READINGS,
  HEAD_PUBLICATION_AUDIT_LISTINGS,
  HEAD_PUBLICATION_AUDIT_RECORD_FIELD,
  listHeadPublicationAuthorisations,
  type HeadPublicationAuditEntryReading,
  type HeadPublicationAuditListingOutcome,
} from '../src/deliver/head-publication-authorisation-listing.js';
import {
  HEAD_PUBLICATION_AUTHORISATION_READINGS,
  MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES,
  headPublicationAuthorisationBinding,
  inspectHeadPublicationAuthorisation,
  type HeadPublicationAuthorisation,
} from '../src/deliver/head-publication-authorisation.js';
import {
  HEAD_PUBLICATION_AUDIT_FILE_NAME,
  headPublicationAuditRoot,
  newHeadPublicationAuditEventId,
  recordHeadPublicationAuthorisation,
} from '../src/deliver/head-publication-authorisation-store.js';
import { HEAD_PUBLICATIONS } from '../src/deliver/head-publication.js';
import { EXIT_RUN_NEEDS_OPERATOR, EXIT_RUN_OK } from '../src/cli/run-exit-codes.js';

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

const READER = 'src/deliver/head-publication-authorisation-listing.ts';
const RENDERER = 'src/cli/render-publication-authorisations.ts';
const COMMAND = 'src/cli/publication-command.ts';
const SLICE_15_SOURCE = [READER, RENDERER, COMMAND] as const;

/* ── scratch ──────────────────────────────────────────────────────────────── */

const roots: string[] = [];

function scratchRoot(prefix = 'ao-v415-'): string {
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

const TASK = 'V4-15';
const HEAD = 'a'.repeat(40);
const REF = 'refs/heads/ao/task/V4-15';
const DIGEST = 'b'.repeat(64);
const AT = '2026-08-27T12:00:00.000Z';
const CHECKOUT = 'C:\\scratch\\repo';
const IDENTITY = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});

/** A profile with an orchestrator home but no store yet. */
function scratchHome(): string {
  const home = scratchRoot('ao-v415-home-');
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
  readonly declarationDigest?: string;
  readonly authorisedAt?: string;
  readonly at?: Date;
}

/**
 * One real record, written by the real writer into a real directory.
 *
 * Nothing in this suite fabricates a whole record where a whole record is what
 * it needs: a listing measured against hand-built bytes would be measuring this
 * file's idea of the format rather than the store's.
 */
function record(home: string, over: RecordOver = {}): string {
  const at = over.at ?? new Date(AT);
  const eventId = newHeadPublicationAuditEventId(at);
  const result = recordHeadPublicationAuthorisation({
    eventId,
    taskId: over.taskId ?? TASK,
    repositoryRoot: over.repositoryRoot ?? CHECKOUT,
    host: over.host ?? IDENTITY.host,
    owner: over.owner ?? IDENTITY.owner,
    name: over.name ?? IDENTITY.name,
    declaredRemote: over.declaredRemote ?? 'origin',
    ref: over.ref ?? REF,
    commit: over.commit ?? HEAD,
    declarationDigest: over.declarationDigest ?? DIGEST,
    authorisedAt: over.authorisedAt ?? at.toISOString(),
    pathProvider: fixedPathProvider(home),
  });
  expect(result.code, 'the fixture writer must succeed').toBe('RECORDED');
  return eventId;
}

/** Creates a directory directly in the store, whatever its name. */
function plantDirectory(home: string, name: string): string {
  const path = join(auditRoot(home), name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Creates a file directly in the store. */
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

function readRecord(home: string, eventId: string): HeadPublicationAuthorisation {
  return JSON.parse(readFileSync(recordPath(home, eventId), 'utf8')) as HeadPublicationAuthorisation;
}

/** Rewrites one field of a stored record without recomputing its digest. */
function edit(home: string, eventId: string, over: Partial<HeadPublicationAuthorisation>): void {
  const stored = { ...readRecord(home, eventId), ...over };
  writeFileSync(recordPath(home, eventId), `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
}

/**
 * Re-seals the record in `eventDirectory` so its binding holds for `underName`.
 *
 * A decoy planted outside the store is only a decoy if a build that followed the
 * link to it would read it as valid. Sealed for its own directory name it would
 * be refused on the binding whichever way the link question went, and an
 * assertion that its fields are absent would hold for the wrong reason.
 */
function reseal(eventDirectory: string, underName: string): void {
  const file = join(eventDirectory, HEAD_PUBLICATION_AUDIT_FILE_NAME);
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & {
    binding: string;
  };
  const { binding: _replaced, ...payload } = stored;
  const sealed = {
    ...payload,
    binding: headPublicationAuthorisationBinding(
      {
        eventId: underName,
        taskId: String(payload.taskId),
        repositoryRoot: String(payload.repositoryRoot),
      },
      payload as never,
    ),
  };
  writeFileSync(file, `${JSON.stringify(sealed, null, 2)}\n`, 'utf8');
}

function list(home: string) {
  return listHeadPublicationAuthorisations(fixedPathProvider(home));
}

function readingsOf(home: string): readonly HeadPublicationAuditEntryReading[] {
  return list(home).entries.map((entry) => entry.reading);
}

/** The whole report an operator would see. */
function report(home: string): string {
  return renderPublicationAuthorisations(list(home));
}

/* ── measuring that nothing changed ───────────────────────────────────────── */

/**
 * A digest of every path under a root and of every file's bytes.
 *
 * Names as well as contents, because "nothing was created" and "nothing was
 * written" are two claims and a content-only digest measures one of them.
 * Sorted, so the snapshot does not inherit the enumeration order this suite
 * spends a whole section refusing to trust.
 */
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

/* ── the store, read as it is ─────────────────────────────────────────────── */

describe('the store, read as it is', () => {
  it('reports an absent store as absent, and does not make one', () => {
    const home = scratchHome();
    const root = auditRoot(home);

    const result = list(home);

    expect(result.outcome).toBe('STORE_ABSENT');
    expect(result.entries).toEqual([]);
    expect(result.root).toBe(root);
    // The whole point of the member: a missing store is an observation, never an
    // invitation to create one.
    expect(readdirSync(join(home, '.agent-orchestrator'))).toEqual([]);
  });

  it('reports an empty store as read, with nothing in it', () => {
    const home = scratchHome();
    mkdirSync(auditRoot(home), { recursive: true });

    const result = list(home);

    expect(result.outcome).toBe('READ');
    expect(result.entries).toEqual([]);
  });

  it('reads one record the real writer wrote', () => {
    const home = scratchHome();
    const eventId = record(home);

    const result = list(home);

    expect(result.outcome).toBe('READ');
    expect(result.entries.length).toBe(1);
    const entry = result.entries[0];
    expect(entry?.reading).toBe('HISTORICAL_AUTHORISATION');
    expect(entry?.name).toBe(eventId);
    expect(entry?.record?.taskId).toBe(TASK);
  });

  it('reads several, and answers identically every time it is asked', () => {
    const home = scratchHome();
    for (const taskId of ['A-1', 'A-2', 'A-3', 'A-4']) record(home, { taskId });

    const first = report(home);
    const second = report(home);
    const third = report(home);

    expect(list(home).entries.length).toBe(4);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('still reads a record after the checkout it names has been deleted', () => {
    const home = scratchHome();
    const checkout = scratchRoot('ao-v415-checkout-');
    const eventId = record(home, { repositoryRoot: checkout });
    const before = report(home);

    rmSync(checkout, { recursive: true, force: true });
    roots.splice(roots.indexOf(checkout), 1);

    // Byte-identical, including the checkout path: the record names its own
    // subject and this command never goes and looks at it.
    expect(report(home)).toBe(before);
    expect(list(home).entries[0]?.record?.repositoryRoot).toBe(checkout);
    expect(list(home).entries[0]?.name).toBe(eventId);
  });

  it('is unchanged by the declaration being edited or removed', () => {
    const home = scratchHome();
    record(home);
    const declaration = join(home, '.agent-orchestrator', 'delivery-automation.yaml');

    writeFileSync(declaration, 'schemaVersion: 1\nrepositories: []\n', 'utf8');
    const withDenied = report(home);

    rmSync(declaration);
    const withNone = report(home);

    writeFileSync(declaration, 'not: yaml: at: all\n', 'utf8');
    const withBroken = report(home);

    // A policy file edited today may not change what yesterday's record means.
    expect(withDenied).toBe(withNone);
    expect(withBroken).toBe(withNone);
    expect(withNone).toContain(DIGEST);
  });
});

/* ── what one record shows ────────────────────────────────────────────────── */

describe('what one record shows', () => {
  it('shows every fact the record carries, exactly as recorded', () => {
    const home = scratchHome();
    const eventId = record(home, {
      taskId: 'T-42',
      repositoryRoot: 'D:\\some\\checkout',
      declaredRemote: 'upstream',
      ref: 'refs/heads/ao/task/T-42',
      commit: 'c'.repeat(40),
      declarationDigest: 'd'.repeat(64),
    });

    const text = report(home);

    expect(text).toContain(eventId);
    expect(text).toContain(AT);
    expect(text).toContain('T-42');
    expect(text).toContain('D:\\some\\checkout');
    expect(text).toContain('upstream -> github.com/M4XD4B0ZZ/AgentOrchestrator');
    expect(text).toContain('refs/heads/ao/task/T-42');
    // The whole object name, never an abbreviation: an identity that is not the
    // whole identity is a different fact.
    expect(text).toContain('c'.repeat(40));
    // The whole digest, for the same reason.
    expect(text).toContain('d'.repeat(64));
    expect(text).toContain('HEAD_PUBLICATION');
    expect(text).toContain('AUTOMATIC');
    expect(text).toContain('AUTOMATIC_ALLOWED');
  });

  it('shows a recorded remote as recorded, even when it is not a remote name', () => {
    const home = scratchHome();
    // What this build WRITES here is a remote name: the publication path takes
    // it from the resolved remote and never from a URL. What the contract
    // ADMITS is a hundred characters of anything, and `L-V4-14-2` concedes that
    // anything running as this OS user can write a record. So a store can hold
    // one carrying a URL with a credential in it, and the report shows what is
    // recorded.
    //
    // A first version of this case banned `https://` and `.git` from the output
    // over a fixture that planted neither. It could not fail, and the guarantee
    // it named is one this build does not have.
    record(home, { declaredRemote: 'https://ghp_TOKEN@github.com/o/r.git' });
    const text = report(home);

    expect(list(home).entries[0]?.reading).toBe('HISTORICAL_AUTHORISATION');
    expect(text).toContain('https://ghp_TOKEN@github.com/o/r.git -> github.com/');
    // The report echoes it; nothing about it is treated as a location. No
    // request is made, nothing is resolved, and the store is untouched.
    const before = treeDigest(home);
    report(home);
    expect(treeDigest(home)).toBe(before);
  });

  it('prints the instant the record carries and not one it worked out', () => {
    const home = scratchHome();
    // The name's instant and the record's disagree. Production takes both from
    // one `Date`, but nothing on the read side establishes that, so the report
    // must show the recorded value rather than the one in the name.
    const eventId = record(home, {
      at: new Date('2026-01-01T00:00:00.000Z'),
      authorisedAt: '2026-08-27T12:00:00.000Z',
    });

    const text = report(home);

    expect(eventId.startsWith('20260101T000000000Z-')).toBe(true);
    expect(text).toContain('Authorised at: 2026-08-27T12:00:00.000Z');
  });
});

/* ── records this build will not read ─────────────────────────────────────── */

describe('records this build will not read', () => {
  it('refuses a record whose digest was not recomputed, field by field', () => {
    const fields: readonly Partial<HeadPublicationAuthorisation>[] = [
      { taskId: 'SOMEBODY-ELSE' },
      { repositoryRoot: 'D:\\another\\checkout' },
      { host: 'example.com' },
      { owner: 'someone-else' },
      { name: 'another-project' },
      { declaredRemote: 'elsewhere' },
      { ref: 'refs/heads/somewhere-else' },
      { commit: 'e'.repeat(40) },
      { declarationDigest: 'f'.repeat(64) },
      { authorisedAt: '2020-01-01T00:00:00.000Z' },
      { eventId: eventName() },
    ];

    for (const over of fields) {
      const home = scratchHome();
      const eventId = record(home);
      edit(home, eventId, over);

      const entries = list(home).entries;
      const label = Object.keys(over)[0] as string;
      expect(entries[0]?.reading, label).toBe('RECORD_NOT_THIS_EVENT');
      // Nothing of a record this build refused is offered to anybody.
      expect(entries[0]?.record, label).toBeNull();
      expect(list(home).outcome, label).toBe('READ_WITH_UNUSABLE_ENTRIES');
    }
  });

  it('refuses a record copied out of another event directory', () => {
    const home = scratchHome();
    const mine = record(home, { taskId: 'MINE' });
    const theirs = record(home, { taskId: 'THEIRS', at: new Date('2026-08-27T12:00:01.000Z') });

    // The bytes of one event, filed under the name of another. Every value in it
    // is self-consistent; only the directory it sits in disagrees.
    writeFileSync(recordPath(home, theirs), readFileSync(recordPath(home, mine)));

    const entries = list(home).entries;
    expect(entries.find((e) => e.name === mine)?.reading).toBe('HISTORICAL_AUTHORISATION');
    expect(entries.find((e) => e.name === theirs)?.reading).toBe('RECORD_NOT_THIS_EVENT');
  });

  it('refuses a version it does not read, apart from a document it cannot parse', () => {
    const home = scratchHome();
    const future = record(home, { taskId: 'FUTURE' });
    edit(home, future, { authorisationVersion: 2 as never });
    const broken = plantDirectory(home, eventName('20260827T140000000Z', '1'));
    writeFileSync(join(broken, HEAD_PUBLICATION_AUDIT_FILE_NAME), '{"authorisationVersion":', 'utf8');

    const entries = list(home).entries;
    expect(entries.find((e) => e.name === future)?.reading).toBe('RECORD_UNSUPPORTED_VERSION');
    expect(entries.find((e) => e.name.startsWith('20260827T14'))?.reading).toBe('RECORD_MALFORMED');
  });

  it('refuses a record larger than the contract admits, without reading all of it', () => {
    const home = scratchHome();
    const eventId = record(home);
    const stored = readRecord(home, eventId);
    // Valid JSON, valid shape, and far past the bound. `readFileSync` plus
    // `JSON.parse` would answer HISTORICAL_AUTHORISATION here.
    const padded = { ...stored, padding: 'x'.repeat(MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES * 4) };
    writeFileSync(recordPath(home, eventId), `${JSON.stringify(padded, null, 2)}\n`, 'utf8');
    expect(statSync(recordPath(home, eventId)).size).toBeGreaterThan(
      MAX_HEAD_PUBLICATION_AUTHORISATION_BYTES * 4,
    );

    expect(readingsOf(home)).toEqual(['RECORD_MALFORMED']);
  });

  it('refuses a truncated record', () => {
    const home = scratchHome();
    const eventId = record(home);
    const bytes = readFileSync(recordPath(home, eventId));
    writeFileSync(recordPath(home, eventId), bytes.subarray(0, 120));

    expect(readingsOf(home)).toEqual(['RECORD_MALFORMED']);
  });

  it('refuses a record that parses and violates the contract', () => {
    const home = scratchHome();
    const eventId = record(home);
    // Inside the byte bound, valid JSON, and no `commit` grammar can accept it.
    edit(home, eventId, { commit: 'not-an-object-name' });

    expect(readingsOf(home)).toEqual(['RECORD_MALFORMED']);
  });
});

/* ── a store with things in it that are not records ───────────────────────── */

describe('a store with things in it that are not records', () => {
  it('tells an empty record file from no record at all', () => {
    const home = scratchHome();
    const crashed = plantDirectory(home, eventName('20260827T130000000Z', '1'));
    const emptied = plantDirectory(home, eventName('20260827T130001000Z', '2'));
    writeFileSync(join(emptied, HEAD_PUBLICATION_AUDIT_FILE_NAME), '', 'utf8');

    const entries = list(home).entries;

    expect(entries[0]?.reading).toBe('RECORD_ABSENT');
    expect(entries[1]?.reading).toBe('RECORD_EMPTY');
    expect(crashed).toContain('20260827T130000000Z');
    expect(list(home).outcome).toBe('READ_WITH_UNUSABLE_ENTRIES');
  });

  it('does not mistake a staging file for a record, and does not show it', () => {
    const home = scratchHome();
    const staged = plantDirectory(home, eventName('20260827T130002000Z', '3'));
    // The exact shape `state/atomic-file.ts` stages under, holding a whole
    // record's worth of bytes. It is not a record: only the rename that
    // completes a write ever creates the record's own name.
    const staging = `${HEAD_PUBLICATION_AUDIT_FILE_NAME}.tmp-abc-0123456789ab`;
    writeFileSync(join(staged, staging), '{"authorisationVersion":1}', 'utf8');

    const result = list(home);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0]?.reading).toBe('RECORD_ABSENT');
    expect(renderPublicationAuthorisations(result)).not.toContain('.tmp-');
  });

  it('lists what is in the store and is not an event, rather than ignoring it', () => {
    const home = scratchHome();
    record(home);
    plantFile(home, 'stray-note.txt', 'left here by somebody');
    plantDirectory(home, 'not-an-event');
    // A name that fails the grammar in one character: a five, where the version
    // nibble of a v4 UUID has to be a four.
    plantDirectory(home, '20260827T130000000Z-11111111-1111-5111-8111-111111111111');
    // A file in the root whose NAME is a perfectly valid event id. Only the
    // directory test refuses it.
    plantFile(home, eventName('20260827T131000000Z', '7'), 'not a directory');

    const result = list(home);

    expect(result.entries.length).toBe(5);
    expect(result.entries.filter((e) => e.reading === 'UNRECOGNISED_ENTRY').length).toBe(4);
    expect(result.outcome).toBe('READ_WITH_UNUSABLE_ENTRIES');
    const text = renderPublicationAuthorisations(result);
    expect(text).toContain('stray-note.txt');
    expect(text).toContain('not-an-event');
  });

  it('keeps every whole record visible around a broken one', () => {
    const home = scratchHome();
    const first = record(home, { taskId: 'BEFORE', at: new Date('2026-08-27T12:00:00.000Z') });
    const damaged = record(home, { taskId: 'DAMAGED', at: new Date('2026-08-27T12:00:01.000Z') });
    const last = record(home, { taskId: 'AFTER', at: new Date('2026-08-27T12:00:02.000Z') });
    edit(home, damaged, { ref: 'refs/heads/somewhere-else' });

    const result = list(home);
    const text = renderPublicationAuthorisations(result);

    // Independent events: one damaged directory says nothing about its
    // neighbours, and hiding them would be the failure this command exists to
    // prevent.
    expect(result.entries.map((e) => e.name)).toEqual([first, damaged, last].sort());
    expect(text).toContain('BEFORE');
    expect(text).toContain('AFTER');
    expect(text).toContain(damaged);
    // ...and the damaged one's values are not shown as though established.
    expect(text).not.toContain('DAMAGED');
    expect(result.outcome).toBe('READ_WITH_UNUSABLE_ENTRIES');
    // A listing was produced, so the command answered what it was asked. The
    // finding is in the report; see the exit contract for why a damaged entry
    // is not a blocking condition.
    expect(AUDIT_LISTING_EXIT[result.outcome]).toBe(EXIT_RUN_OK);
  });

  it('counts what it read apart from what it did not', () => {
    const home = scratchHome();
    record(home, { at: new Date('2026-08-27T12:00:00.000Z') });
    record(home, { at: new Date('2026-08-27T12:00:01.000Z') });
    plantFile(home, 'junk', 'x');

    expect(report(home)).toContain('Entries      : 3 (2 read, 1 not read)');
  });
});

/* ── the filesystem does not choose the order ─────────────────────────────── */

describe('the filesystem does not choose the order', () => {
  it('sorts by entry name, in an order the directory itself does not give', () => {
    const home = scratchHome();
    const later = record(home, { at: new Date('2026-08-27T12:00:01.000Z') });
    const earlier = record(home, { at: new Date('2025-01-01T00:00:00.000Z') });
    // Three names chosen to separate three different orders at once.
    //
    // Measured on this volume: `readdir` answers in the directory index's own
    // case-folded collation, in which `a-entry` precedes `B-entry` and `_under`
    // comes last; a code-unit sort puts them the other way round. And `0-stray`
    // sorts BEFORE an event name, because every event name begins with the
    // century digit `2` — so a listing that sorted everything into one list
    // would put it first, and this one puts it in the second tier. Without that
    // entry the two arrangements are indistinguishable on this fixture, which is
    // how a first version of this case passed while the tiering was gone.
    for (const junk of ['B-entry', 'a-entry', '_under', '0-stray']) plantDirectory(home, junk);

    const raw = readdirSync(auditRoot(home));
    const names = list(home).entries.map((e) => e.name);

    // Two tiers: the event directories this build would have minted, in name
    // order, and then everything else, in name order. A name this build did not
    // mint carries no instant, so interleaving it among the events would place
    // it at a time nothing measured.
    expect(names).toEqual([earlier, later, ...['B-entry', '_under', 'a-entry', '0-stray'].sort()]);
    // Neither the directory's order nor a single sort of everything.
    expect(names, 'the fixture must separate the two orders').not.toEqual(raw);
    expect(names, 'the fixture must separate two tiers from one list').not.toEqual(
      [...names].sort(),
    );
    expect(raw.length).toBe(names.length);
  });

  it('orders two events recorded at one instant, totally and repeatably', () => {
    const home = scratchHome();
    const at = new Date(AT);
    const ids = [record(home, { at }), record(home, { at }), record(home, { at })];
    expect(new Set(ids.map((id) => id.slice(0, 20))).size).toBe(1);

    const first = list(home).entries.map((e) => e.name);
    const second = list(home).entries.map((e) => e.name);

    expect(first).toEqual(ids.slice().sort());
    expect(second).toEqual(first);
  });

  it('places entries it cannot read in the same order as the rest', () => {
    const home = scratchHome();
    record(home, { at: new Date('2026-08-27T12:00:02.000Z') });
    const broken = plantDirectory(home, eventName('20260827T120001000Z', '5'));
    record(home, { at: new Date('2026-08-27T12:00:00.000Z') });

    const names = list(home).entries.map((e) => e.name);

    // An event directory whose record cannot be read is still an event
    // directory: it keeps its place among the rest, ordered by its own name,
    // rather than being heaped at either end.
    expect(names).toEqual([...names].sort());
    expect(names[1]).toBe(broken.split(/[\\/]/).pop());
  });
});

/* ── what is at the path, and what this build will not follow ─────────────── */

describe('what is at the path, and what this build will not follow', () => {
  it('reports a store that is a file, and never as an empty one', () => {
    const home = scratchHome();
    writeFileSync(auditRoot(home), 'not a store', 'utf8');

    const result = list(home);

    expect(result.outcome).toBe('STORE_UNREADABLE');
    expect(result.entries).toEqual([]);
    expect(result.errnoCode).toBe('ENOTDIR');
    expect(AUDIT_LISTING_EXIT[result.outcome]).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('does not report a blocked path as an empty store', () => {
    const home = scratchHome();
    // The orchestrator home is a FILE, so the store cannot exist and cannot be
    // created either. Measured: Windows answers `readdir` on the store path with
    // `ENOENT` here — `ERROR_PATH_NOT_FOUND` — not `ENOTDIR`, which arrives only
    // when the root itself is the non-directory. A listing that read the outcome
    // off that errno said "there is no store under this user profile" and exited
    // zero, while the writer, on the same profile at the same instant, answers
    // `STORE_UNAVAILABLE` and the drive grades it 3.
    rmSync(join(home, '.agent-orchestrator'), { recursive: true, force: true });
    writeFileSync(join(home, '.agent-orchestrator'), 'not a directory', 'utf8');

    const result = list(home);

    expect(result.outcome).toBe('STORE_UNREADABLE');
    expect(result.errnoCode).toBe('ENOTDIR');
    expect(AUDIT_LISTING_EXIT[result.outcome]).toBe(EXIT_RUN_NEEDS_OPERATOR);
    // The writer's own verdict on the same profile, as the control: the two
    // commands must not disagree about whether this store is usable.
    const written = recordHeadPublicationAuthorisation({
      eventId: newHeadPublicationAuditEventId(new Date(AT)),
      taskId: TASK,
      repositoryRoot: CHECKOUT,
      ...IDENTITY,
      declaredRemote: 'origin',
      ref: REF,
      commit: HEAD,
      declarationDigest: DIGEST,
      authorisedAt: AT,
      pathProvider: fixedPathProvider(home),
    });
    expect(written.code).not.toBe('RECORDED');
  });

  it('reports a store it could not place at all, without naming a path', () => {
    // The one producer of this member is the profile resolver refusing, and it
    // has five reasons: the OS could not be asked, and four where it answered
    // and the answer was not one this build accepts.
    const throwing = Object.freeze({
      get homeDirectory(): string {
        throw new Error('the profile is not establishable');
      },
    });

    const result = listHeadPublicationAuthorisations(throwing);

    expect(result.outcome).toBe('PROFILE_UNAVAILABLE');
    expect(result.root).toBeNull();
    expect(result.entries).toEqual([]);
    expect(AUDIT_LISTING_EXIT[result.outcome]).toBe(EXIT_RUN_NEEDS_OPERATOR);
    const text = renderPublicationAuthorisations(result);
    expect(text).not.toContain('Store        :');
    // ...and it does not claim to have read anything.
    expect(text).not.toContain('This command read the store');
    expect(text).toContain('This command changed nothing');
  });

  it('refuses a store reached through a link, and reads nothing through it', () => {
    const home = scratchHome();
    const elsewhere = scratchRoot('ao-v415-elsewhere-');
    // A whole, valid store somewhere else, so a reader that followed the link
    // would have plausible records to report as this profile's.
    const decoy = scratchHome();
    record(decoy, { taskId: 'NOT-THIS-PROFILE' });
    mkdirSync(elsewhere, { recursive: true });

    let linked = false;
    try {
      execFileSync('cmd', ['/c', 'mklink', '/J', auditRoot(home), auditRoot(decoy)], {
        stdio: 'pipe',
      });
      linked = true;
    } catch {
      // Measured on this machine: `mklink /J` needs no elevation. Where it is
      // refused there is nothing to measure, and a fabricated result would be
      // worse than none.
    }
    if (!linked) return;

    const result = list(home);

    expect(result.outcome).toBe('STORE_PATH_UNSAFE');
    expect(result.entries).toEqual([]);
    expect(renderPublicationAuthorisations(result)).not.toContain('NOT-THIS-PROFILE');
  });

  it('refuses an event entry that is a link, and reads nothing through it', () => {
    const home = scratchHome();
    const decoy = scratchHome();
    const planted = record(decoy, { taskId: 'PLANTED' });
    const name = eventName('20260827T150000000Z', '9');
    mkdirSync(auditRoot(home), { recursive: true });

    let linked = false;
    try {
      execFileSync(
        'cmd',
        ['/c', 'mklink', '/J', join(auditRoot(home), name), join(auditRoot(decoy), planted)],
        { stdio: 'pipe' },
      );
      linked = true;
    } catch {
      // As above.
    }
    if (!linked) return;

    // The decoy is re-sealed for the name the LINK has, which is what makes the
    // absence below falsifiable: a build that followed the junction would grade
    // these bytes `HISTORICAL_AUTHORISATION` and print `PLANTED`. Sealed for its
    // own name instead, the binding would refuse them anyway and the assertion
    // would hold whether the link was followed or not.
    reseal(join(auditRoot(decoy), planted), name);

    const result = list(home);

    expect(result.entries.length).toBe(1);
    // Not `HISTORICAL_AUTHORISATION`: a record read through a link is evidence
    // from somewhere else, filed under a name in this store.
    expect(result.entries[0]?.reading).toBe('UNRECOGNISED_ENTRY');
    expect(renderPublicationAuthorisations(result)).not.toContain('PLANTED');
  });

  it('refuses a record file that is a link, and reads nothing through it', () => {
    const home = scratchHome();
    const decoy = scratchHome();
    const planted = record(decoy, { taskId: 'PLANTED-FILE' });
    const event = plantDirectory(home, eventName('20260827T151000000Z', 'a'));

    // Sealed for the entry's own name, so a build that followed the link would
    // read it as this event's record and print `PLANTED-FILE`.
    reseal(join(auditRoot(decoy), planted), event.split(/[\\/]/).pop() as string);

    let linked = false;
    try {
      symlinkSync(recordPath(decoy, planted), join(event, HEAD_PUBLICATION_AUDIT_FILE_NAME), 'file');
      linked = true;
    } catch {
      // A file symbolic link needs a privilege a junction does not. Where it
      // cannot be made there is nothing to measure here.
    }
    if (!linked) return;

    const result = list(home);

    // The event directory itself is a perfectly ordinary directory; only the
    // record's own name is the link, and a check on the directory alone would
    // not see it.
    expect(result.entries[0]?.reading).toBe('RECORD_UNREADABLE');
    expect(renderPublicationAuthorisations(result)).not.toContain('PLANTED-FILE');
  });

  it('refuses a directory sitting where the record should be', () => {
    const home = scratchHome();
    const event = plantDirectory(home, eventName('20260827T152000000Z', 'b'));
    mkdirSync(join(event, HEAD_PUBLICATION_AUDIT_FILE_NAME));

    // Measured: a directory opens successfully on Windows and reports size zero,
    // so without the file test this would read as an empty file — the wrong
    // answer arrived at by accident.
    expect(readingsOf(home)).toEqual(['RECORD_UNREADABLE']);
  });

  it('keeps two checkouts and two tasks apart', () => {
    const home = scratchHome();
    record(home, { taskId: 'T-1', repositoryRoot: 'D:\\clone-a', at: new Date('2026-08-27T12:00:00.000Z') });
    record(home, { taskId: 'T-1', repositoryRoot: 'D:\\clone-b', at: new Date('2026-08-27T12:00:01.000Z') });
    record(home, { taskId: 'T-2', repositoryRoot: 'D:\\clone-a', at: new Date('2026-08-27T12:00:02.000Z') });

    const result = list(home);
    const text = renderPublicationAuthorisations(result);

    expect(result.entries.length).toBe(3);
    expect(result.outcome).toBe('READ');
    expect(text).toContain('D:\\clone-a');
    expect(text).toContain('D:\\clone-b');
  });

  it('ignores what else is in an event directory', () => {
    const home = scratchHome();
    const eventId = record(home);
    const event = join(auditRoot(home), eventId);
    writeFileSync(join(event, 'README.txt'), 'somebody put this here', 'utf8');
    mkdirSync(join(event, 'subdir'));

    // The record is opened by name. Nothing here claims the directory holds one
    // thing, because nothing measured that.
    expect(readingsOf(home)).toEqual(['HISTORICAL_AUTHORISATION']);
    expect(report(home)).not.toContain('README.txt');
  });
});

/* ── it reads, and changes nothing ────────────────────────────────────────── */

describe('it reads, and changes nothing', () => {
  it('creates nothing at all when there is no store', () => {
    const home = scratchHome();
    const before = treeDigest(home);

    list(home);
    list(home);

    expect(treeDigest(home)).toBe(before);
    expect(readdirSync(join(home, '.agent-orchestrator'))).toEqual([]);
  });

  it('leaves every byte of a store it read exactly as it was', () => {
    const home = scratchHome();
    record(home, { taskId: 'ONE', at: new Date('2026-08-27T12:00:00.000Z') });
    const damaged = record(home, { taskId: 'TWO', at: new Date('2026-08-27T12:00:01.000Z') });
    edit(home, damaged, { commit: 'e'.repeat(40) });
    plantDirectory(home, eventName('20260827T160000000Z', 'c'));
    plantFile(home, 'junk.txt', 'x');
    const before = treeDigest(home);

    list(home);
    report(home);

    // Nothing was repaired, nothing was cleaned up, nothing was normalised.
    expect(treeDigest(home)).toBe(before);
  });

  it('names no way to write, spawn or reach a forge', () => {
    for (const file of SLICE_15_SOURCE) {
      const code = codeOnly(file);
      for (const forbidden of [
        'mkdirSync',
        'writeFileSync',
        'renameSync',
        'unlinkSync',
        'rmSync',
        'appendFileSync',
        'writeSync',
        'createRunDirectory',
        'writeRunArtifact',
        'writeFileAtomically',
        'recordHeadPublicationAuthorisation',
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
        'notifyBlockRun',
        'fetch(',
      ]) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('does not import the writer of the store it reads', () => {
    const code = codeOnly(READER);
    expect(code).toContain('head-publication-audit-location.js');
    // The location moved out of the writer for exactly this: a read-only listing
    // must not carry the exclusive `mkdir` and the publishing `rename` in its own
    // import closure to learn a directory name.
    expect(code).not.toContain('head-publication-authorisation-store.js');
  });
});

/* ── evidence, and never authority ────────────────────────────────────────── */

describe('evidence, and never authority', () => {
  it('hands out a record that cannot be an argument to the publication mint', () => {
    const home = scratchHome();
    record(home);
    const entry = list(home).entries[0];
    // Without this the case passes against a stub: `record === null` gives an
    // empty key list and every assertion below holds for free.
    expect(entry?.reading).toBe('HISTORICAL_AUTHORISATION');
    expect(entry?.record).not.toBeNull();
    const shown = Object.keys(entry?.record ?? {});
    expect(shown.length).toBeGreaterThan(10);

    // Measured against the real declarations: `mintHeadPublicationGrant` takes a
    // structurally typed `{host, owner, name, commit}` and the re-check seam
    // takes `{host, owner, name, remoteName, ref, commit}`. A value carrying
    // those names is an argument either accepts, and a brand, a branded string
    // and a `#private` field were each measured to be no defence at all. Names
    // are the defence, so the names are what is pinned.
    for (const forbidden of ['host', 'owner', 'name', 'commit', 'ref', 'remoteName']) {
      expect(shown, `a listed record must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('shows every field of the record it read, under its own name', () => {
    const home = scratchHome();
    const eventId = record(home);
    const stored = readRecord(home, eventId) as unknown as Record<string, unknown>;
    const shown = list(home).entries[0]?.record as unknown as Record<string, unknown>;

    // The rename is complete by type. That it carries the same VALUES is a
    // different question and this is where it is asked: a map proves only that
    // every key was named.
    expect(Object.keys(HEAD_PUBLICATION_AUDIT_RECORD_FIELD).slice().sort()).toEqual(
      Object.keys(stored).slice().sort(),
    );
    for (const [from, to] of Object.entries(HEAD_PUBLICATION_AUDIT_RECORD_FIELD)) {
      expect(shown[to], `${from} -> ${to}`).toEqual(stored[from]);
    }
  });

  it('exports no grader that hands out a record the mint would accept', () => {
    const home = scratchHome();
    const eventId = record(home);
    const inspection = inspectHeadPublicationAuthorisation(
      readFileSync(recordPath(home, eventId)),
      eventId,
    );

    expect(inspection.reading).toBe('HISTORICAL_AUTHORISATION');
    // Slice 14 exported one grader and it returned a reading string, so no
    // exported function in this build handed out a record VALUE at all. This
    // slice's refactor added a second entry point that could have, and a review
    // measured what that would cost: the record's own field names satisfy the
    // mint's structurally typed parameter, so two exported calls would have
    // turned a file on disk into a claimable grant with no repository, no
    // declaration read and no observation. It returns the renamed view instead.
    for (const forbidden of ['host', 'owner', 'name', 'commit', 'ref', 'remoteName']) {
      expect(Object.keys(inspection.record ?? {}), forbidden).not.toContain(forbidden);
    }
    expect(Object.keys(inspection.record ?? {})).toContain('forgeHost');
  });

  it('holds no authority artefact and no way to publish', () => {
    for (const file of SLICE_15_SOURCE) {
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
      ]) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('names no scheduler, no sleep and no background work', () => {
    for (const file of SLICE_15_SOURCE) {
      const code = codeOnly(file);
      for (const forbidden of ['setTimeout', 'setInterval', 'setImmediate', 'cron', 'Atomics.wait']) {
        expect(code, `${file} must not name ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('is not read by anything on the publication authority path', () => {
    const readers = walkSource('src').filter((file) =>
      /\blistHeadPublicationAuthorisations\s*\(/.test(codeOnly(file)),
    );

    // Fail-closed, and this is the second version of this case. The first was a
    // deny-list of six module names, which is a pin that goes stale in the
    // unsafe direction: a future authority module called anything else could
    // read the store with the whole suite green. An allow-list cannot - a new
    // caller fails here until somebody decides it may exist.
    expect(readers).toEqual([
      'src/cli/publication-command.ts',
      'src/deliver/head-publication-authorisation-listing.ts',
    ]);

    // ...and the deny-list is kept as well, because the two fail in different
    // directions: this one still holds if the list above is ever widened by
    // somebody who did not think about what they were widening it with.
    for (const file of readers) {
      expect(file, `${file} must not be on the authority path`).not.toMatch(
        /delivery-steps|delivery-driver|publish-delivery-head|git-head-publisher|head-publication-grant|delivery-automation/,
      );
    }
    for (const file of [
      'src/cli/delivery-steps.ts',
      'src/cli/delivery-driver.ts',
      'src/deliver/publish-delivery-head.ts',
      'src/deliver/git-head-publisher.ts',
      'src/deliver/delivery-automation.ts',
    ]) {
      expect(codeOnly(file), file).not.toContain('listHeadPublicationAuthorisations');
    }
  });

  it('offers no flag that could ask for an effect', () => {
    const publication = buildProgram().commands.find((c) => c.name() === 'publication');
    const authorisations = publication?.commands.find((c) => c.name() === 'authorisations');

    expect(publication).toBeDefined();
    expect(authorisations).toBeDefined();
    // No options at all: no repository, no grant, no force, and nothing that
    // could be read as asking for an act.
    expect(authorisations?.options.map((o) => o.long)).toEqual([]);
    expect(publication?.options.map((o) => o.long)).toEqual([]);
    expect(publication?.commands.map((c) => c.name())).toEqual(['authorisations']);
  });
});

/* ── what the report may not say ──────────────────────────────────────────── */

describe('what the report may not say', () => {
  /** Every sentence, the two command descriptions, and a whole rendered report. */
  function everythingPrinted(): string {
    const home = scratchHome();
    record(home);
    plantFile(home, 'junk', 'x');
    return [
      ...AUDIT_PRINTED_TEXT,
      PUBLICATION_GROUP_DESCRIPTION,
      AUTHORISATIONS_DESCRIPTION,
      report(home),
    ].join('\n');
  }

  /**
   * The report's whole text with its line breaks flattened.
   *
   * A sentence that wraps is one sentence; a search that treats the wrap as
   * meaningful measures the column width instead of the words.
   */
  function flat(text: string): string {
    return text.replace(/\s+/g, ' ');
  }

  /**
   * Only the lines that put a value beside a label.
   *
   * This is where a claim is made, and it is held to a much stricter rule than
   * the prose underneath it — because bounding a claim means saying the word in
   * order to deny it, and a sweep that forbade "not that a publication was
   * attempted" would forbid the sentence doing the work.
   */
  function valueLines(text: string): readonly string[] {
    return text
      .split('\n')
      .filter((raw) =>
        AUDIT_REPORT_LABELS.some((label) => raw.trimStart().startsWith(`${label} `) || raw.trimStart().startsWith(`${label}:`)),
      );
  }

  /**
   * The label of a value line, or `null` for anything else.
   *
   * Recognised by the column the colon sits in rather than by a loose pattern:
   * the report pads every label to thirteen, at column zero or indented by two,
   * so the colon is at index 13 or 15 and nowhere else. A pattern that only
   * looked for "capitalised words then a colon" matched the closing sentence
   * too, which is prose and not a value.
   */
  function labelOf(raw: string): string | null {
    for (const indent of [0, 2]) {
      if (raw.length <= indent + 14) continue;
      if (raw.slice(indent + 13, indent + 15) !== ': ') continue;
      // A label never begins with a space, and the indent before it is nothing
      // else. Without this, a wrapped prose line whose colon happens to land in
      // the same column reads as a label.
      if (raw.slice(0, indent).trim() !== '' || raw[indent] === ' ') continue;
      const label = raw.slice(indent, indent + 13).trimEnd();
      if (label.length > 0) return label;
    }
    return null;
  }

  it('sweeps every label the report actually emits, and no more', () => {
    // The strict sweep below selects lines by prefix-matching a hand-written
    // constant. Nothing pinned that constant against what the renderer emits, so
    // a value line under a new label - `Published at`, say - would never have
    // been swept at all. This is the pin: the two sets are the same set.
    const home = scratchHome();
    record(home);
    plantFile(home, 'junk', 'x');
    const emitted = new Set<string>();
    for (const raw of report(home).split('\n')) {
      const label = labelOf(raw);
      if (label !== null) emitted.add(label);
    }

    expect([...emitted].sort()).toEqual(
      AUDIT_REPORT_LABELS.filter((label) => emitted.has(label))
        .slice()
        .sort(),
    );
    // ...and every label in the constant is one this report can produce, over
    // the union of a readable record, an unreadable store and a link refusal, so
    // the constant cannot quietly grow entries nothing emits.
    const everyLabel = new Set(emitted);
    const unreadable = scratchHome();
    writeFileSync(auditRoot(unreadable), 'not a store', 'utf8');
    for (const raw of report(unreadable).split('\n')) {
      const label = labelOf(raw);
      if (label !== null) everyLabel.add(label);
    }
    expect([...everyLabel].sort()).toEqual([...AUDIT_REPORT_LABELS].sort());
  });

  it('states no outcome on any line that carries a value', () => {
    const home = scratchHome();
    record(home);
    plantFile(home, 'junk', 'x');
    const lines = valueLines(report(home));

    // A positive control first: the filter must actually be selecting the lines
    // this rule is about, or an empty selection would pass it for free.
    expect(lines.length).toBeGreaterThan(8);
    expect(lines.some((l) => l.includes('HISTORICAL_AUTHORISATION'))).toBe(true);

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

  it('never uses a word that would be untrue even in a denial', () => {
    const text = flat(everythingPrinted()).toLowerCase();
    for (const forbidden of [
      'tamper-proof',
      'tamper proof',
      'tamper-evident',
      'non-repudiable',
      'trusted audit',
      'audit trail',
      'authenticated',
      'cryptographically',
      'created_by_ao',
      'publication_attempted',
      'was published',
      'were published',
      'has published',
      'was created',
      'were created',
      'created the branch',
      'succeeded',
      'still permitted',
      'currently authorised',
      'never authorised',
      'proof of',
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it('uses an outcome word only inside a denial, and nowhere else', () => {
    // The rule this measures, rather than a list of phrasings. A first version
    // banned the exact strings "was published", "were published" and "has
    // published", and a mutant that rewrote one sentence to "A branch this build
    // published, whose digest recomputes..." walked straight past all three. The
    // sentence-shaped instrument catches the class: an outcome verb may appear
    // only where something within the same clause denies it.
    const negations = ['not', 'never', 'no ', 'nothing', 'cannot', 'does not', 'without'];
    const outcomes = [
      'published',
      'publishes',
      'created',
      'creates',
      'succeeded',
      'succeeds',
      'pushed',
      'attempted',
      'executed',
      'completed',
    ];

    let seen = 0;
    for (const sentence of [
      ...AUDIT_PRINTED_TEXT,
      PUBLICATION_GROUP_DESCRIPTION,
      AUTHORISATIONS_DESCRIPTION,
    ]) {
      const one = flat(sentence).toLowerCase();
      for (const word of outcomes) {
        let at = one.indexOf(word);
        while (at !== -1) {
          seen += 1;
          const before = one.slice(Math.max(0, at - 80), at);
          expect(
            negations.some((no) => before.includes(no)),
            `"${word}" is asserted rather than denied in: ...${one.slice(Math.max(0, at - 80), at + 30)}`,
          ).toBe(true);
          at = one.indexOf(word, at + 1);
        }
      }
    }
    // A positive control: the rule is worthless if no printed sentence contains
    // one of these words at all, because then it would pass for any text.
    expect(seen, 'the denials must actually use the words they deny').toBeGreaterThan(2);
  });

  it('bounds the claim in its own words, rather than leaving it unsaid', () => {
    const text = flat(everythingPrinted());
    // The heading is pinned with the sentences under it. A mutant that left the
    // denials in place and retitled them "Also worth knowing" survived an
    // earlier version of this case: every sentence stayed true and the framing
    // that makes them bounds rather than trivia was gone.
    expect(text).toContain('What it does not say:');
    // The denials have to be present, not merely the assertions absent: an
    // operator reading a directory of readable records needs the bounds in front
    // of them, and a report that simply omitted the words would leave the
    // comfortable reading standing.
    for (const required of [
      'not that a publication was attempted',
      'not that the ref exists',
      'not that this build put it there',
      'not that the declaration still permits any of it',
    ]) {
      expect(text, required).toContain(required);
    }
  });

  it('says out loud that a record can be forged and deleted by this OS user', () => {
    const text = flat(everythingPrinted());
    expect(text).toContain('can write a record that reads exactly like the rest');
    expect(text).toContain('delete one without trace');
    expect(text).toContain('no key material in this build');
    expect(text).toContain('neither a complete history nor evidence of who wrote what');
  });

  it('never states a publication outcome, in any of its words', () => {
    const text = everythingPrinted();
    for (const member of HEAD_PUBLICATIONS) {
      expect(text, member).not.toContain(member);
    }
  });

  it('answers an empty store without claiming nothing was ever authorised', () => {
    const home = scratchHome();
    mkdirSync(auditRoot(home), { recursive: true });
    const text = report(home);

    expect(text).toContain('0 (0 read, 0 not read)');
    // The strongest true sentence about an empty store is about what is present
    // now. Deletion is untraceable, so "nothing was ever authorised" is not
    // reachable from an empty directory.
    expect(text.replace(/\s+/g, ' ')).toContain('this is what is present now');
    expect(text.toLowerCase()).not.toContain('never authorised');
  });

  it('answers an unreadable store apart from an empty one', () => {
    const absent = scratchHome();
    const unreadable = scratchHome();
    writeFileSync(auditRoot(unreadable), 'not a store', 'utf8');

    expect(report(absent)).toContain('There is no store under this user profile');
    expect(report(unreadable)).toContain('could not be listed');
    // "Nothing is recorded" and "I could not establish what is recorded" are
    // never the same report, never the same member and never the same grade.
    expect(list(absent).outcome).toBe('STORE_ABSENT');
    expect(list(unreadable).outcome).toBe('STORE_UNREADABLE');
    expect(AUDIT_LISTING_EXIT.STORE_ABSENT).toBe(EXIT_RUN_OK);
    expect(AUDIT_LISTING_EXIT.STORE_UNREADABLE).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  it('prints ASCII and nothing else', () => {
    for (const text of [
      ...AUDIT_PRINTED_TEXT,
      PUBLICATION_GROUP_DESCRIPTION,
      AUTHORISATIONS_DESCRIPTION,
    ]) {
      for (const character of text) {
        expect(
          (character.codePointAt(0) ?? 0) <= 0x7f,
          `non-ASCII ${JSON.stringify(character)} in ${text.slice(0, 40)}`,
        ).toBe(true);
      }
    }
  });

  it('has one sentence per member, and no member without one', () => {
    expect(Object.keys(AUDIT_ENTRY_SENTENCES).slice().sort()).toEqual(
      [...HEAD_PUBLICATION_AUDIT_ENTRY_READINGS].sort(),
    );
    expect(Object.keys(AUDIT_LISTING_SENTENCES).slice().sort()).toEqual(
      [...HEAD_PUBLICATION_AUDIT_LISTINGS].sort(),
    );
    for (const sentence of AUDIT_PRINTED_TEXT) expect(sentence.length).toBeGreaterThan(40);
  });

  it('does not name the good reading anything an operator could switch on', () => {
    // The store's own rule, applied to the vocabulary this slice adds: a member
    // called VALID, CURRENT or AUTHORISED is one somebody switches on.
    for (const member of HEAD_PUBLICATION_AUDIT_ENTRY_READINGS) {
      expect(['VALID', 'CURRENT', 'AUTHORISED', 'OK', 'PERMITTED']).not.toContain(member);
    }
    expect(HEAD_PUBLICATION_AUDIT_ENTRY_READINGS).toContain('HISTORICAL_AUTHORISATION');
  });
});

/* ── a forged record does not get to choose what the report says ──────────── */

describe('a forged record does not get to choose what the report says', () => {
  /**
   * A whole record, sealed for one directory name, with chosen values.
   *
   * This is the one place in the suite that builds a record rather than driving
   * the writer, and it has to: the point is exactly what the writer would never
   * produce. Anything running as this OS user can do this — `L-V4-14-2` — so it
   * is a shape the reader really meets, not a hypothetical.
   */
  function forge(home: string, name: string, over: Record<string, unknown>): void {
    // The shape comes from a record the real writer made, so a forgery cannot
    // pass by disagreeing with the format in some way the reader would catch
    // anyway. Only the named fields differ.
    const source = scratchHome();
    const template = readRecord(source, record(source));
    const { binding: _replaced, ...rest } = { ...template, eventId: name, ...over } as Record<
      string,
      unknown
    > & { binding: string };
    const sealed = {
      ...rest,
      binding: headPublicationAuthorisationBinding(
        {
          eventId: name,
          taskId: String(rest.taskId),
          repositoryRoot: String(rest.repositoryRoot),
        },
        rest as never,
      ),
    };
    const event = plantDirectory(home, name);
    writeFileSync(
      join(event, HEAD_PUBLICATION_AUDIT_FILE_NAME),
      `${JSON.stringify(sealed, null, 2)}\n`,
      'utf8',
    );
  }

  it('refuses a record whose own event identity is not the directory it sits in', () => {
    const home = scratchHome();
    const name = eventName('20260827T170000000Z', 'd');
    // The contract bounds `eventId` inside the document at 128 characters and
    // checks no grammar, and the binding covers BOTH it and the directory name
    // as separate inputs — so a digest recomputed over a pair that disagrees is
    // self-consistent and recomputes cleanly. Nothing made the two agree.
    //
    // The writer never produces such a pair: it sets both from one value and the
    // exclusive `mkdir` refuses any other name. So this is a record this build
    // can prove it did not write, and it used to read `HISTORICAL_AUTHORISATION`
    // with 128 characters of chosen text inside it.
    forge(home, name, { eventId: 'THIS IS NOT A RUN ID AT ALL' });

    const result = list(home);
    const text = renderPublicationAuthorisations(result);

    expect(result.entries[0]?.reading).toBe('RECORD_NOT_THIS_EVENT');
    expect(result.entries[0]?.record).toBeNull();
    expect(result.entries[0]?.name).toBe(name);
    expect(result.outcome).toBe('READ_WITH_UNUSABLE_ENTRIES');
    // Nothing of it is shown, and the heading is still the name on disk.
    expect(text).toContain(name);
    expect(text).not.toContain('THIS IS NOT A RUN ID AT ALL');
  });

  it('reads a record whose event identity does agree, and shows the name on disk', () => {
    const home = scratchHome();
    const name = eventName('20260827T170500000Z', 'd');
    // The control for the case above: same construction, same re-sealing, and
    // the one field that differs is the one being tested. Without it the refusal
    // above could come from anything the forging helper does.
    forge(home, name, {});

    const result = list(home);

    expect(result.entries[0]?.reading).toBe('HISTORICAL_AUTHORISATION');
    expect(result.entries[0]?.record?.recordedEventId).toBe(name);
    // The heading comes from the directory, not from the field — which is now
    // provably the same string for any readable record, and is still taken from
    // the one of the two that is not inside the bytes.
    expect(renderPublicationAuthorisations(result)).toContain(`Entry        : ${name}`);
  });

  it('cannot forge extra lines into the report with a control character', () => {
    const home = scratchHome();
    const name = eventName('20260827T171000000Z', 'e');
    forge(home, name, {
      taskId: 'T-1\n  Reading      : HISTORICAL_AUTHORISATION\n  Task         : INVENTED',
    });

    const result = list(home);
    const text = renderPublicationAuthorisations(result);

    expect(result.entries[0]?.reading).toBe('HISTORICAL_AUTHORISATION');
    // One entry, and exactly one line whose LABEL is `Reading`. Without the
    // escaping, one record would print itself as two, and the forged half would
    // read as a second event that is not in the store at all.
    expect(text.split('\n').filter((l) => /^ {2}Reading {6}: /.test(l)).length).toBe(1);
    expect(text.split('\n').filter((l) => /^ {2}Task {9}: /.test(l)).length).toBe(1);
    // The bytes are still shown — nothing is hidden — and shown as what they are.
    expect(text).toContain('<U+000A>');
    expect(text).toContain('INVENTED');
    expect(text.split('\n').some((l) => l.trim() === 'Task         : INVENTED')).toBe(false);
  });

  it('cannot reorder a line with a bidirectional override', () => {
    const home = scratchHome();
    const name = eventName('20260827T173000000Z', '4');
    // A right-to-left override does to a line what a newline does to an entry:
    // it changes what a terminal shows without changing a byte, so a ref or a
    // checkout path can be made to read as something else entirely. Same class
    // as the control characters, same treatment.
    forge(home, name, { taskId: 'T-1‮gnihtemos-esle‬' });

    const text = renderPublicationAuthorisations(list(home));

    expect(text).toContain('<U+202E>');
    expect(text).toContain('<U+202C>');
    expect(text).not.toContain('‮');
    expect(text).not.toContain('‬');
  });

  it('shows a recorded instant that is not a date, exactly as recorded', () => {
    const home = scratchHome();
    const name = eventName('20260827T172000000Z', 'f');
    // Measured: the contract bounds `authorisedAt` as a string of at most 64
    // characters and checks no calendar, so this grades as a record this build
    // read. Nothing here parses it, and nothing orders by it.
    forge(home, name, { authorisedAt: 'yesterday-ish' });

    const result = list(home);
    const text = renderPublicationAuthorisations(result);

    expect(result.entries[0]?.reading).toBe('HISTORICAL_AUTHORISATION');
    expect(text).toContain('Authorised at: yesterday-ish');
    // ...and the report says which of the two instants it sorted by, because the
    // sort key and the printed value are different values that can disagree.
    expect(text.replace(/\s+/g, ' ')).toContain('by the name of each entry');
    expect(text.replace(/\s+/g, ' ')).toContain('checked against nothing');
  });

  it('does not let a claimed instant move an entry in the list', () => {
    const home = scratchHome();
    const first = eventName('20260101T000000000Z', '1');
    const second = eventName('20270101T000000000Z', '2');
    // The later directory carries the earlier claimed instant. Order follows the
    // name, which is the only key that is not inside the bytes.
    forge(home, first, { authorisedAt: '2099-01-01T00:00:00.000Z' });
    forge(home, second, { authorisedAt: '1999-01-01T00:00:00.000Z' });

    expect(list(home).entries.map((e) => e.name)).toEqual([first, second]);
  });
});

/* ── the report survives a reader that walks away ─────────────────────────── */

describe('the report survives a reader that walks away', () => {
  it('treats a closed reader as an ending and not as a defect in this build', async () => {
    const home = scratchHome();
    record(home);

    const before = process.stdout.listeners('error').slice();
    const program = new Command();
    program.exitOverride();
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerPublicationCommand(program, { pathProvider: fixedPathProvider(home) });
      await program.parseAsync(['node', 'ao', 'publication', 'authorisations']);
    } finally {
      process.stdout.write = write;
    }

    const added = process.stdout.listeners('error').filter((l) => !before.includes(l));
    try {
      // This is the first command here whose output is unbounded, so it is the
      // first with an operator who has a reason to pipe it into `head` and close
      // the reader. Measured in a real process: past roughly ninety records the
      // report exceeds the pipe buffer, and without this listener the stream's
      // `error` event is an uncaught exception - 1,355 bytes of raw Node stack
      // outside the safe formatter, and exit 1 for a normal ending.
      expect(added.length, 'the write must be guarded').toBe(1);
      const guard = added[0] as (error: NodeJS.ErrnoException) => void;

      const closed: NodeJS.ErrnoException = new Error('write EPIPE');
      closed.code = 'EPIPE';
      expect(() => guard(closed)).not.toThrow();

      // ...and it is a guard on one condition, not a blanket swallow: anything
      // else is still a defect and still reaches the caller's own handler.
      const other: NodeJS.ErrnoException = new Error('write EACCES');
      other.code = 'EACCES';
      expect(() => guard(other)).toThrow();
    } finally {
      for (const listener of added) {
        process.stdout.removeListener('error', listener as never);
      }
    }
  });
});

/* ── the exit contract ────────────────────────────────────────────────────── */

describe('the exit contract', () => {
  it('grades every outcome, and grades the two absences apart', () => {
    // Written out by hand rather than derived: a table that mapped the
    // production object twice would pass for any grading at all.
    const expected: Readonly<Record<HeadPublicationAuditListingOutcome, number>> = {
      // A listing was produced.
      READ: EXIT_RUN_OK,
      READ_WITH_UNUSABLE_ENTRIES: EXIT_RUN_OK,
      STORE_ABSENT: EXIT_RUN_OK,
      // No listing could be produced, and the same store is the one the next
      // authorised publication would have to write into.
      STORE_PATH_UNSAFE: EXIT_RUN_NEEDS_OPERATOR,
      STORE_UNREADABLE: EXIT_RUN_NEEDS_OPERATOR,
      PROFILE_UNAVAILABLE: EXIT_RUN_NEEDS_OPERATOR,
    };
    expect(Object.keys(AUDIT_LISTING_EXIT).slice().sort()).toEqual(
      [...HEAD_PUBLICATION_AUDIT_LISTINGS].sort(),
    );
    for (const outcome of HEAD_PUBLICATION_AUDIT_LISTINGS) {
      expect(AUDIT_LISTING_EXIT[outcome], outcome).toBe(expected[outcome]);
    }
  });

  it('exits zero on any listing it produced, and three on a store it could not read', async () => {
    const clean = scratchHome();
    record(clean);
    const damaged = scratchHome();
    const eventId = record(damaged);
    edit(damaged, eventId, { taskId: 'SOMEBODY-ELSE' });
    const absent = scratchHome();
    const unreadable = scratchHome();
    writeFileSync(auditRoot(unreadable), 'not a store', 'utf8');

    expect(await run(clean)).toBe(EXIT_RUN_OK);
    // Nothing prunes this store, so a damaged directory is permanent. A grade
    // that went non-zero for one would go non-zero for good, for a condition
    // that blocks nothing and that nothing inside this tool can clear.
    expect(await run(damaged)).toBe(EXIT_RUN_OK);
    expect(await run(absent)).toBe(EXIT_RUN_OK);
    expect(await run(unreadable)).toBe(EXIT_RUN_NEEDS_OPERATOR);
  });

  async function run(home: string): Promise<number | undefined> {
    const program = new Command();
    program.exitOverride();
    const written: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const before = process.exitCode;
    try {
      registerPublicationCommand(program, { pathProvider: fixedPathProvider(home) });
      await program.parseAsync(['node', 'ao', 'publication', 'authorisations']);
      const code = process.exitCode;
      expect(written.join('')).toContain('Listing');
      return typeof code === 'number' ? code : undefined;
    } finally {
      process.stdout.write = write;
      process.exitCode = before;
    }
  }
});

/* ── the surface an operator meets ────────────────────────────────────────── */

describe('the surface an operator meets', () => {
  it('is registered by the program, under the names the text uses', () => {
    const program = buildProgram();
    const names = program.commands.map((c) => c.name()).sort();

    expect(names).toContain('publication');
    const publication = program.commands.find((c) => c.name() === 'publication');
    expect(publication?.commands.map((c) => c.name())).toEqual(['authorisations']);
    // Every `agent-loop publication <x>` this build prints must be a subcommand
    // it registers, so a renamed command cannot leave an advertisement behind.
    const advertised = new Set<string>();
    for (const file of walkSource('src')) {
      for (const match of codeOnly(file).matchAll(/agent-loop publication ([a-z][a-z-]*)/g)) {
        advertised.add(match[1] as string);
      }
    }
    for (const name of advertised) {
      expect(publication?.commands.map((c) => c.name())).toContain(name);
    }
  });

  it('is named on the front page while it is registered, and only while', () => {
    const program = buildProgram();
    const description = program.description().replace(/\s+/g, ' ');
    const registered = program.commands.some((c) => c.name() === 'publication');

    // Bound in both directions rather than to a remembered list: while the
    // command is registered the front page must name it, and if it is ever
    // withdrawn this fails until the sentence goes with it. This repository has
    // spent whole review rounds on help text that outlived what it described.
    expect(registered).toBe(true);
    expect(description).toContain('`publication authorisations`');
    expect(description).toContain('evidence for a person and never');
  });

  it('says in its own description that it takes no repository and contacts nothing', () => {
    expect(AUTHORISATIONS_DESCRIPTION).toContain('Takes no repository');
    expect(AUTHORISATIONS_DESCRIPTION).toContain('never an input to an authority');
    expect(AUTHORISATIONS_DESCRIPTION).toContain('delete one without trace');
    expect(PUBLICATION_GROUP_DESCRIPTION).toContain('Read-only');
  });

  it('has a store vocabulary disjoint from the record vocabulary it wraps', () => {
    // The two are different kinds of answer — one about a document, one about an
    // entry — and a member appearing in both would make it impossible to say
    // which was meant.
    for (const member of HEAD_PUBLICATION_AUTHORISATION_READINGS) {
      if (member === 'HISTORICAL_AUTHORISATION') continue;
      expect(HEAD_PUBLICATION_AUDIT_ENTRY_READINGS as readonly string[]).not.toContain(member);
    }
  });
});

/* ── the mode bits are not a defence, and nothing here pretends ───────────── */

describe('the store is what it is', () => {
  it('does not chmod, chown or otherwise fix anything it finds', () => {
    const home = scratchHome();
    const eventId = record(home);
    try {
      chmodSync(recordPath(home, eventId), 0o400);
    } catch {
      // Modes are not a defence on NTFS and this is not measuring them.
    }
    const before = treeDigest(home);

    list(home);

    expect(treeDigest(home)).toBe(before);
    for (const file of SLICE_15_SOURCE) {
      expect(codeOnly(file)).not.toContain('chmod');
    }
  });
});
