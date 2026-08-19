/**
 * The contract of the native Windows launch boundary — V3 slice 1.
 *
 * ── What the boundary is ───────────────────────────────────────────────────
 *
 * `docs/decisions/2026-08-19-adr-windows-launch-boundary.md` decided that a
 * productive agent process on Windows is created by a small out-of-process
 * helper that owns it: the helper creates a strict Job Object
 * (`KILL_ON_JOB_CLOSE`, neither breakaway flag), creates the target **inside**
 * that job, confirms membership before the target may execute, keeps the only
 * — non-inheritable — job handle, passes exactly the three stdio handles, and
 * couples its own life to the AO process it serves.
 *
 * "Before the target may execute" means different things in the two placement
 * modes, and the difference is stated rather than smoothed over: `JOBLIST` has
 * the kernel place the process in the job at creation, so membership is true
 * before the first instruction and the check confirms it; `SUSPENDED` creates
 * the process suspended and checks before the resume, so the check precedes
 * the first instruction. Neither is a fallback for the other.
 *
 * This module is the TypeScript half of that: the request the helper reads,
 * the status it writes, and the vocabulary an ending is reported in. It starts
 * no process itself (`./start-owned-process.ts` does) and it is deliberately
 * used by **no** productive runner yet: slice 1 delivers the boundary in
 * isolation, and `runCommand`, the Claude writer and the verification runner
 * are untouched.
 *
 * ── What it deliberately does not model ────────────────────────────────────
 *
 * Byte budgets, timeouts, stdin delivery vocabulary, result classification and
 * task state stay in AO, exactly as the ADR splits them. Nothing here reads or
 * bounds a stream. The adapter slices add that on top; adding it here would
 * move AO domain logic behind a boundary whose whole value is being small.
 *
 * ── Why the endings are shaped like this ───────────────────────────────────
 *
 * The spike measured one defect that no containment result reveals: when the
 * helper was killed, the tree died correctly **and the run still looked like a
 * normal completion** — ownership had been reported earlier, the pipes closed
 * cleanly, and no child exit code ever arrived. `BOUNDARY_LOST` is that state,
 * and every ending below is built so that an *unknown* outcome cannot be read
 * as a successful one:
 *
 *   - no status, or an unreadable one, is never `CHILD_EXITED`;
 *   - `boundary=OK` without the membership evidence that justifies it is a
 *     refusal, not ownership;
 *   - a termination the caller asked for is its own ending, so that
 *     `BOUNDARY_LOST` keeps meaning "lost", not "cancelled".
 */

/**
 * The helper's exit codes. Shared with `native/ao-launch/AoLaunch.cs`, which
 * is the other half of this contract; the C# side names the same numbers.
 *
 * They exist because a refusal may happen before there is anywhere to write a
 * status to — an unreadable request file has no `statusPath` in it — and a
 * refusal without a status must still be readable as a refusal rather than as
 * an unknown ending.
 */
export const BOUNDARY_HELPER_EXIT = Object.freeze({
  /** The child was created, owned, and observed to exit. */
  CHILD_OBSERVED: 0,
  /** The helper was invoked with something other than one request path. */
  USAGE: 64,
  /** A boundary primitive failed. Nothing ran. */
  BOUNDARY_FAILURE: 90,
  /** The helper hit an internal error. Nothing ran. */
  INTERNAL_ERROR: 91,
  /** The owner could not be watched at launch time. Nothing ran. */
  OWNER_ALREADY_GONE: 92,
  /** The owner vanished while the child ran; the job was terminated. */
  OWNER_LOST: 93,
} as const);

/**
 * Every failure code the boundary can report.
 *
 * The `OWNED_CONTAINMENT_*` members are the helper's; the rest are decided on
 * this side, when the helper's own report is missing or does not hold together.
 */
export const BOUNDARY_FAILURE_CODES = [
  'OWNED_CONTAINMENT_REQUEST_INVALID',
  'OWNED_CONTAINMENT_JOB_CREATE',
  'OWNED_CONTAINMENT_JOB_CONFIGURE',
  'OWNED_CONTAINMENT_OWNER_GONE',
  'OWNED_CONTAINMENT_PIPES',
  'OWNED_CONTAINMENT_ATTRIBUTE_LIST',
  'OWNED_CONTAINMENT_HANDLE_LIST',
  'OWNED_CONTAINMENT_JOB_LIST',
  'OWNED_CONTAINMENT_CREATE',
  'OWNED_CONTAINMENT_ASSIGN',
  'OWNED_CONTAINMENT_VERIFY',
  'OWNED_CONTAINMENT_RESUME',
  'HELPER_INTERNAL_ERROR',
  /** The helper reported a failure this build does not know. */
  'BOUNDARY_FAILURE_UNKNOWN',
  /** The helper refused, and no readable status says why. */
  'BOUNDARY_STATUS_UNREADABLE',
  /** The status claims ownership without the evidence that establishes it. */
  'BOUNDARY_STATUS_INCONSISTENT',
  /**
   * The status file does not belong to this launch.
   *
   * A directory a caller reuses still holds the previous run's status, and the
   * first read of a launch happens before the helper has written anything —
   * so without an identity check the earlier run's `boundary=OK` is accepted
   * as this one's, complete with its child pid.
   */
  'BOUNDARY_STATUS_FOREIGN',
  /** A job handle could not be set to, or read back as, non-inheritable. */
  'OWNED_CONTAINMENT_JOB_HANDLE',
  /** The helper executable is not where the build puts it. */
  'BOUNDARY_EXECUTABLE_MISSING',
  /** The helper process itself could not be started. */
  'BOUNDARY_HELPER_SPAWN_FAILED',
  /** The helper did not report ownership within the caller's bound. */
  'BOUNDARY_NOT_ESTABLISHED_IN_TIME',
] as const;

export type BoundaryFailureCode = (typeof BOUNDARY_FAILURE_CODES)[number];

const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set(BOUNDARY_FAILURE_CODES);

/**
 * How the target is placed into the job.
 *
 * Both were measured, including against the real Claude Code tree. `JOBLIST`
 * uses `PROC_THREAD_ATTRIBUTE_JOB_LIST`, so the process is a member before its
 * first instruction; `SUSPENDED` creates suspended, assigns, verifies and only
 * then resumes. Neither is a fallback for the other: the caller picks one, and
 * a failure in the picked one is a refusal.
 */
export type BoundaryLaunchMode = 'SUSPENDED' | 'JOBLIST';

/** A launch request, in the terms the helper reads. */
export interface BoundaryLaunchRequest {
  readonly mode: BoundaryLaunchMode;
  /** The canonical application path. Never a bare name: this side resolves. */
  readonly file: string;
  readonly args: readonly string[];
  /**
   * `true` joins the arguments untouched behind a quoted `file`, which is what
   * Node's `windowsVerbatimArguments` does and what the trusted
   * `cmd.exe /d /s /c` route needs. `false` quotes each argument MSVCRT-style.
   */
  readonly verbatim: boolean;
  /** Absent inherits the helper's working directory. */
  readonly cwd?: string;
  /** Absent inherits the helper's environment; present replaces it entirely. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The AO process the boundary is coupled to. Required, and validated. */
  readonly ownerPid: number;
  /** Where the helper writes its status. */
  readonly statusPath: string;
  /**
   * A value invented for this launch and echoed back in the status, so the
   * status file's identity is checkable rather than assumed. It is not a
   * secret against a hostile process on the same account — see the threat
   * model in `native/README.md` — it is what makes a *stale* or mismatched
   * status impossible to mistake for this run's.
   */
  readonly nonce: string;
}

/** A request that cannot be encoded. A programming error, not a run outcome. */
export class InvalidBoundaryRequestError extends Error {}

/**
 * The keys a request may carry, and there are deliberately no others.
 *
 * The helper refuses an unknown key outright, which is what makes this list a
 * contract rather than a convention: neither side can quietly grow an option
 * the other does not know about.
 */
export const BOUNDARY_REQUEST_KEYS = Object.freeze([
  'nonce',
  'mode',
  'file',
  'arg',
  'verbatim',
  'cwd',
  'env',
  'ownerPid',
  'statusPath',
] as const);

function line(key: string, value: string): string {
  return `${key}=${Buffer.from(value, 'utf8').toString('base64')}`;
}

function refuseRequest(detail: string): never {
  throw new InvalidBoundaryRequestError(`Refusing to encode a launch request: ${detail}`);
}

/** Values reach the helper base64-encoded, so only NUL is genuinely impossible. */
function checkValue(what: string, value: string): void {
  if (value.includes('\u0000')) refuseRequest(`${what} contains a NUL character.`);
}

/**
 * Encodes a request into the helper's line format: one `key=base64(value)` per
 * line.
 *
 * Base64 rather than JSON or plain text on purpose. The values are paths,
 * command-line arguments and environment entries — the exact material that
 * quoting bugs live in — and base64 has no quoting to get wrong, no escaping
 * rules that differ between the two languages, and no parser dependency on the
 * native side.
 *
 * Throws rather than returning a refusal: everything checked here is decided
 * by the calling code, not by the machine it runs on.
 */
export function encodeBoundaryRequest(request: BoundaryLaunchRequest): string {
  if (!Number.isInteger(request.ownerPid) || request.ownerPid <= 0) {
    refuseRequest(
      `ownerPid must be a positive integer, got ${JSON.stringify(request.ownerPid)}. ` +
        'A boundary with no owner to watch could outlive the process it serves.',
    );
  }
  if (request.nonce.length === 0) refuseRequest('nonce is empty.');
  checkValue('nonce', request.nonce);
  if (request.file.length === 0) refuseRequest('file is empty.');
  if (request.statusPath.length === 0) refuseRequest('statusPath is empty.');
  checkValue('file', request.file);
  checkValue('statusPath', request.statusPath);
  if (request.cwd !== undefined) checkValue('cwd', request.cwd);
  for (const arg of request.args) checkValue('an argument', arg);

  const lines = [
    line('nonce', request.nonce),
    line('mode', request.mode),
    line('file', request.file),
    line('verbatim', request.verbatim ? 'true' : 'false'),
    line('ownerPid', String(request.ownerPid)),
    line('statusPath', request.statusPath),
  ];
  for (const arg of request.args) lines.push(line('arg', arg));
  if (request.cwd !== undefined) lines.push(line('cwd', request.cwd));
  if (request.env !== undefined) {
    for (const [key, value] of Object.entries(request.env)) {
      if (value === undefined) continue;
      // A Windows environment block is `K=V\0K=V\0\0`. A name carrying `=` or
      // a NUL cannot be represented in it, so it is refused rather than
      // truncated into a different variable than the caller meant.
      if (key.length === 0) refuseRequest('an environment name is empty.');
      if (key.includes('=')) refuseRequest(`environment name ${JSON.stringify(key)} contains '='.`);
      checkValue(`environment name ${JSON.stringify(key)}`, key);
      checkValue(`environment value for ${JSON.stringify(key)}`, value);
      lines.push(line('env', `${key}=${value}`));
    }
  }
  return lines.join('\n');
}

/** The helper's status, as read back. `null` where the helper said nothing. */
export interface BoundaryStatus {
  readonly boundary: 'OK' | 'FAILED' | null;
  readonly failure: string | null;
  readonly win32: number | null;
  readonly mode: BoundaryLaunchMode | null;
  readonly helperPid: number | null;
  readonly childPid: number | null;
  readonly verifiedInJob: boolean;
  readonly assignedAtCreation: boolean | null;
  readonly jobHandleInheritable: boolean | null;
  readonly jobMembersAtStart: number | null;
  readonly jobMembersAtEnd: number | null;
  readonly childExitCode: number | null;
  readonly terminatedByOwnerLoss: boolean;
  readonly stdinForward: string | null;
  /** Echoed from the request; `null` when the helper never got that far. */
  readonly nonce: string | null;
  /**
   * Whether the target had begun executing when this status was written.
   *
   * A refusal is not always "nothing ran": the target can be resumed and then
   * the boundary lost before it is confirmed. The job is terminated either
   * way, but a caller deciding whether a launch had side effects needs the
   * difference rather than the safer assumption.
   */
  readonly targetStarted: boolean;
  /** The child ended, and the helper could not prove how. */
  readonly childExitUnobservable: boolean;
  /** Every key the helper wrote, decoded, including ones this build ignores. */
  readonly raw: Readonly<Record<string, string>>;
}

const BASE64_LINE = /^[A-Za-z0-9+/]*={0,2}$/;

function readInt(raw: Readonly<Record<string, string>>, key: string): number | null {
  const value = raw[key];
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Reads a status file's text.
 *
 * Returns `null` when the text is not a status file. That distinction is
 * load-bearing: "the helper reported nothing" and "something wrote nonsense
 * where the helper's report belongs" must not collapse into the same empty
 * object, because the second one is a reason to distrust the run.
 */
export function decodeBoundaryStatus(text: string): BoundaryStatus | null {
  const raw: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.length === 0) continue;
    const split = rawLine.indexOf('=');
    if (split <= 0) return null;
    const encoded = rawLine.slice(split + 1);
    if (!BASE64_LINE.test(encoded)) return null;
    const decoded = Buffer.from(encoded, 'base64');
    // Base64 decoding in Node is forgiving; re-encoding is not. A line that
    // does not survive the round trip was not written by the helper.
    if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) return null;
    raw[rawLine.slice(0, split)] = decoded.toString('utf8');
  }

  const boundary = raw['boundary'];
  const mode = raw['mode'];
  return Object.freeze({
    boundary: boundary === 'OK' || boundary === 'FAILED' ? boundary : null,
    failure: raw['failure'] ?? null,
    win32: readInt(raw, 'win32'),
    mode: mode === 'SUSPENDED' || mode === 'JOBLIST' ? mode : null,
    helperPid: readInt(raw, 'helperPid'),
    childPid: readInt(raw, 'childPid'),
    verifiedInJob: raw['verifiedInJob'] === 'true',
    assignedAtCreation:
      raw['assignedAtCreation'] === undefined ? null : raw['assignedAtCreation'] === 'true',
    jobHandleInheritable:
      raw['jobHandleInheritable'] === undefined ? null : raw['jobHandleInheritable'] === 'true',
    jobMembersAtStart: readInt(raw, 'jobMembersAtStart'),
    jobMembersAtEnd: readInt(raw, 'jobMembersAtEnd'),
    childExitCode: readInt(raw, 'childExitCode'),
    terminatedByOwnerLoss: raw['terminatedByOwnerLoss'] === 'true',
    stdinForward: raw['stdinForward'] ?? null,
    nonce: raw['nonce'] ?? null,
    targetStarted: raw['targetStarted'] === 'true',
    childExitUnobservable: raw['childExitUnobservable'] === 'true',
    raw: Object.freeze({ ...raw }),
  });
}

/** Why a boundary that had been established was lost. */
export type BoundaryLostReason =
  /** The helper stopped without ever reporting the child's exit. */
  | 'NO_CHILD_EXIT_OBSERVED'
  /** The helper reported that its owner vanished and it took the tree down. */
  | 'OWNER_LOST'
  /** No status could be read, so nothing about the run can be trusted. */
  | 'STATUS_UNREADABLE';

/**
 * How a boundary run ended.
 *
 * `BOUNDARY_LOST` is the ADR's fifth runner outcome, modelled here so that the
 * boundary can report it before any runner consumes it. Nothing in this slice
 * translates these into `CommandOutcome`; that is the adapter's job, and doing
 * it here would be the integration this slice is explicitly not.
 */
export type BoundaryEnding =
  | {
      readonly ending: 'CHILD_EXITED';
      readonly childExitCode: number;
      readonly status: BoundaryStatus;
    }
  | {
      readonly ending: 'TERMINATED_BY_CALLER';
      /** What the helper managed to report, which may include an exit code. */
      readonly status: BoundaryStatus | null;
    }
  | {
      readonly ending: 'BOUNDARY_LOST';
      readonly reason: BoundaryLostReason;
      readonly status: BoundaryStatus | null;
    }
  | {
      readonly ending: 'BOUNDARY_REFUSED';
      readonly failureCode: BoundaryFailureCode;
      readonly win32: number | null;
      /**
       * Whether the target had begun executing before the refusal.
       *
       * A refusal always means the boundary is not established and anything it
       * created has been terminated. It does **not** always mean nothing ran:
       * in `JOBLIST` mode the target executes from its first instruction, and a
       * loss between then and the membership confirmation refuses a launch that
       * had already started. `'UNKNOWN'` is the honest answer when no status
       * could be read, and must be treated as `'YES'` by anything deciding
       * whether a launch had side effects.
       */
      readonly targetStarted: 'NO' | 'YES' | 'UNKNOWN';
      readonly status: BoundaryStatus | null;
    };

/** What the caller knows about the launch it is classifying. */
export interface BoundaryLaunchIdentity {
  /** The nonce this launch's request carried. */
  readonly nonce: string;
  /** The pid Node reports for the helper it started. */
  readonly helperPid: number | undefined;
}

export interface BoundaryEndingObservation {
  /** The helper's status, or `null` when it could not be read. */
  readonly status: BoundaryStatus | null;
  /** The helper's exit code, or `null` when a signal ended it. */
  readonly helperExitCode: number | null;
  readonly helperSignal: string | null;
  /**
   * Whether *this* caller asked for termination — its timeout, its byte
   * budget, its cancellation. Without it, every deliberate cancellation would
   * be indistinguishable from a boundary that was lost.
   */
  readonly callerRequestedTermination: boolean;
  /**
   * Who this status is supposed to belong to.
   *
   * When supplied, a status that does not carry this launch's nonce, or that
   * names a different helper, is refused as foreign rather than read. A caller
   * that omits it is saying it has no way to tell — which is only true of a
   * test constructing a status by hand.
   */
  readonly expect?: BoundaryLaunchIdentity;
}

function refused(
  failureCode: BoundaryFailureCode,
  win32: number | null,
  status: BoundaryStatus | null,
): BoundaryEnding {
  // `NO` is the one value a caller acts on to conclude a launch had no side
  // effects, so it is only ever taken from a status this launch can claim. No
  // status at all, and a status that never named its launch, both answer
  // `UNKNOWN` — which callers must treat as "it may have run". A status may
  // still report the *code* it refused with without proving whose it is; that
  // direction cannot mislead anyone into skipping a cleanup.
  const targetStarted =
    status === null || status.nonce === null
      ? ('UNKNOWN' as const)
      : status.targetStarted
        ? ('YES' as const)
        : ('NO' as const);
  return Object.freeze({
    ending: 'BOUNDARY_REFUSED' as const,
    failureCode,
    win32,
    targetStarted,
    status,
  });
}

function lost(reason: BoundaryLostReason, status: BoundaryStatus | null): BoundaryEnding {
  return Object.freeze({ ending: 'BOUNDARY_LOST' as const, reason, status });
}

/**
 * Decides how a finished boundary run ended.
 *
 * Pure, and total: every combination of inputs lands on exactly one ending,
 * and the ones that cannot be proven to be a completion are not one.
 */
export function classifyBoundaryEnding(observation: BoundaryEndingObservation): BoundaryEnding {
  const { status, helperExitCode, callerRequestedTermination, expect } = observation;

  if (status !== null && expect !== undefined) {
    // Identity before content. A status that belongs to another launch — the
    // previous run in a reused directory, or one a third party wrote — would
    // otherwise be read as this run's evidence, and its `boundary=OK` is
    // exactly the value that decides a run is trustworthy.
    //
    // The rule is asymmetric on purpose. A status carrying the *wrong* nonce or
    // naming a *different* helper is foreign, full stop. A status carrying no
    // nonce at all is a different thing: it is what a helper that refused
    // before it could name the launch leaves behind, and discarding it would
    // throw away the refusal's own code and turn a launch in which nothing was
    // created into one whose side effects are unknown. Such a status may
    // therefore report a *refusal* — the safe direction — but may never
    // establish ownership, which is what the second condition enforces.
    const wrongLaunch =
      (status.nonce !== null && status.nonce !== expect.nonce) ||
      (expect.helperPid !== undefined &&
        status.helperPid !== null &&
        status.helperPid !== expect.helperPid);
    const unidentifiedSuccess = status.nonce === null && status.boundary === 'OK';
    if (wrongLaunch || unidentifiedSuccess) {
      return refused('BOUNDARY_STATUS_FOREIGN', null, null);
    }
  }

  if (status === null) {
    // No readable report. If the helper's exit code says it refused, that is
    // still a refusal — the helper's contract is that nothing ran when it
    // exits that way. Anything else is unknown, and unknown is not success.
    const refusalExits: readonly number[] = [
      BOUNDARY_HELPER_EXIT.USAGE,
      BOUNDARY_HELPER_EXIT.BOUNDARY_FAILURE,
      BOUNDARY_HELPER_EXIT.INTERNAL_ERROR,
      BOUNDARY_HELPER_EXIT.OWNER_ALREADY_GONE,
    ];
    if (helperExitCode !== null && refusalExits.includes(helperExitCode)) {
      return refused('BOUNDARY_STATUS_UNREADABLE', null, null);
    }
    return lost('STATUS_UNREADABLE', null);
  }

  if (status.boundary === 'FAILED') {
    const code =
      status.failure !== null && KNOWN_FAILURE_CODES.has(status.failure)
        ? (status.failure as BoundaryFailureCode)
        : 'BOUNDARY_FAILURE_UNKNOWN';
    return refused(code, status.win32, status);
  }

  if (status.boundary !== 'OK') {
    // The helper neither reported ownership nor a failure. Whatever ended it
    // did so before it could decide, so no ownership was ever established.
    return refused('BOUNDARY_STATUS_UNREADABLE', status.win32, status);
  }

  // `boundary=OK` is a claim; `verifiedInJob` plus a child pid is the evidence
  // that justifies it. Without both, the claim is refused rather than trusted.
  if (!status.verifiedInJob || status.childPid === null) {
    return refused('BOUNDARY_STATUS_INCONSISTENT', status.win32, status);
  }

  if (callerRequestedTermination) {
    return Object.freeze({ ending: 'TERMINATED_BY_CALLER' as const, status });
  }

  // Ownership semantics took the tree down. An exit code may even be present —
  // it is still not a completion, because the child did not finish its work.
  if (status.terminatedByOwnerLoss || helperExitCode === BOUNDARY_HELPER_EXIT.OWNER_LOST) {
    return lost('OWNER_LOST', status);
  }

  if (status.childExitCode === null) {
    // The boundary owned a process and then vanished without reporting how it
    // ended. Spike 2 measured that this reads as a clean completion unless it
    // is given its own ending, so it has one.
    return lost('NO_CHILD_EXIT_OBSERVED', status);
  }

  return Object.freeze({
    ending: 'CHILD_EXITED' as const,
    childExitCode: status.childExitCode,
    status,
  });
}
