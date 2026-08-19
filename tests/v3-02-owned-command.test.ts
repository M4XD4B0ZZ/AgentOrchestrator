/**
 * V3 slice 2 — the owned-command adapter's *contract*, in process.
 *
 * The adapter is the TypeScript half the ADR keeps above the native boundary:
 * byte budgets, a timeout, the stdin delivery vocabulary and the translation
 * of a {@link BoundaryEnding} into a result an AO runner could consume. The
 * boundary itself owns none of that, deliberately.
 *
 * What lives in this file is everything decidable without a process — and the
 * load-bearing part of that is a single guarantee, stated as an exhaustive
 * enumeration rather than as a sample:
 *
 *   **no combination of boundary ending and local termination reason may
 *   produce `COMPLETED` unless the boundary observed the child exit and no
 *   policy terminated it.**
 *
 * Spike 2 measured why. A helper killed mid-run produced a run that looked
 * exactly like a clean completion: ownership had been reported, the pipes
 * closed, and no child exit code ever arrived. `BOUNDARY_LOST` exists for that
 * state, and an adapter that lets it reach `COMPLETED` down some third path
 * has re-created the defect one layer up.
 *
 * The real processes — budgets that actually cut a stream, a timeout that
 * actually kills a tree, survivors counted after each case — are measured
 * against the shipped artefact in
 * `tests/dist-artifact/owned-command-dist-artifact.mjs`.
 */

import type { ChildProcess } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  classifyBoundaryEnding,
  InvalidBoundaryRequestError,
  type BoundaryEnding,
  type BoundaryStatus,
} from '../src/boundary/launch-boundary.js';
import {
  classifyOwnedCommand,
  classifyStdinDelivery,
  DEFAULT_TERMINATION_GRACE_MS,
  OWNED_COMMAND_OUTCOMES,
  OWNED_TERMINATIONS,
  runOwnedCommand,
} from '../src/boundary/owned-command.js';
import type { OwnedProcessStart } from '../src/boundary/start-owned-process.js';

const NONCE = 'b3f0f0c8-0000-4000-8000-000000000002';

/** A status carrying whatever the case needs, with the rest at its zero value. */
function status(over: Partial<BoundaryStatus> = {}): BoundaryStatus {
  return Object.freeze({
    boundary: 'OK',
    failure: null,
    win32: null,
    mode: 'JOBLIST',
    helperPid: 4242,
    childPid: 4243,
    verifiedInJob: true,
    assignedAtCreation: true,
    jobHandleInheritable: false,
    jobMembersAtStart: 1,
    jobMembersAtEnd: 0,
    childExitCode: 0,
    terminatedByOwnerLoss: false,
    stdinForward: null,
    nonce: NONCE,
    targetStarted: true,
    childExitUnobservable: false,
    raw: Object.freeze({}),
    ...over,
  }) as BoundaryStatus;
}

/** One of every ending shape, so a case can enumerate rather than sample. */
const ENDINGS: ReadonlyArray<{ readonly name: string; readonly ending: BoundaryEnding }> = [
  { name: 'CHILD_EXITED(0)', ending: { ending: 'CHILD_EXITED', childExitCode: 0, status: status() } },
  {
    name: 'CHILD_EXITED(3)',
    ending: { ending: 'CHILD_EXITED', childExitCode: 3, status: status({ childExitCode: 3 }) },
  },
  { name: 'TERMINATED_BY_CALLER', ending: { ending: 'TERMINATED_BY_CALLER', status: status() } },
  {
    name: 'TERMINATED_BY_CALLER(no status)',
    ending: { ending: 'TERMINATED_BY_CALLER', status: null },
  },
  {
    name: 'BOUNDARY_LOST(NO_CHILD_EXIT_OBSERVED)',
    ending: {
      ending: 'BOUNDARY_LOST',
      reason: 'NO_CHILD_EXIT_OBSERVED',
      status: status({ childExitCode: null }),
    },
  },
  {
    name: 'BOUNDARY_LOST(OWNER_LOST)',
    ending: {
      ending: 'BOUNDARY_LOST',
      reason: 'OWNER_LOST',
      // The one that matters most: a *present* exit code, and still not a
      // completion. The child did not finish its work; the job was taken down.
      status: status({ terminatedByOwnerLoss: true, childExitCode: 0 }),
    },
  },
  {
    name: 'BOUNDARY_LOST(STATUS_UNREADABLE)',
    ending: { ending: 'BOUNDARY_LOST', reason: 'STATUS_UNREADABLE', status: null },
  },
  {
    name: 'BOUNDARY_REFUSED(nothing ran)',
    ending: {
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'OWNED_CONTAINMENT_JOB_CREATE',
      win32: 5,
      targetStarted: 'NO',
      status: null,
    },
  },
  {
    name: 'BOUNDARY_REFUSED(target had started)',
    ending: {
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'OWNED_CONTAINMENT_VERIFY',
      win32: null,
      targetStarted: 'YES',
      // A refusal never observed a child exit, so the status carries none.
      status: status({ boundary: 'FAILED', targetStarted: true, childExitCode: null }),
    },
  },
  {
    name: 'BOUNDARY_REFUSED(unknown whether it ran)',
    ending: {
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'BOUNDARY_STATUS_UNREADABLE',
      win32: null,
      targetStarted: 'UNKNOWN',
      status: null,
    },
  },
];

/**
 * A boundary that reports what a real one would, without owning anything.
 *
 * It is deliberately *not* a mock of the adapter's own logic: the ending it
 * hands back is produced by the production {@link classifyBoundaryEnding} from
 * a production-shaped status, so a case here exercises the same classifier the
 * shipped path does and cannot pass by agreeing with itself.
 *
 * What it fakes is the process — and only the process. Nothing below has a job
 * object, so nothing below may be read as evidence about containment.
 */
function fakeBoundary(
  options: {
    readonly refuseWith?: BoundaryEnding;
    /** A helper that will not die when it is asked to. */
    readonly ignoreTermination?: boolean;
    /** A helper that accepts no stdin bytes, so a write stays in flight. */
    readonly stallStdin?: boolean;
    /** A helper whose stdio is not readable at all. */
    readonly noStreams?: boolean;
    /** Runs while the launch is being established, before it returns. */
    readonly onStart?: () => void;
    /** How long establishment takes. Long enough to expire a deadline in. */
    readonly startDelayMs?: number;
    /** A stdin channel that refuses the payload outright. */
    readonly failStdin?: boolean;
    /** Streams that raise when this module lets go of them. */
    readonly errorOnRelease?: boolean;
    /** How long the boundary takes to end after it is asked to. */
    readonly terminationDelayMs?: number;
  } = {},
) {
  const out = new PassThrough();
  const err = new PassThrough();
  const written: Buffer[] = [];
  let closeStdin: () => void = () => {};
  const stdinClosedPromise = new Promise<void>((done) => {
    closeStdin = done;
  });
  const input = new Writable({
    write(chunk: Buffer, _encoding, done) {
      written.push(Buffer.from(chunk));
      if (options.stallStdin === true) return;
      if (options.failStdin === true) {
        done(new Error('the child closed its read end'));
        return;
      }
      done();
    },
    destroy(error, done) {
      // A pipe that reports a failure as it goes, which is what a real one
      // does when the process on the other end has just been killed.
      done(options.errorOnRelease === true ? new Error('EPIPE') : error);
    },
    final(done) {
      closeStdin();
      done();
    },
  });

  let starts = 0;
  let terminations = 0;
  let disposals = 0;
  let callerTerminated = false;
  let settled = false;
  let settle: (ending: BoundaryEnding) => void = () => {};
  const ending = new Promise<BoundaryEnding>((done) => {
    settle = done;
  });

  function finish(over: { childExitCode?: number | null; stdinForward?: string | null } = {}): void {
    if (settled) return;
    settled = true;
    const childExitCode = over.childExitCode ?? null;
    settle(
      classifyBoundaryEnding({
        status: status({ childExitCode, stdinForward: over.stdinForward ?? null }),
        helperExitCode: childExitCode === null ? null : 0,
        helperSignal: null,
        callerRequestedTermination: callerTerminated,
        expect: { nonce: NONCE, helperPid: 4242 },
      }),
    );
    out.end();
    err.end();
  }

  function terminate(): void {
    terminations += 1;
    callerTerminated = true;
    // A real helper's stdin pipe dies with it, and a write still in flight
    // then fails — caused by this side, not by the child. The fake reproduces
    // that, because it is the input to a case below.
    // Destroyed without an error argument: the pending write callback still
    // reports `ERR_STREAM_DESTROYED`, which is what the adapter reads, and no
    // `error` event is emitted on a stream a case may not have listened to.
    input.destroy();
    if (options.ignoreTermination === true) return;
    if (options.terminationDelayMs === undefined) {
      finish({ childExitCode: null });
      return;
    }
    setTimeout(() => finish({ childExitCode: null }), options.terminationDelayMs).unref?.();
  }

  const start = async (): Promise<OwnedProcessStart> => {
    starts += 1;
    options.onStart?.();
    // Establishment is not instantaneous for a real boundary — a helper spawn
    // plus a status poll — and the window it opens is where a case below
    // raises its abort, and another lets a deadline expire.
    await new Promise((done) => setTimeout(done, options.startDelayMs ?? 5));
    if (options.refuseWith !== undefined) {
      return { established: false, ending: options.refuseWith };
    }
    const streams =
      options.noStreams === true
        ? { stdout: null, stderr: null, stdin: input }
        : { stdout: out, stderr: err, stdin: input };
    return {
      established: true,
      process: {
        helper: streams as unknown as ChildProcess,
        helperPid: 4242,
        childPid: 4243,
        mode: 'JOBLIST',
        assignedAtCreation: true,
        verifiedInJob: true,
        jobMembersAtStart: 1,
        workDir: 'C:\\fake',
        terminate,
        ending,
        dispose: () => {
          disposals += 1;
        },
      },
    };
  };

  return {
    start,
    starts: () => starts,
    terminations: () => terminations,
    disposals: () => disposals,
    finish,
    // Guarded: a real helper's pipes close when it dies, so a case that keeps
    // writing after the boundary ended is writing into a closed pipe there
    // too. Silently ignored rather than thrown, exactly as it would be.
    stdout: (text: string) => {
      if (!out.writableEnded) out.write(text);
    },
    stderr: (text: string) => {
      if (!err.writableEnded) err.write(text);
    },
    stdinClosed: () => stdinClosedPromise,
    /** How many output sinks are still attached. */
    dataListeners: () => out.listenerCount('data') + err.listenerCount('data'),
    /** Whether the payload channel was destroyed too. */
    stdinDestroyed: () => input.destroyed,
    /**
     * Whether the output streams were destroyed rather than only detached.
     *
     * The distinction is the whole of one case: detaching a `data` listener
     * leaves the underlying handle referenced, and a real helper's pipes then
     * keep this process alive after it has given up on that helper.
     */
    streamsDestroyed: () => out.destroyed && err.destroyed,
    stdinReceived: () => Buffer.concat(written).toString('utf8'),
    /**
     * Resolves once the adapter is reading both streams.
     *
     * Observed rather than assumed: a case that wrote output before the sinks
     * were attached would measure the pipe's buffering, not the budget.
     */
    established: async (): Promise<void> => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        if (out.listenerCount('data') > 0 && err.listenerCount('data') > 0) return;
        await new Promise((done) => setTimeout(done, 1));
      }
      throw new Error('the adapter never attached its output sinks');
    },
  };
}

describe('the owned-command adapter classifies every ending', () => {
  it('completes only when the child exited and no policy terminated it', () => {
    const completed: string[] = [];
    for (const { name, ending } of ENDINGS) {
      for (const termination of OWNED_TERMINATIONS) {
        const result = classifyOwnedCommand({ ending, termination });
        if (result.outcome === 'COMPLETED') completed.push(`${name} × ${termination}`);
      }
    }
    expect(completed).toEqual(['CHILD_EXITED(0) × NONE', 'CHILD_EXITED(3) × NONE']);
  });

  it('never reads a lost boundary as a completion, whatever the local reason', () => {
    // The exhaustive form of the guarantee the ADR added the state for. The
    // case above already implies it; this one states it as its own claim, so a
    // future ending added to the enumeration cannot weaken it by accident.
    for (const { name, ending } of ENDINGS) {
      if (ending.ending !== 'BOUNDARY_LOST') continue;
      for (const termination of OWNED_TERMINATIONS) {
        const result = classifyOwnedCommand({ ending, termination });
        expect(result.outcome, `${name} × ${termination}`).toBe('BOUNDARY_LOST');
        expect(result.failureCode, `${name} × ${termination}`).toBe('BOUNDARY_LOST');
      }
    }
  });

  it('reports a timeout as a timeout rather than as a boundary loss', () => {
    // The boundary's own vocabulary cannot tell a policy kill from a loss —
    // both are "the helper died". `callerRequestedTermination` is what
    // separates them, and the adapter's reason is what names which policy.
    const ending = classifyBoundaryEnding({
      status: status({ childExitCode: null }),
      helperExitCode: null,
      helperSignal: 'SIGKILL',
      callerRequestedTermination: true,
      expect: { nonce: NONCE, helperPid: 4242 },
    });
    expect(ending.ending).toBe('TERMINATED_BY_CALLER');

    const result = classifyOwnedCommand({ ending, termination: 'TIMEOUT' });
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('TIMEOUT');
  });

  it('separates a caller cancellation from a boundary loss', () => {
    const ending: BoundaryEnding = { ending: 'TERMINATED_BY_CALLER', status: status() };
    const result = classifyOwnedCommand({ ending, termination: 'CALLER' });
    expect(result.outcome).toBe('TERMINATED_BY_CALLER');
    expect(result.failureCode).toBe('TERMINATED_BY_CALLER');
  });

  it('names which stream exhausted its budget', () => {
    const ending: BoundaryEnding = { ending: 'TERMINATED_BY_CALLER', status: status() };
    expect(classifyOwnedCommand({ ending, termination: 'LIMIT_STDOUT' })).toMatchObject({
      outcome: 'OUTPUT_LIMIT_EXCEEDED',
      failureCode: 'OUTPUT_LIMIT_STDOUT',
    });
    expect(classifyOwnedCommand({ ending, termination: 'LIMIT_STDERR' })).toMatchObject({
      outcome: 'OUTPUT_LIMIT_EXCEEDED',
      failureCode: 'OUTPUT_LIMIT_STDERR',
    });
  });

  it('refuses to invent a completion for a termination no policy asked for', () => {
    // Only this adapter sets `callerRequestedTermination`, so this pairing is
    // unreachable by construction — which is exactly why it is enumerated. An
    // inconsistent state is fail-closed, not quietly rounded to the nearest
    // plausible outcome.
    const ending: BoundaryEnding = { ending: 'TERMINATED_BY_CALLER', status: status() };
    const result = classifyOwnedCommand({ ending, termination: 'NONE' });
    expect(result.outcome).toBe('BOUNDARY_LOST');
    expect(result.failureCode).toBe('ENDING_INCONSISTENT');
  });

  it('keeps the child exit code whatever the outcome', () => {
    const exited: BoundaryEnding = {
      ending: 'CHILD_EXITED',
      childExitCode: 3221225477,
      status: status({ childExitCode: 3221225477 }),
    };
    expect(classifyOwnedCommand({ ending: exited, termination: 'NONE' }).exitCode).toBe(3221225477);
    // A late timeout — the timer fired in the same tick the child exited — is
    // still a timeout, and the code it exited with is still reported. This is
    // `runCommand`'s behaviour, kept deliberately: the reason a run was
    // terminated may not be revised by what arrived afterwards.
    const late = classifyOwnedCommand({ ending: exited, termination: 'TIMEOUT' });
    expect(late.outcome).toBe('TIMED_OUT');
    expect(late.exitCode).toBe(3221225477);
  });

  it('reads the boundary exit code back as the unsigned value Windows gives', () => {
    // Measured, not assumed. A Windows process exit code is a DWORD, and node
    // reports it unsigned: `process.exit(3221225477)` is observed as
    // 3221225477 by `child_process`. The helper writes the same DWORD through
    // `unchecked((int)exitCode)`, so the status carries -1073741819 for that
    // run. Without this the owned path would report a different number for the
    // same process than the diagnostics path does — and 0xC0000005, an access
    // violation, is exactly the code a crashed agent comes back with.
    const crashed: BoundaryEnding = {
      ending: 'CHILD_EXITED',
      childExitCode: -1073741819,
      status: status({ childExitCode: -1073741819 }),
    };
    expect(classifyOwnedCommand({ ending: crashed, termination: 'NONE' }).exitCode).toBe(
      3221225477,
    );
    // Ordinary codes are untouched, including the largest positive int32.
    for (const code of [0, 1, 42, 255, 256, 2147483647]) {
      const exited: BoundaryEnding = {
        ending: 'CHILD_EXITED',
        childExitCode: code,
        status: status({ childExitCode: code }),
      };
      expect(classifyOwnedCommand({ ending: exited, termination: 'NONE' }).exitCode).toBe(code);
    }
  });

  it('reports no exit code where the boundary proved none', () => {
    for (const { name, ending } of ENDINGS) {
      if (ending.ending === 'CHILD_EXITED') continue;
      const result = classifyOwnedCommand({ ending, termination: 'NONE' });
      // A `TERMINATED_BY_CALLER` or `BOUNDARY_LOST` status may carry a code the
      // helper managed to read. It is reported, because it is evidence — but
      // never as a completion, which the enumeration above already pinned. A
      // refusal reports none at all: no child of this launch was ever observed
      // to exit, so any number there would be another launch's or nobody's.
      const raw = ending.status?.childExitCode ?? null;
      // A refusal reports none at all. `TERMINATED_BY_CALLER` with no policy
      // having asked is contradictory and fails closed, which reports none
      // either — the pairing has its own case further down.
      const expected =
        ending.ending === 'BOUNDARY_REFUSED' || ending.ending === 'TERMINATED_BY_CALLER'
          ? null
          : raw === null
            ? null
            : raw >>> 0;
      expect(result.exitCode, name).toBe(expected);
    }
  });

  it('treats an unknown launch as one that may have had side effects', () => {
    const unknown = ENDINGS.find((entry) => entry.name.includes('unknown whether'))!.ending;
    const result = classifyOwnedCommand({ ending: unknown, termination: 'NONE' });
    expect(result.outcome).toBe('LAUNCH_REFUSED');
    expect(result.targetStarted).toBe('UNKNOWN');
    expect(result.sideEffectsPossible).toBe(true);

    const nothingRan = ENDINGS.find((entry) => entry.name.includes('nothing ran'))!.ending;
    const clean = classifyOwnedCommand({ ending: nothingRan, termination: 'NONE' });
    expect(clean.targetStarted).toBe('NO');
    expect(clean.sideEffectsPossible).toBe(false);
  });

  it('carries the boundary own failure code through a refusal', () => {
    const refused = ENDINGS.find((entry) => entry.name.includes('target had started'))!.ending;
    const result = classifyOwnedCommand({ ending: refused, termination: 'NONE' });
    expect(result.outcome).toBe('LAUNCH_REFUSED');
    expect(result.boundaryFailureCode).toBe('OWNED_CONTAINMENT_VERIFY');
    expect(result.boundaryLostReason).toBeNull();
  });

  it('carries the reason a boundary was lost', () => {
    const lost = ENDINGS.find((entry) => entry.name.includes('OWNER_LOST'))!.ending;
    const result = classifyOwnedCommand({ ending: lost, termination: 'NONE' });
    expect(result.boundaryLostReason).toBe('OWNER_LOST');
    expect(result.boundaryFailureCode).toBeNull();
  });

  it('lands every enumerated pairing on a declared outcome', () => {
    // Totality. A classification map that silently returned `undefined` for an
    // unforeseen pairing would be a fail-open hole in exactly the place this
    // module exists to close.
    const declared = new Set<string>(OWNED_COMMAND_OUTCOMES);
    for (const { name, ending } of ENDINGS) {
      for (const termination of OWNED_TERMINATIONS) {
        const { outcome } = classifyOwnedCommand({ ending, termination });
        expect(declared.has(outcome), `${name} × ${termination} -> ${String(outcome)}`).toBe(true);
      }
    }
  });
});

describe('the adapter reads stdin delivery from the boundary', () => {
  const requested = { requested: true, established: true } as const;

  it('is NOT_REQUESTED when no payload was configured', () => {
    for (const forwarded of [null, 'EOF_FORWARDED', 'BROKEN_PIPE']) {
      expect(
        classifyStdinDelivery({
          requested: false,
          established: true,
          localWrite: 'COMPLETED',
          forwarded,
        }),
      ).toBe('NOT_REQUESTED');
    }
  });

  it('is DELIVERED only when this side finished and the boundary forwarded EOF', () => {
    expect(
      classifyStdinDelivery({ ...requested, localWrite: 'COMPLETED', forwarded: 'EOF_FORWARDED' }),
    ).toBe('DELIVERED');
  });

  it('is not DELIVERED when the child closed its read end first', () => {
    // The measured caveat in the ADR: with a helper in the middle, the caller's
    // own pipe does not break when the child stops reading. `BROKEN_PIPE` is
    // the boundary's report, and it is the only evidence there is.
    expect(
      classifyStdinDelivery({ ...requested, localWrite: 'COMPLETED', forwarded: 'BROKEN_PIPE' }),
    ).toBe('FAILED');
  });

  it('is not DELIVERED when this side never finished writing', () => {
    // A local write that failed halfway makes the helper read EOF early and
    // report `EOF_FORWARDED` for a payload that was never complete. Both halves
    // are required, and this is the pairing that shows why.
    expect(
      classifyStdinDelivery({ ...requested, localWrite: 'FAILED', forwarded: 'EOF_FORWARDED' }),
    ).toBe('UNCONFIRMED');
  });

  it('is UNCONFIRMED while the boundary has reported nothing', () => {
    expect(
      classifyStdinDelivery({ ...requested, localWrite: 'PENDING', forwarded: null }),
    ).toBe('UNCONFIRMED');
    expect(
      classifyStdinDelivery({ ...requested, localWrite: 'COMPLETED', forwarded: null }),
    ).toBe('UNCONFIRMED');
  });


  it('is UNCONFIRMED for a forwarding state this build does not know', () => {
    expect(
      classifyStdinDelivery({ ...requested, localWrite: 'COMPLETED', forwarded: 'SOMETHING_NEW' }),
    ).toBe('UNCONFIRMED');
  });

  it('is FAILED when the launch was refused, whatever the boundary said', () => {
    // Nothing is ever written into a helper that never established ownership,
    // so a configured payload demonstrably did not reach the child. This is
    // what `runCommand` reports for a spawn that never happened.
    for (const forwarded of [null, 'EOF_FORWARDED', 'BROKEN_PIPE']) {
      expect(
        classifyStdinDelivery({
          requested: true,
          established: false,
          localWrite: 'PENDING',
          forwarded,
        }),
      ).toBe('FAILED');
    }
  });

  it('never revises a local failure into a delivery', () => {
    for (const forwarded of [null, 'EOF_FORWARDED', 'BROKEN_PIPE', 'SOMETHING_NEW']) {
      expect(
        classifyStdinDelivery({ ...requested, localWrite: 'FAILED', forwarded }),
        String(forwarded),
      ).not.toBe('DELIVERED');
    }
  });
});

describe('the adapter vocabulary is the one AO already has', () => {
  it('declares one termination reason per policy that can terminate', () => {
    expect([...OWNED_TERMINATIONS]).toEqual([
      'NONE',
      'TIMEOUT',
      'LIMIT_STDOUT',
      'LIMIT_STDERR',
      'CALLER',
    ]);
  });

  it('spells the outcomes it shares with the runner the way the runner spells them', () => {
    // Pinned here, and NOT differential — a claim this case used to make and
    // could not keep. `CommandOutcome` is a type union: it has no runtime
    // representation in `src/doctor/exec.ts`, so nothing here can read the
    // runner's spelling back, and renaming the runner's `'TIMED_OUT'` would
    // leave any assertion in this file green. What enforces the agreement is
    // slice 3's compiler, when it writes the mapping; what this case is for is
    // stating which members are meant to be shared, so that a *rename on this
    // side* is a deliberate act rather than a silent divergence.
    for (const member of ['COMPLETED', 'TIMED_OUT', 'OUTPUT_LIMIT_EXCEEDED'] as const) {
      expect(OWNED_COMMAND_OUTCOMES).toContain(member);
    }
    // And the ones this layer adds are genuinely new, rather than a rename of
    // something the runner already says.
    expect(OWNED_COMMAND_OUTCOMES).toContain('BOUNDARY_LOST');
    expect(OWNED_COMMAND_OUTCOMES).toContain('TERMINATED_BY_CALLER');
    expect(OWNED_COMMAND_OUTCOMES).toContain('LAUNCH_REFUSED');
  });
});

/**
 * ── The run loop, driven through an injected boundary ──────────────────────
 *
 * These cases substitute {@link startOwnedProcess}, and the substitution is
 * what makes them worth having: they drive orderings a real boundary produces
 * rarely or never — a stderr budget landing in the same tick as the stdout
 * one, a helper that ignores its own termination — and they can assert on the
 * *reason* a run ended rather than only on the fact that it did.
 *
 * What they explicitly cannot see, and do not claim: that a real tree died. A
 * fake helper has no job object, so every containment property is measured
 * against the shipped artefact in
 * `tests/dist-artifact/owned-command-dist-artifact.mjs`, with survivors
 * counted after each case.
 */
describe('the run loop, driven through an injected boundary', () => {
  it('keeps stdout and stderr separate', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand({ file: 'C:\\fixture.exe' }, { start: boundary.start });
    await boundary.established();
    boundary.stdout('out-1');
    boundary.stderr('err-1');
    boundary.stdout('out-2');
    boundary.finish({ childExitCode: 0 });

    const result = await run;
    expect(result.stdout).toBe('out-1out-2');
    expect(result.stderr).toBe('err-1');
    expect(result.outcome).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);
  });

  it('keeps an unusual exit code exactly', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand({ file: 'C:\\fixture.exe' }, { start: boundary.start });
    await boundary.established();
    boundary.finish({ childExitCode: 3221225477 });
    await expect(run).resolves.toMatchObject({ outcome: 'COMPLETED', exitCode: 3221225477 });
  });

  it('cuts a stream at its budget and terminates the boundary', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', maxStdoutBytes: 4 },
      { start: boundary.start },
    );
    await boundary.established();
    boundary.stdout('123456789');

    const result = await run;
    expect(result.stdout).toBe('1234');
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
    expect(result.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(result.failureCode).toBe('OUTPUT_LIMIT_STDOUT');
    expect(boundary.terminations()).toBe(1);
  });

  it('cuts stderr at its own budget', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', maxStderrBytes: 2 },
      { start: boundary.start },
    );
    await boundary.established();
    boundary.stderr('abcdef');

    const result = await run;
    expect(result.stderr).toBe('ab');
    expect(result.stderrTruncated).toBe(true);
    expect(result.failureCode).toBe('OUTPUT_LIMIT_STDERR');
  });

  it('lets the first termination reason win, and terminates once', async () => {
    // The race acceptance item 13 names. A second trigger may neither rename
    // the outcome nor ask the boundary to die twice.
    //
    // The boundary is given a delay before it ends, so that both budgets are
    // genuinely exceeded during the same live run: a boundary that ended
    // instantly would close the second stream before it could be written, and
    // the case would pass without ever having two triggers.
    const boundary = fakeBoundary({ terminationDelayMs: 20 });
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', maxStdoutBytes: 2, maxStderrBytes: 2 },
      { start: boundary.start },
    );
    await boundary.established();
    boundary.stdout('aaaa');
    boundary.stderr('bbbb');

    const result = await run;
    expect(result.failureCode).toBe('OUTPUT_LIMIT_STDOUT');
    expect(result.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(boundary.terminations()).toBe(1);
  });

  it('reports a timeout as TIMED_OUT, not as a boundary loss', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', timeoutMs: 20 },
      { start: boundary.start },
    );
    await boundary.established();
    // Nothing else happens: the fake helper hangs, exactly as a hung child
    // would make a real one do.
    const result = await run;
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('TIMEOUT');
    expect(result.boundaryLostReason).toBeNull();
    expect(boundary.terminations()).toBe(1);
  });

  it('does not rename a budget cut when the timeout lands afterwards', async () => {
    // The one case in this file that needs its timeout *not* to fire before the
    // first byte, so it is the one that a loaded machine could turn red — every
    // other 20ms case here expects a timeout, which slowness only confirms.
    // 400ms of head-room for a fake establishment that costs 5ms, and a
    // boundary that then takes 900ms to end, so the timer genuinely fires
    // during the run and genuinely changes nothing.
    const boundary = fakeBoundary({ terminationDelayMs: 900 });
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', timeoutMs: 400, maxStdoutBytes: 2 },
      { start: boundary.start },
    );
    await boundary.established();
    boundary.stdout('aaaa');

    const result = await run;
    expect(result.outcome).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(result.failureCode).toBe('OUTPUT_LIMIT_STDOUT');
    expect(boundary.terminations()).toBe(1);
  });

  it('reports an explicit cancellation as TERMINATED_BY_CALLER', async () => {
    const boundary = fakeBoundary();
    const canceller = new AbortController();
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', signal: canceller.signal },
      { start: boundary.start },
    );
    await boundary.established();
    canceller.abort();

    const result = await run;
    expect(result.outcome).toBe('TERMINATED_BY_CALLER');
    expect(result.failureCode).toBe('TERMINATED_BY_CALLER');
    expect(result.boundaryLostReason).toBeNull();
  });

  it('starts nothing at all for a signal that is already aborted', async () => {
    const boundary = fakeBoundary();
    const canceller = new AbortController();
    canceller.abort();
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', signal: canceller.signal },
      { start: boundary.start },
    );
    expect(boundary.starts()).toBe(0);
    expect(result.established).toBe(false);
    expect(result.outcome).toBe('TERMINATED_BY_CALLER');
    expect(result.targetStarted).toBe('NO');
    expect(result.sideEffectsPossible).toBe(false);
  });

  it('reports an unasked helper death as BOUNDARY_LOST', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand({ file: 'C:\\fixture.exe' }, { start: boundary.start });
    await boundary.established();
    // The spike's defect, reproduced: ownership was reported, the pipes close
    // cleanly, and no child exit code ever arrives.
    boundary.finish({ childExitCode: null });

    const result = await run;
    expect(result.outcome).toBe('BOUNDARY_LOST');
    expect(result.failureCode).toBe('BOUNDARY_LOST');
    expect(result.boundaryLostReason).toBe('NO_CHILD_EXIT_OBSERVED');
  });

  it('reports a refused launch without claiming nothing ran', async () => {
    const boundary = fakeBoundary({
      refuseWith: {
        ending: 'BOUNDARY_REFUSED',
        failureCode: 'OWNED_CONTAINMENT_VERIFY',
        win32: null,
        targetStarted: 'UNKNOWN',
        status: null,
      },
    });
    const result = await runOwnedCommand({ file: 'C:\\fixture.exe' }, { start: boundary.start });
    expect(result.outcome).toBe('LAUNCH_REFUSED');
    expect(result.established).toBe(false);
    expect(result.boundaryFailureCode).toBe('OWNED_CONTAINMENT_VERIFY');
    expect(result.sideEffectsPossible).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('fails closed when a termination it asked for is never confirmed', async () => {
    // A helper that will not die. Nothing here can prove the tree is gone, so
    // the run may not be reported as ended under control.
    const boundary = fakeBoundary({ ignoreTermination: true });
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', timeoutMs: 20, terminationGraceMs: 30 },
      { start: boundary.start },
    );
    await boundary.established();

    const result = await run;
    expect(result.outcome).toBe('BOUNDARY_LOST');
    expect(result.failureCode).toBe('BOUNDARY_TERMINATION_UNCONFIRMED');
    expect(result.sideEffectsPossible).toBe(true);
    boundary.finish({ childExitCode: null });
  });

  it('hands the payload over and reads its fate from the boundary', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', stdin: 'the instructions' },
      { start: boundary.start },
    );
    await boundary.established();
    await boundary.stdinClosed();
    boundary.finish({ childExitCode: 0, stdinForward: 'EOF_FORWARDED' });

    const result = await run;
    expect(boundary.stdinReceived()).toBe('the instructions');
    expect(result.stdinDelivery).toBe('DELIVERED');
  });

  it('does not claim a delivery the boundary reported broken', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', stdin: 'the instructions' },
      { start: boundary.start },
    );
    await boundary.established();
    await boundary.stdinClosed();
    boundary.finish({ childExitCode: 0, stdinForward: 'BROKEN_PIPE' });

    const result = await run;
    // The child exited zero having read a prefix. That is a completion at the
    // process level and a failed delivery at the channel level, and both are
    // true at once — which is why they are separate fields.
    expect(result.outcome).toBe('COMPLETED');
    expect(result.stdinDelivery).toBe('FAILED');
  });

  it('reports UNCONFIRMED when a run ends with the payload still in flight', async () => {
    const boundary = fakeBoundary({ stallStdin: true });
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', stdin: 'the instructions', timeoutMs: 20 },
      { start: boundary.start },
    );
    await boundary.established();
    // The write never completes, and the timeout destroys the pipe underneath
    // it. The error that then arrives is this side's own doing: reading it as a
    // channel failure would be a verdict nobody observed, because the last byte
    // may have gone through microseconds earlier.
    const result = await run;
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.stdinDelivery).toBe('UNCONFIRMED');
  });

  it('reports NOT_REQUESTED when no payload was configured', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand({ file: 'C:\\fixture.exe' }, { start: boundary.start });
    await boundary.established();
    boundary.finish({ childExitCode: 0, stdinForward: 'EOF_FORWARDED' });
    await expect(run).resolves.toMatchObject({ stdinDelivery: 'NOT_REQUESTED' });
  });

  it('closes the child stdin even when no payload was configured', async () => {
    // A child that reads to end-of-file must see one, or it waits forever.
    const boundary = fakeBoundary();
    const run = runOwnedCommand({ file: 'C:\\fixture.exe' }, { start: boundary.start });
    await boundary.established();
    await boundary.stdinClosed();
    expect(boundary.stdinReceived()).toBe('');
    boundary.finish({ childExitCode: 0 });
    await run;
  });

  it('reports FAILED for a payload that was never handed to a boundary', async () => {
    const boundary = fakeBoundary({
      refuseWith: {
        ending: 'BOUNDARY_REFUSED',
        failureCode: 'BOUNDARY_EXECUTABLE_MISSING',
        win32: null,
        targetStarted: 'NO',
        status: null,
      },
    });
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', stdin: 'the instructions' },
      { start: boundary.start },
    );
    expect(result.stdinDelivery).toBe('FAILED');
  });

  it('gives the temporary directory back after a run', async () => {
    const boundary = fakeBoundary();
    const run = runOwnedCommand({ file: 'C:\\fixture.exe' }, { start: boundary.start });
    await boundary.established();
    boundary.finish({ childExitCode: 0 });
    await run;
    expect(boundary.disposals()).toBe(1);
  });
});

/**
 * ── What the first adversarial review found ────────────────────────────────
 *
 * Every case below reproduces a defect an independent review of the first
 * implementation identified. They are kept as their own group because that is
 * what they are: the failures a green suite did not have the power to see, and
 * the reason each of them was possible is worth reading next to the case.
 */
describe('the defects the first review found', () => {
  it('honours an abort raised while the launch is still being established', async () => {
    // The window the first implementation dropped. `signal.aborted` was read
    // once, before establishment, and the listener was attached once, after it
    // — and a listener added to an already-aborted signal is never invoked. An
    // abort landing in between was therefore lost, and the run went on to
    // report `COMPLETED` for a launch the caller had cancelled.
    const canceller = new AbortController();
    const boundary = fakeBoundary({ onStart: () => canceller.abort() });
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', signal: canceller.signal, timeoutMs: 5_000 },
      { start: boundary.start },
    );
    expect(result.outcome).toBe('TERMINATED_BY_CALLER');
    expect(result.failureCode).toBe('TERMINATED_BY_CALLER');
    expect(boundary.terminations()).toBe(1);
  });

  it('leaves no abort listener behind on a signal that outlives the run', async () => {
    // A per-task controller shared by the writer, the reviewer and the
    // verification command is the obvious productive shape. A listener per run
    // retains that run's sinks and child process, and node warns past ten.
    const canceller = new AbortController();
    const boundary = fakeBoundary();
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', signal: canceller.signal },
      { start: boundary.start },
    );
    await boundary.established();
    boundary.finish({ childExitCode: 0 });
    await run;
    expect(getEventListeners(canceller.signal, 'abort')).toHaveLength(0);
  });

  it('stops reading the streams once it has reported a run it abandoned', async () => {
    // The fail-closed path returned while its `data` handlers were still live
    // on a helper that had ignored its own termination, so a later chunk could
    // re-terminate a run that had already been reported.
    const boundary = fakeBoundary({ ignoreTermination: true });
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', timeoutMs: 20, terminationGraceMs: 30, maxStdoutBytes: 2 },
      { start: boundary.start },
    );
    await boundary.established();
    const result = await run;
    expect(result.failureCode).toBe('BOUNDARY_TERMINATION_UNCONFIRMED');

    const terminationsAtReport = boundary.terminations();
    boundary.stdout('this arrives after the run was reported');
    await new Promise((done) => setTimeout(done, 20));
    expect(boundary.terminations()).toBe(terminationsAtReport);
    expect(boundary.dataListeners()).toBe(0);
    boundary.finish({ childExitCode: null });
  });

  it('does not wait forever for a boundary whose streams it cannot read', async () => {
    // Unreachable through `startOwnedProcess`, and previously the one
    // termination in the module with no bound at all: a bare await on an
    // ending that a helper ignoring its kill would never produce.
    const boundary = fakeBoundary({ noStreams: true, ignoreTermination: true });
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', terminationGraceMs: 20 },
      { start: boundary.start },
    );
    expect(result.outcome).toBe('BOUNDARY_LOST');
    expect(result.failureCode).toBe('BOUNDARY_STREAMS_UNAVAILABLE');
    boundary.finish({ childExitCode: null });
  });

  it('reports a launch that threw instead of throwing', async () => {
    // `startOwnedProcess` writes files and spawns, and both can fail for
    // environmental reasons — a full disk, a read-only TMP, a spawn that
    // throws synchronously. The module promises data rather than exceptions,
    // and that promise has to hold for the call that starts everything.
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe' },
      {
        start: () => {
          throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
        },
      },
    );
    expect(result.outcome).toBe('LAUNCH_REFUSED');
    expect(result.established).toBe(false);
    // Conservative: a throw is not proof that nothing was created.
    expect(result.targetStarted).toBe('UNKNOWN');
    expect(result.sideEffectsPossible).toBe(true);
  });

  it('still throws for a request this repository cannot encode', async () => {
    // A NUL in an argument is a programming error here, exactly as an unsafe
    // argument is on the diagnostics path, and it keeps propagating.
    await expect(
      runOwnedCommand(
        { file: 'C:\\fixture.exe' },
        {
          start: () => {
            throw new InvalidBoundaryRequestError('a NUL in an argument');
          },
        },
      ),
    ).rejects.toBeInstanceOf(InvalidBoundaryRequestError);
  });
});

describe('a broken pipe to the boundary proves nothing about the child', () => {
  const requested = { requested: true, established: true } as const;

  it('is UNCONFIRMED whenever this side lost its own pipe', () => {
    // The pipe this side writes into belongs to the *helper*, not to the
    // child. Its breaking says the helper died — by this side's hand or by
    // someone else's — and says nothing at all about what the child received.
    // The first implementation reported a proven `FAILED` whenever the failure
    // arrived before a local termination was recorded, which made the verdict
    // depend on who killed the helper rather than on what was observed.
    expect(classifyStdinDelivery({ ...requested, localWrite: 'FAILED', forwarded: null })).toBe(
      'UNCONFIRMED',
    );
  });

  it('still reports the broken pipe the boundary itself saw', () => {
    expect(
      classifyStdinDelivery({ ...requested, localWrite: 'FAILED', forwarded: 'BROKEN_PIPE' }),
    ).toBe('FAILED');
  });

  it('is FAILED when there was no channel to write into at all', () => {
    // A helper that opened no stdin pipe. Nothing was handed over, and that is
    // an observation rather than an absence of one.
    expect(
      classifyStdinDelivery({ ...requested, localWrite: 'NO_CHANNEL', forwarded: null }),
    ).toBe('FAILED');
  });
});

describe('a refusal and a local termination cannot both be true', () => {
  it('fails closed rather than reporting that nothing ran', () => {
    // Reachable after establishment: a status that turns foreign under a
    // shared working directory, or a `boundary=FAILED` written after the
    // `boundary=OK` this run was established on. This side had already
    // terminated something, so "the launch was refused and nothing ran" is
    // refuted by its own state.
    const refused: BoundaryEnding = {
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'OWNED_CONTAINMENT_VERIFY',
      win32: null,
      targetStarted: 'NO',
      status: null,
    };
    for (const termination of OWNED_TERMINATIONS) {
      if (termination === 'NONE') continue;
      const result = classifyOwnedCommand({ ending: refused, termination });
      expect(result.outcome, termination).toBe('BOUNDARY_LOST');
      expect(result.failureCode, termination).toBe('ENDING_INCONSISTENT');
      expect(result.sideEffectsPossible, termination).toBe(true);
    }
  });

  it('keeps `sideEffectsPossible` true for every pairing that is not a proven refusal', () => {
    // The same claim as the earlier enumeration, with the exclusion narrowed
    // to what it is actually entitled to exclude: a refusal *nobody
    // terminated*. The first version excluded the whole row, which is where
    // the defect above lived.
    for (const { name, ending } of ENDINGS) {
      for (const termination of OWNED_TERMINATIONS) {
        if (
          ending.ending === 'BOUNDARY_REFUSED' &&
          ending.targetStarted === 'NO' &&
          termination === 'NONE'
        ) {
          continue;
        }
        expect(
          classifyOwnedCommand({ ending, termination }).sideEffectsPossible,
          `${name} × ${termination}`,
        ).toBe(true);
      }
    }
  });
});

describe('an exit code that cannot be represented is not a completion', () => {
  it('fails closed on a status carrying an impossible exit code', () => {
    // `>>> 0` is a `ToUint32`: it maps 2**32 to 0 and 4294967297 to 1, so an
    // out-of-range value in a status would have become a plausible small exit
    // code. The decoder only guarantees a *safe* integer, and the nonce exists
    // precisely because a status file is not beyond a third party's reach.
    for (const impossible of [2 ** 32, 4294967297, -2147483649, 1.5]) {
      const ending: BoundaryEnding = {
        ending: 'CHILD_EXITED',
        childExitCode: impossible,
        status: status({ childExitCode: impossible }),
      };
      const result = classifyOwnedCommand({ ending, termination: 'NONE' });
      expect(result.outcome, String(impossible)).toBe('BOUNDARY_LOST');
      expect(result.failureCode, String(impossible)).toBe('ENDING_INCONSISTENT');
      expect(result.exitCode, String(impossible)).toBeNull();
    }
  });

  it('accepts every code a Windows process can actually exit with', () => {
    for (const code of [0, 1, 255, 2147483647, -2147483648, -1073741819]) {
      const ending: BoundaryEnding = {
        ending: 'CHILD_EXITED',
        childExitCode: code,
        status: status({ childExitCode: code }),
      };
      const result = classifyOwnedCommand({ ending, termination: 'NONE' });
      expect(result.outcome, String(code)).toBe('COMPLETED');
      expect(result.exitCode, String(code)).toBe(code >>> 0);
    }
  });
});

/**
 * ── What the second adversarial review found ───────────────────────────────
 *
 * A fresh review of the *fixed* head, which is the round that matters: the
 * fixes written for the first review had themselves never been reviewed, and
 * five of these are defects in those fixes rather than in the original.
 */
describe('the defects the second review found', () => {
  it('releases this process when it abandons a helper that will not die', async () => {
    // Measured, not reasoned. `ChildProcess.unref()` unrefs the process handle
    // and nothing else: the three piped stdio sockets keep their own libuv
    // refs, and removing a `data` listener pauses nothing. Reproduced outside
    // this suite — a parent that only detached and unref'd was still alive
    // after 3s, and one that destroyed the streams exited in 1ms.
    //
    // So the sinks are destroyed, not merely detached, and this case asserts
    // the destruction rather than the exit, which no in-process test can see.
    const boundary = fakeBoundary({ ignoreTermination: true });
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', timeoutMs: 20, terminationGraceMs: 30 },
      { start: boundary.start },
    );
    await boundary.established();
    const result = await run;
    expect(result.failureCode).toBe('BOUNDARY_TERMINATION_UNCONFIRMED');
    expect(boundary.streamsDestroyed()).toBe(true);
    boundary.finish({ childExitCode: null });
  });

  it('honours an abort even when the launch then ends in a refusal', async () => {
    // The half of the establishment window the first fix missed. The abort was
    // recorded, establishment finished — refused — and the refusal branch never
    // consulted the flag, so a cancelled run was reported as a refused launch,
    // which slice 3 maps to the runner's `SPAWN_FAILED`.
    const canceller = new AbortController();
    const boundary = fakeBoundary({
      onStart: () => canceller.abort(),
      refuseWith: {
        ending: 'BOUNDARY_REFUSED',
        failureCode: 'BOUNDARY_NOT_ESTABLISHED_IN_TIME',
        win32: null,
        targetStarted: 'UNKNOWN',
        status: null,
      },
    });
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', signal: canceller.signal, timeoutMs: 30_000 },
      { start: boundary.start },
    );
    expect(result.outcome).toBe('TERMINATED_BY_CALLER');
    expect(result.failureCode).toBe('TERMINATED_BY_CALLER');
    // The boundary's own evidence is kept rather than overwritten: both facts
    // are true, and the refusal is the one that says what may have run.
    expect(result.boundaryFailureCode).toBe('BOUNDARY_NOT_ESTABLISHED_IN_TIME');
    expect(result.targetStarted).toBe('UNKNOWN');
    expect(result.sideEffectsPossible).toBe(true);
  });

  it('reports a deadline that expired during establishment as a timeout', async () => {
    // `timeoutMs` is documented as the budget for the whole call, so a caller
    // reads its expiry as `TIMED_OUT`. The boundary can only report that it was
    // not established in time, and the first version passed that through as
    // `LAUNCH_REFUSED` — the runner's "could not be started" — for a command
    // whose wall clock had simply run out.
    const boundary = fakeBoundary({
      startDelayMs: 40,
      refuseWith: {
        ending: 'BOUNDARY_REFUSED',
        failureCode: 'BOUNDARY_NOT_ESTABLISHED_IN_TIME',
        win32: null,
        targetStarted: 'UNKNOWN',
        status: null,
      },
    });
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', timeoutMs: 10 },
      { start: boundary.start },
    );
    expect(result.outcome).toBe('TIMED_OUT');
    expect(result.failureCode).toBe('TIMEOUT');
    expect(result.boundaryFailureCode).toBe('BOUNDARY_NOT_ESTABLISHED_IN_TIME');
    expect(result.sideEffectsPossible).toBe(true);
  });

  it('keeps a refusal a refusal when the deadline had not expired', async () => {
    const boundary = fakeBoundary({
      refuseWith: {
        ending: 'BOUNDARY_REFUSED',
        failureCode: 'BOUNDARY_EXECUTABLE_MISSING',
        win32: null,
        targetStarted: 'NO',
        status: null,
      },
    });
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', timeoutMs: 30_000 },
      { start: boundary.start },
    );
    expect(result.outcome).toBe('LAUNCH_REFUSED');
    expect(result.sideEffectsPossible).toBe(false);
  });

  it('does not let an unusable grace collapse every termination into a loss', async () => {
    // `terminationGraceMs` is caller-supplied and was unvalidated. Node turns a
    // delay above the 32-bit maximum into 1ms, so asking for a *generous*
    // grace produced the opposite: the grace expired before any real boundary
    // could close, and every timeout, budget cut and cancellation came back as
    // `BOUNDARY_TERMINATION_UNCONFIRMED` with its working directory leaked.
    for (const graceMs of [3_000_000_000, -1, Number.NaN]) {
      const boundary = fakeBoundary({ terminationDelayMs: 30 });
      const result = await runOwnedCommand(
        { file: 'C:\\fixture.exe', timeoutMs: 10, terminationGraceMs: graceMs },
        { start: boundary.start },
      );
      expect(result.outcome, String(graceMs)).toBe('TIMED_OUT');
      expect(result.failureCode, String(graceMs)).toBe('TIMEOUT');
    }
  });

  it('fails closed on a termination reason this build does not declare', async () => {
    // The one function the module exists to make fail-closed was indexing two
    // maps with an unchecked key. A caller that is not type-checked against
    // this build — the `.mjs` harness, a JS consumer, slice 3 across a
    // serialisation boundary — got a frozen result with `outcome: undefined`:
    // neither a completion nor a declared failure, and nothing thrown.
    const ending: BoundaryEnding = { ending: 'CHILD_EXITED', childExitCode: 0, status: status() };
    const result = classifyOwnedCommand({
      ending,
      termination: 'LIMIT_STDIN' as unknown as (typeof OWNED_TERMINATIONS)[number],
    });
    expect(result.outcome).toBe('BOUNDARY_LOST');
    expect(result.failureCode).toBe('ENDING_INCONSISTENT');
    expect(OWNED_COMMAND_OUTCOMES).toContain(result.outcome);
  });

  it('reports FAILED for a payload that never reached a boundary with no stdin', async () => {
    // The streams-unavailable path knew, for free, that not one byte had been
    // handed over — and reported the weaker `UNCONFIRMED` by hand instead of
    // asking the classifier that owns this decision.
    const boundary = fakeBoundary({ noStreams: true, ignoreTermination: true });
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', stdin: 'the instructions', terminationGraceMs: 20 },
      { start: boundary.start },
    );
    expect(result.failureCode).toBe('BOUNDARY_STREAMS_UNAVAILABLE');
    expect(result.stdinDelivery).toBe('FAILED');
    boundary.finish({ childExitCode: null });
  });
});

describe('a helper that survived to report a child exit was not the reason a write failed', () => {
  const requested = { requested: true, established: true } as const;

  it('is FAILED when the boundary saw the child exit and this side still could not write', () => {
    // The correction to the correction. A broken local pipe usually means the
    // helper died, which says nothing about the child — but an ending that
    // carries the child's own exit code proves the helper lived long enough to
    // observe and publish it. The pipe therefore did not break because the
    // helper was gone: this side genuinely failed to hand the payload over,
    // and no end-of-file was ever forwarded. `runCommand` reports `FAILED` for
    // the same physical event, and slice 3 has to collapse the two.
    expect(
      classifyStdinDelivery({
        ...requested,
        localWrite: 'FAILED',
        forwarded: null,
        boundaryObservedChildExit: true,
      }),
    ).toBe('FAILED');
  });

  it('is still UNCONFIRMED when the boundary itself did not survive', () => {
    expect(
      classifyStdinDelivery({
        ...requested,
        localWrite: 'FAILED',
        forwarded: null,
        boundaryObservedChildExit: false,
      }),
    ).toBe('UNCONFIRMED');
  });

  it('never turns a survived boundary into a delivery it did not report', () => {
    expect(
      classifyStdinDelivery({
        ...requested,
        localWrite: 'FAILED',
        forwarded: 'EOF_FORWARDED',
        boundaryObservedChildExit: true,
      }),
    ).toBe('FAILED');
  });
});

/**
 * ── What the third adversarial review found ────────────────────────────────
 *
 * The round that caught the round-2 fixes. The worst of them is the first:
 * the override written to honour a cancellation during establishment was
 * applied to *every* ending on that path, including the one that means "we do
 * not know what happened to the tree".
 */
describe('the defects the third review found', () => {
  it('never lets a cancellation overwrite a lost boundary', () => {
    // Measured through the shipped artefact by the review: an abort raised
    // during establishment, with a helper killed in the same window, produced
    // `outcome: TERMINATED_BY_CALLER` carrying `boundaryLostReason:
    // STATUS_UNREADABLE` — the most benign word in the vocabulary over the
    // state that exists to prevent exactly that, and a self-contradictory
    // result besides.
    const lost: BoundaryEnding = {
      ending: 'BOUNDARY_LOST',
      reason: 'STATUS_UNREADABLE',
      status: null,
    };
    const result = classifyOwnedCommand({
      ending: lost,
      termination: 'NONE',
      cancelledBeforeOwnership: true,
    });
    expect(result.outcome).toBe('BOUNDARY_LOST');
    expect(result.failureCode).toBe('BOUNDARY_LOST');
    expect(result.boundaryLostReason).toBe('STATUS_UNREADABLE');
  });

  it('reports a cancellation that raced a refusal as a cancellation', () => {
    const refused: BoundaryEnding = {
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'BOUNDARY_NOT_ESTABLISHED_IN_TIME',
      win32: null,
      targetStarted: 'UNKNOWN',
      status: null,
    };
    const result = classifyOwnedCommand({
      ending: refused,
      termination: 'NONE',
      cancelledBeforeOwnership: true,
    });
    expect(result.outcome).toBe('TERMINATED_BY_CALLER');
    expect(result.failureCode).toBe('TERMINATED_BY_CALLER');
    // The boundary's evidence is kept: it is what says whether anything ran.
    expect(result.boundaryFailureCode).toBe('BOUNDARY_NOT_ESTABLISHED_IN_TIME');
    expect(result.boundaryLostReason).toBeNull();
    expect(result.targetStarted).toBe('UNKNOWN');
  });

  it('reports an expired deadline as a timeout only for the refusal that means it', () => {
    const notInTime: BoundaryEnding = {
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'BOUNDARY_NOT_ESTABLISHED_IN_TIME',
      win32: null,
      targetStarted: 'UNKNOWN',
      status: null,
    };
    expect(
      classifyOwnedCommand({ ending: notInTime, termination: 'NONE', deadlineExpired: true }),
    ).toMatchObject({ outcome: 'TIMED_OUT', failureCode: 'TIMEOUT' });

    // The half that had no test of its own. A permanent installation defect
    // must not become a retryable timeout just because a small budget happened
    // to expire while it was being discovered.
    const missing: BoundaryEnding = {
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'BOUNDARY_EXECUTABLE_MISSING',
      win32: null,
      targetStarted: 'NO',
      status: null,
    };
    expect(
      classifyOwnedCommand({ ending: missing, termination: 'NONE', deadlineExpired: true }),
    ).toMatchObject({ outcome: 'LAUNCH_REFUSED', failureCode: 'LAUNCH_REFUSED' });
  });

  it('lets an explicit cancellation outrank an expired deadline', () => {
    const notInTime: BoundaryEnding = {
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'BOUNDARY_NOT_ESTABLISHED_IN_TIME',
      win32: null,
      targetStarted: 'UNKNOWN',
      status: null,
    };
    expect(
      classifyOwnedCommand({
        ending: notInTime,
        termination: 'NONE',
        cancelledBeforeOwnership: true,
        deadlineExpired: true,
      }),
    ).toMatchObject({ outcome: 'TERMINATED_BY_CALLER' });
  });

  it('carries an abort during establishment through the classifier, not around it', async () => {
    // The run loop's half of the first case: a boundary that dies during
    // establishment while the caller is cancelling.
    const canceller = new AbortController();
    const boundary = fakeBoundary({
      onStart: () => canceller.abort(),
      refuseWith: { ending: 'BOUNDARY_LOST', reason: 'STATUS_UNREADABLE', status: null },
    });
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', signal: canceller.signal, timeoutMs: 30_000 },
      { start: boundary.start },
    );
    expect(result.outcome).toBe('BOUNDARY_LOST');
    expect(result.boundaryLostReason).toBe('STATUS_UNREADABLE');
  });

  it('reads a failed write as failed when the boundary lived to report the exit', async () => {
    // The wiring of the rule the second review asked for. It was pinned only
    // as a pure function: no end-to-end situation reached it, because the one
    // harness case that gets a failed write also gets a `BROKEN_PIPE` report,
    // which short-circuits three lines earlier. Hardcoding the flag to `false`
    // survived the whole suite.
    const boundary = fakeBoundary({ failStdin: true });
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', stdin: 'the instructions' },
      { start: boundary.start },
    );
    await boundary.established();
    boundary.finish({ childExitCode: 0 });
    const result = await run;
    expect(result.outcome).toBe('COMPLETED');
    expect(result.stdinDelivery).toBe('FAILED');
  });

  it('reads the boundary own proven read failure as a failure', () => {
    // `SOURCE_READ_FAILED` means the helper knows it stopped reading the
    // payload part-way. That is stronger evidence than `NO_CHANNEL`, which
    // already maps to FAILED — and it was falling through to the weakest word
    // the vocabulary has.
    expect(
      classifyStdinDelivery({
        requested: true,
        established: true,
        localWrite: 'COMPLETED',
        forwarded: 'SOURCE_READ_FAILED',
      }),
    ).toBe('FAILED');
  });

  it('does not hang or truncate on a budget that is not a number', async () => {
    // `terminationGraceMs` was validated in round 2 with the reasoning
    // "caller-supplied, and therefore checked". Its two siblings were not.
    //
    // `timeoutMs: NaN` is the shape a missing config value takes after
    // `parseInt`, and it is the worst of the three: the deadline becomes NaN,
    // the establishment budget with it, and `startOwnedProcess` polls a helper
    // that neither establishes nor exits — forever, with the abort listener not
    // yet armed to rescue it.
    for (const timeoutMs of [Number.NaN, -1]) {
      const boundary = fakeBoundary();
      const run = runOwnedCommand({ file: 'C:\\fixture.exe', timeoutMs }, { start: boundary.start });
      await boundary.established();
      boundary.stdout('output');
      boundary.finish({ childExitCode: 0 });
      const result = await run;
      expect(result.outcome, String(timeoutMs)).toBe('COMPLETED');
      expect(result.stdout, String(timeoutMs)).toBe('output');
    }

    // The milder sibling: a byte budget that is not a number cut every stream
    // off at its first byte, so every run reported an output-limit failure over
    // empty output.
    const boundary = fakeBoundary();
    const run = runOwnedCommand(
      { file: 'C:\\fixture.exe', maxStdoutBytes: Number.NaN, maxStderrBytes: -5 },
      { start: boundary.start },
    );
    await boundary.established();
    boundary.stdout('all of it');
    boundary.stderr('all of that too');
    boundary.finish({ childExitCode: 0 });
    const result = await run;
    expect(result.outcome).toBe('COMPLETED');
    expect(result.stdout).toBe('all of it');
    expect(result.stderr).toBe('all of that too');
    expect(result.stdoutTruncated).toBe(false);
  });

  it('does not raise on a stream that errors while being released', async () => {
    // The abandoned paths destroy the helper's streams, and the
    // streams-unavailable one does it before this module has attached its own
    // stdin error listener. An `EPIPE` there is an uncaught exception in *this*
    // process, which is exactly what that listener exists to prevent elsewhere.
    const boundary = fakeBoundary({ noStreams: true, ignoreTermination: true, errorOnRelease: true });
    const result = await runOwnedCommand(
      { file: 'C:\\fixture.exe', stdin: 'the instructions', terminationGraceMs: 20 },
      { start: boundary.start },
    );
    expect(result.failureCode).toBe('BOUNDARY_STREAMS_UNAVAILABLE');
    // A tick for any deferred `error` emission to land where it would throw.
    await new Promise((done) => setTimeout(done, 20));
    boundary.finish({ childExitCode: null });
  });
});

/**
 * ── What the fourth adversarial review found ───────────────────────────────
 *
 * The round that caught the round-3 fix. Round 3 moved the two
 * establishment-time facts *into* the classifier, which was right, and put
 * them in one branch, which was not: paired with any other ending they were
 * ignored, and the pair that means "never established" plus "the boundary owned
 * a child and saw it exit" fell through to `COMPLETED`.
 */
describe('the defects the fourth review found', () => {
  it('never completes a launch the caller says never established ownership', () => {
    // Measured through the shipped artefact by the review: an abort during
    // establishment paired with a `CHILD_EXITED` ending returned
    // `outcome: COMPLETED, established: false, stdout: ''` — a completion whose
    // own result says the launch never happened and whose output is empty
    // because no sink was ever attached to read it.
    const exited: BoundaryEnding = { ending: 'CHILD_EXITED', childExitCode: 0, status: status() };
    for (const stated of [{ cancelledBeforeOwnership: true }, { ownershipEstablished: false }]) {
      const result = classifyOwnedCommand({ ending: exited, termination: 'NONE', ...stated });
      expect(result.outcome, JSON.stringify(stated)).toBe('BOUNDARY_LOST');
      expect(result.failureCode, JSON.stringify(stated)).toBe('ENDING_INCONSISTENT');
    }
  });

});

/**
 * ── What the fifth adversarial review found ────────────────────────────────
 *
 * The round that caught the round-4 fix. Both of these are defects in that
 * fix, not in the original: one grouped a fact with two others it does not
 * belong with, the other let a value through on a delay that may not have it.
 */
describe('the defects the fifth review found', () => {
  it('does not read an expired clock as a statement about ownership', () => {
    // The round-4 fix folded `deadlineExpired` in beside the two facts that do
    // deny ownership. A clock running out says nothing about whether the
    // boundary owned anything — and the pairing it broke is the most common
    // non-success AO has: an ordinary timeout on an established run came back
    // as a lost boundary with `ENDING_INCONSISTENT` and no exit code, which is
    // the word for "we do not know what happened to the tree" over the one case
    // where it is known exactly.
    const exited: BoundaryEnding = { ending: 'CHILD_EXITED', childExitCode: 4, status: status() };
    expect(
      classifyOwnedCommand({
        ending: exited,
        termination: 'NONE',
        ownershipEstablished: true,
        deadlineExpired: true,
      }),
    ).toMatchObject({ outcome: 'COMPLETED', exitCode: 4 });

    const terminated: BoundaryEnding = { ending: 'TERMINATED_BY_CALLER', status: status() };
    expect(
      classifyOwnedCommand({
        ending: terminated,
        termination: 'TIMEOUT',
        ownershipEstablished: true,
        deadlineExpired: true,
      }),
    ).toMatchObject({ outcome: 'TIMED_OUT', failureCode: 'TIMEOUT' });
  });

  it('never refuses a launch that had already established ownership', () => {
    // Reachable: node emits `error` on a ChildProcess when a *kill* fails, not
    // only when a spawn does, and `startOwnedProcess` turns that into
    // `BOUNDARY_HELPER_SPAWN_FAILED` — for a run whose ownership it had already
    // reported. The result said `outcome: LAUNCH_REFUSED` beside
    // `established: true`, and then removed the working directory of a helper
    // that may still have been writing its status into it.
    const refused: BoundaryEnding = {
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'BOUNDARY_HELPER_SPAWN_FAILED',
      win32: null,
      targetStarted: 'NO',
      status: null,
    };
    const result = classifyOwnedCommand({
      ending: refused,
      termination: 'NONE',
      ownershipEstablished: true,
    });
    expect(result.outcome).toBe('BOUNDARY_LOST');
    expect(result.failureCode).toBe('ENDING_INCONSISTENT');
    // And the conservative direction on the question that decides cleanup.
    expect(result.sideEffectsPossible).toBe(true);
  });

  it(
    'falls back to a real grace when asked for one that never expires',
    async () => {
      // Round 4 split the validators and let `Infinity` through on every delay.
      // On a timeout that is a caller saying "effectively never", which is
      // legitimate; on the grace it removes the only bound on a helper that has
      // already ignored its own kill, and `runOwnedCommand` never resolves.
      //
      // Measured rather than asserted about a helper: this case costs the
      // default grace, because that is the value under test.
      const boundary = fakeBoundary({ ignoreTermination: true });
      const startedAt = Date.now();
      const result = await runOwnedCommand(
        { file: 'C:\\fixture.exe', timeoutMs: 20, terminationGraceMs: Number.POSITIVE_INFINITY },
        { start: boundary.start },
      );
      expect(result.failureCode).toBe('BOUNDARY_TERMINATION_UNCONFIRMED');
      // The default, not the largest expressible timer.
      expect(Date.now() - startedAt).toBeLessThan(DEFAULT_TERMINATION_GRACE_MS * 3);
      boundary.finish({ childExitCode: null });
    },
    20_000,
  );

  it('completes exactly one shape across the whole product of its inputs', () => {
    // The enumeration the module header claims, and this is the second attempt
    // at it: the first crossed seven hand-picked combinations of the three
    // establishment facts out of the twenty-seven that exist, which is how a
    // `COMPLETED` hid in the rest for a round. Every field now takes every
    // value it can, including an explicit `false`.
    const tri = [undefined, true, false];
    let rows = 0;
    const completed: string[] = [];
    for (const { name, ending } of ENDINGS) {
      for (const termination of OWNED_TERMINATIONS) {
        for (const ownershipEstablished of tri) {
          for (const cancelledBeforeOwnership of tri) {
            for (const deadlineExpired of tri) {
              rows += 1;
              // Spread rather than assigned: under `exactOptionalPropertyTypes`
              // an explicit `undefined` is a different thing from an absent
              // property, and "absent" is one of the three states this crosses.
              const result = classifyOwnedCommand({
                ending,
                termination,
                ...(ownershipEstablished === undefined ? {} : { ownershipEstablished }),
                ...(cancelledBeforeOwnership === undefined ? {} : { cancelledBeforeOwnership }),
                ...(deadlineExpired === undefined ? {} : { deadlineExpired }),
              });
              const where = `${name} × ${termination} × ${String(ownershipEstablished)}/${String(
                cancelledBeforeOwnership,
              )}/${String(deadlineExpired)}`;
              expect(OWNED_COMMAND_OUTCOMES, where).toContain(result.outcome);
              // Shape, on every row: a completion carries no failure code, and
              // only a lost boundary may name a reason it was lost.
              if (result.outcome === 'COMPLETED') {
                expect(result.failureCode, where).toBeNull();
                completed.push(where);
              }
              if (result.outcome !== 'BOUNDARY_LOST') {
                expect(result.boundaryLostReason, where).toBeNull();
              }
              expect(result.sideEffectsPossible, where).toBe(result.targetStarted !== 'NO');
            }
          }
        }
      }
    }
    expect(rows).toBe(ENDINGS.length * OWNED_TERMINATIONS.length * 27);

    // Every completion, and there is exactly one shape of them: the boundary
    // observed a child exit, no policy terminated it, and nothing said
    // ownership was never established. An expired clock does not appear —
    // deliberately, since it says nothing about ownership.
    const expected: string[] = [];
    for (const { name, ending } of ENDINGS) {
      if (ending.ending !== 'CHILD_EXITED') continue;
      for (const ownershipEstablished of [undefined, true]) {
        for (const cancelledBeforeOwnership of [undefined, false]) {
          for (const deadlineExpired of tri) {
            expected.push(
              `${name} × NONE × ${String(ownershipEstablished)}/${String(
                cancelledBeforeOwnership,
              )}/${String(deadlineExpired)}`,
            );
          }
        }
      }
    }
    expect(completed.sort()).toEqual(expected.sort());
  });

  it('keeps an unbounded budget unbounded', async () => {
    // `Infinity` is a usable byte budget and a usable delay; round 3's single
    // validator folded both into the default because `Number.isFinite` is false
    // for it. The consequence on a byte budget was not merely a smaller cap: a
    // caller that had explicitly disabled the limit got
    // `OUTPUT_LIMIT_EXCEEDED` — and the job object terminated with it.
    const boundary = fakeBoundary();
    const run = runOwnedCommand(
      {
        file: 'C:\\fixture.exe',
        maxStdoutBytes: Number.POSITIVE_INFINITY,
        timeoutMs: Number.POSITIVE_INFINITY,
      },
      { start: boundary.start },
    );
    await boundary.established();
    boundary.stdout('x'.repeat(4_000_000));
    boundary.finish({ childExitCode: 0 });
    const result = await run;
    expect(result.outcome).toBe('COMPLETED');
    expect(result.stdout.length).toBe(4_000_000);
    expect(result.stdoutTruncated).toBe(false);
    expect(boundary.terminations()).toBe(0);
  });

});
