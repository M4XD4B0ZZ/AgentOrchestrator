/**
 * Attended recovery: how a repository stops being locked by a run that died.
 *
 * ── What this is, and what it replaces ─────────────────────────────────────
 *
 * `acquireRepositoryExecutionLease` never takes over a lease it did not create.
 * That is measured rather than assumed — `execution-lease.ts` sets out why a
 * dead owner proves nothing about the agent processes it started — and it leaves
 * exactly one gap: the first crash makes a repository unrunnable until somebody
 * deletes a file inside `.git` by hand.
 *
 * A `lease break` existed for that gap and was **withdrawn**, after three
 * independent adversarial review rounds each found a fresh way for it to destroy
 * an authority somebody had legitimately acquired:
 *
 *  1. it read the lease, decided, and `unlink`ed the *path* — so a lease
 *     released and re-acquired in between was destroyed by a decision made about
 *     a dead owner (ABA);
 *  2. the fix re-occupied the name with a placeholder and then acted on the name
 *     twice, guarded by a boolean — the same defect one level up, reproduced
 *     with real processes twelve times out of twelve;
 *  3. and the routes around the artefact's own machinery.
 *
 * Withdrawing it was right, and leaving it withdrawn is not: "delete a file
 * inside `.git` yourself, and mind the race" is the same destructive operation
 * with the tool's help removed. So it comes back, under a contract written from
 * what defeated it.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 *
 *  1. **Break is explicit and attended.** There is no automatic break, no
 *     `--force`, and no code path anywhere that removes a lease because
 *     something looked stale. Attendance is stated by the operator at the
 *     command, exactly as `release --attended` states it, and this module is
 *     reachable from that one command and nothing else.
 *  2. **Observation is not authority.** "I saw stale lease X" does not license
 *     deleting whatever occupies the path later. The operator names the lease
 *     they inspected — by the digest of its exact bytes — and that name is what
 *     is acted on.
 *  3. **Break is identity-bound.** The removal proves, *on the bytes it has
 *     detached*, that they are still the lease that was inspected. Not on bytes
 *     read earlier, and never on the name alone.
 *  4. **ABA fails closed.** Inspect A → A disappears → B legitimately acquires →
 *     the operator confirms: B is left exactly as it was found.
 *  5. **The TOCTOU windows are named, not argued away.** `removeVerifiedLease`
 *     states the residual it cannot close and why no portable primitive closes
 *     it; the real-process harness in `tests/dist-artifact/` runs breakers and
 *     acquirers against one lease to check the claim where it actually has to
 *     hold.
 *  6. **Classification and removal authority are separate decisions.**
 *     {@link assessLeaseRecovery} says what is there. It authorises nothing:
 *     {@link breakInspectedLease} re-establishes every fact for itself, and a
 *     lease classified stale is still refused if ownership changed.
 *  7. **Every attempt has one durable answer**, and they are five because they
 *     ask five different things of an operator — see {@link LEASE_BREAK_OUTCOMES}.
 *  8. Liveness keeps the rule it has everywhere else: **it may refuse and it may
 *     never permit**. `ALIVE` and `UNDETERMINED` both stop a break. `NOT_FOUND`
 *     does not authorise one — the operator's explicit, identity-bound
 *     authorisation does; the probe only withholds a refusal it had no reason to
 *     make.
 */

import {
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
  legibleOwnerPid,
  osProcessLiveness,
  removeVerifiedLease,
  revisionOfLeaseBytes,
  snapshotRepositoryRecord,
  type VerifiedRemoval,
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
 * A *report*, and deliberately not an authorisation: nothing below takes one of
 * these as an argument. See contract 6 in the header — the previous break failed
 * precisely because a judgement made at one moment was carried to a later effect.
 */
export const LEASE_RECOVERY_CLASSIFICATIONS = [
  /** Nothing is there. Nothing to recover, and nothing to remove. */
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
   * leaves behind. There is no owner to ask about, so the bytes are the only
   * identity it has — which is exactly what an authorisation names.
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
  /**
   * Whether a break *could* apply here at all.
   *
   * A property of what is there, never a permission. A `true` here is worth
   * nothing to {@link breakInspectedLease}, which reads the file again and
   * decides again; it exists so `lease status` can tell an operator whether
   * there is a decision to make.
   */
  readonly breakable: boolean;
  readonly inspection: LeaseInspection;
}

/** Classifies what is at the lease path. Reads; changes nothing; never throws. */
export function assessLeaseRecovery(
  repository: LeaseRepository,
  deps: LeaseRecoveryDependencies = {},
): LeaseRecoveryAssessment {
  const inspection = inspectRepositoryExecutionLease(snapshotRepositoryRecord(repository), deps);
  const classification = classifyForRecovery(inspection);
  return Object.freeze({
    classification,
    // A lease whose object this platform cannot identify is one the break will
    // refuse, so the report an operator acts on must not call it recoverable.
    // `status` offering a command that `break` declines is worse than offering
    // nothing: it spends the operator's trust on a dead end.
    breakable:
      (classification === 'STALE_OWNER_GONE' || classification === 'NO_OWNER_RECORDED') &&
      inspection.objectId !== null,
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

/* ──────────────────────────── authorisation ─────────────────────────────── */

/**
 * The lease an operator inspected and decided about.
 *
 * Both fields are things they were *shown*, and neither is a thing they can
 * usefully guess. There is deliberately no repository id, no run id and no
 * "yes I am sure" flag: an authorisation that can be constructed without having
 * looked is an authorisation that says nothing.
 */
export interface LeaseBreakAuthorisation {
  /**
   * Digest of the exact bytes `lease status` printed. The lease's identity.
   *
   * A revision an operator names back closes nothing on its own — the first
   * withdrawn break took one and still destroyed a successor. It closes
   * something because {@link removeVerifiedLease} checks it against the bytes it
   * has already detached.
   */
  readonly expectedRevision: string;
  /**
   * Which filesystem object the operator inspected, as `lease status` printed it.
   *
   * ── Why a digest was not enough ────────────────────────────────────────
   *
   * Because one class of lease has no content to hash. The crash-window artefact
   * is a zero-byte file; its digest is the constant `sha256("")`; and an
   * authorisation naming that digest matched *any* empty object at the lease
   * name — including the transient one every acquisition creates on a filesystem
   * that refuses hard links. An independent review reproduced a break removing a
   * live exclusive claim that way.
   *
   * So the operator names the object, not just its bytes, and both are
   * re-established on the record the removal has already detached. Required, and
   * with no `null` member: where the platform cannot report a usable identity
   * there is no authorisation to be had and the break refuses for that case. A
   * fallback to something weaker would be the digest again.
   */
  readonly expectedObjectId: string;
  /**
   * The owner pid those bytes recorded, or `null` when they recorded none.
   *
   * Cross-checked rather than trusted: it is how an operator confirms they are
   * looking at the lease they think they are, and a mismatch means a command
   * line built from another repository's report. `null` is a positive statement
   * — "the thing I inspected named no process" — so offering a pid for a lease
   * that records none is refused rather than ignored.
   */
  readonly expectedOwnerPid: number | null;
}

/** Whether a removal left the lease name free while keeping what it detached. */
function leftUnowned(removal: VerifiedRemoval): boolean {
  return removal === 'CHANGED_AND_UNOWNED' || removal === 'UNIDENTIFIABLE_AND_UNOWNED';
}

/** `<dev>:<ino>`, exactly as {@link leaseObjectIdentity} spells it. */
const OBJECT_IDENTITY = /^-?[0-9]+:[0-9]+$/;

/* ─────────────────────────────── the break ──────────────────────────────── */

/**
 * Every way an attended break can end. Total, closed, and five for a reason.
 *
 * They differ in what an operator does next, which is the only thing an outcome
 * vocabulary is for:
 *
 *  - `LEASE_REMOVED` — the lease you inspected is gone; the repository is
 *    runnable again.
 *  - `LEASE_ALREADY_GONE` — there was nothing to remove. **This invocation
 *    destroyed nothing**, which is a different fact from the one above and is
 *    why the two are not one code.
 *  - `LEASE_CHANGED_SINCE_INSPECTION` — something else is there now. Inspect
 *    again; do not repeat the command with the old revision.
 *  - `LEASE_NOT_BREAKABLE` — the lease is there and this is not a lease this
 *    flow may remove: its owner is running, its liveness cannot be established,
 *    or the authorisation describes a different lease. `detail` says which.
 *  - `LEASE_BREAK_VERIFICATION_FAILED` — a record was detached and could not be
 *    identified, so it was neither removed nor claimed to have been. It is kept,
 *    beside the lease path, inert and inspectable.
 */
export const LEASE_BREAK_OUTCOMES = [
  'LEASE_REMOVED',
  'LEASE_ALREADY_GONE',
  'LEASE_CHANGED_SINCE_INSPECTION',
  'LEASE_NOT_BREAKABLE',
  'LEASE_BREAK_VERIFICATION_FAILED',
] as const;

export type LeaseBreakOutcome = (typeof LEASE_BREAK_OUTCOMES)[number];

export interface LeaseBreakResult {
  readonly outcome: LeaseBreakOutcome;
  /** A fixed token, never a message and never a path (AO-002). */
  readonly detail: string | null;
}

function breakResult(outcome: LeaseBreakOutcome, detail: string | null = null): LeaseBreakResult {
  return Object.freeze({ outcome, detail });
}

/**
 * Removes exactly the lease an operator inspected, or nothing at all.
 *
 * Synchronous and never throwing, like every other operation on this path.
 *
 * ── The order, and why it is this order ────────────────────────────────────
 *
 * The gate below is worth having and is *not* what makes this safe. It refuses
 * the cases an operator can be told about cheaply — a running owner, an
 * authorisation for another lease — before anything is touched, so the ordinary
 * refusal never detaches a stranger's record even for an instant.
 *
 * What makes it safe is the second half: every one of those facts is
 * re-established inside the removal, on the bytes the detach has just produced.
 * The gate can be stale by the time the effect happens — that is the definition
 * of a TOCTOU window, and this one cannot be closed by checking harder — so
 * nothing the gate concluded is carried into the removal as a permission. The
 * predicate is handed no state at all: it is given bytes and it asks again.
 */
export function breakInspectedLease(
  repository: LeaseRepository,
  authorisation: LeaseBreakAuthorisation,
  deps: LeaseRecoveryDependencies = {},
): LeaseBreakResult {
  // One reading of the record, for the classification and the removal to share
  // (LF-2): a record that names one repository when the lease is read and
  // another when the path to remove is derived is a record that breaks a lease
  // somewhere nobody looked.
  const record = snapshotRepositoryRecord(repository);
  const location = deriveExecutionLeaseLocation(record);
  if (!location.ok) return breakResult('LEASE_NOT_BREAKABLE', 'LOCATION_UNSUITABLE');

  const probe = deps.processAlive ?? osProcessLiveness;
  const assessed = assessLeaseRecovery(record, deps);

  // --- The gate: what an operator can be told without touching anything -----
  switch (assessed.classification) {
    case 'NOTHING_TO_RECOVER':
      return breakResult('LEASE_ALREADY_GONE');
    case 'OWNER_RUNNING':
      return breakResult('LEASE_NOT_BREAKABLE', 'OWNER_RUNNING');
    case 'OWNER_LIVENESS_UNDETERMINED':
      return breakResult('LEASE_NOT_BREAKABLE', 'OWNER_LIVENESS_UNDETERMINED');
    case 'LEASE_UNREADABLE':
      return breakResult('LEASE_NOT_BREAKABLE', 'LEASE_UNREADABLE');
    case 'LOCATION_UNSUITABLE':
      return breakResult('LEASE_NOT_BREAKABLE', 'LOCATION_UNSUITABLE');
    case 'STALE_OWNER_GONE':
    case 'NO_OWNER_RECORDED':
      break;
  }

  // An authorisation that names no object is not an authorisation. Refused as
  // its own thing rather than folded into "the lease changed", because the two
  // send an operator to different places: one re-inspects, the other cannot
  // proceed on this platform at all.
  if (!OBJECT_IDENTITY.test(authorisation.expectedObjectId)) {
    return breakResult('LEASE_NOT_BREAKABLE', 'OBJECT_IDENTITY_UNUSABLE');
  }
  if (assessed.inspection.objectId === null) {
    return breakResult('LEASE_NOT_BREAKABLE', 'OBJECT_IDENTITY_UNVERIFIABLE');
  }
  if (assessed.inspection.objectId !== authorisation.expectedObjectId) {
    return breakResult('LEASE_CHANGED_SINCE_INSPECTION');
  }

  // The owner the operator was shown, before the bytes are checked: a
  // mismatch here is a command line built from a different report, and saying
  // so is more useful than "the lease changed".
  if (assessed.inspection.ownerPid !== authorisation.expectedOwnerPid) {
    return breakResult('LEASE_NOT_BREAKABLE', 'OWNER_PID_MISMATCH');
  }
  if (assessed.inspection.revision !== authorisation.expectedRevision) {
    return breakResult('LEASE_CHANGED_SINCE_INSPECTION');
  }

  // --- The effect: every fact above, re-established on the detached bytes ---
  //
  // `refusedBy` records *why* the predicate said no, so a refusal on the
  // detached bytes can be reported as what it is. It is written and read inside
  // this one call, about one object this call owns — not a belief about a name
  // carried across syscalls, which is the mistake the second withdrawn break
  // made.
  let refusedBy: string | null = null;
  const removal = removeVerifiedLease(location.path, (bytes, objectId) => {
    // The object first, because it is the identity a digest cannot supply for an
    // empty record — and it is asked of the thing this call has *detached*, not
    // of the name it came from. The gate above asked the same question of an
    // earlier reading; this is the one that decides, immediately before the
    // deletion, and a mutation probe showed the gate alone leaving it unpinned.
    if (objectId === null) {
      refusedBy = 'OBJECT_IDENTITY_UNVERIFIABLE';
      return false;
    }
    if (objectId !== authorisation.expectedObjectId) return false;
    if (revisionOfLeaseBytes(bytes) !== authorisation.expectedRevision) return false;

    const owner = legibleOwnerPid(bytes);
    if (owner !== authorisation.expectedOwnerPid) {
      refusedBy = 'OWNER_PID_MISMATCH';
      return false;
    }

    if (owner !== null) {
      // Asked again, of the process the *detached* record names. A lease whose
      // owner came back to life between the gate and here is not removed —
      // liveness may refuse, and this is it refusing.
      const liveness = probe(owner);
      if (liveness === 'ALIVE') {
        refusedBy = 'OWNER_RUNNING';
        return false;
      }
      if (liveness === 'UNDETERMINED') {
        refusedBy = 'OWNER_LIVENESS_UNDETERMINED';
        return false;
      }
    }

    return true;
  });

  // The refusal, and the one fact that outranks it.
  //
  // `refusedBy` says why this call declined to remove the record. If the restore
  // then failed and left the lease name free, the repository is unowned — and an
  // operator who is told only "its owner is running" will wait for a run that no
  // longer holds anything. A review found this short-circuit discarding exactly
  // that, so the reason line now carries whichever fact the operator must act on
  // first, and the unowned one always wins.
  // Inside the refusal, and not in front of it.
  //
  // The rule intended here is that "this repository is now unowned" outranks
  // *the reason a refusal gives*, because an operator told only "its owner is
  // running" would wait for a run that holds nothing. The first version of it
  // ranked the fact ahead of the whole switch below, which is a different and
  // wrong rule: `leftUnowned` is true for exactly the two removal states the
  // switch answers most precisely, so both arms became dead code and the
  // unowned-and-unreadable state was reported as `LEASE_NOT_BREAKABLE` — "the
  // lease is there", of a name this same call had measured free — at exit 4,
  // "re-invoking under other conditions can differ", instead of the exit 3 that
  // `run-exit-codes.ts` reserves verbatim for a record detached, unidentifiable
  // and sitting beside the lease path with no retry that helps.
  //
  // Worse, on that route there was nothing to outrank: `matches` is invoked only
  // when the detached bytes could be read (`execution-lease.ts`), so `refusedBy`
  // is null by construction whenever `UNIDENTIFIABLE_AND_UNOWNED` is produced.
  // The third independent review found it, and it is this fix's own regression
  // one line further down.
  if (refusedBy !== null) {
    return breakResult(
      'LEASE_NOT_BREAKABLE',
      leftUnowned(removal) ? 'RECORD_QUARANTINED_LEASE_UNOWNED' : refusedBy,
    );
  }

  switch (removal) {
    case 'REMOVED':
      return breakResult('LEASE_REMOVED');
    case 'ABSENT':
      return breakResult('LEASE_ALREADY_GONE');
    case 'CHANGED':
      // Reached only from the effect, and it says so. "The lease changed before
      // I touched anything" and "I detached a record, found it was not the one
      // you named, and put it back" are different facts about the repository,
      // and only the second one moved a file. The gate's refusal above carries
      // no detail for exactly that reason.
      return breakResult('LEASE_CHANGED_SINCE_INSPECTION', 'RECORD_RESTORED');
    case 'CHANGED_AND_UNOWNED':
      // The record is kept and this repository has no owner. Reported as its own
      // reason because "somebody else holds it now" and "nobody holds it now"
      // send an operator to opposite actions, and the previous code answered the
      // first for both without ever looking at the name.
      return breakResult('LEASE_CHANGED_SINCE_INSPECTION', 'RECORD_QUARANTINED_LEASE_UNOWNED');
    case 'UNIDENTIFIABLE_AND_UNOWNED':
      return breakResult('LEASE_BREAK_VERIFICATION_FAILED', 'UNREADABLE_LEASE_UNOWNED');
    case 'CHANGED_QUARANTINED':
      // The same refusal, and a materially different repository afterwards: the
      // record that was there is now in a quarantine file, its writer displaced,
      // and the lease name belongs to whoever took it. The operator is told,
      // because the alternative is that they find a `.breaking-` file inside
      // `.git` with nothing in the build accounting for it.
      return breakResult('LEASE_CHANGED_SINCE_INSPECTION', 'RECORD_QUARANTINED');
    case 'DETACH_FAILED':
      // Nothing happened: the filesystem refused to detach the record, which on
      // Windows is what a file another process has open answers. The lease is
      // exactly where it was, so this is "not breakable, now" and emphatically
      // not the quarantine case below — the real-process harness produces it
      // often enough that reporting the two as one would send most operators
      // hunting for a file that was never created.
      return breakResult('LEASE_NOT_BREAKABLE', 'DETACH_REFUSED');
    case 'UNIDENTIFIABLE':
      // Detached, unreadable, and **put back**. There is no quarantine file to
      // send anybody to, and the sentence for this outcome used to promise one.
      return breakResult('LEASE_BREAK_VERIFICATION_FAILED', 'UNREADABLE_AND_RESTORED');
    case 'UNIDENTIFIABLE_QUARANTINED':
      return breakResult('LEASE_BREAK_VERIFICATION_FAILED', 'UNREADABLE_AND_QUARANTINED');
  }
}
