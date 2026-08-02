/**
 * INTERNAL — trusted Windows system tool provenance (AO-FOUNDATION-REM-003B,
 * closes AO-FOUNDATION-FULL-REV-02).
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * Before this module, `exec.ts` built the path of `where.exe`, `cmd.exe` and
 * `taskkill.exe` by joining `env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows'`
 * with `System32` — and separately trusted `env['COMSPEC']` outright as the
 * `.cmd`/`.bat` interpreter. `env` there is the *probe* environment, itself
 * built from the caller-supplied `process.env` (see `env-guard.ts`). A caller
 * who controls `SystemRoot`, `windir` or `COMSPEC` therefore controlled which
 * binary answered "where is `node`", which binary ran a resolved `.cmd`/`.bat`
 * target, and which binary terminated a process tree. Measured on the
 * installed runtime before this fix: a fake `SystemRoot` pointing at a
 * directory holding a copied `where.exe` made that copy answer PATH
 * resolution; a fake `COMSPEC` pointing at a copied `cmd.exe` ran a `.cmd`
 * script through it.
 *
 * ── The replacement boundary ────────────────────────────────────────────────
 *
 * `cmd.exe` and `taskkill.exe` are now resolved from exactly one place: the
 * fixed NT object-manager path `\\?\GLOBALROOT\SystemRoot\System32`. That
 * `SystemRoot` is the kernel's own object-manager symbolic link — set once at
 * boot, not an environment variable of any process — so nothing this module
 * reads is caller-controlled. The literal string below is never built from
 * `process.env`, a policy map or any other input.
 *
 * `CreateProcess` itself refuses to spawn a `\\?\GLOBALROOT\...` path directly
 * (`EINVAL`, confirmed empirically), so the anchor is used for **validation and
 * canonicalisation only** — `realpathSync.native` resolves it to the ordinary
 * drive-letter path (`C:\Windows\System32\cmd.exe`) the OS actually spawns.
 * That canonicalisation still never touches an environment variable: measured
 * with `SystemRoot`, `SYSTEMROOT`, `windir`, `WINDIR`, `COMSPEC`, `ComSpec`,
 * `PATH` and `PATHEXT` all spoofed simultaneously, the resolved paths were
 * byte-identical to the unspoofed run.
 *
 * where.exe is not part of this module and is not used anywhere any more —
 * PATH resolution for the *target* program under diagnosis is a filesystem
 * walk in `exec.ts`, unrelated to this trust boundary. The resolved target
 * program is never treated as a Windows system tool.
 *
 * ── Trust boundary: fail-closed validation ──────────────────────────────────
 *
 * A tool name outside the closed union below is refused outright. For an
 * allowed name, the canonical path must exist, must be a regular file (never
 * a directory, never a reparse point realpath cannot see through), and its
 * canonical parent directory must be exactly the canonical system directory —
 * so a redirected or substituted parent is refused even if the leaf name
 * matches. Every foreign call (`realpath`, `stat`, and every property read on
 * their results) happens behind its own narrow boundary, mirroring
 * `trusted-profile.ts`: a throwing accessor or a throwing method yields a
 * refusal, never a foreign exception. Only a fully validated success is
 * memoised; a failure is never cached, so a transient problem cannot poison
 * later calls, and nothing about *why* a resolution failed — no path, no
 * environment value, no foreign exception text — ever crosses back out.
 */

import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * The one environment-independent anchor this module ever reads from. An NT
 * object-manager path, not a filesystem path built from a variable: the
 * `SystemRoot` segment here is the kernel's own symbolic link, resolved by
 * the object manager, never by `GetEnvironmentVariable`.
 */
const SYSTEM_NAMESPACE_ANCHOR = String.raw`\\?\GLOBALROOT\SystemRoot\System32`;

/** The closed set of Windows system tools this module will ever resolve. */
export const WINDOWS_SYSTEM_TOOLS = ['cmd.exe', 'taskkill.exe'] as const;
export type WindowsSystemTool = (typeof WINDOWS_SYSTEM_TOOLS)[number];

const WINDOWS_SYSTEM_TOOL_SET: ReadonlySet<string> = new Set<string>(WINDOWS_SYSTEM_TOOLS);

function isWindowsSystemTool(value: unknown): value is WindowsSystemTool {
  return typeof value === 'string' && WINDOWS_SYSTEM_TOOL_SET.has(value);
}

/**
 * The closed dependency set of the resolver, mirroring
 * {@link "../../config/internal/trusted-profile.js".TrustedProfileDependencies}.
 * Typed as returning `unknown` on purpose — the validation pipeline below is
 * what establishes the shape, not this declaration.
 */
export interface WindowsSystemToolDependencies {
  readonly realpath: (path: string) => unknown;
  readonly stat: (path: string) => unknown;
}

/** The productive dependency set. Frozen, module-private, never swapped. */
const PRODUCTION_DEPENDENCIES: WindowsSystemToolDependencies = Object.freeze({
  realpath: (path: string): unknown => realpathSync.native(path),
  stat: (path: string): unknown => statSync(path),
});

/** The one, fixed, safe identity this module ever throws. */
export const WINDOWS_SYSTEM_TOOL_UNAVAILABLE_CODE = 'WINDOWS_SYSTEM_TOOL_UNAVAILABLE';

/** The one text the error ever carries. No tool name, no path, no cause. */
export const WINDOWS_SYSTEM_TOOL_UNAVAILABLE_MESSAGE =
  'A required Windows system tool could not be established from the trusted system boundary. ' +
  'Details are withheld because they would be environment or filesystem data.';

/**
 * Thrown for every resolution failure, whatever the internal reason. The
 * reason is deliberately not distinguished in the public error: a caller
 * cannot act differently on "anchor missing" versus "tool is a directory"
 * versus "unknown tool name", so carrying that distinction out would only be
 * one more thing that could leak.
 */
export class WindowsSystemToolUnavailableError extends Error {
  readonly code = WINDOWS_SYSTEM_TOOL_UNAVAILABLE_CODE;

  constructor() {
    super(WINDOWS_SYSTEM_TOOL_UNAVAILABLE_MESSAGE);
    this.name = 'WindowsSystemToolUnavailableError';
    // The default V8 stack trace names every frame's absolute file path —
    // this module's own on-disk location, and (through the call chain) every
    // caller's, which can include a local username or temp path. Overwriting
    // it with the static name/message pair removes that leak while keeping
    // `.stack` a string, exactly as callers of a normal `Error` expect
    // (AO-FOUNDATION-REM-003B-R5). No `Error.captureStackTrace` call is made,
    // so no frame is ever captured in the first place.
    this.stack = `${this.name}: ${this.message}`;
  }
}

function fail(): never {
  throw new WindowsSystemToolUnavailableError();
}

/**
 * The outcome of exactly one external operation. `ok: false` carries nothing
 * — not the thrown value, not its message — so nothing foreign can travel
 * inward to a later message or report.
 */
type Attempt = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function attempt(operation: () => unknown): Attempt {
  try {
    return { ok: true, value: operation() };
  } catch {
    return { ok: false };
  }
}

type ExternalFunction = (...args: unknown[]) => unknown;
type DependencySlot = 'realpath' | 'stat';

/** Reads one dependency slot fail-closed, exactly as `trusted-profile.ts` does. */
function dependencySlot(container: unknown, slot: DependencySlot): ExternalFunction {
  if (typeof container !== 'object' || container === null) fail();

  const read = attempt(() => (container as Record<string, unknown>)[slot]);
  if (!read.ok) fail();
  if (typeof read.value !== 'function') fail();

  return read.value as ExternalFunction;
}

/**
 * A normal Windows drive-absolute path (`X:\...`), and nothing else. This
 * single check is what rejects every non-canonical shape a spoofed or
 * malfunctioning `realpath` dependency could hand back: a relative path
 * (`System32\cmd.exe`) does not start with a drive letter; a UNC path
 * (`\\server\share\...`) and every device-namespace path (`\\?\GLOBALROOT\...`,
 * `\\?\Volume{...}\...`, `\\.\...`) start with `\\`, never with a drive
 * letter (AO-FOUNDATION-REM-003B-R4).
 */
const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[A-Za-z]:\\/;

function isCanonicalDriveAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(value);
}

/**
 * Fail-closed evaluation of one boolean `fs.Stats` predicate (`isFile`,
 * `isDirectory`) on an already-`stat`ed value: reading the property, calling
 * it, and every step of doing so are each behind their own {@link attempt},
 * so a throwing accessor or a throwing method yields a refusal rather than a
 * foreign exception.
 */
function statPredicateHolds(stats: unknown, predicateName: 'isFile' | 'isDirectory'): boolean {
  if (typeof stats !== 'object' || stats === null) return false;

  const predicate = attempt(() => (stats as Record<string, unknown>)[predicateName]);
  if (!predicate.ok) return false;
  if (typeof predicate.value !== 'function') return false;

  const fn = predicate.value as ExternalFunction;
  const verdict = attempt(() => Reflect.apply(fn, stats, []));
  return verdict.ok && verdict.value === true;
}

/**
 * The single validation pipeline, shared by the productive resolver and by
 * the isolated test resolver so the two can never drift apart.
 *
 * Steps, each behind its own {@link attempt}:
 *  1. the tool name must be a member of the closed union;
 *  2. the fixed anchor is canonicalised, and the result must be a normal
 *     Windows drive-absolute path — never relative, never the raw
 *     `\\?\GLOBALROOT\...` namespace back again, never any other device
 *     namespace or UNC path (AO-FOUNDATION-REM-003B-R4);
 *  3. the raw `anchor/tool` path is canonicalised, under the same
 *     drive-absolute constraint;
 *  4. the canonical path's parent must equal the canonical anchor exactly —
 *     a symlink or junction inside the anchor that redirects `tool` to a
 *     different directory is refused here, because its canonical parent would
 *     not match;
 *  5. the canonical path's basename, compared case-insensitively, must equal
 *     the requested tool name exactly — a redirection to a same-directory
 *     `evil.exe` is refused here even though its parent matches;
 *  6. the canonical anchor must `stat` as an existing directory;
 *  7. the canonical tool path must `stat` as an existing regular file.
 */
function resolveWindowsSystemToolPath(
  tool: string,
  dependencies: WindowsSystemToolDependencies,
): string {
  if (!isWindowsSystemTool(tool)) fail();

  const container: unknown = dependencies;
  const canonicalise = dependencySlot(container, 'realpath');
  const describe = dependencySlot(container, 'stat');

  const anchorCanonical = attempt(() => Reflect.apply(canonicalise, container, [SYSTEM_NAMESPACE_ANCHOR]));
  if (!anchorCanonical.ok) fail();
  if (!isCanonicalDriveAbsolutePath(anchorCanonical.value)) fail();

  const rawToolPath = join(SYSTEM_NAMESPACE_ANCHOR, tool);
  const toolCanonical = attempt(() => Reflect.apply(canonicalise, container, [rawToolPath]));
  if (!toolCanonical.ok) fail();
  if (!isCanonicalDriveAbsolutePath(toolCanonical.value)) fail();

  const canonicalPath = toolCanonical.value;
  const canonicalParent = dirname(canonicalPath);
  if (canonicalParent.toLowerCase() !== anchorCanonical.value.toLowerCase()) fail();

  if (basename(canonicalPath).toLowerCase() !== tool.toLowerCase()) fail();

  const anchorDescribed = attempt(() => Reflect.apply(describe, container, [anchorCanonical.value]));
  if (!anchorDescribed.ok) fail();
  if (!statPredicateHolds(anchorDescribed.value, 'isDirectory')) fail();

  const toolDescribed = attempt(() => Reflect.apply(describe, container, [canonicalPath]));
  if (!toolDescribed.ok) fail();
  if (!statPredicateHolds(toolDescribed.value, 'isFile')) fail();

  return canonicalPath;
}

/**
 * Resolved once per tool, per process. Only a *successful* resolution is
 * remembered, so a transient failure never poisons a later call and a
 * failure is never mistaken for a success on replay.
 */
const resolvedCache = new Map<WindowsSystemTool, string>();

/**
 * The canonical, validated absolute path of a trusted Windows system tool.
 *
 * There is no parameter beyond the closed tool name, so no caller can supply
 * a path or an environment that weakens the validation.
 *
 * @throws WindowsSystemToolUnavailableError if the tool cannot be established
 *         from the trusted boundary. There is no environment, PATH, COMSPEC
 *         or shell fallback of any kind.
 */
export function windowsSystemTool(tool: WindowsSystemTool): string {
  const cached = resolvedCache.get(tool);
  if (cached !== undefined) return cached;

  const canonical = resolveWindowsSystemToolPath(tool, PRODUCTION_DEPENDENCIES);
  resolvedCache.set(tool, canonical);
  return canonical;
}

/**
 * INTERNAL test seam: an isolated resolver over injected dependencies.
 *
 * Runs exactly the validation the productive resolver runs, over its own
 * private per-instance cache, so it can neither observe nor disturb the
 * productive one. It accepts a plain `string` for the tool name (not the
 * closed union) so a test can exercise "not an allowed tool name" the same
 * way any other invalid input is exercised — the same fail-closed path a
 * malformed value would hit through the public API's runtime check.
 *
 * Not reachable from `package.json#exports` or from any productive call
 * site: only `windowsSystemTool` above is used by `exec.ts`.
 */
export function createWindowsSystemToolResolverForTests(
  dependencies: WindowsSystemToolDependencies,
): (tool: string) => string {
  const memo = new Map<string, string>();
  return (tool: string): string => {
    const cached = memo.get(tool);
    if (cached !== undefined) return cached;
    const canonical = resolveWindowsSystemToolPath(tool, dependencies);
    memo.set(tool, canonical);
    return canonical;
  };
}
