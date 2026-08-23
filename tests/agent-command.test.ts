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

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  AGENT_COMMAND_MAX_STDERR_BYTES,
  AGENT_COMMAND_TIMEOUT_MS,
  CLAUDE_WRITER_MAX_STDOUT_BYTES,
  CODEX_REVIEWER_MAX_STDOUT_BYTES,
  maxStdoutBytesFor,
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

/**
 * A child shaped like an agent that was cut off mid-prompt: it reads a bounded
 * prefix of its instructions, closes its read end at the OS level, then prints
 * a well-formed result and exits 0.
 *
 * This is the shape that masks the defect. Every process-level fact is
 * pristine — clean exit, no signal, nothing truncated, parseable output — and
 * the only thing wrong with the run is that the agent never saw most of what it
 * was asked to do.
 *
 * Determinism comes from the payload size rather than from timing: once the
 * payload exceeds the OS pipe buffer, the write *cannot* complete unless the
 * child keeps reading, so closing the read end makes the failure certain
 * whoever wins the start-up race. No sleep, and no handshake, is involved.
 */
function writeHalfReadingScript(prefixBytes: number): string {
  const dir = registry.registerTempDir(makeCanonicalTempDir('ao-agentcmd-'));
  const script = join(dir, 'half-reading.cjs');
  writeFileSync(
    script,
    [
      "const fs = require('fs');",
      'let read = 0;',
      "process.stdin.on('data', (chunk) => {",
      '  read += chunk.length;',
      `  if (read < ${prefixBytes}) return;`,
      '  process.stdin.pause();',
      '  try { fs.closeSync(0); } catch {}',
      "  process.stdout.write(JSON.stringify({ type: 'result', bytesRead: read }));",
      '  process.exit(0);',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
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
    // Still data and still not a thrown error — but no longer silent
    // (V1-05-RR-F5). The child ended before the payload could be handed over,
    // and that is now recorded rather than discarded.
    expect(result.stdinDelivery).toBe('FAILED');
  });

  it('leaves a command without a payload on the historical ignored input', async () => {
    const script = writeEchoScript();

    const result = await runCommand('node', [script], { env: process.env });

    // `'ignore'` gives the child an immediate end-of-file, so it still
    // finishes — and it received nothing, which is what every diagnostic probe
    // in this repository has always seen.
    expect(result.outcome).toBe('COMPLETED');
    expect(JSON.parse(result.stdout)).toEqual({ received: '' });
    // No payload was configured, so there is nothing to have delivered. This is
    // the value every diagnostic probe in the repository reports.
    expect(result.stdinDelivery).toBe('NOT_REQUESTED');
  });

  it.each([
    ['an ordinary payload', 'Implement the task.'],
    ['an empty payload', ''],
  ])('records delivery of %s that the child fully received', async (_label, payload) => {
    const script = writeEchoScript();

    const result = await runCommand('node', [script], { env: process.env, stdin: payload });

    expect(result.stdinDelivery).toBe('DELIVERED');
    expect(JSON.parse(result.stdout)).toEqual({ received: payload });
  });
});

// ── Delivery of the payload ────────────────────────────────────────────────

/**
 * V1-05-RR-F5.
 *
 * The prompt is the entire instruction to the agent. A run that received a
 * fraction of it is not a run of the task that was asked for — but every
 * process-level fact about it is clean, so nothing above this seam can tell.
 * `runCommand` used to attach an empty `'error'` listener to the child's stdin
 * and discard whatever it caught, which is the only place the truth existed.
 *
 * What is claimed here is precise, and deliberately not more: that a delivery
 * failure **Node reported** is never thrown away. It is not a claim that the
 * child consumed the bytes — a payload below the OS pipe buffer is absorbed
 * whole even by a child that has already exited, and no parent-side observation
 * can see that. The bound is on what we can know, not on what we would like to.
 */
describe('a payload that could not be delivered', () => {
  it('records the failure when the child closes its input mid-prompt', async () => {
    const prefixBytes = 32_768;
    const script = writeHalfReadingScript(prefixBytes);
    const payload = 'P'.repeat(1_048_576);

    const result = await runCommand('node', [script], { env: process.env, stdin: payload });

    // The premise, from the child's own mouth: it really did receive only a
    // fraction of the prompt, and it really did exit cleanly anyway.
    expect(JSON.parse(result.stdout).bytesRead).toBeLessThan(payload.length);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdoutTruncated).toBe(false);

    // And the fact that used to be swallowed is now on the result.
    expect(result.stdinDelivery).toBe('FAILED');
  });

  /**
   * The consequence, which is the half that matters. A clean exit and a
   * parseable result must not outrank a known delivery failure: the seam erases
   * the output exactly as it does for a truncated stream, so no boundary above
   * it is ever offered the bytes to classify.
   */
  it('is not rescued by a clean exit and a well-formed result', async () => {
    const script = writeHalfReadingScript(32_768);
    const payload = 'P'.repeat(1_048_576);

    const result = await runCommand('node', [script], { env: process.env, stdin: payload });
    const translated = toAgentCommandResult(result);

    expect(translated.outcome).toBe('UNAVAILABLE');
    expect(translated.stdout).toBe('');
  });

  it('does not reject the promise for a broken pipe', async () => {
    const script = writeHalfReadingScript(32_768);

    await expect(
      runCommand('node', [script], { env: process.env, stdin: 'P'.repeat(1_048_576) }),
    ).resolves.toBeDefined();
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

  /**
   * Folded in beside truncation, and for the same reason: both are facts about
   * the *channel* rather than about the process, both leave a perfectly clean
   * exit code behind, and both mean the bytes on stdout answer a different
   * question than the one that was asked.
   */
  it.each(['FAILED', 'UNCONFIRMED'] as const)(
    'reports a %s payload delivery as unavailable and carries none of its output',
    (stdinDelivery) => {
      const translated = toAgentCommandResult(
        commandResult({ stdinDelivery, stdout: 'looks like a result', exitCode: 0 }),
      );

      expect(translated.outcome).toBe('UNAVAILABLE');
      expect(translated.stdout).toBe('');
    },
  );

  it.each(['DELIVERED', 'NOT_REQUESTED'] as const)(
    'reports a %s payload delivery as an ordinary run',
    (stdinDelivery) => {
      const translated = toAgentCommandResult(
        commandResult({ stdinDelivery, stdout: 'out', exitCode: 0 }),
      );

      expect(translated.outcome).toBe('RAN');
      expect(translated.stdout).toBe('out');
    },
  );

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
    expect(Number.isFinite(CLAUDE_WRITER_MAX_STDOUT_BYTES)).toBe(true);
    expect(Number.isFinite(CODEX_REVIEWER_MAX_STDOUT_BYTES)).toBe(true);
    expect(Number.isFinite(AGENT_COMMAND_MAX_STDERR_BYTES)).toBe(true);
    expect(AGENT_COMMAND_MAX_STDERR_BYTES).toBeGreaterThan(0);
  });

  /**
   * The exact figures, because "finite and positive" is not a budget.
   *
   * A review of the merged slice raised both named mutants against the old
   * shape of this case and neither died: setting the stdout budget to
   * `8_388_609` satisfied finite, positive and greater-than-stderr, and so did
   * swapping the two constants at the wiring site. A budget that only has to be
   * bigger than another budget is not pinned.
   */
  it('pins each stdout budget to its figure', () => {
    expect(CLAUDE_WRITER_MAX_STDOUT_BYTES).toBe(67_108_864);
    expect(CODEX_REVIEWER_MAX_STDOUT_BYTES).toBe(8_388_608);
    expect(AGENT_COMMAND_MAX_STDERR_BYTES).toBe(8_388_608);
  });

  /**
   * The two agents do **not** share a stdout budget, and that is a control
   * boundary rather than a tuning detail.
   *
   * V3-11 raised one shared constant for the Claude writer's new `stream-json`
   * transcript, and the Codex reviewer's reading window went up eightfold with
   * it. That moved when a human is required: a `codex exec --json` transcript
   * between 8 and 64 MiB used to exceed the budget and become
   * `AGENT_PROCESS_UNAVAILABLE` — a human read the review — and afterwards it
   * was read in full and could advance a task unattended. Nothing argued for
   * that, so this case exists to make the next raise argue for itself.
   */
  it('gives the reviewer a smaller stdout budget than the writer, by agent', () => {
    expect(maxStdoutBytesFor('claude')).toBe(CLAUDE_WRITER_MAX_STDOUT_BYTES);
    expect(maxStdoutBytesFor('codex')).toBe(CODEX_REVIEWER_MAX_STDOUT_BYTES);
    expect(maxStdoutBytesFor('codex')).toBeLessThan(maxStdoutBytesFor('claude'));
  });

  /**
   * The size that separates them — and this case is **arithmetic**, not a seam
   * test, which is why it is named for what it computes.
   *
   * It evaluates `8_388_608 < 16_777_216 < 67_108_864` and invokes nothing. It
   * is here because a 16 MiB transcript is ordinary for a writing pass and over
   * the reviewer's ceiling, so the gap between the two constants is the thing
   * with a consequence; but a reader must not mistake it for evidence that the
   * seam behaves that way. The seam behaviour is
   * `toAgentCommandResult`'s truncation handling, covered separately.
   */
  it('places 16 MiB between the two constants, by arithmetic', () => {
    const sixteenMiB = 16 * 1024 * 1024;
    expect(sixteenMiB).toBeLessThan(maxStdoutBytesFor('claude'));
    expect(sixteenMiB).toBeGreaterThan(maxStdoutBytesFor('codex'));
  });

  /**
   * The wiring, read from the source.
   *
   * `runAgentCommand` calls the real `runCommand`, which is imported rather
   * than injected, so no in-suite case can drive the wiring without starting a
   * real agent — and this suite starts none. That is stated plainly because a
   * source assertion is weaker than a behavioural one: what it pins is that the
   * per-agent function reaches the stdout budget and the shared stderr constant
   * reaches stderr, which is exactly the mutant (swap the two) that the old
   * constants-only case could not see.
   */
  it('wires the per-agent stdout budget to stdout and the shared one to stderr', () => {
    const source = readFileSync(
      new URL('../src/agent/agent-command.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/maxStdoutBytes:\s*maxStdoutBytesFor\(agent\)/);
    expect(source).toMatch(/maxStderrBytes:\s*AGENT_COMMAND_MAX_STDERR_BYTES/);
    // And nowhere is a single constant handed to both.
    expect(source).not.toMatch(/maxStdoutBytes:\s*AGENT_COMMAND_MAX_STDERR_BYTES/);
    expect(source).not.toMatch(/maxStderrBytes:\s*maxStdoutBytesFor/);
  });

  it('starts each agent with the profile root it needs and no credential', () => {
    for (const policy of ['agent:claude', 'agent:codex'] as const) {
      expect([...probeEnvAllowlist(policy)].sort()).toEqual(
        ['PATH', 'PATHEXT', 'HOME', 'USERPROFILE'].sort(),
      );
    }
  });
});
