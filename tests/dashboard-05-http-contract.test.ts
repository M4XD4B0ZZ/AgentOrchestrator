/**
 * DASHBOARD-001 slice 3 — the HTTP contract, pinned without a socket.
 *
 * Every property here is a property of a decision, so every case is a value in
 * and a value out. A listening socket would add nothing to any of them and
 * would make the refusals — a duplicated `Host`, an absolute-form request
 * target, an entity-tag list with a `*` in it — awkward to provoke and slow to
 * read. The socket's own properties are pinned next door, in
 * `dashboard-06-http-server.test.ts`.
 *
 * ── The four things this file exists to keep true ──────────────────────────
 *
 * ORDER. Host is decided before the route. A service that routed first would
 * let a page on another origin learn which paths exist before being refused,
 * and the pins below assert the refusal a *combined* failure produces rather
 * than only each one alone.
 *
 * NO SECOND OPINION. The entity tag is the slice-2 revision, used verbatim. The
 * pins hand the contract a snapshot whose revision is a string no hash could
 * produce, so a layer that recomputed one — over the body, over the fields,
 * however — fails here instead of quietly inventing a second change token.
 *
 * COST. A refused request must not take an observation. The snapshot supplier
 * counts its calls, and every refusal asserts the count did not move.
 *
 * THE HEADERS THAT ARE ABSENT. `Access-Control-Allow-*`, `Set-Cookie`,
 * `Strict-Transport-Security` and `Location` are each asserted absent on every
 * status this service can produce, because each of them is a thing a later
 * slice could add for a good-sounding reason and none of them may arrive
 * without the decision being visible in a diff.
 */

import { describe, expect, it } from 'vitest';

import {
  CONSTANT_HEADERS,
  DASHBOARD_BIND_HOST,
  DASHBOARD_DEFAULT_PORT,
  JSON_CONTENT_TYPE,
  SNAPSHOT_METHOD,
  SNAPSHOT_PATH,
  allowedHostsFor,
  entityTagFor,
  ifNoneMatchSelects,
  normaliseHost,
  pathOf,
  respondToDashboardRequest,
  type DashboardHttpResponse,
  type DashboardRequestFacts,
} from '../src/dashboard/http-contract.js';
import { canonicalJson, type PublicSnapshot } from '../src/dashboard/public-view.js';

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/**
 * A revision no hash function could have produced.
 *
 * That is the point of it: if any pin below still passes while the HTTP layer
 * computes its own token, the token it computed happened to equal this string,
 * which it cannot.
 */
const REVISION = 'REVISION-NOT-A-HASH-0001';

function snapshotWith(
  revision: string,
  observedAt = '2026-09-15T21:00:00.000Z',
): PublicSnapshot {
  return {
    observedAt,
    revision,
    registry: { reading: 'NOT_REGISTERED' },
    repositories: [],
    needsOperator: [],
    notes: [],
  };
}

const DEFAULT_ALLOWED = allowedHostsFor(DASHBOARD_BIND_HOST, DASHBOARD_DEFAULT_PORT, []);
const DEFAULT_HOST = `${DASHBOARD_BIND_HOST}:${String(DASHBOARD_DEFAULT_PORT)}`;

/** A counting supplier, so "a refusal costs no observation" is measurable. */
function supplier(snapshot: PublicSnapshot): { get: () => PublicSnapshot; calls: () => number } {
  let calls = 0;
  return {
    get: (): PublicSnapshot => {
      calls += 1;
      return snapshot;
    },
    calls: (): number => calls,
  };
}

function request(overrides: Partial<DashboardRequestFacts> = {}): DashboardRequestFacts {
  return {
    method: SNAPSHOT_METHOD,
    target: SNAPSHOT_PATH,
    hostHeaders: [DEFAULT_HOST],
    ifNoneMatch: null,
    ...overrides,
  };
}

function answer(
  overrides: Partial<DashboardRequestFacts> = {},
  allowed: readonly string[] = DEFAULT_ALLOWED,
  snapshot: PublicSnapshot = snapshotWith(REVISION),
): DashboardHttpResponse {
  return respondToDashboardRequest(request(overrides), allowed, () => snapshot);
}

/** Header lookup that does not depend on the casing this build chose. */
function header(response: DashboardHttpResponse, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/* ── 1. the fixed surface ─────────────────────────────────────────────────── */

describe('the surface is fixed, and the constants say so', () => {
  it('binds the loopback literal and never a name', () => {
    expect(DASHBOARD_BIND_HOST).toBe('127.0.0.1');
    // `localhost` is a name a resolver answers, and what it answers is a
    // property of a hosts file rather than of this build. It may not appear.
    expect(DASHBOARD_BIND_HOST).not.toContain('localhost');
  });

  it('fixes the default port and the one route', () => {
    expect(DASHBOARD_DEFAULT_PORT).toBe(47113);
    expect(SNAPSHOT_PATH).toBe('/api/snapshot');
    expect(SNAPSHOT_METHOD).toBe('GET');
  });

  it('carries the three headers every answer needs, and no transport claim', () => {
    expect(CONSTANT_HEADERS).toEqual({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    });
  });
});

/* ── 2. hosts ─────────────────────────────────────────────────────────────── */

describe('a Host is compared, never interpreted', () => {
  it('folds only ASCII upper case', () => {
    expect(normaliseHost('AO-Manager.Example:443')).toBe('ao-manager.example:443');
    expect(normaliseHost('127.0.0.1:47113')).toBe('127.0.0.1:47113');
  });

  it('refuses a Unicode letter rather than case-folding it', () => {
    // The reason the fold is written by hand. `'İ'.toLowerCase()` is TWO code
    // points, so a Unicode fold can change a string's length and can map two
    // distinct inputs onto one allow-list entry. A host is ASCII on the wire,
    // so the value is refused outright and no fold has to be trusted.
    expect('İ'.toLowerCase().length).toBe(2);
    expect(normaliseHost('İstanbul.example')).toBeNull();
  });

  it('refuses anything that could not have been a Host field value', () => {
    for (const bad of [
      '',
      'a'.repeat(256),
      'has space',
      'a,b',
      'host/path',
      'host\\path',
      'ho"st',
      "ho'st",
      'user@host',
      'null\u0000byte',
      'tab\there',
      'newline\nhere',
      'caf\u00e9.example',
    ]) {
      expect(normaliseHost(bad), bad).toBeNull();
    }
  });

  it('derives the default entry from the bind actually being made', () => {
    expect(allowedHostsFor('127.0.0.1', 47113, [])).toEqual(['127.0.0.1:47113']);
    expect(allowedHostsFor('127.0.0.1', 8080, [])).toEqual(['127.0.0.1:8080']);
    expect(allowedHostsFor('127.0.0.1', 443, [])).toEqual(['127.0.0.1:443']);
  });

  it('also derives the spelling a client uses when the port is the one it omits', () => {
    // Measured, and it was a real refusal before this case existed: with
    // `--port 80`, `curl http://127.0.0.1/api/snapshot` puts `Host: 127.0.0.1`
    // on the wire — no port, because 80 is the default of the scheme this
    // service speaks — so an allow-list holding only `127.0.0.1:80` answered
    // 421 to every request made to the address the command had just printed.
    expect(allowedHostsFor('127.0.0.1', 80, [])).toEqual(['127.0.0.1:80', '127.0.0.1']);

    // Both spellings are the same authority, so both are answered.
    const allowed = allowedHostsFor('127.0.0.1', 80, []);
    expect(answer({ hostHeaders: ['127.0.0.1'] }, allowed).status).toBe(200);
    expect(answer({ hostHeaders: ['127.0.0.1:80'] }, allowed).status).toBe(200);

    // And it is not a widening: it is still the loopback literal, so a name an
    // attacker controls is refused exactly as it was.
    expect(answer({ hostHeaders: ['evil.example'] }, allowed).status).toBe(421);
    expect(answer({ hostHeaders: ['evil.example:80'] }, allowed).status).toBe(421);
  });

  it('adds the bare spelling on no other port, because no other port is elided', () => {
    // 443 is the default for `https`, which this service does not speak — a
    // client asked for `http://127.0.0.1:443/` sends the port.
    for (const port of [47113, 443, 8080, 1, 65535]) {
      expect(allowedHostsFor('127.0.0.1', port, []), String(port)).toEqual([
        `127.0.0.1:${String(port)}`,
      ]);
    }
  });

  it('folds, de-duplicates and drops the unusable among the operator’s additions', () => {
    expect(allowedHostsFor('127.0.0.1', 47113, ['Phone.Example', 'phone.example', 'bad host'])).toEqual(
      ['127.0.0.1:47113', 'phone.example'],
    );
  });

  it('answers 421 for a well-formed Host nobody allowed', () => {
    const response = answer({ hostHeaders: ['evil.example'] });
    expect(response.status).toBe(421);
    expect(response.body).toContain('HOST_NOT_ALLOWED');
  });

  it('answers 400, not 421, when there is no Host at all', () => {
    // Nothing was misdirected: the request never said where it was aimed.
    expect(answer({ hostHeaders: [] }).status).toBe(400);
  });

  it('answers 400 when two Hosts arrive, rather than picking one', () => {
    // The refusal that needs `rawHeaders` to be reachable at all. Two Hosts
    // make "which authority was this routed on" unanswerable, and answering it
    // by taking the first is what a request smuggled past a front end relies
    // on.
    expect(answer({ hostHeaders: [DEFAULT_HOST, 'evil.example'] }).status).toBe(400);
    expect(answer({ hostHeaders: ['evil.example', DEFAULT_HOST] }).status).toBe(400);
  });

  it('accepts an operator-supplied opaque Host, case-insensitively', () => {
    const allowed = allowedHostsFor(DASHBOARD_BIND_HOST, DASHBOARD_DEFAULT_PORT, [
      'ao.example:443',
    ]);
    expect(answer({ hostHeaders: ['AO.Example:443'] }, allowed).status).toBe(200);
  });

  it('decides the Host before the route, so an unknown path still answers 421', () => {
    // The ordering pin. If routing came first this would be 404 and a page on
    // another origin would learn which paths exist before being refused.
    expect(answer({ hostHeaders: ['evil.example'], target: '/nope' }).status).toBe(421);
    expect(answer({ hostHeaders: ['evil.example'], method: 'POST' }).status).toBe(421);
  });

  // "This layer derives no trust from a remote address or a forwarding header"
  // is deliberately NOT pinned here, and the first version of this file pinned
  // it wrongly: it asserted the key set of `request()`, which is this file's own
  // fixture builder, so it measured the test and not the build —
  // `DashboardRequestFacts` is a type and is gone at runtime. The property is
  // one about production source, and it is pinned as one, over the only module
  // that could read such a thing, in dashboard-07.
});

/* ── 3. the route ─────────────────────────────────────────────────────────── */

describe('one route, compared literally', () => {
  it('strips a query and a fragment and nothing else', () => {
    expect(pathOf('/api/snapshot')).toBe('/api/snapshot');
    expect(pathOf('/api/snapshot?since=1')).toBe('/api/snapshot');
    expect(pathOf('/api/snapshot#frag')).toBe('/api/snapshot');
    expect(pathOf('/api/snapshot?a=#b')).toBe('/api/snapshot');
    expect(pathOf('/api/snapshot#a?b')).toBe('/api/snapshot');
  });

  it('refuses any target that is not origin-form', () => {
    // Absolute-form carries a second authority beside the `Host` header, and a
    // service accepting both would have to decide which one its allow-list is
    // about. Asterisk-form and authority-form go the same way.
    expect(pathOf('http://elsewhere/api/snapshot')).toBeNull();
    expect(pathOf('*')).toBeNull();
    expect(pathOf('elsewhere:443')).toBeNull();
    expect(answer({ target: 'http://127.0.0.1:47113/api/snapshot' }).status).toBe(400);
  });

  it('does not decode, collapse or normalise the path', () => {
    for (const target of [
      '/api/snapshot/',
      '/api%2Fsnapshot',
      '/API/SNAPSHOT',
      '/api//snapshot',
      '/./api/snapshot',
      '/nope',
      '/',
    ]) {
      expect(answer({ target }).status, target).toBe(404);
    }
  });

  it('serves the route with a query string attached', () => {
    expect(answer({ target: '/api/snapshot?poll=1' }).status).toBe(200);
  });
});

/* ── 4. the method ────────────────────────────────────────────────────────── */

describe('one method, and the refusal says which', () => {
  it('refuses every other method with 405 and an Allow', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'TRACE', 'get']) {
      const response = answer({ method });
      expect(response.status, method).toBe(405);
      expect(header(response, 'Allow'), method).toBe('GET');
      expect(response.body, method).toContain('METHOD_NOT_ALLOWED');
    }
  });

  it('answers 404 before 405 for an unknown path, so a probe learns no less', () => {
    // Deliberate and stated: the route does not exist, so "which methods does
    // it offer" has no answer to give.
    expect(answer({ method: 'POST', target: '/nope' }).status).toBe(404);
  });
});

/* ── 5. the entity tag ────────────────────────────────────────────────────── */

describe('the entity tag is the slice-2 revision, weak, and not recomputed', () => {
  it('is the revision verbatim, in weak form', () => {
    expect(entityTagFor(snapshotWith(REVISION))).toBe(`W/"${REVISION}"`);
    expect(header(answer(), 'ETag')).toBe(`W/"${REVISION}"`);
  });

  it('is always weak, because observedAt moves under a revision that does not', () => {
    // The whole argument for `W/` in one case: two observations that are the
    // same observation carry different bytes, and a strong tag would be a claim
    // about bytes that is false.
    const early = answer({}, DEFAULT_ALLOWED, snapshotWith(REVISION, '2026-09-15T21:00:00.000Z'));
    const late = answer({}, DEFAULT_ALLOWED, snapshotWith(REVISION, '2026-09-15T22:00:00.000Z'));
    expect(header(early, 'ETag')).toBe(header(late, 'ETag'));
    expect(early.body).not.toBe(late.body);
    expect(header(early, 'ETag')?.startsWith('W/')).toBe(true);
  });

  it('moves when the revision moves', () => {
    const other = answer({}, DEFAULT_ALLOWED, snapshotWith('REVISION-NOT-A-HASH-0002'));
    expect(header(other, 'ETag')).toBe('W/"REVISION-NOT-A-HASH-0002"');
    expect(header(other, 'ETag')).not.toBe(header(answer(), 'ETag'));
  });

  it('compares weakly, and a list and a star both select', () => {
    const tag = `W/"${REVISION}"`;
    expect(ifNoneMatchSelects(tag, tag)).toBe(true);
    expect(ifNoneMatchSelects(`"${REVISION}"`, tag)).toBe(true);
    expect(ifNoneMatchSelects('*', tag)).toBe(true);
    expect(ifNoneMatchSelects(`W/"other", ${tag}`, tag)).toBe(true);
    expect(ifNoneMatchSelects(' , W/"other" ', tag)).toBe(false);
    expect(ifNoneMatchSelects('', tag)).toBe(false);
  });

  it('fails towards the full response when a tag string is mis-parsed', () => {
    // The bounded imprecision, written down as a case. The naive split on `,`
    // mis-reads an opaque tag that contains one; the consequence is a `200`
    // with the current body, which is always correct and never stale.
    expect(ifNoneMatchSelects('W/"a,b"', 'W/"a,b"')).toBe(false);
  });

  it('answers 304 with no body and nothing describing one', () => {
    const response = answer({ ifNoneMatch: `W/"${REVISION}"` });
    expect(response.status).toBe(304);
    expect(response.body).toBeNull();
    expect(header(response, 'ETag')).toBe(`W/"${REVISION}"`);
    // A `Content-Length: 0` would describe an empty body; there is no body.
    expect(header(response, 'Content-Length')).toBeUndefined();
    expect(header(response, 'Content-Type')).toBeUndefined();
    // The caching directives still travel: a 304 that dropped them would let a
    // shared cache decide for itself.
    expect(header(response, 'Cache-Control')).toBe('no-store');
  });

  it('answers 200 with the body when the caller holds a different revision', () => {
    const response = answer({ ifNoneMatch: 'W/"REVISION-NOT-A-HASH-0002"' });
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();
  });
});

/* ── 6. the body ──────────────────────────────────────────────────────────── */

describe('the body is the public snapshot, serialised once', () => {
  it('is canonicalJson of the snapshot, with a newline', () => {
    const snapshot = snapshotWith(REVISION);
    const response = answer({}, DEFAULT_ALLOWED, snapshot);
    expect(response.body).toBe(`${canonicalJson(snapshot)}\n`);
    expect(JSON.parse(response.body ?? '')).toEqual(snapshot);
  });

  it('is the same bytes for the same snapshot, every time', () => {
    // What makes the weak tag defensible: the encoding is not free to move
    // under a revision that says the representation has not changed.
    const snapshot = snapshotWith(REVISION);
    expect(answer({}, DEFAULT_ALLOWED, snapshot).body).toBe(
      answer({}, DEFAULT_ALLOWED, snapshot).body,
    );
  });

  it('declares its length in bytes and its type as JSON', () => {
    const response = answer();
    expect(header(response, 'Content-Type')).toBe(JSON_CONTENT_TYPE);
    expect(header(response, 'Content-Length')).toBe(
      String(Buffer.byteLength(response.body ?? '', 'utf8')),
    );
  });

  it('counts bytes and not characters', () => {
    // A note detail is free text from a reader, so a non-ASCII byte can reach
    // the body. `length` would under-count it and the response would be cut.
    const snapshot: PublicSnapshot = {
      ...snapshotWith(REVISION),
      notes: [{ code: 'REGISTRY_UNUSABLE', repositoryKey: null, taskId: null, detail: 'café—ü' }],
    };
    const response = answer({}, DEFAULT_ALLOWED, snapshot);
    const body = response.body ?? '';
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(body.length);
    expect(header(response, 'Content-Length')).toBe(String(Buffer.byteLength(body, 'utf8')));
  });
});

/* ── 7. what a refusal costs, and what never travels ──────────────────────── */

describe('a refusal takes no observation', () => {
  it.each([
    ['no Host', { hostHeaders: [] }],
    ['two Hosts', { hostHeaders: [DEFAULT_HOST, 'evil.example'] }],
    ['an unlisted Host', { hostHeaders: ['evil.example'] }],
    ['a target that is not origin-form', { target: '*' }],
    ['an unknown route', { target: '/nope' }],
    ['a method nobody offers', { method: 'POST' }],
  ])('does not read the snapshot for %s', (_name, overrides) => {
    const counting = supplier(snapshotWith(REVISION));
    respondToDashboardRequest(request(overrides), DEFAULT_ALLOWED, counting.get);
    expect(counting.calls()).toBe(0);
  });

  it('reads it exactly once for a request it answers', () => {
    const counting = supplier(snapshotWith(REVISION));
    respondToDashboardRequest(request(), DEFAULT_ALLOWED, counting.get);
    expect(counting.calls()).toBe(1);
  });

  it('lets a failing observation through rather than reporting an empty machine', () => {
    // Swallowing here would make a defect in the read model indistinguishable
    // from a machine with nothing on it. The server turns this into a 500.
    expect(() =>
      respondToDashboardRequest(request(), DEFAULT_ALLOWED, () => {
        throw new Error('the reader failed');
      }),
    ).toThrow();
  });
});

describe('four headers may never appear, on any status', () => {
  const BANNED = [
    'strict-transport-security',
    'access-control-allow-origin',
    'access-control-allow-credentials',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-expose-headers',
    'set-cookie',
    'location',
  ];

  it.each([
    ['200', {}],
    ['304', { ifNoneMatch: `W/"${REVISION}"` }],
    ['400 (no Host)', { hostHeaders: [] as readonly string[] }],
    ['400 (target)', { target: '*' }],
    ['421', { hostHeaders: ['evil.example'] }],
    ['404', { target: '/nope' }],
    ['405', { method: 'POST' }],
  ])('sends none of them on %s', (_name, overrides) => {
    const response = answer(overrides);
    const sent = Object.keys(response.headers).map((key) => key.toLowerCase());
    for (const banned of BANNED) expect(sent, banned).not.toContain(banned);
    // And every answer still carries the three that must be there.
    for (const [name, value] of Object.entries(CONSTANT_HEADERS)) {
      expect(header(response, name)).toBe(value);
    }
  });

  it('never puts a path, a header value or an exception into a refusal body', () => {
    const response = respondToDashboardRequest(
      request({ target: '/secret/D:\\Workspaces\\LEAKCANARY', hostHeaders: ['LEAKCANARY.example'] }),
      DEFAULT_ALLOWED,
      () => snapshotWith(REVISION),
    );
    expect(response.body).toBe('{"error":"HOST_NOT_ALLOWED"}\n');
    expect(response.body).not.toContain('LEAKCANARY');
  });
});
