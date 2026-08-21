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
 * operator has explicitly asked *where* the lease is and cannot act without it,
 * and except `SUPPORTED_NODE_MAJORS` in the network-location sentence below: it
 * restates the same whitelist `runtime-gate.ts` renders, read from the same
 * constant rather than copied, so the two cannot state different contracts.
 *
 * The printed vocabulary is **ASCII only**, and `tests/v2-07l-execution-lease.test.ts`
 * holds it there. This repository has twice had text damaged by a re-encoding
 * pass, and an operator-facing refusal is the worst place for that. The comments
 * are prose and are not held to it.
 */

import type {
  LeaseAcquireFailureCode,
  LeaseInspection,
  StaleLeaseRecoveryAssessment,
  StaleLeaseRecoveryResult,
  StaleRecoveryRefusal,
} from '../lease/execution-lease.js';
import type { WriterLaunchReading } from '../lease/writer-launch-ledger.js';
import { SUPPORTED_NODE_MAJORS } from '../platform/runtime-support.js';
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
      '  `agent-loop lease status` to see what is there, including whether the lease can be\n' +
      '  proved removable. If it can, `agent-loop lease recover` removes it and nothing else;\n' +
      '  the next run then takes its own lease normally. If it cannot, that command refuses\n' +
      '  and says which fact is missing. There is no way to override the refusal: a lease this\n' +
      '  build cannot prove dead is cleared by a human decision outside this tool.',
    LEASE_LOCATION_UNSUITABLE:
      // Covers two cases it actually serves, not one: a key from which no
      // location could be derived at all, and a path shape this build
      // recognises but has not verified (an extended-length volume GUID is
      // the concrete case). Neither is "no location could be derived" alone -
      // that was the same misdescription this slice makes its case against
      // for UNC, one code over.
      "This repository's Git common directory has no usable lease location: either none\n" +
      '  could be derived from it, or its shape is one this build has not verified. No\n' +
      '  exclusive claim could be made. Nothing was started.',
    LEASE_LOCATION_NETWORK_UNSUPPORTED:
      "This repository's Git common directory is on a UNC or network path, which is outside\n" +
      '  the V2 support contract. Nothing was started and nothing was created. V2 is built and\n' +
      `  verified for one configuration: Windows, Node ${SUPPORTED_NODE_MAJORS.join(' or ')}, and a repository whose Git\n` +
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
    // Same two cases as LEASE_LOCATION_UNSUITABLE above, for the same reason:
    // "no location could be derived" alone would misdescribe a recognised but
    // unverified shape, such as an extended-length volume GUID.
    LOCATION_UNSUITABLE:
      "This repository's Git common directory has no usable lease location: either none\n" +
      '  could be derived from it, or its shape is one this build has not verified.',
    // "This repository" and "this repository path" would both name the wrong
    // object: the decision is made from `gitCommonDir` alone, and the two can
    // be on different volumes. `git init --separate-git-dir \\server\share\r.git`
    // under `C:\work\repo` is a coherent record this build accepts, and telling
    // that operator "this repository is on a UNC path" is false of the working
    // tree they are looking at. The acquire-side sentence for the identical
    // condition already names the common directory; these two now agree with it.
    LOCATION_NETWORK_UNSUPPORTED:
      "This repository's Git common directory is on a UNC or network path, which V2 does not\n" +
      '  support, so it has no lease location. This is a refusal, not a failure to understand\n' +
      '  the path.',
    LOCATION_DEVICE_NAMESPACE:
      "This repository's Git common directory is in the Windows device namespace, which is not\n" +
      '  a place a lease can be kept.',
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
 * One static sentence per recovery refusal. Closed, and total by type.
 *
 * Every one of them says the same two things in different words: what is
 * missing, and that nothing was touched. None of them offers a way round
 * itself, because there is none — the predicate has no override and this
 * vocabulary must not imply one.
 */
export const STALE_RECOVERY_SENTENCES: Readonly<Record<StaleRecoveryRefusal, string>> =
  Object.freeze({
    NOTHING_TO_RECOVER: 'Nothing is at the lease path. There is no lease to remove.',
    OWNER_RUNNING:
      'A process with the recorded owner id exists. Nothing is removed while an owner may\n' +
      '  still be running. Wait for it, and do not stop it on the strength of this: process\n' +
      '  ids are reused, so the process running now need not be the owner.',
    OWNER_LIVENESS_UNDETERMINED:
      'Whether the owner process exists could not be established. An unknown answer is not a\n' +
      '  dead owner, so nothing is removed.',
    LEASE_UNPARSEABLE:
      'Something is at the lease path and is not a lease this build can read - this is what a\n' +
      '  run that died between claiming the lease and recording it leaves behind. It names no\n' +
      '  owner and carries no identity, so there is nothing a removal could be bound to and\n' +
      '  no history to prove anything with. This case is refused permanently, not pending.',
    LEASE_UNREADABLE:
      'Something is at the lease path and could not be read at all. Nothing was touched.',
    LOCATION_UNSUITABLE:
      "This repository's Git common directory has no usable lease location, so there is no\n" +
      '  lease path to examine.',
    LOCATION_NETWORK_UNSUPPORTED:
      "This repository's Git common directory is on a UNC or network path, which V2 does not\n" +
      '  support.',
    LOCATION_DEVICE_NAMESPACE:
      "This repository's Git common directory is in the Windows device namespace, which is not\n" +
      '  a place a lease can be kept.',
    LAUNCH_HISTORY_ABSENT:
      'This lease keeps no writer launch history, so nothing can be proved about the agent\n' +
      '  processes it started. Every lease taken by a build older than this one is in this\n' +
      '  state, and no such lease becomes recoverable in hindsight.',
    LAUNCH_HISTORY_INCOMPLETE:
      'This lease has a writer launch history that did not begin with the lease itself, so it\n' +
      '  can be missing launches. It is a log and not a proof, and it never becomes one.',
    LAUNCH_HISTORY_UNPROVEN:
      'At least one writer launch under this lease was announced and never proved contained.\n' +
      '  That is what a run killed while its agent was working leaves behind, and it is\n' +
      '  exactly the case where an agent process may have survived the owner. Nothing is\n' +
      '  removed.',
    LAUNCH_HISTORY_UNSUPPORTED_VERSION:
      'The writer launch history beside this lease was written by a build this one does not\n' +
      '  understand. It is refused rather than guessed at.',
    LAUNCH_HISTORY_MALFORMED:
      'The writer launch history beside this lease is not one this build can read. A history\n' +
      '  that cannot be read is not a history that says nothing happened.',
    LAUNCH_HISTORY_NOT_THIS_LEASE:
      'The writer launch history beside this lease belongs to a different lease. It proves\n' +
      '  nothing about this one.',
    LAUNCH_HISTORY_NOT_THIS_RUN:
      'The writer launch history beside this lease describes a different run or a different\n' +
      '  owner than the lease does. It proves nothing about this one.',
  });

/**
 * The removability block, printed under the `lease status` report.
 *
 * Its own function rather than two more lines inside {@link renderLeaseStatus},
 * and the reason is the one that renderer's own docstring gives at length: a
 * report may state what was observed and may not offer a destructive next step.
 * Keeping the observation and the removability answer in separate blocks, from
 * separate inputs, is what stops the second quietly becoming a field of the
 * first — which is what `breakable` was.
 *
 * It names the command in the safe case, and that is a deliberate departure from
 * the withdrawn renderer, which filled a **constant digest** into a ready-made
 * `lease break` line and called the result an identity. There is no argument to
 * fill in here: `lease recover` takes a repository and proves everything else
 * for itself at the moment it runs, so this sentence cannot make a stale fact
 * look like an authorisation.
 */
export function renderLeaseRecovery(
  assessment: StaleLeaseRecoveryAssessment,
  history: WriterLaunchReading | null,
): string {
  const lines = [
    // The reading, on its own line, and read independently of the assessment.
    // The predicate stops at the first refusal, so a lease with a living owner
    // carries `launchHistory: null` — and "is this run's bookkeeping intact" is a
    // question an operator has about a *healthy* repository too.
    line('Launches', history ?? 'none'),
    ...(assessment.refusal === null
      ? [
          line('Recovery', 'SAFE_TO_RECOVER'),
          // "writer", not "agent". The history records the productive writer and
          // nothing else, and an earlier draft of this sentence said "no agent
          // process it started can still be running" — which is the wider claim
          // the ledger's own header refuses to make, printed to the one reader
          // who cannot check it.
          '  Every writer launch under this lease is proved contained and its owner process is\n' +
            '  gone, so no writer process it started can still be running. Remove it with\n' +
            '  `agent-loop lease recover --repository <path>`. That removes a dead record and\n' +
            '  grants nothing: the next run takes its own lease through the ordinary path.',
        ]
      : [
          line('Recovery', assessment.refusal),
          `  ${STALE_RECOVERY_SENTENCES[assessment.refusal]}`,
        ]),
  ];
  return `${lines.join('\n')}\n\n`;
}

/** One static sentence per outcome of `lease recover`. Closed, and total by type. */
export const STALE_RECOVERY_OUTCOMES: Readonly<Record<StaleLeaseRecoveryResult['code'], string>> =
  Object.freeze({
    RECOVERED:
      'The stale lease was removed, and nothing was granted: the next invocation takes its\n' +
      '  own lease through the ordinary path. Whether anything holds this repository now is\n' +
      '  not something this command looked at - the name was free from the moment the record\n' +
      '  was detached, and another invocation may have taken it since.',
    RECOVERY_UNSAFE: 'Nothing was touched. The reason line says which fact is missing.',
    LEASE_CHANGED:
      'Nothing was removed and nothing was moved: what is at the lease path is not what was\n' +
      '  proved removable, or nothing is there at all. The reason line says which. Run\n' +
      '  `agent-loop lease status` before anything else runs against this repository.',
    LEASE_DISPLACED:
      "A record that was not this call's to remove was detached from the lease name and\n" +
      '  could not be put back. It was KEPT, not deleted: it is in a file beside the lease\n' +
      '  whose name begins with the lease name and contains `.breaking-`. An invocation that\n' +
      '  took the lease in that instant has lost it and will stop at its next checkpoint. The\n' +
      '  reason line says whether the lease name is free now or has been taken again. Run\n' +
      '  `agent-loop lease status` and do not start anything against this repository until it\n' +
      '  reads as you expect.',
    RECOVERY_FAILED:
      'The removal could not be completed, and the end-state line names which way. Two of\n' +
      '  the four ways leave a record KEPT in a file beside the lease whose name contains\n' +
      '  `.breaking-` - detached, unreadable, and deliberately not deleted - and one of\n' +
      '  those two also leaves the lease name free. Nothing was destroyed. Run\n' +
      '  `agent-loop lease status` before anything else runs against this repository, and\n' +
      '  look inside the Git directory unless the end state is DETACH_FAILED or\n' +
      '  UNIDENTIFIABLE - those two are the ones that left no file behind. (This said\n' +
      '  "if the end state names a quarantine", which is a rule an operator can follow\n' +
      '  literally and be wrong: UNIDENTIFIABLE_AND_UNOWNED does not contain the word and\n' +
      '  is one of the two with a file to inspect.)',
  });

/** The `lease recover` report. */
export function renderLeaseRecoveryResult(result: StaleLeaseRecoveryResult): string {
  // "Reason" for a refusal, "End state" for everything else. Making `detail`
  // unconditional gave a successful recovery the line `Reason : REMOVED`, which
  // labels a success as though something had gone wrong; the invariant worth
  // keeping is that the code and the state it came from are always both printed,
  // not that they share one label.
  const reason = result.refusal ?? result.detail;
  const lines = [
    '',
    line('Recovery', result.code),
    `  ${STALE_RECOVERY_OUTCOMES[result.code]}`,
    line(result.refusal === null ? 'End state' : 'Reason', reason ?? 'none'),
    ...(result.refusal === null ? [] : [`  ${STALE_RECOVERY_SENTENCES[result.refusal]}`]),
    line('Path', result.assessment.path === '' ? 'no usable location' : result.assessment.path),
  ];
  return `${lines.join('\n')}\n\n`;
}

/**
 * The `Path` field's text, decided from the STATE rather than from `path`
 * being empty — the two used to agree by coincidence, and only by coincidence,
 * which is how a UNC repository's report used to say "Path: not derivable" one
 * line under a sentence that says the opposite: "This is a refusal, not a
 * failure to understand the path."
 *
 * The location-failure states each get their own text, and each text has to be
 * true of *every* case its state covers. A shared fallback across states is
 * what this function exists to remove; a text that describes only one of two
 * cases within a state is the same collapse one level down.
 * `LOCATION_NETWORK_UNSUPPORTED` and `LOCATION_DEVICE_NAMESPACE` each cover a
 * single shape, understood and refused for being that shape, so each says so.
 *
 * `LOCATION_UNSUITABLE` covers **two**, which is why it no longer says "not
 * derivable": a key from which no location could be derived at all
 * (`\repo\.git`, root-relative), and `\\?\Volume{…}`, a shape
 * `classifyWindowsKey` recognises and declines because V2 verified the
 * drive-letter forms and not that one. The second is a refusal, not a failure
 * to understand the path — so asserting "not derivable" over it would reprint
 * the very defect this function was written to remove, one code over, and
 * directly under a sentence that offers both cases. Giving each case its own
 * text would mean splitting the state, which changes the refusal taxonomy and
 * is not a rendering decision to take here.
 *
 * Every other state always carries a real, derived `inspection.path`.
 */
function pathField(inspection: LeaseInspection): string {
  switch (inspection.state) {
    case 'LOCATION_UNSUITABLE':
      return 'no usable location';
    case 'LOCATION_NETWORK_UNSUPPORTED':
      return 'refused (UNC or network path)';
    case 'LOCATION_DEVICE_NAMESPACE':
      return 'refused (Windows device path)';
    default:
      return inspection.path;
  }
}

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
 * which contradicts the reasoning recorded on `readObject` in
 * `lease/execution-lease.ts` — that content cannot identify an object whose
 * content is nothing. So the tool supplied the fact that
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
    line('Path', pathField(inspection)),
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

