import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { beforeAll, describe, expect, it } from 'vitest';

import { READING_NOTE_CODES } from '../src/dashboard/read-model.js';
import type {
  PublicRepository,
  PublicRuntimeScanReading,
  PublicSnapshot,
} from '../src/dashboard/public-view.js';

/**
 * The eleven names `app.js` promises on `globalThis.AO`.
 *
 * Spelled as a literal union rather than `Record<string, …>` for two reasons,
 * both of which this repository's compiler settings force. `Record<string, …>`
 * is an index signature, so under `noUncheckedIndexedAccess` every lookup is
 * `… | undefined` and every call below is a type error; and a rest parameter
 * typed `never[]` accepts no argument at all, so every call below is a second
 * type error. Naming the keys fixes both, and buys something real on top: a
 * misspelled name here is a compile error rather than a runtime
 * `undefined is not a function` inside one `it`.
 *
 * It asserts nothing about the file — `AO` is read out of the sandbox at run
 * time, so a name this type promises and `app.js` does not define still fails,
 * loudly, in whichever case calls it.
 */
type AoExport =
  | 'classifyFreshness'
  | 'completionLine'
  | 'createPoller'
  | 'escapeHtml'
  | 'leaseWording'
  | 'likelyActiveTasks'
  | 'recordedAge'
  | 'renderDetail'
  | 'renderLanding'
  | 'renderRoute'
  | 'repositoryName';

let AO: Record<AoExport, (...args: unknown[]) => unknown>;

/**
 * `app.js` is evaluated as TEXT in a sandbox, against hand-written fakes.
 *
 * There is no DOM in this repository and no dependency is added for one. The
 * sandbox supplies exactly what the pure half touches — nothing — plus the
 * globals the glue half registers against, so loading the file has no effect
 * beyond defining `AO`. This measures the SHIPPED bytes, which is the same
 * instinct as the dist-artefact gates.
 */
beforeAll(() => {
  const source = readFileSync(join(process.cwd(), 'src', 'dashboard', 'ui', 'app.js'), 'utf8');
  const listeners: Record<string, unknown[]> = {};
  const sandbox = {
    window: { addEventListener: (n: string, f: unknown) => (listeners[n] ??= []).push(f) },
    document: {
      addEventListener: (n: string, f: unknown) => (listeners[n] ??= []).push(f),
      getElementById: () => null,
      visibilityState: 'visible',
    },
    navigator: {},
    location: { hash: '' },
    fetch: () => Promise.reject(new Error('not used by the pure half')),
    setInterval: () => 0,
    setTimeout: () => 0,
    clearInterval: () => undefined,
    console,
  };
  (sandbox as { globalThis?: unknown }).globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(source, context, { filename: 'app.js' });
  AO = (sandbox as unknown as { AO: typeof AO }).AO;
  expect(AO, 'app.js did not define the AO namespace').toBeDefined();
});

describe('freshness is the client’s own clock', () => {
  it('is LIVE under 20s, STALE to 60s, OFFLINE beyond', () => {
    expect(AO['classifyFreshness'](0, 0)).toBe('LIVE');
    expect(AO['classifyFreshness'](0, 19_999)).toBe('LIVE');
    expect(AO['classifyFreshness'](0, 20_000)).toBe('STALE');
    expect(AO['classifyFreshness'](0, 60_000)).toBe('STALE');
    expect(AO['classifyFreshness'](0, 60_001)).toBe('OFFLINE');
  });

  it('is OFFLINE before any successful fetch, never LIVE', () => {
    // A page that has never reached the Manager must not open claiming to be
    // live. `null` is "no contact yet", which is the cold-launch case.
    expect(AO['classifyFreshness'](null, 1_000)).toBe('OFFLINE');
  });
});

describe('the lease wording is total, and never overstates', () => {
  const say = (lease: unknown) => AO['leaseWording'](lease as never);

  it('distinguishes a live owner from a dead one from an unprobed one', () => {
    expect(say({ reading: 'HELD', acquiredAt: null, ownerLiveness: 'ALIVE' })).toBe(
      'Repository activity: confirmed',
    );
    // The row that matters: a lease whose owner is GONE is a STALE lease, and
    // an operator acts on it. Folding it into "unknown" hides that.
    expect(say({ reading: 'HELD', acquiredAt: null, ownerLiveness: 'NOT_FOUND' })).toBe(
      'Lease held · recorded owner is gone',
    );
    expect(say({ reading: 'HELD', acquiredAt: null, ownerLiveness: 'UNDETERMINED' })).toBe(
      'Lease held · owner liveness could not be determined',
    );
    expect(say({ reading: 'HELD', acquiredAt: null, ownerLiveness: 'UNKNOWABLE' })).toBe(
      'Lease held · no owner recorded',
    );
  });

  it('never calls a free lease idle, and never interprets OTHER', () => {
    // "idle" would claim AO is up and doing nothing. This build cannot know
    // that: it writes no pidfile and no heartbeat.
    expect(say({ reading: 'FREE' })).toBe('No lease held');
    expect(say({ reading: 'OTHER', state: 'LOCATION_UNSUITABLE' })).toBe(
      'Lease state: LOCATION_UNSUITABLE',
    );
    expect(say({ reading: 'NOT_OBSERVED', why: 'DIRECTORY_ABSENT' })).toContain('DIRECTORY_ABSENT');
  });
});

describe('completion counts one partition, and refuses to fake a denominator', () => {
  const repo = (tasks: string[], declared: unknown) => ({
    declaredTasks: declared,
    tasks: tasks.map((d, i) => ({ taskId: `T-${i}`, declaration: d })),
  });

  it('counts DONE against the DISCOVERED count', () => {
    expect(
      AO['completionLine'](repo(['DONE', 'DONE', 'OPEN'], { reading: 'DISCOVERED', count: 11 }) as never),
    ).toBe('2 / 11 declared tasks done');
  });

  it('names unreadable declarations instead of folding them into the remainder', () => {
    expect(
      AO['completionLine'](
        repo(['DONE', 'OPEN', 'UNDETERMINED'], { reading: 'DISCOVERED', count: 3 }) as never,
      ),
    ).toBe('1 done · 1 open · 1 unreadable');
  });

  it('prints no fraction at all when the plan could not be read', () => {
    const refused = AO['completionLine'](
      repo(['UNDETERMINED'], { reading: 'REFUSED', code: 'TASK_DISCOVERY_REFUSED', taskId: null }) as never,
    ) as string;
    expect(refused).toContain('Declared plan could not be read');
    expect(refused).toContain('TASK_DISCOVERY_REFUSED');
    expect(refused).not.toMatch(/\d+\s*\/\s*\d+/);
  });
});

describe('the active task stays a candidate', () => {
  const task = (id: string, kind: string | null) => ({
    taskId: id,
    runtime: kind === null ? { reading: 'NONE' } : { reading: 'LOADED', state: 'X', stateKind: kind },
  });

  it('selects only REGULAR states, never a BLOCKING one', () => {
    // A BLOCKING task is by definition one AO is NOT working on. Listing it as
    // "likely active" beside the same task under NEEDS YOU would page the
    // operator twice with contradictory framings.
    const picked = AO['likelyActiveTasks']({
      tasks: [task('A', 'REGULAR'), task('B', 'BLOCKING'), task('C', 'TERMINAL'), task('D', null)],
    } as never) as { taskId: string }[];
    expect(picked.map((t) => t.taskId)).toEqual(['A']);
  });

  it('lists every qualifying task rather than choosing one', () => {
    const picked = AO['likelyActiveTasks']({
      tasks: [task('A', 'REGULAR'), task('B', 'REGULAR')],
    } as never) as { taskId: string }[];
    expect(picked.map((t) => t.taskId)).toEqual(['A', 'B']);
  });
});

describe('ages come from the snapshot’s clock, and are labelled as records', () => {
  it('measures against observedAt, not the local clock', () => {
    // A phone with a skewed clock would otherwise print a negative age.
    expect(
      AO['recordedAge']('2026-09-16T10:00:00.000Z', '2026-09-16T10:08:00.000Z'),
    ).toBe('recorded 8 min ago');
  });

  it('says so when the record is ahead of the observation', () => {
    expect(AO['recordedAge']('2026-09-16T10:08:00.000Z', '2026-09-16T10:00:00.000Z')).toBe(
      'recorded just now',
    );
  });
});

describe('a failed reading never renders as calm', () => {
  const snapshot = (over: Record<string, unknown>) => ({
    observedAt: '2026-09-16T10:00:00.000Z',
    revision: 'r',
    registry: { reading: 'UNUSABLE', code: 'REGISTRY_UNUSABLE' },
    repositories: [],
    needsOperator: [],
    notes: [],
    ...over,
  });

  it('an unreadable registry does not read as "no projects"', () => {
    const html = AO['renderLanding'](
      snapshot({ notes: [{ code: 'REGISTRY_UNUSABLE', repositoryKey: null, taskId: null, detail: null }] }) as never,
      'LIVE',
    ) as string;
    expect(html).toContain('Repository registry could not be read');
    expect(html).not.toContain('No projects');
  });

  it('an unreadable attention store does not read as "nothing needs you"', () => {
    const html = AO['renderLanding'](
      snapshot({ notes: [{ code: 'TASK_STATE_UNREADABLE', repositoryKey: null, taskId: null, detail: 'EACCES' }] }) as never,
      'LIVE',
    ) as string;
    expect(html).toContain('could not be read');
  });

  it('shows no NEEDS YOU region at all when the list is genuinely empty', () => {
    const html = AO['renderLanding'](snapshot({}) as never, 'LIVE') as string;
    expect(html).not.toContain('NEEDS YOU');
  });
});

describe('the detail view shows what the landing screen leaves out', () => {
  // Typed as the real contract, and deliberately not cast. The brief's draft of
  // this fixture carried `runtimeScan: { reading: 'SCANNED' }`, which is not a
  // member of `PublicRuntimeScanReading` — an `as never` at every call site was
  // what let a shape nothing emits sit here describing the production value.
  // The annotation is the pin: this fixture now cannot drift from the contract
  // without failing `npm run typecheck`. (It also surfaced a second gap the cast
  // was hiding — the registry reading was missing both of its required counts.)
  const k1: PublicRepository = {
    repositoryKey: 'k1',
    profile: { reading: 'DECLARED', repositoryId: 'ZERA', defaultBranch: 'main', maxReviewRounds: 2 },
    declaredTasks: { reading: 'DISCOVERED', count: 2 },
    runtimeScan: { reading: 'READ', stateFileCount: 2, truncated: true },
    lease: { reading: 'HELD', acquiredAt: '2026-09-16T09:00:00.000Z', ownerLiveness: 'NOT_FOUND' },
    tasks: [
      {
        taskId: 'T-1',
        declaration: 'OPEN',
        runtime: { reading: 'LOADED', state: 'REVIEWING', stateKind: 'REGULAR', stateEnteredAt: '2026-09-16T10:00:00.000Z', reviewRound: 2, reviewBudget: 3, blockedAgent: null, reportedResetAt: null, workBranch: 'ao/task/T-1', recordedCurrentCommit: null, recordedPhaseAgent: null },
        operational: 'ACTIONABLE',
        action: null,
        verification: { reading: 'RECORDED', lastAttempt: { verdict: 'FAIL', attemptedAt: '2026-09-16T09:50:00.000Z', forCommit: 'abc', stoppedAtPhase: 'VERIFY', exitCode: 1 }, passRecordedForCommit: null, passMeasuredAt: null },
        delivery: { reading: 'NONE' },
      },
    ],
  };

  const full: PublicSnapshot = {
    observedAt: '2026-09-16T10:08:00.000Z',
    revision: 'r',
    registry: { reading: 'REGISTERED', entryCount: 1, maxConcurrentRepositories: 3 },
    needsOperator: [],
    notes: [
      { code: 'TASK_STATE_UNREADABLE', repositoryKey: 'k1', taskId: 'T-1', detail: 'EACCES' },
      { code: 'REGISTRY_UNUSABLE', repositoryKey: null, taskId: null, detail: null },
    ],
    repositories: [k1],
  };

  const withScan = (runtimeScan: PublicRuntimeScanReading): PublicSnapshot => ({
    ...full,
    repositories: [{ ...k1, runtimeScan }],
  });

  it('renders the readings the landing screen deliberately omits', () => {
    const html = AO['renderDetail'](full, 'k1') as string;
    expect(html).toContain('ZERA');
    // The stale-lease wording must survive into the detail view unchanged.
    expect(html).toContain('Lease held · recorded owner is gone');
    expect(html).toContain('REVIEWING');
    expect(html).toContain('recorded 8 min ago');
    expect(html).toContain('FAIL');
    expect(html).toContain('ao/task/T-1');
    // The READ branch is the only one that interpolates its two fields, and
    // both of them reach the operator.
    expect(html).toContain('Runtime records read: 2 · list truncated');
  });

  it('renders each runtime-scan reading the contract can actually carry', () => {
    // All three real members. `withScan` takes a `PublicRuntimeScanReading`, so
    // a member that stops existing fails to compile rather than falling through
    // to the wording fallback unnoticed.
    expect(AO['renderDetail'](withScan({ reading: 'READ', stateFileCount: 7, truncated: false }), 'k1')).toContain(
      'Runtime records read: 7',
    );
    expect(AO['renderDetail'](withScan({ reading: 'READ', stateFileCount: 7, truncated: false }), 'k1')).not.toContain(
      'list truncated',
    );
    expect(AO['renderDetail'](withScan({ reading: 'DIRECTORY_ABSENT' }), 'k1')).toContain(
      'No runtime directory',
    );
    expect(AO['renderDetail'](withScan({ reading: 'DIRECTORY_UNREADABLE' }), 'k1')).toContain(
      'Runtime directory could not be listed',
    );
  });

  it('names a runtime-scan reading it does not recognise, rather than rendering nothing', () => {
    // Built WITHOUT claiming to be a `PublicRuntimeScanReading`, because the
    // whole point of the branch is a value that union does not contain — which
    // is what a newer writer widening the contract looks like from here. A cast
    // on a fixture that claims the contract would assert the opposite.
    const widened = { ...full, repositories: [{ ...k1, runtimeScan: { reading: 'SCANNED' } }] };
    expect(AO['renderDetail'](widened, 'k1')).toContain('Runtime scan reading: SCANNED');
  });

  it('shows only that repository’s notes, never the snapshot-level one', () => {
    const html = AO['renderDetail'](full, 'k1') as string;
    expect(html).toContain('TASK_STATE_UNREADABLE');
    expect(html).not.toContain('REGISTRY_UNUSABLE');
  });

  it('carries its own back control, because a standalone install has none', () => {
    // An installed PWA runs in `display: standalone` and has no browser Back
    // button. A drill-down with no way out is a dead end on the device this
    // slice exists for.
    expect(AO['renderDetail'](full, 'k1') as string).toContain('data-back');
  });

  it('says so rather than blanking when the key names no repository', () => {
    const html = AO['renderDetail'](full, 'nosuchkey') as string;
    expect(html).toContain('not in this snapshot');
  });

  it('routes on the hash, and falls back to the landing screen', () => {
    expect(AO['renderRoute']('#/repo/k1', full, 'LIVE') as string).toContain('ao/task/T-1');
    expect(AO['renderRoute']('', full, 'LIVE') as string).toContain('PROJECTS');
    expect(AO['renderRoute']('#/nonsense', full, 'LIVE') as string).toContain('PROJECTS');
  });
});

describe('text from the snapshot is escaped before it reaches innerHTML', () => {
  it('escapes the five characters that matter', () => {
    expect(AO['escapeHtml']('<img src=x onerror="y">&’')).toBe(
      '&lt;img src=x onerror=&quot;y&quot;&gt;&amp;’',
    );
  });

  it('escapes operator text rendered into the attention card', () => {
    const html = AO['renderLanding'](
      {
        observedAt: '2026-09-16T10:00:00.000Z',
        revision: 'r',
        registry: { reading: 'REGISTERED' },
        repositories: [],
        needsOperator: [
          { repositoryKey: 'k', taskId: '<script>bad</script>', reason: 'ESCALATED_DECISION_REQUIRED', text: 'a & b' },
        ],
        notes: [],
      } as never,
      'LIVE',
    ) as string;
    expect(html).not.toContain('<script>bad</script>');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).toContain('a &amp; b');
  });
});

/* ── beyond the brief ───────────────────────────────────────────────────────
 *
 * Three additions, each closing a hole the cases above leave open. They are
 * marked as additions rather than folded in silently, because the brief said
 * what to write and a reviewer is owed the difference.
 */

describe('a repository that cannot name itself is still named honestly', () => {
  // `repositoryName` is one of the ten exports the brief names, and the only
  // one no case above calls. Its DECLARED branch survives indirectly through
  // the detail view's 'ZERA'; its UNUSABLE branch had no pin at all, which is
  // how a `repositoryKey` digest ends up silently substituted for a name.
  it('uses the declared id, and never the key digest', () => {
    expect(
      AO['repositoryName']({
        repositoryKey: 'deadbeef',
        profile: { reading: 'DECLARED', repositoryId: 'ZERA' },
      }),
    ).toBe('ZERA');
  });

  it('names the profile failure instead of falling back to the key', () => {
    const named = AO['repositoryName']({
      repositoryKey: 'deadbeef',
      profile: { reading: 'UNUSABLE', code: 'PROFILE_UNUSABLE' },
    }) as string;
    expect(named).toContain('profile unusable');
    expect(named).toContain('PROFILE_UNUSABLE');
    expect(named).not.toContain('deadbeef');
  });

  /*
   * A missing profile and a profile whose reading this build does not
   * understand are structurally different, and an operator acts on them
   * differently: the second one is ON DISK, so calling it absent sends them
   * looking for a file that is already there. `leaseWording` and
   * `completionLine` both already split these two cases; this is the same
   * distinction, and the three cases below are its three lines.
   */
  const ABSENT = 'Unnamed repository · profile reading absent';

  it('says the reading is ABSENT only when there is no reading to name', () => {
    expect(AO['repositoryName']({ repositoryKey: 'deadbeef' })).toBe(ABSENT);
    expect(AO['repositoryName']({ repositoryKey: 'deadbeef', profile: null })).toBe(ABSENT);
    expect(AO['repositoryName']({ repositoryKey: 'deadbeef', profile: {} })).toBe(ABSENT);
  });

  it('names a profile reading it does not recognise, as unrecognised', () => {
    const named = AO['repositoryName']({
      repositoryKey: 'deadbeef',
      profile: { reading: 'SOMETHING_NEWER' },
    }) as string;
    expect(named).toContain('unrecognised');
    expect(named).toContain('SOMETHING_NEWER');
    expect(named).not.toContain('absent');
    expect(named).not.toContain('deadbeef');
  });

  it('never answers ABSENT for a profile that carries a reading', () => {
    // The property, not a nicety. A single return covering both cases satisfies
    // either of the two cases above on its own; only this one makes the
    // collapse impossible to land silently, for every shape of unrecognised
    // value rather than the one a case happened to pick.
    for (const reading of ['SOMETHING_NEWER', 'DECLARED_V2', 'declared', '', 0, 42, false]) {
      const named = AO['repositoryName']({
        repositoryKey: 'deadbeef',
        profile: { reading },
      }) as string;
      expect(named, `reading ${JSON.stringify(reading)}`).not.toBe(ABSENT);
      expect(named, `reading ${JSON.stringify(reading)}`).not.toContain('absent');
    }
  });
});

describe('an age that cannot be computed says so', () => {
  it('never prints NaN at an operator', () => {
    // `recordedAge` subtracts two parsed instants. Without a guard an
    // unparseable one reads `recorded NaN min ago`, which is the shape of a
    // defect dressed as a measurement.
    expect(AO['recordedAge']('not-an-instant', '2026-09-16T10:00:00.000Z')).not.toContain('NaN');
    expect(AO['recordedAge']('2026-09-16T10:00:00.000Z', 'not-an-instant')).not.toContain('NaN');
  });
});

describe('every reading-note code has a written sentence', () => {
  it('renders no fallback wording for any code the read model can emit', () => {
    // The codes are a closed set in `read-model.ts`; `app.js` mirrors them in a
    // plain-JavaScript table that no compiler checks against that set. This is
    // the check: a code added there and not here renders the fallback, and this
    // case is what says so.
    for (const code of READING_NOTE_CODES) {
      const html = AO['renderLanding'](
        {
          observedAt: '2026-09-16T10:00:00.000Z',
          revision: 'r',
          registry: { reading: 'REGISTERED' },
          repositories: [],
          needsOperator: [],
          notes: [{ code, repositoryKey: null, taskId: null, detail: null }],
        },
        'LIVE',
      ) as string;
      expect(html, `${code} has no sentence in app.js`).not.toContain(
        'A reading could not be completed',
      );
      expect(html, `${code} is not rendered at all`).toContain(code);
    }
  });
});

/* ── the glue: the network half, the clock, and the DOM ─────────────────────
 *
 * Everything below drives the SHIPPED bytes of `app.js` — the same file the
 * asset manifest serves — either through `createPoller`, whose transport and
 * clock are constructor arguments, or through the whole page mounted against a
 * hand-written document. Neither is a seam past the wiring: `install()` is the
 * production entry point and it is what runs here, and the arguments
 * `createPoller` takes are the shape production passes it.
 */

describe('the poller treats a 304 as a successful refresh', () => {
  function pollerWith(responses: { status: number; etag?: string; body?: unknown }[]) {
    let call = 0;
    let clock = 1_000_000;
    const seen: string[] = [];
    const sentHeaders: (string | undefined)[] = [];
    const poller = AO['createPoller']({
      fetch: (_url: string, init: { headers?: Record<string, string> }) => {
        sentHeaders.push(init?.headers?.['If-None-Match']);
        const r = responses[Math.min(call++, responses.length - 1)]!;
        return Promise.resolve({
          status: r.status,
          ok: r.status >= 200 && r.status < 300,
          headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? (r.etag ?? null) : null) },
          json: () => Promise.resolve(r.body ?? {}),
        });
      },
      now: () => clock,
      onState: (s: { freshness: string }) => seen.push(s.freshness),
    } as never) as { tick: () => Promise<void> };
    return { poller, seen, sentHeaders, advance: (ms: number) => (clock += ms) };
  }

  it('resets the clock on a 304, so an idle machine never drifts offline', () => {
    // The defect this catches: counting only 200 as success makes a perfectly
    // healthy, unchanging machine march LIVE -> STALE -> OFFLINE while the
    // Manager answers every single request.
    const h = pollerWith([
      { status: 200, etag: 'W/"r1"', body: { revision: 'r1', observedAt: '2026-09-16T10:00:00.000Z', registry: { reading: 'REGISTERED' }, repositories: [], needsOperator: [], notes: [] } },
      { status: 304, etag: 'W/"r1"' },
    ]);
    return h.poller.tick().then(() => {
      h.advance(30_000);
      return h.poller.tick().then(() => {
        expect(h.seen[h.seen.length - 1]).toBe('LIVE');
      });
    });
  });

  it('echoes the ETag header verbatim, never the bare revision', () => {
    // The contract compares opaque tag strings INCLUDING their quotes. A client
    // sending `r1` is answered 200 forever and the whole 304 path is dead code.
    const h = pollerWith([
      { status: 200, etag: 'W/"r1"', body: { revision: 'r1', observedAt: '2026-09-16T10:00:00.000Z', registry: { reading: 'REGISTERED' }, repositories: [], needsOperator: [], notes: [] } },
      { status: 304, etag: 'W/"r1"' },
    ]);
    return h.poller.tick().then(() =>
      h.poller.tick().then(() => {
        expect(h.sentHeaders[0]).toBeUndefined();
        expect(h.sentHeaders[1]).toBe('W/"r1"');
      }),
    );
  });

  it('reports a refusal as a refusal, not as staleness', () => {
    const h = pollerWith([{ status: 421 }]);
    return h.poller.tick().then(() => {
      expect(h.seen[h.seen.length - 1]).toBe('REFUSED');
    });
  });

  it('keeps the last good snapshot on screen when the network fails', () => {
    const good = { revision: 'r1', observedAt: '2026-09-16T10:00:00.000Z', registry: { reading: 'REGISTERED' }, repositories: [], needsOperator: [], notes: [] };
    let call = 0;
    let clock = 0;
    let lastRendered: unknown = null;
    const poller = AO['createPoller']({
      fetch: () => (call++ === 0
        ? Promise.resolve({ status: 200, ok: true, headers: { get: () => 'W/"r1"' }, json: () => Promise.resolve(good) })
        : Promise.reject(new Error('offline'))),
      now: () => clock,
      onState: (s: { snapshot: unknown }) => (lastRendered = s.snapshot),
    } as never) as { tick: () => Promise<void> };
    return poller.tick().then(() => {
      clock += 120_000;
      return poller.tick().then(() => {
        // Kept, not cleared — and Task 6's renderer is what marks it stale.
        expect(lastRendered).toEqual(good);
      });
    });
  });
});

describe('the page survives having no service worker', () => {
  it('registers nothing and still works when navigator.serviceWorker is absent', () => {
    // On an insecure origin `navigator.serviceWorker` is simply absent, and an
    // unguarded register() throws and takes the whole UI down — turning a
    // missing offline feature into a blank screen.
    const source = readFileSync(join(process.cwd(), 'src', 'dashboard', 'ui', 'app.js'), 'utf8');
    expect(source).toContain("'serviceWorker' in navigator");
    const guardIndex = source.indexOf("'serviceWorker' in navigator");
    const registerIndex = source.indexOf('serviceWorker.register');
    expect(registerIndex).toBeGreaterThan(guardIndex);
  });
});

/* ── the whole page, mounted ─────────────────────────────────────────────────
 *
 * `install()` is not called from here: the file installs itself on load, which
 * is what the browser does, so the mount below exercises the production entry
 * point rather than a test-only door into it. The document is hand-written
 * because this repository has no DOM and adds no dependency for one; it
 * supplies exactly the members `install()` touches and nothing else.
 */

interface Answer {
  readonly status: number;
  readonly etag?: string;
  readonly body?: unknown;
  /** `json()` rejects — a truncated body, or one that is not JSON at all. */
  readonly unparseable?: true;
  /** the request never settles, as on a connection that hangs open */
  readonly hangs?: true;
  /** the request rejects, as it does with no network at all */
  readonly fails?: true;
  /** `fetch` throws synchronously instead of returning a rejected promise */
  readonly throws?: true;
}

interface FakeElement {
  innerHTML: string;
  textContent: string;
  readonly attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

function element(): FakeElement {
  const attributes: Record<string, string> = {};
  return {
    innerHTML: '',
    textContent: '',
    attributes,
    setAttribute: (name: string, value: string) => {
      attributes[name] = value;
    },
  };
}

/** Let every pending microtask run. Timers run after them, so one is enough. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function mountPage(
  answers: readonly Answer[],
  options: { serviceWorker?: boolean; hash?: string } = {},
) {
  const source = readFileSync(join(process.cwd(), 'src', 'dashboard', 'ui', 'app.js'), 'utf8');
  const content = element();
  const word = element();
  const age = element();
  const elements: Record<string, FakeElement> = {
    content,
    'status-word': word,
    'status-age': age,
  };
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const sent: (string | undefined)[] = [];
  const cacheModes: (string | undefined)[] = [];
  const registered: string[] = [];
  let clock = 1_700_000_000_000;
  let call = 0;
  let ticker: (() => void) | null = null;
  let tickerMs: number | null = null;

  const sandbox = {
    window: {
      addEventListener: (n: string, f: (...a: unknown[]) => void) => {
        (listeners[n] ??= []).push(f);
      },
    },
    document: {
      addEventListener: (n: string, f: (...a: unknown[]) => void) => {
        (listeners[n] ??= []).push(f);
      },
      getElementById: (id: string) => elements[id] ?? null,
      visibilityState: 'visible',
    },
    navigator:
      options.serviceWorker === true
        ? {
            serviceWorker: {
              register: (url: string) => {
                registered.push(url);
                return Promise.resolve({});
              },
            },
          }
        : {},
    location: { hash: options.hash ?? '' },
    fetch: (_url: string, init: { headers?: Record<string, string>; cache?: string }) => {
      sent.push(init?.headers?.['If-None-Match']);
      cacheModes.push(init?.cache);
      const answer = answers[call++];
      if (answer === undefined) {
        return Promise.reject(new Error('no answer was queued for this request'));
      }
      if (answer.hangs === true) return new Promise(() => undefined);
      if (answer.fails === true) return Promise.reject(new Error('offline'));
      if (answer.throws === true) throw new TypeError('Failed to construct the request');
      return Promise.resolve({
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        headers: { get: (n: string) => (n.toLowerCase() === 'etag' ? answer.etag ?? null : null) },
        json: () =>
          answer.unparseable === true
            ? Promise.reject(new SyntaxError('Unexpected end of JSON input'))
            : Promise.resolve(answer.body),
      });
    },
    setInterval: (f: () => void, ms: number) => {
      ticker = f;
      tickerMs = ms;
      return 7;
    },
    clearInterval: () => {
      ticker = null;
      tickerMs = null;
    },
    Date: { now: () => clock, parse: Date.parse },
    console,
  };
  (sandbox as { globalThis?: unknown }).globalThis = sandbox;
  runInContext(source, createContext(sandbox), { filename: 'app.js' });

  const fire = (name: string): void => {
    for (const listener of listeners[name] ?? []) listener();
  };

  return {
    content: (): string => content.innerHTML,
    word: (): string => word.textContent,
    stateAttribute: (): string => word.attributes['data-state'] ?? '',
    age: (): string => age.textContent,
    sent,
    cacheModes,
    registered,
    requests: (): number => call,
    pollMs: (): number | null => tickerMs,
    polling: (): boolean => ticker !== null,
    settle: flush,
    advance: (ms: number): void => {
      clock += ms;
    },
    poll: (): Promise<void> => {
      if (ticker === null) throw new Error('the page is not polling, so nothing can be driven');
      ticker();
      return flush();
    },
    navigate: (hash: string): Promise<void> => {
      sandbox.location.hash = hash;
      fire('hashchange');
      return flush();
    },
    hide: (): Promise<void> => {
      sandbox.document.visibilityState = 'hidden';
      fire('visibilitychange');
      return flush();
    },
    show: (): Promise<void> => {
      sandbox.document.visibilityState = 'visible';
      fire('visibilitychange');
      return flush();
    },
  };
}

/** A snapshot typed as the real contract, so this fixture cannot drift from it. */
const LIVE_SNAPSHOT: PublicSnapshot = {
  observedAt: '2026-09-16T10:08:00.000Z',
  revision: 'r1',
  registry: { reading: 'REGISTERED', entryCount: 1, maxConcurrentRepositories: 3 },
  needsOperator: [],
  notes: [],
  repositories: [
    {
      repositoryKey: 'k1',
      profile: { reading: 'DECLARED', repositoryId: 'ZERA', defaultBranch: 'main', maxReviewRounds: 2 },
      declaredTasks: { reading: 'DISCOVERED', count: 2 },
      runtimeScan: { reading: 'READ', stateFileCount: 1, truncated: false },
      lease: { reading: 'FREE' },
      tasks: [
        {
          taskId: 'T-1',
          declaration: 'OPEN',
          runtime: {
            reading: 'LOADED',
            state: 'REVIEWING',
            stateKind: 'REGULAR',
            stateEnteredAt: '2026-09-16T10:00:00.000Z',
            reviewRound: 1,
            reviewBudget: 2,
            blockedAgent: null,
            reportedResetAt: null,
            workBranch: 'ao/task/T-1',
            recordedCurrentCommit: null,
            recordedPhaseAgent: null,
          },
          operational: 'ACTIONABLE',
          action: null,
          verification: { reading: 'NONE' },
          delivery: { reading: 'NONE' },
        },
      ],
    },
  ],
};

/**
 * Two malformed answers, failing in structurally different places.
 *
 * `NOT_SHAPED` is refused before the view model ever sees it. `THROWS_ON_RENDER`
 * passes any shape check worth writing — it is an object carrying all six
 * members and `repositories` really is an array — and detonates inside the
 * renderer on the `null` element. Both must land in the same visible error
 * state, and handling either one alone leaves the other unhandled.
 */
const NOT_SHAPED = { oops: true, repositories: 'not an array' };
const THROWS_ON_RENDER = { ...LIVE_SNAPSHOT, revision: 'r2', repositories: [null] };

describe('a malformed snapshot is an explicit error state, never old data', () => {
  for (const [name, malformed] of [
    ['one the renderer throws on', THROWS_ON_RENDER],
    ['one that is not shaped like a snapshot at all', NOT_SHAPED],
  ] as const) {
    it(`replaces a good render entirely, then gives way to the next good one — ${name}`, async () => {
      const h = mountPage([
        { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
        { status: 200, etag: 'W/"bad"', body: malformed },
        { status: 200, etag: 'W/"r3"', body: LIVE_SNAPSHOT },
      ]);

      // ── valid -> normal render ──────────────────────────────────────────
      await h.settle();
      expect(h.content()).toContain('ZERA');
      expect(h.content()).toContain('PROJECTS');
      expect(h.word()).toBe('LIVE');

      // ── invalid -> explicit error view, with NO old content remaining ───
      await h.poll();
      // These absence assertions are the point of the test, and they name
      // something distinctive from the first render rather than a generic
      // string any page could fail to contain.
      expect(h.content(), 'the repository name survived a malformed snapshot').not.toContain('ZERA');
      expect(h.content(), 'the task id survived a malformed snapshot').not.toContain('T-1');
      expect(h.content(), 'the landing screen survived a malformed snapshot').not.toContain('PROJECTS');
      // Not blank either: a cleared screen is the other failure mode.
      expect(h.content().length).toBeGreaterThan(0);
      expect(h.content()).toContain('AO status unreadable');
      // And not calm: the badge cannot read LIVE over an error card.
      expect(h.word()).toBe('UNREADABLE');
      expect(h.stateAttribute()).toBe('UNREADABLE');
      // Nor is it the cold-launch copy — this page HAS had contact.
      expect(h.content()).not.toContain('No usable data received in this session');

      // ── valid -> normal render restored ─────────────────────────────────
      await h.poll();
      expect(h.content()).toContain('ZERA');
      expect(h.content()).toContain('T-1');
      expect(h.content()).not.toContain('AO status unreadable');
      expect(h.word()).toBe('LIVE');
    });
  }

  it('treats an answer whose body is not JSON as unreadable, not as a dead network', async () => {
    // `response.json()` rejects INSIDE the success handler, so a poller that
    // only passes a rejection handler to the same `.then` never sees it: the
    // page keeps the old render and the rejection goes unhandled.
    const h = mountPage([
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
      { status: 200, etag: 'W/"r2"', unparseable: true },
    ]);
    await h.settle();
    expect(h.content()).toContain('ZERA');
    await h.poll();
    expect(h.content()).not.toContain('ZERA');
    expect(h.content()).toContain('AO status unreadable');
    expect(h.word()).toBe('UNREADABLE');
  });

  it('does not let a held tag put the discarded snapshot back on screen', async () => {
    // The trap: keep the ETag of an answer you refused, and the very next poll
    // is answered 304 — a success, which re-renders the snapshot the page has
    // just declared unreadable.
    const h = mountPage([
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
      { status: 200, etag: 'W/"bad"', body: NOT_SHAPED },
      { status: 304, etag: 'W/"r1"' },
    ]);
    await h.settle();
    await h.poll();
    expect(h.sent[2], 'a refused answer left its tag behind').toBeUndefined();
    await h.poll();
    expect(h.content()).not.toContain('ZERA');
  });
});

describe('the page paints before the first answer, and says what it does not know', () => {
  it('shows the cold-launch copy rather than a blank screen on a hung connection', async () => {
    const h = mountPage([{ status: 200, hangs: true }]);
    await h.settle();
    expect(h.content()).toContain('AO status unavailable');
    expect(h.content()).toContain('No usable data received in this session.');
    // renderRoute is never called with a null snapshot: its landing screen
    // would print the PROJECTS heading, and this page has no projects to
    // report — it has no reading at all.
    expect(h.content()).not.toContain('PROJECTS');
    expect(h.word()).toBe('OFFLINE');
  });

  it('does not claim nothing was received after an answer that could not be read', async () => {
    // Reachable, and this drives the whole way there: an unreadable answer
    // drops the snapshot AND the contact clock, the attempt after it clears
    // the unreadable outcome, and `paint` falls through to the no-data card.
    // At that point an answer HAS arrived in this session — it was garbage —
    // and a card saying none was received sends the reader after a network
    // fault that is not there. The two conditions want different actions.
    const h = mountPage([
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
      { status: 200, etag: 'W/"bad"', body: NOT_SHAPED },
      { status: 200, fails: true },
    ]);
    await h.settle();
    await h.poll();
    expect(h.content()).toContain('AO status unreadable');

    await h.poll();
    expect(h.content()).toContain('AO status unavailable');
    expect(h.content(), 'the card claims nothing was received, and something was').not.toContain(
      'No live data received',
    );
    expect(h.content()).toContain('No usable data received in this session.');
  });

  it('asks for the snapshot without the browser cache in the way', async () => {
    const h = mountPage([{ status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT }]);
    await h.settle();
    // A cached 200 the browser answered on its own would reset the freshness
    // clock without the Manager having said anything at all.
    expect(h.cacheModes[0]).toBe('no-store');
    expect(h.sent[0]).toBeUndefined();
  });
});

describe('what the poller holds, the screen labels', () => {
  it('keeps the last good data through OFFLINE, frozen, and banners it as not current', async () => {
    const h = mountPage([
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
      { status: 200, fails: true },
    ]);
    await h.settle();
    expect(h.content()).toContain('recorded 8 min ago');

    h.advance(120_000);
    await h.poll();
    expect(h.word()).toBe('OFFLINE');
    // Still on screen — and still saying EIGHT minutes. Derived ages are
    // measured against the snapshot's own observation, so they do not keep
    // advancing on data the screen has already declared out of date.
    expect(h.content()).toContain('ZERA');
    expect(h.content()).toContain('recorded 8 min ago');
    expect(h.content()).not.toContain('recorded 10 min ago');
    // The banner is what carries the difference, and it comes from the
    // freshness the glue passes down rather than from a second opinion here.
    expect(h.content()).toContain('OFFLINE · showing data from the last successful fetch');
  });

  it('names the status code of a refusal, and does not dress it as staleness', async () => {
    const h = mountPage([
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
      { status: 421 },
    ]);
    await h.settle();
    await h.poll();
    expect(h.word()).toBe('REFUSED');
    expect(h.stateAttribute()).toBe('REFUSED');
    expect(h.age(), 'a refusal that does not name its code is not actionable').toContain('421');
  });
});

describe('the polling loop follows the page, not the tab it was opened in', () => {
  it('polls every ten seconds while visible', async () => {
    const h = mountPage([{ status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT }]);
    await h.settle();
    expect(h.pollMs()).toBe(10_000);
    expect(h.polling()).toBe(true);
  });

  it('does not stack requests on a Manager that has stopped answering', async () => {
    // The interval does not wait for the previous request. Without a guard, a
    // Manager that takes longer than ten seconds to answer accumulates one
    // request per tick — and when they finally land out of order, the older
    // answer arrives last, moves the freshness clock BACKWARDS and puts an
    // older snapshot on screen than the one already rendered.
    const h = mountPage([
      { status: 200, hangs: true },
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
    ]);
    await h.settle();
    expect(h.requests()).toBe(1);
    await h.poll();
    await h.poll();
    expect(h.requests(), 'a request was started while one was still in flight').toBe(1);
  });

  it('keeps telling the truth while a request hangs, rather than freezing on the last word', async () => {
    // The trap the single-flight guard opened, and the reason it is worth
    // writing down: the stacking version this replaced SELF-HEALED — a later
    // request landed on a fresh socket and published whatever it got. A guard
    // that early-returns without publishing does not. `fetch` has no default
    // timeout and there is no AbortController here, so one socket that never
    // settles leaves every later tick returning immediately, `publish` never
    // running, and the badge reading LIVE over data that is minutes old.
    // Nothing else in the file can move the word: `classifyFreshness` is
    // called at exactly one site, inside `publish`.
    const h = mountPage([
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
      { status: 200, hangs: true },
    ]);
    await h.settle();
    expect(h.word()).toBe('LIVE');

    await h.poll();
    expect(h.requests()).toBe(2);

    h.advance(120_000);
    await h.poll();
    await h.poll();
    expect(h.word(), 'the status word froze while a request hung').toBe('OFFLINE');
    // Still single-flight: the guard is kept, it just stops lying.
    expect(h.requests(), 'the guard was dropped rather than fixed').toBe(2);
    // And the held reading is untouched — labelled stale, not resurrected.
    expect(h.content()).toContain('ZERA');
    expect(h.content()).toContain('OFFLINE · showing data from the last successful fetch');
  });

  it('does not latch shut when the transport throws instead of rejecting', async () => {
    // Production `fetch` against a constant path does not do this, so the
    // guard is defensive — but the failure it prevents is the same permanent
    // wedge through another door: an exception on the way out of `tick` skips
    // the release and shuts the poller for the life of the page.
    const h = mountPage([
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
      { status: 200, throws: true },
      { status: 304, etag: 'W/"r1"' },
    ]);
    await h.settle();
    // In a browser an exception out of a timer callback is reported and the
    // timer keeps running; here it would propagate into the test, so it is
    // contained deliberately. Once the fix is in, nothing is thrown at all.
    try {
      await h.poll();
    } catch {
      /* the transport threw, which is the case under test */
    }
    expect(h.requests()).toBe(2);

    await h.poll();
    expect(h.requests(), 'a transport that threw held the single-flight latch shut').toBe(3);
    expect(h.word()).toBe('LIVE');
  });

  it('stops while hidden and refetches the moment it is shown again', async () => {
    const h = mountPage([
      { status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT },
      { status: 304, etag: 'W/"r1"' },
    ]);
    await h.settle();
    expect(h.requests()).toBe(1);

    await h.hide();
    expect(h.polling(), 'a hidden page kept its timer').toBe(false);
    expect(h.requests()).toBe(1);

    await h.show();
    // Not on the next ten-second boundary: a page that comes back showing
    // half-minute-old state with no way to know it is worse than no page.
    expect(h.requests()).toBe(2);
    expect(h.polling()).toBe(true);
    expect(h.word()).toBe('LIVE');
  });
});

describe('a drill-down is a local move', () => {
  it('renders the detail view from the snapshot already held, with no new request', async () => {
    // The hash route is in-page state. Fetching for it would leave a tap on a
    // project showing the landing screen until the network answered — and on a
    // connection that hangs, forever.
    const h = mountPage([{ status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT }]);
    await h.settle();
    expect(h.requests()).toBe(1);

    await h.navigate('#/repo/k1');
    expect(h.content()).toContain('data-back');
    expect(h.content()).toContain('ao/task/T-1');
    expect(h.requests(), 'a local route change went to the network').toBe(1);
  });

  it('opens straight into the detail view when the page is launched at one', async () => {
    const h = mountPage([{ status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT }], { hash: '#/repo/k1' });
    await h.settle();
    expect(h.content()).toContain('data-back');
    expect(h.content()).toContain('ao/task/T-1');
  });
});

describe('the worker is registered, and its absence is not a failure', () => {
  it('registers the worker where the browser has one', async () => {
    const h = mountPage([{ status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT }], { serviceWorker: true });
    await h.settle();
    expect(h.registered).toEqual(['/sw.js']);
  });

  it('renders normally where the browser has none', async () => {
    const h = mountPage([{ status: 200, etag: 'W/"r1"', body: LIVE_SNAPSHOT }]);
    await h.settle();
    expect(h.registered).toEqual([]);
    expect(h.content()).toContain('ZERA');
  });
});

describe('the last good snapshot lives in page memory and nowhere else', () => {
  it('names no storage API at all', () => {
    // A snapshot written to disk outlives the session that fetched it, and the
    // next launch would render yesterday's AO state as though it were a
    // reading. The page keeps it in a closure variable instead; this is the
    // pin, because an added `localStorage.setItem` is a two-word edit.
    const source = readFileSync(join(process.cwd(), 'src', 'dashboard', 'ui', 'app.js'), 'utf8');
    for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
      expect(source, `app.js names ${api}`).not.toContain(api);
    }
  });
});
