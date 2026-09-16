import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { SHELL_ROUTES } from '../src/dashboard/ui-assets.js';

/**
 * `sw.js` is measured as TEXT, in a sandbox, against hand-written fakes.
 *
 * There is no browser in this repository and no dependency is added for one.
 * The sandbox supplies exactly what a `ServiceWorkerGlobalScope` gives the
 * worker — `self` as the global itself, `caches`, `fetch`, `URL` — and nothing
 * else, so what these cases measure is the SHIPPED bytes rather than a
 * TypeScript translation of them. Same instinct as the dist-artefact gates.
 *
 * The read is at module scope on purpose: delete `sw.js` and this file does not
 * collect at all, so every case in it fails rather than passing on absence.
 */
const SOURCE = readFileSync(join(process.cwd(), 'src', 'dashboard', 'ui', 'sw.js'), 'utf8');

const DIGEST = 'a'.repeat(64);
const CURRENT_CACHE = `ao-shell-${DIGEST}`;
const ORIGIN = 'https://ao.example';

type SwHandler = (event: Record<string, unknown>) => void;

interface Harness {
  readonly handlers: Record<string, SwHandler | undefined>;
  readonly caches: {
    readonly names: readonly string[];
    /** cache name → the routes `addAll` was given for it. */
    readonly added: Record<string, readonly string[]>;
    readonly deleted: string[];
  };
  /** How often the worker searched the cache STORE rather than its own cache. */
  storeMatchCalls: number;
  claimed: boolean;
  skipWaiting: boolean;
}

interface LoadOptions {
  /** Make `cache.addAll` reject, as an offline or 404 install would. */
  readonly addAllFails?: boolean;
  /** What `caches.keys()` reports at activation. */
  readonly existingCaches?: readonly string[];
  /** What the build substituted for the route token. Defaults to the real list. */
  readonly routes?: readonly string[];
  /** Make every cache read miss, as an evicted shell would. */
  readonly cacheMisses?: boolean;
}

/** Loads the worker's REAL bytes against fakes, with the build tokens substituted. */
function load(options: LoadOptions = {}): Harness {
  const source = SOURCE.replace(/__AO_SHELL_DIGEST__/g, DIGEST).replace(
    /'__AO_SHELL_ROUTES__'/g,
    JSON.stringify(options.routes ?? SHELL_ROUTES),
  );

  const h: Harness = {
    handlers: {},
    caches: { names: options.existingCaches ?? [], added: {}, deleted: [] },
    storeMatchCalls: 0,
    claimed: false,
    skipWaiting: false,
  };

  const openCache = (name: string): Record<string, unknown> => ({
    addAll: (routes: readonly string[]): Promise<undefined> => {
      if (options.addAllFails === true) return Promise.reject(new Error('offline'));
      h.caches.added[name] = [...routes];
      return Promise.resolve(undefined);
    },
    match: (request: { readonly url: string }): Promise<unknown> =>
      Promise.resolve(options.cacheMisses === true ? undefined : { from: name, url: request.url }),
  });

  // `self` IS the global in a worker, so the sandbox is modelled that way: one
  // object, reachable both bare and through `self`. A worker that reached for
  // `addEventListener` without the prefix would behave here exactly as it does
  // in the browser.
  const sandbox: Record<string, unknown> = {
    URL,
    fetch: (request: { readonly url: string }): Promise<unknown> =>
      Promise.resolve({ from: 'NETWORK', url: request.url }),
    caches: {
      keys: (): Promise<string[]> => Promise.resolve([...h.caches.names]),
      delete: (name: string): Promise<boolean> => {
        h.caches.deleted.push(name);
        return Promise.resolve(true);
      },
      open: (name: string): Promise<Record<string, unknown>> => Promise.resolve(openCache(name)),
      // The cache STORE at large. Answering from here rather than from the
      // named cache means a leftover shell of another build can reply, so this
      // is counted rather than merely available.
      match: (request: { readonly url: string }): Promise<unknown> => {
        h.storeMatchCalls += 1;
        return Promise.resolve({ from: 'CACHE_STORE_AT_LARGE', url: request.url });
      },
    },
    addEventListener: (name: string, fn: SwHandler): void => {
      h.handlers[name] = fn;
    },
    skipWaiting: (): Promise<undefined> => {
      h.skipWaiting = true;
      return Promise.resolve(undefined);
    },
    clients: {
      claim: (): Promise<undefined> => {
        h.claimed = true;
        return Promise.resolve(undefined);
      },
    },
    location: { origin: ORIGIN },
    console,
  };
  sandbox['self'] = sandbox;
  sandbox['globalThis'] = sandbox;

  runInContext(source, createContext(sandbox), { filename: 'sw.js' });
  return h;
}

/** Runs an install/activate handler and awaits whatever it passed to `waitUntil`. */
async function run(h: Harness, name: string): Promise<void> {
  const handler = h.handlers[name];
  if (handler === undefined) throw new Error(`sw.js registered no ${name} handler`);
  let waited: Promise<unknown> = Promise.resolve();
  handler({
    waitUntil: (p: Promise<unknown>): void => {
      waited = p;
    },
  });
  await waited;
}

interface Dispatched {
  /** Whether `respondWith` was called at all — i.e. whether the worker intercepted. */
  readonly responded: boolean;
  /** What it was called with, if it was. */
  readonly response: Promise<unknown> | undefined;
}

/** Dispatches one fetch event and reports whether, and with what, it was handled. */
function dispatchFetch(h: Harness, path: string, origin: string = ORIGIN): Dispatched {
  const handler = h.handlers['fetch'];
  if (handler === undefined) throw new Error('sw.js registered no fetch handler');
  let responded = false;
  let response: Promise<unknown> | undefined;
  handler({
    request: { url: `${origin}${path}`, method: 'GET', mode: 'navigate' },
    respondWith: (value: Promise<unknown>): void => {
      responded = true;
      response = value;
    },
  });
  return { responded, response };
}

function handled(h: Harness, path: string, origin: string = ORIGIN): boolean {
  return dispatchFetch(h, path, origin).responded;
}

describe('the worker claims three events and no others', () => {
  it('registers install, activate and fetch, and nothing else', () => {
    const h = load();
    expect(Object.keys(h.handlers).sort()).toEqual(['activate', 'fetch', 'install']);
  });
});

describe('the shell cache is populated completely or not at all', () => {
  it('adds every shell route under the digest-named cache, then skips waiting', async () => {
    const h = load();
    await run(h, 'install');
    // Named first: every loop below iterates this list, so an empty one would
    // make the rest of this file assert nothing at all.
    expect(SHELL_ROUTES, 'the shell is the six assets that are not sw.js').toHaveLength(6);
    expect(Object.keys(h.caches.added), 'exactly one cache, named for this build').toEqual([
      CURRENT_CACHE,
    ]);
    expect([...(h.caches.added[CURRENT_CACHE] ?? [])].sort()).toEqual([...SHELL_ROUTES].sort());
    expect(h.skipWaiting).toBe(true);
  });

  it('fails the install when one asset cannot be cached, and does not skip waiting', async () => {
    // A half-populated shell cache is the offline equivalent of serving six of
    // seven assets: the app opens and is broken. The message is matched so that
    // an install which failed for some OTHER reason — a handler that was never
    // registered, say — cannot pass this case.
    const h = load({ addAllFails: true });
    await expect(run(h, 'install'), 'a rejected addAll must fail the install').rejects.toThrow(
      /offline/,
    );
    expect(h.skipWaiting, 'skipWaiting must not run for a half-populated shell').toBe(false);
  });
});

describe('activation removes every older shell, and nothing else', () => {
  it('deletes superseded ao-shell caches, spares everything else, and claims clients', async () => {
    const superseded = `ao-shell-${'b'.repeat(64)}`;
    const h = load({
      existingCaches: [CURRENT_CACHE, superseded, 'unrelated-cache', 'ao-shell'],
    });
    await run(h, 'activate');
    expect(h.caches.deleted, 'exactly the superseded shell of this build').toEqual([superseded]);
    expect(h.caches.deleted, 'the current shell must survive its own activation').not.toContain(
      CURRENT_CACHE,
    );
    expect(h.caches.deleted, 'a cache this build did not create is not ours').not.toContain(
      'unrelated-cache',
    );
    expect(h.caches.deleted, '"ao-shell" is not "ao-shell-<digest>"').not.toContain('ao-shell');
    expect(h.claimed).toBe(true);
  });

  it('deletes nothing when this build is the only shell present', async () => {
    const h = load({ existingCaches: [CURRENT_CACHE] });
    await run(h, 'activate');
    expect(h.caches.deleted).toEqual([]);
    expect(h.claimed).toBe(true);
  });
});

describe('the fetch handler is an allow-list, not a pattern', () => {
  it('handles exactly the six shell routes', () => {
    const h = load();
    expect(SHELL_ROUTES).toHaveLength(6);
    for (const route of SHELL_ROUTES) expect(handled(h, route), route).toBe(true);
  });

  it('never handles /api/snapshot', () => {
    // The single most important assertion in this file. A cached snapshot shown
    // offline looks live, which is the one thing this whole slice refuses.
    const h = load();
    expect(handled(h, '/api/snapshot')).toBe(false);
    expect(handled(h, '/api/snapshot?poll=1'), 'a query string must not slip past').toBe(false);
  });

  it('bypasses /api/snapshot by name, not merely by its absence from the list', () => {
    // The bypass line is the one statement here that an edit could delete with
    // no other assertion noticing: `/api/snapshot` is not in the shell list
    // either, so "not handled" is true for two reasons and the line carries no
    // weight on its own. This case removes the second reason by handing the
    // worker a route list that DOES contain the endpoint, so only the explicit
    // bypass can keep the answer false.
    //
    // That list is hostile on purpose and is not a shape the build emits:
    // `SHELL_ROUTES` in `ui-assets.ts` is derived from the asset manifest and
    // the API is not an asset. Its subject is the worker's own ordering — that
    // the bypass is decided BEFORE and INDEPENDENTLY of the list — which is
    // the property the design asks for and which no honest input can reach.
    const h = load({ routes: [...SHELL_ROUTES, '/api/snapshot'] });
    expect(handled(h, '/app.js'), 'control: the substituted list is the one in force').toBe(true);
    expect(handled(h, '/api/snapshot'), 'the bypass must precede the allow-list').toBe(false);
  });

  it('never handles anything outside the list', () => {
    const h = load();
    let checked = 0;
    for (const path of ['/sw.js', '/anything', '/app.css.map', '/app.js/', '/index.html', '/']) {
      if (SHELL_ROUTES.includes(path)) continue;
      checked += 1;
      expect(handled(h, path), path).toBe(false);
    }
    expect(checked, 'every candidate was a shell route; this case asserted nothing').toBeGreaterThan(
      0,
    );
  });

  it('never handles another origin asking for a shell path', () => {
    // `/app.js` somewhere else is not this shell's `/app.js`. Without the origin
    // test the allow-list is a list of PATHS rather than of this build's assets.
    const h = load();
    expect(handled(h, '/app.js', 'https://elsewhere.example'), 'foreign origin').toBe(false);
    expect(handled(h, '/app.js'), 'control: the same path on this origin is handled').toBe(true);
  });
});

describe('a handled request is answered from this build, or from the network', () => {
  it('reads the named cache, never the cache store at large', async () => {
    // `caches.match` searches EVERY cache, including a previous shell that
    // activation has not reached yet. Reading by name is what keeps a reply
    // attributable to one build.
    const h = load();
    const { responded, response } = dispatchFetch(h, '/app.css');
    expect(responded).toBe(true);
    expect(await response).toEqual({ from: CURRENT_CACHE, url: `${ORIGIN}/app.css` });
    expect(h.storeMatchCalls, 'the cache store at large must not be searched').toBe(0);
  });

  it('falls through to the network when the cached asset is gone', async () => {
    // A miss must not resolve to `undefined`: `respondWith(undefined)` is a
    // network error in the browser, which would be worse than having no worker.
    const h = load({ cacheMisses: true });
    const { response } = dispatchFetch(h, '/app.css');
    expect(await response).toEqual({ from: 'NETWORK', url: `${ORIGIN}/app.css` });
  });
});

describe('the worker persists no orchestration state', () => {
  it('mentions no storage API and no snapshot caching', () => {
    expect(SOURCE).not.toContain('localStorage');
    expect(SOURCE).not.toContain('sessionStorage');
    expect(SOURCE).not.toContain('indexedDB');
    expect(SOURCE).not.toMatch(/put\s*\(/);
  });

  it('is plain browser script with no module system', () => {
    expect(SOURCE).not.toMatch(/^\s*import\s/m);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
  });
});

describe('the file claims only the cache it owns', () => {
  it('never says its shell cache is the only cache on this origin', () => {
    // The retracted heading ended "and nothing else", which claims something
    // about the ORIGIN that this worker neither knows nor controls — and it
    // blurred the half it does control, because inside its own namespace this
    // worker is an owner: `activate` deletes every superseded `ao-shell-*`.
    // The boundary it actually implements is a prefix test, so the sentence is
    // pinned on the namespace rather than on a disclaimer. The heading is the
    // subject because it is the first sentence a reader of this file gets, and
    // it was the one sentence in the file that overreached.
    const flat = SOURCE.replace(/^[ 	]*\*(?!\*)[ 	]?/gm, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();

    expect(flat).not.toContain('the shell cache, and nothing else');

    // What it owns, what it refuses to hold, and where it stops — the last one
    // named as the namespace `activate` tests for, not as a vaguer promise.
    expect(flat).toContain('its own versioned shell cache');
    expect(flat).toContain('never caches `/api/snapshot`');
    expect(flat).toContain('outside the `ao-shell-*` namespace it touches nothing');
  });
});

describe('the build tokens are what ships', () => {
  it('carries both placeholders verbatim and unsubstituted', () => {
    // Task 9 substitutes these. A committed file that already had a digest in
    // it would be a hand-maintained mirror of the manifest, which is the thing
    // `ui-assets.ts` exists to prevent.
    expect(SOURCE).toContain('__AO_SHELL_DIGEST__');
    expect(SOURCE).toContain("'__AO_SHELL_ROUTES__'");
  });

  it('names the snapshot endpoint literally, so the bypass is readable', () => {
    expect(SOURCE).toContain("'/api/snapshot'");
  });
});
