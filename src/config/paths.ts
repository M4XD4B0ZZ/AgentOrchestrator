/**
 * Filesystem locations used by the orchestrator.
 *
 * Nothing here is project-specific. The orchestrator is meant to be used across
 * repositories and from any working directory, so **no persistent artefact is
 * ever placed relative to `process.cwd()`** (AO-007): a diagnosis started in
 * some arbitrary checkout must not litter that checkout, and must not have its
 * output path chosen by wherever the operator happened to stand.
 *
 * The productive persistent write root is fixed (AO-007-R1):
 *
 *     %USERPROFILE%\.agent-orchestrator\      (Windows)
 *     $HOME/.agent-orchestrator/              (POSIX)
 *
 * It is derived from the local OS user identity through {@link PathProvider}
 * and cannot be overridden. `AGENT_LOOP_HOME` used to relocate it; that
 * override has been **removed**, because an environment value that redirects
 * where diagnostics are written is a privilege the diagnostics do not need and
 * an attacker very much does. If the variable is set, its value is ignored and
 * never printed — see {@link homeOverrideWarningCode}.
 *
 * There is no productive environment-configurable path in this module at all.
 * `AGENT_LOOP_WORKTREES_ROOT` used to resolve here and was handed to a write
 * probe, which made an environment value decide where the doctor created a
 * file. It has been removed together with that probe (AO-007-R1-RR2); worktree
 * roots return in the repository/worktree onboarding work, with their own
 * validation, not as an unvalidated diagnostics side effect.
 *
 * Tests point the root at a scratch directory through internal dependency
 * injection (`src/config/internal/path-provider.ts`), never through the
 * environment and never through a public CLI option.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { OS_PATH_PROVIDER, type PathProvider } from './internal/path-provider.js';

export type { PathProvider };

/** Root of this orchestrator repository (two levels up from `src/config`). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SCHEMAS_DIR = join(PACKAGE_ROOT, 'schemas');
export const TASK_STATE_SCHEMA_FILE = join(SCHEMAS_DIR, 'task-state.schema.json');

/**
 * The generated repository-profile contract, as shipped by this package.
 *
 * Note what this is *not*: it is not a location inside a target repository. A
 * target repository's own profile is found relative to that repository's
 * canonical root by `src/repo/profile-location.ts` and never through this
 * module, which knows only about the orchestrator's own installation.
 */
export const REPO_PROFILE_SCHEMA_FILE = join(SCHEMAS_DIR, 'repo-profile.schema.json');

/** Directory name of the orchestrator home inside the OS user profile. */
export const ORCHESTRATOR_HOME_DIR_NAME = '.agent-orchestrator';

/**
 * Per-user orchestrator home: `<OS user profile>/.agent-orchestrator`.
 *
 * This is the trusted containment root for everything the orchestrator writes.
 * The only way to move it is to pass a different {@link PathProvider}, which is
 * internal test-only wiring.
 */
export function orchestratorHome(provider: PathProvider = OS_PATH_PROVIDER): string {
  return resolve(join(provider.homeDirectory, ORCHESTRATOR_HOME_DIR_NAME));
}

/** Root of every persistent diagnostics artefact. */
export function diagnosticsRoot(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(orchestratorHome(provider), 'diagnostics');
}

/** Where `agent-loop doctor` keeps its diagnostics. Never CWD-relative. */
export function doctorDiagnosticsDir(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(diagnosticsRoot(provider), 'doctor');
}

/**
 * Parent of the immutable per-run directories (AO-007-R2). Each doctor run
 * creates exactly one fresh child here and never touches a previous one.
 */
export function doctorRunsRoot(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(doctorDiagnosticsDir(provider), 'runs');
}

/** The removed override. Named here only so its presence can be reported. */
export const UNSUPPORTED_HOME_OVERRIDE_VAR = 'AGENT_LOOP_HOME';

/** Fixed warning code. Carries no value from the environment. */
export const UNSUPPORTED_HOME_OVERRIDE_CODE = 'UNSUPPORTED_HOME_OVERRIDE_IGNORED';

/**
 * `UNSUPPORTED_HOME_OVERRIDE_IGNORED` when the removed override is set in the
 * given environment, otherwise `null`.
 *
 * Only the *presence* is reported. The value is never read into a message, a
 * path, a report field or the console.
 */
export function homeOverrideWarningCode(
  env: NodeJS.ProcessEnv,
): typeof UNSUPPORTED_HOME_OVERRIDE_CODE | null {
  const value = env[UNSUPPORTED_HOME_OVERRIDE_VAR];
  return value !== undefined && value !== '' ? UNSUPPORTED_HOME_OVERRIDE_CODE : null;
}
