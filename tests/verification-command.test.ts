import { describe, expect, it } from 'vitest';

import {
  toVerificationCommandResult,
  VERIFICATION_COMMAND_MAX_OUTPUT_BYTES,
  VERIFICATION_COMMAND_TIMEOUT_MS,
} from '../src/verify/verify-command.js';

import { commandResult } from './fixtures.js';

/**
 * The seam that turns one `CommandResult` into the verification vocabulary.
 *
 * Tested through the pure translator rather than by spawning, exactly as
 * `tests/agent-command.test.ts` tests `toAgentCommandResult`: the endings that
 * matter here — a timeout, a child killed from outside, a flooded output
 * budget — are the ones no real command can be asked to produce on demand.
 */
describe('toVerificationCommandResult', () => {
  it('reports a completed run as RAN and carries its exit code', () => {
    const result = toVerificationCommandResult(commandResult({ exitCode: 0, stdout: 'ok' }));

    expect(result.outcome).toBe('RAN');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('ok');
  });

  /**
   * The difference from the agent seam, and the reason this module exists at
   * all: a non-zero exit is the *answer* here, not a broken tool. Its output is
   * the evidence a human needs to see why verification failed, so unlike
   * `git-command.ts` — which discards stdout on a non-zero exit — it is kept.
   */
  it('keeps the output of a failing run, because that output is the evidence', () => {
    const result = toVerificationCommandResult(
      commandResult({ exitCode: 1, stdout: 'FAIL src/a.ts', stderr: 'boom' }),
    );

    expect(result.outcome).toBe('RAN');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('FAIL src/a.ts');
    expect(result.stderr).toBe('boom');
  });

  it.each(['TIMED_OUT', 'OUTPUT_LIMIT_EXCEEDED', 'NOT_FOUND', 'SPAWN_FAILED'] as const)(
    'reports %s as UNAVAILABLE, carrying no output',
    (outcome) => {
      const result = toVerificationCommandResult(
        commandResult({ outcome, exitCode: null, stdout: 'partial', stderr: 'partial' }),
      );

      expect(result.outcome).toBe('UNAVAILABLE');
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    },
  );

  /**
   * The V1-05-RR-F1 rule, restated for a non-agent process. `runCommand`
   * reports a child killed by something *outside* this process as an ordinary
   * completion, because nothing here issued the termination — so a verification
   * run that was SIGKILLed arrives with `outcome: 'COMPLETED'` and a `null` exit
   * code. Reading the exit code alone would call that a pass or a failure; it
   * is neither, because the command never reached its own verdict.
   */
  it('does not treat a run killed from outside as a verdict', () => {
    const result = toVerificationCommandResult(
      commandResult({ outcome: 'COMPLETED', exitCode: null, signal: 'SIGKILL' }),
    );

    expect(result.outcome).toBe('UNAVAILABLE');
    expect(result.signal).toBe('SIGKILL');
  });

  /**
   * Truncation is recorded but is deliberately *not* fatal here, and this is
   * the one place the verification seam is more permissive than the agent one.
   *
   * For an agent the output *is* the result, so a cut-off stream cannot be
   * parsed into a verdict. For verification the **exit code** is the result and
   * the output is only diagnostics: a build that failed and printed four
   * megabytes doing so still failed. Discarding that verdict would convert a
   * real failure into "we learned nothing".
   */
  it('records truncation without discarding the verdict', () => {
    const result = toVerificationCommandResult(
      commandResult({ exitCode: 1, stdoutTruncated: true, stdout: 'lots' }),
    );

    expect(result.outcome).toBe('RAN');
    expect(result.exitCode).toBe(1);
    expect(result.outputTruncated).toBe(true);
  });

  it('carries the diagnostic facts a failed run is described by', () => {
    const result = toVerificationCommandResult(
      commandResult({
        outcome: 'NOT_FOUND',
        exitCode: null,
        failureCode: 'EXECUTABLE_NOT_FOUND',
        errnoCode: 'ENOENT',
        durationMs: 12,
      }),
    );

    expect(result.failureCode).toBe('EXECUTABLE_NOT_FOUND');
    expect(result.errnoCode).toBe('ENOENT');
    expect(result.durationMs).toBe(12);
  });

  it('bounds one verification run in wall clock and in bytes', () => {
    expect(VERIFICATION_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(VERIFICATION_COMMAND_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
  });
});
