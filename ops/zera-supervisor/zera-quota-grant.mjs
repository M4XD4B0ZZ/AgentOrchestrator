/**
 * Zera quota-grant prover — read-only. Decides whether the operator's STANDING
 * authorisation covers issuing `--continue-usage-limit` for the live task right
 * now. It changes no task state, takes no lease, creates or modifies no
 * worktree, contacts no remote, touches no AO source, and does not even write
 * the retry ledger it reads (the supervisor spends that, and only after this
 * file has said yes).
 *
 * Deliberately NOT "writes nothing", which is stronger than AO claims for its
 * own read-only commands. It shells `run --repository`, whose trailer narrows to
 * "Observing a worktree may let Git refresh its own index"
 * (src/run/render-run-plan.ts:45-47) precisely because AO refuses to claim
 * byte-identity. Restating a claim AO withdrew would be this file's own
 * overclaim.
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 *
 * `--continue-usage-limit` is an OPERATOR grant. It stays one. What changed on
 * 2026-09-12 is not AO's state machine but who is standing behind that grant:
 * the operator issued a narrow standing authorisation so that ordinary quota
 * recovery does not need a person at a keyboard. This file is that
 * authorisation written as a predicate, evaluated fresh every time, outside AO.
 *
 * It must never be described as AO granting itself continuation. AO refuses an
 * automatic resume here exactly as before; the supervisor supplies the operator
 * grant, on the operator's recorded instruction, and only when every condition
 * below holds.
 *
 * ── Why the predicate is short ──────────────────────────────────────────────
 *
 * Most of the operator's conditions collapse into ONE check, because AO already
 * decided them. `STATE_ATTENTION` (src/core/task-attention.ts) is total over
 * `ALL_STATES` by `satisfies`, and a task has exactly one state, so:
 *
 *   BLOCKED_AUTH           -> AGENT_LOGIN_REQUIRED
 *   BLOCKED_VERIFY         -> VERIFICATION_REMEDIATION_REQUIRED
 *   SCOPE_VIOLATION        -> SCOPE_REVIEW_REQUIRED
 *   RESUME_STATE_DIVERGED  -> DIVERGENCE_REVIEW_REQUIRED
 *   HUMAN_DECISION_REQUIRED-> ESCALATED_DECISION_REQUIRED
 *   BLOCKED_USAGE_LIMIT    -> QUOTA_CONTINUATION_REQUIRED (by quota reading)
 *
 * Requiring the reason to be exactly QUOTA_CONTINUATION_REQUIRED therefore rules
 * out every blocking STATE other than the quota block — a human decision, a
 * product/design blocker, a scope violation, a divergence, a login-required
 * state — in one check, using AO's own map rather than a hand-copied list that
 * would go stale the first time AO adds a state.
 *
 * It does NOT rule out conditions that are not task states at all, and saying
 * otherwise would be an overclaim this file has already made once. AO's own
 * module says so (src/core/task-attention.ts:38-55): "this module cannot see
 * conditions that are not in a task record at all. A repository whose profile
 * stopped parsing, a lease whose owner cannot be proven dead, an auth preflight
 * that failed — those halt a pass and are reported by the pass, and none of them
 * is a task state."
 *
 * So an expired agent login, a lease taken between this proof and the
 * invocation, or an unavailable required capability are all invisible here. They
 * are caught AFTER the attempt instead: the supervisor re-reads the state once
 * the granted invocation returns, and a task that moved to any non-quota
 * blocking state wakes the operator immediately rather than being retried three
 * more times in silence.
 *
 * Likewise, "may an operator continue this at all" is not re-decided here:
 * `usageLimitContinuation(record, now).permitted` is AO's own answer, and it is
 * the same line the CLI flag draws. RESET_AHEAD is the machine's wait and is
 * refused; a reset passed over an intact record is the automatic path's and is
 * refused; only RESET_UNRECORDED, RESET_UNREADABLE and RESUME_RECORD_WITHDRAWN
 * permit. This file never widens that.
 *
 * ── Fail closed ────────────────────────────────────────────────────────────
 *
 * Anything unreadable is UNDECIDABLE and blocks. A mixed or ambiguous state
 * blocks. The default answer is no.
 *
 * Exit codes:
 *   0  GRANT_AUTHORISED — the standing authorisation covers this, now
 *   10 GRANT_NOT_AUTHORISED — it does not; not an error
 *   2  UNDECIDABLE — could not read something it must read
 *
 * Usage:
 *   node zera-quota-grant.mjs --repository <root> [--budget <file>]
 *                             [--retry-hours 2] [--max-per-day 4]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const AO_ROOT = process.env.AO_ROOT ?? 'D:\\AgentOrchestrator';

const EXIT_AUTHORISED = 0;
const EXIT_NOT_AUTHORISED = 10;
const EXIT_UNDECIDABLE = 2;

/** One instant for the whole decision, so two reads cannot disagree about now. */
const NOW_MS = Date.now();
const NOW = new Date(NOW_MS).toISOString();

/**
 * Read JSON written by anyone, including PowerShell.
 *
 * `Set-Content -Encoding utf8` on Windows PowerShell 5.1 writes a UTF-8 BOM, and
 * `JSON.parse` rejects a leading U+FEFF outright:
 *
 *   Unexpected token '﻿', "﻿{ ... is not valid JSON
 *
 * Measured 2026-09-12 on the retry ledger, which the supervisor writes in
 * PowerShell and this file reads in Node. It failed closed (UNDECIDABLE, never
 * "treat as empty"), so it could not have granted wrongly -- but it would have
 * blocked the loop permanently from the first spend onward.
 *
 * The same BOM that PowerShell REQUIRES on a .ps1 file is the one Node refuses
 * here. Strip it at every JSON boundary rather than relying on who wrote it.
 */
function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
}

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const REPO = argOf('--repository');
const BUDGET_FILE = argOf('--budget', join('C:\\Users\\Max\\AO-runs', 'zera-retry-budget.json'));
const RETRY_HOURS = Number(argOf('--retry-hours', '2'));
const MAX_PER_DAY = Number(argOf('--max-per-day', '4'));

const conditions = [];
let undecidable = null;
let grantTask = null;
let nextRetryAt = null;
/** OPEN | SPACING | EXHAUSTED. EXHAUSTED is the one the operator asked to hear about. */
let budgetState = 'UNKNOWN';

function cond(name, ok, evidence) {
  conditions.push({ name, ok, evidence });
}

function report() {
  console.log(`GRANT_JUDGED_AT = ${NOW}`);
  console.log(`GRANT_TASK = ${grantTask ?? 'none'}`);
  for (const c of conditions) {
    console.log(`COND ${c.ok ? 'PASS' : 'BLOCK'} ${c.name} — ${c.evidence}`);
  }
  console.log(`GRANT_NEXT_RETRY_AT = ${nextRetryAt ?? 'none'}`);
  console.log(`GRANT_BUDGET_STATE = ${budgetState}`);
  if (undecidable !== null) {
    console.log('GRANT_VERDICT = UNDECIDABLE');
    console.log(`GRANT_REASON = ${undecidable}`);
    return;
  }
  const blocked = conditions.filter((c) => !c.ok);
  if (blocked.length === 0) {
    console.log('GRANT_VERDICT = GRANT_AUTHORISED');
    console.log(`GRANT_REASON = all ${conditions.length} standing-authorisation conditions hold`);
  } else {
    console.log('GRANT_VERDICT = GRANT_NOT_AUTHORISED');
    console.log(`GRANT_REASON = ${blocked.map((c) => c.name).join('; ')}`);
  }
}

function die(reason) {
  undecidable = reason;
  report();
  process.exit(EXIT_UNDECIDABLE);
}

if (!REPO) die('usage: --repository <root>');
if (!Number.isFinite(RETRY_HOURS) || RETRY_HOURS <= 0) die(`--retry-hours must be a positive number, got ${RETRY_HOURS}`);
if (!Number.isFinite(MAX_PER_DAY) || MAX_PER_DAY <= 0) die(`--max-per-day must be a positive number, got ${MAX_PER_DAY}`);
const ROOT = resolve(REPO);
if (!existsSync(ROOT)) die(`no repository at ${ROOT}`);

/** ── AO's own judgement, from the build the run will actually use ────────── */
let attentionForTaskState;
let usageLimitContinuation;
let safeParseTaskState;
try {
  const attention = await import(pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-attention.js')).href);
  const quota = await import(pathToFileURL(join(AO_ROOT, 'dist', 'core', 'usage-limit-continuation.js')).href);
  const taskState = await import(pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-state.js')).href);
  attentionForTaskState = attention.attentionForTaskState;
  usageLimitContinuation = quota.usageLimitContinuation;
  safeParseTaskState = taskState.safeParseTaskState;
} catch (error) {
  die(`cannot load AO's judgement out of ${AO_ROOT}\\dist — ${error.message}`);
}
if (
  typeof attentionForTaskState !== 'function' ||
  typeof usageLimitContinuation !== 'function' ||
  typeof safeParseTaskState !== 'function'
) {
  die("AO's dist does not export attentionForTaskState / usageLimitContinuation / safeParseTaskState");
}

function ao(args) {
  try {
    return execFileSync(process.execPath, [join(AO_ROOT, 'dist', 'cli', 'index.js'), ...args], {
      encoding: 'utf8',
      cwd: AO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // A non-zero exit is a statement about the TASK, not about the report, so
    // stdout is what matters. Only an empty stdout is unreadable.
    const out = (error.stdout ?? '').toString();
    if (out.trim() === '') die(`AO produced no output for \`${args.join(' ')}\` — ${error.message}`);
    return out;
  }
}

/** ── 1. Planner ranking: which task is live, on AO's own answer ──────────── */
const planText = ao(['run', '--repository', ROOT]);
const rankingLine = /^Ranking\s*:\s*(.+?)\s*$/m.exec(planText);
if (!rankingLine) die("AO's read-only plan printed no Ranking line");
const ranking = rankingLine[1] === 'empty' ? [] : rankingLine[1].split('>').map((s) => s.trim()).filter(Boolean);

const selectionLine = /^Selection\s*:\s*(\S+)/m.exec(planText);
if (!selectionLine) die("AO's read-only plan printed no Selection line");
if (selectionLine[1] !== 'TASK_SELECTED') {
  cond('planner-selected-a-task', false, `AO reports Selection: ${selectionLine[1]}; there is no live task to grant for`);
  report();
  process.exit(EXIT_NOT_AUTHORISED);
}
if (ranking.length === 0) {
  cond('planner-selected-a-task', false, 'AO ranks no eligible task');
  report();
  process.exit(EXIT_NOT_AUTHORISED);
}
const live = ranking[0];
grantTask = live;
cond('planner-selected-a-task', true, `AO ranks ${ranking.join(' > ')}; the live task is ${live}`);

/** ── 2. The durable record, parsed against AO's own contract ─────────────── */
const recordPath = join(ROOT, '.agent-orchestrator', 'runtime', `${live}.json`);
if (!existsSync(recordPath)) {
  // Never started. Not a grant case at all: an unstarted task needs no grant,
  // and handing one to it would be an override nobody asked for.
  cond('task-is-already-started', false, `no durable runtime record at ${recordPath}; an unstarted task needs no continuation grant`);
  report();
  process.exit(EXIT_NOT_AUTHORISED);
}
let record;
try {
  const parsed = safeParseTaskState(readJsonFile(recordPath));
  if (parsed.success !== true) die(`runtime record violates AO's task-state contract: ${recordPath}`);
  record = parsed.data;
} catch (error) {
  die(`runtime record unreadable: ${recordPath} — ${error.message}`);
}
/**
 * `workBranch` and `worktreePath` are required NonBlankStrings on every
 * TaskState (src/core/internal/task-state-object-schema.ts), so asserting they
 * are non-empty passes for any record that parsed at all — a condition that
 * cannot fail is not a check. What CAN be false is that the workspace the resume
 * would re-enter is still on disk.
 */
cond(
  'the-task-workspace-still-exists',
  existsSync(record.worktreePath),
  existsSync(record.worktreePath)
    ? `${record.worktreePath} is present, on branch ${record.workBranch}`
    : `${record.worktreePath} is gone; there is nothing for a resume to re-enter`,
);

/** ── 3. The state is exactly the one the authorisation names ─────────────── */
cond(
  'state-is-exactly-blocked-usage-limit',
  record.state === 'BLOCKED_USAGE_LIMIT',
  `AO durable state is ${record.state}`,
);

/** ── 3b. Never the reviewer's block (2026-10-01) ─────────────────────────── */
/**
 * A review is relaunched only by an operator at the keyboard. The standing
 * authorisation covers a writer's quota recovery; it never covers a Codex review,
 * because a supervisor supplying `--continue-usage-limit` for one is exactly the
 * timed reviewer relaunch AO now refuses on its own path
 * (`REVIEWER_BLOCK_REQUIRES_OPERATOR`, src/core/automatic-resume.ts).
 */
cond(
  'the-block-is-not-the-reviewers',
  record.blockedAgent !== 'codex',
  record.blockedAgent === 'codex'
    ? 'the quota block is the reviewer\'s; only an operator relaunches a review, never a standing grant'
    : `the blocked agent is ${record.blockedAgent}`,
);

/** ── 4. AO says an operator grant may continue this ──────────────────────── */
let continuation;
try {
  continuation = usageLimitContinuation(record, NOW);
} catch (error) {
  die(`AO refused to read ${live}'s quota block — ${error.message}`);
}
cond(
  'ao-says-an-operator-grant-may-continue',
  continuation.permitted === true,
  `usageLimitContinuation reads ${continuation.reading}, permitted=${continuation.permitted}` +
    (continuation.permitted === true
      ? ' (RESET_AHEAD and a reset passed over an intact record are refused by AO itself, and this file never widens that)'
      : ' — this is not a reading the operator grant covers'),
);

/** ── 4b. A resume point exists ───────────────────────────────────────────── */
/**
 * AO's own gate is, verbatim (src/run/run-driver.ts:1114):
 *
 *   state.state === 'BLOCKED_USAGE_LIMIT' && quota.permitted &&
 *   request.continueUsageLimit && mayContinueUsageLimit(grant) &&
 *   state.resumeFrom !== null && !usageLimitContinuationSpent
 *
 * `resumeFrom !== null` is already implied by condition 4 — `RESUME_POINT_MISSING`
 * is refused above every permit path in `usageLimitContinuation` — so this
 * cannot currently fail on its own. It is asserted anyway, because the claim
 * being made is "this prover draws AO's line, not a looser one", and a term of
 * AO's gate that is only implied is a term that can drift apart silently. If
 * this ever blocks alone, AO's gate and its classifier have diverged and that is
 * worth stopping for.
 */
cond(
  'a-resume-point-exists',
  record.resumeFrom !== null && record.resumeFrom !== undefined,
  record.resumeFrom
    ? `record resumes from phase=${record.resumeFrom.phase} round=${record.resumeFrom.round}`
    : 'record names no resume point, so AO would refuse the grant and the attempt would be spent for nothing',
);

/** ── 5. Nobody is owed anything BUT the quota continuation ───────────────── */
/**
 * The single check that rules out a simultaneous human decision, a product or
 * design blocker, a scope violation, a divergence, and every auth condition
 * needing judgement. It works because AO's attention map is total over states
 * and a task has exactly one state.
 */
let judged;
try {
  judged = attentionForTaskState(record, NOW);
} catch (error) {
  die(`AO refused to judge ${live} — ${error.message}`);
}
cond(
  'the-only-attention-owed-is-quota-continuation',
  judged.attention === true && judged.reason === 'QUOTA_CONTINUATION_REQUIRED',
  judged.attention === true
    ? `AO raises ${judged.reason}${judged.detail ? `/${judged.detail}` : ''}`
    : 'AO raises no attention at all, so there is nothing for a grant to answer',
);

/** ── 6. The task file has not already been closed ────────────────────────── */
const taskFile = join(ROOT, '.agent-orchestrator', 'tasks', `${live}.md`);
if (!existsSync(taskFile)) die(`no task file at ${taskFile}`);
let taskText;
try {
  taskText = readFileSync(taskFile, 'utf8');
} catch (error) {
  die(`task file unreadable: ${taskFile} — ${error.message}`);
}
const statusMatch = /^status:\s*(\S+)\s*$/m.exec(taskText);
if (!statusMatch) die(`task file ${taskFile} has no status line`);
cond(
  'task-file-is-not-done',
  statusMatch[1] !== 'DONE',
  `${live}.md says status: ${statusMatch[1]}`,
);

/** ── 7. No lease conflict ────────────────────────────────────────────────── */
const leaseText = ao(['lease', 'status', '--repository', ROOT]);
const leaseLine = /^Lease\s*:\s*(\S+)/m.exec(leaseText);
if (!leaseLine) die("AO's lease report printed no Lease line");
cond(
  'no-lease-conflict',
  leaseLine[1] === 'FREE',
  `AO reports Lease: ${leaseLine[1]}` + (leaseLine[1] === 'FREE' ? '' : '; another invocation owns this repository'),
);

/** ── 8. The bounded retry budget permits an attempt ──────────────────────── */
/**
 * Read only. The supervisor spends the budget, and only after this file says
 * yes, so a prover that crashed cannot burn an attempt.
 *
 * The ledger is keyed BY TASK. A flat list would let CAPTURE-003's refusals
 * spend the allowance CAPTURE-004 has not used yet.
 */
function readAttempts() {
  if (!existsSync(BUDGET_FILE)) return [];
  let parsed;
  try {
    parsed = readJsonFile(BUDGET_FILE);
  } catch (error) {
    die(`retry ledger unreadable at ${BUDGET_FILE} — ${error.message}; refusing to guess how much budget is left`);
  }
  // v2 is keyed by task. v1 was a flat array and is read as this task's, which
  // is the conservative direction: it can only make the budget look MORE spent.
  if (parsed && typeof parsed === 'object' && parsed.tasks && typeof parsed.tasks === 'object') {
    const entry = parsed.tasks[live];
    // No entry means no attempt has been spent for this task. An entry whose
    // `attempts` is not an array is a DIFFERENT statement: something wrote a
    // shape this reader does not understand, and reading it as an empty list
    // would hand back a full budget — the one direction a fail-closed reader may
    // never take. `?? []` did exactly that here until 2026-09-13, when a review
    // of the sibling writer-restart prover found the same line in both.
    if (entry === undefined || entry === null) return [];
    if (!Array.isArray(entry.attempts)) {
      die(`retry ledger entry ${live} at ${BUDGET_FILE} has no attempts array; refusing to guess how much budget is left`);
    }
    return entry.attempts;
  }
  // A v1 flat array is REFUSED, not half-understood. This reader would have
  // counted it as the live task's while the supervisor's writer discards it
  // entirely on the next spend — two readers disagreeing about how much budget
  // is left is worse than stopping. Nothing writes v1.
  die(`retry ledger at ${BUDGET_FILE} is in no shape this reader recognises (expected schemaVersion 2 with a tasks map)`);
  return [];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const rawAttempts = readAttempts();
const parsedAttempts = [];
for (const a of rawAttempts) {
  const t = Date.parse(a);
  if (Number.isNaN(t)) die(`retry ledger holds an unparseable instant: ${JSON.stringify(a)}`);
  parsedAttempts.push(t);
}
// Compared as instants, never as strings: the ledger records an offset-bearing
// ISO instant, and two equal instants can sort wrongly as text.
parsedAttempts.sort((a, b) => a - b);
const recent = parsedAttempts.filter((t) => t > NOW_MS - DAY_MS);

/**
 * `budgetState` exists because the two refusals mean different things to the
 * operator and the caller could not previously tell them apart: both set
 * GRANT_NEXT_RETRY_AT, and the distinguishing text lived only in the COND line,
 * which the supervisor's `KEY = VALUE` parser discards. The operating policy
 * says "park and notify when the budget is exhausted" and says nothing about
 * telling anybody during an ordinary two-hour wait, so the difference has to
 * reach the caller as its own key.
 */
budgetState = 'OPEN';
let budgetOk = true;
let budgetWhy = `${recent.length} of ${MAX_PER_DAY} attempt(s) spent in the last 24 h for ${live}`;
if (recent.length >= MAX_PER_DAY) {
  budgetOk = false;
  budgetState = 'EXHAUSTED';
  nextRetryAt = new Date(recent[0] + DAY_MS).toISOString();
  budgetWhy = `${recent.length} of ${MAX_PER_DAY} attempts already spent for ${live} in the last 24 h; the oldest ages out at ${nextRetryAt}`;
} else if (recent.length > 0) {
  const due = recent[recent.length - 1] + RETRY_HOURS * 60 * 60 * 1000;
  if (NOW_MS < due) {
    budgetOk = false;
    budgetState = 'SPACING';
    nextRetryAt = new Date(due).toISOString();
    budgetWhy = `last attempt for ${live} was ${new Date(recent[recent.length - 1]).toISOString()}; the ${RETRY_HOURS} h spacing makes the next one due at ${nextRetryAt}`;
  }
}
cond('retry-budget-permits-an-attempt', budgetOk, budgetWhy);

report();
process.exit(conditions.every((c) => c.ok) ? EXIT_AUTHORISED : EXIT_NOT_AUTHORISED);
