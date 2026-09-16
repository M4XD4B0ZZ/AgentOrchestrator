import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { beforeAll, describe, expect, it } from 'vitest';

import { READING_NOTE_CODES } from '../src/dashboard/read-model.js';

/**
 * The ten names `app.js` promises on `globalThis.AO`.
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
  const full = {
    observedAt: '2026-09-16T10:08:00.000Z',
    revision: 'r',
    registry: { reading: 'REGISTERED' },
    needsOperator: [],
    notes: [
      { code: 'TASK_STATE_UNREADABLE', repositoryKey: 'k1', taskId: 'T-1', detail: 'EACCES' },
      { code: 'REGISTRY_UNUSABLE', repositoryKey: null, taskId: null, detail: null },
    ],
    repositories: [
      {
        repositoryKey: 'k1',
        profile: { reading: 'DECLARED', repositoryId: 'ZERA', defaultBranch: 'main', maxReviewRounds: 2 },
        declaredTasks: { reading: 'DISCOVERED', count: 2 },
        runtimeScan: { reading: 'SCANNED' },
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
      },
    ],
  };

  it('renders the readings the landing screen deliberately omits', () => {
    const html = AO['renderDetail'](full as never, 'k1') as string;
    expect(html).toContain('ZERA');
    // The stale-lease wording must survive into the detail view unchanged.
    expect(html).toContain('Lease held · recorded owner is gone');
    expect(html).toContain('REVIEWING');
    expect(html).toContain('recorded 8 min ago');
    expect(html).toContain('FAIL');
    expect(html).toContain('ao/task/T-1');
  });

  it('shows only that repository’s notes, never the snapshot-level one', () => {
    const html = AO['renderDetail'](full as never, 'k1') as string;
    expect(html).toContain('TASK_STATE_UNREADABLE');
    expect(html).not.toContain('REGISTRY_UNUSABLE');
  });

  it('carries its own back control, because a standalone install has none', () => {
    // An installed PWA runs in `display: standalone` and has no browser Back
    // button. A drill-down with no way out is a dead end on the device this
    // slice exists for.
    expect(AO['renderDetail'](full as never, 'k1') as string).toContain('data-back');
  });

  it('says so rather than blanking when the key names no repository', () => {
    const html = AO['renderDetail'](full as never, 'nosuchkey') as string;
    expect(html).toContain('not in this snapshot');
  });

  it('routes on the hash, and falls back to the landing screen', () => {
    expect(AO['renderRoute']('#/repo/k1', full as never, 'LIVE') as string).toContain('ao/task/T-1');
    expect(AO['renderRoute']('', full as never, 'LIVE') as string).toContain('PROJECTS');
    expect(AO['renderRoute']('#/nonsense', full as never, 'LIVE') as string).toContain('PROJECTS');
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
