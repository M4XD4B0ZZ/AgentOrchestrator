/**
 * The only way a loop step reaches a subprocess (V2-07L).
 *
 * ── Why this is its own module ─────────────────────────────────────────────
 *
 * The fence started as something `runLoopStep` installed: it replaced
 * `deps.agent` with a wrapped version and handed the result down. That fenced
 * every path *through `runLoopStep`* and nothing else, and every step function
 * is exported — so a direct caller got no fence, and an *absent* seam fell
 * through to the raw `runAgentCommand`, which meant the dangerous case was also
 * the default one.
 *
 * Moving the fence to where the seam is read fixed that, and a static test was
 * added claiming the property held for the whole module. A review then defeated
 * that test three times over, from inside the module:
 *
 *  1. aliasing a spawn helper (`const warmUp = runClaudeWriter`) and calling it
 *     with no seam, so the helper's own default reached the raw runner;
 *  2. calling `spawnSync` directly — 57 real unfenced processes started, whole
 *     suite green;
 *  3. calling `runAgentCommand` directly, paid for by rewording one of the three
 *     prose mentions the test counted.
 *
 * The lesson is not that the count was too small. It is that a claim about
 * *every* spawn site cannot be carried by reading source text, any more than the
 * Git-layout rule earlier in this slice could be carried by the three layouts
 * somebody had measured. Three things follow, and they are deliberately not
 * stated as equals:
 *
 *  - **the seams are the enforcement.** Every agent and verification subprocess
 *    goes through {@link leasedAgent} or {@link leasedVerify}, which prove the
 *    lease at the call rather than at some caller's door. That is narrower than
 *    "every productive spawn", which is what this said: `git worktree add`,
 *    `git worktree remove` and `git branch -d` are productive spawns and go
 *    through neither. They are fenced by `verifyExecutionLeaseHeldFor`
 *    immediately before the effect — the same property, a different mechanism,
 *    and worth not blurring, because a reader who believes the seams cover the
 *    Git mutations will look for the wrong gate;
 *  - **and there is now a fourth Git mutation: the commit.** DOGFOOD-REM-001
 *    moved the commit from the writing agent to the orchestrator, so AO itself
 *    writes an object into the target repository's history. That belongs here
 *    rather than beside the other three, and it gets the *seam* treatment
 *    ({@link leasedGit}) rather than a pre-check, for one reason: a commit is
 *    the last thing a writing pass does, minutes of subprocess time after the
 *    step began, which is exactly the window in which a lease is lost. A gate
 *    proved at the top of the step and a commit written at the bottom of it are
 *    not the same claim;
 *  - **a missing seam is a compile error.** `runClaudeWriter`,
 *    `runCodexReviewer` and `runVerification` no longer default their runner, so
 *    a forgetful call site does not build. This is enforcement;
 *  - **the import pins are regression detectors.** This module is the only
 *    importer of the raw runners, and `node:child_process` has exactly one
 *    importer; tests hold both. That catches a reintroduction nobody meant.
 *
 * ── The residue, which is real ─────────────────────────────────────────────
 *
 * The third bullet is **not** a proof, and an earlier version of this header
 * claimed it was. A review disproved that with `process.binding('spawn_sync')`,
 * which starts real processes, names no module, and is therefore invisible to
 * any pin that reads imports — verified working on the Node this package
 * requires. `node:worker_threads`, `node:vm` and indirect `eval` are the same
 * shape. They are on a denylist in `tests/v2-07l-execution-lease.test.ts`
 * because a denylist of known routes is worth having, and a denylist is not a
 * bound on what a determined author can write.
 *
 * What that means in practice: this module makes the *accidental* unfenced spawn
 * impossible and the deliberate one obvious. Bounding the deliberate one needs
 * owned process containment — the same mechanism the recovery contract already
 * waits on — and it is not claimed here.
 *
 * ── What the fence does not claim ──────────────────────────────────────────
 *
 * That an agent *already running* stops. It does not; that needs owned process
 * containment, which is measured in `lease/execution-lease.ts` and deliberately
 * a later slice. This refuses to *start* one.
 */

import { runAgentCommand, type AgentCommandResult, type AgentRunner } from '../agent/agent-command.js';
import {
  isContainmentAttestation,
  type ContainmentAttestation,
} from '../core/containment-attestation.js';
import type { AgentId } from '../core/states.js';
import {
  attestWriterLaunchEstablished,
  beginWriterLaunch,
  clearContainmentEvidence,
  confirmWriterLaunch,
  recordContainmentEvidence,
  retractWriterLaunchEstablishment,
  verifyExecutionLeaseHeldFor,
  type ExecutionLeaseAuthority,
} from '../lease/execution-lease.js';
import { runGitCommand, type GitCommandResult, type GitRunner } from '../worktree/git-command.js';
import {
  runVerificationCommand,
  type VerificationCommandResult,
  type VerificationRunner,
} from '../verify/verify-command.js';

/** The two seams a step may be handed, and the authority they are fenced by. */
export interface SpawnAuthority {
  readonly lease: ExecutionLeaseAuthority;
  readonly agent?: AgentRunner;
  readonly verify?: VerificationRunner;
  /**
   * The clock the containment record is stamped with. A test seam of the same
   * class as the lease's own `now`, and it can only ever produce a record this
   * build refuses: the recorder parses what it built back and requires its own
   * reading of it to be reliable before writing anything.
   *
   * Not called `now`: `LoopDependencies` already carries a `now` of its own, and
   * it is a `string` rather than a function. Every step's dependency object is
   * passed here whole, so a second `now` with a different type would make those
   * call sites stop compiling — which is how this name was chosen.
   */
  readonly containmentNow?: () => string;
}

/**
 * The agent whose containment is recorded against the lease.
 *
 * One value, named rather than derived. `claude` is the productive writer — the
 * process that produces effects in the repository — and it is the only one whose
 * containment says anything about whether a dead lease owner left a writer
 * behind. The reviewer is read-only, so recording its containment as this
 * lease's *writer* evidence would be a record that is simply not true.
 */
const CONTAINED_WRITER: AgentId = 'claude';

/**
 * Whether this run is still the repository's writer, asked now.
 *
 * Exported since V4's verification-attempt evidence, which needs the same
 * question answered at a moment none of the seams below covers. A verification
 * run can take twenty minutes, so the check the *spawn* made is twenty minutes
 * stale by the time its result is written down, and a durable record produced by
 * a run that has stopped being the writer is an artefact from an unauthorised
 * process. The store asks this immediately before its write, which is where
 * every other effect in this module asks it.
 *
 * It is a predicate, never an authorisation: answering `true` grants nothing and
 * every caller still has its own gates.
 */
export function leaseHolds(deps: SpawnAuthority): boolean {
  return verifyExecutionLeaseHeldFor(deps.lease.repository, deps.lease.evidence).code === 'HELD';
}

/**
 * An agent runner that refuses to start a process this run may not start.
 *
 * Always returns a runner, never `undefined`: a missing seam must not be the
 * one shape that reaches production unfenced.
 */
export function leasedAgent(deps: SpawnAuthority): AgentRunner {
  return async (id, args, cwd, payload, callersHooks) => {
    if (!leaseHolds(deps)) return AGENT_NOT_AUTHORISED;
    // The fence owns the establishment hook, and a caller's is **refused rather
    // than dropped**. Accepting the parameter and silently ignoring it is what
    // this did when `AgentRunner` grew a fifth argument, and silence is the
    // wrong answer: the hook writes this lease's ledger, so a second one would
    // be a second writer of the same generation, and a caller that supplied one
    // would reasonably believe it had been installed.
    if (callersHooks !== undefined) return AGENT_LAUNCH_NOT_RECORDED;
    // Reusing that member rather than adding one: both are "this launch could not
    // be recorded the way this lease needs", both are unavailable-with-no-detail
    // once serialised, and both send the same run to the same human decision. It
    // is the second producer, and the member's own doc says so.
    // Announced before it happens, for the reason `beginWriterLaunch` gives: a
    // record written afterwards cannot describe a launch that was killed, and
    // that launch is the one a recovery has to know about.
    const generation = openWriterGeneration(deps, id);
    if (generation === 'REFUSED') return AGENT_LAUNCH_NOT_RECORDED;

    // ── The establishment mark, and the one thing that must undo it ─────────
    //
    // `ESTABLISHED` proves a recovery only while the launch it names is the last
    // thing that happened under this lease. The moment this call returns, the
    // step goes on to a commit, a verification and a reviewer - all owned, none
    // of them in this ledger - so an entry left `ESTABLISHED` by a launch that is
    // *over* would license removing the lease out from under one of them.
    //
    // So the mark is withdrawn here unless the ending was proved, and no exit
    // from the runner skips it: the ordinary path withdraws inline, because its
    // *answer* decides what this seam returns, and the `finally` below catches
    // the one path that has no return value to decide — a throw. This said the
    // withdrawal was "in a `finally`", which was true when the answer was
    // thrown away and is half the story now.
    // `retractWriterLaunchEstablishment` states the rest, including why
    // `PENDING` is the exact target.
    let settled: 'PROVED' | WithdrawalOutcome | 'UNREACHED' = 'UNREACHED';
    try {
      const result = await (deps.agent ?? runAgentCommand)(id, args, cwd, payload, {
        // The mark that closes U1's dominant case, written while the writer is
        // still running. See {@link markWriterLaunchEstablished}.
        onLaunchEstablished: (attestation) => {
          markWriterLaunchEstablished(deps, id, attestation, generation);
        },
      });
      if (recordWriterContainment(deps, id, result, generation) === 'CONFIRMED') {
        settled = 'PROVED';
        return result;
      }
      // The withdrawal's answer is **consumed**, and this is the whole of M2
      // slice 1's remaining fix. It used to be discarded here, on the argument
      // that a failed publish had already fallen back to discarding the history.
      // That argument covers two of the three endings and not the third: when
      // the publish *and* the discard both fail, the affirmative entry is still
      // on disk, still bound to this live lease, and still readable as
      // `LAUNCHES_CONTAINED_SOME_UNENDED`. Measured, through this seam, with a
      // real share-locked ledger: the run got the ordinary writer result back
      // and `assessStaleLeaseRecovery` answered `SAFE_TO_RECOVER` for a lease
      // whose owner was about to commit, verify and review under it.
      // The fail-closed value goes down FIRST, and it is not tidiness. Without
      // it, a throw out of the withdrawal would leave `settled` at `UNREACHED`
      // and the `finally` would call the same destructive path a second time,
      // with its exception replacing the first. That made this scheme depend on
      // `retractWriterLaunchEstablishment` never throwing — a promise its
      // neighbours make in so many words and it does not. Now it depends on
      // nothing: a throw from here leaves the conservative answer standing and
      // propagates, which stops the step by itself.
      settled = 'STALE_MARK_STANDS';
      const outcome = withdrawWriterLaunchEstablishment(deps, id, generation);
      settled = outcome;
      // Allow-list at this level too, not `!== 'STALE_MARK_STANDS'`: a fourth
      // outcome added to the type without a decision here must refuse rather
      // than be waved through, which is the same rule the mapping itself keeps.
      return outcome === 'WITHDRAWN' || outcome === 'LEASE_NO_LONGER_THIS_RUNS'
        ? result
        : AGENT_LAUNCH_NOT_WITHDRAWN;
    } finally {
      // The throw path, and the only one this `finally` still owns: a throw out
      // of the runner or the recorder, before the line above ran. Its answer
      // cannot be consumed, because there is no return value on this path. The
      // throw is what stops the step, and a caller that swallows it is outside
      // what this seam can reach — no such caller exists between here and the
      // CLI today, and that is a measurement of this build rather than a
      // guarantee about the next one.
      if (settled === 'UNREACHED') withdrawWriterLaunchEstablishment(deps, id, generation);
    }
  };
}

/**
 * What a withdrawal left on disk, as the one question a caller may act on.
 *
 * Two values rather than `WRITER_LAUNCH_CODES` itself, because the caller's
 * question is not *what happened* but *may this run carry on*. Narrowing it
 * here is what makes the mapping a decision somebody wrote down rather than a
 * comparison somebody may forget; it lives in
 * {@link withdrawWriterLaunchEstablishment} and it is deliberately total.
 */
type WithdrawalOutcome = 'WITHDRAWN' | 'LEASE_NO_LONGER_THIS_RUNS' | 'STALE_MARK_STANDS';

/**
 * Withdraws this generation's establishment mark, unless its ending was proved.
 *
 * Runs after every writer launch that did not reach `CONTAINED`, and before
 * anything else of this run can start. The header of
 * {@link retractWriterLaunchEstablishment} carries the reasoning; what belongs
 * here is why it is *this* seam's job: this is the only place that knows both
 * that a writer launch is over and that the lease is still this run's, and it is
 * the last instruction before control returns to a step that will start
 * subprocesses this ledger does not describe.
 *
 * ── Its result is consumed, and that is not what this used to say ─────────
 *
 * It said the result was discarded like its siblings', because a withdrawal
 * that could not be published had already fallen back to discarding the
 * history, which asserts nothing at all — and a run is not failed by an
 * enrichment. It then named the leftover as a residual: if the withdrawal *and*
 * the discard both fail, an affirmative entry stays on disk, and the next
 * `beginWriterLaunch` would meet the same broken directory and refuse.
 *
 * The first half of that is right and the second half was the defect. The next
 * `beginWriterLaunch` is the next **writer launch**, and what follows a writer
 * is a commit, a verification and a reviewer — none of which opens a generation,
 * so none of which meets that gate. The run therefore carried straight on with
 * an entry on disk claiming a proof it no longer had. It was reproduced through
 * this seam rather than argued: a real share-locked ledger made the rename
 * answer `EPERM` and the unlink answer `EBUSY`, the entry stayed `ESTABLISHED`,
 * the reading stayed `LAUNCHES_CONTAINED_SOME_UNENDED`, and the recovery
 * predicate answered `SAFE_TO_RECOVER`.
 *
 * So the answer is now the caller's to act on, and the mapping below is what it
 * means rather than what it was.
 *
 * ── The mapping, and why everything else refuses ───────────────────────────
 *
 * Exactly two outcomes **prove** nothing affirmative is on disk, and they are
 * the two the ledger's own vocabulary calls successes of *state* rather than of
 * writing. Not the only two that leave nothing — `GENERATION_NOT_OPEN` with a
 * reading of `ABSENT` or `NOT_PRESENT` leaves nothing either, and is refused,
 * because a caller cannot tell that from the answer:
 *
 *  - `RETRACTED` — the entry is `PENDING`, which is where this build left such
 *    a launch before the middle mark existed. Includes `ALREADY_PENDING`, where
 *    the establishment mark never landed and there was nothing to withdraw;
 *  - `HISTORY_DISCARDED` — the file is gone. A worse outcome for this lease,
 *    which can now never be recovered, and a safe one: nothing asserts anything.
 *
 * Two more permit continuation for a different reason, and they are not a
 * softening of the rule — they are the rule read exactly. `NOT_OWNER` and
 * `LEASE_ABSENT` say the lease at that path is not this run's, or that there is
 * none. The mark may well still be on disk, and it is then **unreadable to
 * every future recovery**: a recovery derives its subject from the lease
 * document beside the ledger, so no document means no reading at all, and a
 * different document means a different `ownerNonce` and therefore
 * `NOT_THIS_LEASE`. The hazard this refusal exists for is a stale mark bound to
 * a *live* lease, and that is precisely what these two answers rule out. The
 * run is not left running either: `leaseHolds` asks the same document through
 * the same gate, so `leasedGit` and `leasedVerify` refuse and
 * `advanceTaskState` refuses after them.
 *
 * Refusing them instead was measured and rejected. It broke an existing
 * guarantee in `tests/v3-10-quota-checkpoint.test.ts`: a lease released *inside*
 * the writer turned a quota block into `HUMAN_DECISION_REQUIRED` before
 * `settleQuotaInterruption` could run, so the case that proves the commit was
 * attempted and refused (`GIT_UNAVAILABLE`) stopped reaching the commit at all.
 * The refusal is aimed at one hazard; making it fire where that hazard cannot
 * exist cost an unrelated path its instrument.
 *
 * Everything else refuses, **including codes this function does not name** —
 * the same default, and for the same reason, as {@link openWriterGeneration}
 * one screen down. `LAUNCH_MUST_NOT_START` is the measured case above.
 * `LEASE_UNREADABLE` is the sharp one and is deliberately *not* with the two
 * above: something is at the lease path and could not be read, so the lease may
 * still be this run's and the mark may still be live — and a later `leaseHolds`
 * that reads it successfully would let the commit through. Nothing here
 * produces that code, so it is unpinned defence rather than a measured arm.
 * `GENERATION_NOT_OPEN` carries a reading — `MALFORMED`, `NOT_THIS_LEASE` —
 * that says this call could not tell what is on disk. None of them is a proof
 * of absence, and a code added to `WRITER_LAUNCH_CODES` without a decision here
 * must fall to the safe side rather than be waved through.
 *
 * The two early returns are `WITHDRAWN` and are not an exception to that: a
 * non-writer agent and a `null` generation are launches with no entry in this
 * ledger at all, so there is no affirmative mark of theirs to stand.
 */
function withdrawWriterLaunchEstablishment(
  deps: SpawnAuthority,
  id: AgentId,
  generation: number | null,
): WithdrawalOutcome {
  if (id !== CONTAINED_WRITER || generation === null) return 'WITHDRAWN';
  const withdrawn = retractWriterLaunchEstablishment(
    deps.lease.repository,
    deps.lease.evidence,
    { generation, writerId: id },
  );
  if (withdrawn.code === 'RETRACTED') return 'WITHDRAWN';
  if (withdrawn.code === 'HISTORY_DISCARDED') return 'WITHDRAWN';
  if (withdrawn.code === 'NOT_OWNER') return 'LEASE_NO_LONGER_THIS_RUNS';
  if (withdrawn.code === 'LEASE_ABSENT') return 'LEASE_NO_LONGER_THIS_RUNS';
  return 'STALE_MARK_STANDS';
}

/**
 * Opens this lease's next writer generation, or refuses the launch.
 *
 * Answers a generation number when one is on disk, `null` when there is nothing
 * to confirm afterwards, and `'REFUSED'` when the launch must not happen.
 *
 * ── One of the two places a recording failure may stop productive work ─────
 *
 * It said "the one place", and its twin is {@link
 * withdrawWriterLaunchEstablishment} above: this one refuses a launch that
 * cannot be written down, that one refuses to carry on from a launch whose mark
 * could not be taken back. Same hazard, same code, opposite ends of the launch.
 *
 * Slice 4 settled that a failed containment record must never fail a run, and
 * that stays true: the *record* is an enrichment. This is not the same thing.
 * The launch history is the input to a decision that removes somebody's lease,
 * and the hazard it has is not a missing entry — it is a **stale affirmative
 * one**. If generations 1..N-1 are on disk as `CONTAINED` and generation N
 * launches without being written down, that history reads as a complete proof
 * and is a lie, and a later recovery removes a lease under a writer tree that
 * may still be running.
 *
 * `beginWriterLaunch` has one fallback for that — delete the history, which
 * asserts nothing — and answers `HISTORY_DISCARDED`, which is `null` here: the
 * launch proceeds and this lease is simply never recoverable. Only when even
 * that is impossible does the launch lose.
 *
 * Everything that is not one of those two successes refuses, including codes
 * this function does not name. That default is the point: a code added to
 * `WRITER_LAUNCH_CODES` without a decision here refuses the launch rather than
 * being waved through, which is the direction a fail-closed contract has to
 * fail in.
 */
function openWriterGeneration(deps: SpawnAuthority, id: AgentId): number | null | 'REFUSED' {
  if (id !== CONTAINED_WRITER) return null;
  const opened = beginWriterLaunch(deps.lease.repository, deps.lease.evidence, {
    writerId: id,
    now: deps.containmentNow ?? (() => new Date().toISOString()),
  });
  if (opened.code === 'OPENED') return opened.generation;
  if (opened.code === 'HISTORY_DISCARDED') return null;
  return 'REFUSED';
}

/**
 * Records that the kernel placed this writer launch in the owner's job, while
 * the writer is still running.
 *
 * ── Why this call exists, and what it is worth ─────────────────────────────
 *
 * Without it, the whole of a writer's runtime — minutes, and the largest window
 * in a run — is on disk as `PENDING`, which proves nothing. A real reproduction
 * killed an orchestrator in that window and measured the result: the writer tree
 * was gone, and no product command could say so, so the repository stayed
 * locked. That is M1's `U1`, and this line is what closes its dominant case.
 *
 * ── Deliberately not a claim about the ending ──────────────────────────────
 *
 * `attestWriterLaunchEstablished` writes `ESTABLISHED`, never `CONTAINED`, and
 * the difference is the whole safety argument: this runs while the writer is
 * alive, so it cannot say the tree has ended, and a recovery reading it must
 * re-establish that separately. {@link recordWriterContainment} below is still
 * the only call that says a launch ended, and it still runs after the run.
 *
 * ── And it still cannot fail the run ───────────────────────────────────────
 *
 * The result is discarded for the same reason its sibling's is. A generation
 * that stays `PENDING` because this could not be published is exactly the
 * conservative state the format already handles: less is proved, nothing untrue
 * is asserted, and the launch that is already running is not stopped by an
 * enrichment. The lease is re-proved inside the recorder, against the bytes it
 * opens, so a run that lost its lease during establishment writes nothing.
 */
function markWriterLaunchEstablished(
  deps: SpawnAuthority,
  id: AgentId,
  attestation: ContainmentAttestation,
  generation: number | null,
): void {
  // `null` is the deliberate "there was nothing to confirm" answer from
  // `openWriterGeneration` — a discarded history, or a non-writer agent — and
  // both are launches this ledger does not describe.
  if (id !== CONTAINED_WRITER || generation === null) return;
  attestWriterLaunchEstablished(deps.lease.repository, deps.lease.evidence, attestation, {
    generation,
    writerId: id,
    now: deps.containmentNow ?? (() => new Date().toISOString()),
  });
}

/**
 * Brings this lease's containment record into line with the launch that just
 * finished: publishes one when the writer was contained, removes the previous
 * one when it was not.
 *
 * ── Why here, and why after the run ────────────────────────────────────────
 *
 * This is the one place that holds both halves at once: the lease authority,
 * which says whose lease it is, and the writer's result, which carries the
 * attestation. Neither layer below has the other — `doctor/exec.ts` must not
 * learn about leases, and `execution-lease.ts` must not learn about agents — so
 * threading the artefact up to the seam is what keeps the two vocabularies
 * apart.
 *
 * After the run rather than before it, because the attestation does not exist
 * until the boundary has ended and been classified.
 *
 * ── Why an unattested launch *removes* the record ──────────────────────────
 *
 * Because otherwise it lies, and an adversarial review reproduced the lie. A run
 * makes several `claude` launches under one lease. Publishing only on success
 * meant a launch that could not be attested left the *previous* launch's
 * positive record standing, and the lease then read `CONTAINED` — and
 * `containmentProven: true` — while its most recent writer was not contained at
 * all.
 *
 * This paragraph used to say the opposite: that such a run "carries no evidence
 * for that run… a later recovery reading that lease finds `ABSENT` and must
 * refuse". It found `CONTAINED`. The removal is what makes the sentence true,
 * and `lease/containment-evidence.ts` states exactly how far that gets — the
 * record describes the most recent launch and cannot speak for the ones before
 * it.
 *
 * The gap that remains is the one the ordering cannot close: an owner that dies
 * *during* a writer run leaves whatever the previous launch left. That is why
 * the record is not, and must not be read as, a statement about the lease.
 *
 * ── It cannot fail the run ─────────────────────────────────────────────────
 *
 * The result is deliberately discarded. This is an enrichment: a lease with no
 * record is a lease with no containment proof, which is exactly what the reader
 * assumes by default. Turning a failed write into a failed agent run would give
 * an enrichment the power to stop productive work, which is the wrong severity —
 * and neither entry point throws, so there is nothing here to catch.
 *
 * The lease is re-proved *inside* the recorder, against the bytes it opens, so a
 * run that lost its lease during the agent process writes nothing. This function
 * does not re-check it beforehand, on purpose: a check here and an effect there
 * would be two readings of one question, which is the defect this module's
 * neighbours keep finding.
 */
function recordWriterContainment(
  deps: SpawnAuthority,
  id: AgentId,
  result: AgentCommandResult,
  generation: number | null,
): 'CONFIRMED' | 'NOT_CONFIRMED' {
  // The answer is what the *caller* needs, not what this function writes. Only
  // `CONFIRMED` means the launch's ending is proved on disk; everything else -
  // an agent that is not the writer, an unattestable ending, a confirmation that
  // would not publish - leaves an establishment mark that has to be withdrawn.
  // Returning the containment record instead, as this did, made "was the ending
  // proved" a question no caller could ask.
  if (id !== CONTAINED_WRITER) return 'NOT_CONFIRMED';
  // The registry gate, not `!== undefined`. A result carrying an explicit
  // `null`, or anything else a JS consumer or a JSON round trip can produce, is
  // not an attestation — and asking the mint is the same discipline
  // `doctor/exec.ts` applies one layer down, rather than a second, weaker test
  // of the same thing.
  //
  // And the negative arm is not a shortcut back to `return null`: a writer
  // launch this build cannot attest must take the previous launch's record with
  // it. See the header.
  if (!isContainmentAttestation(result.containment)) {
    // The generation opened above is deliberately **not advanced here**. That is
    // not an omission and there is no arm that closes it: an unattested ending
    // is exactly the ending a recovery must not read as an ending, and the
    // entry as it stands is the only durable trace of what happened. Slice 4's
    // record is removed for its own reason — it would otherwise keep describing
    // the launch before this one — and the two are different obligations.
    //
    // ── The generation goes back to `PENDING`, and the caller does it ───────
    //
    // A draft of this slice argued that an unattested ending "takes nothing
    // away" from an `ESTABLISHED` entry, because that state claims containment
    // rather than an ending. That is true of the *entry* and false of what it
    // then licenses: the run continues from here into a commit, a verification
    // and a reviewer, none of which this ledger records, so an entry left
    // standing would let a later crash remove the lease out from under one of
    // them. A review found it before it shipped.
    //
    // The withdrawal is `leasedAgent`'s - see
    // {@link withdrawWriterLaunchEstablishment}. This arm reports the failure to
    // prove and does not act on it; the caller acts on it twice over, by
    // withdrawing the mark and then by refusing to return the writer's result
    // if the withdrawal could not neutralise it. This said the withdrawal
    // happened "in a `finally`, so a throw cannot skip it", which named the
    // throw path only: the ordinary path - and this arm is the ordinary path -
    // withdraws inline, because its answer decides what the seam returns.
    clearContainmentEvidence(deps.lease.repository, deps.lease.evidence);
    return 'NOT_CONFIRMED';
  }
  const now = deps.containmentNow ?? (() => new Date().toISOString());
  let confirmed = false;
  if (generation !== null) {
    // Named back rather than re-derived. `confirmWriterLaunch` refuses a
    // generation that is not open, so a result discarded here is a generation
    // that stays unproven — which is the safe direction and needs no handling.
    // The result is READ now, and that is the whole of the fix a review asked
    // for. It used to be discarded, so a confirmation that could not be
    // published left an `ESTABLISHED` entry standing and nobody knew - which is
    // the state that licensed removing a lease under a later, unrecorded
    // subprocess. A generation this call did not prove is withdrawn by the
    // caller.
    confirmed =
      confirmWriterLaunch(deps.lease.repository, deps.lease.evidence, result.containment, {
        generation,
        writerId: id,
        now,
      }).code === 'CONFIRMED';
  }
  // Slice 4's record is still an enrichment and still cannot fail a run, so its
  // result is still discarded. It is a different obligation from the ledger's.
  recordContainmentEvidence(deps.lease.repository, deps.lease.evidence, result.containment, {
    writerId: id,
    now,
  });
  return confirmed ? 'CONFIRMED' : 'NOT_CONFIRMED';
}

/**
 * A Git runner that refuses to touch the repository when this run is no longer
 * its writer.
 *
 * Handed to `commitTaskWork`, so the reads that decide *whether* to commit and
 * the commit itself are fenced by one authority: a run that has lost the lease
 * must not even ask, because the answer would be used to justify a write it may
 * not make.
 *
 * `UNAVAILABLE` is the seam's existing vocabulary for "no process ran, and
 * nothing it printed is evidence of anything". Every caller in the commit path
 * already treats that as a refusal, so a lost lease stops the commit with the
 * step that failed named, rather than being mistaken for a repository that had
 * nothing to record.
 */
export function leasedGit(deps: SpawnAuthority & { readonly git?: GitRunner }): GitRunner {
  return async (cwd, args) => {
    if (!leaseHolds(deps)) return GIT_NOT_AUTHORISED;
    return (deps.git ?? runGitCommand)(cwd, args);
  };
}

/** The same, for the verification seam. See {@link leasedAgent}. */
export function leasedVerify(deps: SpawnAuthority): VerificationRunner {
  return async (command, args, cwd) => {
    if (!leaseHolds(deps)) return VERIFICATION_NOT_AUTHORISED;
    return (deps.verify ?? runVerificationCommand)(command, args, cwd);
  };
}

/**
 * What a seam answers when this run is no longer the repository's writer.
 *
 * `UNAVAILABLE` is the vocabulary both seams already have for "the process
 * never started, and nothing it printed is evidence of anything". The step then
 * tries to record something and `advanceTaskState` refuses that too, so the run
 * stops with `EXECUTION_LEASE_LOST` and no durable trace.
 */
export const AGENT_NOT_AUTHORISED: AgentCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  failureCode: null,
  errnoCode: null,
  durationMs: 0,
});

/**
 * What the agent seam answers when a writer launch could not be written down.
 *
 * A **distinct object** with the same fields as {@link AGENT_NOT_AUTHORISED},
 * and the difference is reference identity only: once serialised the two are
 * indistinguishable, so a reader of a transcript cannot tell them apart. An
 * earlier version of this paragraph claimed they could, which a review measured
 * as false field by field.
 *
 * What the distinct object buys is that the *seam's own* callers and tests can
 * name which refusal happened, and that a future author adding a field to one
 * does not silently add it to the other. It is deliberately **not** given a
 * `failureCode`: that union is `doctor/exec.ts`'s vocabulary about what became of
 * a *command*, and a lease-shaped member in it would push the lease down into
 * the layer this module exists to keep it out of.
 */
export const AGENT_LAUNCH_NOT_RECORDED: AgentCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  failureCode: null,
  errnoCode: null,
  durationMs: 0,
});

/**
 * What the agent seam answers when a writer launch really ran, ended without a
 * proof of its ending, and its establishment mark could not be taken back.
 *
 * A **third distinct object** with the same fields as its two neighbours, on the
 * terms their own doc sets out: once serialised the three are indistinguishable,
 * and what the separate identity buys is that this seam's callers and tests can
 * name which refusal happened.
 *
 * ── What it costs, stated rather than left to be discovered ────────────────
 *
 * `UNAVAILABLE` is read one layer up as "the process never reached its own end"
 * (`agent/claude-writer.ts`), and here that is **not literally true**: the writer
 * ran. The consequence is deliberate and it is the whole point — the step ends
 * at `recordInterruption` instead of going on to measure scope, commit, verify
 * and review.
 *
 * The price is higher than "a lost pass", which is what this said, and the
 * commit that said it also measured the opposite. `AGENT_PROCESS_UNAVAILABLE`
 * carries the disposition `AGENT_NEEDS_ATTENTION`, so `recordAgentInterruption`
 * **does** make a durable move — to `HUMAN_DECISION_REQUIRED`, which
 * `core/resume-policy.ts` marks `automaticResumeEligible: false` and which this
 * loop does not drive. So there is no next pass: the task stops until an
 * operator continues it by hand, and the writer's edits sit uncommitted in the
 * worktree meanwhile. `tests/v2-07l-execution-lease.test.ts` asserts that state
 * by name.
 *
 * One case is sharper still. A writer refused for quota ends with an
 * attestation, so it can reach this refusal — and `endedUnderOwnControl` is
 * asked *above* the usage-limit check, so a block that would have parked at
 * `BLOCKED_USAGE_LIMIT` (the one state a timer may resume, and the one whose
 * settlement commits the partial work) parks here instead. That is the right
 * direction — nothing may be committed while the ledger cannot be written — and
 * it converts a self-clearing pause into a human-only stop, which is a cost this
 * paragraph owes the reader rather than one to discover in an incident.
 *
 * The trade is still the one to make. A stopped run is recoverable by a person;
 * a lease removed out from under a live commit is not recoverable at all.
 */
export const AGENT_LAUNCH_NOT_WITHDRAWN: AgentCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  failureCode: null,
  errnoCode: null,
  durationMs: 0,
});

/** The Git seam's equivalent of {@link AGENT_NOT_AUTHORISED}. */
export const GIT_NOT_AUTHORISED: GitCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  stdout: '',
  exitCode: null,
});

/** The verification seam's equivalent of {@link AGENT_NOT_AUTHORISED}. */
export const VERIFICATION_NOT_AUTHORISED: VerificationCommandResult = Object.freeze({
  outcome: 'UNAVAILABLE' as const,
  exitCode: null,
  signal: null,
  stdout: '',
  stderr: '',
  outputTruncated: false,
  failureCode: null,
  errnoCode: null,
  durationMs: 0,
});
