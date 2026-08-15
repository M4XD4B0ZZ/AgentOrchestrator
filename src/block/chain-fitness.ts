/**
 * Whether a predecessor's result is fit to be this member's execution base.
 *
 * ── Proved at the effect, never remembered ─────────────────────────────────
 *
 * Every answer here is re-derived from the ledger and from real Git immediately
 * before the base is used. Nothing is stored: a stored "this base was fine" is a
 * claim about a repository at some earlier instant, and the repository is the
 * one thing in this system an operator can change between two instants. Branch
 * deleted, history rewritten, objects pruned — each of those makes a recorded
 * verdict false without touching the record that holds it.
 *
 * So this module is a gate. It is called on a chained start, it returns a commit
 * or a refusal, and it leaves nothing behind.
 *
 * ── The order is part of the contract ──────────────────────────────────────
 *
 * The checks run cheapest-and-most-specific first, so an operator is told the
 * fact closest to what they must fix rather than the last thing that happened to
 * fail. The ledger is asked before Git — no point probing a commit for a
 * predecessor that has not settled — and existence is asked before reachability,
 * because "not there" and "there but abandoned" are different repairs.
 */

import {
  entryFor,
  type BlockRunLedger,
} from './block-ledger.js';
import {
  classifyAncestry,
  commitIsReferenced,
  commitObjectPresent,
} from '../worktree/commit-probes.js';
import type { GitRunner } from '../worktree/git-command.js';

/** Every way a chained base is refused. A closed set, in precedence order. */
export const CHAIN_BASE_REFUSALS = [
  /**
   * A member this task requires has not settled in this run.
   *
   * The operator's move: run the block again and let the predecessor finish, or
   * resolve whatever stopped it. Nothing is wrong with the repository.
   */
  'PREDECESSOR_NOT_SETTLED',
  /**
   * The predecessor settled but its entry carries no result commit.
   *
   * A settlement without a commit is a task that finished without producing
   * anything to build on — a forced settlement of an older record, typically.
   * There is no base to hand forward, and inventing one would be inventing work.
   */
  'PREDECESSOR_RESULT_ABSENT',
  /**
   * The recorded result commit is not an object in this repository.
   *
   * Git answered the question and said no. The commit was pruned, or the ledger
   * belongs to a different checkout than it claims.
   */
  'BASE_OBJECT_ABSENT',
  /**
   * Git could not evaluate a question about the base at all.
   *
   * Never merged into `BASE_OBJECT_ABSENT`: "your commit is gone" sends an
   * operator hunting for a force-push, and this says only that the repository
   * could not be read.
   */
  'BASE_OBJECT_UNREADABLE',
  /**
   * The object exists and no ref contains it.
   *
   * Discarded work — a deleted branch's tip, or an object waiting to be pruned.
   * Chaining onto it would resurrect it into the successor's pull request.
   */
  'BASE_NOT_REFERENCED',
  /**
   * The base is real and does not descend from the commit this block was frozen
   * on, so the chain has left the line the run is authorised for.
   */
  'BASE_NOT_DESCENDED_FROM_BLOCK_BASE',
  /**
   * The unique maximum's history does not contain every predecessor this member
   * requires, so building on it would silently drop a sibling's work.
   */
  'BASE_MISSING_REQUIRED_PREDECESSOR',
  /**
   * No empty-row member of this ledger is recorded at this invocation's block
   * base, so the document cannot name the base the chain rests on.
   */
  'CHAIN_ANCHOR_MISSING',
  /**
   * The empty-row members that have started name more than one base, so the
   * document has two answers to "what was this block frozen on", and therefore
   * none.
   */
  'CHAIN_ANCHOR_AMBIGUOUS',
] as const;

export type ChainBaseRefusal = (typeof CHAIN_BASE_REFUSALS)[number];

export type ChainBaseResult =
  | { readonly ok: true; readonly commit: string }
  | { readonly ok: false; readonly code: ChainBaseRefusal };

export interface ChainBaseInput {
  readonly ledger: BlockRunLedger;
  /** The chained member about to be started. */
  readonly taskId: string;
  /** Its unique maximum, as `chain-shape.ts` read it from the frozen relation. */
  readonly maximum: string;
  /** The commit this invocation froze the block on. */
  readonly blockBaseCommit: string;
}

function refuse(code: ChainBaseRefusal): ChainBaseResult {
  return Object.freeze({ ok: false as const, code });
}

/** The commit `taskId` may be built on, or why it may not be built at all. */
export async function proveChainBase(
  git: GitRunner,
  repositoryRoot: string,
  input: ChainBaseInput,
): Promise<ChainBaseResult> {
  const { ledger, taskId, maximum, blockBaseCommit } = input;
  const required = ledger.frozenDependencies.find((row) => row.taskId === taskId)?.dependsOn ?? [];

  // 1 + 2. What the ledger must already say, before Git is asked anything.
  for (const predecessor of required) {
    const entry = entryFor(ledger, predecessor);
    if (entry === null || entry.disposition !== 'SETTLED') return refuse('PREDECESSOR_NOT_SETTLED');
  }
  const candidate = entryFor(ledger, maximum)?.resultCommit ?? null;
  if (candidate === null) return refuse('PREDECESSOR_RESULT_ABSENT');

  // 3–4. The object, then its reachability. Existence is not enough: an
  // unreferenced tip is discarded work, and chaining onto it would resurrect it.
  const present = await commitObjectPresent(git, repositoryRoot, candidate);
  if (present === null) return refuse('BASE_OBJECT_UNREADABLE');
  if (!present) return refuse('BASE_OBJECT_ABSENT');
  const referenced = await commitIsReferenced(git, repositoryRoot, candidate);
  if (referenced === null) return refuse('BASE_OBJECT_UNREADABLE');
  if (!referenced) return refuse('BASE_NOT_REFERENCED');

  // 5. The chain has not left the line the block was frozen on.
  const fromBase = await classifyAncestry(git, repositoryRoot, blockBaseCommit, candidate);
  if (fromBase === 'INDETERMINATE') return refuse('BASE_OBJECT_UNREADABLE');
  if (fromBase === 'NOT_ANCESTOR') return refuse('BASE_NOT_DESCENDED_FROM_BLOCK_BASE');

  // 6. The maximum really contains every predecessor this member requires. This
  // is what a `READY_FOR_PR` record from an older run cannot satisfy: such a
  // record may be legitimately settled by `applyForcedProgress`, and settling it
  // does not put its commits into the maximum's history.
  for (const predecessor of required) {
    if (predecessor === maximum) continue;
    const result = entryFor(ledger, predecessor)?.resultCommit ?? null;
    if (result === null) return refuse('PREDECESSOR_RESULT_ABSENT');
    const contained = await classifyAncestry(git, repositoryRoot, result, candidate);
    if (contained === 'INDETERMINATE') return refuse('BASE_OBJECT_UNREADABLE');
    if (contained === 'NOT_ANCESTOR') return refuse('BASE_MISSING_REQUIRED_PREDECESSOR');
  }

  // 7. The anchor, and it is a cardinality question rather than an existence
  // one. `blockBaseCommit` is an invocation input; what makes it *derivable*
  // from this document afterwards is that the empty-row members which have
  // started agree on one value. Two values — one root started here, one
  // forced-settled from an older run — leave a later reader with two candidate
  // block bases and therefore with none.
  const anchors = new Set(
    ledger.frozenDependencies
      .filter((row) => row.dependsOn.length === 0)
      .map((row) => entryFor(ledger, row.taskId)?.baseCommit ?? null)
      // A root that has not started carries no base and is not evidence either
      // way; only a recorded value can anchor or contradict.
      .filter((commit): commit is string => commit !== null),
  );
  //
  // Two codes, and each says exactly one thing. More than one distinct value is
  // a document with two answers. A single value that is not this invocation's
  // base — every root forced-settled from one older run — is a document with one
  // answer that is not ours, and it is the same operator instruction as no
  // anchor at all: start this block from its root.
  if (anchors.size > 1) return refuse('CHAIN_ANCHOR_AMBIGUOUS');
  if (!anchors.has(blockBaseCommit)) return refuse('CHAIN_ANCHOR_MISSING');

  return Object.freeze({ ok: true as const, commit: candidate });
}
