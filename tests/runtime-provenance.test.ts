/**
 * AO-RUNTIME-ISOLATION-001: the provenance reader, case by case.
 *
 * `tests/dist-artifact/runtime-deployment-dist-artifact.mjs` measures the two
 * refusals that a real deployed runtime can actually reach — an absent record,
 * and a record about a different root — by spawning a compiled CLI and reading
 * its exit code. That is the decisive measurement, and it is deliberately not
 * duplicated here.
 *
 * What is here is the set of *malformed* records that harness cannot
 * conveniently produce one at a time: a record that is not JSON, that is not an
 * object, that is a schema version this build cannot read, that names a channel
 * this build does not know, or that is missing a field the refusal message
 * depends on. Each is a way for a record to exist without establishing
 * anything, and each has to be a refusal rather than a shrug — a reader that
 * accepted any of them would hand the gate above it a runtime it could not
 * describe.
 *
 * Every case writes a real file into a real directory. The reader takes a root
 * and reads what is there; there is no seam to substitute, which is the point:
 * a gate with an injectable answer is a gate that can be told not to refuse.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  RUNTIME_PROVENANCE_FILENAME,
  RUNTIME_PROVENANCE_SCHEMA_VERSION,
  readRuntimeProvenance,
  renderProvenanceRefusal,
} from '../src/cli/runtime-provenance.js';

const created: string[] = [];

afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** A directory holding exactly the record given, or none at all. */
function runtimeWith(record: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'ao-provenance-'));
  created.push(root);
  mkdirSync(root, { recursive: true });
  if (record !== null) {
    writeFileSync(join(root, RUNTIME_PROVENANCE_FILENAME), record, 'utf8');
  }
  return root;
}

/** A record that is valid apart from the fields overridden. */
function record(root: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: RUNTIME_PROVENANCE_SCHEMA_VERSION,
    channel: 'DEPLOYED',
    runtimeRoot: root,
    commit: '2036198533837e34934abc954eabf161345dbeba',
    authorization: 'CANONICAL',
    ...overrides,
  });
}

describe('readRuntimeProvenance', () => {
  it('establishes provenance from a well-formed record about its own root', () => {
    const root = runtimeWith(null);
    writeFileSync(join(root, RUNTIME_PROVENANCE_FILENAME), record(root), 'utf8');

    const reading = readRuntimeProvenance(root);

    expect(reading.established).toBe(true);
    if (!reading.established) return;
    expect(reading.provenance.commit).toBe('2036198533837e34934abc954eabf161345dbeba');
    expect(reading.provenance.channel).toBe('DEPLOYED');
  });

  it('accepts a build output, which is a different channel and not an error', () => {
    const root = runtimeWith(null);
    writeFileSync(
      join(root, RUNTIME_PROVENANCE_FILENAME),
      record(root, { channel: 'BUILD', authorization: 'BUILD' }),
      'utf8',
    );

    const reading = readRuntimeProvenance(root);

    expect(reading.established).toBe(true);
    if (!reading.established) return;
    expect(reading.provenance.channel).toBe('BUILD');
  });

  it('refuses a runtime with no record at all', () => {
    const reading = readRuntimeProvenance(runtimeWith(null));

    expect(reading.established).toBe(false);
    if (reading.established) return;
    expect(reading.refusal.code).toBe('PROVENANCE_ABSENT');
  });

  it('refuses a record that is not JSON', () => {
    const reading = readRuntimeProvenance(runtimeWith('{ this is not json'));

    expect(reading.established).toBe(false);
    if (reading.established) return;
    expect(reading.refusal.code).toBe('PROVENANCE_UNREADABLE');
  });

  it('refuses a record that is JSON but not an object', () => {
    const reading = readRuntimeProvenance(runtimeWith('"deployed, honest"'));

    expect(reading.established).toBe(false);
    if (reading.established) return;
    expect(reading.refusal.code).toBe('PROVENANCE_UNREADABLE');
  });

  it('refuses a schema version this build cannot read', () => {
    const root = runtimeWith(null);
    writeFileSync(
      join(root, RUNTIME_PROVENANCE_FILENAME),
      record(root, { schemaVersion: RUNTIME_PROVENANCE_SCHEMA_VERSION + 1 }),
      'utf8',
    );

    const reading = readRuntimeProvenance(root);

    expect(reading.established).toBe(false);
    if (reading.established) return;
    expect(reading.refusal.code).toBe('PROVENANCE_UNREADABLE');
  });

  it('refuses a channel this build does not know', () => {
    const root = runtimeWith(null);
    writeFileSync(
      join(root, RUNTIME_PROVENANCE_FILENAME),
      record(root, { channel: 'STAGING' }),
      'utf8',
    );

    const reading = readRuntimeProvenance(root);

    expect(reading.established).toBe(false);
    if (reading.established) return;
    expect(reading.refusal.code).toBe('PROVENANCE_UNREADABLE');
  });

  it.each(['runtimeRoot', 'commit', 'authorization'])(
    'refuses a record with no %s',
    (field) => {
      const root = runtimeWith(null);
      writeFileSync(
        join(root, RUNTIME_PROVENANCE_FILENAME),
        record(root, { [field]: undefined }),
        'utf8',
      );

      const reading = readRuntimeProvenance(root);

      expect(reading.established).toBe(false);
      if (reading.established) return;
      expect(reading.refusal.code).toBe('PROVENANCE_UNREADABLE');
    },
  );

  it('refuses a record about a different root', () => {
    const root = runtimeWith(null);
    const elsewhere = runtimeWith(null);
    writeFileSync(
      join(root, RUNTIME_PROVENANCE_FILENAME),
      record(root, { runtimeRoot: elsewhere }),
      'utf8',
    );

    const reading = readRuntimeProvenance(root);

    expect(reading.established).toBe(false);
    if (reading.established) return;
    expect(reading.refusal.code).toBe('PROVENANCE_ROOT_MISMATCH');
  });

  it('reads a record whose root is the same directory spelled differently', () => {
    // The record is written before the tree is at its final name, so the two
    // spellings are never guaranteed to be textually equal. A trailing
    // separator and a `.` segment are the cheap cases; the expensive ones — an
    // 8.3 alias, a differently cased volume — are what `realpathSync.native`
    // and the Windows case fold are for, and this pins that the comparison is
    // not a string equality.
    const root = runtimeWith(null);
    writeFileSync(
      join(root, RUNTIME_PROVENANCE_FILENAME),
      record(root, { runtimeRoot: join(root, '.', '') }),
      'utf8',
    );

    expect(readRuntimeProvenance(root).established).toBe(true);
  });
});

describe('renderProvenanceRefusal', () => {
  it('names the refusal, the runtime and the one command that produces one', () => {
    const text = renderProvenanceRefusal(
      { code: 'PROVENANCE_ABSENT', detail: 'There is no record.' },
      'D:\\AgentOrchestrator\\dist',
    );

    expect(text).toContain('PROVENANCE_ABSENT');
    expect(text).toContain('D:\\AgentOrchestrator\\dist');
    expect(text).toContain('There is no record.');
    expect(text).toContain('npm run deploy');
    // The operator must not be sent to repair the record by hand: a
    // hand-written record is exactly the thing the gate exists to refuse.
    expect(text).toContain('rather than repairing the record by hand');
  });
});
