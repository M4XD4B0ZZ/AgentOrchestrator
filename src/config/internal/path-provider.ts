/**
 * INTERNAL — the single source of the local OS user identity (AO-007-R1).
 *
 * The productive persistent write root is derived from the operating system's
 * own notion of the current user's profile directory and from nothing else. It
 * is deliberately **not** configurable: no CLI flag, no environment variable and
 * no repository file may relocate it, because a relocatable write root turns
 * every diagnostics run into a primitive for writing attacker-chosen content to
 * an attacker-chosen path.
 *
 * "The operating system's own notion" is load-bearing and is *not*
 * `os.homedir()` in this process: on Windows that function returns
 * `%USERPROFILE%` whenever the variable is set. The real answer comes from
 * `trusted-profile.ts`, which reads the profile directory from `os.userInfo()`
 * — the process token on Windows, the passwd entry on POSIX — and so consults
 * no environment variable at all (AO-007-R1-RR1, AO-WINPROFILE-001).
 *
 * Tests still need to run against a scratch directory. That is solved by
 * dependency injection *inside* the package — this module is not referenced
 * from `package.json#exports`, is not reachable through the CLI, and takes no
 * input from `process.env`.
 */

import { trustedProfileDirectory } from './trusted-profile.js';

export interface PathProvider {
  /** Absolute, canonical profile directory of the local OS user. */
  readonly homeDirectory: string;
}

/**
 * The productive provider.
 *
 * The value is resolved on access rather than at import time, and the resolver
 * throws rather than guessing if the OS cannot be asked — see
 * `trusted-profile.ts`. It memoises internally, so repeated access does not
 * re-query the operating system.
 */
export const OS_PATH_PROVIDER: PathProvider = Object.freeze({
  get homeDirectory(): string {
    return trustedProfileDirectory();
  },
});

/**
 * INTERNAL test seam. Builds a provider around a fixed directory.
 *
 * Only test code calls this. It is not exported from any public module, so a
 * consumer of the package cannot reach it, and it reads no environment value.
 */
export function fixedPathProvider(homeDirectory: string): PathProvider {
  return Object.freeze({ homeDirectory });
}
