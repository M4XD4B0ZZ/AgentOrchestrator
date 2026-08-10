/**
 * Turning a review into durable evidence, and durable evidence into the next
 * agent's instructions.
 *
 * ── The durable record is narrower than the runtime finding, on purpose ────
 *
 * `ReviewFinding` carries `severity`, `fingerprint`, `path` and `rule`.
 * `TaskState.findingHistory[]` stores `{ round, severity, fingerprint }` and
 * nothing else, because `fingerprint` is the only free-form string the durable
 * contract accepts and it is computed here rather than chosen by the reviewed
 * repository's agent. {@link findingRecordsFor} is that narrowing, stated once.
 *
 * The consequence is deliberate and worth naming: `path` and `rule` do not
 * survive a restart. A remediation prompt built from live review findings can
 * name the files to fix; one rebuilt from `findingHistory` after a crash can
 * only name severities, rounds and fingerprints. That is the price of refusing
 * to persist agent text, and {@link buildRemediationPayload} says so *in the
 * payload itself* rather than presenting a degraded prompt as a complete one.
 *
 * ── History is appended to, never rewritten ────────────────────────────────
 *
 * {@link appendFindings} only ever grows the array, and repeats are kept rather
 * than de-duplicated. A finding reported in round 1 and again in round 2 is two
 * records with the same fingerprint and different rounds — that pair is the
 * evidence that remediation did not work, and a `Set` keyed on the fingerprint
 * would delete precisely the fact worth knowing. `reconcile.ts` also reads a
 * non-empty `findingHistory` as proof a task has done work, so dropping earlier
 * rounds would make the loop's own progress reconcile as divergence.
 */

import type { ReviewFinding } from '../agent/codex-reviewer.js';
import type { TaskState } from '../core/task-state.js';

/** The durable record shape, taken from the state contract rather than restated. */
export type FindingRecord = TaskState['findingHistory'][number];

/** Characters one remediation payload may occupy. Bounded, like everything an agent is handed. */
export const MAX_REMEDIATION_PAYLOAD_CHARS = 16_384;

/**
 * The durable projection of one review round's findings.
 *
 * `round` is 1-based, as `FindingRecordSchema` requires, while `reviewRound`
 * counts *completed* reviews and is 0-based. The round of a review being
 * performed is therefore `reviewRound + 1`, and that is what a caller must pass.
 */
export function findingRecordsFor(
  findings: readonly ReviewFinding[],
  round: number,
): readonly FindingRecord[] {
  return Object.freeze(
    findings.map((finding) =>
      Object.freeze({ round, severity: finding.severity, fingerprint: finding.fingerprint }),
    ),
  );
}

/** Appends one round's records to the history, preserving order and repeats. */
export function appendFindings(
  history: readonly FindingRecord[],
  findings: readonly ReviewFinding[],
  round: number,
): readonly FindingRecord[] {
  return Object.freeze([...history, ...findingRecordsFor(findings, round)]);
}

/**
 * The instructions handed to the reviewer, on stdin.
 *
 * It quotes the canonical review document from `README.md` ("The review
 * document, canonically") because the parser that enforces that shape is
 * internal and a prompt may not reach into it. The two are expected to change
 * together; `codex-review-transcript.ts` names this dependency explicitly.
 *
 * Nothing here interpolates repository text into a command line — this is a
 * stdin payload, and the reviewer's argv is the frozen `CODEX_REVIEWER_ARGS`.
 */
export function buildReviewPayload(taskBrief: string): string {
  return [
    'Review the working tree of this repository for defects introduced by the',
    'current task. You are read-only: do not modify any file.',
    '',
    'TASK BRIEF',
    taskBrief,
    '',
    'Reply with exactly one JSON document as your final message, and nothing else:',
    '',
    '{',
    '  "reviewVersion": 1,',
    '  "verdict": "PASS" | "FINDINGS",',
    '  "findings": [',
    '    { "severity": "critical|high|medium|low|info",',
    '      "path": "repository/relative/posix/path.ts",',
    '      "rule": "bounded.rule-slug" }',
    '  ]',
    '}',
    '',
    'Rules, all enforced:',
    '- "verdict" must agree with the list: PASS requires an empty findings array,',
    '  FINDINGS requires a non-empty one.',
    '- at most 64 findings.',
    '- "path" is repository-relative POSIX, built only from [A-Za-z0-9] and',
    '  ". _ : @ = + / -", at most 1 024 characters: no leading "/", no drive',
    '  letter, no backslash, no "." or ".." segment, and no space, line break or',
    '  control character of any kind. A path is quoted into these instructions,',
    '  so anything that could start a new line of them is refused.',
    '- "rule" is a slug of [A-Za-z0-9] with inner "._:-", at most 128 characters.',
    '- any other shape, any unknown severity, any surrounding prose makes the',
    '  document unreadable, which is never read as "no problems found".',
  ].join('\n');
}

function severityTally(findings: readonly { readonly severity: string }[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([severity, count]) => `${severity}=${count}`)
    .join(' ');
}

/**
 * The instructions handed to the writer for a remediation pass, on stdin.
 *
 * Deterministic: the same findings in the same order produce the same bytes, so
 * a remediation prompt is reproducible from the evidence rather than being a
 * fresh composition each time. Bounded, because a review may carry 64 findings
 * and an agent payload is not allowed to grow without a ceiling.
 */
export function buildRemediationPayload(
  findings: readonly ReviewFinding[],
  round: number,
): string {
  const lines = [
    `Address the findings reported by review round ${round}.`,
    '',
    'Change only what is needed to resolve them. Do not broaden the task.',
    'The verification commands will be re-run afterwards, and the reviewer will',
    'look again; neither is satisfied by a change that hides a finding.',
    '',
    `FINDINGS (${findings.length}; ${severityTally(findings)})`,
  ];

  for (const finding of findings) {
    lines.push(`- [${finding.severity}] ${finding.path} — ${finding.rule}`);
  }

  return clamp(lines.join('\n'));
}

/**
 * What the durable history can say about a remediation pass being resumed.
 *
 * Two members, because "the record is thinner than the live findings were" and
 * "the record holds nothing about this round at all" are different situations
 * with different correct responses. A single `string` return cannot express the
 * second, which is how a brief listing zero findings came to be written in the
 * reviewer's voice.
 */
export type ResumedRemediationBrief =
  /** The durable record for this round, rendered as instructions. */
  | { readonly kind: 'DURABLE_RECORD'; readonly payload: string }
  /**
   * Nothing durable records a finding for this round, so there is nothing to
   * brief. Carries no payload, deliberately: a brief that says "FINDINGS (0)"
   * asserts both that a review ran and that it reported an empty list, and
   * neither is in evidence. The caller must refuse rather than compose one.
   */
  | { readonly kind: 'NO_DURABLE_FINDINGS' };

/**
 * The remediation brief for a pass that was resumed rather than driven straight
 * through, when only the durable history survives.
 *
 * Where there is a record, it is a *weaker* prompt and it says so. The
 * alternative — presenting a severity tally in the shape of an actionable brief
 * — would have the writer guess at which files were meant, and a guess is
 * exactly what this repository refuses to let an agent make on evidence it does
 * not have. Where there is no record, there is no prompt at all: an empty list
 * is the most confident-looking degraded brief of them all, and the one whose
 * every claim is invented.
 */
export function buildResumedRemediationBrief(
  history: readonly FindingRecord[],
  round: number,
): ResumedRemediationBrief {
  const current = history.filter((record) => record.round === round);
  if (current.length === 0) return Object.freeze({ kind: 'NO_DURABLE_FINDINGS' as const });

  const lines = [
    `Address the findings reported by review round ${round}.`,
    '',
    'This pass was resumed after an interruption. The reviewer\'s file paths and',
    'rule identifiers were held in memory only and did not survive, because they',
    'are agent-authored text and this orchestrator does not persist such text.',
    'What follows is the durable record. Re-read the working tree to locate the',
    'findings; do not guess at files this list does not name.',
    '',
    `FINDINGS (${current.length}; ${severityTally(current)})`,
  ];

  for (const record of current) {
    lines.push(`- [${record.severity}] fingerprint ${record.fingerprint}`);
  }

  return Object.freeze({ kind: 'DURABLE_RECORD' as const, payload: clamp(lines.join('\n')) });
}

function clamp(text: string): string {
  if (text.length <= MAX_REMEDIATION_PAYLOAD_CHARS) return text;
  return `${text.slice(0, MAX_REMEDIATION_PAYLOAD_CHARS - 1)}\n`;
}
