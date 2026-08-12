/**
 * The durable record of one held execution lease.
 *
 * ── What this document is for, and what it is not ──────────────────────────
 *
 * The lease's authority comes from **the exclusive create having succeeded**,
 * and from nothing in here. That is the whole reason this file is short: every
 * field below exists so that a human — or a later reconciliation — can say
 * *whose* lease this is, and not one of them is what makes it a lease.
 *
 * The distinction is the same one V2-07 had to learn about its ledger, one
 * level down. A `repositoryId`, a `runId` and an `ownerPid` explain the claim;
 * they are supplied by the caller and a caller can supply anything. Deriving
 * authority from them would mean a lease could be *described* into existence,
 * which is precisely what the atomic create exists to prevent.
 *
 * `ownerNonce` is the one field with a job beyond diagnosis, and even that is an
 * identity rather than an authority: it is how the acquiring process later tells
 * *its own* lease from a successor's occupying the same path. See
 * `core/internal/execution-lease-evidence.ts` for why it is not a secret.
 *
 * ── Why the key is recorded at all ─────────────────────────────────────────
 *
 * `leaseKey` is the normalised Git common directory the lease was taken for, and
 * the file already lives inside that directory — so recording it looks
 * redundant. It is the same guard `block-store.ts` puts on `repositoryRoot`: a
 * document found *by* one identity that carries another has been copied, and a
 * lease restored from a backup into a different clone would otherwise read as
 * that clone's own. Held to its location on every read.
 */

import { z } from 'zod';

/** Contract version of the lease document. Bump on any breaking shape change. */
export const EXECUTION_LEASE_SCHEMA_VERSION = 1;

/** 32 random bytes, hex-encoded. */
const NONCE = /^[0-9a-f]{64}$/;

/**
 * Restated rather than imported from `block/block-ledger.ts`.
 *
 * The two documents are written by different modules to different places and
 * neither may quietly loosen the other; sharing the pattern would create a
 * single edit that changes both contracts at once. Same reasoning
 * `block-store.ts` gives for restating the compare-and-swap.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const ExecutionLeaseObjectSchema = z
  .object({
    schemaVersion: z.int().positive(),
    /**
     * The local Git administrative identity this lease is for: the normalised,
     * absolute `git-common-dir`.
     *
     * Not the profile's `repositoryId`, and V2-07 settled why. Two clones of one
     * remote declare the same id and are two independent local writers; two
     * worktrees of one clone declare one id and are one. Only the common
     * directory separates those cases, and it is the same information that
     * proved worktree membership in V2-06A.
     */
    leaseKey: z.string().min(1),
    /** The checkout the acquiring invocation was pointed at. Diagnostic. */
    repositoryRoot: z.string().min(1),
    /** The profile's declared identity. Diagnostic, and never the key. */
    repositoryId: z.string().min(1).max(64),
    /**
     * The process that took the lease.
     *
     * Diagnostic, and deliberately never authority: an operating system reuses
     * pids, and — measured on this build's spawn path — a dead owner does not
     * prove that no writer survives it. `execution-lease.ts` states what that
     * measurement was and what it licenses.
     */
    ownerPid: z.int().positive(),
    ownerNonce: z.string().regex(NONCE, 'Must be a lease nonce.'),
    acquiredAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    /** The run this lease was taken for, when the caller named one. */
    runId: z.string().min(1).max(128).nullable(),
    /** The block this lease was taken for, when the caller named one. */
    blockId: z.string().min(1).max(128).nullable(),
  })
  .strict();

export const ExecutionLeaseSchema = ExecutionLeaseObjectSchema.superRefine((value, ctx) => {
  if (value.schemaVersion !== EXECUTION_LEASE_SCHEMA_VERSION) {
    ctx.addIssue({
      code: 'custom',
      path: ['schemaVersion'],
      message: `Unsupported schemaVersion ${String(value.schemaVersion)}.`,
    });
  }
});

export type ExecutionLease = z.infer<typeof ExecutionLeaseObjectSchema>;

/** Non-throwing parse. There is deliberately no throwing variant: every caller
 *  of this contract is deciding whether to refuse, never whether to crash. */
export function safeParseExecutionLease(value: unknown) {
  return ExecutionLeaseSchema.safeParse(value);
}
