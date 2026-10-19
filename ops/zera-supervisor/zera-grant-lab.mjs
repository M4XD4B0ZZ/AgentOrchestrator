/**
 * Dry-test lab for the two new Zera standing authorisations.
 *
 * Builds a real, disposable AO repository per case — real git, real worktree,
 * real repo profile, a real durable task record and a real verification-attempt
 * history bound with AO's OWN `verificationAttemptBinding` — then runs the
 * prover against it and compares the verdict with what the case expects.
 *
 * Nothing here touches D:\Workspaces_VSCode\HealthApp or D:\AgentOrchestrator.
 * Every case lives under its own directory in the lab root and is deleted and
 * rebuilt on each run, so a case can never inherit another case's tree.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const AO_ROOT = 'D:\\AgentOrchestrator';
const RUNS = 'C:\\Users\\Max\\AO-runs';
const LAB = resolve(process.argv[2] ?? join(process.env.TEMP ?? '.', 'zera-grant-lab'));

const { verificationAttemptBinding } = await import(
  pathToFileURL(join(AO_ROOT, 'dist', 'verify', 'verification-attempt.js')).href
);

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const PROFILE = (id) => `schemaVersion: 1

repository:
  id: ${id}
  defaultBranch: main

taskSource:
  kind: MARKDOWN_DIRECTORY
  path: .agent-orchestrator/tasks

context:
  canonicalSources:
    - NOTES.md

capabilities:
  codegraph: OPTIONAL

verification:
  phases:
    - phase: VERIFY
      command:
        - node
        - --version

scope:
  allowedPaths:
    - src
  protectedPaths: []

completion:
  maxReviewRounds: 2

remote:
  required: false
`;

const TASK_MD = (id, status, dependsOn = []) => `---
id: ${id}
title: Lab task ${id}
status: ${status}
kind: NORMAL
priority: HIGH
currentFocus: false
dependsOn: [${dependsOn.join(', ')}]
---

# ${id}

A disposable task used only to drive a grant prover.
`;

/** A verification attempt record, shaped exactly as the store's schema requires. */
function attempt(subjectCommit, verdict, attemptedAt) {
  return {
    attemptedAt,
    subjectCommit,
    profileDigest: 'a'.repeat(64),
    verdict,
    stoppedAt: 'VERIFY',
    phases: [
      {
        phase: 'VERIFY',
        outcome: verdict === 'FAILED' ? 'RAN' : 'UNAVAILABLE',
        exitCode: verdict === 'FAILED' ? 1 : null,
        signal: null,
        outputTruncated: false,
        failureCode: null,
        errnoCode: null,
        durationMs: 1234,
      },
    ],
    stdoutExcerpt: ['lab attempt'],
    stderrExcerpt: [],
  };
}

/**
 * Builds one disposable repository.
 *
 * `record` is a function of the facts the build discovers (the base pin, the
 * worktree path, the branch), so a case can state its record in terms of what
 * git actually produced rather than guessing a sha in advance.
 */
function buildCase(name, opts) {
  const root = join(LAB, name);
  rmSync(root, { recursive: true, force: true });
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, '.agent-orchestrator', 'tasks'), { recursive: true });
  mkdirSync(join(repo, '.agent-orchestrator', 'runtime', 'verification-attempts'), {
    recursive: true,
  });

  sh('git', ['init', '-b', 'main'], repo);
  sh('git', ['config', 'user.email', 'lab@example.invalid'], repo);
  sh('git', ['config', 'user.name', 'Grant Lab'], repo);
  sh('git', ['config', 'commit.gpgsign', 'false'], repo);

  writeFileSync(join(repo, 'NOTES.md'), '# notes\n');
  writeFileSync(join(repo, 'src', 'app.js'), 'export const v = 1;\n');
  writeFileSync(join(repo, 'OUTSIDE.md'), '# outside every allowed path\n');
  writeFileSync(join(repo, '.agent-orchestrator', 'repo-profile.yaml'), PROFILE(name.toLowerCase()));
  for (const t of opts.tasks) {
    writeFileSync(
      join(repo, '.agent-orchestrator', 'tasks', `${t.id}.md`),
      TASK_MD(t.id, t.status, t.dependsOn ?? []),
    );
  }
  writeFileSync(join(repo, '.gitignore'), '');
  sh('git', ['add', '-A'], repo);
  sh('git', ['commit', '-m', 'lab base'], repo);
  const basePin = sh('git', ['rev-parse', 'HEAD'], repo);

  const taskId = opts.taskId;
  const branch = `ao/task/${taskId}`;
  const worktree = join(root, 'worktrees', taskId);
  sh('git', ['worktree', 'add', '-b', branch, worktree, basePin], repo);

  // The operator's repair, or an out-of-scope edit, or nothing at all.
  if (opts.dirty === 'IN_SCOPE') {
    writeFileSync(join(worktree, 'src', 'app.js'), 'export const v = 2; // operator repair\n');
  } else if (opts.dirty === 'OUT_OF_SCOPE') {
    writeFileSync(join(worktree, 'OUTSIDE.md'), '# touched outside every allowed path\n');
  }

  const facts = { repo, worktree, branch, basePin, taskId, repositoryId: name.toLowerCase() };

  // A case may move HEAD on top of the attempt's subject.
  if (opts.moveHead) {
    writeFileSync(join(worktree, 'src', 'later.js'), 'export const later = true;\n');
    sh('git', ['add', '-A'], worktree);
    sh('git', ['commit', '--no-gpg-sign', '-m', 'a later commit'], worktree);
    facts.head = sh('git', ['rev-parse', 'HEAD'], worktree);
    if (opts.dirty === 'IN_SCOPE') {
      writeFileSync(join(worktree, 'src', 'app.js'), 'export const v = 3; // repair after the move\n');
    }
  } else {
    facts.head = sh('git', ['rev-parse', 'HEAD'], worktree);
  }

  // The durable record.
  const record = opts.record(facts);
  writeFileSync(
    join(repo, '.agent-orchestrator', 'runtime', `${taskId}.json`),
    JSON.stringify(record, null, 2),
  );

  // The attempt history, bound with AO's own digest so the store accepts it.
  if (opts.attempts) {
    const attempts = opts.attempts(facts);
    const payload = {
      attemptVersion: 1,
      taskId,
      repositoryRoot: repo,
      attempts,
    };
    writeFileSync(
      join(repo, '.agent-orchestrator', 'runtime', 'verification-attempts', `${taskId}.json`),
      JSON.stringify(
        { ...payload, binding: verificationAttemptBinding({ taskId, repositoryRoot: repo }, payload) },
        null,
        2,
      ),
    );
  }

  return facts;
}

/** The task record every case starts from, with per-case fields overlaid. */
function baseRecord(facts, over) {
  return {
    schemaVersion: 1,
    taskId: facts.taskId,
    repositoryId: facts.repositoryId,
    repositoryRoot: facts.repo,
    worktreePath: facts.worktree,
    state: 'BLOCKED_VERIFY',
    stateEnteredAt: '2026-09-13T10:00:00.000Z',
    baseBranch: 'main',
    basePinnedCommit: facts.basePin,
    scopeAuthorityCommit: null,
    workBranch: facts.branch,
    currentCommit: null,
    reviewRound: 0,
    maxReviewRounds: 2,
    grantedReviewRounds: 0,
    blockedAgent: null,
    resumeFrom: { phase: 'REMEDIATE', round: 1 },
    reportedResetAt: null,
    worktreeCleanAtCheckpoint: false,
    operatorResolution: null,
    findingHistory: [],
    ...over,
  };
}

function runProver(script, repo, extra = []) {
  try {
    const out = execFileSync(process.execPath, [join(RUNS, script), '--repository', repo, ...extra], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AO_ROOT },
    });
    return { exit: 0, out };
  } catch (error) {
    return { exit: error.status ?? -1, out: (error.stdout ?? '').toString() + (error.stderr ?? '').toString() };
  }
}

/** Writes a v2 retry ledger with the given per-key attempt instants. */
function ledger(path, entries) {
  const tasks = {};
  for (const [key, instants] of Object.entries(entries)) tasks[key] = { attempts: instants };
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, tasks }, null, 2));
  return path;
}

const results = [];
function check(name, got, want, detail) {
  const ok = got === want;
  results.push({ name, ok, got, want, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (exit ${got}, expected ${want})`);
  if (detail) console.log(`        ${detail}`);
}

function verdictOf(out, prefix) {
  const m = new RegExp(`^${prefix}_VERDICT = (.+)$`, 'm').exec(out);
  const r = new RegExp(`^${prefix}_REASON = (.+)$`, 'm').exec(out);
  const a = /^REPAIR_GRANT_AO_REFUSAL = (.+)$/m.exec(out);
  const g = /^WRITER_GRANT_WOULD_GRANT_ROUND = (.+)$/m.exec(out);
  return {
    verdict: m ? m[1] : '(none)',
    reason: r ? r[1] : '(none)',
    aoRefusal: a ? a[1] : null,
    wouldGrantRound: g ? g[1] : null,
  };
}

mkdirSync(LAB, { recursive: true });

/* ─────────────────────── operator-repair grant cases ─────────────────────── */

const REPAIR = 'zera-operator-repair-grant.mjs';
const T = 'LAB-001';
const one = (id, status = 'OPEN') => [{ id, status }];

// R1 — the exact shape the authorisation names.
{
  const f = buildCase('R1-valid', {
    taskId: T,
    tasks: one(T),
    dirty: 'IN_SCOPE',
    record: (f) => baseRecord(f, {}),
    attempts: (f) => [attempt(f.head, 'FAILED', '2026-09-13T09:00:00.000Z')],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R1 valid exact failed tree -> grant selected', r.exit, 0, `${v.verdict} / ${v.reason}`);
}

// R2 — HEAD moved on top of the attempt's subject.
{
  const f = buildCase('R2-head-moved', {
    taskId: T,
    tasks: one(T),
    dirty: 'IN_SCOPE',
    moveHead: true,
    record: (f) => baseRecord(f, {}),
    // Subject is the BASE pin, but HEAD is the later commit.
    attempts: (f) => [attempt(f.basePin, 'FAILED', '2026-09-13T09:00:00.000Z')],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R2 HEAD moved -> no grant', r.exit, 10, `AO refusal: ${v.aoRefusal}`);
  check('R2 refusal is HEAD_MOVED', v.aoRefusal, 'HEAD_MOVED');
}

// R3 — nothing to adopt: the worktree is clean.
{
  const f = buildCase('R3-no-repair', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => baseRecord(f, {}),
    attempts: (f) => [attempt(f.head, 'FAILED', '2026-09-13T09:00:00.000Z')],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R3 no repair -> no grant', r.exit, 10, `AO refusal: ${v.aoRefusal}`);
  check('R3 refusal is NOTHING_TO_ADOPT', v.aoRefusal, 'NOTHING_TO_ADOPT');
}

// R4 — the repair reaches outside the declared scope.
{
  const f = buildCase('R4-out-of-scope', {
    taskId: T,
    tasks: one(T),
    dirty: 'OUT_OF_SCOPE',
    record: (f) => baseRecord(f, {}),
    attempts: (f) => [attempt(f.head, 'FAILED', '2026-09-13T09:00:00.000Z')],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R4 out-of-scope repair -> no grant', r.exit, 10, `AO refusal: ${v.aoRefusal}`);
  check('R4 refusal is REPAIR_OUT_OF_SCOPE', v.aoRefusal, 'REPAIR_OUT_OF_SCOPE');
}

// R5a — a stale attempt: the LATEST record is about a commit that is not HEAD.
// A build that adopted against the older, matching failure would grant here.
{
  const f = buildCase('R5a-stale-latest', {
    taskId: T,
    tasks: one(T),
    dirty: 'IN_SCOPE',
    moveHead: true,
    record: (f) => baseRecord(f, {}),
    attempts: (f) => [
      attempt(f.head, 'FAILED', '2026-09-13T08:00:00.000Z'),
      attempt(f.basePin, 'FAILED', '2026-09-13T09:00:00.000Z'),
    ],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R5a stale attempt (latest is not HEAD) -> no grant', r.exit, 10, `AO refusal: ${v.aoRefusal}`);
  check('R5a refusal is HEAD_MOVED', v.aoRefusal, 'HEAD_MOVED');
}

// R5b — the latest attempt is UNAVAILABLE: the commands never ran, so there is
// no failure a diff in the worktree repairs.
{
  const f = buildCase('R5b-unavailable', {
    taskId: T,
    tasks: one(T),
    dirty: 'IN_SCOPE',
    record: (f) => baseRecord(f, {}),
    attempts: (f) => [
      attempt(f.head, 'FAILED', '2026-09-13T08:00:00.000Z'),
      attempt(f.head, 'UNAVAILABLE', '2026-09-13T09:00:00.000Z'),
    ],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R5b latest attempt UNAVAILABLE -> no grant', r.exit, 10, `AO refusal: ${v.aoRefusal}`);
  check('R5b refusal is LATEST_ATTEMPT_NOT_FAILED', v.aoRefusal, 'LATEST_ATTEMPT_NOT_FAILED');
}

// R6 — no attempt history at all.
{
  const f = buildCase('R6-no-history', {
    taskId: T,
    tasks: one(T),
    dirty: 'IN_SCOPE',
    record: (f) => baseRecord(f, {}),
    attempts: null,
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R6 no verification attempt -> no grant', r.exit, 10, `AO refusal: ${v.aoRefusal}`);
  check('R6 refusal is NO_VERIFICATION_ATTEMPT', v.aoRefusal, 'NO_VERIFICATION_ATTEMPT');
}

// R7 — the resume point names a phase this state does not declare.
{
  const f = buildCase('R7-wrong-phase', {
    taskId: T,
    tasks: one(T),
    dirty: 'IN_SCOPE',
    record: (f) => baseRecord(f, { resumeFrom: { phase: 'VERIFY', round: 1 } }),
    attempts: (f) => [attempt(f.head, 'FAILED', '2026-09-13T09:00:00.000Z')],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  // MEASURED, and stronger than the expectation this case was written with.
  // `resume-policy.ts` declares REMEDIATE as the only phase BLOCKED_VERIFY may
  // resume from, and `safeParseTaskState` enforces it: "resumeFrom.phase
  // \"VERIFY\" is not reachable from BLOCKED_VERIFY. Allowed phases: REMEDIATE."
  // So the shape is unrepresentable on disk, AO's RESUME_POINT_NOT_REMEDIATE is
  // unreachable from a stored record, and the prover fails CLOSED one layer
  // earlier. The supervisor stops on UNDECIDABLE and notifies.
  check('R7 resume phase is not REMEDIATE -> fails closed, no grant', r.exit, 2, `${v.verdict} / ${v.reason}`);
  check('R7 verdict is UNDECIDABLE, never a grant', v.verdict, 'UNDECIDABLE');
}

// R8 — the task file has already been closed.
{
  const f = buildCase('R8-task-done', {
    taskId: T,
    tasks: [{ id: T, status: 'DONE' }],
    dirty: 'IN_SCOPE',
    record: (f) => baseRecord(f, {}),
    attempts: (f) => [attempt(f.head, 'FAILED', '2026-09-13T09:00:00.000Z')],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R8 task file DONE -> no grant', r.exit, 10, `${v.reason}`);
}

/* ── cross-check: the repair lane may not fire for an unrelated state ─────── */

// R9 — the writer-death shape. The repair prover must refuse it outright, so
// `--verify-operator-repair` can never be emitted for HUMAN_DECISION_REQUIRED.
{
  const f = buildCase('R9-writer-death-shape', {
    taskId: T,
    tasks: one(T),
    dirty: 'IN_SCOPE',
    record: (f) =>
      baseRecord(f, {
        state: 'HUMAN_DECISION_REQUIRED',
        blockedAgent: 'claude',
        resumeFrom: { phase: 'IMPLEMENT', round: 1 },
      }),
    attempts: (f) => [attempt(f.head, 'FAILED', '2026-09-13T09:00:00.000Z')],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R9 HUMAN_DECISION_REQUIRED -> repair lane refuses', r.exit, 10, `${v.reason}`);
}

// R10 — a state neither lane covers at all.
{
  const f = buildCase('R10-scope-violation', {
    taskId: T,
    tasks: one(T),
    dirty: 'IN_SCOPE',
    record: (f) =>
      baseRecord(f, { state: 'SCOPE_VIOLATION', blockedAgent: 'claude', resumeFrom: null }),
    attempts: (f) => [attempt(f.head, 'FAILED', '2026-09-13T09:00:00.000Z')],
  });
  const r = runProver(REPAIR, f.repo);
  const v = verdictOf(r.out, 'REPAIR_GRANT');
  check('R10 SCOPE_VIOLATION -> repair lane refuses', r.exit, 10, `${v.reason}`);
}

/* ────────────────────────── writer-death grant cases ─────────────────────── */

const WRITER = 'zera-writer-death-grant.mjs';

const writerRecord = (f, over = {}) =>
  baseRecord(f, {
    state: 'HUMAN_DECISION_REQUIRED',
    blockedAgent: 'claude',
    resumeFrom: { phase: 'IMPLEMENT', round: 1 },
    ...over,
  });

// W1 — the exact writer-death shape.
{
  const f = buildCase('W1-valid', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => writerRecord(f),
  });
  const r = runProver(WRITER, f.repo);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W1 exact IMPLEMENT writer-death shape -> continuation', r.exit, 0, `${v.verdict} / grantReviewRound=${v.wouldGrantRound}`);
  check('W1 grantReviewRound is false', v.wouldGrantRound, 'false');
}

// W2 — the review budget is exhausted, and at the ceiling so grantReviewRound
// is still false. This isolates "exhausted" from "would buy a round".
{
  const f = buildCase('W2-budget-exhausted', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => writerRecord(f, { maxReviewRounds: 12, grantedReviewRounds: 0, reviewRound: 12 }),
  });
  const r = runProver(WRITER, f.repo);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W2 reviewRound exhausted -> refused', r.exit, 10, `${v.reason}`);
  check('W2 grantReviewRound is still false (the ceiling)', v.wouldGrantRound, 'false');
}

// W3 — the budget is exhausted BELOW the ceiling, so AO would write
// grantedReviewRounds + 1. This is the one the operator named explicitly.
{
  const f = buildCase('W3-would-grant-round', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => writerRecord(f, { maxReviewRounds: 2, grantedReviewRounds: 0, reviewRound: 2 }),
  });
  const r = runProver(WRITER, f.repo);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W3 grantReviewRound would be true -> refused', r.exit, 10, `${v.reason}`);
  check('W3 grantReviewRound is reported true', v.wouldGrantRound, 'true');
}

// W4 — the reviewer, not the writer.
{
  const f = buildCase('W4-codex', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) =>
      writerRecord(f, { blockedAgent: 'codex', resumeFrom: { phase: 'REVIEW', round: 1 } }),
  });
  const r = runProver(WRITER, f.repo);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W4 blockedAgent != claude -> refused', r.exit, 10, `${v.reason}`);
}

// W5 — the remediation phase, which is where a review-budget park lands.
{
  const f = buildCase('W5-remediate', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => writerRecord(f, { resumeFrom: { phase: 'REMEDIATE', round: 1 } }),
  });
  const r = runProver(WRITER, f.repo);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W5 resume phase != IMPLEMENT -> refused', r.exit, 10, `${v.reason}`);
}

// W6 — a review finding is waiting.
{
  const f = buildCase('W6-findings', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) =>
      writerRecord(f, {
        reviewRound: 1,
        findingHistory: [
          {
            round: 1,
            severity: 'high',
            fingerprint: 'b'.repeat(32),
            path: 'src/app.js',
            rule: 'lab.rule',
          },
        ],
      }),
  });
  const r = runProver(WRITER, f.repo);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W6 findings present -> refused', r.exit, 10, `${v.reason}`);
}

// W7 — an operator has already ended this task. Re-opening it is a product
// decision by any reading, and it is refused from the representable side: the
// state AO writes for it.
{
  const f = buildCase('W7-operator-resolved', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) =>
      baseRecord(f, {
        state: 'OPERATOR_RESOLVED',
        blockedAgent: null,
        resumeFrom: null,
        operatorResolution: { closedFrom: 'HUMAN_DECISION_REQUIRED' },
      }),
  });
  const r = runProver(WRITER, f.repo);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W7 operator decision already recorded -> refused', r.exit, 10, `${v.reason}`);
}

// W7b — the same decision written onto HUMAN_DECISION_REQUIRED instead.
//
// MEASURED: AO's own contract refuses it — "State HUMAN_DECISION_REQUIRED must
// not carry operatorResolution: only OPERATOR_RESOLVED records an operator
// ending the task." So this shape cannot exist on disk and the prover fails
// CLOSED on it rather than reading past it. The supervisor stops on UNDECIDABLE.
{
  const f = buildCase('W7b-resolution-on-hdr', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) =>
      writerRecord(f, { operatorResolution: { closedFrom: 'HUMAN_DECISION_REQUIRED' } }),
  });
  const r = runProver(WRITER, f.repo);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W7b resolution on HUMAN_DECISION_REQUIRED -> fails closed', r.exit, 2, `${v.verdict} / ${v.reason}`);
  check('W7b verdict is UNDECIDABLE, never a grant', v.verdict, 'UNDECIDABLE');
}

/* ── cross-check: the writer lane may not fire for an unrelated state ─────── */

// W8 — the repair shape. The writer prover must refuse it, so
// `--continue-human-decision` can never be emitted for BLOCKED_VERIFY.
{
  const f = buildCase('W8-repair-shape', {
    taskId: T,
    tasks: one(T),
    dirty: 'IN_SCOPE',
    record: (f) => baseRecord(f, {}),
    attempts: (f) => [attempt(f.head, 'FAILED', '2026-09-13T09:00:00.000Z')],
  });
  const r = runProver(WRITER, f.repo);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W8 BLOCKED_VERIFY -> writer lane refuses', r.exit, 10, `${v.reason}`);
}

// W9 — a quota block. Neither new lane may touch it.
{
  const f = buildCase('W9-usage-limit', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) =>
      baseRecord(f, {
        state: 'BLOCKED_USAGE_LIMIT',
        blockedAgent: 'claude',
        resumeFrom: { phase: 'IMPLEMENT', round: 1 },
        reportedResetAt: null,
      }),
  });
  const rw = runProver(WRITER, f.repo);
  const rr = runProver(REPAIR, f.repo);
  check('W9 BLOCKED_USAGE_LIMIT -> writer lane refuses', rw.exit, 10, verdictOf(rw.out, 'WRITER_GRANT').reason);
  check('W9 BLOCKED_USAGE_LIMIT -> repair lane refuses', rr.exit, 10, verdictOf(rr.out, 'REPAIR_GRANT').reason);
}

// W10 — an auth block. Neither new lane may touch it either.
{
  const f = buildCase('W10-blocked-auth', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) =>
      baseRecord(f, {
        state: 'BLOCKED_AUTH',
        blockedAgent: 'claude',
        resumeFrom: { phase: 'IMPLEMENT', round: 1 },
      }),
  });
  const rw = runProver(WRITER, f.repo);
  const rr = runProver(REPAIR, f.repo);
  check('W10 BLOCKED_AUTH -> writer lane refuses', rw.exit, 10, verdictOf(rw.out, 'WRITER_GRANT').reason);
  check('W10 BLOCKED_AUTH -> repair lane refuses', rr.exit, 10, verdictOf(rr.out, 'REPAIR_GRANT').reason);
}

// W11 — READY_FOR_PR, a terminal state nothing may continue.
{
  const f = buildCase('W11-ready-for-pr', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) =>
      baseRecord(f, {
        state: 'READY_FOR_PR',
        blockedAgent: null,
        resumeFrom: null,
        reviewRound: 1,
        currentCommit: f.head,
        worktreeCleanAtCheckpoint: true,
      }),
  });
  const rw = runProver(WRITER, f.repo);
  const rr = runProver(REPAIR, f.repo);
  check('W11 READY_FOR_PR -> writer lane refuses', rw.exit, 10, verdictOf(rw.out, 'WRITER_GRANT').reason);
  check('W11 READY_FOR_PR -> repair lane refuses', rr.exit, 10, verdictOf(rr.out, 'REPAIR_GRANT').reason);
}

/* ─────────────── the durable restart bound, and its key isolation ────────── */

// W12 — the restart budget is spent for the day. The shape is perfect; the
// answer is still no, because a writer that will not stay alive is a person's
// problem rather than a retry's.
{
  const f = buildCase('W12-restart-exhausted', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => writerRecord(f),
  });
  const now = Date.now();
  const b = ledger(join(LAB, 'W12-restart-exhausted', 'budget.json'), {
    [`${T}#writer-restart`]: [
      new Date(now - 20 * 3600_000).toISOString(),
      new Date(now - 15 * 3600_000).toISOString(),
      new Date(now - 10 * 3600_000).toISOString(),
      new Date(now - 5 * 3600_000).toISOString(),
    ],
  });
  const r = runProver(WRITER, f.repo, ['--budget', b, '--retry-hours', '1', '--max-per-day', '4']);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  const st = /^WRITER_GRANT_BUDGET_STATE = (.+)$/m.exec(r.out);
  check('W12 restart budget exhausted -> refused', r.exit, 10, `${v.reason}`);
  check('W12 budget state is EXHAUSTED', st ? st[1] : '(none)', 'EXHAUSTED');
}

// W13 — one restart was spent minutes ago. The spacing refuses the next one.
{
  const f = buildCase('W13-restart-spacing', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => writerRecord(f),
  });
  const b = ledger(join(LAB, 'W13-restart-spacing', 'budget.json'), {
    [`${T}#writer-restart`]: [new Date(Date.now() - 5 * 60_000).toISOString()],
  });
  const r = runProver(WRITER, f.repo, ['--budget', b, '--retry-hours', '1', '--max-per-day', '4']);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  const st = /^WRITER_GRANT_BUDGET_STATE = (.+)$/m.exec(r.out);
  check('W13 restart spacing not elapsed -> refused', r.exit, 10, `${v.reason}`);
  check('W13 budget state is SPACING', st ? st[1] : '(none)', 'SPACING');
}

// W14 — the same ledger, but the entries are the QUOTA lane's, under the plain
// task id. The writer lane must not see them, and must still grant.
//
// This is the isolation claim stated as a measurement: one file, two
// allowances, and neither can spend the other's.
{
  const f = buildCase('W14-key-isolation', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => writerRecord(f),
  });
  const now = Date.now();
  const b = ledger(join(LAB, 'W14-key-isolation', 'budget.json'), {
    [T]: [
      new Date(now - 20 * 3600_000).toISOString(),
      new Date(now - 15 * 3600_000).toISOString(),
      new Date(now - 10 * 3600_000).toISOString(),
      new Date(now - 60_000).toISOString(),
    ],
  });
  const r = runProver(WRITER, f.repo, ['--budget', b, '--retry-hours', '1', '--max-per-day', '4']);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  const st = /^WRITER_GRANT_BUDGET_STATE = (.+)$/m.exec(r.out);
  check('W14 a spent QUOTA budget does not block a writer restart', r.exit, 0, `${v.verdict} / ${v.reason}`);
  check('W14 the writer budget reads OPEN', st ? st[1] : '(none)', 'OPEN');

  // And the mirror: the quota prover must not see the writer lane's entries.
  const b2 = ledger(join(LAB, 'W14-key-isolation', 'budget2.json'), {
    [`${T}#writer-restart`]: [
      new Date(now - 20 * 3600_000).toISOString(),
      new Date(now - 15 * 3600_000).toISOString(),
      new Date(now - 10 * 3600_000).toISOString(),
      new Date(now - 60_000).toISOString(),
    ],
  });
  const q = runProver('zera-quota-grant.mjs', f.repo, ['--budget', b2, '--retry-hours', '2', '--max-per-day', '4']);
  const qb = /^GRANT_BUDGET_STATE = (.+)$/m.exec(q.out);
  check('W14 the quota prover cannot see writer-restart entries', qb ? qb[1] : '(none)', 'OPEN');
}

// W15 — an unreadable ledger is UNDECIDABLE, never a full budget.
{
  const f = buildCase('W15-ledger-unreadable', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => writerRecord(f),
  });
  const b = join(LAB, 'W15-ledger-unreadable', 'budget.json');
  writeFileSync(b, '{ this is not json');
  const r = runProver(WRITER, f.repo, ['--budget', b]);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W15 unreadable ledger -> fails closed', r.exit, 2, `${v.verdict} / ${v.reason}`);
  check('W15 verdict is UNDECIDABLE, never a grant', v.verdict, 'UNDECIDABLE');
}

// W16 — a ledger ENTRY whose `attempts` is not an array. Distinct from an
// unreadable file: the JSON parses, the tasks map is there, and only this task's
// entry is malformed. A reader that answered "no attempts spent" here would hand
// back a FULL budget off a shape it did not understand — the one direction a
// fail-closed reader may never take. Both provers must refuse.
{
  const f = buildCase('W16-malformed-entry', {
    taskId: T,
    tasks: one(T),
    dirty: 'NONE',
    record: (f) => writerRecord(f),
  });
  const b = join(LAB, 'W16-malformed-entry', 'budget.json');
  writeFileSync(b, JSON.stringify({ schemaVersion: 2, tasks: { [`${T}#writer-restart`]: { attempts: 'four' }, [T]: { attempts: 4 } } }, null, 2));
  const r = runProver(WRITER, f.repo, ['--budget', b]);
  const v = verdictOf(r.out, 'WRITER_GRANT');
  check('W16 malformed writer-restart entry -> fails closed', r.exit, 2, `${v.verdict} / ${v.reason}`);
  check('W16 verdict is UNDECIDABLE, never a grant', v.verdict, 'UNDECIDABLE');

  const q = runProver('zera-quota-grant.mjs', f.repo, ['--budget', b]);
  const qv = /^GRANT_VERDICT = (.+)$/m.exec(q.out);
  check('W16 malformed quota entry -> the quota prover fails closed too', q.exit, 2, qv ? qv[1] : '(none)');
}

/* ──────────────────────────────── summary ────────────────────────────────── */

console.log('');
const failed = results.filter((r) => !r.ok);
console.log(`LAB_CASES = ${results.length}`);
console.log(`LAB_FAILED = ${failed.length}`);
for (const f of failed) console.log(`FAILED: ${f.name} — got ${f.got}, expected ${f.want}. ${f.detail ?? ''}`);
console.log(`LAB_VERDICT = ${failed.length === 0 ? 'ALL_PASS' : 'FAILURES'}`);
process.exit(failed.length === 0 ? 0 : 1);
