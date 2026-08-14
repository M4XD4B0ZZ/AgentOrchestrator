/**
 * How the execution lease is reported to an operator.
 *
 * Three commands need this vocabulary — `run --attended` and `release
 * --attended` when they are refused the lease, and `lease` when it is the
 * subject — so it lives once. A second copy would be free to drift, and the
 * whole value of a refusal here is that it says the same thing whichever command
 * produced it.
 *
 * Every sentence is a literal written in this repository. No path, no host name
 * and no exception text is interpolated into a refusal (AO-002) — except the
 * lease path itself on the `lease status` report, which is the one place an
 * operator has explicitly asked *where* the lease is and cannot act without it.
 *
 * The printed vocabulary is **ASCII only**, and `tests/v2-07l-execution-lease.test.ts`
 * holds it there. This repository has twice had text damaged by a re-encoding
 * pass, and an operator-facing refusal is the worst place for that. The comments
 * are prose and are not held to it.
 */

import type { LeaseAcquireFailureCode, LeaseInspection } from '../lease/execution-lease.js';
import { line } from './render-attended-run.js';

/**
 * One static sentence per acquisition refusal. Closed, and total by type.
 *
 * The two that matter read differently on purpose. `LEASE_HELD` is a normal
 * condition an operator waits out; `STALE_LEASE_RECOVERY_UNSAFE` is one they
 * have to decide about, and the sentence says what the decision is and what it
 * costs — because the alternative, an automatic takeover, is the thing this
 * whole slice refuses to do.
 */
export const LEASE_ACQUIRE_SENTENCES: Readonly<Record<LeaseAcquireFailureCode, string>> =
  Object.freeze({
    LEASE_HELD:
      'Another orchestrator invocation holds the execution lease for this repository, and a\n' +
      '  process with the recorded id exists. Nothing was started. Wait for it. Do not stop\n' +
      '  that process on the strength of this: process ids are reused, so the one running\n' +
      '  now need not be the owner, and this build cannot tell you which it is.',
    STALE_LEASE_RECOVERY_UNSAFE:
      'A lease is present and this build cannot prove it is safe to take: its owner process\n' +
      '  is not observably running, or the record cannot be read. It is deliberately not\n' +
      '  taken over - a dead owner does not prove that no agent process survived it. Run\n' +
      '  `agent-loop lease status` to see what is there. This build has no command that\n' +
      '  removes it: an attended break was shipped twice and withdrawn twice, because for a\n' +
      '  record left by a crash there is no fact an operator can be shown that still names\n' +
      '  the same object once the removal runs. Clearing it is a decision outside this tool.',
    LEASE_LOCATION_UNSUITABLE:
      'No lease location could be derived for this repository, so no exclusive claim could\n' +
      '  be made. Nothing was started.',
    LEASE_LOCATION_NETWORK_UNSUPPORTED:
      "This repository's Git common directory is on a UNC or network path, which is outside\n" +
      '  the V2 support contract. Nothing was started and nothing was created. V2 is built and\n' +
      '  verified for one configuration: Windows, Node 22 or 24, and a repository whose Git\n' +
      '  common directory is on a local NTFS volume. Move the repository, or its Git common\n' +
      '  directory, onto a local volume. Note what this refusal does not claim: a repository\n' +
      '  reached through a drive letter is accepted, and this build cannot tell whether such a\n' +
      '  letter is a mapped network share.',
    LEASE_LOCATION_DEVICE_NAMESPACE:
      "This repository's Git common directory is a Windows device path (\\\\.\\...), which is\n" +
      '  not a filesystem location a lease can be kept in. Nothing was started and nothing was\n' +
      '  created. This is reported apart from the network refusal because it is a different\n' +
      '  thing: a device path is not network storage.',
    REPOSITORY_RECORD_INCOHERENT:
      'This repository record does not describe one repository: its root and its Git common\n' +
      '  directory belong to different places, so a lease taken for it would guard the wrong\n' +
      '  one. Nothing was started. This is a defect in whatever built the record rather than\n' +
      '  a state of the repository - a working tree Git itself resolves is accepted, including\n' +
      '  a submodule, a linked worktree and a separate Git directory.',
    LEASE_WRITE_FAILED:
      'The lease claim could not be recorded, so it was given back. Nothing was started.',
    LEASE_FILESYSTEM_UNSUPPORTED:
      'This repository is on a filesystem that cannot carry an execution lease, so nothing\n' +
      '  was started and nothing was created. The lease is published by hard-linking a\n' +
      '  finished record into place, and a record this build may not remove is put back the\n' +
      '  same way; where the filesystem refuses to link, neither is possible. This build used\n' +
      '  to fall back to an exclusive create here. That fallback is withdrawn: it produced a\n' +
      '  lease whose release and rollback could not be carried out safely, and reviews\n' +
      '  reproduced it destroying a claim another invocation had legitimately taken. A named\n' +
      '  unsupported filesystem is the honest answer. FAT, exFAT and some network or\n' +
      '  container-mounted paths are the usual causes; move the repository, or its Git common\n' +
      '  directory, onto a local filesystem that supports hard links. The reason line carries\n' +
      '  the errno the link was refused with.',
  });

/** One static sentence per inspected state. Closed, and total by type. */
export const LEASE_STATE_SENTENCES: Readonly<Record<LeaseInspection['state'], string>> =
  Object.freeze({
    FREE: 'No invocation owns this repository. The next one may take the lease.',
    HELD: 'An invocation owns this repository.',
    UNPARSEABLE:
      'Something is at the lease path and is not a lease this build can read. It is treated\n' +
      '  as held, never as free: this is what a run that died between claiming the lease and\n' +
      '  recording it leaves behind.',
    UNREADABLE: 'Something is at the lease path and could not be read at all.',
    LOCATION_UNSUITABLE: 'No lease location could be derived for this repository.',
    LOCATION_NETWORK_UNSUPPORTED:
      'This repository is on a UNC or network path, which V2 does not support, so it has no\n' +
      '  lease location. This is a refusal, not a failure to understand the path.',
    LOCATION_DEVICE_NAMESPACE:
      'This repository path is in the Windows device namespace, which is not a place a lease\n' +
      '  can be kept.',
  });

/**
 * What the recorded owner liveness means — and, in every case, what it does not.
 *
 * Spelled out because an operator reading "not running" is one step from
 * concluding "so nothing of that run survives", which is exactly the inference
 * the measurement in `lease/execution-lease.ts` refuses.
 */
export const LEASE_LIVENESS_SENTENCES: Readonly<Record<LeaseInspection['liveness'], string>> =
  Object.freeze({
    ALIVE:
      'a process with that id exists. That is not proof it is the owner - process ids are\n' +
      '  reused - so it is a reason to wait, never a reason to act. Treat this lease as held.',
    NOT_FOUND:
      'no process with that id exists. That is not proof that nothing of that run survives\n' +
      '  - process ids are reused, and an agent process can outlive the orchestrator that\n' +
      '  started it - so it is never taken over automatically.',
    UNDETERMINED: 'whether the owner exists could not be established.',
    UNKNOWABLE: 'no owner is recorded, so nothing can be said about one.',
  });

/**
 * The `lease status` report. The only place a lease path is printed.
 *
 * Diagnostic, and it ends where the observations end. It used to take a
 * `breakable` flag and, when that was true, print a ready-made
 * `lease break --expected-revision … --expected-object …` line under the heading
 * "This lease is recoverable". That is gone with the break itself, and the flag
 * with it — but the renderer's part deserves its own note, because it was not
 * merely a caller of the unsafe operation.
 *
 * For the crash-window record the printed revision is `sha256("")`, a constant
 * every empty file shares. The report filled that constant into the command for
 * the operator, and then told them "Nothing is removed on a revision you did not
 * see" — a guarantee that is vacuous for exactly the class of lease the command
 * was being offered for. It also asserted "the revision is the lease's identity",
 * which contradicts `leaseObjectIdentity`'s own reasoning that content cannot
 * identify an object whose content is nothing. So the tool supplied the fact that
 * made the authorisation empty, and described it as the fact that made it safe.
 *
 * That is why a report may state what was observed and may not offer a
 * destructive next step: an operator cannot audit a guarantee the renderer is
 * asserting on the tool's behalf.
 */
export function renderLeaseStatus(inspection: LeaseInspection): string {
  const lines = [
    '',
    line('Lease', inspection.state),
    `  ${LEASE_STATE_SENTENCES[inspection.state]}`,
    line('Path', inspection.path === '' ? 'not derivable' : inspection.path),
    line('Revision', inspection.revision ?? 'none'),
    // The object, beside the digest, because for one class of lease the digest
    // is a constant: a crash-window record is empty, and every empty file hashes
    // the same. Reported so an operator can tell two records apart by eye across
    // two runs of this command; `none` means this platform reports no usable
    // identity. Neither value authorises anything — nothing in this build removes
    // a lease — and the pair being insufficient to authorise a removal is what
    // withdrew the break.
    line('Object', inspection.objectId ?? 'none'),
    line('Owner pid', inspection.ownerPid === null ? 'none' : String(inspection.ownerPid)),
    line('Liveness', inspection.liveness),
    `  ${LEASE_LIVENESS_SENTENCES[inspection.liveness]}`,
    line('Run', inspection.runId ?? 'none'),
    line('Block', inspection.blockId ?? 'none'),
    line('Acquired', inspection.acquiredAt ?? 'unknown'),
  ];

  return `${lines.join('\n')}\n\n`;
}

/** The refusal an execution command prints when it could not take the lease. */
export function renderLeaseRefusal(code: LeaseAcquireFailureCode): string {
  return `${['', line('Lease', code), `  ${LEASE_ACQUIRE_SENTENCES[code]}`, ''].join('\n')}\n`;
}

