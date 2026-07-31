/**
 * Filesystem locations used by the orchestrator.
 *
 * Nothing here is project-specific. The two machine-local roots the doctor
 * probes for write access are overridable via environment variables so the
 * tool is not hard-wired to one machine's layout.
 */

import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/** Root of this orchestrator repository (two levels up from `src/config`). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SCHEMAS_DIR = join(PACKAGE_ROOT, 'schemas');
export const TASK_STATE_SCHEMA_FILE = join(SCHEMAS_DIR, 'task-state.schema.json');

/** Where `agent-loop doctor` writes its artefacts. Git-ignored. */
export const DIAGNOSTICS_DIRNAME = '.diagnostics';

export function diagnosticsDir(cwd: string = process.cwd()): string {
  return join(cwd, DIAGNOSTICS_DIRNAME);
}

/**
 * Per-user orchestrator home. Default `%USERPROFILE%\.agent-orchestrator`
 * (`$HOME/.agent-orchestrator` on POSIX).
 */
export function orchestratorHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_LOOP_HOME;
  if (override !== undefined && override.trim() !== '') return resolve(override);
  return join(homedir(), '.agent-orchestrator');
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
  const override = env.AGENT_LOOP_WORKTREES_ROOT;
  if (override !== undefined && override.trim() !== '') return resolve(override);
  return DEFAULT_WORKTREES_ROOT;
}
