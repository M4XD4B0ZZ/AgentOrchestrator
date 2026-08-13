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
      '  `agent-loop lease status` to see what is there. It prints the break command for it\n' +
      '  only when the recorded owner is definitely gone; if it cannot even establish that,\n' +
      '  there is nothing to weigh up and nothing to do but wait. Breaking is attended, it\n' +
      '  removes only the lease you name by revision, and there is no --force.',
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
 * `breakable` is passed in rather than derived here, and that is the point:
 * whether a lease may be recovered is `lease-recovery.ts`'s judgement, and a
 * renderer that formed its own opinion would be a second classifier — one an
 * operator reads, beside one the removal obeys. The one thing worse than no
 * recovery command is a report that offers one for a lease the command refuses.
 */
export function renderLeaseStatus(inspection: LeaseInspection, breakable: boolean): string {
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

  // Recovery, and it is now a command — under a contract, and only for a lease
  // that is actually recoverable.
  //
  // The instruction this replaces told an operator to delete the file by hand
  // and to mind the race while doing it, because an attended break had been
  // withdrawn after three review rounds each found a fresh way for it to destroy
  // a legitimately acquired lease. That was honest about the tool and no help at
  // all: "do the same destructive thing yourself, unassisted" is not a safer
  // answer, and the race it warned about is one a human cannot win by being
  // careful. `lease break` closes it structurally — the removal proves, on the
  // bytes it has detached, that they are still the ones printed here.
  //
  // Printed only when there is a decision to make. For a running owner there is
  // nothing to recover from, and printing a break command beside a healthy run
  // is how a healthy run gets cleared.
  if (breakable) {
    lines.push(
      '',
      '  This lease is recoverable: nothing occupying it can be shown to be running. Breaking',
      '  it removes exactly the bytes above - the revision is the lease\'s identity, and the',
      '  removal re-checks it against the record it has detached, so a lease that is released',
      '  and legitimately re-acquired in the meantime is left alone rather than destroyed.',
      '',
      '    1. establish that no orchestrator process and no agent process of that run is',
      '       still alive. A process id that is gone does not prove this: an agent can',
      '       outlive the orchestrator that started it. This is the judgement the tool',
      '       cannot make for you, and it is the reason the break is attended.',
      // One line, deliberately, however long it gets. A wrapped command needs a
      // continuation character, and there is no continuation character that is
      // right in both of the shells an operator of this build might be standing
      // in - `\` is a literal backslash in PowerShell, which is where this
      // build's canonical evidence comes from, and a backtick is noise
      // everywhere else. A line that can be copied without editing beats a
      // pretty one that cannot.
      '    2. run this, as a single line:',
      '',
      `       agent-loop lease break --repository <path> --attended` +
        ` --expected-revision ${inspection.revision ?? '<revision>'}` +
        (inspection.ownerPid === null ? '' : ` --owner-pid ${String(inspection.ownerPid)}`),
      '',
      '  If the lease changed between this report and that command, the break refuses and',
      '  says so. Nothing is removed on a revision you did not see, and there is no --force.',
    );
  }

  return `${lines.join('\n')}\n\n`;
}

/** The refusal an execution command prints when it could not take the lease. */
export function renderLeaseRefusal(code: LeaseAcquireFailureCode): string {
  return `${['', line('Lease', code), `  ${LEASE_ACQUIRE_SENTENCES[code]}`, ''].join('\n')}\n`;
}

