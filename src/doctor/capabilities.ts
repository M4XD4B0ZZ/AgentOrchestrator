/**
 * CLI capability probing.
 *
 * Runs a fixed, allow-listed set of read-only `--version` / `--help` probes
 * against the locally installed toolchain and turns each one into a small
 * closed-vocabulary fact record.
 *
 * ── The persistent contract changed deliberately (AO-002-R1) ───────────────
 *
 * The previous implementation persisted the probes' full `stdout` and `stderr`
 * into `cli-capabilities.txt`, passed through a pattern-based redactor. That is
 * not defensible: a redactor only masks the secret shapes it already knows, and
 * a CLI's help text, error prose, banner or account line can carry anything at
 * all. The raw dump has therefore been **removed**. It is not redacted more
 * aggressively — it is not written.
 *
 * What a probe may contribute to an artefact or the report is now exactly this,
 * and the type system is the enforcement (see {@link CapabilityFacts}):
 *
 *  - the stable internal probe id;
 *  - the program, as a fixed known label from {@link KNOWN_PROGRAMS};
 *  - the statically configured argument list;
 *  - whether the process started, its exit code, start/end time and duration;
 *  - a fixed outcome / timeout / spawn / output-limit status code, plus an
 *    allow-listed errno identifier;
 *  - a strictly extracted version number;
 *  - strictly extracted, allow-listed subcommand names;
 *  - strictly extracted, allow-listed flag names;
 *  - boolean capability answers derived from those;
 *  - the fact that the raw output was discarded.
 *
 * What can never appear: stdout, stderr, an unknown text line, help prose, an
 * error sentence, spawn-exception text, an email address, an account or
 * organisation identifier, or any other marker copied out of a process.
 *
 * Extraction is conservative by construction. A token must both match a strict
 * syntactic pattern *and* appear in a closed vocabulary defined in this file,
 * so a probe cannot introduce a new string into an artefact even by printing
 * something that looks exactly like a flag. Whole source lines are never kept.
 * If a probe's output yields no recognised token at all, its capability answers
 * are `UNKNOWN` rather than a guessed `NO`.
 */

import { runCommand, type CommandFailureCode, type CommandOutcome, type CommandResult, type RunOptions } from './exec.js';

/** Programs the doctor is allowed to probe. Fixed labels, never user input. */
export const KNOWN_PROGRAMS = ['node', 'npm', 'git', 'claude', 'codex'] as const;
export type KnownProgram = (typeof KNOWN_PROGRAMS)[number];

export interface CapabilityProbe {
  readonly id: string;
  readonly program: KnownProgram;
  readonly args: readonly string[];
  /** Probes whose absence is a hard problem rather than just information. */
  readonly required: boolean;
}

/**
 * The probe list — static and allow-list based.
 *
 * The doctor executes these and nothing else. There is no way to hand it a
 * command or an argument to probe: no CLI option feeds this list, and it is a
 * frozen compile-time constant.
 *
 * `claude auth …` and `codex login …` sub-command help is probed rather than
 * assumed. `--help` is used throughout: it is inert and cannot start a login
 * flow, an interactive session or a model request.
 */
export const CAPABILITY_PROBES: readonly CapabilityProbe[] = Object.freeze([
  { id: 'node.version', program: 'node', args: ['--version'], required: true },
  { id: 'npm.version', program: 'npm', args: ['--version'], required: true },
  { id: 'git.version', program: 'git', args: ['--version'], required: true },

  { id: 'claude.version', program: 'claude', args: ['--version'], required: true },
  { id: 'claude.help', program: 'claude', args: ['--help'], required: false },
  { id: 'claude.auth.help', program: 'claude', args: ['auth', '--help'], required: false },
  { id: 'claude.auth.login.help', program: 'claude', args: ['auth', 'login', '--help'], required: false },
  { id: 'claude.auth.status.help', program: 'claude', args: ['auth', 'status', '--help'], required: true },

  { id: 'codex.version', program: 'codex', args: ['--version'], required: true },
  { id: 'codex.help', program: 'codex', args: ['--help'], required: false },
  { id: 'codex.login.help', program: 'codex', args: ['login', '--help'], required: false },
  { id: 'codex.login.status.help', program: 'codex', args: ['login', 'status', '--help'], required: true },
] as const);

export type ProbeAvailability =
  | 'AVAILABLE'
  | 'UNAVAILABLE_IN_INSTALLED_VERSION'
  | 'EXECUTABLE_NOT_FOUND'
  | 'PROBE_FAILED';

// ── Closed token vocabularies ──────────────────────────────────────────────

/**
 * Flag names the orchestrator has a reason to look for.
 *
 * This is the *only* set of flag strings that can ever be persisted. A probe
 * printing `--zz-something-else` contributes nothing, because the token is not
 * in this list — the syntactic pattern is the first gate, the vocabulary the
 * second.
 */
export const RECOGNISED_FLAGS = [
  '--claudeai',
  '--config',
  '--console',
  '--disable',
  '--enable',
  '--format',
  '--help',
  '--json',
  '--version',
  '--with-api-key',
] as const;
export type RecognisedFlag = (typeof RECOGNISED_FLAGS)[number];

/** Subcommand names the orchestrator has a reason to look for. */
export const RECOGNISED_SUBCOMMANDS = [
  'auth',
  'config',
  'doctor',
  'exec',
  'help',
  'login',
  'logout',
  'mcp',
  'resume',
  'status',
  'update',
  'version',
] as const;
export type RecognisedSubcommand = (typeof RECOGNISED_SUBCOMMANDS)[number];

const FLAG_SET: ReadonlySet<string> = new Set<string>(RECOGNISED_FLAGS);
const SUBCOMMAND_SET: ReadonlySet<string> = new Set<string>(RECOGNISED_SUBCOMMANDS);

/**
 * A long-flag token, delimited so it cannot be a fragment of a longer word.
 * Only lower-case ASCII, digits and hyphens are accepted.
 */
const FLAG_TOKEN_PATTERN = /(?<![\w-])--[a-z][a-z0-9-]{0,30}(?![\w-])/g;

/** `Commands:` / `Subcommands:` / `Available commands:` section header. */
const COMMAND_SECTION_HEADER = /^\s*(?:available\s+)?(?:sub)?commands\s*:?\s*$/i;

/** The leading token of an indented entry inside such a section. */
const SECTION_ENTRY_PATTERN = /^\s+([a-z][a-z0-9-]{0,30})(?![\w-])/;

/**
 * Allow-listed flag names appearing anywhere in the text.
 *
 * The result is bounded by {@link RECOGNISED_FLAGS}, so neither the number nor
 * the content of the entries can be influenced by the probed program.
 */
export function extractFlags(text: string): readonly RecognisedFlag[] {
  const found = new Set<RecognisedFlag>();
  for (const match of text.matchAll(FLAG_TOKEN_PATTERN)) {
    const token = match[0];
    if (FLAG_SET.has(token)) found.add(token as RecognisedFlag);
  }
  return [...found].sort();
}

/**
 * Allow-listed subcommand names listed in a help text's command section.
 *
 * Deliberately narrow: only the first token of an indented line inside a
 * `Commands:` block is considered a candidate, and it still has to be in
 * {@link RECOGNISED_SUBCOMMANDS}. Prose elsewhere in the help text contributes
 * nothing, and no source line is ever retained.
 */
export function extractSubcommands(text: string): readonly RecognisedSubcommand[] {
  const found = new Set<RecognisedSubcommand>();
  let inSection = false;

  for (const line of text.split(/\r?\n/)) {
    if (COMMAND_SECTION_HEADER.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;

    // A blank line or a line that is not indented ends the section.
    if (line.trim().length === 0 || !/^\s/.test(line)) {
      inSection = false;
      continue;
    }
    const entry = SECTION_ENTRY_PATTERN.exec(line);
    const name = entry?.[1];
    if (name !== undefined && SUBCOMMAND_SET.has(name)) {
      found.add(name as RecognisedSubcommand);
    }
  }
  return [...found].sort();
}

// ── Version extraction ─────────────────────────────────────────────────────

/**
 * Per-probe, fully anchored `--version` formats (AO-002-R1-RR1).
 *
 * The previous implementation searched *any* first non-empty line for anything
 * that looked like a dotted number, which is not a parser but a scanner. It
 * accepted a version out of an account line (`Account you@example.test plan
 * 9.8.7`), out of help prose, out of a banner, out of `stderr` when `stdout`
 * was expected, and out of a completely different probe's output — and the
 * extracted digits were then reported as the installed version of a tool.
 *
 * What replaces it:
 *
 *  - **only** the probes listed here extract a version. A `--help` probe has no
 *    entry, so it can never contribute one;
 *  - the probe's whole normalised output must be exactly **one** non-empty
 *    line, and that entire line must match the probe's own anchored pattern.
 *    A prefix, a suffix, an extra line, a banner or an account marker means the
 *    output is not the format we know, so the answer is `null` / `UNKNOWN`;
 *  - only `stdout` is read. Each of these tools prints its version there, so a
 *    version appearing in `stderr` is by definition not the expected output;
 *  - the captured group is a bare numeric triple, re-validated against
 *    {@link VERSION_VALUE}. Nothing textual from the line — not `git version`,
 *    not `(Claude Code)`, not `codex-cli`, not a `.windows.N` build suffix —
 *    can reach a report or an artefact.
 *
 * The patterns are derived from the output of the actually installed CLIs,
 * observed locally on 2026-08-01:
 *
 *     node   --version  →  v24.18.1
 *     npm    --version  →  11.12.1
 *     git    --version  →  git version 2.55.0.windows.3
 *     claude --version  →  2.1.220 (Claude Code)
 *     codex  --version  →  codex-cli 0.146.0
 *
 * That makes them deliberately brittle: if a CLI changes its output format, the
 * version becomes `UNKNOWN` rather than being guessed at. Fail-closed is the
 * point — a wrong version silently reported is worse than an absent one.
 */
const NUMERIC_TRIPLE = String.raw`\d{1,6}\.\d{1,6}\.\d{1,6}`;

const PROBE_VERSION_FORMATS: ReadonlyMap<string, RegExp> = new Map<string, RegExp>([
  // `v24.18.1`
  ['node.version', new RegExp(`^v(${NUMERIC_TRIPLE})$`)],
  // `11.12.1`
  ['npm.version', new RegExp(`^(${NUMERIC_TRIPLE})$`)],
  // `git version 2.55.0.windows.3` — the Windows build suffix is matched so the
  // line is fully anchored, but it is not part of the captured value.
  ['git.version', new RegExp(`^git version (${NUMERIC_TRIPLE})(?:\\.windows\\.\\d{1,6})?$`)],
  // `2.1.220 (Claude Code)`
  ['claude.version', new RegExp(`^(${NUMERIC_TRIPLE}) \\(Claude Code\\)$`)],
  // `codex-cli 0.146.0`
  ['codex.version', new RegExp(`^codex-cli (${NUMERIC_TRIPLE})$`)],
]);

/**
 * The only syntax a reported version value may have: three dotted numbers.
 *
 * Applied to the captured group as a second, independent gate, so a future
 * pattern edit cannot widen what a version is allowed to contain.
 */
const VERSION_VALUE = new RegExp(`^${NUMERIC_TRIPLE}$`);

/** Probe ids that carry a version parser. Exported for tests and audits. */
export const VERSION_PROBE_IDS: readonly string[] = Object.freeze([...PROBE_VERSION_FORMATS.keys()]);

/**
 * The version of one specific probe's `stdout`, or `null`.
 *
 * `null` means "this probe did not produce the exact output format we know",
 * which every caller must treat as `UNKNOWN`, never as a defect-free absence.
 */
export function extractProbeVersion(probeId: string, stdout: string): string | null {
  const format = PROBE_VERSION_FORMATS.get(probeId);
  if (format === undefined) return null;

  // Normalisation is whitespace only: leading/trailing blanks and line endings.
  // It never removes content, so it cannot turn an unexpected line into an
  // expected one.
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return null;

  const match = format.exec(lines[0] ?? '');
  const version = match?.[1];
  if (version === undefined || !VERSION_VALUE.test(version)) return null;
  return version;
}

// ── Facts ──────────────────────────────────────────────────────────────────

/**
 * Everything a probe may contribute to a persistent artefact.
 *
 * Every field is a fixed vocabulary value, a number, a timestamp the
 * orchestrator produced, or a token from a closed list. There is no field that
 * could hold raw output, and none that could hold text a probed program chose.
 */
export interface CapabilityFacts {
  readonly probeId: string;
  readonly program: KnownProgram;
  readonly args: readonly string[];
  readonly required: boolean;
  readonly started: boolean;
  readonly outcome: CommandOutcome;
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** Timeout / spawn / output-limit status, as a fixed code. */
  readonly failureCode: CommandFailureCode | null;
  /** Allow-listed errno identifier, never a message. */
  readonly errnoCode: string | null;
  /** Whether a stream hit its byte budget. */
  readonly outputTruncated: boolean;
  /** Whether the probe wrote anything at all. Not *what* it wrote. */
  readonly producedOutput: boolean;
  readonly version: string | null;
  readonly subcommands: readonly RecognisedSubcommand[];
  readonly flags: readonly RecognisedFlag[];
  /**
   * Whether any recognised token was found. `false` means the output could not
   * be parsed conservatively, which makes every capability answer `UNKNOWN`.
   */
  readonly outputParsed: boolean;
  /** Always true: the raw stdout/stderr of this probe was thrown away. */
  readonly rawOutputDiscarded: true;
}

export interface CapabilityRecord {
  readonly probe: CapabilityProbe;
  readonly availability: ProbeAvailability;
  /** The only representation of the probe that survives past this module. */
  readonly facts: CapabilityFacts;
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

/**
 * Reduces a raw {@link CommandResult} to {@link CapabilityFacts}.
 *
 * This is the one place raw output is read, and nothing derived from it leaves
 * except a version number and allow-listed tokens. The caller drops the
 * `CommandResult` immediately afterwards.
 */
export function deriveCapabilityFacts(
  probe: CapabilityProbe,
  result: CommandResult,
): CapabilityFacts {
  const combined = `${result.stdout}\n${result.stderr}`;
  const flags = extractFlags(combined);
  const subcommands = extractSubcommands(combined);
  // Probe-specific and stdout-only: a `--help` probe has no parser at all, and
  // a version appearing anywhere else than the one expected stdout line is not
  // this probe's version (AO-002-R1-RR1).
  const version = extractProbeVersion(probe.id, result.stdout);

  return Object.freeze({
    probeId: probe.id,
    program: probe.program,
    args: probe.args,
    required: probe.required,
    started: result.started,
    outcome: result.outcome,
    exitCode: result.exitCode,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    failureCode: result.failureCode,
    errnoCode: result.errnoCode,
    outputTruncated: result.stdoutTruncated || result.stderrTruncated,
    producedOutput: combined.trim().length > 0,
    version,
    subcommands,
    flags,
    outputParsed: flags.length > 0 || subcommands.length > 0 || version !== null,
    rawOutputDiscarded: true,
  });
}

/**
 * Runs every probe and returns facts only.
 *
 * The raw `CommandResult` is consumed inside the loop and never stored, so
 * there is no object graph anywhere in the doctor that still holds a probe's
 * stdout or stderr.
 */
export async function runCapabilityDump(options: RunOptions): Promise<readonly CapabilityRecord[]> {
  const records: CapabilityRecord[] = [];
  for (const probe of CAPABILITY_PROBES) {
    const result = await runCommand(probe.program, probe.args, options);
    records.push(
      Object.freeze({
        probe,
        availability: classifyProbe(result),
        facts: deriveCapabilityFacts(probe, result),
      }),
    );
  }
  return records;
}

export function findRecord(
  records: readonly CapabilityRecord[],
  id: string,
): CapabilityRecord | undefined {
  return records.find((r) => r.probe.id === id);
}

// ── Boolean capability answers ─────────────────────────────────────────────

/**
 * A capability answer. `UNKNOWN` is a real answer, not a missing one: it means
 * the probe did not produce output this module is willing to interpret, and
 * every caller must treat it as "not proven" and fail closed.
 */
export type CapabilityAnswer = 'YES' | 'NO' | 'UNKNOWN';

export function probeSupportsFlag(
  record: CapabilityRecord | undefined,
  flag: RecognisedFlag,
): CapabilityAnswer {
  if (record === undefined || record.availability !== 'AVAILABLE') return 'UNKNOWN';
  if (!record.facts.outputParsed) return 'UNKNOWN';
  return record.facts.flags.includes(flag) ? 'YES' : 'NO';
}

/** `YES` when *any* of the flags is present; `UNKNOWN` dominates a `NO`. */
export function probeSupportsAnyFlag(
  record: CapabilityRecord | undefined,
  flags: readonly RecognisedFlag[],
): CapabilityAnswer {
  let answer: CapabilityAnswer = 'NO';
  for (const flag of flags) {
    const single = probeSupportsFlag(record, flag);
    if (single === 'YES') return 'YES';
    if (single === 'UNKNOWN') answer = 'UNKNOWN';
  }
  return answer;
}

/** The boolean capability results persisted alongside the probe facts. */
export interface CapabilityAnswers {
  /** `claude auth status` can emit JSON — the basis of the Claude auth check. */
  readonly claudeAuthStatusSupportsJson: CapabilityAnswer;
  /** `claude auth login --console` exists, i.e. an API-billing login path does. */
  readonly claudeLoginOffersConsoleMode: CapabilityAnswer;
  /** `codex login status` offers a machine-readable output format. */
  readonly codexLoginStatusMachineReadable: CapabilityAnswer;
  /** `codex login --with-api-key` exists, i.e. an API-key login path does. */
  readonly codexLoginOffersApiKeyMode: CapabilityAnswer;
}

export function deriveCapabilityAnswers(
  records: readonly CapabilityRecord[],
): CapabilityAnswers {
  return {
    claudeAuthStatusSupportsJson: probeSupportsFlag(
      findRecord(records, 'claude.auth.status.help'),
      '--json',
    ),
    claudeLoginOffersConsoleMode: probeSupportsFlag(
      findRecord(records, 'claude.auth.login.help'),
      '--console',
    ),
    codexLoginStatusMachineReadable: probeSupportsAnyFlag(
      findRecord(records, 'codex.login.status.help'),
      ['--json', '--format'],
    ),
    codexLoginOffersApiKeyMode: probeSupportsFlag(
      findRecord(records, 'codex.login.help'),
      '--with-api-key',
    ),
  };
}

// ── Rendering ──────────────────────────────────────────────────────────────

const SEPARATOR = '='.repeat(78);

/**
 * Renders `cli-capabilities.txt`.
 *
 * The file kept its name and its purpose — telling an operator what the local
 * toolchain can do — but not its old contents. It is a structured summary of
 * {@link CapabilityFacts}; the raw `--help` / `--version` dump it used to carry
 * was removed for the reasons in this module's header (AO-002-R1). Every value
 * printed here is either produced by this tool or drawn from a closed
 * vocabulary, so there is nothing left to redact.
 */
export function renderCapabilitySummary(
  records: readonly CapabilityRecord[],
  answers: CapabilityAnswers,
  generatedAt: string,
  runId: string,
): string {
  const lines: string[] = [
    SEPARATOR,
    'agent-loop doctor — CLI capability summary',
    `run id      : ${runId}`,
    `generated at: ${generatedAt}`,
    '',
    'Read-only `--version` / `--help` probes of the locally installed CLIs.',
    'The raw stdout/stderr dump this file used to contain was REMOVED for',
    'security reasons (AO-002-R1): pattern-based redaction cannot recognise',
    'unknown sensitive content, so process output is discarded instead of',
    'sanitised. Only the structured, allow-listed facts below are persisted.',
    'No credential store is read and no login is performed.',
    SEPARATOR,
    '',
  ];

  for (const { facts, availability } of records) {
    lines.push(SEPARATOR);
    lines.push(`PROBE       : ${facts.probeId}`);
    lines.push(`PROGRAM     : ${facts.program}`);
    lines.push(`ARGV        : ${JSON.stringify(facts.args)}`);
    lines.push(`REQUIRED    : ${facts.required ? 'yes' : 'no'}`);
    lines.push(`STARTED     : ${facts.started ? 'yes' : 'no'}`);
    lines.push(`OUTCOME     : ${facts.outcome}`);
    lines.push(`AVAILABLE   : ${availability}`);
    lines.push(`EXIT CODE   : ${facts.exitCode === null ? '<none>' : String(facts.exitCode)}`);
    lines.push(`STARTED AT  : ${facts.startedAt}`);
    lines.push(`FINISHED AT : ${facts.finishedAt}`);
    lines.push(`DURATION    : ${facts.durationMs} ms`);
    // Fixed codes only — an exception message would republish untrusted text.
    lines.push(`FAILURE     : ${facts.failureCode ?? '<none>'}`);
    lines.push(`ERRNO       : ${facts.errnoCode ?? '<none>'}`);
    lines.push(`TRUNCATED   : ${facts.outputTruncated ? 'yes' : 'no'}`);
    lines.push(`OUTPUT SEEN : ${facts.producedOutput ? 'yes' : 'no'}`);
    lines.push(`PARSED      : ${facts.outputParsed ? 'yes' : 'no'}`);
    lines.push(`VERSION     : ${facts.version ?? '<none>'}`);
    lines.push(
      `SUBCOMMANDS : ${facts.subcommands.length > 0 ? facts.subcommands.join(', ') : '<none recognised>'}`,
    );
    lines.push(
      `FLAGS       : ${facts.flags.length > 0 ? facts.flags.join(', ') : '<none recognised>'}`,
    );
    lines.push(`RAW OUTPUT  : discarded`);
    lines.push(SEPARATOR);
    lines.push('');
  }

  lines.push(SEPARATOR);
  lines.push('CAPABILITY ANSWERS (YES / NO / UNKNOWN — UNKNOWN fails closed)');
  lines.push(SEPARATOR);
  for (const [name, answer] of Object.entries(answers)) {
    lines.push(`${name.padEnd(34)}: ${answer}`);
  }
  lines.push(SEPARATOR);

  return `${lines.join('\n')}\n`;
}
