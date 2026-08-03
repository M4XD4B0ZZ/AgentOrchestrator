/**
 * AO-008-S1-R1: the teardown contract of `tests/exec.test.ts`, proven on its own.
 *
 * `tests/exec.test.ts` is excluded from `test:foundation-safe` because it starts
 * real, deliberately unkillable child processes. Its *teardown* has no such
 * excuse, so it lives in an injectable registry and is asserted here — with
 * mocked filesystem, process and timer seams, and never against a real foreign
 * PID. Two findings are locked down:
 *
 *   F1 — a PID was claimed by `Number.parseInt`, which stops at the first
 *        non-digit. `"17628.5"` therefore became the live, unrelated PID 17628.
 *   F2 — teardown removed directories in a loop with no per-item handling, so
 *        the first `rmSync` failure aborted the hook and stranded everything
 *        after it.
 */

import { describe, expect, it } from 'vitest';

import { ExecArtifactRegistry, parseOwnedHelperPid } from './helpers/exec-cleanup.js';

/** An errno-style error, the shape `fs` and `process.kill` actually throw. */
function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`mock ${code}`);
  error.code = code;
  return error;
}

/**
 * A registry wired to recording stubs. Nothing here touches the filesystem, a
 * real process or a real timer.
 */
function harness(options: {
  readonly pidFiles?: Readonly<Record<string, string | Error>>;
  readonly dead?: readonly number[];
  readonly killFails?: Readonly<Record<number, Error>>;
  readonly removeFails?: Readonly<Record<string, Error>>;
}) {
  const killed: number[] = [];
  const removed: string[] = [];
  const read: string[] = [];
  const settled: number[] = [];
  const checked: number[] = [];

  const registry = new ExecArtifactRegistry({
    readPidFile: (path: string): string => {
      read.push(path);
      const entry = options.pidFiles?.[path];
      if (entry === undefined) throw errnoError('ENOENT');
      if (entry instanceof Error) throw entry;
      return entry;
    },
    isAlive: (pid: number): boolean => {
      checked.push(pid);
      return !(options.dead ?? []).includes(pid);
    },
    kill: (pid: number): void => {
      killed.push(pid);
      const failure = options.killFails?.[pid];
      if (failure !== undefined) throw failure;
    },
    removeDir: (dir: string): void => {
      removed.push(dir);
      const failure = options.removeFails?.[dir];
      if (failure !== undefined) throw failure;
    },
    settle: async (ms: number): Promise<void> => {
      settled.push(ms);
    },
    settleMs: 0,
  });

  // `checked` is the liveness probe. A PID that reaches it has already been
  // aimed at the outside world, so an empty `checked` is the proof that a
  // refused value never left the registry at all.
  return { registry, killed, removed, read, settled, checked };
}

/** The errors an `AggregateError` collected, or a failure if it is not one. */
function aggregated(error: unknown): readonly unknown[] {
  expect(error).toBeInstanceOf(AggregateError);
  return (error as AggregateError).errors;
}

describe('parseOwnedHelperPid refuses anything that is not entirely a PID', () => {
  it.each<[string, string]>([
    ['empty', ''],
    ['whitespace only', '   '],
    ['zero', '0'],
    ['negative', '-1'],
    ['explicitly signed', '+1'],
    ['fractional', '17628.5'],
    ['trailing zero fraction', '17628.0'],
    ['exponential', '1e3'],
    ['hexadecimal', '0x10'],
    ['binary', '0b10'],
    ['octal', '0o10'],
    ['numeric prefix', '123abc'],
    ['two numbers', '123 456'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['above MAX_SAFE_INTEGER', String(Number.MAX_SAFE_INTEGER + 1)],
    ['an absurdly long digit run', '9'.repeat(400)],
    ['leading zero', '0123'],
    ['a newline between digits', '17\n628'],
    ['a tab suffix', '17628\tx'],
  ])('refuses %s', (_label, raw) => {
    expect(parseOwnedHelperPid(raw)).toBeUndefined();
  });

  it.each<[string, string, number]>([
    ['the smallest PID', '1', 1],
    ['a plain PID', '17628', 17_628],
    ['MAX_SAFE_INTEGER itself', String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ['a trailing newline', '17628\n', 17_628],
    ['surrounding spaces', ' 17628 ', 17_628],
    ['surrounding CRLF', '\r\n17628\r\n', 17_628],
  ])('accepts %s', (_label, raw, expected) => {
    expect(parseOwnedHelperPid(raw)).toBe(expected);
  });

  it('never returns a value that is not a positive safe integer', () => {
    const samples = ['', ' ', '0', '-1', '1', '17628.5', '9007199254740993', '  42\n'];
    for (const sample of samples) {
      const pid = parseOwnedHelperPid(sample);
      if (pid === undefined) continue;
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(pid).toBeGreaterThan(0);
    }
  });
});

describe('a rejected PID file never reaches the kill seam', () => {
  it.each(['', '   ', '0', '-1', '+1', '17628.5', '1e3', '0x10', '123abc', 'NaN'])(
    'ignores a PID file holding %j',
    async (contents) => {
      const h = harness({ pidFiles: { 'C:\\pid.txt': contents } });
      h.registry.registerPidFile('C:\\pid.txt');
      h.registry.registerTempDir('C:\\scratch');

      await expect(h.registry.cleanUp()).resolves.toBeUndefined();

      expect(h.read).toEqual(['C:\\pid.txt']);
      expect(h.killed).toEqual([]);
      expect(h.removed).toEqual(['C:\\scratch']);
    },
  );

  it('registers a valid PID exactly once, however often it is claimed', () => {
    const h = harness({ pidFiles: { 'C:\\pid.txt': '17628\n' } });
    expect(h.registry.claimPid('C:\\pid.txt')).toBe(17_628);
    expect(h.registry.claimPid('C:\\pid.txt')).toBe(17_628);
    h.registry.registerPid(17_628);
    expect(h.registry.claimedPids()).toEqual([17_628]);
  });

  it('keeps a rejected value out of the cleanup set entirely', () => {
    const h = harness({ pidFiles: { 'C:\\pid.txt': '17628.5' } });
    expect(h.registry.claimPid('C:\\pid.txt')).toBeNull();
    expect(h.registry.claimedPids()).toEqual([]);
  });
});

/**
 * AO-008-S1-R1-REREV-F1: a PID file is only one of the two ways a PID enters
 * the registry. `registerPid` takes a number directly, and used to store
 * whatever it was handed. `registerPid(-1)` therefore reached both `isAlive`
 * and `kill` — where on POSIX a negative argument means "every process in that
 * process group", the exact opposite of the owned-PID guarantee. The invariant
 * belongs at that lowest common entry point, which the parser sits above rather
 * than in front of.
 */
describe('a directly registered PID must be one this run could own', () => {
  /** Every direct registration the registry must refuse, whoever hands it over. */
  const REFUSED: readonly [string, number][] = [
    ['a negative PID', -1], // A — a POSIX process-group signal, not a process
    ['zero', 0], // B — POSIX: the caller's own process group
    ['NaN', Number.NaN], // C
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a fraction', 1.5], // D
    ['a negative fraction', -1.5],
    ['one past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 1], // E — no longer exact
    ['one past MIN_SAFE_INTEGER', Number.MIN_SAFE_INTEGER - 1],
    ['an absurdly large finite number', 1e308],
    ['a negative safe integer', -17_628],
  ];

  it.each(REFUSED)('never stores %s', (_label, pid) => {
    const h = harness({});
    h.registry.registerPid(pid);
    expect(h.registry.claimedPids()).toEqual([]);
  });

  it.each(REFUSED)('never aims cleanup at %s', async (_label, pid) => {
    const h = harness({});
    h.registry.registerPid(pid);
    h.registry.registerTempDir('C:\\scratch');

    // Refusing the value is not itself a teardown failure, and it does not cost
    // the artefacts that *are* valid their cleanup.
    await expect(h.registry.cleanUp()).resolves.toBeUndefined();

    expect(h.checked).toEqual([]);
    expect(h.killed).toEqual([]);
    expect(h.removed).toEqual(['C:\\scratch']);
  });

  // F
  it.each<[string, number]>([
    ['the smallest PID', 1],
    ['a plain PID', 17_628],
    ['MAX_SAFE_INTEGER itself', Number.MAX_SAFE_INTEGER],
  ])('stores %s once and acts on it once', async (_label, pid) => {
    const h = harness({});
    h.registry.registerPid(pid);
    h.registry.registerPid(pid);

    expect(h.registry.claimedPids()).toEqual([pid]);

    await expect(h.registry.cleanUp()).resolves.toBeUndefined();
    expect(h.checked).toEqual([pid]);
    expect(h.killed).toEqual([pid]);
  });

  // G
  it('keeps only the valid PID out of a mixed run of registrations', async () => {
    const h = harness({});
    for (const pid of [-1, 0, 17_628.5, 17_628, Number.NaN, 17_628, Number.MAX_SAFE_INTEGER + 1]) {
      h.registry.registerPid(pid);
    }

    expect(h.registry.claimedPids()).toEqual([17_628]);

    await expect(h.registry.cleanUp()).resolves.toBeUndefined();
    expect(h.checked).toEqual([17_628]);
    expect(h.killed).toEqual([17_628]);
  });
});

describe('teardown attempts every artefact', () => {
  // Test A
  it('runs the rest of cleanup after an invalid decimal PID file', async () => {
    const h = harness({
      pidFiles: { 'C:\\a\\pid.txt': '17628.5', 'C:\\b\\pid.txt': '4242' },
    });
    h.registry.registerPidFile('C:\\a\\pid.txt');
    h.registry.registerPidFile('C:\\b\\pid.txt');
    h.registry.registerTempDir('C:\\a');
    h.registry.registerTempDir('C:\\b');

    await expect(h.registry.cleanUp()).resolves.toBeUndefined();

    // 17628 is never claimed; only the genuinely valid PID is.
    expect(h.killed).toEqual([4242]);
    expect(h.removed).toEqual(['C:\\a', 'C:\\b']);
    expect(h.registry.claimedPids()).toEqual([]);
  });

  // Test B
  it('removes the second directory after the first removal throws', async () => {
    const h = harness({ removeFails: { 'C:\\first': new Error('EBUSY-ish') } });
    h.registry.registerTempDir('C:\\first');
    h.registry.registerTempDir('C:\\second');

    const error = await h.registry.cleanUp().then(
      () => null,
      (caught: unknown) => caught,
    );

    // Both attempted, in order, and only then reported.
    expect(h.removed).toEqual(['C:\\first', 'C:\\second']);
    expect(aggregated(error)).toHaveLength(1);
    // The internal list is empty regardless: a second run has nothing left.
    h.removed.length = 0;
    await expect(h.registry.cleanUp()).resolves.toBeUndefined();
    expect(h.removed).toEqual([]);
  });

  // Test C
  it('aggregates independent failures across all three phases', async () => {
    const h = harness({
      pidFiles: {
        'C:\\a\\pid.txt': errnoError('EACCES'), // unexpected read failure
        'C:\\b\\pid.txt': '111',
        'C:\\c\\pid.txt': '222',
      },
      killFails: { 111: errnoError('EPERM') },
      removeFails: { 'C:\\b': new Error('remove failed') },
    });
    for (const name of ['a', 'b', 'c']) h.registry.registerPidFile(`C:\\${name}\\pid.txt`);
    for (const name of ['a', 'b', 'c']) h.registry.registerTempDir(`C:\\${name}`);

    const error = await h.registry.cleanUp().then(
      () => null,
      (caught: unknown) => caught,
    );

    // No early exit anywhere: every file read, every PID killed, every dir tried.
    expect(h.read).toEqual(['C:\\a\\pid.txt', 'C:\\b\\pid.txt', 'C:\\c\\pid.txt']);
    expect(h.killed).toEqual([111, 222]);
    expect(h.removed).toEqual(['C:\\a', 'C:\\b', 'C:\\c']);
    expect(h.settled).toEqual([0]);

    const errors = aggregated(error);
    expect(errors).toHaveLength(3);
    expect(errors.map((e) => (e as NodeJS.ErrnoException).code)).toContain('EACCES');
    expect(errors.map((e) => (e as NodeJS.ErrnoException).code)).toContain('EPERM');
  });

  // Test D
  it('treats an already-exited process as a clean outcome', async () => {
    const h = harness({
      pidFiles: { 'C:\\a\\pid.txt': '111', 'C:\\b\\pid.txt': '222' },
      dead: [111],
    });
    h.registry.registerPidFile('C:\\a\\pid.txt');
    h.registry.registerPidFile('C:\\b\\pid.txt');
    h.registry.registerTempDir('C:\\a');

    await expect(h.registry.cleanUp()).resolves.toBeUndefined();

    expect(h.killed).toEqual([222]); // 111 was gone; not signalled, not an error
    expect(h.removed).toEqual(['C:\\a']);
  });

  it('does not report a process that exits between the liveness check and the kill', async () => {
    const h = harness({
      pidFiles: { 'C:\\a\\pid.txt': '111' },
      killFails: { 111: errnoError('ESRCH') },
    });
    h.registry.registerPidFile('C:\\a\\pid.txt');

    await expect(h.registry.cleanUp()).resolves.toBeUndefined();
    expect(h.killed).toEqual([111]);
  });

  // Test E
  it('kills a PID once even when claimed directly and found in a file', async () => {
    const h = harness({ pidFiles: { 'C:\\a\\pid.txt': '17628' } });
    expect(h.registry.claimPid('C:\\a\\pid.txt')).toBe(17_628);
    h.registry.registerPidFile('C:\\a\\pid.txt'); // teardown re-reads the same file

    await expect(h.registry.cleanUp()).resolves.toBeUndefined();

    expect(h.killed).toEqual([17_628]);
  });

  it('treats a missing PID file as normal, not as a cleanup failure', async () => {
    const h = harness({ pidFiles: { 'C:\\b\\pid.txt': '333' } });
    h.registry.registerPidFile('C:\\a\\pid.txt'); // never written
    h.registry.registerPidFile('C:\\b\\pid.txt');
    h.registry.registerTempDir('C:\\b');

    await expect(h.registry.cleanUp()).resolves.toBeUndefined();
    expect(h.killed).toEqual([333]);
    expect(h.removed).toEqual(['C:\\b']);
  });

  it('still removes the directories when the settle wait itself fails', async () => {
    const removed: string[] = [];
    const registry = new ExecArtifactRegistry({
      settle: (): Promise<void> => Promise.reject(new Error('timer failed')),
      removeDir: (dir: string): void => {
        removed.push(dir);
      },
    });
    registry.registerTempDir('C:\\a');
    registry.registerTempDir('C:\\b');

    const error = await registry.cleanUp().then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(removed).toEqual(['C:\\a', 'C:\\b']);
    expect(aggregated(error)).toHaveLength(1);
  });

  it('empties every collection even when each phase fails', async () => {
    const h = harness({
      pidFiles: { 'C:\\a\\pid.txt': errnoError('EIO') },
      killFails: { 999: errnoError('EPERM') },
      removeFails: { 'C:\\a': new Error('remove failed') },
    });
    h.registry.registerPidFile('C:\\a\\pid.txt');
    h.registry.registerPid(999);
    h.registry.registerTempDir('C:\\a');

    await expect(h.registry.cleanUp()).rejects.toThrow(AggregateError);

    // Nothing is left registered, so the next teardown has no work at all.
    expect(h.registry.claimedPids()).toEqual([]);
    h.read.length = 0;
    h.killed.length = 0;
    h.removed.length = 0;
    await expect(h.registry.cleanUp()).resolves.toBeUndefined();
    expect([h.read, h.killed, h.removed]).toEqual([[], [], []]);
  });
});
