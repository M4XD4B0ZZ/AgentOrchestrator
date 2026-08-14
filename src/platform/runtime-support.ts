/**
 * The V2 runtime support decision, and nothing else.
 *
 * ── Why this may be decided once, at the entry, and trusted afterwards ──────
 *
 * Because both facts it reads are **process-constant**. `process.platform` and
 * `process.version` are fixed by the Node binary that is already running; there
 * is no later moment at which either could answer differently, so checking them
 * once is not a check relocated away from its effect.
 *
 * That reasoning does **not** extend to the filesystem, and nothing here may be
 * read as though it did. Whether the repository's Git common directory can
 * carry a lease is not process-constant, is not consulted here, and stays where
 * it belongs: at the hard-link operation in `lease/execution-lease.ts`, which
 * answers `LEASE_FILESYSTEM_UNSUPPORTED` from the errno the link was refused
 * with. This module measures nothing about any filesystem, which is why it
 * cannot become an authority a later effect leans on — a property of its
 * inputs, not a discipline its callers have to keep.
 *
 * Pure by construction: it reads no `process`, opens no file and starts no
 * child. The caller supplies both facts, which is what makes the whole decision
 * testable in-process against runtimes this machine is not.
 */

/**
 * The supported Node majors. **A whitelist, deliberately not a floor.**
 *
 * `>= 22` would admit 23, 25 and everything after them on a promise nobody has
 * tested. Every member here is measured by CI (`.github/workflows/verify.yml`
 * runs the whole gate against each), so on this axis "enforced" and "verified"
 * are the same set.
 *
 * 24 is a member because it is what the development host runs. A contract that
 * refused the machine the tool is used on would reproduce, on a new axis, the
 * verified/deployed mismatch this slice exists to remove.
 *
 * Typed `readonly number[]` rather than a literal tuple on purpose: no caller
 * needs the `22 | 24` union, and `includes(major)` against a tuple type forces
 * a cast at the one call site whose correctness matters most.
 */
export const SUPPORTED_NODE_MAJORS: readonly number[] = Object.freeze([22, 24]);

/** The supported platform. `process.platform`'s value, not a friendly name. */
export const SUPPORTED_PLATFORM = 'win32';

export const RUNTIME_SUPPORT_CODES = [
  /** Not Windows. */
  'RUNTIME_PLATFORM_UNSUPPORTED',
  /**
   * Windows, but the Node major is outside {@link SUPPORTED_NODE_MAJORS}.
   *
   * Not `..._TOO_OLD`: Node 25 is refused and is not old. A code that
   * misdescribes its own refusal sends an operator to the wrong fix.
   */
  'RUNTIME_NODE_UNSUPPORTED',
  /**
   * The version string could not be read.
   *
   * Its own code, and a refusal rather than a pass: an unknown answer is not a
   * supported one.
   */
  'RUNTIME_NODE_VERSION_UNREADABLE',
] as const;

export type RuntimeSupportCode = (typeof RUNTIME_SUPPORT_CODES)[number];

export type RuntimeSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly code: RuntimeSupportCode;
      /** One sentence naming what was found and what is supported. */
      readonly detail: string;
    };

const SUPPORTED: RuntimeSupport = Object.freeze({ supported: true as const });

function refuse(code: RuntimeSupportCode, detail: string): RuntimeSupport {
  return Object.freeze({ supported: false as const, code, detail });
}

/**
 * The major from a Node version string, or `null` when there is not one.
 *
 * Exported so `doctor/run-doctor.ts` reports on the same reading the gate
 * refuses on. Two parsers would be two contracts.
 */
export function parseNodeMajor(versionText: string): number | null {
  const match = /^v?(\d+)\./.exec(versionText.trim());
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}

/** Whether this runtime is inside the V2 support contract. */
export function evaluateRuntimeSupport(platform: string, nodeVersion: string): RuntimeSupport {
  // Platform first, and that order is load-bearing: an unreadable version on
  // POSIX must report the operating system, which is the operator's actual
  // problem, not a Node problem they would then go and fail to fix.
  if (platform !== SUPPORTED_PLATFORM) {
    return refuse(
      'RUNTIME_PLATFORM_UNSUPPORTED',
      `Detected platform ${platform}; V2 supports ${SUPPORTED_PLATFORM} only.`,
    );
  }

  const major = parseNodeMajor(nodeVersion);
  if (major === null) {
    return refuse(
      'RUNTIME_NODE_VERSION_UNREADABLE',
      `Node reported the version ${JSON.stringify(nodeVersion)}, which could not be read. ` +
        `V2 supports Node ${SUPPORTED_NODE_MAJORS.join(' and ')}.`,
    );
  }

  if (!SUPPORTED_NODE_MAJORS.includes(major)) {
    return refuse(
      'RUNTIME_NODE_UNSUPPORTED',
      `Detected Node major ${major}; V2 supports ${SUPPORTED_NODE_MAJORS.join(' and ')} ` +
        `and nothing else. This is a whitelist, not a minimum.`,
    );
  }

  return SUPPORTED;
}
