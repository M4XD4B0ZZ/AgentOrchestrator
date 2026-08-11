/**
 * V2-05 / I4: auth evidence cannot be asserted, only produced.
 *
 * The claim under test is not "the happy path calls the preflight". It is the
 * counter-claim: **can a caller reach execution while asserting a preflight that
 * never produced successful evidence?** Before V2-05 the answer was yes, in one
 * line — `runTask({ …, authPreflightPassed: true })` — and the documentation
 * around that field said the opposite. Every case here tries to get back to that
 * position by a different route.
 *
 * Four routes, and each needs its own kind of refusal:
 *
 *  1. **Say nothing.** Pass no evidence. Must deny (fail-closed default).
 *  2. **Write the artefact down.** Must not compile — the nominal type is the
 *     only thing standing between "evidence" and "an object with the right
 *     shape", and this is the route a plain `AuthAssessment` would have left
 *     wide open.
 *  3. **Cast.** No type system stops `as unknown as`, so the runtime gate must,
 *     and a forged value must deny exactly as an absent one does.
 *  4. **Get the real mint to produce one for a preflight that failed.** Must
 *     return `null`, including for the empty check list, where `[].every(…)`
 *     would otherwise say every check passed.
 *
 * Plus the reachability claim the whole design rests on: exactly one module in
 * `src/` may import the mint. That is asserted structurally, the same way
 * `tests/internal-api.test.ts` keeps the weaker schema internal (AO-009) — a
 * second producer would make every case above a statement about only one of
 * them.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateClaudeAuthStatus,
  type AuthCheckResult,
} from '../src/auth/auth-preflight.js';
import {
  isAuthPreflightEvidence,
  type AuthPreflightEvidence,
} from '../src/core/auth-preflight-evidence.js';
import { mintAuthPreflightEvidence } from '../src/core/internal/auth-preflight-evidence.js';
import { evaluateAutomaticResume } from '../src/core/automatic-resume.js';
import { PACKAGE_ROOT } from '../src/config/paths.js';
import { positiveResumeEvidence, validUsageLimitState } from './fixtures.js';
import { passingAuthChecks, provenAuthEvidence } from './helpers/auth-evidence.js';

/** Every `.ts` file under `src/`. Same walk as `tests/internal-api.test.ts`. */
function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
    }
  };
  walk(join(PACKAGE_ROOT, 'src'));
  return files;
}

/** The resume decision for a quota-blocked task, given some auth evidence. */
function resumeWith(authEvidence: unknown): ReturnType<typeof evaluateAutomaticResume> {
  return evaluateAutomaticResume(
    validUsageLimitState(),
    // The cast is on the *call*, not on a fabricated artefact: this helper's
    // whole job is to feed the gate values a caller should not be able to use.
    positiveResumeEvidence({ authEvidence } as { authEvidence: AuthPreflightEvidence | null }),
  );
}

describe('route 1: asserting nothing at all', () => {
  it('denies an unattended resume when no evidence is supplied', () => {
    const decision = resumeWith(null);

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('AUTH_PREFLIGHT_NOT_PASSED');
  });

  it('allows it with real evidence, so the denial above is about the evidence', () => {
    // Without this, every case in this file would pass against a gate that
    // simply always denies.
    const decision = resumeWith(provenAuthEvidence());

    expect(decision.allowed).toBe(true);
    expect(decision.reasonCodes).toEqual([]);
  });
});

describe('route 2: writing the artefact down', () => {
  it('refuses an object of the right shape at compile time', () => {
    // @ts-expect-error a structurally similar object is not evidence: the
    // `#private` field makes the type nominal, which is the whole mechanism.
    // If this ever compiles, the `@ts-expect-error` becomes unused and `tsc`
    // fails — so this assertion is enforced by the build, not by the runtime.
    const forged: AuthPreflightEvidence = { proven: true };
    expect(isAuthPreflightEvidence(forged)).toBe(false);
  });

  it('refuses an empty object at compile time', () => {
    // @ts-expect-error `{}` is not evidence either. Worth its own case: if the
    // nominal marker were ever removed, this class would become structurally
    // equal to `{}` and *every* object would satisfy it.
    const forged: AuthPreflightEvidence = {};
    expect(isAuthPreflightEvidence(forged)).toBe(false);
  });

  it('refuses a fabricated assessment as a source of evidence', () => {
    // The shape a caller *can* still write: `AuthAssessment` is an ordinary
    // interface, so this compiles. It buys nothing, because the one field that
    // carries authority cannot be filled.
    const fabricated = { checks: [], allPassed: true, evidence: null } as const;

    expect(isAuthPreflightEvidence(fabricated.evidence)).toBe(false);
    expect(resumeWith(fabricated.evidence).allowed).toBe(false);
  });
});

describe('route 3: casting past the type', () => {
  it.each([
    ['a bare true', true],
    ['an object claiming to be proven', { proven: true }],
    ['an empty object', {}],
    ['a class with the same shape', new (class { proven = true as const })()],
    ['undefined', undefined],
  ])('denies an unattended resume for %s', (_label, forged) => {
    // A cast is legitimate here precisely because the forgery *is* the subject.
    // The rule that tests must not fabricate the artefact is about tests that
    // fabricate it in order to get other work done; this one fabricates it to
    // prove it does not work.
    expect(isAuthPreflightEvidence(forged)).toBe(false);

    const decision = resumeWith(forged);
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCodes).toContain('AUTH_PREFLIGHT_NOT_PASSED');
  });
});

describe('route 4: getting the real mint to produce evidence for a failure', () => {
  it('mints nothing for an empty check list', () => {
    // `[].every(…)` is `true`. A preflight where no status command could even be
    // attempted must not be indistinguishable from one that passed everything.
    expect(mintAuthPreflightEvidence([])).toBeNull();
  });

  it('mints nothing when any check failed', () => {
    const passing = passingAuthChecks();
    const rejected = evaluateClaudeAuthStatus({
      display: 'stub',
      executable: 'stub',
      args: [],
      started: true,
      outcome: 'COMPLETED',
      exitCode: 0,
      signal: null,
      // A logged-out answer, in the CLI's own accepted JSON shape.
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: '',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:00.001Z',
      durationMs: 1,
      failureCode: null,
      errnoCode: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdinDelivery: 'NOT_REQUESTED',
      processTreeKilled: false,
    });

    expect(rejected.passed).toBe(false);
    expect(mintAuthPreflightEvidence([rejected])).toBeNull();
    // One failure among passing checks is still a failure: the mint is an AND,
    // not a "some agent is logged in".
    expect(mintAuthPreflightEvidence([...passing, rejected])).toBeNull();
  });

  it('mints for a preflight in which every check passed', () => {
    const checks: readonly AuthCheckResult[] = passingAuthChecks();

    expect(checks.every((check) => check.passed)).toBe(true);
    const evidence = mintAuthPreflightEvidence(checks);
    expect(evidence).not.toBeNull();
    expect(isAuthPreflightEvidence(evidence)).toBe(true);
  });
});

describe('the mint has exactly one producer in the product', () => {
  const MINT_MODULE = 'auth-preflight-evidence.js';

  it('has its mint function imported by auth/auth-preflight.ts and nothing else', () => {
    // The claim is about the *mint*, not about the module. Two modules import
    // the internal file and they import different things: the preflight takes
    // the mint, and the public wrapper takes the class so that
    // `isAuthPreflightEvidence` can be an `instanceof` test. Only the first is a
    // producer, and only producers are what this rule is about.
    const importers: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (/import\s*\{[^}]*mintAuthPreflightEvidence[^}]*\}/.test(text)) {
        importers.push(relative(PACKAGE_ROOT, file));
      }
    }

    expect(importers).toEqual([join('src', 'auth', 'auth-preflight.ts')]);
  });

  it('is imported at all by only those two modules', () => {
    const importers: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (new RegExp(`from\\s+['"][^'"]*internal/${MINT_MODULE}['"]`).test(text)) {
        importers.push(relative(PACKAGE_ROOT, file));
      }
    }

    expect(importers.sort()).toEqual([
      join('src', 'auth', 'auth-preflight.ts'),
      join('src', 'core', 'auth-preflight-evidence.ts'),
    ]);
  });

  it('is not reachable from the public wrapper as a value', () => {
    // The wrapper may name the class; it may not take the mint. If it ever did,
    // every consumer of the public module would be one re-export away from a
    // producer.
    const text = readFileSync(
      join(PACKAGE_ROOT, 'src', 'core', 'auth-preflight-evidence.ts'),
      'utf8',
    );
    expect(text).not.toContain('mintAuthPreflightEvidence');
  });

  it('is re-exported by no module at all', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(file, 'utf8');
      if (/export\s*\{[^}]*mintAuthPreflightEvidence/.test(text)) {
        offenders.push(relative(PACKAGE_ROOT, file));
      }
      if (/export\s*\{[^}]*AuthPreflightProof/.test(text)) {
        offenders.push(relative(PACKAGE_ROOT, file));
      }
    }

    // The public module exports a *type alias* and a predicate, never the class
    // value or the mint — so a caller importing it gets nothing to construct.
    expect(offenders).toEqual([]);
  });

  it('keeps the public module free of any way to construct one', () => {
    const publicModule = join(PACKAGE_ROOT, 'src', 'core', 'auth-preflight-evidence.ts');
    const text = readFileSync(publicModule, 'utf8');

    expect(text).toContain('export type AuthPreflightEvidence');
    expect(text).toContain('export function isAuthPreflightEvidence');
    expect(text).not.toMatch(/export\s+(async\s+)?function\s+mint/);
    expect(text).not.toMatch(/export\s+class/);
  });
});

describe('the driver no longer accepts a boolean', () => {
  it('is not satisfied by the pre-V2-05 spelling', async () => {
    const { runTask } = await import('../src/run/run-driver.js');
    type Request = Parameters<typeof runTask>[0];

    // The field is gone, and the compiler is the assertion. A regression that
    // reintroduced `authPreflightPassed: boolean` would make this expectation
    // unused and fail the build.
    // @ts-expect-error `authPreflightPassed` is not a member of `RunRequest`.
    const legacy: Pick<Request, 'authPreflightPassed'> = { authPreflightPassed: true };
    expect(legacy).toBeDefined();
  });
});
