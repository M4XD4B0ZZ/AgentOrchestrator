/**
 * V4 slice 2 — the delivery observation seam.
 *
 * The suite is organised around the properties the slice claims, and every
 * claim that could be satisfied by an accident is paired with a control that
 * fails if the mechanism is removed.
 *
 * Two things this file deliberately never does:
 *
 *  - **it never contacts a network.** Every observation runs against an
 *    injected runner. The canonical suite must be deterministic on a machine
 *    that has never run `gh auth login`, and CI has no GitHub credentials at
 *    all. A test that needed one would be a test that gets skipped and then
 *    rots;
 *  - **it never asserts an absence without proving the absence is reachable.**
 *    "No process started" is only evidence when the same fixture, with the one
 *    guard removed or the one flag added, *does* start one. Those positive
 *    controls sit next to their negatives throughout.
 */

import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  FORGE_CLIENT_OVERRIDE_ENV_VARS,
  probeEnvAllowlist,
  PROBE_ENV_POLICIES,
} from '../src/auth/env-guard.js';
import {
  DELIVERY_COMMAND_DESCRIPTION,
  OBSERVE_OPTION_DESCRIPTION,
  registerDeliveryCommand,
  exitCodeFor,
} from '../src/cli/delivery-command.js';
import {
  CONTACTED_TRAILER,
  NOT_CONTACTED_TRAILER,
  renderCheckStateLine,
  renderDeliveryObservation,
  renderPullRequestLine,
} from '../src/cli/render-delivery-observation.js';
import { TERMINAL_STATES } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import {
  parseRemoteUrlIdentity,
  type ResolvedDelivery,
} from '../src/deliver/delivery-target.js';
import {
  aggregateCheckState,
  BLOCKING_CONCLUSIONS,
  NON_BLOCKING_CONCLUSIONS,
  CHECK_RUN_CONCLUSIONS,
  CHECK_RUN_STATUSES,
  COMMIT_STATUS_STATES,
  createObservationSubject,
  isAddressableSubject,
  matchExactHead,
  OBSERVATION_REFUSAL_DETAIL,
  OBSERVATION_REFUSALS,
  parseCheckRuns,
  parseCommitStatuses,
  parsePullCandidates,
  SUPPORTED_FORGE_HOSTS,
  supportedForgeHost,
  type ObservationSubject,
} from '../src/deliver/forge-observation.js';
import {
  CHECK_RUNS_FILTER_PARAM,
  checkRunsPath,
  commitStatusPath,
  FORGE_CLIENT_COMMAND,
  FORGE_CLIENT_WORKING_DIRECTORY,
  FORGE_ENV_POLICY,
  FORGE_REQUEST_PREFIX,
  forgeRequestArgs,
  OBSERVATION_MAX_RESPONSE_BYTES,
  OBSERVATION_PAGE_SIZE,
  OBSERVATION_TIMEOUT_MS,
  observeCheckStateAtCommit,
  observePullRequestAtHead,
  pullCandidatesPath,
  PER_PAGE_PARAM,
  type ForgeCommandRunner,
} from '../src/deliver/github-observer.js';
import {
  concludeObservation,
  observeDelivery,
  OBSERVATION_CONCLUSION_DETAIL,
  resolveObservationSubject,
  SUBJECT_REFUSAL_DETAIL,
  SUBJECT_REFUSALS,
} from '../src/deliver/observe-delivery.js';
import {
  isShellInertArgument,
  UnsafeArgumentError,
  WINDOWS_PLATFORM_BACKFILL,
  type CommandResult,
} from '../src/doctor/exec.js';
import type { StateLoadResult } from '../src/state/state-store.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const HEAD = '10583ee91a5747d0049f563ffaac64b0cf643aeb';
const OLDER = '46629f0503b0126318ead7229eba7a84d3e7504a';
const OTHER = 'c89ef605400a15e5d3db4d256c184773c0d533f6';

const IDENTITY = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});

function subjectOf(commit = HEAD): ObservationSubject {
  const built = createObservationSubject(IDENTITY, commit);
  if (!built.ok) throw new Error(`fixture subject refused: ${built.refusal}`);
  return built.subject;
}

interface RecordedCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
}

function commandResult(over: Partial<CommandResult>): CommandResult {
  return {
    display: 'gh api',
    executable: 'gh',
    args: [],
    started: true,
    outcome: 'COMPLETED',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    startedAt: '2026-08-23T00:00:00.000Z',
    finishedAt: '2026-08-23T00:00:01.000Z',
    durationMs: 1000,
    failureCode: null,
    errnoCode: null,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdinDelivery: 'NOT_REQUESTED',
    processTreeKilled: false,
    ...over,
  };
}

/**
 * A runner that records what it was asked to do and answers from a table keyed
 * by the endpoint's last path segment. Anything unlisted answers a 404-shaped
 * failure, so a test that provokes an unexpected request fails loudly rather
 * than falling through to a happy default.
 */
function recordingRunner(bodies: Readonly<Record<string, Partial<CommandResult>>>): {
  readonly runner: ForgeCommandRunner;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const runner: ForgeCommandRunner = async (command, args, options) => {
    calls.push({
      command,
      args: [...args],
      env: options.env,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxStdoutBytes: options.maxStdoutBytes,
    });
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    const key = path.split('/').pop() ?? '';
    const answer = bodies[key];
    return commandResult(answer ?? { exitCode: 1, stdout: '{"message":"Not Found"}' });
  };
  return { runner, calls };
}

function pullsBody(entries: readonly { number: number; state: string; sha: string }[]): string {
  return JSON.stringify(entries.map((e) => ({ number: e.number, state: e.state, head: { sha: e.sha } })));
}

function checkRunsBody(
  runs: readonly { status: string; conclusion: string | null }[],
  sha = HEAD,
): string {
  return JSON.stringify({
    total_count: runs.length,
    check_runs: runs.map((r) => ({ head_sha: sha, status: r.status, conclusion: r.conclusion })),
  });
}

function statusBody(states: readonly string[], sha = HEAD): string {
  return JSON.stringify({
    sha,
    total_count: states.length,
    state: states.length === 0 ? 'pending' : 'success',
    statuses: states.map((state) => ({ state })),
  });
}

/** Everything green, for the endpoints the two questions touch. */
function greenBodies(): Readonly<Record<string, Partial<CommandResult>>> {
  return {
    pulls: { stdout: pullsBody([{ number: 55, state: 'open', sha: HEAD }]) },
    'check-runs': {
      stdout: checkRunsBody([
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'success' },
      ]),
    },
    status: { stdout: statusBody([]) },
  };
}

// ── 1. Identity: which hosts this build will contact ───────────────────────

describe('the supported forge host set is closed and judged in code', () => {
  it('supports exactly github.com', () => {
    expect([...SUPPORTED_FORGE_HOSTS]).toEqual(['github.com']);
  });

  it.each([
    ['github.com', 'github.com'],
    ['gitlab.com', null],
    ['bitbucket.org', null],
    ['github.example.com', null],
    ['api.github.com', null],
    // Slice 1 lower-cases what it parses, so an upper-case host cannot arrive
    // from it. It is refused here anyway rather than folded: folding would
    // accept a spelling slice 1 itself would not produce.
    ['GitHub.com', null],
    ['github.com.evil.example', null],
    ['evil.example/github.com', null],
    ['', null],
  ])('supportedForgeHost(%j) -> %j', (host, expected) => {
    expect(supportedForgeHost(host)).toBe(expected);
  });

  it('refuses a subject on an unsupported host before anything else is judged', () => {
    // The commit is fine and the owner/name are fine. Only the host is wrong,
    // so this pins that the host alone is sufficient to refuse.
    const built = createObservationSubject({ ...IDENTITY, host: 'gitlab.com' }, HEAD);
    expect(built).toEqual({ ok: false, refusal: 'UNSUPPORTED_HOST' });
  });

  it('accepts the supported host — the positive control for the case above', () => {
    const built = createObservationSubject(IDENTITY, HEAD);
    expect(built.ok).toBe(true);
  });
});

// ── 2. Identity: what may become a request path ────────────────────────────

describe('the subject grammar', () => {
  it.each([
    ['a full lowercase object name', HEAD, true],
    ['an abbreviated object name', '10583ee', false],
    ['a branch name', 'main', false],
    ['HEAD', 'HEAD', false],
    ['an upper-case object name', HEAD.toUpperCase(), false],
    ['a 39-digit name', HEAD.slice(0, 39), false],
    ['a 41-digit name', `${HEAD}a`, false],
    // The durable task contract admits a SHA-256 object name. GitHub's
    // repositories are SHA-1, so it is refused here rather than sent.
    ['a 64-digit SHA-256 name', 'a'.repeat(64), false],
    ['a path traversal', '../../etc/passwd', false],
    ['an empty name', '', false],
  ])('%s: %j -> addressable %s', (_label, commit, expected) => {
    expect(isAddressableSubject(IDENTITY.owner, IDENTITY.name, commit)).toBe(expected);
    expect(createObservationSubject(IDENTITY, commit).ok).toBe(expected);
  });

  it.each([
    ['an ordinary owner', 'M4XD4B0ZZ', true],
    ['a hyphenated owner', 'some-org', true],
    ['an owner starting with a hyphen', '-evil', false],
    ['an owner with a slash', 'a/b', false],
    ['an owner with a dot-dot', '..', false],
    ['an empty owner', '', false],
  ])('owner %s: %j -> %s', (_label, owner, expected) => {
    expect(isAddressableSubject(owner, IDENTITY.name, HEAD)).toBe(expected);
  });

  it.each([
    ['an ordinary name', 'AgentOrchestrator', true],
    ['a dotted name', 'my.repo', true],
    // A leading dot is an ordinary repository name, which is exactly why a
    // name made only of dots needs a check of its own.
    ['a leading-dot name', '.github', true],
    ['a name starting with a hyphen', '-repo', false],
    ['a name with a slash', 'a/b', false],
    ['a name with a query string', 'repo?x=1', false],
    ['a single dot', '.', false],
    ['a dot-dot', '..', false],
    ['three dots', '...', false],
    ['an empty name', '', false],
  ])('repository name %s: %j -> %s', (_label, name, expected) => {
    expect(isAddressableSubject(IDENTITY.owner, name, HEAD)).toBe(expected);
  });

  /**
   * The agreement this module's comment claims, measured in both directions.
   *
   * It used to be claimed and not measured, and the claim was false: slice 1
   * refuses a name in two steps — its pattern, then a separate all-dots check —
   * and only the first was restated here. `..` therefore passed the guard the
   * transport makes immediately before building a path, and `..` also satisfies
   * `SAFE_ARG_PATTERN`, so `repos/{owner}/../commits/{sha}/pulls` would have
   * been built for a caller that cast its way to such a subject.
   *
   * Driving the same names through slice 1's parser and through this predicate
   * is what turns "they agree today" into something a future widening of either
   * one has to trip over.
   */
  it.each([
    ['AgentOrchestrator', true],
    ['.github', true],
    ['my.repo', true],
    ['.', false],
    ['..', false],
    ['...', false],
    ['-repo', false],
  ])('slice 1 and this build agree about the name %j', (name, expected) => {
    const parsed = parseRemoteUrlIdentity(`https://github.com/M4XD4B0ZZ/${name}.git`);
    expect(parsed.outcome === 'RESOLVED').toBe(expected);
    expect(isAddressableSubject('M4XD4B0ZZ', name, HEAD)).toBe(expected);
  });

  it('preserves owner and name case in the request path', () => {
    // Slice 1 preserves case; this build must not fold it, because two GitHub
    // owners differing only in case are not guaranteed to be the same account.
    const subject = subjectOf();
    expect(pullCandidatesPath(subject)).toContain('/M4XD4B0ZZ/AgentOrchestrator/');
    expect(pullCandidatesPath(subject)).not.toContain('m4xd4b0zz');
  });
});

// ── 3. The argument vector ─────────────────────────────────────────────────

describe('the request vector is pinned, not described', () => {
  it('is exactly this, for the locator endpoint', () => {
    expect(forgeRequestArgs(pullCandidatesPath(subjectOf()), [PER_PAGE_PARAM])).toEqual([
      'api',
      '--hostname',
      'github.com',
      '-X',
      'GET',
      `repos/M4XD4B0ZZ/AgentOrchestrator/commits/${HEAD}/pulls`,
      '-F',
      'per_page=100',
    ]);
  });

  it('is exactly this, for the check-runs endpoint', () => {
    expect(
      forgeRequestArgs(checkRunsPath(subjectOf()), [PER_PAGE_PARAM, CHECK_RUNS_FILTER_PARAM]),
    ).toEqual([
      'api',
      '--hostname',
      'github.com',
      '-X',
      'GET',
      `repos/M4XD4B0ZZ/AgentOrchestrator/commits/${HEAD}/check-runs`,
      '-F',
      'per_page=100',
      '-F',
      'filter=latest',
    ]);
  });

  /**
   * The counter-proof for the token whose removal turns a read into a write.
   *
   * `gh api` documents its default method as "GET normally and POST if any
   * parameters were added", and every request here adds parameters. This is not
   * a style assertion: without the pair, the observation issues a POST.
   */
  it('names the method explicitly, because every request carries parameters', () => {
    const args = forgeRequestArgs(checkRunsPath(subjectOf()), [PER_PAGE_PARAM]);
    const method = args.indexOf('-X');
    expect(method).toBeGreaterThanOrEqual(0);
    expect(args[method + 1]).toBe('GET');
    expect(args.some((a) => a.startsWith('per_page='))).toBe(true);
  });

  it('names the destination in this build, never from the parsed identity', () => {
    const hostFlag = FORGE_REQUEST_PREFIX.indexOf('--hostname');
    expect(hostFlag).toBeGreaterThanOrEqual(0);
    expect(FORGE_REQUEST_PREFIX[hostFlag + 1]).toBe('github.com');
    // The identity's host never reaches the vector as a value of its own.
    const forged = { ...subjectOf(), host: 'evil.example.com' };
    expect(forgeRequestArgs(pullCandidatesPath(forged), [PER_PAGE_PARAM])).not.toContain(
      'evil.example.com',
    );
  });

  it('produces only tokens the process boundary will accept', () => {
    // `runCommand` throws `UnsafeArgumentError` on a token outside
    // SAFE_ARG_PATTERN. An observation must never be able to reach that: it is
    // an exception, and this layer answers with data.
    for (const path of [
      pullCandidatesPath(subjectOf()),
      checkRunsPath(subjectOf()),
      commitStatusPath(subjectOf()),
    ]) {
      for (const token of forgeRequestArgs(path, [PER_PAGE_PARAM, CHECK_RUNS_FILTER_PARAM])) {
        expect(isShellInertArgument(token)).toBe(true);
      }
    }
  });

  it('carries no query string, because the boundary would refuse one', () => {
    // The reason `per_page` travels as `-F` rather than in the path: `?` is
    // outside the argument grammar. A regression to a query string would be
    // caught by the previous test, and this states why.
    expect(isShellInertArgument(`repos/o/r/commits/${HEAD}/check-runs?per_page=100`)).toBe(false);
  });

  it('asks for the same page size it uses as the truncation threshold', () => {
    expect(PER_PAGE_PARAM).toBe(`per_page=${String(OBSERVATION_PAGE_SIZE)}`);
  });

  /**
   * `-F` is the one flag in the vector whose value could be dangerous, and the
   * property that it never is deserves an assertion rather than an inspection.
   *
   * `gh api --help`: "if the value starts with `@`, the rest of the value is
   * interpreted as a filename" — and `@` is inside `SAFE_ARG_PATTERN`, so the
   * process boundary would not refuse `-F body=@C:/secret`.
   *
   * The first version of this scanned the `forgeRequestArgs(...)` call sites and
   * accepted `params` — the pass-through identifier — as one of its permitted
   * values, which made it blind to the only place a value is actually chosen.
   * `forgeRequestArgs` is called once, from `request`; the values come from the
   * three `request(...)` call sites, and those are what is read here.
   */
  it('gives -F only its own constants, never a value from anywhere else', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('src/deliver/github-observer.ts', 'utf8');

    // The array literal each `request(...)` call site passes as its params.
    const sites = [...source.matchAll(/\brequest\(\s*subject,[\s\S]*?\[([^\]]*)\]/g)].map(
      (m) => m[1] ?? '',
    );
    // Positive control: there really are three, so an empty scan is a broken
    // regex rather than a module with no requests in it.
    expect(sites).toHaveLength(3);
    for (const site of sites) {
      for (const token of site.split(',')) {
        const cleaned = token.trim();
        if (cleaned === '') continue;
        expect(['PER_PAGE_PARAM', 'CHECK_RUNS_FILTER_PARAM']).toContain(cleaned);
      }
    }

    // Second control: the scan would catch a threaded value. This is the exact
    // shape the docstring claims to prevent, run against the same regex.
    const threaded = `const r = await request(subject, commitStatusPath(subject), [PER_PAGE_PARAM, \`body=@\${x}\`], deps);`;
    const caught = [...threaded.matchAll(/\brequest\(\s*subject,[\s\S]*?\[([^\]]*)\]/g)].map(
      (m) => m[1] ?? '',
    );
    expect(caught).toHaveLength(1);
    expect(
      (caught[0] ?? '')
        .split(',')
        .map((t) => t.trim())
        .some((t) => !['PER_PAGE_PARAM', 'CHECK_RUNS_FILTER_PARAM'].includes(t)),
    ).toBe(true);

    // Positive control on the emitted vector: `-F` really is present, its
    // values really are these two, and neither can name a file.
    const emitted = forgeRequestArgs('repos/o/r/commits/x/check-runs', [
      PER_PAGE_PARAM,
      CHECK_RUNS_FILTER_PARAM,
    ]);
    expect(emitted.filter((t) => t === '-F')).toHaveLength(2);
    for (const value of [PER_PAGE_PARAM, CHECK_RUNS_FILTER_PARAM]) {
      expect(emitted).toContain(value);
      expect(value.startsWith('@')).toBe(false);
      expect(value).not.toContain('@');
    }
  });
});

// ── 4. The exact-head invariant ────────────────────────────────────────────

describe('a pull request matches only on its exact current head', () => {
  it('matches when the head is exactly the subject', () => {
    expect(matchExactHead([{ number: 55, state: 'open', headSha: HEAD }], HEAD)).toEqual({
      outcome: 'MATCHED',
      pullRequest: 55,
    });
  });

  /**
   * The measured failure this slice exists for.
   *
   * `GET /repos/{o}/{r}/commits/{sha}/pulls` answers "which pull requests
   * contain this commit" and reports each one's *current* head. Measured on
   * 2026-08-23: querying `46629f0…` returned pull request 55 with head
   * `10583ee…`. Reading that array as an answer would credit a new head with an
   * old commit's evidence.
   */
  it('does not match a pull request whose head has moved past the subject', () => {
    const candidates = [{ number: 55, state: 'open', headSha: HEAD }];
    expect(matchExactHead(candidates, OLDER)).toEqual({ outcome: 'NO_MATCHING_PULL_REQUEST' });
  });

  it('does not match a closed pull request that has exactly this head', () => {
    expect(matchExactHead([{ number: 54, state: 'closed', headSha: HEAD }], HEAD)).toEqual({
      outcome: 'NO_MATCHING_PULL_REQUEST',
    });
  });

  it('reports every open pull request that claims the head, when more than one does', () => {
    const result = matchExactHead(
      [
        { number: 71, state: 'open', headSha: HEAD },
        { number: 60, state: 'open', headSha: HEAD },
        { number: 59, state: 'closed', headSha: HEAD },
        { number: 58, state: 'open', headSha: OTHER },
      ],
      HEAD,
    );
    expect(result).toEqual({ outcome: 'AMBIGUOUS', pullRequests: [60, 71] });
  });

  it('does not call one pull request ambiguous because it was listed twice', () => {
    const result = matchExactHead(
      [
        { number: 55, state: 'open', headSha: HEAD },
        { number: 55, state: 'open', headSha: HEAD },
      ],
      HEAD,
    );
    expect(result).toEqual({ outcome: 'MATCHED', pullRequest: 55 });
  });

  it('offers no pull-request number on any outcome but MATCHED', () => {
    for (const result of [
      matchExactHead([], HEAD),
      matchExactHead([{ number: 1, state: 'open', headSha: HEAD }, { number: 2, state: 'open', headSha: HEAD }], HEAD),
    ]) {
      expect(result).not.toHaveProperty('pullRequest');
    }
  });
});

describe('the locator response is parsed totally', () => {
  it('accepts a well-formed page', () => {
    const parsed = parsePullCandidates(
      JSON.parse(pullsBody([{ number: 55, state: 'open', sha: HEAD }])),
      OBSERVATION_PAGE_SIZE,
    );
    expect(parsed).toEqual({ ok: true, candidates: [{ number: 55, state: 'open', headSha: HEAD }] });
  });

  it('refuses a full page rather than answering from a possible prefix', () => {
    const full = Array.from({ length: OBSERVATION_PAGE_SIZE }, (_, i) => ({
      number: i + 1,
      state: 'open',
      sha: OTHER,
    }));
    expect(parsePullCandidates(JSON.parse(pullsBody(full)), OBSERVATION_PAGE_SIZE)).toEqual({
      ok: false,
      refusal: 'RESULTS_TRUNCATED',
    });
  });

  it('accepts one record short of a full page — the control for the case above', () => {
    const nearly = Array.from({ length: OBSERVATION_PAGE_SIZE - 1 }, (_, i) => ({
      number: i + 1,
      state: 'open',
      sha: OTHER,
    }));
    expect(parsePullCandidates(JSON.parse(pullsBody(nearly)), OBSERVATION_PAGE_SIZE).ok).toBe(true);
  });

  it.each([
    ['not an array', {}],
    ['an array of non-objects', ['x']],
    ['a null member', [null]],
    ['a missing number', [{ state: 'open', head: { sha: HEAD } }]],
    ['a non-integer number', [{ number: 1.5, state: 'open', head: { sha: HEAD } }]],
    ['a zero number', [{ number: 0, state: 'open', head: { sha: HEAD } }]],
    ['a missing state', [{ number: 1, head: { sha: HEAD } }]],
    ['a missing head', [{ number: 1, state: 'open' }]],
    ['a head that is not an object', [{ number: 1, state: 'open', head: 'x' }]],
    ['a head sha that is abbreviated', [{ number: 1, state: 'open', head: { sha: '10583ee' } }]],
    ['a head sha that is not hex', [{ number: 1, state: 'open', head: { sha: 'z'.repeat(40) } }]],
  ])('refuses %s', (_label, body) => {
    expect(parsePullCandidates(body, OBSERVATION_PAGE_SIZE)).toEqual({
      ok: false,
      refusal: 'RESPONSE_MALFORMED',
    });
  });
});

// ── 5. Check state ─────────────────────────────────────────────────────────

describe('the check aggregate reads both mechanisms', () => {
  it('is SUCCESS when every record finished and none blocks', () => {
    expect(
      aggregateCheckState(
        [
          { status: 'completed', conclusion: 'success' },
          { status: 'completed', conclusion: 'success' },
        ],
        [],
      ),
    ).toEqual({
      outcome: 'SUCCESS',
      counts: { checkRuns: 2, commitStatuses: 0, failed: 0, pending: 0, succeeded: 2, neutralOrSkipped: 0 },
    });
  });

  it('is NO_CHECKS, never SUCCESS, when neither mechanism has a record', () => {
    expect(aggregateCheckState([], [])).toEqual({ outcome: 'NO_CHECKS' });
  });

  it('is PENDING while a run is unfinished', () => {
    const result = aggregateCheckState(
      [{ status: 'completed', conclusion: 'success' }, { status: 'in_progress', conclusion: null }],
      [],
    );
    expect(result.outcome).toBe('PENDING');
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'])(
    'is FAILED for the conclusion %s',
    (conclusion) => {
      expect(aggregateCheckState([{ status: 'completed', conclusion }], []).outcome).toBe('FAILED');
    },
  );

  it('lets a failure win over a still-running check', () => {
    // Stated as a contract rather than left to ordering: a failure is already
    // decisive, and PENDING would invite an operator to wait for an answer that
    // has arrived.
    const result = aggregateCheckState(
      [{ status: 'completed', conclusion: 'failure' }, { status: 'queued', conclusion: null }],
      [],
    );
    expect(result.outcome).toBe('FAILED');
  });

  it.each(['neutral', 'skipped'])('counts %s separately and does not call it a failure', (conclusion) => {
    const result = aggregateCheckState(
      [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion }],
      [],
    );
    expect(result.outcome).toBe('SUCCESS');
    expect(result).toHaveProperty('counts.neutralOrSkipped', 1);
    expect(result).toHaveProperty('counts.succeeded', 1);
  });

  it('refuses a completed run that carries no conclusion', () => {
    expect(aggregateCheckState([{ status: 'completed', conclusion: null }], [])).toEqual({
      outcome: 'RESPONSE_MALFORMED',
    });
  });

  it.each([
    ['pending', 'PENDING'],
    ['success', 'SUCCESS'],
    ['failure', 'FAILED'],
    ['error', 'FAILED'],
  ])('grades a legacy commit status %s as %s', (state, expected) => {
    expect(aggregateCheckState([], [{ state }]).outcome).toBe(expected);
  });

  it('sees a failing legacy status even when every check run passed', () => {
    // The hole in reading check runs alone. Without the second mechanism this
    // commit reports SUCCESS.
    const withStatus = aggregateCheckState(
      [{ status: 'completed', conclusion: 'success' }],
      [{ state: 'failure' }],
    );
    const withoutStatus = aggregateCheckState([{ status: 'completed', conclusion: 'success' }], []);
    expect(withStatus.outcome).toBe('FAILED');
    expect(withoutStatus.outcome).toBe('SUCCESS');
  });

  it('reports both mechanism totals so the operator can see both were read', () => {
    const result = aggregateCheckState(
      [{ status: 'completed', conclusion: 'success' }],
      [{ state: 'success' }],
    );
    expect(result).toHaveProperty('counts.checkRuns', 1);
    expect(result).toHaveProperty('counts.commitStatuses', 1);
  });
});

describe('the check responses are parsed totally and bound to the subject', () => {
  it('accepts a well-formed check-runs page', () => {
    const parsed = parseCheckRuns(
      JSON.parse(checkRunsBody([{ status: 'completed', conclusion: 'success' }])),
      HEAD,
    );
    expect(parsed).toEqual({ ok: true, runs: [{ status: 'completed', conclusion: 'success' }] });
  });

  it('refuses a check run attached to a different commit', () => {
    const body = JSON.parse(checkRunsBody([{ status: 'completed', conclusion: 'failure' }], OTHER));
    expect(parseCheckRuns(body, HEAD)).toEqual({ ok: false, refusal: 'SUBJECT_MISMATCH' });
  });

  it('refuses when total_count disagrees with the page it came with', () => {
    const body = { total_count: 5, check_runs: [{ head_sha: HEAD, status: 'completed', conclusion: 'success' }] };
    expect(parseCheckRuns(body, HEAD)).toEqual({ ok: false, refusal: 'RESULTS_TRUNCATED' });
  });

  it.each([
    ['an array instead of an object', []],
    ['a missing total_count', { check_runs: [] }],
    ['a missing check_runs', { total_count: 0 }],
    ['a run with no head_sha', { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' }] }],
    [
      'an unknown status',
      { total_count: 1, check_runs: [{ head_sha: HEAD, status: 'levitating', conclusion: null }] },
    ],
    [
      'an unknown conclusion',
      { total_count: 1, check_runs: [{ head_sha: HEAD, status: 'completed', conclusion: 'mostly_fine' }] },
    ],
  ])('refuses %s', (_label, body) => {
    expect(parseCheckRuns(body, HEAD)).toEqual({ ok: false, refusal: 'RESPONSE_MALFORMED' });
  });

  /**
   * The measured trap in the legacy endpoint.
   *
   * A commit with no legacy statuses answers `{"state":"pending","statuses":[]}`.
   * Reading that summary word would make every GitHub-Actions-only repository
   * permanently pending. Only the records are read.
   */
  it('does not read the combined summary word for an empty status set', () => {
    const body = JSON.parse(statusBody([]));
    expect(body.state).toBe('pending');
    const parsed = parseCommitStatuses(body, HEAD);
    expect(parsed).toEqual({ ok: true, statuses: [] });
    expect(aggregateCheckState([{ status: 'completed', conclusion: 'success' }], []).outcome).toBe(
      'SUCCESS',
    );
  });

  it('refuses a combined status that names a different commit', () => {
    expect(parseCommitStatuses(JSON.parse(statusBody([], OTHER)), HEAD)).toEqual({
      ok: false,
      refusal: 'SUBJECT_MISMATCH',
    });
  });

  it('refuses a combined status whose total disagrees with its records', () => {
    expect(parseCommitStatuses({ sha: HEAD, total_count: 3, statuses: [] }, HEAD)).toEqual({
      ok: false,
      refusal: 'RESULTS_TRUNCATED',
    });
  });

  it.each([
    ['a missing sha', { total_count: 0, statuses: [] }],
    ['a missing statuses array', { sha: HEAD, total_count: 0 }],
    ['an unknown state', { sha: HEAD, total_count: 1, statuses: [{ state: 'sideways' }] }],
  ])('refuses %s', (_label, body) => {
    expect(parseCommitStatuses(body, HEAD)).toEqual({ ok: false, refusal: 'RESPONSE_MALFORMED' });
  });
});

// ── 6. Transport classification ────────────────────────────────────────────

describe('the transport turns every process outcome into a closed refusal', () => {
  it.each([
    ['NOT_FOUND', { outcome: 'NOT_FOUND' as const, started: false }, 'FORGE_CLIENT_ABSENT'],
    ['TIMED_OUT', { outcome: 'TIMED_OUT' as const }, 'FORGE_CLIENT_UNUSABLE'],
    ['OUTPUT_LIMIT_EXCEEDED', { outcome: 'OUTPUT_LIMIT_EXCEEDED' as const }, 'FORGE_CLIENT_UNUSABLE'],
    ['SPAWN_FAILED', { outcome: 'SPAWN_FAILED' as const }, 'FORGE_CLIENT_UNUSABLE'],
    ['BOUNDARY_LOST', { outcome: 'BOUNDARY_LOST' as const }, 'FORGE_CLIENT_UNUSABLE'],
    ['exit 4', { exitCode: 4 }, 'NOT_AUTHENTICATED'],
    ['exit 1', { exitCode: 1 }, 'REQUEST_FAILED'],
    // Measured in slice 1: a COMPLETED result can carry a null exit code. It is
    // not a success, and it is not graded as one.
    ['a completed run with no exit code', { exitCode: null }, 'REQUEST_FAILED'],
  ])('reports %s as %s', async (_label, over, expected) => {
    const { runner } = recordingRunner({ pulls: over, 'check-runs': over, status: over });
    expect((await observePullRequestAtHead(subjectOf(), { runner, envSource: {} })).outcome).toBe(
      expected,
    );
    expect((await observeCheckStateAtCommit(subjectOf(), { runner, envSource: {} })).outcome).toBe(
      expected,
    );
  });

  /**
   * The reason the exit code is judged before the body is parsed.
   *
   * Measured: a 404 from `gh api` still writes GitHub's error document to
   * stdout and exits 1. That document is valid JSON, so a reader that parsed
   * first would have to decide what an object with a `message` key means.
   */
  it('does not parse a body that came with a failing exit code', async () => {
    const notFound = { exitCode: 1, stdout: '{"message":"Not Found","status":"404"}' };
    const { runner } = recordingRunner({ pulls: notFound });
    expect((await observePullRequestAtHead(subjectOf(), { runner, envSource: {} })).outcome).toBe(
      'REQUEST_FAILED',
    );
  });

  it.each([
    ['not JSON at all', 'this is not json'],
    ['an empty body', ''],
    ['a truncated document', '[{"number":55,'],
  ])('reports %s as RESPONSE_MALFORMED', async (_label, stdout) => {
    const { runner } = recordingRunner({ pulls: { stdout } });
    expect((await observePullRequestAtHead(subjectOf(), { runner, envSource: {} })).outcome).toBe(
      'RESPONSE_MALFORMED',
    );
  });

  it('never lets the client stderr reach a result', async () => {
    const { runner } = recordingRunner({
      pulls: { exitCode: 1, stderr: 'gh: Bad credentials ghp_SECRETVALUE (HTTP 401)' },
    });
    const result = await observePullRequestAtHead(subjectOf(), { runner, envSource: {} });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('Bad credentials');
    expect(result).toEqual({ outcome: 'REQUEST_FAILED' });
  });

  /**
   * The seam is guarded the way the other three seams over `runCommand` are
   * guarded, and no wider.
   *
   * `runCommand` documents exactly one thrown error — `UnsafeArgumentError`,
   * a programming error in this repository rather than a runtime condition —
   * and `worktree/git-command.ts`, `agent/agent-command.ts` and
   * `verify/verify-command.ts` all map that one to a typed refusal and let
   * everything else propagate.
   *
   * A first attempt at this guard used a bare `catch` returning
   * `FORGE_CLIENT_UNUSABLE`. That laundered a programming error into an
   * operator sentence, and it swallowed every other throw as well — a defect
   * anywhere under the call would have been reported as a forge that did not
   * answer. Both halves are pinned below.
   */
  it('maps an unsafe argument to SUBJECT_UNUSABLE, the way the sibling seams do', async () => {
    const refusing: ForgeCommandRunner = () => {
      throw new UnsafeArgumentError('repos/o/r?evil=1');
    };
    const result = await observePullRequestAtHead(subjectOf(), {
      runner: refusing,
      envSource: { PATH: '/usr/bin' },
    });
    expect(result).toEqual({ outcome: 'SUBJECT_UNUSABLE' });
    // Nothing from the error is read: it quotes the offending token.
    expect(JSON.stringify(result)).not.toContain('evil');
  });

  it('lets every other throw propagate rather than reporting it as a forge answer', async () => {
    const broken: ForgeCommandRunner = () => {
      throw new TypeError('a defect under this call');
    };
    await expect(
      observeCheckStateAtCommit(subjectOf(), { runner: broken, envSource: { PATH: '/usr/bin' } }),
    ).rejects.toThrow(TypeError);
  });

  it('bounds the request in time and in bytes', async () => {
    const { runner, calls } = recordingRunner(greenBodies());
    await observePullRequestAtHead(subjectOf(), { runner, envSource: {} });
    expect(calls[0]?.timeoutMs).toBe(OBSERVATION_TIMEOUT_MS);
    expect(calls[0]?.maxStdoutBytes).toBe(OBSERVATION_MAX_RESPONSE_BYTES);
  });
});

// ── 7. The guard at the effect ─────────────────────────────────────────────

describe('an unsupported subject starts no process, even when handed one', () => {
  /**
   * `ObservationSubject` is deliberately not branded. The guarantee is that the
   * transport re-checks the tuple at the moment it builds an argument vector,
   * and the only way to demonstrate that is to hand it a value the factory
   * would never have produced.
   */
  it.each([
    ['a host the factory refuses', { host: 'evil.example.com' }, 'UNSUPPORTED_HOST'],
    ['a branch name as the commit', { commit: 'main' }, 'SUBJECT_UNUSABLE'],
    ['an abbreviated commit', { commit: '10583ee' }, 'SUBJECT_UNUSABLE'],
    ['an owner with a slash', { owner: 'a/b' }, 'SUBJECT_UNUSABLE'],
    ['a traversal in the name', { name: '../../evil' }, 'SUBJECT_UNUSABLE'],
  ])('refuses %s with no call to the client', async (_label, override, expected) => {
    const forged = { ...subjectOf(), ...override } as ObservationSubject;
    const { runner, calls } = recordingRunner(greenBodies());

    expect((await observePullRequestAtHead(forged, { runner, envSource: {} })).outcome).toBe(expected);
    expect((await observeCheckStateAtCommit(forged, { runner, envSource: {} })).outcome).toBe(expected);
    expect(calls).toHaveLength(0);
  });

  it('does start the client for a subject that passes — the control', async () => {
    const { runner, calls } = recordingRunner(greenBodies());
    const result = await observePullRequestAtHead(subjectOf(), { runner, envSource: {} });
    expect(result).toEqual({ outcome: 'MATCHED', pullRequest: 55 });
    expect(calls).toHaveLength(1);
  });
});

// ── 8. The environment handed to the client ────────────────────────────────

describe('the client environment is built, not inherited', () => {
  const HOSTILE: NodeJS.ProcessEnv = {
    PATH: '/usr/bin',
    PATHEXT: '.EXE',
    APPDATA: 'C:\\Users\\Max\\AppData\\Roaming',
    GH_TOKEN: 'ghp_HOSTILE_TOKEN_VALUE',
    GITHUB_TOKEN: 'ghp_ANOTHER_HOSTILE_VALUE',
    GH_HOST: 'evil.example.com',
    GH_CONFIG_DIR: 'C:\\evil\\gh',
    XDG_CONFIG_HOME: '/evil/xdg',
    GH_DEBUG: 'api',
    GH_PAGER: 'C:\\evil\\pager.exe',
    HTTPS_PROXY: 'http://evil.example.com:8080',
    ANTHROPIC_API_KEY: 'sk-ant-HOSTILE',
    NODE_OPTIONS: '--require=C:\\evil\\preload.cjs',
  };

  it('forwards exactly PATH, PATHEXT and APPDATA', async () => {
    const { runner, calls } = recordingRunner(greenBodies());
    await observePullRequestAtHead(subjectOf(), { runner, envSource: HOSTILE });
    expect(Object.keys(calls[0]?.env ?? {}).sort()).toEqual(['APPDATA', 'PATH', 'PATHEXT']);
  });

  it('forwards not one variable that could redirect or authenticate the request', async () => {
    const { runner, calls } = recordingRunner(greenBodies());
    await observePullRequestAtHead(subjectOf(), { runner, envSource: HOSTILE });
    const env = calls[0]?.env ?? {};
    for (const name of FORGE_CLIENT_OVERRIDE_ENV_VARS) {
      expect(env[name]).toBeUndefined();
    }
    const serialised = JSON.stringify(env);
    expect(serialised).not.toContain('HOSTILE');
    expect(serialised).not.toContain('evil.example.com');
    expect(serialised).not.toContain('preload.cjs');
  });

  it('names the proxy variables that gh does not document but obeys', () => {
    // Measured: HTTPS_PROXY redirected every request; NO_PROXY undid it.
    // `gh help environment` lists neither, so a list built from that help alone
    // would have missed the variables that choose the destination.
    for (const name of ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'ALL_PROXY']) {
      expect(FORGE_CLIENT_OVERRIDE_ENV_VARS).toContain(name);
    }
  });

  /**
   * The property the policy allow-list on its own does **not** give, and which
   * two independent reviewers each read the policy comment as claiming.
   *
   * `createProbeEnv` decides what AO *supplies*. It does not decide what the
   * child receives: on Windows `runCommand` merges eleven fixed OS names out of
   * this process's environment into every child block, so the forge client gets
   * `SYSTEMROOT`, `USERPROFILE` and `TEMP` whatever the policy says. The
   * assertions above are therefore true and incomplete, and this is the one
   * that closes the gap — not by pretending the back-fill is absent, but by
   * pinning the property that makes it harmless.
   */
  it('shares not one name between the platform back-fill and the override class', () => {
    const backfilled = new Set<string>(WINDOWS_PLATFORM_BACKFILL.map((n) => n.toUpperCase()));
    const overrides = new Set<string>(FORGE_CLIENT_OVERRIDE_ENV_VARS.map((n) => n.toUpperCase()));
    const both = [...backfilled].filter((n) => overrides.has(n));
    expect(both).toEqual([]);

    // Positive control on both sets: they are the sets they are named after, so
    // an empty intersection is a fact rather than an empty operand. The
    // back-fill really does carry the two names the corrected comments name,
    // and the override class really does carry a credential and a destination.
    expect(backfilled).toContain('SYSTEMROOT');
    expect(backfilled).toContain('USERPROFILE');
    expect(overrides).toContain('GH_TOKEN');
    expect(overrides).toContain('GH_HOST');
    expect(overrides).toContain('GH_CONFIG_DIR');
    expect(overrides).toContain('HTTPS_PROXY');
  });

  it('runs the client outside the repository, so an observation writes nothing into it', async () => {
    // Measured with the block this policy supplies: the client writes
    // `.local/state/gh/device-id` relative to its working directory. Re-measured
    // with `USERPROFILE` present — which the Windows back-fill always supplies —
    // it writes nothing there, so the dirtied checkout is a property of the
    // policy block alone and not of the shipped path. The constant stays because
    // it costs nothing, survives a narrowing of that back-fill, and independently
    // denies the client any repository to infer context from.
    const { runner, calls } = recordingRunner(greenBodies());
    await observePullRequestAtHead(subjectOf(), { runner, envSource: HOSTILE });
    expect(calls[0]?.cwd).toBe(FORGE_CLIENT_WORKING_DIRECTORY);
    expect(calls[0]?.cwd).not.toContain('AgentOrchestrator');
  });

  it('answers ENVIRONMENT_UNUSABLE rather than throwing on an unusable source', async () => {
    // `createProbeEnv` refuses a proxy source. This layer must turn that into
    // data: an observation reports refusals, it does not raise.
    const proxied = new Proxy({ PATH: '/usr/bin' } as NodeJS.ProcessEnv, {});
    const { runner, calls } = recordingRunner(greenBodies());
    const result = await observePullRequestAtHead(subjectOf(), { runner, envSource: proxied });
    expect(result).toEqual({ outcome: 'ENVIRONMENT_UNUSABLE' });
    expect(calls).toHaveLength(0);
  });

  it('declares the policy in the closed policy set with the measured allow-list', () => {
    expect(PROBE_ENV_POLICIES).toContain(FORGE_ENV_POLICY);
    expect([...probeEnvAllowlist(FORGE_ENV_POLICY)]).toEqual(['PATH', 'PATHEXT', 'APPDATA']);
  });
});

// ── 9. Composition: subject resolution ─────────────────────────────────────

function loaded(state: Record<string, unknown>): StateLoadResult {
  return {
    ok: true,
    code: 'LOADED',
    classification: 'STATE_VALID',
    state: state as never,
    path: 'C:\\repo\\.agent\\state.json',
    revision: 'r1',
  };
}

const NO_STATE: StateLoadResult = {
  ok: false,
  code: 'NO_STATE',
  classification: 'STATE_MISSING',
  path: null,
  detail: null,
  errnoCode: null,
};

const DECLARED: ResolvedDelivery = Object.freeze({
  declared: true as const,
  remoteName: 'origin',
  result: { outcome: 'RESOLVED' as const, target: IDENTITY },
});

describe('the subject is resolved from the record, never guessed', () => {
  it('resolves from a declared target and a pinned commit', () => {
    const result = resolveObservationSubject(
      DECLARED,
      loaded({ state: 'READY_FOR_PR', currentCommit: HEAD }),
    );
    expect(result).toMatchObject({
      ok: true,
      taskState: 'READY_FOR_PR',
      remoteName: 'origin',
      subject: { host: 'github.com', owner: 'M4XD4B0ZZ', name: 'AgentOrchestrator', commit: HEAD },
    });
  });

  it('refuses when the repository declares no delivery target', () => {
    const result = resolveObservationSubject(
      { declared: false },
      loaded({ state: 'READY_FOR_PR', currentCommit: HEAD }),
    );
    expect(result).toEqual({ ok: false, code: 'DELIVERY_NOT_DECLARED', deliveryDetail: null });
  });

  it('carries the delivery target refusal when a mistyped remote did not resolve', () => {
    // The residual slice 1 named: a mistyped `delivery.remote` must surface,
    // not disappear. It surfaces here as its own closed code.
    const result = resolveObservationSubject(
      { declared: true, remoteName: 'orgin', result: { outcome: 'REMOTE_NOT_CONFIGURED' } },
      loaded({ state: 'READY_FOR_PR', currentCommit: HEAD }),
    );
    expect(result).toEqual({
      ok: false,
      code: 'DELIVERY_TARGET_UNRESOLVED',
      deliveryDetail: 'REMOTE_NOT_CONFIGURED',
    });
  });

  it('refuses when no durable record could be read', () => {
    expect(resolveObservationSubject(DECLARED, NO_STATE)).toEqual({
      ok: false,
      code: 'TASK_STATE_UNAVAILABLE',
      deliveryDetail: null,
    });
  });

  it('refuses when the record pins no commit', () => {
    const result = resolveObservationSubject(
      DECLARED,
      loaded({ state: 'WORKTREE_READY', currentCommit: null }),
    );
    expect(result).toEqual({ ok: false, code: 'NO_CURRENT_COMMIT', deliveryDetail: null });
  });

  it('refuses a target on an unsupported host', () => {
    const gitlab: ResolvedDelivery = {
      declared: true,
      remoteName: 'origin',
      result: { outcome: 'RESOLVED', target: { ...IDENTITY, host: 'gitlab.com' } },
    };
    expect(
      resolveObservationSubject(gitlab, loaded({ state: 'READY_FOR_PR', currentCommit: HEAD })),
    ).toMatchObject({ ok: false, code: 'UNSUPPORTED_HOST' });
  });

  it('refuses a record whose commit is not a full object name', () => {
    const result = resolveObservationSubject(
      DECLARED,
      loaded({ state: 'READY_FOR_PR', currentCommit: 'a'.repeat(64) }),
    );
    expect(result).toMatchObject({ ok: false, code: 'SUBJECT_UNUSABLE' });
  });

  it('offers no subject on any refusal', () => {
    for (const result of [
      resolveObservationSubject({ declared: false }, NO_STATE),
      resolveObservationSubject(DECLARED, NO_STATE),
    ]) {
      expect(result).not.toHaveProperty('subject');
    }
  });
});

// ── 10. Both questions, and the order they are asked in ────────────────────

describe('the two questions', () => {
  it('are asked about the same commit, on every endpoint', async () => {
    const { runner, calls } = recordingRunner(greenBodies());
    await observeDelivery(subjectOf(), { runner, envSource: {} });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.args.some((a) => a.includes(`/commits/${HEAD}/`))).toBe(true);
      expect(call.command).toBe(FORGE_CLIENT_COMMAND);
    }
    expect(calls.map((c) => c.args.find((a) => a.startsWith('repos/'))?.split('/').pop())).toEqual([
      'pulls',
      'check-runs',
      'status',
    ]);
  });

  /**
   * The order is a guard, not a habit.
   *
   * Measured: for a commit that is not in the repository, `check-runs` answers
   * HTTP 422 while `status` answers HTTP 200 with `state: "pending"` and echoes
   * the requested sha back. Asking `status` first would turn a typo into a
   * PENDING an operator waits on forever.
   */
  it('asks check-runs before the endpoint that invents an answer for an unknown commit', async () => {
    const { runner, calls } = recordingRunner({
      'check-runs': { exitCode: 1, stdout: '{"message":"No commit found for SHA"}' },
      status: { stdout: statusBody([]) },
    });
    const result = await observeCheckStateAtCommit(subjectOf(), { runner, envSource: {} });
    expect(result).toEqual({ outcome: 'REQUEST_FAILED' });
    // The combined-status endpoint was never reached, so its fabricated
    // "pending" never had the chance to become the answer.
    expect(calls.map((c) => c.args.find((a) => a.startsWith('repos/'))?.split('/').pop())).toEqual([
      'check-runs',
    ]);
  });

  it('still asks about the checks when no pull request matched', async () => {
    const { runner } = recordingRunner({
      ...greenBodies(),
      pulls: { stdout: pullsBody([]) },
    });
    const observation = await observeDelivery(subjectOf(), { runner, envSource: {} });
    expect(observation.pullRequest).toEqual({ outcome: 'NO_MATCHING_PULL_REQUEST' });
    expect(observation.checks.outcome).toBe('SUCCESS');
  });

  it('combines nothing: neither answer carries a merge verdict', async () => {
    const { runner } = recordingRunner(greenBodies());
    const observation = await observeDelivery(subjectOf(), { runner, envSource: {} });
    const text = JSON.stringify(observation).toUpperCase();
    for (const forbidden of ['MERGE', 'ELIGIBLE', 'READY', 'APPROVED', 'AUTHORIS', 'AUTHORIZ']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

// ── 11. What the whole invocation amounts to ───────────────────────────────

describe('the conclusion', () => {
  const subject = resolveObservationSubject(
    DECLARED,
    loaded({ state: 'READY_FOR_PR', currentCommit: HEAD }),
  );

  it('is NOT_OBSERVED when a subject exists and nothing was asked', () => {
    expect(concludeObservation(subject, null)).toBe('NOT_OBSERVED');
  });

  it('is SUBJECT_NOT_ESTABLISHED when there was nothing to ask about', () => {
    expect(concludeObservation(resolveObservationSubject({ declared: false }, NO_STATE), null)).toBe(
      'SUBJECT_NOT_ESTABLISHED',
    );
  });

  it.each([
    ['MATCHED', 'SUCCESS'],
    ['NO_MATCHING_PULL_REQUEST', 'NO_CHECKS'],
    ['AMBIGUOUS', 'FAILED'],
    ['NO_MATCHING_PULL_REQUEST', 'PENDING'],
  ])('is OBSERVED for the settled pair %s / %s', (pr, checks) => {
    const observation = {
      pullRequest: { outcome: pr } as never,
      checks: { outcome: checks } as never,
    };
    expect(concludeObservation(subject, observation)).toBe('OBSERVED');
  });

  it.each([
    ['NOT_AUTHENTICATED', 'SUCCESS'],
    ['MATCHED', 'REQUEST_FAILED'],
    ['RESPONSE_MALFORMED', 'FORGE_CLIENT_ABSENT'],
  ])('is OBSERVATION_INCOMPLETE when %s / %s', (pr, checks) => {
    const observation = {
      pullRequest: { outcome: pr } as never,
      checks: { outcome: checks } as never,
    };
    expect(concludeObservation(subject, observation)).toBe('OBSERVATION_INCOMPLETE');
  });

  it('maps to exit codes that distinguish an answer from a refusal', () => {
    expect(exitCodeFor('OBSERVED')).toBe(0);
    expect(exitCodeFor('NOT_OBSERVED')).toBe(0);
    expect(exitCodeFor('SUBJECT_NOT_ESTABLISHED')).toBe(2);
    expect(exitCodeFor('OBSERVATION_INCOMPLETE')).toBe(4);
  });
});

// ── 12. Rendering ──────────────────────────────────────────────────────────

describe('rendering carries facts and never foreign text', () => {
  it('prints a matched pull request by number alone', () => {
    expect(renderPullRequestLine({ outcome: 'MATCHED', pullRequest: 55 })).toContain('MATCHED  (#55)');
  });

  it('prints every ambiguous candidate', () => {
    const text = renderPullRequestLine({ outcome: 'AMBIGUOUS', pullRequests: [60, 71] });
    expect(text).toContain('#60, #71');
  });

  it('prints check counts beside every graded outcome, including SUCCESS', () => {
    const text = renderCheckStateLine({
      outcome: 'SUCCESS',
      counts: { checkRuns: 2, commitStatuses: 1, failed: 0, pending: 0, succeeded: 3, neutralOrSkipped: 0 },
    });
    expect(text).toContain('2 check run(s), 1 commit status(es)');
    expect(text).toContain('3 succeeded');
  });

  it('says plainly that no checks is not success', () => {
    expect(renderCheckStateLine({ outcome: 'NO_CHECKS' })).toContain('This is not success');
  });

  it('renders the exact subject commit, so no answer is unattached', () => {
    const subject = resolveObservationSubject(
      DECLARED,
      loaded({ state: 'READY_FOR_PR', currentCommit: HEAD }),
    );
    const text = renderDeliveryObservation({
      repositoryId: 'ao',
      repositoryRoot: 'D:\\AgentOrchestrator',
      taskId: 'T-001',
      subject,
      observation: null,
      conclusion: 'NOT_OBSERVED',
    });
    expect(text).toContain(`Subject      : ${HEAD}`);
    expect(text).toContain('github.com/M4XD4B0ZZ/AgentOrchestrator');
    expect(text).toContain(NOT_CONTACTED_TRAILER);
    expect(text).not.toContain(CONTACTED_TRAILER);
  });

  it('says a forge was contacted only when one was', async () => {
    const subject = resolveObservationSubject(
      DECLARED,
      loaded({ state: 'READY_FOR_PR', currentCommit: HEAD }),
    );
    if (!subject.ok) throw new Error('fixture');
    const { runner } = recordingRunner(greenBodies());
    const observation = await observeDelivery(subject.subject, { runner, envSource: {} });
    const text = renderDeliveryObservation({
      repositoryId: 'ao',
      repositoryRoot: 'D:\\AgentOrchestrator',
      taskId: 'T-001',
      subject,
      observation,
      conclusion: 'OBSERVED',
    });
    expect(text).toContain(CONTACTED_TRAILER);
    expect(text).toContain('MATCHED  (#55)');
  });

  it('shows a mistyped remote instead of losing it', () => {
    const subject = resolveObservationSubject(
      { declared: true, remoteName: 'orgin', result: { outcome: 'REMOTE_NOT_CONFIGURED' } },
      loaded({ state: 'READY_FOR_PR', currentCommit: HEAD }),
    );
    const text = renderDeliveryObservation({
      repositoryId: 'ao',
      repositoryRoot: 'D:\\AgentOrchestrator',
      taskId: 'T-001',
      subject,
      observation: null,
      conclusion: 'SUBJECT_NOT_ESTABLISHED',
    });
    expect(text).toContain('DELIVERY_TARGET_UNRESOLVED');
    expect(text).toContain('[delivery target: REMOTE_NOT_CONFIGURED]');
  });
});

// ── 13. Operator sentences, pinned by literal ──────────────────────────────

describe('the operator sentences are pinned by literal, not by reading the map', () => {
  it('covers every refusal and every conclusion', () => {
    expect(Object.keys(OBSERVATION_REFUSAL_DETAIL).sort()).toEqual([...OBSERVATION_REFUSALS].sort());
    expect(Object.keys(SUBJECT_REFUSAL_DETAIL).sort()).toEqual([...SUBJECT_REFUSALS].sort());
  });

  it('says exactly this — every sentence, not a sample of them', () => {
    // Slice 1 shipped a sentence map whose one binding test compared the map
    // with itself, and a README sample drifted away from the code unnoticed.
    //
    // The first version of this case cited that defect and then pinned four of
    // ten refusals, one of six subject refusals and one of four conclusions —
    // while `forge-observation.ts` and `observe-delivery.ts` both told the
    // reader the sentences were "pinned by literal, never by reading the map".
    // Whole-map equality against object literals is what makes those two
    // sentences true: every sentence below is written out here, so a drifted
    // one is red, and no assertion can be satisfied by consulting the source.
    expect({ ...OBSERVATION_REFUSAL_DETAIL }).toEqual({
      UNSUPPORTED_HOST:
        'The delivery target is not on a host this build contacts. Nothing was requested.',
      SUBJECT_UNUSABLE:
        'The repository identity or the commit object name is not one this build will put in a request.',
      FORGE_CLIENT_ABSENT: 'No GitHub CLI was found on this machine, so nothing was asked.',
      ENVIRONMENT_UNUSABLE:
        'The environment for the GitHub CLI could not be built unambiguously, so nothing was started.',
      FORGE_CLIENT_UNUSABLE:
        'The GitHub CLI produced no usable answer, so nothing is established.',
      NOT_AUTHENTICATED:
        'The GitHub CLI reports that this request needs an authentication it does not have.',
      REQUEST_FAILED: 'The GitHub CLI ran and the request did not succeed.',
      RESPONSE_MALFORMED:
        'The answer was not of a shape this build accepts, so it was not read as evidence.',
      SUBJECT_MISMATCH:
        'The answer identifies a different commit than the one asked about, so it was not read as evidence.',
      RESULTS_TRUNCATED:
        'The forge returned a full page of records, so a further one cannot be ruled out.',
    });

    expect({ ...SUBJECT_REFUSAL_DETAIL }).toEqual({
      DELIVERY_NOT_DECLARED:
        'This repository declares no delivery target, so there is nothing to observe.',
      DELIVERY_TARGET_UNRESOLVED:
        'The declared delivery target did not resolve to a repository identity.',
      TASK_STATE_UNAVAILABLE: 'No durable record for this task could be read.',
      NO_CURRENT_COMMIT:
        'The durable record pins no commit, so there is no subject to ask about.',
      UNSUPPORTED_HOST:
        'The delivery target is not on a host this build contacts. Nothing was requested.',
      SUBJECT_UNUSABLE:
        'The repository identity or the commit object name is not one this build will put in a request.',
    });

    // The two trailers are the strongest promises this surface makes, and they
    // were the one operator-facing string nothing pinned. `CONTACTED_TRAILER`
    // used to say "github.com was asked about one commit and nothing else",
    // which the same commit's own residual `L-V4-02-6` contradicts: the client
    // sends telemetry and runs an update check that this build does not
    // suppress. A promise that strong needs a literal.
    expect(NOT_CONTACTED_TRAILER).toBe(
      'Read-only. No forge was contacted, no task state was written, and nothing was delivered.',
    );
    expect(CONTACTED_TRAILER).toBe(
      'Read-only. This build asked about no commit but the one named above, and about no other\n' +
        'repository. No task state was written. No pull request was opened, updated, reviewed or\n' +
        'merged. The GitHub CLI also makes calls of its own — telemetry, and a periodic update\n' +
        'check — which this build does not suppress (L-V4-02-6).',
    );

    // The flag's own sentence is a promise too, and it was the last copy of the
    // withdrawn over-claim: `CONTACTED_TRAILER` was corrected and this was not,
    // so two strings made the same promise and only one was true. Pinned by
    // literal, and both help strings are checked for the phrase itself so a
    // third copy cannot reappear anywhere on this surface.
    expect(OBSERVE_OPTION_DESCRIPTION).toBe(
      'Ask github.com about the commit named above, read-only. This is the only way this ' +
        'build contacts a forge for delivery, and it asks about no commit but that one. The ' +
        'GitHub CLI additionally makes calls of its own (telemetry, update check) that this ' +
        'build does not suppress. Without this flag nothing leaves this machine.',
    );
    for (const text of [
      OBSERVE_OPTION_DESCRIPTION,
      DELIVERY_COMMAND_DESCRIPTION,
      CONTACTED_TRAILER,
      NOT_CONTACTED_TRAILER,
    ]) {
      expect(text).not.toContain('and nothing else');
    }

    expect({ ...OBSERVATION_CONCLUSION_DETAIL }).toEqual({
      NOT_OBSERVED:
        'The subject is established. Nothing was contacted; pass --observe to ask the forge.',
      SUBJECT_NOT_ESTABLISHED: 'There is no subject to ask about, so no request was made.',
      OBSERVED:
        'Both questions were answered for exactly the commit named above. Nothing was delivered.',
      OBSERVATION_INCOMPLETE:
        'At least one question was not answered, so nothing about it is established.',
    });
  });

  it('interpolates nothing into any sentence', () => {
    for (const sentence of [
      ...Object.values(OBSERVATION_REFUSAL_DETAIL),
      ...Object.values(SUBJECT_REFUSAL_DETAIL),
      ...Object.values(OBSERVATION_CONCLUSION_DETAIL),
    ]) {
      expect(sentence.length).toBeGreaterThan(20);
      expect(sentence).not.toContain('${');
      expect(sentence).not.toContain('undefined');
    }
  });

  /**
   * The slice-1 defect this file's header names, applied to this slice.
   *
   * Slice 1's README sample drifted away from the code and nothing noticed,
   * because nothing compared them. The observation sample is a block of console
   * output an operator will read as the contract, so it is compared with the
   * renderer's own constants here rather than maintained by hand.
   */
  it('keeps the README sample and the rendered output the same text', async () => {
    const { readFileSync } = await import('node:fs');
    const readme = readFileSync('README.md', 'utf8');

    // Positive control: the sample block really is in the file, so a missing
    // substring below is drift rather than a wrong path.
    expect(readme).toContain('agent-loop delivery --repository');
    expect(readme).toContain('Subject      : ');

    expect(readme).toContain(CONTACTED_TRAILER);
    expect(readme).toContain(NOT_CONTACTED_TRAILER);
    expect(readme).toContain(OBSERVATION_CONCLUSION_DETAIL.OBSERVED);
    expect(readme).toContain(
      renderCheckStateLine({
        outcome: 'SUCCESS',
        counts: {
          checkRuns: 2,
          commitStatuses: 0,
          failed: 0,
          pending: 0,
          succeeded: 2,
          neutralOrSkipped: 0,
        },
      }),
    );
    expect(readme).toContain(renderPullRequestLine({ outcome: 'MATCHED', pullRequest: 55 }));
  });

  /**
   * The grading is fail-closed, and this is what keeps it honest.
   *
   * `aggregateCheckState` counts `success` as the only success and everything
   * that is not non-blocking as blocking. So a conclusion GitHub adds later —
   * which `parseCheckRuns` would accept the moment it joined
   * `CHECK_RUN_CONCLUSIONS` — is graded `FAILED`, never `SUCCESS`, whatever
   * anyone remembers to update. The arms used to be ordered the other way, with
   * an `else succeeded` default, which graded an unclassified conclusion green.
   *
   * The partition is asserted so that "this build has decided about every
   * conclusion it accepts" stays true rather than becoming a stale list, and a
   * new member turns a test red — a decision to take, not a silent grading.
   */
  it('has decided about every check-run conclusion it accepts', () => {
    const decided = new Set<string>([
      ...BLOCKING_CONCLUSIONS,
      ...NON_BLOCKING_CONCLUSIONS,
      'success',
    ]);
    expect([...decided].sort()).toEqual([...CHECK_RUN_CONCLUSIONS].sort());
    // The three classes are disjoint: no conclusion is both blocking and not.
    for (const conclusion of NON_BLOCKING_CONCLUSIONS) {
      expect(BLOCKING_CONCLUSIONS.has(conclusion)).toBe(false);
    }
    expect(BLOCKING_CONCLUSIONS.has('success')).toBe(false);
    expect(NON_BLOCKING_CONCLUSIONS.has('success')).toBe(false);
  });

  it('grades a conclusion it has never seen as FAILED, not as SUCCESS', () => {
    // The counter-proof for the ordering above, driven through the aggregate
    // rather than through the list: a value outside all three classes must not
    // reach `succeeded`. `parseCheckRuns` would refuse this shape, which is why
    // the aggregate is called directly — the question is what the grading does
    // if the enumeration ever widens ahead of the classification.
    const graded = aggregateCheckState([{ status: 'completed', conclusion: 'quarantined' }], []);
    expect(graded.outcome).toBe('FAILED');
    expect(graded).toMatchObject({ counts: { failed: 1, succeeded: 0 } });
  });

  it('names every enumeration this build accepts from the forge', () => {
    expect([...CHECK_RUN_STATUSES]).toEqual([
      'queued',
      'in_progress',
      'completed',
      'waiting',
      'requested',
      'pending',
    ]);
    expect([...CHECK_RUN_CONCLUSIONS]).toEqual([
      'success',
      'failure',
      'neutral',
      'cancelled',
      'skipped',
      'timed_out',
      'action_required',
      'stale',
      'startup_failure',
    ]);
    expect([...COMMIT_STATUS_STATES]).toEqual(['error', 'failure', 'pending', 'success']);
  });
});

// ── 14. The product surface ────────────────────────────────────────────────

describe('the CLI surface', () => {
  function harness(over: {
    delivery?: ResolvedDelivery;
    load?: StateLoadResult;
    bodies?: Readonly<Record<string, Partial<CommandResult>>>;
  }) {
    const out: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown): boolean => {
        out.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    const { runner, calls } = recordingRunner(over.bodies ?? greenBodies());
    const program = new Command();
    program.exitOverride();
    registerDeliveryCommand(program, {
      resolveRepository: async () =>
        ({
          ok: true,
          repository: {
            id: 'ao',
            root: 'D:\\AgentOrchestrator',
            delivery: over.delivery ?? DECLARED,
          },
        }) as never,
      loadTaskState: () => over.load ?? loaded({ state: 'READY_FOR_PR', currentCommit: HEAD }),
      runner,
      envSource: { PATH: '/usr/bin' },
    });
    return { program, out, calls, restore: () => write.mockRestore() };
  }

  /** The egress property, as a fact about the code rather than about help text. */
  it('starts no client when --observe was not given', async () => {
    const h = harness({});
    try {
      await h.program.parseAsync(
        ['delivery', '--repository', 'D:\\AgentOrchestrator', '--task', 'T-001'],
        { from: 'user' },
      );
    } finally {
      h.restore();
    }
    expect(h.calls).toHaveLength(0);
    expect(h.out.join('')).toContain('not observed');
    expect(h.out.join('')).toContain(NOT_CONTACTED_TRAILER);
    expect(process.exitCode).toBe(0);
  });

  /** The positive control: the same fixture, one flag, and a client does start. */
  it('starts the client when --observe is given', async () => {
    const h = harness({});
    try {
      await h.program.parseAsync(
        ['delivery', '--repository', 'D:\\AgentOrchestrator', '--task', 'T-001', '--observe'],
        { from: 'user' },
      );
    } finally {
      h.restore();
    }
    expect(h.calls).toHaveLength(3);
    expect(h.out.join('')).toContain('MATCHED  (#55)');
    expect(process.exitCode).toBe(0);
  });

  it('contacts nothing when no subject could be established, even with --observe', async () => {
    const h = harness({ delivery: { declared: false } });
    try {
      await h.program.parseAsync(
        ['delivery', '--repository', 'D:\\AgentOrchestrator', '--task', 'T-001', '--observe'],
        { from: 'user' },
      );
    } finally {
      h.restore();
    }
    expect(h.calls).toHaveLength(0);
    expect(h.out.join('')).toContain('DELIVERY_NOT_DECLARED');
    expect(process.exitCode).toBe(2);
  });

  it('renders no credential-shaped text even when the client failed loudly', async () => {
    const h = harness({
      bodies: {
        pulls: { exitCode: 1, stderr: 'gh: Bad credentials ghp_LEAKED (HTTP 401)' },
        'check-runs': { exitCode: 4, stderr: 'gh auth login' },
      },
    });
    try {
      await h.program.parseAsync(
        ['delivery', '--repository', 'D:\\AgentOrchestrator', '--task', 'T-001', '--observe'],
        { from: 'user' },
      );
    } finally {
      h.restore();
    }
    const text = h.out.join('');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('LEAKED');
    expect(text).toContain('REQUEST_FAILED');
    expect(text).toContain('NOT_AUTHENTICATED');
    expect(process.exitCode).toBe(4);
  });

  it('writes no task state on any path', async () => {
    // The first version of this read one file and claimed the module graph.
    // It also had no positive control, so a renamed file or a mistyped path
    // would have produced three vacuous passes.
    //
    // Every module this slice adds or owns is named here instead — the command,
    // the renderer, and the whole of `deliver/` including slice 1's
    // `delivery-target.ts`, which the first version of this list forgot. It is
    // a check on these six files and says so; what they import is a separate
    // case, 'the observation modules reach no writer, by import'.
    const { readFileSync } = await import('node:fs');
    const reachable = [
      'src/cli/delivery-command.ts',
      'src/cli/render-delivery-observation.ts',
      'src/deliver/observe-delivery.ts',
      'src/deliver/forge-observation.ts',
      'src/deliver/github-observer.ts',
      'src/deliver/delivery-target.ts',
    ];
    for (const file of reachable) {
      const source = readFileSync(file, 'utf8');
      // Positive control: this really is the file it is named after, so an
      // absence below is evidence rather than an unread path.
      expect(source.length).toBeGreaterThan(200);
      for (const writer of [
        'saveTaskState',
        'advanceTaskState',
        'recordAgentInterruption',
        'acquireExecutionLease',
        'writeFileSync',
        'mkdirSync',
        'renameSync',
      ]) {
        expect(source).not.toContain(writer);
      }
    }

    // And the positive control for the *pattern*: the same search does find a
    // writer where one exists, so an empty result above is a fact about these
    // files and not about the search.
    expect(readFileSync('src/state/state-store.ts', 'utf8')).toContain('saveTaskState');
  });

  it('the observation modules import no writer, one level out', async () => {
    // Deliberately titled for what it does. It collects the specifiers the six
    // slice modules import and judges those; it does **not** follow them, so it
    // is a depth-one check and not a transitive graph proof. An earlier version
    // of this comment called it "the module graph it reaches", which it never
    // was. The transitive question is answered elsewhere and differently: the
    // execution-lease suite pins, across the whole of `src/`, which modules may
    // reach a runner and which may start a process at all.
    const { readFileSync } = await import('node:fs');
    const specifier = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+'([^']+)'/g;
    const seen = new Set<string>();
    for (const file of [
      'src/cli/delivery-command.ts',
      'src/cli/render-delivery-observation.ts',
      'src/deliver/observe-delivery.ts',
      'src/deliver/forge-observation.ts',
      'src/deliver/github-observer.ts',
      'src/deliver/delivery-target.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(specifier)) {
        const found = match[1];
        if (found !== undefined) seen.add(found);
      }
    }

    // Positive control: the scanner found something at all, and found the two
    // specifiers that must be there. An empty set would otherwise pass.
    expect(seen.size).toBeGreaterThan(5);
    expect(seen).toContain('../doctor/exec.js');
    expect(seen).toContain('../auth/env-guard.js');

    // Two modules in that class are reachable, and both are named here so that
    // a third cannot arrive quietly:
    //
    //  - `state-store.js`, and only for `loadTaskState`, which reads;
    //  - `core/task-state.js`, for the `TaskState` *type* alone. A type is
    //    erased and cannot write; it is admitted because the report prints the
    //    state a commit belongs to and that name has to come from somewhere.
    const ADMITTED = ['../core/task-state.js', '../state/state-store.js'];
    expect([...seen].filter((s) => /state|lease|worktree/.test(s)).sort()).toEqual(ADMITTED);
    for (const found of seen) {
      if (ADMITTED.includes(found)) continue;
      expect(found).not.toMatch(/state-store|execution-lease|worktree|commit-task-work|leased/);
    }
    // The type-only exception is type-only. If it ever stops being, this is red.
    expect(readFileSync('src/deliver/observe-delivery.ts', 'utf8')).toContain(
      "import type { TaskState } from '../core/task-state.js'",
    );
    // The exception is a reader and nothing more: the command names the read
    // and never the writer that lives in the same module.
    const command = readFileSync('src/cli/delivery-command.ts', 'utf8');
    expect(command).toContain('loadTaskState');
    expect(command).not.toContain('saveTaskState');
  });
});

// ── 15. Nothing widened ────────────────────────────────────────────────────

describe('the product contract is unchanged', () => {
  it('leaves READY_FOR_PR terminal', () => {
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
    expect([...TERMINAL_STATES]).toContain('READY_FOR_PR');
  });

  it('adds no forge mutation anywhere in the source', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk('src');

    // The first version of this matched only a literal adjacent pair such as
    // `'pr', 'merge'`. It was green, and it would have stayed green through the
    // most likely widening there is: flipping `'GET'` to `'POST'` in the fixed
    // prefix and adding a merge path built by a template. It also had no
    // positive control, so a broken pattern was indistinguishable from a clean
    // source tree. Both are fixed here.
    const forbidden = [
      // A writing method, however it is spelled.
      /['"]-X['"]\s*,\s*['"](POST|PUT|PATCH|DELETE)['"]/,
      /--method['"]?\s*[,=]?\s*['"](POST|PUT|PATCH|DELETE)['"]/,
      /['"]-X (POST|PUT|PATCH|DELETE)['"]/,
      // A writing subcommand of the client, adjacent or templated.
      /['"](pr|issue|api|repos)\/?['"]\s*,\s*['"](create|merge|edit|close|review|comment)['"]/,
      /['"]gh (pr|issue) (create|merge|edit|close|review|comment)/,
      // A path that can only be a mutation, however it is assembled.
      /\/(merge|merges)['"`]/,
      /pulls\/\$\{/,
      // The body channel: a read has none.
      /['"]--input['"]/,
    ];
    const offenders = files.filter((f) => {
      const source = readFileSync(f, 'utf8');
      return forbidden.some((pattern) => pattern.test(source));
    });
    expect(offenders).toEqual([]);

    // Positive control, and the reason the case above is evidence rather than a
    // broken regex: each pattern is shown to match the thing it is aimed at, on
    // text written here. It is a control on the SEARCH, not on production code —
    // the sweep looks for mutation text that was added, so no production deletion
    // can turn either half red, and saying otherwise would be the same over-claim
    // this case exists to remove.
    const mutants = [
      `runner('gh', ['api', '-X', 'POST', path])`,
      `runner('gh', ['api', '--method', 'PATCH', path])`,
      `const args = ['api', '-X DELETE', path]`,
      `runner('gh', ['pr', 'merge', String(n)])`,
      `exec('gh pr merge --squash')`,
      `const p = \`repos/\${o}/\${r}/pulls/\${n}/merge\``,
      `runner('gh', ['api', path, '--input', '-'])`,
    ];
    for (const mutant of mutants) {
      expect(forbidden.some((pattern) => pattern.test(mutant))).toBe(true);
    }

    expect([...FORGE_REQUEST_PREFIX]).toEqual(['api', '--hostname', 'github.com', '-X', 'GET']);
  });

  /**
   * The second egress pin.
   *
   * `tests/v2-10-operator-notification.test.ts` pins the modules that open a
   * socket *in process*. A subprocess is invisible to it, so that test would
   * have stayed green while this build acquired a second egress class. This is
   * the differently-shaped pin that keeps the property measured: exactly one
   * module may name the forge client, and it is this one.
   */
  it('names the forge client in exactly one module', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts')) files.push(full);
      }
    };
    walk('src');

    const declaresClient = /FORGE_CLIENT_COMMAND\s*=/;
    const owners = files
      .filter((f) => declaresClient.test(readFileSync(f, 'utf8')))
      .map((f) => relative('src', f).replace(/\\/g, '/'));
    expect(owners).toEqual(['deliver/github-observer.ts']);

    // False-negative guard: the pattern really does match the module it is
    // aimed at, so an empty result would be evidence rather than a broken regex.
    expect(declaresClient.test(readFileSync('src/deliver/github-observer.ts', 'utf8'))).toBe(true);
  });
});
