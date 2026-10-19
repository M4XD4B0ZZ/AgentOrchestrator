/**
 * Zera delivery gate — read-only prover for the operator's standing merge
 * authorisation. Lives OUTSIDE AgentOrchestrator and changes nothing: no task
 * state, no lease, no worktree, no remote, no AO source. It contacts github.com
 * only through `gh` read commands.
 *
 * ── Why this exists here and not inside AO ─────────────────────────────────
 *
 * AO answers `delivery` for a repository that declares a delivery target.
 * HealthApp does not: `agent-loop delivery --repository <root> --task <id>`
 * reports `DELIVERY_NOT_DECLARED — This repository declares no delivery target`.
 * So publishing, opening a pull request and merging are not AO rules for this
 * repository at all, and proving them out here duplicates no AO authority.
 *
 * Everything AO *does* own is still read from AO: the durable task record
 * through `safeParseTaskState`, whether a human is owed through
 * `attentionForTaskState`. This file adds no state rule of its own.
 *
 * ── What it proves, and what it can only approximate ───────────────────────
 *
 * Conditions come in two kinds, and the run prints its own tally — no count is
 * written here, because a number in a comment goes stale the first time a
 * condition is added and then lies with authority. A PROVEN one is read
 * from data — a byte, a commit id, a check bucket. A PROXY cannot be proven by a
 * machine at all, so the output names the mechanical thing that stood in for it.
 * A reader must be able to tell those apart without reading this file, so every
 * line says which it is. A PROXY that fails blocks the merge exactly like a
 * PROVEN that fails; the label is about what a pass MEANS, not about how much it
 * is trusted.
 *
 * The three PROXIES, and what each really checks:
 *   pr-stays-inside-the-projected-scope   stands in for "no new product decision
 *     was invented". It proves REACH, not intent.
 *   roadmap-marks-this-task-done          stands in for "ROADMAP accurately
 *     describes what was delivered". It proves one status line, not prose.
 *   handoff-is-this-tasks-and-complete    the same, for the handoff.
 *
 * ── Fail closed ────────────────────────────────────────────────────────────
 *
 * Anything unreadable is UNDECIDABLE and blocks. Zero checks is never success:
 * it is its own blocking condition, distinct from failure, so "CI is broken"
 * can never be delivered as "CI is fine".
 *
 * Exit codes:
 *   0  MERGE_AUTHORISED — every condition proven
 *   10 MERGE_NOT_AUTHORISED — at least one condition not proven; not an error
 *   11 NO_PULL_REQUEST — none exists yet; a stage, not a failure
 *   2  UNDECIDABLE — could not read something it must read; stop and tell somebody
 *
 * On success it prints `GATE_PROVEN_HEAD = <oid>`. A caller that merges MUST pin
 * the merge to that oid (`gh pr merge --match-head-commit`), because every
 * condition here was evaluated against it and the branch can move afterwards.
 *
 * Usage:
 *   node zera-delivery-gate.mjs --repository <root> --task <id>
 *                               [--pr <n>] [--canonical-branch <name>]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const AO_ROOT = process.env.AO_ROOT ?? 'D:\\AgentOrchestrator';

const EXIT_AUTHORISED = 0;
const EXIT_NOT_AUTHORISED = 10;
const EXIT_NO_PULL_REQUEST = 11;
const EXIT_UNDECIDABLE = 2;

/** One instant for the whole gate, so two reads cannot disagree about now. */
const NOW = new Date().toISOString();

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

function argOf(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

const REPO = argOf('--repository');
const TASK = argOf('--task');
const PR_ARG = argOf('--pr');
const CANONICAL = argOf('--canonical-branch');

const conditions = [];
let undecidable = null;
/**
 * The one head every condition below is judged against. Printed on success so a
 * caller can pin its merge to it. Without that pin the branch can move during
 * the CI wait and `gh pr merge` will happily merge a head this gate never saw —
 * unverified, unscoped, possibly unchecked.
 */
let provenHead = null;

function record(kind, name, ok, evidence) {
  conditions.push({ kind, name, ok, evidence });
}
function proven(name, ok, evidence) {
  record('PROVEN', name, ok, evidence);
}
function proxy(name, ok, evidence) {
  record('PROXY', name, ok, evidence);
}

function die(reason) {
  undecidable = reason;
  report();
  process.exit(EXIT_UNDECIDABLE);
}

function report() {
  console.log(`GATE_TASK = ${TASK ?? 'unknown'}`);
  console.log(`GATE_REPOSITORY = ${REPO ?? 'unknown'}`);
  console.log(`GATE_JUDGED_AT = ${NOW}`);
  for (const c of conditions) {
    console.log(`COND ${c.ok ? 'PASS' : 'BLOCK'} [${c.kind}] ${c.name} — ${c.evidence}`);
  }
  if (undecidable !== null) {
    console.log(`GATE_VERDICT = UNDECIDABLE`);
    console.log(`GATE_REASON = ${undecidable}`);
    return;
  }
  const provenCount = conditions.filter((c) => c.kind === 'PROVEN').length;
  const proxyCount = conditions.filter((c) => c.kind === 'PROXY').length;
  console.log(`GATE_CONDITIONS = ${conditions.length} (${provenCount} PROVEN, ${proxyCount} PROXY)`);
  const blocked = conditions.filter((c) => !c.ok);
  if (blocked.length === 0) {
    console.log('GATE_VERDICT = MERGE_AUTHORISED');
    console.log(`GATE_REASON = all ${conditions.length} conditions proven`);
    console.log(`GATE_PROVEN_HEAD = ${provenHead ?? 'unknown'}`);
  } else {
    console.log('GATE_VERDICT = MERGE_NOT_AUTHORISED');
    console.log(`GATE_REASON = ${blocked.map((c) => c.name).join('; ')}`);
  }
}

if (!REPO || !TASK) die('usage: --repository <root> --task <id> [--pr <n>]');
const ROOT = resolve(REPO);
if (!existsSync(ROOT)) die(`no repository at ${ROOT}`);

/** ── AO's own judgement, from the build the run actually uses ────────────── */
let attentionForTaskState;
let safeParseTaskState;
try {
  const attention = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-attention.js')).href
  );
  const taskState = await import(pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-state.js')).href);
  attentionForTaskState = attention.attentionForTaskState;
  safeParseTaskState = taskState.safeParseTaskState;
} catch (error) {
  die(`cannot load AO's judgement out of ${AO_ROOT}\\dist — ${error.message}`);
}
if (typeof attentionForTaskState !== 'function' || typeof safeParseTaskState !== 'function') {
  die("AO's dist does not export attentionForTaskState / safeParseTaskState");
}

function git(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gh(args) {
  return execFileSync('gh', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** ── 0. The durable task record — AO's answer, not this file's ───────────── */
const recordPath = join(ROOT, '.agent-orchestrator', 'runtime', `${TASK}.json`);
if (!existsSync(recordPath)) die(`no durable runtime record for ${TASK} at ${recordPath}`);
let taskRecord;
try {
  const parsed = safeParseTaskState(readJsonFile(recordPath));
  if (parsed.success !== true) die(`runtime record violates AO's task-state contract: ${recordPath}`);
  taskRecord = parsed.data;
} catch (error) {
  die(`runtime record unreadable: ${recordPath} — ${error.message}`);
}

/** ── 1. AO says the task is finished, and says so terminally ─────────────── */
proven(
  'ao-state-is-ready-for-pr',
  taskRecord.state === 'READY_FOR_PR',
  `AO durable state is ${taskRecord.state}; READY_FOR_PR is the only state that means the lifecycle finished clean`,
);

/** ── 2. Nobody is owed a decision ────────────────────────────────────────── */
let judged;
try {
  judged = attentionForTaskState(taskRecord, NOW);
} catch (error) {
  die(`AO refused to judge ${TASK} — ${error.message}`);
}
proven(
  'no-unresolved-human-decision',
  judged.attention !== true && taskRecord.state !== 'HUMAN_DECISION_REQUIRED',
  judged.attention === true
    ? `AO raises attention: ${judged.reason}${judged.detail ? `/${judged.detail}` : ''}`
    : 'AO raises no attention item for this record',
);

/** ── 3. The review loop left nothing owed ────────────────────────────────── */
/**
 * `findingHistory` is a history and not an open set, so a past `high` is not a
 * blocker on its own. What makes it decidable is that AO only reaches
 * READY_FOR_PR by leaving REVIEWING/REMEDIATING with nothing to remediate.
 * Condition 1 carries that. What is added here is narrower and independently
 * checkable: the loop must not have ended by spending an operator grant.
 */
proven(
  'no-review-round-bought-by-operator',
  (taskRecord.grantedReviewRounds ?? 0) === 0 && taskRecord.operatorResolution === null,
  `grantedReviewRounds=${taskRecord.grantedReviewRounds ?? 0}, operatorResolution=${
    taskRecord.operatorResolution === null ? 'none' : JSON.stringify(taskRecord.operatorResolution)
  }; findingHistory carries ${(taskRecord.findingHistory ?? []).length} historical finding(s)`,
);

/** ── 4. The verified head, from AO's own verification-pass store ─────────── */
const passPath = join(ROOT, '.agent-orchestrator', 'runtime', 'verification-passes', `${TASK}.json`);
let verifiedCommit = null;
if (existsSync(passPath)) {
  try {
    const pass = readJsonFile(passPath);
    verifiedCommit = typeof pass.subjectCommit === 'string' ? pass.subjectCommit : null;
  } catch (error) {
    die(`verification-pass store unreadable: ${passPath} — ${error.message}`);
  }
}
proven(
  'verification-pass-recorded',
  verifiedCommit !== null,
  verifiedCommit === null
    ? `no verification pass recorded at ${passPath}; an absent record is not a pass`
    : `AO recorded a pass on subjectCommit ${verifiedCommit}`,
);

/** ── 5. The pull request itself ──────────────────────────────────────────── */
const branch = taskRecord.workBranch;
if (typeof branch !== 'string' || branch === '') die(`${TASK}'s record names no work branch`);

let pr;
try {
  const selector = PR_ARG !== null ? PR_ARG : branch;
  const raw = gh([
    'pr',
    'view',
    selector,
    '--json',
    'number,state,isDraft,mergeable,mergeStateStatus,headRefName,headRefOid,baseRefName,files,changedFiles',
  ]);
  pr = JSON.parse(raw);
} catch (error) {
  const why = (error.stderr ?? error.message).toString().trim();
  // "No pull request exists yet" is a stage, not a failure to read. It is the
  // ordinary state of a task AO has just finished, and the supervisor answers
  // it by opening one — so it must not be reported as undecidable.
  if (/no pull requests? found/i.test(why)) {
    console.log(`GATE_TASK = ${TASK}`);
    console.log(`GATE_REPOSITORY = ${REPO}`);
    console.log(`GATE_JUDGED_AT = ${NOW}`);
    for (const c of conditions) {
      console.log(`COND ${c.ok ? 'PASS' : 'BLOCK'} [${c.kind}] ${c.name} — ${c.evidence}`);
    }
    console.log('GATE_VERDICT = NO_PULL_REQUEST');
    console.log(`GATE_REASON = no pull request exists for ${branch}`);
    process.exit(EXIT_NO_PULL_REQUEST);
  }
  die(`could not read a pull request for ${branch} — ${why}`);
}

proven('pr-is-open', pr.state === 'OPEN', `PR #${pr.number} state=${pr.state}`);
proven('pr-is-not-draft', pr.isDraft === false, `PR #${pr.number} isDraft=${pr.isDraft}`);
proven(
  'pr-merges-cleanly',
  pr.mergeable === 'MERGEABLE' && pr.mergeStateStatus === 'CLEAN',
  `mergeable=${pr.mergeable}, mergeStateStatus=${pr.mergeStateStatus}`,
);
/**
 * `?? pr.baseRefName` used to sit in this comparison, which made it compare a
 * value with itself whenever the record's baseBranch was nullish — a condition
 * that can only pass. It is gone. The canonical branch is now an INPUT: without
 * it the gate has only the record's own word for what the base should be, which
 * is not an independent check at all.
 */
if (CANONICAL === null) die('--canonical-branch is required: without it this gate cannot check the base independently');
proven(
  'pr-targets-the-canonical-branch',
  pr.baseRefName === CANONICAL &&
    pr.baseRefName === taskRecord.baseBranch &&
    pr.headRefName === branch,
  `head=${pr.headRefName} base=${pr.baseRefName}; operator says canonical=${CANONICAL}; record says workBranch=${branch} baseBranch=${taskRecord.baseBranch}`,
);

/** ── 6. No head drift: the PR head IS the verified head ──────────────────── */
/**
 * The verified head is what AO measured `npm run verify` green on. The PR head
 * may legitimately sit ONE commit above it: the delivery flip that marks the
 * task file DONE, which the writing agent could not author because the profile's
 * scope grant excludes `.agent-orchestrator/tasks`.
 *
 * That is a head drift, and calling it anything else would be the lie this gate
 * exists to prevent. So it is admitted narrowly and by measurement: exactly one
 * commit, whose diff touches exactly that one file. Anything else — two commits,
 * a wider diff, a rewritten history — blocks. CI runs on the real head anyway,
 * so the merged commit is verified in its own right rather than by inheritance.
 */
const head = pr.headRefOid;
provenHead = head;
const taskFileRel = `.agent-orchestrator/tasks/${TASK}.md`;

/**
 * NEVER `--depth`. Measured on 2026-09-12 in a scratch clone: `git fetch origin
 * <oid> --depth 1` into a FULL clone does not fetch one object cheaply — it
 * converts the repository to a shallow one. Four commits became one and
 * `.git/shallow` appeared; `rev-list HEAD~3..HEAD` then failed outright. Run
 * against the live source checkout that would have silently truncated Zera's
 * history, broken `merge --ff-only`, and blocked this gate forever on a
 * rev-list it could no longer answer. A plain fetch of the same oid left the
 * clone at four commits.
 *
 * A fetch still writes objects and FETCH_HEAD, so this file is read-only about
 * task state, leases, worktrees and the remote — not about the object store.
 */
function ensureLocalObject(oid) {
  try {
    git(['cat-file', '-e', `${oid}^{commit}`]);
    return true;
  } catch {
    try {
      git(['fetch', 'origin', oid]);
      git(['cat-file', '-e', `${oid}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }
}

let headDriftEvidence;
let headDriftOk = false;
if (verifiedCommit === null) {
  headDriftEvidence = 'no verified head recorded, so no head can be compared with it';
} else if (head === verifiedCommit) {
  headDriftOk = true;
  headDriftEvidence = `PR head ${head} IS the verified head; no drift at all`;
} else if (!ensureLocalObject(head) || !ensureLocalObject(verifiedCommit)) {
  headDriftEvidence = `cannot read ${head} or ${verifiedCommit} locally to compare them`;
} else {
  // `between` and `touched` start as null, not []. An empty array here would
  // fall through into the chain below and be reported as an affirmative
  // measurement — "0 commit(s) sit above the verified head" — about a
  // measurement that never happened.
  let between = null;
  try {
    between = git(['rev-list', `${verifiedCommit}..${head}`]).split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (error) {
    between = null;
    headDriftEvidence = `cannot list commits between the verified head and the PR head — ${error.message}`;
  }
  const behind = (() => {
    try {
      return git(['rev-list', `${head}..${verifiedCommit}`]).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return ['unknown'];
    }
  })();
  if (between === null) {
    // evidence already set by the catch above; say nothing further
  } else if (behind.length > 0) {
    headDriftEvidence = `PR head ${head} does not contain the verified head ${verifiedCommit}; ${behind.length} verified commit(s) are missing from it`;
  } else if (between.length !== 1) {
    headDriftEvidence = `${between.length} commit(s) sit above the verified head ${verifiedCommit}; only a single delivery flip is admitted`;
  } else {
    let touched = null;
    try {
      touched = git(['diff', '--name-only', `${between[0]}^`, between[0]])
        .split('\n')
        .map((s) => s.trim().replace(/\\/g, '/'))
        .filter(Boolean);
    } catch (error) {
      touched = null;
      headDriftEvidence = `cannot read the diff of ${between[0]} — ${error.message}`;
    }
    if (touched === null) {
      // evidence already set by the catch above
    } else if (touched.length === 1 && touched[0] === taskFileRel) {
      headDriftOk = true;
      headDriftEvidence = `PR head ${head} is the verified head ${verifiedCommit} plus exactly one delivery flip (${between[0].slice(0, 8)}) touching only ${taskFileRel}`;
    } else {
      headDriftEvidence = `the one commit above the verified head touches ${touched.length} file(s): ${touched.join(', ')}; only ${taskFileRel} is admitted`;
    }
  }
}
proven('no-head-drift-beyond-the-delivery-flip', headDriftOk, headDriftEvidence);

/** ── 7. Checks exist, and every one the PR reports has passed ────────────── */
/**
 * Read structurally, never from one exit code. `gh pr checks --json` buckets
 * each check into pass / fail / pending / skipping / cancel. The command exits
 * non-zero when checks are failing or absent, which is a statement about the
 * checks and not about the report, so stdout is what is read.
 *
 * An honest limit, because the earlier wording here claimed more than the data
 * can carry: `gh pr checks --json` offers name, bucket, state, link, workflow,
 * event and timestamps — and NO commit field. It reports the checks of whatever
 * the PR's head is when asked, which the server re-resolves each time. So the
 * checks cannot be bound to an oid by reading them.
 *
 * They are bound by bracketing instead: the head is re-read AFTER the checks and
 * must still be the head every other condition was judged against. If the branch
 * moved while this gate was running, that is caught here rather than assumed
 * away, and the caller is additionally required to pin the merge itself to
 * GATE_PROVEN_HEAD.
 */
let checks = [];
try {
  const raw = gh(['pr', 'checks', String(pr.number), '--json', 'name,bucket,state,link']);
  checks = JSON.parse(raw);
} catch (error) {
  const out = (error.stdout ?? '').toString().trim();
  if (out === '') {
    // `gh` prints nothing when a PR has no checks at all. That is the
    // zero-checks condition, not an unreadable answer.
    checks = [];
  } else {
    try {
      checks = JSON.parse(out);
    } catch {
      die(`could not read checks for PR #${pr.number} — ${(error.stderr ?? error.message).toString().trim()}`);
    }
  }
}
const buckets = checks.map((c) => c.bucket);
const passing = checks.filter((c) => c.bucket === 'pass');
const notPassing = checks.filter((c) => c.bucket !== 'pass');

proven(
  'checks-exist',
  checks.length > 0,
  checks.length === 0
    ? 'PR has zero checks; under CI_REQUIRED that is a blocking condition of its own, never success'
    : `${checks.length} check(s): ${checks.map((c) => `${c.name}=${c.bucket}`).join(', ')}`,
);
proven(
  'every-check-passed',
  checks.length > 0 && notPassing.length === 0,
  notPassing.length === 0
    ? `${passing.length} check(s) all in bucket pass`
    : `not passing: ${notPassing.map((c) => `${c.name}=${c.bucket}/${c.state}`).join(', ')}`,
);
void buckets;

let headAfterChecks = null;
try {
  headAfterChecks = JSON.parse(gh(['pr', 'view', String(pr.number), '--json', 'headRefOid'])).headRefOid;
} catch (error) {
  die(`could not re-read PR #${pr.number}'s head after reading its checks — ${error.message}`);
}
proven(
  'head-did-not-move-while-this-gate-ran',
  headAfterChecks === pr.headRefOid,
  headAfterChecks === pr.headRefOid
    ? `head is still ${pr.headRefOid} after the checks were read`
    : `head moved from ${pr.headRefOid} to ${headAfterChecks} while this gate was running`,
);

/** ── 8. The task file is flipped to DONE in this same pull request ───────── */
let taskFileAtHead = null;
try {
  taskFileAtHead = git(['show', `${head}:${taskFileRel}`]);
} catch {
  taskFileAtHead = null;
}
if (taskFileAtHead === null) {
  // The head may not be fetched locally yet. Fetch it read-only, by object id,
  // without moving any branch or touching a worktree.
  try {
    // No `--depth`: see ensureLocalObject. A shallow fetch here would truncate
    // the live checkout's history.
    git(['fetch', 'origin', head]);
    taskFileAtHead = git(['show', `${head}:${taskFileRel}`]);
  } catch (error) {
    die(`cannot read ${taskFileRel} at PR head ${head} — ${(error.stderr ?? error.message).toString().trim()}`);
  }
}
proven(
  'task-file-says-done-at-pr-head',
  /^status:\s*DONE\s*$/m.test(taskFileAtHead),
  `${taskFileRel} at ${head.slice(0, 8)} has status: ${
    (/^status:\s*(\S+)\s*$/m.exec(taskFileAtHead) ?? [null, 'unreadable'])[1]
  }`,
);

/** ── 9. Scope: the pull request touches only what the profile granted ────── */
/**
 * PROXY for "no new product decision was invented by the writer". A machine
 * cannot read intent. What it can read is reach: a diff confined to the paths
 * the repository profile granted this wave, plus the task file the delivery
 * flip needs, cannot have edited a contract, a migration or a workflow. That is
 * a narrower claim than the condition it stands in for, and it is the one that
 * is actually checked.
 */
const profilePath = join(ROOT, '.agent-orchestrator', 'repo-profile.yaml');
if (!existsSync(profilePath)) die(`no repository profile at ${profilePath}`);
const profileText = readFileSync(profilePath, 'utf8');

function yamlStringList(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s{2,}${key}:\\s*$`).test(l));
  if (start < 0) return null;
  const indent = /^(\s*)/.exec(lines[start])[1].length;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i].replace(/#.*$/, '');
    if (line.trim() === '') continue;
    const here = /^(\s*)/.exec(line)[1].length;
    if (here <= indent) break;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (!item) break;
    out.push(item[1].replace(/^["']|["']$/g, ''));
  }
  return out;
}

const allowed = yamlStringList(profileText, 'allowedPaths');
if (allowed === null || allowed.length === 0) die(`could not read scope.allowedPaths from ${profilePath}`);
/**
 * `?? []` used to sit here, which meant "this reader could not parse
 * protectedPaths" and "this profile protects nothing" produced the same answer —
 * and the profile's own comment says protectedPaths is evaluated FIRST and wins.
 * A deny list this file failed to read must block, not evaporate.
 */
const declaresProtected = /^\s{2,}protectedPaths:\s*$/m.test(profileText);
const protectedPaths = yamlStringList(profileText, 'protectedPaths');
if (declaresProtected && (protectedPaths === null || protectedPaths.length === 0)) {
  die(`${profilePath} declares scope.protectedPaths but this reader could not parse it`);
}
const protectedList = protectedPaths ?? [];

/** A grant denotes a subtree, and the separator is the boundary: `scripts` covers
 *  `scripts/x` but not `scriptsX`. Mirrors AO's own rule rather than inventing one. */
function underAny(file, roots) {
  const f = file.replace(/\\/g, '/');
  return roots.some((r) => {
    const root = r.replace(/\\/g, '/').replace(/\/+$/, '');
    return f === root || f.startsWith(`${root}/`);
  });
}

const prFiles = (pr.files ?? []).map((f) => f.path);
if (prFiles.length === 0) die(`PR #${pr.number} reports no files; refusing to judge scope on nothing`);
/**
 * `gh pr view --json files` returns at most 100 entries and does not paginate.
 * Judging scope on a silently truncated list is how a migration or a workflow
 * file slips past a proxy that then reports "all under scope.allowedPaths".
 * `changedFiles` is the PR's real count, so the truncation is detectable — and
 * an undetected one must never be a pass.
 */
if (typeof pr.changedFiles === 'number' && pr.changedFiles !== prFiles.length) {
  die(
    `PR #${pr.number} changed ${pr.changedFiles} file(s) but the API returned only ${prFiles.length}; ` +
      'scope cannot be judged on a truncated list',
  );
}
const grantedForDelivery = [...allowed, taskFileRel];
const outside = prFiles.filter(
  (f) => !underAny(f, grantedForDelivery) || underAny(f, protectedList),
);
proxy(
  'pr-stays-inside-the-projected-scope',
  outside.length === 0,
  outside.length === 0
    ? `${prFiles.length} file(s), all under scope.allowedPaths plus the task file`
    : `outside the grant: ${outside.join(', ')}`,
);

/** ── 10. ROADMAP says done, for this task, at this head ──────────────────── */
/** PROXY for "ROADMAP accurately describes what was delivered". Accuracy of
 *  prose is not machine-checkable; the status line for this exact task is. */
let roadmapAtHead;
try {
  roadmapAtHead = git(['show', `${head}:ROADMAP.md`]);
} catch (error) {
  die(`cannot read ROADMAP.md at PR head ${head} — ${(error.stderr ?? error.message).toString().trim()}`);
}
const heading = new RegExp(`^####\\s+${TASK}:`, 'm').exec(roadmapAtHead);
let roadmapStatus = null;
if (heading) {
  const after = roadmapAtHead.slice(heading.index);
  const status = /^Status:\s*`([a-z_]+)`/m.exec(after);
  roadmapStatus = status ? status[1] : null;
}
proxy(
  'roadmap-marks-this-task-done',
  roadmapStatus === 'done',
  heading === null
    ? `ROADMAP.md at ${head.slice(0, 8)} has no "#### ${TASK}:" heading`
    : `ROADMAP.md status for ${TASK} is ${roadmapStatus ?? 'unreadable'}`,
);

/** ── 11. The handoff is this task's ──────────────────────────────────────── */
/** PROXY for "handoff accurately describes what was delivered": it must at
 *  least be about this task and carry the eight binding fields by name. */
let handoffAtHead;
try {
  handoffAtHead = git(['show', `${head}:handoffs/latest-handoff.md`]);
} catch (error) {
  die(`cannot read handoffs/latest-handoff.md at PR head ${head} — ${(error.stderr ?? error.message).toString().trim()}`);
}
const handoffNamesTask = handoffAtHead.includes(TASK);
const handoffFields = [
  /task\s*id/i,
  /what\s+changed/i,
  /why/i,
  /files\s+changed/i,
  /verification\s+executed/i,
  /verification\s+result/i,
  /(known\s+issues|blockers|residual)/i,
  /(human[- ]review|next\s+steps)/i,
];
const missingFields = handoffFields.filter((r) => !r.test(handoffAtHead)).length;
proxy(
  'handoff-is-this-tasks-and-complete',
  handoffNamesTask && missingFields === 0,
  `handoff at ${head.slice(0, 8)}: names ${TASK}=${handoffNamesTask}, ${
    handoffFields.length - missingFields
  }/${handoffFields.length} binding fields present`,
);

/** ── 12. Both working trees are clean ────────────────────────────────────── */
let sourceDirty;
try {
  sourceDirty = git(['status', '--porcelain', '-uall']).trim();
} catch (error) {
  die(`cannot read the source checkout status — ${error.message}`);
}
proven(
  'source-checkout-is-clean',
  sourceDirty === '',
  sourceDirty === '' ? `${ROOT} is clean` : `${ROOT} has uncommitted changes`,
);

const worktree = taskRecord.worktreePath;
if (typeof worktree === 'string' && worktree !== '' && existsSync(worktree)) {
  let wtDirty;
  try {
    wtDirty = git(['status', '--porcelain', '-uall'], worktree).trim();
  } catch (error) {
    die(`cannot read the delivery worktree status at ${worktree} — ${error.message}`);
  }
  proven(
    'delivery-worktree-is-clean',
    wtDirty === '',
    wtDirty === '' ? `${worktree} is clean` : `${worktree} has uncommitted changes`,
  );
} else {
  // An absence is not a cleanliness proof. The supervisor authors the delivery
  // flip INSIDE this worktree moments before calling the gate, so a worktree
  // that is gone by now means something went wrong — not that everything is
  // fine. Recording PASS here would let the condition's name assert something
  // its own evidence contradicts.
  proven(
    'delivery-worktree-is-clean',
    false,
    `no worktree at ${worktree ?? 'none recorded'}; the delivery flip was written there moments ago, so its absence is a fault and not a clean state`,
  );
}

report();
process.exit(conditions.every((c) => c.ok) ? EXIT_AUTHORISED : EXIT_NOT_AUTHORISED);
