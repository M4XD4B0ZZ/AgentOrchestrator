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
  LeaseReleaseCode,
  LeaseReleaseResult,
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
    // This sentence used to say the state is "what a run killed while its agent
    // was working leaves behind". That stopped being true when M2 slice 1 added
    // the `ESTABLISHED` mark: a run killed with its agent working now leaves a
    // launch the kernel had already placed in the owner's job, and lands on the
    // two LAUNCH_TREE_ refusals below or on a recovery. What reaches this one is
    // the narrow window before the kernel answered.
    LAUNCH_HISTORY_UNPROVEN:
      'At least one writer launch under this lease was announced and never reached the\n' +
      '  point where the kernel confirmed it had been placed in the owner\'s process job.\n' +
      '  That is the short window between announcing a launch and starting it, and it is\n' +
      '  the one case where nothing at all can be said about the process. Nothing is removed.',
    LAUNCH_TREE_STILL_RUNNING:
      'A writer launch under this lease was placed in the owner\'s process job and never seen\n' +
      '  to end, and a process bearing one of the ids it recorded exists right now. The owner\n' +
      '  is gone and something it started may not be. Nothing is removed, and do not stop that\n' +
      '  process on the strength of this: process ids are reused, so it need not be the one\n' +
      '  this lease started.',
    LAUNCH_TREE_LIVENESS_UNDETERMINED:
      'Whether the processes of an unended writer launch still exist could not be established.\n' +
      '  An unknown answer is not an absent process, so nothing is removed.',
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

/**
 * One static sentence per outcome of `lease recover`. Closed, and total by type.
 *
 * ── Two corrections that belong here rather than in the printed text ───────
 *
 * `RECOVERY_FAILED` used to end "look inside the Git directory **if the end
 * state names a quarantine**". That is a rule an operator can follow literally
 * and be wrong: `detail` prints the {@link VerifiedRemoval} member verbatim, and
 * `UNIDENTIFIABLE_AND_UNOWNED` does not contain the word while being one of the
 * two that leave a file. It now names the two that do not.
 *
 * And it says of `UNIDENTIFIABLE` that it "tried to delete" its quarantine
 * rather than that it left no file: that path reaches `discard`, which swallows a
 * failed unlink, so "no file behind" is the design and not a guarantee. A printed
 * never/always resting on a best-effort call is exactly the shape this renderer's
 * own header was written about — the withdrawn break's report asserted a
 * guarantee an operator could not audit.
 *
 * Both of those are recorded here because a printed refusal is read by somebody
 * acting on it. The history of the sentence belongs to whoever maintains it.
 */
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
      '  look inside the Git directory unless the end state is DETACH_FAILED, which never\n' +
      '  created a file, or UNIDENTIFIABLE, which tried to delete the one it made.',
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

/**
 * One static sentence per release code. Closed, total by type, ASCII only.
 *
 * Written once because three commands report the same fact — `run --attended`,
 * `block --attended` and `release --attended` all take the repository's one
 * writer slot and all have to give it back — and an operator reading two of them
 * should not have to work out whether two different sentences describe two
 * different conditions.
 *
 * ── The rule these obey, and what it cost to find ──────────────────────────
 *
 * A sentence keyed on a code may state only what is true of **every** producer
 * of that code. Three consecutive reviews caught this table breaking that rule,
 * each one level further in, so it is worth saying why it kept happening:
 * `releaseRepositoryExecutionLease` maps twelve returns onto six codes, and the
 * producers of one code routinely disagree about the two facts an operator acts
 * on — what is at the lease name afterwards, and whether a detached copy was
 * kept. `NOT_OWNER` alone comes from four refusals that inspected only the name
 * and three removal states that inspected the object.
 *
 * So the sentences below say what the code establishes, and stop. Everything
 * about the resulting state on disk lives in {@link LEASE_RELEASE_DETAIL_SENTENCES},
 * keyed on the token — because the token *is* the end state, and the code is not.
 *
 * The word "reason" appears in none of them on purpose: the dist harness in
 * `tests/dist-artifact/notification-egress-dist-artifact.mjs` scrapes block's
 * stdout with `/reason (\S+)/`, and a sentence printed after the run report that
 * happened to contain it would answer that scrape with prose.
 */
export const LEASE_RELEASE_SENTENCES: Readonly<Record<LeaseReleaseCode, string>> = Object.freeze({
  RELEASED:
    'The execution lease was given back. Nothing of this invocation is left holding this\n' +
    '  repository. What the next invocation meets is its own question - a successor may have\n' +
    '  taken the name already - but nothing this one holds stands in its way.',
  EVIDENCE_INVALID:
    'This invocation could not prove which lease it was holding, so it looked at nothing and\n' +
    '  removed nothing. That is a defect in this build rather than a condition of the\n' +
    '  repository, and a lease record may still be present. Run `agent-loop lease status` to\n' +
    '  see what is there.',
  LEASE_ABSENT:
    'There was nothing to give back: no record was at the lease name when this release\n' +
    '  reached it, and this call kept nothing aside. That is all it establishes. It does not\n' +
    '  say what is at the lease name now, and it did not look anywhere else in the\n' +
    '  repository. Nor does it say when the record went: if it went while the work was still\n' +
    '  running, the name was free and a second writer could have been admitted, and this\n' +
    '  build cannot tell you which happened. Run `agent-loop lease status` and check the\n' +
    '  repository before trusting the result.',
  NOT_OWNER:
    'The record this release examined could not be shown to be the one this invocation took,\n' +
    '  so nothing of this invocation was removed. Note what that is not: a record too\n' +
    '  damaged to identify answers the same way, and a restore that failed part way through\n' +
    '  writing a copy back can leave a damaged record at the name. A successor is one\n' +
    '  reading of this code and not the only one, and this build does not tell them apart\n' +
    '  here. If a token follows the code above, the line under it says what state the\n' +
    '  removal stopped in; with no token, this report has nothing further to add. Run\n' +
    '  `agent-loop lease status` before the next run.',
  LEASE_UNREADABLE:
    'This build could not get at the lease record, and the failure was not classified as its\n' +
    '  absence. That alone does not settle whether a record is there. Some failures here mean\n' +
    '  something is at the lease name that is not a readable record - a directory in its\n' +
    '  place is one - and others settle nothing at all, including a machine out of file\n' +
    '  handles, a failure this build cannot classify, and one that never reached the\n' +
    '  filesystem. Nothing was removed and nothing else was inspected. Run\n' +
    '  `agent-loop lease status` for what this build can see before the next run.',
  LEASE_REMOVE_FAILED:
    'The removal did not complete. A token follows the code above, and the line under it says\n' +
    '  what state the removal stopped in; every one of them needs a human before the next\n' +
    '  run. Run `agent-loop lease status`, and clear what is there by hand.',
});

/** The tokens a release result can carry, one per removal end state. */
export const LEASE_RELEASE_DETAILS = [
  'DETACH_REFUSED',
  'UNREADABLE_AFTER_DETACH',
  'RECORD_QUARANTINED',
  'RECORD_QUARANTINED_LEASE_UNOWNED',
] as const;

export type LeaseReleaseDetail = (typeof LEASE_RELEASE_DETAILS)[number];

/**
 * What the removal left behind, keyed on the token rather than on the code.
 *
 * This table exists because the code is not enough, and four reviews proved it.
 * The token is a much better key — it distinguishes what the code cannot — but
 * it is **not** one token per end state, and the fifth review found the sentence
 * that assumed it was. `RECORD_QUARANTINED` comes from `Restoration.NAME_TAKEN`,
 * and `putBack` reaches that both by proof (`link` refused with `EEXIST`) and by
 * `occupancyOf` treating a *failed* `stat` as occupancy — which that function's
 * own docstring calls proof of nothing, chosen so it can never announce a free
 * repository it has not established. So the token says a copy was kept aside,
 * which is true of every producer, and says nothing certain about who holds the
 * name, which is not.
 *
 * The rule survives the correction, and it is the same rule the code table
 * obeys: say what every producer of this key shares, and name the uncertainty
 * where the producers differ.
 *
 * The one that had to be written from the source rather than from its name is
 * `UNREADABLE_AFTER_DETACH`. It reads as a record left in quarantine and is the
 * opposite: `removeVerifiedLease` restores it to the lease name and then
 * discards the quarantine copy. An earlier version of this file glossed it as a
 * quarantined record, which would have sent an operator into the administrative
 * directory after a file the same call had deleted — the harm `VerifiedRemoval`'s
 * own docstring records having been reproduced once already, on a different
 * code, and the reason that vocabulary was split apart in the first place.
 */
export const LEASE_RELEASE_DETAIL_SENTENCES: Readonly<Record<LeaseReleaseDetail, string>> =
  Object.freeze({
    DETACH_REFUSED:
      'Nothing was moved at all: the record could not be detached from the lease name, so\n' +
      '    whatever is there is still there and nothing was kept aside. It was the record\n' +
      '    this run took, as of the check a few calls earlier; this call did not look again,\n' +
      '    and the name can change hands in that window. Run `agent-loop lease status` to see\n' +
      '    what is there now.',
    UNREADABLE_AFTER_DETACH:
      'The record was detached, could not be read, and was put back at the lease name. It was\n' +
      '    not kept aside on purpose - the quarantine name was unlinked, best effort, and this\n' +
      '    call did not check that the unlink worked. What sits at the lease name is a record\n' +
      '    this call could not read, and it will refuse the next run.',
    RECORD_QUARANTINED:
      'The record was detached and could not be put back, and it is kept - deliberately -\n' +
      '    beside the lease rather than deleted. Whether anything is at the lease name is not\n' +
      '    established: the restore refused, and the check that followed may itself have been\n' +
      '    refused, which this build reads as occupied so that it can never announce a free\n' +
      '    repository it has not seen. If something is there it may be a successor that\n' +
      '    acquired legitimately, and it may be a partial record left by a restore that failed\n' +
      '    part way. Run `agent-loop lease status` before assuming either.',
    RECORD_QUARANTINED_LEASE_UNOWNED:
      'The record was detached, could not be put back, and nothing holds the lease name -\n' +
      '    which this call established rather than assumed. The record is kept beside the\n' +
      '    lease. The name being free is not the same as the repository being idle: the\n' +
      '    record that was detached may belong to a live writer, which loses authority and\n' +
      '    stops at its next checkpoint rather than immediately. Nothing this call left at\n' +
      '    the lease name stands in the way of a next run; what that run meets is its own\n' +
      '    question, and this is the case for looking before you let it.',
  });

/**
 * The code printed when the release produced no answer at all.
 *
 * Not a member of `LeaseReleaseCode`, and it may not be: that union is the
 * codomain of `releaseRepositoryExecutionLease`, and this is the state of having
 * no value from it — the release threw, and both commands' `finally` contains
 * the throw rather than letting it replace the exception that entered.
 *
 * It exists because the alternative is printing nothing, and an absent line is
 * the one thing this report may never be: "the release was not reported" and
 * "the release was fine" would then look identical from the console, which is
 * the confusion this whole slice removes.
 */
export const LEASE_RELEASE_UNREPORTED = 'RELEASE_NOT_REPORTED';

/**
 * Its sentence, exported for the same reason the others are.
 *
 * It reaches an operator's console on exactly the same footing, so it belongs to
 * the same vocabulary tests — the ASCII pin, the distinctness pin and the pin
 * that forbids the word the notification harness scrapes. A sentence no pin
 * could reach would be the one that drifted.
 */
export const LEASE_RELEASE_UNREPORTED_SENTENCE =
  'Giving the execution lease back failed with an error rather than an answer, so what is in\n' +
  '  this repository now is unknown to this invocation. Assume a lease record is still there.\n' +
  '  Run `agent-loop lease status` before the next run. The error itself should be on the\n' +
  '  standard error stream, in the safe form this build prints exceptions in - unless that\n' +
  '  stream refused the write too, which is the one thing that could have hidden it.';

/**
 * The one line every command prints for its execution-lease release.
 *
 * The label is a parameter and the rest is not. `run --attended` has printed
 * `Release` since V3-06 and keeps it; `block --attended` uses the same word,
 * because a block has no other release; `release --attended` uses `Lease`,
 * because in *that* report `Release` already means the task workspace and
 * `Outcome` already carries its verdict. What may not differ between the three
 * is the code, the detail and their spelling, which is why they are here and the
 * label is not.
 */
export function leaseReleaseLine(label: string, result: LeaseReleaseResult): string {
  return line(label, result.detail !== null ? `${result.code}  (${result.detail})` : result.code);
}

/**
 * The report a command prints about giving the lease back.
 *
 * Printed on **every** attended path that acquired a lease: the successful one,
 * the refusals, and the one where the release itself threw and produced nothing
 * — which is what `null` renders, and which is the case that would otherwise
 * print no line at all on the one occasion the lease is provably still there.
 *
 * Up to three lines. The code's sentence says what every producer of that code
 * shares; the token's, indented under it, says what *this* removal left on disk.
 * A token this build does not recognise prints no third line rather than a wrong
 * one — `execution-lease.ts` cannot produce one today, and a missing lookup
 * interpolated into a template would print the word "undefined" at an operator
 * on the one report they are reading because something already went wrong.
 */
export function renderLeaseRelease(label: string, result: LeaseReleaseResult | null): string {
  const body =
    result === null
      ? [line(label, LEASE_RELEASE_UNREPORTED), `  ${LEASE_RELEASE_UNREPORTED_SENTENCE}`]
      : [
          leaseReleaseLine(label, result),
          `  ${LEASE_RELEASE_SENTENCES[result.code]}`,
          ...(result.detail !== null && Object.hasOwn(LEASE_RELEASE_DETAIL_SENTENCES, result.detail)
            ? [`    ${LEASE_RELEASE_DETAIL_SENTENCES[result.detail as LeaseReleaseDetail]}`]
            : []),
        ];
  return `${['', ...body, ''].join('\n')}\n`;
}
