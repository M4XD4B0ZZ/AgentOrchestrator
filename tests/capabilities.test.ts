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

import {
  CAPABILITY_PROBES,
  classifyProbe,
  deriveCapabilityAnswers,
  deriveCapabilityFacts,
  extractFlags,
  extractSubcommands,
  extractVersion,
  KNOWN_PROGRAMS,
  probeSupportsFlag,
  RECOGNISED_FLAGS,
  RECOGNISED_SUBCOMMANDS,
  renderCapabilitySummary,
  type CapabilityProbe,
  type CapabilityRecord,
} from '../src/doctor/capabilities.js';
import { commandResult, SENSITIVE_MARKER } from './fixtures.js';

const probe: CapabilityProbe = {
  id: 'claude.auth.status.help',
  program: 'claude',
  args: ['auth', 'status', '--help'],
  required: true,
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

describe('version extraction', () => {
  it.each([
    ['v24.4.0', '24.4.0'],
    ['codex-cli 0.146.0', '0.146.0'],
    ['2.1.220 (Claude Code)', '2.1.220'],
    ['git version 2.47.1.windows.1', '2.47.1'],
    ['11.6.2', '11.6.2'],
  ])('extracts the version from %j', (line, expected) => {
    expect(extractVersion(line)).toBe(expected);
  });

  it('never copies a whole line into the report', () => {
    expect(extractVersion(`some tool ${SENSITIVE_MARKER}`)).toBeNull();
    expect(extractVersion(`1.2.3 ${SENSITIVE_MARKER}`)).toBe('1.2.3');
  });

  it('returns null for empty or unrecognised output', () => {
    expect(extractVersion('')).toBeNull();
    expect(extractVersion('   \n  ')).toBeNull();
    expect(extractVersion('no numbers here')).toBeNull();
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
