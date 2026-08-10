/**
 * V1-06 — running a repository's declared verification phases.
 *
 * The property under test is a conjunction that cannot be satisfied by silence:
 * `PASSED` requires every declared phase to have *run* and exited 0. A missing
 * phase list, a phase that never started, and a phase killed from outside are
 * each `UNAVAILABLE`, which is a different answer from `FAILED` and sends an
 * operator somewhere different.
 */

import { describe, expect, it } from 'vitest';

import type { ResolvedVerificationPolicy } from '../src/repo/resolve-repository.js';
import { runVerification } from '../src/verify/run-verification.js';
import type { VerificationCommandResult, VerificationRunner } from '../src/verify/verify-command.js';

const WORKTREE = process.platform === 'win32' ? 'C:/work/task' : '/work/task';

function policy(...phases: ('BUILD' | 'TEST' | 'VERIFY')[]): ResolvedVerificationPolicy {
  return {
    phases: phases.map((phase) => ({ phase, command: ['npm', 'run', phase.toLowerCase()] })),
  };
}

function seam(results: Partial<VerificationCommandResult>[]) {
  const calls: string[] = [];
  let index = 0;
  const runner: VerificationRunner = async (command, args) => {
    calls.push([command, ...args].join(' '));
    const overrides = results[Math.min(index, results.length - 1)] ?? {};
    index += 1;
    return {
      outcome: 'RAN',
      exitCode: 0,
      signal: null,
      stdout: '',
      stderr: '',
      outputTruncated: false,
      failureCode: null,
      errnoCode: null,
      durationMs: 1,
      ...overrides,
    };
  };
  return { runner, calls };
}

describe('runVerification', () => {
  it('passes only when every declared phase ran and exited 0', async () => {
    const run = seam([{ exitCode: 0 }]);

    const report = await runVerification(
      { worktreePath: WORKTREE, verification: policy('BUILD', 'TEST', 'VERIFY') },
      { verify: run.runner },
    );

    expect(report.verdict).toBe('PASSED');
    expect(report.stoppedAt).toBeNull();
    expect(report.phases.map((p) => p.phase)).toEqual(['BUILD', 'TEST', 'VERIFY']);
    // Declaration order is the profile's statement of dependency.
    expect(run.calls).toEqual(['npm run build', 'npm run test', 'npm run verify']);
  });

  /**
   * Running `TEST` after `BUILD` failed would measure a tree that was never
   * built, so the run stops at the first phase that does not pass.
   */
  it('stops at the first failing phase and names it', async () => {
    const run = seam([{ exitCode: 1, stdout: 'build broke' }]);

    const report = await runVerification(
      { worktreePath: WORKTREE, verification: policy('BUILD', 'TEST', 'VERIFY') },
      { verify: run.runner },
    );

    expect(report.verdict).toBe('FAILED');
    expect(report.stoppedAt).toBe('BUILD');
    expect(report.phases).toHaveLength(1);
    expect(run.calls).toEqual(['npm run build']);
  });

  it.each([
    ['a process that never started', { outcome: 'UNAVAILABLE' as const, exitCode: null }],
    ['a run killed from outside', { outcome: 'UNAVAILABLE' as const, exitCode: null, signal: 'SIGKILL' as const }],
    ['a refused argv', { outcome: 'REFUSED_UNSAFE_ARGUMENT' as const, exitCode: null }],
  ])('reports %s as UNAVAILABLE rather than FAILED', async (_label, overrides) => {
    const run = seam([overrides]);

    const report = await runVerification(
      { worktreePath: WORKTREE, verification: policy('VERIFY') },
      { verify: run.runner },
    );

    expect(report.verdict).toBe('UNAVAILABLE');
    expect(report.stoppedAt).toBe('VERIFY');
  });

  /** A gate that can be satisfied by the absence of evidence is not a gate. */
  it('does not read an empty phase list as a pass', async () => {
    const report = await runVerification(
      { worktreePath: WORKTREE, verification: { phases: [] } },
      { verify: seam([{}]).runner },
    );

    expect(report.verdict).toBe('UNAVAILABLE');
    expect(report.phases).toEqual([]);
  });

  /**
   * The failing phase's output is the evidence a human needs, so it is kept —
   * bounded and redacted, through the same excerpting the agent boundaries use,
   * rather than a second copy of it.
   */
  it('carries the failing phase output, redacted and marked untrusted', async () => {
    const run = seam([
      { exitCode: 1, stdout: 'contact m4xd4b0zz@googlemail.com', stderr: 'boom' },
    ]);

    const report = await runVerification(
      { worktreePath: WORKTREE, verification: policy('VERIFY') },
      { verify: run.runner },
    );

    expect(report.diagnostics.trusted).toBe(false);
    expect(report.diagnostics.stdoutExcerpt).toContain('<redacted:email>');
    expect(report.diagnostics.stdoutExcerpt).not.toContain('m4xd4b0zz');
    expect(report.diagnostics.stderrExcerpt).toBe('boom');
  });

  it('carries no output at all from a run that passed', async () => {
    const report = await runVerification(
      { worktreePath: WORKTREE, verification: policy('VERIFY') },
      { verify: seam([{ exitCode: 0, stdout: 'lots of noise' }]).runner },
    );

    expect(report.verdict).toBe('PASSED');
    expect(report.diagnostics.stdoutExcerpt).toBe('');
  });

  it('does not retry a phase that failed', async () => {
    const run = seam([{ exitCode: 1 }]);

    await runVerification(
      { worktreePath: WORKTREE, verification: policy('VERIFY') },
      { verify: run.runner },
    );

    expect(run.calls).toHaveLength(1);
  });
});
