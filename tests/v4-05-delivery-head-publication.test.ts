/**
 * V4 slice 5 — publishing the delivery head.
 *
 * This is the first slice in the build that can change something outside the
 * machine, so the suite is organised around the mutation rather than around the
 * arithmetic. A test that feeds a happy path in and reads a happy word out
 * proves none of what matters here. Four properties carry the slice:
 *
 *  1. **nothing mutates without the authority** — and the authority is a type,
 *     not a boolean, so the counter-proof is a perfectly shaped forgery driven
 *     through the real argument and refused, plus a second use of a real one;
 *  2. **at most one attempt, ever** — the runner is counted, on every path,
 *     including the paths that end in an uncertain outcome. A build that
 *     retried would be caught by the count and not by an assertion about text;
 *  3. **success is established by looking, not by exit 0** — measured, `git
 *     push` exits 0 both when it creates a ref and when the ref already held
 *     the object, so the suite drives both and pins that they are named
 *     differently;
 *  4. **the vector cannot become destructive** — the tokens are derived from
 *     the emitter and checked for what must be present (an *empty* lease) and
 *     what must be absent (`--force`, `--delete`, and the rest).
 *
 * Nothing here touches a network. Every Git answer comes from an injected
 * runner, for the reason slices 2 to 4 give: the canonical gate has to be
 * deterministic on a machine that has never run `gh auth login`, and CI has no
 * credentials at all. The behaviours the injected runner imitates were measured
 * against github.com before this slice was written, and the measurements are
 * recorded in `docs/decisions/2026-08-24-adr-delivery-head-publication.md`.
 */

import { Command } from 'commander';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  ATTENDED_OPTION_DESCRIPTION,
  DELIVERY_COMMAND_DESCRIPTION,
  PUBLISH_HEAD_OPTION_DESCRIPTION,
  registerDeliveryCommand,
} from '../src/cli/delivery-command.js';
import { buildProgram } from '../src/cli/index.js';
import {
  CONTACTED_TRAILER,
  OBSERVED_AND_CHANGED_TRAILER,
  PUBLICATION_TRAILER,
  renderDeliveryObservation,
} from '../src/cli/render-delivery-observation.js';
import { EXIT_RUN_OK } from '../src/cli/run-exit-codes.js';
import { TERMINAL_STATES, isTerminalState } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import { createObservationSubject, type ObservationSubject } from '../src/deliver/forge-observation.js';
import {
  ESTABLISHED_HEAD_PUBLICATIONS,
  HEAD_PUBLICATIONS,
  HEAD_PUBLICATION_DETAIL,
  PUBLICATION_ATTEMPTS,
  REMOTE_REF_READINGS,
  gradeHeadPublication,
  remoteHeadIsEstablished,
  type HeadPublication,
  type PublicationAttempt,
  type RemoteRefReading,
} from '../src/deliver/head-publication.js';
import {
  GIT_PUBLICATION_COMMAND,
  PUBLICATION_CONFIG_PINS,
  PUBLICATION_RECEIVE_PACK,
  publishHeadArgs,
  readUrlAgreement,
  remoteFetchUrlArgs,
  remotePushUrlArgs,
  remoteRefArgs,
  type GitPublicationRunner,
} from '../src/deliver/git-head-publisher.js';
import {
  claimHeadPublication,
  isHeadPublicationGrant,
  type HeadPublicationGrant,
} from '../src/deliver/head-publication-grant.js';
import { mintHeadPublicationGrant } from '../src/deliver/internal/head-publication-grant.js';
import { publishDeliveryHead } from '../src/deliver/publish-delivery-head.js';
import { isShellInertArgument } from '../src/doctor/exec.js';
import type { ResolvedDelivery } from '../src/deliver/delivery-target.js';
import type { StateLoadResult } from '../src/state/state-store.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const HEAD = '10583ee91a5747d0049f563ffaac64b0cf643aeb';
const OTHER = 'c89ef605400a15e5d3db4d256c184773c0d533f6';
const BASE = '46629f0503b0126318ead7229eba7a84d3e7504a';
const REV = 'a'.repeat(64);
const BRANCH = 'ao/T-001';
const REF = `refs/heads/${BRANCH}`;
const REMOTE = 'origin';

interface Identity {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

const IDENTITY: Identity = Object.freeze({
  host: 'github.com',
  owner: 'M4XD4B0ZZ',
  name: 'AgentOrchestrator',
});

const ELSEWHERE: Identity = Object.freeze({
  host: 'github.com',
  owner: 'someone-else',
  name: 'AnotherRepo',
});

function subjectOf(commit = HEAD, identity: Identity = IDENTITY): ObservationSubject {
  const built = createObservationSubject(identity, commit);
  if (!built.ok) throw new Error(`fixture subject refused: ${built.refusal}`);
  return built.subject;
}

/** A real, minted grant. Never a hand-built object on a positive path. */
function grantFor(
  commit = HEAD,
  identity: Identity = IDENTITY,
  ref = REF,
  remote = REMOTE,
): HeadPublicationGrant {
  const grant = mintHeadPublicationGrant(subjectOf(commit, identity), remote, ref);
  if (grant === null) throw new Error('fixture grant was refused by the mint');
  return grant;
}

const ABSENT: RemoteRefReading = Object.freeze({ outcome: 'ABSENT' as const, commit: null });
const UNKNOWN: RemoteRefReading = Object.freeze({ outcome: 'UNKNOWN' as const, commit: null });
const at = (commit: string): RemoteRefReading =>
  Object.freeze({ outcome: 'AT_COMMIT' as const, commit });

function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * A runner that answers the two vectors, and counts every call.
 *
 * `lsRemote` is a queue: the first entry answers the pre-reading, the second
 * the post-reading. The last entry repeats, so a test that cares about only one
 * of them supplies one.
 */
interface FakeRunnerOptions {
  readonly lsRemote?: readonly { exitCode: number | null; stdout?: string; outcome?: string }[];
  readonly push?: { exitCode: number | null; outcome?: string };
  readonly urls?: { fetch?: string; push?: string; exitCode?: number; outcome?: string };
}

/**
 * Which of the three vectors a call is, derived rather than positional.
 *
 * The push no longer starts with `push` — it starts with the `-c` config pins
 * — so a check on `args[0]` would have quietly stopped recognising it and every
 * "pushed once" count would have read zero while passing. Found by a review;
 * the subcommand is now looked up by name.
 */
const vectorOf = (args: readonly string[]): 'push' | 'ls-remote' | 'remote' | 'other' => {
  for (const token of args) {
    if (token === 'push' || token === 'ls-remote' || token === 'remote') return token;
  }
  return 'other';
};

function fakeRunner(options: FakeRunnerOptions = {}) {
  const calls: string[][] = [];
  const reads = options.lsRemote ?? [{ exitCode: 2 }];
  let readIndex = 0;
  const runner: GitPublicationRunner = async (args) => {
    calls.push([...args]);
    const kind = vectorOf(args);
    if (kind === 'push') {
      const p = options.push ?? { exitCode: 0 };
      return { outcome: p.outcome ?? 'COMPLETED', exitCode: p.exitCode, stdout: '' };
    }
    if (kind === 'remote') {
      // Both URL questions answer the same thing unless a test says otherwise,
      // because a remote with no `pushurl` is the ordinary case.
      const u = options.urls ?? {};
      const isPush = args.includes('--push');
      if (u.outcome !== undefined || u.exitCode !== undefined) {
        return {
          outcome: u.outcome ?? 'COMPLETED',
          exitCode: u.exitCode ?? 0,
          stdout: isPush ? (u.push ?? 'https://example.invalid/o/r.git') : (u.fetch ?? 'https://example.invalid/o/r.git'),
        };
      }
      return {
        outcome: 'COMPLETED',
        exitCode: 0,
        stdout: isPush ? (u.push ?? 'https://example.invalid/o/r.git') : (u.fetch ?? 'https://example.invalid/o/r.git'),
      };
    }
    const r = reads[Math.min(readIndex, reads.length - 1)] ?? { exitCode: 2 };
    readIndex += 1;
    return { outcome: r.outcome ?? 'COMPLETED', exitCode: r.exitCode, stdout: r.stdout ?? '' };
  };
  return {
    runner,
    calls,
    pushes: () => calls.filter((c) => vectorOf(c) === 'push').length,
    reads: () => calls.filter((c) => vectorOf(c) === 'ls-remote').length,
    urlChecks: () => calls.filter((c) => vectorOf(c) === 'remote').length,
    /** Everything that leaves the machine. The URL questions are local. */
    contacts: () => calls.filter((c) => vectorOf(c) !== 'remote').length,
  };
}

/** The recheck that says nothing moved. */
const unchanged = (
  commit = HEAD,
  identity: Identity = IDENTITY,
  ref = REF,
  remote = REMOTE,
) =>
  async () =>
    Object.freeze({
      host: identity.host,
      owner: identity.owner,
      name: identity.name,
      remoteName: remote,
      ref,
      commit,
    });

// ── 1. The vocabulary is closed, total, and says nothing it cannot ─────────

describe('the publication vocabulary', () => {
  it('is closed, unique and ordered weakest claim first', () => {
    expect(new Set(HEAD_PUBLICATIONS).size).toBe(HEAD_PUBLICATIONS.length);
    expect(HEAD_PUBLICATIONS[0]).toBe('SUBJECT_NOT_ESTABLISHED');
    expect(HEAD_PUBLICATIONS[HEAD_PUBLICATIONS.length - 1]).toBe('PUBLISHED');
  });

  it('has a sentence for every member, and no orphan sentences', () => {
    expect(Object.keys(HEAD_PUBLICATION_DETAIL).sort()).toEqual([...HEAD_PUBLICATIONS].sort());
    for (const member of HEAD_PUBLICATIONS) {
      const sentence = HEAD_PUBLICATION_DETAIL[member];
      expect(sentence.length, member).toBeGreaterThan(40);
      expect(sentence.endsWith('.'), member).toBe(true);
    }
  });

  it('contains no word that could be read as permission to open or merge', () => {
    // Derived from the vocabulary and its sentences together, not a hand list of
    // members: the risk is a *word*, and a word can appear in either.
    const text = [...HEAD_PUBLICATIONS, ...Object.values(HEAD_PUBLICATION_DETAIL)]
      .join(' ')
      .toLowerCase();
    for (const forbidden of ['mergeable', 'merge it', 'ready to merge', 'may merge', 'eligible']) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    // "opens no pull request" must not become "a pull request may now be opened".
    expect(text).not.toContain('may now be opened');
  });

  it('partitions exactly into established and not-established', () => {
    const established = HEAD_PUBLICATIONS.filter(remoteHeadIsEstablished);
    const not = HEAD_PUBLICATIONS.filter((m) => !remoteHeadIsEstablished(m));
    expect(established.length + not.length).toBe(HEAD_PUBLICATIONS.length);
    expect([...ESTABLISHED_HEAD_PUBLICATIONS].sort()).toEqual([...established].sort());
    // The three provenances of one established state, named.
    expect([...established].sort()).toEqual([
      'ALREADY_PUBLISHED',
      'CONVERGED_AFTER_UNCERTAIN_EFFECT',
      'PUBLISHED',
    ]);
    // And the one member that claims this process did it.
    expect(not).toContain('PUBLICATION_REFUSED');
    expect(not).toContain('OUTCOME_UNCERTAIN');
  });

  it('every member is reachable, from the grader or from the command ladder', async () => {
    // Derived: drive both producers over their whole input space and take the
    // union. A member neither can produce is a member nothing can report, which
    // is the "dead enum for a future slice" this slice must not add.
    const fromGrader = new Set<HeadPublication>();
    for (const before of [ABSENT, UNKNOWN, at(HEAD), at(OTHER)]) {
      for (const attempt of PUBLICATION_ATTEMPTS) {
        for (const after of [null, ABSENT, UNKNOWN, at(HEAD), at(OTHER)]) {
          fromGrader.add(gradeHeadPublication(HEAD, before, attempt, after));
        }
      }
    }
    // Seeded, not derived, and said plainly: these are produced by
    // `performPublication`'s refusal ladder, which needs a resolved repository,
    // a task record and a seam for the operator's declaration to drive. They are
    // driven for real — every one of them, by a real call, asserted to be
    // exactly the set the grader cannot produce — in
    // `tests/v4-13-unattended-head-publication.test.ts`, under 'the ladder
    // produces every member the grader cannot'. What this case is for is the
    // union: a member that neither producer can reach is a dead enum, and adding
    // one here without adding it there fails over there instead of passing
    // quietly here.
    const fromLadder = new Set<HeadPublication>([
      'SUBJECT_NOT_ESTABLISHED',
      'TASK_NOT_READY',
      'OPERATOR_ABSENT',
      'AUTOMATIC_PUBLICATION_NOT_DECLARED',
      'AUTOMATIC_PUBLICATION_DENIED',
      'PUBLICATION_POLICY_UNREADABLE',
      // V4 slice 14. Produced when the permission stood and the durable record
      // of it could not be written, which needs a store this build can reach and
      // cannot use — so it is driven over there with a real blocked store, in
      // the same case as the five above it.
      'PUBLICATION_AUDIT_UNWRITTEN',
    ]);
    // AUTHORITY_REFUSED and SUBJECT_CHANGED come from the publisher itself.
    const spent = grantFor();
    expect(claimHeadPublication(spent)).not.toBeNull();
    fromLadder.add(
      (await publishDeliveryHead(spent, '/repo', { recheck: unchanged(), runner: fakeRunner().runner }))
        .publication,
    );
    fromLadder.add(
      (
        await publishDeliveryHead(grantFor(), '/repo', {
          recheck: async () => null,
          runner: fakeRunner().runner,
        })
      ).publication,
    );
    fromLadder.add(
      (
        await publishDeliveryHead(grantFor(), '/repo', {
          recheck: unchanged(),
          runner: fakeRunner({ urls: { fetch: 'a', push: 'b' } }).runner,
        })
      ).publication,
    );
    const reachable = new Set([...fromGrader, ...fromLadder]);
    expect([...reachable].sort()).toEqual([...HEAD_PUBLICATIONS].sort());
  });

  it('grades every input in the space, and never falls through', () => {
    for (const before of [ABSENT, UNKNOWN, at(HEAD), at(OTHER)]) {
      for (const attempt of PUBLICATION_ATTEMPTS) {
        for (const after of [null, ABSENT, UNKNOWN, at(HEAD), at(OTHER)]) {
          const graded = gradeHeadPublication(HEAD, before, attempt, after);
          expect(HEAD_PUBLICATIONS, `${before.outcome}/${attempt}`).toContain(graded);
        }
      }
    }
    expect([...REMOTE_REF_READINGS].sort()).toEqual(['ABSENT', 'AT_COMMIT', 'UNKNOWN']);
  });
});

// ── 2. Exit 0 is not the answer ────────────────────────────────────────────

describe('the effect is established by looking, not by the exit code', () => {
  it('separates a create from a ref that already held the commit', () => {
    // Measured: `git push` exits 0 for BOTH. Only the pre-reading tells them
    // apart, and this is the assertion that the build does tell them apart.
    expect(gradeHeadPublication(HEAD, ABSENT, 'COMPLETED', at(HEAD))).toBe('PUBLISHED');
    expect(gradeHeadPublication(HEAD, at(HEAD), 'NOT_ATTEMPTED', null)).toBe('ALREADY_PUBLISHED');
  });

  it('refuses to call it published when the transport succeeded and the ref is not there', () => {
    expect(gradeHeadPublication(HEAD, ABSENT, 'COMPLETED', ABSENT)).toBe('OUTCOME_UNCERTAIN');
    expect(gradeHeadPublication(HEAD, ABSENT, 'COMPLETED', UNKNOWN)).toBe('OUTCOME_UNCERTAIN');
    expect(gradeHeadPublication(HEAD, ABSENT, 'COMPLETED', null)).toBe('OUTCOME_UNCERTAIN');
  });

  it('converges when the transport failed and the effect landed anyway', () => {
    expect(gradeHeadPublication(HEAD, ABSENT, 'FAILED', at(HEAD))).toBe(
      'CONVERGED_AFTER_UNCERTAIN_EFFECT',
    );
  });

  it('names an honest failure when the transport failed and nothing changed', () => {
    expect(gradeHeadPublication(HEAD, ABSENT, 'FAILED', ABSENT)).toBe('PUBLICATION_REFUSED');
  });

  it('never reports success for a ref that ended up at another commit', () => {
    // The remote-ref race: pre-reading saw nothing, someone else won.
    expect(gradeHeadPublication(HEAD, ABSENT, 'COMPLETED', at(OTHER))).toBe(
      'REF_HOLDS_ANOTHER_COMMIT',
    );
    expect(gradeHeadPublication(HEAD, ABSENT, 'FAILED', at(OTHER))).toBe('REF_HOLDS_ANOTHER_COMMIT');
    expect(remoteHeadIsEstablished('REF_HOLDS_ANOTHER_COMMIT')).toBe(false);
  });

  it('refuses to act on a remote it could not read', () => {
    for (const attempt of PUBLICATION_ATTEMPTS) {
      expect(gradeHeadPublication(HEAD, UNKNOWN, attempt, at(HEAD))).toBe('REMOTE_STATE_UNKNOWN');
    }
  });

  it('compares object names exactly, with no prefix and no case folding', () => {
    expect(gradeHeadPublication(HEAD, at(HEAD.slice(0, 12)), 'NOT_ATTEMPTED', null)).toBe(
      'REF_HOLDS_ANOTHER_COMMIT',
    );
    expect(gradeHeadPublication(HEAD, at(HEAD.toUpperCase()), 'NOT_ATTEMPTED', null)).toBe(
      'REF_HOLDS_ANOTHER_COMMIT',
    );
  });
});

// ── 3. At most one attempt, on every path ──────────────────────────────────

describe('the publisher attempts at most one mutation', () => {
  it('pushes once when the ref is absent, and reads twice around it', async () => {
    const f = fakeRunner({ lsRemote: [{ exitCode: 2 }, { exitCode: 0, stdout: `${HEAD}\t${REF}\n` }] });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('PUBLISHED');
    expect(f.pushes()).toBe(1);
    expect(f.reads()).toBe(2);
    // The order is the contract, so it is asserted as a sequence of vectors
    // rather than by index into an argv that the config pins have already
    // shifted once.
    expect(f.calls.map(vectorOf)).toEqual([
      'remote',
      'remote',
      'ls-remote',
      'push',
      'ls-remote',
    ]);
    expect(f.urlChecks()).toBe(2);
  });

  it('pushes nothing when the ref already holds the commit', async () => {
    const f = fakeRunner({ lsRemote: [{ exitCode: 0, stdout: `${HEAD}\t${REF}\n` }] });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('ALREADY_PUBLISHED');
    expect(f.pushes()).toBe(0);
    expect(f.reads()).toBe(1);
  });

  it('pushes nothing when the ref holds someone else’s commit', async () => {
    const f = fakeRunner({ lsRemote: [{ exitCode: 0, stdout: `${OTHER}\t${REF}\n` }] });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('REF_HOLDS_ANOTHER_COMMIT');
    expect(f.pushes()).toBe(0);
  });

  it('pushes nothing when the remote could not be read', async () => {
    const f = fakeRunner({ lsRemote: [{ exitCode: 128 }] });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('REMOTE_STATE_UNKNOWN');
    expect(f.pushes()).toBe(0);
  });

  it('does not push again after an uncertain outcome', async () => {
    // The transport said yes and the ref is not there. A build that retried
    // here would be caught by the count, not by reading a message.
    const f = fakeRunner({ lsRemote: [{ exitCode: 2 }, { exitCode: 2 }] });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('OUTCOME_UNCERTAIN');
    expect(f.pushes()).toBe(1);
  });

  it('does not push again after the transport failed', async () => {
    const f = fakeRunner({ lsRemote: [{ exitCode: 2 }, { exitCode: 2 }], push: { exitCode: 1 } });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('PUBLICATION_REFUSED');
    expect(f.pushes()).toBe(1);
  });

  it('reads the postcondition even when the transport reported failure', async () => {
    const f = fakeRunner({
      lsRemote: [{ exitCode: 2 }, { exitCode: 0, stdout: `${HEAD}\t${REF}\n` }],
      push: { exitCode: null, outcome: 'TIMED_OUT' },
    });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('CONVERGED_AFTER_UNCERTAIN_EFFECT');
    expect(f.reads()).toBe(2);
    expect(f.pushes()).toBe(1);
  });

  it('treats a boundary loss as a failed attempt, not as a success', async () => {
    for (const outcome of ['TIMED_OUT', 'NOT_FOUND', 'OUTPUT_LIMIT_EXCEEDED', 'SPAWN_FAILED']) {
      const f = fakeRunner({
        lsRemote: [{ exitCode: 2 }, { exitCode: 2 }],
        push: { exitCode: 0, outcome },
      });
      const out = await publishDeliveryHead(grantFor(), '/repo', {
        recheck: unchanged(),
        runner: f.runner,
      });
      expect(out.attempt, outcome).toBe('FAILED');
      expect(out.publication, outcome).toBe('PUBLICATION_REFUSED');
    }
  });

  it('never turns an unusable answer into a commit', async () => {
    // Two classes, and they are graded differently on purpose. An answer that
    // names the intended ref but no object name is UNKNOWN — something is
    // there and this build cannot say what. An answer that names only other
    // refs is ABSENT — the intended ref is genuinely not there. Neither ever
    // produces an AT_COMMIT, which is the property that matters.
    const unknown = [`not-a-sha\t${REF}\n`, `${HEAD.slice(0, 39)}\t${REF}\n`, `\t${REF}\n`];
    for (const stdout of unknown) {
      const f = fakeRunner({ lsRemote: [{ exitCode: 0, stdout }] });
      const out = await publishDeliveryHead(grantFor(), '/repo', {
        recheck: unchanged(),
        runner: f.runner,
      });
      expect(out.publication, JSON.stringify(stdout)).toBe('REMOTE_STATE_UNKNOWN');
      expect(f.pushes(), JSON.stringify(stdout)).toBe(0);
    }
    const absent = ['', 'not-a-sha\trefs/heads/x\n', '\t\t\n', `${HEAD}\trefs/heads/x\n`];
    for (const stdout of absent) {
      const f = fakeRunner({
        lsRemote: [{ exitCode: 0, stdout }, { exitCode: 0, stdout: `${HEAD}\t${REF}\n` }],
      });
      const out = await publishDeliveryHead(grantFor(), '/repo', {
        recheck: unchanged(),
        runner: f.runner,
      });
      expect(out.publication, JSON.stringify(stdout)).toBe('PUBLISHED');
    }
  });

  it('finds the intended ref wherever it is in the answer', async () => {
    const f = fakeRunner({
      lsRemote: [{ exitCode: 0, stdout: `${OTHER}\trefs/heads/other\n${HEAD}\t${REF}\n` }],
    });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('ALREADY_PUBLISHED');
  });

  it('ignores a ref that merely ends with the one asked about', async () => {
    // `ls-remote` takes a PATTERN matched against a ref's tail, so
    // `refs/heads/ao/T-001` is answered by a stranger's
    // `refs/heads/x/refs/heads/ao/T-001`. Measured against a real remote. Before
    // this was fixed the build read that as ALREADY_PUBLISHED and told the
    // operator the intended state was already true, for a ref that did not
    // exist — and the same instrument grades the postcondition, so a real
    // create could be reported as a failure.
    const f = fakeRunner({
      lsRemote: [
        { exitCode: 0, stdout: `${HEAD}\trefs/heads/stranger/${REF}\n` },
        { exitCode: 0, stdout: `${HEAD}\t${REF}\n` },
      ],
    });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    // The intended ref was absent, so it is created — not reported as present.
    expect(out.publication).toBe('PUBLISHED');
    expect(f.pushes()).toBe(1);
  });

  it('reads a bad object name on the intended ref as UNKNOWN, not as an absence', async () => {
    // The distinction matters in the dangerous direction: an absence would
    // authorise a push.
    const f = fakeRunner({ lsRemote: [{ exitCode: 0, stdout: `not-a-sha\t${REF}\n` }] });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('REMOTE_STATE_UNKNOWN');
    expect(f.pushes()).toBe(0);
  });
});

// ── 4. Idempotency across invocations ──────────────────────────────────────

describe('a second invocation converges without a second mutation', () => {
  it('publishes once, then reports the state as already established', async () => {
    // Two full invocations against one remote whose state the first one changed.
    let refHolds: string | null = null;
    const calls: string[][] = [];
    const runner: GitPublicationRunner = async (args) => {
      calls.push([...args]);
      const kind = vectorOf(args);
      if (kind === 'push') {
        refHolds = HEAD;
        return { outcome: 'COMPLETED', exitCode: 0, stdout: '' };
      }
      // One remote, one repository: both URL questions answer the same.
      if (kind === 'remote') {
        return { outcome: 'COMPLETED', exitCode: 0, stdout: 'https://example.invalid/o/r.git' };
      }
      return refHolds === null
        ? { outcome: 'COMPLETED', exitCode: 2, stdout: '' }
        : { outcome: 'COMPLETED', exitCode: 0, stdout: `${refHolds}\t${REF}\n` };
    };

    const first = await publishDeliveryHead(grantFor(), '/repo', { recheck: unchanged(), runner });
    expect(first.publication).toBe('PUBLISHED');

    const second = await publishDeliveryHead(grantFor(), '/repo', { recheck: unchanged(), runner });
    expect(second.publication).toBe('ALREADY_PUBLISHED');

    // Exactly one mutation across both invocations. This is the whole claim.
    expect(calls.filter((c) => vectorOf(c) === 'push').length).toBe(1);
    // And both agree the head is established, by different routes.
    expect(remoteHeadIsEstablished(first.publication)).toBe(true);
    expect(remoteHeadIsEstablished(second.publication)).toBe(true);
  });

  it('does not converge on the same branch name at a different commit', async () => {
    const f = fakeRunner({ lsRemote: [{ exitCode: 0, stdout: `${OTHER}\t${REF}\n` }] });
    const out = await publishDeliveryHead(grantFor(HEAD), '/repo', {
      recheck: unchanged(HEAD),
      runner: f.runner,
    });
    expect(out.publication).toBe('REF_HOLDS_ANOTHER_COMMIT');
    expect(remoteHeadIsEstablished(out.publication)).toBe(false);
  });
});

// ── 5. The authority ───────────────────────────────────────────────────────

describe('nothing mutates without the minted authority', () => {
  it('refuses a forgery that carries every correct field', async () => {
    // Shape-equivalent, built from the real facts, and refused. Nothing is
    // contacted: the count is the assertion, not the word.
    const real = grantFor();
    const forged = Object.create(Object.getPrototypeOf(real) as object) as HeadPublicationGrant;
    expect(isHeadPublicationGrant(forged)).toBe(false);
    const f = fakeRunner();
    const out = await publishDeliveryHead(forged, '/repo', { recheck: unchanged(), runner: f.runner });
    expect(out.publication).toBe('AUTHORITY_REFUSED');
    // Not one child at all, local or otherwise: an unauthorised caller must not
    // be able to make this build start a process.
    expect(f.calls.length).toBe(0);
  });

  it('offers no constructor to reach, and freezes what is left', () => {
    const real = grantFor();
    const proto = Object.getPrototypeOf(real) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(proto, 'constructor')).toBe(false);
    expect(Object.isFrozen(proto)).toBe(true);
  });

  it('cannot be flipped by replacing WeakSet.prototype.has', () => {
    const original = WeakSet.prototype.has;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (WeakSet.prototype as any).has = () => true;
      expect(isHeadPublicationGrant({})).toBe(false);
    } finally {
      WeakSet.prototype.has = original;
    }
  });

  it('is one-shot: the second use authorises nothing and contacts nothing', async () => {
    const grant = grantFor();
    const f1 = fakeRunner({ lsRemote: [{ exitCode: 2 }, { exitCode: 0, stdout: `${HEAD}\t${REF}\n` }] });
    expect((await publishDeliveryHead(grant, '/repo', { recheck: unchanged(), runner: f1.runner })).publication)
      .toBe('PUBLISHED');

    const f2 = fakeRunner();
    const again = await publishDeliveryHead(grant, '/repo', { recheck: unchanged(), runner: f2.runner });
    expect(again.publication).toBe('AUTHORITY_REFUSED');
    expect(f2.calls.length).toBe(0);
  });

  it('reveals nothing without spending, so a report cannot disarm a publication', () => {
    const grant = grantFor();
    expect(claimHeadPublication(grant)).not.toBeNull();
    expect(claimHeadPublication(grant)).toBeNull();
  });

  it('refuses to mint what it will not put in an argument vector', () => {
    // Derived over the classes the vector must never carry, each with a control
    // that proves the refusal is about that class and not about the fixture.
    expect(mintHeadPublicationGrant(subjectOf(), REMOTE, REF)).not.toBeNull();
    for (const ref of [
      '',
      BRANCH,
      'refs/heads/',
      'refs/heads/a b',
      'refs/heads/a;rm',
      // A colon would split the refspec into a different push entirely.
      'refs/heads/a:refs/heads/b',
      'refs/heads/a\tb',
      'refs/heads/a\nb',
      'refs/heads/a?b',
      'refs/heads/a*b',
      'refs/heads/a\\b',
      'refs/tags/x',
      '--upload-pack=x',
    ]) {
      expect(mintHeadPublicationGrant(subjectOf(), REMOTE, ref), ref).toBeNull();
    }
    for (const remote of ['', '-origin', 'a b', 'https://github.com/o/r.git', 'o;rm']) {
      expect(mintHeadPublicationGrant(subjectOf(), remote, REF), remote).toBeNull();
    }
    // The host is re-tested at the mint against the frozen supported list, not
    // taken on trust from the subject's type. The type is structural, so a
    // hand-cast walks straight past it — which is how the docblock came to
    // claim a refusal the code did not perform.
    for (const host of ['', 'gitlab.com', 'GitHub.com', 'evil.example', 'github.com.evil.example']) {
      const elsewhere = { ...IDENTITY, host, commit: HEAD } as ObservationSubject;
      expect(mintHeadPublicationGrant(elsewhere, REMOTE, REF), host).toBeNull();
    }
  });

  it('refuses to mint a subject whose commit is not an object name', () => {
    // Driven at the mint directly, with a hand-built subject. Every other
    // fixture here comes through `createObservationSubject`, which validates
    // the commit a layer earlier — so without this the mint's own guard is
    // never reached and deleting it changes nothing any test can see. A
    // counter-proof found exactly that.
    const bad = (commit: string): ObservationSubject =>
      ({ ...IDENTITY, commit }) as ObservationSubject;
    for (const commit of [
      '',
      BRANCH,
      HEAD.slice(0, 39),
      `${HEAD}0`,
      HEAD.toUpperCase(),
      'refs/heads/main',
      `${HEAD} `,
    ]) {
      expect(mintHeadPublicationGrant(bad(commit), REMOTE, REF), JSON.stringify(commit)).toBeNull();
    }
    // The control: the same call shape with a real object name mints.
    expect(mintHeadPublicationGrant(bad(HEAD), REMOTE, REF)).not.toBeNull();
  });

  it('binds the exact repository, ref and commit it was minted for', async () => {
    // A grant for one target cannot be redeemed against another: the recheck
    // returns a different world and the publisher refuses before contacting it.
    for (const moved of [
      { ...IDENTITY, host: 'gitlab.invalid', commit: HEAD, remoteName: REMOTE, ref: REF },
      { ...IDENTITY, commit: OTHER, remoteName: REMOTE, ref: REF },
      { ...ELSEWHERE, commit: HEAD, remoteName: REMOTE, ref: REF },
      { ...IDENTITY, commit: HEAD, remoteName: 'upstream', ref: REF },
      { ...IDENTITY, commit: HEAD, remoteName: REMOTE, ref: 'refs/heads/other' },
    ]) {
      const f = fakeRunner();
      const out = await publishDeliveryHead(grantFor(), '/repo', {
        recheck: async () => Object.freeze(moved),
        runner: f.runner,
      });
      expect(out.publication, JSON.stringify(moved)).toBe('SUBJECT_CHANGED');
      expect(f.calls.length, JSON.stringify(moved)).toBe(0);
    }
  });

  it('refuses a remote that reads one repository and writes another', async () => {
    // Measured: with `remote.<name>.pushurl` set elsewhere, `ls-remote` answers
    // from the fetch URL while `push` writes to the push URL — and slice 1
    // binds the delivery identity to the push URL. Every reading would then be
    // about the wrong repository, so the divergence is refused before anything
    // is contacted.
    const f = fakeRunner({ urls: { fetch: 'https://x.invalid/a.git', push: 'https://x.invalid/b.git' } });
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: unchanged(),
      runner: f.runner,
    });
    expect(out.publication).toBe('REMOTE_URLS_DIVERGE');
    expect(f.urlChecks()).toBe(2);
    // Two local questions and nothing else: no ref was read and none was pushed.
    expect(f.contacts()).toBe(0);
  });

  it('refuses a remote whose URLs cannot be read at all', async () => {
    for (const urls of [{ exitCode: 1 }, { outcome: 'NOT_FOUND', exitCode: null as never }]) {
      const f = fakeRunner({ urls });
      const out = await publishDeliveryHead(grantFor(), '/repo', {
        recheck: unchanged(),
        runner: f.runner,
      });
      // UNKNOWN is a refusal, not a pass: this is a precondition and not a
      // diagnosis, so failing to establish it fails closed.
      expect(out.publication, JSON.stringify(urls)).toBe('REMOTE_URLS_DIVERGE');
      expect(f.contacts(), JSON.stringify(urls)).toBe(0);
    }
  });

  it('agrees when one remote is one repository', async () => {
    const f = fakeRunner();
    expect(await readUrlAgreement('/repo', REMOTE, f.runner)).toBe('AGREE');
    const d = fakeRunner({ urls: { fetch: 'a', push: 'b' } });
    expect(await readUrlAgreement('/repo', REMOTE, d.runner)).toBe('DIVERGE');
    const u = fakeRunner({ urls: { exitCode: 128 } });
    expect(await readUrlAgreement('/repo', REMOTE, u.runner)).toBe('UNKNOWN');
    // Two empty answers are equal and establish nothing. Without this the sole
    // fail-closed precondition in the transport failed open, and a counter-proof
    // found it: deleting the guard broke no test.
    for (const urls of [{ fetch: '', push: '' }, { fetch: '', push: 'u' }, { fetch: 'u', push: '' }]) {
      const e = fakeRunner({ urls });
      expect(await readUrlAgreement('/repo', REMOTE, e.runner), JSON.stringify(urls)).toBe('UNKNOWN');
    }
  });

  it('refuses when the local subject cannot be re-established at all', async () => {
    const f = fakeRunner();
    const out = await publishDeliveryHead(grantFor(), '/repo', {
      recheck: async () => null,
      runner: f.runner,
    });
    expect(out.publication).toBe('SUBJECT_CHANGED');
    expect(f.calls.length).toBe(0);
  });
});

// ── 6. The vector cannot become destructive ────────────────────────────────

describe('the two Git vectors', () => {
  it('reads one ref, with the separator and the exit-code token', () => {
    expect(remoteRefArgs(REMOTE, REF)).toEqual(['ls-remote', '--exit-code', '--', REMOTE, REF]);
  });

  it('writes exactly one ref, create-only, with an EMPTY lease', () => {
    expect(publishHeadArgs(REMOTE, REF, HEAD)).toEqual([
      ...PUBLICATION_CONFIG_PINS.flatMap((pin) => ['-c', pin]),
      'push',
      '--porcelain',
      '--atomic',
      `--receive-pack=${PUBLICATION_RECEIVE_PACK}`,
      `--force-with-lease=${REF}:`,
      '--',
      REMOTE,
      `${HEAD}:${REF}`,
    ]);
  });

  it('never sends an expected value with the lease', () => {
    // Measured: `--force-with-lease=<ref>:<sha>` with the CORRECT current value
    // performs a forced update and rewrites the branch. The empty form refuses
    // an existing ref instead. This asserts the token ends at the colon, for
    // every input, so no value can be smuggled into it.
    for (const commit of [HEAD, OTHER, BASE]) {
      const lease = publishHeadArgs(REMOTE, REF, commit).find((a) =>
        a.startsWith('--force-with-lease='),
      );
      expect(lease, commit).toBe(`--force-with-lease=${REF}:`);
      expect(lease?.endsWith(':'), commit).toBe(true);
    }
  });

  it('pins the operator’s own Git config out of the effect', () => {
    // Measured, both of these change what the vector does: `push.followTags`
    // added an annotated tag the vector never named, and a `pre-push` hook ran
    // and aborted the publication. They are part of the contract, not hygiene.
    const args = publishHeadArgs(REMOTE, REF, HEAD);
    expect(PUBLICATION_CONFIG_PINS).toContain('push.followTags=false');
    expect(PUBLICATION_CONFIG_PINS).toContain('core.hooksPath=');
    for (const pin of PUBLICATION_CONFIG_PINS) {
      const at = args.indexOf(pin);
      expect(at, pin).toBeGreaterThan(0);
      expect(args[at - 1], pin).toBe('-c');
      // Before the subcommand, or Git reads it as an argument to `push`.
      expect(at, pin).toBeLessThan(args.indexOf('push'));
    }
    // The read vector runs no hooks and pushes nothing, so it carries none.
    expect(remoteRefArgs(REMOTE, REF)).not.toContain('-c');
  });

  it('asks two local questions about the remote’s URLs, and no others', () => {
    expect(remoteFetchUrlArgs(REMOTE)).toEqual(['remote', 'get-url', '--all', '--', REMOTE]);
    expect(remotePushUrlArgs(REMOTE)).toEqual([
      'remote',
      'get-url',
      '--push',
      '--all',
      '--',
      REMOTE,
    ]);
  });

  it('pushes an object name, never a branch name', () => {
    const refspec = publishHeadArgs(REMOTE, REF, HEAD).at(-1) ?? '';
    expect(refspec).toBe(`${HEAD}:${REF}`);
    expect(refspec.startsWith(BRANCH)).toBe(false);
  });

  it('carries none of the tokens that would make it destructive', () => {
    const all = [...remoteRefArgs(REMOTE, REF), ...publishHeadArgs(REMOTE, REF, HEAD)].join(' ');
    for (const token of [
      '--force ',
      '--force\t',
      '--delete',
      '--mirror',
      '--all',
      '--tags',
      '--prune',
      '--set-upstream',
      '--exec',
      '--upload-pack',
    ]) {
      expect(`${all} `, token).not.toContain(token);
    }
    // `--force-with-lease` is present and `--force` on its own is not: the
    // check above would pass for both, so the distinction is made here.
    expect(all).toContain('--force-with-lease=');
    expect(all.split(/\s+/)).not.toContain('--force');
  });

  it('names the receive-pack program, so config cannot choose it', () => {
    // `--receive-pack` used to be on the banned list above, and that was the
    // defect: the receive side is what writes the refs, so leaving it to
    // `remote.<name>.receivepack` let an operator's config reach past every pin.
    // Measured with the full pinned vector against a throwaway destination: a
    // wrapper receive-pack created a second ref and the push reported
    // `[new branch]`, exit 0. Naming it on the command line reduced the
    // destination to the intended ref alone.
    expect(PUBLICATION_RECEIVE_PACK).toBe('git-receive-pack');
    const args = publishHeadArgs(REMOTE, REF, HEAD);
    const token = args.find((a) => a.startsWith('--receive-pack'));
    expect(token).toBe(`--receive-pack=${PUBLICATION_RECEIVE_PACK}`);
    // Exactly one, and it carries Git's own program rather than a path.
    expect(args.filter((a) => a.startsWith('--receive-pack')).length).toBe(1);
    expect(token).not.toContain('/');
    expect(token).not.toContain('\\');
    // The read vector asks nothing of a receive side and must not name one.
    expect(remoteRefArgs(REMOTE, REF).join(' ')).not.toContain('receive-pack');
  });

  it('emits only shell-inert tokens, for every input the mint admits', () => {
    // Derived over inputs the mint actually accepts, rather than over the one
    // fixture the first version used. What this proves is that the emitter is
    // inert across the shape of every branch, remote and commit a real subject
    // can carry — not that the grammar itself is narrow enough, because these
    // inputs are all already inert. The grammar is pinned by the refusal test
    // above, which is where a widened one dies.
    const remotes = ['origin', 'up-stream', 'o.k', 'a_b', 'X9'];
    const branches = ['ao/T-001', 'a', 'feat/x.y', 'a+b=c', 'v1.2.3-rc.1', 'a@b', 'x/y/z'];
    // Forty hex only: `createObservationSubject` is the boundary every real
    // subject comes through and it admits no other length, so a sixty-four-hex
    // input could not reach the mint from anywhere in the product.
    const commits = [HEAD, OTHER, 'f'.repeat(40), 'a1'.repeat(20)];
    let admitted = 0;
    for (const remote of remotes) {
      for (const branch of branches) {
        for (const commit of commits) {
          const ref = `refs/heads/${branch}`;
          if (mintHeadPublicationGrant(subjectOf(commit), remote, ref) === null) continue;
          admitted += 1;
          for (const token of [...remoteRefArgs(remote, ref), ...publishHeadArgs(remote, ref, commit)]) {
            expect(isShellInertArgument(token), token).toBe(true);
          }
        }
      }
    }
    // The control: the loop must have measured something.
    expect(admitted).toBe(remotes.length * branches.length * commits.length);
  });

  it('carries no local path, no URL, no credential and no free text', () => {
    const tokens = [...remoteRefArgs(REMOTE, REF), ...publishHeadArgs(REMOTE, REF, HEAD)];
    // Per token, not over a joined string: joining with a space would make the
    // whitespace assertion vacuously false and the rest vacuously weaker.
    for (const token of tokens) {
      for (const leak of ['http', '://', '@github', 'token', 'D:\\', '/home/', 'C:\\']) {
        expect(token, `${token} / ${leak}`).not.toContain(leak);
      }
      // No whitespace at all: a token carrying a space is a token carrying
      // something a person wrote, and nothing a person wrote belongs here.
      expect(/\s/.test(token), token).toBe(false);
    }
  });

  it('names git, and does not redeclare the forge client', () => {
    expect(GIT_PUBLICATION_COMMAND).toBe('git');
    // Slice 2 owns `FORGE_CLIENT_COMMAND` and a tree walk pins that it is
    // declared in exactly one file. Declaring it here would break that pin; this
    // is the local half of the same guarantee.
    expect(codeOnly('src/deliver/git-head-publisher.ts')).not.toMatch(/FORGE_CLIENT_COMMAND\s*=/);
  });
});

// ── 7. The mutating surface, derived from the tree ─────────────────────────

describe('exactly one module can change anything, and it changes one ref', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });

  const SURFACE = [
    ...walk('src/deliver'),
    // Derived rather than named, so a delivery module added to `src/cli/`
    // joins this surface without anybody remembering to. V4 slice 11 moved the
    // three mint call sites into `delivery-steps.ts` and added
    // `delivery-driver.ts` beside it; under the old hand-written pair both would
    // have escaped every assertion below.
    ...walk('src/cli').filter((file) => file.includes('delivery')),
  ].sort();

  it('names a push in exactly one module of the delivery surface', () => {
    // This is the claim slice 4's scan used to make in its title and could not
    // measure. Derived from the tree so a second publisher cannot be added
    // without this failing.
    const pushers = SURFACE.filter((f) => /'push'/.test(codeOnly(f)));
    expect(pushers).toEqual(['src/deliver/git-head-publisher.ts']);
  });

  it('imports the mint in exactly one module of the whole source tree', () => {
    const all = walk('src');
    const importers = all.filter((f) =>
      /from\s+'[^']*internal\/head-publication-grant\.js'/.test(readFileSync(f, 'utf8')),
    );
    // The public facade re-exports the type; the CLI mints. Nothing else.
    expect(importers.sort()).toEqual(
      ['src/cli/delivery-steps.ts', 'src/deliver/head-publication-grant.ts', 'src/deliver/publish-delivery-head.ts'].sort(),
    );
    // And the only one that CALLS the mint is the command ladder. The module
    // that declares it is excluded by name rather than by a cleverer regex: a
    // pattern that tried to tell a call from a declaration would be the thing
    // most likely to go quietly wrong, and the declaring module is exactly one
    // file whose identity this test already knows.
    const DECLARES = 'src/deliver/internal/head-publication-grant.ts';
    expect(all, 'the declaring module must exist').toContain(DECLARES);
    const minters = all
      .filter((f) => f !== DECLARES)
      .filter((f) => /\bmintHeadPublicationGrant\s*\(/.test(codeOnly(f)));
    expect(minters).toEqual(['src/cli/delivery-steps.ts']);
  });

  // The title lost "and no merge" at V4 slice 7, which added one. What that
  // slice did NOT add is what the surviving lines measure, and they are the
  // ones that were always the point: this surface still writes no task state,
  // takes no lease, starts no process of its own, never invokes `gh pr merge`
  // — the merge goes through `gh api`, whose vector is pinned by exact
  // equality in the slice-7 file — and never enables auto-merge. The retired
  // line was `not.toMatch(/\bmergePullRequest\b/)`: it was the name of the
  // thing that must not exist and is now the name of the thing that does, so
  // keeping it would have measured a spelling rather than a capability.
  it('still names no writer, no lease, no agent and no auto-merge', () => {
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
      expect(code, file).not.toMatch(/gh pr merge|--auto\b/);
      expect(code, file).not.toMatch(/\benableAutoMerge\b|\bauto_merge\b|\bmerge_queue\b/);
      expect(code, file).not.toMatch(/merge-async/);
    }
  });

  // Two assertions used to live in the case above and were true when this slice
  // shipped: that no module in the delivery surface names `-X POST` (or PATCH,
  // PUT, DELETE), and that none names `createPullRequest`. **V4 slice 6 made
  // both false on purpose**, and they are moved rather than deleted — a removed
  // assertion takes its citations with it, and "this build performs no API
  // mutation" was one of the things this file measured.
  //
  // What survives here is the half that is still slice 5's business: the
  // publication path is Git, so it must name no HTTP method at all. The other
  // half — that POST appears in exactly one module, at exactly one endpoint —
  // is a slice-6 claim and is pinned in `tests/v4-06-…`, where the module it is
  // about lives.
  // Both spellings are matched: the token pair a real vector uses, and the
  // single string a careless one might. The first version of these patterns
  // looked only for the string, which no vector in this build writes — so it
  // measured nothing, and slice 6's creator walked straight past it.
  const METHOD = (...names: string[]): RegExp => {
    const alt = names.join('|');
    return new RegExp(`-X\\s*(${alt})|['"]-X['"]\\s*,\\s*['"](${alt})['"]`);
  };

  it('leaves the publication path free of any HTTP method', () => {
    for (const file of ['src/deliver/git-head-publisher.ts', 'src/deliver/publish-delivery-head.ts']) {
      expect(codeOnly(file), file).not.toMatch(METHOD('GET', 'POST', 'PATCH', 'PUT', 'DELETE'));
    }
  });

  // V4 slice 7 added a PUT, so this narrowed from "no method other than GET or
  // POST" to what is still true: PATCH and DELETE appear nowhere, and PUT
  // appears in exactly one module. The one-module half is the part that carries
  // the guarantee — the slice-7 file pins that module's whole vector, and its
  // single endpoint, by exact equality.
  it('names no PATCH or DELETE, and confines PUT to one module', () => {
    for (const file of SURFACE) {
      expect(codeOnly(file), file).not.toMatch(METHOD('PATCH', 'DELETE'));
    }
    const putters = SURFACE.filter((f) => METHOD('PUT').test(codeOnly(f)));
    expect(putters).toEqual(['src/deliver/github-pull-request-merger.ts']);
    // False-negative guard: the pattern matches both spellings of a real one.
    expect("['api', '-X', 'DELETE', p]").toMatch(METHOD('PATCH', 'DELETE'));
    expect('-X PUT').toMatch(METHOD('PUT'));
  });

  it('leaves READY_FOR_PR terminal, with no outgoing transition', () => {
    expect([...TERMINAL_STATES]).toContain('READY_FOR_PR');
    expect(isTerminalState('READY_FOR_PR')).toBe(true);
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
  });

  it('adds no schema field and no state, anywhere', () => {
    const core = codeOnly('src/core/internal/task-state-object-schema.ts');
    for (const invented of ['publishedAt', 'remoteHead', 'headPublished', 'pushedAt', 'upstream']) {
      expect(core, invented).not.toContain(invented);
    }
  });
});

// ── 8. The command surface ─────────────────────────────────────────────────

describe('the delivery command publishes only when asked, and only when told someone is there', () => {
  const DECLARED: ResolvedDelivery = Object.freeze({
    declared: true as const,
    remoteName: REMOTE,
    result: Object.freeze({ outcome: 'RESOLVED' as const, target: IDENTITY }),
  });

  function loadedState(root: string, state = 'READY_FOR_PR', commit: string | null = HEAD): StateLoadResult {
    return {
      ok: true,
      code: 'LOADED',
      classification: 'STATE_VALID',
      state: { state, currentCommit: commit, basePinnedCommit: BASE, workBranch: BRANCH } as never,
      path: join(root, 'state.json'),
      revision: REV,
    } as never;
  }

  function scratchRoot(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'ao-v405-'));
    mkdirSync(join(root, '.agent-orchestrator', 'runtime', 'delivery'), { recursive: true });
    return {
      root,
      cleanup: () => {
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          // A scratch directory a test could not remove is not a test failure.
        }
      },
    };
  }

  interface HarnessOptions {
    readonly loads?: readonly StateLoadResult[];
    readonly publication?: FakeRunnerOptions;
  }

  function harness(root: string, options: HarnessOptions = {}) {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const loads = options.loads ?? [loadedState(root)];
    let loadCall = 0;
    const fake = fakeRunner(options.publication);

    const program = new Command();
    program.exitOverride();
    registerDeliveryCommand(program, {
      resolveRepository: async () =>
        ({ ok: true, repository: { id: 'ao', root, delivery: DECLARED } }) as never,
      loadTaskState: () => {
        const load = loads[Math.min(loadCall, loads.length - 1)] as StateLoadResult;
        loadCall += 1;
        return load;
      },
      // The forge client seam is left at its default and never reached: no test
      // here passes --observe, so a call would be a defect this would surface.
      runner: async () => {
        throw new Error('the forge client must not be started by a publication');
      },
      envSource: { PATH: '/usr/bin' },
      checkIgnored: async () => 'IGNORED',
      publicationRunner: fake.runner,
    });
    return { program, out, fake, restore: () => spy.mockRestore() };
  }

  const run = async (h: ReturnType<typeof harness>, root: string, ...args: string[]) =>
    h.program.parseAsync(['node', 'ao', 'delivery', '--repository', root, '--task', 'T-001', ...args]);

  it('starts no Git and changes nothing when --publish-head is absent', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await run(h, scratch.root);
      expect(h.fake.calls.length).toBe(0);
      expect(h.out.join('')).not.toContain('Publication  :');
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses without --attended, having contacted nothing', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await run(h, scratch.root, '--publish-head');
      const text = h.out.join('');
      expect(text).toContain('Publication  : OPERATOR_ABSENT');
      expect(text).toContain(HEAD_PUBLICATION_DETAIL.OPERATOR_ABSENT);
      expect(h.fake.calls.length).toBe(0);
      // A refusal that contacted nothing still gets the read-only trailer.
      expect(text).not.toContain(PUBLICATION_TRAILER);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses a task that has not reached READY_FOR_PR, before checking attendance', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, { loads: [loadedState(scratch.root, 'REVIEWING')] });
    try {
      // Without --attended too: the ladder answers the work before the invocation.
      await run(h, scratch.root, '--publish-head');
      expect(h.out.join('')).toContain('Publication  : TASK_NOT_READY');
      expect(h.fake.calls.length).toBe(0);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses a task with no pinned commit', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, { loads: [loadedState(scratch.root, 'READY_FOR_PR', null)] });
    try {
      await run(h, scratch.root, '--publish-head', '--attended');
      expect(h.out.join('')).toContain('Publication  : SUBJECT_NOT_ESTABLISHED');
      expect(h.fake.calls.length).toBe(0);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('publishes when asked, attended, ready and absent', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, {
      publication: { lsRemote: [{ exitCode: 2 }, { exitCode: 0, stdout: `${HEAD}\t${REF}\n` }] },
    });
    try {
      await run(h, scratch.root, '--publish-head', '--attended');
      const text = h.out.join('');
      expect(text).toContain('Publication  : PUBLISHED');
      expect(text).toContain(`${REF} on ${REMOTE}`);
      expect(text).toContain('Remote before: ABSENT');
      expect(text).toContain(`Remote after : AT_COMMIT ${HEAD}`);
      expect(text).toContain(PUBLICATION_TRAILER);
      expect(h.fake.pushes()).toBe(1);
      // The push carries the exact vector, built from the task's own facts.
      const push = h.fake.calls.find((c) => vectorOf(c) === 'push') ?? [];
      expect(push).toEqual([...publishHeadArgs(REMOTE, REF, HEAD)]);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses when the task moved between the first read and the recheck', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root, {
      loads: [loadedState(scratch.root), loadedState(scratch.root, 'READY_FOR_PR', OTHER)],
    });
    try {
      await run(h, scratch.root, '--publish-head', '--attended');
      expect(h.out.join('')).toContain('Publication  : SUBJECT_CHANGED');
      expect(h.fake.calls.length).toBe(0);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses when the task left READY_FOR_PR between the first read and the recheck', async () => {
    // Same commit, same ref, same target — only the state moved. Without the
    // recheck's own state guard the subject would compare equal and the remote
    // would be contacted, so the assertion that matters is the call count.
    const scratch = scratchRoot();
    const h = harness(scratch.root, {
      loads: [loadedState(scratch.root, 'READY_FOR_PR'), loadedState(scratch.root, 'REVIEWING')],
    });
    try {
      await run(h, scratch.root, '--publish-head', '--attended');
      expect(h.out.join('')).toContain('Publication  : SUBJECT_CHANGED');
      expect(h.fake.calls.length).toBe(0);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('leaves the exit code answering only whether the observation settled', async () => {
    const previous = process.exitCode;
    const scratch = scratchRoot();
    const h = harness(scratch.root, {
      publication: { lsRemote: [{ exitCode: 2 }, { exitCode: 0, stdout: `${HEAD}\t${REF}\n` }] },
    });
    try {
      process.exitCode = undefined;
      await run(h, scratch.root, '--publish-head', '--attended');
      expect(h.out.join('')).toContain('Publication  : PUBLISHED');
      // A publication is not an observation, and the exit code says nothing
      // about it. A caller that could read "it is published" out of an exit
      // status would have a machine-consumable delivery signal this build does
      // not give.
      expect(process.exitCode).toBe(EXIT_RUN_OK);
    } finally {
      process.exitCode = previous;
      h.restore();
      scratch.cleanup();
    }
  });
});

// ── 9. The operator surface says what it can and cannot ────────────────────

describe('the surface states its own limits', () => {
  it('describes --publish-head as create-only, granted, and granting nothing', () => {
    // 'Requires --attended' stood here until V4 slice 13 gave this act a second
    // grant and made the sentence false. It is replaced rather than dropped:
    // what has to be said is that the act needs a grant and which grants exist,
    // and both spellings are named because an operator running unattended who
    // is sent to --attended has been sent to a flag their invocation refuses.
    expect(PUBLISH_HEAD_OPTION_DESCRIPTION).toContain('Requires a task at READY_FOR_PR and a grant');
    expect(PUBLISH_HEAD_OPTION_DESCRIPTION).toContain('--attended');
    expect(PUBLISH_HEAD_OPTION_DESCRIPTION).toContain('--automatic-publish-head-only');
    expect(PUBLISH_HEAD_OPTION_DESCRIPTION).toContain('READY_FOR_PR');
    expect(PUBLISH_HEAD_OPTION_DESCRIPTION).toContain('Create-only');
    expect(PUBLISH_HEAD_OPTION_DESCRIPTION).toContain('opens no pull request');
    expect(PUBLISH_HEAD_OPTION_DESCRIPTION).toContain('writes no task state');
  });

  it('describes --attended as presence, and as the only grant for the other two acts', () => {
    expect(ATTENDED_OPTION_DESCRIPTION).toContain('operator is present');
    // 'no unattended publication' stood here and V4 slice 13 made it false. The
    // half that is still true is asserted instead, and it is the half that
    // matters: the two acts with the largest blast radius have exactly one
    // grant, and this flag is it.
    expect(ATTENDED_OPTION_DESCRIPTION).toContain('no unattended ' + 'pull request and no unattended merge');
    expect(ATTENDED_OPTION_DESCRIPTION).toContain('--automatic-publish-head-only');
    expect(ATTENDED_OPTION_DESCRIPTION).not.toContain('no unattended publication');
  });

  it('keeps the command description true of the whole surface', () => {
    // Slices 2, 3 and 4's clauses must survive slice 5 rather than be replaced.
    for (const clause of [
      'two read-only questions',
      '--record',
      'historical record',
      '--decide',
      'not merge eligibility',
      '--publish-head',
      'create-only',
      'writes no task state',
    ]) {
      expect(DELIVERY_COMMAND_DESCRIPTION, clause).toContain(clause);
    }
    // And the clause slice 5 falsified must be gone.
    expect(DELIVERY_COMMAND_DESCRIPTION).not.toContain('Contacts nothing without --observe');
    // `opens no pull request` was in the list above and is gone from both, for
    // the same reason and one slice later: V4 slice 6 opens one. The clause is
    // not merely removed from the pin — it must be absent from the description,
    // or the description would be claiming something the build no longer does.
    expect(DELIVERY_COMMAND_DESCRIPTION).not.toContain('opens no pull request');
    // What replaced it is a narrower claim that is still true, and it is pinned
    // here so removing it is a visible act.
    //
    // Narrowed once more at V4 slice 7, which merges one: "or merges" had to go
    // for the reason "opens no pull request" went one slice earlier, and the
    // clause must be ABSENT rather than merely unpinned. What is left is the
    // set of things still true, and `--merge-pr` is why "reopens", "comments
    // on", "labels" and "auto-merge" were spelled out rather than left implied.
    expect(DELIVERY_COMMAND_DESCRIPTION).not.toContain(
      'never updates, closes, reviews or merges a pull request',
    );
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain(
      'never updates, closes, reopens, reviews, comments on or labels a pull request',
    );
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('never enables an auto-merge');
  });

  it('registers both flags with the sentences that were pinned, not copies', () => {
    // Pinning the constants by literal proves what they say; it does not prove
    // commander was given them. Slices 2, 3 and 4 each pin their own flag's
    // wiring for that reason, and an inline copy at the registration site would
    // pass every other assertion in this file.
    const program = new Command();
    registerDeliveryCommand(program, {});
    const delivery = program.commands.find((c) => c.name() === 'delivery');
    const help = delivery?.helpInformation() ?? '';
    const collapse = (t: string): string => t.replace(/\s+/g, ' ').trim();
    expect(help).toContain('--publish-head');
    expect(help).toContain('--attended');
    expect(collapse(help)).toContain(collapse(PUBLISH_HEAD_OPTION_DESCRIPTION));
    expect(collapse(help)).toContain(collapse(ATTENDED_OPTION_DESCRIPTION));
  });

  it('registers no option this build refuses to name', () => {
    // The repository bans force/unattended/adopt/takeover/steal in a flag
    // string. Checked against the live program rather than remembered.
    const flags = buildProgram()
      .commands.flatMap((c) => c.options.map((o) => o.flags))
      .join(' ');
    expect(flags).toMatch(/--publish-head/);
    expect(flags).not.toMatch(/force|unattended|adopt|takeover|steal/i);
  });

  it('shows an operator a block the emitter really produces', () => {
    // The README's sample is quoted, and a quoted sample drifts. It is compared
    // against the real renderer here rather than eyeballed: the emitter is the
    // only authority for what an operator sees, and a sample that has to be
    // remembered is a sample that will be wrong.
    const rendered = renderDeliveryObservation({
      repositoryId: 'ao',
      repositoryRoot: 'D:\\Work\\my-repo',
      taskId: 'T-001',
      subject: { ok: false, refusal: 'DELIVERY_NOT_DECLARED' } as never,
      observation: null,
      conclusion: 'NOT_OBSERVED' as never,
      stored: null,
      recording: null,
      decision: null,
      publication: {
        result: {
          publication: 'PUBLISHED',
          before: ABSENT,
          attempt: 'COMPLETED' as PublicationAttempt,
          after: at(HEAD),
          commandReport: 'RAN_TO_EXIT_ZERO' as const,
        },
        ref: REF,
        remoteName: REMOTE,
        outcome: null,
      },
    });

    const block = rendered
      .split('\n')
      .slice(
        rendered.split('\n').findIndex((l) => l.startsWith('Publication  :')),
      )
      .filter((l) => l.trim() !== '')
      .slice(0, 6)
      .join('\n');

    const readme = readFileSync('README.md', 'utf8');
    expect(readme, 'the sample block must be present in the README').toContain(block);
  });

  it('never opens the trailer with "Read-only." on a run that published', () => {
    // The arm that had no test, and the defect that got in because of it: the
    // fix for a dropped disclosure reused a sentence written to be a whole
    // read-only trailer, so a run that created a branch closed with the word
    // "Read-only.". Both halves are asserted, because dropping the disclosure
    // again would be the other half of the same mistake.
    const rendered = renderDeliveryObservation({
      repositoryId: 'ao',
      repositoryRoot: 'D:\\Work\\my-repo',
      taskId: 'T-001',
      subject: { ok: false, refusal: 'DELIVERY_NOT_DECLARED' } as never,
      // A settled observation AND a publication that contacted the remote.
      observation: { pullRequest: { outcome: 'NO_MATCHING_PULL_REQUEST' }, checks: { outcome: 'NO_CHECKS' } } as never,
      conclusion: 'OBSERVED' as never,
      stored: null,
      recording: null,
      decision: null,
      publication: {
        result: {
          publication: 'PUBLISHED',
          before: ABSENT,
          attempt: 'COMPLETED' as PublicationAttempt,
          after: at(HEAD),
          commandReport: 'RAN_TO_EXIT_ZERO' as const,
        },
        ref: REF,
        remoteName: REMOTE,
        outcome: null,
      },
    });

    expect(rendered).toContain(PUBLICATION_TRAILER);
    expect(rendered).toContain(OBSERVED_AND_CHANGED_TRAILER);
    // The disclosure the fix existed to keep.
    expect(rendered).toContain('L-V4-02-6');
    // And the framing that stopped being true.
    expect(rendered).not.toContain('Read-only.');
    expect(rendered).not.toContain(CONTACTED_TRAILER);

    // The control: an observation with no publication still gets it, so the
    // assertion above is about the publication and not about the fixture.
    const observedOnly = renderDeliveryObservation({
      repositoryId: 'ao',
      repositoryRoot: 'D:\\Work\\my-repo',
      taskId: 'T-001',
      subject: { ok: false, refusal: 'DELIVERY_NOT_DECLARED' } as never,
      observation: { pullRequest: { outcome: 'NO_MATCHING_PULL_REQUEST' }, checks: { outcome: 'NO_CHECKS' } } as never,
      conclusion: 'OBSERVED' as never,
      stored: null,
      recording: null,
      decision: null,
      publication: null,
    });
    expect(observedOnly).toContain(CONTACTED_TRAILER);
    expect(observedOnly).toContain('Read-only.');
  });

  it('states the new network access in the top-level help, and stops claiming there is none', () => {
    const top = buildProgram().description().replace(/\s+/g, ' ');
    expect(top).toContain('--publish-head');
    // The sentence that said the command contacts no forge without --observe.
    expect(top).not.toContain('Without --observe the command starts no client');
    expect(top).toContain('Given none of the flags named above');

    // ── The clause that had to be rewritten, and why it is asserted this way ──
    //
    // This line used to read: `expect(top).toContain('Opening pull requests is
    // not in this build')`, under the comment "still not in this build, and
    // must still say so". It was true at slice 5. **V4 slice 6 made it false
    // and did not come back here**, so from that day the top-level help denied
    // a capability the build had, and this test held the denial in place — a
    // pin guarding a lie, which is worse than no pin. Slice 7 made it false
    // twice over. Slice 12's sweep found it and corrected the help.
    //
    // The replacement asserts the rule rather than a list of acts, because a
    // list beside a growing surface is exactly what went stale here: what the
    // build refuses is *deciding* a merge is warranted, and what it permits is
    // performing one an operator asked for in that invocation.
    expect(top).toContain('Deciding that a merge is WARRANTED is not in this build');
    expect(top).not.toContain('Opening pull requests is not in this build');
    // And the three acts that reach github.com are named, each needing
    // `--attended`. `--publish-head` is asserted above; the other two were
    // absent from this description entirely until slice 12.
    expect(top).toContain('--create-pr');
    expect(top).toContain('--merge-pr');
    // The superlative that went with it, and died the same way: `--publish-head`
    // was called "the one thing any command in this build can change outside
    // this machine" — false since slice 6, false again since slice 7.
    expect(top).not.toContain('the one thing any command');
    expect(top).toContain('Three flags can change something outside this machine');
  });
});
