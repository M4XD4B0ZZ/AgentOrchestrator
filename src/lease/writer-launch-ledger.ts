/**
 * The writer-launch ledger: the durable history that lets one lease answer
 * *"can an unproven writer still exist under me?"* — and answer it fail-closed.
 *
 * ── Why slice 4's record cannot answer this, restated exactly ──────────────
 *
 * `lease/containment-evidence.ts` records one **launch**. Its own header says so
 * twice and lists the residue that follows: a run makes several `claude` spawns
 * under one lease, only the most recent one is described, a failed publish
 * leaves the previous launch's positive record standing, and so does a failed
 * clear. Every one of those was measured rather than argued.
 *
 * So `latestLaunchContained === true` is not "this lease is safe to recover". It
 * is "the last launch anybody managed to write about was contained", which is a
 * different sentence and a much weaker one. Recovery needs the stronger claim,
 * and a stronger claim needs a different record — a per-launch state that is
 * **poisoned before the launch and confirmed after it**. That is this file.
 *
 * ── The mechanism, in the order it happens ─────────────────────────────────
 *
 *     lease acquired      → ledger published, `historyComplete: true`, no entries
 *     before each launch  → generation N appended as PENDING, published
 *     launch happens      → only after that publish is known to have landed
 *     kernel confirms job → generation N replaced by ESTABLISHED, published
 *     launch seen to end  → generation N replaced by CONTAINED, published
 *     anything else       → generation N stays where it got to, for good
 *
 * The ordering is the whole safety argument, and it only works in one direction.
 * A record written *after* a launch cannot describe a launch that was killed
 * mid-flight; a mark written *before* it can. So the poison goes down first, and
 * a launch whose poison could not be written does not happen at all — see
 * {@link WriterLaunchLedger.historyComplete} for the one escape hatch that
 * exists instead of stopping the run, and why it is still fail-closed.
 *
 * ── The middle step, and the window it closes ──────────────────────────────
 *
 * `ESTABLISHED` is M2 slice 1 and it is the reason this ledger changed. The two
 * original marks were written *before* and *after* the writer ran, so the whole
 * of a writer's runtime — minutes, and by far the largest window in a run — was
 * recorded as `PENDING`, which proves nothing. A real reproduction killed an
 * orchestrator in that window and measured the consequence: the writer tree was
 * gone, and no product command could say so, so the repository stayed locked.
 *
 * The kernel's confirmation of job membership was already in hand at the moment
 * the boundary reported ownership; it was simply not written down until the run
 * ended. Writing it at that instant narrows the unprovable window from a
 * writer's whole runtime to the interval between the poison and the kernel's
 * answer, which was **observed once at 76 ms** on the reference machine. That is
 * one observation and not a bound - nothing here measures it and no gate holds
 * it - and it is offered for its order of magnitude against the minutes it
 * replaces. It does not close the window, and {@link EstablishedLaunchSchema}
 * says what the state does and does not claim.
 *
 * ── `historyComplete` is what makes an absent baseline safe to refuse ──────
 *
 * A ledger that has to be rebuilt from nothing is the sharpest failure this
 * format has, and the obvious handling of it is fail-open. If the file is gone,
 * or torn, or belongs to another lease, the next launch could simply start a
 * fresh history at generation 1 — and that history would then read *complete and
 * all-contained* while hiding every launch the lost file described.
 *
 * So a history is only ever `historyComplete: true` when it was created at the
 * one instant nothing can have been hidden: the moment the lease itself was
 * claimed, when no writer under it can have launched yet. Every other origin —
 * a rebuild after an unreadable ledger, after a missing one, after one bound to
 * a different lease — produces `false`, and `false` is permanent: nothing in
 * this build promotes it, because nothing can learn what the lost file said.
 *
 * A ledger with `historyComplete: false` is a usable *log* and is never a
 * *proof*. {@link readWriterLaunchLedger} reports it as its own reading rather
 * than folding it into "unproven launch", because the two send an operator to
 * different places: one says a writer of this lease is unaccounted for, the
 * other says this lease's bookkeeping was interrupted.
 *
 * ── Containment is still not authority ─────────────────────────────────────
 *
 * Repeated here for the same reason `containment-evidence.ts` repeats it, since
 * this is the file whose reading a removal is gated on. A complete ledger whose
 * every launch is `CONTAINED` proves one thing only: **no process tree started
 * as a writer under this lease can still be running**, because every one of them
 * was created inside a Job Object coupled to the lease owner, was observed to
 * end, and that owner is gone.
 *
 * A ledger carrying `ESTABLISHED` entries proves strictly less than that on its
 * own — the endings were not observed — and the missing half is supplied at the
 * removal, not here: the predicate re-probes the pids those entries record and
 * refuses unless every one of them is gone. Stated in both places on purpose,
 * because this is the file somebody reads while deciding what a reading licenses,
 * and the two readings license different things.
 *
 * Neither says anything about who may write to the repository. The lease that
 * gets removed on the strength of either is removed as a *dead object*, and the
 * next execution acquires its own authority through the ordinary acquisition
 * path.
 *
 * ── What this ledger does not cover, stated rather than implied ────────────
 *
 * **Only the productive writer.** `loop/leased-spawns.ts` opens a generation for
 * `claude` and for nothing else, exactly as slice 4 records containment for
 * `claude` and nothing else. The reviewer and the verification command go
 * through the same owned boundary on Windows — `doctor/exec.ts` routes every
 * spawn through `runOwnedCommand` — so they are contained in fact; they are
 * simply not *recorded*, so no reading here is evidence about them. A reader who
 * needs "no process of any kind survives" needs a wider ledger than this one, and
 * widening it is a contract change rather than a reading of this contract.
 *
 * **And forgery is bounded exactly as slice 4's is.** The binding digest below
 * is computed from the lease key and the owner nonce, both of which are
 * plaintext in the lease document sitting beside this file. Anyone who can
 * create a file in the Git directory can therefore write a ledger that reads
 * all-contained. That is not a hole this format can close, it is the same bound
 * `containment-evidence.ts` states without flinching, and it is why the digest is
 * called a binding and never a signature: it catches transplantation, in-place
 * edits and version drift, and it does not withstand an author who can rewrite
 * the whole file.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Contract version of the ledger. Bump on any change to the payload.
 *
 * Its own version, separate from both the lease document's and the containment
 * record's, for the reason `containment-evidence.ts` gives: a bump here must
 * leave the lease readable and its owner reportable, and must refuse only the
 * history.
 *
 * **2** since M2 slice 1 added {@link EstablishedLaunchSchema} to the entry
 * union. The cost of that bump is stated rather than left to be discovered: a
 * ledger written by a version-1 build now reads `UNSUPPORTED_VERSION`, so a
 * stale lease left behind by an older build is refused where it might once have
 * been recovered. That is the conservative direction and it is the same rule
 * `LAUNCH_HISTORY_ABSENT` already applies — no lease from an earlier build is
 * retroactively safe — and the operator's remaining move is unchanged: the lease
 * path is printed by `agent-loop lease status`.
 */
export const WRITER_LAUNCH_LEDGER_VERSION = 2;

/**
 * Largest history this build will represent.
 *
 * This said "a run cannot reach it", which was wrong twice over and an
 * adversarial review measured both halves. A `CONTAINED` entry serialises to
 * about 465 bytes at `JSON.stringify(…, null, 2)`, so 4096 of them are roughly
 * 1.9 MB — and the companion reader's byte cap was set to 1 MiB and described as
 * "sized for the entry cap", so the *byte* cap bound first, at about 2261
 * entries, and this one could never fire at all.
 *
 * That was not merely a dead constant. Past the byte cap every confirmation
 * failed its read-back, so every generation stayed `PENDING` and the lease
 * became permanently unrecoverable — silently, because the seam discards the
 * confirmation's result. Fail-closed, and an undisclosed permanent loss of the
 * whole feature.
 *
 * Both are fixed rather than re-described: the byte cap now covers this one with
 * room to spare, so this cap is what binds, and reaching it is a stated outcome
 * (`HISTORY_DISCARDED` with `HISTORY_FULL`) rather than a silent state. A run
 * reaching 4096 writer launches under one lease is not expected; it is no longer
 * *asserted* to be impossible.
 */
export const MAX_WRITER_LAUNCH_ENTRIES = 4096;

const HEX_64 = /^[0-9a-f]{64}$/;

/** Restated rather than imported, for the reason `lease-document.ts` gives. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A launch that was announced and has not been proven contained.
 *
 * The state a generation is *born* in. It carries no containment facts at all
 * rather than carrying them as nulls, so there is no field an edit can flip to
 * turn an unproven launch into a proven one — the two states are different
 * shapes, and the discriminated union below refuses a mixture of them.
 */
const PendingLaunchSchema = z
  .object({
    generation: z.int().positive(),
    state: z.literal('PENDING'),
    writerId: z.string().min(1).max(64),
    openedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
  })
  .strict();

/**
 * A launch whose job membership the kernel confirmed.
 *
 * `verifiedInJob` is a literal `true` for the reason the containment record's
 * is: a record saying the kernel did not confirm membership is evidence for
 * something else, and this schema refuses to represent it.
 */
const ContainedLaunchSchema = z
  .object({
    generation: z.int().positive(),
    state: z.literal('CONTAINED'),
    writerId: z.string().min(1).max(64),
    openedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    helperPid: z.int().positive(),
    childPid: z.int().positive(),
    mode: z.string().min(1).max(32),
    verifiedInJob: z.literal(true),
    assignedAtCreation: z.boolean().nullable(),
    launchDigest: z.string().regex(HEX_64, 'Must be a launch digest.'),
    attestedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    confirmedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
  })
  .strict();

/**
 * A launch the kernel placed in the owner's job, whose ending was never seen.
 *
 * ── Why this state exists, measured rather than reasoned ───────────────────
 *
 * `PENDING` and `CONTAINED` were written before and after the writer ran, and
 * the whole of a writer's runtime sat between them with nothing recorded. That
 * is the *largest* window in a run — a `claude` launch lasts minutes — and it is
 * the window an interrupt is most likely to land in. A real reproduction on
 * this platform (`tests/dist-artifact/crash-recovery-dist-artifact.mjs`) killed
 * an owner mid-writer and measured the result: the writer tree was **gone**, and
 * the ledger said `PENDING`, so `agent-loop lease recover` refused
 * `LAUNCH_HISTORY_UNPROVEN` and the repository was unrunnable by every product
 * command there is. That is M1's `U1`.
 *
 * The fact that would have settled it existed the whole time and was simply not
 * written down. `boundary/start-owned-process.ts` returns only once the helper
 * has reported `verifiedInJob` — the kernel confirming job membership **before
 * the target's first instruction** — so at establishment the launch's
 * containment is already proven. This state is that proof, recorded at that
 * instant.
 *
 * ── What it claims, and what it deliberately does not ──────────────────────
 *
 * It claims exactly this: *generation N's target was created for a Job Object
 * owned by `helperPid`, coupled to the lease's owner, the kernel confirmed its
 * membership, and no instruction of the target executed outside that job.*
 *
 * Neither of the two shorter wordings holds in both launch modes - "confirmed
 * before the target executed" is false in `JOBLIST` and "never existed outside
 * the job" is false in `SUSPENDED`. `core/containment-attestation.ts` sets out
 * why; this file has carried each of them in turn and neither was true.
 *
 * It does **not** claim the tree has ended, and that is the whole difference
 * from {@link ContainedLaunchSchema}. `CONTAINED` is written by
 * `confirmWriterLaunch` after `runOwnedCommand` has awaited `owned.ending`,
 * which settles on the helper's close — so a `CONTAINED` entry is written when
 * the helper is already gone. Nothing of the kind is true here: this entry is
 * written while the writer is running.
 *
 * So a recovery may not treat the two the same, and does not. The predicate in
 * `execution-lease.ts` accepts a history containing these entries **only** after
 * re-establishing, against the real liveness probe and inside the call that
 * removes, that `helperPid` and `childPid` are both gone. That check is what
 * turns "was contained" into "is not running": the helper holds the job's only
 * handle, the job carries `KILL_ON_JOB_CLOSE` and neither breakaway flag
 * (`native/ao-launch/AoLaunch.cs`), so a helper that is gone took its job — and
 * everything in it, grandchildren included — with it.
 *
 * Recording the pids is therefore not decoration: they are the subject of that
 * later check, and a state that carried the containment without them would be a
 * claim nothing could re-verify.
 */
const EstablishedLaunchSchema = z
  .object({
    generation: z.int().positive(),
    state: z.literal('ESTABLISHED'),
    writerId: z.string().min(1).max(64),
    openedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    helperPid: z.int().positive(),
    childPid: z.int().positive(),
    mode: z.string().min(1).max(32),
    verifiedInJob: z.literal(true),
    assignedAtCreation: z.boolean().nullable(),
    launchDigest: z.string().regex(HEX_64, 'Must be a launch digest.'),
    attestedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    establishedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
  })
  .strict();

export const WriterLaunchEntrySchema = z.discriminatedUnion('state', [
  PendingLaunchSchema,
  EstablishedLaunchSchema,
  ContainedLaunchSchema,
]);

export type WriterLaunchEntry = z.infer<typeof WriterLaunchEntrySchema>;
export type PendingLaunch = z.infer<typeof PendingLaunchSchema>;
export type EstablishedLaunch = z.infer<typeof EstablishedLaunchSchema>;
export type ContainedLaunch = z.infer<typeof ContainedLaunchSchema>;

export const WriterLaunchLedgerSchema = z
  .object({
    ledgerVersion: z.int().positive(),
    /** The lease owner this history belongs to. Must be the lease's own owner. */
    ownerPid: z.int().positive(),
    /** The run the lease was taken for. Must be the lease's own, `null` included. */
    runId: z.string().min(1).max(128).nullable(),
    /**
     * Whether this history began at the lease's own creation.
     *
     * `true` only for a ledger published by the acquisition that created the
     * lease. Anything rebuilt after the file was lost, torn or transplanted is
     * `false`, permanently — see the module header. A `false` ledger is a log
     * and never a proof.
     */
    historyComplete: z.boolean(),
    entries: z.array(WriterLaunchEntrySchema).max(MAX_WRITER_LAUNCH_ENTRIES),
    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict();

export type WriterLaunchLedger = z.infer<typeof WriterLaunchLedgerSchema>;

/** The ledger without the digest computed over it. */
export type WriterLaunchLedgerPayload = Omit<WriterLaunchLedger, 'binding'>;

/**
 * The lease a ledger is judged against.
 *
 * Its own shape rather than `ExecutionLease`, for the reason
 * `ContainmentSubject` is: these are the only four fields read, and it keeps
 * this module importing nothing from `execution-lease.ts` — which matters here
 * more than it did there, because the removal that consumes this reading lives
 * in that file and would otherwise import a cycle.
 */
export interface WriterLaunchSubject {
  readonly leaseKey: string;
  readonly ownerNonce: string;
  readonly ownerPid: number;
  readonly runId: string | null;
}

/**
 * What a lease's launch history turned out to be. A closed set of nine, of
 * which **two** can license a recovery and neither does so alone.
 */
export const WRITER_LAUNCH_READINGS = [
  /**
   * A complete history, bound to this lease, in which every launch is proven
   * contained *and observed to end*. The strongest reading — and it still does
   * not license removing a stale lease by itself, because it says nothing about
   * whether the owner is alive.
   */
  'ALL_LAUNCHES_CONTAINED',
  /**
   * A complete, well-bound history in which every launch was placed in the
   * owner's job by the kernel, and at least one of them was never seen to end.
   *
   * What an orchestrator killed **during** a writer run leaves behind, which the
   * U1 reproduction measured as the dominant case. It is a weaker reading than
   * {@link ALL_LAUNCHES_CONTAINED} in exactly one way — no ending was observed
   * for the `ESTABLISHED` entries — so a recovery built on it owes one further
   * proof that the other does not: that the trees those entries name are gone.
   * See `EstablishedLaunchSchema` for why the pids are recorded, and
   * {@link provesEveryLaunchContainedUnended} for how the two are kept apart.
   */
  'LAUNCHES_CONTAINED_SOME_UNENDED',
  /**
   * A complete, well-bound history in which at least one launch is still
   * `PENDING`.
   *
   * NOT what a killed orchestrator leaves behind while its writer is running -
   * that was true of this reading until M2 slice 1 and is now
   * {@link LAUNCHES_CONTAINED_SOME_UNENDED}. What reaches this one is a launch
   * that never got as far as the kernel's answer: killed in the window between
   * the announcement and establishment, established on a platform with no
   * boundary to confirm, or established and unable to publish the mark. It is
   * the format working, not the format failing.
   */
  'LAUNCH_UNPROVEN',
  /**
   * A well-bound history that did not begin with its lease.
   *
   * Its own reading rather than a shade of {@link LAUNCH_UNPROVEN}: no launch is
   * necessarily unaccounted for, and the bookkeeping is known to have a hole.
   * Different sentence, different place to look.
   */
  'HISTORY_INCOMPLETE',
  /** No ledger beside the lease: a lease from a build that kept none. */
  'ABSENT',
  /** A ledger this build does not know how to read. */
  'UNSUPPORTED_VERSION',
  /** Something is there and is not a ledger this build declares. */
  'MALFORMED',
  /** Well-formed, and the binding says it belongs to a different lease. */
  'NOT_THIS_LEASE',
  /** Well-formed and correctly bound, and it describes a different run or owner. */
  'NOT_THIS_RUN',
] as const;

export type WriterLaunchReading = (typeof WRITER_LAUNCH_READINGS)[number];

/**
 * Which readings prove that no unproven writer launch exists under this lease.
 *
 * A total table rather than an equality test, for the reason
 * `containment-evidence.ts` gives for its own: an added reading stops the build
 * here instead of falling into whatever `=== 'ALL_LAUNCHES_CONTAINED'` answers
 * for it. Completeness is not correctness, so every row is asserted by value in
 * `tests/v3-05-stale-lease-recovery.test.ts`.
 */
const PROVES_EVERY_LAUNCH_CONTAINED: Readonly<Record<WriterLaunchReading, boolean>> = Object.freeze({
  ALL_LAUNCHES_CONTAINED: true,
  // `false`, and this row is the one worth reading twice. Every launch in that
  // history *was* contained; what is missing is an observed ending, so the
  // sentence this predicate answers — "no unproven writer launch exists" — is
  // not the sentence that reading supports. It gets its own predicate below
  // rather than a second `true` here, because a caller that reached the removal
  // through this one would skip the liveness proof the other one owes.
  LAUNCHES_CONTAINED_SOME_UNENDED: false,
  LAUNCH_UNPROVEN: false,
  HISTORY_INCOMPLETE: false,
  ABSENT: false,
  UNSUPPORTED_VERSION: false,
  MALFORMED: false,
  NOT_THIS_LEASE: false,
  NOT_THIS_RUN: false,
});

/**
 * Whether this reading proves every writer launch was contained **and ended**.
 * Exactly one does.
 */
export function provesEveryLaunchContained(reading: WriterLaunchReading): boolean {
  return PROVES_EVERY_LAUNCH_CONTAINED[reading] === true;
}

/**
 * Which readings prove every launch was placed in the owner's job, while leaving
 * at least one ending unobserved.
 *
 * Not "at creation". Nothing here reads `assignedAtCreation` - the entry records
 * it and the digest binds it, and no predicate consults it - so a name or a
 * sentence promising it would be describing a check that does not happen. What
 * the reading rests on is `verifiedInJob`, which the schema pins to a literal
 * `true`.
 *
 * Its own table for the same reason the one above is a table rather than an
 * equality test, and its own *predicate* for a reason that is not style: this
 * answer is **not sufficient** for a removal on its own. A caller that gets
 * `true` here still owes a liveness proof about the trees
 * {@link unendedLaunchesOf} names, and separating the two predicates is what
 * makes forgetting that owed proof a compile-visible mistake rather than a
 * silent widening of the stronger one.
 *
 * Every row is asserted by value in `tests/v3-05-stale-lease-recovery.test.ts`,
 * beside the rows of the table above and with the disjointness of the two
 * asserted as its own claim; completeness is not correctness.
 */
const PROVES_CONTAINED_UNENDED: Readonly<Record<WriterLaunchReading, boolean>> = Object.freeze({
  ALL_LAUNCHES_CONTAINED: false,
  LAUNCHES_CONTAINED_SOME_UNENDED: true,
  LAUNCH_UNPROVEN: false,
  HISTORY_INCOMPLETE: false,
  ABSENT: false,
  UNSUPPORTED_VERSION: false,
  MALFORMED: false,
  NOT_THIS_LEASE: false,
  NOT_THIS_RUN: false,
});

/**
 * Whether this reading proves containment with at least one ending unseen.
 *
 * `false` for {@link WRITER_LAUNCH_READINGS.ALL_LAUNCHES_CONTAINED} on purpose:
 * the two predicates partition the licensing readings rather than nesting, so
 * neither answer can be read as the other's superset.
 */
export function provesEveryLaunchContainedUnended(reading: WriterLaunchReading): boolean {
  return PROVES_CONTAINED_UNENDED[reading] === true;
}

/** One launch proved contained and never observed to end. */
export interface UnendedLaunch {
  readonly generation: number;
  /** The process that owns the job. Its death destroys the job. */
  readonly helperPid: number;
  /** The target the kernel placed in that job before it executed. */
  readonly childPid: number;
}

/**
 * The launches a recovery still owes a liveness proof about, or `null`.
 *
 * ── Why it re-reads rather than taking a parsed ledger ─────────────────────
 *
 * Because the fail-closed direction has to be the *only* way to get pids out of
 * this module. This answers non-`null` for exactly one reading — the one
 * {@link provesEveryLaunchContainedUnended} names — so a ledger that is
 * malformed, transplanted, from another run, incomplete, or carrying a
 * `PENDING` entry yields nothing to probe rather than yielding a shorter list
 * that a caller could exhaust and call proven.
 *
 * `null` and `[]` are therefore both refusals at the call site, and the caller
 * treats them that way: an empty list from this reading is impossible by
 * construction — the reading exists only when an `ESTABLISHED` entry is present
 * — so producing one would mean this function and the reading disagree, which is
 * not a state to act on.
 */
export function unendedLaunchesOf(
  lease: WriterLaunchSubject,
  raw: unknown,
): readonly UnendedLaunch[] | null {
  if (!provesEveryLaunchContainedUnended(readWriterLaunchLedger(lease, raw))) return null;
  const parsed = WriterLaunchLedgerSchema.safeParse(raw);
  if (!parsed.success) return null;
  return Object.freeze(
    parsed.data.entries
      .filter((entry): entry is EstablishedLaunch => entry.state === 'ESTABLISHED')
      .map((entry) =>
        Object.freeze({
          generation: entry.generation,
          helperPid: entry.helperPid,
          childPid: entry.childPid,
        }),
      ),
  );
}

/** Domain separation, so this digest can never collide with another one. */
const BINDING_LABEL = 'agent-orchestrator/writer-launch-ledger/v1';

/**
 * The binding digest for one ledger against one lease.
 *
 * Every field is fed in by name rather than by serialising the object, for the
 * reason `containmentBinding` gives: `JSON.stringify` would make the digest
 * depend on key order and would silently start or stop covering a field
 * somebody added. That applies to the entries too, so each entry is flattened
 * here field by field.
 *
 * The test file asserts a detected per-field mutation for nine of a contained
 * entry's twelve, and the three it does not are the three that cannot be mutated
 * independently — stated rather than left to look like coverage. `state` is
 * covered by its own case; `verifiedInJob` is a `z.literal(true)`, so there is no
 * other value to try; and `generation` is determined *positionally* by the 1..N
 * check in {@link readWriterLaunchLedger}, which refuses any edit to it as
 * `MALFORMED` before this digest is consulted at all.
 *
 * `state` is fed in explicitly and first among an entry's fields. A digest that
 * covered only the value fields would let `PENDING` be relabelled `CONTAINED`
 * without recomputation — which is the single edit this whole format exists to
 * refuse.
 */
export function writerLaunchBinding(
  lease: Pick<WriterLaunchSubject, 'leaseKey' | 'ownerNonce'>,
  payload: WriterLaunchLedgerPayload,
): string {
  const entries = payload.entries.map((entry) => {
    if (entry.state === 'PENDING') {
      return [entry.generation, entry.state, entry.writerId, entry.openedAt];
    }
    // The eleven fields the two containment-carrying states share, in one place
    // rather than two lists that could drift apart. `state` is among them and
    // is fed in first: a digest that covered only the value fields would let
    // `ESTABLISHED` be relabelled `CONTAINED` without recomputation, and that
    // single edit would skip the liveness proof the weaker state owes.
    const common = [
      entry.generation,
      entry.state,
      entry.writerId,
      entry.openedAt,
      entry.helperPid,
      entry.childPid,
      entry.mode,
      entry.verifiedInJob,
      entry.assignedAtCreation,
      entry.launchDigest,
      entry.attestedAt,
    ];
    // The twelfth differs by state and is not interchangeable: `establishedAt`
    // is when the kernel confirmed membership and `confirmedAt` is when the
    // launch was seen to end. Hashing them into the same slot without the
    // `state` above would make the two entries collide.
    return [...common, entry.state === 'ESTABLISHED' ? entry.establishedAt : entry.confirmedAt];
  });
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        lease.leaseKey,
        lease.ownerNonce,
        payload.ledgerVersion,
        payload.ownerPid,
        payload.runId,
        payload.historyComplete,
        entries,
      ]),
    )
    .digest('hex');
}

/**
 * Reads the launch history found beside a lease. Never throws.
 *
 * The order of the checks is the contract, and it is the same shape
 * `readContainmentEvidence` uses: each step can only reach a *worse* answer than
 * the one after it, so nothing later can rescue an earlier refusal.
 *
 * `raw` is whatever was at the ledger's path — `undefined` when there was
 * nothing, and any parsed value at all otherwise. Judging it is this function's
 * job and nobody else's, and there is deliberately no arm that turns a value it
 * cannot read into a value nobody wrote.
 */
export function readWriterLaunchLedger(
  lease: WriterLaunchSubject,
  raw: unknown,
): WriterLaunchReading {
  if (raw === undefined) return 'ABSENT';

  // The version before the shape, and from the raw value, for the reason
  // `readContainmentEvidence` gives: a ledger from a future build will not
  // satisfy this build's strict schema, and reporting it as `MALFORMED` would
  // hide the one fact an operator needs.
  const declared: unknown =
    typeof raw === 'object' && raw !== null
      ? (raw as { ledgerVersion?: unknown }).ledgerVersion
      : undefined;
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) {
    if (declared !== WRITER_LAUNCH_LEDGER_VERSION) return 'UNSUPPORTED_VERSION';
  }

  const parsed = WriterLaunchLedgerSchema.safeParse(raw);
  if (!parsed.success) return 'MALFORMED';
  const ledger = parsed.data;

  // Belt and braces against the arm above being loosened: the schema accepts any
  // positive version so a future ledger stays *readable*, so this build must
  // state its own requirement where the schema cannot be edited out from under
  // it.
  if (ledger.ledgerVersion !== WRITER_LAUNCH_LEDGER_VERSION) return 'UNSUPPORTED_VERSION';

  // The generations must be exactly 1..N, in order. A gap is not a history with
  // a missing page, it is a history somebody has edited — and the edit that
  // matters is *deleting a pending entry*, which is precisely how an unproven
  // launch would be made to disappear. Refused as `MALFORMED` before the binding
  // is even consulted, because a well-bound gap is still not a history.
  for (let index = 0; index < ledger.entries.length; index += 1) {
    if (ledger.entries[index]?.generation !== index + 1) return 'MALFORMED';
  }

  const { binding, ...payload } = ledger;
  if (writerLaunchBinding(lease, payload) !== binding) return 'NOT_THIS_LEASE';

  // The two agreement checks, which the digest does not imply: it covers the
  // ledger's *own* owner and run, not the lease's, so a perfectly bound ledger
  // describing another run is still not this lease's history.
  if (ledger.ownerPid !== lease.ownerPid) return 'NOT_THIS_RUN';
  if (ledger.runId !== lease.runId) return 'NOT_THIS_RUN';

  if (!ledger.historyComplete) return 'HISTORY_INCOMPLETE';
  // `PENDING` first, and it dominates: a history with one announced launch that
  // never reached the kernel's confirmation is unproven whatever else is in it.
  // Reading the three states in any other order would let a later `ESTABLISHED`
  // entry describe a history that still hides an unaccounted-for launch.
  if (ledger.entries.some((entry) => entry.state === 'PENDING')) return 'LAUNCH_UNPROVEN';
  if (ledger.entries.some((entry) => entry.state === 'ESTABLISHED')) {
    return 'LAUNCHES_CONTAINED_SOME_UNENDED';
  }
  return 'ALL_LAUNCHES_CONTAINED';
}

/**
 * The parsed ledger, when it is one this build may extend. `null` otherwise.
 *
 * Separate from {@link readWriterLaunchLedger} on purpose: the reading answers
 * "may a recovery build on this", and this answers "may the next launch be
 * appended to this". They are different questions with different safe answers —
 * a `HISTORY_INCOMPLETE` or `LAUNCH_UNPROVEN` ledger is not a proof and is
 * absolutely still the history to append to, and appending to it is the only way
 * an unproven launch stays visible.
 */
export function extendableWriterLaunchLedger(
  lease: WriterLaunchSubject,
  raw: unknown,
): WriterLaunchLedger | null {
  const reading = readWriterLaunchLedger(lease, raw);
  if (
    reading !== 'ALL_LAUNCHES_CONTAINED' &&
    // Extendable for the same reason `LAUNCH_UNPROVEN` is: a run whose first
    // writer is still running is exactly the run that starts a second one, and
    // refusing to append here would make the *next* launch unrecordable — which
    // `beginWriterLaunch` answers by discarding the whole history, silently
    // costing this lease the recoverability this state exists to give it.
    reading !== 'LAUNCHES_CONTAINED_SOME_UNENDED' &&
    reading !== 'LAUNCH_UNPROVEN' &&
    reading !== 'HISTORY_INCOMPLETE'
  ) {
    return null;
  }
  const parsed = WriterLaunchLedgerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
