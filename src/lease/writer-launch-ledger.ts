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
 *     kernel-confirmed    → generation N replaced by CONTAINED, published
 *     anything else       → generation N is left PENDING, for good
 *
 * The ordering is the whole safety argument, and it only works in one direction.
 * A record written *after* a launch cannot describe a launch that was killed
 * mid-flight; a mark written *before* it can. So the poison goes down first, and
 * a launch whose poison could not be written does not happen at all — see
 * {@link WriterLaunchLedger.historyComplete} for the one escape hatch that
 * exists instead of stopping the run, and why it is still fail-closed.
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
 * this is the file whose reading a removal is gated on. A complete, all-contained
 * ledger proves one thing only: **no process tree started as a writer under this
 * lease can still be running**, because every one of them was created inside a
 * Job Object coupled to the lease owner, and that owner is gone. It says nothing
 * about who may write to the repository. The lease that gets removed on the
 * strength of it is removed as a *dead object*, and the next execution acquires
 * its own authority through the ordinary acquisition path.
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
 */
export const WRITER_LAUNCH_LEDGER_VERSION = 1;

/** Largest history this build will represent. A run cannot reach it. */
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

export const WriterLaunchEntrySchema = z.discriminatedUnion('state', [
  PendingLaunchSchema,
  ContainedLaunchSchema,
]);

export type WriterLaunchEntry = z.infer<typeof WriterLaunchEntrySchema>;
export type PendingLaunch = z.infer<typeof PendingLaunchSchema>;
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
 * What a lease's launch history turned out to be. A closed set of eight, of
 * which **one** licenses a recovery.
 */
export const WRITER_LAUNCH_READINGS = [
  /**
   * A complete history, bound to this lease, in which every launch is proven
   * contained. The only reading that may license removing a stale lease — and
   * only in combination with a dead owner, which this reading says nothing
   * about.
   */
  'ALL_LAUNCHES_CONTAINED',
  /**
   * A complete, well-bound history in which at least one launch is still
   * `PENDING`.
   *
   * The state a killed orchestrator leaves behind while its writer was running,
   * and the state a launch whose confirmation could not be published stays in.
   * It is the format working, not the format failing.
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
  LAUNCH_UNPROVEN: false,
  HISTORY_INCOMPLETE: false,
  ABSENT: false,
  UNSUPPORTED_VERSION: false,
  MALFORMED: false,
  NOT_THIS_LEASE: false,
  NOT_THIS_RUN: false,
});

/** Whether this reading proves every writer launch was contained. Exactly one does. */
export function provesEveryLaunchContained(reading: WriterLaunchReading): boolean {
  return PROVES_EVERY_LAUNCH_CONTAINED[reading] === true;
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
 * here field by field, and a per-field mutation of every one of them is
 * asserted to be detected in the test file.
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
  const entries = payload.entries.map((entry) =>
    entry.state === 'PENDING'
      ? [entry.generation, entry.state, entry.writerId, entry.openedAt]
      : [
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
          entry.confirmedAt,
        ],
  );
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
  if (ledger.entries.some((entry) => entry.state !== 'CONTAINED')) return 'LAUNCH_UNPROVEN';
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
    reading !== 'LAUNCH_UNPROVEN' &&
    reading !== 'HISTORY_INCOMPLETE'
  ) {
    return null;
  }
  const parsed = WriterLaunchLedgerSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
