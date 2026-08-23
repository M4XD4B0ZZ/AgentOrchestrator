/**
 * V4 slice 3 — durable delivery evidence.
 *
 * The suite attacks the durability boundary rather than the serialisation. A
 * test that writes a record and reads it back proves JSON works; it proves
 * nothing about the three properties this slice exists for:
 *
 *  1. **provenance** — a record claiming "AO observed GitHub" may only come
 *     from an observation that happened. The counter-proof is a shape-valid
 *     forgery, driven through the same argument, refused;
 *  2. **exact binding** — a record about commit A must never satisfy a question
 *     about commit B, about another task, or about another repository on
 *     another host;
 *  3. **history is not truth** — a stored `SUCCESS` is never reported as a
 *     current success, and no elapsed interval turns one into the other.
 *
 * Nothing here contacts a network. Every observation runs against an injected
 * runner, for the reason slice 2's suite gives: the canonical gate must be
 * deterministic on a machine that has never run `gh auth login`, and CI has no
 * credentials at all.
 *
 * Real files are used throughout rather than a mocked filesystem. The atomicity
 * claim is about `rename` on a real directory, and a fake would be this build
 * asserting against its own idea of what the OS does.
 */

import { Command } from 'commander';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DELIVERY_COMMAND_DESCRIPTION,
  RECORD_OPTION_DESCRIPTION,
  RECORD_REFUSAL_DETAIL,
  RECORD_REFUSALS,
  registerDeliveryCommand,
} from '../src/cli/delivery-command.js';
import {
  HISTORICAL_LABEL,
  EVIDENCE_AGREEMENT_SUFFIX,
  EVIDENCE_DISAGREEMENT_PREFIX,
  renderStoredEvidenceLine,
} from '../src/cli/render-delivery-observation.js';
import { buildProgram } from '../src/cli/index.js';
import { isValidTaskId } from '../src/plan/task-id.js';
import { deriveTaskStateLocation } from '../src/state/state-location.js';
import { TERMINAL_STATES } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import {
  DELIVERY_EVIDENCE_READINGS,
  DELIVERY_EVIDENCE_READING_DETAIL,
  DELIVERY_EVIDENCE_VERSION,
  DeliveryEvidenceSchema,
  MAX_DELIVERY_EVIDENCE_BYTES,
  RECORDABLE_CHECK_OUTCOMES,
  RECORDABLE_PULL_REQUEST_OUTCOMES,
  REMOTE_FRESHNESS_SENTENCE,
  deliveryEvidenceBinding,
  isHistoricalDeliveryEvidence,
  readDeliveryEvidence,
} from '../src/deliver/delivery-evidence.js';
import {
  DELIVERY_EVIDENCE_DIR_NAME,
  DELIVERY_EVIDENCE_FILE_EXTENSION,
  deriveDeliveryEvidenceLocation,
  isDeliveryEvidenceFileName,
  loadDeliveryEvidence,
  recordDeliveryEvidence,
  type IgnoreVerdict,
} from '../src/deliver/delivery-evidence-store.js';
import {
  deliveryObservationFactsOf,
  isDeliveryObservationProof,
} from '../src/deliver/delivery-observation-proof.js';
import { createObservationSubject } from '../src/deliver/forge-observation.js';
import {
  attestDeliveryObservation,
  type DeliveryObservation,
} from '../src/deliver/observe-delivery.js';
import type { ResolvedDelivery } from '../src/deliver/delivery-target.js';
import type { StateLoadResult } from '../src/state/state-store.js';
import type { CommandResult } from '../src/doctor/exec.js';
import type { ForgeCommandRunner } from '../src/deliver/github-observer.js';

// ── fixtures ───────────────────────────────────────────────────────────────

const HEAD: string = '10583ee91a5747d0049f563ffaac64b0cf643aeb';
const OTHER: string = 'c89ef605400a15e5d3db4d256c184773c0d533f6';
const BASE: string = '46629f0503b0126318ead7229eba7a84d3e7504a';
const REV = 'a'.repeat(64);
const OTHER_REV = 'b'.repeat(64);
const AT = '2026-08-23T14:00:00.000Z';

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

function subjectOf(commit = HEAD, identity = IDENTITY) {
  const built = createObservationSubject(identity, commit);
  if (!built.ok) throw new Error(`fixture subject refused: ${built.refusal}`);
  return built.subject;
}

/** A settled observation: one matched pull request and two green check runs. */
function settled(commit = HEAD): DeliveryObservation {
  return Object.freeze({
    pullRequest: Object.freeze({ outcome: 'MATCHED' as const, pullRequest: 56 }),
    checks: Object.freeze({
      outcome: 'SUCCESS' as const,
      counts: Object.freeze({
        checkRuns: 2,
        commitStatuses: 0,
        failed: 0,
        pending: 0,
        succeeded: 2,
        neutralOrSkipped: 0,
      }),
    }),
  }) as DeliveryObservation & { readonly _commit?: typeof commit };
}

/** An observation that refused. Nothing was established. */
function refused(): DeliveryObservation {
  return Object.freeze({
    pullRequest: Object.freeze({ outcome: 'NOT_AUTHENTICATED' as const }),
    checks: Object.freeze({ outcome: 'NOT_AUTHENTICATED' as const }),
  }) as DeliveryObservation;
}

function provenProof(commit = HEAD, identity = IDENTITY) {
  const proof = attestDeliveryObservation(subjectOf(commit, identity), settled(commit), AT);
  if (proof === null) throw new Error('fixture proof was refused');
  return proof;
}

const SUBJECT = Object.freeze({
  taskId: 'T-001',
  repositoryRoot: 'D:\\repo',
  stateRevision: REV,
});

interface ExpectedBinding {
  readonly subjectCommit: string;
  readonly host: string;
  readonly owner: string;
  readonly name: string;
  readonly declaredRemote: string;
}

const EXPECTED: ExpectedBinding = Object.freeze({
  subjectCommit: HEAD,
  host: IDENTITY.host,
  owner: IDENTITY.owner,
  name: IDENTITY.name,
  declaredRemote: 'origin',
});

/** A scratch repository root. Never the real one. */
function scratchRoot(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ao-v403-'));
  mkdirSync(join(root, '.agent-orchestrator', 'runtime', DELIVERY_EVIDENCE_DIR_NAME), {
    recursive: true,
  });
  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // A scratch directory that could not be removed is not a test failure.
      }
    },
  };
}

const ALWAYS_IGNORED = async (): Promise<IgnoreVerdict> => 'IGNORED';

/**
 * A source file with its comments removed.
 *
 * Two of the assertions below are about what the code *does*, and the first
 * version of each scanned the whole file — so they failed on the prose that
 * explains why the thing is not done. Banning a word outright also bans saying
 * why it was rejected, which is the opposite of what this repository wants from
 * a header.
 *
 * The stripper is deliberately simple and its limit is stated rather than
 * hidden: a `//` inside a string literal would be treated as a comment. No file
 * scanned here contains one, and the positive controls beside each use would
 * fail if a file ever emptied out.
 */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A complete CommandResult, so a fixture cannot drift from the real shape. */
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

interface WriteOver {
  readonly proof?: unknown;
  readonly expectedSubjectCommit?: string;
  readonly expectedHost?: string;
  readonly expectedOwner?: string;
  readonly expectedName?: string;
  readonly declaredRemote?: string;
  readonly stateRevision?: string;
  readonly taskId?: string;
  readonly checkIgnored?: (relativePath: string) => Promise<IgnoreVerdict>;
  readonly replace?: (from: string, to: string) => void;
}

async function write(root: string, over: WriteOver = {}) {
  const taskId = over.taskId ?? 'T-001';
  return recordDeliveryEvidence({
    repositoryRoot: root,
    taskId,
    subject: { taskId, repositoryRoot: root, stateRevision: over.stateRevision ?? REV },
    taskState: 'READY_FOR_PR',
    basePinnedCommit: BASE,
    declaredRemote: over.declaredRemote ?? 'origin',
    expectedSubjectCommit: over.expectedSubjectCommit ?? HEAD,
    expectedHost: over.expectedHost ?? IDENTITY.host,
    expectedOwner: over.expectedOwner ?? IDENTITY.owner,
    expectedName: over.expectedName ?? IDENTITY.name,
    proof: 'proof' in over ? over.proof : provenProof(),
    recordedAt: AT,
    checkIgnored: over.checkIgnored ?? ALWAYS_IGNORED,
    ...(over.replace === undefined ? {} : { replace: over.replace }),
  });
}

function read(root: string, over: Partial<ExpectedBinding> & { taskId?: string; stateRevision?: string } = {}) {
  const taskId = over.taskId ?? 'T-001';
  return loadDeliveryEvidence(
    root,
    taskId,
    { taskId, repositoryRoot: root, stateRevision: over.stateRevision ?? REV },
    { ...EXPECTED, ...over },
  );
}

function recordPath(root: string, taskId = 'T-001'): string {
  return join(
    root,
    '.agent-orchestrator',
    'runtime',
    DELIVERY_EVIDENCE_DIR_NAME,
    `${taskId}${DELIVERY_EVIDENCE_FILE_EXTENSION}`,
  );
}

// ── 1. Provenance: a claim must come from an observation ───────────────────

describe('a forge-observation claim cannot be manufactured', () => {
  it('mints for a settled observation, and the artefact is opaque', () => {
    const proof = provenProof();
    expect(isDeliveryObservationProof(proof)).toBe(true);
    const facts = deliveryObservationFactsOf(proof);
    expect(facts?.commit).toBe(HEAD);
    expect(facts?.pullRequestNumber).toBe(56);
    expect(facts?.observedAt).toBe(AT);
  });

  /**
   * The counter-proof that matters. A structural type cannot carry provenance,
   * and this is the value that proves it: every field the real artefact holds,
   * written down by a caller who observed nothing.
   */
  it('refuses a shape-equivalent object with every field the real one has', async () => {
    const real = deliveryObservationFactsOf(provenProof());
    expect(real).not.toBeNull();
    // Built FROM the real facts, so it is not a weaker imitation — it is the
    // same data, and the only thing it lacks is having been minted.
    const forged = { ...(real as object) };
    expect(isDeliveryObservationProof(forged)).toBe(false);
    expect(deliveryObservationFactsOf(forged)).toBeNull();

    const scratch = scratchRoot();
    try {
      const result = await write(scratch.root, { proof: forged });
      expect(result.code).toBe('OBSERVATION_NOT_PROVEN');
      expect(result.recorded).toBe(false);
      // And the refusal is a refusal to *act*, not merely a returned code:
      // nothing was created, not even the directory.
      expect(existsSync(recordPath(scratch.root))).toBe(false);
    } finally {
      scratch.cleanup();
    }
  });

  it('refuses a prototype-borrowed forgery and a reached constructor', () => {
    const real = provenProof();
    const borrowed = Object.create(Object.getPrototypeOf(real) as object) as object;
    expect(isDeliveryObservationProof(borrowed)).toBe(false);
    // The constructor route, which defeated an earlier artefact in this
    // codebase: reachable from any instance, so it is deleted and the
    // prototype frozen.
    const proto = Object.getPrototypeOf(real) as { constructor?: unknown };
    expect(proto.constructor).toBe(Object);
    expect(Object.isFrozen(proto)).toBe(true);
  });

  it('cannot have its gate turned off process-wide', () => {
    const real = provenProof();
    // `WeakSet.prototype.has` is captured and bound at module load, so
    // replacing it afterwards changes nothing.
    const original = WeakSet.prototype.has;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (WeakSet.prototype as any).has = (): boolean => true;
      expect(isDeliveryObservationProof({})).toBe(false);
      expect(isDeliveryObservationProof(real)).toBe(true);
    } finally {
      WeakSet.prototype.has = original;
    }
  });

  /**
   * A refusal is not a weaker observation. There is no proof shape in which
   * `NOT_AUTHENTICATED` can be stored, so an unavailable forge cannot be
   * promoted into a record.
   */
  it('mints nothing for an observation that did not settle', () => {
    expect(attestDeliveryObservation(subjectOf(), refused(), AT)).toBeNull();
    // One half settled is still not settled.
    const halfway = Object.freeze({
      pullRequest: Object.freeze({ outcome: 'MATCHED' as const, pullRequest: 56 }),
      checks: Object.freeze({ outcome: 'REQUEST_FAILED' as const }),
    }) as DeliveryObservation;
    expect(attestDeliveryObservation(subjectOf(), halfway, AT)).toBeNull();
    const otherHalf = Object.freeze({
      pullRequest: Object.freeze({ outcome: 'RESULTS_TRUNCATED' as const }),
      checks: settled().checks,
    }) as DeliveryObservation;
    expect(attestDeliveryObservation(subjectOf(), otherHalf, AT)).toBeNull();
  });

  it('mints nothing for a MATCHED outcome carrying no pull request', () => {
    const inconsistent = Object.freeze({
      pullRequest: Object.freeze({ outcome: 'MATCHED' as const }),
      checks: settled().checks,
    }) as DeliveryObservation;
    expect(attestDeliveryObservation(subjectOf(), inconsistent, AT)).toBeNull();
  });

  it('mints nothing for a graded check outcome carrying no counts', () => {
    const noCounts = Object.freeze({
      pullRequest: settled().pullRequest,
      checks: Object.freeze({ outcome: 'SUCCESS' as const }),
    }) as DeliveryObservation;
    expect(attestDeliveryObservation(subjectOf(), noCounts, AT)).toBeNull();
  });

  it('mints nothing for an instant that is not one', () => {
    expect(attestDeliveryObservation(subjectOf(), settled(), 'yesterday')).toBeNull();
    expect(attestDeliveryObservation(subjectOf(), settled(), '')).toBeNull();
  });

  /**
   * The reachability pin. The guarantee is "product code cannot go around the
   * boundary", and it is worth exactly as much as the number of modules that
   * can reach the mint.
   */
  it('is minted from exactly one module beside its own public wrapper', () => {
    // Walks the whole of `src/` rather than a list written here.
    //
    // The first version filtered a hand-written array of eight files, which is
    // not a reachability check at all: a ninth module anywhere in `src/`
    // importing the mint — the exact event this pin exists to prevent — would
    // have left it green. A review caught that, and it is the difference
    // between a pin and a note.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && full.endsWith('.ts') ? [full] : [];
      });
    const sources = walk('src');
    // Positive control: the walk really found the tree, not an empty directory.
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain('src/deliver/observe-delivery.ts');

    // Import statements in code, not mentions in prose. One earlier version
    // matched the raw text and caught `delivery-evidence.ts`, whose header
    // *names* the mint while importing nothing from it — a scan that cannot
    // tell a citation from a dependency is not measuring reachability either.
    //
    // And the specifier is matched by its **file name**, not by requiring an
    // `internal/` segment. A second review found that hole: the version that
    // required the segment could not see a module placed *inside*
    // `src/deliver/internal/`, which would import its neighbour as
    // `'./delivery-observation-proof.js'` — and that directory is precisely
    // where a new collaborator of the mint would be put. The fix had moved the
    // hole rather than closed it.
    const specifier = /from\s+'([^']*delivery-observation-proof\.js)'/g;
    const importers = sources
      .filter((file) => {
        const code = codeOnly(file);
        for (const match of code.matchAll(specifier)) {
          const found = match[1] ?? '';
          // The public wrapper is a different module and importing *it* is
          // ordinary. Only the mint's own module is restricted, and it is
          // named by the last path segment either way it is spelled.
          const target = found.split('/').slice(-2).join('/');
          if (target === 'internal/delivery-observation-proof.js') return true;
          if (
            found === './delivery-observation-proof.js' &&
            file.startsWith('src/deliver/internal/')
          ) {
            return true;
          }
        }
        return false;
      })
      .sort();
    expect(importers).toEqual([
      'src/deliver/delivery-observation-proof.ts',
      'src/deliver/observe-delivery.ts',
    ]);

    // Positive control on the search itself: it finds the mint's own name where
    // one exists, so an empty result above would be a fact about the tree and
    // not about the scan.
    expect(readFileSync('src/deliver/observe-delivery.ts', 'utf8')).toContain(
      'mintDeliveryObservation',
    );
    // Nothing anywhere may re-export the mint or the class, which would walk
    // past the import pin entirely.
    for (const file of sources) {
      if (file === 'src/deliver/internal/delivery-observation-proof.ts') continue;
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/export\s*\{[^}]*mintDeliveryObservation/);
      expect(source).not.toMatch(/export\s*\{[^}]*DeliveryObservationEvidence/);
    }
    // And the mint's name may not appear in the public wrapper at all, which
    // would be a re-export in all but name.
    expect(readFileSync('src/deliver/delivery-observation-proof.ts', 'utf8')).not.toContain(
      'mintDeliveryObservation',
    );
    // No dynamic import can route around the static scan either.
    for (const file of sources) {
      expect(readFileSync(file, 'utf8')).not.toMatch(
        /import\s*\(\s*[^)]*delivery-observation-proof/,
      );
    }
  });
});

// ── 2. Exact subject binding ───────────────────────────────────────────────

describe('evidence about one commit never answers about another', () => {
  it('refuses to record an observation of a different commit', async () => {
    const scratch = scratchRoot();
    try {
      const result = await write(scratch.root, {
        proof: provenProof(OTHER),
        expectedSubjectCommit: HEAD,
      });
      expect(result.code).toBe('SUBJECT_MISMATCH');
      expect(existsSync(recordPath(scratch.root))).toBe(false);
    } finally {
      scratch.cleanup();
    }
  });

  it('refuses to record an observation of another repository', async () => {
    const scratch = scratchRoot();
    try {
      const elsewhere = { host: 'github.com', owner: 'Someone', name: 'Fork' };
      const result = await write(scratch.root, { proof: provenProof(HEAD, elsewhere) });
      expect(result.code).toBe('SUBJECT_MISMATCH');
      expect(existsSync(recordPath(scratch.root))).toBe(false);
    } finally {
      scratch.cleanup();
    }
  });

  /**
   * The headline case from the ADR, in durable form. An old green commit's
   * record must never satisfy a question about the head that replaced it.
   */
  it('an old green record does not answer for a new subject', async () => {
    const scratch = scratchRoot();
    try {
      expect((await write(scratch.root)).code).toBe('RECORDED');
      // The task moves on: a new commit, and a new state revision with it.
      const later = read(scratch.root, { subjectCommit: OTHER, stateRevision: OTHER_REV });
      expect(later.reading).toBe('LOCAL_BINDING_MISMATCH');
      expect(isHistoricalDeliveryEvidence(later.reading)).toBe(false);
      // Positive control: the same bytes still answer for the subject they are
      // about, so the refusal above is about the subject and not about the file.
      expect(read(scratch.root).reading).toBe('HISTORICAL_VALID');
    } finally {
      scratch.cleanup();
    }
  });

  it('refuses a record whose pull-request head contradicts its own subject', () => {
    const payload = {
      evidenceVersion: DELIVERY_EVIDENCE_VERSION,
      taskId: SUBJECT.taskId,
      repositoryRoot: SUBJECT.repositoryRoot,
      taskState: 'READY_FOR_PR',
      stateRevision: REV,
      subjectCommit: HEAD,
      basePinnedCommit: BASE,
      provider: 'github' as const,
      host: IDENTITY.host,
      owner: IDENTITY.owner,
      name: IDENTITY.name,
      declaredRemote: 'origin',
      pullRequestOutcome: 'MATCHED' as const,
      pullRequestNumber: 56,
      // The contradiction: #56's head is said to be a commit that is not the
      // subject this record is evidence about.
      pullRequestHeadSha: OTHER,
      checkQueriedCommit: HEAD,
      checkOutcome: 'SUCCESS' as const,
      checkRuns: 2,
      commitStatuses: 0,
      checksFailed: 0,
      checksPending: 0,
      checksSucceeded: 2,
      checksNeutralOrSkipped: 0,
      observedAt: AT,
      recordedAt: AT,
    };
    const record = { ...payload, binding: deliveryEvidenceBinding(SUBJECT, payload) };
    // Correctly bound and internally false: the binding cannot save it.
    expect(readDeliveryEvidence(record, SUBJECT, EXPECTED)).toBe('MALFORMED');
  });

  it('refuses a record whose check answer is about another commit', () => {
    const payload = {
      evidenceVersion: DELIVERY_EVIDENCE_VERSION,
      taskId: SUBJECT.taskId,
      repositoryRoot: SUBJECT.repositoryRoot,
      taskState: 'READY_FOR_PR',
      stateRevision: REV,
      subjectCommit: HEAD,
      basePinnedCommit: null,
      provider: 'github' as const,
      host: IDENTITY.host,
      owner: IDENTITY.owner,
      name: IDENTITY.name,
      declaredRemote: 'origin',
      pullRequestOutcome: 'NO_MATCHING_PULL_REQUEST' as const,
      pullRequestNumber: null,
      pullRequestHeadSha: null,
      checkQueriedCommit: OTHER,
      checkOutcome: 'SUCCESS' as const,
      checkRuns: 1,
      commitStatuses: 0,
      checksFailed: 0,
      checksPending: 0,
      checksSucceeded: 1,
      checksNeutralOrSkipped: 0,
      observedAt: AT,
      recordedAt: AT,
    };
    const record = { ...payload, binding: deliveryEvidenceBinding(SUBJECT, payload) };
    expect(readDeliveryEvidence(record, SUBJECT, EXPECTED)).toBe('MALFORMED');
  });

  it('refuses a non-matched record that names a pull request anyway', () => {
    const base = {
      evidenceVersion: DELIVERY_EVIDENCE_VERSION,
      taskId: SUBJECT.taskId,
      repositoryRoot: SUBJECT.repositoryRoot,
      taskState: 'READY_FOR_PR',
      stateRevision: REV,
      subjectCommit: HEAD,
      basePinnedCommit: null,
      provider: 'github' as const,
      host: IDENTITY.host,
      owner: IDENTITY.owner,
      name: IDENTITY.name,
      declaredRemote: 'origin',
      pullRequestOutcome: 'NO_MATCHING_PULL_REQUEST' as const,
      pullRequestNumber: 56,
      pullRequestHeadSha: null,
      checkQueriedCommit: HEAD,
      checkOutcome: 'NO_CHECKS' as const,
      checkRuns: 0,
      commitStatuses: 0,
      checksFailed: 0,
      checksPending: 0,
      checksSucceeded: 0,
      checksNeutralOrSkipped: 0,
      observedAt: AT,
      recordedAt: AT,
    };
    expect(DeliveryEvidenceSchema.safeParse({ ...base, binding: 'f'.repeat(64) }).success).toBe(
      false,
    );
  });
});

// ── 3. Target binding ──────────────────────────────────────────────────────

describe('evidence is bound to one delivery target', () => {
  it.each([
    ['host', { host: 'example.com' }],
    ['owner', { owner: 'Someone' }],
    ['repository name', { name: 'Other' }],
    ['declared remote', { declaredRemote: 'fork' }],
  ])('refuses a record when the %s now resolves differently', async (_what, over) => {
    const scratch = scratchRoot();
    try {
      expect((await write(scratch.root)).code).toBe('RECORDED');
      expect(read(scratch.root, over).reading).toBe('LOCAL_BINDING_MISMATCH');
      // Positive control beside every case: unchanged, the same bytes read back.
      expect(read(scratch.root).reading).toBe('HISTORICAL_VALID');
    } finally {
      scratch.cleanup();
    }
  });

  it('refuses a record copied into another task', async () => {
    const scratch = scratchRoot();
    try {
      expect((await write(scratch.root, { taskId: 'T-001' })).code).toBe('RECORDED');
      // The file, moved to another task's name. Everything inside it is intact.
      const bytes = readFileSync(recordPath(scratch.root, 'T-001'));
      writeFileSync(recordPath(scratch.root, 'T-002'), bytes);
      expect(read(scratch.root, { taskId: 'T-002' }).reading).toBe('NOT_THIS_TASK');
    } finally {
      scratch.cleanup();
    }
  });

  /**
   * What a *recomputed* binding still has to satisfy.
   *
   * The copied-file case above is caught by the digest, because the digest is
   * taken over the reader's own task identity. So it cannot tell whether the
   * agreement checks below do anything — and a mutant that deleted them
   * survived it. This is the case that separates them: the binding is
   * recomputed for the new task, correctly, and the payload still says it is
   * about the old one.
   *
   * The header is blunt that anyone who can write the file can recompute the
   * digest. These checks are what such an author still cannot satisfy without
   * also rewriting the claim itself.
   */
  it('refuses a record whose binding was recomputed but whose payload names another task', () => {
    const payload = {
      evidenceVersion: DELIVERY_EVIDENCE_VERSION,
      // The claim: this is T-001's evidence.
      taskId: 'T-001',
      repositoryRoot: SUBJECT.repositoryRoot,
      taskState: 'READY_FOR_PR',
      stateRevision: REV,
      subjectCommit: HEAD,
      basePinnedCommit: BASE,
      provider: 'github' as const,
      host: IDENTITY.host,
      owner: IDENTITY.owner,
      name: IDENTITY.name,
      declaredRemote: 'origin',
      pullRequestOutcome: 'MATCHED' as const,
      pullRequestNumber: 56,
      pullRequestHeadSha: HEAD,
      checkQueriedCommit: HEAD,
      checkOutcome: 'SUCCESS' as const,
      checkRuns: 2,
      commitStatuses: 0,
      checksFailed: 0,
      checksPending: 0,
      checksSucceeded: 2,
      checksNeutralOrSkipped: 0,
      observedAt: AT,
      recordedAt: AT,
    };
    // Read as T-002's evidence, with the digest recomputed for T-002 so the
    // binding check passes.
    const asT002 = { taskId: 'T-002', repositoryRoot: SUBJECT.repositoryRoot, stateRevision: REV };
    const record = { ...payload, binding: deliveryEvidenceBinding(asT002, payload) };
    expect(readDeliveryEvidence(record, asT002, EXPECTED)).toBe('NOT_THIS_TASK');

    // Positive control: the same construction, honestly done, reads back. So
    // the refusal above is about the disagreement and not about the fixture.
    const honest = { ...payload, taskId: 'T-002' };
    expect(
      readDeliveryEvidence(
        { ...honest, binding: deliveryEvidenceBinding(asT002, honest) },
        asT002,
        EXPECTED,
      ),
    ).toBe('HISTORICAL_VALID');

    // And the same for the repository root, which is the other half of the
    // identity a recomputed digest cannot fix.
    const elsewhere = { taskId: 'T-001', repositoryRoot: 'D:\\other', stateRevision: REV };
    const rebound = { ...payload, binding: deliveryEvidenceBinding(elsewhere, payload) };
    expect(readDeliveryEvidence(rebound, elsewhere, EXPECTED)).toBe('NOT_THIS_TASK');
  });

  /**
   * Every payload field is covered by the binding digest, asserted against the
   * digest itself.
   *
   * The on-disk loop below is not this proof and a review showed why: it
   * collapses every refusal into one boolean, so for the eleven fields governed
   * by a regex, an enum, a literal or the version arm the mutated value is
   * refused *before* the digest is ever consulted. Delete `observedAt` from
   * `deliveryEvidenceBinding`'s input list and that loop still passes — while an
   * on-disk record's instant could then be rewritten to any valid ISO string and
   * still read `HISTORICAL_VALID`.
   *
   * This checks the property directly instead: change one field, and the digest
   * must change. A field left out of the digest fails here and nowhere else.
   */
  it('covers every payload field in the binding digest', () => {
    const scratchSubject = { taskId: 'T-001', repositoryRoot: 'D:\\repo', stateRevision: REV };
    const payload = {
      evidenceVersion: DELIVERY_EVIDENCE_VERSION,
      taskId: 'T-001',
      repositoryRoot: 'D:\\repo',
      taskState: 'READY_FOR_PR',
      stateRevision: REV,
      subjectCommit: HEAD,
      basePinnedCommit: BASE,
      provider: 'github' as const,
      host: IDENTITY.host,
      owner: IDENTITY.owner,
      name: IDENTITY.name,
      declaredRemote: 'origin',
      pullRequestOutcome: 'MATCHED' as const,
      pullRequestNumber: 56,
      pullRequestHeadSha: HEAD,
      checkQueriedCommit: HEAD,
      checkOutcome: 'SUCCESS' as const,
      checkRuns: 2,
      commitStatuses: 0,
      checksFailed: 0,
      checksPending: 0,
      checksSucceeded: 2,
      checksNeutralOrSkipped: 0,
      observedAt: AT,
      recordedAt: AT,
    };
    const original = deliveryEvidenceBinding(scratchSubject, payload);
    const fields = Object.keys(payload);
    // Positive controls: this really is the whole payload — it satisfies the
    // schema when the digest is attached, and it is the full field count, so a
    // loop that silently covered three fields cannot pass.
    expect(DeliveryEvidenceSchema.safeParse({ ...payload, binding: original }).success).toBe(true);
    expect(fields.length).toBe(25);

    for (const field of fields) {
      const mutated = { ...payload } as Record<string, unknown>;
      const value = mutated[field];
      mutated[field] =
        typeof value === 'number' ? value + 1 : typeof value === 'string' ? `${value}x` : 'x';
      expect(
        deliveryEvidenceBinding(scratchSubject, mutated as typeof payload),
        `field ${field} is not covered by the binding digest`,
      ).not.toBe(original);
    }

    // And the subject's own identity is covered too, which is what makes a
    // record copied into another task fail before any agreement check runs.
    expect(
      deliveryEvidenceBinding({ ...scratchSubject, taskId: 'T-002' }, payload),
    ).not.toBe(original);
    expect(
      deliveryEvidenceBinding({ ...scratchSubject, repositoryRoot: 'D:\\other' }, payload),
    ).not.toBe(original);
  });

  it('detects a per-field edit for every field the payload carries', async () => {
    const scratch = scratchRoot();
    try {
      expect((await write(scratch.root)).code).toBe('RECORDED');
      const original = JSON.parse(readFileSync(recordPath(scratch.root), 'utf8')) as Record<
        string,
        unknown
      >;
      const fields = Object.keys(original).filter((key) => key !== 'binding');
      // Positive control: the payload really has the fields this claims to
      // cover, so an empty loop cannot pass.
      expect(fields.length).toBeGreaterThanOrEqual(20);

      for (const field of fields) {
        const edited = { ...original };
        const value = original[field];
        edited[field] =
          typeof value === 'number'
            ? value + 1
            : typeof value === 'string'
              ? `${value}x`
              : value === null
                ? BASE
                : 'x';
        writeFileSync(recordPath(scratch.root), JSON.stringify(edited));
        const reading = read(scratch.root).reading;
        // Every single-field edit must reach a refusal. Which refusal depends
        // on the field — a mangled enum is MALFORMED before the binding is even
        // computed — and the point is that none of them reads as valid history.
        expect(isHistoricalDeliveryEvidence(reading)).toBe(false);
      }
    } finally {
      scratch.cleanup();
    }
  });
});

// ── 4. Durability ──────────────────────────────────────────────────────────

describe('the record survives, and refuses everything it cannot read', () => {
  it('round-trips through real bytes on disk', async () => {
    const scratch = scratchRoot();
    try {
      const written = await write(scratch.root);
      expect(written.code).toBe('RECORDED');
      expect(written.recorded).toBe(true);
      const loaded = read(scratch.root);
      expect(loaded.reading).toBe('HISTORICAL_VALID');
      expect(loaded.observedAt).toBe(AT);
      expect(loaded.pullRequestOutcome).toBe('MATCHED');
      expect(loaded.pullRequestNumber).toBe(56);
      expect(loaded.checkOutcome).toBe('SUCCESS');
    } finally {
      scratch.cleanup();
    }
  });

  it('reads ABSENT when nobody wrote one, and never for a file that exists', () => {
    const scratch = scratchRoot();
    try {
      expect(read(scratch.root).reading).toBe('ABSENT');
      // A file whose contents are the JSON value `null` is a file somebody
      // wrote. Reading it as absent would turn a corrupted record into "AO has
      // never observed this", which is the one direction that must not happen.
      writeFileSync(recordPath(scratch.root), 'null');
      expect(read(scratch.root).reading).toBe('MALFORMED');
      writeFileSync(recordPath(scratch.root), '');
      expect(read(scratch.root).reading).toBe('MALFORMED');
    } finally {
      scratch.cleanup();
    }
  });

  /**
   * A file that exists and cannot be opened is not a file nobody wrote.
   *
   * `ENOENT` is the only errno that means absence. Every other reason an open
   * fails — a permissions problem, a path that is a directory — is a record
   * that may well be there, and reporting it as `ABSENT` would tell an operator
   * "AO has never observed this" about a task it observed yesterday. A mutant
   * that collapsed the two survived until this case existed.
   */
  it('does not report an unopenable path as ABSENT', () => {
    const scratch = scratchRoot();
    try {
      const subject = { taskId: 'T-001', repositoryRoot: scratch.root, stateRevision: REV };
      const fail = (code: string) => (): number => {
        throw Object.assign(new Error('no'), { code });
      };
      // Only `ENOENT` means nobody wrote one. Everything else is a file that
      // may well be there, and calling it absent would tell an operator "AO has
      // never observed this" about a task it observed yesterday.
      for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EISDIR']) {
        expect(
          loadDeliveryEvidence(scratch.root, 'T-001', subject, EXPECTED, fail(code)).reading,
        ).toBe('MALFORMED');
      }
      // The control that makes those mean something: the one errno that IS
      // absence still reads as absence.
      expect(
        loadDeliveryEvidence(scratch.root, 'T-001', subject, EXPECTED, fail('ENOENT')).reading,
      ).toBe('ABSENT');
    } finally {
      scratch.cleanup();
    }
  });

  /**
   * Measured, not assumed: on Windows `openSync(dir, 'r')` succeeds and reports
   * size 0. So a directory standing where the record should be would read as an
   * empty file unless something says otherwise, and the reading would be right
   * by accident rather than because anything checked.
   */
  it('refuses a directory standing where the record should be', () => {
    const scratch = scratchRoot();
    try {
      mkdirSync(recordPath(scratch.root));
      expect(read(scratch.root).reading).toBe('MALFORMED');
      rmSync(recordPath(scratch.root), { recursive: true, force: true });
      expect(read(scratch.root).reading).toBe('ABSENT');
    } finally {
      scratch.cleanup();
    }
  });

  it('refuses a truncated record rather than reading the prefix', async () => {
    const scratch = scratchRoot();
    try {
      await write(scratch.root);
      const bytes = readFileSync(recordPath(scratch.root), 'utf8');
      writeFileSync(recordPath(scratch.root), bytes.slice(0, Math.floor(bytes.length / 2)));
      expect(read(scratch.root).reading).toBe('MALFORMED');
    } finally {
      scratch.cleanup();
    }
  });

  it('refuses a future version as unsupported, not as malformed', async () => {
    const scratch = scratchRoot();
    try {
      await write(scratch.root);
      const record = JSON.parse(readFileSync(recordPath(scratch.root), 'utf8')) as Record<
        string,
        unknown
      >;
      // A future build's record will not satisfy this build's strict schema —
      // that is what a version bump is for — so it must be recognised by its
      // version before the shape is judged, or the operator is told the wrong
      // thing.
      writeFileSync(
        recordPath(scratch.root),
        JSON.stringify({ ...record, evidenceVersion: DELIVERY_EVIDENCE_VERSION + 1, extra: 1 }),
      );
      expect(read(scratch.root).reading).toBe('UNSUPPORTED_VERSION');
    } finally {
      scratch.cleanup();
    }
  });

  it('refuses an oversized record without parsing it', async () => {
    const scratch = scratchRoot();
    try {
      writeFileSync(recordPath(scratch.root), 'x'.repeat(MAX_DELIVERY_EVIDENCE_BYTES + 1));
      expect(read(scratch.root).reading).toBe('MALFORMED');
    } finally {
      scratch.cleanup();
    }
  });

  it('refuses a record carrying a field this build does not declare', async () => {
    const scratch = scratchRoot();
    try {
      await write(scratch.root);
      const record = JSON.parse(readFileSync(recordPath(scratch.root), 'utf8')) as Record<
        string,
        unknown
      >;
      writeFileSync(recordPath(scratch.root), JSON.stringify({ ...record, mergeApproved: true }));
      expect(read(scratch.root).reading).toBe('MALFORMED');
    } finally {
      scratch.cleanup();
    }
  });

  /**
   * The torn-publication case, and the reason `writeFileAtomically` is used.
   *
   * A replace that fails must leave the previous record byte-for-byte intact.
   * That cannot be provoked against a real filesystem on demand, so the replace
   * is a seam — the same arrangement `state/atomic-file.ts` documents.
   */
  it('a failed replace leaves the previous record intact', async () => {
    const scratch = scratchRoot();
    try {
      expect((await write(scratch.root)).code).toBe('RECORDED');
      const before = readFileSync(recordPath(scratch.root));

      const failed = await write(scratch.root, {
        proof: provenProof(),
        replace: () => {
          throw Object.assign(new Error('nope'), { code: 'EPERM' });
        },
      });
      expect(failed.code).toBe('WRITE_FAILED');
      expect(failed.recorded).toBe(false);
      // The previous record, unchanged to the byte.
      expect(readFileSync(recordPath(scratch.root)).equals(before)).toBe(true);
      expect(read(scratch.root).reading).toBe('HISTORICAL_VALID');
    } finally {
      scratch.cleanup();
    }
  });

  it('a later observation replaces the earlier record', async () => {
    const scratch = scratchRoot();
    try {
      await write(scratch.root);
      const first = readFileSync(recordPath(scratch.root), 'utf8');
      const laterProof = attestDeliveryObservation(
        subjectOf(),
        settled(),
        '2026-08-23T15:00:00.000Z',
      );
      expect(laterProof).not.toBeNull();
      const second = await recordDeliveryEvidence({
        repositoryRoot: scratch.root,
        taskId: 'T-001',
        subject: { taskId: 'T-001', repositoryRoot: scratch.root, stateRevision: REV },
        taskState: 'READY_FOR_PR',
        basePinnedCommit: BASE,
        declaredRemote: 'origin',
        expectedSubjectCommit: HEAD,
        expectedHost: IDENTITY.host,
        expectedOwner: IDENTITY.owner,
        expectedName: IDENTITY.name,
        proof: laterProof,
        recordedAt: '2026-08-23T15:00:01.000Z',
        checkIgnored: ALWAYS_IGNORED,
      });
      expect(second.code).toBe('RECORDED');
      const after = readFileSync(recordPath(scratch.root), 'utf8');
      expect(after).not.toBe(first);
      expect(read(scratch.root).observedAt).toBe('2026-08-23T15:00:00.000Z');
    } finally {
      scratch.cleanup();
    }
  });

  it('the record it writes is well inside the size it will read back', async () => {
    const scratch = scratchRoot();
    try {
      await write(scratch.root);
      const size = readFileSync(recordPath(scratch.root)).byteLength;
      expect(size).toBeLessThan(MAX_DELIVERY_EVIDENCE_BYTES);
      // Not merely under the cap: an order of magnitude under it, because the
      // payload is a fixed set of scalars. A record approaching the bound would
      // mean something unbounded got in.
      expect(size).toBeLessThan(MAX_DELIVERY_EVIDENCE_BYTES / 4);
    } finally {
      scratch.cleanup();
    }
  });
});

// ── 5. Write authority ─────────────────────────────────────────────────────

describe('recording is an explicit act, and refuses everything else', () => {
  it.each([
    ['NOT_IGNORED', 'RUNTIME_PATH_NOT_IGNORED'],
    ['UNDETERMINED', 'RUNTIME_IGNORE_UNDETERMINED'],
  ])('writes nothing when Git says the path is %s', async (verdict, code) => {
    const scratch = scratchRoot();
    try {
      const result = await write(scratch.root, {
        checkIgnored: async () => verdict as IgnoreVerdict,
      });
      expect(result.code).toBe(code);
      expect(existsSync(recordPath(scratch.root))).toBe(false);
    } finally {
      scratch.cleanup();
    }
  });

  /**
   * The two names are asked about separately, and each refusal must be
   * reachable on its own.
   *
   * The blanket case above answers the same verdict for both, so it cannot tell
   * which check did the work — and a mutant that deleted the record-name check
   * survived it. These two are the counter-proof: each leaves exactly one name
   * un-ignored, which is what a rule keyed on a shape rather than a directory
   * really produces.
   */
  it.each([
    ['the record name is not ignored', (p: string) => !p.endsWith('.tmp-probe')],
    ['the staging name is not ignored', (p: string) => p.endsWith('.tmp-probe')],
  ])('writes nothing when only %s', async (_what, isNotIgnored) => {
    const scratch = scratchRoot();
    try {
      const result = await write(scratch.root, {
        checkIgnored: async (path) => (isNotIgnored(path) ? 'NOT_IGNORED' : 'IGNORED'),
      });
      expect(result.code).toBe('RUNTIME_PATH_NOT_IGNORED');
      expect(existsSync(recordPath(scratch.root))).toBe(false);
      // Positive control: with both ignored, the same fixture writes. So the
      // absence above is attributable to the verdict and not to the fixture.
      expect((await write(scratch.root)).code).toBe('RECORDED');
    } finally {
      scratch.cleanup();
    }
  });

  it.each([
    ['the record name', (p: string) => !p.endsWith('.tmp-probe')],
    ['the staging name', (p: string) => p.endsWith('.tmp-probe')],
  ])('writes nothing when Git cannot answer about %s', async (_what, isUnknown) => {
    const scratch = scratchRoot();
    try {
      const result = await write(scratch.root, {
        checkIgnored: async (path) => (isUnknown(path) ? 'UNDETERMINED' : 'IGNORED'),
      });
      expect(result.code).toBe('RUNTIME_IGNORE_UNDETERMINED');
      expect(existsSync(recordPath(scratch.root))).toBe(false);
    } finally {
      scratch.cleanup();
    }
  });

  it('asks about the staging name as well as the record name', async () => {
    const scratch = scratchRoot();
    const asked: string[] = [];
    try {
      await write(scratch.root, {
        checkIgnored: async (path) => {
          asked.push(path);
          return 'IGNORED';
        },
      });
      // Both names, and in two separate calls: `check-ignore` ORs its
      // arguments, so one call carrying both would answer "ignored" whenever
      // either passed.
      expect(asked).toEqual([
        '.agent-orchestrator/runtime/delivery/T-001.json.tmp-probe',
        '.agent-orchestrator/runtime/delivery/T-001.json',
      ]);
    } finally {
      scratch.cleanup();
    }
  });

  it('checks provenance before it touches the filesystem at all', async () => {
    const scratch = scratchRoot();
    const asked: string[] = [];
    try {
      const result = await write(scratch.root, {
        proof: {},
        checkIgnored: async (path) => {
          asked.push(path);
          return 'IGNORED';
        },
      });
      expect(result.code).toBe('OBSERVATION_NOT_PROVEN');
      // Git was never asked, so no effect of any kind was set in motion by a
      // caller that observed nothing.
      expect(asked).toEqual([]);
    } finally {
      scratch.cleanup();
    }
  });

  /**
   * The state-destroying collision, and the reason the record lives one
   * directory down.
   *
   * The task-id grammar admits `.` (`plan/task-id.ts`), so `T-001.delivery` is a
   * legal task id. The first version of this slice wrote
   * `runtime/<taskId>.delivery.json`, which meant the evidence path for `T-001`
   * and the *task-state* path for `T-001.delivery` were the same string —
   * recording an observation for one task would have renamed a blob over
   * another task's durable record and destroyed it.
   *
   * This is the counter-proof, and it is written as an inequality of paths
   * rather than as a claim about names, because a name-based check is exactly
   * what was wrong before: the old test asserted the converse
   * (`isDeliveryEvidenceFileName('T-001.json') === false`) and the property it
   * claimed to establish was never asserted and was false.
   */
  it('cannot collide with any task-state path, for any legal task id', () => {
    // The grammar really does admit the dot. Positive control: without this the
    // inequality below would be about a case that cannot arise.
    expect(isValidTaskId('T-001.delivery')).toBe(true);
    expect(isValidTaskId('T-001')).toBe(true);

    const root = 'D:\\repo';
    for (const [evidenceTask, stateTask] of [
      ['T-001', 'T-001.delivery'],
      ['T-001', 'T-001'],
      ['a', 'a.delivery'],
      ['x.y', 'x.y.delivery'],
    ]) {
      const evidence = deriveDeliveryEvidenceLocation(root, evidenceTask as string);
      const state = deriveTaskStateLocation(root, stateTask as string);
      expect(evidence.ok).toBe(true);
      expect(state.ok).toBe(true);
      if (!evidence.ok || !state.ok) continue;
      expect(evidence.path).not.toBe(state.path);
    }

    // And the structural reason, stated as a fact about the directories rather
    // than about the names: task state never leaves the runtime directory, and
    // a delivery record is never in it.
    const anyState = deriveTaskStateLocation(root, 'T-001');
    const anyEvidence = deriveDeliveryEvidenceLocation(root, 'T-001');
    expect(anyState.ok && anyEvidence.ok).toBe(true);
    if (anyState.ok && anyEvidence.ok) {
      expect(anyState.directory).not.toBe(anyEvidence.directory);
      expect(anyEvidence.directory).toBe(join(anyState.directory, DELIVERY_EVIDENCE_DIR_NAME));
    }
  });

  it('names a location that is inside the repository and is not a state file', () => {
    const location = deriveDeliveryEvidenceLocation('D:\\repo', 'T-001');
    expect(location.ok).toBe(true);
    if (!location.ok) return;
    expect(location.fileName).toBe('T-001.json');
    expect(isDeliveryEvidenceFileName(location.fileName)).toBe(true);
    // The name grammar is deliberately the SAME as a task state's, shared
    // rather than restated. The two are told apart by the directory, which is
    // the property the test above proves and the one a task id cannot spell
    // its way around.
    expect(location.directory.endsWith(DELIVERY_EVIDENCE_DIR_NAME)).toBe(true);
  });

  it.each([
    ['a relative repository root', '.\\repo', 'T-001'],
    ['an empty repository root', '', 'T-001'],
    ['a traversing task id', 'D:\\repo', '../evil'],
    ['a separator in the task id', 'D:\\repo', 'a/b'],
  ])('refuses %s', (_what, root, task) => {
    expect(deriveDeliveryEvidenceLocation(root, task).ok).toBe(false);
  });
});

// ── 6. History is not truth ────────────────────────────────────────────────

describe('a stored observation is never presented as the current one', () => {
  it('has exactly one reading that is historical evidence, asserted by value', () => {
    expect([...DELIVERY_EVIDENCE_READINGS]).toEqual([
      'HISTORICAL_VALID',
      'ABSENT',
      'UNSUPPORTED_VERSION',
      'MALFORMED',
      'NOT_THIS_TASK',
      'LOCAL_BINDING_MISMATCH',
    ]);
    // By value, not by completeness. `satisfies Record<Reading, boolean>` would
    // accept `true` in every row and prove nothing about which one is which.
    expect(
      Object.fromEntries(
        DELIVERY_EVIDENCE_READINGS.map((r) => [r, isHistoricalDeliveryEvidence(r)]),
      ),
    ).toEqual({
      HISTORICAL_VALID: true,
      ABSENT: false,
      UNSUPPORTED_VERSION: false,
      MALFORMED: false,
      NOT_THIS_TASK: false,
      LOCAL_BINDING_MISMATCH: false,
    });
  });

  it('names nothing CURRENT, and offers no function that answers now', () => {
    for (const reading of DELIVERY_EVIDENCE_READINGS) {
      expect(reading).not.toContain('CURRENT');
    }
    // The vocabulary an operator reads must not say it either.
    for (const sentence of Object.values(DELIVERY_EVIDENCE_READING_DETAIL)) {
      expect(sentence.toLowerCase()).not.toContain('currently');
    }
    // And the module exports no name that promises freshness. This is a pin on
    // the API surface, because a future `isDeliveryGreen()` would be the whole
    // defect in one function name.
    const source = readFileSync('src/deliver/delivery-evidence.ts', 'utf8');
    const exported = [...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      expect(name ?? '').not.toMatch(/current|fresh|isGreen|isPassing|approved/i);
    }
  });

  it('says in the operator report that a record is not a claim about now', () => {
    // Matched flat: the sentence is pre-wrapped so an operator's console does
    // not decide where it breaks, and where it breaks is not part of the claim.
    const flat = REMOTE_FRESHNESS_SENTENCE.replace(/\s+/g, ' ');
    expect(flat).toContain('one past moment');
    expect(flat).toContain('not a claim about the forge now');
    expect(flat).toContain('Nothing here has asked again.');
    // Wrapped, and to a width the rest of this report already uses.
    for (const wrapped of REMOTE_FRESHNESS_SENTENCE.split('\n')) {
      expect(wrapped.length).toBeLessThanOrEqual(90);
    }
  });

  it('renders a stored SUCCESS in the past tense, under a HISTORICAL label', () => {
    const rendered = renderStoredEvidenceLine(
      {
        reading: 'HISTORICAL_VALID',
        observedAt: AT,
        pullRequestOutcome: 'MATCHED',
        pullRequestNumber: 56,
        checkOutcome: 'SUCCESS',
      },
      null,
    );
    expect(rendered).toContain(HISTORICAL_LABEL);
    expect(rendered).toContain('HISTORICAL');
    expect(rendered).toContain(`at ${AT} this was MATCHED (#56), checks SUCCESS`);
    // The word that must never appear beside a stored outcome.
    expect(rendered).not.toContain('CURRENT');
  });

  /**
   * A recent timestamp is not freshness, and the product must not behave as
   * though it were. The strongest available proof is that the *same* record
   * reads identically whatever its instant, so nothing downstream can be
   * treating the interval as evidence.
   */
  it('an instant one second old and one a year old read exactly the same', async () => {
    const scratch = scratchRoot();
    try {
      const older = attestDeliveryObservation(subjectOf(), settled(), '2025-01-01T00:00:00.000Z');
      const newer = attestDeliveryObservation(subjectOf(), settled(), '2026-08-23T23:59:59.000Z');
      expect(older).not.toBeNull();
      expect(newer).not.toBeNull();

      const readings: string[] = [];
      for (const proof of [older, newer]) {
        await write(scratch.root, { proof });
        readings.push(read(scratch.root).reading);
      }
      expect(readings).toEqual(['HISTORICAL_VALID', 'HISTORICAL_VALID']);
      // No threshold exists to be crossed: the code compares `observedAt`
      // against nothing, and implements no expiry of any kind. Scanned with the
      // comments removed, so that the header may go on explaining why a TTL was
      // rejected without tripping its own ban.
      const code = codeOnly('src/deliver/delivery-evidence.ts');
      // Positive control: the stripper left the code behind.
      expect(code).toContain('export function readDeliveryEvidence');
      expect(code).not.toMatch(/observedAt\s*[<>]/);
      expect(code).not.toMatch(/TTL|maxAge|expiry|expires|staleAfter|Date\.now/i);
      expect(codeOnly('src/deliver/delivery-evidence-store.ts')).not.toMatch(
        /TTL|maxAge|expiry|expires|staleAfter/i,
      );
    } finally {
      scratch.cleanup();
    }
  });

  it('reports a disagreement between a stored record and a fresh observation', () => {
    const stored = {
      reading: 'HISTORICAL_VALID' as const,
      observedAt: AT,
      pullRequestOutcome: 'MATCHED',
      pullRequestNumber: 56,
      checkOutcome: 'SUCCESS',
    };
    // Agreement, as the control.
    expect(renderStoredEvidenceLine(stored, settled())).toContain(EVIDENCE_AGREEMENT_SUFFIX);
    // The agreement sentence says what was compared and no more: only the two
    // outcome words and the pull-request number are. A review pointed out that
    // 'agrees' claimed more than that — a stored SUCCESS over 2 check runs
    // beside a fresh SUCCESS over 10 is not nothing having changed.
    expect(EVIDENCE_AGREEMENT_SUFFIX).toContain('the same outcome and pull request');
    expect(EVIDENCE_AGREEMENT_SUFFIX).not.toContain('agrees');
    // The disagreement half may NOT name the outcome, because it also fires
    // when only the pull-request number moved -- a PR closed and another opened
    // at the same head gives MATCHED on both sides and identical outcome words.
    // A second review found the first correction had made this half false.
    expect(EVIDENCE_DISAGREEMENT_PREFIX).not.toContain('outcome');

    // The checks went red since. Neither side is preferred; the difference is
    // reported.
    const nowFailing = Object.freeze({
      pullRequest: settled().pullRequest,
      checks: Object.freeze({
        outcome: 'FAILED' as const,
        counts: Object.freeze({
          checkRuns: 2,
          commitStatuses: 0,
          failed: 1,
          pending: 0,
          succeeded: 1,
          neutralOrSkipped: 0,
        }),
      }),
    }) as DeliveryObservation;
    expect(renderStoredEvidenceLine(stored, nowFailing)).toContain(EVIDENCE_DISAGREEMENT_PREFIX);

    // And a pull request that closed since, where the outcome word changed.
    const noPull = Object.freeze({
      pullRequest: Object.freeze({ outcome: 'NO_MATCHING_PULL_REQUEST' as const }),
      checks: settled().checks,
    }) as DeliveryObservation;
    expect(renderStoredEvidenceLine(stored, noPull)).toContain(EVIDENCE_DISAGREEMENT_PREFIX);

    // A different pull request at the same head is a disagreement too, and it
    // is the one an outcome-word comparison alone would miss.
    const otherPull = Object.freeze({
      pullRequest: Object.freeze({ outcome: 'MATCHED' as const, pullRequest: 99 }),
      checks: settled().checks,
    }) as DeliveryObservation;
    expect(renderStoredEvidenceLine(stored, otherPull)).toContain(EVIDENCE_DISAGREEMENT_PREFIX);
  });
});

// ── 7. Secret and data hygiene ─────────────────────────────────────────────

describe('nothing sensitive can reach the record', () => {
  it('stores only the declared fields, and none of them can carry a payload', async () => {
    const scratch = scratchRoot();
    try {
      await write(scratch.root);
      const text = readFileSync(recordPath(scratch.root), 'utf8');
      const record = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(record).sort()).toEqual(
        [
          'basePinnedCommit',
          'binding',
          'checkOutcome',
          'checkQueriedCommit',
          'checkRuns',
          'checksFailed',
          'checksNeutralOrSkipped',
          'checksPending',
          'checksSucceeded',
          'commitStatuses',
          'declaredRemote',
          'evidenceVersion',
          'host',
          'name',
          'observedAt',
          'owner',
          'provider',
          'pullRequestHeadSha',
          'pullRequestNumber',
          'pullRequestOutcome',
          'recordedAt',
          'repositoryRoot',
          'stateRevision',
          'subjectCommit',
          'taskId',
          'taskState',
        ].sort(),
      );
      // No URL, no scheme, no credential shape, anywhere in the bytes.
      expect(text).not.toMatch(/https?:\/\//);
      expect(text.toLowerCase()).not.toContain('authorization');
      expect(text.toLowerCase()).not.toContain('token');
      expect(text.toLowerCase()).not.toContain('@');
    } finally {
      scratch.cleanup();
    }
  });

  it('has no field a raw forge payload or a branch name could travel in', () => {
    const source = readFileSync('src/deliver/delivery-evidence.ts', 'utf8');
    for (const banned of ['workBranch', 'rawResponse', 'stdout', 'stderr', 'body', 'headers']) {
      expect(source).not.toContain(`${banned}:`);
    }
    // The recordable vocabularies are exactly the settled ones: a refusal has
    // no representation, so `NOT_AUTHENTICATED` cannot be written down.
    expect([...RECORDABLE_PULL_REQUEST_OUTCOMES]).toEqual([
      'MATCHED',
      'NO_MATCHING_PULL_REQUEST',
      'AMBIGUOUS',
    ]);
    expect([...RECORDABLE_CHECK_OUTCOMES]).toEqual(['SUCCESS', 'PENDING', 'FAILED', 'NO_CHECKS']);
    for (const refusal of ['NOT_AUTHENTICATED', 'REQUEST_FAILED', 'RESPONSE_MALFORMED']) {
      expect([...RECORDABLE_PULL_REQUEST_OUTCOMES] as string[]).not.toContain(refusal);
      expect([...RECORDABLE_CHECK_OUTCOMES] as string[]).not.toContain(refusal);
    }
  });
});

// ── 8. The product contract does not widen ─────────────────────────────────

describe('recording grants nothing and moves nothing', () => {
  it('leaves READY_FOR_PR terminal', () => {
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
    expect([...TERMINAL_STATES]).toContain('READY_FOR_PR');
  });

  /**
   * Every module this slice adds or changes, and the criterion is the one the
   * title states.
   *
   * The first version was titled "anywhere in the slice" while scanning four of
   * the six modules, and a review pointed out that the omission was not
   * incidental: `cli/delivery-command.ts` imports `loadTaskState`, which the
   * import ban below would have flagged. So the title was false of the slice,
   * and the list was hand-written — the exact shape rejected one screen above
   * for the reachability pin.
   *
   * The criterion is split instead, because the two halves are different
   * claims. **No module writes task state** — that holds for all six, and it is
   * checked as the absence of a *call*. **Only the CLI reads it** — the four
   * library modules may not import the store at all, and the CLI's read is
   * admitted by name.
   */
  it('writes no task state and names no pull-request mutation, in every module of the slice', () => {
    const LIBRARY = [
      'src/deliver/delivery-evidence.ts',
      'src/deliver/delivery-evidence-store.ts',
      'src/deliver/internal/delivery-observation-proof.ts',
      'src/deliver/delivery-observation-proof.ts',
    ];
    const SURFACE = ['src/cli/delivery-command.ts', 'src/cli/render-delivery-observation.ts'];

    for (const file of [...LIBRARY, ...SURFACE]) {
      const code = codeOnly(file);
      // Positive control: the file really was read and the stripper left code.
      expect(code.length).toBeGreaterThan(200);
      // No writer *call*, anywhere. Scanned on the code alone, so a header may
      // go on explaining why the task-state writer is not used here — which is
      // the load-bearing part of the design and the first thing a reader needs.
      expect(code, file).not.toMatch(/\badvanceTaskState\s*\(/);
      expect(code, file).not.toMatch(/\bsaveTaskState\s*\(/);
      expect(code, file).not.toMatch(/\bmergePullRequest\b|\bcreatePullRequest\b/);
      expect(code, file).not.toMatch(/\brecordAgentInterruption\s*\(/);
      expect(code, file).not.toMatch(/\bacquire\w*ExecutionLease\s*\(/);
    }

    // The library may not reach the store at all.
    for (const file of LIBRARY) {
      expect(codeOnly(file), file).not.toMatch(
        /from '[^']*state\/(advance-state|state-store)\.js'/,
      );
    }

    // The module that owns the ignore contract must name the path this slice
    // really writes. Its header said `<taskId>.delivery.json` for a whole
    // review round after the record moved — the same class of stale claim as
    // the collision it was moved to fix, left in the one module the new path
    // depends on.
    const ignored = readFileSync('src/state/runtime-ignored.ts', 'utf8');
    expect(ignored).toContain('runtime/delivery/<taskId>.json');
    expect(ignored).not.toContain('<taskId>.delivery.json');

    // The CLI surface imports exactly one thing from it, and it reads.
    const cli = codeOnly('src/cli/delivery-command.ts');
    const stateImports = [...cli.matchAll(/import \{([^}]*)\} from '[^']*state\/state-store\.js'/g)]
      .map((m) => (m[1] ?? '').trim());
    // Positive control: the import really is there, so an empty scan cannot
    // pass this by finding nothing.
    expect(stateImports).toEqual(['loadTaskState']);
    expect(codeOnly('src/cli/render-delivery-observation.ts')).not.toMatch(
      /from '[^']*state\/(advance-state|state-store)\.js'/,
    );
  });

  it('takes no execution lease and dispatches no agent', () => {
    const source = readFileSync('src/deliver/delivery-evidence-store.ts', 'utf8');
    expect(source).not.toContain('acquireRepositoryExecutionLease');
    expect(source).not.toContain('ExecutionLeaseAuthority');
    expect(source).not.toContain('runOwnedCommand');
  });
});

// ── 9. The CLI surface ─────────────────────────────────────────────────────

describe('the delivery command records only when asked', () => {
  const DECLARED: ResolvedDelivery = Object.freeze({
    declared: true as const,
    remoteName: 'origin',
    result: Object.freeze({ outcome: 'RESOLVED' as const, target: IDENTITY }),
  });

  function loadedState(root: string): StateLoadResult {
    return {
      ok: true,
      code: 'LOADED',
      classification: 'STATE_VALID',
      state: {
        state: 'READY_FOR_PR',
        currentCommit: HEAD,
        basePinnedCommit: BASE,
      } as never,
      path: join(root, 'state.json'),
      revision: REV,
    };
  }

  function greenRunner(): ForgeCommandRunner {
    return async (_command, args) => {
      const path = args.find((a) => a.startsWith('repos/')) ?? '';
      const key = path.split('/').pop() ?? '';
      const stdout =
        key === 'pulls'
          ? JSON.stringify([{ number: 56, state: 'open', head: { sha: HEAD } }])
          : key === 'check-runs'
            ? JSON.stringify({
                total_count: 2,
                check_runs: [
                  { status: 'completed', conclusion: 'success', head_sha: HEAD },
                  { status: 'completed', conclusion: 'success', head_sha: HEAD },
                ],
              })
            : JSON.stringify({ sha: HEAD, total_count: 0, statuses: [] });
      return commandResult({ stdout });
    };
  }

  function harness(root: string, runner?: ForgeCommandRunner) {
    const out: string[] = [];
    const write2 = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(((chunk: unknown): boolean => {
        out.push(String(chunk));
        return true;
      }) as typeof process.stdout.write);
    const program = new Command();
    program.exitOverride();
    registerDeliveryCommand(program, {
      resolveRepository: async () =>
        ({ ok: true, repository: { id: 'ao', root, delivery: DECLARED } }) as never,
      loadTaskState: () => loadedState(root),
      runner: runner ?? greenRunner(),
      envSource: { PATH: '/usr/bin' },
      now: () => new Date(AT),
      checkIgnored: ALWAYS_IGNORED,
    });
    return { program, out, restore: () => write2.mockRestore() };
  }

  it('writes nothing for --observe alone', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await h.program.parseAsync(
        ['delivery', '--repository', scratch.root, '--task', 'T-001', '--observe'],
        { from: 'user' },
      );
      // The observation really happened — the control that makes the absence
      // below mean something.
      expect(h.out.join('')).toContain('MATCHED');
      expect(existsSync(recordPath(scratch.root))).toBe(false);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('writes when --record is given with --observe', async () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      await h.program.parseAsync(
        ['delivery', '--repository', scratch.root, '--task', 'T-001', '--observe', '--record'],
        { from: 'user' },
      );
      expect(existsSync(recordPath(scratch.root))).toBe(true);
      const text = h.out.join('');
      expect(text).toContain('Record       : RECORDED');
      expect(text).not.toContain('RECORDED — RECORDED');
      expect(read(scratch.root).reading).toBe('HISTORICAL_VALID');

      // The report describes the store as this invocation LEAVES it, which
      // means the record is written before it is read back.
      //
      // This is the assertion whose absence let the defect ship. The first
      // version read first, so on this exact flow — a task with no prior record
      // — it printed "Recorded : ABSENT — No observation has been recorded for
      // this task" on the line directly above "Record : RECORDED": a sentence
      // false at the moment it was printed, contradicting the line beneath it,
      // and suppressing the freshness sentence as a bonus. Asserting only that
      // the file exists afterwards cannot see any of that.
      expect(text).toContain(`${HISTORICAL_LABEL}     : HISTORICAL`);
      expect(text).not.toContain('ABSENT');
      expect(text).toContain(REMOTE_FRESHNESS_SENTENCE);
      // And it is the record just written, not a superseded one: the instant is
      // this invocation's own clock.
      expect(text).toContain(`at ${AT} this was MATCHED (#56)`);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('refuses --record without --observe, and contacts nothing', async () => {
    const scratch = scratchRoot();
    let started = 0;
    const counting: ForgeCommandRunner = async (...args) => {
      started += 1;
      return greenRunner()(...args);
    };
    const h = harness(scratch.root, counting);
    try {
      await h.program.parseAsync(
        ['delivery', '--repository', scratch.root, '--task', 'T-001', '--record'],
        { from: 'user' },
      );
      const text = h.out.join('');
      expect(text).toContain('RECORD_REQUIRES_OBSERVATION');
      // The refusal carries its sentence, because a refusal is the case an
      // operator has to act on. A success prints the code alone -- the first
      // version printed 'RECORDED -- RECORDED', explaining nothing twice.
      expect(text).toContain(RECORD_REFUSAL_DETAIL.RECORD_REQUIRES_OBSERVATION);
      expect(existsSync(recordPath(scratch.root))).toBe(false);
      // And it stayed a local command: no client was constructed.
      expect(started).toBe(0);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('writes nothing when the observation refused', async () => {
    const scratch = scratchRoot();
    const failing: ForgeCommandRunner = async () => commandResult({ exitCode: 4 });
    const h = harness(scratch.root, failing);
    try {
      await h.program.parseAsync(
        ['delivery', '--repository', scratch.root, '--task', 'T-001', '--observe', '--record'],
        { from: 'user' },
      );
      const text = h.out.join('');
      expect(text).toContain('NOT_AUTHENTICATED');
      expect(text).toContain('RECORD_WITHOUT_SETTLED_OBSERVATION');
      expect(existsSync(recordPath(scratch.root))).toBe(false);
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('reports a stored record on a later local run, with the freshness sentence', async () => {
    const scratch = scratchRoot();
    const first = harness(scratch.root);
    try {
      await first.program.parseAsync(
        ['delivery', '--repository', scratch.root, '--task', 'T-001', '--observe', '--record'],
        { from: 'user' },
      );
    } finally {
      first.restore();
    }
    const second = harness(scratch.root);
    try {
      // No --observe: purely local, and it still knows what was recorded.
      await second.program.parseAsync(
        ['delivery', '--repository', scratch.root, '--task', 'T-001'],
        { from: 'user' },
      );
      const text = second.out.join('');
      expect(text).toContain(HISTORICAL_LABEL);
      expect(text).toContain('HISTORICAL');
      expect(text).toContain(REMOTE_FRESHNESS_SENTENCE);
      // The live answer is absent, because nothing was asked.
      expect(text).toContain('not observed');
    } finally {
      second.restore();
      scratch.cleanup();
    }
  });

  it('registers --record with the sentence that was pinned, not a copy', () => {
    const scratch = scratchRoot();
    const h = harness(scratch.root);
    try {
      const delivery = h.program.commands.find((c) => c.name() === 'delivery');
      const help = delivery?.helpInformation() ?? '';
      expect(help).toContain('--record');
      const collapse = (t: string): string => t.replace(/\s+/g, ' ').trim();
      expect(collapse(help)).toContain(collapse(RECORD_OPTION_DESCRIPTION));
      // The command's own description must have stopped saying it writes
      // nothing, since it now can.
      expect(DELIVERY_COMMAND_DESCRIPTION).toContain('--record');
      expect(DELIVERY_COMMAND_DESCRIPTION).toContain('historical record');

      // And so must the top-level help, which called this command "the
      // read-only `delivery` report". That sentence was true for two slices and
      // stopped being true here. Five review rounds on V4 slice 2 were spent on
      // exactly this class — a claim that was true when written and was not
      // moved when the slice that falsified it shipped — so it is checked
      // against the live surface rather than remembered.
      // Read from the real program, not this harness's stub: the harness
      // registers one command and carries no top-level description at all, so
      // asserting against it would pass while measuring nothing.
      const top = buildProgram().description().replace(/\s+/g, ' ');
      expect(top).toContain('This build ships:');
      expect(top).not.toContain('the read-only `delivery` report');
      expect(top).toContain('`--record`');
    } finally {
      h.restore();
      scratch.cleanup();
    }
  });

  it('has a sentence for every record refusal, and no orphan sentences', () => {
    expect(Object.keys(RECORD_REFUSAL_DETAIL).sort()).toEqual([...RECORD_REFUSALS].sort());
    // Pinned by literal, not by reading the map: a completeness check proves a
    // key exists, only a literal proves the sentence an operator reads.
    expect(RECORD_REFUSAL_DETAIL.RECORD_REQUIRES_OBSERVATION).toBe(
      'Recording stores an observation, so one has to be made. Pass --observe as well.',
    );
    expect(RECORD_REFUSAL_DETAIL.RECORD_WITHOUT_SETTLED_OBSERVATION).toBe(
      'At least one question was not answered, so no observation was established to record.',
    );
  });
});
