/**
 * CLI capability dump.
 *
 * Runs a fixed list of read-only `--version` / `--help` probes against the
 * locally installed toolchain and records exactly what happened. Nothing here
 * is invented: the probe list contains only commands that either are universal
 * (`node --version`, `git --version`) or whose existence the dump itself is
 * meant to prove or disprove.
 *
 * A probe that does not exist in the installed version is recorded as
 * `UNAVAILABLE_IN_INSTALLED_VERSION`; the dump then continues.
 */

import { runCommand, type CommandResult, type RunOptions } from './exec.js';
import { CAPABILITY_DUMP_KIND } from './report.js';
import { redact } from '../auth/redaction.js';

export interface CapabilityProbe {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Probes whose absence is a hard problem rather than just information. */
  readonly required: boolean;
}

/**
 * The probe list.
 *
 * `claude auth …` and `codex login …` sub-command help is probed rather than
 * assumed. `--help` is used throughout: it is inert and cannot start a login
 * flow, an interactive session or a model request.
 */
export const CAPABILITY_PROBES: readonly CapabilityProbe[] = [
  { id: 'node.version', command: 'node', args: ['--version'], required: true },
  { id: 'npm.version', command: 'npm', args: ['--version'], required: true },
  { id: 'git.version', command: 'git', args: ['--version'], required: true },

  { id: 'claude.version', command: 'claude', args: ['--version'], required: true },
  { id: 'claude.help', command: 'claude', args: ['--help'], required: false },
  { id: 'claude.auth.help', command: 'claude', args: ['auth', '--help'], required: false },
  { id: 'claude.auth.login.help', command: 'claude', args: ['auth', 'login', '--help'], required: false },
  { id: 'claude.auth.status.help', command: 'claude', args: ['auth', 'status', '--help'], required: true },

  { id: 'codex.version', command: 'codex', args: ['--version'], required: true },
  { id: 'codex.help', command: 'codex', args: ['--help'], required: false },
  { id: 'codex.login.help', command: 'codex', args: ['login', '--help'], required: false },
  { id: 'codex.login.status.help', command: 'codex', args: ['login', 'status', '--help'], required: true },
];

export type ProbeAvailability =
  | 'AVAILABLE'
  | 'UNAVAILABLE_IN_INSTALLED_VERSION'
  | 'EXECUTABLE_NOT_FOUND'
  | 'PROBE_FAILED';

export interface CapabilityRecord {
  readonly probe: CapabilityProbe;
  readonly result: CommandResult;
  readonly availability: ProbeAvailability;
}

/**
 * Classifies a probe result.
 *
 * A missing *general* help entry does not by itself prove that a targeted
 * sub-command help is unavailable, so each probe is judged on its own exit
 * code and output rather than inherited from a parent probe.
 */
export function classifyProbe(result: CommandResult): ProbeAvailability {
  if (result.outcome === 'NOT_FOUND') return 'EXECUTABLE_NOT_FOUND';
  if (
    result.outcome === 'SPAWN_FAILED' ||
    result.outcome === 'TIMED_OUT' ||
    result.outcome === 'OUTPUT_LIMIT_EXCEEDED'
  ) {
    return 'PROBE_FAILED';
  }

  if (result.exitCode === 0) {
    // A zero exit with no output at all is not usable evidence of anything.
    return result.stdout.trim().length > 0 || result.stderr.trim().length > 0
      ? 'AVAILABLE'
      : 'UNAVAILABLE_IN_INSTALLED_VERSION';
  }

  // Non-zero exit from a `--help` probe means the installed version does not
  // understand this sub-command.
  return 'UNAVAILABLE_IN_INSTALLED_VERSION';
}

export async function runCapabilityDump(options: RunOptions): Promise<readonly CapabilityRecord[]> {
  const records: CapabilityRecord[] = [];
  for (const probe of CAPABILITY_PROBES) {
    const result = await runCommand(probe.command, probe.args, options);
    records.push({ probe, result, availability: classifyProbe(result) });
  }
  return records;
}

export function findRecord(
  records: readonly CapabilityRecord[],
  id: string,
): CapabilityRecord | undefined {
  return records.find((r) => r.probe.id === id);
}

/** First non-empty line, redacted — used for the human-readable dump only. */
export function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line === undefined ? '' : redact(line.trim());
}

/**
 * The version number inside a `--version` line, or `null`.
 *
 * The machine-readable report must not carry arbitrary CLI text (AO-002), so a
 * version is not copied verbatim: only a dotted numeric core plus an optional
 * conventional pre-release/build suffix is extracted, and anything else yields
 * `null`. `codex-cli 0.146.0` becomes `0.146.0`; a line carrying an unexpected
 * marker yields either the version alone or nothing at all.
 */
// The leading context class lets `v24.4.0`, `codex-cli 0.146.0` and a bare
// `2.1.220` all be recognised without ever capturing the surrounding words.
const VERSION_PATTERN = /(?:^|[\s(\[v=,:/-])(\d{1,6}(?:\.\d{1,6}){1,3}(?:-[A-Za-z0-9.]{1,32})?)\b/;

export function extractVersion(text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (line === undefined) return null;
  const match = VERSION_PATTERN.exec(line);
  return match?.[1] ?? null;
}

const SEPARATOR = '='.repeat(78);

/**
 * Renders the human-readable capability dump written to
 * `.diagnostics/cli-capabilities.txt`.
 *
 * Output of `--version`/`--help` probes contains no credentials, but it is put
 * through the redactor anyway as a defence in depth.
 */
export function renderCapabilityDump(
  records: readonly CapabilityRecord[],
  generatedAt: string,
): string {
  const lines: string[] = [
    SEPARATOR,
    'agent-loop doctor — CLI capability dump',
    // Ownership marker: `writeDiagnosticFile` refuses to replace a file that
    // does not carry it, so the doctor can only overwrite its own artefacts.
    `kind: ${CAPABILITY_DUMP_KIND}`,
    `generated at: ${generatedAt}`,
    '',
    'Read-only `--version` / `--help` probes of the locally installed CLIs.',
    'Output is redacted. No credential store is read and no login is performed.',
    SEPARATOR,
    '',
  ];

  for (const record of records) {
    const { probe, result, availability } = record;
    lines.push(SEPARATOR);
    lines.push(`PROBE      : ${probe.id}`);
    lines.push(`COMMAND    : ${result.executable}`);
    lines.push(`ARGV       : ${JSON.stringify(probe.args)}`);
    lines.push(`REQUIRED   : ${probe.required ? 'yes' : 'no'}`);
    lines.push(`STARTED    : ${result.started ? 'yes' : 'no'}`);
    lines.push(`OUTCOME    : ${result.outcome}`);
    lines.push(`AVAILABLE  : ${availability}`);
    lines.push(`EXIT CODE  : ${result.exitCode === null ? '<none>' : String(result.exitCode)}`);
    lines.push(`SIGNAL     : ${result.signal ?? '<none>'}`);
    lines.push(`STARTED AT : ${result.startedAt}`);
    lines.push(`FINISHED AT: ${result.finishedAt}`);
    lines.push(`DURATION   : ${result.durationMs} ms`);
    // Fixed codes only — an exception message would republish untrusted text.
    lines.push(`FAILURE    : ${result.failureCode ?? '<none>'}`);
    lines.push(`ERRNO      : ${result.errnoCode ?? '<none>'}`);
    lines.push(
      `TRUNCATED  : stdout=${result.stdoutTruncated ? 'yes' : 'no'}, ` +
        `stderr=${result.stderrTruncated ? 'yes' : 'no'}`,
    );
    lines.push(SEPARATOR);
    lines.push('--- stdout ---');
    lines.push(result.stdout.trim().length > 0 ? redact(result.stdout.trimEnd()) : '<empty>');
    lines.push('--- stderr ---');
    lines.push(result.stderr.trim().length > 0 ? redact(result.stderr.trimEnd()) : '<empty>');
    lines.push('');
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
