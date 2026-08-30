/**
 * The owned-launch register: the durable set of AO-owned subprocesses that are
 * **open right now** under one lease — and the answer to *"can any process this
 * epoch started still be running?"*, for every class of process rather than for
 * the writer alone.
 *
 * ── The sentence the writer ledger cannot say ──────────────────────────────
 *
 * `lease/writer-launch-ledger.ts` says so itself, in the paragraph headed *What
 * this ledger does not cover*: it records the productive writer and nothing
 * else, the reviewer and the verification command go through the same owned
 * boundary and are simply not written down, and "a reader who needs 'no process
 * of any kind survives' needs a wider ledger than this one".
 *
 * This is that wider record. It exists because the gap was measured rather than
 * argued. On `main` at `fba4cfd`, a real lease, a real writer run to
 * `CONTAINED` through the real native boundary, and then a real verification
 * subprocess started through the production path
 * (`verify/verify-command.ts` → `doctor/exec.ts` → `boundary/owned-command.ts`)
 * produced this:
 *
 *     ledger reading                 ALL_LAUNCHES_CONTAINED
 *     assessStaleLeaseRecovery       SAFE_TO_RECOVER, refusal null
 *     agent-loop lease recover       RECOVERED — the lease file was deleted
 *
 * The removal was licensed having probed **one** process, the owner. Nothing in
 * the predicate named the verification subprocess, and nothing ever could.
 *
 * ── Why that is a defect even though the subprocess died anyway ────────────
 *
 * It did die. Measured, three rounds, sampling every 4 ms for six seconds after
 * `taskkill /F` with no `/T`, with liveness established *backwards* from later
 * heartbeat advances: the owned verification tree was already gone at the first
 * sample, 44–69 ms in. Two couplings do that, and `native/ao-launch/AoLaunch.cs`
 * owns one of them — `WatchOwner` terminates the job when the owner handle
 * signals, and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` on a job whose only handle
 * the helper holds destroys the tree when the helper goes.
 *
 * So the hole is in the *proof*, not — on this host, today — in the outcome.
 * That is still a defect, and the reason is that **this build refuses that
 * exact inference everywhere else**. For a writer launch that was established
 * and never seen to end, `execution-lease.ts` re-probes `helperPid` and
 * `childPid` inside the call that removes, and says why in so many words: the
 * helper is asked directly "rather than inheriting that measurement". Phase B
 * of `tests/dist-artifact/crash-recovery-dist-artifact.mjs` exists to prove
 * that re-probe can tell a live process from a dead one. Every non-writer class
 * was getting the inference for free, silently, and three places in this build
 * record that the inference has exceptions:
 *
 *  - `boundary/owned-command.ts`'s `ATTESTABLE_OUTCOME` table, on
 *    `BOUNDARY_LOST`: "the boundary stopped being accountable for the tree.
 *    That is precisely the case where 'the owner's death took the writer with
 *    it' stops being true." A verification or reviewer run that ends that way
 *    writes nothing, anywhere;
 *  - `boundary/start-owned-process.ts`, which states the owner→helper coupling
 *    as measured rather than guaranteed;
 *  - the teardown window itself, which nothing waits on.
 *
 * ── A register, not a ledger, and the difference is the discipline ─────────
 *
 * The writer ledger is **append-only**: a generation goes down as `PENDING`,
 * becomes `ESTABLISHED`, becomes `CONTAINED`, and stays. That works because a
 * writer launches a handful of times under one lease.
 *
 * It does not work here, and the reason is measured rather than aesthetic. Every
 * productive owned spawn under a lease is accounted — the commit's `git add`,
 * every `rev-parse`, every verification phase, the reviewer — which is tens of
 * launches per step. `publishCompanionRecord` rewrites the whole document, so an
 * append-only entry per owned spawn is quadratic in bytes written and reaches
 * `MAX_WRITER_LAUNCH_ENTRIES` in a long run. So an entry here is **removed when
 * its launch is seen to end**, and the set is bounded by how many owned
 * launches are open at once rather than by how many ever happened.
 *
 * The safety argument survives that change intact, because the question this
 * record answers is not "what happened" but "what is still open":
 *
 *     lease acquired      → register published empty, historyComplete: true
 *     before each launch  → a slot appended as ANNOUNCED, published
 *     launch happens      → only after that publish is known to have landed
 *     kernel confirms job → the slot replaced by ESTABLISHED, published
 *     launch seen to end  → the slot REMOVED, published
 *     anything else       → the slot stays where it got to, for good
 *
 * ── The leftover is a refusal, and that is the whole of why this is cheap ──
 *
 * The writer ledger's hazard is a **stale affirmative** entry: an `ESTABLISHED`
 * mark left standing by a launch that is over reads as a proof and is a lie, so
 * `loop/leased-spawns.ts` carries a withdrawal, consumes its answer, and stops
 * the run when it cannot take the mark back.
 *
 * Nothing of that shape is needed here, and it is worth saying why rather than
 * leaving the asymmetry to look like an omission. An entry that could not be
 * removed is a **stale refusal**: it names processes, the predicate probes them,
 * and if they are gone the recovery proceeds anyway. If they cannot be probed it
 * refuses. There is no leftover in this format that permits anything, so a
 * failed settlement costs this lease nothing and never stops a run.
 *
 * The *announcement* is the other way round and is therefore guarded the way
 * `beginWriterLaunch` guards its own: an owned launch that starts without its
 * slot on disk is a launch a later recovery cannot know about, so the write
 * comes first, its one fallback is to discard the whole document — which asserts
 * nothing — and only when even that is impossible does the launch lose.
 *
 * ── Slots are minted, never positional ────────────────────────────────────
 *
 * The writer ledger's `generation` is checked positionally, 1..N, so an edit
 * that deletes an entry is `MALFORMED` before the binding is consulted. Entries
 * here are removed in the ordinary course of business, so that check cannot
 * exist, and its absence has to be paid for somewhere else.
 *
 * It is paid for by {@link OwnedLaunchRegisterFields.nextSlot}, which only ever
 * increases. Without it a settled slot could be handed out again, and a
 * settlement for the *old* launch arriving after the new one was announced would
 * remove a live launch's record — the one edit in this format that turns a
 * refusal into a permission. Slots are therefore strictly increasing, all below
 * `nextSlot`, and both are covered by the binding digest.
 *
 * ── What it does not claim ────────────────────────────────────────────────
 *
 * `NO_OWNED_LAUNCH_OPEN` says every owned launch this register saw was seen to
 * end. It does **not** say the processes are gone: the boundary settles
 * `owned.ending` on the helper's close, and the helper holds the only handle to
 * a job carrying `KILL_ON_JOB_CLOSE`, so the kernel destroyed the tree — that is
 * a contract of the job flags and not of this file. It says nothing at all about
 * a process this build never started, and nothing about the unleased delivery
 * surface: `cli/delivery-steps.ts` records that nothing under `src/deliver/`
 * acquires a lease, so no epoch is held while `git push` and the two `gh`
 * mutations run. They are announced like every other launch and the
 * announcement reaches nobody, which is a different sentence from "they are
 * excluded" and is the true one.
 *
 * And forgery is bounded exactly as the writer ledger's is. The binding is
 * computed from the lease key and the owner nonce, both plaintext in the lease
 * document beside it; it catches transplantation, in-place edits and version
 * drift, and it does not withstand an author who can rewrite the whole file.
 */

import { z } from 'zod';

const HEX_64 = /^[0-9a-f]{64}$/;

/** Restated rather than imported, for the reason `lease-document.ts` gives. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Largest number of owned launches this build will hold open at once.
 *
 * Not "a number a run cannot reach", which is the claim
 * `MAX_WRITER_LAUNCH_ENTRIES` had to retract. It is a number this build's own
 * topology says nothing reaches: `grep -rn 'Promise.all' src/` finds nothing, so
 * every spawn in this product is awaited before the next begins and the register
 * holds at most one entry. Sixty-four is room for a shape that does not exist
 * yet, and reaching it is a **stated outcome** — the announcement discards the
 * document and answers `REGISTER_DISCARDED` with `REGISTER_FULL` as its reason —
 * rather than a silent state. There is no `REGISTER_FULL` *code*: this sentence
 * named one for a while, and the closed set the tests pin proves it absent.
 */
export const MAX_OPEN_OWNED_LAUNCHES = 64;

/**
 * An owned launch that has been announced and whose job membership is unproven.
 *
 * Carries no containment facts at all rather than carrying them as nulls, for
 * the reason `PendingLaunchSchema` does: there is no field an edit can flip to
 * turn an unproven launch into a proven one, because the two are different
 * shapes and the union below refuses a mixture.
 *
 * What reaches a recovery in this state is a launch killed between the
 * announcement and the kernel's answer, a launch on a platform with no boundary
 * to confirm one, or a launch whose establishment mark could not be published.
 * All three are refusals, and none of them can be told apart from the record —
 * which is the honest answer, because nothing was established.
 */
const AnnouncedOwnedLaunchSchema = z
  .object({
    slot: z.int().positive(),
    state: z.literal('ANNOUNCED'),
    openedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
  })
  .strict();

/**
 * An owned launch the kernel placed in the owner's job, still open.
 *
 * `verifiedInJob` is a literal `true` for the reason every other containment
 * shape in this build pins it: a record saying the kernel did not confirm
 * membership is evidence for something else, and this schema refuses to
 * represent it.
 *
 * The pids are not decoration. They are the subject of the liveness re-probe the
 * recovery performs inside the call that removes, and a state that carried the
 * containment without them would be a claim nothing could re-verify.
 */
const EstablishedOwnedLaunchSchema = z
  .object({
    slot: z.int().positive(),
    state: z.literal('ESTABLISHED'),
    openedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    helperPid: z.int().positive(),
    childPid: z.int().positive(),
    mode: z.string().min(1).max(32),
    verifiedInJob: z.literal(true),
    assignedAtCreation: z.boolean().nullable(),
    launchDigest: z.string().regex(HEX_64, 'Must be a launch digest.'),
    attestedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
    establishedAt: z.string().regex(ISO_8601, 'Must be an ISO-8601 instant.'),
  })
  .strict();

export const OpenOwnedLaunchSchema = z.discriminatedUnion('state', [
  AnnouncedOwnedLaunchSchema,
  EstablishedOwnedLaunchSchema,
]);

export type OpenOwnedLaunch = z.infer<typeof OpenOwnedLaunchSchema>;
export type AnnouncedOwnedLaunch = z.infer<typeof AnnouncedOwnedLaunchSchema>;
export type EstablishedOwnedLaunch = z.infer<typeof EstablishedOwnedLaunchSchema>;

/**
 * The two fields this register contributes to the lease's launch document.
 *
 * They live in the *same* file as the writer ledger, and that is a decision
 * rather than an accident. One document means one binding digest, one atomic
 * publish and one version to reason about; two would mean a recovery had to
 * reconcile two files that can disagree about which lease they belong to, which
 * is the class of defect `lease/containment-evidence.ts` already paid for once.
 * What is kept apart is the *vocabulary*: this module defines the shape and the
 * readings, `writer-launch-ledger.ts` keeps saying exactly what it always said,
 * and no reading of one is a reading of the other.
 */
export interface OwnedLaunchRegisterFields {
  /**
   * The owned launches open right now, by ascending slot.
   *
   * Empty is the licensing value and the ordinary one: every launch that ended
   * took its entry with it.
   */
  readonly open: readonly OpenOwnedLaunch[];
  /**
   * The next slot to hand out. Only ever increases.
   *
   * See the module header: without it a settled slot could be reused, and a
   * late settlement would then remove a *live* launch's record. That is the one
   * edit in this format that turns a refusal into a permission, so the counter
   * is part of the payload and part of the binding rather than derived from the
   * open set — a maximum over an emptied set is 0, and the whole hazard is
   * that the set is emptied.
   */
  readonly nextSlot: number;
}

/** The schema fragment, for the document that carries it. */
export const OWNED_LAUNCH_REGISTER_SHAPE = {
  open: z.array(OpenOwnedLaunchSchema).max(MAX_OPEN_OWNED_LAUNCHES),
  nextSlot: z.int().positive(),
} as const;

/**
 * What a lease's owned-launch register turned out to be. A closed set of four,
 * of which **two** can license a recovery and neither does so alone.
 */
export const OWNED_LAUNCH_READINGS = [
  /**
   * No owned launch is open: every one this register saw was announced, and
   * every one was seen to end.
   *
   * The strongest reading, and it still does not license removing a lease by
   * itself — it says nothing about the owner, and nothing about the writer
   * history next to it.
   */
  'NO_OWNED_LAUNCH_OPEN',
  /**
   * Every open launch was placed in the owner's job by the kernel, and none of
   * them was seen to end.
   *
   * What an orchestrator killed **during** a verification, a reviewer pass or a
   * commit leaves behind. Weaker than {@link NO_OWNED_LAUNCH_OPEN} in exactly
   * one way — no ending was observed — so a recovery built on it owes one
   * further proof: that the processes those entries name are gone.
   */
  'OWNED_LAUNCHES_OPEN_UNENDED',
  /**
   * At least one open launch is still `ANNOUNCED`.
   *
   * A launch that never got as far as the kernel's answer. Nothing at all can
   * be said about the process, so nothing is removed. This is the window this
   * register narrows and does not close, and it is the same window
   * `LAUNCH_UNPROVEN` names for the writer.
   */
  'OWNED_LAUNCH_UNPROVEN',
  /**
   * The document this register lives in is not one a recovery may read: absent,
   * malformed, from another build, bound to another lease, describing another
   * run, or a history that did not begin with its lease.
   *
   * One member rather than six, and the reason is placement rather than
   * laziness: the writer reading is taken from the same document **first**, and
   * every one of those conditions is already a named refusal there. Repeating
   * the six here would give an operator two names for one fact and would let a
   * later reordering decide which one they saw. Reached only when this reader is
   * used on its own, which nothing in the recovery path does.
   */
  'REGISTER_NOT_READABLE',
] as const;

export type OwnedLaunchReading = (typeof OWNED_LAUNCH_READINGS)[number];

/**
 * Which readings prove no owned launch of this epoch is still open.
 *
 * A total table rather than an equality test, for the reason
 * `writer-launch-ledger.ts` gives for its own: an added reading stops the build
 * here instead of falling into whatever `=== 'NO_OWNED_LAUNCH_OPEN'` answers for
 * it. Completeness is not correctness, so every row is asserted by value in
 * `tests/m2-02-owned-launch-quiescence.test.ts`.
 */
const PROVES_NO_OWNED_LAUNCH_OPEN: Readonly<Record<OwnedLaunchReading, boolean>> = Object.freeze({
  NO_OWNED_LAUNCH_OPEN: true,
  // `false`, and this row is the one worth reading twice. Those launches *were*
  // contained; what is missing is an observed ending, so the sentence this
  // predicate answers is not the sentence that reading supports. It gets its own
  // predicate below rather than a second `true` here, because a caller that
  // reached the removal through this one would skip the liveness proof the other
  // one owes.
  OWNED_LAUNCHES_OPEN_UNENDED: false,
  OWNED_LAUNCH_UNPROVEN: false,
  REGISTER_NOT_READABLE: false,
});

/** Whether this reading proves no owned launch is open at all. Exactly one does. */
export function provesNoOwnedLaunchOpen(reading: OwnedLaunchReading): boolean {
  return PROVES_NO_OWNED_LAUNCH_OPEN[reading] === true;
}

/**
 * Which readings prove every open launch was placed in the owner's job while
 * leaving every ending unobserved.
 *
 * Its own table for the same reason the one above is a table, and its own
 * *predicate* for a reason that is not style: this answer is **not sufficient**
 * for a removal on its own. A caller that gets `true` here still owes a liveness
 * proof about the processes {@link openOwnedLaunchesOf} names, and separating
 * the two predicates is what makes forgetting that owed proof a compile-visible
 * mistake rather than a silent widening of the stronger one.
 */
const PROVES_OPEN_UNENDED: Readonly<Record<OwnedLaunchReading, boolean>> = Object.freeze({
  NO_OWNED_LAUNCH_OPEN: false,
  OWNED_LAUNCHES_OPEN_UNENDED: true,
  OWNED_LAUNCH_UNPROVEN: false,
  REGISTER_NOT_READABLE: false,
});

/**
 * Whether this reading proves containment for every open launch with no ending
 * observed.
 *
 * `false` for {@link OWNED_LAUNCH_READINGS.NO_OWNED_LAUNCH_OPEN} on purpose: the
 * two predicates partition the licensing readings rather than nesting, so
 * neither answer can be read as the other's superset.
 */
export function provesOwnedLaunchesOpenUnended(reading: OwnedLaunchReading): boolean {
  return PROVES_OPEN_UNENDED[reading] === true;
}

/** One owned launch a recovery still owes a liveness proof about. */
export interface OpenOwnedProcess {
  readonly slot: number;
  /** The process that owns the job. Its death destroys the job. */
  readonly helperPid: number;
  /** The target the kernel placed in that job. */
  readonly childPid: number;
}

/**
 * Reads the register out of an already-validated document.
 *
 * Takes the parsed fields rather than the raw value, and that is the whole of
 * how this module avoids owning a second copy of the document's structural
 * rules. The caller — {@link readOwnedLaunchRegister} and the recovery
 * predicate — has already established that the document is this lease's, this
 * run's, this build's version and complete; what is left is the four-way answer
 * about the open set, and it is a pure function of that set.
 */
export function readOpenSet(open: readonly OpenOwnedLaunch[]): OwnedLaunchReading {
  // `ANNOUNCED` first, and it dominates: one announced launch that never
  // reached the kernel's confirmation is unproven whatever else is open.
  // Reading the two states in any other order would let an `ESTABLISHED` entry
  // describe a register that still hides an unaccounted-for launch.
  if (open.some((entry) => entry.state === 'ANNOUNCED')) return 'OWNED_LAUNCH_UNPROVEN';
  if (open.length > 0) return 'OWNED_LAUNCHES_OPEN_UNENDED';
  return 'NO_OWNED_LAUNCH_OPEN';
}

/**
 * The processes a recovery still owes a liveness proof about, or `null`.
 *
 * Answers non-`null` for exactly one reading — the one
 * {@link provesOwnedLaunchesOpenUnended} names — so a register carrying an
 * `ANNOUNCED` entry yields nothing to probe rather than yielding a shorter list
 * a caller could exhaust and call proven. `null` and `[]` are therefore both
 * refusals at the call site, and the caller treats them that way: an empty list
 * from this reading is impossible by construction, so producing one would mean
 * this function and the reading disagree, which is not a state to act on.
 */
export function openOwnedLaunchesOf(
  open: readonly OpenOwnedLaunch[],
): readonly OpenOwnedProcess[] | null {
  if (!provesOwnedLaunchesOpenUnended(readOpenSet(open))) return null;
  return Object.freeze(
    open
      .filter((entry): entry is EstablishedOwnedLaunch => entry.state === 'ESTABLISHED')
      .map((entry) =>
        Object.freeze({
          slot: entry.slot,
          helperPid: entry.helperPid,
          childPid: entry.childPid,
        }),
      ),
  );
}

/**
 * Whether an open set is structurally admissible, independent of its binding.
 *
 * The register's replacement for the writer ledger's positional `1..N` check.
 * Entries are removed here in the ordinary course of business, so a gap proves
 * nothing — but three things still must hold, and each of them is an edit this
 * format has to refuse:
 *
 *  - **strictly increasing slots.** Two entries with one slot make a settlement
 *    ambiguous, and an out-of-order pair is a document somebody assembled;
 *  - **every slot below `nextSlot`.** The counter is what makes a slot unique
 *    for the life of the register; an entry at or above it means the counter was
 *    rolled back, which is exactly the edit that lets a live launch's record be
 *    removed by a stale settlement;
 *  - **`nextSlot` above every slot ever handed out**, which the first two give.
 *
 * Refused before the binding is consulted, for the reason the writer ledger
 * refuses a gap before consulting its own: a well-bound impossible document is
 * still not a register.
 */
export function admissibleOpenSet(open: readonly OpenOwnedLaunch[], nextSlot: number): boolean {
  if (!Number.isSafeInteger(nextSlot) || nextSlot < 1) return false;
  let previous = 0;
  for (const entry of open) {
    if (entry.slot <= previous) return false;
    if (entry.slot >= nextSlot) return false;
    previous = entry.slot;
  }
  return true;
}

/**
 * One open entry as the fields a binding digest covers, in order.
 *
 * Exported so the document's binding covers this register without that function
 * having to know the two entry shapes. Every field goes in by name rather than
 * by serialising the object, for the reason the writer ledger's binding gives:
 * `JSON.stringify` over the object itself would make the digest depend on key
 * order and would silently start or stop covering a field somebody added.
 *
 * `state` is second, before every value field. A digest that covered only the
 * values would let `ANNOUNCED` be relabelled `ESTABLISHED` without
 * recomputation — the single edit this format exists to refuse — and it would
 * let a three-field announcement and an eleven-field establishment collide if
 * the shorter one were a prefix of the longer.
 *
 * Every field of both shapes is here. `tests/m2-02-owned-launch-quiescence.test.ts`
 * asserts a detected per-field mutation for ten of an established entry's
 * eleven; the one it does not is `verifiedInJob`, a `z.literal(true)` with no
 * other value to try, and `state` is covered by its own case.
 */
export function openLaunchBindingFields(entry: OpenOwnedLaunch): readonly unknown[] {
  if (entry.state === 'ANNOUNCED') return [entry.slot, entry.state, entry.openedAt];
  return [
    entry.slot,
    entry.state,
    entry.openedAt,
    entry.helperPid,
    entry.childPid,
    entry.mode,
    entry.verifiedInJob,
    entry.assignedAtCreation,
    entry.launchDigest,
    entry.attestedAt,
    entry.establishedAt,
  ];
}
