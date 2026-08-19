/**
 * Starting a process behind the native launch boundary — V3 slice 1.
 *
 * This is the smallest thing that can be called an adapter and still be
 * honest: it writes the request, starts the helper, waits for the boundary to
 * report ownership *or* refuse, and reports how the run ended. It owns no
 * timeout, no byte budget, no stdin vocabulary and no task state — those are
 * AO's, they stay in TypeScript, and they belong to the adapter slices that
 * come after this one. Nothing in `src/` calls this module yet, deliberately:
 * `runCommand`, the Claude writer and the verification runner are untouched by
 * slice 1.
 *
 * ── The streams belong to the caller ───────────────────────────────────────
 *
 * `helper.stdout` and `helper.stderr` are the child's streams, forwarded. This
 * module does not read them, because reading them is where budgets live. A
 * caller that never reads them will fill the pipe and stall the child — that
 * is the same contract `child_process.spawn` has, and it is stated here rather
 * than hidden behind a convenience that would quietly become policy.
 *
 * `helper.stdin` is the child's stdin, and it is the caller's too: this module
 * neither writes to it nor ends it. A child that reads to end-of-file waits
 * until the caller closes it. That is deliberate — stdin *delivery* is a
 * vocabulary AO already owns, and the boundary's own measured caveat (with a
 * helper in the middle, a child closing its read end early is observed through
 * the helper's `stdinForward` state rather than through the caller's own pipe)
 * belongs to the adapter that implements it, not here.
 *
 * ── Cancellation is helper death ───────────────────────────────────────────
 *
 * {@link OwnedProcess.terminate} kills the helper, and the helper holds the
 * only handle to a `KILL_ON_JOB_CLOSE` job, so the kernel takes the tree. There
 * is no second termination mechanism in *this* module: no `taskkill`, no
 * descendant walk, no list of pids anyone has to keep correct.
 *
 * There is, however, a second *coupling*, and it is worth knowing about rather
 * than being surprised by: node puts every child it spawns into a kill-on-close
 * job of its own (libuv does this on Windows), so a helper started here dies
 * with this process even before its own owner watch notices. Measured, not
 * assumed — it is why an AO-death status usually stops at `boundary=OK`
 * instead of recording an owner loss, and why that case is classified from the
 * absence of a child exit rather than from a flag.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyBoundaryEnding,
  decodeBoundaryStatus,
  encodeBoundaryRequest,
  type BoundaryEnding,
  type BoundaryLaunchMode,
  type BoundaryStatus,
} from './launch-boundary.js';

/** How long ownership may take to be reported before the launch is refused. */
export const DEFAULT_ESTABLISH_TIMEOUT_MS = 15_000;

const STATUS_POLL_INTERVAL_MS = 10;

const moduleDir = dirname(fileURLToPath(import.meta.url));

/**
 * Where the built boundary is.
 *
 * Resolved from this module's own location, so the answer is about the
 * artefact that is actually running rather than about a working directory: in
 * `dist/boundary/`, the boundary is `dist/native/ao-launch.exe`.
 */
export function resolveBoundaryExecutable(): { path?: string } {
  const path = resolve(moduleDir, '..', 'native', 'ao-launch.exe');
  return existsSync(path) ? { path } : {};
}

export interface OwnedProcessRequest {
  /**
   * Defaults to `JOBLIST`, and the difference is not a preference.
   *
   * `JOBLIST` places the process in the job **at creation**, so there is no
   * moment at which a created process is not yet owned. `SUSPENDED` creates
   * the process first and assigns it immediately afterwards, which proves
   * membership before the target's first instruction but leaves a window: a
   * helper killed *inside* it leaves a suspended process in no job, which
   * nothing will resume or reap. Both were measured, including against the
   * real Claude tree; the default is the one with no window.
   */
  readonly mode?: BoundaryLaunchMode;
  /** The canonical application path. This module resolves nothing. */
  readonly file: string;
  readonly args?: readonly string[];
  readonly verbatim?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * The process the boundary is coupled to. Defaults to this one, which is
   * what a productive caller wants; a different pid is only ever useful to a
   * measurement, and an unwatchable one is refused rather than ignored.
   */
  readonly ownerPid?: number;
  /** Where request and status files live. A temporary directory by default. */
  readonly workDir?: string;
  readonly establishTimeoutMs?: number;
}

/** A running, owned process. */
export interface OwnedProcess {
  /** The helper. Its stdio *is* the child's stdio, and it is the caller's. */
  readonly helper: ChildProcess;
  readonly helperPid: number;
  readonly childPid: number;
  readonly mode: BoundaryLaunchMode;
  /** Whether the kernel placed the process in the job at creation time. */
  readonly assignedAtCreation: boolean | null;
  /** The membership check that had to pass before the target could execute. */
  readonly verifiedInJob: boolean;
  readonly jobMembersAtStart: number | null;
  readonly workDir: string;
  /** Kills the helper; the job, and everything in it, goes with it. */
  terminate: () => void;
  /** Resolves when the helper is gone and its final status has been read. */
  readonly ending: Promise<BoundaryEnding>;
  /**
   * Removes the temporary directory this launch created. A `workDir` the
   * caller supplied is the caller's, and is left alone.
   */
  dispose: () => void;
}

export type OwnedProcessStart =
  | { readonly established: true; readonly process: OwnedProcess }
  | { readonly established: false; readonly ending: BoundaryEnding };

function readStatusFile(statusPath: string): BoundaryStatus | null {
  let text: string;
  try {
    text = readFileSync(statusPath, 'utf8');
  } catch {
    // Not written yet, or being replaced. Both are "nothing to read", and the
    // helper publishes by atomic rename so a partial read is not a third case.
    return null;
  }
  return decodeBoundaryStatus(text);
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/**
 * Starts one process behind the boundary.
 *
 * Fails closed, and that means exactly two things: verified ownership was not
 * established, and no unowned process tree is left alive — whatever was
 * created has been terminated with the job. There is no ordinary-spawn
 * fallback here, and adding one would turn a guarantee into a feature while
 * every caller kept believing the guarantee held.
 *
 * It does **not** mean the target never executed. In `JOBLIST` mode the target
 * runs from its first instruction, so a boundary lost between then and the
 * membership confirmation refuses a launch that had already started. A caller
 * deciding whether a launch could have had side effects must read
 * {@link BoundaryEnding} `targetStarted` on the refusal, and must treat
 * `'UNKNOWN'` — no status this launch could claim — as `'YES'`. Reading
 * `established: false` as "nothing happened" is the one inference this result
 * does not support.
 */
export async function startOwnedProcess(
  request: OwnedProcessRequest,
): Promise<OwnedProcessStart> {
  const executable = resolveBoundaryExecutable();
  if (executable.path === undefined) {
    return {
      established: false,
      ending: {
        ending: 'BOUNDARY_REFUSED',
        failureCode: 'BOUNDARY_EXECUTABLE_MISSING',
        win32: null,
        targetStarted: 'NO',
        status: null,
      },
    };
  }

  const ownWorkDir = request.workDir === undefined;
  const workDir = request.workDir ?? mkdtempSync(join(tmpdir(), 'ao-boundary-'));
  if (!ownWorkDir) mkdirSync(workDir, { recursive: true });
  const statusPath = join(workDir, 'status.txt');
  const requestPath = join(workDir, 'request.txt');
  const mode = request.mode ?? 'JOBLIST';

  // A launch's own name for its evidence. Everything read back has to carry
  // it, which is what makes a status left behind by an earlier run in a reused
  // directory impossible to mistake for this one's.
  const nonce = randomUUID();

  // And the earlier run's file is removed outright rather than only
  // out-argued: the first poll below happens before the helper has written
  // anything, so a stale `boundary=OK` would otherwise be read first.
  try {
    rmSync(statusPath, { force: true });
  } catch {
    /* checked immediately below, where it is a refusal rather than a throw */
  }
  if (existsSync(statusPath)) {
    if (ownWorkDir) {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* an empty temporary directory is not worth failing a refusal for */
      }
    }
    return {
      established: false,
      ending: {
        ending: 'BOUNDARY_REFUSED',
        failureCode: 'BOUNDARY_STATUS_FOREIGN',
        win32: null,
        targetStarted: 'NO',
        status: null,
      },
    };
  }

  const encoded = encodeBoundaryRequest({
    nonce,
    mode,
    file: request.file,
    args: request.args ?? [],
    verbatim: request.verbatim ?? false,
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
    ownerPid: request.ownerPid ?? process.pid,
    statusPath,
  });
  writeFileSync(requestPath, encoded, 'utf8');

  const helper = spawn(executable.path, [requestPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  let callerRequestedTermination = false;
  let spawnFailure: Error | null = null;
  const helperClosed = new Promise<{ code: number | null; signal: string | null }>((done) => {
    helper.once('error', (error) => {
      spawnFailure = error;
      done({ code: null, signal: null });
    });
    helper.once('close', (code, signal) => done({ code, signal }));
  });

  let endingSettled = false;
  let disposeRequested = false;
  const removeWorkDir = (): void => {
    if (!ownWorkDir) return;
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* a leftover temporary directory is not worth failing a run for */
    }
  };
  /**
   * Deferred until the ending has been read, deliberately. `ending` reads the
   * status file when the helper closes; a caller that disposed first would
   * turn a genuinely completed run into `BOUNDARY_LOST / STATUS_UNREADABLE`,
   * and no ordering rule in a doc comment would stop that from happening.
   */
  const dispose = (): void => {
    disposeRequested = true;
    if (endingSettled) removeWorkDir();
  };

  const ending = helperClosed.then((closed): BoundaryEnding => {
    if (spawnFailure !== null) {
      return {
        ending: 'BOUNDARY_REFUSED',
        failureCode: 'BOUNDARY_HELPER_SPAWN_FAILED',
        win32: null,
        targetStarted: 'NO',
        status: null,
      };
    }
    return classifyBoundaryEnding({
      status: readStatusFile(statusPath),
      helperExitCode: closed.code,
      helperSignal: closed.signal,
      callerRequestedTermination,
      expect: { nonce, helperPid: helper.pid },
    });
  });
  // Nothing may be lost if the caller only awaits `ending` later.
  void ending
    .catch(() => undefined)
    .then(() => {
      endingSettled = true;
      if (disposeRequested) removeWorkDir();
    });

  const terminate = (): void => {
    callerRequestedTermination = true;
    try {
      helper.kill('SIGKILL');
    } catch {
      /* already gone; `ending` still settles from the close event */
    }
  };

  // Wait for the boundary to report ownership — or to refuse, or to die.
  const deadline = Date.now() + (request.establishTimeoutMs ?? DEFAULT_ESTABLISH_TIMEOUT_MS);
  let settled: { code: number | null; signal: string | null } | null = null;
  void helperClosed.then((closed) => {
    settled = closed;
  });

  for (;;) {
    const status = readStatusFile(statusPath);
    if (
      status !== null &&
      // Identity first, and both halves of it: the pid this launch started is
      // checked as well as the nonce, because `OwnedProcess.helperPid` is read
      // from this file and a later adapter will act on it.
      status.nonce === nonce &&
      // The same rule the classifier applies, and no stricter: a status that
      // names a different helper is another launch's, one that names none
      // cannot establish this one. Diverging here would refuse at
      // establishment what classification then accepts.
      (status.helperPid === null || status.helperPid === (helper.pid ?? -1)) &&
      status.boundary === 'OK' &&
      status.verifiedInJob &&
      status.childPid !== null
    ) {
      return {
        established: true,
        process: {
          helper,
          // Node's own answer first: it started this process, and that is a
          // stronger authority about which pid it is than a file the process
          // wrote about itself. The status's value is checked against it above.
          helperPid: helper.pid ?? status.helperPid ?? -1,
          childPid: status.childPid,
          mode: status.mode ?? mode,
          assignedAtCreation: status.assignedAtCreation,
          verifiedInJob: status.verifiedInJob,
          jobMembersAtStart: status.jobMembersAtStart,
          workDir,
          terminate,
          ending,
          dispose,
        },
      };
    }

    if (settled !== null) {
      // The helper is gone and never reported verified ownership.
      const refusal = await ending;
      dispose();
      return { established: false, ending: refusal };
    }

    if (Date.now() >= deadline) {
      // Fail closed on silence too: a boundary that has not reported ownership
      // is not one, and whatever it may or may not have started dies with the
      // helper this kills.
      terminate();
      await helperClosed;
      // Read through the identity check, like every other status read here: a
      // status this launch cannot claim may not decide `targetStarted` either,
      // and this is the path on which the caller knows least to begin with.
      const timedOut = classifyBoundaryEnding({
        status: readStatusFile(statusPath),
        helperExitCode: null,
        helperSignal: null,
        callerRequestedTermination: false,
        expect: { nonce, helperPid: helper.pid },
      });
      const lastStatus = timedOut.ending === 'BOUNDARY_REFUSED' ? timedOut.status : null;
      const started =
        timedOut.ending === 'BOUNDARY_REFUSED' ? timedOut.targetStarted : ('UNKNOWN' as const);
      dispose();
      return {
        established: false,
        ending: {
          ending: 'BOUNDARY_REFUSED',
          failureCode: 'BOUNDARY_NOT_ESTABLISHED_IN_TIME',
          win32: null,
          // The helper never reported ownership, so what it may have started
          // is exactly what this caller cannot know. The kill above took the
          // tree either way.
          targetStarted: started,
          status: lastStatus,
        },
      };
    }

    await sleep(STATUS_POLL_INTERVAL_MS);
  }
}
