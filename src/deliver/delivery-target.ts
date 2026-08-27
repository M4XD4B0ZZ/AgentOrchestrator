/**
 * The delivery target: *which* repository a finished task would be delivered
 * to, read from Git and stripped of everything that is not identity.
 *
 * ── Why this exists, and why it is the first delivery slice ────────────────
 *
 * `READY_FOR_PR` is terminal. Everything downstream of it — opening a pull
 * request, reading its checks, merging it — has to name a repository on a
 * forge, and today **no value in this product can name one**. `TaskState`
 * carries `repositoryId` (a slug the profile chose), `repositoryRoot` (a local
 * path) and two commit SHAs; `ResolvedRepository.remote` carries a single
 * boolean, `present`, and says in so many words that it will not carry a name
 * or a URL. So a delivery step built on top of today's record would have to
 * *infer* its target — from the process working directory, from whatever
 * `origin` happens to be, from a tool's own guess — and inference is exactly
 * the "wrong repository" failure that a delivery controller must not have.
 *
 * This module answers the question once, deterministically, from the authority
 * that owns it, and hands back an identity or a refusal. Nothing here contacts
 * a network, and nothing here is authority to *do* anything: see "What a
 * resolved target is not" below.
 *
 * ── The exact question this answers, and the three it does not ─────────────
 *
 * **It answers: what is the push URL of the remote the profile declared.** That
 * is deliberately narrower than "where would a push go", and the difference was
 * measured rather than assumed:
 *
 *  - `branch.<name>.pushRemote` and `remote.pushDefault` select a **different
 *    remote** for a push, before any URL is chosen. Measured: with
 *    `branch.main.pushRemote = fork`, a bare `git push` on `main` writes to
 *    `fork` while this module, asked for `origin`, answers `origin`'s URL.
 *  - A **linked worktree** may carry its own `remote.<name>.pushurl` or
 *    `url.*.pushInsteadOf` in `config.worktree` once `extensions.worktreeConfig`
 *    is set. This module is asked about a repository *root*, and does not
 *    consult the worktree a task's branch lives in.
 *  - Whether the branch has actually been pushed anywhere is not asked at all.
 *
 * None of the three is a defect here; each is a question a later slice has to
 * ask deliberately if it needs the answer. They are written down because the
 * whole point of this slice is that the subject is never inferred, and a
 * sentence that quietly widened "this remote's push URL" into "where the work
 * goes" would be an inference wearing a measurement's clothes.
 *
 * ── The authority is `git remote get-url --push --all`, and each token was
 *    measured ───────────────────────────────────────────────────────────────
 *
 * Measured on git 2.55.0.windows.3. Every one of the four tokens changes the
 * answer, and three of them change it in the unsafe direction if dropped:
 *
 * `--push` — a remote may carry a push URL distinct from its fetch URL
 * (`git remote set-url --push`), and a pull request is opened on the repository
 * the branch was pushed to. Measured: with `remote.origin.url` =
 * `https://github.com/Owner/Repo.git` and `remote.origin.pushurl` =
 * `ssh://git@github.com/Other/Third.git`, the bare `get-url` answers `Owner/Repo`
 * and `--push` answers `Other/Third`. Reading the fetch URL would name a
 * repository the work never reaches. When no push URL is configured, `--push`
 * falls back to the fetch URL — measured, not assumed.
 *
 * `--all` — a remote may carry **more than one** URL, and without `--all` Git
 * prints only the first. Measured: two `url` entries, or two `pushurl` entries,
 * and the bare `--push` call prints one of them with exit 0. A push to such a
 * remote goes to *every* configured push URL, so "one line came back" is the
 * only shape in which a delivery target is unambiguous, and `--all` is what
 * makes the second line visible at all. Dropping it converts an ambiguity into
 * a confident wrong answer.
 *
 * `--` — the remote name comes from a repository-authored profile, and Git
 * would read a leading `-` as an option. The profile grammar refuses such a
 * name (`DeliveryPolicySchema`), and this vector refuses it a second time, at
 * the place the argument is actually built. Measured to be accepted by
 * `git remote get-url`, and measured to matter: `get-url --push --all -- -dash`
 * succeeds where the same call without `--` fails with ``unknown switch `d'``.
 *
 * The remote **name** is declared by the profile rather than assumed to be
 * `origin`. `origin` is a convention of `git clone`, not a fact about a
 * checkout, and a delivery target chosen by convention is a delivery target
 * chosen by whoever last ran `git remote add`.
 *
 * ── `get-url` reports the URL Git *uses*, including rewrites ───────────────
 *
 * Measured, and it matters: with `url.https://evil.example.com/.insteadOf
 * https://github.com/` in the repository's own config, `git remote get-url`
 * prints `https://evil.example.com/Owner/Repo.git` — the rewritten value, not
 * the configured one. `pushInsteadOf` behaves the same way when no explicit
 * push URL exists.
 *
 * That is the direction this module wants. Reading `remote.<name>.url` out of
 * the config instead would report `github.com` for a checkout whose pushes land
 * somewhere else entirely — an identity that is wrong precisely when it is
 * being lied to. So a rewritten host is reported as that host. **No host is
 * judged here**, by design and by omission: this build has nothing that decides
 * which hosts AO may deal with, and saying a rewrite is "caught downstream"
 * would be citing a control that does not exist. It is recorded as open
 * (`L-V4-01-2`).
 *
 * ── One line is not one URL, and that cost a fail-open ─────────────────────
 *
 * An earlier version of this module stated that Git refuses a config value
 * containing an escaped newline, and dropped every empty line from the output
 * on the strength of it. **Both halves were wrong.** Measured:
 * `git-config(5)` lists `\n` among the recognised escapes, `git remote add lead
 * "$(printf '\nhttps://github.com/Evil/Repo.git')"` exits 0, and `get-url
 * --push --all` then prints `\nhttps://github.com/Evil/Repo.git\n`. Filtering
 * the empty line collapsed that into one clean-looking URL and resolved
 * `Evil/Repo` from bytes that are not that string — the same trailing-whitespace
 * class the raw-bytes decision below exists to close, arriving through the
 * splitter instead of through `.trim()`.
 *
 * So exactly one trailing terminator is removed and nothing else is: a URL
 * containing a newline stays visible as the extra line it produces, and is
 * refused. `REMOTE_URL_AMBIGUOUS` covers it together with the genuine
 * many-URL case, because the two are **indistinguishable in this output** —
 * Git's line-oriented answer cannot represent a URL containing a newline — and
 * inventing a distinction the data does not carry would be the same mistake in
 * the other direction.
 *
 * ── Why the raw bytes ──────────────────────────────────────────────────────
 *
 * {@link GitQueryResult.stdout} is `.trim()`ed, and a configured URL may end in
 * a space: measured, `git remote add origin "https://github.com/Owner/Repo.git "`
 * keeps the trailing space through `get-url`. Trimming it turns a URL this
 * grammar must refuse into `Owner/Repo` — a fail-*open* on the exact value the
 * rest of delivery is keyed on. So this reader parses `rawStdout`, for the
 * reason `worktree/git-command.ts` gives for the same field, and treats its
 * absence as an unreadable answer rather than falling back to the trimmed form.
 *
 * ── What a resolved target is not ──────────────────────────────────────────
 *
 * It is **not** permission to contact anything. This build has one network
 * egress path — the opt-in operator notification — and this module does not add
 * a second: it starts `git`, locally, and returns data. Whether AO may talk to
 * the host in a resolved identity, with what credential, and to do what, are
 * separate decisions that a later slice has to make explicitly. Declaring a
 * delivery target in a profile therefore grants nothing today; it makes the
 * target *nameable*, which is the half that has to exist first.
 *
 * It is also **not durable**. No task state, ledger or lease field holds it.
 * The target is re-derived from Git wherever it is needed, because a pinned
 * copy is a claim about a configuration that can be changed underneath it, and
 * a stale delivery target is worse than none.
 */

import type { GitQueryResult } from '../repo/git-query.js';
/**
 * The three identity grammars, which were private constants in this file until
 * V4 slice 17 needed the same rules to bound an operator's *query* over the
 * publication audit store. They moved rather than being copied — the move
 * `internal/delivery-ref-grammar.ts` already records for the ref grammar —
 * because a second copy is free to drift from the first, and a review has
 * already found one in this repository.
 *
 * `isForgeRepositoryName` carries both halves of the name rule: the character
 * class, and the separate refusal of a name made only of dots. That pairing was
 * two statements here and is now one call, so no caller can apply one half
 * without the other — which is the reason the rules are handed out as
 * predicates rather than as the patterns behind them.
 *
 * An earlier version of this note also claimed the move kept `spawn` out of the
 * reader's swept import graph. A review measured that false: the second
 * consumer is a CLI command whose graph already reached `doctor/exec.ts` before
 * this slice and still does. See the grammar module's own header for the
 * numbers.
 */
import {
  isForgeHost,
  isForgeOwner,
  isForgeRepositoryName,
} from './internal/forge-identity-grammar.js';

// ── Result vocabulary ──────────────────────────────────────────────────────

/**
 * How the delivery-target question ended, in a closed vocabulary.
 *
 * Never a message, and in particular never a fragment of the URL: a remote URL
 * is exactly the kind of value that carries a credential, which is the reason
 * `resolve-repository.ts` refuses to record one at all.
 */
export const DELIVERY_TARGET_OUTCOMES: readonly [
  'RESOLVED',
  'GIT_UNAVAILABLE',
  'REMOTE_NOT_CONFIGURED',
  'REMOTE_URL_AMBIGUOUS',
  'REMOTE_URL_CARRIES_USERINFO',
  'REMOTE_URL_NOT_REPOSITORY_SHAPED',
] = Object.freeze([
  /** A single, unambiguous, credential-free repository identity was read. */
  'RESOLVED',
  /** The Git query could not be completed, or the runner supplied no raw bytes. */
  'GIT_UNAVAILABLE',
  /**
   * No usable remote of the declared name was obtained. Two producers, and the
   * code deliberately names neither cause beyond what it can establish:
   *
   *  - Git ran and answered non-zero. The ordinary case is that there is no
   *    such remote (measured: exit 2, `error: No such remote`) — but it is
   *    **not** the only one. `gitQuery` collapses every non-zero answer into
   *    `NONZERO_EXIT`, and it has no exit status to hand on, so a `git` that
   *    refused because it could not parse the repository's configuration
   *    (measured: exit 128, `fatal: bad config line …`), or one killed by a
   *    signal (`exitCode === null`, which `git-query.ts` reads as non-zero),
   *    arrives here too. Carried as **L-V4-01-7** rather than diagnosed: the
   *    read-only seam would have to carry the exit status first, and
   *    `worktree/git-command.ts` is explicit that reading one is a narrow,
   *    documented act rather than a general licence.
   *  - The declared name is one this module will not put in an argument vector
   *    at all — see {@link observeDeliveryTarget}.
   *
   * It is **not** the code for "the remote exists but has no URL". Measured,
   * Git answers that case by printing the *remote's own name* and exiting 0
   * (`nourl\n`), which reaches the grammar and is refused as not
   * repository-shaped. A separate code would describe a Git behaviour that does
   * not occur.
   */
  'REMOTE_NOT_CONFIGURED',
  /** Git's answer is not one URL: several are configured, or one spans lines. */
  'REMOTE_URL_AMBIGUOUS',
  /** The URL carries user information other than the bare SSH user `git`. */
  'REMOTE_URL_CARRIES_USERINFO',
  /** The URL does not name `<host>/<owner>/<name>` under this grammar. */
  'REMOTE_URL_NOT_REPOSITORY_SHAPED',
] as const);

export type DeliveryTargetOutcome = (typeof DELIVERY_TARGET_OUTCOMES)[number];
export type DeliveryTargetRefusal = Exclude<DeliveryTargetOutcome, 'RESOLVED'>;

/**
 * One static sentence per **refusal**.
 *
 * `RESOLVED` has none, deliberately: its answer is the identity, and a sentence
 * nothing renders is a claim nothing checks.
 *
 * Nothing is interpolated — not the URL, not the remote name, not Git's
 * stderr. The same rule `resolve-repository.ts` applies to its failure detail
 * applies here for a stronger reason: the value being diagnosed is the one most
 * likely to hold a secret.
 */
export const DELIVERY_TARGET_DETAIL: Readonly<Record<DeliveryTargetRefusal, string>> =
  Object.freeze({
    GIT_UNAVAILABLE: 'The remote URL could not be read from Git.',
    REMOTE_NOT_CONFIGURED:
      'No usable remote of the declared name was obtained: Git refused the question about it, or the declared name is one AO will not put in a command.',
    REMOTE_URL_AMBIGUOUS:
      'Git did not answer with exactly one push URL for the declared remote, so there is no single delivery target.',
    REMOTE_URL_CARRIES_USERINFO:
      'The remote URL embeds user information. A credential in a remote URL is not read, carried or reported.',
    REMOTE_URL_NOT_REPOSITORY_SHAPED:
      'The remote URL does not name a host, an owner and a repository.',
  });

/**
 * A repository on a forge, named by the three parts that identify it.
 *
 * `host` is lowercased, because host names are case-insensitive and two
 * spellings of one host must not compare unequal. `owner` and `name` keep the
 * case they were configured with: a forge may treat them case-insensitively,
 * but it is not this module's place to assert that about a host it was merely
 * handed.
 *
 * The URL these came from is deliberately absent, and so is the scheme. The
 * identity answers *which repository*; how Git happens to reach it — `https`,
 * `ssh`, a rewritten host — is not identity, and a consumer that needs a
 * transport has to choose one deliberately rather than inherit whatever was in
 * a config file.
 */
export interface ForgeRepositoryIdentity {
  /**
   * Lowercased, dotted host name. Never a port and never an IPv6 literal.
   *
   * An **IPv4 address is accepted**, because a dotted host of digit-only labels
   * satisfies {@link isForgeHost} and refusing it would need a rule this
   * module has no reason to hold: it does not decide which hosts AO may deal
   * with (`L-V4-01-2`). Stated because an earlier version of this sentence said
   * "never an IP literal", which was false for IPv4 and true only for IPv6.
   */
  readonly host: string;
  /** Owning user or organisation. */
  readonly owner: string;
  /** Repository name, with a single trailing `.git` removed. */
  readonly name: string;
}

export interface DeliveryTargetResolved {
  readonly outcome: 'RESOLVED';
  readonly target: ForgeRepositoryIdentity;
}

export interface DeliveryTargetRefused {
  readonly outcome: DeliveryTargetRefusal;
}

/**
 * The result of asking for a delivery target.
 *
 * Fail-closed by construction rather than by discipline: `target` exists only
 * on the `RESOLVED` member, so there is no shape in which a caller reads an
 * identity out of a refusal, and no default identity for one to fall back to.
 */
export type DeliveryTargetResult = DeliveryTargetResolved | DeliveryTargetRefused;

/**
 * Where a finished task would be delivered, as far as one checkout can say.
 *
 * A discriminated union rather than three nullable fields, so that "the profile
 * declares no delivery target" and "it declares one that could not be resolved"
 * cannot be confused for each other, and so that neither of them offers a
 * `target` to read.
 */
export type ResolvedDelivery =
  | {
      /** The profile declares no delivery target. Nothing was asked of Git. */
      readonly declared: false;
    }
  | {
      readonly declared: true;
      /** The remote name the profile declared, exactly as it passed the grammar. */
      readonly remoteName: string;
      /** The identity read from that remote's push URL, or the refusal. */
      readonly result: DeliveryTargetResult;
    };

const REFUSALS: Readonly<Record<DeliveryTargetRefusal, DeliveryTargetRefused>> = Object.freeze({
  GIT_UNAVAILABLE: Object.freeze({ outcome: 'GIT_UNAVAILABLE' as const }),
  REMOTE_NOT_CONFIGURED: Object.freeze({ outcome: 'REMOTE_NOT_CONFIGURED' as const }),
  REMOTE_URL_AMBIGUOUS: Object.freeze({ outcome: 'REMOTE_URL_AMBIGUOUS' as const }),
  REMOTE_URL_CARRIES_USERINFO: Object.freeze({ outcome: 'REMOTE_URL_CARRIES_USERINFO' as const }),
  REMOTE_URL_NOT_REPOSITORY_SHAPED: Object.freeze({
    outcome: 'REMOTE_URL_NOT_REPOSITORY_SHAPED' as const,
  }),
});

function refuse(code: DeliveryTargetRefusal): DeliveryTargetRefused {
  return REFUSALS[code];
}

// ── Grammar ────────────────────────────────────────────────────────────────

/**
 * Every character of a URL this grammar will look at.
 *
 * Printable ASCII, no space. It is the first gate, and exactly one refusal in
 * the suite depends on it alone — measured, by running the grammar with the
 * gate disabled over every refusal case: `U+212A KELVIN SIGN` lower-cases to
 * ASCII `k`, so `https://<U+212A>EYS.example.com/Owner/Repo.git` would
 * normalise into `keys.example.com` and be accepted as a host, while Git
 * contacts a different host entirely. Every other case — a leading or trailing
 * space, a carriage return, a non-ASCII letter — is independently refused by a
 * component pattern below.
 *
 * Because a carriage return is outside this set, no assumption about Git's line
 * endings is needed anywhere in this module: an answer of `<url>\r\n` is refused
 * here rather than read as `<url>`. (Measured: Git writes `\n` on this platform,
 * so that case is a floor rather than an observed shape.)
 *
 * The *spelling* of the split below is deliberately not claimed to matter, and
 * that is measured too: replacing `split('\n')` with `split(/\r?\n/)` changes no
 * outcome for any shape this reader can meet, and the reason is the line
 * *count* rather than the line contents. Both spellings break at exactly the
 * same `\n` offsets, so the count is identical for every input: at a count of
 * one there is no `\n` left in `body` for `\r?\n` to match, so the single
 * element is byte-identical either way; at a count of two or more the answer is
 * refused before any line is parsed, so the contents are never observed. (The
 * contents do differ — `\r?\n` eats a `\r` before an *internal* newline — which
 * is exactly why the argument has to rest on the count.) It is
 * recorded as this slice's one equivalent mutant rather than left as a mechanism
 * a comment claims and no test can kill.
 */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

// The host, owner and repository-name grammars used to be three private
// constants here. They live in `internal/forge-identity-grammar.ts` since V4
// slice 17 — see the note on their import at the top of this file.

/**
 * The one user name a remote URL may carry.
 *
 * `git@` is the universal SSH user of every forge and is not a secret. Every
 * other user information is refused, including a bare user name with no
 * password: GitHub accepts a personal access token *as the user name*, so
 * "there is no colon, therefore there is no credential" is false. An allow-list
 * of one is the only form of this rule that cannot be wrong.
 */
const SSH_USER = 'git';

/**
 * The `.git` suffix a clone URL conventionally carries. Removed exactly once,
 * and **case-sensitively**: forges and `git clone` emit the lowercase spelling,
 * and folding case here would make this module decide that `Repo.GIT` and
 * `Repo` are one repository, which is a claim about a host it was handed.
 */
const GIT_SUFFIX = '.git';

interface SplitUrl {
  readonly authority: string;
  readonly path: string;
}

/**
 * Splits a remote URL into its authority and its path, or refuses it.
 *
 * Two grammars, matching the two shapes Git accepts and a forge produces:
 *
 *  - `<scheme>://<authority>/<path>` — every scheme is accepted, because the
 *    scheme is not part of the identity (see {@link ForgeRepositoryIdentity});
 *  - `[user@]<host>:<path>` — the scp-like form, recognised the way Git
 *    recognises it: a colon that appears before any slash. A string with no
 *    colon at all, or whose first slash precedes its first colon, is a local
 *    path and is refused here.
 */
function splitRemoteUrl(url: string): SplitUrl | null {
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(url);
  if (scheme !== null) {
    const rest = url.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    return { authority: rest.slice(0, slash), path: rest.slice(slash + 1) };
  }

  const colon = url.indexOf(':');
  if (colon < 0) return null;
  const slash = url.indexOf('/');
  if (slash >= 0 && slash < colon) return null;

  const path = url.slice(colon + 1);
  // A forge accepts `git@host:/owner/repo` and `git@host:owner/repo` as the
  // same repository, so exactly one leading slash is absorbed. Note what that
  // costs elsewhere: on a plain `sshd` host the two are *different* paths — one
  // relative to the account's home, one from the filesystem root — and this
  // grammar collapses them into one identity. Harmless while nothing acts on
  // the identity; a collision the moment something does. A second slash leaves
  // an empty first segment and is refused with everything else.
  return { authority: url.slice(0, colon), path: path.startsWith('/') ? path.slice(1) : path };
}

/**
 * Parses one remote URL into an identity, or into the reason it is not one.
 *
 * Exported for the tests that have to reach every branch of the grammar: a
 * fixture per case would be a fixture per *forge convention*, and the ones that
 * matter here — a port, an IPv6 literal, a percent-encoded segment — are not
 * shapes a real remote is easily made to produce on demand.
 */
export function parseRemoteUrlIdentity(url: string): DeliveryTargetResult {
  if (!PRINTABLE_ASCII.test(url)) return refuse('REMOTE_URL_NOT_REPOSITORY_SHAPED');

  const split = splitRemoteUrl(url);
  if (split === null) return refuse('REMOTE_URL_NOT_REPOSITORY_SHAPED');

  // The host is what follows the *last* `@`, as in every URL grammar, so a
  // user name that itself contains an `@` cannot smuggle a host in front of the
  // real one.
  const at = split.authority.lastIndexOf('@');
  let host = split.authority;
  if (at >= 0) {
    if (split.authority.slice(0, at) !== SSH_USER) return refuse('REMOTE_URL_CARRIES_USERINFO');
    host = split.authority.slice(at + 1);
  }

  const lowerHost = host.toLowerCase();
  if (!isForgeHost(lowerHost)) return refuse('REMOTE_URL_NOT_REPOSITORY_SHAPED');

  const segments = split.path.split('/');
  if (segments.length !== 2) return refuse('REMOTE_URL_NOT_REPOSITORY_SHAPED');
  const [owner, rawName] = segments;
  if (owner === undefined || rawName === undefined) {
    return refuse('REMOTE_URL_NOT_REPOSITORY_SHAPED');
  }

  const name = rawName.endsWith(GIT_SUFFIX) ? rawName.slice(0, -GIT_SUFFIX.length) : rawName;

  if (!isForgeOwner(owner)) return refuse('REMOTE_URL_NOT_REPOSITORY_SHAPED');
  // One call and not two: the character class and the all-dots refusal are the
  // two halves of one rule, and they are applied together where the rule lives.
  if (!isForgeRepositoryName(name)) return refuse('REMOTE_URL_NOT_REPOSITORY_SHAPED');

  return Object.freeze({
    outcome: 'RESOLVED' as const,
    target: Object.freeze({ host: lowerHost, owner, name }),
  });
}

// ── The observation ────────────────────────────────────────────────────────

/**
 * The Git seam.
 *
 * **Required, with no default**, for the reason `worktree/git-command.ts` gives
 * for its own runner: a module that could reach for the real one implicitly is
 * a module something can bypass the seam in by accident. It also keeps this
 * module free of a runtime import from `repo/`, which imports *it*.
 *
 * Production passes `gitQuery`; a test passes its own function to drive the
 * answers a real repository cannot be made to give on demand — a Git that has
 * vanished, or a runner that supplies no raw bytes.
 */
export type DeliveryGitQuery = (cwd: string, args: readonly string[]) => Promise<GitQueryResult>;

/**
 * The argument vector, as one exported constant rather than a literal built at
 * the call site, so that a test can assert the tokens the product actually
 * sends. Each of them is justified in this module's header; `--all` and
 * `--push` are the two whose removal is silent.
 */
export const DELIVERY_REMOTE_URL_ARGS: readonly string[] = Object.freeze([
  'remote',
  'get-url',
  '--push',
  '--all',
  '--',
]);

/**
 * The remote names this module will place in an argument vector.
 *
 * The same rule `DeliveryPolicySchema` applies to a declared remote, and the two
 * accept exactly the same set — `tests/v4-01-delivery-target.test.ts` pins that,
 * because a shared constant would drag the whole process layer into the schema
 * module the JSON-Schema generator imports.
 *
 * So this guard cannot fire on any input the one production caller can supply,
 * and that is the point: it is a floor for the *next* caller, placed where the
 * argument is built rather than left to whoever adds one. Said plainly rather
 * than as "a profile is not the only way to reach this function", which today
 * is not true.
 *
 * The first character is the security-relevant part: Git reads a leading `-` as
 * an option. A remote genuinely *may* be named that way — measured, `git remote
 * add -- -dash <url>` exits 0 and reads back fine — so this is a real, accepted
 * limitation and not merely a tightening: such a remote can never be a declared
 * delivery target.
 */
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Reads the delivery target of `repositoryRoot` from the remote named
 * `remoteName`.
 *
 * `repositoryRoot` must already be a canonical, existing directory: this reader
 * does not canonicalise and never falls back to `process.cwd()`, for the reason
 * `git-query.ts` gives.
 *
 * Never throws for an expected condition, and never contacts a network.
 */
export async function observeDeliveryTarget(
  repositoryRoot: string,
  remoteName: string,
  query: DeliveryGitQuery,
): Promise<DeliveryTargetResult> {
  // Shares `REMOTE_NOT_CONFIGURED` with Git's own "no such remote" rather than
  // taking a code of its own: both mean *this repository has no remote of that
  // name that AO will ask about*, and a seventh code that production can never
  // produce would be a vocabulary entry describing nothing.
  if (!REMOTE_NAME_PATTERN.test(remoteName)) return refuse('REMOTE_NOT_CONFIGURED');

  const result = await query(repositoryRoot, [...DELIVERY_REMOTE_URL_ARGS, remoteName]);
  if (result.outcome === 'UNAVAILABLE') return refuse('GIT_UNAVAILABLE');
  if (result.outcome === 'NONZERO_EXIT') return refuse('REMOTE_NOT_CONFIGURED');

  // The bytes Git wrote, never the trimmed form. See this module's header: a
  // configured URL may end in a space, and trimming it is a fail-open on the
  // one value the whole of delivery is keyed on. A runner that cannot supply
  // them has not answered the question.
  const raw = result.rawStdout;
  if (raw === undefined) return refuse('GIT_UNAVAILABLE');

  // Exactly one trailing terminator, and nothing else. Filtering empty lines
  // was the earlier form and it was a fail-open: a URL containing a newline
  // then arrived as one clean-looking URL. See "One line is not one URL".
  const body = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const urls = body.split('\n');
  if (urls.length !== 1) return refuse('REMOTE_URL_AMBIGUOUS');

  const only = urls[0];
  // `split` on a string always yields at least one element, so this is a type
  // floor rather than a reachable branch.
  if (only === undefined) return refuse('REMOTE_URL_AMBIGUOUS');
  return parseRemoteUrlIdentity(only);
}
