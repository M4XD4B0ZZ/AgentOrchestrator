/**
 * What is at a repository's lease path, judged for recovery. Diagnosis only.
 *
 * ── This module removes nothing, and that is the whole design ──────────────
 *
 * `acquireRepositoryExecutionLease` never takes over a lease it did not create.
 * That is measured rather than assumed — `execution-lease.ts` sets out why a dead
 * owner proves nothing about the agent processes it started — and it leaves
 * exactly one gap: the first crash makes a repository unrunnable until somebody
 * clears a file inside `.git` by hand.
 *
 * An attended `lease break` existed for that gap **twice**, and has been
 * withdrawn twice. It is not here, and this file exists to say what is, so that
 * the next person to want it starts from the reason rather than from the idea.
 *
 * ── Why the break cannot be written against this identity model ────────────
 *
 * A break has to name *one object* and still be acting on that same object after
 * the window between the operator reading a report and the removal happening.
 * The facts available to name it are the record's digest, the owner pid it
 * records, and the filesystem's object identity. For the one class of lease that
 * most needs recovering — the **zero-byte crash artefact**, left when a process
 * dies between taking the name and writing its record — all three collapse at
 * once:
 *
 *   - the digest is `sha256("")`, a constant every empty file in existence
 *     shares, so it distinguishes nothing;
 *   - the record names no owner, so the pid cross-check compares `null` with
 *     `null` and the liveness re-check is skipped entirely;
 *   - the object identity is a `(dev,ino)` pair, and `execution-lease.ts`'s
 *     acquire path shipped fallbacks for filesystems that reuse those promptly.
 *     (That fallback has since been withdrawn too, and a lease now exists only
 *     where hard links work — but the break was already gone by then, and it is
 *     the *collapse of all three facts at once* that is the reason, not any one
 *     of them being repairable.)
 *
 * A sixth independent review reproduced the consequence end to end: an
 * authorisation minted for artefact A removed a **legitimately acquired** lease B
 * that had taken the same name and the same reused index. Closing that needs an
 * atomic compare-and-delete on a directory entry, which `removeVerifiedLease`
 * already records that no portable filesystem primitive offers. Four consecutive
 * review rounds each strengthened the predicate and each was broken by the next
 * round on the same surface. A contract that requires a primitive which does not
 * exist is not repaired by asking harder.
 *
 * So: **no break, no `--force`, no environment variable, no API back door.** The
 * operation described above does not exist in this build and is not coming back.
 *
 * ── V3 slice 5 ships a recovery, and it is not that operation ──────────────
 *
 * `recoverStaleLease`, in `execution-lease.ts`, removes a stale lease. Read the
 * paragraph above before concluding the withdrawal was reversed, because the two
 * differ where the withdrawal happened rather than in how carefully they are
 * written:
 *
 *  - **the break's hardest case is still refused.** The zero-byte crash artefact
 *    has no nonce, so there is nothing to bind a removal to; the new predicate
 *    requires a *parsed* lease document and refuses that artefact as
 *    `LEASE_UNPARSEABLE`, permanently. Slice 5 recovers the case it can prove and
 *    declines the case that defeated six reviews, rather than covering both with
 *    one authorisation;
 *  - **nothing is minted, shown, and acted on later.** The break's authority was
 *    a token an operator carried across a window. The new one has no window: the
 *    predicate is evaluated inside the call that removes, and no caller can
 *    supply a verdict — there is no parameter for one;
 *  - **and there is a fact the break never had.** Owned process containment,
 *    plus a per-launch history that is poisoned before each writer starts, makes
 *    "no writer of this lease can still be running" provable instead of hoped
 *    for. That is what was missing in V2, and it is why the answer changed.
 *
 * ── What this module does ──────────────────────────────────────────────────
 *
 * The truth about the lease path, stated precisely: what is there, and whether it
 * can be proved removable. {@link assessLeaseRecovery} classifies and reports; it
 * authorises nothing, because a report is not what the removal acts on — see
 * {@link LeaseRecoveryAssessment.staleRecovery}.
 *
 * ── Where liveness may permit, and why that is safe here ───────────────────
 *
 * The rule everywhere else in this build is that **liveness may refuse and may
 * never permit**, and it is worth saying plainly that this module is the
 * exception rather than leaving the slogan standing. `processAlive` *substitutes*
 * for the real probe here, so a supplied one can flip
 * {@link LeaseRecoveryAssessment.staleRecovery} from `UNSAFE` to
 * `SAFE_TO_RECOVER` for a lease whose owner is running perfectly well.
 *
 * That is safe for exactly one reason, and it is a reason about consumers rather
 * than about this module: **nothing destructive reads this value.**
 * `recoverStaleLease` makes its own assessment, always consults the real probe,
 * and accepts only an opinion that can refuse — a review reproduced the version
 * that did not, removing a living owner's lease in one call. So the worst a
 * fabricated probe achieves here is a misleading report, to the caller that
 * fabricated it.
 *
 * `tests/v3-05-stale-lease-recovery.test.ts` pins that asymmetry by measuring
 * both halves in one case rather than asserting it.
 */

import {
  isReliableContainment,
  type ContainmentReading,
} from './containment-evidence.js';
import {
  assessStaleLeaseRecovery,
  inspectRepositoryExecutionLease,
  snapshotRepositoryRecord,
  type LeaseInspection,
  type LeaseRepository,
  type ProcessLivenessProbe,
  type StaleLeaseRecoveryAssessment,
} from './execution-lease.js';

/**
 * The seam this module takes: the liveness probe, and nothing else.
 *
 * `acquire` takes three — its clock, this probe, and the `link` that publishes
 * the record. This comment claimed it took "the same one, and the only one"
 * `acquire` takes, which was false on both halves.
 */
export interface LeaseRecoveryDependencies {
  readonly processAlive?: ProcessLivenessProbe;
}

/* ─────────────────────────── classification ─────────────────────────────── */

/**
 * What is at the lease path, judged for recovery. A closed set.
 *
 * A *report*, and nothing else takes one of these as an argument — there is no
 * longer anything in the build that could. The previous break failed precisely
 * because a judgement made at one moment was carried to a later effect; the
 * shape is kept because it was right, not because something still depends on it.
 */
export const LEASE_RECOVERY_CLASSIFICATIONS = [
  /** Nothing is there. Nothing to recover. */
  'NOTHING_TO_RECOVER',
  /** A lease is there and a process with its recorded id exists. */
  'OWNER_RUNNING',
  /** A lease is there and whether its owner exists could not be established. */
  'OWNER_LIVENESS_UNDETERMINED',
  /** A lease is there and no process with its recorded id exists. */
  'STALE_OWNER_GONE',
  /**
   * Something is there, it is not a lease this build can read, and it names no
   * process at all.
   *
   * The artefact a crash between the exclusive create and the record write
   * leaves behind. There is no owner to ask about and no content to identify it
   * by — which is exactly why the break that tried to remove it by content was
   * withdrawn. See this module's header.
   */
  'NO_OWNER_RECORDED',
  /** Something is there and could not be read at all. */
  'LEASE_UNREADABLE',
  /** No lease path can be derived for this repository. */
  'LOCATION_UNSUITABLE',
  /**
   * The Git common directory is on a UNC/network path, which V2 does not
   * support.
   *
   * Its own member rather than folded into {@link LOCATION_UNSUITABLE}: a
   * location *was* derived, and that classification's sentence says one
   * could not be. Repeating that misdescription here — one module over from
   * where V2-07P removed it — would report the crash-window artefact's
   * classification, `NO_OWNER_RECORDED`, for a repository where nothing was
   * ever created, which is worse still.
   */
  'LOCATION_NETWORK_UNSUPPORTED',
  /**
   * The Git common directory is a Windows device path (`\\.\...`).
   *
   * Kept apart from the network member for the same reason
   * `execution-lease.ts` keeps the two codes apart: a device path is not
   * network storage.
   */
  'LOCATION_DEVICE_NAMESPACE',
] as const;

export type LeaseRecoveryClassification = (typeof LEASE_RECOVERY_CLASSIFICATIONS)[number];

export interface LeaseRecoveryAssessment {
  readonly classification: LeaseRecoveryClassification;
  readonly inspection: LeaseInspection;
  /**
   * Whether the **most recent recorded launch** under this lease was contained.
   *
   * Named for exactly what is checked, which took two corrections to get right.
   * It was `containmentProven` — a property of the lease, which this record
   * cannot claim — and then `latestWriterContained`, which was still one notch
   * strong: this read path passes no {@link ContainmentExpectation}, so the
   * record's `writerId` is *recorded and bound but not judged here*, and a
   * record naming some other agent would have satisfied a field with `Writer` in
   * its name. Production cannot produce one (`loop/leased-spawns.ts` records for
   * the writer and nothing else), and a field's name is a contract regardless of
   * who can reach it.
   *
   * The record describes one launch; `lease/containment-evidence.ts` sets out
   * what that does and does not license, and why an earlier launch under the
   * same lease may have been uncontained even when this is `true`.
   *
   * Reported beside the classification and deliberately **not** an input to it.
   * {@link classifyForRecovery} takes two fields of the inspection and cannot
   * see this one, and a test pins that every classification is the same value
   * with and without a record present: this slice teaches the assessment to
   * *see* containment and nothing more.
   *
   * The reason for the separation is the one `execution-lease.ts` records at
   * length. A dead owner does not prove no writer survives it, and containment
   * is what could change that — but changing it is a decision about removing
   * somebody else's lease, which is a product-contract change and needs its own
   * slice. Wiring the field into the answer here would make that decision by
   * accident, which is exactly how `--permission-mode` was decided in V1.
   *
   * `false` for every lease with no reliable reading, including one with none at
   * all: absence of a proof, never a proof of absence.
   */
  readonly latestLaunchContained: boolean;
  /** The reading itself, for a report. `null` when no document was parsed. */
  readonly containment: ContainmentReading | null;
  /**
   * Whether this lease can be proved removable, and if not, which conjunct of
   * the safety predicate refused — as judged with **this call's** liveness probe,
   * which a caller may substitute. See this module's header: a supplied probe can
   * make this field say `SAFE_TO_RECOVER` about a running owner, and nothing
   * destructive reads it.
   *
   * ── Why this is beside the classification and not inside it ────────────────
   *
   * {@link classification} describes *what is at the path*; this decides *what
   * may be done about it*. Folding the second into the first would give one
   * value two jobs, and the job it would silently acquire is authorising a
   * removal — which is exactly how `latestLaunchContained` was kept out of the
   * classifier one field up, and for the same reason.
   *
   * ── It is a report, and a report is not what a removal acts on ────────────
   *
   * `recoverStaleLease` takes no assessment. It makes its own, inside the same
   * call that removes the lease, because this one can be minutes old by the time
   * an operator reads it and this module has already paid once for a judgement
   * carried to a later effect. What is here answers "is there something to do";
   * what the removal acts on is what is on disk at the instant it runs.
   *
   * ── And it costs a second liveness probe ──────────────────────────────────
   *
   * Stated rather than hidden: {@link assessLeaseRecovery} now probes the owner
   * twice — once for the inspection above, once inside the predicate. The two
   * are separate readings on purpose. Sharing one answer would mean the
   * predicate trusted a liveness result taken by somebody else at some other
   * moment, which is the shape it exists to refuse.
   */
  readonly staleRecovery: StaleLeaseRecoveryAssessment;
}

/**
 * Classifies what is at the lease path. Reads; changes nothing; never throws
 * for any `LeaseInspection` this build produces.
 *
 * That qualifier is new and is precision, not hedging: `classifyForRecovery`
 * below closes its switch on `inspection.state` with a `never` exhaustiveness
 * check, and the branch behind it throws rather than silently returning a
 * classification for a state it does not name. Provably dead code today,
 * because every member `inspectRepositoryExecutionLease` can produce has a
 * case above it — and that is exactly what keeps it dead: it is a compile
 * failure waiting on the next unhandled `LEASE_STATES` member, not a runtime
 * path this build can reach.
 *
 * There is deliberately no `breakable` here any more. It existed so `lease
 * status` could tell an operator there was a decision to make, and it was read by
 * the renderer to print a ready-made destructive command — which is how the
 * unsafe authorisation contract became the *normal* operator path rather than a
 * hand-built misuse. With the break withdrawn the field would be a permission
 * pointing at nothing.
 */
export function assessLeaseRecovery(
  repository: LeaseRepository,
  deps: LeaseRecoveryDependencies = {},
): LeaseRecoveryAssessment {
  const record = snapshotRepositoryRecord(repository);
  const inspection = inspectRepositoryExecutionLease(record, deps);
  return Object.freeze({
    classification: classifyForRecovery(inspection),
    inspection,
    staleRecovery: assessStaleLeaseRecovery(record, deps),
    // Read from the inspection here, and never handed to the classifier — see
    // the argument it takes, which is two fields rather than the whole
    // inspection. A field a function cannot see is a field it cannot start
    // depending on, and an earlier version of this comment claimed that while
    // passing the classifier the entire `LeaseInspection`, containment included.
    latestLaunchContained:
      inspection.containment !== null && isReliableContainment(inspection.containment),
    containment: inspection.containment,
  });
}

/**
 * Not called `classify`, and the name is load-bearing rather than fussy.
 *
 * `tests/v2-02-remediation.test.ts` pins the modules that define a function of
 * that name, because three copies of one path-safety chain once travelled under
 * it. This classifies a lease inspection and shares nothing with that chain, so
 * it says so instead of joining a list of exceptions.
 */
function classifyForRecovery(
  inspection: Pick<LeaseInspection, 'state' | 'liveness'>,
): LeaseRecoveryClassification {
  switch (inspection.state) {
    case 'FREE':
      return 'NOTHING_TO_RECOVER';
    case 'UNREADABLE':
      return 'LEASE_UNREADABLE';
    case 'LOCATION_UNSUITABLE':
      return 'LOCATION_UNSUITABLE';
    case 'LOCATION_NETWORK_UNSUPPORTED':
      return 'LOCATION_NETWORK_UNSUPPORTED';
    case 'LOCATION_DEVICE_NAMESPACE':
      return 'LOCATION_DEVICE_NAMESPACE';
    case 'HELD':
    case 'UNPARSEABLE':
      break;
    default: {
      // The real repair, not the two cases above it. Without this, a state
      // this switch does not name falls all the way through into the
      // liveness switch below and comes out misclassified as whatever that
      // switch's default answer happens to be — which is exactly how the two
      // location states above went missing and were reported as
      // `NO_OWNER_RECORDED`, the crash-window artefact, for a repository
      // where nothing was ever created. `inspection.state` is `LeaseState`,
      // a closed union; every member reaching here is handled above, so this
      // assignment only compiles when that is still true. Add a member to
      // `LEASE_STATES` without a case here and the build fails, rather than
      // the classification silently lying again.
      const unhandled: never = inspection.state;
      throw new Error(`lease-recovery: unhandled lease state '${String(unhandled)}'`);
    }
  }

  switch (inspection.liveness) {
    case 'ALIVE':
      return 'OWNER_RUNNING';
    case 'UNDETERMINED':
      return 'OWNER_LIVENESS_UNDETERMINED';
    case 'NOT_FOUND':
      return 'STALE_OWNER_GONE';
    case 'UNKNOWABLE':
      return 'NO_OWNER_RECORDED';
  }
}
