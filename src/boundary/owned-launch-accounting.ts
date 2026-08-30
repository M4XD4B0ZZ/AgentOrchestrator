/**
 * Where an owned launch is announced, and to whom. A registry, and nothing else.
 *
 * ── The problem this shape solves ──────────────────────────────────────────
 *
 * `doctor/exec.ts` is the single execution abstraction: every process this
 * product starts passes through `runCommand`, and `tests/v2-07l-execution-lease.test.ts`
 * pins that structurally — exactly two modules import `node:child_process`,
 * exactly one imports `start-owned-process.js`, exactly one imports
 * `owned-command.js`. So there is one place that sees every owned launch.
 *
 * It is also the place that must not know what a lease is. Its own header says
 * so, and the reason is not tidiness: a module that starts processes and also
 * decides who may start them is a module where authority and mechanism have
 * been merged.
 *
 * The lease layer has the opposite problem. It knows exactly which epoch a
 * launch belongs to and cannot see the launches, because the modules that start
 * them — `worktree/git-command.ts`, `verify/verify-command.ts`,
 * `agent/agent-command.ts`, and the unfenced Git probes in `loop/loop-step.ts`,
 * `run/run-driver.ts`, `run/start-task.ts`, `block/block-runner.ts` — do not
 * carry lease evidence and cannot be given it without widening every runner
 * signature between them.
 *
 * ── Why threading it was rejected, measured rather than assumed ────────────
 *
 * The alternative considered first was a required accounting argument on
 * `RunOptions`, so that every call site had to declare. It is compile-visible,
 * which is the property to want, and it does not work here: an inventory of
 * this build's spawn sites found that most of the ones running under a lease
 * reach `runCommand` from code that holds no evidence. Every one of those would
 * have declared itself unaccounted — a hole by declaration, which is a
 * documented hole rather than a closed one.
 *
 * So the fact travels the other way. The boundary layer *announces*, in a
 * vocabulary with no lease in it; whoever holds an epoch *subscribes*. This
 * module is that seam and holds no policy at all.
 *
 * ── What an accountant may do, and the one thing it may decide ─────────────
 *
 * {@link OwnedLaunchAccountant.open} is called **before anything is created**,
 * and its answer can stop the launch. That is the whole reason it exists: a
 * record written after a launch cannot describe a launch that was killed, so
 * the record has to come first, and a record that could not be written has to be
 * able to say so. Everything after it — {@link OwnedLaunchRecord.established}
 * and {@link OwnedLaunchRecord.ended} — is told, never asked.
 *
 * ── Module-level state, and why that is the honest shape here ──────────────
 *
 * This is a process-wide registry, which is not a thing to reach for lightly.
 * It has precedent in this build — `core/internal/containment-attestation.ts`
 * keeps a module-level `WeakSet` of everything it minted, for the same reason:
 * the fact has to be true of the *process*, not of an argument somebody
 * remembered to pass.
 *
 * Three properties keep it bounded:
 *
 *  - **an installation is a disposal.** {@link installOwnedLaunchAccountant}
 *    hands back the only function that removes it, so a caller that keeps the
 *    handle can always undo it and a caller that loses it cannot remove
 *    somebody else's;
 *  - **an accountant evicts itself.** An accountant whose epoch has ended
 *    answers {@link OwnedLaunchOpening.EPOCH_ENDED} and is dropped, so a
 *    process that acquires many leases over its life does not accumulate
 *    subscribers to leases it no longer holds;
 *  - **an empty registry changes nothing.** With no accountant installed — the
 *    ordinary state of `agent-loop doctor`, of `resolveRepository` before a
 *    lease exists, and of every process that never takes one — `openOwnedLaunch`
 *    answers no records and no refusal, and the launch proceeds exactly as it
 *    did before this module existed. This bullet said "nothing here fails a
 *    launch by itself", which stopped being true when a throwing accountant
 *    became a refusal rather than an eviction.
 */

import type { ContainmentAttestation } from '../core/containment-attestation.js';

/**
 * What an accountant answered when asked to record a launch about to happen.
 *
 * A closed set of three, of which exactly one stops the launch.
 */
export type OwnedLaunchOpening =
  /** The launch is recorded. It may proceed, and its record must be closed. */
  | { readonly opening: 'RECORDED'; readonly record: OwnedLaunchRecord }
  /**
   * Nothing was recorded, and nothing needs to be: this accountant's epoch is
   * over — the lease it belongs to was released, lost, or taken by somebody
   * else.
   *
   * The launch proceeds. It is **not** unaccounted-for work under a live epoch:
   * the epoch is gone, so there is no document a later recovery would read this
   * launch out of, and there is no lease left for that recovery to remove. A
   * run that has lost its lease is stopped by the gates that exist for that —
   * `loop/leased-spawns.ts`'s `leaseHolds`, and `advanceTaskState` after it —
   * and stopping it here as well would put a lease decision in the layer that
   * has no authority to make one.
   *
   * The accountant is dropped from the registry when it answers this.
   */
  | { readonly opening: 'EPOCH_ENDED' }
  /**
   * The launch could not be recorded and the accountant could not make what is
   * on disk say nothing either. **Nothing may be started.**
   *
   * The one answer that stops a launch, and the only one. `doctor/exec.ts`
   * turns it into a result that never ran.
   */
  | { readonly opening: 'LAUNCH_MUST_NOT_START'; readonly detail: string | null };

/** One launch's record, from the moment it is opened until it is closed. */
export interface OwnedLaunchRecord {
  /**
   * The kernel confirmed this launch's job membership.
   *
   * Called at most once, with the boundary's own attestation. Told, not asked:
   * an accountant that cannot write this leaves the launch recorded in its
   * weaker state, which refuses a recovery rather than permitting one, so there
   * is nothing here for a caller to decide.
   */
  readonly established: (attestation: ContainmentAttestation) => void;
  /**
   * The launch is over, however it ended.
   *
   * Called exactly once for every {@link OwnedLaunchOpening} that recorded, on
   * every path including a throw. Told, not asked, for the same reason: a
   * failed close leaves the launch recorded as open, which over-refuses and
   * never permits.
   */
  readonly ended: () => void;
}

/**
 * Something that records the owned launches of one epoch.
 *
 * Deliberately not called a "lease accountant". Nothing in this file knows what
 * a lease is, and the moment it did, `doctor/exec.ts` would import a module that
 * does.
 */
export interface OwnedLaunchAccountant {
  /** Called before anything is created. See {@link OwnedLaunchOpening}. */
  readonly open: () => OwnedLaunchOpening;
}

/**
 * The installed accountants, in installation order.
 *
 * An array rather than a single slot, and the reason is a hazard rather than a
 * feature: nothing in this build holds two leases in one process, and a
 * single-slot registry would have to *choose* between two if it ever happened —
 * silently accounting a launch to one epoch and not the other. Recording it to
 * both is the conservative answer, so the shape that can hold both is the one to
 * have.
 */
const INSTALLED: OwnedLaunchAccountant[] = [];

/**
 * Registers `accountant` and answers the function that removes it.
 *
 * The handle is the only way to remove it, and it removes exactly the one it
 * was made for — by identity, never by position, because an array index means a
 * different accountant the moment somebody else's disposal has run.
 *
 * Idempotent: calling the returned function twice removes nothing the second
 * time.
 */
export function installOwnedLaunchAccountant(accountant: OwnedLaunchAccountant): () => void {
  INSTALLED.push(accountant);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    evict(accountant);
  };
}

function evict(accountant: OwnedLaunchAccountant): void {
  const index = INSTALLED.indexOf(accountant);
  if (index >= 0) INSTALLED.splice(index, 1);
}

/**
 * Announces a launch to every installed accountant, before anything is created.
 *
 * Answers `null` when the launch may proceed — which is the answer when nothing
 * is installed — and a detail string when it must not.
 *
 * ── The failure path closes what it opened ────────────────────────────────
 *
 * If a later accountant refuses, the records already opened are closed before
 * this returns. Without that, a refused launch would leave open slots in the
 * epochs that *did* record it, and each of those would refuse a recovery
 * forever for a process that never existed. Conservative, but wrong: the point
 * of the record is to describe launches, and no launch happened.
 *
 * ── Never throws, and a throw is a refusal ────────────────────────────────
 *
 * An accountant is somebody else's code. A throw out of it here would escape
 * `runCommand`, whose contract is that a failing command is data. So every call
 * is guarded — and the guard answers {@link OwnedLaunchOpening.LAUNCH_MUST_NOT_START}.
 *
 * It answered `EPOCH_ENDED` once, on the reasoning that a throwing accountant
 * "cannot make a launch happen that this module would otherwise have refused,
 * because refusal is the only thing it could have said". That is false, and a
 * fault-injection test in `tests/v3-07-lease-release-fault.test.ts` reached it:
 * a throw makes a launch happen that would otherwise have been **recorded**,
 * and `EPOCH_ENDED` additionally drops the accountant, so every later launch in
 * the process goes unrecorded too. An unknown is not an ended epoch. It refuses.
 */
export function openOwnedLaunch(): {
  readonly refusal: string | null;
  readonly records: readonly OwnedLaunchRecord[];
} {
  const records: OwnedLaunchRecord[] = [];
  // A copy, taken before the loop: an accountant that evicts itself while this
  // is running would otherwise shorten the array being iterated and skip its
  // neighbour.
  for (const accountant of [...INSTALLED]) {
    let opening: OwnedLaunchOpening;
    try {
      opening = accountant.open();
    } catch {
      // Not evicted, and not waved through. Nothing is known about this epoch
      // except that asking failed, and the launch that would have gone
      // unrecorded is exactly the one a later recovery has to know about.
      for (const record of records) closeOwnedLaunch(record);
      return { refusal: 'ACCOUNTANT_THREW', records: [] };
    }
    if (opening.opening === 'RECORDED') {
      records.push(opening.record);
      continue;
    }
    if (opening.opening === 'EPOCH_ENDED') {
      evict(accountant);
      continue;
    }
    for (const record of records) closeOwnedLaunch(record);
    return { refusal: opening.detail ?? 'LAUNCH_MUST_NOT_START', records: [] };
  }
  return { refusal: null, records };
}

/** Tells one record its launch was placed in the owner's job. Never throws. */
export function establishOwnedLaunch(
  record: OwnedLaunchRecord,
  attestation: ContainmentAttestation,
): void {
  try {
    record.established(attestation);
  } catch {
    /* Somebody else's code. A record that could not be strengthened stays weak,
       and weak refuses. There is nothing to report and nothing to do. */
  }
}

/** Tells one record its launch is over. Never throws, for the same reason. */
export function closeOwnedLaunch(record: OwnedLaunchRecord): void {
  try {
    record.ended();
  } catch {
    /* A record left open over-refuses a later recovery and never permits it. */
  }
}

/**
 * How many accountants are installed. For tests and for `doctor`, never for a
 * decision.
 *
 * Exported so a test can prove an install and a disposal really happened,
 * which is the only way to kill a mutant that drops either. It answers a
 * count and not the accountants themselves: handing those out would let a
 * caller record launches into somebody else's epoch.
 */
export function installedOwnedLaunchAccountants(): number {
  return INSTALLED.length;
}
