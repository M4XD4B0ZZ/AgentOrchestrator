/**
 * Zera writer-restart grant prover — read-only. Decides whether the operator's
 * STANDING authorisation covers issuing `--continue-human-decision` for the live
 * task right now, for ONE recovery shape and no other.
 *
 * "One shape" means one PRODUCER of `HUMAN_DECISION_REQUIRED` — the writing
 * agent's interruption during the implement pass — not one cause. Four writer
 * failure codes share that producer and AO persists none of them, so the shape
 * is wider than the file's original name suggested. That is set out in full
 * below rather than papered over; it is the operator's widening to accept.
 *
 * It changes no task state, takes no lease, creates or modifies no worktree,
 * contacts no remote, touches no AO source, and writes no ledger. Deliberately
 * NOT "writes nothing": it shells `run --repository`, whose own trailer narrows
 * to "Observing a worktree may let Git refresh its own index"
 * (src/run/render-run-plan.ts:45-47). Restating a claim AO withdrew would be
 * this file's own overclaim.
 *
 * ── The one shape, and why it earned an authorisation ───────────────────────
 *
 * Measured repeatedly in real CAPTURE-004 operation: the writing agent's process
 * did not run to its own end. AO diagnosed `AGENT_PROCESS_UNAVAILABLE`, whose
 * disposition is `AGENT_NEEDS_ATTENTION` (src/agent/agent-outcome.ts), and
 * `recordAgentInterruption` parked the task at `HUMAN_DECISION_REQUIRED` with
 * `blockedAgent: 'claude'` and `resumeFrom: { phase: 'IMPLEMENT' }`.
 *
 * Nothing was decided, nothing was reviewed, no finding exists and no product
 * question was asked. For the interruption this was raised for, a person reading
 * it has one useful move: start the writer again. That is the move this
 * authorisation covers -- and NOT for every cause that lands here, as the next
 * section sets out.
 *
 * ── The shape is WIDER than "the process died", and saying so is the point ──
 *
 * An earlier draft of this file said the conjunction identifies a dead writer.
 * It does not, and the difference is not recoverable from any record. A review
 * caught it; it is written down here rather than quietly narrowed, because the
 * operator is the one accepting the widening.
 *
 * `AGENT_FAILURE_DISPOSITION` (src/agent/agent-outcome.ts:140-156) maps FOUR
 * writer failure codes onto the same disposition, and all four are reachable
 * from `claude-writer.ts`:
 *
 *   AGENT_PROCESS_UNAVAILABLE  the process never reached its own end
 *   AGENT_NONZERO_EXIT         it ran and exited non-zero
 *   AGENT_RESULT_MALFORMED     it ran but printed no recognisable envelope
 *   AGENT_ARGUMENT_REFUSED     it was never started: an argument was not inert
 *
 * All four reach `recordInterruption` with the same fallback evidence
 * (loop-step.ts:944-946) and produce a byte-identical record: the failure code
 * is NOT persisted, because `TaskState` is `.strict()` and has no field for it.
 * So no predicate reading durable state can separate them, and this one does not
 * pretend to.
 *
 * What the authorisation therefore covers, stated honestly: **a writing agent
 * that did not complete its implement pass, whatever the diagnosis.** Three of
 * those four are worth one more attempt on their face. The fourth,
 * `AGENT_ARGUMENT_REFUSED`, is deterministic and a restart will reproduce it —
 * which is exactly what the durable restart budget below is for: it costs at
 * most four spawn attempts in a day, and then a person is told.
 *
 * What it still does not cover is every OTHER producer of
 * `HUMAN_DECISION_REQUIRED`, and that exclusion is real rather than assumed —
 * see the enumeration below.
 *
 * ── Why the shape is identifiable, measured rather than assumed ─────────────
 *
 * `HUMAN_DECISION_REQUIRED` has many producers in `src/loop/loop-step.ts`, and
 * every other one of them is excluded by the conjunction below. Enumerated from
 * the build at d813456:
 *
 *   review budget exceeded              -> resumeFrom REMEDIATE
 *   findings at the last permitted round-> resumeFrom REMEDIATE
 *   no durable findings to remediate    -> resumeFrom REMEDIATE
 *   reviewer brief incomplete           -> resumeFrom REVIEW
 *   completion not settled              -> resumeFrom REVIEW
 *   verification evidence not durable   -> resumeFrom VERIFY
 *   reviewer interrupted                -> blockedAgent 'codex'
 *   task brief / context / capability   -> resumeFrom IMPLEMENT, blockedAgent NULL
 *   scope indeterminate during implement-> resumeFrom IMPLEMENT, blockedAgent NULL
 *   the writing agent failed            -> resumeFrom IMPLEMENT, blockedAgent 'claude'  <- this one
 *
 * The last two share a phase and are told apart by `blockedAgent`, which is not
 * a coincidence to lean on but a contract: `task-state.ts` invariant 4 requires
 * `blockedAgent` to be null in every non-blocking state, and both brief-failure
 * writes spread it from `CONTEXT_LOADING` / `IMPLEMENTING`. Only
 * `recordAgentInterruption` names an agent, and only because one ran.
 *
 * ── What this authorisation does NOT cover ──────────────────────────────────
 *
 * Stated as refusals, not as habits, and each is a condition below:
 *
 *   - REMEDIATE review-budget exhaustion. A continuation there refills a budget,
 *     which is a decision about how much review the work is worth;
 *   - a product or design decision;
 *   - review findings waiting to be answered;
 *   - `HUMAN_DECISION_REQUIRED` reached through any OTHER producer.
 *
 * "Any other producer", and deliberately not "any other reason": within this one
 * producer the four writer failure codes are indistinguishable on disk, and the
 * section above says so rather than claiming a narrowness the record cannot
 * support.
 *
 * ── The budget, proved twice and deliberately ───────────────────────────────
 *
 * The operator asked for two things that sound like one: the budget must not be
 * exhausted, and the grant must not increase `grantedReviewRounds`. They are
 * proved separately because they are different sentences and the second is the
 * one with teeth.
 *
 * `run-driver.ts:1569` computes, verbatim:
 *
 *   grantReviewRound = continuingHumanDecision
 *                      && reviewBudgetExhausted(state)
 *                      && reviewBudget(state) < MAX_REVIEW_BUDGET
 *
 * The supervisor's invocation makes `continuingHumanDecision` true by
 * construction — that is what the flag is — so this file evaluates the remaining
 * two conjuncts with AO's own exported functions and requires the result to be
 * `false`. Today it cannot be true while the exhaustion condition holds, and
 * that is the point: if AO ever changes which continuations refill a budget,
 * this blocks rather than silently buying a round the operator did not authorise.
 *
 * ── What it cannot see ──────────────────────────────────────────────────────
 *
 * The same residual the quota prover carries. A repository whose profile stopped
 * parsing, a lease taken between this proof and the invocation, an auth
 * preflight that failed, a reconciliation that answers DIVERGED — none of those
 * is a task state, and none is visible here. AO checks them INSIDE the
 * invocation and refuses there. The supervisor re-reads the state afterwards and
 * stops loudly if the task did not leave this shape.
 *
 * ── Why it is bounded, and why the bound is durable ─────────────────────────
 *
 * This is the ONLY lane that starts an agent against an unchanged tree. A writer
 * that dies again returns the task to the identical shape, so the identical
 * grant is provable on the next pass, and the scheduler re-enters every thirty
 * minutes. An unbounded version of this lane would spend a writer invocation on
 * a dead writer roughly a hundred times a day and tell nobody.
 *
 * So the same bound the quota lane carries applies here: no more often than
 * every N hours, and at most M restarts in any rolling 24 hours, per task. It
 * lives in the same ledger file, under the key `<taskId>#writer-restart`.
 *
 * The suffix is the point and not a convenience. `zera-quota-grant.mjs` looks up
 * `tasks[<taskId>]` with the plain id, so a restart recorded under the suffixed
 * key is invisible to it: one file, two allowances, and neither can spend the
 * other's. A shared key would let a dead writer exhaust the quota budget a
 * provider outage needs, which is two different problems sharing one number.
 *
 * This file only READS the ledger. The supervisor spends it, and only after this
 * file has said yes, so a prover that crashed cannot burn a restart.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
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
 *   node zera-writer-death-grant.mjs --repository <root> [--budget <file>]
 *                                    [--retry-hours 1] [--max-per-day 4]
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
const NOW = new Date().toISOString();

/** Strip a PowerShell-written UTF-8 BOM, which `JSON.parse` rejects outright. */
function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const REPO = argOf('--repository');
const BUDGET_FILE = argOf('--budget', join('C:\\Users\\Max\\AO-runs', 'zera-retry-budget.json'));
const RETRY_HOURS = Number(argOf('--retry-hours', '1'));
const MAX_PER_DAY = Number(argOf('--max-per-day', '4'));

/** One instant for the budget arithmetic, matching NOW above. */
const NOW_MS = Date.parse(NOW);

const conditions = [];
let undecidable = null;
let grantTask = null;
/** What `run-driver.ts` would compute for this record. Reported whether or not it blocks. */
let wouldGrantRound = 'unknown';
let nextRetryAt = null;
/** OPEN | SPACING | EXHAUSTED. EXHAUSTED is the one an operator hears about. */
let budgetState = 'UNKNOWN';

function cond(name, ok, evidence) {
  conditions.push({ name, ok, evidence });
}

function report() {
  console.log(`WRITER_GRANT_JUDGED_AT = ${NOW}`);
  console.log(`WRITER_GRANT_TASK = ${grantTask ?? 'none'}`);
  for (const c of conditions) {
    console.log(`COND ${c.ok ? 'PASS' : 'BLOCK'} ${c.name} — ${c.evidence}`);
  }
  console.log(`WRITER_GRANT_WOULD_GRANT_ROUND = ${wouldGrantRound}`);
  console.log(`WRITER_GRANT_NEXT_RETRY_AT = ${nextRetryAt ?? 'none'}`);
  console.log(`WRITER_GRANT_BUDGET_STATE = ${budgetState}`);
  if (undecidable !== null) {
    console.log('WRITER_GRANT_VERDICT = UNDECIDABLE');
    console.log(`WRITER_GRANT_REASON = ${undecidable}`);
    return;
  }
  const blocked = conditions.filter((c) => !c.ok);
  if (blocked.length === 0) {
    console.log('WRITER_GRANT_VERDICT = GRANT_AUTHORISED');
    console.log(
      `WRITER_GRANT_REASON = all ${conditions.length} standing-authorisation conditions hold`,
    );
  } else {
    console.log('WRITER_GRANT_VERDICT = GRANT_NOT_AUTHORISED');
    console.log(`WRITER_GRANT_REASON = ${blocked.map((c) => c.name).join('; ')}`);
  }
}

function die(reason) {
  undecidable = reason;
  report();
  process.exit(EXIT_UNDECIDABLE);
}

function refuse() {
  report();
  process.exit(EXIT_NOT_AUTHORISED);
}

if (!REPO) die('usage: --repository <root>');
if (!Number.isFinite(RETRY_HOURS) || RETRY_HOURS <= 0)
  die(`--retry-hours must be a positive number, got ${RETRY_HOURS}`);
if (!Number.isFinite(MAX_PER_DAY) || MAX_PER_DAY <= 0)
  die(`--max-per-day must be a positive number, got ${MAX_PER_DAY}`);
const ROOT = resolve(REPO);
if (!existsSync(ROOT)) die(`no repository at ${ROOT}`);

/** ── AO's own judgement, from the build the run will actually use ────────── */
let attentionForTaskState;
let safeParseTaskState;
let reviewBudget;
let reviewBudgetExhausted;
let MAX_REVIEW_BUDGET;
try {
  const attention = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-attention.js')).href
  );
  const taskState = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-state.js')).href
  );
  const budget = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'core', 'review-budget.js')).href
  );
  attentionForTaskState = attention.attentionForTaskState;
  safeParseTaskState = taskState.safeParseTaskState;
  reviewBudget = budget.reviewBudget;
  reviewBudgetExhausted = budget.reviewBudgetExhausted;
  MAX_REVIEW_BUDGET = budget.MAX_REVIEW_BUDGET;
} catch (error) {
  die(`cannot load AO's judgement out of ${AO_ROOT}\\dist — ${error.message}`);
}
if (
  typeof attentionForTaskState !== 'function' ||
  typeof safeParseTaskState !== 'function' ||
  typeof reviewBudget !== 'function' ||
  typeof reviewBudgetExhausted !== 'function' ||
  typeof MAX_REVIEW_BUDGET !== 'number'
) {
  die(
    "AO's dist does not export attentionForTaskState / safeParseTaskState / reviewBudget / reviewBudgetExhausted / MAX_REVIEW_BUDGET",
  );
}

function ao(args) {
  try {
    return execFileSync(process.execPath, [join(AO_ROOT, 'dist', 'cli', 'index.js'), ...args], {
      encoding: 'utf8',
      cwd: AO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const out = (error.stdout ?? '').toString();
    if (out.trim() === '') die(`AO produced no output for \`${args.join(' ')}\` — ${error.message}`);
    return out;
  }
}

/** ── 1. Planner ranking: which task is live, on AO's own answer ──────────── */
const planText = ao(['run', '--repository', ROOT]);
const rankingLine = /^Ranking\s*:\s*(.+?)\s*$/m.exec(planText);
if (!rankingLine) die("AO's read-only plan printed no Ranking line");
const ranking =
  rankingLine[1] === 'empty'
    ? []
    : rankingLine[1]
        .split('>')
        .map((s) => s.trim())
        .filter(Boolean);

const selectionLine = /^Selection\s*:\s*(\S+)/m.exec(planText);
if (!selectionLine) die("AO's read-only plan printed no Selection line");
if (selectionLine[1] !== 'TASK_SELECTED') {
  cond(
    'planner-selected-a-task',
    false,
    `AO reports Selection: ${selectionLine[1]}; there is no live task to grant for`,
  );
  refuse();
}
if (ranking.length === 0) {
  cond('planner-selected-a-task', false, 'AO ranks no eligible task');
  refuse();
}
const live = ranking[0];
grantTask = live;
cond('planner-selected-a-task', true, `AO ranks ${ranking.join(' > ')}; the live task is ${live}`);

/** ── 2. The durable record, parsed against AO's own contract ─────────────── */
const recordPath = join(ROOT, '.agent-orchestrator', 'runtime', `${live}.json`);
if (!existsSync(recordPath)) {
  cond(
    'task-is-already-started',
    false,
    `no durable runtime record at ${recordPath}; an unstarted task has no writer to have died`,
  );
  refuse();
}
let record;
try {
  const parsed = safeParseTaskState(readJsonFile(recordPath));
  if (parsed.success !== true) die(`runtime record violates AO's task-state contract: ${recordPath}`);
  record = parsed.data;
} catch (error) {
  die(`runtime record unreadable: ${recordPath} — ${error.message}`);
}

/** ── 3. Nobody is owed anything BUT an escalated decision ────────────────── */
/**
 * The single check that rules out a quota block, a scope violation, a
 * divergence, a verification remediation and every auth condition needing
 * judgement, using AO's own attention map rather than a hand-copied list.
 *
 * `HUMAN_DECISION_REQUIRED` is the only state that maps to
 * `ESCALATED_DECISION_REQUIRED`, so this is also the "state is exactly
 * HUMAN_DECISION_REQUIRED" condition. It is asserted again below in its own
 * right, because the operator named it as a condition and a term that is only
 * implied is a term that can drift apart silently.
 */
let judged;
try {
  judged = attentionForTaskState(record, NOW);
} catch (error) {
  die(`AO refused to judge ${live} — ${error.message}`);
}
cond(
  'the-only-attention-owed-is-an-escalated-decision',
  judged.attention === true && judged.reason === 'ESCALATED_DECISION_REQUIRED',
  judged.attention === true
    ? `AO raises ${judged.reason}${judged.detail ? `/${judged.detail}` : ''} on state ${record.state}`
    : `AO raises no attention at all on state ${record.state}, so there is nothing for a grant to answer`,
);

cond(
  'state-is-exactly-human-decision-required',
  record.state === 'HUMAN_DECISION_REQUIRED',
  `AO durable state is ${record.state}`,
);

/** ── 4. The exact recovery shape: a writing agent, during the implement pass */
cond(
  'blocked-agent-is-claude',
  record.blockedAgent === 'claude',
  record.blockedAgent === null
    ? 'blockedAgent is null, so no agent was running: this park is a brief, context, capability or indeterminate-scope condition, and a person owns it'
    : `blockedAgent is ${record.blockedAgent}`,
);

cond(
  'resume-phase-is-exactly-implement',
  record.resumeFrom !== null &&
    record.resumeFrom !== undefined &&
    record.resumeFrom.phase === 'IMPLEMENT',
  record.resumeFrom
    ? `record resumes from phase=${record.resumeFrom.phase} round=${record.resumeFrom.round}`
    : 'record names no resume point, so AO would refuse the continuation and it would be spent for nothing',
);

/** ── 5. The review budget, and the round the grant must not buy ──────────── */
const budgetTotal = reviewBudget(record);
const exhausted = reviewBudgetExhausted(record);
cond(
  'review-budget-is-not-exhausted',
  exhausted === false,
  `reviewRound ${record.reviewRound} against a budget of ${budgetTotal} ` +
    `(${record.maxReviewRounds} declared + ${record.grantedReviewRounds} granted); ` +
    `AO says reviewBudgetExhausted=${exhausted}`,
);

/**
 * `run-driver.ts:1569`, with `continuingHumanDecision` held true because the
 * supervisor's invocation is exactly what makes it true. If this is `true` the
 * continuation would write `grantedReviewRounds + 1`, which is a decision about
 * how much review the work is worth and is not the operator's standing grant.
 */
const wouldGrant = exhausted && budgetTotal < MAX_REVIEW_BUDGET;
wouldGrantRound = wouldGrant ? 'true' : 'false';
cond(
  'granting-would-not-increase-granted-review-rounds',
  wouldGrant === false,
  `grantReviewRound = continuingHumanDecision(true) && reviewBudgetExhausted(${exhausted}) && ` +
    `reviewBudget(${budgetTotal}) < MAX_REVIEW_BUDGET(${MAX_REVIEW_BUDGET}) = ${wouldGrantRound}` +
    (wouldGrant
      ? ' — this continuation would buy a review round, which the standing authorisation does not cover'
      : ''),
);

/** ── 6. No finding and no operator decision is waiting ───────────────────── */
/**
 * Structurally implied by condition 4 — every finding-bearing park names
 * REMEDIATE or REVIEW, never IMPLEMENT — and asserted anyway as a fail-closed
 * floor. A record that somehow carried both would be one this authorisation was
 * never written for, and the honest answer to it is a person.
 */
const findings = Array.isArray(record.findingHistory) ? record.findingHistory : [];
cond(
  'no-review-finding-is-waiting',
  findings.length === 0,
  findings.length === 0
    ? 'findingHistory is empty: no reviewer has recorded anything for a person or a writer to answer'
    : `findingHistory holds ${findings.length} record(s); answering a finding is review work, not a dead writer`,
);

/**
 * A task an operator has already ended carries their decision. Continuing it
 * would re-open a closed thing, which is a product decision by any reading.
 */
cond(
  'no-operator-decision-is-already-recorded',
  record.operatorResolution === null || record.operatorResolution === undefined,
  record.operatorResolution
    ? `operatorResolution records a close from ${record.operatorResolution.closedFrom}`
    : 'operatorResolution is null: nobody has ended this task',
);

/** ── 7. The task file has not already been closed ────────────────────────── */
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
cond('task-file-is-not-done', statusMatch[1] !== 'DONE', `${live}.md says status: ${statusMatch[1]}`);

/** ── 8. The worktree exists and Git registers it where the record says ───── */
function normalisePath(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
let registered = [];
let registeredBranchOf = new Map();
try {
  const listed = execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Records are blank-line separated: `worktree <path>` then HEAD, then branch.
  for (const block of listed.split(/\r?\n\r?\n/)) {
    const path = /^worktree\s+(.+?)\s*$/m.exec(block);
    if (!path) continue;
    const branch = /^branch\s+refs\/heads\/(.+?)\s*$/m.exec(block);
    registered.push(normalisePath(path[1]));
    registeredBranchOf.set(normalisePath(path[1]), branch ? branch[1] : null);
  }
} catch (error) {
  die(`git worktree list failed in ${ROOT} — ${error.message}`);
}
const wantWorktree = normalisePath(record.worktreePath);
const isRegistered = registered.includes(wantWorktree) && existsSync(record.worktreePath);
const onBranch = registeredBranchOf.get(wantWorktree) ?? null;
cond(
  'the-worktree-exists-and-is-consistent',
  isRegistered && onBranch === record.workBranch,
  !isRegistered
    ? `Git registers no live worktree at ${record.worktreePath}; there is nothing for a resume to re-enter`
    : onBranch === record.workBranch
      ? `${record.worktreePath} is registered and checked out on ${record.workBranch}`
      : `${record.worktreePath} is on ${onBranch ?? '(detached)'}, not the record's ${record.workBranch}`,
);

/** ── 9. No lease conflict ────────────────────────────────────────────────── */
const leaseText = ao(['lease', 'status', '--repository', ROOT]);
const leaseLine = /^Lease\s*:\s*(\S+)/m.exec(leaseText);
if (!leaseLine) die("AO's lease report printed no Lease line");
cond(
  'no-lease-conflict',
  leaseLine[1] === 'FREE',
  `AO reports Lease: ${leaseLine[1]}` +
    (leaseLine[1] === 'FREE' ? '' : '; another invocation owns this repository'),
);

/** ── 10. The bounded restart budget permits one more ─────────────────────── */
/**
 * Read only. The supervisor spends it, and only after this file says yes.
 *
 * Keyed `<taskId>#writer-restart`, so `zera-quota-grant.mjs` — which looks up
 * `tasks[<taskId>]` with the plain id — cannot see these entries and a dead
 * writer cannot spend the allowance a provider outage needs.
 */
const LEDGER_KEY = `${live}#writer-restart`;

function readRestarts() {
  if (!existsSync(BUDGET_FILE)) return [];
  let parsed;
  try {
    parsed = readJsonFile(BUDGET_FILE);
  } catch (error) {
    die(`retry ledger unreadable at ${BUDGET_FILE} — ${error.message}; refusing to guess how much budget is left`);
  }
  if (parsed && typeof parsed === 'object' && parsed.tasks && typeof parsed.tasks === 'object') {
    const entry = parsed.tasks[LEDGER_KEY];
    // No entry means no restart has been spent for this task. An entry whose
    // `attempts` is not an array is a DIFFERENT statement: something wrote a
    // shape this reader does not understand, and reading it as an empty list
    // would hand back a full budget — the one direction a fail-closed reader may
    // never take. Measured as a review finding, not supposed.
    if (entry === undefined || entry === null) return [];
    if (!Array.isArray(entry.attempts)) {
      die(`retry ledger entry ${LEDGER_KEY} at ${BUDGET_FILE} has no attempts array; refusing to guess how much budget is left`);
    }
    return entry.attempts;
  }
  // A shape this reader does not recognise is REFUSED, not half-understood: two
  // readers disagreeing about how much budget is left is worse than stopping.
  die(`retry ledger at ${BUDGET_FILE} is in no shape this reader recognises (expected a top-level object carrying a \`tasks\` map)`);
  return [];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const parsedRestarts = [];
for (const a of readRestarts()) {
  const t = Date.parse(a);
  if (Number.isNaN(t)) die(`retry ledger holds an unparseable instant: ${JSON.stringify(a)}`);
  parsedRestarts.push(t);
}
// Compared as instants, never as strings: the ledger records an offset-bearing
// ISO instant, and two equal instants can sort wrongly as text.
parsedRestarts.sort((a, b) => a - b);
const recentRestarts = parsedRestarts.filter((t) => t > NOW_MS - DAY_MS);

budgetState = 'OPEN';
let budgetOk = true;
let budgetWhy = `${recentRestarts.length} of ${MAX_PER_DAY} automatic restart(s) spent in the last 24 h for ${live}`;
if (recentRestarts.length >= MAX_PER_DAY) {
  budgetOk = false;
  budgetState = 'EXHAUSTED';
  nextRetryAt = new Date(recentRestarts[0] + DAY_MS).toISOString();
  budgetWhy = `${recentRestarts.length} of ${MAX_PER_DAY} automatic restarts already spent for ${live} in the last 24 h; the oldest ages out at ${nextRetryAt}. A writer that will not stay alive is a person's problem, not a retry's`;
} else if (recentRestarts.length > 0) {
  const due = recentRestarts[recentRestarts.length - 1] + RETRY_HOURS * 60 * 60 * 1000;
  if (NOW_MS < due) {
    budgetOk = false;
    budgetState = 'SPACING';
    nextRetryAt = new Date(due).toISOString();
    budgetWhy = `last restart for ${live} was ${new Date(recentRestarts[recentRestarts.length - 1]).toISOString()}; the ${RETRY_HOURS} h spacing makes the next one due at ${nextRetryAt}`;
  }
}
cond('restart-budget-permits-an-attempt', budgetOk, budgetWhy);

report();
process.exit(conditions.every((c) => c.ok) ? EXIT_AUTHORISED : EXIT_NOT_AUTHORISED);
