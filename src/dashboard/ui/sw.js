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
 * shape caches the snapshot endpoint, and a cached snapshot shown offline
 * LOOKS LIVE — the single thing this slice exists to prevent. So the handler
 * answers six literal paths on this origin, bypasses the API explicitly so the
 * intent is readable, and calls `respondWith` for nothing else. Nothing is
 * cached at runtime: the shell is written once, at install, and never added to.
 *
 * ── What this file promises, and what it does not ──────────────────────────
 *
 * It promises that a reply this worker serves came out of the cache named for
 * THIS build's shell digest. The read is against that one cache BY NAME rather
 * than against the cache store at large, so a shell left behind by another
 * build cannot answer even in the window before activation deletes it.
 *
 * It does NOT promise that a new deployment appears on the first navigation
 * that discovers a new worker. When a browser goes looking for an update is
 * the browser's business, and this build does not control it; what is
 * controlled is that when the new worker does activate, the changeover is
 * complete — new shell in, every older shell of this build gone.
 *
 * The two constants below are substituted at build time from the one manifest
 * in `ui-assets.ts`. They are never hand-maintained.
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
      // assets — the app opens and is broken — and `skipWaiting` below must not
      // run for a cache in that state.
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
          // Only this build's own shells, and only the ones that are not
          // current. A cache belonging to something other than this shell is
          // not ours to delete, whoever left it there.
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
  // A request's URL is absolute and already valid by the time a fetch event
  // carries it, so there is no parse failure here to absorb — and this is
  // deliberately not wrapped in a `try`. A `catch` that returned quietly would
  // turn "this worker cannot read a URL" into "this worker handles nothing",
  // which is a broken cache wearing the face of a working one. Were this ever
  // to throw, the handler would end without having called `respondWith`, and
  // the request would go to the network: the same fall-through, minus silence.
  var url = new URL(event.request.url);

  // Another origin's `/app.js` is not this shell's `/app.js`. Without this the
  // allow-list would be a list of PATHS rather than of this build's assets.
  if (url.origin !== self.location.origin) return;

  // Named explicitly rather than left to fall through, so that a future edit
  // which broadened the match would have to delete a line that says why.
  if (url.pathname === API_PATH) return;

  if (SHELL_ROUTES.indexOf(url.pathname) === -1) return;

  event.respondWith(
    // This build's cache by name. `caches.match` would search EVERY cache in
    // the store, so a superseded shell still waiting for activation could
    // answer and two versions would mix.
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(event.request).then(function (hit) {
        // A miss goes to the network. Resolving `respondWith` with nothing is a
        // network error in the browser, which is worse than having no worker.
        return hit || fetch(event.request);
      });
    }),
  );
});
