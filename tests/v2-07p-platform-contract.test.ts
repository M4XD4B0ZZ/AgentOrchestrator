import { describe, expect, it, vi } from 'vitest';

import {
  evaluateRuntimeSupport,
  parseNodeMajor,
  SUPPORTED_NODE_MAJORS,
} from '../src/platform/runtime-support.js';

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
