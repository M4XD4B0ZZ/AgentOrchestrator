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
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type WriteAccessStatus =
  | 'WRITABLE'
  | 'DIRECTORY_MISSING'
  | 'NOT_WRITABLE';

export interface WriteAccessResult {
  readonly label: string;
  readonly path: string;
  readonly status: WriteAccessStatus;
  readonly directoryExisted: boolean;
  readonly reason: string;
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

export function probeWriteAccess(target: WriteProbeTarget): WriteAccessResult {
  const { label, path } = target;
  let directoryExisted = existsSync(path);

  if (!directoryExisted) {
    if (!target.createIfMissing) {
      return {
        label,
        path,
        status: 'DIRECTORY_MISSING',
        directoryExisted: false,
        reason: 'Directory does not exist. It was not created, because the doctor does not modify the environment.',
        probeFileRemoved: true,
      };
    }
    try {
      mkdirSync(path, { recursive: true });
      directoryExisted = false;
    } catch (error) {
      return {
        label,
        path,
        status: 'NOT_WRITABLE',
        directoryExisted: false,
        reason: `Directory could not be created: ${errorMessage(error)}`,
        probeFileRemoved: true,
      };
    }
  }

  const probeFile = join(path, `.agent-loop-write-probe-${randomUUID()}.tmp`);
  let created = false;

  try {
    writeFileSync(probeFile, PROBE_CONTENT, { encoding: 'utf8', flag: 'wx' });
    created = true;
  } catch (error) {
    return {
      label,
      path,
      status: 'NOT_WRITABLE',
      directoryExisted,
      reason: `Write probe failed: ${errorMessage(error)}`,
      probeFileRemoved: true,
    };
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
  return {
    label,
    path,
    status: 'WRITABLE',
    directoryExisted,
    reason: removed
      ? 'Write probe succeeded and the probe file was removed.'
      : 'Write probe succeeded but the probe file could not be removed.',
    probeFileRemoved: removed,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}
