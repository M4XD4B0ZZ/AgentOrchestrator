/**
 * `agent-loop delivery` — the delivery surface (V4 slices 2 to 11).
 *
 * ── Why a command of its own, and why the network is a flag on it ──────────
 *
 * `run` is read-only by default and executes only when `--attended` says so.
 * This command copies that shape one level down: it is **local** by default and
 * contacts a forge only when a flag says so. It stopped being a read-only
 * surface at V4 slice 5, and the sentences on it were corrected then rather
 * than left to be discovered — which had to happen again at slice 6. Every
 * "the only" that survives on this surface is one somebody has to re-read when
 * a flag is added; a review found one that had not been, and it was wrong for a
 * second reason as well. The two properties that matter are structural rather
 * than documented:
 *
 *  - `agent-loop run` gained nothing. It resolves a delivery target — that is
 *    slice 1, and it is local Git — and it has no path to this module at all.
 *    No existing command became a networking command;
 *  - with none of the contacting flags this command builds a subject and stops.
 *    There is no branch on which a client is constructed, so "nothing was
 *    contacted" is a fact about the code rather than a promise in help text.
 *
 * ── The three acts, and why they are three ─────────────────────────────────
 *
 * `--publish-head` creates one branch on the delivery remote. `--create-pr`
 * opens one pull request from that branch. `--merge-pr` merges that pull
 * request. Each requires `--attended`, each takes its own authority, and **none
 * implies another**: a published head is not permission to open a pull request,
 * the pull-request authority cannot push, and neither of them can merge. The
 * three authorities are three separate opaque types, and substituting one for
 * another is a compile error rather than a runtime refusal.
 *
 * They are run in that order when more than one is asked for, and that is
 * necessary without being sufficient. **On a first delivery they do not compose
 * in one invocation**, and the reason is the same each time: the observation
 * runs before any of the acts, so the decision they gate on describes the world
 * as it was before this invocation changed it.
 *
 * Measured for the first pair: `--observe` runs before the publication, the
 * forge has never seen the commit, `commits/{sha}/pulls` answers `422 "No commit
 * found for SHA"`, and the decision is `OBSERVATION_UNSETTLED` — so the creation
 * is refused after the branch has been created. `L-V4-06-10` records it.
 *
 * The same shape closes the second pair, and more tightly: `--merge-pr` admits
 * only `PULL_REQUEST_MATCHED_CHECKS_SUCCESS`, which asserts a pull request
 * already matched this commit, so it cannot be true in the invocation that opens
 * one. The merge is refused before anything is contacted. `L-V4-07-1` records
 * it. Publish, then create, then merge — three invocations.
 *
 * ── What it will not do ────────────────────────────────────────────────────
 *
 * It writes no task state and starts no agent. It takes the execution lease on
 * exactly one path — `--verify-merge`, which starts this repository's own build
 * and test commands in a detached checkout, and which `--drive` reaches when a
 * delivery needs a verdict about its merge commit; that is V4 slice 9's
 * widening, and it lives in `delivery-steps.ts` rather than here.
 * It never updates, closes, reopens, marks ready or draft,
 * comments on, labels or reviews a pull request, never enables an auto-merge and
 * never enters a merge queue, and there is no flag that would. `READY_FOR_PR` is
 * still terminal, and delivering a task at that state — including merging its
 * pull request — changes nothing about the task. After a merge this build still
 * reports `READY_FOR_PR` while GitHub reports the pull request as merged; that
 * mismatch is deliberate and is the next slice's subject.
 *
 * It also does not answer "may this be merged", and `--merge-pr` does not change
 * that. It reports facts about one commit and stops there: reviews, branch
 * protection and repository rules are not observed at all, and — measured —
 * their surfaces cannot be told apart from "you may not read them". What
 * authorises a merge is an operator saying so for one invocation; what enforces
 * it is GitHub. Opening a pull request is still not that decision, and neither
 * is this build's willingness to send the request.
 */

import type { Command } from 'commander';
import { attestDeliveryObservation, concludeObservation, observeDelivery, resolveObservationSubject, type DeliveryObservation, type SubjectResolution } from '../deliver/observe-delivery.js';
import { loadDeliveryEvidence, recordDeliveryEvidence, type DeliveryEvidenceRecordCode } from '../deliver/delivery-evidence-store.js';
import { concludeDeliveryDecision, type DeliveryDecision, type SubjectRevalidation } from '../deliver/delivery-decision.js';
import type { DeliveryObservationProof } from '../deliver/delivery-observation-proof.js';
import { runGitCommand } from '../worktree/git-command.js';
import { createForgeCommandRunner } from '../deliver/github-observer.js';
import { resolveRepository } from '../repo/resolve-repository.js';
import { loadTaskState } from '../state/state-store.js';
import { renderDeliveryObservation } from './render-delivery-observation.js';
import { exitCodeForConclusionRecord, exitCodeForDrive, exitCodeWithLeaseRelease, EXIT_RUN_INPUT_UNUSABLE, EXIT_RUN_OK, EXIT_RUN_REFUSED, type CliExitCode } from './run-exit-codes.js';
import { driveDelivery, refuseDeliveryDrive } from './delivery-driver.js';
import {
  createRuntimeIgnoreProbe,
  performObservation,
  performConclusion,
  performCreation,
  performMerge,
  performPublication,
  performReconciliation,
  performVerification,
  publishableRef,
  revalidateLocalSubject,
} from './delivery-steps.js';
import type {
  DeliveryCommandSeams,
  DeliveryOptions,
} from './delivery-steps.js';

// Re-exported because `registerDeliveryCommand` names it: a caller typing the
// seams object should not have to know which module the ladders moved to.
export type { DeliveryCommandSeams } from './delivery-steps.js';

/**
 * Every way `--record` can end, beside the store's own codes.
 *
 * These are the refusals decided *by the command*, before the store is reached.
 * They exist as their own vocabulary because "you did not ask for an
 * observation" and "the observation did not settle" send an operator to
 * different places, and neither is a failure of the store.
 */
export const RECORD_REFUSALS = [
  /** `--record` without `--observe`. Nothing was contacted and nothing was written. */
  'RECORD_REQUIRES_OBSERVATION',
  /** No subject could be established, so there was nothing to observe or record. */
  'RECORD_WITHOUT_SUBJECT',
  /** The observation did not settle both questions. Nothing is established to record. */
  'RECORD_WITHOUT_SETTLED_OBSERVATION',
  /** The task's durable record could not be re-read to bind the evidence to. */
  'RECORD_WITHOUT_TASK_BINDING',
] as const;

export type RecordRefusal = (typeof RECORD_REFUSALS)[number];

export const RECORD_REFUSAL_DETAIL: Readonly<Record<RecordRefusal, string>> = Object.freeze({
  RECORD_REQUIRES_OBSERVATION:
    'Recording stores an observation, so one has to be made. Pass --observe as well.',
  RECORD_WITHOUT_SUBJECT: 'There was no subject to ask about, so there is nothing to record.',
  RECORD_WITHOUT_SETTLED_OBSERVATION:
    'At least one question was not answered, so no observation was established to record.',
  RECORD_WITHOUT_TASK_BINDING:
    'The task record could not be read, so evidence could not be bound to it.',
});

/**
 * The flag's own sentence, exported so it can be pinned by literal.
 *
 * It used to end "it asks about one commit and nothing else" — the identical
 * over-claim that was withdrawn from `CONTACTED_TRAILER`, left standing on the
 * surface an operator reads *before* running the command, and pinned by
 * nothing. Two strings made the same promise and only one was corrected.
 *
 * It happened a second time, and the literal pin did not stop it. Slice 5 made
 * "this is the only way this build contacts a forge" and "without this flag
 * nothing leaves this machine" both false, and a test asserting the exact
 * string went on passing — because a literal proves what a sentence says, never
 * that it is true. The lesson is not that the pin is wrong; it is that a
 * sentence naming *the* way to do something has to be re-read by any slice that
 * adds a second way.
 */
export const OBSERVE_OPTION_DESCRIPTION =
  'Ask github.com about the commit named above, read-only. It asks about no commit but ' +
  'that one. The GitHub CLI additionally makes calls of its own (telemetry, update check) ' +
  'that this build does not suppress. This flag only reads, and it is not the only flag here ' +
  'that reads: every flag that can change something on a forge reads as well, because each ' +
  'establishes what it is about before and after it acts, and --reconcile-merge reads without ' +
  'changing anything there. Contacting a forge is never implicit — with no flag that says it ' +
  'contacts github.com, nothing leaves this machine, though a flag that stores something still ' +
  'writes a record beside the task, here.';

/**
 * The record flag's own sentence, exported so it can be pinned by literal.
 *
 * Every clause is load-bearing. "A record of one past moment" is the whole
 * semantic contract of the slice, and it is stated on the surface an operator
 * reads *before* running the command rather than only in the report afterwards.
 * "Grants nothing" is there because a durable green check state is exactly the
 * artefact somebody will later be tempted to treat as permission.
 */
export const RECORD_OPTION_DESCRIPTION =
  'Store the observation as a durable record for this task, beside its task state. Requires ' +
  '--observe, and stores nothing unless both questions were answered. What is stored is a ' +
  'record of one past moment: it does not stay true, it is never re-read as the forge\'s ' +
  'current state, and it grants nothing — no merge, no pull request, no task state change. ' +
  'Replaces any previous record for this task.';

/**
 * The decide flag's own sentence, exported so it can be pinned by literal.
 *
 * "From this invocation's own answers" is the whole freshness contract, stated
 * on the surface an operator reads before running the command. "Does not
 * establish merge eligibility" is there because a one-word verdict is exactly
 * the artefact somebody will later be tempted to read as permission — and
 * because, measured, this build cannot establish it: the branch-rule endpoints
 * answer the same way for "there are none" as for "you may not read them".
 */
export const DECIDE_OPTION_DESCRIPTION =
  'Classify this invocation\'s own answers into one delivery decision. Requires --observe: a ' +
  'stored record can never produce a decision, so once a subject exists and nothing was ' +
  'contacted the answer is NOT_DECIDED. The local subject is re-read after the answers come ' +
  'back and the decision is refused if it moved. This does not establish merge eligibility — ' +
  'draft state, mergeability, reviews and branch rules are not observed, and their absence is ' +
  'not provable from what GitHub returns. Writes nothing.';

/**
 * The flag that names the act, and the only one in this build that can change
 * something on a forge.
 *
 * Spelled after what it does. It is not `--push`, because what is published is
 * one ref at one object name and never the local branch's current tip; and it
 * is not `--publish`, because a bare verb would grow to mean whatever the next
 * slice wants published.
 */
export const PUBLISH_HEAD_OPTION_DESCRIPTION =
  'Create the task\'s work branch on the delivery remote, at exactly its pinned commit. ' +
  'Requires --attended and a task at READY_FOR_PR. Create-only: the ref is written under a ' +
  'compare-and-swap that refuses an existing ref, so a branch already there is never moved, ' +
  'rewritten or deleted — whatever it holds. Idempotent by observation: the remote is read ' +
  'before and after, a ref already at this commit is reported and not pushed to, and an ' +
  'attempt whose result was lost is never repeated blindly. This opens no pull request and ' +
  'grants no authority to open or merge one. It writes no task state.';

/**
 * The flag that names the second act this build can perform on a forge.
 *
 * Spelled after what it does, and narrowly. It is not `--pr`, which would grow
 * to mean whatever the next slice wants done to one, and it is not `--deliver`,
 * which would name an outcome rather than an act. Creating is the whole of it:
 * there is no flag here that updates, closes, reopens, marks ready, comments,
 * labels, requests review or merges, and none of those exists anywhere in this
 * build.
 */
export const CREATE_PR_OPTION_DESCRIPTION =
  'Open one pull request on github.com for this task, from its work branch to its base ' +
  'branch. Requires --attended, --observe and --decide, and a task at READY_FOR_PR whose own ' +
  'fresh decision says this commit was observed and no check on it failed — a stored record ' +
  'can never stand in for that. Only PULL_REQUEST_REQUIRED means one is needed; the other ' +
  'admitted decisions mean one existed a moment ago, and a request is sent only when the ' +
  'reading this flag takes immediately before finds none. The work branch ' +
  'must already exist on the delivery remote at exactly this commit: this flag never pushes, ' +
  'and answers HEAD_NOT_PUBLISHED for a ref that is not there, HEAD_SHA_MISMATCH for one ' +
  'holding another commit. Idempotent by observation: the forge is read before and after, an ' +
  'intended pull request that already exists is reported and not sent for again, and an ' +
  'attempt whose result was lost is never repeated blindly. It updates, closes, reviews and ' +
  'merges nothing, and writes no task state.';

/**
 * The flag that names the third act this build can perform on a forge, and the
 * only one that writes to a branch nobody asked it to touch.
 *
 * Spelled after what it does and after what it does it to. It is not `--merge`,
 * which would be a verb with no object and would grow to mean whatever the next
 * slice wants merged; and it is not `--land` or `--integrate`, which would name
 * an outcome while hiding the act — a flag whose name hides the act is exactly
 * the failure the naming rule exists for.
 *
 * The rule banning `force`, `unattended`, `adopt`, `takeover` and `steal` in a
 * registered option name is unchanged. `merge` was in that list too, put there
 * by slice 6 to say this build could not merge. This slice makes that false, so
 * the word leaves the list and the option set is pinned by exact enumeration
 * instead, so a new mutation flag cannot arrive unnamed whatever it is called.
 * An earlier draft said "a sixth", which counts nothing. Two later drafts said
 * "nine options" and then "ten options", and each went stale at the next slice
 * — the third time a review caught this same sentence. So it states **no count
 * at all** now: the registered set is pinned by exact enumeration in
 * `tests/v4-07-…`, and how many of them are forge mutations is measured by the
 * effect-boundary cases in each slice's own file rather than tallied here. A
 * number written beside a list a test already enforces is a number nothing
 * enforces.
 */
export const MERGE_PR_OPTION_DESCRIPTION =
  'Merge this task\'s pull request on github.com, by squash, into its base branch. Requires ' +
  '--attended, --observe and --decide, and a task at READY_FOR_PR whose own fresh decision is ' +
  'PULL_REQUEST_MATCHED_CHECKS_SUCCESS: exactly one open pull request at this commit, no check ' +
  'on it failed or is still running, and this commit carries at least one check record — so a ' +
  'repository that runs no checks at all is refused, under CHECKS_ABSENT. It does NOT mean a ' +
  'check succeeded: a commit whose only check was skipped reaches this decision with nothing ' +
  'having succeeded, and would be merged. A stored record can never stand in for it. This ' +
  'is not merge eligibility — reviews, branch protection and repository rules are not observed, ' +
  'and GitHub is what enforces them; what authorises the act is you. The pull request is the ' +
  'one this invocation observed, never one you name. The request carries the exact head commit ' +
  'observed, and while the pull request is open GitHub refuses it if the head has moved ' +
  'since. Read before and after: an ' +
  'already-merged pull request is reported and nothing is sent, and one that is closed, a ' +
  'draft, at another commit or targeting another base is refused. At most one request per ' +
  'invocation, and an attempt whose result was lost is never repeated blindly. It opens, ' +
  'updates, closes, reviews and reverts nothing, it pushes no branch and deletes none itself — ' +
  'though a repository with delete_branch_on_merge set will have GitHub remove the head branch ' +
  'as a consequence — there is no auto-merge, and it writes no task state — so after a merge this task is still READY_FOR_PR.';

/**
 * The reconciliation flag's own sentence, exported so it can be pinned by
 * literal.
 *
 * Two clauses are load-bearing and both are about what the flag is *not*.
 *
 * The opening one — "reading github.com to establish it and changing nothing
 * there" — separates it from `--merge-pr`, which is the act; this is the
 * bookkeeping afterwards. The other is the sentence beginning "It is not a claim
 * that the commit is on the base branch now", which is the distinction the whole
 * slice turns on: a receipt is an event, not a statement about the base now.
 *
 * It is named by its opening words rather than by its position. A review found
 * this docblock calling it "the closing clause" after an exit-code clause had
 * been appended past it — a pointer that a later edit silently invalidated.
 *
 * This docblock previously quoted a phrase, "Records what GitHub already did",
 * that appears nowhere in the string below. A review found it, and it is worth
 * recording why a quotation in a comment is worse than a paraphrase: it reads
 * as a pin and is not one.
 *
 * It deliberately does not say "requires --attended", because it does not.
 * `--attended` is this build's marker that a person is present for an
 * irreversible effect *outside this machine*, and this flag has none: it reads
 * github.com and writes a receipt here. Requiring it would make the marker mean
 * two different things.
 */
export const RECONCILE_MERGE_OPTION_DESCRIPTION =
  'Record, beside the task state, that this task\'s delivery was merged — reading github.com ' +
  'to establish it and changing nothing there. It finds the pull request by asking which ones ' +
  'carry this task\'s commit as their head, never from a stored number and never from one you ' +
  'name, then reads that pull request and requires it to be merged, at exactly this commit, ' +
  'into exactly this task\'s base branch. Requires a task at READY_FOR_PR: before that its current commit is not a delivery head. ' +
  'It works for a merge performed by anyone — this ' +
  'build, another invocation, or a person — and it never claims AO did it. Writing needs this ' +
  'flag: without it nothing is stored. A receipt already there for the same merge is left ' +
  'alone and nothing is written; one naming a different merge refuses rather than being ' +
  'overwritten. What is stored is one past event — that this pull request was merged and ' +
  'produced that commit. It is not a claim that the commit is on the base branch now, that it ' +
  'has not been reverted, or that anything was verified against it, and it changes no task ' +
  'state: the task is still READY_FOR_PR afterwards. The exit code answers whether the ' +
  'observation settled and never reports this flag, so a refused write is not visible in it. ' +
  'Read the Receipt line.';

/**
 * The verification flag's help text.
 *
 * Like `--reconcile-merge` it deliberately does not say "requires --attended".
 * `--attended` marks a person present for an irreversible effect **outside this
 * machine**, and this flag has none: it reads a receipt, checks out a commit
 * locally and runs the repository's own declared commands. What it does require
 * is the **execution lease**, and that is a different statement — it is about
 * being this repository's writer while a checkout appears and disappears in it,
 * not about somebody watching.
 *
 * It says what it does not claim, at length, because that is the sentence an
 * operator is most likely to over-read: a pass is about a commit at an instant,
 * never about a branch today.
 */
export const VERIFY_MERGE_OPTION_DESCRIPTION =
  "Run this repository's own declared verification commands against the exact merge commit " +
  "named by this task's merge receipt, and record the result beside the task state. The " +
  'subject comes from the receipt and from nowhere else: not from a commit you name, not from ' +
  'the base branch, and never from whatever that branch has since become. Requires a receipt ' +
  '— run --reconcile-merge first — whose recorded head is still this task\'s current commit. ' +
  'It takes this repository\'s execution lease, because it creates and destroys a detached ' +
  'checkout here; this act opens no network connection of its own — though the commands it ' +
  'starts are this repository\'s and may do anything they like — and it will not fetch a merge ' +
  'commit this repository does not already have. The checkout is made in a directory beside ' +
  'the repository, proved to be at exactly that commit before anything runs, and removed ' +
  'afterwards — and if that removal is refused you are told rather than left to find the ' +
  'leftovers; your own working tree is never touched. A run that could not be started is ' +
  'reported as such and never as a failure of the code. Nothing is changed on github.com, no ' +
  'agent is started, no task state and no block ledger is written, and a failing result ' +
  'triggers no revert, no branch and no follow-up. What is stored is one past event — that ' +
  'this commit completed this profile with this result at that instant. It is not a claim ' +
  'that the commit is on the base branch now, that it is still reachable from it, that the ' +
  'merge has not been reverted, or that the base branch passes today. A commit already ' +
  'recorded as passing under the same profile is not run again; a different profile is. The ' +
  'exit code answers whether the observation settled and never carries the verification ' +
  'verdict — but a run that took the lease and cannot prove it gave it back may not exit ' +
  'nominal, whatever its own work came to. Read the Verification, Record and Lease lines.';

/**
 * The end of the delivery lifecycle, and the sentence it may not be read as.
 *
 * The description says what is *joined* rather than what is run, because
 * nothing is run: this flag reads two records and the task, and writes a third
 * record if they agree. The three things an operator is most likely to read
 * into "complete" — that the change is on the branch, that it survived, that
 * the task moved on — are each denied by name.
 */
export const CONCLUDE_DELIVERY_OPTION_DESCRIPTION =
  "Conclude this task's delivery, by joining its merge receipt to its post-merge verification " +
  'history, and record that judgement beside the task state. Requires both — run ' +
  '--reconcile-merge and then --verify-merge first — and requires them to describe one ' +
  'delivery: the same merge commit, the same implementation head, the same repository and the ' +
  'same pull request. The verification must carry a passing standing verdict for that commit ' +
  'under the profile resolved now; a verdict under a different profile answers a different ' +
  "contract and is not enough, and a run that could not be started is not a failure of the " +
  'code and is not counted as one. It reads up to four documents beside the task — any ' +
  'conclusion already recorded, the merge receipt, the verification history and the task ' +
  'state — and writes one. This act starts no process of its own except git check-ignore, ' +
  'twice, before it writes; it opens no network connection of its own, ' +
  'contacts no forge, takes no execution lease, starts no agent, runs no verification, and ' +
  'writes neither task state nor block ledger — READY_FOR_PR stays terminal and the task\'s ' +
  'current commit stays the implementation head, which is a different commit from the merge. ' +
  'What is stored is one past judgement: that at that instant this delivery had happened and ' +
  'the commit it produced was verified. It is not a claim that the merge commit is on the base ' +
  'branch now, that it is reachable from it, that the merge has not been reverted, that its ' +
  'changes are still present, or that the base branch passes today — none of those questions ' +
  'is asked, and no Git history is read. A delivery already concluded is reported as such and ' +
  'nothing is rewritten. The exit code answers whether the observation settled — which for ' +
  'a subject that could not be established is already not nominal — with one addition: a run ' +
  'that concluded the delivery and could not leave that conclusion on disk does not exit ' +
  'nominal either, under the code its own failure earns. Read the Completion and Record lines.';

/**
 * The driver's own sentence, exported so it can be pinned.
 *
 * Pinned by rule rather than by literal, which is what the five rounds this
 * command's help already cost bought: a sentence that enumerates goes stale, a
 * sentence that states a rule does not. What the suite checks is that this text
 * says the three things true of every drive — each act still needs its own flag
 * and `--attended`, at most one act is attempted, nothing waits — and that it
 * names the flags it will not compose with, because that refusal is otherwise a
 * surprise.
 */
export const DRIVE_OPTION_DESCRIPTION =
  'Work out where this task delivery stands and run the acts that stand between it and a ' +
  'conclusion, stopping at the first condition this invocation cannot cross. It adds no act: ' +
  'each of the three that change github.com still needs its own flag and --attended, and a ' +
  'drive given none of them changes nothing there. At most one of those acts is attempted per ' +
  'invocation - the moment one reports an attempt this run stops and the next one reads what ' +
  'happened rather than repeating it. It never waits: a check still running, a pull request ' +
  'nobody has opened and an act nobody authorised are reported and returned from, with no ' +
  'sleep, no loop and no background work. It asks github.com about this commit when it needs ' +
  'to, writes whichever of the merge receipt, the verification history and the conclusion this ' +
  'delivery still needs, and takes the repository execution lease when it verifies the merge ' +
  'commit. A delivery already concluded is answered from the ' +
  'record on disk without contacting github.com, taking the execution lease or running a ' +
  'verification. Not combinable with --observe, --record, --decide, --reconcile-merge, ' +
  '--verify-merge or --conclude-delivery, which name the acts one at a time.';

/**
 * Operator presence, in the shape `release` established.
 *
 * A second, independent statement rather than a widening of the first: one flag
 * says which act, and this one says that a person is present for it. Neither
 * implies the other, and there is no unattended publication — which `--drive`
 * does not change, because it names no act of its own.
 */
export const ATTENDED_OPTION_DESCRIPTION =
  'States that an operator is present for this invocation. Required by every flag here that can ' +
  'change something outside this machine — today --publish-head, --create-pr and --merge-pr. ' +
  'Not a claim ' +
  'about credentials, and not needed by any read-only part of this command. There is no ' +
  'unattended publication, no unattended pull request and no unattended merge.';

export const DELIVERY_COMMAND_DESCRIPTION =
  'Report the delivery target and the exact commit a delivery observation would be about, ' +
  'and — only with --observe — ask github.com two read-only questions about that commit: ' +
  'is there exactly one open pull request whose head is this commit, and what is the check ' +
  'state of this commit. With --record it stores that ' +
  'observation as a historical record beside the task state; without it, nothing is written. ' +
  'With --decide it classifies this invocation\'s own answers into one delivery decision, which ' +
  'is not merge eligibility and grants nothing. With --publish-head and --attended it creates ' +
  'the work branch on the delivery remote at its pinned commit, create-only. With --create-pr ' +
  'and --attended, on top of --observe and --decide, it opens one pull request from that branch ' +
  'to the base branch. With --merge-pr and --attended, on the same footing plus a fresh ' +
  'decision of PULL_REQUEST_MATCHED_CHECKS_SUCCESS, it merges that pull request by squash. ' +
  'Those three are what it can change on a forge; they are separately requested and separately ' +
  'authorised, and none implies another. With --reconcile-merge it reads github.com to establish ' +
  'that this task\'s delivery was merged and stores that one event beside the task state, ' +
  'changing nothing on the forge. With --verify-merge it runs this repository\'s own declared ' +
  'verification commands against the exact merge commit that receipt names, in a detached ' +
  'checkout beside the repository, and stores the result beside the task state. It contacts no ' +
  'forge and opens no network connection of its own; the commands it starts are the ' +
  "repository's, and what those do is the profile's to answer for. " +
  "With --conclude-delivery it joins that receipt to that verification history and stores the " +
  'judgement that this delivery is concluded, reading no network and no Git history. ' +
  'With --drive it works out which of those acts this delivery still needs and runs those, in ' +
  'that order, stopping at the first condition it cannot cross; it adds no act, each act that ' +
  'reaches github.com still needs its own flag and --attended, and at most one of them is ' +
  'attempted per invocation. --drive does not combine with the flags that name the acts one at ' +
  'a time. ' +
  'Contacting a forge is never implicit: with no flag that says ' +
  'it contacts github.com, nothing is read from a network. It writes no task state at all, and ' +
  'the records it writes are written by the flags that ask for them — --record, ' +
  '--reconcile-merge, --verify-merge and --conclude-delivery write one each; --drive writes ' +
  'whichever of those the delivery still needs, which in one invocation can be three. ' +
  'It never updates, closes, ' +
  'reopens, reviews, comments on or labels a pull request, and never enables an auto-merge.';

export function registerDeliveryCommand(program: Command, seams: DeliveryCommandSeams = {}): void {
  const resolve = seams.resolveRepository ?? resolveRepository;
  const load = seams.loadTaskState ?? loadTaskState;

  program
    .command('delivery')
    .description(DELIVERY_COMMAND_DESCRIPTION)
    .requiredOption(
      '--repository <path>',
      'Absolute path of the repository root. Required; never defaulted from the working directory.',
    )
    .requiredOption(
      '--task <id>',
      'The task whose pinned commit is the subject. Required: an observation with no exact ' +
        'commit to be about is not an observation this build makes.',
    )
    .option(
      '--observe',
      OBSERVE_OPTION_DESCRIPTION,
    )
    .option(
      '--record',
      RECORD_OPTION_DESCRIPTION,
    )
    .option(
      '--decide',
      DECIDE_OPTION_DESCRIPTION,
    )
    .option(
      '--publish-head',
      PUBLISH_HEAD_OPTION_DESCRIPTION,
    )
    .option(
      '--create-pr',
      CREATE_PR_OPTION_DESCRIPTION,
    )
    .option(
      '--merge-pr',
      MERGE_PR_OPTION_DESCRIPTION,
    )
    .option(
      '--reconcile-merge',
      RECONCILE_MERGE_OPTION_DESCRIPTION,
    )
    .option(
      '--verify-merge',
      VERIFY_MERGE_OPTION_DESCRIPTION,
    )
    .option(
      '--conclude-delivery',
      CONCLUDE_DELIVERY_OPTION_DESCRIPTION,
    )
    .option(
      '--drive',
      DRIVE_OPTION_DESCRIPTION,
    )
    .option(
      '--attended',
      ATTENDED_OPTION_DESCRIPTION,
    )
    .action(async (options: DeliveryOptions) => {
      const resolution = await resolve({ repositoryPath: options.repository });
      if (!resolution.ok) {
        process.stdout.write(
          `\nRepository   : could not be resolved\n` +
            `Failure      : ${resolution.code} — ${resolution.detail}\n\n`,
        );
        process.exitCode = EXIT_RUN_INPUT_UNUSABLE;
        return;
      }

      const repository = resolution.repository;
      // Read once and keep it. The same load supplies the subject and the
      // revision the evidence is bound to, so the two cannot describe different
      // bytes — reading twice would open a window in which the task advanced
      // between them and the record claimed a revision it was not derived from.
      const taskLoad = load(repository.root, options.task);
      const subject = resolveObservationSubject(repository.delivery, taskLoad);

      // ── The driver, and it is a whole branch rather than a tenth act ──────
      //
      // It works out which acts this delivery still needs and runs those, so it
      // cannot also sit in a list of acts an operator named one by one: the two
      // orderings would both be in force. A run that asks for both is refused
      // before anything is contacted or written.
      //
      // Everything the driver reached renders through the same view fields the
      // flags below fill, so an act it ran prints exactly as it would have
      // under its own flag. The `Drive` block adds the one sentence those
      // blocks cannot say between them.
      if (options.drive === true) {
        const alsoNamed =
          options.observe === true ||
          options.record === true ||
          options.decide === true ||
          options.reconcileMerge === true ||
          options.verifyMerge === true ||
          options.concludeDelivery === true;
        const driven = alsoNamed
          ? refuseDeliveryDrive('DRIVE_NOT_COMBINABLE')
          : await driveDelivery(repository, options, subject, taskLoad, resolve, load, seams);
        process.stdout.write(
          renderDeliveryObservation({
            repositoryId: repository.id,
            repositoryRoot: repository.root,
            taskId: options.task,
            subject,
            observation: driven.observation,
            // The same function the flag path uses, asked about the same two
            // values. A drive that never looked has a subject and no
            // observation, which is exactly what `NOT_OBSERVED` means; spelling
            // that constant here instead would be a second opinion about it.
            conclusion: driven.observationConclusion ?? concludeObservation(subject, null),
            decision: driven.decision,
            publication: driven.publication,
            creation: driven.creation,
            merge: driven.merge,
            reconciliation: driven.reconciliation,
            verification: driven.verification,
            deliveryConclusion: driven.deliveryConclusion,
            drive: {
              outcome: driven.outcome,
              position: driven.conclusionOutcome,
              requiredEffect: driven.requiredEffect,
            },
          }),
        );
        // The driver's own member decides the code, graded one member at a time
        // by `run-exit-codes.ts`, with the conclusion store's grade substituted
        // for the one member that needs it.
        // Both store codes, because the driver has two members whose grade is
        // the store's own rather than a number chosen for them. Passed as named
        // fields rather than one value: two closed vocabularies behind one
        // parameter is a parameter that can take the wrong one.
        const primary = exitCodeForDrive(driven.outcome, {
          conclusion: driven.deliveryConclusion?.record?.code ?? null,
          receipt: driven.reconciliation?.record?.code ?? null,
        });
        // …and the lease rule last, over it. `run-exit-codes.ts` states the
        // precedence: an invocation that took this repository's only writer slot
        // and cannot prove it gave the slot back may not exit nominal however
        // well its own work went, and **no primary code is exempt**. Gated on
        // `leaseTaken` so a run that could not acquire one is not punished for a
        // slot it never held.
        process.exitCode =
          driven.verification !== null && driven.verification.leaseTaken
            ? exitCodeWithLeaseRelease(primary, driven.verification.leaseRelease)
            : primary;
        return;
      }

      // The egress branch, the mint, the re-check and the decision — one
      // sequence, in `delivery-steps.ts`, because V4 slice 11 gave it a second
      // caller. Written once so the two cannot come to disagree about when the
      // forge answered or which proof a decision was drawn from.
      const looked = await performObservation(
        options,
        {
          observe: options.observe === true,
          // Still not minted on a plain `--observe`: an artefact made for
          // nobody is an artefact somebody will find a use for.
          proof: options.record === true || options.decide === true,
          decide: options.decide === true,
        },
        subject,
        resolve,
        load,
        seams,
      );
      const observation = looked.observation;
      const conclusion = looked.conclusion;
      const proof = looked.proof;
      const revalidation = looked.revalidation;
      const decision = looked.decision;

      // Recording happens BEFORE the record is read back, and the order is the
      // contract rather than an accident.
      //
      // The first version of this read first, and a review reproduced what that
      // prints: on a successful `--observe --record` for a task with no prior
      // record, the report said "Recorded : ABSENT — No observation has been
      // recorded for this task" on the line directly above "Record : RECORDED".
      // A sentence false at the moment it is printed, contradicting the line
      // beneath it, and it suppressed the freshness sentence as a bonus. On a
      // second run it showed the record that had just been *superseded*.
      //
      // So the read is the last thing that happens, and what it reports is the
      // state of the store as the invocation leaves it.
      const recording =
        options.record === true
          ? await performRecording({
              options,
              repositoryRoot: repository.root,
              subject,
              taskLoad,
              observation,
              conclusion,
              proof,
              seams,
            })
          : null;

      // Whatever is on disk, judged against the task as it is now. Read on every
      // invocation, including one with no `--observe`, because "what does AO
      // already know about this task" is a local question and answering it needs
      // no network. It is reported as history and never as truth.
      const stored =
        subject.ok && taskLoad.ok
          ? loadDeliveryEvidence(
              repository.root,
              options.task,
              {
                taskId: options.task,
                repositoryRoot: repository.root,
                stateRevision: taskLoad.revision,
              },
              {
                subjectCommit: subject.subject.commit,
                host: subject.subject.host,
                owner: subject.subject.owner,
                name: subject.subject.name,
                declaredRemote: subject.remoteName,
              },
            )
          : null;

      // The mutation, and it is deliberately the last thing that happens.
      //
      // Everything above is a read, and every one of those reads is worth
      // having even on an invocation that goes on to be refused. Putting the
      // effect after them means a refusal costs nothing extra, and means the
      // report an operator sees describes the same world the attempt was made
      // against rather than one observed before it.
      // The ref and the remote are carried beside the result rather than read
      // back out of it: the authority that named them is spent by the time the
      // result exists, deliberately, because an artefact a report could read
      // twice is an artefact that could publish twice.
      const publication =
        options.publishHead === true
          ? {
              result: await performPublication(
                options,
                repository.root,
                subject,
                taskLoad,
                resolve,
                load,
                seams,
              ),
              ref: taskLoad.ok ? publishableRef(taskLoad.state.workBranch) : null,
              remoteName: subject.ok ? subject.remoteName : null,
            }
          : null;

      // The second mutation, and it is after the first on purpose. A pull
      // request is created from a branch that must already be on the remote, so
      // an invocation that was asked for both has to publish before it creates
      // — and one asked only for this finds the ref already there, or answers
      // `HEAD_NOT_PUBLISHED` and pushes nothing.
      const creation =
        options.createPr === true
          ? await performCreation(
              options,
              repository.root,
              subject,
              taskLoad,
              decision,
              resolve,
              load,
              seams,
            )
          : null;

      // The third mutation, and it is after the other two on purpose: a pull
      // request must exist on the forge before it can be merged, so an
      // invocation asked for all three publishes, creates and then merges. One
      // asked only for this finds the pull request the observation matched, or
      // refuses without sending anything.
      const merge =
        options.mergePr === true
          ? await performMerge(options, subject, taskLoad, decision, proof, resolve, load, seams)
          : null;

      // Last, and after the merge on purpose. An invocation asked for both
      // merges and then records what the merge did; one asked only for this
      // reconciles a merge somebody else performed. It is deliberately not a
      // forge mutation and takes no authority from the one above it: the merge
      // grant is spent, and this path could not use it if it were not.
      //
      // Reached on its own flag alone. It does not require `--observe`, because
      // it asks the forge its own two questions about its own subject rather
      // than reading the observation above — an observation looks for an *open*
      // pull request at this head, and after a merge there is none.
      const reconciliation =
        options.reconcileMerge === true
          ? await performReconciliation(options, repository.root, subject, taskLoad, {
              // A fresh object of exactly the five named seams, not `seams`
              // itself. See `ReconciliationCommandSeams`: a wider value is
              // assignable to a narrower parameter type, so passing `seams`
              // would leave the three forge-mutation runners on the value at
              // runtime and the "it cannot reach one" claim would be about the
              // type only.
              runner: seams.runner,
              envSource: seams.envSource,
              now: seams.now,
              checkIgnored: seams.checkIgnored,
              git: seams.git,
            })
          : null;

      // After the reconciliation on purpose, and for the same reason that one
      // is after the merge: an invocation asked for both records the merge and
      // then verifies the commit that record names. One asked only for this
      // finds the receipt already there, or refuses with `RECEIPT_ABSENT`.
      //
      // It is the only act here that starts a process from the repository under
      // test, so it is the only one that takes the execution lease. It takes no
      // grant: a grant authorises one irreversible effect and is spent by
      // claiming it, and running a gate is neither irreversible nor something a
      // second run would duplicate.
      const verification =
        options.verifyMerge === true
          ? await performVerification(options, repository, subject, taskLoad, {
              // A fresh object of exactly the named seams, not `seams` itself.
              // A wider value is assignable to a narrower parameter type, so
              // passing `seams` would leave the forge runners on the value at
              // runtime and "it cannot reach one" would be about the type only.
              now: seams.now,
              checkIgnored: seams.checkIgnored,
              git: seams.git,
              verify: seams.verify,
            })
          : null;

      // After the verification on purpose, and for the same reason that one is
      // after the reconciliation: an invocation that asked for both verifies the
      // commit and then concludes the delivery that verification is about. One
      // asked only for this finds the history already there, or refuses with
      // `VERIFICATION_ABSENT`.
      //
      // It takes no execution lease. Every act on this command that takes one
      // starts a process from the repository under test; this one reads
      // documents already on disk and writes one, which is exactly what `--record` and
      // `--reconcile-merge` do without a lease. Taking a repository-wide writer
      // slot to file a judgement would make bookkeeping contend with runs of
      // other tasks.
      const deliveryConclusion =
        options.concludeDelivery === true
          ? await performConclusion(repository, options.task, subject, taskLoad, load, {
              // A fresh object of exactly the named seams, not `seams` itself.
              // A wider value is assignable to a narrower parameter type, so
              // passing `seams` would leave the forge runners on the value at
              // runtime and "it cannot reach one" would be about the type only.
              now: seams.now,
              checkIgnored: seams.checkIgnored,
              git: seams.git,
            })
          : null;

      process.stdout.write(
        renderDeliveryObservation({
          repositoryId: repository.id,
          repositoryRoot: repository.root,
          taskId: options.task,
          subject,
          observation,
          conclusion,
          stored,
          recording,
          decision: decision === null ? null : { decision, revalidation },
          publication,
          creation,
          merge,
          reconciliation,
          verification,
          deliveryConclusion,
        }),
      );

      // Unchanged by `--decide`, and that is the decision rather than an
      // omission. The exit code answers one question — was the observation
      // settled — and a caller that could read "deliver this" out of an exit
      // status would have been handed the machine-consumable merge signal this
      // slice exists to not give. The decision is in the report, where a person
      // reads the sentence that comes with it.
      //
      // The one thing that CAN override it is the execution lease, and that is
      // a rule about authority rather than about severity.
      // `run-exit-codes.ts` states it for this repository — "an invocation that
      // took this repository's only writer slot and cannot prove it gave the
      // slot back has left something behind, and it may not exit nominal
      // however well its own work went", and "**No primary code is exempt**" —
      // and `block --attended` and `release --attended` both apply it.
      // `--verify-merge` is the third path that takes a lease, and a review
      // found it exiting 0 with a stuck one. It applies the same rule now.
      //
      // Gated on `leaseTaken` rather than on the flag: a run that asked for
      // verification and could not acquire the lease took no slot, and owes
      // nothing back. `exitCodeWithLeaseRelease(primary, null)` would refuse it,
      // which would be punishing a run for a lease it never held.
      // The second thing that can override it, and the reason it is not the
      // same rule as the lease's.
      //
      // The lease rule is about *leaving something behind*: a run that took the
      // writer slot and cannot prove it gave it back has changed this machine
      // and must not exit nominal. A refused record leaves nothing behind, and
      // that is why `--record`, `--reconcile-merge` and `--verify-merge` all
      // report their store code in the report and none of them touches `$?`.
      //
      // This one is different, and narrowly. `--conclude-delivery` is the flag
      // whose whole purpose is to answer "is this delivery concluded?". A run
      // that decided yes and could not leave the conclusion on disk has told a
      // caller yes about something that did not happen, and a caller reading
      // `$?` would act on it. So exactly one shape overrides: the ladder reached
      // `DELIVERY_CONCLUDED` and the store did not leave the claim on disk.
      // Every ladder refusal keeps the convention — those are *answers*, and the
      // report carries them.
      //
      // WHICH code it becomes is `run-exit-codes.ts`'s to decide, one store code
      // at a time, and not a single number chosen here. A review measured the
      // first version collapsing all twelve non-durable codes onto
      // `EXIT_RUN_NEEDS_OPERATOR`, including two this repository's own tables
      // grade 4 and 2 for the identical condition. `null` there means "keep the
      // primary", which is what the two durable codes answer.
      // `record === null` on a concluded run is the second receipt read
      // disagreeing with the ladder's — a **race**, not a floor. An earlier
      // version graded it `EXIT_RUN_UNEXPECTED` and called it unreachable; a
      // review read `performConclusion`'s own comment, which says it exists
      // because "a build in which those two readings could disagree must not
      // write a record from the second". It is the same class of event as
      // `EVIDENCE_MOVED` one function deeper, and it gets the same code:
      // nothing is wrong, and the next invocation may well succeed.
      const concludedNotDurable =
        deliveryConclusion !== null && deliveryConclusion.result.outcome === 'DELIVERY_CONCLUDED'
          ? deliveryConclusion.record === null
            ? EXIT_RUN_REFUSED
            : exitCodeForConclusionRecord(deliveryConclusion.record.code)
          : null;

      // The lease rule is applied **last**, over the conclusion override rather
      // than beside it, and that ordering was a correction.
      //
      // While the override was the single constant `EXIT_RUN_NEEDS_OPERATOR` it
      // happened to equal what `exitCodeWithLeaseRelease` forces, so `?? ` over
      // an already-lease-adjusted code was indistinguishable from the right
      // answer. Grading the store's codes one by one made the override able to
      // return 2 or 4 — and a review measured the consequence: a run with
      // `--verify-merge --conclude-delivery` whose lease could not be given back
      // and whose conclusion write was refused would have exited 4, telling a
      // caller "nothing is wrong, try again" about a repository with the writer
      // slot still held. `run-exit-codes.ts` states the precedence: **no primary
      // code is exempt**, and the conclusion override is a primary code like any
      // other.
      const primary = exitCodeFor(conclusion) as CliExitCode;
      const afterConclusion = concludedNotDurable ?? primary;
      process.exitCode =
        verification !== null && verification.leaseTaken
          ? exitCodeWithLeaseRelease(afterConclusion, verification.leaseRelease)
          : afterConclusion;
    });
}

/**
 * What one `--record` amounted to.
 *
 * A union of this command's own refusals and the store's, kept as one closed
 * string so the report has one place to print and a test has one place to pin.
 */
export type RecordOutcome = RecordRefusal | DeliveryEvidenceRecordCode;

export interface RecordingResult {
  readonly outcome: RecordOutcome;
  readonly recorded: boolean;
  /** The operator sentence for a refusal this command decided, else null. */
  readonly detail: string | null;
}

interface RecordingInputs {
  readonly options: DeliveryOptions;
  readonly repositoryRoot: string;
  readonly subject: SubjectResolution;
  readonly taskLoad: ReturnType<typeof loadTaskState>;
  readonly observation: DeliveryObservation | null;
  readonly conclusion: ReturnType<typeof concludeObservation>;
  /**
   * The invocation's one attestation, or `null` if none could be minted.
   *
   * Handed in rather than minted here, so that a run which both records and
   * decides binds both to the same observed instant. The refusal below is
   * unchanged: `null` still means the observation did not settle after all, and
   * it is still the mint — not this module — that decided so.
   */
  readonly proof: DeliveryObservationProof | null;
  readonly seams: DeliveryCommandSeams;
}

/**
 * The recording path, and every refusal on the way in.
 *
 * The order is the contract, and each step can only reach a *worse* answer than
 * the one after it. In particular the `--observe` requirement is judged before
 * anything else: `--record` alone must not merely fail to write, it must not
 * cause the command to behave differently from a plain local run in any way an
 * observer could detect. Nothing is contacted, nothing is created, and the
 * refusal is a sentence.
 */
async function performRecording(inputs: RecordingInputs): Promise<RecordingResult> {
  const refuse = (outcome: RecordRefusal): RecordingResult =>
    Object.freeze({ outcome, recorded: false as const, detail: RECORD_REFUSAL_DETAIL[outcome] });

  if (inputs.options.observe !== true) return refuse('RECORD_REQUIRES_OBSERVATION');
  if (!inputs.subject.ok) return refuse('RECORD_WITHOUT_SUBJECT');
  if (inputs.observation === null || inputs.conclusion !== 'OBSERVED') {
    return refuse('RECORD_WITHOUT_SETTLED_OBSERVATION');
  }
  if (!inputs.taskLoad.ok) return refuse('RECORD_WITHOUT_TASK_BINDING');

  // The mint's verdict. A `null` here means the observation did not settle
  // after all — the mint re-derives that for itself and does not believe the
  // conclusion computed above — and it reaches the same refusal, because from
  // the operator's side the two are one fact.
  const proof = inputs.proof;
  if (proof === null) return refuse('RECORD_WITHOUT_SETTLED_OBSERVATION');

  const result = await recordDeliveryEvidence({
    repositoryRoot: inputs.repositoryRoot,
    taskId: inputs.options.task,
    subject: {
      taskId: inputs.options.task,
      repositoryRoot: inputs.repositoryRoot,
      stateRevision: inputs.taskLoad.revision,
    },
    taskState: inputs.taskLoad.state.state,
    basePinnedCommit: inputs.taskLoad.state.basePinnedCommit,
    declaredRemote: inputs.subject.remoteName,
    expectedSubjectCommit: inputs.subject.subject.commit,
    expectedHost: inputs.subject.subject.host,
    expectedOwner: inputs.subject.subject.owner,
    expectedName: inputs.subject.subject.name,
    proof,
    recordedAt: (inputs.seams.now ?? (() => new Date()))().toISOString(),
    checkIgnored:
      inputs.seams.checkIgnored ??
      createRuntimeIgnoreProbe(inputs.repositoryRoot, inputs.seams.git ?? runGitCommand),
  });
  // The store's own codes carry no sentence here: they are already a closed
  // vocabulary an operator can look up, and inventing a second sentence for
  // each in this module would be a second place for them to drift.
  return Object.freeze({ outcome: result.code, recorded: result.recorded, detail: null });
}


/**
 * Four conclusions, three codes, and the distinction a scheduler needs.
 *
 * Three codes because two conclusions share one: a subject that was established
 * and not observed, and one that was observed and settled, are both "nothing to
 * go and fix".
 *
 * `OBSERVED` is zero even when the answer is "no pull request has this head" or
 * "the checks failed". Those are answers, and a command that exits non-zero on
 * a successfully obtained fact teaches a caller to retry a question that has
 * already been settled.
 */
export function exitCodeFor(conclusion: ReturnType<typeof concludeObservation>): CliExitCode {
  if (conclusion === 'SUBJECT_NOT_ESTABLISHED') return EXIT_RUN_INPUT_UNUSABLE;
  if (conclusion === 'OBSERVATION_INCOMPLETE') return EXIT_RUN_REFUSED;
  // Exhaustive rather than a trailing `return`. A fifth conclusion would
  // otherwise inherit the success code silently, and this is the ladder that
  // decides what a caller reads as "settled" — the place a new member must not
  // be able to arrive at by falling off the end.
  if (conclusion === 'NOT_OBSERVED' || conclusion === 'OBSERVED') return EXIT_RUN_OK;
  const unreachable: never = conclusion;
  void unreachable;
  return EXIT_RUN_REFUSED;
}

