/**
 * INTERNAL — the single source of the local OS user identity (AO-007-R1).
 *
 * The productive persistent write root is derived from the operating system's
 * own notion of the current user's home directory and from nothing else. It is
 * deliberately **not** configurable: no CLI flag, no environment variable and
 * no repository file may relocate it, because a relocatable write root turns
 * every diagnostics run into a primitive for writing attacker-chosen content to
 * an attacker-chosen path.
 *
 * Tests still need to run against a scratch directory. That is solved by
 * dependency injection *inside* the package — this module is not referenced
 * from `package.json#exports`, is not reachable through the CLI, and takes no
 * input from `process.env`.
 */

import { homedir } from 'node:os';

export interface PathProvider {
  /** Absolute home directory of the local OS user. */
  readonly homeDirectory: string;
}

/**
 * The productive provider. Reads the home directory from the OS on every
 * access, so it cannot be captured and frozen at import time.
 */
export const OS_PATH_PROVIDER: PathProvider = Object.freeze({
  get homeDirectory(): string {
    return homedir();
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
