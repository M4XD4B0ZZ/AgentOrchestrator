// AO Manager — service worker.
//
// Empty on purpose. The install/activate cache lifecycle and the shell digest
// wiring (__AO_SHELL_DIGEST__, __AO_SHELL_ROUTES__ substituted at build time)
// land in a later task of this slice. It exists here so the asset manifest in
// src/dashboard/ui-assets.ts names a complete, loadable set.
//
// `app.js` does now register it, and this file claims no event: with no
// `fetch` handler it intercepts nothing, so the page stays network-only and
// the registration changes nothing an operator can observe. What registering
// it already buys is that the guard around `navigator.serviceWorker` — absent
// on an insecure origin, where an unguarded call takes the whole page down —
// is exercised on the real page rather than written against a worker nobody
// loads.
