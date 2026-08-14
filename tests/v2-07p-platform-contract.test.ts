import { describe, expect, it, vi } from 'vitest';

import {
  evaluateRuntimeSupport,
  parseNodeMajor,
  SUPPORTED_NODE_MAJORS,
} from '../src/platform/runtime-support.js';
import { EXIT_RUNTIME_UNSUPPORTED } from '../src/cli/run-exit-codes.js';
import { renderRuntimeRefusal } from '../src/cli/runtime-gate.js';

describe('the runtime support decision is a whitelist, not a floor', () => {
  // The two rows that matter most are 23 and 25. `includes(major)` and
  // `major >= 22` agree on 21, 22 and 24 and disagree ONLY here, so a suite
  // without them passes against an implementation that silently reverted to a
  // floor — and the contract would then be wider than the document claims with
  // every test still green.
  const cases: ReadonlyArray<readonly [string, string, string | null]> = [
    ['win32', 'v21.7.3', 'RUNTIME_NODE_UNSUPPORTED'],
    ['win32', 'v22.11.0', null],
    ['win32', 'v23.5.0', 'RUNTIME_NODE_UNSUPPORTED'],
    ['win32', 'v24.18.1', null],
    ['win32', 'v25.0.0', 'RUNTIME_NODE_UNSUPPORTED'],
    ['win32', 'not-a-version', 'RUNTIME_NODE_VERSION_UNREADABLE'],
    ['win32', '', 'RUNTIME_NODE_VERSION_UNREADABLE'],
  ];

  for (const [platform, version, expected] of cases) {
    it(`${platform} ${version || '<empty>'} -> ${expected ?? 'supported'}`, () => {
      const result = evaluateRuntimeSupport(platform, version);
      if (expected === null) {
        expect(result.supported).toBe(true);
        return;
      }
      expect(result.supported).toBe(false);
      if (result.supported) return;
      expect(result.code).toBe(expected);
    });
  }

  // Driven at BOTH supported majors so a platform refusal cannot come out of
  // the Node check by accident.
  for (const platform of ['linux', 'darwin', 'freebsd', 'android']) {
    for (const version of ['v22.11.0', 'v24.18.1']) {
      it(`${platform} ${version} -> RUNTIME_PLATFORM_UNSUPPORTED`, () => {
        const result = evaluateRuntimeSupport(platform, version);
        expect(result.supported).toBe(false);
        if (result.supported) return;
        expect(result.code).toBe('RUNTIME_PLATFORM_UNSUPPORTED');
      });
    }
  }

  it('refuses the platform before it reads the version at all', () => {
    // Otherwise an unreadable version on POSIX would report a Node problem to
    // an operator whose actual problem is the operating system.
    const result = evaluateRuntimeSupport('linux', 'not-a-version');
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.code).toBe('RUNTIME_PLATFORM_UNSUPPORTED');
  });

  it('states the supported set as exactly two majors', () => {
    expect([...SUPPORTED_NODE_MAJORS]).toEqual([22, 24]);
  });

  it('parses a major only from a well-formed version', () => {
    expect(parseNodeMajor('v24.18.1')).toBe(24);
    expect(parseNodeMajor('24.18.1')).toBe(24);
    expect(parseNodeMajor('  v22.11.0  ')).toBe(22);
    expect(parseNodeMajor('v24')).toBeNull();
    expect(parseNodeMajor('')).toBeNull();
  });

  it('carries a detail that names what was found and what is supported', () => {
    // The refusal message is the diagnosis, so the detail may not be generic.
    const result = evaluateRuntimeSupport('win32', 'v25.0.0');
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.detail).toContain('25');
    expect(result.detail).toContain('22');
    expect(result.detail).toContain('24');
  });
});

describe('the runtime refusal is the diagnosis', () => {
  const refusal = (platform: string, version: string): string => {
    const support = evaluateRuntimeSupport(platform, version);
    expect(support.supported).toBe(false);
    if (support.supported) throw new Error('unreachable');
    return renderRuntimeRefusal(support, platform, version);
  };

  it('names what was found, on both axes', () => {
    const text = refusal('linux', 'v22.11.0');
    expect(text).toContain('linux');
    expect(text).toContain('v22.11.0');
  });

  it('names the supported configuration', () => {
    const text = refusal('linux', 'v22.11.0');
    expect(text).toContain('Windows');
    expect(text).toContain('22');
    expect(text).toContain('24');
  });

  it('says that nothing was started', () => {
    // An operator who cannot tell whether the tool half-ran will go looking for
    // state that does not exist.
    expect(refusal('linux', 'v22.11.0')).toContain('Nothing was started');
  });

  it('tells the operator what still works here', () => {
    const text = refusal('win32', 'v25.0.0');
    expect(text).toContain('--help');
    expect(text).toContain('--version');
  });

  it('carries the code and the detail from the decision', () => {
    expect(refusal('win32', 'v25.0.0')).toContain('RUNTIME_NODE_UNSUPPORTED');
    expect(refusal('win32', 'nonsense')).toContain('RUNTIME_NODE_VERSION_UNREADABLE');
  });

  it('ends with a newline, so a terminal does not eat the last line', () => {
    expect(refusal('linux', 'v22.11.0').endsWith('\n')).toBe(true);
  });

  it('uses an exit code no run outcome uses', () => {
    expect(EXIT_RUNTIME_UNSUPPORTED).toBe(6);
  });
});

describe('the gate does not disturb the supported path', () => {
  it('lets a command action run on this (supported) runtime', async () => {
    // The in-process positive control. Its counterpart — that an action does
    // NOT run on an unsupported runtime — cannot be measured in-process,
    // because the gate terminates the process; that half is
    // tests/dist-artifact/runtime-gate-dist-artifact.mjs.
    expect(process.platform).toBe('win32');
    const { buildProgram } = await import('../src/cli/index.js');
    const program = buildProgram();
    // Commander would otherwise call process.exit on a usage error.
    program.exitOverride();

    // `process.stdout.write`, not `configureOutput`: `lease-command.ts` writes
    // its report through the former directly, so a Commander output hook sees
    // none of it and this control would pass against a gate that blocked the
    // action entirely.
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    // The action sets `process.exitCode`; left set, it becomes vitest's own
    // exit code and a fully passing run reports failure.
    const previousExitCode = process.exitCode;
    try {
      // `from: 'user'` means the array carries NO node/script prefix.
      await program.parseAsync(['lease', 'status', '--repository', 'no-such-repository'], {
        from: 'user',
      });
    } finally {
      spy.mockRestore();
      process.exitCode = previousExitCode;
    }

    // The action ran. Either marker proves it: both are written by
    // `lease-command.ts` itself, downstream of the hook.
    const output = written.join('');
    expect(output.length).toBeGreaterThan(0);
    expect(/could not be resolved|Lease/.test(output)).toBe(true);
  });
});
