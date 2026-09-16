# DASHBOARD-001 Slice 4 — Mobile UI / PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a mobile-first, installable, read-only web UI for AgentOrchestrator from the loopback listener slice 3 already owns, without inventing any fact the snapshot does not carry.

**Architecture:** The UI is authored as ordinary files under `src/dashboard/ui/`. A closed literal manifest maps each URL path to exactly one of them; the whole set is read into a frozen in-memory map **before** the socket opens, so a request is a `Map.get` on the undecoded path and never a filesystem operation. The page polls `GET /api/snapshot`, keeps its own freshness clock, and degrades visibly to `STALE` / `OFFLINE` while keeping the last good data on screen. A service worker caches only the six shell assets and never the API.

**Tech Stack:** TypeScript 7, Node 22/24, vitest 4, plain DOM JavaScript (no framework, no bundler, no CDN). **No new dependency is added by this slice.**

**Spec:** `docs/superpowers/specs/2026-09-16-dashboard-001-slice-4-mobile-ui-pwa-design.md`

## Global Constraints

Every task's requirements implicitly include all of these.

- **Bind address is untouched.** `DASHBOARD_BIND_HOST = '127.0.0.1'`. No new option may widen it.
- **No authentication, no CORS, no cookies, no HSTS.** No `Access-Control-Allow-*` header on any response, ever.
- **No Tailscale or proxy knowledge in `src/`.** The strings `tailscale` and `ts.net` must not appear in any file under `src/`, including the new `.js`, `.html`, `.css` and `.webmanifest` files.
- **No external dependency.** No CDN URL, no `<script src="http...">`, no new entry in `package.json` dependencies or devDependencies.
- **No absolute URL in the frontend.** Every reference is root-relative (`/app.css`, `/api/snapshot`).
- **Request input never becomes a filesystem path.** No `path.join`, no decoding, no normalisation of a request target anywhere in the serving path.
- **No `'unsafe-inline'` in any CSP.** Therefore `index.html` contains no inline `<script>`, no `<style>` element and no `style=` attribute.
- **No invented progress.** No percentage, no "step N of M". `stateEnteredAt` is the step's start and is rendered only as `recorded <age> ago`.
- **Every derived age is computed against `snapshot.observedAt`**, never `Date.now()`, and freezes when the page is `STALE` or `OFFLINE`.
- **The freshness clock is the client's `lastSuccessfulFetchAt`**, and both `200` and `304` reset it.
- **`If-None-Match` echoes the `ETag` header value verbatim** (`W/"…"`), never the bare `revision`.
- **Snapshot data is never persisted.** No `localStorage`, no `sessionStorage`, no IndexedDB, no `cache.put` of `/api/snapshot`.
- **Inference stays visibly inference.** `Likely active task`, never `Current task`.
- **Commit style:** conventional prefix with a scope, e.g. `feat(dashboard): …`. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01XWwJDPFVRtowJmCQqS4Hag
  ```
- **Branch:** `feat/dashboard-mobile-ui`. Never commit to `main`.
- **Fast gates while iterating:** `npm run typecheck` (~2 s) and the single test file (~4 s). Run `npm run verify` **once**, at the end.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/dashboard/ui-assets.ts` | **create** — the closed manifest (the single authority) and the all-or-nothing startup loader |
| `src/dashboard/ui/index.html` | **create** — the shell document; no inline script or style |
| `src/dashboard/ui/app.css` | **create** — all presentation |
| `src/dashboard/ui/app.js` | **create** — pure view-model + HTML-string rendering + DOM glue + polling |
| `src/dashboard/ui/sw.js` | **create** — service worker; shell-only cache, allow-list fetch handler |
| `src/dashboard/ui/manifest.webmanifest` | **create** — installability |
| `src/dashboard/ui/icon-192.png`, `icon-512.png` | **create** — authored once, committed |
| `src/dashboard/http-contract.ts` | **modify** — body type widens; UI CSP; the asset route |
| `src/dashboard/http-server.ts` | **modify** — `write()` carries bytes; config carries the asset map |
| `src/cli/dashboard-command.ts` | **modify** — load assets before binding; `UI_ASSETS_UNUSABLE`; corrected help text |
| `src/cli/index.ts` | **modify** — corrected front-page text |
| `scripts/build-ui-assets.mjs` | **create** — the shared emit step, invoked by build **and** deploy |
| `scripts/deploy-runtime.mjs` | **modify** — emit assets into staging |
| `package.json` | **modify** — `build:ui` in the build chain |
| `tests/dashboard-08-ui-assets.test.ts` | **create** — manifest, loader, asset routing, CSP, traversal |
| `tests/dashboard-09-ui-logic.test.ts` | **create** — `app.js` view-model + rendering, via `node:vm` |
| `tests/dashboard-10-service-worker.test.ts` | **create** — `sw.js` lifecycle, via `node:vm` |
| `tests/dist-artifact/dashboard-ui-dist-artifact.mjs` | **create** — the built CLI serves every route; digest; a real 304 |
| `tests/dashboard-05/06/07-*.test.ts` | **modify** — three existing pins rewritten to the new promise |
| `README.md` | **modify** — the slice-3 section's "one route" sentence |

---

## Task 1: The manifest and the all-or-nothing loader

**Files:**
- Create: `src/dashboard/ui-assets.ts`
- Test: `tests/dashboard-08-ui-assets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `UI_ASSET_MANIFEST: readonly UiAssetEntry[]` where `UiAssetEntry = { readonly route: string; readonly file: string; readonly contentType: string }`
  - `SHELL_ROUTES: readonly string[]` — manifest routes minus `/sw.js`
  - `type DashboardAssetMap = ReadonlyMap<string, { readonly bytes: Uint8Array; readonly contentType: string }>`
  - `loadUiAssets(rootDir: string): { readonly outcome: 'LOADED'; readonly assets: DashboardAssetMap } | { readonly outcome: 'MISSING'; readonly route: string }`
  - `uiAssetRoot(moduleUrl: string): string` — resolves `<dir of compiled module>/ui`

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-08-ui-assets.test.ts`:

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  UI_ASSET_MANIFEST,
  SHELL_ROUTES,
  loadUiAssets,
} from '../src/dashboard/ui-assets.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* a leftover scratch directory is not worth failing a suite over */
    }
  }
});

/** A directory holding every manifest file, minus the ones named. */
function assetDir(omit: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'ao-ui-assets-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const entry of UI_ASSET_MANIFEST) {
    if (omit.includes(entry.file)) continue;
    writeFileSync(join(root, entry.file), `bytes-of-${entry.file}`, 'utf8');
  }
  return root;
}

describe('the manifest is a closed list with one authority', () => {
  it('maps every route exactly once, and every file exactly once', () => {
    const routes = UI_ASSET_MANIFEST.map((e) => e.route);
    const files = UI_ASSET_MANIFEST.map((e) => e.file);
    expect(new Set(routes).size).toBe(routes.length);
    expect(new Set(files).size).toBe(files.length);
  });

  it('names the seven assets the design fixes, and no others', () => {
    expect(UI_ASSET_MANIFEST.map((e) => e.route).sort()).toEqual([
      '/',
      '/app.css',
      '/app.js',
      '/icon-192.png',
      '/icon-512.png',
      '/manifest.webmanifest',
      '/sw.js',
    ]);
  });

  it('derives the shell routes from the manifest, excluding the worker itself', () => {
    // The worker cannot be an element of the set it caches: its own bytes carry
    // the digest of that set.
    expect([...SHELL_ROUTES].sort()).toEqual([
      '/',
      '/app.css',
      '/app.js',
      '/icon-192.png',
      '/icon-512.png',
      '/manifest.webmanifest',
    ]);
    expect(SHELL_ROUTES).not.toContain('/sw.js');
  });

  it('gives every asset a content type, and no asset a charset it should not have', () => {
    const byRoute = new Map(UI_ASSET_MANIFEST.map((e) => [e.route, e.contentType]));
    expect(byRoute.get('/')).toBe('text/html; charset=utf-8');
    expect(byRoute.get('/app.css')).toBe('text/css; charset=utf-8');
    expect(byRoute.get('/app.js')).toBe('text/javascript; charset=utf-8');
    expect(byRoute.get('/sw.js')).toBe('text/javascript; charset=utf-8');
    expect(byRoute.get('/manifest.webmanifest')).toBe('application/manifest+json');
    expect(byRoute.get('/icon-192.png')).toBe('image/png');
    expect(byRoute.get('/icon-512.png')).toBe('image/png');
  });
});

describe('loading is all or nothing', () => {
  it('loads every asset as bytes, keyed by route', () => {
    const loaded = loadUiAssets(assetDir());
    expect(loaded.outcome).toBe('LOADED');
    if (loaded.outcome !== 'LOADED') return;
    expect(loaded.assets.size).toBe(UI_ASSET_MANIFEST.length);
    const html = loaded.assets.get('/');
    expect(html).toBeDefined();
    expect(Buffer.from(html!.bytes).toString('utf8')).toBe('bytes-of-index.html');
    expect(html!.contentType).toBe('text/html; charset=utf-8');
  });

  it('refuses the whole set when one asset is missing, and names the ROUTE', () => {
    // The route, never the filesystem path: a refusal reaches an operator and
    // must not carry where this machine keeps its files.
    const missing = loadUiAssets(assetDir(['icon-512.png']));
    expect(missing.outcome).toBe('MISSING');
    if (missing.outcome !== 'MISSING') return;
    expect(missing.route).toBe('/icon-512.png');
    expect(JSON.stringify(missing)).not.toContain(tmpdir());
  });

  it('refuses a directory that does not exist at all', () => {
    const absent = loadUiAssets(join(tmpdir(), 'ao-ui-assets-definitely-absent'));
    expect(absent.outcome).toBe('MISSING');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/dashboard-08-ui-assets.test.ts`
Expected: FAIL — cannot resolve `../src/dashboard/ui-assets.js`.

- [ ] **Step 3: Write the implementation**

Create `src/dashboard/ui-assets.ts`:

```ts
/**
 * DASHBOARD-001 slice 4 — the closed asset manifest, and the only reader of it.
 *
 * This module is the single authority for what the UI consists of. Two other
 * lists are DERIVED from it and never hand-maintained: the digest input and the
 * service worker's fetch allow-list, both substituted into `sw.js` by
 * `scripts/build-ui-assets.mjs`.
 *
 * ── Why a list and not a directory ─────────────────────────────────────────
 *
 * The alternative is a static-file server: take the request target, decode it,
 * normalise it, join it onto a root and open whatever comes out. Every path
 * traversal defect in the history of the web lives in that sentence. Here a
 * request is a lookup in a `Map` keyed by the path exactly as it
 * arrived, so `..`, `%2e%2e` and a backslash are strings that are not keys.
 * Traversal is not mitigated; it has nowhere to go.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One shipped asset: the route it answers, its file, and how to label it. */
export interface UiAssetEntry {
  readonly route: string;
  readonly file: string;
  readonly contentType: string;
}

/**
 * Every asset this build serves. Closed, literal, and ordered for reading.
 *
 * `/manifest.webmanifest` carries `application/manifest+json` rather than
 * `application/json`: a browser will parse either, but the specific type is the
 * one that says what the bytes are for.
 */
export const UI_ASSET_MANIFEST: readonly UiAssetEntry[] = Object.freeze([
  Object.freeze({ route: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' }),
  Object.freeze({ route: '/app.css', file: 'app.css', contentType: 'text/css; charset=utf-8' }),
  Object.freeze({ route: '/app.js', file: 'app.js', contentType: 'text/javascript; charset=utf-8' }),
  Object.freeze({ route: '/sw.js', file: 'sw.js', contentType: 'text/javascript; charset=utf-8' }),
  Object.freeze({
    route: '/manifest.webmanifest',
    file: 'manifest.webmanifest',
    contentType: 'application/manifest+json',
  }),
  Object.freeze({ route: '/icon-192.png', file: 'icon-192.png', contentType: 'image/png' }),
  Object.freeze({ route: '/icon-512.png', file: 'icon-512.png', contentType: 'image/png' }),
]);

/**
 * The shell: what the service worker caches, and what the digest is taken over.
 *
 * `/sw.js` is excluded, and the exclusion is load-bearing rather than tidy. The
 * worker's own bytes carry the digest of this set, so including it would define
 * the digest in terms of itself.
 */
export const SHELL_ROUTES: readonly string[] = Object.freeze(
  UI_ASSET_MANIFEST.filter((entry) => entry.route !== '/sw.js').map((entry) => entry.route),
);

/** One asset in memory. Bytes, because two of the seven are not text. */
export interface LoadedUiAsset {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * The route→asset map a running server answers from.
 *
 * Protection is type-level and conventional: the map is built once by this
 * loader and nothing in this build writes to it afterwards. There is
 * deliberately no runtime `Object.freeze` — a frozen object would refuse key
 * mutation but the bytes it points at stay writable either way, so the
 * guarantee would be partial rather than real. A partial guarantee is not
 * worth changing the container type for.
 */
export type DashboardAssetMap = ReadonlyMap<string, LoadedUiAsset>;

/** What a load attempt did. Total: every path returns one of these. */
export type UiAssetLoad =
  | { readonly outcome: 'LOADED'; readonly assets: DashboardAssetMap }
  | { readonly outcome: 'MISSING'; readonly route: string };

/**
 * Where the assets sit beside the compiled module.
 *
 * Resolved from the module's own location rather than from `process.cwd()` or
 * from the repository root, so the same code finds them under `build/` and
 * under a deployed `dist/` without being told which it is running from.
 */
export function uiAssetRoot(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), 'ui');
}

/**
 * Reads every manifest asset, or none of them.
 *
 * All-or-nothing on purpose. A build that shipped six of seven assets would
 * otherwise serve a UI missing its stylesheet — a half-broken page an operator
 * has to diagnose, in place of a refusal at startup that names the defect. The
 * failure carries the ROUTE and never a filesystem path: it reaches an operator,
 * and a path names this machine.
 */
export function loadUiAssets(rootDir: string): UiAssetLoad {
  const assets = new Map<string, LoadedUiAsset>();
  for (const entry of UI_ASSET_MANIFEST) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(rootDir, entry.file));
    } catch {
      return Object.freeze({ outcome: 'MISSING' as const, route: entry.route });
    }
    assets.set(entry.route, Object.freeze({ bytes, contentType: entry.contentType }));
  }
  return Object.freeze({ outcome: 'LOADED' as const, assets: assets as DashboardAssetMap });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run tests/dashboard-08-ui-assets.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/dashboard/ui-assets.ts tests/dashboard-08-ui-assets.test.ts
git commit -m "feat(dashboard): a closed asset manifest, read all at once or not at all"
```

---

## Task 2: The response body carries bytes, not only text

**Files:**
- Modify: `src/dashboard/http-contract.ts` (the `DashboardHttpResponse` interface)
- Modify: `src/dashboard/http-server.ts` (`write`, ~line 137)
- Test: `tests/dashboard-06-http-server.test.ts` (append one case)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `DashboardHttpResponse.body: string | Uint8Array | null`.

**Why this task exists:** `DashboardHttpResponse.body` is `string | null`, so two of the seven assets — the PNGs — cannot be expressed at all. The type must widen before Task 3 can serve them, and `Content-Length` must be computed in bytes for both arms. It is separable, so it gets its own reviewable commit.

> **Correction, measured.** An earlier draft of this task claimed the defect was
> that `response.end(bytes, 'utf8')` corrupts the bytes. **That is false**, and
> it was measured over a real socket: `89504e47ff00c3` goes out and
> `89504e47ff00c3` comes back. Node applies an `encoding` only to a *string*
> chunk; for a byte chunk the argument is inert. The real corruption path is
> holding bytes **in a string** and re-encoding them, which is why the type —
> not the encoding argument — is the thing that has to change. Dropping the
> inert `'utf8'` on the bytes arm is honesty about what is being sent, not a
> bug fix.

> **Scope, also corrected.** There is **no honest wire-level byte test at this
> point in the sequence**, and this task must not pretend otherwise. No
> production path can produce a bytes body until Task 3 gives the contract its
> asset arm, and the only injectable seam is `snapshot`, which returns a string.
> A test that stands up its own `node:http` server to prove "bytes survive"
> proves only that Node works — it would pass with `http-server.ts` deleted.
> The wire-level pin lives in **Task 3** (contract: a `Uint8Array` body with a
> byte-counted `Content-Length`) and **Task 11** (dist gate: a served icon
> compared to the file on disk, byte for byte, through the built CLI). What
> this task pins instead is `bodyByteLength`, which is real production code
> with two call sites.

- [ ] **Step 1: Write the failing test**

`bodyByteLength` is what this task can honestly pin: it is real production
code, Step 3 gives it two call sites, and it has no test today. A wrong
`Content-Length` is a response that lies about itself.

Append to `tests/dashboard-05-http-contract.test.ts` — the pure-contract suite,
where that export lives:

```ts
describe('a body is measured in bytes, because that is what the wire carries', () => {
  it('counts a multi-byte string in bytes rather than in code units', () => {
    // The string is chosen so the two numbers DISAGREE. An ASCII-only string
    // would pass against a `String.prototype.length` implementation and prove
    // nothing at all — which is the whole defect class here.
    const text = 'café 🎛';
    expect(text.length).not.toBe(Buffer.byteLength(text, 'utf8'));
    expect(bodyByteLength(text)).toBe(Buffer.byteLength(text, 'utf8'));
    expect(bodyByteLength(text)).not.toBe(text.length);
  });

  it('counts a byte array by its byteLength', () => {
    expect(bodyByteLength(Uint8Array.from([0x89, 0x50, 0xff, 0x00]))).toBe(4);
  });

  it('counts an empty body of either arm as zero', () => {
    expect(bodyByteLength('')).toBe(0);
    expect(bodyByteLength(new Uint8Array(0))).toBe(0);
  });

  it('is the number the contract actually declares', () => {
    // The units above prove the function; this proves a CALL SITE uses it. A
    // refusal body is ASCII, so this one cannot distinguish the two
    // implementations by itself — it pins that the header is derived from the
    // body at all, and Task 3's 200 branch carries the non-ASCII case.
    const refusal = answer({ target: '/nope' });
    expect(header(refusal, 'Content-Length')).toBe(
      String(Buffer.byteLength(refusal.body as string, 'utf8')),
    );
  });
});
```

Add `bodyByteLength` to this file's import from `../src/dashboard/http-contract.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/dashboard-05-http-contract.test.ts -t "measured in bytes"`
Expected: FAIL — `bodyByteLength` is not exported yet. It fails because the
production function does not exist, which is the right reason to fail.

- [ ] **Step 3: Write the implementation**

**3a.** In `src/dashboard/http-contract.ts`, widen the interface:

```ts
/** What to write back. Header names are already in the casing to send. */
export interface DashboardHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * `null` means no body at all — not an empty one.
   *
   * `Uint8Array` is not a convenience. Two of this build's assets are PNG, and
   * a PNG is full of bytes that are not valid UTF-8: sending one down the
   * string arm replaces each of them with U+FFFD and reports a length for
   * bytes that never left. The two arms are measured separately for that
   * reason.
   */
  readonly body: string | Uint8Array | null;
}
```

**3b.** Add a shared length helper beside `refuse` in the same file:

```ts
/**
 * The length of a body in bytes, for either arm.
 *
 * `String.prototype.length` counts UTF-16 code units and is the wrong number
 * for any non-ASCII character; `Buffer.byteLength` counts what goes on the
 * wire. A `Uint8Array` is already bytes.
 */
export function bodyByteLength(body: string | Uint8Array): number {
  return typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
}
```

Use it in `refuse` and in the `200` branch in place of the two existing
`Buffer.byteLength(body, 'utf8')` calls.

**3c.** In `src/dashboard/http-server.ts`, replace `write`:

```ts
/** Writes a decided response. Node omits the body of a `304` on its own. */
function write(response: ServerResponse, decided: DashboardHttpResponse): void {
  response.writeHead(decided.status, { ...decided.headers });
  if (decided.body === null) {
    response.end();
    return;
  }
  if (typeof decided.body === 'string') {
    response.end(decided.body, 'utf8');
    return;
  }
  // No encoding argument. Passing one here would ask Node to interpret bytes
  // that are already bytes, which is exactly how a PNG becomes a page of
  // U+FFFD.
  response.end(decided.body);
}
```

**3d.** Nothing — and deliberately so. There is no socket-level test in this
task and no `rawBytes` helper, for the reason in the scope correction above: no
production path can produce a bytes body until Task 3. The byte path is pinned
in Task 3 (contract) and Task 11 (dist gate, real icon, built CLI).

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run tests/dashboard-05-http-contract.test.ts tests/dashboard-06-http-server.test.ts tests/dashboard-08-ui-assets.test.ts`
Expected: PASS — the new cases and every existing one. The neighbours are run
because Step 3 changes `refuse` and the `200` branch, which they cover.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/dashboard/http-contract.ts src/dashboard/http-server.ts tests/dashboard-05-http-contract.test.ts
git commit -m "feat(dashboard): a response may carry bytes, because a PNG is not text"
```

---

## Task 3: The asset route inside the contract

**Files:**
- Modify: `src/dashboard/http-contract.ts`
- Test: `tests/dashboard-08-ui-assets.test.ts` (append)

**Interfaces:**
- Consumes: `DashboardAssetMap` (Task 1), `bodyByteLength` (Task 2).
- Produces: `respondToDashboardRequest(request, allowedHosts, snapshot, assets)` — a **fourth** parameter; `UI_CONTENT_SECURITY_POLICY: string`.

**Decision order, unchanged in shape:** Host → origin-form → `/api/snapshot` → assets → `404`. The API route is decided **before** the asset map is consulted and never passes through it.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-08-ui-assets.test.ts`:

```ts
import {
  DASHBOARD_BIND_HOST,
  respondToDashboardRequest,
  type DashboardRequestFacts,
} from '../src/dashboard/http-contract.js';
import type { PublicSnapshot } from '../src/dashboard/public-view.js';

const ALLOWED = ['127.0.0.1:47113'];

function fakeAssets(): DashboardAssetMap {
  return new Map(
    UI_ASSET_MANIFEST.map((e) => [
      e.route,
      { bytes: Uint8Array.from([0x00, 0xff, 0x41]), contentType: e.contentType },
    ]),
  );
}

function snapshotStub(): PublicSnapshot {
  return {
    observedAt: '2026-09-16T00:00:00.000Z',
    revision: 'abc123',
    registry: { reading: 'UNUSABLE', code: 'X' },
    repositories: [],
    needsOperator: [],
    notes: [],
  } as unknown as PublicSnapshot;
}

function ask(overrides: Partial<DashboardRequestFacts> = {}) {
  return respondToDashboardRequest(
    {
      method: 'GET',
      target: '/',
      hostHeaders: ['127.0.0.1:47113'],
      ifNoneMatch: null,
      ...overrides,
    },
    ALLOWED,
    snapshotStub,
    fakeAssets(),
  );
}

const header = (r: { headers: Readonly<Record<string, string>> }, name: string): string | undefined =>
  Object.entries(r.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

describe('the asset routes answer, and only the ones in the manifest', () => {
  it('serves every manifest route with its own content type and byte length', () => {
    for (const entry of UI_ASSET_MANIFEST) {
      const answer = ask({ target: entry.route });
      expect(answer.status, entry.route).toBe(200);
      expect(header(answer, 'Content-Type'), entry.route).toBe(entry.contentType);
      expect(header(answer, 'Content-Length'), entry.route).toBe('3');
      expect(answer.body, entry.route).toBeInstanceOf(Uint8Array);
    }
  });

  it('answers the API route before the asset map is consulted', () => {
    const answer = ask({ target: '/api/snapshot' });
    expect(answer.status).toBe(200);
    expect(header(answer, 'Content-Type')).toBe('application/json; charset=utf-8');
    // The API keeps the slice-3 policy. It is not a document and grants nothing.
    expect(header(answer, 'Content-Security-Policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it('gives a successful asset the UI policy, with no unsafe-inline anywhere', () => {
    const policy = header(ask({ target: '/app.js' }), 'Content-Security-Policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("img-src 'self'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("manifest-src 'self'");
    expect(policy).toContain("worker-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('keeps no-store and nosniff on an asset, which is where they matter most', () => {
    const answer = ask({ target: '/icon-192.png' });
    expect(header(answer, 'Cache-Control')).toBe('no-store');
    expect(header(answer, 'X-Content-Type-Options')).toBe('nosniff');
    expect(header(answer, 'Access-Control-Allow-Origin')).toBeUndefined();
  });

  it('gives every REFUSAL the slice-3 policy, whatever path it was asked for', () => {
    // The UI policy attaches to a served asset, never to a refusal. This is the
    // observable half of "the API contract did not move".
    for (const target of ['/nope', '/app.css/', '/API/SNAPSHOT']) {
      const answer = ask({ target });
      expect(answer.status, target).toBe(404);
      expect(header(answer, 'Content-Security-Policy'), target).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(answer.body, target).toContain('NOT_FOUND');
    }
  });

  it('offers assets by GET only, and says so', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      const answer = ask({ target: '/app.css', method });
      expect(answer.status, method).toBe(405);
      expect(header(answer, 'Allow'), method).toBe('GET');
    }
  });
});

describe('traversal has nowhere to go, and the refusal says which kind', () => {
  it('refuses a well-formed path that is not a key with 404', () => {
    for (const target of ['/api/../app.js', '//app.css', '/%2e%2e/app.css', '/ui/app.css']) {
      expect(ask({ target }).status, target).toBe(404);
    }
  });

  it('refuses anything that is not origin-form with 400, before routing', () => {
    for (const target of ['../app.css', '..%5capp.css', 'http://elsewhere/app.css', '*']) {
      expect(ask({ target }).status, target).toBe(400);
    }
  });

  it('refuses an unlisted Host before it reveals that any asset exists', () => {
    const answer = ask({ target: '/app.css', hostHeaders: ['evil.example'] });
    expect(answer.status).toBe(421);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/dashboard-08-ui-assets.test.ts`
Expected: FAIL — `respondToDashboardRequest` takes three arguments.

- [ ] **Step 3: Write the implementation**

In `src/dashboard/http-contract.ts`:

**3a.** Add the UI policy beside `CONSTANT_HEADERS`:

```ts
/**
 * The policy a SERVED asset carries. Refusals keep `CONSTANT_HEADERS`.
 *
 * Still `default-src 'none'`: six `'self'` grants for the six things a
 * same-origin application actually loads, and three further lock-downs. There
 * is deliberately no `'unsafe-inline'`, which is not a detail — it is what
 * makes `index.html` carry no inline script, no `<style>` and no `style=`
 * attribute, and it is the difference between a policy and a decoration.
 *
 * `worker-src` is what governs registering the service worker; `manifest-src`
 * governs `<link rel="manifest">`; `connect-src` governs the `fetch` to
 * `/api/snapshot`. Each is present because something in this build needs it,
 * and nothing else is.
 */
export const UI_CONTENT_SECURITY_POLICY =
  "default-src 'none'; " +
  "script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
```

**3b.** Extend the signature and add the asset step. Replace the method/observation
part of `respondToDashboardRequest` with:

```ts
export function respondToDashboardRequest(
  request: DashboardRequestFacts,
  allowedHosts: readonly string[],
  snapshot: () => PublicSnapshot,
  assets: DashboardAssetMap = new Map(),
): DashboardHttpResponse {
  // ── 1. the Host ──────────────────────────────────────────────────────────
  if (request.hostHeaders.length !== 1) return refuse(400, 'BAD_REQUEST');
  const host = normaliseHost(request.hostHeaders[0] ?? '');
  if (host === null) return refuse(400, 'BAD_REQUEST');
  if (!allowedHosts.includes(host)) return refuse(421, 'HOST_NOT_ALLOWED');

  // ── 2. the route ─────────────────────────────────────────────────────────
  const path = pathOf(request.target);
  if (path === null) return refuse(400, 'BAD_REQUEST');

  // The API is decided BEFORE the asset map is consulted and never passes
  // through it. That ordering is the reason an asset table could never shadow
  // the one route this service existed for before it had a UI.
  if (path !== SNAPSHOT_PATH) {
    const asset = assets.get(path);
    if (asset === undefined) return refuse(404, 'NOT_FOUND');
    if (request.method !== SNAPSHOT_METHOD) {
      return refuse(405, 'METHOD_NOT_ALLOWED', { Allow: SNAPSHOT_METHOD });
    }
    return Object.freeze({
      status: 200,
      headers: Object.freeze({
        ...CONSTANT_HEADERS,
        'Content-Security-Policy': UI_CONTENT_SECURITY_POLICY,
        'Content-Type': asset.contentType,
        'Content-Length': String(bodyByteLength(asset.bytes)),
      }),
      body: asset.bytes,
    });
  }

  // ── 3. the method ────────────────────────────────────────────────────────
  if (request.method !== SNAPSHOT_METHOD) {
    return refuse(405, 'METHOD_NOT_ALLOWED', { Allow: SNAPSHOT_METHOD });
  }

  // ── 4. the observation ───────────────────────────────────────────────────
  // (unchanged from slice 3 — 304 branch, then the 200)
```

Add the import at the top of the file:

```ts
import type { DashboardAssetMap } from './ui-assets.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run tests/dashboard-08-ui-assets.test.ts tests/dashboard-05-http-contract.test.ts`
Expected: `dashboard-08` PASS. `dashboard-05` **FAIL** on one case — it asserts `/` is `404`. That is expected and is rewritten in Task 9. Do not fix it here.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/dashboard/http-contract.ts tests/dashboard-08-ui-assets.test.ts
git commit -m "feat(dashboard): an asset route that is a map lookup, never a path"
```

---

## Task 4: The server and the serve command load assets before binding

**Files:**
- Modify: `src/dashboard/http-server.ts`
- Modify: `src/cli/dashboard-command.ts`
- Test: `tests/dashboard-08-ui-assets.test.ts` (append), `tests/dashboard-07-serve-command.test.ts` (append)

**Interfaces:**
- Consumes: `loadUiAssets`, `uiAssetRoot` (Task 1); the four-argument contract (Task 3).
- Produces: `DashboardServerConfig.assets: DashboardAssetMap`; the outcome `UI_ASSETS_UNUSABLE`.

> **Pre-flight ruling (F-1).** `assets` is a **required** member, not an optional
> one with an empty default. An optional member would let a production path start
> a server that silently serves no UI — the same partial-serve failure §4.5
> refuses — whereas a required one turns every construction site into a compile
> error, which is the cheaper teacher.
>
> That means this task must **also update every existing construction of
> `DashboardServerConfig`**, which the plan's file list did not name. Find them
> before you start:
>
> ```bash
> grep -rn "bindHost:" tests/ src/ --include=*.ts --include=*.mjs | grep -v node_modules
> ```
>
> At minimum this includes `serving()` in `tests/dashboard-06-http-server.test.ts`.
> Each such site that has no UI to serve passes `new Map()` explicitly. Do not
> give them a shared helper that hides the argument — the explicit empty map at
> each site is the readable statement that this server serves no assets.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-08-ui-assets.test.ts`:

```ts
import { startDashboardServer } from '../src/dashboard/http-server.js';
import { allowedHostsFor } from '../src/dashboard/http-contract.js';

describe('a server carries its assets, and a missing one opens no socket', () => {
  it('serves an asset over a real socket with the right bytes', async () => {
    const outcome = await startDashboardServer(
      {
        bindHost: DASHBOARD_BIND_HOST,
        port: 0,
        allowedHosts: [],
        assets: fakeAssets(),
      },
      { snapshot: snapshotStub },
    );
    expect(outcome.outcome).toBe('LISTENING');
    if (outcome.outcome !== 'LISTENING') return;
    try {
      const port = outcome.boundPort;
      // Rebuilt for the port actually bound, so the Host is the allowed one.
      expect(allowedHostsFor(DASHBOARD_BIND_HOST, port, [])).toContain(`127.0.0.1:${port}`);
    } finally {
      await outcome.stop();
    }
  });
});
```

Append to `tests/dashboard-07-serve-command.test.ts`:

```ts
  it('refuses to serve when a UI asset is missing, and binds nothing', async () => {
    // The positive control is the `start` seam: if it is ever called, the
    // refusal did not happen before the socket, which is the whole claim.
    let started = 0;
    const result = await runServe({
      argv: ['dashboard', 'serve'],
      start: async () => {
        started += 1;
        return { outcome: 'BIND_FAILED', errnoCode: 'NOTREACHED' };
      },
      loadAssets: () => ({ outcome: 'MISSING', route: '/icon-512.png' }),
    });

    expect(started).toBe(0);
    expect(result.exitCode).toBe(DASHBOARD_SERVE_EXIT.UI_ASSETS_UNUSABLE);
    expect(result.stderr).toContain('/icon-512.png');
    // A refusal reaches an operator, so it names the route and not this machine.
    expect(result.stderr).not.toMatch(/[A-Za-z]:\\/);
  });
```

> **Implementer note:** `runServe` is this file's existing harness. Read it
> before writing the case and match its shape; add a `loadAssets` seam to it
> alongside the existing `start` seam.

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/dashboard-07-serve-command.test.ts -t "UI asset is missing"`
Expected: FAIL — `DASHBOARD_SERVE_EXIT.UI_ASSETS_UNUSABLE` is undefined.

- [ ] **Step 3: Write the implementation**

**3a.** `src/dashboard/http-server.ts` — extend the config and **rewrite its
doc comment**, which currently says "Three values":

```ts
/**
 * Neutral server configuration, and the complete list of it.
 *
 * Four values now, and every one of them is a property of an HTTP server
 * rather than of any particular way of reaching one. There is no public URL
 * here, no base path, no origin, no scheme, no tunnel, no proxy and no vendor.
 *
 * `assets` is the fourth, and it is data rather than a seam on purpose: it is
 * what this server serves, decided by the manifest and read before the socket
 * opened, not a dependency a caller may substitute for one with more authority.
 *
 * `allowedHosts` … (unchanged)
 */
export interface DashboardServerConfig {
  readonly bindHost: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly assets: DashboardAssetMap;
}
```

Pass it through in `createDashboardServer`:

```ts
          respondToDashboardRequest(
            { /* …unchanged facts… */ },
            config.allowedHosts,
            snapshot,
            config.assets,
          ),
```

Import the type: `import type { DashboardAssetMap } from './ui-assets.js';`

**3b.** `src/cli/dashboard-command.ts`:

Add the outcome to the array at line 69 and the exit map at line 100:

```ts
export const DASHBOARD_SERVE_OUTCOMES = [
  'SERVED',
  'PORT_UNUSABLE',
  'ALLOW_HOST_UNUSABLE',
  'UI_ASSETS_UNUSABLE',
  'BIND_REFUSED',
  'BIND_NOT_LOOPBACK',
] as const;
```

```ts
    UI_ASSETS_UNUSABLE: EXIT_RUN_UNEXPECTED,
```

Document the grade beside the others:

```ts
 * `UI_ASSETS_UNUSABLE` is `EXIT_RUN_UNEXPECTED` and deliberately not `4`. A
 * refused invocation is one the operator could have typed differently; this one
 * cannot be. Every asset is fixed by the manifest and shipped by the build, so
 * a missing one means the artefact is defective — a different port, a different
 * moment and a different machine all give the same answer.
```

Add a `loadAssets` seam and refuse **before** `start`:

```ts
        const loaded = (seams.loadAssets ?? (() => loadUiAssets(uiAssetRoot(import.meta.url))))();
        if (loaded.outcome === 'MISSING') {
          // The route, never the path. This sentence reaches an operator.
          writeError(
            `agent-loop: refused to serve. The shipped user interface is incomplete — ` +
              `${loaded.route} is missing or unreadable. This build's assets are fixed, so ` +
              `nothing was served and no socket was opened.\n`,
          );
          process.exitCode = DASHBOARD_SERVE_EXIT.UI_ASSETS_UNUSABLE;
          return;
        }

        const outcome = await start(
          {
            bindHost: DASHBOARD_BIND_HOST,
            port,
            allowedHosts: allowedHostsFor(DASHBOARD_BIND_HOST, port, options.allowHost),
            assets: loaded.assets,
          },
          {},
        );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node_modules/.bin/vitest run tests/dashboard-07-serve-command.test.ts tests/dashboard-08-ui-assets.test.ts`
Expected: PASS, except the pre-existing help-text pin (rewritten in Task 9).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/dashboard/http-server.ts src/cli/dashboard-command.ts tests/dashboard-07-serve-command.test.ts tests/dashboard-08-ui-assets.test.ts
git commit -m "feat(dashboard): every asset loads before the socket, or none does"
```

---

## Task 5: The authored shell — HTML, CSS, manifest, icons

**Files:**
- Create: `src/dashboard/ui/index.html`, `app.css`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`
- Create (one-off, **not** committed to the build chain): `scripts/one-off/make-icons.mjs`
- Test: `tests/dashboard-08-ui-assets.test.ts` (append a source sweep)

**Interfaces:**
- Consumes: nothing.
- Produces: `#app` as the render root; the element ids `#status-word`, `#status-age`, `#content`.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-08-ui-assets.test.ts`:

```ts
import { readFileSync as readSource } from 'node:fs';
import { join as joinPath } from 'node:path';

const UI_DIR = joinPath(process.cwd(), 'src', 'dashboard', 'ui');
const read = (name: string): string => readSource(joinPath(UI_DIR, name), 'utf8');

describe('the authored shell obeys the policy that serves it', () => {
  it('has no inline script, no style element and no style attribute', () => {
    // Not a nicety. The served policy carries no 'unsafe-inline', so any of
    // these would be silently dropped by the browser and the page would be
    // broken in a way no server-side test can see.
    const html = read('index.html');
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it('references everything root-relative, and nothing off this origin', () => {
    const html = read('index.html');
    expect(html).toContain('href="/app.css"');
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('href="/manifest.webmanifest"');
    expect(html).not.toMatch(/https?:\/\//);
    // crossorigin on the manifest link changes credential behaviour for no
    // reason here, and is a common copy-paste that breaks installability.
    expect(html).not.toMatch(/rel="manifest"[^>]*crossorigin/i);
  });

  it('declares a manifest that can actually install', () => {
    const manifest = JSON.parse(read('manifest.webmanifest')) as Record<string, unknown>;
    expect(manifest['name']).toBe('AO Manager');
    expect(manifest['short_name']).toBe('AO');
    expect(manifest['start_url']).toBe('/');
    expect(manifest['scope']).toBe('/');
    expect(manifest['display']).toBe('standalone');
    const icons = manifest['icons'] as { src: string; sizes: string; type: string }[];
    expect(icons.map((i) => i.sizes).sort()).toEqual(['192x192', '512x512']);
    for (const icon of icons) {
      expect(icon.type).toBe('image/png');
      expect(icon.src.startsWith('/')).toBe(true);
    }
  });

  it('ships real PNG bytes, not a placeholder', () => {
    for (const name of ['icon-192.png', 'icon-512.png']) {
      const bytes = readSource(joinPath(UI_DIR, name));
      expect(Buffer.compare(bytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), name).toBe(0);
      expect(bytes.byteLength, name).toBeGreaterThan(100);
    }
  });

  it('names no vendor and no hostname this build cannot know', () => {
    for (const name of ['index.html', 'app.css', 'manifest.webmanifest']) {
      const text = read(name).toLowerCase();
      for (const forbidden of ['tailscale', 'ts.net', 'localhost', '0.0.0.0', '100.']) {
        expect(text, `${name} names ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/dashboard-08-ui-assets.test.ts -t "authored shell"`
Expected: FAIL — `ENOENT` on `index.html`.

- [ ] **Step 3: Write the implementation**

**3a.** `src/dashboard/ui/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark light" />
    <title>AO Manager</title>
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" href="/icon-192.png" type="image/png" />
    <link rel="apple-touch-icon" href="/icon-192.png" />
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <header id="bar">
      <span id="title">AO MANAGER</span>
      <span id="status-word" data-state="INIT">CONNECTING</span>
    </header>
    <p id="status-age">Waiting for the first response.</p>
    <main id="content"></main>
    <script src="/app.js" defer></script>
  </body>
</html>
```

**3b.** `src/dashboard/ui/app.css` — mobile-first at 390 px, dark-first, and
**every state carries a word as well as a colour** (the colour is decoration on
top of `#status-word`'s text). Keep it to one screenful of rules: a `:root`
token block, `#bar`, `#status-word[data-state="LIVE"|"STALE"|"OFFLINE"|"REFUSED"]`,
`.card`, `.needs-you`, `.project`, `.badge`, `.note`, and a
`@media (prefers-color-scheme: light)` override of the tokens only.

**3c.** `src/dashboard/ui/manifest.webmanifest`:

```json
{
  "name": "AO Manager",
  "short_name": "AO",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#101214",
  "theme_color": "#101214",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}
```

**3d.** The icons. Write `scripts/one-off/make-icons.mjs` that emits two flat
PNGs using only `node:zlib` — a solid background with a lighter inset square —
run it once, commit the two `.png` files, and leave the generator out of the
build chain entirely. The build copies artwork; it never re-creates it.

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run tests/dashboard-08-ui-assets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/ui scripts/one-off/make-icons.mjs tests/dashboard-08-ui-assets.test.ts
git commit -m "feat(dashboard): the shell, authored to the policy that serves it"
```

---

## Task 6: `app.js` — the view model, as pure functions

**Files:**
- Create: `src/dashboard/ui/app.js` (the pure half)
- Test: `tests/dashboard-09-ui-logic.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces, on a `globalThis.AO` namespace so `node:vm` can reach them:
  - `classifyFreshness(lastGoodAtMs, nowMs) -> 'LIVE'|'STALE'|'OFFLINE'`
  - `leaseWording(lease) -> string`
  - `completionLine(repository) -> string`
  - `likelyActiveTasks(repository) -> PublicTask[]`
  - `repositoryName(repository) -> string`
  - `recordedAge(isoInstant, observedAtIso) -> string`
  - `escapeHtml(value) -> string`
  - `renderLanding(snapshot, freshness) -> string` (HTML)
  - `renderDetail(snapshot, repositoryKey) -> string` (HTML)
  - `renderRoute(hash, snapshot, freshness) -> string` — dispatches on `#/repo/<key>`

**Why a string:** there is no DOM in this repository's test runner. Rendering to
an HTML **string** makes the whole view testable in Node with zero dependencies,
and the DOM glue in Task 7 is then a single `innerHTML` assignment.

**Why `escapeHtml` is not optional:** the snapshot carries operator-authored
text (`needsOperator[].text`, task ids, refusal codes). `innerHTML` with
unescaped text is an injection. CSP without `'unsafe-inline'` blocks an injected
`<script>` and an inline `onerror`, but defence in depth is the rule here and a
broken layout is reason enough on its own.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-09-ui-logic.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `app.js` is evaluated as TEXT in a sandbox, against hand-written fakes.
 *
 * There is no DOM in this repository and no dependency is added for one. The
 * sandbox supplies exactly what the pure half touches — nothing — plus the
 * globals the glue half registers against, so loading the file has no effect
 * beyond defining `AO`. This measures the SHIPPED bytes, which is the same
 * instinct as the dist-artefact gates.
 */
let AO: Record<string, (...args: never[]) => unknown>;

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/dashboard-09-ui-logic.test.ts`
Expected: FAIL — `ENOENT` on `app.js`.

- [ ] **Step 3: Write the implementation**

Create `src/dashboard/ui/app.js`. Open with the namespace and the pure
functions; the glue comes in Task 7. Structure:

```js
/**
 * DASHBOARD-001 slice 4 — the AO Manager page.
 *
 * Two halves, deliberately separated. Everything above `install()` is PURE: a
 * value in, a string out, no DOM and no network. That is not an abstraction for
 * its own sake — this repository has seven dependencies and no DOM in its test
 * runner, so a view model that renders to a STRING is the whole difference
 * between a UI that is pinned and one that is hoped for.
 *
 * The page never asserts anything the snapshot does not carry. Three rules do
 * most of that work, and each has a test that fails without it:
 *  - a lease proves activity only when the owner is known to answer;
 *  - the task AO is on is inferred, and says so;
 *  - a reading that failed is never rendered as good news.
 */
(function (global) {
  'use strict';

  var LIVE_MS = 20000;
  var STALE_MS = 60000;

  function classifyFreshness(lastGoodAtMs, nowMs) {
    // `null` is "no contact in this session" — the cold offline launch. It is
    // OFFLINE and never LIVE: a page that has never reached the Manager must
    // not open claiming otherwise.
    if (lastGoodAtMs === null || lastGoodAtMs === undefined) return 'OFFLINE';
    var age = nowMs - lastGoodAtMs;
    if (age < LIVE_MS) return 'LIVE';
    if (age <= STALE_MS) return 'STALE';
    return 'OFFLINE';
  }

  function escapeHtml(value) { /* & < > " ' → entities */ }

  function leaseWording(lease) { /* the total table from spec §3.2 */ }

  function repositoryName(repository) {
    // An UNUSABLE profile has no repositoryId. The key is a digest and is never
    // silently substituted for a name, because a repository AO cannot identify
    // is itself operator-relevant.
  }

  function completionLine(repository) { /* spec §3.3, including both degenerate cases */ }

  function likelyActiveTasks(repository) {
    // REGULAR only. See the test for why BLOCKING is excluded.
  }

  function recordedAge(isoInstant, observedAtIso) { /* against observedAt, clamped at 0 */ }

  function renderLanding(snapshot, freshness) { /* returns HTML; snapshot-level notes first */ }

  function renderDetail(snapshot, repositoryKey) {
    // Everything the landing screen leaves out: the full lease reading, the
    // runtime record, verification evidence, delivery, and THIS repository's
    // notes only. Carries `data-back`, because a standalone install has no
    // browser Back button.
  }

  function renderRoute(hash, snapshot, freshness) {
    // `#/repo/<key>` or the landing screen. Read on LOAD as well as on
    // `hashchange`, so a relaunch at a deep link renders the detail view.
  }

  global.AO = {
    classifyFreshness: classifyFreshness,
    escapeHtml: escapeHtml,
    leaseWording: leaseWording,
    repositoryName: repositoryName,
    completionLine: completionLine,
    likelyActiveTasks: likelyActiveTasks,
    recordedAge: recordedAge,
    renderLanding: renderLanding,
    renderDetail: renderDetail,
    renderRoute: renderRoute,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
```

Fill each body to satisfy the tests exactly. Do not add a function the tests do
not name.

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run tests/dashboard-09-ui-logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/ui/app.js tests/dashboard-09-ui-logic.test.ts
git commit -m "feat(dashboard): a view model that renders to a string, so it can be pinned"
```

---

## Task 7: `app.js` — polling, freshness and the DOM glue

**Files:**
- Modify: `src/dashboard/ui/app.js` (append the glue)
- Test: `tests/dashboard-09-ui-logic.test.ts` (append)

**Interfaces:**
- Consumes: the `AO` namespace (Task 6).
- Produces: `AO.createPoller({ fetch, now, onState })` with `.tick()` — the whole
  network state machine, injectable and therefore testable.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-09-ui-logic.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/dashboard-09-ui-logic.test.ts -t "poller"`
Expected: FAIL — `AO.createPoller` is not a function.

- [ ] **Step 3: Write the implementation**

Append to `src/dashboard/ui/app.js`, before the `global.AO = …` assignment:

```js
  /**
   * The network half, with its clock and its transport injected.
   *
   * Injected because every property worth pinning here is about TIME and about
   * a status code: that a 304 resets the freshness clock, that the conditional
   * header is the ETag verbatim, that a refusal is not staleness, and that the
   * last good snapshot survives a failure. None of those need a browser, and a
   * test that needed one would not exist in this repository.
   */
  function createPoller(options) {
    var fetchImpl = options.fetch;
    var now = options.now;
    var onState = options.onState;

    var lastGoodAtMs = null;
    var heldTag = null;      // the ETag field value, verbatim, quotes included
    var heldSnapshot = null; // page memory only — never persisted

    function publish(extra) {
      onState({
        freshness: extra && extra.freshness ? extra.freshness : classifyFreshness(lastGoodAtMs, now()),
        snapshot: heldSnapshot,
        lastGoodAtMs: lastGoodAtMs,
        refusal: extra ? extra.refusal || null : null,
      });
    }

    function tick() {
      var headers = {};
      // Verbatim. `W/"r1"`, never `r1`: the contract compares opaque strings
      // including the quotes, so the bare revision matches nothing, forever.
      if (heldTag !== null) headers['If-None-Match'] = heldTag;

      return fetchImpl('/api/snapshot', { headers: headers, cache: 'no-store' }).then(
        function (response) {
          if (response.status === 304) {
            // A 304 PROVES the Manager answered. Not counting it would drift an
            // idle, healthy machine into OFFLINE while it answered every poll.
            lastGoodAtMs = now();
            publish();
            return undefined;
          }
          if (response.status === 200) {
            var tag = response.headers.get('ETag');
            return response.json().then(function (body) {
              heldSnapshot = body;
              heldTag = tag;
              lastGoodAtMs = now();
              publish();
            });
          }
          // Answered, and declined. A configuration fault, not a slow network.
          publish({ freshness: 'REFUSED', refusal: String(response.status) });
          return undefined;
        },
        function () {
          // Never reached the Manager. The held snapshot stays on screen and
          // the clock is NOT reset, so the renderer marks it stale or offline.
          publish();
          return undefined;
        },
      );
    }

    return { tick: tick };
  }
```

Then the DOM glue, guarded and last in the file:

```js
  function install() {
    var content = document.getElementById('content');
    var word = document.getElementById('status-word');
    var age = document.getElementById('status-age');
    if (content === null || word === null || age === null) return;

    var poller = createPoller({
      fetch: function (u, i) { return fetch(u, i); },
      now: function () { return Date.now(); },
      onState: function (state) {
        word.textContent = state.freshness;     // a WORD, never only a colour
        word.setAttribute('data-state', state.freshness);
        age.textContent = describeContact(state);
        content.innerHTML = state.snapshot === null
          ? renderNoData()
          : renderRoute(location.hash, state.snapshot, state.freshness);
      },
    });

    var timer = null;
    function start() { if (timer === null) timer = setInterval(function () { void poller.tick(); }, 10000); }
    function stop() { if (timer !== null) { clearInterval(timer); timer = null; } }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { void poller.tick(); start(); } else { stop(); }
    });
    // On load as well as on change, so a relaunch at #/repo/<key> renders the
    // detail view rather than the landing screen.
    window.addEventListener('hashchange', function () { void poller.tick(); });

    void poller.tick();
    start();

    // Absent on an insecure origin. Unguarded, this throws and the page is blank.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(function () {
        /* no worker: the UI is network-only, which is reduced and not broken */
      });
    }
  }

  if (typeof document !== 'undefined' && document.getElementById) install();
```

Add `createPoller` to the exported namespace.

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run tests/dashboard-09-ui-logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/ui/app.js tests/dashboard-09-ui-logic.test.ts
git commit -m "feat(dashboard): a 304 is a successful refresh, and a refusal is not staleness"
```

---

## Task 8: The service worker

**Files:**
- Create: `src/dashboard/ui/sw.js`
- Test: `tests/dashboard-10-service-worker.test.ts`

**Interfaces:**
- Consumes: the placeholder tokens `__AO_SHELL_DIGEST__` and `__AO_SHELL_ROUTES__` (substituted in Task 9).
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard-10-service-worker.test.ts`. It evaluates `sw.js` in a
`node:vm` sandbox with fake `caches`, captures the three handlers, and asserts:

1. `install` opens `ao-shell-<digest>` and adds **every** shell route;
2. an `addAll` that rejects **fails the install**, and `skipWaiting` is not called;
3. `activate` deletes every `ao-shell-*` cache that is not the current digest, and deletes nothing else;
4. `activate` calls `clients.claim()`;
5. a `fetch` for each of the six shell routes is handled from the cache;
6. a `fetch` for `/api/snapshot` is **not** handled — `respondWith` is never called;
7. a `fetch` for `/anything-else` is not handled;
8. the source contains no `cache.put` of `/api/snapshot`, no `localStorage`, no `indexedDB`.

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { beforeEach, describe, expect, it } from 'vitest';

import { SHELL_ROUTES } from '../src/dashboard/ui-assets.js';

const SOURCE = readFileSync(join(process.cwd(), 'src', 'dashboard', 'ui', 'sw.js'), 'utf8');

interface Harness {
  handlers: Record<string, (event: Record<string, unknown>) => void>;
  caches: { names: string[]; opened: Record<string, string[]>; deleted: string[] };
  claimed: boolean;
  skipWaiting: boolean;
}

/** Loads the worker's REAL bytes against fakes, with the tokens substituted. */
function load(options: { addAllFails?: boolean; existingCaches?: string[] } = {}): Harness {
  const digest = 'a'.repeat(64);
  const source = SOURCE.replace(/__AO_SHELL_DIGEST__/g, digest).replace(
    /'__AO_SHELL_ROUTES__'/g,
    JSON.stringify(SHELL_ROUTES),
  );

  const h: Harness = {
    handlers: {},
    caches: { names: options.existingCaches ?? [], opened: {}, deleted: [] },
    claimed: false,
    skipWaiting: false,
  };

  const sandbox: Record<string, unknown> = {
    caches: {
      keys: () => Promise.resolve(h.caches.names),
      delete: (name: string) => { h.caches.deleted.push(name); return Promise.resolve(true); },
      open: (name: string) =>
        Promise.resolve({
          addAll: (routes: string[]) => {
            if (options.addAllFails === true) return Promise.reject(new Error('offline'));
            h.caches.opened[name] = routes;
            return Promise.resolve(undefined);
          },
          match: (request: unknown) => Promise.resolve({ matched: request }),
        }),
      match: (request: unknown) => Promise.resolve({ matched: request }),
    },
    self: {
      addEventListener: (name: string, fn: (e: Record<string, unknown>) => void) => (h.handlers[name] = fn),
      skipWaiting: () => { h.skipWaiting = true; return Promise.resolve(undefined); },
      clients: { claim: () => { h.claimed = true; return Promise.resolve(undefined); } },
      location: { origin: 'https://ao.example' },
    },
    console,
  };
  sandbox['globalThis'] = sandbox;
  (sandbox['self'] as Record<string, unknown>)['caches'] = sandbox['caches'];
  runInContext(source, createContext(sandbox), { filename: 'sw.js' });
  return h;
}

/** Runs an install/activate handler and awaits whatever it passed to waitUntil. */
async function run(h: Harness, name: string): Promise<void> {
  let waited: Promise<unknown> = Promise.resolve();
  h.handlers[name]?.({ waitUntil: (p: Promise<unknown>) => (waited = p) });
  await waited;
}

/** Runs the fetch handler for one URL and reports whether it was handled. */
function fetched(h: Harness, url: string): boolean {
  let handled = false;
  h.handlers['fetch']?.({
    request: { url: `https://ao.example${url}`, method: 'GET', mode: 'navigate' },
    respondWith: () => { handled = true; },
  });
  return handled;
}

describe('the shell cache is populated completely or not at all', () => {
  it('adds every shell route under the digest-named cache', async () => {
    const h = load();
    await run(h, 'install');
    const name = `ao-shell-${'a'.repeat(64)}`;
    expect(Object.keys(h.caches.opened)).toEqual([name]);
    expect([...(h.caches.opened[name] ?? [])].sort()).toEqual([...SHELL_ROUTES].sort());
    expect(h.skipWaiting).toBe(true);
  });

  it('fails the install when one asset cannot be cached, and does not skip waiting', async () => {
    // A half-populated shell cache is the offline equivalent of serving six of
    // seven assets: the app opens and is broken.
    const h = load({ addAllFails: true });
    await expect(run(h, 'install')).rejects.toThrow();
    expect(h.skipWaiting).toBe(false);
  });
});

describe('activation removes every older shell, and nothing else', () => {
  it('deletes other ao-shell caches and claims clients', async () => {
    const current = `ao-shell-${'a'.repeat(64)}`;
    const h = load({ existingCaches: [current, `ao-shell-${'b'.repeat(64)}`, 'unrelated-cache'] });
    await run(h, 'activate');
    expect(h.caches.deleted).toEqual([`ao-shell-${'b'.repeat(64)}`]);
    expect(h.caches.deleted).not.toContain(current);
    expect(h.caches.deleted).not.toContain('unrelated-cache');
    expect(h.claimed).toBe(true);
  });
});

describe('the fetch handler is an allow-list, not a pattern', () => {
  it('handles exactly the six shell routes', () => {
    const h = load();
    for (const route of SHELL_ROUTES) expect(fetched(h, route), route).toBe(true);
  });

  it('never handles /api/snapshot', () => {
    // The single most important assertion in this file. A cached snapshot shown
    // offline looks live, which is the one thing this whole slice refuses.
    const h = load();
    expect(fetched(h, '/api/snapshot')).toBe(false);
    expect(fetched(h, '/api/snapshot?poll=1')).toBe(false);
  });

  it('never handles anything outside the list', () => {
    const h = load();
    for (const url of ['/sw.js', '/anything', '/app.css.map', '/']) {
      if (SHELL_ROUTES.includes(url)) continue;
      expect(fetched(h, url), url).toBe(false);
    }
  });
});

describe('the worker persists no orchestration state', () => {
  it('mentions no storage API and no snapshot caching', () => {
    expect(SOURCE).not.toContain('localStorage');
    expect(SOURCE).not.toContain('sessionStorage');
    expect(SOURCE).not.toContain('indexedDB');
    expect(SOURCE).not.toMatch(/put\s*\(/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/dashboard-10-service-worker.test.ts`
Expected: FAIL — `ENOENT` on `sw.js`.

- [ ] **Step 3: Write the implementation**

Create `src/dashboard/ui/sw.js`, with both placeholder tokens present verbatim:

```js
/**
 * DASHBOARD-001 slice 4 — the shell cache, and nothing else.
 *
 * ── Why there is a fetch handler at all ────────────────────────────────────
 *
 * An earlier design pre-cached the shell and registered NO fetch handler. That
 * does not work, and the way it fails is quiet: a service worker's cache is
 * consulted only by code that consults it, so with no handler every request
 * goes to the network exactly as if the worker did not exist, the cache is
 * never read, and the application does not open offline at all.
 *
 * ── Why the handler is a list ──────────────────────────────────────────────
 *
 * The tempting shape is "if it is same-origin, serve it from the cache". That
 * shape caches `/api/snapshot`, and a cached snapshot shown offline LOOKS LIVE
 * — the single thing this slice exists to prevent. So the handler answers six
 * literal paths, bypasses the API explicitly so the intent is readable, and
 * calls `respondWith` for nothing else.
 *
 * Both constants below are substituted at build time from the one manifest in
 * `ui-assets.ts`. They are never hand-maintained.
 */
'use strict';

var SHELL_ROUTES = '__AO_SHELL_ROUTES__';
var CACHE_NAME = 'ao-shell-__AO_SHELL_DIGEST__';
var API_PATH = '/api/snapshot';

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // No catch. A rejection here FAILS the install on purpose: a
      // half-populated shell is the offline equivalent of serving six of seven
      // assets, and `skipWaiting` below must not run for a broken cache.
      return cache.addAll(SHELL_ROUTES).then(function () {
        return self.skipWaiting();
      });
    }),
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names.map(function (name) {
          // Only this build's own caches, and only the ones that are not current.
          if (name.indexOf('ao-shell-') !== 0 || name === CACHE_NAME) return undefined;
          return caches.delete(name);
        }),
      ).then(function () {
        return self.clients.claim();
      });
    }),
  );
});

self.addEventListener('fetch', function (event) {
  var path;
  try {
    path = new URL(event.request.url).pathname;
  } catch (error) {
    return; // not a URL this worker can reason about: leave it to the network
  }

  // Named explicitly rather than left to fall through, so that a future edit
  // which broadened the match would have to delete a line that says why.
  if (path === API_PATH) return;

  if (SHELL_ROUTES.indexOf(path) === -1) return;

  event.respondWith(
    caches.match(event.request).then(function (hit) {
      return hit || fetch(event.request);
    }),
  );
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node_modules/.bin/vitest run tests/dashboard-10-service-worker.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/ui/sw.js tests/dashboard-10-service-worker.test.ts
git commit -m "feat(dashboard): a worker that caches the shell and never the snapshot"
```

---

## Task 9: The build step, on both output paths

**Files:**
- Create: `scripts/build-ui-assets.mjs`
- Modify: `package.json`, `scripts/deploy-runtime.mjs`
- Test: `tests/dashboard-08-ui-assets.test.ts` (append)

**Interfaces:**
- Consumes: `UI_ASSET_MANIFEST`, `SHELL_ROUTES` (Task 1).
- Produces: `emitUiAssets({ outDir }) -> { digest: string, files: string[] }`.

**This is the task the audit called the single biggest defect.** `dist/` is the
deployed runtime, `npm run deploy` is the only thing that writes it, and it
**re-compiles with `tsc` rather than copying `build/`** — so without this task
the first production deploy ships a `dist/` with no `dashboard/ui/`, and Task 4's
all-or-nothing rule then makes `dashboard serve` unstartable, while every
existing gate stays green.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard-08-ui-assets.test.ts`:

```ts
import { emitUiAssets } from '../scripts/build-ui-assets.mjs';

describe('the emit step produces a complete, substituted artefact', () => {
  it('writes every manifest file into the destination', () => {
    const out = mkdtempSync(join(tmpdir(), 'ao-ui-emit-'));
    roots.push(out);
    emitUiAssets({ outDir: out });
    const loaded = loadUiAssets(out);
    expect(loaded.outcome).toBe('LOADED');
  });

  it('substitutes both tokens, leaving none behind', () => {
    const out = mkdtempSync(join(tmpdir(), 'ao-ui-emit-'));
    roots.push(out);
    const { digest } = emitUiAssets({ outDir: out });
    const sw = readSource(join(out, 'sw.js'), 'utf8');
    // A silent substitution failure is invisible and catastrophic: it ships a
    // worker whose bytes never change, so no update ever runs, forever.
    expect(sw).not.toContain('__AO_SHELL_DIGEST__');
    expect(sw).not.toContain('__AO_SHELL_ROUTES__');
    expect(sw).toContain(`ao-shell-${digest}`);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    for (const route of SHELL_ROUTES) expect(sw).toContain(JSON.stringify(route));
  });

  it('takes the digest over the shell only, so the worker cannot define itself', () => {
    const a = mkdtempSync(join(tmpdir(), 'ao-ui-emit-'));
    const b = mkdtempSync(join(tmpdir(), 'ao-ui-emit-'));
    roots.push(a, b);
    expect(emitUiAssets({ outDir: a }).digest).toBe(emitUiAssets({ outDir: b }).digest);
  });

  it('copies the shell verbatim — only sw.js differs from its source', () => {
    const out = mkdtempSync(join(tmpdir(), 'ao-ui-emit-'));
    roots.push(out);
    emitUiAssets({ outDir: out });
    for (const entry of UI_ASSET_MANIFEST) {
      if (entry.file === 'sw.js') continue;
      const emitted = readSource(join(out, entry.file));
      const authored = readSource(joinPath(UI_DIR, entry.file));
      expect(Buffer.compare(emitted, authored), entry.file).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node_modules/.bin/vitest run tests/dashboard-08-ui-assets.test.ts -t "emit step"`
Expected: FAIL — cannot resolve `../scripts/build-ui-assets.mjs`.

- [ ] **Step 3: Write the implementation**

**3a.** `scripts/build-ui-assets.mjs`, following `build-native-boundary.mjs`'s
shape exactly (an exported function taking a destination, plus a
direct-invocation guard at the bottom):

```js
#!/usr/bin/env node
/**
 * Copies `src/dashboard/ui/` into a build output, substituting the worker's
 * two build-time constants.
 *
 * ── Why this is a function taking a destination ────────────────────────────
 *
 * Because it has TWO callers, and forgetting the second is the defect this
 * script exists to prevent. `npm run build` writes `build/`; `npm run deploy`
 * writes `dist/`, which is the runtime the production supervisor actually
 * executes — and `deploy-runtime.mjs` RE-COMPILES with `tsc` rather than
 * copying `build/`, so it emits no `.html`, `.css`, `.js`, `.png` or
 * `.webmanifest` of its own. A deployed runtime with no assets refuses to start
 * the Manager, and nothing else in this repository would have caught it.
 *
 * `native/ao-launch.exe` is the precedent: it is the other non-`tsc` artefact,
 * and it already has exactly these two call sites.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const SOURCE_DIR = join(repoRoot, 'src', 'dashboard', 'ui');

const DIGEST_TOKEN = '__AO_SHELL_DIGEST__';
const ROUTES_TOKEN = "'__AO_SHELL_ROUTES__'";

/**
 * The manifest, mirrored from `src/dashboard/ui-assets.ts`.
 *
 * Mirrored rather than imported because this is a `.mjs` build script and that
 * is a `.ts` source. The mirror cannot drift silently: the bidirectional gate
 * in `tests/dashboard-08-ui-assets.test.ts` fails if the emitted set and the
 * manifest ever disagree in either direction.
 */
const FILES = [
  'index.html',
  'app.css',
  'app.js',
  'sw.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
];
const SHELL = FILES.filter((f) => f !== 'sw.js');
const ROUTE_OF = {
  'index.html': '/',
  'app.css': '/app.css',
  'app.js': '/app.js',
  'manifest.webmanifest': '/manifest.webmanifest',
  'icon-192.png': '/icon-192.png',
  'icon-512.png': '/icon-512.png',
};

export function emitUiAssets({ outDir }) {
  mkdirSync(outDir, { recursive: true });

  // The digest covers the shell and EXCLUDES sw.js, which carries it. Including
  // the worker would define the digest in terms of itself.
  const hash = createHash('sha256');
  for (const file of SHELL) {
    hash.update(file, 'utf8');
    hash.update(readFileSync(join(SOURCE_DIR, file)));
  }
  const digest = hash.digest('hex');

  const written = [];
  for (const file of FILES) {
    const target = join(outDir, file);
    if (file === 'sw.js') {
      const source = readFileSync(join(SOURCE_DIR, file), 'utf8');
      const routes = JSON.stringify(SHELL.map((f) => ROUTE_OF[f]));
      const substituted = source
        .split(ROUTES_TOKEN).join(routes)
        .split(DIGEST_TOKEN).join(digest);
      if (substituted.includes(DIGEST_TOKEN) || substituted.includes('__AO_SHELL_ROUTES__')) {
        throw new Error('build-ui-assets: a placeholder survived substitution');
      }
      writeFileSync(target, substituted, 'utf8');
    } else {
      copyFileSync(join(SOURCE_DIR, file), target);
    }
    written.push(file);
  }
  return { digest, files: written };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { digest } = emitUiAssets({ outDir: join(repoRoot, 'build', 'dashboard', 'ui') });
  process.stdout.write(`dashboard ui assets: ao-shell-${digest}\n`);
}
```

**3b.** `package.json` — add the script and put it in the chain:

```json
"build": "tsc -p tsconfig.build.json && npm run build:ui && npm run build:boundary && npm run build:provenance",
"//build:ui": "Copies src/dashboard/ui into build/dashboard/ui and substitutes the service worker's two build-time constants. It has a SECOND caller in scripts/deploy-runtime.mjs, and that is the point: `npm run deploy` re-compiles with tsc rather than copying build/, so without an explicit emit there the deployed runtime carries no UI at all and `dashboard serve` refuses to start in production while every gate stays green.",
"build:ui": "node scripts/build-ui-assets.mjs",
```

**3c.** `scripts/deploy-runtime.mjs` — import and call it beside the boundary:

```js
import { emitUiAssets } from './build-ui-assets.mjs';
```

```js
    compileNativeBoundary({ outFile: join(staging, 'native', 'ao-launch.exe') });
    // The UI is the second non-`tsc` artefact, and the compile above emits none
    // of it. Without this line a deployed runtime has no assets, and the
    // Manager refuses to start on the machine that matters most.
    emitUiAssets({ outDir: join(staging, 'dashboard', 'ui') });
```

- [ ] **Step 4: Run test and a real build to verify**

```bash
node_modules/.bin/vitest run tests/dashboard-08-ui-assets.test.ts
npm run build
ls build/dashboard/ui
grep -c "__AO_SHELL" build/dashboard/ui/sw.js   # expect 0
```

Expected: tests PASS; seven files listed; `grep` finds nothing.

- [ ] **Step 5: Commit**

```bash
git add scripts/build-ui-assets.mjs scripts/deploy-runtime.mjs package.json tests/dashboard-08-ui-assets.test.ts
git commit -m "build(dashboard): emit the UI on both output paths, not only into build/"
```

---

## Task 10: The prose this slice makes false

**Files:**
- Modify: `src/cli/dashboard-command.ts` (lines ~121 and ~128)
- Modify: `src/cli/index.ts` (line ~91)
- Modify: `README.md` (line ~14543)
- Modify: `tests/dashboard-05-http-contract.test.ts:295`, `tests/dashboard-06-http-server.test.ts:566`, `tests/dashboard-07-serve-command.test.ts:197`

**Interfaces:** none.

**Why this is its own task:** three of these sentences are pinned by existing
tests. Deleting the pins would leave the new promise unguarded; leaving them
lands the slice red. Each is **rewritten to the new promise**.

- [ ] **Step 1: Rewrite the pins first, and watch them fail**

`tests/dashboard-07-serve-command.test.ts:197` — replace `'no user interface'`
in the promises list with `'nothing authenticates'`, and add a second case:

```ts
  it('says in its own help that the interface exists and still has no lock on it', () => {
    // The absence that remains true is the one that matters. An operator who
    // reads "there is a UI" must not infer "so something checks who I am".
    expect(DASHBOARD_SERVE_DESCRIPTION).toContain('nothing authenticates');
    expect(DASHBOARD_SERVE_DESCRIPTION).not.toContain('no user interface');
    expect(DASHBOARD_SERVE_DESCRIPTION).toContain('read-only');
  });
```

`tests/dashboard-05-http-contract.test.ts:295` — remove `'/'` from the 404 list,
and add **no** positive assertion in its place.

> **Pre-flight ruling (F-3).** An earlier draft of this step told you to assert
> `/` is no longer `404` here. That assertion would fail, and correctly so:
> `dashboard-05`'s `answer()` helper configures the contract with **no asset
> map**, and a contract with no assets answering `404` for `/` is right rather
> than stale. Giving that suite a fake asset map would put asset concerns in the
> pure-contract file. The positive pin — every manifest route answers `200` —
> already lives in `dashboard-08` (Task 3), which has a real asset map, and end
> to end in the dist gate (Task 11). Here, `/` is simply no longer a member of
> the list of targets this suite claims are absent.

`tests/dashboard-06-http-server.test.ts:566` — change the `/` assertion to
`/nope` and keep `/api/snapshot/` as-is.

Run: `node_modules/.bin/vitest run tests/dashboard-05-http-contract.test.ts tests/dashboard-06-http-server.test.ts tests/dashboard-07-serve-command.test.ts`
Expected: the help-text case FAILS (the description still says "no user interface").

- [ ] **Step 2: Rewrite the four prose locations**

`src/cli/dashboard-command.ts` — the doc comment at ~121 and the description at
~128. Replace "answers one route" with the route count, and replace "There is no
user interface" with the UI's existence **plus the surviving absence**:

> `…and answers the read-only dashboard: a small mobile-first page at `/` and
> the snapshot it polls at `GET /api/snapshot`, as JSON with a weak ETag so a
> poll that changed nothing costs a 304. Nothing authenticates: whatever can
> reach this port can read the snapshot, which is why it is bound to loopback
> and why reaching it from elsewhere is an access layer an operator puts in
> front of it rather than anything this build does.…`

`src/cli/index.ts:91` — the same correction to the front-page bullet.

`README.md:14543` — "One command, one address, one route, one method" becomes a
sentence naming the document and the API route, and the slice-3 section gains a
short slice-4 subsection.

- [ ] **Step 3: Run the three files again**

Run: `node_modules/.bin/vitest run tests/dashboard-05-http-contract.test.ts tests/dashboard-06-http-server.test.ts tests/dashboard-07-serve-command.test.ts`
Expected: PASS.

- [ ] **Step 4: Sweep for a fourth copy**

```bash
grep -rn "one route" src/ README.md docs/ | grep -v node_modules
grep -rn "no user interface" src/ README.md docs/
```

Expected: no remaining occurrence that is now false. (A sentence usually has a
twin; this step exists because it does.)

- [ ] **Step 5: Commit**

```bash
git add src/cli/dashboard-command.ts src/cli/index.ts README.md tests/dashboard-05-http-contract.test.ts tests/dashboard-06-http-server.test.ts tests/dashboard-07-serve-command.test.ts
git commit -m "docs(dashboard): the interface exists now, and still nothing authenticates"
```

---

## Task 11: The dist gate — the built CLI, and a deployed runtime

**Files:**
- Create: `tests/dist-artifact/dashboard-ui-dist-artifact.mjs`
- Modify: `package.json` (add `test:dist-dashboard-ui` to `verify`)
- Modify: `tests/dashboard-08-ui-assets.test.ts` (the bidirectional manifest gate)

**Interfaces:** none.

- [ ] **Step 1: Write the bidirectional manifest gate**

Append to `tests/dashboard-08-ui-assets.test.ts`:

```ts
import { readdirSync } from 'node:fs';

describe('the artefact and the manifest agree in both directions', () => {
  it('every manifest file is emitted, and every emitted file is in the manifest', () => {
    const out = mkdtempSync(join(tmpdir(), 'ao-ui-both-'));
    roots.push(out);
    emitUiAssets({ outDir: out });
    const onDisk = readdirSync(out).sort();
    const named = UI_ASSET_MANIFEST.map((e) => e.file).sort();
    // Both directions. One catches a forgotten copy; the other catches a stray
    // shipped file nothing serves — and neither can be introduced by editing
    // one list, because there is only one list.
    expect(onDisk).toEqual(named);
  });
});
```

- [ ] **Step 2: Write the dist harness**

Create `tests/dist-artifact/dashboard-ui-dist-artifact.mjs`, following the
existing `dashboard-listener-dist-artifact.mjs` (its `check()` helper, its
`launch`/`ask`/`killAndWait` helpers, its exit-code discipline). It must:

1. start `build/cli/index.js dashboard serve` on a free port;
2. `GET` **every** manifest route and require `200` with the manifest's content type;
3. compare the two icons' bytes to the files in `build/dashboard/ui/` — **byte for byte**;
4. require the served `/app.js` and `/index.html` to carry the UI CSP, and `/api/snapshot` the API CSP;
5. read `/sw.js` and require a `ao-shell-<64 hex>` name, **no** surviving placeholder token, and a digest equal to one recomputed over the six shell assets in the artefact;
6. issue a real `GET /api/snapshot`, take the `ETag` **verbatim**, re-issue with `If-None-Match` and require **`304`** — the one place the conditional value is proved against the server rather than a stub;
7. require `/nope` → `404`, `POST /app.css` → `405` with `Allow: GET`;
8. move `build/dashboard/ui/icon-512.png` aside, start the CLI again, require exit `EXIT_RUN_UNEXPECTED`, stderr naming `/icon-512.png`, **no listener opened**, then restore it.

- [ ] **Step 3: Wire it into verify**

```json
"//test:dist-dashboard-ui": "DASHBOARD-001 slice 4 against the shipped CLI. It exists because three of its claims are unreachable in-process: that the BUILT artefact carries the assets at all, that a PNG survives the socket byte for byte, and that the ETag a real server sends is the value a real client must echo to get a 304. The eighth case is the negative control — an asset is moved aside and the CLI must refuse with no listener, which is what stops the other seven from passing against a build that simply serves whatever it finds.",
"test:dist-dashboard-ui": "node tests/dist-artifact/dashboard-ui-dist-artifact.mjs",
"verify:dist-dashboard-ui": "npm run build && npm run test:dist-dashboard-ui",
```

Add `&& npm run test:dist-dashboard-ui` to the `verify` chain, immediately after
`test:dist-dashboard-listen`.

- [ ] **Step 4: Run it**

```bash
npm run build
node tests/dist-artifact/dashboard-ui-dist-artifact.mjs
echo "exit: $?"
```

Expected: exit `0`, every check reported.

- [ ] **Step 5: Prove the gate can fail**

```bash
mv build/dashboard/ui/app.css build/dashboard/ui/app.css.bak
node tests/dist-artifact/dashboard-ui-dist-artifact.mjs; echo "exit: $?"
mv build/dashboard/ui/app.css.bak build/dashboard/ui/app.css
```

Expected: **non-zero** exit naming `/app.css`. A gate that cannot fail is not a
gate. Restore the file before continuing.

- [ ] **Step 6: Commit**

```bash
git add tests/dist-artifact/dashboard-ui-dist-artifact.mjs package.json tests/dashboard-08-ui-assets.test.ts
git commit -m "test(dashboard): the shipped CLI serves the UI, byte for byte, or refuses"
```

---

## Task 12: Widen the existing source sweeps, then the full gate

**Files:**
- Modify: whichever test owns the `tailscale` / `localhost` sweep (locate with the command below)
- Test: full `npm run verify`

- [ ] **Step 1: Find the sweeps and see that they miss the new files**

```bash
grep -rln "tailscale" tests/ | grep -v node_modules
grep -rn "\.ts'" tests/dashboard-07-serve-command.test.ts | head
```

The existing sweeps walk `.ts` files only. This slice puts `.js`, `.html`,
`.css` and `.webmanifest` under `src/`, and they are invisible to it — so the
pin claims an extent its instrument does not have.

- [ ] **Step 2: Widen the extension filter**

Change the sweep's file filter to include `.js`, `.html`, `.css` and
`.webmanifest`, and add a comment saying why the list grew.

- [ ] **Step 3: Prove the widened sweep bites**

```bash
printf '\n/* tailscale */\n' >> src/dashboard/ui/app.css
node_modules/.bin/vitest run tests/dashboard-07-serve-command.test.ts; echo "exit: $?"
git checkout -- src/dashboard/ui/app.css
```

Expected: **FAIL** while the line is present. Restore it afterwards and confirm
`git status` is clean.

- [ ] **Step 4: The full gate, once**

```bash
npm run verify
echo "VERIFY EXIT: $?"
```

Expected: exit `0`. This is the only `npm run verify` of the whole plan — iterate
on `npm run typecheck` plus the single test file, which together take about six
seconds.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A
git commit -m "test(dashboard): the vendor sweep reads the files this slice added"
git push -u origin feat/dashboard-mobile-ui
gh pr create --base main --title "DASHBOARD-001 slice 4 — mobile UI / PWA" --body-file <(...)
```

Do **not** merge. Wait for both `verify (windows, node 22)` and
`verify (windows, node 24)`. Under this repository's `CI_REQUIRED` policy, zero
checks is a blocking condition in its own right and is never success.

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: §2.1 secure context → Task 7 step 1 (the guard test); §3.1–3.4 wording → Task 6; §4.1–4.3 shipping → Tasks 1, 9; §4.4 route table → Task 3; §4.5 startup → Tasks 1, 4; §4.6 body type → Task 2; §5.1–5.4 worker → Task 8; §5.5 manifest → Task 5; §6 CSP → Tasks 3, 5; §7 freshness → Tasks 6, 7; §8 screen → Tasks 5, 6; §9 harness → Tasks 6, 8; §10 pins → all; §10.1 prose → Task 10.

**Gap found and closed.** The first pass left the spec's §8.6 drill-down with no
test of its own — `renderRoute` was called in Task 7 but nothing pinned what the
detail view *contains*. Task 6 now produces `renderDetail` and `renderRoute`
alongside `renderLanding`, with five cases: the omitted readings appear, the
stale-lease wording survives into the detail view unchanged, only that
repository's notes are shown, a `data-back` control exists (a standalone install
has no browser Back button), and an unknown key says so rather than blanking.

**Type consistency.** `DashboardAssetMap` is produced in Task 1 and consumed
with the same name in Tasks 3 and 4. `bodyByteLength` is produced in Task 2 and
used in Task 3. `SHELL_ROUTES` is produced in Task 1 and consumed in Tasks 8 and
9. `emitUiAssets({ outDir })` returns `{ digest, files }` in Task 9 and is
consumed with that shape in Tasks 9 and 11. `AO.classifyFreshness` /
`leaseWording` / `completionLine` / `likelyActiveTasks` / `repositoryName` /
`recordedAge` / `escapeHtml` / `renderLanding` are defined in Task 6 and
`createPoller` in Task 7; the names match the tests in both.
