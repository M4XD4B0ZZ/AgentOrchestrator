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

import type {
  LeaseAcquireFailureCode,
  LeaseBreakCode,
  LeaseInspection,
} from '../lease/execution-lease.js';
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
      '  `agent-loop lease status` and, if you are certain nothing is running, clear it with\n' +
      '  `agent-loop lease break --attended`.',
    LEASE_LOCATION_UNSUITABLE:
      'No lease location could be derived for this repository, so no exclusive claim could\n' +
      '  be made. Nothing was started.',
    LEASE_WRITE_FAILED:
      'The lease claim could not be recorded, so it was given back. Nothing was started.',
  });

/** One static sentence per break outcome. Closed, and total by type. */
export const LEASE_BREAK_SENTENCES: Readonly<Record<LeaseBreakCode, string>> = Object.freeze({
  BROKEN:
    'The lease you identified was removed. This repository has no execution owner now, and\n' +
    '  the next invocation may take one.',
  LEASE_ABSENT: 'There is no lease to break. This repository already has no execution owner.',
  LEASE_CHANGED:
    'The lease on disk is not the one this break named. Nothing was removed: another\n' +
    '  invocation has taken, released or replaced it since you looked. Inspect it again.',
  LEASE_OWNER_ALIVE:
    'The recorded owner process is running, so this is not a stale lease. Nothing was\n' +
    '  removed - an operator cannot assert a live process away.',
  LEASE_OWNER_LIVENESS_UNDETERMINED:
    'Whether the recorded owner is running could not be established, so nothing was\n' +
    '  removed. A refusal to answer is never read here as an absence.',
  OWNER_PID_REQUIRED:
    'This lease records an owner, so a break must name it back with --owner-pid. Nothing\n' +
    '  was removed.',
  OWNER_PID_MISMATCH:
    'The owner named does not match the one this lease records. Nothing was removed.',
  OWNER_PID_UNEXPECTED:
    'This lease records no owner - it cannot be read - so --owner-pid claims something you\n' +
    '  did not observe. Identify it by --expected-revision alone. Nothing was removed.',
  LEASE_UNREADABLE: 'The lease path could not be read at all. Nothing was removed.',
  LEASE_LOCATION_UNSUITABLE:
    'No lease location could be derived for this repository. Nothing was removed.',
  LEASE_REMOVE_FAILED:
    'Every check held and the removal itself failed. The lease is still there.',
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

  // The exact command that would clear this lease, with the values already
  // filled in. Not a convenience: the whole point of `--expected-revision` is
  // that an operator names back what they read, and a report that made them
  // retype a 64-character digest would be a report that trains them to skip it.
  if (inspection.state === 'HELD' || inspection.state === 'UNPARSEABLE') {
    lines.push(
      '',
      '  To clear a lease you are certain is stale, name back exactly what you just read:',
      '    agent-loop lease break --repository <abs path> --attended \\',
      `      --expected-revision ${inspection.revision ?? '<revision>'}${
        inspection.ownerPid === null ? '' : ` \\\n      --owner-pid ${String(inspection.ownerPid)}`
      }`,
    );
  }

  return `${lines.join('\n')}\n\n`;
}

/** The refusal an execution command prints when it could not take the lease. */
export function renderLeaseRefusal(code: LeaseAcquireFailureCode): string {
  return `${['', line('Lease', code), `  ${LEASE_ACQUIRE_SENTENCES[code]}`, ''].join('\n')}\n`;
}
