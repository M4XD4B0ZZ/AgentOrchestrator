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
 *   - the object identity is a `(dev,ino)` pair, and this module's own acquire
 *     path ships fallbacks for filesystems that reuse those promptly.
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
  inspectRepositoryExecutionLease,
  snapshotRepositoryRecord,
  type LeaseInspection,
  type LeaseRepository,
  type ProcessLivenessProbe,
} from './execution-lease.js';

/** The seam this module takes. The same one, and the only one, `acquire` takes. */
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
] as const;

export type LeaseRecoveryClassification = (typeof LEASE_RECOVERY_CLASSIFICATIONS)[number];

export interface LeaseRecoveryAssessment {
  readonly classification: LeaseRecoveryClassification;
  readonly inspection: LeaseInspection;
}

/**
 * Classifies what is at the lease path. Reads; changes nothing; never throws.
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
    case 'HELD':
    case 'UNPARSEABLE':
      break;
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
