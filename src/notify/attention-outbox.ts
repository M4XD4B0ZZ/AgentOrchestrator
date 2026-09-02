/**
 * Finding what needs a person, and settling the outbox against it (M3-02).
 *
 * ── One function, and it is an idempotent reconciliation ───────────────────
 *
 * {@link settleAttention} reads every enlisted repository's durable task states,
 * derives the set of conditions that need an operator, and makes the store equal
 * that set: it creates what is missing and removes what has been resolved.
 * Running it twice over an unchanged disk does nothing the second time, and that
 * is the property the whole design rests on — a scheduler that wakes forty times
 * a day calls this forty times and an operator hears once.
 *
 * The two halves are deliberately asymmetric in their failure modes, because
 * their costs are:
 *
 *  - a **create** that does not happen is a person not told, so it is retried on
 *    the next pass for free — the condition is still in the record, so the next
 *    scan derives the same item and tries again;
 *  - a **removal** that does not happen is a stale item, which is noise rather
 *    than silence, and it is also retried on the next pass.
 *
 * Neither failure is allowed to reach the caller. This is called from a
 * scheduler loop whose answer about the repositories must not be rewritten by
 * the outbox; every refusal is counted and returned.
 *
 * ── Why the derivation reads only durable state ────────────────────────────
 *
 * `core/task-attention.ts` judges a `TaskState` and nothing else, and this scan
 * gives it nothing else. The consequence is the one Phase N asks for: a process
 * that reaches a human-action state and dies before recording anything loses
 * nothing, because the *next* process reads the same document and derives the
 * same item. An outbox fed by what a pass happened to observe could not have
 * that property — the observation dies with the observer.
 *
 * ── Removal is conservative, and the race is bounded ───────────────────────
 *
 * Only records this build wrote, whose id is not in the freshly derived set, are
 * removed. A file it cannot read is counted and left alone.
 *
 * Two processes settling concurrently can interleave badly in exactly one way: A
 * derives its set, B then finds a *new* condition and writes it, and A — whose
 * set predates it — removes it. Nothing is lost by that: the condition is still
 * in the durable record, so the next pass of either process derives it again and
 * writes it again. It costs a delayed notification, never a missing one, and the
 * alternative — a lock over a shared directory — would buy that at the cost of
 * the property that makes this store safe in the first place.
 */

import { readdirSync } from 'node:fs';

import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { attentionForTaskState } from '../core/task-attention.js';
import { compareTaskIds } from '../plan/task-id.js';
import {
  isStateFileName,
  TASK_STATE_FILE_EXTENSION,
  taskRuntimeDirectory,
} from '../state/state-location.js';
import { loadTaskState } from '../state/state-store.js';
import {
  listAttentionRecords,
  removeAttentionRecord,
  writeAttentionRecord,
  type AttentionRecord,
  type AttentionWriteCode,
} from './attention-store.js';
import { attentionIdFor } from './internal/attention-location.js';

/**
 * A repository this scan may look at.
 *
 * The declared id *and* the canonical root, because the store sits outside every
 * repository and a record has to be able to say which one it came from — and
 * because two clones declare one id and are two execution domains, so the root
 * is what identity is keyed on.
 */
export interface AttentionSubject {
  readonly repositoryId: string;
  readonly repositoryRoot: string;
}

/** Anything the scan could not read. Diagnostic; never a failure. */
export const ATTENTION_SCAN_NOTES = [
  /** A repository that has never run has no runtime directory. Ordinary. */
  'RUNTIME_DIRECTORY_ABSENT',
  /** It is there and would not be read. A condition in it is invisible here. */
  'RUNTIME_DIRECTORY_UNREADABLE',
  /** A state file this build cannot read back. Not necessarily a defect. */
  'STATE_UNREADABLE',
  /** More state files than this scan will read in one repository. */
  'SCAN_TRUNCATED',
] as const;

export type AttentionScanNote = (typeof ATTENTION_SCAN_NOTES)[number];

/**
 * The ceiling on state files read per repository.
 *
 * The same number `schedule/durable-wake.ts` applies, and for the same reason:
 * a runtime directory is machine-written and a scan of it must be bounded by
 * something other than hope. Deliberately the same constant value rather than an
 * import, because the two scans answer different questions and a shared bound
 * would make one of them the other's caller.
 */
export const MAX_SCANNED_STATE_FILES_PER_REPOSITORY = 1024;

/** One condition that needs a person, ready to be written down. */
export interface AttentionItem {
  readonly record: AttentionRecord;
}

export interface AttentionScan {
  /** Every open condition found, in a total order. */
  readonly items: readonly AttentionItem[];
  /**
   * The repository roots whose durable state this scan read **in full**, and the
   * only ones whose items may be settled by removal.
   *
   * The distinction is the whole reason this field exists. "I looked and found
   * nothing" and "I could not look" are different answers, and a store that
   * treated them alike would clear an operator's open items the moment a runtime
   * directory became unreadable — a transient permission error silently
   * dismissing a scope violation. A directory that is simply *absent* is the
   * first answer, not the second: no task state exists there, so no condition
   * stands.
   *
   * A repository is out of this set if its directory refused to be enumerated,
   * if any state file in it could not be read back, or if it holds more state
   * files than one scan reads. Conservative in every case: an item that should
   * have gone stays, which is noise, and noise is the direction to fail in.
   */
  readonly settled: readonly string[];
  readonly statesRead: number;
  readonly notes: readonly AttentionScanNote[];
}

/** INTERNAL seams. Production passes nothing; a test drives the two reads. */
export interface AttentionScanDependencies {
  readonly readDirectory?: (path: string) => readonly string[];
  readonly loadTaskState?: typeof loadTaskState;
}

function taskIdOf(fileName: string): string {
  return fileName.slice(0, fileName.length - TASK_STATE_FILE_EXTENSION.length);
}

/**
 * Ascending by repository root, then by task id. Total.
 *
 * Total for the reason `durable-wake.ts` gives about its own comparator: within
 * one repository the names are read in **file-name** order, which is not the
 * order of the ids they carry, and a report whose order came from the
 * filesystem is a report nobody can pin.
 */
function compareItems(a: AttentionItem, b: AttentionItem): number {
  if (a.record.repositoryRoot !== b.record.repositoryRoot) {
    return a.record.repositoryRoot < b.record.repositoryRoot ? -1 : 1;
  }
  return compareTaskIds(a.record.taskId, b.record.taskId);
}

/**
 * Reads every subject's durable task states and reports what needs a person.
 *
 * Never throws, writes nothing, takes no lease. `now` is read once by the caller
 * and applied to every record, so two tasks blocked on the same reset instant
 * cannot be judged against two different clocks in one scan.
 */
export function scanAttention(
  subjects: readonly AttentionSubject[],
  now: string,
  deps: AttentionScanDependencies = {},
): AttentionScan {
  const readDirectory =
    deps.readDirectory ?? ((path: string): readonly string[] => readdirSync(path));
  const load = deps.loadTaskState ?? loadTaskState;

  const notes = new Set<AttentionScanNote>();
  const items: AttentionItem[] = [];
  const settled: string[] = [];
  let statesRead = 0;

  for (const subject of subjects) {
    /** Whether this repository's durable state was read in full. See `settled`. */
    let complete = true;
    let names: readonly string[];
    try {
      names = readDirectory(taskRuntimeDirectory(subject.repositoryRoot));
    } catch (error: unknown) {
      const absent = safeErrnoCode(error) === 'ENOENT';
      notes.add(absent ? 'RUNTIME_DIRECTORY_ABSENT' : 'RUNTIME_DIRECTORY_UNREADABLE');
      // Absent is an answer — nothing has ever run there, so nothing stands.
      // Unreadable is not: it is "I could not look", and settling on it would
      // dismiss whatever is in there.
      if (absent) settled.push(subject.repositoryRoot);
      continue;
    }

    const stateFiles = [...names].filter(isStateFileName).sort();
    if (stateFiles.length > MAX_SCANNED_STATE_FILES_PER_REPOSITORY) {
      notes.add('SCAN_TRUNCATED');
      complete = false;
    }

    for (const fileName of stateFiles.slice(0, MAX_SCANNED_STATE_FILES_PER_REPOSITORY)) {
      const taskId = taskIdOf(fileName);
      const loaded = load(subject.repositoryRoot, taskId);
      if (!loaded.ok) {
        notes.add('STATE_UNREADABLE');
        complete = false;
        continue;
      }
      statesRead += 1;

      const judgement = attentionForTaskState(loaded.state, now);
      if (!judgement.attention) continue;

      const state = loaded.state;
      const attentionId = attentionIdFor({
        // The root the scan was pointed at, not the one the record claims. The
        // two agree for every record this build writes, and where they did not
        // the identity has to belong to the repository actually being scanned —
        // otherwise a copied state file would deduplicate against its original.
        repositoryRoot: subject.repositoryRoot,
        taskId: state.taskId,
        reason: judgement.reason,
        detail: judgement.detail,
        stateEnteredAt: state.stateEnteredAt,
      });

      items.push({
        record: Object.freeze({
          attentionVersion: 1 as const,
          attentionId,
          repositoryId: subject.repositoryId,
          repositoryRoot: subject.repositoryRoot,
          taskId: state.taskId,
          state: state.state,
          reason: judgement.reason,
          detail: judgement.detail,
          stateEnteredAt: state.stateEnteredAt,
          reportedResetAt: state.reportedResetAt,
          observedAt: now,
          action: judgement.action,
        }),
      });
    }

    if (complete) settled.push(subject.repositoryRoot);
  }

  items.sort(compareItems);

  return Object.freeze({
    items: Object.freeze(items),
    settled: Object.freeze(settled),
    statesRead,
    notes: Object.freeze([...notes].sort()),
  });
}

/** What one settle did. Counts and the records it newly wrote down. */
export interface AttentionSettlement {
  readonly scan: AttentionScan;
  /**
   * Records created by *this* call — the ones nobody had been told about.
   *
   * The trigger for anything louder than a file. An item that was already in the
   * store is not here, which is what makes repeated passes silent.
   */
  readonly raised: readonly AttentionRecord[];
  /** Items already in the store. The deduplication, counted. */
  readonly alreadyOpen: number;
  /** Records removed because their condition is gone. */
  readonly resolved: number;
  /** Items the store refused to write, by code. Neither raised nor lost. */
  readonly refusals: readonly AttentionWriteCode[];
  /** Records present that this build did not write, or could not read. */
  readonly foreign: number;
  /** `true` when the store root could not be enumerated at all. */
  readonly storeUnreadable: boolean;
}

export interface SettleAttentionDependencies extends AttentionScanDependencies {
  readonly pathProvider?: PathProvider;
  readonly writeRecord?: typeof writeAttentionRecord;
  readonly listRecords?: typeof listAttentionRecords;
  readonly removeRecord?: typeof removeAttentionRecord;
}

/**
 * Makes the outbox equal the set of conditions that currently need a person.
 *
 * Creates first, removes second, and that order is not arbitrary: a crash
 * between the two halves leaves an item that is open and one that is stale, and
 * of the two a stale item is the one an operator can see and dismiss. The
 * reverse order would have a window in which a real condition had been resolved
 * away and not yet re-raised.
 */
export function settleAttention(
  subjects: readonly AttentionSubject[],
  now: string,
  deps: SettleAttentionDependencies = {},
): AttentionSettlement {
  const provider = deps.pathProvider ?? OS_PATH_PROVIDER;
  const write = deps.writeRecord ?? writeAttentionRecord;
  const list = deps.listRecords ?? listAttentionRecords;
  const remove = deps.removeRecord ?? removeAttentionRecord;

  const scanDeps: AttentionScanDependencies = {
    ...(deps.readDirectory === undefined ? {} : { readDirectory: deps.readDirectory }),
    ...(deps.loadTaskState === undefined ? {} : { loadTaskState: deps.loadTaskState }),
  };
  const scan = scanAttention(subjects, now, scanDeps);

  const raised: AttentionRecord[] = [];
  const refusals: AttentionWriteCode[] = [];
  let alreadyOpen = 0;

  for (const item of scan.items) {
    const outcome = write(item.record, provider);
    if (outcome.code === 'RECORDED') raised.push(item.record);
    else if (outcome.code === 'ALREADY_RECORDED') alreadyOpen += 1;
    else refusals.push(outcome.code);
  }

  const open = new Set(scan.items.map((item) => item.record.attentionId));
  const listing = list(provider);
  let resolved = 0;

  // Removal is scoped to the repositories this call read **in full**, which is
  // narrower than the ones it was asked about and narrower again than the ones
  // it looked at. Two different mistakes are excluded by the same set:
  //
  //  - a record for a repository nobody looked at is *unexamined*, and a
  //    scheduler run over half an operator's registry must not empty the other
  //    half's inbox;
  //  - a record for a repository whose durable state could not be read is
  //    *unknown*, and "I could not look" must never resolve as "nothing is
  //    there". A transient permission error would otherwise dismiss a scope
  //    violation, silently, and re-raise it only once the directory came back.
  const scanned = new Set(scan.settled);

  for (const record of listing.records) {
    if (open.has(record.attentionId)) continue;
    if (!scanned.has(record.repositoryRoot)) continue;
    if (remove(record.attentionId, provider) === 'REMOVED') resolved += 1;
  }

  return Object.freeze({
    scan,
    raised: Object.freeze(raised),
    alreadyOpen,
    resolved,
    refusals: Object.freeze(refusals),
    foreign: listing.foreignNames + listing.unreadable,
    storeUnreadable: listing.unreadableRoot,
  });
}
