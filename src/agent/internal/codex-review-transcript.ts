/**
 * Reading a Codex review: the JSONL transcript, and the review document the
 * reviewer is asked to end its turn with.
 *
 * INTERNAL, for the reason `claude-result-envelope.ts` gives — this reads
 * foreign text, and a caller holding it could ask "does this look like a pass"
 * without any of the process-level facts that make the question answerable.
 *
 * ── Evidence baseline (captured on this machine while implementing) ────────
 *
 * `codex --version` → `codex-cli 0.146.0`.
 *
 * `codex exec --json -s read-only --skip-git-repo-check "reply with the single
 * word ok"` printed, on stdout, one JSON object per line:
 *
 *     {"type":"thread.started","thread_id":"019fe9ec-…"}
 *     {"type":"turn.started"}
 *     {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}
 *     {"type":"turn.completed","usage":{…}}
 *
 * and, on stderr, an unrelated cache warning (`ERROR
 * codex_models_manager::cache: failed to load models cache`) *on a run that
 * succeeded*. That last observation is why stderr is never read as a verdict
 * here: this CLI writes diagnostics there routinely, and a rule that treated
 * stderr content as failure would fail every healthy run on this machine.
 *
 * ── Two layers, and why the reviewer does not get to name its own findings ─
 *
 * The transcript is *transport*: it says whether a turn finished and carries
 * the agent's last message. The review document inside that message is
 * *content*, and it is validated field by field against a closed vocabulary.
 *
 * The reviewer supplies a severity, a path and a rule id. It does **not**
 * supply the fingerprint: `TaskState.findingHistory[].fingerprint` is the only
 * free-form string in the durable contract, and letting a reviewed-repository
 * agent choose it would publish untrusted text into a persisted artefact — the
 * one thing every other module in this repository refuses to do. The
 * fingerprint is computed here, from the allow-listed fields, at a fixed
 * length, which also makes the state's size bound provable rather than hoped
 * for.
 */

import { createHash } from 'node:crypto';

import { FINDING_SEVERITIES, type FindingSeverity } from '../../core/states.js';

/** The document version this reader understands. A future one is unrecognised, not assumed. */
const REVIEW_DOCUMENT_VERSION = 1;

/**
 * Findings one review may report.
 *
 * A cap rather than a truncation: a review with more findings than this is not
 * silently shortened into a smaller review, it is refused. `saveTaskState`
 * measures the serialised state against a 1 MiB ceiling before writing, and
 * `findingHistory` is the field that can grow without bound, so the bound has
 * to exist somewhere. Here, with a fixed-length fingerprint, the arithmetic is
 * closed: rounds × 64 findings × a few dozen bytes stays far inside the limit.
 */
const MAX_FINDINGS_PER_REVIEW = 64;

/** Fixed fingerprint width. A truncated SHA-256, hex. */
const FINGERPRINT_LENGTH = 32;

const MAX_PATH_LENGTH = 1_024;
const MAX_RULE_LENGTH = 128;

/** A rule identifier: a bounded slug, never prose. */
const RULE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/;

/** A finding, with the fingerprint this module computed for it. */
export interface ReviewFinding {
  readonly severity: FindingSeverity;
  readonly fingerprint: string;
}

export type CodexTranscriptVerdict =
  /** The turn finished and carried a valid review document. */
  | 'REVIEWED'
  /** Anything else. One verdict, because they all mean "no review to act on". */
  | 'UNRECOGNISED';

export interface CodexTranscriptReading {
  readonly verdict: CodexTranscriptVerdict;
  /**
   * The findings, when `verdict` is `REVIEWED`.
   *
   * An empty array here is a *positive* answer — a review that ran and found
   * nothing — and it is reachable only through a document that said so. It is
   * never a default, never an initial value, and never what a parse failure
   * degrades into.
   */
  readonly findings: readonly ReviewFinding[];
}

const UNRECOGNISED: CodexTranscriptReading = Object.freeze({
  verdict: 'UNRECOGNISED' as const,
  findings: Object.freeze([]) as readonly ReviewFinding[],
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A repository-relative POSIX path, guarded as far as a string can be.
 *
 * Not reused from `repo/internal/repo-profile-object-schema.ts`: that schema
 * describes what a *repository* may declare about itself in a file it owns and
 * reviews. This describes what an *agent* may say about a file it looked at.
 * The two happen to look similar today and are allowed to diverge, which is
 * the same reason that module keeps its own copy of the shell-inert pattern.
 */
function isAcceptablePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return false;
  if (value.includes('\\') || value.includes('\0')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function isAcceptableRule(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_RULE_LENGTH && RULE_PATTERN.test(value);
}

/**
 * The stable identity of a finding across rounds.
 *
 * Over the allow-listed triple only, NUL-separated so that two different
 * triples cannot concatenate into the same string. Truncated to a fixed width:
 * the full digest adds no discrimination worth the bytes at this cardinality,
 * and a fixed width is what makes the state-size bound arithmetic.
 */
export function fingerprintFinding(severity: string, path: string, rule: string): string {
  return createHash('sha256')
    .update(`${severity}\0${path}\0${rule}`)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}

/**
 * Validates one review document.
 *
 * Every rule here is a positive match. There is no coercion, no case folding,
 * no "unknown severity becomes info": severity decides whether a task is
 * blocked, so an unrecognised one invalidates the whole document rather than
 * degrading quietly into the least alarming value.
 */
export function readReviewDocument(text: string): CodexTranscriptReading {
  const trimmed = text.trim();
  if (trimmed.length === 0) return UNRECOGNISED;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return UNRECOGNISED;
  }

  if (!isPlainObject(parsed)) return UNRECOGNISED;
  if (parsed['reviewVersion'] !== REVIEW_DOCUMENT_VERSION) return UNRECOGNISED;

  const verdict = parsed['verdict'];
  if (verdict !== 'PASS' && verdict !== 'FINDINGS') return UNRECOGNISED;

  const raw = parsed['findings'];
  if (!Array.isArray(raw)) return UNRECOGNISED;
  if (raw.length > MAX_FINDINGS_PER_REVIEW) return UNRECOGNISED;

  // The verdict and the list must agree. A document claiming to pass while
  // listing findings is not a pass with a caveat; it is a document we cannot
  // read, and the safe reading of an unreadable review is not "no problems".
  if (verdict === 'PASS' && raw.length !== 0) return UNRECOGNISED;
  if (verdict === 'FINDINGS' && raw.length === 0) return UNRECOGNISED;

  const findings: ReviewFinding[] = [];
  for (const entry of raw) {
    if (!isPlainObject(entry)) return UNRECOGNISED;
    const severity = entry['severity'];
    if (typeof severity !== 'string') return UNRECOGNISED;
    if (!(FINDING_SEVERITIES as readonly string[]).includes(severity)) return UNRECOGNISED;
    const path = entry['path'];
    const rule = entry['rule'];
    if (!isAcceptablePath(path) || !isAcceptableRule(rule)) return UNRECOGNISED;

    findings.push(
      Object.freeze({
        severity: severity as FindingSeverity,
        fingerprint: fingerprintFinding(severity, path, rule),
      }),
    );
  }

  return Object.freeze({ verdict: 'REVIEWED' as const, findings: Object.freeze(findings) });
}

/**
 * Reads the transcript `codex exec --json` prints on stdout.
 *
 * Requires a `turn.completed` event to be present. Its absence is not a
 * detail: it is how a transcript that was cut short, abandoned, or ended by a
 * failure differs from one that finished, and without it the last agent
 * message is just the last thing said before something went wrong.
 *
 * The review document is taken from the **final** `agent_message` item. A
 * malformed line is skipped rather than fatal — the CLI is entitled to emit
 * event kinds this reader has never seen — but a transcript with no usable
 * final message is unrecognised.
 */
export function readCodexTranscript(stdout: string): CodexTranscriptReading {
  let turnCompleted = false;
  let lastMessage: string | null = null;

  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (text.length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (!isPlainObject(event)) continue;

    const type = event['type'];
    if (type === 'turn.completed') {
      turnCompleted = true;
      continue;
    }
    if (type !== 'item.completed') continue;

    const item = event['item'];
    if (!isPlainObject(item)) continue;
    if (item['type'] !== 'agent_message') continue;
    const message = item['text'];
    if (typeof message === 'string') lastMessage = message;
  }

  if (!turnCompleted || lastMessage === null) return UNRECOGNISED;
  return readReviewDocument(lastMessage);
}
