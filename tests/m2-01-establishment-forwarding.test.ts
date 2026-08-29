/**
 * The two forwards that make M2 slice 1 work in production, and nothing else.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The establishment mark travels four layers: the boundary mints it,
 * `doctor/exec.ts` forwards the callback into the boundary, `agent/agent-command.ts`
 * forwards it into `doctor/exec.ts`, and `loop/leased-spawns.ts` supplies it and
 * writes the ledger. Three of those four are measured elsewhere — the mint and
 * the boundary end by `tests/dist-artifact/crash-recovery-dist-artifact.mjs`, the
 * ledger write by the seam case in `tests/v3-05-stale-lease-recovery.test.ts`.
 *
 * The two forwards in the middle were measured by nothing. A mutation campaign
 * confirmed it rather than suspected it: deleting the spread in
 * `runAgentCommand` that hands the hook to `runCommand` left the entire suite
 * green, and so did deleting the one in `runCommand` that hands it to the
 * boundary. Between them they are the whole feature in production — with either
 * gone, every real writer launch stays `PENDING` and U1 is exactly as it was.
 *
 * Both are pinned here by *observation of the argument*, not by shape. Each case
 * substitutes the layer below and asserts the callback it received is the one
 * that was passed in, and that calling it reaches the caller's own function.
 *
 * `vi.mock` is confined to this file on purpose: it is file-scoped, and
 * `tests/report-safety.test.ts` and `tests/probe-env-policy.test.ts` establish
 * the pattern for substituting this exact module.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ContainmentAttestation } from '../src/core/containment-attestation.js';
import type { RunOptions } from '../src/doctor/exec.js';

/** What the substituted `runCommand` was handed, for the agent-side case. */
const seenByRunCommand: RunOptions[] = [];

vi.mock('../src/doctor/exec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/doctor/exec.js')>();
  return {
    ...actual,
    runCommand: async (_command: string, _args: readonly string[], options: RunOptions) => {
      seenByRunCommand.push(options);
      return {
        display: 'substituted',
        executable: 'substituted',
        args: [],
        outcome: 'COMPLETED' as const,
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        failureCode: null,
        errnoCode: null,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdinDelivery: 'NOT_REQUESTED' as const,
        processTreeKilled: false,
        startedAt: '2026-08-30T00:00:00.000Z',
        finishedAt: '2026-08-30T00:00:00.000Z',
        durationMs: 0,
      };
    },
  };
});

const { runAgentCommand } = await import('../src/agent/agent-command.js');
const { runCommand } = await import('../src/doctor/exec.js');

describe('the establishment callback reaches the layer below it', () => {
  it('runAgentCommand hands its hook to runCommand, and withholds it when there is none', async () => {
    seenByRunCommand.length = 0;
    const mine = (_attestation: ContainmentAttestation): void => undefined;

    await runAgentCommand('claude', [], process.cwd(), '', { onLaunchEstablished: mine });
    expect(seenByRunCommand).toHaveLength(1);
    // Identity, not presence: a forward that passed *some* function would
    // satisfy a `typeof` check and deliver the mark to nobody.
    expect(seenByRunCommand[0]?.onLaunchEstablished).toBe(mine);

    // And the negative half, which is the reason the forward is conditional: a
    // caller that asks for nothing must not make the option appear.
    await runAgentCommand('claude', [], process.cwd(), '');
    expect(seenByRunCommand).toHaveLength(2);
    expect(seenByRunCommand[1]?.onLaunchEstablished).toBeUndefined();
    expect('onLaunchEstablished' in (seenByRunCommand[1] ?? {})).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'runCommand hands its hook to the owned boundary, and withholds it when there is none',
    async () => {
      // The real `runCommand` this time — the mock above replaced the module's
      // export, and the import below re-reads it, so this case drives the
      // substituted one. That is fine for what it measures: what it needs is the
      // `runOwned` seam the real module exposes, which the mock's spread keeps.
      const actual = await vi.importActual<typeof import('../src/doctor/exec.js')>(
        '../src/doctor/exec.js',
      );
      const seen: { onLaunchEstablished?: unknown }[] = [];
      const runOwned = async (options: { onLaunchEstablished?: unknown }): Promise<never> => {
        seen.push(options);
        // Refused rather than completed: this case is about the argument, and a
        // refusal is the cheapest ending that reaches no process at all.
        return {
          outcome: 'LAUNCH_REFUSED',
          failureCode: 'LAUNCH_REFUSED',
          boundaryFailureCode: 'BOUNDARY_HELPER_SPAWN_FAILED',
          boundaryLostReason: null,
          exitCode: null,
          established: false,
          targetStarted: 'NO',
          sideEffectsPossible: false,
          started: false,
          stdout: '',
          stderr: '',
          stdoutTruncated: false,
          stderrTruncated: false,
          stdinDelivery: 'NOT_REQUESTED',
          helperPid: null,
          childPid: null,
          retainedWorkDir: null,
          ending: null,
          termination: 'NONE',
        } as never;
      };

      const mine = (_attestation: ContainmentAttestation): void => undefined;
      await actual.runCommand(
        process.execPath,
        [],
        { cwd: process.cwd(), env: {}, onLaunchEstablished: mine },
        { runOwned },
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]?.onLaunchEstablished).toBe(mine);

      await actual.runCommand(process.execPath, [], { cwd: process.cwd(), env: {} }, { runOwned });
      expect(seen).toHaveLength(2);
      expect('onLaunchEstablished' in (seen[1] ?? {})).toBe(false);
    },
  );

  it('the module under test is really the substituted one', () => {
    // The control. `vi.mock` failing silently would make the first case above
    // start a real `claude` process, and its assertions would then be measuring
    // an empty array rather than a forward.
    expect(seenByRunCommand.length).toBeGreaterThan(0);
    expect(runCommand.name).not.toBe('');
  });
});
