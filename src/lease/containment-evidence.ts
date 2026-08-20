/**
 * Containment evidence: the durable, versioned record that one lease's writer
 * was started behind the owned process boundary.
 *
 * ── The question this exists to make answerable ────────────────────────────
 *
 * `execution-lease.ts` refuses to take over a stale lease, and its header says
 * why: a dead owner does not prove that no writer survives it. That was
 * measured, not assumed. Owned process containment is the mechanism that can
 * change the answer — a target created inside a Job Object the orchestrator owns
 * dies when the orchestrator dies, because the kernel destroys the job — but only
 * for a writer that **was actually started that way**.
 *
 * So the lease needs to be able to say, durably and per run, "my writer was
 * contained". This module is that statement's format, and nothing else. It does
 * not recover anything, it does not remove or take over any lease, and no caller
 * in this build acts on a reliable reading. It exists so that the slice which
 * does can be built on a record rather than on an assumption.
 *
 * ── Containment is lifetime evidence, never writer authority ───────────────
 *
 * Repeated here because this is the file somebody will read while wiring the
 * recovery that follows. A reliable containment reading says the writer *tree*
 * was bounded by the owner's lifetime. It says nothing about who may write to
 * the repository. Lease fencing remains the authority boundary; this record is
 * an input to a future safety argument, not a permission.
 *
 * ── What the binding digest is, stated exactly ─────────────────────────────
 *
 * {@link ContainmentEvidence.binding} is an **integrity binding, not a message
 * authentication code**, and the difference is worth being blunt about because
 * the reassuring reading of it is wrong.
 *
 * It is a digest over the evidence payload *together with the lease's own
 * identity* — the lease key and the owner nonce. Every input to it is readable
 * in the same file, so an author who can rewrite the lease document can also
 * recompute the digest. It does not withstand that author and it is not offered
 * as though it does.
 *
 * What it does catch is everything short of that, which is the realistic damage:
 *
 *  - evidence copied out of one lease into another — a different key and a
 *    different nonce, so the digest no longer matches;
 *  - a field edited in place without recomputation — the ordinary shape of hand
 *    tampering and of a partial restore;
 *  - a record written by a build that disagrees with this one about what the
 *    payload is.
 *
 * And what catches the case it cannot — a fully recomputed forgery — is not this
 * digest but the two agreement checks below, which compare the evidence against
 * the *rest of the lease document*: a forger who wants a reliable reading has to
 * make the evidence agree with the run and the owner the lease already names, at
 * which point they are asserting something about their own lease rather than
 * stealing somebody else's claim. That is the honest bound, and it is the reason
 * this record may never be read as authority.
 *
 * ── Fail-closed is the whole contract ──────────────────────────────────────
 *
 * Exactly one of the readings below means "there is a reliable containment
 * proof", and every other input this module can meet — a legacy lease with no
 * field at all, a version from a future build, a malformed payload, a
 * transplanted one, one that disagrees with its own lease — reaches one of the
 * other five. There is no default, no "probably", and no arm that turns an
 * unrecognised value into a reassuring one.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Contract version of the containment record. Bump on any change to the payload.
 *
 * Deliberately its own version, separate from `EXECUTION_LEASE_SCHEMA_VERSION`.
 * The lease document's version governs whether the *lease* can be read at all —
 * a bump there locks every older lease out, which is the right severity for a
 * change to who holds a repository and the wrong one for a change to an
 * enrichment. A build that meets an unknown evidence version must still be able
 * to read the lease, report its owner, and refuse the evidence.
 */
export const CONTAINMENT_EVIDENCE_VERSION = 1;

const HEX_64 = /^[0-9a-f]{64}$/;

/** Restated rather than imported, for the reason `lease-document.ts` gives. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The evidence payload.
 *
 * `.strict()`, and `verifiedInJob` is a literal `true` rather than a boolean: a
 * record that says the kernel did not confirm membership is not a weaker piece
 * of evidence, it is a piece of evidence for something else, and the schema
 * refuses to represent it. The mint refuses to produce it either — the two are
 * stated in both places on purpose, because this schema also has to judge
 * records this process did not write.
 */
export const ContainmentEvidenceSchema = z
  .object({
    evidenceVersion: z.int().positive(),
    /** The lease owner the job was coupled to. Must be the lease's own owner. */
    ownerPid: z.int().positive(),
    /** The run this containment was observed for. Must be the lease's own run. */
    runId: z.string().min(1).max(128),
    /** Which agent was contained. `claude` is the productive writer. */
    writerId: z.string().min(1).max(64),
    helperPid: z.int().positive(),
    childPid: z.int().positive(),
    mode: z.string().min(1).max(32),
    verifiedInJob: z.literal(true),
    assignedAtCreation: z.boolean().nullable(),
    launchDigest: z.string().regex(HEX_64, 'Must be a launch digest.'),
    observedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    recordedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    binding: z.string().regex(HEX_64, 'Must be a binding digest.'),
  })
  .strict();

export type ContainmentEvidence = z.infer<typeof ContainmentEvidenceSchema>;

/** The payload without the digest computed over it. */
export type ContainmentEvidencePayload = Omit<ContainmentEvidence, 'binding'>;

/**
 * The lease fields a containment reading is decided against.
 *
 * Stated as its own shape rather than as `ExecutionLease`, for the reason
 * `LeaseRepository` is: these are the only five fields read, and it keeps this
 * module free of an import cycle with the document that carries it.
 */
export interface ContainmentSubject {
  readonly leaseKey: string;
  readonly ownerNonce: string;
  readonly ownerPid: number;
  readonly runId: string | null;
  readonly containment?: unknown;
}

/**
 * What a lease's containment field turned out to be. A closed set of six, of
 * which **one** means "reliable".
 */
export const CONTAINMENT_READINGS = [
  /** A well-formed, current-version record, bound to this lease and agreeing
   *  with it. The only reading a later recovery may build on. */
  'CONTAINED',
  /** No containment field at all: a legacy lease, or one whose writer never
   *  ran behind the boundary. Conservative by construction — absence of a
   *  proof, never a proof of absence. */
  'ABSENT',
  /** A record this build does not know how to read. Refused, and the lease
   *  itself stays readable. */
  'UNSUPPORTED_VERSION',
  /** Something is there and is not a containment record this build declares. */
  'MALFORMED',
  /** Well-formed, and the binding says it belongs to a different lease or has
   *  been edited since it was written. */
  'NOT_THIS_LEASE',
  /** Well-formed and correctly bound, and it describes a different run, owner
   *  or writer than the one being asked about. */
  'NOT_THIS_RUN',
] as const;

export type ContainmentReading = (typeof CONTAINMENT_READINGS)[number];

/**
 * Which readings license a later recovery to treat containment as proven.
 *
 * A total table rather than an equality test, and the difference matters: a
 * seventh reading added to the union above stops the build here rather than
 * falling into whatever `=== 'CONTAINED'` happens to answer for it. Completeness
 * is not correctness, though — `satisfies` would accept `true` in every row — so
 * every entry is asserted by value in `tests/v3-04-lease-containment.test.ts`.
 */
const RELIABLE: Readonly<Record<ContainmentReading, boolean>> = Object.freeze({
  CONTAINED: true,
  ABSENT: false,
  UNSUPPORTED_VERSION: false,
  MALFORMED: false,
  NOT_THIS_LEASE: false,
  NOT_THIS_RUN: false,
});

/** Whether this reading is a reliable containment proof. Exactly one is. */
export function isReliableContainment(reading: ContainmentReading): boolean {
  return RELIABLE[reading] === true;
}

/** Domain separation, so this digest can never collide with another one. */
const BINDING_LABEL = 'agent-orchestrator/containment-evidence/v1';

/**
 * The binding digest for one payload against one lease.
 *
 * The inputs are listed one by one rather than serialised from the object, and
 * that is deliberate: `JSON.stringify(payload)` would make the digest depend on
 * key order, and would silently start covering — or stop covering — a field
 * added to the payload without anybody deciding it should. Every field of the
 * payload is here, and adding one to {@link ContainmentEvidenceSchema} without
 * adding it here leaves it unbound, which is why the test file asserts a
 * per-field mutation is detected for each of them.
 */
export function containmentBinding(
  lease: Pick<ContainmentSubject, 'leaseKey' | 'ownerNonce'>,
  payload: ContainmentEvidencePayload,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        BINDING_LABEL,
        lease.leaseKey,
        lease.ownerNonce,
        payload.evidenceVersion,
        payload.ownerPid,
        payload.runId,
        payload.writerId,
        payload.helperPid,
        payload.childPid,
        payload.mode,
        payload.verifiedInJob,
        payload.assignedAtCreation,
        payload.launchDigest,
        payload.observedAt,
        payload.recordedAt,
      ]),
    )
    .digest('hex');
}

/**
 * Who a containment record is expected to be about.
 *
 * Optional at the call site, because the two readers ask different questions.
 * An inspection has only the lease in hand and asks "is there a reliable proof
 * for whatever this lease is", while a caller that just ran a writer knows
 * exactly which run and which agent it wants the answer for. The lease document
 * records no writer of its own, so `writerId` is the one field that *can only*
 * be checked against an expectation — and it is bound by the digest, so a
 * caller with no expectation is still protected against it having been edited.
 */
export interface ContainmentExpectation {
  readonly runId: string;
  readonly writerId: string;
  readonly ownerPid: number;
}

/**
 * Reads the containment evidence a lease document carries. Never throws.
 *
 * The order of the checks is the contract, and it is the same shape the writer
 * boundary uses: each step can only reach a *worse* answer than the one after
 * it, so nothing later can rescue an earlier refusal.
 */
export function readContainmentEvidence(
  lease: ContainmentSubject,
  expected?: ContainmentExpectation,
): ContainmentReading {
  const raw: unknown = lease.containment;
  // A legacy lease has no key at all. `null` is treated the same way rather
  // than as a malformed record, because it is what a build that clears the
  // field would leave, and "nothing is claimed here" is exactly what `ABSENT`
  // means.
  if (raw === undefined || raw === null) return 'ABSENT';

  // The version is read *before* the shape, and from the raw value. A record
  // written by a future build will not satisfy this build's strict schema — that
  // is what a version bump is for — so asking the schema first would report
  // every future record as `MALFORMED` and hide the one fact an operator needs:
  // this lease was written by something newer.
  const declared: unknown =
    typeof raw === 'object' && raw !== null
      ? (raw as { evidenceVersion?: unknown }).evidenceVersion
      : undefined;
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) {
    if (declared !== CONTAINMENT_EVIDENCE_VERSION) return 'UNSUPPORTED_VERSION';
  }

  const parsed = ContainmentEvidenceSchema.safeParse(raw);
  if (!parsed.success) return 'MALFORMED';
  const evidence = parsed.data;

  // Belt and braces against the version arm above being loosened: the schema
  // accepts any positive version so that a future record stays *readable*, so
  // this build must state its own version requirement somewhere the schema
  // cannot be edited out from under it.
  if (evidence.evidenceVersion !== CONTAINMENT_EVIDENCE_VERSION) return 'UNSUPPORTED_VERSION';

  const { binding, ...payload } = evidence;
  if (containmentBinding(lease, payload) !== binding) return 'NOT_THIS_LEASE';

  // The two agreement checks. These are what a fully recomputed digest still has
  // to satisfy, and they are not implied by it: the digest covers the evidence's
  // *own* `ownerPid` and `runId`, not the lease's, so a record that names a
  // different run can be perfectly bound and is still not this lease's proof.
  if (lease.runId === null || evidence.runId !== lease.runId) return 'NOT_THIS_RUN';
  if (evidence.ownerPid !== lease.ownerPid) return 'NOT_THIS_RUN';

  if (expected !== undefined) {
    if (
      evidence.runId !== expected.runId ||
      evidence.writerId !== expected.writerId ||
      evidence.ownerPid !== expected.ownerPid
    ) {
      return 'NOT_THIS_RUN';
    }
  }

  return 'CONTAINED';
}
