/**
 * The durable half of the capability-command fix: one record per ambiguous
 * ending, written where a person can still read it next week.
 *
 * ── Why a store had to exist at all ────────────────────────────────────────
 *
 * A required-but-unproven capability refuses the run *before* `startTask`, so
 * on that path there is no task state, no worktree and no branch. The refusal
 * reached an operator's console and nowhere else. That is how the same failure
 * could happen twice — 2026-09-09 and 2026-09-10, both clearing on a retry with
 * no configuration change — and still not be explainable the second time.
 *
 * ── What these cases hold ──────────────────────────────────────────────────
 *
 * Three properties, and each one is a thing the record could plausibly have got
 * wrong: it grades **before** it creates anything, so a refused record leaves
 * nothing behind; it never folds two occurrences into one, because the whole
 * incident was that there were two; and it can never change a verdict, so a
 * store that failed is visible as itself rather than as a different answer.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_COMMAND_FAILURE_FILE_NAME,
  CAPABILITY_COMMAND_SITES,
  MAX_CAPABILITY_COMMAND_FAILURE_BYTES,
  capabilityCommandFailuresRoot,
  observeCapabilityCommand,
  type CapabilityCommandBudget,
} from '../src/agent/capability-command-failure.js';
import {
  CAPABILITY_COMMAND_RECORD_CODES,
  recordCapabilityCommandFailure,
} from '../src/agent/capability-command-failure-store.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import type { CommandResult } from '../src/doctor/exec.js';
import { RUN_ID_PATTERN } from '../src/doctor/run-directory.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';

const BUDGET: CapabilityCommandBudget = Object.freeze({
  timeoutMs: 20_000,
  maxStdoutBytes: 1_048_576,
  maxStderrBytes: 1_048_576,
  terminateOnOutputLimit: true,
});

function home(): { readonly provider: ReturnType<typeof fixedPathProvider>; readonly root: string } {
  const dir = makeCanonicalTempDir('ao-ccf-');
  const provider = fixedPathProvider(dir);
  mkdirSync(join(dir, '.agent-orchestrator'), { recursive: true });
  return { provider, root: capabilityCommandFailuresRoot(provider) };
}

/**
 * The ending as it was actually measured on 2026-09-10.
 *
 * Complete, field by field. A spread of some other fixture would leave numeric
 * fields `undefined`, `JSON.stringify` would drop the keys, and a record
 * missing a field would be indistinguishable from one whose field was never
 * measured — which is the exact ambiguity this store exists to remove.
 */
function observedResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    display: 'claude',
    executable: 'claude',
    args: [],
    started: true,
    outcome: 'TIMED_OUT',
    exitCode: null,
    signal: null,
    stdout: 'SENTINEL-STDOUT-a41c',
    stderr: 'SENTINEL-STDERR-b52d',
    startedAt: '2026-09-10T07:53:36.000Z',
    finishedAt: '2026-09-10T07:53:40.000Z',
    durationMs: 3651,
    failureCode: 'TIMEOUT',
    errnoCode: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutBytesObserved: 5189,
    stderrBytesObserved: 0,
    stdinDelivery: 'DELIVERED',
    processTreeKilled: false,
    ...overrides,
  } as unknown as CommandResult;
}

function record(provider: ReturnType<typeof fixedPathProvider>, at: string, result = observedResult()) {
  return recordCapabilityCommandFailure({
    site: 'MCP_CAPABILITY_PROBE',
    reason: 'PROBE_DID_NOT_COMPLETE',
    capability: 'codegraph',
    observation: observeCapabilityCommand(result, BUDGET),
    now: new Date(at),
    provider,
  });
}

describe('a capability-command failure is written down where it can be read later', () => {
  it('records the ending as measured, rather than the code that used to stand in for it', () => {
    const { provider } = home();
    const written = record(provider, '2026-09-10T07:53:40.000Z');

    expect(written).toMatchObject({ recorded: true, code: 'RECORDED' });
    expect(RUN_ID_PATTERN.test(written.eventId as string)).toBe(true);

    const stored = JSON.parse(readFileSync(written.path as string, 'utf8'));
    // The regression test for the defect as observed. Before the split this
    // ending was reported as PROBE_DID_NOT_START and nothing was written at all.
    expect(stored.observation.outcome).toBe('TIMED_OUT');
    expect(stored.observation.failureCode).toBe('TIMEOUT');
    expect(stored.observation.started).toBe(true);
    expect(stored.reason).toBe('PROBE_DID_NOT_COMPLETE');
    expect(stored.site).toBe('MCP_CAPABILITY_PROBE');
  });

  it('keeps the budget beside the measurement, so neither is a bare number', () => {
    const { provider } = home();
    const written = record(provider, '2026-09-10T07:53:40.000Z');
    const stored = JSON.parse(readFileSync(written.path as string, 'utf8'));

    // `3651 ms of 20000 ms` answers the question. `3651 ms` asks a reader to
    // find a constant and to trust it has not moved — and the two hypotheses an
    // operator refuted by hand were exactly a duration and a byte count, each
    // against its budget.
    expect(stored.observation.durationMs).toBe(3651);
    expect(stored.observation.budget.timeoutMs).toBe(20_000);
    expect(stored.observation.stdoutBytesObserved).toBe(5189);
    expect(stored.observation.budget.maxStdoutBytes).toBe(1_048_576);
  });

  it('carries no byte of what the command said, and no containment artefact', () => {
    const { provider } = home();
    const written = record(provider, '2026-09-10T07:53:40.000Z');
    const text = readFileSync(written.path as string, 'utf8');

    // Read as TEXT. A shape assertion alone would pass a record that stringified
    // a stream into some other field.
    expect(text).not.toContain('SENTINEL-STDOUT-a41c');
    expect(text).not.toContain('SENTINEL-STDERR-b52d');
    const stored = JSON.parse(text);
    expect(Object.keys(stored.observation)).not.toContain('stdout');
    expect(Object.keys(stored.observation)).not.toContain('stderr');
    expect(Object.keys(stored.observation)).not.toContain('containment');
  });

  it('writes one directory per occurrence and never reuses a name', () => {
    const { provider, root } = home();
    const first = record(provider, '2026-09-09T21:00:00.000Z');
    const second = record(provider, '2026-09-10T07:53:40.000Z');

    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(true);
    expect(first.eventId).not.toBe(second.eventId);
    expect(readdirSync(root)).toHaveLength(2);
    // The incident was that it happened twice. A store that folded by identity
    // would have kept one of them and hidden the fact that mattered.
    expect(readFileSync(first.path as string, 'utf8')).toContain('2026-09-09');
    expect(readFileSync(second.path as string, 'utf8')).toContain('2026-09-10');
  });

  it('never measures what it did not measure', () => {
    const { provider } = home();
    // A result missing every numeric field — the shape a hand-built stub has.
    const partial = { started: true, outcome: 'SPAWN_FAILED' } as unknown as CommandResult;
    const written = record(provider, '2026-09-10T08:00:00.000Z', partial);
    const stored = JSON.parse(readFileSync(written.path as string, 'utf8'));

    // Explicit nulls, not absent keys. `JSON.stringify` drops `undefined`, and
    // a record missing a key looks exactly like one that never had it.
    expect(stored.observation.durationMs).toBeNull();
    expect(stored.observation.stdoutBytesObserved).toBeNull();
    expect(Object.keys(stored.observation)).toContain('durationMs');
  });

  it('grades before it creates, so a refused record leaves nothing behind', () => {
    const { provider, root } = home();
    const huge = 'x'.repeat(MAX_CAPABILITY_COMMAND_FAILURE_BYTES + 1);
    const written = recordCapabilityCommandFailure({
      site: 'MCP_CAPABILITY_PROBE',
      reason: huge,
      capability: 'codegraph',
      observation: observeCapabilityCommand(observedResult(), BUDGET),
      now: new Date('2026-09-10T08:00:00.000Z'),
      provider,
    });

    expect(written).toMatchObject({ recorded: false, code: 'RECORD_TOO_LARGE', path: null });
    // The only way to see the ordering: a grade that ran after the effect would
    // be a cleanup problem rather than a gate.
    expect(existsSync(root)).toBe(false);
  });

  it('reports a refused directory as itself, and writes nothing', () => {
    const dir = makeCanonicalTempDir('ao-ccf-blocked-');
    const provider = fixedPathProvider(dir);
    mkdirSync(join(dir, '.agent-orchestrator'), { recursive: true });
    // A plain file where the root belongs: nothing can be created under it.
    writeFileSync(capabilityCommandFailuresRoot(provider), 'not a directory', 'utf8');

    const written = record(provider, '2026-09-10T08:00:00.000Z');
    expect(written.recorded).toBe(false);
    expect(written.code).toBe('DIRECTORY_REFUSED');
    expect(written.detailCode).not.toBeNull();
    expect(written.path).toBeNull();
  });

  it('reports a write it cannot prove, rather than claiming one', () => {
    const { provider } = home();
    const written = recordCapabilityCommandFailure({
      site: 'MCP_CAPABILITY_PROBE',
      reason: 'PROBE_DID_NOT_COMPLETE',
      capability: 'codegraph',
      observation: observeCapabilityCommand(observedResult(), BUDGET),
      now: new Date('2026-09-10T08:00:00.000Z'),
      provider,
      // A read-back that returns different bytes. The one failure a caller
      // cannot see from a successful write result.
      readBack: () => 'something else entirely',
    });
    expect(written).toMatchObject({ recorded: false, code: 'READBACK_MISMATCH' });
  });

  it('lives under the orchestrator home, and inside no repository and no doctor run', () => {
    const { provider, root } = home();
    record(provider, '2026-09-10T08:00:00.000Z');

    expect(root.endsWith(join('.agent-orchestrator', 'capability-command-failures'))).toBe(true);
    // Not inside diagnostics/: a doctor run directory's artefact names are
    // frozen and an extra entry there would quietly make that run
    // non-consumable.
    expect(root).not.toContain(`${join('.agent-orchestrator', 'diagnostics')}`);
    const [event] = readdirSync(root);
    expect(readdirSync(join(root, event as string))).toEqual([
      CAPABILITY_COMMAND_FAILURE_FILE_NAME,
    ]);
  });

  it('names its endings and its sites in closed sets', () => {
    expect(new Set(CAPABILITY_COMMAND_RECORD_CODES).size).toBe(
      CAPABILITY_COMMAND_RECORD_CODES.length,
    );
    expect([...CAPABILITY_COMMAND_RECORD_CODES]).toEqual([
      'RECORDED',
      'RECORD_TOO_LARGE',
      'PROFILE_UNAVAILABLE',
      'DIRECTORY_REFUSED',
      'ARTEFACT_REFUSED',
      'READBACK_MISMATCH',
    ]);
    expect([...CAPABILITY_COMMAND_SITES]).toEqual(['MCP_CAPABILITY_PROBE', 'CODEGRAPH_PREPARE']);
  });
});
