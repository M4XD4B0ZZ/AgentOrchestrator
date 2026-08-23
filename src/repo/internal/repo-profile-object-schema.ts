/**
 * INTERNAL — not part of the public runtime API.
 *
 * The *plain object shape* of a repository profile: field types only, no
 * cross-field invariants. It exists for exactly two consumers, mirroring the
 * task-state split (AO-009):
 *
 *  1. JSON Schema generation (`repo/json-schema.ts`), because JSON Schema
 *     cannot express the invariants below; and
 *  2. composition inside `repo/repo-profile.ts`, which layers them on top and
 *     exposes the result as `RepoProfileSchema`.
 *
 * It must never be re-exported from a public module or a barrel file.
 * `RepoProfileObjectSchema.parse()` accepts profiles the contract rejects — a
 * verification block with no `VERIFY` phase, a duplicated phase, a repeated
 * allowed path, a `schemaVersion` this build does not understand — so handing
 * it to callers as a validator would quietly bypass the contract.
 *
 * Use `RepoProfileSchema`, `parseRepoProfile()` or `safeParseRepoProfile()`.
 */

import { z } from 'zod';

import { RoundSchema } from '../../core/resume-point.js';

/**
 * Current version of the repository-profile contract. Bump on any breaking
 * shape change. A profile must state it, and a profile from a future contract
 * is refused rather than interpreted under this build's assumptions.
 */
export const REPO_PROFILE_SCHEMA_VERSION = 1;

/**
 * Characters a path, branch name or command token may contain.
 *
 * The set is the one `src/doctor/exec.ts` already enforces on every argument it
 * spawns a process with, and it is repeated rather than imported so that this
 * contract does not depend on the diagnostics module. Everything a v1 profile
 * needs to express — `npm`, `run`, `--reporter=dot`, `ops/work-items` — fits;
 * spaces, quotes, `&`, `|`, `^`, `%`, `<`, `>`, `(`, `)`, `$`, `;` and `` ` ``
 * do not, and are refused at the contract boundary rather than at the moment a
 * process is started. A profile is repository-supplied input: it must not be
 * able to place a shell metacharacter into a command line at all.
 */
const SHELL_INERT_PATTERN = /^[A-Za-z0-9._:@=+\\/-]+$/;

/** A single argv token of a verification command. Never a shell string. */
export const CommandTokenSchema = z
  .string()
  .min(1, 'A command token must not be empty.')
  .max(256, 'A command token must not exceed 256 characters.')
  .regex(SHELL_INERT_PATTERN, 'A command token must consist of shell-inert characters only.');

/**
 * A repository-relative location, in POSIX form.
 *
 * The rules are deliberately narrow and are all containment rules: an absolute
 * path, a drive letter, a UNC prefix, a backslash, a `.` or `..` segment and an
 * empty segment are each refused. A path that survives this cannot denote
 * anything outside the repository root, whatever the host platform does with
 * separators — the resolver still re-checks containment against the canonical
 * root, because a schema is a contract and not a filesystem.
 */
export const RepoRelativePathSchema = z
  .string()
  .min(1, 'A repository-relative path must not be empty.')
  .max(1024, 'A repository-relative path must not exceed 1024 characters.')
  .regex(SHELL_INERT_PATTERN, 'A repository-relative path must consist of shell-inert characters only.')
  .refine((value) => !value.includes('\\'), 'Use forward slashes: a repository-relative path is POSIX-shaped.')
  .refine((value) => !value.startsWith('/'), 'A repository-relative path must not be absolute.')
  .refine((value) => !/^[A-Za-z]:/.test(value), 'A repository-relative path must not carry a drive letter.')
  .refine(
    (value) => value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'A repository-relative path must not contain an empty, "." or ".." segment.',
  );

/**
 * A Git branch name, guarded only as far as a *string* can be guarded here.
 *
 * This is the charset floor that lets the name be handed to `git` as an
 * argument at all. The full `git check-ref-format` grammar (no leading dot, no
 * `.lock` suffix, no `@{`, no `//`, …) and the requirement that the branch
 * actually exists locally are enforced by the resolver, which reports them as
 * their own closed failure codes — see `repo/branch-name.ts`.
 */
export const BranchNameSchema = z
  .string()
  .min(1, 'A branch name must not be empty.')
  .max(255, 'A branch name must not exceed 255 characters.')
  .regex(SHELL_INERT_PATTERN, 'A branch name must consist of shell-inert characters only.');

/**
 * Stable identity of the repository, chosen by the repository itself.
 *
 * It is copied into `TaskState.repositoryId`, so it must be a short, stable
 * slug rather than a path: a task's identity must not change because a checkout
 * moved.
 */
export const RepositoryIdSchema = z
  .string()
  .min(1, 'repository.id must not be empty.')
  .max(64, 'repository.id must not exceed 64 characters.')
  .regex(
    /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/,
    'repository.id must be a lowercase slug of letters, digits, ".", "_" and "-".',
  );

/**
 * Where a later task-discovery step finds work. **Declared only** in V1-01:
 * nothing here is read, resolved or listed, and the path is not required to
 * exist. The discriminator exists so V1-02 has to *decide* how to read a
 * source rather than assume; adding a member is a deliberate act.
 */
export const TASK_SOURCE_KINDS = ['MARKDOWN_DIRECTORY'] as const;

export const TaskSourceSchema = z
  .object({
    kind: z.enum(TASK_SOURCE_KINDS),
    path: RepoRelativePathSchema,
  })
  .strict();

/**
 * The canonical documents a later context step is allowed to read, in the
 * order the repository considers meaningful. **Declared only**: no file is
 * opened in V1-01. An empty list is legal and means "no canonical source".
 */
export const ContextPolicySchema = z
  .object({
    canonicalSources: z
      .array(RepoRelativePathSchema)
      .max(64, 'context.canonicalSources must not exceed 64 entries.'),
  })
  .strict();

/**
 * What a capability's absence means for this repository.
 *
 * `REQUIRED` is fail-closed: the repository does not resolve unless the
 * capability is positively proven available. `OPTIONAL` records the observed
 * status and resolves either way.
 */
export const CAPABILITY_REQUIREMENTS = ['REQUIRED', 'OPTIONAL'] as const;

export const CapabilityPolicySchema = z
  .object({
    codegraph: z.enum(CAPABILITY_REQUIREMENTS),
  })
  .strict();

/**
 * Verification phases, declared as argv vectors. **Nothing is executed in
 * V1-01.** The vector form is not cosmetic: it is what keeps a repository from
 * handing the orchestrator a string for a shell to re-parse.
 */
export const VERIFICATION_PHASES = ['BUILD', 'TEST', 'VERIFY'] as const;

export const VerificationPhaseSchema = z
  .object({
    phase: z.enum(VERIFICATION_PHASES),
    command: z
      .array(CommandTokenSchema)
      .min(1, 'A verification command needs at least the program name.')
      .max(32, 'A verification command must not exceed 32 tokens.'),
  })
  .strict();

export const VerificationPolicySchema = z
  .object({
    phases: z
      .array(VerificationPhaseSchema)
      .min(1, 'verification.phases must declare at least one phase.')
      .max(8, 'verification.phases must not exceed 8 entries.'),
  })
  .strict();

/**
 * The write scope a later writer agent is confined to. **Declared only**: no
 * scope is enforced in V1-01. `protectedPaths` wins over `allowedPaths`, so a
 * carve-out inside an allowed subtree is expressible.
 */
export const ScopePolicySchema = z
  .object({
    allowedPaths: z
      .array(RepoRelativePathSchema)
      .min(1, 'scope.allowedPaths must declare at least one path.')
      .max(64, 'scope.allowedPaths must not exceed 64 entries.'),
    protectedPaths: z
      .array(RepoRelativePathSchema)
      .max(64, 'scope.protectedPaths must not exceed 64 entries.'),
  })
  .strict();

/**
 * The completion policy. Exactly one value, because exactly one has a v1
 * consumer: `maxReviewRounds` is copied into `TaskState.maxReviewRounds` and
 * bounded by the same `RoundSchema` the state contract uses, so a profile can
 * never declare a budget the state contract would refuse.
 */
export const CompletionPolicySchema = z
  .object({
    maxReviewRounds: RoundSchema('completion.maxReviewRounds', 1),
  })
  .strict();

/**
 * Remote expectation. The default is *not* "a remote exists": a repository
 * with no remote at all is an ordinary, fully valid target, so a profile has
 * to say so explicitly when it needs one.
 */
export const RemotePolicySchema = z
  .object({
    required: z.boolean(),
  })
  .strict();

/**
 * A Git remote *name*, as a repository profile may declare it.
 *
 * Narrower than Git's own rules, and the first character is the reason. The
 * declared name is spliced into an argument vector
 * (`deliver/delivery-target.ts`), and a name beginning with `-` would be read
 * by Git as an option rather than as a remote. Requiring an alphanumeric first
 * character refuses that, and also refuses a leading `.`; the remaining
 * characters are the ordinary ones a remote is named with.
 *
 * This is a contract-boundary refusal, not the only one: the reader that builds
 * the vector applies the same rule again at the point of use, because a
 * profile is repository-supplied input and one gate is one place to forget.
 * `tests/v4-01-delivery-target.test.ts` pins that the two agree, since a shared
 * constant would drag the whole process layer into the module the JSON-Schema
 * generator imports.
 *
 * It is a real limitation and not merely a tightening: a remote genuinely may be
 * named with a leading `-` — measured, `git remote add -- -dash <url>` exits 0
 * and reads back fine — and such a remote can never be a declared delivery
 * target. Accepted, because the alternative is putting a repository-authored
 * string that Git reads as an option into an argument vector.
 */
export const RemoteNameSchema = z
  .string()
  .min(1, 'A remote name must not be empty.')
  .max(100, 'A remote name must not exceed 100 characters.')
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'A remote name must start with a letter or digit and consist of letters, digits, ".", "_" and "-".',
  );

/**
 * Where a finished task would be **delivered**, declared by the repository.
 *
 * ── What declaring it does, and what it does not ───────────────────────────
 *
 * It names the remote whose push URL identifies the delivery target, and that
 * is all it does. `READY_FOR_PR` is still terminal, nothing is pushed, no pull
 * request is opened, nothing is merged and no network is contacted: this build
 * resolves the identity from local Git and reports it. Whether AO may talk to
 * the resolved host, with what credential, and to take what action, are
 * separate decisions that need their own contract.
 *
 * ── Why the remote is declared rather than assumed ─────────────────────────
 *
 * `origin` is what `git clone` happens to call the remote it cloned from. It
 * is a convention, not a fact about a checkout, and a checkout may have several
 * remotes, none of them, or an `origin` pointing at a fork. A delivery target
 * inferred from convention is a delivery target chosen by whoever last ran
 * `git remote add`, which is the "wrong repository" failure a delivery
 * controller exists to not have. So the repository states it, in the same file
 * in which it states which paths may be written and how it is verified.
 *
 * ── Absence is the default, and it is a real answer ────────────────────────
 *
 * The whole block is optional. A profile that omits it declares no delivery
 * target, and AO asks Git nothing on its behalf — which is what every profile
 * written before this field existed means, and what a repository that is
 * delivered by hand goes on meaning. Added optionally rather than by a contract
 * version bump for the reason `core/task-state.ts` gives for
 * `scopeAuthorityCommit`: nothing is invented for an older document, and the
 * other direction fails closed on its own, because an older build meets an
 * unknown key at a `.strict()` boundary and refuses the profile.
 */
export const DeliveryPolicySchema = z
  .object({
    /** The remote whose **push** URL names the delivery target. */
    remote: RemoteNameSchema,
  })
  .strict();

export const RepositoryIdentitySchema = z
  .object({
    id: RepositoryIdSchema,
    defaultBranch: BranchNameSchema,
  })
  .strict();

/** Plain object shape, without cross-field invariants. INTERNAL. */
export const RepoProfileObjectSchema = z
  .object({
    schemaVersion: z.int().positive('schemaVersion must be a positive integer.'),
    repository: RepositoryIdentitySchema,
    taskSource: TaskSourceSchema,
    context: ContextPolicySchema,
    capabilities: CapabilityPolicySchema,
    verification: VerificationPolicySchema,
    scope: ScopePolicySchema,
    completion: CompletionPolicySchema,
    remote: RemotePolicySchema,
    delivery: DeliveryPolicySchema.optional(),
  })
  .strict();
