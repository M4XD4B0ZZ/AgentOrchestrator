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
 * The probe answers one question honestly: **does this working copy carry a
 * CodeGraph index?** It looks for a real `.codegraph` directory at the directory
 * it is given, which is the documented marker of an indexed working copy, and it
 * looks for it in-process — no subprocess, no PATH search, no network, no
 * environment value.
 *
 * **Which working copy is the caller's decision, and it is a real decision.**
 * The probe used to be described as asking about "the canonical repository
 * root", and its one caller passed exactly that — while the agents this build
 * starts work in a *task worktree*, a sibling directory. Those two can disagree,
 * and on the machine this was written on they always did: `.codegraph/` is
 * ignored through `.git/info/exclude`, a file in the **common** Git directory,
 * so every linked worktree inherits the ignore rule and none inherits the
 * directory. Measured: 0 of 12 worktrees carried an index while the root did.
 * `resolve-repository.ts` still asks at the root, because that is the only
 * question answerable before a task exists, and `plan/task-brief.ts` asks again
 * in the worktree, which is the answer a writer's authority may rest on.
 *
 * That is the whole of the evidence, so it is also the whole of what the type
 * says. The positive status is named `INDEX_PRESENT` rather than `AVAILABLE`
 * because a local index directory is a fact about the filesystem and nothing
 * more. It does **not** establish that the index has valid contents, that it is
 * current with the working tree, that an MCP server is configured, or that a
 * `codegraph_explore` tool is reachable from this process — the orchestrator
 * runtime is not the agent session that owns those tools and cannot call one,
 * so asserting any of it would be a fabricated pass.
 *
 * The naming is deliberate rather than cosmetic: `AVAILABLE` invites a consumer
 * to read "the capability can be used", and V1-02 onwards would be written
 * against that reading. `INDEX_PRESENT` can only be read as what was measured.
 * When a later slice can prove tool reachability, it earns a *second* status of
 * its own; it does not redefine this one.
 *
 * **That slice is M5 and the promise was kept.**
 * `agent/mcp-capability-preflight.ts` answers reachability, from a separate
 * source (the operator's grant registry) against a separate question (does the
 * writer's own session announce the tool). Nothing below changed: a repository
 * that resolves here can still be refused there, and the two refusals have
 * different codes because they are different facts.
 *
 * `UNKNOWN` exists so that "could not be determined" is representable rather
 * than rounded to either answer, and it never satisfies a requirement. Only
 * `INDEX_PRESENT` does.
 */

import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/** The capabilities a v1 profile can declare a need for. */
export const REPOSITORY_CAPABILITIES = ['codegraph'] as const;
export type RepositoryCapability = (typeof REPOSITORY_CAPABILITIES)[number];

/**
 * The closed answer set, named after the evidence rather than after a
 * conclusion drawn from it.
 *
 * - `INDEX_PRESENT` — a real local index directory was observed. Nothing about
 *   its contents, its freshness or any tool's reachability is claimed.
 * - `UNAVAILABLE` — no local index is there.
 * - `UNKNOWN` — the probe could not conclude. Not a soft `INDEX_PRESENT`: every
 *   caller must treat it as "not proven" — see {@link capabilitySatisfied}.
 */
export type CapabilityStatus = 'INDEX_PRESENT' | 'UNAVAILABLE' | 'UNKNOWN';

/** Directory whose presence marks a repository as CodeGraph-indexed. */
export const CODEGRAPH_INDEX_DIR_NAME = '.codegraph';

/**
 * `INDEX_PRESENT` only for a real directory — not a symlink, not a junction,
 * not a file — named `.codegraph` directly in `workingCopy`.
 *
 * A link is refused rather than followed: the marker is supposed to say
 * something about *this* working copy, and a link makes it say something about
 * wherever it points. An inspection error that is not "absent" yields `UNKNOWN`
 * rather than a guess in either direction.
 *
 * The parameter is the whole of the subject. Nothing in here knows or cares
 * whether it was handed a repository root or a task worktree, and a caller that
 * passes the wrong one gets a true answer to the wrong question — which is the
 * defect this parameter was renamed to stop repeating.
 */
export function probeCodegraphCapability(workingCopy: string): CapabilityStatus {
  const indexPath = join(workingCopy, CODEGRAPH_INDEX_DIR_NAME);

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
  return stats.isDirectory() ? 'INDEX_PRESENT' : 'UNAVAILABLE';
}

/**
 * Whether an observed status meets a declared requirement.
 *
 * `OPTIONAL` is met by every status, including `UNKNOWN`: the repository stated
 * that it can work without the capability. `REQUIRED` is met by `INDEX_PRESENT`
 * alone — that is, by the only status backed by evidence this build can gather.
 * A profile declaring `REQUIRED` is therefore requiring an indexed working copy,
 * which is what a probe is able to check; it is not being told that a CodeGraph
 * tool answered — and *which* working copy was asked is a property of the
 * caller, never of this function.
 */
export function capabilitySatisfied(
  requirement: 'REQUIRED' | 'OPTIONAL',
  status: CapabilityStatus,
): boolean {
  return requirement === 'OPTIONAL' || status === 'INDEX_PRESENT';
}

/** What the resolver records about one capability. */
export interface CapabilityAssessment {
  readonly capability: RepositoryCapability;
  readonly requirement: 'REQUIRED' | 'OPTIONAL';
  readonly status: CapabilityStatus;
  readonly satisfied: boolean;
}
