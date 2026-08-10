/**
 * V1-05 — the agent execution seam, and the payload channel it depends on.
 *
 * Most of this slice is deliberately testable without a process, and is tested
 * that way. This file covers the part that cannot be: the claim that
 * instructions handed to `runCommand` as `stdin` actually arrive at a child.
 * That claim is load-bearing — it is the entire reason the writer's prompt is
 * not an argument — and a fake runner cannot support it, so a real `node`
 * child is used, exactly as `tests/exec.test.ts` does for its own claims.
 *
 * No real `claude` or `codex` is started anywhere in this suite. The evidence
 * that those two read stdin is documented, with the observed output, in
 * `src/agent/agent-command.ts`; what is verified here is that this repository
 * delivers on the channel they read from.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  AGENT_COMMAND_MAX_OUTPUT_BYTES,
  AGENT_COMMAND_TIMEOUT_MS,
  toAgentCommandResult,
} from '../src/agent/agent-command.js';
import { probeEnvAllowlist } from '../src/auth/env-guard.js';
import { isShellInertArgument, runCommand } from '../src/doctor/exec.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import { ExecArtifactRegistry } from './helpers/exec-cleanup.js';
import { commandResult } from './fixtures.js';

const registry = new ExecArtifactRegistry();

afterAll(async () => {
  await registry.cleanUp();
});

/** A child that reports back exactly what it was given on stdin. */
function writeEchoScript(): string {
  const dir = registry.registerTempDir(makeCanonicalTempDir('ao-agentcmd-'));
  const script = join(dir, 'echo-stdin.cjs');
  writeFileSync(
    script,
    [
      "let buffered = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { buffered += chunk; });",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ received: buffered }));",
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return script;
}

/** A child that exits at once without ever reading its input. */
function writeIgnoreScript(): string {
  const dir = registry.registerTempDir(makeCanonicalTempDir('ao-agentcmd-'));
  const script = join(dir, 'ignore-stdin.cjs');
  writeFileSync(script, "process.stdout.write('done');\n", 'utf8');
  return script;
}

describe('the payload channel', () => {
  it('delivers the payload to a real child process', async () => {
    const script = writeEchoScript();
    expect(isShellInertArgument(script)).toBe(true);

    const payload = 'Implement the task.\nIt has "quotes", & a pipe |, and a % sign.\n';
    const result = await runCommand('node', [script], { env: process.env, stdin: payload });

    expect(result.outcome).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ received: payload });
  });

  /**
   * The characters that make a payload impossible to express as an argument in
   * the first place — `SAFE_ARG_PATTERN` excludes every one of them — must
   * survive the channel that replaces it, byte for byte and unescaped. If they
   * did not, the writer's instructions would be silently rewritten.
   */
  it('delivers shell metacharacters unaltered, having never put them on a command line', async () => {
    const script = writeEchoScript();
    const payload = '^ & | < > ( ) % ! " \' ` $ \\ ;';

    const result = await runCommand('node', [script], { env: process.env, stdin: payload });

    expect(JSON.parse(result.stdout).received).toBe(payload);
    // And the argument vector really did stay inert: nothing of the payload
    // was smuggled into it.
    for (const arg of result.args) expect(isShellInertArgument(arg)).toBe(true);
  });

  it('closes the input so a child waiting for end-of-file finishes', async () => {
    const script = writeEchoScript();

    const result = await runCommand('node', [script], { env: process.env, stdin: '' });

    // The child settles on `end`, which only arrives because the stream was
    // ended rather than merely written to.
    expect(result.outcome).toBe('COMPLETED');
    expect(JSON.parse(result.stdout)).toEqual({ received: '' });
  });

  /**
   * A child that exits without draining its input breaks the pipe. That is a
   * fact about the child, answered by the result the child produced — not a
   * reason to reject a promise on a path whose whole contract is that failures
   * are data.
   */
  it('reports a child that ignored its input as data, never as a thrown error', async () => {
    const script = writeIgnoreScript();
    const payload = 'x'.repeat(1_000_000);

    const result = await runCommand('node', [script], { env: process.env, stdin: payload });

    expect(result.outcome).toBe('COMPLETED');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('done');
  });

  it('leaves a command without a payload on the historical ignored input', async () => {
    const script = writeEchoScript();

    const result = await runCommand('node', [script], { env: process.env });

    // `'ignore'` gives the child an immediate end-of-file, so it still
    // finishes — and it received nothing, which is what every diagnostic probe
    // in this repository has always seen.
    expect(result.outcome).toBe('COMPLETED');
    expect(JSON.parse(result.stdout)).toEqual({ received: '' });
  });
});

describe('translating a command result for an agent run', () => {
  it('reports a clean completion as a run', () => {
    const translated = toAgentCommandResult(
      commandResult({ stdout: 'out', stderr: 'err', exitCode: 0 }),
    );

    expect(translated.outcome).toBe('RAN');
    expect(translated.stdout).toBe('out');
    expect(translated.stderr).toBe('err');
    expect(translated.outputTruncated).toBe(false);
  });

  it('reports a non-zero exit as a run, because the process still answered', () => {
    const translated = toAgentCommandResult(commandResult({ exitCode: 7, stdout: 'partial' }));

    expect(translated.outcome).toBe('RAN');
    expect(translated.exitCode).toBe(7);
    expect(translated.stdout).toBe('partial');
  });

  it.each(['TIMED_OUT', 'OUTPUT_LIMIT_EXCEEDED', 'NOT_FOUND', 'SPAWN_FAILED'] as const)(
    'reports a %s command as unavailable and carries none of its output',
    (outcome) => {
      const translated = toAgentCommandResult(
        commandResult({ outcome, stdout: 'looks like a result', stderr: 'noise' }),
      );

      expect(translated.outcome).toBe('UNAVAILABLE');
      // A process that did not end under its own control has said nothing this
      // slice is entitled to read, so there is nothing to read.
      expect(translated.stdout).toBe('');
      expect(translated.stderr).toBe('');
    },
  );

  /**
   * Truncation is folded in here rather than left for each boundary to
   * remember. Forgetting it is the cheapest way to turn a stream cut at its
   * byte budget — which can still end on a closing brace and parse — into a
   * verdict.
   */
  it.each([
    ['stdout', { stdoutTruncated: true }],
    ['stderr', { stderrTruncated: true }],
  ])('reports a run whose %s was truncated as unavailable', (_stream, overrides) => {
    const translated = toAgentCommandResult(
      commandResult({ ...overrides, stdout: '{"type":"result"}' }),
    );

    expect(translated.outcome).toBe('UNAVAILABLE');
    expect(translated.outputTruncated).toBe(true);
    expect(translated.stdout).toBe('');
  });

  /**
   * A child killed by something outside this process is reported by
   * `runCommand` as a completion — nothing here issued the termination — with
   * a null exit code and a signal. The seam preserves the signal so a boundary
   * can refuse it; dropping it would leave the exit code as the only evidence,
   * and it is `null`.
   */
  it('preserves the signal that ended a child it did not kill', () => {
    const translated = toAgentCommandResult(
      commandResult({ exitCode: null, signal: 'SIGKILL', stdout: 'half a result' }),
    );

    expect(translated.outcome).toBe('RAN');
    expect(translated.signal).toBe('SIGKILL');
    expect(translated.exitCode).toBeNull();
  });
});

describe('the budgets an agent run is given', () => {
  it('bounds wall clock and output', () => {
    expect(Number.isFinite(AGENT_COMMAND_TIMEOUT_MS)).toBe(true);
    expect(AGENT_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(AGENT_COMMAND_MAX_OUTPUT_BYTES)).toBe(true);
    expect(AGENT_COMMAND_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
  });

  it('starts each agent with the profile root it needs and no credential', () => {
    for (const policy of ['agent:claude', 'agent:codex'] as const) {
      expect([...probeEnvAllowlist(policy)].sort()).toEqual(
        ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE'].sort(),
      );
    }
  });
});
