/**
 * Reversible write probes.
 *
 * The doctor must know whether it will later be able to persist task state and
 * create worktrees. It finds out by writing one uniquely named, empty marker
 * file and deleting it immediately.
 *
 * Rules:
 *  - The probe file is deleted in a `finally` block, so it does not survive a
 *    failure either.
 *  - Nothing sensitive is ever written into it.
 *  - A missing target directory is *reported*, not silently created — creating
 *    directories is a setup concern, not a diagnostic one.
 *  - Failures are reported as a fixed {@link WriteAccessStatus} plus an
 *    allow-listed errno identifier. Exception messages are never persisted:
 *    they routinely embed paths and OS text and have no place in a report
 *    (AO-002).
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { safeErrnoCode } from '../core/safe-error.js';

export type WriteAccessStatus = 'WRITABLE' | 'DIRECTORY_MISSING' | 'NOT_WRITABLE';

export type WriteAccessReasonCode =
  | 'WRITABLE'
  | 'PROBE_FILE_NOT_REMOVED'
  | 'DIRECTORY_MISSING'
  | 'DIRECTORY_CREATE_FAILED'
  | 'WRITE_PROBE_FAILED';

/** Static descriptions. The only write-access prose that reaches a report. */
export const WRITE_ACCESS_REASON_TEXT: Readonly<Record<WriteAccessReasonCode, string>> =
  Object.freeze({
    WRITABLE: 'Write probe succeeded and the probe file was removed.',
    PROBE_FILE_NOT_REMOVED: 'Write probe succeeded but the probe file could not be removed.',
    DIRECTORY_MISSING:
      'Directory does not exist. It was not created, because the doctor does not modify the environment.',
    DIRECTORY_CREATE_FAILED: 'Directory does not exist and could not be created.',
    WRITE_PROBE_FAILED: 'A file could not be created in this directory.',
  });

export interface WriteAccessResult {
  readonly label: string;
  readonly path: string;
  readonly status: WriteAccessStatus;
  readonly directoryExisted: boolean;
  readonly reasonCode: WriteAccessReasonCode;
  /** Static description of {@link reasonCode}. */
  readonly reason: string;
  /** Allow-listed errno identifier (`EACCES`, `EPERM`, …), never a message. */
  readonly errnoCode: string | null;
  /** Proof that the probe file did not survive the check. */
  readonly probeFileRemoved: boolean;
}

export interface WriteProbeTarget {
  readonly label: string;
  readonly path: string;
  /**
   * Whether a missing directory should be created for the probe. Only used for
   * the diagnostics directory, which the doctor legitimately owns.
   */
  readonly createIfMissing: boolean;
}

const PROBE_CONTENT = 'agent-loop doctor write probe\n';

function outcome(
  target: WriteProbeTarget,
  status: WriteAccessStatus,
  reasonCode: WriteAccessReasonCode,
  directoryExisted: boolean,
  errnoCode: string | null,
  probeFileRemoved: boolean,
): WriteAccessResult {
  return {
    label: target.label,
    path: target.path,
    status,
    directoryExisted,
    reasonCode,
    reason: WRITE_ACCESS_REASON_TEXT[reasonCode],
    errnoCode,
    probeFileRemoved,
  };
}

export function probeWriteAccess(target: WriteProbeTarget): WriteAccessResult {
  const { path } = target;
  let directoryExisted = existsSync(path);

  if (!directoryExisted) {
    if (!target.createIfMissing) {
      return outcome(target, 'DIRECTORY_MISSING', 'DIRECTORY_MISSING', false, null, true);
    }
    try {
      mkdirSync(path, { recursive: true });
      directoryExisted = false;
    } catch (error) {
      return outcome(
        target,
        'NOT_WRITABLE',
        'DIRECTORY_CREATE_FAILED',
        false,
        safeErrnoCode(error),
        true,
      );
    }
  }

  const probeFile = join(path, `.agent-loop-write-probe-${randomUUID()}.tmp`);
  let created = false;

  try {
    writeFileSync(probeFile, PROBE_CONTENT, { encoding: 'utf8', flag: 'wx' });
    created = true;
  } catch (error) {
    return outcome(
      target,
      'NOT_WRITABLE',
      'WRITE_PROBE_FAILED',
      directoryExisted,
      safeErrnoCode(error),
      true,
    );
  } finally {
    if (created) {
      try {
        rmSync(probeFile, { force: true });
      } catch {
        // Reported below via existsSync.
      }
    }
  }

  const removed = !existsSync(probeFile);
  return outcome(
    target,
    'WRITABLE',
    removed ? 'WRITABLE' : 'PROBE_FILE_NOT_REMOVED',
    directoryExisted,
    null,
    removed,
  );
}
