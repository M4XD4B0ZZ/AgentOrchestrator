/**
 * Real execution-lease evidence for tests (V2-07L).
 *
 * ── Why this helper exists at all ──────────────────────────────────────────
 *
 * `ExecutionLeaseEvidence` is opaque, so a suite cannot write one down — and the
 * tempting workaround, `{} as unknown as ExecutionLeaseEvidence`, is forbidden
 * here for exactly the reason `helpers/auth-evidence.ts` forbids its own: a suite
 * that fabricates the artefact has restored the hole the type exists to close,
 * and would keep passing after a regression that made the real acquire hand out
 * nothing.
 *
 * So this fabricates nothing. It performs the **real** exclusive create through
 * the **real** entry point, and hands back what that produced. A test that cannot
 * take the lease fails loudly rather than running unleased.
 *
 * The one legitimate use of a cast is a test whose *subject* is the forgery.
 * That belongs in `tests/v2-07l-execution-lease.test.ts`, beside the claim it
 * disproves, not here.
 *
 * ── One holder per process, which is also the truth ────────────────────────
 *
 * Acquisition is memoised per lease path. Without it, a suite whose `deps()`
 * helper is called twice in one test would refuse itself the second time — and
 * rightly so, because a second acquisition in one repository is precisely what
 * the lease forbids. Memoising models the real shape of an invocation: one
 * process, one lease, held for the duration.
 */

import type { ExecutionLeaseEvidence } from '../../src/core/execution-lease-evidence.js';
import {
  acquireRepositoryExecutionLease,
  deriveExecutionLeaseLocation,
  releaseRepositoryExecutionLease,
  type ExecutionLeaseAuthority,
  type LeaseRepository,
} from '../../src/lease/execution-lease.js';

const held = new Map<string, ExecutionLeaseEvidence>();

/**
 * The lease for `repository`, acquired for real and reused within this process.
 *
 * Throws rather than returning something unusable: a suite that silently ran
 * without the lease would be testing the refusal path while claiming to test the
 * permitted one.
 */
export function leaseFor(repository: LeaseRepository): ExecutionLeaseEvidence {
  const location = deriveExecutionLeaseLocation(repository);
  if (!location.ok) {
    throw new Error(`lease helper could not derive a location: ${location.code}`);
  }

  const existing = held.get(location.path);
  if (existing !== undefined) return existing;

  const acquired = acquireRepositoryExecutionLease(
    repository,
    { runId: null, blockId: null },
    { now: () => new Date().toISOString() },
  );
  if (!acquired.ok) {
    throw new Error(`lease helper could not take the lease: ${acquired.code}`);
  }

  held.set(location.path, acquired.evidence);
  return acquired.evidence;
}

/**
 * A real lease plus the repository it authorises, for `advanceTaskState`.
 *
 * Every durable transition now requires one (V2-07L / B), so a suite that
 * advances state needs a genuine lease rather than a stand-in. `gitCommonDir`
 * defaults to the root itself, which is what a scratch directory standing in for
 * a repository can honestly offer: the lease only needs a real directory it may
 * create a file in, and using the root keeps each suite's lease inside its own
 * temporary space.
 */
export function leaseAuthorityAt(root: string, id = 'test-fixture'): ExecutionLeaseAuthority {
  const repository = { gitCommonDir: root, root, id };
  return { repository, evidence: leaseFor(repository) };
}

/** The same, for a suite that already holds a resolved repository. */
export function leaseAuthorityFor(repository: LeaseRepository): ExecutionLeaseAuthority {
  return { repository, evidence: leaseFor(repository) };
}

/**
 * Gives back every lease this helper took. Safe from `afterEach`/`afterAll`.
 *
 * Fixture removal would take the files with it anyway — a lease lives inside the
 * fixture's own Git directory — so this is about the *process*: leaving entries
 * in the map would hand a later test a stale artefact for a path a new fixture
 * has since reused.
 */
export function releaseTestLeases(): void {
  for (const evidence of held.values()) releaseRepositoryExecutionLease(evidence);
  held.clear();
}
