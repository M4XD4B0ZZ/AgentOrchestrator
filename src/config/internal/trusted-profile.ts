/**
 * INTERNAL — the trusted OS user profile directory
 * (AO-007-R1-RR1, AO-007-R1-RR3, AO-WINPROFILE-001, AO-WINPROFILE-001-R1).
 *
 * ── What this module answers, and how ───────────────────────────────────────
 *
 * One question: where is the local user's profile directory. It is answered by
 * a direct, in-process query of the operating system through `os.userInfo()`.
 * That call consults no environment block at all — on Windows it resolves the
 * profile directory from the process token, on POSIX from the passwd entry for
 * the real uid — so the answer cannot be relocated by anything a caller, a
 * parent process or a repository file is able to set. A relocatable write root
 * would turn every diagnostics run into a primitive for writing chosen content
 * to a chosen location, and that is what this module exists to prevent.
 *
 * ── No external mechanism ───────────────────────────────────────────────────
 *
 * The resolution happens entirely inside this process. There is no program to
 * locate, no interpreter, no search list, no quoting, no output protocol to
 * parse, no timeout, and no sub-process that can fail. One source of truth, and
 * no fallback of any kind.
 *
 * ── Trust boundary: fail-closed validation ──────────────────────────────────
 *
 * Everything crossing in from outside is treated as untrusted at runtime,
 * regardless of what the TypeScript declaration promises: the dependency slots
 * themselves, the query result, its `homedir` field, the canonical answer, the
 * file-status object, and that object's own directory predicate. Every one of
 * those property reads and every one of those calls happens behind a narrow
 * boundary of its own, so a throwing accessor, an absent member or a throwing
 * method yields a refusal rather than a foreign exception
 * (AO-WINPROFILE-001-R1).
 *
 * An accepted value must be a string, non-empty, not whitespace-only, free of
 * embedded NUL, absolute, canonically resolvable, and an existing directory.
 * **There is no fallback.** Every failure throws
 * {@link TrustedProfileUnavailableError}, whose displayed text comes from a
 * closed identifier: no raw value, no user name, no errno and no foreign
 * exception text ever crosses back out.
 *
 * This module is not referenced from `package.json#exports`, is not reachable
 * from the CLI, and reads nothing from the process environment.
 */

import { realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';

import { TrustedProfileUnavailableError } from '../../core/errors.js';

/**
 * The closed dependency set of the resolver.
 *
 * Every member is typed as returning `unknown` on purpose: the validation below
 * is what establishes the shape, and typing them faithfully here would let the
 * compiler quietly excuse the runtime checks that are the point of this module.
 * The declaration is not evidence either — the resolver re-derives each slot
 * from the object it is handed, and refuses anything that is not a function.
 */
export interface TrustedProfileDependencies {
  readonly userInfo: () => unknown;
  readonly realpath: (path: string) => unknown;
  readonly stat: (path: string) => unknown;
}

/**
 * The productive dependency set. Frozen, module-private, and never swapped:
 * there is no setter and no global provider reference, so no caller — and no
 * test — can redirect what {@link trustedProfileDirectory} asks.
 */
const PRODUCTION_DEPENDENCIES: TrustedProfileDependencies = Object.freeze({
  userInfo: (): unknown => userInfo(),
  realpath: (path: string): unknown => realpathSync.native(path),
  stat: (path: string): unknown => statSync(path),
});

/**
 * Internal diagnosis reasons. These differentiate for a developer reading a
 * stack trace; they are never public API and never reach a report or the
 * console, which see only the static `TRUSTED_PROFILE_UNAVAILABLE` sentence.
 */
type ResolutionFailure =
  | 'RESOLVER_DEPENDENCIES_INVALID'
  | 'OPERATING_SYSTEM_QUERY_FAILED'
  | 'OPERATING_SYSTEM_VALUE_INVALID'
  | 'PROFILE_CANONICALIZATION_FAILED'
  | 'PROFILE_NOT_DIRECTORY';

/**
 * Static texts, one per reason. Nothing is interpolated: not the raw path, not
 * the canonical path, not the user name, not an `errno`, not a caught
 * exception's message and not its stack. A failure must not become a channel
 * for the very value the caller was not allowed to learn.
 */
const FAILURE_DETAIL: Readonly<Record<ResolutionFailure, string>> = Object.freeze({
  RESOLVER_DEPENDENCIES_INVALID: 'the resolver dependency set is not usable',
  OPERATING_SYSTEM_QUERY_FAILED: 'the operating system user query did not succeed',
  OPERATING_SYSTEM_VALUE_INVALID: 'the operating system returned no usable profile path',
  PROFILE_CANONICALIZATION_FAILED: 'the profile path could not be canonicalised',
  PROFILE_NOT_DIRECTORY: 'the canonical profile path is not an existing directory',
});

function fail(reason: ResolutionFailure): never {
  throw new TrustedProfileUnavailableError(
    `Trusted profile resolution failed: ${FAILURE_DETAIL[reason]}.`,
  );
}

/** The one character no filesystem path may contain. */
const NUL = '\u0000';

/**
 * A value usable as a path at all: a string with content that is not merely
 * whitespace and carries no embedded NUL.
 *
 * The whitespace test is an emptiness test only. The original string — not a
 * trimmed copy — is what gets resolved, because trimming would invent a path
 * the OS never returned.
 */
function isUsablePathString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim().length > 0 &&
    !value.includes(NUL)
  );
}

/**
 * The outcome of exactly one external operation.
 *
 * `ok: false` carries nothing at all — not the thrown value, not its message,
 * not its `errno`. The caught value is dropped at the boundary rather than
 * carried inward and later formatted, so there is no data path along which it
 * could reach a message, a report or a stack.
 */
type Attempt = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * Runs one — and only one — external operation behind a narrow boundary.
 *
 * The callback passed in must contain nothing but the foreign property read or
 * the foreign call itself. In particular it never contains a {@link fail}, so a
 * deliberate {@link TrustedProfileUnavailableError} raised by this module can
 * never be swallowed here and re-reported as an external failure.
 */
function attempt(operation: () => unknown): Attempt {
  try {
    return { ok: true, value: operation() };
  } catch {
    return { ok: false };
  }
}

/** The shape every dependency slot must have to be callable at all. */
type ExternalFunction = (...args: unknown[]) => unknown;

/** The three slots the resolver reads out of the dependency container. */
type DependencySlot = 'userInfo' | 'realpath' | 'stat';

/**
 * Reads one dependency slot fail-closed.
 *
 * The container may be `null`, a primitive, a plain object missing the slot, an
 * object whose slot holds a non-function, or an accessor-backed object whose
 * getter throws. Each of those is a refusal with the ordinary domain semantics
 * — never a native `TypeError` and never the getter's own exception, which on a
 * hostile object is attacker-chosen text.
 */
function dependencySlot(container: unknown, slot: DependencySlot): ExternalFunction {
  if (typeof container !== 'object' || container === null) fail('RESOLVER_DEPENDENCIES_INVALID');

  const read = attempt(() => (container as Record<string, unknown>)[slot]);
  if (!read.ok) fail('RESOLVER_DEPENDENCIES_INVALID');
  if (typeof read.value !== 'function') fail('RESOLVER_DEPENDENCIES_INVALID');

  return read.value as ExternalFunction;
}

/**
 * The single validation pipeline, shared by the productive resolver and by the
 * isolated test resolver so the two can never drift apart.
 *
 * A UNC path is not rejected for being UNC: `isAbsolute` accepts it, and what
 * matters is that canonicalisation succeeds and the target is a directory. A
 * junction or redirected profile is likewise not rejected for carrying a
 * reparse point — `realpath` resolving it is the whole point.
 *
 * Each foreign interaction — reading a slot, calling it, reading a field of the
 * result, calling that field — is a separate {@link attempt}. Nothing between
 * two attempts is inside a `try`, so this module's own refusals travel straight
 * out to the caller.
 */
function resolveTrustedProfile(dependencies: TrustedProfileDependencies): string {
  const container: unknown = dependencies;
  const queryUser = dependencySlot(container, 'userInfo');
  const canonicalise = dependencySlot(container, 'realpath');
  const describe = dependencySlot(container, 'stat');

  const queried = attempt(() => Reflect.apply(queryUser, container, []));
  if (!queried.ok) fail('OPERATING_SYSTEM_QUERY_FAILED');

  const info = queried.value;
  if (typeof info !== 'object' || info === null) fail('OPERATING_SYSTEM_VALUE_INVALID');

  // The field read is its own boundary: `homedir` may be an accessor, and an
  // accessor that throws must not become the reported failure.
  const home = attempt(() => (info as { homedir?: unknown }).homedir);
  if (!home.ok) fail('OPERATING_SYSTEM_VALUE_INVALID');

  const raw = home.value;
  if (!isUsablePathString(raw)) fail('OPERATING_SYSTEM_VALUE_INVALID');
  // `isAbsolute` from node:path, never a hand-rolled drive-letter pattern: the
  // platform's own rules cover UNC and POSIX roots that a regex would miss.
  if (!isAbsolute(raw)) fail('OPERATING_SYSTEM_VALUE_INVALID');

  const canonicalised = attempt(() => Reflect.apply(canonicalise, container, [raw]));
  if (!canonicalised.ok) fail('PROFILE_CANONICALIZATION_FAILED');

  // The canonical answer is re-validated rather than trusted for having come
  // out of `realpath`.
  const canonical = canonicalised.value;
  if (!isUsablePathString(canonical)) fail('PROFILE_CANONICALIZATION_FAILED');
  if (!isAbsolute(canonical)) fail('PROFILE_CANONICALIZATION_FAILED');

  const described = attempt(() => Reflect.apply(describe, container, [canonical]));
  if (!described.ok) fail('PROFILE_NOT_DIRECTORY');

  const stats = described.value;
  if (typeof stats !== 'object' || stats === null) fail('PROFILE_NOT_DIRECTORY');

  // Three separate steps on purpose: the property may be an accessor that
  // throws, the value may not be callable, and the call itself may throw.
  const predicate = attempt(() => (stats as { isDirectory?: unknown }).isDirectory);
  if (!predicate.ok) fail('PROFILE_NOT_DIRECTORY');
  if (typeof predicate.value !== 'function') fail('PROFILE_NOT_DIRECTORY');

  const isDirectory = predicate.value as ExternalFunction;
  // `stats` is the receiver, because a real file-status object reads private
  // state through `this`; calling it detached would answer about nothing.
  const verdict = attempt(() => Reflect.apply(isDirectory, stats, []));
  if (!verdict.ok) fail('PROFILE_NOT_DIRECTORY');
  // Exactly `true`, not merely truthy: a non-boolean answer is an answer this
  // module does not understand, and an answer it does not understand is a no.
  if (verdict.value !== true) fail('PROFILE_NOT_DIRECTORY');

  return canonical;
}

/**
 * Resolved once per process.
 *
 * Only a *successful* resolution is remembered. A failure is not cached, so a
 * transient problem does not poison the rest of the process — and a cached
 * success cannot be invalidated by anything an attacker can set later.
 */
let resolved: string | null = null;

/**
 * The trusted profile directory of the local OS user.
 *
 * Always uses the productive `os.userInfo` dependency set. There is no
 * parameter, so no caller can supply a profile path or weaken the validation.
 *
 * @throws TrustedProfileUnavailableError if it cannot be established. There is
 *         deliberately no environment, shell or external fallback.
 */
export function trustedProfileDirectory(): string {
  if (resolved !== null) return resolved;

  const canonical = resolveTrustedProfile(PRODUCTION_DEPENDENCIES);
  resolved = canonical;
  return canonical;
}

/**
 * INTERNAL test seam: drops the memoised value so a test can observe a fresh
 * resolution. Not exported from any public module.
 */
export function resetTrustedProfileCacheForTests(): void {
  resolved = null;
}

/**
 * INTERNAL test seam: an isolated resolver over injected dependencies.
 *
 * It runs exactly the validation the productive resolver runs — the same
 * function, not a copy — and carries its own private cache, so it can neither
 * observe nor disturb the productive one. It accepts *dependencies*, never a
 * ready-made profile path, so there is no way to hand it a value that skips
 * validation, and a malformed container is refused with the ordinary domain
 * semantics rather than a native error.
 */
export function createTrustedProfileResolverForTests(
  dependencies: TrustedProfileDependencies,
): () => string {
  let memo: string | null = null;
  return (): string => {
    if (memo !== null) return memo;
    const canonical = resolveTrustedProfile(dependencies);
    memo = canonical;
    return canonical;
  };
}
