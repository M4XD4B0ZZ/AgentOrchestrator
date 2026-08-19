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
 * is no second termination mechanism: no `taskkill`, no descendant walk, no
 * list of pids anyone has to keep correct.
 */

import { spawn, type ChildProcess } from 'node:child_process';
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
  /** Defaults to `SUSPENDED`, where membership is proven before any execution. */
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
 * Fails closed: every path that cannot establish verified ownership resolves
 * to `established: false` with the boundary's own failure code, and no target
 * has run when it does. There is no ordinary-spawn fallback here, and adding
 * one would turn a guarantee into a feature while every caller kept believing
 * the guarantee held.
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
        status: null,
      },
    };
  }

  const ownWorkDir = request.workDir === undefined;
  const workDir = request.workDir ?? mkdtempSync(join(tmpdir(), 'ao-boundary-'));
  if (!ownWorkDir) mkdirSync(workDir, { recursive: true });
  const statusPath = join(workDir, 'status.txt');
  const requestPath = join(workDir, 'request.txt');
  const mode = request.mode ?? 'SUSPENDED';

  const encoded = encodeBoundaryRequest({
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

  const dispose = (): void => {
    if (!ownWorkDir) return;
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* a leftover temporary directory is not worth failing a run for */
    }
  };

  const ending = helperClosed.then((closed): BoundaryEnding => {
    if (spawnFailure !== null) {
      return {
        ending: 'BOUNDARY_REFUSED',
        failureCode: 'BOUNDARY_HELPER_SPAWN_FAILED',
        win32: null,
        status: null,
      };
    }
    return classifyBoundaryEnding({
      status: readStatusFile(statusPath),
      helperExitCode: closed.code,
      helperSignal: closed.signal,
      callerRequestedTermination,
    });
  });
  // Nothing may be lost if the caller only awaits `ending` later.
  void ending.catch(() => undefined);

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
    if (status !== null && status.boundary === 'OK' && status.verifiedInJob && status.childPid !== null) {
      return {
        established: true,
        process: {
          helper,
          helperPid: status.helperPid ?? helper.pid ?? -1,
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
      const lastStatus = readStatusFile(statusPath);
      dispose();
      return {
        established: false,
        ending: {
          ending: 'BOUNDARY_REFUSED',
          failureCode: 'BOUNDARY_NOT_ESTABLISHED_IN_TIME',
          win32: null,
          status: lastStatus,
        },
      };
    }

    await sleep(STATUS_POLL_INTERVAL_MS);
  }
}
