/**
 * AO-002-R1: the capability artefact carries facts, never process output.
 *
 * The previous `cli-capabilities.txt` persisted each probe's full stdout and
 * stderr through a pattern-based redactor. These probes push markers that the
 * redactor cannot recognise — they are not emails, UUIDs, `sk-` tokens or JWTs
 * — through both streams and in every syntactic disguise a probe could pick:
 * as prose, as a flag, as a subcommand entry, as an error sentence. None of
 * them may reach the artefact. On the old implementation every one of these
 * would have been written out verbatim.
 */

import { describe, expect, it } from 'vitest';

import { PROBE_ENV_POLICIES } from '../src/auth/env-guard.js';
import {
  CAPABILITY_PROBES,
  classifyProbe,
  deriveCapabilityAnswers,
  deriveCapabilityFacts,
  extractFlags,
  extractProbeVersion,
  extractSubcommands,
  KNOWN_PROGRAMS,
  probeSupportsFlag,
  RECOGNISED_FLAGS,
  RECOGNISED_SUBCOMMANDS,
  renderCapabilitySummary,
  VERSION_PROBE_IDS,
  type CapabilityProbe,
  type CapabilityRecord,
} from '../src/doctor/capabilities.js';
import { commandResult, SENSITIVE_MARKER } from './fixtures.js';

const probe: CapabilityProbe = {
  id: 'claude.auth.status.help',
  program: 'claude',
  args: ['auth', 'status', '--help'],
  required: true,
  envPolicy: 'capability:claude',
};

const RUN_ID = '20260801T123456789Z-3f2a0c11-1111-2222-3333-444455556666';

function recordFrom(stdout: string, stderr = ''): CapabilityRecord {
  const result = commandResult({
    display: 'claude auth status --help',
    executable: 'claude',
    args: probe.args,
    stdout,
    stderr,
  });
  return {
    probe,
    availability: classifyProbe(result),
    facts: deriveCapabilityFacts(probe, result),
  };
}

describe('the probe list stays static and allow-listed', () => {
  it('names only known programs and inert arguments', () => {
    for (const p of CAPABILITY_PROBES) {
      expect(KNOWN_PROGRAMS).toContain(p.program);
      for (const arg of p.args) {
        expect(arg).toMatch(/^[a-z][a-z0-9-]*$|^--[a-z][a-z0-9-]*$/);
      }
      expect(p.args.some((a) => a === '--help' || a === '--version')).toBe(true);
    }
  });

  it('has unique probe ids', () => {
    const ids = CAPABILITY_PROBES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is frozen, so no caller can append a probe of its own', () => {
    expect(Object.isFrozen(CAPABILITY_PROBES)).toBe(true);
  });

  /**
   * AO-FOUNDATION-REM-003A. Every probe states the environment it is started
   * with, at the place it is defined. A probe without a policy would have to
   * fall back to some default block, which is exactly the shared child
   * environment this remediation removed.
   */
  it('declares an explicit capability environment policy for every probe', () => {
    for (const p of CAPABILITY_PROBES) {
      expect(PROBE_ENV_POLICIES).toContain(p.envPolicy);
      // A capability probe reports what a program *is*, never who is logged
      // into it, so an auth policy here would be a category error.
      expect(p.envPolicy.startsWith('capability:')).toBe(true);
    }
  });

  it('gives each provider its own policy rather than one shared block', () => {
    const policyOf = (program: string): string[] => [
      ...new Set(CAPABILITY_PROBES.filter((p) => p.program === program).map((p) => p.envPolicy)),
    ];

    expect(policyOf('node')).toEqual(['capability:generic']);
    expect(policyOf('npm')).toEqual(['capability:generic']);
    expect(policyOf('git')).toEqual(['capability:generic']);
    expect(policyOf('claude')).toEqual(['capability:claude']);
    expect(policyOf('codex')).toEqual(['capability:codex']);
  });
});

describe('token extraction is conservative', () => {
  it('keeps only allow-listed flags', () => {
    const flags = extractFlags('  --json  Output as JSON\n  --zz-unknown-flag  Do something\n');
    expect(flags).toEqual(['--json']);
  });

  it('ignores a marker dressed up as a flag', () => {
    const flags = extractFlags(`  --${SENSITIVE_MARKER.toLowerCase()}  description\n`);
    expect(flags).toEqual([]);
    expect(JSON.stringify(flags)).not.toContain(SENSITIVE_MARKER.toLowerCase());
  });

  it('does not treat a flag fragment inside a word as a flag', () => {
    expect(extractFlags('see also--jsonify or x--json2y')).toEqual([]);
  });

  it('keeps only allow-listed subcommands, and only from a command section', () => {
    const help = [
      'Usage: claude [options] [command]',
      '',
      'Commands:',
      '  auth       Manage authentication',
      `  ${SENSITIVE_MARKER.toLowerCase()}  Do something odd`,
      '  mcp        Configure MCP servers',
      '',
      'Run `claude help` for more. The word status appears here as prose.',
    ].join('\n');

    expect(extractSubcommands(help)).toEqual(['auth', 'mcp']);
    expect(JSON.stringify(extractSubcommands(help))).not.toContain(SENSITIVE_MARKER.toLowerCase());
  });

  it('recognises nothing outside a command section', () => {
    expect(extractSubcommands('please check the auth status and the login config')).toEqual([]);
  });

  it('never yields a token outside the closed vocabularies', () => {
    const noisy = `--auth --login ${SENSITIVE_MARKER} --json --sk-ant-abcdefgh --config`;
    for (const flag of extractFlags(noisy)) {
      expect(RECOGNISED_FLAGS).toContain(flag);
    }
    for (const name of extractSubcommands(`Commands:\n  ${noisy}\n`)) {
      expect(RECOGNISED_SUBCOMMANDS).toContain(name);
    }
  });
});

/**
 * AO-002-R1-RR1: version extraction is per-probe and fully anchored.
 *
 * The previous implementation scanned the first non-empty line of *either*
 * stream for anything shaped like a dotted number, for *every* probe. It
 * therefore reported a version out of an account line, out of help prose, out
 * of a banner and out of an unrelated tool's output. Each negative case below
 * returned a version before the remediation; every one of them must now be
 * `null`, which the callers surface as `UNKNOWN`.
 */
describe('version extraction is probe-specific and fully anchored', () => {
  // Exactly the output of the locally installed CLIs, observed 2026-08-01.
  it.each([
    ['node.version', 'v24.18.1\n', '24.18.1'],
    ['npm.version', '11.12.1\n', '11.12.1'],
    ['git.version', 'git version 2.55.0.windows.3\n', '2.55.0'],
    ['claude.version', '2.1.220 (Claude Code)\n', '2.1.220'],
    ['codex.version', 'codex-cli 0.146.0\n', '0.146.0'],
  ])('reads the observed %s output', (probeId, stdout, expected) => {
    expect(extractProbeVersion(probeId, stdout)).toBe(expected);
  });

  it('accepts the same lines with CRLF endings and surrounding blank lines', () => {
    expect(extractProbeVersion('node.version', '\r\nv24.18.1\r\n\r\n')).toBe('24.18.1');
    expect(extractProbeVersion('git.version', '  git version 2.43.0  \n')).toBe('2.43.0');
  });

  it('extracts nothing at all from a --help probe', () => {
    for (const probeId of [
      'claude.help',
      'claude.auth.help',
      'claude.auth.login.help',
      'claude.auth.status.help',
      'codex.help',
      'codex.login.help',
      'codex.login.status.help',
    ]) {
      expect(VERSION_PROBE_IDS).not.toContain(probeId);
      expect(extractProbeVersion(probeId, 'codex-cli 0.146.0\n')).toBeNull();
      expect(extractProbeVersion(probeId, '  --json  Output as JSON (since 1.2.3)\n')).toBeNull();
    }
  });

  it.each([
    ['an account line carrying a version', 'node.version', `Account ${SENSITIVE_MARKER}@example.test plan 9.8.7\n`],
    ['an account line on the claude probe', 'claude.version', 'Account marker@example.test plan 9.8.7\n'],
    ['a help line carrying a version', 'node.version', '  -v, --version   print Node.js version v24.18.1\n'],
    ['banner text before the version', 'claude.version', 'Claude Code CLI\n2.1.220 (Claude Code)\n'],
    ['a banner glued in front of the version', 'codex.version', 'welcome! codex-cli 0.146.0\n'],
    ['text after the version', 'node.version', 'v24.18.1 (unsupported build)\n'],
    ['a marker after a formally valid version', 'npm.version', `11.12.1 ${SENSITIVE_MARKER}\n`],
    ['a marker before a formally valid version', 'npm.version', `${SENSITIVE_MARKER} 11.12.1\n`],
    ['several non-empty lines', 'npm.version', '11.12.1\nnotice: update available 12.0.0\n'],
    ['a second line on the git probe', 'git.version', 'git version 2.55.0.windows.3\nextra 1.2.3\n'],
    ['another probe id’s output format', 'node.version', 'git version 2.55.0.windows.3\n'],
    ['yet another probe id’s output format', 'codex.version', '2.1.220 (Claude Code)\n'],
    ['the npm format on the node probe', 'node.version', '24.18.1\n'],
    ['a changed CLI output format', 'claude.version', 'claude-code version 2.1.220\n'],
    ['a two-part version', 'node.version', 'v24.18\n'],
    ['a four-part version', 'node.version', 'v24.18.1.2\n'],
    ['a pre-release suffix', 'node.version', 'v24.18.1-nightly20260801\n'],
    ['empty output', 'node.version', ''],
    ['whitespace only', 'node.version', '   \n  \n'],
    ['no numbers at all', 'node.version', 'command not found\n'],
    ['an unregistered probe id', 'perl.version', 'v24.18.1\n'],
  ])('yields null for %s', (_label, probeId, stdout) => {
    expect(extractProbeVersion(probeId, stdout)).toBeNull();
  });

  it('ignores a version in stderr when stdout is what the probe should print', () => {
    // `deriveCapabilityFacts` passes only stdout, and this is why: a version on
    // stderr is not the expected output of these probes.
    const record = recordFrom('', 'v24.18.1\n');
    expect(record.facts.version).toBeNull();

    const facts = deriveCapabilityFacts(
      {
        id: 'node.version',
        program: 'node',
        args: ['--version'],
        required: true,
        envPolicy: 'capability:generic',
      },
      commandResult({ stdout: '', stderr: 'v24.18.1\n' }),
    );
    expect(facts.version).toBeNull();
  });

  it('reports only a bare numeric triple, never a word from the line', () => {
    for (const probeId of VERSION_PROBE_IDS) {
      for (const stdout of [
        'v24.18.1\n',
        '11.12.1\n',
        'git version 2.55.0.windows.3\n',
        '2.1.220 (Claude Code)\n',
        'codex-cli 0.146.0\n',
      ]) {
        const version = extractProbeVersion(probeId, stdout);
        if (version === null) continue;
        expect(version).toMatch(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/);
        for (const word of ['git', 'version', 'codex', 'cli', 'Claude', 'Code', 'windows', 'v']) {
          expect(version).not.toContain(word);
        }
      }
    }
  });

  it('covers exactly the version probes in the probe list', () => {
    const declared = CAPABILITY_PROBES.filter((p) => p.id.endsWith('.version')).map((p) => p.id);
    expect([...VERSION_PROBE_IDS].sort()).toEqual(declared.sort());
  });
});

describe('derived facts hold no process output', () => {
  it('records the fixed probe identity and discards the raw streams', () => {
    const { facts } = recordFrom('Usage: claude auth status\n  --json  Output as JSON\n');

    expect(facts.probeId).toBe('claude.auth.status.help');
    expect(facts.program).toBe('claude');
    expect(facts.args).toEqual(['auth', 'status', '--help']);
    expect(facts.rawOutputDiscarded).toBe(true);
    expect(facts.flags).toEqual(['--json']);
    expect(facts).not.toHaveProperty('stdout');
    expect(facts).not.toHaveProperty('stderr');
    expect(Object.keys(facts).sort()).toEqual(
      [
        'args',
        'durationMs',
        'errnoCode',
        'exitCode',
        'failureCode',
        'finishedAt',
        'flags',
        'outcome',
        'outputParsed',
        'outputTruncated',
        'probeId',
        'producedOutput',
        'program',
        'rawOutputDiscarded',
        'required',
        'started',
        'startedAt',
        'subcommands',
        'version',
      ].sort(),
    );
  });

  it.each([
    ['prose in stdout', `Usage: claude — account ${SENSITIVE_MARKER}\n`, ''],
    ['an error sentence in stderr', '', `error: could not read ${SENSITIVE_MARKER}\n`],
    ['a flag-shaped marker', `  --${SENSITIVE_MARKER.toLowerCase()}  x\n`, ''],
    [
      'a command-section entry',
      `Commands:\n  ${SENSITIVE_MARKER.toLowerCase()}  do it\n`,
      '',
    ],
    ['an account line', `Logged in as ${SENSITIVE_MARKER}@example.com (org ${SENSITIVE_MARKER})\n`, ''],
    ['a marker in both streams', `${SENSITIVE_MARKER}\n`, `${SENSITIVE_MARKER}\n`],
    ['a version line with a marker', `claude ${SENSITIVE_MARKER} 2.1.220\n`, ''],
  ])('keeps a marker delivered as %s out of the facts', (_label, stdout, stderr) => {
    const record = recordFrom(stdout, stderr);
    const serialised = JSON.stringify(record.facts);
    expect(serialised).not.toContain(SENSITIVE_MARKER);
    expect(serialised).not.toContain(SENSITIVE_MARKER.toLowerCase());
  });

  it('keeps a marker out of the rendered capability summary', () => {
    const records = [
      recordFrom(
        `Usage: claude ${SENSITIVE_MARKER}\n\nCommands:\n  ${SENSITIVE_MARKER.toLowerCase()}  x\n  auth  y\n\n  --json  z\n  --${SENSITIVE_MARKER.toLowerCase()}  w\n`,
        `warning: ${SENSITIVE_MARKER}\n`,
      ),
    ];
    const summary = renderCapabilitySummary(
      records,
      deriveCapabilityAnswers(records),
      '2026-08-01T10:00:00.000Z',
      RUN_ID,
    );

    expect(summary).not.toContain(SENSITIVE_MARKER);
    expect(summary).not.toContain(SENSITIVE_MARKER.toLowerCase());
    expect(summary).toContain('RAW OUTPUT  : discarded');
    expect(summary).toContain(RUN_ID);
    expect(summary).toContain('auth');
    expect(summary).toContain('--json');
  });

  it('renders no stdout or stderr section at all', () => {
    const summary = renderCapabilitySummary(
      [recordFrom('anything\n', 'anything\n')],
      deriveCapabilityAnswers([]),
      '2026-08-01T10:00:00.000Z',
      RUN_ID,
    );
    expect(summary).not.toContain('--- stdout ---');
    expect(summary).not.toContain('--- stderr ---');
    expect(summary).not.toContain('anything');
  });

  it('reports fixed failure codes instead of an exception message', () => {
    const failing: CapabilityRecord = {
      probe,
      availability: 'EXECUTABLE_NOT_FOUND',
      facts: deriveCapabilityFacts(
        probe,
        commandResult({
          started: false,
          outcome: 'NOT_FOUND',
          exitCode: null,
          failureCode: 'EXECUTABLE_NOT_FOUND',
          errnoCode: 'ENOENT',
          stderr: `spawn claude ENOENT ${SENSITIVE_MARKER}`,
        }),
      ),
    };
    const summary = renderCapabilitySummary(
      [failing],
      deriveCapabilityAnswers([failing]),
      '2026-08-01T10:00:00.000Z',
      RUN_ID,
    );
    expect(summary).toContain('FAILURE     : EXECUTABLE_NOT_FOUND');
    expect(summary).toContain('ERRNO       : ENOENT');
    expect(summary).not.toContain(SENSITIVE_MARKER);
    expect(summary).not.toContain('spawn ');
  });
});

describe('capability answers fail closed', () => {
  it('answers YES only on a parsed, available probe carrying the flag', () => {
    const record = recordFrom('Usage\n  --json  Output as JSON\n');
    expect(probeSupportsFlag(record, '--json')).toBe('YES');
  });

  it('answers NO when the probe parsed but the flag is absent', () => {
    const record = recordFrom('Usage\n  --config  Set config\n');
    expect(probeSupportsFlag(record, '--json')).toBe('NO');
  });

  it('answers UNKNOWN when nothing in the output could be parsed', () => {
    const record = recordFrom(`${SENSITIVE_MARKER}\n`);
    expect(record.availability).toBe('AVAILABLE');
    expect(record.facts.outputParsed).toBe(false);
    expect(probeSupportsFlag(record, '--json')).toBe('UNKNOWN');
  });

  it('answers UNKNOWN for a missing or unavailable probe', () => {
    expect(probeSupportsFlag(undefined, '--json')).toBe('UNKNOWN');
    const missing = recordFrom('');
    expect(missing.availability).toBe('UNAVAILABLE_IN_INSTALLED_VERSION');
    expect(probeSupportsFlag(missing, '--json')).toBe('UNKNOWN');
  });

  it('reports every answer as one of the three fixed words', () => {
    const answers = deriveCapabilityAnswers([recordFrom('  --json  x\n')]);
    for (const value of Object.values(answers)) {
      expect(['YES', 'NO', 'UNKNOWN']).toContain(value);
    }
  });
});

describe('probe classification', () => {
  const base = commandResult({
    display: 'claude auth status --help',
    executable: 'claude',
    args: ['auth', 'status', '--help'],
    stdout: 'Usage: claude auth status',
  });

  it('marks a zero exit with output as AVAILABLE', () => {
    expect(classifyProbe(base)).toBe('AVAILABLE');
  });

  it('marks a non-zero exit as unavailable in the installed version', () => {
    expect(classifyProbe({ ...base, exitCode: 1, stdout: '', stderr: 'unknown command' })).toBe(
      'UNAVAILABLE_IN_INSTALLED_VERSION',
    );
  });

  it('does not accept a silent success as proof of availability', () => {
    expect(classifyProbe({ ...base, stdout: '', stderr: '' })).toBe(
      'UNAVAILABLE_IN_INSTALLED_VERSION',
    );
  });

  it('distinguishes a missing executable from a missing subcommand', () => {
    expect(classifyProbe({ ...base, outcome: 'NOT_FOUND', started: false, exitCode: null })).toBe(
      'EXECUTABLE_NOT_FOUND',
    );
  });

  it.each(['TIMED_OUT', 'SPAWN_FAILED', 'OUTPUT_LIMIT_EXCEEDED'] as const)(
    'treats the %s outcome as a failed probe',
    (outcome) => {
      expect(classifyProbe({ ...base, outcome, exitCode: null })).toBe('PROBE_FAILED');
    },
  );
});
