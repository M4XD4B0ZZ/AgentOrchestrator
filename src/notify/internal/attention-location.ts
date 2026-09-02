/**
 * INTERNAL — where the operator-attention outbox is, and what a record is
 * called (M3-02).
 *
 * A module that writes nothing, creates nothing and imports no writer, for the
 * reason `deliver/internal/head-publication-audit-location.ts` writes down about
 * its own move: a reader that had to import the store to learn a directory name
 * would pull the exclusive create and the `link` into its own closure, and "this
 * cannot create anything" would stop being a fact about the import graph.
 *
 * ── Outside every repository, on purpose ───────────────────────────────────
 *
 * Task state lives inside the repository it describes; this does not. Three
 * reasons, and none of them is convenience:
 *
 *  - the consumer is **cross-repository**. An operator running one unattended
 *    process over an enlisted set wants one place to look, and the registry that
 *    names that set is already `<home>/repositories.yaml`;
 *  - an in-repository store would be written **without that repository's
 *    execution lease**. The outbox is settled between coordinator passes,
 *    holding nothing, which is exactly when a repository-scoped write has no
 *    authority behind it;
 *  - a repository AO drives ignores `.agent-orchestrator/runtime/` and nothing
 *    else, so a new directory beside the profile would show up as untracked work
 *    in every `git status` and in the scope assessment of the next task.
 *
 * The consequence is stated where it costs something: a record has to name its
 * own repository, because its location no longer does. See
 * `notify/attention-store.ts`.
 *
 * ── The name is the identity ───────────────────────────────────────────────
 *
 * A record's file name is a digest of what the notification is *about*, so the
 * filesystem is the deduplication: the same durable condition derives the same
 * name, and the `link` that gives a finished record that name either wins or
 * reports that somebody already said this. There is no read-then-write, no lock
 * and no counter, which is what makes two schedulers safe against each other
 * here. See `notify/attention-store.ts` for why it is `link` and not an
 * exclusive `open`.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { orchestratorHome } from '../../config/paths.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../../config/internal/path-provider.js';

/**
 * The directory under the orchestrator home that holds the records.
 *
 * Its own directory rather than its own name inside a shared one, following the
 * rule this build already made structural, and named for what it holds: items
 * awaiting an operator's attention. Deliberately not `notifications`, which
 * would make the directory's existence a claim that something was *delivered* —
 * a record here asserts only that a condition was found and written down.
 */
export const OPERATOR_ATTENTION_DIR_NAME = 'operator-attention';

/** Extension of a stored record. No alternative spelling. */
export const OPERATOR_ATTENTION_FILE_EXTENSION = '.json';

/**
 * How many hex characters of the identity digest become the file name.
 *
 * 32, so a name is 37 characters with the extension — inside every plain-file
 * budget this build applies — and a truncation of SHA-256 to 128 bits. The
 * collision this has to avoid is not adversarial: two *different* durable
 * conditions producing one name would silently drop a notification, and 128 bits
 * over a set an operator could plausibly hold is not a risk anybody can reach.
 * A longer name would not be wrong; it would just be longer.
 */
export const ATTENTION_ID_LENGTH = 32;

/** `<id>.json` where `<id>` is exactly {@link ATTENTION_ID_LENGTH} lowercase hex. */
const ATTENTION_FILE_NAME = new RegExp(`^[0-9a-f]{${String(ATTENTION_ID_LENGTH)}}\\.json$`);

/** `true` for a name this build would itself have written. */
export function isAttentionFileName(name: string): boolean {
  return ATTENTION_FILE_NAME.test(name);
}

/**
 * The suffix of a staging file — the complete record, under a name nothing
 * reads, waiting to be linked to its real one.
 *
 * A separate grammar rather than a convention, because the listing has to be
 * able to tell three things apart: a record, one of this build's own leftovers,
 * and a file somebody else put in the directory. Reporting a leftover as
 * "foreign" would tell an operator to go and look at something that is theirs
 * and harmless.
 */
const ATTENTION_STAGING_NAME = new RegExp(
  `^[0-9a-f]{${String(ATTENTION_ID_LENGTH)}}\\.[0-9a-z]+-[0-9a-f]{12}\\.staging$`,
);

/** `true` for a staging name this build would itself have written. */
export function isAttentionStagingName(name: string): boolean {
  return ATTENTION_STAGING_NAME.test(name);
}

/**
 * A staging name for one record, unique per attempt.
 *
 * The pid and the random half are both there and both earn it: the pid so two
 * processes cannot collide, and the random half so one process retrying cannot
 * collide with its own leftover from a crash. Same construction as
 * `state/atomic-file.ts`'s temporary name, for the same reason.
 */
export function attentionStagingName(attentionId: string, suffix: string): string {
  return `${attentionId}.${suffix}.staging`;
}

/** The id inside a name this build wrote, or `null`. */
export function attentionIdOf(name: string): string | null {
  if (!isAttentionFileName(name)) return null;
  return name.slice(0, ATTENTION_ID_LENGTH);
}

/**
 * The suffix of a **delivery receipt** — this item reached a configured endpoint
 * and the endpoint acknowledged it (`U2`, M4).
 *
 * A separate file beside the record rather than a field inside it, and the
 * reason is the record's own design. A record is created once by `link` and is
 * never rewritten: that is what makes "already recorded" and "somebody else
 * recorded it" the same answer with no lock and no lost update. A mutable
 * `delivered` field would put a read-then-write back into the one document the
 * whole store's concurrency argument rests on being immutable.
 *
 * Two files, each created exclusively, keeps both facts and keeps the argument:
 * the condition is one atomic create, the acknowledgement is another, and
 * neither can half-happen.
 *
 * A **fourth** grammar in this directory, so the listing can still tell apart a
 * record, a receipt, this build's own staging leftover, and a file somebody else
 * put there. The id is a fixed-length hex digest, so `<id>.delivered` is
 * unambiguous — no id can contain the separator, which is the property a
 * `<id>.<kind>` name needs and does not always have.
 */
const ATTENTION_DELIVERY_NAME = new RegExp(
  `^[0-9a-f]{${String(ATTENTION_ID_LENGTH)}}\\.delivered$`,
);

/** `true` for a delivery receipt name this build would itself have written. */
export function isAttentionDeliveryName(name: string): boolean {
  return ATTENTION_DELIVERY_NAME.test(name);
}

/** The id inside a delivery receipt name this build wrote, or `null`. */
export function deliveredAttentionIdOf(name: string): string | null {
  if (!isAttentionDeliveryName(name)) return null;
  return name.slice(0, ATTENTION_ID_LENGTH);
}

/** The full path of one item's delivery receipt. Joins; touches no filesystem. */
export function attentionDeliveryPath(
  attentionId: string,
  provider: PathProvider = OS_PATH_PROVIDER,
): string {
  return join(operatorAttentionRoot(provider), `${attentionId}.delivered`);
}

/**
 * The store root. A pure function of the OS user identity, and it creates
 * nothing.
 *
 * A root that is not there is a machine on which nothing has ever needed an
 * operator, which is a reading rather than an error.
 */
export function operatorAttentionRoot(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(orchestratorHome(provider), OPERATOR_ATTENTION_DIR_NAME);
}

/** The full path of one record. Joins; touches no filesystem. */
export function operatorAttentionPath(
  attentionId: string,
  provider: PathProvider = OS_PATH_PROVIDER,
): string {
  return join(
    operatorAttentionRoot(provider),
    `${attentionId}${OPERATOR_ATTENTION_FILE_EXTENSION}`,
  );
}

/**
 * Separates the fields of an identity so two of them cannot run together.
 *
 * A NUL, written as an escape rather than as the byte itself. The byte works —
 * it is the one character no field here can contain, which is what a separator
 * has to be, and unlike a space it does not lean on the field grammars (a
 * repository root may hold spaces). What the raw byte does not survive is being
 * *read*: Git classifies a source file containing one as **binary**, so the
 * whole module stops diffing, stops being reviewable, and stops being covered
 * by `.gitattributes`' `text=auto eol=lf` normalisation.
 *
 * Caught by `git show --stat` on the first commit of this slice, which reported
 * this file as `Bin 0 -> 8342 bytes` while every sibling reported a line count.
 * The escape produces the identical string at runtime, which was measured
 * rather than assumed: the same identity digests to the same value on both
 * sides of the change.
 */
const FIELD_SEPARATOR = '\u0000';

/**
 * What one notification is *about*, as the values that decide whether two of
 * them are the same notification.
 *
 * Each field earns its place:
 *
 *  - `repositoryRoot` rather than the declared id, because two clones of one
 *    project declare the same id and are two execution domains — the same rule
 *    the execution lease already applies by keying on the Git common directory;
 *  - `taskId`, obviously;
 *  - `reason` and `detail`, so a task that moves from one human-action condition
 *    to a different one raises a second item rather than reusing the first;
 *  - `stateEnteredAt`, which is what makes a *re-entry* a new notification. A
 *    task parked on the same block across a hundred scheduler passes keeps the
 *    same instant and therefore the same name, so the passes deduplicate. One
 *    that is continued, runs, and blocks again gets a fresh instant and is said
 *    again — which is right: it is a new event, and an operator who acted on the
 *    first is entitled to know the second happened.
 */
export interface AttentionIdentity {
  readonly repositoryRoot: string;
  readonly taskId: string;
  readonly reason: string;
  readonly detail: string | null;
  readonly stateEnteredAt: string;
}

/**
 * The identity digest for one notification.
 *
 * `null` is encoded distinctly from an empty string so that a `detail` of `''`
 * — which no producer writes, and which a widened vocabulary could — cannot
 * collide with an absent one. The two tags are control characters, written as
 * escapes rather than as the bytes themselves for the reason
 * {@link FIELD_SEPARATOR} gives: a source file holding one is classified binary
 * by Git and stops being reviewable. The escapes produce the identical strings,
 * so every identity this build has ever derived is unchanged — measured, not
 * assumed.
 */
export function attentionIdFor(identity: AttentionIdentity): string {
  const fields = [
    identity.repositoryRoot,
    identity.taskId,
    identity.reason,
    identity.detail === null ? '\u0001none' : `\u0002${identity.detail}`,
    identity.stateEnteredAt,
  ];
  return digestOf(fields);
}

/**
 * The tag that opens a repository identity, and can open no task identity.
 *
 * It sits in the **first** slot, which is where a task identity carries its
 * `repositoryRoot` — and a repository root is an absolute filesystem path, which
 * this word is not and cannot be: it names no drive, no UNC share and no root,
 * and every `repositoryRoot` reaching an identity has already been through
 * `resolveRepository`, which canonicalises to an absolute path. So the two field
 * lists are drawn from disjoint sets in their first position, and no task
 * identity can digest to a repository one whatever its remaining fields hold.
 *
 * The alternative — adding a `subject` field to every identity — would read more
 * plainly and would change **every task digest this build has ever written**,
 * silently re-raising every open item in every operator's store once. Leaving
 * the task field list untouched is why the tag is a leading field rather than a
 * new one.
 */
const REPOSITORY_IDENTITY_TAG = 'repository';

/**
 * What one *repository-subject* notification is about (`U3`, `L-M3-F-3`).
 *
 * Three fields, and the absentee is as deliberate as the members:
 *
 *  - `repositoryRoot`, for the reason the task identity gives;
 *  - `condition`, the exact lifecycle outcome, so a repository that moves from
 *    one unrunnable condition to a different one raises a second item;
 *  - `reason`, which is derived from the condition and is included anyway, so
 *    that re-grouping a condition under a different action becomes a new item
 *    rather than a silent change of advice under an existing name.
 *
 * There is **no instant**. A task identity carries `stateEnteredAt` so that a
 * re-entry is a new notification; a repository condition has no such instant to
 * carry, and putting `observedAt` there would give the same unchanged condition
 * a fresh name on every cycle — which is exactly the notification spam this
 * store exists to prevent, and at scheduler cadence it would be a file and a
 * push per repository per cycle for days.
 *
 * The consequence is stated rather than hidden: while a condition holds it is
 * one record and is announced once; when it clears the record is removed by the
 * same settle that removes a resolved task item; and if it then recurs, the name
 * is free again and it is announced again. That is the behaviour of an **open
 * set**, which is what this store is and what makes it safe to reason about.
 */
export interface RepositoryAttentionIdentity {
  readonly repositoryRoot: string;
  readonly condition: string;
  readonly reason: string;
}

/** The identity digest for one repository-subject notification. */
export function repositoryAttentionIdFor(identity: RepositoryAttentionIdentity): string {
  return digestOf([
    REPOSITORY_IDENTITY_TAG,
    identity.repositoryRoot,
    identity.condition,
    identity.reason,
  ]);
}

/** The one hash both identities go through. Two callers, one construction. */
function digestOf(fields: readonly string[]): string {
  return createHash('sha256')
    .update(fields.join(FIELD_SEPARATOR), 'utf8')
    .digest('hex')
    .slice(0, ATTENTION_ID_LENGTH);
}
