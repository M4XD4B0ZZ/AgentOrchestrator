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
 * So: **no break, no `--force`, no environment variable, no API back door.** A
 * later recovery is a different design — quarantine-and-report, which never
 * unlinks and takes its second confirmation against a quarantine name only that
 * call knows — and it is a product decision of its own, not a fifth patch
 * wearing this one's name.
 *
 * ── What an operator gets instead ──────────────────────────────────────────
 *
 * The truth about the lease path, stated precisely, and the fact that clearing it
 * is outside what this build will do for them. {@link assessLeaseRecovery}
 * classifies; it authorises nothing, because there is now nothing to authorise.
 * Liveness keeps the rule it has everywhere else: **it may refuse and it may
 * never permit.**
 */

import {
  isReliableContainment,
  type ContainmentReading,
} from './containment-evidence.js';
import {
  inspectRepositoryExecutionLease,
  snapshotRepositoryRecord,
  type LeaseInspection,
  type LeaseRepository,
  type ProcessLivenessProbe,
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
   * Whether this lease carries a reliable containment proof.
   *
   * Reported beside the classification and deliberately **not** an input to it.
   * {@link classifyForRecovery} does not read this field, and a test pins that
   * every classification is the same value with and without evidence present:
   * this slice teaches the assessment to *see* containment and nothing more.
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
  readonly containmentProven: boolean;
  /** The reading itself, for a report. `null` when no document was parsed. */
  readonly containment: ContainmentReading | null;
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
  const inspection = inspectRepositoryExecutionLease(snapshotRepositoryRecord(repository), deps);
  return Object.freeze({
    classification: classifyForRecovery(inspection),
    inspection,
    // Read from the inspection, and read *here* rather than inside
    // `classifyForRecovery`, so that the classifier has no access to it at all.
    // A field a function cannot see is a field it cannot start depending on.
    containmentProven:
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
function classifyForRecovery(inspection: LeaseInspection): LeaseRecoveryClassification {
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
