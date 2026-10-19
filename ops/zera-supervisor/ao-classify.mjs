/**
 * Read-only night-run classifier. Lives OUTSIDE AgentOrchestrator and changes
 * nothing: no task state, no lease, no worktree, no remote, no AO source.
 *
 * It answers one question a night run needs between passes and AO does not
 * answer for it: is there still work a machine can move, or is everything that
 * is left waiting for a person?
 *
 * ── Why it imports AO instead of re-deciding ────────────────────────────────
 *
 * "Which states need a human" is already decided, once, inside AO:
 * `STATE_ATTENTION` in `src/core/task-attention.ts`, total over `ALL_STATES` by
 * `satisfies`, reached through `attentionForTaskState(state, now)`. A quota block
 * is decided by `usageLimitContinuation(state, now)` in the same breath, so that
 * "an operator may continue this" and "somebody must be told" cannot drift
 * apart.
 *
 * So this file calls those two functions out of the shipped `dist/` and adds no
 * rule of its own. A hand-copied list of state names here would be a second
 * authority that goes stale silently the first time AO adds a state; importing
 * the real one fails loudly instead.
 *
 * ── Which tasks it judges ──────────────────────────────────────────────────
 *
 * Only the ones AO's own planner ranks as eligible. That distinction is not
 * cosmetic: a task whose file says `status: DONE` can still carry a runtime
 * record in `HUMAN_DECISION_REQUIRED` — RESOLVER-V3-033 does, right now — and
 * `attentionForTaskState` judges the record, which is all it is given. Such a
 * task is `ALREADY_DONE` to the planner, blocks nothing and needs nobody, so
 * counting it as a blocker would stop a night that had work left.
 *
 * The eligible set is read from AO's read-only `run --repository <root>` report,
 * whose `Ranking` line (`src/run/render-run-plan.ts:224`) is the same ranking the
 * attended run admits from.
 *
 * ── Fail closed ────────────────────────────────────────────────────────────
 *
 * Anything this cannot read is reported as undecidable and stops the night. The
 * opposite default would keep a run polling on a guess.
 *
 * Exit codes (the wrapper's, deliberately not AO's):
 *   0  auto progress remains — a pass is worth making
 *   10 operator-only — nothing left that a machine can move
 *   2  undecidable — could not classify; stop and tell somebody
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const AO_ROOT = process.env.AO_ROOT ?? 'D:\\AgentOrchestrator';

/**
 * The OS profile, not the environment. AO resolves its home through
 * `trustedProfileDirectory()` (src/config/internal/path-provider.ts), which does
 * not read HOME/USERPROFILE — so `os.homedir()`, which prefers those variables,
 * can point this classifier at a different registry than the run it is
 * classifying. `userInfo().homedir` asks the OS.
 */
const HOME = userInfo().homedir;
const REGISTRY = join(HOME, '.agent-orchestrator', 'repositories.yaml');
const ATTENTION_DIR = join(HOME, '.agent-orchestrator', 'operator-attention');

const EXIT_AUTO_PROGRESS = 0;
const EXIT_OPERATOR_ONLY = 10;
const EXIT_UNDECIDABLE = 2;

/** One instant for the whole scan, so two records cannot disagree about a reset. */
const NOW = new Date().toISOString();

const notes = [];

function die(reason) {
  console.log('AUTO_PROGRESS_REMAINING = unknown');
  console.log('FUTURE_WAKE = unknown');
  console.log(`OPERATOR_BLOCKERS = unknown`);
  console.log('STATE_DIGEST = unknown');
  console.log(`CLASSIFIER = UNDECIDABLE — ${reason}`);
  process.exit(EXIT_UNDECIDABLE);
}

/** AO's two judgements, loaded from the build the night run will actually use. */
let attentionForTaskState;
let usageLimitContinuation;
let safeParseTaskState;
try {
  const attention = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-attention.js')).href
  );
  const quota = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'core', 'usage-limit-continuation.js')).href
  );
  // `TaskStateSchema` is the only schema a reader may trust: the internal
  // object schema accepts records the contract rejects. Four keys are also
  // *defaulted*, so an older file can be missing them physically — parsing
  // materialises them, which a raw JSON.parse would not.
  const taskState = await import(
    pathToFileURL(join(AO_ROOT, 'dist', 'core', 'task-state.js')).href
  );
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

/**
 * Quota refusals that name no instant and no path forward.
 *
 * `attentionForTaskState` collapses every refusal to SILENT, discarding the
 * reading — so these four produce no attention item at all while the record
 * genuinely cannot be resumed. Reported on their own line rather than folded
 * into either bucket: calling them operator blockers would put words in AO's
 * mouth, and calling them machine-progressable would spend a pass on them.
 * `RESET_AHEAD` and `MACHINE_MAY_STILL_RESUME` are deliberately not here.
 */
const UNRESUMABLE_SILENT_READINGS = new Set([
  'STATE_NOT_BLOCKED_ON_USAGE_LIMIT',
  'CURRENT_TIME_UNREADABLE',
  'RECORD_REFUSAL_UNRECOGNISED',
  'RESUME_POINT_MISSING',
]);

/**
 * The enlisted roots, from the one file that decides them. Not a YAML parser:
 * this reads the two keys the registry actually has and refuses anything it does
 * not recognise rather than guessing.
 */
function enlistedRoots() {
  if (!existsSync(REGISTRY)) die(`no registry at ${REGISTRY}`);
  const text = readFileSync(REGISTRY, 'utf8');
  const roots = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '');
    if (line.trim() === '') continue;
    const entry = /^\s*-\s*path:\s*(.+?)\s*$/.exec(line);
    if (entry) {
      roots.push(resolve(entry[1].replace(/^["']|["']$/g, '')));
      continue;
    }
    if (/^\s*(schemaVersion|maxConcurrentRepositories|repositories)\s*:/.test(line)) continue;
    die(`registry line not understood: ${raw.trim()}`);
  }
  if (roots.length === 0) die('registry enlists no repository');
  return roots;
}

/**
 * The eligible task ids for one repository, best first, from AO's own read-only
 * plan. `run` exits non-zero for a parked task, which is a statement about the
 * task and not about the report, so the exit code is not read — the `Ranking`
 * line is.
 */
function rankingFor(root) {
  let stdout;
  try {
    stdout = execFileSync(
      process.execPath,
      [join(AO_ROOT, 'dist', 'cli', 'index.js'), 'run', '--repository', root],
      { encoding: 'utf8', cwd: AO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    stdout = error.stdout ?? '';
    if (stdout.trim() === '') die(`AO's read-only plan for ${root} produced nothing — ${error.message}`);
  }
  const line = /^Ranking\s*:\s*(.+?)\s*$/m.exec(stdout);
  if (!line) die(`AO's read-only plan for ${root} printed no Ranking line`);
  const value = line[1];
  if (value === 'empty') return [];
  return value.split('>').map((id) => id.trim()).filter((id) => id !== '');
}

function runtimeRecordPath(root, taskId) {
  return join(root, '.agent-orchestrator', 'runtime', `${taskId}.json`);
}

const roots = enlistedRoots();

const blockers = [];
const machineProgressable = [];
const unresumableSilent = [];
const futureWakes = [];
const digestParts = [];

for (const root of roots) {
  const ranking = rankingFor(root);
  digestParts.push(`root:${root}`, `ranking:${ranking.join(',')}`);

  if (ranking.length === 0) {
    notes.push(`${root}: nothing eligible`);
    continue;
  }

  for (const taskId of ranking) {
    const file = runtimeRecordPath(root, taskId);

    // Eligible and never started. A machine can start it; that is a pass worth
    // making, and it is the ordinary case on a fresh wave.
    if (!existsSync(file)) {
      machineProgressable.push(`${taskId} (not started)`);
      digestParts.push(`${taskId}:NO_RECORD`);
      continue;
    }

    let record;
    try {
      const parsed = safeParseTaskState(JSON.parse(readFileSync(file, 'utf8')));
      if (parsed.success !== true) {
        die(`runtime record violates AO's task-state contract: ${file}`);
      }
      record = parsed.data;
    } catch (error) {
      die(`runtime record unreadable: ${file} — ${error.message}`);
    }
    digestParts.push(`${taskId}:${record.state}:${record.stateEnteredAt}:${record.currentCommit ?? '-'}`);

    let judged;
    try {
      judged = attentionForTaskState(record, NOW);
    } catch (error) {
      die(`AO refused to judge ${taskId} — ${error.message}`);
    }

    if (judged.attention === true) {
      const detail = judged.detail ? `/${judged.detail}` : '';
      blockers.push(`${record.repositoryId ?? root}/${taskId} ${record.state} ${judged.reason}${detail}`);
      continue;
    }

    // Silent. For a quota block, ask AO's quota reading what that silence means
    // before counting the task as the machine's.
    if (record.state === 'BLOCKED_USAGE_LIMIT') {
      let reading;
      try {
        reading = usageLimitContinuation(record, NOW);
      } catch (error) {
        die(`AO refused to read ${taskId}'s quota block — ${error.message}`);
      }
      // Both branches of `UsageLimitContinuation` carry the word in `reading`;
      // there is no `refusal` field (src/core/usage-limit-continuation.ts:168).
      const word = reading.reading;

      if (UNRESUMABLE_SILENT_READINGS.has(word)) {
        unresumableSilent.push(`${taskId} ${word}`);
        continue;
      }

      machineProgressable.push(`${taskId} (${record.state} / ${word})`);

      // `RESET_AHEAD` is the only reading that names an instant AO will wake on.
      // `MACHINE_MAY_STILL_RESUME` means the record does not refuse, but the
      // wake scan no longer offers the instant — the no-progress guard in the
      // wrapper is what keeps that from looping.
      if (word === 'RESET_AHEAD' && record.reportedResetAt) {
        const at = Date.parse(record.reportedResetAt);
        if (Number.isNaN(at)) die(`${taskId} has an unparseable reportedResetAt`);
        futureWakes.push({ at, iso: record.reportedResetAt });
      }
      continue;
    }

    // Any other silent state: an in-flight or terminal record the machine owns.
    machineProgressable.push(`${taskId} (${record.state})`);
  }
}

/**
 * Stale outbox items are reported, never acted on. AO removes an item when the
 * condition behind it is gone — but only for a repository it is still driving,
 * so items from de-enlisted repositories stay forever. Counting them would stop
 * a night for a repository nobody asked about.
 */
function staleOutboxNote() {
  if (!existsSync(ATTENTION_DIR)) return;
  const enlistedLower = new Set(roots.map((r) => r.toLowerCase()));
  let foreign = 0;
  for (const name of readdirSync(ATTENTION_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const item = JSON.parse(readFileSync(join(ATTENTION_DIR, name), 'utf8'));
      if (item.repositoryRoot && !enlistedLower.has(resolve(item.repositoryRoot).toLowerCase())) foreign += 1;
    } catch {
      // An unreadable item is not this classifier's business to repair.
    }
  }
  if (foreign > 0) notes.push(`${foreign} outbox item(s) belong to repositories no longer enlisted; ignored`);
}
staleOutboxNote();

// `reportedResetAt` is `z.iso.datetime({ offset: true })`, so a numeric offset is
// valid and a lexicographic sort would order two equal instants wrongly. Compare
// parsed time and print the instant as it was recorded.
futureWakes.sort((a, b) => a.at - b.at);
const futureWake = futureWakes.length > 0 ? futureWakes[0].iso : null;
const autoProgress = machineProgressable.length > 0 || futureWake !== null;

const digest = createHash('sha256').update(digestParts.join('|')).digest('hex');

console.log(`AUTO_PROGRESS_REMAINING = ${autoProgress ? 'yes' : 'no'}`);
console.log(`FUTURE_WAKE = ${futureWake ?? 'none'}`);
console.log(`OPERATOR_BLOCKERS = ${blockers.length > 0 ? blockers.join('; ') : 'none'}`);
console.log(`STATE_DIGEST = ${digest}`);
console.log(`MACHINE_PROGRESSABLE = ${machineProgressable.length > 0 ? machineProgressable.join('; ') : 'none'}`);
console.log(
  `UNRESUMABLE_NO_ITEM = ${unresumableSilent.length > 0 ? unresumableSilent.join('; ') : 'none'}`,
);
console.log(`JUDGED_AT = ${NOW}`);
for (const note of notes) console.log(`NOTE = ${note}`);

process.exit(autoProgress ? EXIT_AUTO_PROGRESS : EXIT_OPERATOR_ONLY);
