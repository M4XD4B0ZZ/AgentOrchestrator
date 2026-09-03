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
 * Both are pinned here by *observation of the argument*, not by shape: each case
 * substitutes the layer below and asserts the callback it received is by
 * identity the one that was passed in. Neither case calls it - identity is the
 * stronger check and needs no call, and an earlier version of this paragraph
 * claimed a call that is not made.
 *
 * `vi.mock` is confined to this file on purpose: it is file-scoped, and
 * `tests/report-safety.test.ts` and `tests/probe-env-policy.test.ts` establish
 * the pattern for substituting this exact module.
 */

import { describe, expect, it, vi } from 'vitest';

import type { ContainmentAttestation } from '../src/core/containment-attestation.js';
import { mintContainmentAttestation } from '../src/core/internal/containment-attestation.js';
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
        stdoutBytesObserved: 0,
        stderrBytesObserved: 0,
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
    const second = seenByRunCommand[1];
    // Named and asserted present first: `seen[1] ?? {}` would let an absent
    // second call satisfy the `in` check below while measuring nothing.
    expect(second).toBeDefined();
    expect('onLaunchEstablished' in (second as object)).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'runCommand always hands the boundary a hook, and calls the caller through it',
    async () => {
      // ── What this case used to pin, and why it changed ──────────────────
      //
      // It required the forward to be **conditional**: the option present when a
      // caller supplied a hook and absent when none did. That was the contract
      // until M2 slice 2, and it had a consequence nobody had written down —
      // exactly one caller in the whole build ever supplied one, the writer, so
      // the kernel's confirmation of job membership for a verification command,
      // a reviewer pass or a Git subprocess reached this module and was dropped.
      //
      // The accounting that closes that gap is not a caller and cannot be one:
      // it has to see every launch. So the hook is now always passed, and the
      // caller's is called *through* it. The case below pins both halves,
      // because "always present" alone would be satisfied by a forward that had
      // stopped calling the caller at all.
      //
      // The conditional forward still exists one layer up, at
      // `agent-command.ts`, and the case above this one still pins it there.
      // `vi.importActual` bypasses the factory above entirely, so this really is
      // the unmocked `runCommand` — which is what this case needs, because the
      // forward it measures lives inside it. (An earlier comment here said the
      // opposite: that the case drives the substituted one. It does not, and a
      // case whose comment names the wrong subject is a case nobody can check.)
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
          stdoutBytesObserved: 0,
          stderrBytesObserved: 0,
          stdinDelivery: 'NOT_REQUESTED',
          helperPid: null,
          childPid: null,
          retainedWorkDir: null,
          ending: null,
          termination: 'NONE',
        } as never;
      };

      const told: ContainmentAttestation[] = [];
      const mine = (attestation: ContainmentAttestation): void => {
        told.push(attestation);
      };
      await actual.runCommand(
        process.execPath,
        [],
        { cwd: process.cwd(), env: {}, onLaunchEstablished: mine },
        { runOwned },
      );
      expect(seen).toHaveLength(1);
      // Present, and NOT the caller's own function: what the boundary is handed
      // is the composed hook, which tells the accounting first and the caller
      // after.
      const forwarded = seen[0]?.onLaunchEstablished;
      expect(typeof forwarded).toBe('function');
      expect(forwarded).not.toBe(mine);

      // And the caller really is called through it, with the same artefact. A
      // forward that had quietly stopped calling the caller would satisfy every
      // assertion above.
      const minted = mintContainmentAttestation({
        ownerPid: process.pid,
        helperPid: 5101,
        childPid: 5102,
        mode: 'JOBLIST',
        assignedAtCreation: true,
        launchNonce: 'a1a1a1a1a1a1a1a1',
        attestedAt: new Date(Date.UTC(2026, 7, 30)).toISOString(),
        verifiedInJob: true,
      });
      expect(minted).not.toBeNull();
      (forwarded as (a: ContainmentAttestation) => void)(minted as ContainmentAttestation);
      expect(told).toEqual([minted]);

      // A caller that supplies nothing still causes a hook to be handed down -
      // that is the whole change - and is simply never called back.
      await actual.runCommand(process.execPath, [], { cwd: process.cwd(), env: {} }, { runOwned });
      expect(seen).toHaveLength(2);
      expect(typeof seen[1]?.onLaunchEstablished).toBe('function');
      const second = seen[1]?.onLaunchEstablished as (a: ContainmentAttestation) => void;
      second(minted as ContainmentAttestation);
      expect(told).toHaveLength(1);
    },
  );

  it('the module the agent seam reached really was the substituted one', async () => {
    // The control, and it has to be one. `expect(runCommand.name).not.toBe('')`
    // stood here and could not fail: a function has a name whether it is mocked
    // or real. What distinguishes them is the *identity* of the export, so that
    // is what is compared - and the sink having been written to is what proves
    // the agent seam reached this one rather than the real spawn path.
    const real = await vi.importActual<typeof import('../src/doctor/exec.js')>(
      '../src/doctor/exec.js',
    );
    expect(runCommand).not.toBe(real.runCommand);
    expect(seenByRunCommand.length).toBeGreaterThan(0);
  });
});
