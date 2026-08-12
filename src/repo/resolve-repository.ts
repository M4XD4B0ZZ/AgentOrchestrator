/**
 * Repository resolution: turning an explicit path into a typed, validated,
 * frozen statement of *which repository this is and what contract governs it*.
 *
 * This is the orchestrator's first runtime layer. Everything after it — task
 * discovery, worktrees, the writer, verification, review — reads the value this
 * module produces and nothing else. It therefore contains no knowledge of any
 * particular repository: the only project-specific facts in the system live in
 * the target repository's own profile.
 *
 * ── Fail-closed, in both directions ────────────────────────────────────────
 *
 * A repository resolves only when *every* step succeeded: the path is real and
 * canonical, it is the root of a Git repository (not a subdirectory of one), a
 * profile exists at the one canonical location, it parses, it satisfies the
 * contract, every path it declares is contained in the repository, its default
 * branch is a legal branch name that exists locally, every required capability
 * is positively available, and its remote expectation holds. A failure at any
 * step returns a closed code and no repository at all — never a partially
 * resolved value.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 *
 * **`process.cwd()`.** The caller states the repository; this module never
 * guesses it. A resolution that depended on where the operator happened to
 * stand would make the answer a property of the shell rather than of the input.
 *
 * **Environment overrides.** No variable names the repository, the profile
 * path, the profile format or the default branch. The child Git processes
 * receive `PATH`/`PATHEXT` and nothing else (see `git-query.ts`), so not even
 * `GIT_DIR` can redirect which repository answers.
 *
 * **Writes.** Git is used read-only. Nothing is created, checked out, fetched
 * or committed.
 *
 * **Exceptions across the boundary.** Failures are data. No `fs`, `git`, YAML
 * or Zod exception text leaves this module — those messages quote paths,
 * command lines and the offending input itself, which is exactly the class of
 * value `core/safe-error.ts` exists to keep out of user-facing output. What a
 * caller gets is a code from a closed set and a sentence written here.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import {
  classify,
  inspectContainedFile,
  isContained,
  samePath,
  type Entry,
} from './internal/contained-file.js';
import {
  capabilitySatisfied,
  probeCodegraphCapability,
  type CapabilityAssessment,
  type CapabilityStatus,
} from './capabilities.js';
import { isValidBranchName, localBranchRef } from './branch-name.js';
import { gitQuery } from './git-query.js';
import { loadProfileDocument } from './profile-yaml.js';
import {
  repoProfileDirectory,
  repoProfilePath,
  REPO_PROFILE_RELATIVE_PATH,
} from './profile-location.js';
import { safeParseRepoProfile, type RepoProfile } from './repo-profile.js';

// ── Failure vocabulary ─────────────────────────────────────────────────────

/**
 * Every way resolution can fail, as a closed set.
 *
 * These are the machine-readable outcome of the step: stable across builds,
 * safe to log, safe to branch on, and carrying nothing from the host, the
 * profile or an exception.
 */
export const REPOSITORY_RESOLUTION_FAILURE_CODES = [
  /** The input is not a usable absolute repository path. */
  'REPOSITORY_PATH_INVALID',
  /** Nothing exists at the given path, or it could not be canonicalised. */
  'REPOSITORY_NOT_FOUND',
  /** The canonical path exists but is not a directory. */
  'REPOSITORY_NOT_DIRECTORY',
  /** A link, or a path escaping the repository root, was found where a
   *  contained, link-free path is required. */
  'REPOSITORY_PATH_UNSAFE',
  /** Git could not be started, timed out, or exceeded its output budget. */
  'GIT_UNAVAILABLE',
  /** The path is not inside any Git repository. */
  'NOT_A_GIT_REPOSITORY',
  /** The path is inside a Git repository but is not its root. */
  'REPOSITORY_ROOT_MISMATCH',
  /** No profile at the one canonical location. */
  'PROFILE_MISSING',
  /** Something is at the profile path, but it is not a regular file. */
  'PROFILE_NOT_REGULAR_FILE',
  /** The profile exceeds the byte ceiling and is not read. */
  'PROFILE_TOO_LARGE',
  /** The profile exists but could not be read. */
  'PROFILE_READ_FAILED',
  /** The profile is not well-formed YAML. */
  'PROFILE_PARSE_FAILED',
  /** The profile is well-formed YAML but violates the contract. */
  'PROFILE_SCHEMA_INVALID',
  /** The declared default branch is not a legal Git branch name. */
  'DEFAULT_BRANCH_INVALID',
  /** The declared default branch does not exist locally. */
  'DEFAULT_BRANCH_NOT_FOUND',
  /** A capability the profile marks REQUIRED is not positively available. */
  'REQUIRED_CAPABILITY_UNAVAILABLE',
  /** The profile requires a remote and the repository has none. */
  'REMOTE_REQUIRED_BUT_ABSENT',
  /**
   * A declared context source exists and is not a regular file — a directory,
   * a link, a device.
   *
   * Refused here, at resolution, because it is a *configuration* error and this
   * is where configuration is judged. Left to execution it became a permanent
   * `HUMAN_DECISION_REQUIRED` on every task in the repository, which tells an
   * operator that a task is stuck rather than that a profile line is wrong.
   *
   * A source that simply does not exist is **not** this: absence is an ordinary
   * execution-time `MISSING`, and a repository is allowed to declare a document
   * it has not written yet. Only a path that is there and is the wrong *kind*
   * of thing is a configuration error. Directories and globs may become legal
   * later, with their own source type and a bounded enumeration; until then
   * `docs/` is a mistake, and saying so early is the whole point.
   */
  'CONTEXT_SOURCE_NOT_REGULAR_FILE',
] as const;

export type RepositoryResolutionFailureCode =
  (typeof REPOSITORY_RESOLUTION_FAILURE_CODES)[number];

export type RepositoryResolutionCode = 'RESOLVED' | RepositoryResolutionFailureCode;

/**
 * One static sentence per failure code.
 *
 * Nothing is interpolated: not the repository path, not the profile path, not
 * the branch name, not a Zod issue message and not an exception's text. A
 * failure must not become a channel for the value the caller was not allowed to
 * learn, and a profile is repository-supplied input.
 */
const FAILURE_DETAIL: Readonly<Record<RepositoryResolutionFailureCode, string>> = Object.freeze({
  REPOSITORY_PATH_INVALID:
    'The repository path must be a non-empty absolute path with no embedded NUL character.',
  REPOSITORY_NOT_FOUND: 'No filesystem object exists at the given repository path.',
  REPOSITORY_NOT_DIRECTORY: 'The canonical repository path is not a directory.',
  REPOSITORY_PATH_UNSAFE:
    'A required path is a link, or resolves outside the canonical repository root.',
  GIT_UNAVAILABLE: 'A read-only Git query could not be completed.',
  NOT_A_GIT_REPOSITORY: 'The given path is not inside a Git repository.',
  REPOSITORY_ROOT_MISMATCH:
    'The given path is inside a Git repository but is not that repository\u2019s root.',
  PROFILE_MISSING: `No repository profile exists at ${REPO_PROFILE_RELATIVE_PATH}.`,
  PROFILE_NOT_REGULAR_FILE: 'The repository profile path does not hold a regular file.',
  PROFILE_TOO_LARGE: 'The repository profile exceeds the maximum accepted size.',
  PROFILE_READ_FAILED: 'The repository profile could not be read.',
  PROFILE_PARSE_FAILED: 'The repository profile is not well-formed YAML.',
  PROFILE_SCHEMA_INVALID: 'The repository profile does not satisfy the repository-profile contract.',
  DEFAULT_BRANCH_INVALID: 'The declared default branch is not a legal Git branch name.',
  DEFAULT_BRANCH_NOT_FOUND: 'The declared default branch does not exist in this repository.',
  REQUIRED_CAPABILITY_UNAVAILABLE:
    'A capability the profile declares as required could not be proven available.',
  REMOTE_REQUIRED_BUT_ABSENT:
    'The profile requires a configured remote and the repository has none.',
  CONTEXT_SOURCE_NOT_REGULAR_FILE:
    'A declared context source is not a regular file inside the repository.',
});

// ── Resolved value ─────────────────────────────────────────────────────────

export interface ResolvedTaskSource {
  readonly kind: RepoProfile['taskSource']['kind'];
  /** Repository-relative, POSIX-shaped, verified to be contained in the root. */
  readonly path: string;
}

export interface ResolvedContextPolicy {
  readonly canonicalSources: readonly string[];
}

export interface ResolvedVerificationPhase {
  readonly phase: RepoProfile['verification']['phases'][number]['phase'];
  readonly command: readonly string[];
}

export interface ResolvedVerificationPolicy {
  readonly phases: readonly ResolvedVerificationPhase[];
}

export interface ResolvedScopePolicy {
  readonly allowedPaths: readonly string[];
  /** Wins over {@link allowedPaths} where the two overlap. */
  readonly protectedPaths: readonly string[];
}

export interface ResolvedCapabilities {
  readonly codegraph: CapabilityAssessment;
}

export interface ResolvedRemote {
  readonly required: boolean;
  /**
   * Whether the repository has at least one configured remote. Only the fact is
   * recorded — never a remote name and never a URL, which would put a host and
   * possibly a credential into a value that gets logged.
   */
  readonly present: boolean;
}

/**
 * A repository the orchestrator may act on, and the contract governing it.
 *
 * Deeply frozen. Every later step reads this value; none of them may edit it,
 * and none of them may re-derive a policy from the raw YAML — which is why no
 * raw document is carried here at all.
 */
export interface ResolvedRepository {
  /** Canonical, absolute, existing repository root. Never CWD-derived. */
  readonly root: string;
  /** Stable identity from the profile; suitable for `TaskState.repositoryId`. */
  readonly id: string;
  /**
   * The **local Git administrative identity**: the canonical, absolute
   * `git-common-dir` of this checkout.
   *
   * Distinct from {@link id}, and the distinction is the whole reason this field
   * exists. `id` is *declared logical* identity, so two clones of one remote
   * answer the same `id` while being two independent local execution domains,
   * and two worktrees of one clone answer the same `id` while being one. Only
   * the common directory separates those cases — it is what proved worktree
   * membership in V2-06A, and it is what the execution lease is keyed on.
   *
   * Resolved here rather than queried by the lease, so that *which repository
   * this is* has one answer produced by the one module whose job that is.
   */
  readonly gitCommonDir: string;
  /** Validated, locally existing default branch. */
  readonly defaultBranch: string;
  /** Canonical absolute path of the profile that produced this value. */
  readonly profilePath: string;
  readonly schemaVersion: number;
  readonly taskSource: ResolvedTaskSource;
  readonly context: ResolvedContextPolicy;
  readonly capabilities: ResolvedCapabilities;
  readonly verification: ResolvedVerificationPolicy;
  readonly scope: ResolvedScopePolicy;
  readonly completion: { readonly maxReviewRounds: number };
  readonly remote: ResolvedRemote;
}

export interface RepositoryResolutionSuccess {
  readonly ok: true;
  readonly code: 'RESOLVED';
  readonly repository: ResolvedRepository;
}

export interface RepositoryResolutionFailure {
  readonly ok: false;
  readonly code: RepositoryResolutionFailureCode;
  /** A sentence from {@link FAILURE_DETAIL}. Carries no host or input data. */
  readonly detail: string;
  /**
   * How many contract violations were counted, for `PROFILE_SCHEMA_INVALID`
   * only; `null` otherwise. A count, not the issues: an issue message quotes
   * the offending key and value.
   */
  readonly issueCount: number | null;
}

export type RepositoryResolutionResult =
  | RepositoryResolutionSuccess
  | RepositoryResolutionFailure;

export interface RepositoryResolutionInput {
  /** Absolute path of the repository root. Required; never defaulted. */
  readonly repositoryPath: string;
}

function failure(
  code: RepositoryResolutionFailureCode,
  issueCount: number | null = null,
): RepositoryResolutionFailure {
  return Object.freeze({ ok: false as const, code, detail: FAILURE_DETAIL[code], issueCount });
}

// ── Path helpers ───────────────────────────────────────────────────────────

/** The one character no filesystem path may contain. */
const NUL = '\u0000';

/** Profiles are human-authored policy documents; 256 KiB is already generous. */
const MAX_PROFILE_BYTES = 262_144;

/**
 * The safety chain lives in `internal/contained-file.ts`.
 *
 * This module used to hold `isContained`, `samePath` and `classify` verbatim,
 * plus the same six-step chain inline — while V2-02's commit message claimed
 * discovery had held "the only copy". It had not. The type policy below is
 * still this module's own; the chain is not.
 */
type LinkFreeEntry = Entry;

// ── Resolution ─────────────────────────────────────────────────────────────

/**
 * Resolves an explicit repository path into a validated {@link ResolvedRepository}.
 *
 * Never throws for an expected condition: every failure is a
 * {@link RepositoryResolutionFailure} carrying a closed code.
 */
export async function resolveRepository(
  input: RepositoryResolutionInput,
): Promise<RepositoryResolutionResult> {
  // --- 1. The input itself -------------------------------------------------
  const given: unknown = input?.repositoryPath;
  if (typeof given !== 'string' || given.trim().length === 0 || given.includes(NUL)) {
    return failure('REPOSITORY_PATH_INVALID');
  }
  // An absolute path is required rather than resolved against `process.cwd()`:
  // a relative input has no meaning without a working directory, and adopting
  // one would reintroduce exactly the dependency this module refuses.
  if (!isAbsolute(given)) return failure('REPOSITORY_PATH_INVALID');

  // --- 2. Canonical root ---------------------------------------------------
  let root: string;
  try {
    root = realpathSync.native(given);
  } catch {
    return failure('REPOSITORY_NOT_FOUND');
  }
  const rootEntry = classify(root);
  if (rootEntry.kind === 'ABSENT') return failure('REPOSITORY_NOT_FOUND');
  if (rootEntry.kind !== 'DIRECTORY') return failure('REPOSITORY_NOT_DIRECTORY');

  // --- 3. It must be a Git repository, and its root ------------------------
  const toplevel = await gitQuery(root, ['rev-parse', '--show-toplevel']);
  if (toplevel.outcome === 'UNAVAILABLE') return failure('GIT_UNAVAILABLE');
  if (toplevel.outcome === 'NONZERO_EXIT' || toplevel.stdout === '') {
    return failure('NOT_A_GIT_REPOSITORY');
  }

  // Git answers with forward slashes on Windows; `resolve` restores the
  // platform form before the paths are compared, and `realpath` settles case
  // and 8.3 aliases so the comparison is between two canonical values.
  let canonicalToplevel: string;
  try {
    canonicalToplevel = realpathSync.native(resolvePath(toplevel.stdout));
  } catch {
    return failure('NOT_A_GIT_REPOSITORY');
  }
  if (!samePath(root, canonicalToplevel)) return failure('REPOSITORY_ROOT_MISMATCH');

  // A repository without a Git directory is not one, whatever `rev-parse` said.
  const gitDir = await gitQuery(root, ['rev-parse', '--git-dir']);
  if (gitDir.outcome === 'UNAVAILABLE') return failure('GIT_UNAVAILABLE');
  if (gitDir.outcome === 'NONZERO_EXIT' || gitDir.stdout === '') {
    return failure('NOT_A_GIT_REPOSITORY');
  }

  // The local administrative identity, asked for separately and left as its own
  // query rather than folded into the check above. The two answer different
  // questions — "does this checkout have a Git directory" and "which clone is it
  // part of" — and for a linked worktree they are different paths. Canonicalised
  // the same way `--show-toplevel` is, because Git answers with forward slashes
  // on Windows and a lease path is built from this value rather than merely
  // compared with it.
  const commonDir = await gitQuery(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (commonDir.outcome === 'UNAVAILABLE') return failure('GIT_UNAVAILABLE');
  if (commonDir.outcome === 'NONZERO_EXIT' || commonDir.stdout === '') {
    return failure('NOT_A_GIT_REPOSITORY');
  }
  let gitCommonDir: string;
  try {
    gitCommonDir = realpathSync.native(resolvePath(commonDir.stdout));
  } catch {
    return failure('NOT_A_GIT_REPOSITORY');
  }

  // --- 4. The profile, at the one canonical location -----------------------
  const profileDir = repoProfileDirectory(root);
  const profilePath = repoProfilePath(root);

  // Containment is re-derived rather than assumed. The paths are built by
  // joining onto a canonical root, so this holds by construction — which is
  // precisely why it is cheap to state and worth stating.
  if (!isContained(root, profileDir) || !isContained(root, profilePath)) {
    return failure('REPOSITORY_PATH_UNSAFE');
  }

  const dirEntry = classify(profileDir);
  if (dirEntry.kind === 'LINK') return failure('REPOSITORY_PATH_UNSAFE');
  if (dirEntry.kind === 'UNREADABLE') return failure('PROFILE_READ_FAILED');
  if (dirEntry.kind !== 'DIRECTORY') return failure('PROFILE_MISSING');

  const fileEntry = classify(profilePath);
  if (fileEntry.kind === 'LINK') return failure('REPOSITORY_PATH_UNSAFE');
  if (fileEntry.kind === 'ABSENT') return failure('PROFILE_MISSING');
  if (fileEntry.kind === 'UNREADABLE') return failure('PROFILE_READ_FAILED');
  if (fileEntry.kind !== 'FILE') return failure('PROFILE_NOT_REGULAR_FILE');
  if (fileEntry.size > MAX_PROFILE_BYTES) return failure('PROFILE_TOO_LARGE');

  // Neither segment is a link, so the canonical path must be the joined one.
  // A difference means something changed underneath us between the checks.
  let canonicalProfilePath: string;
  try {
    canonicalProfilePath = realpathSync.native(profilePath);
  } catch {
    return failure('PROFILE_READ_FAILED');
  }
  if (!samePath(profilePath, canonicalProfilePath) || !isContained(root, canonicalProfilePath)) {
    return failure('REPOSITORY_PATH_UNSAFE');
  }

  let text: string;
  try {
    text = readFileSync(canonicalProfilePath, 'utf8');
  } catch {
    return failure('PROFILE_READ_FAILED');
  }

  // --- 5. Parse ------------------------------------------------------------
  // Plain YAML 1.2 core schema: no custom tags, no merge keys, and the
  // library's own alias ceiling. The document may only produce the JSON data
  // model, so nothing exotic reaches the validator. See `profile-yaml.ts` for
  // why the mapping keys are inspected there, on the document tree, and why no
  // parser warning reaches the process.
  const loaded = loadProfileDocument(text);
  if (loaded.outcome === 'MALFORMED') return failure('PROFILE_PARSE_FAILED');
  if (loaded.outcome === 'FORBIDDEN_KEY') {
    // A key the contract refuses by name is a contract violation, classified
    // exactly as the generated JSON Schema classifies it: an unknown property.
    // The count is a count — never the key, never its position.
    return failure('PROFILE_SCHEMA_INVALID', loaded.count);
  }

  // --- 6. Validate against the contract ------------------------------------
  const parsed = safeParseRepoProfile(loaded.document);
  if (!parsed.success) {
    return failure('PROFILE_SCHEMA_INVALID', parsed.error.issues.length);
  }
  const profile = parsed.data;

  // --- 7. Every declared path must stay inside this repository -------------
  // The schema already forbids absolute paths, drive letters, backslashes and
  // `..` segments, so a violation here should be unreachable. It is checked
  // anyway, against the *canonical root*: the schema is a contract about
  // strings, and containment is a fact about the filesystem.
  const declaredPaths = [
    profile.taskSource.path,
    ...profile.context.canonicalSources,
    ...profile.scope.allowedPaths,
    ...profile.scope.protectedPaths,
  ];
  for (const declared of declaredPaths) {
    const absolute = resolvePath(root, ...declared.split('/'));
    if (!isContained(root, absolute) || samePath(root, absolute)) {
      return failure('REPOSITORY_PATH_UNSAFE');
    }
  }

  // --- 7b. A declared context source must be usable, if it is anything ------
  // Configuration is judged here, so a `docs/` entry is refused here. Left to
  // execution it became a permanent `HUMAN_DECISION_REQUIRED` on every task in
  // the repository — an operator told that a task is stuck rather than that a
  // profile line is wrong.
  //
  // The check is **the same proof execution runs** (`inspectContainedFile`),
  // not a cheaper approximation of it. The first version of this step used a
  // bare `classify`, which is a single `lstat`: `lstat` does not follow the
  // final component but does follow every parent, so a source under a
  // symlinked directory was classified `FILE` and resolved — and then execution,
  // running the full chain, refused it as `UNSAFE` and parked every task
  // forever. The same misconfiguration answered two different ways depending on
  // whether the link was the leaf or one component up. A gate that is weaker
  // than the gate it exists to pre-empt does not pre-empt it.
  //
  // Absence is deliberately *not* an error: a repository may declare a document
  // it has not written yet, and that is an ordinary execution-time `MISSING`.
  // `UNREADABLE` is left to execution too — a permission or I/O fault is a fact
  // about the machine, not about the profile, and refusing to resolve the
  // repository over one would blame the wrong thing.
  for (const declared of profile.context.canonicalSources) {
    const inspected = inspectContainedFile(root, resolvePath(root, ...declared.split('/')));
    if (!inspected.ok && inspected.refusal === 'UNSAFE') {
      return failure('CONTEXT_SOURCE_NOT_REGULAR_FILE');
    }
  }

  // --- 8. Default branch: legal name, and one that actually exists ---------
  const defaultBranch = profile.repository.defaultBranch;
  if (!isValidBranchName(defaultBranch)) return failure('DEFAULT_BRANCH_INVALID');

  // `--verify` on a fully qualified ref: no revision expression is evaluated,
  // no short-name disambiguation happens, and a missing ref is a non-zero exit
  // rather than an error message. There is no fallback to `main` or `master` —
  // a profile that names a branch means that branch.
  const branch = await gitQuery(root, ['rev-parse', '--verify', '--quiet', localBranchRef(defaultBranch)]);
  if (branch.outcome === 'UNAVAILABLE') return failure('GIT_UNAVAILABLE');
  if (branch.outcome === 'NONZERO_EXIT' || branch.stdout === '') {
    return failure('DEFAULT_BRANCH_NOT_FOUND');
  }

  // --- 9. Capability preflight --------------------------------------------
  const codegraphRequirement = profile.capabilities.codegraph;
  const codegraphStatus: CapabilityStatus = probeCodegraphCapability(root);
  const codegraphSatisfied = capabilitySatisfied(codegraphRequirement, codegraphStatus);
  if (!codegraphSatisfied) return failure('REQUIRED_CAPABILITY_UNAVAILABLE');

  // --- 10. Remote expectation ---------------------------------------------
  // A repository with no remote is an ordinary, valid target. Only a profile
  // that explicitly requires one can fail here.
  const remotes = await gitQuery(root, ['remote']);
  if (remotes.outcome === 'UNAVAILABLE') return failure('GIT_UNAVAILABLE');
  const remotePresent = remotes.outcome === 'OK' && remotes.stdout.length > 0;
  if (profile.remote.required && !remotePresent) return failure('REMOTE_REQUIRED_BUT_ABSENT');

  // --- 11. The frozen result ----------------------------------------------
  const repository: ResolvedRepository = Object.freeze({
    root,
    id: profile.repository.id,
    gitCommonDir,
    defaultBranch,
    profilePath: canonicalProfilePath,
    schemaVersion: profile.schemaVersion,
    taskSource: Object.freeze({
      kind: profile.taskSource.kind,
      path: profile.taskSource.path,
    }),
    context: Object.freeze({
      canonicalSources: Object.freeze([...profile.context.canonicalSources]),
    }),
    capabilities: Object.freeze({
      codegraph: Object.freeze({
        capability: 'codegraph' as const,
        requirement: codegraphRequirement,
        status: codegraphStatus,
        satisfied: codegraphSatisfied,
      }),
    }),
    verification: Object.freeze({
      phases: Object.freeze(
        profile.verification.phases.map((entry) =>
          Object.freeze({ phase: entry.phase, command: Object.freeze([...entry.command]) }),
        ),
      ),
    }),
    scope: Object.freeze({
      allowedPaths: Object.freeze([...profile.scope.allowedPaths]),
      protectedPaths: Object.freeze([...profile.scope.protectedPaths]),
    }),
    completion: Object.freeze({ maxReviewRounds: profile.completion.maxReviewRounds }),
    remote: Object.freeze({ required: profile.remote.required, present: remotePresent }),
  });

  return Object.freeze({ ok: true as const, code: 'RESOLVED' as const, repository });
}
