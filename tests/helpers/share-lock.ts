/**
 * A real Windows sharing lock on one file, for the tests that need a write to
 * fail while the read still succeeds.
 *
 * ── Why a second process, and why not the obvious alternatives ─────────────
 *
 * The ledger's fail-closed tail — `LAUNCH_MUST_NOT_START`, reached when the
 * record can be *neither* renamed onto *nor* unlinked — needs a state in which
 * three things hold at once: the file reads back as a valid ledger, the publish
 * is refused, and the fallback discard is refused too. Its own doc names the
 * production cause as a read-only or vanished administrative directory.
 *
 * The cheaper instruments were tried first and each was measured, not assumed:
 *
 *  - **`chmod 0o444` on the file.** The rename answers `EPERM`; the unlink
 *    **succeeds**, because libuv clears the read-only attribute before deleting.
 *    One failure, not two.
 *  - **`chmod 0o500` on the directory.** No effect at all: Windows ignores the
 *    read-only attribute on directories, so both the staging write and the
 *    unlink succeed.
 *  - **`icacls` deny ACEs**, on the file (`DE`), on the directory (`DC`), and on
 *    both at once, including with inheritance stripped so the file's whole DACL
 *    read `Max:(R)`. `icacls` reported success and **the unlink still
 *    succeeded**, so on this machine the test process is not subject to those
 *    denies. An instrument that silently stops biting would turn a regression
 *    into a vacuous pass, which is the failure mode this repository keeps
 *    finding, so it was rejected rather than tuned.
 *  - **`openSync(path, 'r')` from this process.** The rename is refused —
 *    `tests/v3-05-stale-lease-recovery.test.ts` already relies on that — and the
 *    unlink is not, because Node opens with `FILE_SHARE_DELETE`. That is the
 *    single-failure case, and it is exactly why it produces `HISTORY_DISCARDED`
 *    there rather than the state this helper is for.
 *
 * What is left is a handle opened **without** delete- or write-sharing, which
 * Node cannot ask for and .NET can. Measured on this platform: `read` returns
 * the bytes, `rename` onto it answers `EPERM`, `unlink` answers `EBUSY`, and the
 * file is byte-identical afterwards. That is the production condition, produced
 * by the operating system rather than described to the code under test — no
 * seam is added to `src` for it, and nothing about the retraction path is
 * substituted.
 *
 * It is also not an exotic state. A virus scanner, a backup agent or an editor
 * holding a file this way is ordinary on Windows, which is the platform this
 * build declares.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, rmSync } from 'node:fs';

/** A held lock. `release()` waits until the file is writable again. */
export interface ShareLock {
  readonly release: () => Promise<void>;
}

/** How long to wait for the holder to take, and to give up, the handle. */
const LOCK_DEADLINE_MS = 30_000;

/**
 * Whether this process can open `path` for **writing**.
 *
 * The direct probe for the lock rather than a proxy for it: a
 * `FileShare.Read` holder permits further readers and refuses everybody who
 * wants write access, so this answers `false` exactly while the lock is in
 * force. Both halves of the helper assert on it — a holder that never took the
 * handle, and a release that has not landed yet, are the two ways a case built
 * on this could quietly stop testing anything.
 */
function writableNow(path: string): boolean {
  let handle: number | null = null;
  try {
    handle = openSync(path, 'r+');
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== null) closeSync(handle);
  }
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`share lock: ${what} within ${LOCK_DEADLINE_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Holds `path` open with `FileShare.Read` until the returned lock is released.
 *
 * Resolves only once the lock is **observed** to be in force, so a caller can
 * never proceed against a holder that failed to start. The holder times itself
 * out as a backstop against a killed test run leaving a handle behind; the
 * timeout is far longer than any case here and is not the release mechanism.
 */
export async function shareLockOn(path: string): Promise<ShareLock> {
  const flag = `${path}.share-lock-held`;
  rmSync(flag, { force: true });
  const script =
    `$f=[System.IO.File]::Open('${path}',[System.IO.FileMode]::Open,` +
    `[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); ` +
    `Set-Content -LiteralPath '${flag}' -Value held; ` +
    `Start-Sleep -Seconds 120; $f.Close()`;
  const holder: ChildProcess = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { stdio: 'ignore' },
  );
  // A `ChildProcess` with no `error` listener turns a failed spawn into an
  // **uncaught** exception in the worker rather than a failed case, which is a
  // crash a reader cannot attribute. There is nothing to do about it beyond
  // recording it: the `until` below is what actually fails the caller, and it
  // does so with a sentence naming the lock.
  let spawnFailure: Error | null = null;
  holder.on('error', (error: Error) => {
    spawnFailure = error;
  });

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    holder.kill();
    await until(() => writableNow(path), 'the holder did not give the handle back');
    rmSync(flag, { force: true });
  };

  try {
    await until(
      () => existsSync(flag) || spawnFailure !== null,
      'the holder never started',
    );
    if (spawnFailure !== null) throw spawnFailure;
    // Asserted rather than inferred from the flag: the flag says the holder
    // reached its own next statement, and this says the handle is doing what
    // the case needs it to do.
    //
    // `existsSync` is in the conjunction because `writableNow` cannot tell a
    // locked file from a **missing** one — both refuse to open — so without it
    // a path that had been deleted would read as perfectly locked and the
    // caller would go on to measure nothing.
    await until(
      () => existsSync(path) && !writableNow(path),
      'the handle never became exclusive, or the file is gone',
    );
  } catch (error) {
    await release();
    throw error;
  }

  return { release };
}

/**
 * Releases every lock, and **never throws**.
 *
 * The form a `finally` may use. `release()` on its own throws when the handle
 * does not come back, and a throw out of a `finally` *replaces* the exception
 * already travelling — so a case that failed on its real assertion would be
 * reported as a cleanup timeout instead, which is precisely the kind of
 * misattributed failure this repository keeps paying for.
 *
 * Swallowing is safe here rather than merely convenient: a handle that is still
 * held goes on refusing writes to that path, and both callers write to it again
 * afterwards, so a release that did not land fails the case anyway — with an
 * error about the write, which is the truthful one.
 */
export async function releaseAll(locks: readonly ShareLock[]): Promise<void> {
  for (const lock of locks) {
    try {
      await lock.release();
    } catch {
      /* see above: the next write to the path is what reports this. */
    }
  }
}
