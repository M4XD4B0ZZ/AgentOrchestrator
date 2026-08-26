/**
 * Whether this machine's operator has permitted an unattended head publication,
 * and for which repository (V4 slice 13).
 *
 * ── One location, outside every repository and every worktree ──────────────
 *
 *     <OS user profile>/.agent-orchestrator/delivery-automation.yaml
 *
 * The permission comes from that file and from nowhere else. Not from the
 * repository profile, not from repository content, not from a commit, not from
 * a CLI option and not from the environment. `notify-config.ts` established the
 * shape for exactly one reason and this slice needs a stronger version of it:
 * the root is derived from `os.userInfo()` through
 * `config/internal/path-provider.ts`, which consults no environment block, so a
 * parent process, a repository file or an agent writing inside its own worktree
 * cannot place this file or move where it is looked for.
 *
 * "A caller" is deliberately not in that list, and a review took it out. Both
 * functions below take a {@link PathProvider}, so a caller inside this package
 * can point the lookup anywhere — that is the test seam, and `trusted-profile.ts`
 * refuses the same override for the reason it gives. The property that holds is
 * narrower, and it is a fact about the tree rather than about a signature:
 * `registerDeliveryCommand` is called in exactly one place in `src/`
 * (`cli/index.ts`), with no seams at all, and `package.json` exports only the
 * CLI entry — so no operator input, no environment value and no repository file
 * reaches the parameter, and nothing outside this package can call these
 * functions to begin with.
 *
 * ── Why not the repository profile, pinned or otherwise ────────────────────
 *
 * The obvious candidate was the repository profile — the one file `repo/
 * profile-location.ts` names, and the only place it is named — read out of
 * the task's own scope-authority commit the way `scope/pinned-scope.ts` reads
 * the scope declaration. That module's header already argues the
 * self-authorisation case correctly, and this slice would have inherited the
 * argument for free.
 *
 * Two measured facts stopped it, and they are recorded here rather than in a
 * commit message:
 *
 *  - **in this repository the profile is not in any commit.** `.gitignore`
 *    ignores `.agent-orchestrator/`, the file is untracked, and
 *    `git show HEAD:<that path>` answers `fatal: path … exists on disk, but not
 *    in 'HEAD'`. The path is deliberately not spelled here: exactly two modules
 *    in `src/` may name it, `tests/repo-resolution.test.ts` proves it, and a
 *    third naming it — even in a comment saying it is not used — is a third
 *    place a reader could take the answer from. A permission read from a
 *    commit is therefore unreadable in the one repository this build is
 *    dogfooded against, and a mechanism that fails closed everywhere it is used
 *    is not a mechanism;
 *  - **a repository profile is repository-authored input.** The delivery mints
 *    already refuse to carry repository-authored prose into an argument vector.
 *    Taking a *permission* from the same trust class, for an effect performed
 *    with nobody present, is the direction this slice exists to refuse — and
 *    pinning the read to a commit removes the worktree-edit vector without
 *    removing the one where `--repository` is pointed at a tree the writer owns.
 *
 * So the declaration is the operator's, on the operator's machine, about a named
 * forge repository. A task cannot write it, cannot commit it, and cannot make
 * this module look somewhere else for it.
 *
 * ── Absence is the answer, and the answer is no ────────────────────────────
 *
 * No file means no unattended publication anywhere. A file that names other
 * repositories means no unattended publication *here*. A file that is present
 * and unusable means no unattended publication either, and unlike the notifier
 * it is **not** silently off: an authority configuration that cannot be read is
 * reported under its own member, because "the operator meant to allow this and I
 * could not tell" and "the operator did not allow this" send a person to
 * different places.
 *
 * ── The vocabulary is closed, and closed in both directions ────────────────
 *
 * `schemaVersion` is a literal, so a document written against a future contract
 * is refused rather than reinterpreted. Every object is `.strict()`, so a key
 * this build does not know — including the key some later slice would add for
 * *another* effect — refuses the whole document instead of being ignored. And
 * the permission itself is a two-member enum, so a value that is neither is a
 * contract violation and never a fall-through into "allowed".
 *
 * That is the whole of the fail-closed claim: there is no default, no coercion,
 * no truthiness test and no `??` anywhere below.
 *
 * ── What it permits, and what it cannot be made to permit ──────────────────
 *
 * One act: creating one work branch on one delivery remote, at one commit,
 * through the create-only publication this build already performs. It is not
 * permission to open a pull request, to merge one, to comment, to review, to
 * delete a ref, to move one, or to push anything else — none of which has a key
 * in this contract, and each of which would need its own decision, its own
 * schema change and its own slice.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { orchestratorHome } from '../config/paths.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { loadSafeYamlDocument } from '../yaml/safe-yaml.js';
import { SUPPORTED_FORGE_HOSTS } from './forge-observation.js';

/** The one file name. There is no alternative spelling and no `.yml` fallback. */
export const DELIVERY_AUTOMATION_FILE_NAME = 'delivery-automation.yaml';

/**
 * The one contract version this build understands.
 *
 * A literal rather than a minimum: a document written against a later contract
 * may mean something this build would act on wrongly, and an authority document
 * is the last place to guess.
 */
export const DELIVERY_AUTOMATION_SCHEMA_VERSION = 1;

/**
 * Largest authority document this build will read.
 *
 * A ceiling rather than a guess, and refused before parsing: an enormous file is
 * never turned into a document.
 */
export const MAX_DELIVERY_AUTOMATION_BYTES = 65_536;

/** Where the declaration lives. A pure function of the OS user identity. */
export function deliveryAutomationPath(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(orchestratorHome(provider), DELIVERY_AUTOMATION_FILE_NAME);
}

/**
 * The permission an operator may declare for one repository's head publication.
 *
 * Two members and no third. `ATTENDED_ONLY` is what every repository means
 * without a declaration; writing it changes nothing and is allowed so that an
 * operator can revoke by editing one word rather than by deleting an entry and
 * wondering whether they deleted the right one.
 */
export const HEAD_PUBLICATION_DECLARATIONS = ['ATTENDED_ONLY', 'AUTOMATIC_ALLOWED'] as const;

export type HeadPublicationDeclaration = (typeof HEAD_PUBLICATION_DECLARATIONS)[number];

/**
 * Every way the declaration can be present and unusable. Closed, and carrying
 * nothing from the file itself — a refusal must not become the channel for the
 * value it refused.
 */
export const DELIVERY_AUTOMATION_REFUSALS = [
  /** The OS could not be asked where the user profile is, so there is no place to look. */
  'PROFILE_UNAVAILABLE',
  /** The file exists and could not be read. */
  'DECLARATION_UNREADABLE',
  'DECLARATION_TOO_LARGE',
  /** Not one well-formed, warning-free YAML document. */
  'DECLARATION_MALFORMED',
  /** Well-formed, and carries a mapping key this boundary refuses by name. */
  'DECLARATION_FORBIDDEN_KEY',
  /**
   * A document that is not this contract: a version this build does not
   * understand, an unknown key, a missing field, a permission that is not one of
   * the two members, or a host this build does not support.
   */
  'DECLARATION_CONTRACT_VIOLATION',
  /**
   * Two entries name the same repository.
   *
   * Refused rather than resolved by order: which of two contradictory
   * permissions is in force must not depend on which line came first.
   */
  'DECLARATION_AMBIGUOUS',
] as const;

export type DeliveryAutomationRefusal = (typeof DELIVERY_AUTOMATION_REFUSALS)[number];

/**
 * One repository, named the way the publication authority names it.
 *
 * `{host, owner, name}` and not a repository id: an id is a label a profile
 * chooses and two clones share it, while these three are what the push actually
 * changes and what `mintHeadPublicationGrant` binds. A declaration for one
 * cannot authorise a push to another, which is the same rule slice 2 applies to
 * an observation.
 */
const TargetSchema = z
  .object({
    host: z.enum(SUPPORTED_FORGE_HOSTS),
    owner: z.string().min(1).max(100),
    name: z.string().min(1).max(100),
    headPublication: z.enum(HEAD_PUBLICATION_DECLARATIONS),
  })
  .strict();

const DeliveryAutomationSchema = z
  .object({
    schemaVersion: z.literal(DELIVERY_AUTOMATION_SCHEMA_VERSION),
    /**
     * The repositories this operator has decided about. May be empty, which is
     * a decision and means the same as no file: nothing is permitted.
     */
    repositories: z.array(TargetSchema).max(256),
  })
  .strict();

export interface ForgeRepositoryName {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

export type DeliveryAutomationOutcome =
  /** No file. Unattended publication is off for every repository. */
  | { readonly state: 'NOT_DECLARED' }
  /** A file that cannot be used. Nothing is permitted, and the operator is told. */
  | { readonly state: 'UNUSABLE'; readonly code: DeliveryAutomationRefusal }
  | {
      readonly state: 'DECLARED';
      readonly repositories: ReadonlyArray<
        ForgeRepositoryName & { readonly headPublication: HeadPublicationDeclaration }
      >;
    };

const unusable = (code: DeliveryAutomationRefusal): DeliveryAutomationOutcome =>
  Object.freeze({ state: 'UNUSABLE' as const, code });

/**
 * The key two entries collide on.
 *
 * `JSON.stringify` of the three parts rather than a joined string: a separator
 * character is a separator an owner or a repository name could contain, and two
 * different triples that produced one key would make a duplicate invisible
 * exactly where this function exists to see one. The parts are compared as
 * written and never case-folded — see {@link permitsUnattendedHeadPublication}.
 */
function repositoryKey(target: ForgeRepositoryName): string {
  return JSON.stringify([target.host, target.owner, target.name]);
}

/**
 * Reads the operator's delivery-automation declaration, or says why there is
 * none this build can act on.
 *
 * Never throws. Every failure — including the operating system refusing to say
 * where the profile is — is a return value, because this is consulted on the way
 * into a refusal ladder and a configuration problem may not become a crash.
 */
export function loadDeliveryAutomation(
  provider: PathProvider = OS_PATH_PROVIDER,
): DeliveryAutomationOutcome {
  let path: string;
  try {
    path = deliveryAutomationPath(provider);
  } catch {
    // `trustedProfileDirectory` throws rather than guessing. Its message is
    // already value-free, and it is dropped here regardless.
    return unusable('PROFILE_UNAVAILABLE');
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (safeErrnoCode(error) === 'ENOENT') return Object.freeze({ state: 'NOT_DECLARED' as const });
    return unusable('DECLARATION_UNREADABLE');
  }

  if (bytes.byteLength > MAX_DELIVERY_AUTOMATION_BYTES) return unusable('DECLARATION_TOO_LARGE');

  const parsed = loadSafeYamlDocument(bytes.toString('utf8'));
  if (parsed.outcome === 'FORBIDDEN_KEY') return unusable('DECLARATION_FORBIDDEN_KEY');
  if (parsed.outcome !== 'DOCUMENT') return unusable('DECLARATION_MALFORMED');

  const contract = DeliveryAutomationSchema.safeParse(parsed.document);
  // The Zod issue is deliberately not carried: it is a message authored by a
  // dependency about a file this module refuses to quote.
  if (!contract.success) return unusable('DECLARATION_CONTRACT_VIOLATION');

  const seen = new Set<string>();
  for (const entry of contract.data.repositories) {
    const key = repositoryKey(entry);
    if (seen.has(key)) return unusable('DECLARATION_AMBIGUOUS');
    seen.add(key);
  }

  return Object.freeze({
    state: 'DECLARED' as const,
    repositories: Object.freeze(
      contract.data.repositories.map((entry) =>
        Object.freeze({
          host: entry.host,
          owner: entry.owner,
          name: entry.name,
          headPublication: entry.headPublication,
        }),
      ),
    ),
  });
}

/**
 * What the operator has said about publishing this repository's head unattended.
 *
 * Four answers, and three of them are refusals that mean different things to a
 * person: nobody decided, somebody decided no, and the decision could not be
 * read at all.
 */
export const UNATTENDED_PUBLICATION_PERMISSIONS = [
  'ALLOWED',
  'NOT_DECLARED',
  'DENIED',
  'UNREADABLE',
] as const;

export type UnattendedPublicationPermission =
  (typeof UNATTENDED_PUBLICATION_PERMISSIONS)[number];

/**
 * Grades one declaration against one repository identity.
 *
 * Pure, total, and deliberately separate from reading the file: this is the
 * whole of the permission decision and it deserves to be readable on its own.
 *
 * The three identity fields are compared **exactly**. github.com treats an owner
 * and a repository name case-insensitively, so a declaration written with
 * different capitalisation than the delivery target resolves to answers
 * `NOT_DECLARED` here rather than `ALLOWED`. That is the fail-closed direction
 * and it is stated rather than smoothed over: case-folding a permission would
 * mean this build deciding that two strings name one repository on the strength
 * of a rule it does not own.
 */
export function permitsUnattendedHeadPublication(
  declaration: DeliveryAutomationOutcome,
  target: ForgeRepositoryName,
): UnattendedPublicationPermission {
  if (declaration.state === 'UNUSABLE') return 'UNREADABLE';
  if (declaration.state === 'NOT_DECLARED') return 'NOT_DECLARED';
  const entry = declaration.repositories.find(
    (candidate) =>
      candidate.host === target.host &&
      candidate.owner === target.owner &&
      candidate.name === target.name,
  );
  if (entry === undefined) return 'NOT_DECLARED';
  // An exhaustive switch rather than `=== 'AUTOMATIC_ALLOWED'`, so that a third
  // member added to the vocabulary is a compile error here and not a silent
  // `DENIED` — or, worse, a silent `ALLOWED` under the opposite spelling.
  switch (entry.headPublication) {
    case 'AUTOMATIC_ALLOWED':
      return 'ALLOWED';
    case 'ATTENDED_ONLY':
      return 'DENIED';
  }
}
