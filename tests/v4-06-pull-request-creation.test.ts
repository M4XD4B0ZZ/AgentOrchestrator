/**
 * V4 slice 6 — creating one pull request.
 *
 * The second slice that can change something outside this machine, and the
 * first that can ask a repository's humans to take work. The suite is organised
 * around the mutation rather than around the arithmetic, because a test that
 * feeds a happy path in and reads a happy word out proves none of what matters.
 * Five properties carry the slice:
 *
 *  1. **nothing mutates without the authority** — and the authority is a type,
 *     not a boolean. The counter-proofs are a perfectly shaped forgery driven
 *     through the real argument, a second use of a real one, and the two
 *     delivery authorities offered to each other's functions, which is a
 *     *compile* error and is asserted as one;
 *  2. **at most one request, ever** — the mutation runner is counted, on every
 *     path, including every path that ends uncertain. A build that retried
 *     would be caught by the count and not by an assertion about text;
 *  3. **success is established by looking** — the response body is never read,
 *     and a transport that reports success with nothing findable afterwards
 *     produces `OUTCOME_UNCERTAIN` rather than `CREATED`;
 *  4. **the intended pull request is identified by the exact commit** — not by
 *     the branch name, which moves, and not by the pull request's number, which
 *     this build does not know before it looks;
 *  5. **the vector cannot become something else** — the argument list is pinned
 *     by exact equality, the body reaches the child only on stdin, and no
 *     spelling of a push, a merge or an update appears anywhere on the surface.
 *
 * Nothing here touches a network. Every forge answer comes from an injected
 * runner, for the reason slices 2 to 5 give: the canonical gate has to be
 * deterministic on a machine that has never run `gh auth login`, and CI has no
 * credentials at all. The behaviours the injected runners imitate were measured
 * against github.com before this slice was written, and the measurements are
 * recorded in `docs/decisions/2026-08-24-adr-pull-request-creation.md`.
 */

import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CREATE_PR_OPTION_DESCRIPTION,
  ATTENDED_OPTION_DESCRIPTION,
  DELIVERY_COMMAND_DESCRIPTION,
  registerDeliveryCommand,
} from '../src/cli/delivery-command.js';
import {
  CREATION_TRAILER,
  CONTACTED_TRAILER,
  OBSERVED_AND_CHANGED_TRAILER,
  PUBLICATION_TRAILER,
  renderDeliveryObservation,
} from '../src/cli/render-delivery-observation.js';
import { EXIT_RUN_OK } from '../src/cli/run-exit-codes.js';
import { TERMINAL_STATES, isTerminalState } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import { createObservationSubject, parsePullCandidates, type ObservationSubject, type PullCandidate } from '../src/deliver/forge-observation.js';
import {
  ESTABLISHED_PULL_REQUEST_CREATIONS,
  PULL_REQUEST_ATTEMPTS,
  PULL_REQUEST_CREATIONS,
  PULL_REQUEST_CREATION_DETAIL,
  PULL_REQUEST_SITUATIONS,
  gradePullRequestCreation,
  pullRequestIsEstablished,
  type PullRequestAttempt,
  type PullRequestCreation,
  type PullRequestSituation,
} from '../src/deliver/pull-request-creation.js';
import {
  SITUATION_UNKNOWN,
  classifyPullRequestSituation,
} from '../src/deliver/pull-request-situation.js';
import {
  AO_PULL_REQUEST_DRAFT,
  MAX_BODY_BYTES,
  MAX_TITLE_BYTES,
  PULL_REQUEST_PROVENANCE,
  boundedTitle,
  branchOf,
  byteLength,
  composePullRequestContent,
} from '../src/deliver/pull-request-content.js';
import {
  FORGE_CREATE_BODY_SOURCE,
  FORGE_CREATE_PREFIX,
  createPullRequestArgs,
  createPullRequestVia,
  pullRequestCreateBody,
  pullRequestsPath,
  qualifiedHead,
  type ForgeMutationRunner,
} from '../src/deliver/github-pull-request-creator.js';
import {
  claimPullRequestCreation,
  isPullRequestCreationGrant,
  type PullRequestCreationGrant,
} from '../src/deliver/pull-request-creation-grant.js';
import {
  DELIVERY_BASE_REF,
  mintPullRequestCreationGrant,
  type PullRequestCreationSubject,
  type PullRequestIntent,
} from '../src/deliver/internal/pull-request-creation-grant.js';
import { createPullRequest, type CreationSeams } from '../src/deliver/create-pull-request.js';
import { mintHeadPublicationGrant } from '../src/deliver/internal/head-publication-grant.js';
import { publishDeliveryHead } from '../src/deliver/publish-delivery-head.js';
import { isShellInertArgument } from '../src/doctor/exec.js';
import type { CommandResult } from '../src/doctor/exec.js';
import type { GitPublicationRunner } from '../src/deliver/git-head-publisher.js';
import type { ForgeCommandRunner } from '../src/deliver/github-observer.js';
import type { ResolvedDelivery } from '../src/deliver/delivery-target.js';
import type { StateLoadResult } from '../src/state/state-store.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const HEAD = '10583ee91a5747d0049f563ffaac64b0cf643aeb';
const OTHER = 'c89ef605400a15e5d3db4d256c184773c0d533f6';
const REV = 'a'.repeat(64);
const TASK = 'T-001';
const BRANCH = 'ao/T-001';
const REF = `refs/heads/${BRANCH}`;
const BASE = 'main';
const REMOTE = 'origin';
const URL = 'https://github.com/M4XD4B0ZZ/AgentOrchestrator.git';

const IDENTITY = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});

function subjectOf(commit = HEAD, identity = IDENTITY): ObservationSubject {
  const built = createObservationSubject(identity, commit);
  if (!built.ok) throw new Error(`fixture subject refused: ${built.refusal}`);
  return built.subject;
}

function intentOf(over: Partial<PullRequestIntent> = {}): PullRequestIntent {
  const content = composePullRequestContent({
    taskId: TASK,
    headRef: REF,
    headCommit: HEAD,
    baseRef: BASE,
  });
  return {
    taskId: TASK,
    remoteName: REMOTE,
    headRef: REF,
    baseRef: BASE,
    draft: AO_PULL_REQUEST_DRAFT,
    title: content.title,
    body: content.body,
    ...over,
  };
}

/** A real, minted grant — never a hand-built object. */
function grantOf(
  over: Partial<PullRequestIntent> = {},
  target = subjectOf(),
): PullRequestCreationGrant {
  const grant = mintPullRequestCreationGrant(target, intentOf(over));
  if (grant === null) throw new Error('fixture grant was refused by the mint');
  return grant;
}

function subjectFacts(over: Partial<PullRequestCreationSubject> = {}): PullRequestCreationSubject {
  const intent = intentOf();
  return Object.freeze({
    taskId: intent.taskId,
    host: IDENTITY.host,
    owner: IDENTITY.owner,
    name: IDENTITY.name,
    remoteName: intent.remoteName,
    headRef: intent.headRef,
    headCommit: HEAD,
    baseRef: intent.baseRef,
    draft: intent.draft,
    title: intent.title,
    body: intent.body,
    ...over,
  });
}

function commandResult(over: Partial<CommandResult> = {}): CommandResult {
  return {
    display: 'x',
    executable: 'x',
    args: [],
    started: true,
    outcome: 'COMPLETED',
    exitCode: 0,
    failureCode: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    durationMs: 1,
    timedOut: false,
    treeKilled: false,
    stdinDelivery: 'DELIVERED',
    ...over,
  } as CommandResult;
}

/** The body the locator endpoint answers with, in GitHub's shape. */
function pullsBody(
  entries: readonly { number: number; state: string; sha: string; base?: string; draft?: boolean }[],
): string {
  return JSON.stringify(
    entries.map((e) => ({
      number: e.number,
      state: e.state,
      head: { sha: e.sha },
      base: { ref: e.base ?? BASE },
      draft: e.draft ?? false,
    })),
  );
}

interface ForgeReads {
  readonly runner: ForgeCommandRunner;
  readonly calls: string[][];
}

/**
 * A reading seam that answers the locator with a different page each time.
 *
 * The pages are consumed in order, so a test can say "before there was nothing,
 * afterwards there is one" without the two readings being the same object —
 * which is the whole point of taking two.
 */
function forgeReads(pages: readonly (string | null)[]): ForgeReads {
  const calls: string[][] = [];
  let index = 0;
  const runner: ForgeCommandRunner = async (_command, args) => {
    calls.push([...args]);
    const page = pages[Math.min(index, pages.length - 1)] ?? null;
    index += 1;
    if (page === null) return commandResult({ exitCode: 1, stdout: '{"message":"Not Found"}' });
    return commandResult({ stdout: page });
  };
  return { runner, calls };
}

interface Mutations {
  readonly runner: ForgeMutationRunner;
  readonly calls: { args: string[]; stdin: string }[];
}

function mutations(over: Partial<CommandResult> = {}): Mutations {
  const calls: { args: string[]; stdin: string }[] = [];
  const runner: ForgeMutationRunner = async (_command, args, options) => {
    calls.push({ args: [...args], stdin: options.stdin });
    return commandResult(over);
  };
  return { runner, calls };
}

/** A Git seam that agrees on URLs and answers one ref reading. */
function gitReads(
  ref: { present: boolean; commit?: string; unknown?: boolean } = { present: true, commit: HEAD },
): GitPublicationRunner {
  return async (args) => {
    const joined = args.join(' ');
    if (joined.startsWith('remote get-url')) return commandResult({ stdout: `${URL}\n` });
    if (args[0] === 'ls-remote') {
      if (ref.unknown === true) return commandResult({ outcome: 'TIMED_OUT', exitCode: null });
      if (!ref.present) return commandResult({ exitCode: 2 });
      return commandResult({ stdout: `${ref.commit ?? HEAD}\t${REF}\n` });
    }
    throw new Error(`unexpected git vector: ${joined}`);
  };
}

function seamsOf(over: Partial<CreationSeams> = {}): CreationSeams {
  return {
    recheck: async () => subjectFacts(),
    gitRunner: gitReads(),
    reader: forgeReads([pullsBody([])]).runner,
    mutator: mutations().runner,
    envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
    ...over,
  };
}

const ROOT = 'D:\\repo';

function situation(
  outcome: PullRequestSituation['outcome'],
  open: PullRequestSituation['open'] = null,
  numbers: readonly number[] = [],
): PullRequestSituation {
  return Object.freeze({ outcome, open, numbers });
}

const INTENDED = Object.freeze({ baseRef: BASE, draft: AO_PULL_REQUEST_DRAFT });

// ── 1. The vocabulary is closed, total and partitioned ─────────────────────

describe('the creation vocabulary', () => {
  it('is a set, and every member carries exactly one sentence', () => {
    expect(new Set(PULL_REQUEST_CREATIONS).size).toBe(PULL_REQUEST_CREATIONS.length);
    // Derived both ways: a member with no sentence fails, and a sentence for a
    // member that no longer exists fails too.
    expect(Object.keys(PULL_REQUEST_CREATION_DETAIL).sort()).toEqual(
      [...PULL_REQUEST_CREATIONS].sort(),
    );
    for (const member of PULL_REQUEST_CREATIONS) {
      expect(PULL_REQUEST_CREATION_DETAIL[member].length, member).toBeGreaterThan(40);
    }
  });

  it('partitions itself into established and not, with nothing left over', () => {
    const established = PULL_REQUEST_CREATIONS.filter((m) => ESTABLISHED_PULL_REQUEST_CREATIONS.has(m));
    const not = PULL_REQUEST_CREATIONS.filter((m) => !ESTABLISHED_PULL_REQUEST_CREATIONS.has(m));
    expect([...established].sort()).toEqual(
      ['ALREADY_EXISTS', 'CONVERGED_AFTER_UNCERTAIN_EFFECT', 'CREATED'].sort(),
    );
    expect(established.length + not.length).toBe(PULL_REQUEST_CREATIONS.length);
    // And the predicate agrees with the set for every member, so a caller can
    // never be right by asking one and wrong by asking the other.
    for (const member of PULL_REQUEST_CREATIONS) {
      expect(pullRequestIsEstablished(member), member).toBe(
        ESTABLISHED_PULL_REQUEST_CREATIONS.has(member),
      );
    }
  });

  it('says exactly this, for the members an operator acts on', () => {
    // Pinned by literal, not by reading the map: a completeness check proves a
    // key exists, only a literal proves the sentence somebody reads.
    expect(PULL_REQUEST_CREATION_DETAIL.CREATED).toBe(
      'No pull request had this head, one request was made, and exactly one open pull request now has this head, this base and this draft state.',
    );
    expect(PULL_REQUEST_CREATION_DETAIL.ALREADY_EXISTS).toBe(
      'Exactly one open pull request already had this head, this base and this draft state. Nothing was sent, because the intended state was already true.',
    );
    expect(PULL_REQUEST_CREATION_DETAIL.HEAD_NOT_PUBLISHED).toBe(
      'The head ref does not exist on the delivery remote, so there is no branch to open a pull request from. Publish it first with --publish-head; this command does not push, and nothing was attempted.',
    );
    expect(PULL_REQUEST_CREATION_DETAIL.OUTCOME_UNCERTAIN).toBe(
      'Whether the forge created a pull request could not be established. Do not ask again to find out — ask again, and the answer will be read from the forge before anything is attempted.',
    );
  });

  it('names three attempts and five situations, and no more', () => {
    expect([...PULL_REQUEST_ATTEMPTS]).toEqual(['NOT_ATTEMPTED', 'COMPLETED', 'FAILED']);
    expect([...PULL_REQUEST_SITUATIONS]).toEqual([
      'NONE',
      'OPEN_ONE',
      'OPEN_MANY',
      'CLOSED_ONLY',
      'UNKNOWN',
    ]);
  });
});

// ── 2. The grade comes from the readings ───────────────────────────────────

describe('grading a creation', () => {
  const open = (over: Partial<{ number: number; baseRef: string; draft: boolean }> = {}) =>
    situation('OPEN_ONE', { number: 7, baseRef: BASE, draft: false, ...over }, [7]);

  const table: readonly [string, PullRequestSituation, PullRequestAttempt, PullRequestSituation | null, PullRequestCreation][] = [
    ['an unreadable pre-reading', SITUATION_UNKNOWN, 'NOT_ATTEMPTED', null, 'PULL_REQUEST_STATE_UNKNOWN'],
    ['two open at this head', situation('OPEN_MANY', null, [7, 8]), 'NOT_ATTEMPTED', null, 'PULL_REQUEST_AMBIGUOUS'],
    ['only a closed one', situation('CLOSED_ONLY', null, [7]), 'NOT_ATTEMPTED', null, 'PRIOR_PULL_REQUEST_CLOSED'],
    ['the intended one already open', open(), 'NOT_ATTEMPTED', null, 'ALREADY_EXISTS'],
    ['one open at another base', open({ baseRef: 'release' }), 'NOT_ATTEMPTED', null, 'WRONG_BASE_CONFLICT'],
    ['one open in the wrong draft state', open({ draft: true }), 'NOT_ATTEMPTED', null, 'DRAFT_STATE_CONFLICT'],
    ['an OPEN_ONE carrying nothing', situation('OPEN_ONE', null, [7]), 'NOT_ATTEMPTED', null, 'PULL_REQUEST_STATE_UNKNOWN'],
    ['nothing, and nothing attempted', situation('NONE'), 'NOT_ATTEMPTED', null, 'CREATION_REFUSED'],
    ['a completed attempt with no post-reading', situation('NONE'), 'COMPLETED', null, 'OUTCOME_UNCERTAIN'],
    ['a completed attempt and an unreadable after', situation('NONE'), 'COMPLETED', SITUATION_UNKNOWN, 'OUTCOME_UNCERTAIN'],
    ['a completed attempt and nothing after', situation('NONE'), 'COMPLETED', situation('NONE'), 'OUTCOME_UNCERTAIN'],
    ['a failed attempt and nothing after', situation('NONE'), 'FAILED', situation('NONE'), 'CREATION_REFUSED'],
    ['a failed attempt and the intended one after', situation('NONE'), 'FAILED', open(), 'CONVERGED_AFTER_UNCERTAIN_EFFECT'],
    ['a completed attempt and the intended one after', situation('NONE'), 'COMPLETED', open(), 'CREATED'],
    ['a completed attempt and the wrong base after', situation('NONE'), 'COMPLETED', open({ baseRef: 'release' }), 'POSTCONDITION_MISMATCH'],
    ['a completed attempt and the wrong draft after', situation('NONE'), 'COMPLETED', open({ draft: true }), 'POSTCONDITION_MISMATCH'],
    ['a completed attempt and a closed one after', situation('NONE'), 'COMPLETED', situation('CLOSED_ONLY', null, [7]), 'POSTCONDITION_MISMATCH'],
    ['a completed attempt and two after', situation('NONE'), 'COMPLETED', situation('OPEN_MANY', null, [7, 8]), 'PULL_REQUEST_AMBIGUOUS'],
    ['a completed attempt and an empty OPEN_ONE after', situation('NONE'), 'COMPLETED', situation('OPEN_ONE', null, [7]), 'OUTCOME_UNCERTAIN'],
  ];

  it.each(table)('%s grades as the named member', (_name, before, attempt, after, expected) => {
    expect(gradePullRequestCreation(INTENDED, before, attempt, after)).toBe(expected);
  });

  it('never claims CREATED from the attempt alone', () => {
    // The load-bearing asymmetry: a transport that says it succeeded and a
    // forge with nothing on it is not a creation. Exit 0 is evidence about a
    // process, and the pull request is a fact about GitHub.
    for (const after of [null, SITUATION_UNKNOWN, situation('NONE')]) {
      expect(gradePullRequestCreation(INTENDED, situation('NONE'), 'COMPLETED', after)).not.toBe(
        'CREATED',
      );
    }
  });

  it('compares the base by exact equality, with no normalisation', () => {
    for (const base of ['Main', 'refs/heads/main', 'main ', ' main']) {
      expect(
        gradePullRequestCreation(
          INTENDED,
          situation('OPEN_ONE', { number: 7, baseRef: base, draft: false }, [7]),
          'NOT_ATTEMPTED',
          null,
        ),
        base,
      ).toBe('WRONG_BASE_CONFLICT');
    }
  });

  it('is total over every combination the orchestration can produce', () => {
    const situations: PullRequestSituation[] = [
      situation('NONE'),
      open(),
      situation('OPEN_MANY', null, [1, 2]),
      situation('CLOSED_ONLY', null, [1]),
      SITUATION_UNKNOWN,
    ];
    for (const before of situations) {
      for (const attempt of PULL_REQUEST_ATTEMPTS) {
        for (const after of [...situations, null]) {
          const graded = gradePullRequestCreation(INTENDED, before, attempt, after);
          expect(PULL_REQUEST_CREATIONS, `${before.outcome}/${attempt}`).toContain(graded);
        }
      }
    }
  });
});

// ── 3. The situation is classified from candidates ─────────────────────────

describe('classifying what the forge answered', () => {
  const candidate = (over: Partial<PullCandidate> = {}): PullCandidate =>
    Object.freeze({ number: 7, state: 'open', headSha: HEAD, baseRef: BASE, draft: false, ...over });

  it('finds nothing when nothing carries this exact commit', () => {
    expect(classifyPullRequestSituation([candidate({ headSha: OTHER })], HEAD)).toEqual(
      situation('NONE'),
    );
    expect(classifyPullRequestSituation([], HEAD)).toEqual(situation('NONE'));
  });

  it('does not match an abbreviation of the commit', () => {
    expect(classifyPullRequestSituation([candidate({ headSha: HEAD.slice(0, 7) })], HEAD)).toEqual(
      situation('NONE'),
    );
  });

  it('reports the one open pull request with its base and draft state', () => {
    expect(classifyPullRequestSituation([candidate()], HEAD)).toEqual(
      situation('OPEN_ONE', { number: 7, baseRef: BASE, draft: false }, [7]),
    );
  });

  it('separates a closed one at this head from an absence', () => {
    expect(classifyPullRequestSituation([candidate({ state: 'closed' })], HEAD)).toEqual(
      situation('CLOSED_ONLY', null, [7]),
    );
  });

  it('prefers the open one when both exist at this head', () => {
    const both = [candidate({ number: 3, state: 'closed' }), candidate({ number: 4 })];
    expect(classifyPullRequestSituation(both, HEAD)).toEqual(
      situation('OPEN_ONE', { number: 4, baseRef: BASE, draft: false }, [4]),
    );
  });

  it('refuses to choose between two open ones', () => {
    const two = [candidate({ number: 9 }), candidate({ number: 4 })];
    expect(classifyPullRequestSituation(two, HEAD)).toEqual(situation('OPEN_MANY', null, [4, 9]));
  });

  it('fails closed when the forge did not report the base or the draft state', () => {
    // Both are nullable in the parse — question 1 does not need them — so the
    // consumer that does is where absence has to be refused. `UNKNOWN`, not
    // `NONE`: "I cannot judge the one that is there" is not "there is none".
    expect(classifyPullRequestSituation([candidate({ baseRef: null })], HEAD)).toEqual(
      SITUATION_UNKNOWN,
    );
    expect(classifyPullRequestSituation([candidate({ draft: null })], HEAD)).toEqual(
      SITUATION_UNKNOWN,
    );
  });

  it('reads a real GitHub page through the shared parse', () => {
    const parsed = parsePullCandidates(JSON.parse(pullsBody([{ number: 7, state: 'open', sha: HEAD }])), 100);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(classifyPullRequestSituation(parsed.candidates, HEAD)).toEqual(
      situation('OPEN_ONE', { number: 7, baseRef: BASE, draft: false }, [7]),
    );
  });
});

// ── 4. The authority ───────────────────────────────────────────────────────

describe('the pull-request creation authority', () => {
  it('mints from a whole intent and recognises only what it minted', () => {
    const grant = grantOf();
    expect(isPullRequestCreationGrant(grant)).toBe(true);
    // A perfectly shaped forgery, driven through the real argument.
    const forged = { ...subjectFacts() } as unknown as PullRequestCreationGrant;
    expect(isPullRequestCreationGrant(forged)).toBe(false);
    expect(claimPullRequestCreation(forged)).toBeNull();
  });

  it('cannot be reached through the prototype', () => {
    const grant = grantOf();
    const prototype = Object.getPrototypeOf(grant) as Record<string, unknown>;
    // The own property is gone. `prototype.constructor` still resolves — up the
    // chain, to `Object` — which is exactly why the assertion is about the
    // descriptor: the route that produced a working forgery against an earlier
    // artefact here was `Object.getPrototypeOf(v).constructor`, and it now
    // reaches something that cannot build one of these.
    expect(Object.getOwnPropertyDescriptor(prototype, 'constructor')).toBeUndefined();
    expect(prototype['constructor']).toBe(Object);
    expect(Object.isFrozen(prototype)).toBe(true);
    // `Object.create` borrows the prototype and produces something that passes
    // `instanceof`. It is still not a grant, because membership is a registry.
    const borrowed = Object.create(prototype) as PullRequestCreationGrant;
    expect(isPullRequestCreationGrant(borrowed)).toBe(false);
    expect(claimPullRequestCreation(borrowed)).toBeNull();
  });

  it('is spent by the only accessor that reads it', () => {
    const grant = grantOf();
    const first = claimPullRequestCreation(grant);
    expect(first?.taskId).toBe(TASK);
    expect(first?.headCommit).toBe(HEAD);
    expect(claimPullRequestCreation(grant)).toBeNull();
    // And the guard still says it was minted — spending is not un-minting, and
    // the two questions are deliberately different.
    expect(isPullRequestCreationGrant(grant)).toBe(true);
  });

  it('binds every fact the request and its preconditions rest on', () => {
    const claimed = claimPullRequestCreation(grantOf());
    expect(claimed).toEqual({
      taskId: TASK,
      host: IDENTITY.host,
      owner: IDENTITY.owner,
      name: IDENTITY.name,
      remoteName: REMOTE,
      headRef: REF,
      headCommit: HEAD,
      baseRef: BASE,
      draft: false,
      title: `${TASK}: ${BRANCH}`,
      body: expect.stringContaining(HEAD) as unknown as string,
    });
    expect(Object.isFrozen(claimed)).toBe(true);
  });

  it.each([
    ['a task id outside the grammar', { taskId: 'not a task id' }],
    ['an empty task id', { taskId: '' }],
    ['a remote name that could be a flag', { remoteName: '--upload-pack=x' }],
    ['a partial head ref', { headRef: BRANCH }],
    ['a head ref with a space', { headRef: 'refs/heads/a b' }],
    ['a base that could be a flag', { baseRef: '-x' }],
    ['a base with a space', { baseRef: 'ma in' }],
    ['an empty base', { baseRef: '' }],
    ['a head that is the base', { headRef: `refs/heads/${BASE}` }],
    ['an empty title', { title: '' }],
    ['an empty body', { body: '' }],
    ['a title over budget', { title: 'x'.repeat(MAX_TITLE_BYTES + 1) }],
    ['a body over budget', { body: 'y'.repeat(MAX_BODY_BYTES + 1) }],
  ])('refuses %s', (_name, over) => {
    expect(mintPullRequestCreationGrant(subjectOf(), intentOf(over as Partial<PullRequestIntent>))).toBeNull();
  });

  it('counts the text budget in bytes, not in characters', () => {
    // A character budget would let a multi-byte title through at more than the
    // stated size, and the transport writes bytes.
    const wide = '\u00e9'.repeat(MAX_TITLE_BYTES);
    expect(wide.length).toBe(MAX_TITLE_BYTES);
    expect(byteLength(wide)).toBe(MAX_TITLE_BYTES * 2);
    expect(mintPullRequestCreationGrant(subjectOf(), intentOf({ title: wide }))).toBeNull();
  });

  it('refuses an unsupported host even when the subject type says otherwise', () => {
    // The subject type is structural, and a review has hand-cast straight past
    // it before. The host is re-tested at the mint against the frozen list.
    const elsewhere = { ...subjectOf(), host: 'gitlab.com' } as ObservationSubject;
    expect(mintPullRequestCreationGrant(elsewhere, intentOf())).toBeNull();
  });

  it.each([
    ['a commit that is a branch name', 'main'],
    ['an abbreviated commit', HEAD.slice(0, 7)],
    ['an upper-case commit', HEAD.toUpperCase()],
  ])('refuses %s as the head commit', (_name, commit) => {
    const target = { ...subjectOf(), commit } as ObservationSubject;
    expect(mintPullRequestCreationGrant(target, intentOf())).toBeNull();
  });

  it('accepts a base branch grammar that a real repository can carry', () => {
    for (const base of ['main', 'release/2.0', 'v1.2.3', 'a_b-c.d']) {
      expect(DELIVERY_BASE_REF.test(base), base).toBe(true);
      expect(mintPullRequestCreationGrant(subjectOf(), intentOf({ baseRef: base }))).not.toBeNull();
    }
  });
});

// ── 5. The two delivery authorities cannot substitute ──────────────────────

describe('publication authority and creation authority are different types', () => {
  it('is a compile error in both directions, and a refusal at runtime', async () => {
    const creation = grantOf();
    const publication = mintHeadPublicationGrant(subjectOf(), REMOTE, REF);
    expect(publication).not.toBeNull();
    if (publication === null) return;

    // @ts-expect-error a pull-request authority is not a publication authority
    const wrongWayRound = publishDeliveryHead(creation, ROOT, {
      recheck: async () => null,
      runner: gitReads(),
    });
    // @ts-expect-error a publication authority is not a pull-request authority
    const otherWayRound = createPullRequest(publication, ROOT, seamsOf());

    // Belt and braces: the compile error is the guarantee, and the runtime
    // registries refuse anyway, because each mint has its own.
    expect((await wrongWayRound).publication).toBe('AUTHORITY_REFUSED');
    expect((await otherWayRound).creation).toBe('AUTHORITY_REFUSED');
  });

  it('exports no merge authority and no widening conversion', async () => {
    const publicFacade = await import('../src/deliver/pull-request-creation-grant.js');
    expect(Object.keys(publicFacade).sort()).toEqual(
      ['claimPullRequestCreation', 'isPullRequestCreationGrant'].sort(),
    );
    // The mint is not on the public facade — the only way to one is the ladder.
    expect(Object.keys(publicFacade)).not.toContain('mintPullRequestCreationGrant');
    expect(Object.keys(publicFacade)).not.toContain('PullRequestCreationGrant');
  });
});

// ── 6. The content ─────────────────────────────────────────────────────────

describe('what AO writes into the pull request', () => {
  it('is deterministic and composed from four identifiers', () => {
    const once = composePullRequestContent({ taskId: TASK, headRef: REF, headCommit: HEAD, baseRef: BASE });
    const twice = composePullRequestContent({ taskId: TASK, headRef: REF, headCommit: HEAD, baseRef: BASE });
    expect(once).toEqual(twice);
    expect(once.title).toBe(`${TASK}: ${BRANCH}`);
    expect(once.body).toContain(`Task        : ${TASK}`);
    expect(once.body).toContain(`Head ref    : ${REF}`);
    expect(once.body).toContain(`Head commit : ${HEAD}`);
    expect(once.body).toContain(`Base ref    : ${BASE}`);
    expect(once.body).toContain(PULL_REQUEST_PROVENANCE);
  });

  it('says who opened it and what that does not mean', () => {
    expect(PULL_REQUEST_PROVENANCE).toBe(
      'Opened by AgentOrchestrator. AO created this pull request and will not update, close, ' +
        'reopen, review, comment on, label or merge it. Its existence establishes nothing about ' +
        'the work: no review, no verification result and no merge authority.',
    );
  });

  it('carries nothing but the four values, and no local detail', () => {
    const { body, title } = composePullRequestContent({
      taskId: TASK,
      headRef: REF,
      headCommit: HEAD,
      baseRef: BASE,
    });
    for (const forbidden of ['D:\\', '/home/', 'diff --git', 'node_modules', 'PATH=', 'http']) {
      expect(body, forbidden).not.toContain(forbidden);
      expect(title, forbidden).not.toContain(forbidden);
    }
    // ASCII by construction: no input the mint accepts can carry anything else.
    expect(/^[\x20-\x7e\n]*$/.test(body)).toBe(true);
  });

  it('fits both budgets for every input the mint accepts', () => {
    // The two parts are bounded on their own and their sum is not, so a long
    // task id beside a long branch composes an over-budget title. It is cut
    // rather than refused: refusing to open a pull request because a branch
    // name is long would be a bad failure nobody could act on, and the full ref
    // is in the body either way.
    const longestTask = 'T'.repeat(64);
    const longestBranch = 'b'.repeat(200);
    const content = composePullRequestContent({
      taskId: longestTask,
      headRef: `refs/heads/${longestBranch}`,
      headCommit: REV,
      baseRef: 'r'.repeat(100),
    });
    expect(byteLength(content.title)).toBe(MAX_TITLE_BYTES);
    expect(content.title.endsWith('...')).toBe(true);
    expect(byteLength(content.body)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    // And the grant it composes is minted, not refused.
    expect(
      mintPullRequestCreationGrant(
        subjectOf(),
        intentOf({
          taskId: longestTask,
          headRef: `refs/heads/${longestBranch}`,
          baseRef: 'r'.repeat(100),
          title: content.title,
          body: content.body,
        }),
      ),
    ).not.toBeNull();

    // A short pair is left exactly as it is.
    const short = composePullRequestContent({
      taskId: TASK,
      headRef: REF,
      headCommit: HEAD,
      baseRef: BASE,
    });
    expect(short.title).toBe(`${TASK}: ${BRANCH}`);
    expect(boundedTitle(short.title)).toBe(short.title);
  });

  it('takes the branch out of the ref without guessing', () => {
    expect(branchOf(REF)).toBe(BRANCH);
    expect(branchOf('refs/heads/a/b/c')).toBe('a/b/c');
    expect(branchOf('main')).toBe('main');
  });

  it('creates non-draft, which is what this repository has always done', () => {
    expect(AO_PULL_REQUEST_DRAFT).toBe(false);
  });
});

// ── 7. The transport ───────────────────────────────────────────────────────

describe('the one request vector', () => {
  it('is exactly this, token for token', () => {
    expect([...FORGE_CREATE_PREFIX]).toEqual(['api', '--hostname', 'github.com', '-X', 'POST']);
    expect([...FORGE_CREATE_BODY_SOURCE]).toEqual(['--input', '-']);
    expect([...createPullRequestArgs(IDENTITY.owner, IDENTITY.name)]).toEqual([
      'api',
      '--hostname',
      'github.com',
      '-X',
      'POST',
      'repos/M4XD4B0ZZ/AgentOrchestrator/pulls',
      '--input',
      '-',
    ]);
  });

  it('states the method, because --input alone would choose POST for it', () => {
    // Measured in the client's own source: with a body supplied and no -X, the
    // method becomes POST on its own. The token must never be a consequence of
    // which other flags happen to be present.
    const args = createPullRequestArgs(IDENTITY.owner, IDENTITY.name);
    expect(args[args.indexOf('-X') + 1]).toBe('POST');
    expect(args).not.toContain('PATCH');
    expect(args).not.toContain('PUT');
    expect(args).not.toContain('DELETE');
  });

  it('names one collection endpoint and nothing under it', () => {
    expect(pullRequestsPath(IDENTITY.owner, IDENTITY.name)).toBe(
      'repos/M4XD4B0ZZ/AgentOrchestrator/pulls',
    );
    expect(pullRequestsPath(IDENTITY.owner, IDENTITY.name)).not.toMatch(/\/(merge|reviews|comments)$/);
  });

  it('puts every token past the shell-inert grammar', () => {
    for (const token of createPullRequestArgs(IDENTITY.owner, IDENTITY.name)) {
      expect(isShellInertArgument(token), token).toBe(true);
    }
  });

  it('sends the body on stdin, never in the vector', async () => {
    const m = mutations();
    await createPullRequestVia(subjectFacts(), { runner: m.runner, envSource: { PATH: '/x' } });
    expect(m.calls).toHaveLength(1);
    const call = m.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) return;
    const body = JSON.parse(call.stdin) as Record<string, unknown>;
    expect(body).toEqual({
      title: `${TASK}: ${BRANCH}`,
      head: `${IDENTITY.owner}:${BRANCH}`,
      base: BASE,
      body: expect.stringContaining(HEAD) as unknown as string,
      draft: false,
    });
    // Nothing of the body is anywhere in the argument list.
    expect(call.args.join(' ')).not.toContain(TASK);
    expect(call.args.join(' ')).not.toContain(BRANCH);
  });

  it('qualifies the head with the owner, and never sends the commit', () => {
    expect(qualifiedHead(subjectFacts())).toBe(`${IDENTITY.owner}:${BRANCH}`);
    const body = JSON.parse(pullRequestCreateBody(subjectFacts())) as Record<string, unknown>;
    // Measured: GitHub answers 422 {"field":"head","code":"invalid"} for an
    // object name in this field, even one that exists. The commit is checked,
    // never sent, so it must not appear as head or base.
    expect(body['head']).not.toBe(HEAD);
    expect(body['base']).not.toBe(HEAD);
  });

  it('sets exactly five fields, and no field this build did not decide', () => {
    const body = JSON.parse(pullRequestCreateBody(subjectFacts())) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['base', 'body', 'draft', 'head', 'title'].sort());
    expect(body).not.toHaveProperty('maintainer_can_modify');
    expect(body).not.toHaveProperty('issue');
    expect(body).not.toHaveProperty('head_repo');
  });

  it('states draft explicitly, because the API declares no default', () => {
    for (const draft of [true, false]) {
      const body = JSON.parse(pullRequestCreateBody(subjectFacts({ draft }))) as Record<string, unknown>;
      expect(body['draft']).toBe(draft);
    }
  });

  it.each([
    ['a non-zero exit', { exitCode: 1 }],
    ['a timeout', { outcome: 'TIMED_OUT' as const, exitCode: null }],
    ['a lost boundary', { outcome: 'BOUNDARY_LOST' as const, exitCode: null }],
    ['an output overrun', { outcome: 'OUTPUT_LIMIT_EXCEEDED' as const, exitCode: null }],
    ['a body only partly delivered', { stdinDelivery: 'FAILED' as const }],
    ['a body whose delivery was never confirmed', { stdinDelivery: 'UNCONFIRMED' as const }],
  ])('grades %s as a failed attempt, never as a completed one', async (_name, over) => {
    const m = mutations(over);
    const attempt = await createPullRequestVia(subjectFacts(), {
      runner: m.runner,
      envSource: { PATH: '/x' },
    });
    expect(attempt).toBe('FAILED');
    // And it still asked exactly once. `FAILED` is not permission to retry.
    expect(m.calls).toHaveLength(1);
  });

  it('does not start a client for an unsupported host', async () => {
    const m = mutations();
    const attempt = await createPullRequestVia(subjectFacts({ host: 'gitlab.com' }), {
      runner: m.runner,
      envSource: { PATH: '/x' },
    });
    // `NOT_ATTEMPTED` is the only word that carries "nothing happened", and it
    // is reserved for the points before a process exists.
    expect(attempt).toBe('NOT_ATTEMPTED');
    expect(m.calls).toHaveLength(0);
  });

  it('does not start a client when the environment policy cannot be applied', async () => {
    const m = mutations();
    const attempt = await createPullRequestVia(subjectFacts(), {
      runner: m.runner,
      // Two spellings of one allow-listed name: `createProbeEnv` throws.
      envSource: { PATH: '/x', Path: '/y' },
    });
    expect(attempt).toBe('NOT_ATTEMPTED');
    expect(m.calls).toHaveLength(0);
  });

  it('never reads the response body', async () => {
    // A 201 carrying a pull request is graded the same as a 201 carrying
    // nothing this build understands: the attempt completed, and the forge
    // reading afterwards is what decides. Anything else would make the
    // response the authority.
    for (const stdout of ['', '{"number":7}', 'not json at all', '{"number":"not a number"}']) {
      const m = mutations({ stdout });
      expect(
        await createPullRequestVia(subjectFacts(), { runner: m.runner, envSource: { PATH: '/x' } }),
        stdout,
      ).toBe('COMPLETED');
    }
  });
});

// ── 8. The orchestration: observe, at most once, observe ───────────────────

describe('creating one pull request', () => {
  it('creates when nothing is there, and asks exactly once', async () => {
    const m = mutations();
    const reads = forgeReads([pullsBody([]), pullsBody([{ number: 7, state: 'open', sha: HEAD }])]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe('CREATED');
    expect(result.attempt).toBe('COMPLETED');
    expect(result.before?.outcome).toBe('NONE');
    expect(result.after?.open?.number).toBe(7);
    expect(m.calls).toHaveLength(1);
    // Two readings, one before and one after, and both about the same commit.
    expect(reads.calls).toHaveLength(2);
    for (const call of reads.calls) {
      expect(call.join(' ')).toContain(`commits/${HEAD}/pulls`);
    }
  });

  it('sends nothing when the intended pull request already exists', async () => {
    const m = mutations();
    const reads = forgeReads([pullsBody([{ number: 7, state: 'open', sha: HEAD }])]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe('ALREADY_EXISTS');
    expect(result.attempt).toBe('NOT_ATTEMPTED');
    expect(m.calls).toHaveLength(0);
    // One reading, and no second one: there was nothing to establish afterwards.
    expect(reads.calls).toHaveLength(1);
    expect(result.after).toBeNull();
  });

  it.each([
    ['a wrong base', [{ number: 7, state: 'open', sha: HEAD, base: 'release' }], 'WRONG_BASE_CONFLICT'],
    ['a draft', [{ number: 7, state: 'open', sha: HEAD, draft: true }], 'DRAFT_STATE_CONFLICT'],
    ['two open', [{ number: 7, state: 'open', sha: HEAD }, { number: 8, state: 'open', sha: HEAD }], 'PULL_REQUEST_AMBIGUOUS'],
    ['a closed one', [{ number: 7, state: 'closed', sha: HEAD }], 'PRIOR_PULL_REQUEST_CLOSED'],
  ])('does not converge on %s, and sends nothing', async (_name, page, expected) => {
    const m = mutations();
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: forgeReads([pullsBody(page)]).runner, mutator: m.runner }),
    );
    expect(result.creation).toBe(expected);
    expect(m.calls).toHaveLength(0);
  });

  it('does not converge on a pull request whose head is another commit', async () => {
    const m = mutations();
    const reads = forgeReads([
      pullsBody([{ number: 7, state: 'open', sha: OTHER }]),
      pullsBody([{ number: 8, state: 'open', sha: HEAD }]),
    ]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    // The branch may well be the same one. The commit is not, so the pre-reading
    // sees nothing at this head and a pull request is created.
    expect(result.before?.outcome).toBe('NONE');
    expect(result.creation).toBe('CREATED');
    expect(m.calls).toHaveLength(1);
  });

  it.each([
    ['the authority is spent', 'AUTHORITY_REFUSED'],
  ])('refuses when %s, having contacted nothing', async (_name, expected) => {
    const grant = grantOf();
    claimPullRequestCreation(grant);
    const m = mutations();
    const reads = forgeReads([pullsBody([])]);
    const result = await createPullRequest(
      grant,
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe(expected);
    expect(m.calls).toHaveLength(0);
    expect(reads.calls).toHaveLength(0);
    expect(result.remoteHead).toBeNull();
  });

  it.each([
    ['the task moved to another commit', subjectFacts({ headCommit: OTHER })],
    ['the base branch changed', subjectFacts({ baseRef: 'release' })],
    ['the work branch changed', subjectFacts({ headRef: 'refs/heads/other' })],
    ['the target moved', subjectFacts({ owner: 'someone-else' })],
    ['the task id changed', subjectFacts({ taskId: 'T-002' })],
    ['the title would differ', subjectFacts({ title: 'something else' })],
    ['the body would differ', subjectFacts({ body: 'something else' })],
  ])('refuses when %s between minting and acting', async (_name, still) => {
    const m = mutations();
    const reads = forgeReads([pullsBody([])]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ recheck: async () => still, reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe('SUBJECT_CHANGED');
    expect(m.calls).toHaveLength(0);
    expect(reads.calls).toHaveLength(0);
  });

  it('refuses when the subject cannot be re-established at all', async () => {
    const m = mutations();
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ recheck: async () => null, mutator: m.runner }),
    );
    expect(result.creation).toBe('SUBJECT_CHANGED');
    expect(m.calls).toHaveLength(0);
  });

  it('refuses a remote that reads one repository and writes another', async () => {
    const m = mutations();
    const reads = forgeReads([pullsBody([])]);
    let call = 0;
    const git: GitPublicationRunner = async (args) => {
      if (args.join(' ').startsWith('remote get-url')) {
        call += 1;
        return commandResult({ stdout: call === 1 ? `${URL}\n` : 'https://example.invalid/x.git\n' });
      }
      throw new Error('the ref must not be read after a divergence');
    };
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ gitRunner: git, reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe('REMOTE_URLS_DIVERGE');
    expect(m.calls).toHaveLength(0);
    expect(reads.calls).toHaveLength(0);
  });

  it.each([
    ['the head ref could not be read', { present: true, unknown: true }, 'REMOTE_STATE_UNKNOWN'],
    ['the head ref is not there', { present: false }, 'HEAD_NOT_PUBLISHED'],
    ['the head ref holds another commit', { present: true, commit: OTHER }, 'HEAD_SHA_MISMATCH'],
  ])('refuses when %s, and never pushes', async (_name, ref, expected) => {
    const m = mutations();
    const reads = forgeReads([pullsBody([])]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ gitRunner: gitReads(ref), reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe(expected);
    expect(m.calls).toHaveLength(0);
    // The forge was never asked either: the head is a precondition of the
    // question, not a detail discovered while answering it.
    expect(reads.calls).toHaveLength(0);
  });

  it('refuses when the forge cannot be read before the attempt', async () => {
    const m = mutations();
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: forgeReads([null]).runner, mutator: m.runner }),
    );
    expect(result.creation).toBe('PULL_REQUEST_STATE_UNKNOWN');
    expect(m.calls).toHaveLength(0);
  });

  it('reports an uncertain effect rather than a failure, and does not ask again', async () => {
    const m = mutations({ outcome: 'TIMED_OUT', exitCode: null });
    const reads = forgeReads([pullsBody([]), pullsBody([])]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    // The transport failed and nothing is findable. That is a refusal, and it
    // is honest: an effect that did not happen and is known not to have.
    expect(result.creation).toBe('CREATION_REFUSED');
    expect(m.calls).toHaveLength(1);
  });

  it('converges when the effect landed and the answer did not', async () => {
    const m = mutations({ outcome: 'BOUNDARY_LOST', exitCode: null });
    const reads = forgeReads([pullsBody([]), pullsBody([{ number: 7, state: 'open', sha: HEAD }])]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe('CONVERGED_AFTER_UNCERTAIN_EFFECT');
    expect(m.calls).toHaveLength(1);
  });

  it('is uncertain when the transport succeeded and nothing is findable', async () => {
    const m = mutations();
    const reads = forgeReads([pullsBody([]), pullsBody([])]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe('OUTCOME_UNCERTAIN');
    expect(m.calls).toHaveLength(1);
  });

  it('is uncertain when the post-reading cannot be taken', async () => {
    const m = mutations();
    const reads = forgeReads([pullsBody([]), null]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe('OUTCOME_UNCERTAIN');
    expect(m.calls).toHaveLength(1);
  });

  it('does not report success when the pull request that appeared is not the intended one', async () => {
    // The head-ref race, in the only shape this build can observe: GitHub
    // resolves `head` on its own side, so a ref moved between the reading and
    // the request produces a pull request from another commit — which the
    // post-reading, keyed on the intended object name, does not find.
    const m = mutations();
    const reads = forgeReads([pullsBody([]), pullsBody([{ number: 7, state: 'open', sha: OTHER }])]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).not.toBe('CREATED');
    expect(result.creation).toBe('OUTCOME_UNCERTAIN');
    expect(pullRequestIsEstablished(result.creation)).toBe(false);
    expect(m.calls).toHaveLength(1);
  });

  it('reports a mismatch when what appeared targets another base', async () => {
    const m = mutations();
    const reads = forgeReads([
      pullsBody([]),
      pullsBody([{ number: 7, state: 'open', sha: HEAD, base: 'release' }]),
    ]);
    const result = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({ reader: reads.runner, mutator: m.runner }),
    );
    expect(result.creation).toBe('POSTCONDITION_MISMATCH');
    // Nothing is closed, retargeted, edited or retried in response.
    expect(m.calls).toHaveLength(1);
  });

  it('asks at most once on every path there is', async () => {
    // The property stated as a sweep rather than as one case: whatever the
    // readings say and whatever the transport does, the mutation runner is
    // called zero times or one time. A retry anywhere would show up here.
    const pages = [pullsBody([]), pullsBody([{ number: 7, state: 'open', sha: HEAD }]), null];
    const transports: Partial<CommandResult>[] = [
      {},
      { exitCode: 1 },
      { outcome: 'TIMED_OUT', exitCode: null },
      { outcome: 'BOUNDARY_LOST', exitCode: null },
      { stdinDelivery: 'FAILED' },
    ];
    for (const before of pages) {
      for (const after of pages) {
        for (const transport of transports) {
          const m = mutations(transport);
          await createPullRequest(
            grantOf(),
            ROOT,
            seamsOf({ reader: forgeReads([before, after]).runner, mutator: m.runner }),
          );
          expect(m.calls.length, `${String(before)}/${String(after)}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('converges on a second invocation without a second request', async () => {
    // The whole idempotency claim, driven end to end: create once, then ask
    // again with a fresh grant and the forge now carrying the pull request.
    const first = mutations();
    const created = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({
        reader: forgeReads([pullsBody([]), pullsBody([{ number: 7, state: 'open', sha: HEAD }])]).runner,
        mutator: first.runner,
      }),
    );
    expect(created.creation).toBe('CREATED');

    const second = mutations();
    const again = await createPullRequest(
      grantOf(),
      ROOT,
      seamsOf({
        reader: forgeReads([pullsBody([{ number: 7, state: 'open', sha: HEAD }])]).runner,
        mutator: second.runner,
      }),
    );
    expect(again.creation).toBe('ALREADY_EXISTS');
    expect(again.attempt).toBe('NOT_ATTEMPTED');
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(0);
  });
});

// ── 9. The command ladder ──────────────────────────────────────────────────

describe('the delivery command creates only when asked, and only when it may', () => {
  const DECLARED: ResolvedDelivery = Object.freeze({
    declared: true as const,
    remoteName: REMOTE,
    result: Object.freeze({ outcome: 'RESOLVED' as const, target: IDENTITY }),
  });

  function taskState(over: Record<string, unknown> = {}): StateLoadResult {
    return {
      ok: true,
      revision: REV,
      state: {
        schemaVersion: 1,
        taskId: TASK,
        repositoryId: 'repo',
        repositoryRoot: ROOT,
        worktreePath: ROOT,
        state: 'READY_FOR_PR',
        stateEnteredAt: '2026-08-24T00:00:00.000Z',
        baseBranch: BASE,
        basePinnedCommit: OTHER,
        scopeAuthorityCommit: null,
        workBranch: BRANCH,
        currentCommit: HEAD,
        reviewRound: 1,
        maxReviewRounds: 3,
        blockedAgent: null,
        resumeFrom: null,
        reportedResetAt: null,
        worktreeCleanAtCheckpoint: true,
        findingHistory: [],
        ...over,
      },
    } as unknown as StateLoadResult;
  }

  async function run(
    argv: readonly string[],
    over: {
      readonly forgePages?: readonly (string | null)[];
      readonly checkPages?: readonly string[];
      readonly mutator?: Mutations;
      readonly state?: StateLoadResult;
    } = {},
  ): Promise<{ out: string; mutations: Mutations }> {
    const root = mkdtempSync(join(tmpdir(), 'ao-v406-'));
    mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
    const m = over.mutator ?? mutations();
    // Two questions per observation — pulls, then check runs, then status — and
    // the creation path asks the pulls endpoint again on its own.
    let pulls = 0;
    const forgePages = over.forgePages ?? [pullsBody([]), pullsBody([]), pullsBody([])];
    const reader: ForgeCommandRunner = async (_c, args) => {
      const path = args.find((a) => a.startsWith('repos/')) ?? '';
      if (path.endsWith('/pulls')) {
        const page = forgePages[Math.min(pulls, forgePages.length - 1)] ?? null;
        pulls += 1;
        if (page === null) return commandResult({ exitCode: 1, stdout: '{}' });
        return commandResult({ stdout: page });
      }
      if (path.endsWith('/check-runs')) {
        return commandResult({
          stdout: JSON.stringify({
            total_count: 1,
            check_runs: [{ head_sha: HEAD, status: 'completed', conclusion: 'success' }],
          }),
        });
      }
      // The combined-status response names its own subject at the top level,
      // and the parser refuses one that does not.
      return commandResult({
        stdout: JSON.stringify({ sha: HEAD, state: 'success', total_count: 0, statuses: [] }),
      });
    };

    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const program = new Command();
      program.exitOverride();
      registerDeliveryCommand(program, {
        resolveRepository: async () =>
          ({
            ok: true,
            repository: { id: 'repo', root, delivery: DECLARED },
          }) as unknown as Awaited<ReturnType<typeof import('../src/repo/resolve-repository.js').resolveRepository>>,
        loadTaskState: () => over.state ?? taskState(),
        runner: reader,
        creationRunner: m.runner,
        publicationRunner: gitReads(),
        envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
        now: () => new Date('2026-08-24T00:00:00.000Z'),
        checkIgnored: async () => 'IGNORED' as never,
      });
      await program.parseAsync(['node', 'x', 'delivery', '--repository', root, '--task', TASK, ...argv]);
    } finally {
      write.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
    return { out: chunks.join(''), mutations: m };
  }

  it('creates nothing without the flag, and says nothing about creation', async () => {
    const { out, mutations: m } = await run(['--observe', '--decide']);
    expect(out).not.toContain('Creation     :');
    expect(m.calls).toHaveLength(0);
    expect(out).toContain(CONTACTED_TRAILER);
  });

  it('refuses without --attended, having contacted no forge for it', async () => {
    const { out, mutations: m } = await run(['--observe', '--decide', '--create-pr']);
    expect(out).toContain('Creation     : OPERATOR_ABSENT');
    expect(m.calls).toHaveLength(0);
  });

  it('refuses without a fresh decision of its own', async () => {
    const { out, mutations: m } = await run(['--create-pr', '--attended']);
    expect(out).toContain('Creation     : DECISION_NOT_ESTABLISHED');
    expect(m.calls).toHaveLength(0);
    // And with --observe but no --decide: an observation is not a decision.
    const second = await run(['--observe', '--create-pr', '--attended']);
    expect(second.out).toContain('Creation     : DECISION_NOT_ESTABLISHED');
    expect(second.mutations.calls).toHaveLength(0);
  });

  it('refuses a task that has not finished', async () => {
    const { out, mutations: m } = await run(['--observe', '--decide', '--create-pr', '--attended'], {
      state: taskState({ state: 'REVIEWING' }),
    });
    expect(out).toContain('Creation     : TASK_NOT_READY');
    expect(m.calls).toHaveLength(0);
  });

  it('refuses a base branch it will not send', async () => {
    const { out, mutations: m } = await run(['--observe', '--decide', '--create-pr', '--attended'], {
      state: taskState({ baseBranch: 'not a branch name' }),
    });
    expect(out).toContain('Creation     : SUBJECT_NOT_ESTABLISHED');
    expect(m.calls).toHaveLength(0);
  });

  it('refuses when the decision is not PULL_REQUEST_REQUIRED', async () => {
    // A green observation whose pull request already matched decides
    // PULL_REQUEST_MATCHED_CHECKS_SUCCESS, which is not permission to create.
    const matched = pullsBody([{ number: 7, state: 'open', sha: HEAD }]);
    const { out, mutations: m } = await run(['--observe', '--decide', '--create-pr', '--attended'], {
      forgePages: [matched, matched, matched],
    });
    expect(out).toContain('Creation     : DECISION_NOT_ESTABLISHED');
    expect(m.calls).toHaveLength(0);
  });

  it('creates when every gate is satisfied, and says so once', async () => {
    const created = pullsBody([{ number: 7, state: 'open', sha: HEAD }]);
    const { out, mutations: m } = await run(['--observe', '--decide', '--create-pr', '--attended'], {
      forgePages: [pullsBody([]), pullsBody([]), created],
    });
    expect(out).toContain('Creation     : CREATED');
    expect(out).toContain(`Intended     : ${REF} -> ${BASE}  (draft: false)`);
    expect(out).toContain('Forge after  : OPEN_ONE #7  (draft: false)');
    expect(m.calls).toHaveLength(1);
    expect(out).toContain(CREATION_TRAILER);
    expect(out).toContain(OBSERVED_AND_CHANGED_TRAILER);
    expect(out).not.toContain(CONTACTED_TRAILER);
  });

  it('leaves the task state file untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-v406-state-'));
    try {
      const runtime = join(root, '.agent-orchestrator', 'runtime');
      mkdirSync(runtime, { recursive: true });
      const before = readdirSync(runtime);
      const created = pullsBody([{ number: 7, state: 'open', sha: HEAD }]);
      await run(['--observe', '--decide', '--create-pr', '--attended'], {
        forgePages: [pullsBody([]), pullsBody([]), created],
      });
      expect(readdirSync(runtime)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('registers the flag with the sentence that was pinned, not a copy', () => {
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    const help = delivery?.helpInformation() ?? '';
    const collapse = (t: string): string => t.replace(/\s+/g, ' ').trim();
    expect(help).toContain('--create-pr');
    expect(collapse(help)).toContain(collapse(CREATE_PR_OPTION_DESCRIPTION));
    expect(collapse(help)).toContain(collapse(ATTENDED_OPTION_DESCRIPTION));
  });

  it('registers no option this build refuses to name', () => {
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    for (const option of delivery?.options ?? []) {
      expect(option.long ?? '', option.long ?? '').not.toMatch(
        /force|unattended|adopt|takeover|steal|merge/i,
      );
    }
  });

  it('says what --attended is required by, now that it is two flags', () => {
    expect(ATTENDED_OPTION_DESCRIPTION).toContain('--publish-head and --create-pr');
    expect(ATTENDED_OPTION_DESCRIPTION).toContain('no unattended pull request');
  });

  it('says what --create-pr will not do', () => {
    for (const clause of [
      'Requires --attended, --observe and --decide',
      'never pushes',
      'HEAD_NOT_PUBLISHED',
      'updates, closes, reviews and merges nothing',
      'writes no task state',
    ]) {
      expect(CREATE_PR_OPTION_DESCRIPTION, clause).toContain(clause);
    }
  });
});

// ── 10. The report ─────────────────────────────────────────────────────────

describe('the report', () => {
  const base = {
    repositoryId: 'repo',
    repositoryRoot: ROOT,
    taskId: TASK,
    subject: { ok: false as const, refusal: 'NO_DELIVERY_TARGET' as never },
    observation: null,
    conclusion: 'SUBJECT_NOT_ESTABLISHED' as never,
    stored: null,
    recording: null,
    decision: null,
    publication: null,
  };

  it('prints no reading for a refusal that never contacted anything', () => {
    const out = renderDeliveryObservation({
      ...base,
      creation: {
        result: {
          creation: 'OPERATOR_ABSENT',
          remoteHead: null,
          before: null,
          attempt: 'NOT_ATTEMPTED',
          after: null,
        },
        headRef: REF,
        baseRef: BASE,
        draft: null,
      },
    } as never);
    expect(out).toContain('Creation     : OPERATOR_ABSENT');
    expect(out).not.toContain('Forge before');
    expect(out).not.toContain('Remote head');
    // Nothing was contacted, so the read-only trailer is the right one.
    expect(out).toContain('Read-only. No forge was contacted');
  });

  it('never prints a branch name the forge supplied', () => {
    const out = renderDeliveryObservation({
      ...base,
      creation: {
        result: {
          creation: 'WRONG_BASE_CONFLICT',
          remoteHead: { outcome: 'AT_COMMIT', commit: HEAD },
          before: {
            outcome: 'OPEN_ONE',
            open: { number: 7, baseRef: 'somebody-elses-branch', draft: false },
            numbers: [7],
          },
          attempt: 'NOT_ATTEMPTED',
          after: null,
        },
        headRef: REF,
        baseRef: BASE,
        draft: false,
      },
    } as never);
    expect(out).toContain('Forge before : OPEN_ONE #7  (draft: false)');
    // The base the forge reported is a string this build did not write. The
    // number is enough to find the pull request, and the number is validated.
    expect(out).not.toContain('somebody-elses-branch');
  });

  it('prints both act trailers when one invocation did both', () => {
    const out = renderDeliveryObservation({
      ...base,
      observation: { pullRequest: { outcome: 'NO_MATCHING_PULL_REQUEST' }, checks: { outcome: 'NO_CHECKS' } },
      publication: {
        result: {
          publication: 'PUBLISHED',
          before: { outcome: 'ABSENT', commit: null },
          attempt: 'COMPLETED',
          after: { outcome: 'AT_COMMIT', commit: HEAD },
        },
        ref: REF,
        remoteName: REMOTE,
      },
      creation: {
        result: {
          creation: 'CREATED',
          remoteHead: { outcome: 'AT_COMMIT', commit: HEAD },
          before: { outcome: 'NONE', open: null, numbers: [] },
          attempt: 'COMPLETED',
          after: { outcome: 'OPEN_ONE', open: { number: 7, baseRef: BASE, draft: false }, numbers: [7] },
        },
        headRef: REF,
        baseRef: BASE,
        draft: false,
      },
    } as never);
    expect(out).toContain(PUBLICATION_TRAILER);
    expect(out).toContain(CREATION_TRAILER);
    expect(out).toContain(OBSERVED_AND_CHANGED_TRAILER);
    expect(out).not.toContain('Read-only. No forge was contacted');
  });

  it('states each act separately, so neither claims the other did nothing', () => {
    // The defect this shape exists to prevent, and it has been shipped here
    // once: the publication trailer used to end "No pull request was opened,
    // updated, reviewed or merged", which became false the moment a flag was
    // added that opens one.
    expect(PUBLICATION_TRAILER).not.toContain('No pull request was opened');
    expect(PUBLICATION_TRAILER).toContain('The publication could change exactly one thing');
    expect(CREATION_TRAILER).toContain('The creation could change exactly one thing');
    expect(CREATION_TRAILER).toContain('No branch was pushed');
    expect(CREATION_TRAILER).toContain('marked ready or draft');
  });
});

// ── 11. The product contract is unchanged where it must be ─────────────────

describe('what this slice did not gain', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });

  const codeOnly = (path: string): string =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  const SURFACE = [
    ...walk('src/deliver'),
    'src/cli/delivery-command.ts',
    'src/cli/render-delivery-observation.ts',
  ].sort();

  const CREATOR = 'src/deliver/github-pull-request-creator.ts';

  it('leaves READY_FOR_PR terminal, with no outgoing transition', () => {
    expect([...TERMINAL_STATES]).toContain('READY_FOR_PR');
    expect(isTerminalState('READY_FOR_PR')).toBe(true);
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
  });

  it('names no writer, no lease and no agent on the whole delivery surface', () => {
    for (const file of SURFACE) {
      const code = codeOnly(file);
      expect(code, file).not.toMatch(/\badvanceTaskState\s*\(/);
      expect(code, file).not.toMatch(/\bsaveTaskState\s*\(/);
      expect(code, file).not.toMatch(/\bacquire\w*ExecutionLease\s*\(/);
      expect(code, file).not.toMatch(/\brunOwnedCommand\s*\(|\bspawn\s*\(/);
    }
  });

  it('sends a POST from exactly one module, at exactly one endpoint', () => {
    const posters = SURFACE.filter((f) =>
      /['"]-X['"]\s*,\s*['"]POST['"]|-X\s*POST/.test(codeOnly(f)),
    );
    expect(posters).toEqual([CREATOR]);
    // And that module names one path and no sub-resource of it.
    const code = codeOnly(CREATOR);
    expect(code).toContain('/pulls`');
    expect(code).not.toMatch(/pulls\/\$\{|\/merge|\/reviews|\/comments|\/labels|\/requested_reviewers/);
  });

  it('names no update, close, review, label or merge anywhere on the surface', () => {
    for (const file of SURFACE) {
      const code = codeOnly(file);
      expect(code, file).not.toMatch(/['"]-X['"]\s*,\s*['"](PATCH|PUT|DELETE)['"]|-X\s*(PATCH|PUT|DELETE)/);
      expect(code, file).not.toMatch(/gh pr (merge|edit|close|review|comment|ready)/);
      expect(code, file).not.toMatch(/\bmergePullRequest\b|\benableAutoMerge\b/);
      expect(code, file).not.toMatch(/['"]--auto['"]|--squash\b/);
    }
    // False-negative guard: each pattern matches the thing it is aimed at.
    expect("['api', '-X', 'PATCH', p]").toMatch(/['"]-X['"]\s*,\s*['"](PATCH|PUT|DELETE)['"]/);
    expect('gh pr merge --squash').toMatch(/gh pr (merge|edit|close|review|comment|ready)/);
  });

  it('never reaches the client through the assisting front end', () => {
    for (const file of SURFACE) {
      const code = codeOnly(file);
      // `gh pr create` pushes, forks, prompts, opens an editor and can fill the
      // body from commit messages. Named nowhere, in either spelling.
      expect(code, file).not.toMatch(/['"]pr['"]\s*,\s*['"]create['"]/);
      expect(code, file).not.toMatch(/gh pr create/);
      expect(code, file).not.toMatch(/['"]--fill['"]|['"]--web['"]|['"]--editor['"]|['"]--template['"]/);
    }
  });

  it('pushes from exactly one module, and it is not the creator', () => {
    const pushers = SURFACE.filter((f) => /'push'/.test(codeOnly(f)));
    expect(pushers).toEqual(['src/deliver/git-head-publisher.ts']);
    expect(codeOnly(CREATOR)).not.toMatch(/'push'|git push/);
  });

  it('imports the creation mint in exactly one module of the whole source tree', () => {
    const all = walk('src');
    const importers = all.filter((f) =>
      /from\s+'[^']*internal\/pull-request-creation-grant\.js'/.test(readFileSync(f, 'utf8')),
    );
    // The public facade re-exports the type; the CLI mints; the creator and the
    // transport name the subject type. Nothing else.
    expect(importers.sort()).toEqual(
      [
        'src/cli/delivery-command.ts',
        'src/deliver/create-pull-request.ts',
        'src/deliver/github-pull-request-creator.ts',
        'src/deliver/pull-request-creation-grant.ts',
      ].sort(),
    );

    // And the only one that CALLS the mint is the command ladder. The declaring
    // module is excluded by name rather than by a cleverer regex.
    const DECLARES = 'src/deliver/internal/pull-request-creation-grant.ts';
    expect(all, 'the declaring module must exist').toContain(DECLARES);
    const minters = all
      .filter((f) => f !== DECLARES)
      .filter((f) => /\bmintPullRequestCreationGrant\s*\(/.test(codeOnly(f)));
    expect(minters).toEqual(['src/cli/delivery-command.ts']);
  });

  it('runs the creation through its own seam, not the reading one', () => {
    // A test that stubbed reading must not be able to stand in for writing.
    const code = codeOnly('src/deliver/create-pull-request.ts');
    expect(code).toContain('reader');
    expect(code).toContain('mutator');
    expect(code).toMatch(/runner:\s*seams\.mutator/);
    expect(code).toMatch(/runner:\s*seams\.reader/);
  });

  it('has no second attempt anywhere in the creation path', () => {
    for (const file of [
      'src/deliver/create-pull-request.ts',
      'src/deliver/github-pull-request-creator.ts',
    ]) {
      const code = codeOnly(file);
      expect(code, file).not.toMatch(/\bfor\s*\(|\bwhile\s*\(|\bretry\b|\bbackoff\b/i);
      // Exactly one call site for the transport, and it is not in a loop.
      const calls = code.match(/createPullRequestVia\s*\(/g) ?? [];
      expect(calls.length, file).toBeLessThanOrEqual(1);
    }
  });
});
