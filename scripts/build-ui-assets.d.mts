/**
 * Types for `scripts/build-ui-assets.mjs`.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * `tests/dashboard-08-ui-assets.test.ts` imports `emitUiAssets` so that the
 * emit is pinned by the same suite that owns the manifest — which is the right
 * place for it, because the tests there recompute the digest from
 * `UI_ASSET_MANIFEST` and check the emitted set against it in both directions.
 *
 * But `tsconfig.json` sets neither `allowJs` nor `checkJs`, so a `.ts` test
 * importing a `.mjs` build script is `error TS7016` under `strict`, and
 * `npm run typecheck` is the FIRST step of `npm run verify`. Turning on
 * `allowJs` to fix one import would pull every `.js` in the repository into the
 * program; a declaration beside the module is the narrow answer.
 *
 * ── The drift this carries, stated rather than hidden ──────────────────────
 *
 * A hand-written declaration can lie about a module it does not compile from.
 * This one is deliberately tiny, and both of its fields are asserted at
 * RUNTIME by the importing suite — `digest` against `/^[0-9a-f]{64}$/` and
 * against a recomputation from the manifest, `files` against the manifest's
 * own file list — so a declaration that stopped describing the module would be
 * caught by a failing test rather than by a reviewer noticing.
 */

/** What the emit produced: the shell digest, and the files it wrote. */
export interface UiAssetEmit {
  /** SHA-256 over the shell, hex. The service worker's cache is named for it. */
  readonly digest: string;
  /** Every file written into `outDir`, in manifest order. */
  readonly files: string[];
}

/** Where the assets are authored: `<repo>/src/dashboard/ui`. */
export declare const UI_SOURCE_DIR: string;

/** Where `npm run build` puts them: `<repo>/build/dashboard/ui`. */
export declare const UI_BUILD_DIR: string;

/** A refusal from the emit step. Never a partial artefact. */
export declare class UiAssetBuildError extends Error {}

/** Emits the seven UI assets into `outDir`, substituting the worker's constants. */
export declare function emitUiAssets(options: { outDir: string }): UiAssetEmit;
