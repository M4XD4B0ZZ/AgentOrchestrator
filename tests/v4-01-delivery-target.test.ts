/**
 * V4 slice 1 — the delivery target.
 *
 * The slice answers one question: *which repository on a forge would this
 * checkout deliver to?* Everything downstream of `READY_FOR_PR` needs that
 * answer, and nothing in this product could give it before.
 *
 * ── What each block is for, and which mechanism it would kill ──────────────
 *
 * The grammar block drives `parseRemoteUrlIdentity` directly: a fixture per URL
 * shape would be a fixture per forge convention, and the shapes that matter
 * most — a port, an IPv6 literal, a percent-encoded segment — are not shapes a
 * real remote is easily made to produce.
 *
 * The real-repository block is where the argument vector is proved, and every
 * case in it is a counter-proof rather than a demonstration. Each of the
 * load-bearing mechanisms is silent when removed — the command still exits 0
 * and still prints a URL — so each one has a fixture whose *only* purpose is to
 * make the removal visible:
 *
 *  - drop `--push`  → the fetch-vs-push fixture names the wrong repository;
 *  - drop `--all`   → both ambiguity fixtures resolve confidently and wrongly;
 *  - use `stdout` instead of `rawStdout` → the trailing-space fixture resolves
 *    to a repository whose URL is not the configured one;
 *  - filter empty lines instead of stripping one terminator → the embedded-
 *    newline fixture resolves a repository the configuration does not name.
 *
 * That last one was a real defect, found by review after this file was first
 * written. Git accepts `\n` inside a config value — measured, `git-config(5)`
 * lists it among the recognised escapes — so a remote URL can span output
 * lines, and dropping empty lines collapsed it into a clean-looking URL.
 *
 * The resolution block measures the argument vector the *product* sends,
 * through a delegating spy on the read-only Git seam, so that the tokens are
 * pinned at the boundary as well as by their effects — and so that "a profile
 * with no delivery block asks Git no URL question" is measured rather than read
 * off the source.
 *
 * The rendering block ends with the control this slice most needs: a remote URL
 * carrying a credential must not appear in the operator's console, whatever
 * else the line says.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  createRepoFixture,
  git,
  removeRepoFixtures,
  FIXTURE_A_PROFILE,
} from './helpers/repo-fixtures.js';

/**
 * A delegating spy on the read-only Git seam.
 *
 * Hoisted, as every mock factory in this repository is, because the factory
 * runs during the import phase and cannot see an ordinary top-level binding. It
 * delegates to the real `gitQuery`, so every case in this file still talks to a
 * real Git against a real repository; the recording exists only so that the
 * argument vector the product builds can be asserted, and so that the *absence*
 * of a call is observable at all.
 */
const gitSpy = vi.hoisted(() => ({
  calls: [] as { readonly cwd: string; readonly args: readonly string[] }[],
}));

vi.mock('../src/repo/git-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/repo/git-query.js')>();
  return {
    ...actual,
    gitQuery: async (cwd: string, args: readonly string[]) => {
      gitSpy.calls.push({ cwd, args: [...args] });
      return actual.gitQuery(cwd, args);
    },
  };
});

const {
  DELIVERY_REMOTE_URL_ARGS,
  DELIVERY_TARGET_DETAIL,
  DELIVERY_TARGET_OUTCOMES,
  observeDeliveryTarget,
  parseRemoteUrlIdentity,
} = await import('../src/deliver/delivery-target.js');
const { gitQuery } = await import('../src/repo/git-query.js');
const { resolveRepository } = await import('../src/repo/resolve-repository.js');
const { safeParseRepoProfile } = await import('../src/repo/repo-profile.js');
const { renderDeliveryLine, renderRunPlan } = await import('../src/run/render-run-plan.js');
const { planRun } = await import('../src/run/run-plan.js');
const { runGitCommand } = await import('../src/worktree/git-command.js');

type DeliveryResult = Awaited<ReturnType<typeof observeDeliveryTarget>>;
type ResolvedRepository = Extract<
  Awaited<ReturnType<typeof resolveRepository>>,
  { ok: true }
>['repository'];

afterAll(() => {
  removeRepoFixtures();
});

/** `FIXTURE_A_PROFILE` plus a declared delivery remote. */
function profileDeliveringVia(remote: string): string {
  return `${FIXTURE_A_PROFILE}delivery:\n  remote: ${remote}\n`;
}

/** A fixture repository whose profile declares a delivery remote. */
function fixtureDeclaringDelivery(remote = 'origin'): string {
  return createRepoFixture({ defaultBranch: 'main', profile: profileDeliveringVia(remote) });
}

/**
 * Writes a remote section straight into `.git/config`.
 *
 * `git remote add` cannot express a URL containing a newline without relying on
 * how this platform's argument quoting survives one, and the cases that need it
 * are precisely the ones where the exact bytes are the point. The escapes here
 * are Git's own — `git-config(5)` lists `\n` among the recognised ones — so
 * this is the configuration a person writes, read back by a real Git.
 */
function writeRawRemote(root: string, name: string, body: string): void {
  appendFileSync(join(root, '.git', 'config'), `[remote "${name}"]\n\t${body}\n`, 'utf8');
}

function identityOf(result: DeliveryResult): string {
  if (result.outcome !== 'RESOLVED') {
    throw new Error(`expected RESOLVED, got ${result.outcome}`);
  }
  return `${result.target.host}/${result.target.owner}/${result.target.name}`;
}

function resolvedRepository(
  result: Awaited<ReturnType<typeof resolveRepository>>,
): ResolvedRepository {
  if (!result.ok) throw new Error(`expected RESOLVED, got ${result.code}`);
  return result.repository;
}

/** Reads a delivery target through the production seam. */
function observe(root: string, remote: string): Promise<DeliveryResult> {
  return observeDeliveryTarget(root, remote, gitQuery);
}

// ── The grammar ────────────────────────────────────────────────────────────

describe('the remote-URL grammar', () => {
  it.each([
    // The three forms a forge itself hands out.
    ['https://github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    ['ssh://git@github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    ['git@github.com:Owner/Repo.git', 'github.com/Owner/Repo'],
    // The `.git` suffix is a convention, not a requirement.
    ['https://github.com/Owner/Repo', 'github.com/Owner/Repo'],
    // The scheme is not part of the identity: which repository is not the same
    // question as how Git reaches it, and a consumer picks its own transport.
    ['git://github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    ['http://github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    ['git+ssh://git@github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    // The scp-like form is allowed one leading slash, as Git allows it.
    ['git@github.com:/Owner/Repo.git', 'github.com/Owner/Repo'],
    // An enterprise host is an ordinary host. The identity carries it; whether
    // AO may talk to it is not this module's decision.
    ['https://git.example.co.uk/Owner/Repo.git', 'git.example.co.uk/Owner/Repo'],
    // An IPv4 host is a dotted host of digit labels and is accepted. Pinned in
    // both directions because the docstring used to claim it was refused.
    ['https://192.168.1.10/Owner/Repo.git', '192.168.1.10/Owner/Repo'],
    // Host names are case-insensitive and are normalised; an owner and a
    // repository name are not, and keep the case they were configured with.
    ['https://GitHub.COM/Owner/Repo.git', 'github.com/Owner/Repo'],
    // `.github` is an ordinary repository name, which is why a leading dot is
    // allowed and an all-dots name is refused separately.
    ['https://github.com/Owner/.github.git', 'github.com/Owner/.github'],
    ['https://github.com/Owner/_internal.git', 'github.com/Owner/_internal'],
    // Exactly one `.git` suffix is removed, and only the lowercase spelling
    // Git and forges emit — folding case would decide that two names are one.
    ['https://github.com/Owner/Repo.git.git', 'github.com/Owner/Repo.git'],
    ['https://github.com/Owner/Repo.GIT', 'github.com/Owner/Repo.GIT'],
    // The bare SSH user is the one permitted user information.
    ['https://git@github.com/Owner/Repo.git', 'github.com/Owner/Repo'],
    // The owner bound is GitHub's: 39 characters is legal, 40 is not.
    [`https://github.com/${'a'.repeat(39)}/Repo.git`, `github.com/${'a'.repeat(39)}/Repo`],
    // The name bound, likewise, in both directions.
    [`https://github.com/Owner/${'a'.repeat(100)}.git`, `github.com/Owner/${'a'.repeat(100)}`],
  ])('reads %s as %s', (url, expected) => {
    expect(identityOf(parseRemoteUrlIdentity(url))).toBe(expected);
  });

  it.each([
    // A credential in the user name. GitHub accepts a personal access token as
    // the user name with no password at all, so "there is no colon" is not a
    // test for "there is no secret".
    ['https://ghp_EXAMPLETOKEN@github.com/Owner/Repo.git', 'REMOTE_URL_CARRIES_USERINFO'],
    ['https://user:password@github.com/Owner/Repo.git', 'REMOTE_URL_CARRIES_USERINFO'],
    ['ssh://deploy@github.com/Owner/Repo.git', 'REMOTE_URL_CARRIES_USERINFO'],
    // The host is what follows the *last* `@`, so a user name containing an `@`
    // cannot present a second host in front of the real one.
    ['https://git@evil.example.com@github.com/Owner/Repo.git', 'REMOTE_URL_CARRIES_USERINFO'],

    // Not `<host>/<owner>/<name>`.
    ['https://github.com/Owner', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner/Group/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com//Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner/', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['git@github.com://Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    // A local path whose first slash precedes its first colon. Git reads it as
    // a path, not as an scp-like URL, and so does the splitter. Without that
    // rule the authority becomes `foo/bar@github.com` and the answer is
    // `REMOTE_URL_CARRIES_USERINFO` — a refusal, but the wrong diagnosis.
    ['foo/bar@github.com:Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],

    // A local path is not a delivery target, in either platform's spelling. The
    // Windows one is the case the dotted-host rule exists for: without it, `D`
    // presents itself as a host.
    ['/srv/git/repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['D:/work/repo', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['D:\\work\\repo', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['file:///c/work/repo', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['../sibling.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],

    // A bare host name is not fully qualified. A port and an IPv6 literal are
    // refused by the host grammar itself — it admits neither `:` nor `[`.
    ['https://localhost/Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com:8443/Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['ssh://git@[2001:db8::1]/Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],

    // Grammar refusals on the two names that later become arguments. Both
    // refuse a leading hyphen, for the same reason: `-oProxyCommand` is not a
    // token to hand to another program.
    ['https://github.com/-Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner-/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    [`https://github.com/${'a'.repeat(40)}/Repo.git`, 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    [`https://github.com/Owner/${'a'.repeat(101)}.git`, 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner/-oProxyCommand.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner/--upload-pack.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Ow%2Fner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner/Re po.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    // A name made only of dots, at every length the suffix rule can produce.
    ['https://github.com/Owner/..git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner/...git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner/....git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],

    // A homograph host. `K` is the Kelvin sign, and `'K'.toLowerCase()`
    // is the ASCII letter `k`, so the host normalisation this module performs
    // would turn it into `keys.example.com` and the dotted-host pattern would
    // accept the result — while Git contacts a different host entirely. It is
    // the one case the printable-ASCII gate refuses on its own: every other
    // refusal below is also caught by a component grammar, measured.
    // Written as an escape rather than as the character itself: rewriting this
    // file once flattened it to an ASCII K, and the case passed while measuring
    // nothing. The assertion below re-checks the codepoint for the same reason.
    ['https://KEYS.example.com/Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],

    // Whitespace and control characters never reach a component grammar.
    // A space inside the user information. The component grammars catch every
    // other space — in a host, an owner or a name — so this is the case that
    // makes the gate's `no space` half load-bearing: widen it to   and the
    // answer becomes `REMOTE_URL_CARRIES_USERINFO`.
    ['https://gi t@github.com/Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner/Repo.git ', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    [' https://github.com/Owner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Owner/Repo.git\r', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['https://github.com/Öwner/Repo.git', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
    ['', 'REMOTE_URL_NOT_REPOSITORY_SHAPED'],
  ])('refuses %s as %s', (url, code) => {
    expect(parseRemoteUrlIdentity(url).outcome).toBe(code);
  });

  it('uses the real Kelvin sign, which is the only reason that case measures anything', () => {
    const kelvin = 'K';
    expect(kelvin).not.toBe('K');
    expect(kelvin.toLowerCase()).toBe('k');
    expect(parseRemoteUrlIdentity(`https://${kelvin}EYS.example.com/Owner/Repo.git`).outcome).toBe(
      'REMOTE_URL_NOT_REPOSITORY_SHAPED',
    );
  });

  it('offers no identity on any refusal', () => {
    const refused = parseRemoteUrlIdentity('https://github.com/Owner');
    expect(refused.outcome).not.toBe('RESOLVED');
    expect(Object.hasOwn(refused, 'target')).toBe(false);
  });

  it('refuses an all-dots name only after the suffix is removed', () => {
    // `..git` reaches the name check as `.`, `...git` as `..`, `....git` as
    // `...` — the names the pattern alone would accept, because a leading dot
    // is legal. The control is the same shape with one more character.
    expect(identityOf(parseRemoteUrlIdentity('https://github.com/Owner/.a.git'))).toBe(
      'github.com/Owner/.a',
    );
  });
});

// ── The argument vector ────────────────────────────────────────────────────

describe('the argument vector', () => {
  it('carries every token whose absence is silent, and ends with the separator', () => {
    expect(DELIVERY_REMOTE_URL_ARGS).toEqual(['remote', 'get-url', '--push', '--all', '--']);
  });

  it('freezes both closed vocabularies it hands out', () => {
    expect(Object.isFrozen(DELIVERY_REMOTE_URL_ARGS)).toBe(true);
    expect(Object.isFrozen(DELIVERY_TARGET_OUTCOMES)).toBe(true);
  });
});

// ── Against a real repository ──────────────────────────────────────────────

describe('against a real repository', () => {
  it('reads the push URL, not the fetch URL', async () => {
    // Counter-proof for `--push`. Both URLs are valid and both resolve, so the
    // only thing that distinguishes a correct reader from an incorrect one is
    // *which* repository comes back. Dropping `--push` names `Owner/Fetched`.
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Fetched.git']);
    git(root, ['remote', 'set-url', '--push', 'origin', 'ssh://git@github.com/Other/Pushed.git']);

    expect(identityOf(await observe(root, 'origin'))).toBe('github.com/Other/Pushed');
  });

  it('refuses a remote with two push URLs', async () => {
    // Counter-proof for `--all`, and a real hazard rather than a hypothetical:
    // a push to such a remote reaches *both* repositories, so there is no
    // single delivery target to name. Without `--all`, Git prints the first URL
    // and exits 0, and the reader answers `A/One` with full confidence.
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git']);
    git(root, ['remote', 'set-url', '--push', 'origin', 'ssh://git@github.com/A/One.git']);
    git(root, ['remote', 'set-url', '--push', '--add', 'origin', 'ssh://git@github.com/B/Two.git']);

    expect((await observe(root, 'origin')).outcome).toBe('REMOTE_URL_AMBIGUOUS');
  });

  it('refuses a remote with two fetch URLs and no push URL', async () => {
    // The same counter-proof through the fallback path: with no push URL
    // configured, `--push --all` lists every fetch URL. Measured.
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git']);
    git(root, ['remote', 'set-url', '--add', 'origin', 'https://github.com/Owner/Second.git']);

    expect((await observe(root, 'origin')).outcome).toBe('REMOTE_URL_AMBIGUOUS');
  });

  it('refuses a single URL that contains a newline, rather than reading past it', async () => {
    // The fail-open a review found. Git accepts `\n` inside a config value, so
    // one URL can occupy several output lines; an earlier reader dropped the
    // empty ones and resolved `Evil/Repo` from bytes that are not that string.
    // Exactly one trailing terminator is removed now, so the extra line stays
    // visible and the answer is refused.
    const root = fixtureDeclaringDelivery();
    writeRawRemote(root, 'origin', 'url = "\\nhttps://github.com/Evil/Repo.git"');

    expect((await observe(root, 'origin')).outcome).toBe('REMOTE_URL_AMBIGUOUS');
  });

  it('refuses a URL whose own trailing newline Git preserved', async () => {
    // The same defect from the other side, and the one that pairs exactly with
    // the trailing-space case below: a trailing space is refused, so a trailing
    // newline must be too. Filtering empty lines made this one resolve.
    const root = fixtureDeclaringDelivery();
    writeRawRemote(root, 'origin', 'url = "https://github.com/Owner/Repo.git\\n"');

    expect((await observe(root, 'origin')).outcome).toBe('REMOTE_URL_AMBIGUOUS');
  });

  it('refuses a URL whose trailing space Git preserved', async () => {
    // Counter-proof for `rawStdout`. `GitQueryResult.stdout` is `.trim()`ed, so
    // a reader that used it would see `…/Repo.git` and resolve `Owner/Repo` —
    // an identity assembled from bytes the configuration does not contain. The
    // control below is the same URL without the space.
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git ']);

    expect((await observe(root, 'origin')).outcome).toBe('REMOTE_URL_NOT_REPOSITORY_SHAPED');

    const clean = fixtureDeclaringDelivery();
    git(clean, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git']);
    expect(identityOf(await observe(clean, 'origin'))).toBe('github.com/Owner/Repo');
  });

  it('reports the host a rewrite sends the push to, not the one that was typed', async () => {
    // Measured: `git remote get-url` applies `url.<base>.insteadOf`. That is the
    // direction this reader wants — reading `remote.origin.url` out of the
    // config would report `github.com` for a checkout whose pushes land
    // somewhere else, which is an identity that is wrong exactly when it is
    // being lied to. No host is judged in this build; that is `L-V4-01-2`.
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git']);
    git(root, ['config', 'url.https://rewritten.example.com/.insteadOf', 'https://github.com/']);

    expect(identityOf(await observe(root, 'origin'))).toBe('rewritten.example.com/Owner/Repo');
  });

  it('accepts the scp-like form a real remote stores verbatim', async () => {
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'git@github.com:Owner/Repo.git']);

    expect(identityOf(await observe(root, 'origin'))).toBe('github.com/Owner/Repo');
  });

  it('refuses a remote the repository does not have', async () => {
    const root = fixtureDeclaringDelivery('upstream');
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git']);

    expect((await observe(root, 'upstream')).outcome).toBe('REMOTE_NOT_CONFIGURED');
  });

  it('refuses a remote that exists with no URL, which Git answers with its name', async () => {
    // Measured, and the reason `REMOTE_NOT_CONFIGURED` does not claim to cover
    // this case: Git prints `origin\n` and exits 0 for a remote that has a
    // fetch refspec and no URL. That reaches the grammar, not the empty-answer
    // branch, and `origin` is not a repository-shaped URL.
    const root = fixtureDeclaringDelivery();
    writeRawRemote(root, 'origin', 'fetch = +refs/heads/*:refs/remotes/origin/*');

    expect((await observe(root, 'origin')).outcome).toBe('REMOTE_URL_NOT_REPOSITORY_SHAPED');
  });

  it('refuses a local-path remote, which is what a repository without a forge has', async () => {
    // `createRepoFixture({ remote: true })` adds exactly this: a bare
    // repository under the temp directory, named by an absolute path.
    const root = createRepoFixture({
      defaultBranch: 'main',
      profile: profileDeliveringVia('origin'),
      remote: true,
    });

    expect((await observe(root, 'origin')).outcome).toBe('REMOTE_URL_NOT_REPOSITORY_SHAPED');
  });

  it('refuses a remote URL with a credential in it, and reports no part of it', async () => {
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://ghp_EXAMPLETOKEN@github.com/Owner/Repo.git']);

    const result = await observe(root, 'origin');
    expect(result.outcome).toBe('REMOTE_URL_CARRIES_USERINFO');
    expect(JSON.stringify(result)).not.toContain('ghp_EXAMPLETOKEN');
  });
});

// ── The seam ───────────────────────────────────────────────────────────────

describe('the Git seam', () => {
  it('reports an unavailable Git as unavailable, never as an answer', async () => {
    const result = await observeDeliveryTarget('/nowhere', 'origin', async () => ({
      outcome: 'UNAVAILABLE' as const,
      stdout: '',
    }));
    expect(result.outcome).toBe('GIT_UNAVAILABLE');
  });

  it('refuses to fall back to the trimmed answer when no raw bytes were supplied', async () => {
    // The fail-closed half of the `rawStdout` decision. A runner that answers
    // `OK` with a perfectly good trimmed URL and no raw bytes has still not
    // answered the question this reader asks, and inventing the missing byte
    // sequence from the trimmed one is exactly the fallback that made the
    // trailing-space case above resolve.
    const result = await observeDeliveryTarget('/nowhere', 'origin', async () => ({
      outcome: 'OK' as const,
      stdout: 'https://github.com/Owner/Repo.git',
    }));
    expect(result.outcome).toBe('GIT_UNAVAILABLE');
  });

  it('refuses a CRLF answer rather than reading past the carriage return', async () => {
    // A behaviour pin, and deliberately **not** a counter-proof for the split
    // spelling: `split(/\r?\n/)` is this slice's one measured equivalent mutant
    // (see the module header). Only the `\n` terminator is removed, so the `\r`
    // stays in its line whichever spelling splits it, and the printable-ASCII
    // gate is what refuses it. What this case pins is the outcome — fail-closed,
    // so a runner that ever returned CRLF makes a target unresolvable rather
    // than wrong.
    const result = await observeDeliveryTarget('/nowhere', 'origin', async () => ({
      outcome: 'OK' as const,
      stdout: 'https://github.com/Owner/Repo.git',
      rawStdout: 'https://github.com/Owner/Repo.git\r\n',
    }));
    expect(result.outcome).toBe('REMOTE_URL_NOT_REPOSITORY_SHAPED');
  });

  it('removes exactly one terminator, never every blank line', async () => {
    // The splitter, driven directly: the same bytes the embedded-newline
    // fixture produces, with no repository in the way.
    const result = await observeDeliveryTarget('/nowhere', 'origin', async () => ({
      outcome: 'OK' as const,
      stdout: 'https://github.com/Evil/Repo.git',
      rawStdout: '\nhttps://github.com/Evil/Repo.git\n',
    }));
    expect(result.outcome).toBe('REMOTE_URL_AMBIGUOUS');
  });

  it.each([
    // The one character the guard exists for: Git reads it as an option. It is
    // refused only by the *first* character rule, so it is the case that dies
    // when that rule is loosened — every other refusal here is caught by the
    // tail class as well.
    ['-dash'],
    ['--upload-pack=touch'],
    [''],
    ['a'.repeat(101)],
  ])('refuses the remote name %j without starting Git', async (remoteName) => {
    let started = 0;
    const result = await observeDeliveryTarget('/nowhere', remoteName, async () => {
      started += 1;
      return { outcome: 'OK' as const, stdout: '', rawStdout: '' };
    });
    expect(result.outcome).toBe('REMOTE_NOT_CONFIGURED');
    expect(started).toBe(0);
  });

  it('sends the pinned vector and the remote name, and nothing else', async () => {
    let seen: readonly string[] = [];
    await observeDeliveryTarget('/nowhere', 'upstream', async (_cwd, args) => {
      seen = args;
      return { outcome: 'NONZERO_EXIT' as const, stdout: '' };
    });
    expect(seen).toEqual(['remote', 'get-url', '--push', '--all', '--', 'upstream']);
  });
});

// ── The repository profile ─────────────────────────────────────────────────

describe('the repository profile', () => {
  function validProfile(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      repository: { id: 'fixture-alpha', defaultBranch: 'main' },
      taskSource: { kind: 'MARKDOWN_DIRECTORY', path: 'tasks' },
      context: { canonicalSources: ['README.md'] },
      capabilities: { codegraph: 'OPTIONAL' },
      verification: { phases: [{ phase: 'VERIFY', command: ['npm', 'run', 'verify'] }] },
      scope: { allowedPaths: ['src'], protectedPaths: [] },
      completion: { maxReviewRounds: 3 },
      remote: { required: false },
    };
  }

  function profileAccepts(remote: string): boolean {
    return safeParseRepoProfile({ ...validProfile(), delivery: { remote } }).success;
  }

  it('accepts a profile that declares no delivery target', () => {
    const parsed = safeParseRepoProfile(validProfile());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.delivery).toBeUndefined();
  });

  it('accepts a declared delivery remote', () => {
    const parsed = safeParseRepoProfile({ ...validProfile(), delivery: { remote: 'origin' } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.delivery?.remote).toBe('origin');
  });

  it('refuses an unknown key inside the delivery block', () => {
    const profile = { ...validProfile(), delivery: { remote: 'origin', autoMerge: true } };
    expect(safeParseRepoProfile(profile).success).toBe(false);
  });

  it.each([
    ['origin'],
    ['upstream'],
    ['fork.2'],
    ['a_b-c.d'],
    ['-dash'],
    ['--all'],
    ['.hidden'],
    [''],
    ['has space'],
    ['a/b'],
    ['a'.repeat(100)],
    ['a'.repeat(101)],
  ])(
    'agrees with the reader about the remote name %j, which is why two copies of the rule are safe',
    async (remote) => {
      // The profile is the contract boundary and the reader is the use site;
      // the rule is written twice because the schema module must not grow an
      // import into the process layer. Nothing but this case makes them agree.
      let started = 0;
      const read = await observeDeliveryTarget('/nowhere', remote, async () => {
        started += 1;
        return {
          outcome: 'OK' as const,
          stdout: 'https://github.com/Owner/Repo.git',
          rawStdout: 'https://github.com/Owner/Repo.git\n',
        };
      });
      expect(read.outcome === 'RESOLVED').toBe(profileAccepts(remote));
      expect(started > 0).toBe(profileAccepts(remote));
    },
  );

  it('does not require the delivery block in the generated JSON Schema', async () => {
    const { REPO_PROFILE_SCHEMA_FILE } = await import('../src/config/paths.js');
    const { readFileSync } = await import('node:fs');
    const schema = JSON.parse(readFileSync(REPO_PROFILE_SCHEMA_FILE, 'utf8')) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(schema.required).not.toContain('delivery');
    expect(schema.properties['delivery']).toBeDefined();
  });
});

// ── Repository resolution ──────────────────────────────────────────────────

describe('repository resolution', () => {
  function urlQueries(cwd: string): readonly (readonly string[])[] {
    return gitSpy.calls
      .filter((call) => call.cwd === cwd && call.args[0] === 'remote' && call.args[1] === 'get-url')
      .map((call) => call.args);
  }

  it('asks Git no URL question when the profile declares no delivery target', async () => {
    const root = createRepoFixture({ defaultBranch: 'main', profile: FIXTURE_A_PROFILE });
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git']);

    const repository = resolvedRepository(await resolveRepository({ repositoryPath: root }));

    expect(repository.delivery).toEqual({ declared: false });
    expect(Object.hasOwn(repository.delivery, 'result')).toBe(false);
    // Frozen on this branch too: the outer freeze of the resolved repository
    // does not reach a nested object.
    expect(Object.isFrozen(repository.delivery)).toBe(true);
    // The measured half: a remote *exists* and would resolve cleanly, so a
    // build that asked anyway would produce an identity here. Nothing asked.
    expect(urlQueries(root)).toEqual([]);
  });

  it('carries the identity, and sends exactly the pinned vector to Git', async () => {
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git']);

    const repository = resolvedRepository(await resolveRepository({ repositoryPath: root }));

    expect(repository.delivery).toEqual({
      declared: true,
      remoteName: 'origin',
      result: { outcome: 'RESOLVED', target: { host: 'github.com', owner: 'Owner', name: 'Repo' } },
    });
    expect(urlQueries(root)).toEqual([['remote', 'get-url', '--push', '--all', '--', 'origin']]);
  });

  it('still resolves the repository when the declared target does not', async () => {
    // A delivery target AO cannot name is not a reason to stop a repository
    // working. The work still happens and `READY_FOR_PR` still hands it to a
    // human; the refusal is carried, and it carries no identity to act on.
    const root = fixtureDeclaringDelivery('upstream');

    const result = await resolveRepository({ repositoryPath: root });

    expect(result.ok).toBe(true);
    const repository = resolvedRepository(result);
    expect(repository.delivery).toEqual({
      declared: true,
      remoteName: 'upstream',
      result: { outcome: 'REMOTE_NOT_CONFIGURED' },
    });
  });

  it('freezes the delivery value with the rest of the resolved repository', async () => {
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git']);

    const repository = resolvedRepository(await resolveRepository({ repositoryPath: root }));
    expect(Object.isFrozen(repository.delivery)).toBe(true);
    if (repository.delivery.declared) {
      expect(Object.isFrozen(repository.delivery.result)).toBe(true);
    }
  });
});

// ── The operator's line ────────────────────────────────────────────────────

describe('the delivery line', () => {
  it('has a static sentence for every refusal, and none for the identity', () => {
    const refusals = DELIVERY_TARGET_OUTCOMES.filter((outcome) => outcome !== 'RESOLVED');
    expect(Object.keys(DELIVERY_TARGET_DETAIL).sort()).toEqual([...refusals].sort());
  });

  it('pins what each refusal actually tells an operator', () => {
    // Completeness was proved above and correctness was not, which is the trap
    // a `Record<keyof T>` sets: every key present, every value unread. A review
    // found the consequence — the README quoted a sentence for
    // `REMOTE_URL_AMBIGUOUS` that named a cause this slice deliberately refuses
    // to name, and nothing failed. The snapshot makes a reword a reviewable
    // diff rather than a silent one.
    expect(DELIVERY_TARGET_DETAIL).toMatchInlineSnapshot(`
      {
        "GIT_UNAVAILABLE": "The remote URL could not be read from Git.",
        "REMOTE_NOT_CONFIGURED": "No usable remote of the declared name was obtained: Git refused the question about it, or the declared name is one AO will not put in a command.",
        "REMOTE_URL_AMBIGUOUS": "Git did not answer with exactly one push URL for the declared remote, so there is no single delivery target.",
        "REMOTE_URL_CARRIES_USERINFO": "The remote URL embeds user information. A credential in a remote URL is not read, carried or reported.",
        "REMOTE_URL_NOT_REPOSITORY_SHAPED": "The remote URL does not name a host, an owner and a repository.",
      }
    `);
  });

  it('names no cause it cannot establish', () => {
    // `REMOTE_NOT_CONFIGURED` has two producers and Git's non-zero answers have
    // more than one meaning: exit 2 is "no such remote", exit 128 is a
    // configuration Git could not read, and a signal-killed child arrives with
    // a null exit status that the read-only seam also reads as non-zero. The
    // sentence must therefore not assert that the repository lacks the remote.
    expect(DELIVERY_TARGET_DETAIL.REMOTE_NOT_CONFIGURED).not.toContain('does not have');
    expect(DELIVERY_TARGET_DETAIL.REMOTE_NOT_CONFIGURED).toContain('or');
    // And the ambiguity sentence must not name a cause either, for the reason
    // the newline fix exists: a single URL spanning lines and a genuinely
    // multi-URL remote are indistinguishable in this output.
    expect(DELIVERY_TARGET_DETAIL.REMOTE_URL_AMBIGUOUS).not.toContain('more than one push URL');
  });

  it('names the identity, and says that naming it delivers nothing', () => {
    const text = renderDeliveryLine({
      declared: true,
      remoteName: 'origin',
      result: {
        outcome: 'RESOLVED',
        target: { host: 'github.com', owner: 'Owner', name: 'Repo' },
      },
    });
    expect(text).toContain('origin -> github.com/Owner/Repo');
    expect(text).toContain('nothing is delivered');
  });

  it('names the closed code and its static sentence on a refusal', () => {
    const text = renderDeliveryLine({
      declared: true,
      remoteName: 'origin',
      result: { outcome: 'REMOTE_URL_AMBIGUOUS' },
    });
    expect(text).toContain('REMOTE_URL_AMBIGUOUS');
    // The sentence as a literal, not as `DELIVERY_TARGET_DETAIL[...]`. Reading
    // it out of the map compares the map with itself and stays green under
    // every edit to it — a co-occurrence control, which is what this was.
    expect(text).toContain('Git did not answer with exactly one push URL for the declared remote');
  });

  it('says so plainly when no delivery target is declared', () => {
    // The whole clause, not a substring: the README prints this line verbatim,
    // and a `toContain('not declared')` let the two drift once already.
    expect(renderDeliveryLine({ declared: false })).toContain(
      'not declared  (this repository declares no delivery target)',
    );
  });

  it('appears in the run plan an operator actually reads', async () => {
    // Without this the three cases above would still pass if the renderer
    // stopped calling `renderDeliveryLine` at all.
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://github.com/Owner/Repo.git']);
    const repository = resolvedRepository(await resolveRepository({ repositoryPath: root }));

    const plan = await planRun(
      { repository, taskId: null },
      { git: runGitCommand, now: () => new Date().toISOString() },
    );

    expect(renderRunPlan(plan, repository)).toContain('Delivery');
    expect(renderRunPlan(plan, repository)).toContain('github.com/Owner/Repo');
  });

  it('never prints the URL a credential was configured in', async () => {
    // The control this slice most needs. A remote URL is the value most likely
    // to hold a secret, and the run plan is a console an operator reads, copies
    // and pastes into an issue.
    const root = fixtureDeclaringDelivery();
    git(root, ['remote', 'add', 'origin', 'https://ghp_EXAMPLETOKEN@github.com/Owner/Repo.git']);
    const repository = resolvedRepository(await resolveRepository({ repositoryPath: root }));

    const plan = await planRun(
      { repository, taskId: null },
      { git: runGitCommand, now: () => new Date().toISOString() },
    );
    const text = renderRunPlan(plan, repository);

    expect(text).toContain('REMOTE_URL_CARRIES_USERINFO');
    expect(text).not.toContain('ghp_EXAMPLETOKEN');
    expect(text).not.toContain('https://');
  });
});
