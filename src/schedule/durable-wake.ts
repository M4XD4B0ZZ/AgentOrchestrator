/**
 * The durable wake horizon: when, if ever, does parked work become runnable
 * again (M3-01).
 *
 * ── What this module is, in one sentence ───────────────────────────────────
 *
 * A **read** over the task-state store that answers one question — "what is the
 * earliest instant, strictly in the future, at which some enlisted repository's
 * durable record says a quota pause ends?" — and answers it from bytes on disk,
 * holding no lease, starting no process and writing nothing.
 *
 * ── Why there is no second persisted queue ─────────────────────────────────
 *
 * The information a scheduler needs to reconstruct a wait after a restart
 * already exists durably, in exactly one place: `TaskState.reportedResetAt` of a
 * task recorded as `BLOCKED_USAGE_LIMIT`, at
 * `<repository root>/.agent-orchestrator/runtime/<taskId>.json`. A separate
 * "due-date index" would be a second answer to a question the task state already
 * answers, and the two would be free to disagree — the failure this build has
 * paid for before, where a gate proves one document and the effect lands against
 * another. So this module indexes nothing and caches nothing: every call is a
 * fresh read, and the state store stays the single authority.
 *
 * What is added is the one capability the store deliberately does not have.
 * `state-store.ts` never enumerates the runtime directory — `loadTaskState`
 * takes a task id — so nothing in this build could ask "which tasks are
 * waiting?" without already knowing their names. That enumeration is here,
 * bounded and fail-closed, and it is the whole of this module's novelty.
 *
 * ── Strictly in the future, and why that word is load-bearing ──────────────
 *
 * A wake instant is reported only when it is **strictly greater** than the
 * caller's `now`. An instant that has already passed is not a wake: the
 * scheduler's own coordinator pass has just run and had its chance to act on it,
 * and reporting it would produce a sleep of zero followed by a pass that admits
 * the same nothing — a hot loop dressed as a schedule. Requiring the future
 * makes every cycle advance the clock past at least one recorded instant, which
 * is what bounds the loop.
 *
 * ── Fail-closed means "do not schedule a wake" ─────────────────────────────
 *
 * Every uncertainty here resolves to *fewer* wakes, never more: a runtime
 * directory that cannot be read, a state file this build cannot parse, a reset
 * time `Date.parse` will not take, a clock reading that is not a timestamp —
 * each contributes no wake and is reported as a note. The cost of that direction
 * is a scheduler that stops early and tells an operator why. The cost of the
 * other direction would be a scheduler that sleeps on a value it does not
 * understand.
 *
 * ── What this module does NOT decide ───────────────────────────────────────
 *
 * Whether the task may then resume. That is `evaluateAutomaticResume`'s, and it
 * is re-run from a fresh clock inside the ordinary lifecycle after the wake.
 * This module produces a *time to look again*, never a permission — so a wake
 * that turns out to lead nowhere costs one planning pass and nothing else.
 */

import { readdirSync } from 'node:fs';

import { isStateFileName, taskRuntimeDirectory, TASK_STATE_FILE_EXTENSION } from '../state/state-location.js';
import { loadTaskState } from '../state/state-store.js';

/**
 * The most state files this build will read from one repository's runtime
 * directory in a single scan.
 *
 * A bound rather than a limit anybody should meet: it exists because
 * `readdirSync` on an unbounded directory is an unbounded allocation, and a
 * scheduler that must survive a hostile or damaged runtime directory may not
 * have that as its failure mode. Names are sorted before the cut, so truncation
 * is deterministic rather than filesystem-order dependent, and a truncated scan
 * says so — its consequence is a wake later than it needed to be, never a wake
 * earlier than the record allows.
 */
export const MAX_SCANNED_STATE_FILES_PER_REPOSITORY = 1024;

/** One durable "this task is waiting until X", read from disk. */
export interface DurableWake {
  /** Canonical repository root, exactly as the caller supplied it. */
  readonly repositoryRoot: string;
  readonly taskId: string;
  /** The instant exactly as the durable record spells it. Never reformatted. */
  readonly resetAt: string;
  /** `Date.parse(resetAt)`. Finite by construction — a wake with a value this build could not parse is not produced. */
  readonly resetAtMs: number;
}

/**
 * Everything a scan could not establish. A closed vocabulary, carrying no text
 * from any file it read.
 *
 * These are **notes**, not failures: a scan that produced them still produced a
 * usable answer about every repository it could read. They exist so that "no
 * wake was found" and "no wake could be looked for" are never the same sentence
 * to an operator.
 */
export const WAKE_SCAN_NOTES = [
  /** The caller's clock did not produce a timestamp. Nothing was scanned. */
  'CURRENT_TIME_UNPARSEABLE',
  /** A repository has no runtime directory at all. Ordinary: nothing has run there yet. */
  'RUNTIME_DIRECTORY_ABSENT',
  /** A runtime directory exists and could not be enumerated. */
  'RUNTIME_DIRECTORY_UNREADABLE',
  /** A state file exists and this build could not read it as a task state. */
  'STATE_UNREADABLE',
  /** A recorded reset time is not a timestamp this build can read. */
  'RESET_TIME_UNPARSEABLE',
  /** One repository held more state files than {@link MAX_SCANNED_STATE_FILES_PER_REPOSITORY}. */
  'SCAN_TRUNCATED',
] as const;

export type WakeScanNote = (typeof WAKE_SCAN_NOTES)[number];

export interface WakeScan {
  /**
   * The soonest future wake across every repository scanned, or `null`.
   *
   * `null` means exactly "no enlisted repository's durable state names an
   * instant still ahead of us" — including the case where every recorded reset
   * has already passed, and the case where every quota block records none.
   */
  readonly earliest: DurableWake | null;
  /** Every future wake found, ascending by instant then repository then task. Total order. */
  readonly future: readonly DurableWake[];
  /** How many state files were successfully read. Diagnostic. */
  readonly statesRead: number;
  /** Sorted, de-duplicated {@link WAKE_SCAN_NOTES}. Empty when nothing was in doubt. */
  readonly notes: readonly WakeScanNote[];
}

/** INTERNAL seams. Production passes nothing; a test drives the two reads. */
export interface WakeScanDependencies {
  /** Enumerates one directory. Throws exactly as `readdirSync` does. */
  readonly readDirectory?: (path: string) => readonly string[];
  readonly loadTaskState?: typeof loadTaskState;
}

/** The task id a state file name denotes. The name has already passed `isStateFileName`. */
function taskIdOf(fileName: string): string {
  return fileName.slice(0, fileName.length - TASK_STATE_FILE_EXTENSION.length);
}

/**
 * Ascending by instant, then by repository root, then by task id.
 *
 * Total, and total on purpose: two repositories can legitimately record the
 * same reset instant — one provider, one window, two tasks — and a scan whose
 * `earliest` depended on directory order would name a different task on two
 * reads of one unchanged disk. The instant is what the sleep is computed from,
 * so a tie changes nothing about *when* the scheduler wakes; it changes what the
 * report says it woke for, and a report that varies is a report nobody can pin.
 */
function compareWakes(a: DurableWake, b: DurableWake): number {
  if (a.resetAtMs !== b.resetAtMs) return a.resetAtMs - b.resetAtMs;
  if (a.repositoryRoot !== b.repositoryRoot) return a.repositoryRoot < b.repositoryRoot ? -1 : 1;
  if (a.taskId !== b.taskId) return a.taskId < b.taskId ? -1 : 1;
  return 0;
}

/**
 * Reads every enlisted repository's durable task states and reports the wake
 * horizon at `nowIso`.
 *
 * Never throws for an expected condition — an unreadable directory, an
 * unparseable state, a clock that answered nonsense all arrive as notes. Writes
 * nothing, on any path.
 */
export function scanDurableWakes(
  repositoryRoots: readonly string[],
  nowIso: string,
  deps: WakeScanDependencies = {},
): WakeScan {
  const readDirectory = deps.readDirectory ?? ((path: string): readonly string[] => readdirSync(path));
  const load = deps.loadTaskState ?? loadTaskState;

  const notes = new Set<WakeScanNote>();

  // The clock first, and a refusal before any I/O. A scan whose "now" is not a
  // timestamp cannot decide what is in the future, and every wake it produced
  // would be a comparison against `NaN` — which is `false` in both directions,
  // so the arm below would silently return nothing while looking like it had
  // looked. Refusing here says so.
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    return Object.freeze({
      earliest: null,
      future: Object.freeze([]),
      statesRead: 0,
      notes: Object.freeze(['CURRENT_TIME_UNPARSEABLE' as const]),
    });
  }

  const future: DurableWake[] = [];
  let statesRead = 0;

  for (const repositoryRoot of repositoryRoots) {
    let names: readonly string[];
    try {
      names = readDirectory(taskRuntimeDirectory(repositoryRoot));
    } catch (error: unknown) {
      // A repository that has never run has no runtime directory, and that is
      // the ordinary case rather than a problem. Anything else is a directory
      // that exists and would not be read, which is worth telling an operator:
      // a wake recorded in there is invisible to this scan.
      notes.add(
        (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
          ? 'RUNTIME_DIRECTORY_ABSENT'
          : 'RUNTIME_DIRECTORY_UNREADABLE',
      );
      continue;
    }

    // Sorted before the cut so that truncation is a property of the names and
    // not of the filesystem's enumeration order.
    const stateFiles = [...names].filter(isStateFileName).sort();
    if (stateFiles.length > MAX_SCANNED_STATE_FILES_PER_REPOSITORY) notes.add('SCAN_TRUNCATED');
    const considered = stateFiles.slice(0, MAX_SCANNED_STATE_FILES_PER_REPOSITORY);

    for (const fileName of considered) {
      const taskId = taskIdOf(fileName);
      const loaded = load(repositoryRoot, taskId);
      if (!loaded.ok) {
        // A state this build cannot read is not a wake. It is also not
        // necessarily a defect — an older or newer document meets a `.strict()`
        // boundary and refuses — so the scan continues and reports the note.
        notes.add('STATE_UNREADABLE');
        continue;
      }
      statesRead += 1;

      const state = loaded.state;
      if (state.state !== 'BLOCKED_USAGE_LIMIT') continue;

      // A block recording no reset has no machine-understandable wake, by
      // contract. It is the operator's, through `--continue-usage-limit`, and
      // inventing an interval here would be this module deciding the one thing
      // the product says nothing may decide.
      const resetAt = state.reportedResetAt;
      if (resetAt === null) continue;

      const resetAtMs = Date.parse(resetAt);
      if (!Number.isFinite(resetAtMs)) {
        notes.add('RESET_TIME_UNPARSEABLE');
        continue;
      }

      // Strictly in the future. See the module header: an instant that has
      // already passed is not a wake, because the pass that just ran has
      // already had its chance to act on it.
      if (resetAtMs <= nowMs) continue;

      future.push(
        Object.freeze({
          repositoryRoot,
          taskId,
          resetAt,
          resetAtMs,
        }),
      );
    }
  }

  future.sort(compareWakes);

  return Object.freeze({
    earliest: future[0] ?? null,
    future: Object.freeze([...future]),
    statesRead,
    notes: Object.freeze([...notes].sort()),
  });
}
