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
      'Another orchestrator invocation holds the execution lease for this repository, and\n' +
      '  its owner process is running. Nothing was started. Wait for it, or stop it.',
    STALE_LEASE_RECOVERY_UNSAFE:
      'A lease is present and this build cannot prove it is safe to take: its owner process\n' +
      '  is not observably running, or the record cannot be read. It is deliberately not\n' +
      '  taken over - a dead owner does not prove that no agent process survived it. Run\n' +
      '  `agent-loop lease status`, which reports what is there and what clearing it would\n' +
      '  require of you. There is no command that clears a lease, and no --force.',
    LEASE_LOCATION_UNSUITABLE:
      'No lease location could be derived for this repository, so no exclusive claim could\n' +
      '  be made. Nothing was started.',
    REPOSITORY_RECORD_INCOHERENT:
      'This repository record does not describe one repository: its root and its Git common\n' +
      '  directory belong to different places, so a lease taken for it would guard the wrong\n' +
      '  one. Nothing was started. This is a defect in whatever built the record rather than\n' +
      '  a state of the repository - a working tree Git itself resolves is accepted, including\n' +
      '  a submodule, a linked worktree and a separate Git directory.',
    LEASE_WRITE_FAILED:
      'The lease claim could not be recorded, so it was given back. Nothing was started.',
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
    ALIVE: 'the owner process exists. This lease is not stale.',
    NOT_FOUND:
      'no process with that id exists. That is not proof that nothing of that run survives\n' +
      '  - process ids are reused, and an agent process can outlive the orchestrator that\n' +
      '  started it - so it is never taken over automatically.',
    UNDETERMINED: 'whether the owner exists could not be established.',
    UNKNOWABLE: 'no owner is recorded, so nothing can be said about one.',
  });

/** The `lease status` report. The only place a lease path is printed. */
export function renderLeaseStatus(inspection: LeaseInspection): string {
  const lines = [
    '',
    line('Lease', inspection.state),
    `  ${LEASE_STATE_SENTENCES[inspection.state]}`,
    line('Path', inspection.path === '' ? 'not derivable' : inspection.path),
    line('Revision', inspection.revision ?? 'none'),
    line('Owner pid', inspection.ownerPid === null ? 'none' : String(inspection.ownerPid)),
    line('Liveness', inspection.liveness),
    `  ${LEASE_LIVENESS_SENTENCES[inspection.liveness]}`,
    line('Run', inspection.runId ?? 'none'),
    line('Block', inspection.blockId ?? 'none'),
    line('Acquired', inspection.acquiredAt ?? 'unknown'),
  ];

  // Recovery, and it is deliberately **not** a command.
  //
  // This build ships no way to clear a lease other than its owner releasing it.
  // An attended break existed here and was withdrawn: three adversarial review
  // rounds each found a fresh way for it to destroy an authority somebody had
  // legitimately acquired — an ABA on the removal, then a placeholder that
  // reintroduced the same defect one level up. Shipping a destructive command
  // that has never survived a review is worse than shipping none, so what is
  // offered instead is an instruction to a human, stated as being outside what
  // the tool guarantees.
  //
  // Printed only when the recorded owner cannot be found. For a running owner
  // there is nothing to recover from, and telling an operator how to delete the
  // file is how a healthy run gets cleared.
  if (
    (inspection.state === 'HELD' || inspection.state === 'UNPARSEABLE') &&
    inspection.liveness === 'NOT_FOUND'
  ) {
    lines.push(
      '',
      '  This lease records an owner that is not running. Clearing it is a manual step and',
      '  is OUTSIDE what this build guarantees - there is no command, and no --force:',
      '',
      '    1. establish that no orchestrator process and no agent process of that run is',
      '       still alive. A process id that is gone does not prove this: an agent can',
      '       outlive the orchestrator that started it.',
      '    2. re-run `agent-loop lease status` and confirm it still reports what you just',
      '       read - in particular the same revision.',
      '    3. delete the file at the path above, deliberately - and only if step 2 still',
      '       showed the same revision. Between reading and deleting, a lease you have',
      '       just cleared can be legitimately re-acquired by a new run, and deleting',
      '       then destroys the authority of that run. That race is exactly why this is',
      '       NOT a command.',
      '',
      '  A supported attended recovery flow is a separate piece of work; until it exists,',
      '  step 1 is a judgement this tool cannot make for you.',
    );
  }

  return `${lines.join('\n')}\n\n`;
}

/** The refusal an execution command prints when it could not take the lease. */
export function renderLeaseRefusal(code: LeaseAcquireFailureCode): string {
  return `${['', line('Lease', code), `  ${LEASE_ACQUIRE_SENTENCES[code]}`, ''].join('\n')}\n`;
}
