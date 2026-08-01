/**
 * Filesystem locations used by the orchestrator.
 *
 * Nothing here is project-specific. The orchestrator is meant to be used across
 * repositories and from any working directory, so **no persistent artefact is
 * ever placed relative to `process.cwd()`** (AO-007): a diagnosis started in
 * some arbitrary checkout must not litter that checkout, and must not have its
 * output path chosen by wherever the operator happened to stand.
 *
 * Persistent diagnostics live under the per-user application-data root:
 *
 *     %USERPROFILE%\.agent-orchestrator\diagnostics\doctor\    (Windows)
 *     $HOME/.agent-orchestrator/diagnostics/doctor/            (POSIX)
 */

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** Root of this orchestrator repository (two levels up from `src/config`). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SCHEMAS_DIR = join(PACKAGE_ROOT, 'schemas');
export const TASK_STATE_SCHEMA_FILE = join(SCHEMAS_DIR, 'task-state.schema.json');

/**
 * Per-user orchestrator home. Default `%USERPROFILE%\.agent-orchestrator`
 * (`$HOME/.agent-orchestrator` on POSIX).
 *
 * This is the trusted containment root for everything the orchestrator writes.
 * `AGENT_LOOP_HOME` relocates it — that is how the tests point it at a
 * temporary directory.
 */
export function orchestratorHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['AGENT_LOOP_HOME'];
  if (override !== undefined && override.trim() !== '') return resolve(override);
  return join(homedir(), '.agent-orchestrator');
}

/** Root of every persistent diagnostics artefact. */
export function diagnosticsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(orchestratorHome(env), 'diagnostics');
}

/** Where `agent-loop doctor` writes its artefacts. Never CWD-relative. */
export function doctorDiagnosticsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(diagnosticsRoot(env), 'doctor');
}

/**
 * Root under which per-task Git worktrees will later be created.
 *
 * The default matches the operator's configured layout on this machine; it is
 * a default, not a hard-coded requirement, and can be pointed anywhere via
 * `AGENT_LOOP_WORKTREES_ROOT`.
 */
export const DEFAULT_WORKTREES_ROOT = 'D:\\AgentWorktrees';

export function worktreesRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['AGENT_LOOP_WORKTREES_ROOT'];
  if (override !== undefined && override.trim() !== '') return resolve(override);
  return DEFAULT_WORKTREES_ROOT;
}
