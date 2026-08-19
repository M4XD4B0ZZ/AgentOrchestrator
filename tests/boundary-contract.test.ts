/**
 * V3 slice 1 — the launch boundary's *contract*, in process.
 *
 * This file measures only what can be decided without a process: how a launch
 * request is encoded for the native boundary, how the boundary's status is
 * read back, and — the part the ADR insists on — how an ending is classified.
 *
 * The ownership guarantee itself is not measurable here. It is measured
 * against the built artefact in
 * `tests/dist-artifact/launch-boundary-dist-artifact.mjs`, with real
 * processes, real deaths and an independent liveness instrument. What lives
 * here is the vocabulary those measurements are reported in, and one defect
 * the spike found the hard way:
 *
 *   a boundary that established ownership and then vanished without ever
 *   reporting a child exit looks *exactly* like a completed run.
 *
 * So the load-bearing tests below are the negative ones: every path where the
 * outcome is unknown must classify as `BOUNDARY_LOST` or `BOUNDARY_REFUSED`,
 * and never as `CHILD_EXITED`.
 */

import { describe, expect, it } from 'vitest';

import {
  BOUNDARY_HELPER_EXIT,
  classifyBoundaryEnding,
  decodeBoundaryStatus,
  encodeBoundaryRequest,
  InvalidBoundaryRequestError,
} from '../src/boundary/launch-boundary.js';

const STATUS_PATH = 'C:\\Temp\\ao-boundary\\status.txt';

/** Reads an encoded request back into the `key -> values` shape the helper parses. */
function decodeRequest(encoded: string): Map<string, string[]> {
  const decoded = new Map<string, string[]>();
  for (const line of encoded.split('\n')) {
    if (line.length === 0) continue;
    const split = line.indexOf('=');
    expect(split).toBeGreaterThan(0);
    const key = line.slice(0, split);
    const value = Buffer.from(line.slice(split + 1), 'base64').toString('utf8');
    const existing = decoded.get(key);
    if (existing === undefined) decoded.set(key, [value]);
    else existing.push(value);
  }
  return decoded;
}

/** A status file exactly as the helper writes one. */
function statusText(entries: Readonly<Record<string, string>>, eol = '\n'): string {
  return Object.entries(entries)
    .map(([key, value]) => `${key}=${Buffer.from(value, 'utf8').toString('base64')}`)
    .join(eol);
}

/** The status of a run that established ownership and reported a child exit. */
function completedStatus(exitCode: string): string {
  return statusText({
    helperPid: '4242',
    mode: 'SUSPENDED',
    jobCreated: 'true',
    boundary: 'OK',
    childPid: '1234',
    verifiedInJob: 'true',
    jobMembersAtStart: '1',
    childExitCode: exitCode,
    terminatedByOwnerLoss: 'false',
    jobMembersAtEnd: '0',
  });
}

describe('encodeBoundaryRequest', () => {
  it('encodes every value as base64 so spaces, quotes and Unicode survive untouched', () => {
    const encoded = encodeBoundaryRequest({
      mode: 'SUSPENDED',
      file: 'C:\\Program Files\\node\\node.exe',
      args: ['--eval', 'console.log("日本 λ")', ''],
      verbatim: false,
      cwd: 'C:\\cwd with spaces und Ümläute',
      env: { PATH: 'C:\\Windows\\System32', GREETING: 'hello "world"' },
      ownerPid: 4321,
      statusPath: STATUS_PATH,
    });

    const decoded = decodeRequest(encoded);
    expect(decoded.get('file')).toEqual(['C:\\Program Files\\node\\node.exe']);
    expect(decoded.get('arg')).toEqual(['--eval', 'console.log("日本 λ")', '']);
    expect(decoded.get('cwd')).toEqual(['C:\\cwd with spaces und Ümläute']);
    expect(decoded.get('env')).toEqual(['PATH=C:\\Windows\\System32', 'GREETING=hello "world"']);
    expect(decoded.get('ownerPid')).toEqual(['4321']);
    expect(decoded.get('statusPath')).toEqual([STATUS_PATH]);
    expect(decoded.get('verbatim')).toEqual(['false']);
    expect(decoded.get('mode')).toEqual(['SUSPENDED']);
  });

  it('emits no key that could weaken containment', () => {
    // The measurement instrument that proves the guarantee is load-bearing —
    // an inheritable job handle with no handle list — is a *separate,
    // test-only* build of the helper. If a request key ever reappeared here,
    // the production boundary would carry its own bypass.
    const encoded = encodeBoundaryRequest({
      mode: 'JOBLIST',
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [],
      verbatim: true,
      ownerPid: 7,
      statusPath: STATUS_PATH,
    });

    const keys = new Set(decodeRequest(encoded).keys());
    expect(keys.has('inheritJobHandle')).toBe(false);
    expect(keys.has('noHandleList')).toBe(false);
    expect(keys.has('failAt')).toBe(false);
    expect(keys.has('jobFlags')).toBe(false);
    expect([...keys].sort()).toEqual(['file', 'mode', 'ownerPid', 'statusPath', 'verbatim']);
  });

  it('refuses an owner pid that is not a positive integer', () => {
    // No owner means no coupling, and an uncoupled boundary can outlive the
    // process it serves. It is refused before anything is written.
    for (const ownerPid of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        encodeBoundaryRequest({
          mode: 'SUSPENDED',
          file: 'C:\\Windows\\System32\\cmd.exe',
          args: [],
          verbatim: false,
          ownerPid,
          statusPath: STATUS_PATH,
        }),
      ).toThrow(InvalidBoundaryRequestError);
    }
  });

  it('refuses an environment entry a block cannot represent', () => {
    const base = {
      mode: 'SUSPENDED',
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: [] as readonly string[],
      verbatim: false,
      ownerPid: 7,
      statusPath: STATUS_PATH,
    } as const;

    expect(() => encodeBoundaryRequest({ ...base, env: { 'A=B': 'x' } })).toThrow(
      InvalidBoundaryRequestError,
    );
    expect(() => encodeBoundaryRequest({ ...base, env: { A: 'x\u0000y' } })).toThrow(
      InvalidBoundaryRequestError,
    );
    expect(() => encodeBoundaryRequest({ ...base, env: { '': 'x' } })).toThrow(
      InvalidBoundaryRequestError,
    );
  });

  it('refuses a request line that could not be read back as one line', () => {
    expect(() =>
      encodeBoundaryRequest({
        mode: 'SUSPENDED',
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['ok'],
        verbatim: false,
        ownerPid: 7,
        statusPath: 'C:\\status\u0000.txt',
      }),
    ).toThrow(InvalidBoundaryRequestError);
  });
});

describe('decodeBoundaryStatus', () => {
  it('reads the helper status, whatever line ending it was written with', () => {
    for (const eol of ['\n', '\r\n']) {
      const status = decodeBoundaryStatus(
        statusText({ boundary: 'OK', childPid: '1234', childExitCode: '-1073741819' }, eol),
      );
      expect(status?.boundary).toBe('OK');
      expect(status?.childPid).toBe(1234);
      // A crashing child's exit code is a signed 32-bit value; it must not be
      // rounded, truncated or lost on the way through the status file.
      expect(status?.childExitCode).toBe(-1073741819);
    }
  });

  it('reports an unreadable status as unreadable rather than as an empty one', () => {
    expect(decodeBoundaryStatus('boundary=not-base64-@@@')).toBeNull();
    expect(decodeBoundaryStatus('this is not a status file at all')).toBeNull();
  });

  it('reads an empty status file as an empty status, not as a failure to read one', () => {
    const status = decodeBoundaryStatus('');
    expect(status).not.toBeNull();
    expect(status?.boundary).toBeNull();
  });
});

describe('classifyBoundaryEnding', () => {
  it('reports the child exit code when the boundary observed the child exit', () => {
    const ending = classifyBoundaryEnding({
      status: decodeBoundaryStatus(completedStatus('42')),
      helperExitCode: 0,
      helperSignal: null,
      callerRequestedTermination: false,
    });
    expect(ending).toMatchObject({ ending: 'CHILD_EXITED', childExitCode: 42 });
  });

  it('reports BOUNDARY_LOST when ownership was established and no child exit ever arrived', () => {
    // Spike 2, case D: the helper is killed, the tree dies correctly — and the
    // first version of the caller called this `COMPLETED`. This assertion is
    // the reason `BOUNDARY_LOST` exists.
    const ending = classifyBoundaryEnding({
      status: decodeBoundaryStatus(
        statusText({
          boundary: 'OK',
          childPid: '1234',
          verifiedInJob: 'true',
          jobMembersAtStart: '1',
        }),
      ),
      helperExitCode: null,
      helperSignal: 'SIGKILL',
      callerRequestedTermination: false,
    });
    expect(ending).toMatchObject({ ending: 'BOUNDARY_LOST', reason: 'NO_CHILD_EXIT_OBSERVED' });
  });

  it('reports BOUNDARY_LOST when the helper reports that it lost its owner', () => {
    const ending = classifyBoundaryEnding({
      status: decodeBoundaryStatus(
        statusText({
          boundary: 'OK',
          childPid: '1234',
          verifiedInJob: 'true',
          terminatedByOwnerLoss: 'true',
          childExitCode: '1',
        }),
      ),
      helperExitCode: BOUNDARY_HELPER_EXIT.OWNER_LOST,
      helperSignal: null,
      callerRequestedTermination: false,
    });
    // A child exit code is present, and is still not a completion: the tree
    // was terminated by the ownership semantics, not by the child finishing.
    expect(ending).toMatchObject({ ending: 'BOUNDARY_LOST', reason: 'OWNER_LOST' });
  });

  it('separates a termination the caller asked for from a boundary it lost', () => {
    const ending = classifyBoundaryEnding({
      status: decodeBoundaryStatus(
        statusText({ boundary: 'OK', childPid: '1234', verifiedInJob: 'true' }),
      ),
      helperExitCode: null,
      helperSignal: 'SIGKILL',
      callerRequestedTermination: true,
    });
    expect(ending).toMatchObject({ ending: 'TERMINATED_BY_CALLER' });
  });

  it('reports the boundary failure code when ownership was refused', () => {
    const ending = classifyBoundaryEnding({
      status: decodeBoundaryStatus(
        statusText({
          boundary: 'FAILED',
          failure: 'OWNED_CONTAINMENT_CREATE',
          win32: '2',
        }),
      ),
      helperExitCode: BOUNDARY_HELPER_EXIT.BOUNDARY_FAILURE,
      helperSignal: null,
      callerRequestedTermination: false,
    });
    expect(ending).toMatchObject({
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'OWNED_CONTAINMENT_CREATE',
      win32: 2,
    });
  });

  it('refuses a status that claims ownership it never verified', () => {
    // `boundary=OK` without `verifiedInJob=true` is a claim without its
    // evidence. Reading it as ownership would accept exactly the state the
    // membership check exists to rule out.
    const ending = classifyBoundaryEnding({
      status: decodeBoundaryStatus(statusText({ boundary: 'OK', childPid: '1234' })),
      helperExitCode: 0,
      helperSignal: null,
      callerRequestedTermination: false,
    });
    expect(ending).toMatchObject({
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'BOUNDARY_STATUS_INCONSISTENT',
    });
  });

  it('never reads a missing status as a completion', () => {
    const ending = classifyBoundaryEnding({
      status: null,
      helperExitCode: 0,
      helperSignal: null,
      callerRequestedTermination: false,
    });
    expect(ending).toMatchObject({ ending: 'BOUNDARY_LOST', reason: 'STATUS_UNREADABLE' });
  });

  it('reports a refusal that never reached a status file as a refusal', () => {
    const ending = classifyBoundaryEnding({
      status: null,
      helperExitCode: BOUNDARY_HELPER_EXIT.BOUNDARY_FAILURE,
      helperSignal: null,
      callerRequestedTermination: false,
    });
    expect(ending).toMatchObject({
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'BOUNDARY_STATUS_UNREADABLE',
    });
  });

  it('reports an owner that was already gone as a refusal, not as a lost boundary', () => {
    // Nothing ran: the helper refuses to launch for an owner it cannot watch.
    const ending = classifyBoundaryEnding({
      status: decodeBoundaryStatus(
        statusText({ boundary: 'FAILED', failure: 'OWNED_CONTAINMENT_OWNER_GONE', win32: '87' }),
      ),
      helperExitCode: BOUNDARY_HELPER_EXIT.OWNER_ALREADY_GONE,
      helperSignal: null,
      callerRequestedTermination: false,
    });
    expect(ending).toMatchObject({
      ending: 'BOUNDARY_REFUSED',
      failureCode: 'OWNED_CONTAINMENT_OWNER_GONE',
    });
  });
});
