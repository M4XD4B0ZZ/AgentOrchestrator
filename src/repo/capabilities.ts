/**
 * Repository capability preflight.
 *
 * A profile may declare that a repository *needs* something beyond Git — for
 * v1 that is exactly one thing, CodeGraph — and the orchestrator must decide,
 * before it does anything else, whether that need is met. The whole point is to
 * fail closed: a capability that cannot be positively demonstrated is not
 * available, and a repository that requires it does not resolve.
 *
 * ── What the CodeGraph probe actually proves (and what it does not) ─────────
 *
 * The probe answers one question honestly: **does this repository carry a
 * CodeGraph index?** It looks for a real `.codegraph` directory at the
 * canonical repository root, which is the documented marker of an indexed
 * repository, and it looks for it in-process — no subprocess, no PATH search,
 * no network, no environment value.
 *
 * It does **not** claim that an MCP `codegraph_explore` tool is reachable from
 * this process. The orchestrator runtime is not the agent session that owns
 * those tools and cannot call one, so asserting that would be a fabricated
 * pass. The status vocabulary says exactly this much and no more, and the
 * `UNKNOWN` member exists so that "could not be determined" is representable
 * rather than being rounded to either answer.
 *
 * `UNKNOWN` never satisfies a requirement. Only `AVAILABLE` does.
 */

import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** The capabilities a v1 profile can declare a need for. */
export const REPOSITORY_CAPABILITIES = ['codegraph'] as const;
export type RepositoryCapability = (typeof REPOSITORY_CAPABILITIES)[number];

/**
 * The closed answer set.
 *
 * `UNKNOWN` is not a soft `AVAILABLE`: it means the probe could not conclude,
 * and every caller must treat it as "not proven" — see {@link capabilitySatisfied}.
 */
export type CapabilityStatus = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN';

/** Directory whose presence marks a repository as CodeGraph-indexed. */
export const CODEGRAPH_INDEX_DIR_NAME = '.codegraph';

/**
 * `AVAILABLE` only for a real directory — not a symlink, not a junction, not a
 * file — named `.codegraph` directly at `repositoryRoot`.
 *
 * A link is refused rather than followed: the marker is supposed to say
 * something about *this* repository, and a link makes it say something about
 * wherever it points. An inspection error that is not "absent" yields `UNKNOWN`
 * rather than a guess in either direction.
 */
export function probeCodegraphCapability(repositoryRoot: string): CapabilityStatus {
  const indexPath = join(repositoryRoot, CODEGRAPH_INDEX_DIR_NAME);

  let stats;
  try {
    stats = lstatSync(indexPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'UNAVAILABLE';
    // Anything else — a permission failure, a name that is too long, an I/O
    // error — leaves the question genuinely open.
    return 'UNKNOWN';
  }

  if (stats.isSymbolicLink()) return 'UNKNOWN';
  return stats.isDirectory() ? 'AVAILABLE' : 'UNAVAILABLE';
}

/**
 * Whether an observed status meets a declared requirement.
 *
 * `OPTIONAL` is met by every status, including `UNKNOWN`: the repository stated
 * that it can work without the capability. `REQUIRED` is met by `AVAILABLE`
 * alone.
 */
export function capabilitySatisfied(
  requirement: 'REQUIRED' | 'OPTIONAL',
  status: CapabilityStatus,
): boolean {
  return requirement === 'OPTIONAL' || status === 'AVAILABLE';
}

/** What the resolver records about one capability. */
export interface CapabilityAssessment {
  readonly capability: RepositoryCapability;
  readonly requirement: 'REQUIRED' | 'OPTIONAL';
  readonly status: CapabilityStatus;
  readonly satisfied: boolean;
}
