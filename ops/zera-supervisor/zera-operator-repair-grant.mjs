/**
 * Zera operator-repair grant prover — read-only. Decides whether the operator's
 * STANDING authorisation covers issuing `--verify-operator-repair` for the live
 * task right now.
 *
 * It changes no task state, takes no lease, creates or modifies no worktree,
 * contacts no remote, touches no AO source, and — the point of this whole file —
 * **commits nothing**. The repair it grants permission for is already sitting in
 * the worktree, put there by the operator. AO commits it, under AO's own commit
 * controls, inside the invocation the supervisor then makes. Nothing here stages,
 * commits, reverts or writes a byte of that repair.
 *
 * Deliberately NOT "writes nothing", which is stronger than AO claims for its
 * own read-only commands: it shells `run --repository` and calls
 * `assessOperatorRepair`, both of which run Git, and AO's own trailer narrows to
 * "Observing a worktree may let Git refresh its own index"
 * (src/run/render-run-plan.ts:45-47). Restating a claim AO withdrew would be
 * this file's own overclaim.
 *
 * ── What this is, and what it is not ────────────────────────────────────────
 *
 * `--verify-operator-repair` is an OPERATOR grant. It stays one. What the
 * operator issued on 2026-09-13 is a narrow standing authorisation so that a
 * repair they have ALREADY made, to a tree AO has ALREADY measured as failed,
 * does not need a person at a keyboard to be adopted.
 *
 * It must never be described as AO granting itself an adoption, and never as the
 * supervisor repairing anything. AO refuses an automatic departure here exactly
 * as before; the supervisor supplies the operator grant, on the operator's
 * recorded instruction, and only when every condition below holds.
 *
 * ── Why the predicate is short ──────────────────────────────────────────────
 *
 * Eight of the ten conditions the authorisation names are AO's own, and AO
 * ships them as one exported function. `assessOperatorRepair`
 * (src/verify/operator-repair.ts) is the gate `run-driver.ts` itself consults
 * before adopting, it is an observer that writes nothing by construction, and
 * its refusal vocabulary is closed — one member per proven condition:
 *
 *   state exactly BLOCKED_VERIFY        -> STATE_NOT_BLOCKED_VERIFY
 *   resumeFrom.phase == REMEDIATE       -> RESUME_POINT_NOT_REMEDIATE
 *   a verification attempt exists       -> NO_VERIFICATION_ATTEMPT
 *   the LATEST attempt is FAILED        -> LATEST_ATTEMPT_NOT_FAILED
 *   HEAD == attempt.subjectCommit       -> HEAD_MOVED / HEAD_UNREADABLE
 *   the worktree carries a repair       -> NOTHING_TO_ADOPT / WORKTREE_UNREADABLE
 *   the repair is WITHIN_SCOPE          -> REPAIR_OUT_OF_SCOPE
 *   the scope is not indeterminate      -> SCOPE_INDETERMINATE
 *
 * That is eight conditions against ten refusal codes, because two of the codes
 * are the "Git would not answer" halves of their neighbours. Counted from
 * `OPERATOR_REPAIR_REFUSALS`, which has ten members, not from memory.
 *
 * So this file calls it rather than re-deciding it. A hand-copied list would be
 * free to disagree with the gate it is predicting, and it would go stale the
 * first time AO adds a refusal — which is the failure mode a second copy of a
 * gate always has.
 *
 * Two conditions are NOT AO's, because `assessOperatorRepair`'s own header says
 * so: "Identity, the execution lease, the authorised worktree and reconciliation
 * are not re-checked here. They are proven by `run-driver.ts` before any of this
 * is reached." Those are proven here instead, from outside:
 *
 *   no lease / writer conflict          -> `lease status` says FREE
 *   still planner-selected, not DONE    -> AO's own ranking, and the task file
 *
 * ── What it cannot see ──────────────────────────────────────────────────────
 *
 * The same residual the quota prover carries, and for the same reason. A
 * repository whose profile stopped parsing, a lease taken between this proof and
 * the invocation, an auth preflight that failed, a reconciliation that answers
 * DIVERGED — none of those is a task state, and none is visible here. AO checks
 * them INSIDE the invocation, after the lease is taken, and refuses there.
 *
 * That residual is cheaper here than it is for the quota grant, because a
 * refused adoption spends nothing: there is no retry ledger and no allowance to
 * burn. The task stays exactly where it was. The supervisor still re-reads the
 * state afterwards and stops loudly if the adoption did not land.
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
 *   node zera-operator-repair-grant.mjs --repository <root>
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

/**
 * Read JSON written by anyone, including PowerShell.
 *
 * `Set-Content -Encoding utf8` on Windows PowerShell 5.1 writes a UTF-8 BOM and
 * `JSON.parse` rejects a leading U+FEFF outright. Strip it at every JSON
 * boundary rather than relying on who wrote it.
 */
function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
}

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const REPO = argOf('--repository');

const conditions = [];
let undecidable = null;
let grantTask = null;
/** The closed refusal code AO's own gate returned, when it is the thing blocking. */
let aoRefusal = null;

function cond(name, ok, evidence) {
  conditions.push({ name, ok, evidence });
}

function report() {
  console.log(`REPAIR_GRANT_JUDGED_AT = ${NOW}`);
  console.log(`REPAIR_GRANT_TASK = ${grantTask ?? 'none'}`);
  for (const c of conditions) {
    console.log(`COND ${c.ok ? 'PASS' : 'BLOCK'} ${c.name} — ${c.evidence}`);
  }
  console.log(`REPAIR_GRANT_AO_REFUSAL = ${aoRefusal ?? 'none'}`);
  if (undecidable !== null) {
    console.log('REPAIR_GRANT_VERDICT = UNDECIDABLE');
    console.log(`REPAIR_GRANT_REASON = ${undecidable}`);
    return;
  }
  const blocked = conditions.filter((c) => !c.ok);
  if (blocked.length === 0) {
    console.log('REPAIR_GRANT_VERDICT = GRANT_AUTHORISED');
    console.log(
      `REPAIR_GRANT_REASON = all ${conditions.length} standing-authorisation conditions hold`,
    );
  } else {
    console.log('REPAIR_GRANT_VERDICT = GRANT_NOT_AUTHORISED');
    console.log(`REPAIR_GRANT_REASON = ${blocked.map((c) => c.name).join('; ')}`);
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
const ROOT = resolve(REPO);
if (!existsSync(ROOT)) die(`no repository at ${ROOT}`);

/** ── AO's own judgement, from the build the run will actually use ────────── */
let assessOperatorRepair;
let runGitCommand;
let safeParseTaskState;
let attentionForTaskState;
try {
  const repair = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'verify', 'operator-repair.js')).href
  );
  const git = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'worktree', 'git-command.js')).href
  );
  const taskState = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-state.js')).href
  );
  const attention = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-attention.js')).href
  );
  assessOperatorRepair = repair.assessOperatorRepair;
  runGitCommand = git.runGitCommand;
  safeParseTaskState = taskState.safeParseTaskState;
  attentionForTaskState = attention.attentionForTaskState;
} catch (error) {
  die(`cannot load AO's judgement out of ${AO_ROOT}\\dist — ${error.message}`);
}
if (
  typeof assessOperatorRepair !== 'function' ||
  typeof runGitCommand !== 'function' ||
  typeof safeParseTaskState !== 'function' ||
  typeof attentionForTaskState !== 'function'
) {
  die(
    "AO's dist does not export assessOperatorRepair / runGitCommand / safeParseTaskState / attentionForTaskState",
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
  // Never started. An unstarted task has no failed verification to repair, and
  // handing it an adoption grant would be an override nobody asked for.
  cond(
    'task-is-already-started',
    false,
    `no durable runtime record at ${recordPath}; an unstarted task has no failed verification to adopt a repair for`,
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

/** ── 3. The task file has not already been closed ────────────────────────── */
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

/** ── 4. Nobody is owed anything BUT a verification remediation ───────────── */
/**
 * The single check that rules out a simultaneous human decision, a quota block,
 * a scope violation, a divergence and every auth condition needing judgement. It
 * works because AO's attention map (`STATE_ATTENTION`, total over `ALL_STATES`
 * by `satisfies`) is a function of the state, and a task has exactly one state.
 *
 * `BLOCKED_VERIFY` is the only state that maps to `VERIFICATION_REMEDIATION_REQUIRED`,
 * so this is also the "state is exactly BLOCKED_VERIFY" condition — read from
 * AO's own map rather than from a hand-copied state name. `assessOperatorRepair`
 * asserts the same thing again below, from the other side, and if the two ever
 * disagree that is a divergence worth stopping for.
 */
let judged;
try {
  judged = attentionForTaskState(record, NOW);
} catch (error) {
  die(`AO refused to judge ${live} — ${error.message}`);
}
cond(
  'the-only-attention-owed-is-verification-remediation',
  judged.attention === true && judged.reason === 'VERIFICATION_REMEDIATION_REQUIRED',
  judged.attention === true
    ? `AO raises ${judged.reason}${judged.detail ? `/${judged.detail}` : ''} on state ${record.state}`
    : `AO raises no attention at all on state ${record.state}, so there is nothing for a grant to answer`,
);

/** ── 5. No lease conflict ────────────────────────────────────────────────── */
/**
 * Not re-checked by `assessOperatorRepair` — its header says the lease is
 * `run-driver.ts`'s to prove — so it is proven here, from outside, exactly as
 * the quota prover does it.
 */
const leaseText = ao(['lease', 'status', '--repository', ROOT]);
const leaseLine = /^Lease\s*:\s*(\S+)/m.exec(leaseText);
if (!leaseLine) die("AO's lease report printed no Lease line");
cond(
  'no-lease-or-writer-conflict',
  leaseLine[1] === 'FREE',
  `AO reports Lease: ${leaseLine[1]}` +
    (leaseLine[1] === 'FREE' ? '' : '; another invocation owns this repository'),
);

/** ── 6. The worktree AO would open is the one Git has registered ─────────── */
/**
 * `assessOperatorRepair` takes `authorisedWorktreePath` as "the path Git printed
 * for this task's registration, proven by the driver". This prover is not the
 * driver, so it proves the same thing the same way rather than passing the
 * record's claim through unchecked: an unregistered path would make every Git
 * observation below run somewhere AO would never open.
 *
 * Compared with separators normalised and case folded, because Git prints
 * `D:/a/b` where the record holds `D:\a\b`, and NTFS is case-insensitive. A
 * literal string comparison here would refuse every healthy worktree on this
 * machine.
 */
function normalisePath(p) {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
let registered = [];
try {
  const listed = execFileSync('git', ['-C', ROOT, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  registered = [...listed.matchAll(/^worktree\s+(.+?)\s*$/gm)].map((m) => normalisePath(m[1]));
} catch (error) {
  die(`git worktree list failed in ${ROOT} — ${error.message}`);
}
const wantWorktree = normalisePath(record.worktreePath);
const worktreeRegistered = registered.includes(wantWorktree);
cond(
  'the-worktree-is-registered-where-the-record-says',
  worktreeRegistered && existsSync(record.worktreePath),
  worktreeRegistered
    ? `Git registers ${record.worktreePath} for branch ${record.workBranch}`
    : `Git registers no worktree at ${record.worktreePath}; AO would not open it and nothing observed there would be about this task`,
);
if (!worktreeRegistered || !existsSync(record.worktreePath)) {
  // Stop before the Git observations below: they would measure a directory that
  // is not this task's, and an answer from the wrong tree is worse than none.
  refuse();
}

/** ── 7. AO's own adoption gate, asked rather than re-implemented ─────────── */
/**
 * The eight conditions listed in this file's header, decided by the gate
 * `run-driver.ts` itself consults. It observes and writes nothing; the effect
 * lives in `commitOperatorRepair`, which is NOT called here and is not reachable
 * from here.
 *
 * Production seams are used throughout — `runGitCommand`, and the module's own
 * default attempt store, cleanliness observer and scope gate — so this asks
 * exactly the question the invocation will ask, and not an easier one.
 */
let assessment;
try {
  assessment = await assessOperatorRepair({
    state: record,
    git: runGitCommand,
    authorisedWorktreePath: record.worktreePath,
  });
} catch (error) {
  die(`AO's adoption gate could not be evaluated for ${live} — ${error.message}`);
}

if (assessment.allowed === true) {
  cond(
    'ao-adoption-gate-permits-this-repair',
    true,
    `assessOperatorRepair allows the adoption: the latest attempt ${assessment.attempt.verdict} on ` +
      `subject ${assessment.attempt.subjectCommit} is still HEAD, the worktree carries a repair, and the ` +
      `whole delta from base pin ${assessment.basePinnedCommit} is WITHIN_SCOPE across ` +
      `${assessment.approvedPaths.length} approved path(s)`,
  );
} else {
  aoRefusal = assessment.refusal;
  cond(
    'ao-adoption-gate-permits-this-repair',
    false,
    `assessOperatorRepair refuses with ${assessment.refusal}; the standing authorisation requires every one of ` +
      'its conditions, and this file never widens what that gate decided',
  );
}

report();
process.exit(conditions.every((c) => c.ok) ? EXIT_AUTHORISED : EXIT_NOT_AUTHORISED);
