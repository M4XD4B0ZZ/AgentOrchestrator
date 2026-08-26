/**
 * V4 slice 7 — the explicit merge effect, under attended authority.
 *
 * Eleven sections, in the order slices 5 and 6 established, and the same rule
 * about what an assertion is allowed to be: a count of calls rather than a word
 * about them, an enumerated equality rather than a partition, a minted artefact
 * rather than a hand-built one, and a positive control beside every sweep so an
 * empty scan cannot pass as a clean tree.
 *
 * What this file has that neither sibling did: the transport's own answer is
 * never evidence. Measured against github.com, a merge request against an
 * already-merged pull request answers `200 {"merged":true}` and replays the
 * ORIGINAL merge commit, ignoring both the `sha` this build sends and the
 * `merge_method`. So a case that asserted `attempt === 'COMPLETED'` and stopped
 * would be asserting nothing about the forge, and every positive case here ends
 * on a reading instead.
 */

import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DELIVERY_MERGE_METHOD,
  MERGE_METHODS,
  MergeGrant as MergeGrantClass,
  mintMergeGrant,
  type MergeIntent,
  type MergeSubject,
} from '../src/deliver/internal/merge-grant.js';
import {
  claimMerge,
  isMergeGrant,
  type MergeGrant,
} from '../src/deliver/merge-grant.js';
import {
  ESTABLISHED_MERGES,
  gradeMerge,
  gradeMergePrecondition,
  mergeIsEstablished,
  MERGE_ATTEMPTS,
  MERGE_OUTCOME_DETAIL,
  MERGE_OUTCOMES,
  MERGE_READING_UNKNOWN,
  MERGE_READINGS,
  type IntendedMerge,
  type MergeOutcome,
  type MergeReading,
} from '../src/deliver/pull-request-merge.js';
import {
  createForgeMergeRunner,
  FORGE_MERGE_BODY_SOURCE,
  FORGE_MERGE_PREFIX,
  MERGE_MAX_RESPONSE_BYTES,
  MERGE_TIMEOUT_MS,
  mergePath,
  mergePullRequestVia,
  mergeRequestArgs,
  mergeRequestBody,
  type ForgeMergeRunner,
} from '../src/deliver/github-pull-request-merger.js';
import { mergePullRequest, type MergeSeams } from '../src/deliver/merge-pull-request.js';
import {
  createObservationSubject,
  parsePullRequestRecord,
  type ObservationSubject,
} from '../src/deliver/forge-observation.js';
import {
  pullRequestPath,
  readPullRequestByNumber,
  type ForgeCommandRunner,
} from '../src/deliver/github-observer.js';
import {
  ATTENDED_OPTION_DESCRIPTION,
  DELIVERY_COMMAND_DESCRIPTION,
  MERGE_PR_OPTION_DESCRIPTION,
  registerDeliveryCommand,
} from '../src/cli/delivery-command.js';
import {
  MERGE_TRAILER,
  renderDeliveryObservation,
} from '../src/cli/render-delivery-observation.js';
import {
  DELIVERY_DECISIONS,
  POSITIVE_DELIVERY_DECISION,
} from '../src/deliver/delivery-decision.js';
import { TERMINAL_STATES, isTerminalState } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import { isShellInertArgument } from '../src/doctor/exec.js';
import type { CommandResult } from '../src/doctor/exec.js';
import { mintPullRequestCreationGrant } from '../src/deliver/internal/pull-request-creation-grant.js';
import { mintHeadPublicationGrant } from '../src/deliver/internal/head-publication-grant.js';
import { composePullRequestContent, AO_PULL_REQUEST_DRAFT } from '../src/deliver/pull-request-content.js';
import { publishDeliveryHead } from '../src/deliver/publish-delivery-head.js';
import { createPullRequest } from '../src/deliver/create-pull-request.js';
import type { ResolvedDelivery } from '../src/deliver/delivery-target.js';
import type { StateLoadResult } from '../src/state/state-store.js';
import type { GitPublicationRunner } from '../src/deliver/git-head-publisher.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const HEAD = '10583ee91a5747d0049f563ffaac64b0cf643aeb';
const OTHER = 'c89ef605400a15e5d3db4d256c184773c0d533f6';
const RESULT = 'f1e2d3c4b5a6978877665544332211ffeeddccbb';
const REV = 'a'.repeat(64);
const TASK = 'T-001';
const BRANCH = 'ao/T-001';
const REF = `refs/heads/${BRANCH}`;
const BASE = 'main';
const REMOTE = 'origin';
const URL = 'https://github.com/M4XD4B0ZZ/AgentOrchestrator.git';
const PR = 60;
const ROOT = 'D:\\repo';

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

function intentOf(over: Partial<MergeIntent> = {}): MergeIntent {
  return {
    taskId: TASK,
    pullRequestNumber: PR,
    baseRef: BASE,
    mergeMethod: DELIVERY_MERGE_METHOD,
    ...over,
  };
}

/** A real, minted grant — never a hand-built object. */
function grantOf(over: Partial<MergeIntent> = {}, target = subjectOf()): MergeGrant {
  const grant = mintMergeGrant(target, intentOf(over));
  if (grant === null) throw new Error('fixture grant was refused by the mint');
  return grant;
}

function subjectFacts(over: Partial<MergeSubject> = {}): MergeSubject {
  return Object.freeze({
    taskId: TASK,
    host: IDENTITY.host,
    owner: IDENTITY.owner,
    name: IDENTITY.name,
    pullRequestNumber: PR,
    expectedHeadCommit: HEAD,
    baseRef: BASE,
    mergeMethod: DELIVERY_MERGE_METHOD,
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

/**
 * The single pull-request document, in GitHub's own shape.
 *
 * `merge_commit_sha` is supplied independently of `merged`, deliberately: the
 * measured trap is that GitHub fills that field on an OPEN pull request with an
 * ephemeral test-merge commit, and a fixture that could not express that could
 * not test the gate that ignores it.
 */
function prBody(
  over: {
    number?: number;
    state?: string;
    merged?: boolean;
    sha?: string;
    base?: string | null;
    draft?: boolean | null;
    mergeCommit?: string | null;
  } = {},
): string {
  const record: Record<string, unknown> = {
    number: over.number ?? PR,
    state: over.state ?? 'open',
    merged: over.merged ?? false,
    head: { sha: over.sha ?? HEAD },
    merge_commit_sha: over.mergeCommit === undefined ? null : over.mergeCommit,
  };
  if (over.base !== null) record['base'] = { ref: over.base ?? BASE };
  if (over.draft !== null) record['draft'] = over.draft ?? false;
  return JSON.stringify(record);
}

interface Reads {
  readonly runner: ForgeCommandRunner;
  readonly calls: string[][];
}

/**
 * A reading seam that answers with a different page each time.
 *
 * The pages are consumed in order, so a case can say "open before, merged
 * afterwards" without the two readings being the same object — which is the
 * whole point of taking two. `null` is a refusal.
 */
function reads(pages: readonly (string | null)[]): Reads {
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

interface Merges {
  readonly runner: ForgeMergeRunner;
  readonly calls: { args: string[]; stdin: string }[];
}

function merges(over: Partial<CommandResult> = {}): Merges {
  const calls: { args: string[]; stdin: string }[] = [];
  const runner: ForgeMergeRunner = async (_command, args, options) => {
    calls.push({ args: [...args], stdin: options.stdin });
    return commandResult(over);
  };
  return { runner, calls };
}

function seamsOf(over: Partial<MergeSeams> = {}): MergeSeams {
  return {
    recheck: async () => subjectFacts(),
    reader: reads([prBody()]).runner,
    merger: merges().runner,
    envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
    ...over,
  };
}

function reading(over: Partial<MergeReading> = {}): MergeReading {
  return Object.freeze({
    outcome: 'OPEN' as const,
    number: PR,
    headSha: HEAD,
    baseRef: BASE,
    draft: false,
    mergeCommit: null,
    ...over,
  });
}

const INTENDED: IntendedMerge = Object.freeze({
  pullRequestNumber: PR,
  expectedHeadCommit: HEAD,
  baseRef: BASE,
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Source with comments removed.
 *
 * The same stripper the sibling files use, and the same stated limit: a `//`
 * inside a string literal would be read as a comment. No file scanned here
 * contains one, and the positive controls beside each use would fail if a file
 * ever emptied out.
 */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ── 1. The vocabulary is closed and total ──────────────────────────────────

describe('the merge vocabulary', () => {
  it('names a sentence for every member, and no others', () => {
    expect(Object.keys(MERGE_OUTCOME_DETAIL).sort()).toEqual([...MERGE_OUTCOMES].sort());
    for (const member of MERGE_OUTCOMES) {
      expect(MERGE_OUTCOME_DETAIL[member].length, member).toBeGreaterThan(40);
    }
  });

  it('names three attempts and four readings, and no more', () => {
    expect([...MERGE_ATTEMPTS]).toEqual(['NOT_ATTEMPTED', 'COMPLETED', 'FAILED']);
    expect([...MERGE_READINGS]).toEqual(['UNKNOWN', 'OPEN', 'CLOSED_UNMERGED', 'MERGED']);
  });

  it('names exactly three established members, and the predicate agrees', () => {
    // Enumerated, not partitioned. A `filter(p)`/`filter(!p)` assertion over the
    // vocabulary is a tautology whatever shape it is written in, and slice 6
    // tried three of them before recording that the list is the only thing that
    // holds the set. This is the list.
    const established = MERGE_OUTCOMES.filter((m) => ESTABLISHED_MERGES.has(m));
    expect([...established].sort()).toEqual(
      ['ALREADY_MERGED', 'CONVERGED_AFTER_UNCERTAIN_EFFECT', 'MERGED'].sort(),
    );
    // And the predicate agrees with the set for every member, so a caller can
    // never be right by asking one and wrong by asking the other. This pins the
    // two to each other; it cannot detect a widening, because both sides move
    // together — the enumerated equality above is what does that.
    for (const member of MERGE_OUTCOMES) {
      expect(mergeIsEstablished(member), member).toBe(ESTABLISHED_MERGES.has(member));
    }
  });

  it('says exactly this, for the members an operator acts on', () => {
    expect(MERGE_OUTCOME_DETAIL.MERGED).toBe(
      'This pull request was open at the authorised head, one request was made, and it is now merged into the intended base at that head. The resulting commit below was read back from the forge, not taken from the response.',
    );
    expect(MERGE_OUTCOME_DETAIL.ALREADY_MERGED).toBe(
      'This pull request was already merged before anything was attempted, so nothing was sent. That it is merged is what this says; who merged it is not something a reading can establish.',
    );
    expect(MERGE_OUTCOME_DETAIL.PULL_REQUEST_NOT_OPEN).toBe(
      'This pull request is closed and was not merged. GitHub would merge it anyway; this build will not, because somebody decided about this delivery already. Nothing was attempted.',
    );
    expect(MERGE_OUTCOME_DETAIL.OBSERVATION_UNAVAILABLE).toBe(
      'The reading after the attempt could not be completed, so whether the forge merged this pull request is not established. A request may have taken effect. Nothing was retried; asking again begins with a reading.',
    );
  });

  it('carries no member that claims eligibility', () => {
    // The word this slice must never acquire. `MERGE_ELIGIBLE`,
    // `ALL_CHECKS_PASSED` and friends would each be a claim slice 4 measured
    // this build cannot make, and a vocabulary member is the easiest place for
    // one to arrive unnoticed.
    for (const member of MERGE_OUTCOMES) {
      expect(member, member).not.toMatch(/ELIGIBLE|APPROVED|PERMITTED|ALLOWED/);
    }
    // The predicate the case's name describes. It was
    // `not.toContain('eligible to merge, and')` — a seven-word phrase that
    // occurs in this build only inside the report's DISCLAIMER, so a sentence
    // claiming "this pull request was eligible to merge" would have passed it.
    // Fourteen of the eighteen sentences are covered by nothing else, which is
    // what made the weak form worth finding.
    for (const member of MERGE_OUTCOMES) {
      expect(MERGE_OUTCOME_DETAIL[member].toLowerCase(), member).not.toContain('eligible');
      expect(MERGE_OUTCOME_DETAIL[member].toLowerCase(), member).not.toContain('approved');
      expect(MERGE_OUTCOME_DETAIL[member].toLowerCase(), member).not.toContain('permitted to');
    }
  });
});

// ── 2. The grade comes from the readings ───────────────────────────────────

describe('grading a merge', () => {
  it('refuses from the pre-reading, and every arm means nothing was attempted', () => {
    const cases: readonly [MergeReading, MergeOutcome][] = [
      [MERGE_READING_UNKNOWN, 'PULL_REQUEST_STATE_UNKNOWN'],
      [reading({ number: 61 }), 'PULL_REQUEST_STATE_UNKNOWN'],
      [reading({ outcome: 'MERGED', mergeCommit: RESULT }), 'ALREADY_MERGED'],
      [reading({ outcome: 'CLOSED_UNMERGED' }), 'PULL_REQUEST_NOT_OPEN'],
      [reading({ draft: true }), 'DRAFT_REFUSED'],
      [reading({ draft: null }), 'PULL_REQUEST_STATE_UNKNOWN'],
      [reading({ headSha: null }), 'PULL_REQUEST_STATE_UNKNOWN'],
      [reading({ baseRef: null }), 'PULL_REQUEST_STATE_UNKNOWN'],
      [reading({ headSha: OTHER }), 'HEAD_MOVED'],
      [reading({ baseRef: 'release' }), 'WRONG_BASE'],
    ];
    for (const [before, expected] of cases) {
      expect(gradeMergePrecondition(INTENDED, before), expected).toBe(expected);
    }
    // And the one arm that lets the merge proceed.
    expect(gradeMergePrecondition(INTENDED, reading())).toBeNull();
  });

  it('refuses to call a merge at another head or base ALREADY_MERGED', () => {
    // **This case asserted the opposite until a review found it.** It said a
    // merged pull request is answered before the head is compared, on the
    // argument that it cannot be brought back to the authorised head — which is
    // true and is not the point. `ALREADY_MERGED` is a member of
    // `ESTABLISHED_MERGES`, so answering it claims the intended state is true,
    // and the intended state is not "merged" but "merged at the authorised
    // head, into the intended base". Somebody else's merge was being reported
    // as this delivery's, with their commit under a `Merge commit` line.
    //
    // It is deliberately NOT `HEAD_MOVED` — that member's sentence says nothing
    // was attempted and the head moved, and says nothing about a merge. What is
    // true is that it is merged and not as intended.
    const otherHead = reading({ outcome: 'MERGED', headSha: OTHER, mergeCommit: RESULT });
    expect(gradeMergePrecondition(INTENDED, otherHead)).toBe('POSTCONDITION_MISMATCH');

    const otherBase = reading({ outcome: 'MERGED', baseRef: 'release', mergeCommit: RESULT });
    expect(gradeMergePrecondition(INTENDED, otherBase)).toBe('POSTCONDITION_MISMATCH');

    // A merged reading that cannot describe itself is judged as unreadable
    // rather than as a mismatch: "I cannot tell" is not "it is wrong".
    for (const blind of [{ headSha: null }, { baseRef: null }]) {
      const r = reading({ outcome: 'MERGED', mergeCommit: RESULT, ...blind });
      expect(gradeMergePrecondition(INTENDED, r), JSON.stringify(blind)).toBe(
        'PULL_REQUEST_STATE_UNKNOWN',
      );
    }

    // And the agreeing case still answers the established member.
    const agreeing = reading({ outcome: 'MERGED', mergeCommit: RESULT });
    expect(gradeMergePrecondition(INTENDED, agreeing)).toBe('ALREADY_MERGED');
  });

  it('never reports a merge commit for a merge it did not authorise', async () => {
    // The end-to-end half of the same finding: the early return in the
    // orchestration filled `mergeCommit` from the reading, and that early
    // return is the ONLY path that can produce `ALREADY_MERGED`. The correction
    // had reached `result()` and not it.
    const m = merges();
    const r = reads([
      prBody({ state: 'closed', merged: true, sha: OTHER, base: 'release', mergeCommit: RESULT }),
    ]);
    const out = await mergePullRequest(grantOf(), seamsOf({ merger: m.runner, reader: r.runner }));
    expect(out.outcome).toBe('POSTCONDITION_MISMATCH');
    expect(out.mergeCommit).toBeNull();
    expect(mergeIsEstablished(out.outcome)).toBe(false);
    expect(m.calls).toHaveLength(0);

    // The agreeing case still reports it, so the narrowing did not blind the
    // path a re-run depends on.
    const agree = await mergePullRequest(
      grantOf(),
      seamsOf({
        merger: merges().runner,
        reader: reads([prBody({ state: 'closed', merged: true, mergeCommit: RESULT })]).runner,
      }),
    );
    expect(agree.outcome).toBe('ALREADY_MERGED');
    expect(agree.mergeCommit).toBe(RESULT);
  });

  it('decides the postcondition from the reading, not from the attempt', () => {
    const after = (over: Partial<MergeReading>) => reading(over);
    const merged = { outcome: 'MERGED' as const, mergeCommit: RESULT };

    // The only member that claims this process did it.
    expect(gradeMerge(INTENDED, reading(), 'COMPLETED', after(merged))).toBe('MERGED');
    // Same reading, transport said nothing useful: the state is established and
    // this process cannot claim it is what established it.
    expect(gradeMerge(INTENDED, reading(), 'FAILED', after(merged))).toBe(
      'CONVERGED_AFTER_UNCERTAIN_EFFECT',
    );
    expect(gradeMerge(INTENDED, reading(), 'NOT_ATTEMPTED', after(merged))).toBe(
      'CONVERGED_AFTER_UNCERTAIN_EFFECT',
    );

    // Merged, but not as intended.
    expect(gradeMerge(INTENDED, reading(), 'COMPLETED', after({ ...merged, headSha: OTHER }))).toBe(
      'POSTCONDITION_MISMATCH',
    );
    expect(
      gradeMerge(INTENDED, reading(), 'COMPLETED', after({ ...merged, baseRef: 'release' })),
    ).toBe('POSTCONDITION_MISMATCH');

    // Merged and the resulting commit could not be established. This is the
    // member that exists because the next slice needs that exact identity.
    expect(
      gradeMerge(INTENDED, reading(), 'COMPLETED', after({ outcome: 'MERGED', mergeCommit: null })),
    ).toBe('OUTCOME_AMBIGUOUS');
    expect(
      gradeMerge(INTENDED, reading(), 'COMPLETED', after({ outcome: 'MERGED', mergeCommit: 'nope' })),
    ).toBe('OUTCOME_AMBIGUOUS');

    // Not merged afterwards.
    expect(gradeMerge(INTENDED, reading(), 'COMPLETED', after({}))).toBe('OUTCOME_AMBIGUOUS');
    expect(gradeMerge(INTENDED, reading(), 'FAILED', after({}))).toBe('EFFECT_NOT_ESTABLISHED');
    expect(gradeMerge(INTENDED, reading(), 'NOT_ATTEMPTED', after({}))).toBe(
      'EFFECT_NOT_ESTABLISHED',
    );
    expect(gradeMerge(INTENDED, reading(), 'COMPLETED', after({ outcome: 'CLOSED_UNMERGED' }))).toBe(
      'POSTCONDITION_MISMATCH',
    );

    // No reading afterwards at all. The member the whole design exists for.
    expect(gradeMerge(INTENDED, reading(), 'COMPLETED', null)).toBe('OBSERVATION_UNAVAILABLE');
    expect(gradeMerge(INTENDED, reading(), 'COMPLETED', MERGE_READING_UNKNOWN)).toBe(
      'OBSERVATION_UNAVAILABLE',
    );
    // A reading about a different pull request settles nothing about this one.
    expect(gradeMerge(INTENDED, reading(), 'COMPLETED', after({ number: 61 }))).toBe(
      'OUTCOME_AMBIGUOUS',
    );
  });

  it('consults the attempt exactly twice, and nowhere else', () => {
    // Measured rather than asserted: for every settled post-reading, flip the
    // attempt word and count the rows whose answer changes. Two of them do —
    // merged-as-intended, and not-merged-and-still-open — and those are the two
    // the readings alone genuinely cannot separate.
    const afters: readonly MergeReading[] = [
      reading({ outcome: 'MERGED', mergeCommit: RESULT }),
      reading({ outcome: 'MERGED', mergeCommit: RESULT, headSha: OTHER }),
      reading({ outcome: 'MERGED', mergeCommit: null }),
      reading({ outcome: 'CLOSED_UNMERGED' }),
      reading({}),
      MERGE_READING_UNKNOWN,
    ];
    const differing = afters.filter(
      (after) =>
        gradeMerge(INTENDED, reading(), 'COMPLETED', after) !==
        gradeMerge(INTENDED, reading(), 'FAILED', after),
    );
    expect(differing).toHaveLength(2);
  });

  it('returns a member of the vocabulary for every input it can be given', () => {
    // Totality, over the whole cross product this function's types admit.
    const befores: readonly MergeReading[] = [
      MERGE_READING_UNKNOWN,
      reading({}),
      reading({ draft: true }),
      reading({ headSha: OTHER }),
      reading({ baseRef: 'release' }),
      reading({ outcome: 'CLOSED_UNMERGED' }),
      reading({ outcome: 'MERGED', mergeCommit: RESULT }),
    ];
    const afters: readonly (MergeReading | null)[] = [
      null,
      MERGE_READING_UNKNOWN,
      reading({}),
      reading({ outcome: 'CLOSED_UNMERGED' }),
      reading({ outcome: 'MERGED', mergeCommit: RESULT }),
      reading({ outcome: 'MERGED', mergeCommit: null }),
    ];
    for (const before of befores) {
      for (const attempt of MERGE_ATTEMPTS) {
        for (const after of afters) {
          const outcome = gradeMerge(INTENDED, before, attempt, after);
          expect(MERGE_OUTCOMES, `${before.outcome}/${attempt}/${after?.outcome ?? 'null'}`).toContain(
            outcome,
          );
        }
      }
    }
  });
});

// ── 3. The reading is parsed from what GitHub sends ────────────────────────

describe('parsing one pull request', () => {
  it('refuses every shape it cannot draw a conclusion from', () => {
    const bad: readonly unknown[] = [
      null,
      'a string',
      [],
      {},
      { number: 0, state: 'open', merged: false, head: { sha: HEAD } },
      { number: 1.5, state: 'open', merged: false, head: { sha: HEAD } },
      { number: PR, merged: false, head: { sha: HEAD } },
      { number: PR, state: 7, merged: false, head: { sha: HEAD } },
      { number: PR, state: 'open', head: { sha: HEAD } },
      { number: PR, state: 'open', merged: 'yes', head: { sha: HEAD } },
      { number: PR, state: 'open', merged: false },
      { number: PR, state: 'open', merged: false, head: { sha: 'abc' } },
      { number: PR, state: 'open', merged: false, head: { sha: HEAD.toUpperCase() } },
    ];
    for (const body of bad) {
      const parsed = parsePullRequestRecord(body);
      expect(parsed.ok, JSON.stringify(body)).toBe(false);
    }
  });

  it('reads leniently into null, and never coerces', () => {
    const parsed = parsePullRequestRecord({
      number: PR,
      state: 'open',
      merged: false,
      head: { sha: HEAD },
      base: { ref: '' },
      draft: 'yes',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.record.baseRef).toBeNull();
    expect(parsed.record.draft).toBeNull();
  });

  it('ignores merge_commit_sha while the pull request is open', () => {
    // **The measured trap.** On an OPEN pull request GitHub fills this field
    // with an ephemeral two-parent TEST merge commit that is on no branch — for
    // pull request 60 it read `ecae16f…`, and `main` was behind it. Reading it
    // without first establishing `merged` would report a commit that is on no
    // branch as the result of a merge. Deleting the `merged &&` guard in the
    // parse makes this case fail, which is the whole reason it is a case.
    const open = parsePullRequestRecord({
      number: PR,
      state: 'open',
      merged: false,
      head: { sha: HEAD },
      base: { ref: BASE },
      draft: false,
      merge_commit_sha: RESULT,
    });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect(open.record.mergeCommitSha).toBeNull();

    // And it is read once the pull request really is merged.
    const merged = parsePullRequestRecord({
      number: PR,
      state: 'closed',
      merged: true,
      head: { sha: HEAD },
      base: { ref: BASE },
      draft: false,
      merge_commit_sha: RESULT,
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.record.mergeCommitSha).toBe(RESULT);
  });

  it('maps state and merged to one word, and fails closed on a word it has never seen', async () => {
    const cases: readonly [string, boolean, MergeReading['outcome']][] = [
      ['open', false, 'OPEN'],
      ['closed', false, 'CLOSED_UNMERGED'],
      ['closed', true, 'MERGED'],
      // Measured, GitHub reports `merged` on the document itself, so a merged
      // pull request that still said `open` would be a shape this build has
      // never seen. It is read as merged, because `merged` is the field that
      // answers the question.
      ['open', true, 'MERGED'],
      // A third state word from a future API is not read as either of the two.
      ['locked', false, 'UNKNOWN'],
      ['', false, 'UNKNOWN'],
    ];
    for (const [state, merged, expected] of cases) {
      const r = reads([prBody({ state, merged, mergeCommit: merged ? RESULT : null })]);
      const out = await readPullRequestByNumber(subjectOf(), PR, {
        runner: r.runner,
        envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
      });
      expect(out.ok, `${state}/${String(merged)}`).toBe(true);
      if (!out.ok) continue;
      expect(out.reading.outcome, `${state}/${String(merged)}`).toBe(expected);
      if (expected === 'UNKNOWN') {
        // A reading this build cannot classify carries nothing about the pull
        // request either, so a consumer cannot be tempted to use the fields.
        expect(out.reading.number).toBeNull();
        expect(out.reading.headSha).toBeNull();
        expect(out.reading.baseRef).toBeNull();
        expect(out.reading.draft).toBeNull();
        expect(out.reading.mergeCommit).toBeNull();
      }
    }
  });

  it('refuses a number it will not put in a request path, before any process', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const r = reads([prBody()]);
      const out = await readPullRequestByNumber(subjectOf(), bad, {
        runner: r.runner,
        envSource: { PATH: '/usr/bin' },
      });
      expect(out.ok, String(bad)).toBe(false);
      if (!out.ok) expect(out.refusal).toBe('SUBJECT_UNUSABLE');
      // The count is the assertion, not the word.
      expect(r.calls, String(bad)).toHaveLength(0);
    }
  });

  it('asks one endpoint, with no parameters at all', async () => {
    const r = reads([prBody()]);
    await readPullRequestByNumber(subjectOf(), PR, {
      runner: r.runner,
      envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
    });
    expect(r.calls).toHaveLength(1);
    const args = r.calls[0] ?? [];
    expect(args).toEqual([
      'api',
      '--hostname',
      'github.com',
      '-X',
      'GET',
      `repos/${IDENTITY.owner}/${IDENTITY.name}/pulls/${String(PR)}`,
    ]);
    // No `-F` at all: this endpoint takes none.
    expect(args).not.toContain('-F');
    expect(pullRequestPath(subjectOf(), PR)).toBe(
      `repos/${IDENTITY.owner}/${IDENTITY.name}/pulls/${String(PR)}`,
    );
  });
});

// ── 4. The authority ───────────────────────────────────────────────────────

describe('the merge authority', () => {
  it('binds all eight fields, and reads them back once', () => {
    const grant = grantOf();
    expect(isMergeGrant(grant)).toBe(true);
    const claimed = claimMerge(grant);
    expect(claimed).toEqual(subjectFacts());
    // One-shot: the accessor that reveals the facts consumes the artefact.
    expect(claimMerge(grant)).toBeNull();
  });

  it('refuses every input it cannot vouch for', () => {
    const target = subjectOf();
    const refused: readonly [string, Partial<MergeIntent>][] = [
      ['an empty task id', { taskId: '' }],
      ['a task id outside the grammar', { taskId: 'not a task id' }],
      ['a zero pull request', { pullRequestNumber: 0 }],
      ['a negative pull request', { pullRequestNumber: -1 }],
      ['a fractional pull request', { pullRequestNumber: 1.5 }],
      ['NaN', { pullRequestNumber: Number.NaN }],
      ['an unsafe integer', { pullRequestNumber: Number.MAX_SAFE_INTEGER + 2 }],
      ['a base Git will not accept', { baseRef: 'a..b' }],
      ['a base with a lock suffix', { baseRef: 'x.lock' }],
      ['a base that is @', { baseRef: '@' }],
      ['an empty base', { baseRef: '' }],
      ['the merge method', { mergeMethod: 'merge' }],
      ['the rebase method', { mergeMethod: 'rebase' }],
      ['an empty method', { mergeMethod: '' }],
      ['a shouted method', { mergeMethod: 'SQUASH' }],
    ];
    for (const [name, over] of refused) {
      expect(mintMergeGrant(target, intentOf(over)), name).toBeNull();
    }
  });

  it('refuses a subject it cannot address', () => {
    // The commit is SENT here, unlike slice 6's, so its grammar is load-bearing
    // in a way that one's was not: measured, the endpoint answers 422 for
    // anything that is not exactly forty lowercase hex digits.
    for (const commit of ['a'.repeat(64), HEAD.toUpperCase(), HEAD.slice(0, 7), '']) {
      const fake = { ...subjectOf(), commit } as ObservationSubject;
      expect(mintMergeGrant(fake, intentOf()), commit || '(empty)').toBeNull();
    }
    for (const bad of [{ owner: '' }, { name: '' }, { owner: 'a/b' }, { host: 'gitlab.com' }]) {
      const fake = { ...subjectOf(), ...bad } as ObservationSubject;
      expect(mintMergeGrant(fake, intentOf()), JSON.stringify(bad)).toBeNull();
    }
  });

  it('offers exactly one merge method, and it is the repository convention', () => {
    // Measured on M4XD4B0ZZ/AgentOrchestrator: every merge on `main` from #56 to
    // #59 is a single-parent commit whose parent is the previous pull request's
    // merge_commit_sha, and #59 turned seven branch commits into one.
    expect([...MERGE_METHODS]).toEqual(['squash']);
    expect(DELIVERY_MERGE_METHOD).toBe('squash');
  });

  it('refuses a forgery that carries every correct field', async () => {
    const plain = { ...subjectFacts() } as unknown as MergeGrant;
    expect(isMergeGrant(plain)).toBe(false);
    expect(claimMerge(plain)).toBeNull();

    const real = grantOf();
    const viaPrototype = Object.create(Object.getPrototypeOf(real) as object) as MergeGrant;
    expect(isMergeGrant(viaPrototype)).toBe(false);

    const m = merges();
    const r = reads([prBody()]);
    const out = await mergePullRequest(
      viaPrototype,
      seamsOf({ merger: m.runner, reader: r.runner }),
    );
    expect(out.outcome).toBe('AUTHORITY_REFUSED');
    // Nothing was contacted at all — not even a read. The count is the
    // assertion, not the word.
    expect(m.calls).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });

  it('closes the constructor route and freezes both objects', () => {
    const real = grantOf();
    const proto = Object.getPrototypeOf(real) as object;
    expect(Object.prototype.hasOwnProperty.call(proto, 'constructor')).toBe(false);
    expect(Object.isFrozen(proto)).toBe(true);
    expect(Object.isFrozen(MergeGrantClass)).toBe(true);
  });

  it('cannot be flipped by replacing WeakSet.prototype.has', () => {
    const original = WeakSet.prototype.has;
    try {
      (WeakSet.prototype as unknown as { has: unknown }).has = () => true;
      expect(isMergeGrant({})).toBe(false);
    } finally {
      (WeakSet.prototype as unknown as { has: unknown }).has = original;
    }
  });

  it('refuses a second use, having contacted nothing', async () => {
    const grant = grantOf();
    const first = merges();
    await mergePullRequest(
      grant,
      seamsOf({
        merger: first.runner,
        reader: reads([
          prBody(),
          prBody({ state: 'closed', merged: true, mergeCommit: RESULT }),
        ]).runner,
      }),
    );
    expect(first.calls).toHaveLength(1);

    const second = merges();
    const secondReads = reads([prBody()]);
    const out = await mergePullRequest(
      grant,
      seamsOf({ merger: second.runner, reader: secondReads.runner }),
    );
    expect(out.outcome).toBe('AUTHORITY_REFUSED');
    expect(second.calls).toHaveLength(0);
    expect(secondReads.calls).toHaveLength(0);
  });
});

// ── 5. The three delivery authorities cannot substitute ────────────────────

describe('publication, creation and merge are three different types', () => {
  function publicationGrant() {
    const g = mintHeadPublicationGrant(subjectOf(), REMOTE, REF);
    if (g === null) throw new Error('fixture publication grant refused');
    return g;
  }

  function creationGrant() {
    const content = composePullRequestContent({
      taskId: TASK,
      headRef: REF,
      headCommit: HEAD,
      baseRef: BASE,
    });
    const g = mintPullRequestCreationGrant(subjectOf(), {
      taskId: TASK,
      remoteName: REMOTE,
      headRef: REF,
      baseRef: BASE,
      draft: AO_PULL_REQUEST_DRAFT,
      title: content.title,
      body: content.body,
    });
    if (g === null) throw new Error('fixture creation grant refused');
    return g;
  }

  it('refuses every substitution at compile time, and again at runtime', async () => {
    const merge = grantOf();
    const publication = publicationGrant();
    const creation = creationGrant();

    const m = merges();
    const r = reads([prBody()]);

    // @ts-expect-error a merge authority is not a publication authority
    const a = publishDeliveryHead(merge, ROOT, { recheck: async () => null });
    // @ts-expect-error a merge authority is not a pull-request authority
    const b = createPullRequest(merge, ROOT, {
      recheck: async () => null,
      reader: r.runner,
      mutator: async () => commandResult(),
      envSource: {},
    });
    // @ts-expect-error a publication authority is not a merge authority
    const c = mergePullRequest(publication, seamsOf({ merger: m.runner, reader: r.runner }));
    // @ts-expect-error a pull-request authority is not a merge authority
    const d = mergePullRequest(creation, seamsOf({ merger: m.runner, reader: r.runner }));

    // Each mint owns its own registry, so a value cast past the compiler is
    // refused again at runtime. The two gates are independent, and this is the
    // second one.
    expect((await a).publication).toBe('AUTHORITY_REFUSED');
    expect((await b).creation).toBe('AUTHORITY_REFUSED');
    expect((await c).outcome).toBe('AUTHORITY_REFUSED');
    expect((await d).outcome).toBe('AUTHORITY_REFUSED');
    expect(m.calls).toHaveLength(0);
    expect(r.calls).toHaveLength(0);
  });

  it('does not recognise a sibling artefact as one of its own', () => {
    expect(isMergeGrant(publicationGrant())).toBe(false);
    expect(isMergeGrant(creationGrant())).toBe(false);
    expect(claimMerge(publicationGrant() as unknown as MergeGrant)).toBeNull();
    expect(claimMerge(creationGrant() as unknown as MergeGrant)).toBeNull();
  });
});

// ── 6. The one request vector ──────────────────────────────────────────────

describe('the one merge vector', () => {
  it('is exactly these tokens, and every one is shell-inert', () => {
    const args = mergeRequestArgs(IDENTITY.owner, IDENTITY.name, PR);
    expect([...args]).toEqual([
      'api',
      '--hostname',
      'github.com',
      '-X',
      'PUT',
      `repos/${IDENTITY.owner}/${IDENTITY.name}/pulls/${String(PR)}/merge`,
      '--input',
      '-',
    ]);
    for (const token of args) expect(isShellInertArgument(token), token).toBe(true);
    expect([...FORGE_MERGE_PREFIX]).toEqual(['api', '--hostname', 'github.com', '-X', 'PUT']);
    expect([...FORGE_MERGE_BODY_SOURCE]).toEqual(['--input', '-']);
    expect(mergePath(IDENTITY.owner, IDENTITY.name, PR)).toBe(
      `repos/${IDENTITY.owner}/${IDENTITY.name}/pulls/${String(PR)}/merge`,
    );
  });

  it('sends the expected head and the method, and nothing else', () => {
    const body = mergeRequestBody(subjectFacts());
    expect(body).toBe(`{"sha":"${HEAD}","merge_method":"squash"}`);
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['merge_method', 'sha']);
  });

  it('carries the fence, and the fence is the exact authorised head', () => {
    // **The targeted counter-proof for the whole slice.** Measured against
    // github.com: with `sha` present and stale, the endpoint answers
    // `409 "Head branch was modified"` and merges nothing; with `sha` ABSENT it
    // merges whatever the head holds, and says nothing about the difference.
    // Deleting the field from `mergeRequestBody` therefore removes the only
    // atomic protection this slice has, and it is invisible in every other
    // assertion in this file. This case is what dies.
    const body = JSON.parse(mergeRequestBody(subjectFacts())) as Record<string, unknown>;
    expect(Object.keys(body)).toContain('sha');
    expect(body['sha']).toBe(HEAD);
    // And it is the AUTHORISED head, not any other commit that happens to be in
    // scope: a grant bound to one commit must not send another.
    const other = JSON.parse(
      mergeRequestBody(subjectFacts({ expectedHeadCommit: OTHER })),
    ) as Record<string, unknown>;
    expect(other['sha']).toBe(OTHER);
  });

  it('sends no free text and no title of its own', () => {
    // `commit_title` and `commit_message` are the only fields on this endpoint
    // that would carry free text. Leaving them out means the merge commit's
    // message comes from the repository's own configured convention.
    const body = mergeRequestBody(subjectFacts());
    expect(body).not.toContain('commit_title');
    expect(body).not.toContain('commit_message');
    expect(body).not.toContain(TASK);
    expect(body).not.toContain(BRANCH);
  });

  it('starts no process for a subject it will not address', async () => {
    const cases: readonly [string, MergeSubject][] = [
      ['an unsupported host', subjectFacts({ host: 'gitlab.com' })],
      ['an owner that is not a path segment', subjectFacts({ owner: 'a/b' })],
      ['a commit that is not forty hex', subjectFacts({ expectedHeadCommit: 'a'.repeat(64) })],
      ['a fractional number', subjectFacts({ pullRequestNumber: 1.5 })],
      ['a zero number', subjectFacts({ pullRequestNumber: 0 })],
    ];
    for (const [name, subject] of cases) {
      const m = merges();
      const attempt = await mergePullRequestVia(subject, {
        runner: m.runner,
        envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
      });
      expect(attempt, name).toBe('NOT_ATTEMPTED');
      expect(m.calls, name).toHaveLength(0);
    }
  });

  it('reports NOT_ATTEMPTED for an environment it will not build', async () => {
    const m = merges();
    const attempt = await mergePullRequestVia(subjectFacts(), {
      runner: m.runner,
      // Two spellings of one allow-listed name is what `createProbeEnv` throws on.
      envSource: { Path: '/a', PATH: '/b' },
    });
    expect(attempt).toBe('NOT_ATTEMPTED');
    expect(m.calls).toHaveLength(0);
  });

  it('requires all three conditions before it calls an attempt completed', async () => {
    const good = { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' };
    expect(
      await mergePullRequestVia(subjectFacts(), { runner: merges().runner, envSource: good }),
    ).toBe('COMPLETED');

    const failing: readonly [string, Partial<CommandResult>][] = [
      ['a process that did not complete', { outcome: 'TIMED_OUT', exitCode: null }],
      ['a non-zero exit', { exitCode: 1 }],
      // A partly delivered body is a request that may have carried NO `sha`,
      // which is a request with no fence. It is the condition that matters most.
      ['a body whose delivery failed', { stdinDelivery: 'FAILED' as const }],
      ['a body whose fate was never confirmed', { stdinDelivery: 'UNCONFIRMED' as const }],
    ];
    for (const [name, over] of failing) {
      const m = merges(over);
      const attempt = await mergePullRequestVia(subjectFacts(), {
        runner: m.runner,
        envSource: good,
      });
      expect(attempt, name).toBe('FAILED');
      // It still ran: `FAILED` does not mean "no effect", it means "not
      // established", which is what the reading afterwards is for.
      expect(m.calls, name).toHaveLength(1);
    }
  });

  it('names its budgets, and the deadline is longer than a read', () => {
    expect(MERGE_TIMEOUT_MS).toBe(60_000);
    expect(MERGE_MAX_RESPONSE_BYTES).toBe(4_194_304);
    expect(typeof createForgeMergeRunner()).toBe('function');
  });
});

// ── 7. The orchestration: observe, at most once, observe ───────────────────

describe('merging one pull request', () => {
  it('merges when it is open at the authorised head, and asks exactly once', async () => {
    const m = merges();
    const r = reads([prBody(), prBody({ state: 'closed', merged: true, mergeCommit: RESULT })]);
    const out = await mergePullRequest(grantOf(), seamsOf({ merger: m.runner, reader: r.runner }));

    expect(out.outcome).toBe('MERGED');
    expect(out.attempt).toBe('COMPLETED');
    expect(out.before?.outcome).toBe('OPEN');
    expect(out.after?.outcome).toBe('MERGED');
    // The resulting commit came from the reading afterwards, and it is the one
    // value the next slice needs.
    expect(out.mergeCommit).toBe(RESULT);

    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.stdin).toBe(`{"sha":"${HEAD}","merge_method":"squash"}`);
    // Two readings, one before and one after, and both about the same pull
    // request BY NUMBER.
    expect(r.calls).toHaveLength(2);
    for (const call of r.calls) {
      expect(call.join(' ')).toContain(`pulls/${String(PR)}`);
      expect(call.join(' ')).not.toContain('/merge');
    }
  });

  it('sends nothing when the pull request is already merged', async () => {
    // The whole idempotency claim, and the reason the pre-reading is a
    // precondition rather than an optimisation: measured, a second request
    // against a merged pull request answers 200 merged=true and would prove
    // nothing. So none is sent.
    const m = merges();
    const r = reads([prBody({ state: 'closed', merged: true, mergeCommit: RESULT })]);
    const out = await mergePullRequest(grantOf(), seamsOf({ merger: m.runner, reader: r.runner }));

    expect(out.outcome).toBe('ALREADY_MERGED');
    expect(out.attempt).toBe('NOT_ATTEMPTED');
    expect(m.calls).toHaveLength(0);
    // One reading, not two: nothing was attempted, so there is nothing to
    // observe the effect of.
    expect(r.calls).toHaveLength(1);
    // And the commit identity is still reported, so a re-run gets it without a
    // mutation.
    expect(out.mergeCommit).toBe(RESULT);
  });

  it('refuses from the pre-reading, and each refusal costs no request', async () => {
    const cases: readonly [string, string, MergeOutcome][] = [
      ['a closed, unmerged pull request', prBody({ state: 'closed', merged: false }), 'PULL_REQUEST_NOT_OPEN'],
      ['a draft', prBody({ draft: true }), 'DRAFT_REFUSED'],
      ['a head that moved', prBody({ sha: OTHER }), 'HEAD_MOVED'],
      ['another base', prBody({ base: 'release' }), 'WRONG_BASE'],
      ['another pull request', prBody({ number: 61 }), 'PULL_REQUEST_STATE_UNKNOWN'],
      ['a base the forge did not report', prBody({ base: null }), 'PULL_REQUEST_STATE_UNKNOWN'],
      ['a draft state the forge did not report', prBody({ draft: null }), 'PULL_REQUEST_STATE_UNKNOWN'],
      ['a state word this build has never seen', prBody({ state: 'locked' }), 'PULL_REQUEST_STATE_UNKNOWN'],
      ['a malformed answer', '{"nope":1}', 'PULL_REQUEST_STATE_UNKNOWN'],
    ];
    for (const [name, page, expected] of cases) {
      const m = merges();
      const r = reads([page]);
      const out = await mergePullRequest(grantOf(), seamsOf({ merger: m.runner, reader: r.runner }));
      expect(out.outcome, name).toBe(expected);
      expect(out.attempt, name).toBe('NOT_ATTEMPTED');
      expect(m.calls, name).toHaveLength(0);
      expect(out.mergeCommit, name).toBeNull();
    }
  });

  it('refuses a forge it could not read at all, and attempts nothing', async () => {
    const m = merges();
    const r = reads([null]);
    const out = await mergePullRequest(grantOf(), seamsOf({ merger: m.runner, reader: r.runner }));
    expect(out.outcome).toBe('PULL_REQUEST_STATE_UNKNOWN');
    expect(m.calls).toHaveLength(0);
  });

  it('refuses a subject that moved, having contacted nothing', async () => {
    const moved: readonly [string, MergeSubject | null][] = [
      ['a subject that could not be re-established', null],
      ['a different task', subjectFacts({ taskId: 'T-002' })],
      ['a different repository', subjectFacts({ name: 'Other' })],
      ['a different owner', subjectFacts({ owner: 'someone-else' })],
      ['a different pull request', subjectFacts({ pullRequestNumber: 61 })],
      ['a different head', subjectFacts({ expectedHeadCommit: OTHER })],
      ['a different base', subjectFacts({ baseRef: 'release' })],
    ];
    for (const [name, still] of moved) {
      const m = merges();
      const r = reads([prBody()]);
      const out = await mergePullRequest(
        grantOf(),
        seamsOf({ merger: m.runner, reader: r.runner, recheck: async () => still }),
      );
      expect(out.outcome, name).toBe('SUBJECT_CHANGED');
      expect(m.calls, name).toHaveLength(0);
      expect(r.calls, name).toHaveLength(0);
    }
  });

  it('reads again whatever the transport said, and never retries', async () => {
    const cases: readonly [string, Partial<CommandResult>, readonly (string | null)[], MergeOutcome][] =
      [
        [
          'a request that failed and left it open',
          { exitCode: 1 },
          [prBody(), prBody()],
          'EFFECT_NOT_ESTABLISHED',
        ],
        [
          'a request that failed while the forge committed it',
          { exitCode: 1 },
          [prBody(), prBody({ state: 'closed', merged: true, mergeCommit: RESULT })],
          'CONVERGED_AFTER_UNCERTAIN_EFFECT',
        ],
        [
          'a timeout while the forge committed it',
          { outcome: 'TIMED_OUT', exitCode: null },
          [prBody(), prBody({ state: 'closed', merged: true, mergeCommit: RESULT })],
          'CONVERGED_AFTER_UNCERTAIN_EFFECT',
        ],
        [
          'a success the reading afterwards does not agree with',
          {},
          [prBody(), prBody()],
          'OUTCOME_AMBIGUOUS',
        ],
        [
          'a reading afterwards that could not be completed',
          {},
          [prBody(), null],
          'OBSERVATION_UNAVAILABLE',
        ],
        [
          'a merge that landed on another base',
          {},
          [prBody(), prBody({ state: 'closed', merged: true, mergeCommit: RESULT, base: 'release' })],
          'POSTCONDITION_MISMATCH',
        ],
        [
          'a merge whose resulting commit was not reported',
          {},
          [prBody(), prBody({ state: 'closed', merged: true, mergeCommit: null })],
          'OUTCOME_AMBIGUOUS',
        ],
        [
          'a pull request closed under it',
          {},
          [prBody(), prBody({ state: 'closed', merged: false })],
          'POSTCONDITION_MISMATCH',
        ],
      ];
    for (const [name, over, pages, expected] of cases) {
      const m = merges(over);
      const r = reads(pages);
      const out = await mergePullRequest(grantOf(), seamsOf({ merger: m.runner, reader: r.runner }));
      expect(out.outcome, name).toBe(expected);
      // **At most one, on every path.** There is no retry after a timeout, a
      // lost boundary, a malformed answer or an unexpected exit, and the reason
      // is sharper here than in either sibling: a second request against a
      // merged pull request answers success and proves nothing.
      expect(m.calls, name).toHaveLength(1);
      // And a reading was taken afterwards regardless.
      expect(r.calls, name).toHaveLength(2);
    }
  });

  it('never reports a merge commit under a member that did not establish one', async () => {
    const pages: readonly (readonly (string | null)[])[] = [
      [prBody(), prBody()],
      [prBody(), null],
      [prBody(), prBody({ state: 'closed', merged: false })],
      [prBody(), prBody({ state: 'closed', merged: true, mergeCommit: RESULT, base: 'release' })],
    ];
    for (const p of pages) {
      const out = await mergePullRequest(
        grantOf(),
        seamsOf({ merger: merges().runner, reader: reads(p).runner }),
      );
      expect(mergeIsEstablished(out.outcome), out.outcome).toBe(false);
      expect(out.mergeCommit, out.outcome).toBeNull();
    }
  });

  it('performs at most one merge request on every reachable path', async () => {
    // A sweep rather than a claim. Every fixture in this file's vocabulary is
    // driven, and the invariant asserted is the same one each time.
    const pageSets: readonly (readonly (string | null)[])[] = [
      [prBody()],
      [null],
      [prBody({ draft: true })],
      [prBody({ sha: OTHER })],
      [prBody({ base: 'release' })],
      [prBody({ state: 'closed', merged: false })],
      [prBody({ state: 'closed', merged: true, mergeCommit: RESULT })],
      [prBody(), prBody()],
      [prBody(), null],
      [prBody(), prBody({ state: 'closed', merged: true, mergeCommit: RESULT })],
    ];
    for (const pages of pageSets) {
      for (const over of [{}, { exitCode: 1 }, { outcome: 'TIMED_OUT' as const, exitCode: null }]) {
        const m = merges(over);
        await mergePullRequest(
          grantOf(),
          seamsOf({ merger: m.runner, reader: reads(pages).runner }),
        );
        expect(m.calls.length, JSON.stringify({ pages: pages.length, over })).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ── 8. The command ladder ──────────────────────────────────────────────────

describe('the delivery command merges only when asked, and only when it may', () => {
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

  /** The locator answer that makes the decision `PULL_REQUEST_MATCHED_CHECKS_SUCCESS`. */
  function matchedPulls(): string {
    return JSON.stringify([
      { number: PR, state: 'open', head: { sha: HEAD }, base: { ref: BASE }, draft: false },
    ]);
  }

  async function run(
    argv: readonly string[],
    over: {
      readonly pulls?: string;
      readonly prPages?: readonly (string | null)[];
      readonly merger?: Merges;
      readonly state?: StateLoadResult;
      readonly delivery?: ResolvedDelivery;
      readonly checkConclusion?: string;
    } = {},
  ): Promise<{ out: string; merger: Merges; prReads: number; runtimeAfter: readonly string[] }> {
    const root = mkdtempSync(join(tmpdir(), 'ao-v407-'));
    mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
    const m = over.merger ?? merges();
    let prReads = 0;
    const prPages = over.prPages ?? [
      prBody(),
      prBody({ state: 'closed', merged: true, mergeCommit: RESULT }),
    ];
    const reader: ForgeCommandRunner = async (_c, args) => {
      const path = args.find((a) => a.startsWith('repos/')) ?? '';
      // The merge path's own reading, addressed by NUMBER. Distinguished from
      // the locator by shape rather than by order, because the two are asked by
      // different modules and their order is not this fixture's to assume.
      if (/\/pulls\/\d+$/.test(path)) {
        const page = prPages[Math.min(prReads, prPages.length - 1)] ?? null;
        prReads += 1;
        if (page === null) return commandResult({ exitCode: 1, stdout: '{}' });
        return commandResult({ stdout: page });
      }
      if (path.endsWith('/pulls')) {
        return commandResult({ stdout: over.pulls ?? matchedPulls() });
      }
      if (path.endsWith('/check-runs')) {
        return commandResult({
          stdout: JSON.stringify({
            total_count: 1,
            check_runs: [
              { head_sha: HEAD, status: 'completed', conclusion: over.checkConclusion ?? 'success' },
            ],
          }),
        });
      }
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
            repository: { id: 'repo', root, delivery: over.delivery ?? DECLARED },
          }) as unknown as Awaited<
            ReturnType<typeof import('../src/repo/resolve-repository.js').resolveRepository>
          >,
        loadTaskState: () => over.state ?? taskState(),
        runner: reader,
        mergeRunner: m.runner,
        creationRunner: async () => commandResult(),
        publicationRunner: (async () => commandResult()) as unknown as GitPublicationRunner,
        envSource: { PATH: '/usr/bin', PATHEXT: '.EXE', APPDATA: 'C:\\x' },
        now: () => new Date('2026-08-24T00:00:00.000Z'),
        checkIgnored: async () => 'IGNORED' as never,
      });
      await program.parseAsync([
        'node',
        'x',
        'delivery',
        '--repository',
        root,
        '--task',
        TASK,
        ...argv,
      ]);
    } finally {
      write.mockRestore();
    }
    const runtimeAfter = readdirSync(join(root, '.agent-orchestrator', 'runtime'));
    rmSync(root, { recursive: true, force: true });
    return { out: chunks.join(''), merger: m, prReads, runtimeAfter };
  }

  it('merges when everything holds, and reports the commit it read back', async () => {
    const r = await run(['--observe', '--decide', '--merge-pr', '--attended']);
    expect(r.out).toContain('Merge        : MERGED');
    expect(r.out).toContain(`Merge commit : ${RESULT}`);
    expect(r.merger.calls).toHaveLength(1);
    expect(r.merger.calls[0]?.stdin).toBe(`{"sha":"${HEAD}","merge_method":"squash"}`);
    expect(r.prReads).toBe(2);
  });

  it('sends nothing without --attended', async () => {
    const r = await run(['--observe', '--decide', '--merge-pr']);
    expect(r.out).toContain('Merge        : OPERATOR_ABSENT');
    expect(r.merger.calls).toHaveLength(0);
    // And it never even read the pull request: the refusal is before contact.
    expect(r.prReads).toBe(0);
  });

  it('sends nothing without a fresh decision', async () => {
    for (const argv of [
      ['--merge-pr', '--attended'],
      ['--observe', '--merge-pr', '--attended'],
      ['--decide', '--merge-pr', '--attended'],
    ]) {
      const r = await run(argv);
      expect(r.out, argv.join(' ')).toContain('Merge        : DECISION_NOT_SUCCESS');
      expect(r.merger.calls, argv.join(' ')).toHaveLength(0);
      expect(r.prReads, argv.join(' ')).toBe(0);
    }
  });

  it('admits exactly one decision, and it is the positive one', () => {
    // Enumerated rather than partitioned, and the gate is a single member
    // rather than slice 6's five-member set: a merge has one precondition worth
    // naming. What makes a NEW decision member safe is that it is simply not
    // this one, which is the fail-closed direction.
    const admitted = DELIVERY_DECISIONS.filter((d) => d === POSITIVE_DELIVERY_DECISION);
    expect(admitted).toEqual(['PULL_REQUEST_MATCHED_CHECKS_SUCCESS']);
    expect(DELIVERY_DECISIONS.length).toBeGreaterThan(1);
  });

  it('refuses a decision that is not success, whatever else is true', async () => {
    // Driven through the real ladder rather than asserted about the set: a
    // failing check produces `CHECKS_FAILED`, and a locator that matches
    // nothing produces `PULL_REQUEST_REQUIRED` — the decision slice 6 merges
    // from, and the one this slice must not.
    const failing = await run(['--observe', '--decide', '--merge-pr', '--attended'], {
      checkConclusion: 'failure',
    });
    expect(failing.out).toContain('Merge        : DECISION_NOT_SUCCESS');
    expect(failing.merger.calls).toHaveLength(0);

    const noPull = await run(['--observe', '--decide', '--merge-pr', '--attended'], {
      pulls: '[]',
    });
    expect(noPull.out).toContain('Merge        : DECISION_NOT_SUCCESS');
    expect(noPull.merger.calls).toHaveLength(0);
  });

  it('refuses a task that is not finished', async () => {
    const r = await run(['--observe', '--decide', '--merge-pr', '--attended'], {
      state: taskState({ state: 'REVIEWING' }),
    });
    expect(r.out).toContain('Merge        : TASK_NOT_READY');
    expect(r.merger.calls).toHaveLength(0);
  });

  it('refuses a base branch it will not compare', async () => {
    const r = await run(['--observe', '--decide', '--merge-pr', '--attended'], {
      state: taskState({ baseBranch: 'a..b' }),
    });
    expect(r.out).toContain('Merge        : SUBJECT_NOT_ESTABLISHED');
    expect(r.merger.calls).toHaveLength(0);
  });

  it('merges nothing for any invocation that did not ask for it', async () => {
    // The structural claim of the slice: no flag chains into a merge. Every
    // combination of the other five, and none of them sends a request.
    const combos: readonly string[][] = [
      [],
      ['--observe'],
      ['--observe', '--decide'],
      ['--observe', '--record'],
      ['--observe', '--decide', '--attended'],
      ['--observe', '--decide', '--publish-head', '--attended'],
      ['--observe', '--decide', '--create-pr', '--attended'],
      ['--observe', '--decide', '--publish-head', '--create-pr', '--attended'],
    ];
    for (const argv of combos) {
      const r = await run(argv);
      expect(r.merger.calls, argv.join(' ') || '(no flags)').toHaveLength(0);
      expect(r.out, argv.join(' ') || '(no flags)').not.toContain('Merge        :');
    }
  });

  it('prints the merge trailer only when a merge was attempted', async () => {
    // The trailer's TEXT is pinned in section 9. This is the other half, and
    // the half `render-delivery-observation.ts` records as having shipped false
    // once already: a sentence about what did not happen has to be printed on
    // exactly the runs it is about. A refusal that contacted nothing is a
    // read-only run of a flag that could have changed something and did not.
    const merged = await run(['--observe', '--decide', '--merge-pr', '--attended']);
    expect(merged.out).toContain(MERGE_TRAILER);

    const refused = await run(['--observe', '--decide', '--merge-pr']);
    expect(refused.out).not.toContain(MERGE_TRAILER);
    expect(refused.merger.calls).toHaveLength(0);

    // And an invocation that never asked prints neither the block nor the
    // sentence.
    const other = await run(['--observe', '--decide']);
    expect(other.out).not.toContain(MERGE_TRAILER);
    expect(other.out).not.toContain('Merge        :');
  });

  it('does not print the merge trailer beside another act that was attempted', () => {
    // The case above cannot reach this, and a counter-proof said so: on a run
    // that attempted nothing the renderer takes the read-only branch and never
    // consults `mergeAttempted` at all, so making the push unconditional
    // survived it. The branch that matters is the one where SOMETHING was
    // attempted and the merge was not — there, a trailer pushed unconditionally
    // would tell an operator a merge was made on a run that refused one.
    //
    // Driven at the renderer rather than through the command, because reaching
    // that branch through the ladder needs a publication or creation that
    // really attempted, and this asserts the renderer's rule rather than the
    // ladder's.
    const view = {
      repositoryId: 'repo',
      repositoryRoot: ROOT,
      taskId: TASK,
      subject: { ok: false as const, refusal: 'NO_DELIVERY_TARGET' },
      observation: null,
      conclusion: 'NOT_REQUESTED',
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
      merge: {
        result: {
          outcome: 'OPERATOR_ABSENT',
          before: null,
          attempt: 'NOT_ATTEMPTED',
          after: null,
          mergeCommit: null,
        },
        pullRequestNumber: null,
        baseRef: BASE,
      },
    } as unknown as Parameters<typeof renderDeliveryObservation>[0];

    const out = renderDeliveryObservation(view);
    // The publication really was attempted, so the report is not read-only...
    expect(out).toContain('Not read-only.');
    // ...and the merge block is printed, because the flag was given...
    expect(out).toContain('Merge        : OPERATOR_ABSENT');
    // ...but the sentence about a merge having happened is not.
    expect(out).not.toContain(MERGE_TRAILER);
  });

  it('prints the resulting commit only where a reading established one', async () => {
    // `Merge commit` is the line an operator would act on, and the one the next
    // slice needs. It must not appear under an outcome that did not establish a
    // merge — the defect a case in section 7 found in the result object.
    const merged = await run(['--observe', '--decide', '--merge-pr', '--attended']);
    expect(merged.out).toContain(`Merge commit : ${RESULT}`);

    const openAfter = await run(['--observe', '--decide', '--merge-pr', '--attended'], {
      prPages: [prBody(), prBody()],
    });
    expect(openAfter.out).toContain('Merge        : OUTCOME_AMBIGUOUS');
    expect(openAfter.out).not.toContain('Merge commit :');
    // The reading is still shown whole, so the fact is not hidden — only the
    // line that would attribute it to this delivery is withheld.
    expect(openAfter.out).toContain('Forge after  : OPEN at');
  });

  it('writes nothing beside the task, on a run that really merged', async () => {
    // The BEHAVIOURAL pin for "a merge writes no task state". The code scan in
    // section 11 proves no module names a writer; this proves a run that took
    // the whole ladder and sent a real merge request left the task's runtime
    // directory exactly as it found it.
    //
    // `run()` collected this from the start and no case read it — a review found
    // the evidence gathered and discarded, which is the shape slice 6 recorded
    // when its own task-state case inspected a directory the harness never
    // used. It is read here, on the merging path, where it means something.
    const merged = await run(['--observe', '--decide', '--merge-pr', '--attended']);
    expect(merged.out).toContain('Merge        : MERGED');
    expect(merged.merger.calls).toHaveLength(1);
    expect(merged.runtimeAfter).toEqual([]);

    // And with `--record`, which is the one flag that writes anything at all,
    // the directory is not empty — so the assertion above is a measurement of
    // this run rather than of a directory nothing ever writes to.
    const recorded = await run(['--observe', '--record', '--decide', '--merge-pr', '--attended']);
    expect(recorded.runtimeAfter.length).toBeGreaterThan(0);
  });

  it('registers the option set exactly, and none of the words this build refuses', () => {
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    const longs = (delivery?.options ?? []).map((o) => o.long ?? '').sort();
    // Enumerated. This is what replaced the `merge` entry in the sibling files'
    // word ban: a NEW flag cannot arrive unnamed, whatever it is called.
    //
    // The list is the whole statement, and it states **no count in prose**.
    // Two earlier versions of this comment did — "a sixth", then "ten options
    // … three of them are forge mutations" — and both went stale the moment a
    // flag was added, which is the shape a number beside an enforced list
    // always has. V4 slice 8 added `--reconcile-merge` and V4 slice 9 added
    // `--verify-merge`; each had to be declared here rather than slipped in,
    // which is the property this case exists for.
    //
    // A flag arriving here is not evidence about what it *does*. Neither of
    // the two additions is a forge mutation — one reads github.com and writes
    // locally, the other contacts nothing — and that is measured by the
    // effect-boundary cases in `tests/v4-08-…` and `tests/v4-09-…` rather than
    // inferred from this list. V4 slice 10 added `--conclude-delivery`, whose
    // own boundary — no forge, no Git history, no lease, no task state — is
    // measured in `tests/v4-10-…`.
    expect(longs).toEqual(
      [
        '--attended',
        '--conclude-delivery',
        '--create-pr',
        '--decide',
        '--drive',
        '--merge-pr',
        '--observe',
        '--publish-head',
        '--reconcile-merge',
        '--record',
        '--repository',
        '--task',
        '--verify-merge',
      ].sort(),
    );
    // And the five words that name an override of a refusal stay forbidden.
    for (const long of longs) {
      expect(long, long).not.toMatch(/force|unattended|adopt|takeover|steal/i);
    }
  });

  it('registers the sentence that was pinned, not a copy', () => {
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    const option = (delivery?.options ?? []).find((o) => o.long === '--merge-pr');
    expect(option?.description).toBe(MERGE_PR_OPTION_DESCRIPTION);
  });

  it('says what it does and does not establish', () => {
    expect(MERGE_PR_OPTION_DESCRIPTION).toContain('Requires --attended');
    expect(MERGE_PR_OPTION_DESCRIPTION).toContain('PULL_REQUEST_MATCHED_CHECKS_SUCCESS');
    expect(MERGE_PR_OPTION_DESCRIPTION).toContain('This is not merge eligibility');
    expect(MERGE_PR_OPTION_DESCRIPTION).toContain('GitHub is what enforces them');
    expect(MERGE_PR_OPTION_DESCRIPTION).toContain('never one you name');
    expect(MERGE_PR_OPTION_DESCRIPTION).toContain('still READY_FOR_PR');
    expect(ATTENDED_OPTION_DESCRIPTION).toContain('--publish-head, --create-pr and --merge-pr');
    expect(ATTENDED_OPTION_DESCRIPTION).toContain('no unattended merge');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('--merge-pr');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('not merge eligibility');
  });
});

// ── 9. The report ──────────────────────────────────────────────────────────

describe('the merge report', () => {
  it('says exactly this about what a merge is not', () => {
    expect(MERGE_TRAILER).toContain('by squash, into the base branch named above');
    // The qualifier is the finding, not decoration: measured, the `sha` fence
    // does not apply once the pull request is merged, so an unconditional
    // sentence is false in exactly the race `L-V4-07-4` carries — and that race
    // is one of the cases in which this trailer gets printed.
    expect(MERGE_TRAILER).toContain('while the pull request is open GitHub refuses it');
    // And the branch-deletion clause is scoped to what this build does, because
    // `delete_branch_on_merge` is a repository setting that deletes the head
    // branch as a consequence of this very request. It is false on this
    // repository today; it is not false everywhere.
    expect(MERGE_TRAILER).toContain(
      'delete_branch_on_merge set will have the head branch removed by this merge',
    );
    // And the sentence no longer opens by claiming exactly one thing changed,
    // which the clause above contradicts on such a repository. It says what this
    // build ASKED for, which is the bounded claim.
    expect(MERGE_TRAILER).toContain('This build asked for exactly one change');
    expect(MERGE_TRAILER).not.toContain('changed exactly one thing');
    expect(MERGE_TRAILER).toContain('it enabled no auto-merge');
    expect(MERGE_TRAILER).toContain('this task is still READY_FOR_PR');
    expect(MERGE_TRAILER).toContain('did not establish that the pull request was eligible to merge');
  });
});

// ── 10. The surface ────────────────────────────────────────────────────────

describe('what the merging surface is', () => {
  const SURFACE = [
    ...walk('src/deliver'),
    // Derived rather than named, so a delivery module added to `src/cli/`
    // joins this surface without anybody remembering to. V4 slice 11 moved the
    // three mint call sites into `delivery-steps.ts` and added
    // `delivery-driver.ts` beside it; under the old hand-written pair both would
    // have escaped every assertion below.
    ...walk('src/cli').filter((file) => file.includes('delivery')),
  ].sort();

  const MERGER = 'src/deliver/github-pull-request-merger.ts';
  const DECLARES = 'src/deliver/internal/merge-grant.ts';

  it('sends a PUT from exactly one module, at exactly one endpoint', () => {
    expect(SURFACE, 'the merger must be on the surface being swept').toContain(MERGER);
    const putters = SURFACE.filter((f) =>
      /['"]-X['"]\s*,\s*['"]PUT['"]|-X\s*PUT/.test(codeOnly(f)),
    );
    expect(putters).toEqual([MERGER]);
    const code = codeOnly(MERGER);
    expect(code).toContain('/merge`');
    // And that module names one sub-resource and no other.
    expect(code).not.toMatch(/\/reviews|\/comments|\/labels|\/requested_reviewers|\/merge-async/);
  });

  it('names no deferred merge anywhere on the surface', () => {
    for (const file of SURFACE) {
      const code = codeOnly(file);
      expect(code.replace(/\s+/g, '').length, file).toBeGreaterThan(30);
      expect(code, file).not.toMatch(/\benableAutoMerge\b|\bauto_merge\b|\bmerge_queue\b/);
      expect(code, file).not.toMatch(/merge-async/);
      expect(code, file).not.toMatch(/gh pr (merge|edit|close|review|comment|ready)/);
      expect(code, file).not.toMatch(/['"]--auto['"]|--squash\b/);
      expect(code, file).not.toMatch(
        /['"]-X['"]\s*,\s*['"](PATCH|DELETE)['"]|-X\s*(PATCH|DELETE)/,
      );
    }
    // False-negative guard: each pattern matches the thing it is aimed at.
    expect('await enableAutoMerge(pr)').toMatch(/\benableAutoMerge\b/);
    expect("['api', '-X', 'DELETE', p]").toMatch(/['"]-X['"]\s*,\s*['"](PATCH|DELETE)['"]/);
    expect('gh pr merge --squash').toMatch(/gh pr (merge|edit|close|review|comment|ready)/);
  });

  it('imports the mint in four modules and calls it in exactly one', () => {
    const all = walk('src');
    const importsTheMint =
      /(?:from|import)\s*\(?\s*['"`][^'"`]*internal\/merge-grant\.js['"`]/;
    const importers = all
      .filter((f) => importsTheMint.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(/\\/g, '/'))
      .sort();
    // The list, and not a count of it. Slice 6's copy of this sentence claimed
    // "one" until a review counted them; slice 7's first copy said "three of
    // them for the subject type" and a review counted two. There is no number
    // here now: the enumeration below is the claim, and it is the thing that
    // fails when the set changes.
    expect(importers).toEqual(
      [
        'src/cli/delivery-steps.ts',
        'src/deliver/github-pull-request-merger.ts',
        'src/deliver/merge-grant.ts',
        'src/deliver/merge-pull-request.ts',
      ].sort(),
    );
    expect(all.map((f) => f.replace(/\\/g, '/')), 'the declaring module must exist').toContain(
      DECLARES,
    );
    const minters = all
      .map((f) => f.replace(/\\/g, '/'))
      .filter((f) => f !== DECLARES)
      .filter((f) => /\bmintMergeGrant\s*\(/.test(codeOnly(f)));
    expect(minters).toEqual(['src/cli/delivery-steps.ts']);
  });

  it('has no loop, no retry and one call site of the transport', () => {
    for (const file of [MERGER, 'src/deliver/merge-pull-request.ts']) {
      const code = codeOnly(file);
      expect(code, file).not.toMatch(/\bfor\s*\(|\bwhile\s*\(|\bretry\b|\bbackoff\b/i);
    }
    const callers = walk('src').filter((f) =>
      /\bmergePullRequestVia\s*\(/.test(codeOnly(f.replace(/\\/g, '/'))),
    );
    expect(callers.map((f) => f.replace(/\\/g, '/')).sort()).toEqual(
      [MERGER, 'src/deliver/merge-pull-request.ts'].sort(),
    );
    const calls = codeOnly('src/deliver/merge-pull-request.ts').match(/mergePullRequestVia\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('asks no local Git question at all', () => {
    // The one structural difference from both siblings, and it is asserted
    // rather than described: this act has no local subject to protect, so it
    // starts no Git process and takes no repository root.
    const code = codeOnly('src/deliver/merge-pull-request.ts');
    expect(code).not.toMatch(/\bls-remote\b|\breadRemoteRef\b|\breadUrlAgreement\b/);
    expect(code).not.toMatch(/repositoryRoot/);
    expect(code).not.toMatch(/GitPublicationRunner/);
  });
});

// ── 11. What this slice did not gain ───────────────────────────────────────

describe('the product contract is unchanged where it must be', () => {
  it('leaves READY_FOR_PR terminal, with no outgoing transition', () => {
    expect([...TERMINAL_STATES]).toContain('READY_FOR_PR');
    expect(isTerminalState('READY_FOR_PR')).toBe(true);
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
  });

  it('adds no state and no schema field, anywhere', () => {
    const core = codeOnly('src/core/internal/task-state-object-schema.ts');
    for (const invented of [
      'mergedAt',
      'mergeCommit',
      'merged',
      'mergeCommitSha',
      'deliveredAt',
      'completedAt',
    ]) {
      expect(core, invented).not.toContain(invented);
    }
    const states = readFileSync('src/core/states.ts', 'utf8');
    for (const invented of ['MERGED', 'POST_MERGE_VERIFY', 'COMPLETE']) {
      expect(states, invented).not.toContain(`'${invented}'`);
    }
  });

  it('names no writer and no agent on the whole delivery surface', () => {
    const SURFACE = [
      ...walk('src/deliver'),
      'src/cli/delivery-command.ts',
      'src/cli/render-delivery-observation.ts',
    ].sort();
    expect(SURFACE.length).toBeGreaterThanOrEqual(20);
    for (const file of SURFACE) {
      const code = codeOnly(file);
      expect(code, file).not.toMatch(/\badvanceTaskState\s*\(/);
      expect(code, file).not.toMatch(/\bsaveTaskState\s*\(/);
      // The lease clause that used to sit here moved, once, when V4 slice 9
      // gave `--verify-merge` the execution lease — the first delivery act that
      // starts the repository's own build and test commands. It is not dropped:
      // the whole delivery surface still acquires a lease in exactly one file,
      // exactly once, released in a `finally`, and nowhere under `src/deliver/`.
      // That is asserted in `tests/v4-09-post-merge-verification.test.ts`, in
      // 'takes the execution lease in exactly one place'. Restating it here would
      // be five copies of one fact with nothing making them agree — the shape
      // `L-V4-08-7` already names.
      expect(code, file).not.toMatch(/\brunOwnedCommand\s*\(|\bspawn\s*\(/);
      expect(code, file).not.toMatch(/\bstartTask\s*\(/);
    }
  });

});
