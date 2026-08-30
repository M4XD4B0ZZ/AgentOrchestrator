/**
 * Which repositories this machine's operator has enlisted for orchestration
 * (M2 slice 3).
 *
 * ── One location, outside every repository and every worktree ──────────────
 *
 *     <OS user profile>/.agent-orchestrator/repositories.yaml
 *
 * Every command before this slice named exactly one repository on the command
 * line — `--repository <path>`, required and never defaulted. That makes the
 * orchestrator repository-*agnostic*, which is not the same as
 * repository-*plural*: an invocation could act on any repository, and on one.
 * This module is where "which repositories are there at all" becomes a value the
 * build can hold.
 *
 * The list comes from that file and from nowhere else. Not from a repository
 * profile, not from repository content, not from a commit, not from a CLI option
 * and not from the environment. The shape is `delivery-automation.ts`'s, for the
 * reason that module gives and one this slice adds: the root is derived from
 * `os.userInfo()` through `config/internal/path-provider.ts`, which consults no
 * environment block, so a parent process, a repository file or an agent writing
 * inside its own worktree cannot place this file or move where it is looked for
 * — and here that matters more, because a repository that could add itself to
 * this list could nominate *itself* as work for an orchestrator that had not
 * been pointed at it.
 *
 * ("A caller" is deliberately absent from that list, exactly as it is in
 * `delivery-automation.ts`. Both functions below take a {@link PathProvider}, so
 * a caller inside this package can point the lookup anywhere — that is the test
 * seam. The property that holds is narrower and is a fact about the tree: the
 * registry is read from exactly one place in `src/`, `cli/repositories-command.ts`,
 * which the shipped entry point registers with no seams at all, and
 * `package.json` exports only that entry point. That sentence is a pin rather
 * than a claim — `tests/m2-03-cross-repository-selection.test.ts` enumerates the
 * importers — because an earlier draft of it named a file that does not exist.)
 *
 * ── What an entry declares, and what it does not ───────────────────────────
 *
 * An entry declares **where**: one absolute repository path. It does not declare
 * *who* — no name, no id, no label. That is not an omission, it is the whole
 * shape of the thing: `repository.id` already exists, is validated by
 * `RepositoryIdSchema`, is documented as "stable identity from the profile", and
 * is what `TaskState.repositoryId` already carries. A registry that also named
 * repositories would be a second source of truth for the name, and the two could
 * disagree — with a durable task state pointing at whichever of them wrote it.
 * So identity is read out of each repository's own committed profile, by the one
 * module whose job that is.
 *
 * ── Ambiguity is refused, and the refusals are load-bearing ────────────────
 *
 * Two accepted entries may not be the same **canonical root**, and may not share
 * a **`gitCommonDir`**. Neither refusal is tidiness, and both are keyed on facts
 * `realpathSync.native` established rather than on anything a repository wrote:
 *
 *  - **the canonical root** is what every per-repository artefact hangs off —
 *    the task state directory (`state/state-location.ts`), the workspace parent,
 *    the ledgers. One directory enlisted twice is one repository the build would
 *    treat as two, and it is the ordinary hand-editing mistake: two spellings of
 *    one path, or a path and a junction to it.
 *  - **`gitCommonDir`** is the execution lease's key, and it is the local
 *    administrative identity: two worktrees of one clone share it and are one
 *    execution domain, while two clones of one remote do not and are two. Two
 *    entries sharing it contend for one lease — and, measured rather than
 *    assumed, `deriveTaskWorkspaceIdentity` would give a task of the same id in
 *    both the *same* work branch `ao/task/<id>` in one Git object store.
 *
 * Both are `DUPLICATE_*` refusals of the whole registry rather than a rule for
 * picking a winner: which of two contradictory entries is in force must not
 * depend on which line came first.
 *
 * ── Two entries MAY share a `repository.id`, and that is deliberate ────────
 *
 * An earlier form of this module refused that pair, to make
 * `plan-across-repositories.ts`'s tie-break total. Three things were wrong with
 * it, and the third is the one that decided it:
 *
 *  1. two clones of one remote answering the same id is the configuration
 *     `resolve-repository.ts:258` and `execution-lease.ts` establish as
 *     **supported and independent** — the lease is keyed on `gitCommonDir`,
 *     state files are per root, and workspaces derive from the root. Nothing
 *     structural breaks;
 *  2. this repository's own working practice is a scratch clone of itself, so
 *     the refusal would have fired on the first pair anyone registered;
 *  3. `repository.id` is read out of a profile **inside a repository this
 *     orchestrator writes to**. Making the global ordering depend on it would
 *     let one driven repository change which repository is selected — and,
 *     under a whole-registry refusal, stop every other repository — by
 *     committing an edit to its own file. An ordering that a subject of the
 *     ordering can rewrite is not an ordering.
 *
 * So the id stays what `declared-identity.ts` says it is: a declared label,
 * carried for display and for the records that already hold it. What the
 * ranking and the refusals key on are the canonical root and the Git common
 * directory, neither of which any repository content can move.
 *
 * ── Why this is not in `src/repo/` ─────────────────────────────────────────
 *
 * It was, for one round, and a structural pin caught it:
 * `tests/repo-resolution.test.ts` sweeps `src/repo/` and refuses **any** module
 * there that imports `config/paths.js`, on the grounds that
 *
 *   > a resolver that consulted it would be deriving a target repository's
 *   > contract from the orchestrator's own checkout, which is the exact coupling
 *   > V1-01 exists to prevent.
 *
 * This module does import it — `orchestratorHome` — and it is not a resolver, so
 * the letter of the pin caught something its reason does not describe. The right
 * answer is still to move rather than to carve out an exemption: `src/repo/` is
 * the layer that answers *what is this one repository*, from that repository's
 * own committed files and nothing else, and a module that reads a machine-wide
 * operator document does not belong in it whatever the pin says. The exemption
 * would have been the beginning of a second rule about where a repository's
 * contract may come from.
 *
 * ── Not Git's registry ─────────────────────────────────────────────────────
 *
 * "Registry" already names one thing in this build: Git's own worktree registry,
 * which `worktree/worktree-registry.ts` reads and which is the authority for
 * which worktrees exist. This module is unrelated to it. That one is Git's
 * answer about one repository; this one is the operator's answer about which
 * repositories there are.
 *
 * ── The vocabulary is closed, in both directions ───────────────────────────
 *
 * `schemaVersion` is a literal, so a document written against a future contract
 * is refused rather than reinterpreted under this build's assumptions. Every
 * object is `.strict()`, so a key this build does not know — including the key
 * some later slice would add for scheduling, priorities or concurrency — refuses
 * the whole document instead of being ignored. There is no default, no coercion,
 * no truthiness test and no `??` fallback anywhere below.
 *
 * ── What this module does not do ───────────────────────────────────────────
 *
 * It starts no process, opens no repository and reads no task. It answers what
 * the operator wrote down. Turning that into resolved repositories is
 * {@link resolveRegisteredRepositories}, which is separate because it costs Git
 * child processes and because a document that cannot be read should never get
 * that far.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { z } from 'zod';

import { orchestratorHome } from '../config/paths.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { comparePathIdentity } from '../core/path-identity.js';
import { loadSafeYamlDocument } from '../yaml/safe-yaml.js';
import {
  resolveRepository as resolveRepositoryProduction,
  type RepositoryResolutionFailureCode,
  type ResolvedRepository,
} from '../repo/resolve-repository.js';

/** The one file name. There is no alternative spelling and no `.yml` fallback. */
export const REPOSITORY_REGISTRY_FILE_NAME = 'repositories.yaml';

/**
 * The one contract version this build understands.
 *
 * A literal rather than a minimum, for the reason `delivery-automation.ts` gives:
 * a document written against a later contract may mean something this build
 * would act on wrongly.
 */
export const REPOSITORY_REGISTRY_SCHEMA_VERSION = 1;

/**
 * Largest registry document this build will read.
 *
 * A ceiling rather than a guess, and refused before parsing: an enormous file is
 * never turned into a document. 64 KiB holds several hundred paths.
 */
export const MAX_REPOSITORY_REGISTRY_BYTES = 65_536;

/**
 * The most entries one registry may declare.
 *
 * A bound rather than a policy: every entry costs Git child processes to
 * resolve, and an unbounded list would make one file decide how much work a
 * single command does. It is not a statement about how many repositories an
 * operator *should* have.
 */
export const MAX_REGISTERED_REPOSITORIES = 256;

/** The character no filesystem path may contain. */
const NUL = '\u0000';

/**
 * One declared location.
 *
 * The path is required to be absolute *here*, at the contract boundary, rather
 * than left for the resolver to refuse. Both refuse it; stating it twice is
 * deliberate, because the two refusals mean different things to an operator — a
 * relative path in this file is a document they wrote wrongly, and the resolver's
 * is about a repository. `.strict()` so a `name:` or `priority:` key a later
 * slice might add refuses the document rather than being ignored.
 */
const RegistryEntrySchema = z
  .object({
    path: z
      .string()
      .min(1, 'A registered repository path must not be empty.')
      .max(4096, 'A registered repository path must not exceed 4096 characters.')
      .refine((value) => !value.includes(NUL), 'A path must not contain a NUL character.')
      .refine((value) => isAbsolute(value), 'A registered repository path must be absolute.'),
  })
  .strict();

const RepositoryRegistrySchema = z
  .object({
    schemaVersion: z.literal(REPOSITORY_REGISTRY_SCHEMA_VERSION),
    /**
     * The repositories this operator has enlisted. May be empty, which is a
     * decision the operator wrote down and means the same as no file: there is
     * nothing to orchestrate. It is not "all work complete" — see
     * {@link CrossRepositoryPlanCode}.
     */
    repositories: z.array(RegistryEntrySchema).max(MAX_REGISTERED_REPOSITORIES),
  })
  .strict();

/** Where the registry lives. A pure function of the OS user identity. */
export function repositoryRegistryPath(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(orchestratorHome(provider), REPOSITORY_REGISTRY_FILE_NAME);
}

/**
 * Every way the registry can be present and unusable. Closed, and carrying
 * nothing from the file itself — a refusal must not become the channel for the
 * value it refused.
 */
export const REPOSITORY_REGISTRY_REFUSALS = [
  /** The OS could not be asked where the user profile is, so there is no place to look. */
  'PROFILE_UNAVAILABLE',
  /** The file exists and could not be read. */
  'REGISTRY_UNREADABLE',
  'REGISTRY_TOO_LARGE',
  /** Not one well-formed, warning-free YAML document. */
  'REGISTRY_MALFORMED',
  /** Well-formed, and carries a mapping key this boundary refuses by name. */
  'REGISTRY_FORBIDDEN_KEY',
  /**
   * A document that is not this contract: a version this build does not
   * understand, an unknown key, a missing field, an entry that is not a mapping,
   * a path that is empty, relative, over-long or carries a NUL, or more entries
   * than {@link MAX_REGISTERED_REPOSITORIES}.
   */
  'REGISTRY_CONTRACT_VIOLATION',
  /**
   * Two entries declare the same path, character for character.
   *
   * A cheap document-sanity refusal, and deliberately *not* the duplicate
   * guarantee: it compares the strings as written, so `D:\Repo` and `D:\repo\`
   * are two entries to it. What actually establishes that two entries are not
   * the same repository is `DUPLICATE_EXECUTION_DOMAIN`, which compares
   * canonical Git identities after resolution. This one exists so an obviously
   * self-contradictory document is refused before N Git processes are started
   * to discover the same thing.
   */
  'REGISTRY_DUPLICATE_PATH',
] as const;

export type RepositoryRegistryRefusal = (typeof REPOSITORY_REGISTRY_REFUSALS)[number];

/** One entry, as the operator wrote it. Nothing has been opened yet. */
export interface RegistryEntry {
  /** The declared absolute path, exactly as written. Not canonicalised. */
  readonly path: string;
}

export type RepositoryRegistryOutcome =
  /** No file. There is no registry, which is not the same as an empty one. */
  | { readonly state: 'NOT_REGISTERED' }
  /** A file that cannot be used. Nothing is enlisted, and the operator is told. */
  | { readonly state: 'UNUSABLE'; readonly code: RepositoryRegistryRefusal }
  | {
      readonly state: 'REGISTERED';
      /**
       * SHA-256 of the **exact bytes** this read took off the disk, before any
       * decoding, parsing or normalisation.
       *
       * Present only on this member, for the reason `delivery-automation.ts`
       * gives: a refusal may not carry anything derived from the file it
       * refused, while a document this build has acted on has to be nameable
       * without the name being a copy of the file.
       */
      readonly registryDigest: string;
      /** The declared entries, in document order. May be empty. */
      readonly entries: readonly RegistryEntry[];
    };

const unusable = (code: RepositoryRegistryRefusal): RepositoryRegistryOutcome =>
  Object.freeze({ state: 'UNUSABLE' as const, code });

/**
 * Reads the operator's repository registry, or says why there is none this build
 * can act on.
 *
 * Never throws. Every failure — including the operating system refusing to say
 * where the profile is — is a return value, because a configuration problem may
 * not become a crash.
 */
export function loadRepositoryRegistry(
  provider: PathProvider = OS_PATH_PROVIDER,
): RepositoryRegistryOutcome {
  let path: string;
  try {
    path = repositoryRegistryPath(provider);
  } catch {
    // `trustedProfileDirectory` throws rather than guessing. Its message is
    // already value-free, and it is dropped here regardless.
    return unusable('PROFILE_UNAVAILABLE');
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (safeErrnoCode(error) === 'ENOENT') {
      return Object.freeze({ state: 'NOT_REGISTERED' as const });
    }
    // Everything else — a directory in that place (EISDIR), a permission
    // refusal, an I/O error — is a file that exists in some sense and could not
    // be read. It is deliberately not folded into NOT_REGISTERED: "the operator
    // enlisted nothing" and "the operator enlisted something and I could not
    // tell what" send a person to different places.
    return unusable('REGISTRY_UNREADABLE');
  }

  if (bytes.byteLength > MAX_REPOSITORY_REGISTRY_BYTES) return unusable('REGISTRY_TOO_LARGE');

  const parsed = loadSafeYamlDocument(bytes.toString('utf8'));
  if (parsed.outcome === 'FORBIDDEN_KEY') return unusable('REGISTRY_FORBIDDEN_KEY');
  if (parsed.outcome !== 'DOCUMENT') return unusable('REGISTRY_MALFORMED');

  const contract = RepositoryRegistrySchema.safeParse(parsed.document);
  // The Zod issue is deliberately not carried: it is a message authored by a
  // dependency about a file this module refuses to quote.
  if (!contract.success) return unusable('REGISTRY_CONTRACT_VIOLATION');

  const seen = new Set<string>();
  for (const entry of contract.data.repositories) {
    if (seen.has(entry.path)) return unusable('REGISTRY_DUPLICATE_PATH');
    seen.add(entry.path);
  }

  return Object.freeze({
    state: 'REGISTERED' as const,
    // Over `bytes`, which is what `readFileSync` returned — not over the decoded
    // string and not over the parsed document. The claim is "these are the bytes
    // this invocation acted under".
    registryDigest: createHash('sha256').update(bytes).digest('hex'),
    entries: Object.freeze(
      contract.data.repositories.map((entry) => Object.freeze({ path: entry.path })),
    ),
  });
}

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * One enlisted repository, resolved.
 *
 * Carries the whole frozen {@link ResolvedRepository} rather than its path or
 * its id. That is the execution binding, and it is a type rather than a
 * convention: `planRun` and `startTask` already take exactly this value, so a
 * selection that carries it cannot be handed onward in a form that would let a
 * downstream step re-derive the repository from anywhere else.
 */
export interface RegisteredRepository {
  /** The entry's declared path, as written. Kept for reporting, never for identity. */
  readonly declaredPath: string;
  /** The resolved repository. Deeply frozen; `root` and `id` are canonical. */
  readonly repository: ResolvedRepository;
}

/** Every way resolving a registry can fail. Closed. */
export const REGISTRY_RESOLUTION_REFUSALS = [
  /**
   * One entry did not resolve. The offending entry's **index** and the
   * resolver's own closed code are carried; the path is not, because a path is
   * host data and a refusal is not a channel for it.
   */
  'REPOSITORY_UNRESOLVABLE',
  /**
   * Two entries canonicalised to the same repository root.
   *
   * This is the authoritative duplicate check, and `REGISTRY_DUPLICATE_PATH` is
   * not: the strings `D:\Repo`, `d:\repo\` and a junction pointing at either are
   * four spellings of one directory, and only `realpathSync.native` — which
   * `resolveRepository` has already run by the time this fires — settles them.
   */
  'DUPLICATE_REPOSITORY_ROOT',
  /**
   * Two entries resolved into the same local Git execution domain.
   *
   * Distinct from `DUPLICATE_REPOSITORY_ROOT` and not implied by it: two Git
   * worktrees of one clone are two different canonical roots and one execution
   * domain.
   */
  'DUPLICATE_EXECUTION_DOMAIN',
] as const;

export type RegistryResolutionRefusal = (typeof REGISTRY_RESOLUTION_REFUSALS)[number];

export interface RegistryResolutionSuccess {
  readonly ok: true;
  /**
   * The enlisted repositories, in **`repository.id` order** — not in document
   * order.
   *
   * Sorted here, once, so that no consumer's answer can depend on how the
   * operator happened to order the file. `plan-across-repositories.ts` states
   * the same guarantee for the ranking it builds on top; this is the half of it
   * that belongs to resolution.
   */
  readonly repositories: readonly RegisteredRepository[];
}

export interface RegistryResolutionFailure {
  readonly ok: false;
  readonly code: RegistryResolutionRefusal;
  /** A static sentence. Carries no path, no id and no host data. */
  readonly detail: string;
  /** The offending entry's index in the document, or `null`. */
  readonly entryIndex: number | null;
  /** The resolver's own code, for `REPOSITORY_UNRESOLVABLE`; `null` otherwise. */
  readonly resolutionCode: RepositoryResolutionFailureCode | null;
}

export type RegistryResolutionResult = RegistryResolutionSuccess | RegistryResolutionFailure;

/** One static sentence per refusal. Nothing is interpolated. */
const RESOLUTION_DETAIL: Readonly<Record<RegistryResolutionRefusal, string>> = Object.freeze({
  REPOSITORY_UNRESOLVABLE: 'A registered repository could not be resolved.',
  DUPLICATE_REPOSITORY_ROOT:
    'Two registered entries are the same repository. One directory enlisted twice would be ' +
    'planned twice and would contend with itself.',
  DUPLICATE_EXECUTION_DOMAIN:
    'Two registered entries are the same local Git execution domain. They would contend for ' +
    'one execution lease and derive the same work branch.',
});

function resolutionFailure(
  code: RegistryResolutionRefusal,
  entryIndex: number | null = null,
  resolutionCode: RepositoryResolutionFailureCode | null = null,
): RegistryResolutionFailure {
  return Object.freeze({
    ok: false as const,
    code,
    detail: RESOLUTION_DETAIL[code],
    entryIndex,
    resolutionCode,
  });
}

/**
 * Order on canonical repository roots, by UTF-16 code unit.
 *
 * The same rule and the same reason as `plan/task-id.ts`'s `compareTaskIds`, and
 * written out rather than borrowed: that function is about task ids, and a
 * comparator named for one kind of identifier being applied to another is a
 * claim about them being the same kind of thing. Deliberately **not**
 * `localeCompare`, because a collation that depended on the machine's locale
 * would make which repository wins a tie a property of the operator's Windows
 * region setting.
 *
 * It is a *total* order on the values it is used for, and only because of what
 * has already happened by then: `resolveRegisteredRepositories` has refused
 * `DUPLICATE_REPOSITORY_ROOT`, so no two roots reaching this are `EQUAL` under
 * `comparePathIdentity`, so no two differ only in case or trailing separator,
 * so no two are equal as strings. Applied to an unfiltered list it would not be
 * total, and this comparator does not claim to make it so.
 */
export function compareRepositoryRoots(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** The seam. Production passes nothing and gets `resolveRepository`. */
export interface RegistryResolutionDependencies {
  readonly resolveRepository?: typeof resolveRepositoryProduction;
}

/**
 * Resolves every entry, and refuses the whole registry if any of them is
 * unusable or if two of them are the same repository.
 *
 * ── Sequential, and that is the contract ───────────────────────────────────
 *
 * Entries are resolved one at a time, in document order, and the first failure
 * stops the walk. Not for safety — `resolveRepository` is independent per
 * repository — but so that *which* failure is reported is a property of the
 * document rather than of which Git child happened to finish first. A
 * `Promise.all` here would make the reported `entryIndex` a race.
 *
 * ── Refusing the whole registry, rather than skipping the bad entry ────────
 *
 * A registry with one unresolvable entry answers `REPOSITORY_UNRESOLVABLE` and
 * no repositories at all. Skipping it and carrying on would mean every later
 * answer — including "this is the next task" — was computed over a candidate set
 * the caller did not know was incomplete, which turns a configuration mistake
 * into a scheduling decision silently. An operator who wants the remaining
 * repositories orchestrated can say so by editing one line; nothing here can
 * infer that they meant to.
 */
export async function resolveRegisteredRepositories(
  entries: readonly RegistryEntry[],
  dependencies: RegistryResolutionDependencies = {},
): Promise<RegistryResolutionResult> {
  const resolve = dependencies.resolveRepository ?? resolveRepositoryProduction;

  const resolved: RegisteredRepository[] = [];
  for (const [index, entry] of entries.entries()) {
    const outcome = await resolve({ repositoryPath: entry.path });
    if (!outcome.ok) {
      return resolutionFailure('REPOSITORY_UNRESOLVABLE', index, outcome.code);
    }
    resolved.push(Object.freeze({ declaredPath: entry.path, repository: outcome.repository }));
  }

  // Ambiguity is checked after resolution, because both facts it needs — the
  // canonical root and the canonical Git common directory — are things
  // `realpathSync.native` established inside the resolver, not things the
  // document states and not things a repository wrote.
  //
  // `comparePathIdentity` rather than string equality: both are paths, and two
  // spellings of one path — case, separator form, an 8.3 alias, a junction —
  // are the same place. Comparing the strings would let exactly the pairs these
  // refusals exist for through. Both sweeps are O(n^2) over at most
  // MAX_REGISTERED_REPOSITORIES entries, which is the price of not having a
  // canonical string key for a path identity this build compares structurally.
  //
  // Roots first, then domains, and the order is the reporting decision rather
  // than a correctness one: a pair that is the same root is also the same
  // domain, and "you registered one directory twice" is the sentence that names
  // what the operator actually did.
  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const left = resolved[i]?.repository.root;
      const right = resolved[j]?.repository.root;
      if (left === undefined || right === undefined) continue;
      if (comparePathIdentity(left, right) === 'EQUAL') {
        return resolutionFailure('DUPLICATE_REPOSITORY_ROOT', j);
      }
    }
  }

  for (let i = 0; i < resolved.length; i += 1) {
    for (let j = i + 1; j < resolved.length; j += 1) {
      const left = resolved[i]?.repository.gitCommonDir;
      const right = resolved[j]?.repository.gitCommonDir;
      if (left === undefined || right === undefined) continue;
      if (comparePathIdentity(left, right) === 'EQUAL') {
        return resolutionFailure('DUPLICATE_EXECUTION_DOMAIN', j);
      }
    }
  }

  // Sorted by canonical root, once, here. Every consumer therefore sees one
  // order, and it is not the operator's file order.
  //
  // By root and not by `repository.id`, for the reason the header gives: two
  // enlisted repositories may legitimately declare the same id, so an id sort
  // would tie and leave the answer to `Array.prototype.sort`'s stability — that
  // is, to the operator's file order, which is the one thing sorting here exists
  // to remove. The sort is total because the duplicate-root refusal above has
  // already run: no two entries are the same root by the time this line is
  // reached.
  resolved.sort((a, b) => compareRepositoryRoots(a.repository.root, b.repository.root));

  return Object.freeze({ ok: true as const, repositories: Object.freeze(resolved) });
}
