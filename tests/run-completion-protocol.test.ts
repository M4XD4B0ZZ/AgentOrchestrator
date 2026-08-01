/**
 * AO-FOUNDATION-REM-002C2-REREVIEW-01 / -02: the fixed doctor-run artefact
 * contract must stay unmutable at JavaScript runtime, not merely at the
 * TypeScript type level, and the exact-structure check must independently
 * catch a missing artefact rather than relying on a later per-artefact check
 * to notice.
 *
 * This test imports `src/doctor/run-completion.ts` directly (via vitest's
 * TypeScript module resolution) and exercises its real exports against the
 * real filesystem — no mock of `node:fs` is installed. That makes it a check
 * of source/module semantics, not of the compiled build: it says nothing
 * about what `tsc` actually emits into `dist/`.
 *
 * The separate check against the literal built artefact —
 * `dist/doctor/run-completion.js`, imported by an explicit `file://` URL in
 * a standalone Node process, never through src or through vitest's module
 * resolution — lives in `tests/run-completion-dist.test.ts` and
 * `tests/dist-artifact/run-completion-dist-artifact.mjs`
 * (AO-FOUNDATION-REM-002C4 / AO-FOUNDATION-REM-002C3-REREVIEW-01).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import * as runCompletion from '../src/doctor/run-completion.js';
import {
  completeRun,
  COMPLETION_MARKER_FILE_NAME,
  inspectRun,
  requiredArtefactFileNames,
} from '../src/doctor/run-completion.js';
import { createRunDirectory, newRunId } from '../src/doctor/run-directory.js';
import { writeRunArtifact } from '../src/doctor/safe-write.js';

const tempDirs: string[] = [];

function makeRunsRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-loop-protocol-'));
  tempDirs.push(dir);
  return join(dir, 'diagnostics', 'doctor', 'runs');
}

function freshRun(runsRoot: string): string {
  const created = createRunDirectory({ runsRoot, runId: newRunId() });
  expect(created.created).toBe(true);
  return created.path;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('no mutable protocol array is exported', () => {
  it('has no REQUIRED_ARTEFACT_NAMES (or similarly named) export at all', () => {
    const exported = Object.keys(runCompletion);
    for (const name of exported) {
      // Whatever is exported must not be a plain, unfrozen array: every
      // export that is itself an array must already be frozen.
      const value = (runCompletion as Record<string, unknown>)[name];
      if (Array.isArray(value)) {
        expect(Object.isFrozen(value)).toBe(true);
      }
    }
    // The specific historical export name this finding removed.
    expect('REQUIRED_ARTEFACT_NAMES' in runCompletion).toBe(false);
  });
});

describe('requiredArtefactFileNames() is safe to hand to untrusted callers', () => {
  it('returns a frozen array', () => {
    const names = requiredArtefactFileNames();
    expect(Object.isFrozen(names)).toBe(true);
  });

  it('returns the two canonical names, in order', () => {
    expect(requiredArtefactFileNames()).toEqual(['cli-capabilities.txt', 'doctor-report.json']);
  });

  it('returns a fresh array reference on every call', () => {
    const first = requiredArtefactFileNames();
    const second = requiredArtefactFileNames();
    expect(first).not.toBe(second);
  });

  it.each<[string, (arr: unknown) => void]>([
    ['push', (arr) => (arr as unknown[]).push('evil.txt')],
    ['splice', (arr) => (arr as unknown[]).splice(0, 1, 'evil.txt')],
    ['pop', (arr) => (arr as unknown[]).pop()],
    ['index assignment', (arr) => ((arr as unknown[])[0] = 'evil.txt')],
    ['length truncation', (arr) => ((arr as unknown[]).length = 1)],
    ['reverse (reorder)', (arr) => (arr as unknown[]).reverse()],
    ['sort (reorder)', (arr) => (arr as unknown[]).sort()],
  ])('a %s mutation attempt on the returned value never succeeds silently', (_label, mutate) => {
    const names = requiredArtefactFileNames();
    const before = [...names];

    // In strict-mode ESM (which this project is), mutating a frozen array
    // throws a TypeError rather than silently failing.
    expect(() => mutate(names)).toThrow(TypeError);

    // Whether or not the attempt threw, the array itself must be unchanged,
    // and a fresh call must still return the canonical pair.
    expect(names).toEqual(before);
    expect(requiredArtefactFileNames()).toEqual(['cli-capabilities.txt', 'doctor-report.json']);
  });

  it('surviving a full replacement of the returned copy never affects the internal contract', () => {
    let names: readonly string[] = requiredArtefactFileNames();
    names = ['evil.txt'];
    // Reassigning the local binding cannot reach back into the module.
    expect(requiredArtefactFileNames()).toEqual(['cli-capabilities.txt', 'doctor-report.json']);
    void names;
  });
});

describe('a run holding only one artefact is never treated as complete, even under attempted mutation', () => {
  it('completeRun never reports COMPLETED or completed:true for a one-artefact run', () => {
    // Attempt the exact attack this finding closes: grab the exported
    // accessor's result and try to mutate it before the run completes.
    const names = requiredArtefactFileNames();
    try {
      (names as unknown as string[]).push('evil.txt');
    } catch {
      // Expected to throw under strict mode; either way, proceed.
    }

    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeRunArtifact({ runDirectory, fileName: 'cli-capabilities.txt', contents: 'a\n' });

    const result = completeRun(runsRoot, runDirectory.split(/[\\/]/).pop() as string);
    expect(result.code).not.toBe('COMPLETED');
    expect(result.completed).toBe(false);
  });

  it('inspectRun never reports COMPLETE or consumable:true for a one-artefact run', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeRunArtifact({ runDirectory, fileName: 'cli-capabilities.txt', contents: 'a\n' });

    const runId = runDirectory.split(/[\\/]/).pop() as string;
    const inspection = inspectRun(runsRoot, runId);
    expect(inspection.code).not.toBe('COMPLETE');
    expect(inspection.consumable).toBe(false);
    // The independent structure check itself is what catches this — the
    // missing artefact, not merely an unexpected one.
    expect(inspection.code).toBe('REQUIRED_ARTIFACT_MISSING');
  });

  it('a fully valid, two-artefact, marked run still completes and is consumable', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeRunArtifact({ runDirectory, fileName: 'cli-capabilities.txt', contents: 'a\n' });
    writeRunArtifact({ runDirectory, fileName: 'doctor-report.json', contents: 'b\n' });

    const runId = runDirectory.split(/[\\/]/).pop() as string;
    const result = completeRun(runsRoot, runId);
    expect(result.code).toBe('COMPLETED');
    expect(result.completed).toBe(true);

    const inspection = inspectRun(runsRoot, runId);
    expect(inspection.code).toBe('COMPLETE');
    expect(inspection.consumable).toBe(true);
  });
});

describe('checkPreCompletionEntries / checkCompletedEntries independence (AO-FOUNDATION-REM-002C2-REREVIEW-02)', () => {
  it('rejects a pre-completion directory missing one artefact via the structure check itself', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeRunArtifact({ runDirectory, fileName: 'doctor-report.json', contents: 'b\n' });

    const runId = runDirectory.split(/[\\/]/).pop() as string;
    const result = completeRun(runsRoot, runId);
    expect(result.code).toBe('REQUIRED_ARTIFACT_MISSING');
    expect(result.completed).toBe(false);
  });

  it('rejects a completed-shape directory missing the marker, reported by structure, not by chance', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeRunArtifact({ runDirectory, fileName: 'cli-capabilities.txt', contents: 'a\n' });
    writeRunArtifact({ runDirectory, fileName: 'doctor-report.json', contents: 'b\n' });
    // No marker written: two of the three completed-stage entries only.

    const runId = runDirectory.split(/[\\/]/).pop() as string;
    const inspection = inspectRun(runsRoot, runId);
    expect(inspection.code).toBe('COMPLETION_MARKER_MISSING');
    expect(inspection.consumable).toBe(false);
  });

  it('rejects a completed-shape directory missing both an artefact and the marker', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeRunArtifact({ runDirectory, fileName: 'cli-capabilities.txt', contents: 'a\n' });
    // Missing doctor-report.json and the marker: one of three entries only.

    const runId = runDirectory.split(/[\\/]/).pop() as string;
    const inspection = inspectRun(runsRoot, runId);
    expect(inspection.code).toBe('REQUIRED_ARTIFACT_MISSING');
    expect(inspection.consumable).toBe(false);
  });

  it('still rejects an empty run directory (zero of the expected entries present)', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    const runId = runDirectory.split(/[\\/]/).pop() as string;

    expect(completeRun(runsRoot, runId).code).toBe('REQUIRED_ARTIFACT_MISSING');
    expect(inspectRun(runsRoot, runId).code).toBe('REQUIRED_ARTIFACT_MISSING');
  });

  it('still rejects extra, unexpected entries independently of missing ones', () => {
    const runsRoot = makeRunsRoot();
    const runDirectory = freshRun(runsRoot);
    writeRunArtifact({ runDirectory, fileName: 'cli-capabilities.txt', contents: 'a\n' });
    writeRunArtifact({ runDirectory, fileName: 'doctor-report.json', contents: 'b\n' });
    writeFileSync(join(runDirectory, 'unexpected.txt'), 'x\n', 'utf8');

    const runId = runDirectory.split(/[\\/]/).pop() as string;
    expect(completeRun(runsRoot, runId).code).toBe('RUN_STRUCTURE_INVALID');
  });
});

describe('the marker file name and protocol version stay ordinary, immutable string exports', () => {
  it('COMPLETION_MARKER_FILE_NAME is the fixed value', () => {
    expect(COMPLETION_MARKER_FILE_NAME).toBe('COMPLETED');
  });
});
