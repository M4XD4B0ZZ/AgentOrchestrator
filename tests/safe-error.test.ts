/**
 * AO-002-R2-RR1: the error formatter emits only allow-listed literals.
 *
 * Two generations of this formatter have leaked. The first echoed any
 * `error.name` that *looked* like a JS identifier and any `error.code` that
 * *looked* like an errno constant — shape is not provenance, because both
 * properties are writable. The second fixed that with an `instanceof` check but
 * kept a fallback: an object carrying `Symbol.for('agent-loop.safeMessage')`
 * was accepted as an internal error, and its own `safeMessage` string was then
 * printed verbatim. `Symbol.for` keys are global, so *any* object could set
 * that symbol and choose the CLI's output.
 *
 * Both fallbacks are gone. Recognition is `instanceof` and nothing else, and
 * the displayed text comes from a static table keyed by a closed id — never
 * from the error object. The forgery probes below are the direct regression
 * tests for the second leak: every one of them would have printed the marker.
 */

import { describe, expect, it } from 'vitest';

import {
  DOMAIN_ERROR_IDS,
  IllegalTransitionError,
  InvalidResumePointError,
  isDomainErrorId,
  OrchestratorError,
  TrustedProfileUnavailableError,
} from '../src/core/errors.js';
import {
  ALLOWED_ERRNO_CODES,
  DOMAIN_ERROR_TEXT,
  formatSafeError,
  safeDomainErrorId,
  safeErrnoCode,
  UNEXPECTED_ERROR_CODE,
  UNKNOWN_ERRNO_CODE,
  WITHHELD_ERROR_TEXT,
} from '../src/core/safe-error.js';
import { assertTransition } from '../src/core/transitions.js';
import { SENSITIVE_MARKER } from './fixtures.js';

/** The exact global symbol the removed fallback trusted. */
const FORMER_SAFE_MESSAGE_SYMBOL = Symbol.for('agent-loop.safeMessage');

describe('our own domain errors', () => {
  it('shows the static text of the closed domain id, not a per-error string', () => {
    const error = new OrchestratorError('internal detail quoting the input');
    expect(safeDomainErrorId(error)).toBe('ORCHESTRATOR_INVARIANT_VIOLATED');
    expect(formatSafeError(error)).toBe(
      `${DOMAIN_ERROR_TEXT['ORCHESTRATOR_INVARIANT_VIOLATED']} [ORCHESTRATOR_INVARIANT_VIOLATED]`,
    );
    // The developer-facing message never reaches the output.
    expect(formatSafeError(error)).not.toContain('internal detail');
  });

  it('reports a real transition error through the table', () => {
    let thrown: unknown;
    try {
      assertTransition('READY_FOR_PR', 'IMPLEMENTING');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IllegalTransitionError);
    expect(safeDomainErrorId(thrown)).toBe('ILLEGAL_TRANSITION');
    expect(formatSafeError(thrown)).toBe(
      `${DOMAIN_ERROR_TEXT['ILLEGAL_TRANSITION']} [ILLEGAL_TRANSITION]`,
    );
  });

  it('withholds the quoted input of a resume-point error', () => {
    const error = new InvalidResumePointError(`Not a valid resume point: "${SENSITIVE_MARKER}".`);
    const text = formatSafeError(error);
    expect(text).not.toContain(SENSITIVE_MARKER);
    expect(text).toContain('resume point');
    expect(safeDomainErrorId(error)).toBe('INVALID_RESUME_POINT');
  });

  it('reports the trusted-profile failure without naming a path', () => {
    const error = new TrustedProfileUnavailableError(
      `Trusted profile resolution failed: ${SENSITIVE_MARKER}.`,
    );
    expect(safeDomainErrorId(error)).toBe('TRUSTED_PROFILE_UNAVAILABLE');
    expect(formatSafeError(error)).not.toContain(SENSITIVE_MARKER);
  });

  it('only ever names an id from the closed list', () => {
    for (const error of [
      new OrchestratorError('x'),
      new InvalidResumePointError('y'),
      new IllegalTransitionError('ABORTED', 'CREATED', [], 'terminal state'),
      new TrustedProfileUnavailableError('z'),
    ]) {
      expect(DOMAIN_ERROR_IDS).toContain(safeDomainErrorId(error));
    }
  });

  it('keeps a tampered name off our own error entirely', () => {
    const error = new OrchestratorError('x');
    error.name = `Evil ${SENSITIVE_MARKER}`;
    // The name is not an input to the formatter at all any more.
    expect(formatSafeError(error)).not.toContain(SENSITIVE_MARKER);
    expect(formatSafeError(error)).not.toContain('Evil');
  });

  it('exposes the id as a read-only getter that cannot be reassigned', () => {
    const error = new IllegalTransitionError('ABORTED', 'CREATED', [], 'terminal state');
    // Whether the assignment throws (strict mode) or is silently ignored, the
    // resolved id must not change: it lives in a private field.
    try {
      (error as unknown as { domainErrorId: string }).domainErrorId = 'INVALID_RESUME_POINT';
    } catch {
      // Expected on an accessor without a setter.
    }
    expect(safeDomainErrorId(error)).toBe('ILLEGAL_TRANSITION');
  });

  it('degrades an id outside the closed set to the base identity', () => {
    const error = new OrchestratorError('x', 'NOT_A_REAL_ID' as never);
    expect(safeDomainErrorId(error)).toBe('ORCHESTRATOR_INVARIANT_VIOLATED');
    expect(formatSafeError(error)).not.toContain('NOT_A_REAL_ID');
  });

  it('keeps the id table exhaustive and free of foreign text', () => {
    expect(Object.keys(DOMAIN_ERROR_TEXT).sort()).toEqual([...DOMAIN_ERROR_IDS].sort());
    for (const id of DOMAIN_ERROR_IDS) {
      expect(isDomainErrorId(id)).toBe(true);
      expect(DOMAIN_ERROR_TEXT[id].length).toBeGreaterThan(0);
    }
    expect(isDomainErrorId('ORCHESTRATOR_INVARIANT_VIOLATED_')).toBe(false);
    expect(isDomainErrorId(SENSITIVE_MARKER)).toBe(false);
  });
});

describe('the removed SAFE_MESSAGE fallback cannot be forged', () => {
  /**
   * Every one of these produced attacker-chosen output on the previous
   * implementation: it accepted the global symbol as proof of provenance and
   * then printed the object's own `safeMessage`.
   */
  it.each([
    [
      'the exact former SAFE_MESSAGE symbol',
      { [FORMER_SAFE_MESSAGE_SYMBOL]: true, safeMessage: `Everything is fine. ${SENSITIVE_MARKER}` },
    ],
    [
      'Symbol.for with the same key, obtained independently',
      {
        [Symbol.for('agent-loop.safeMessage')]: true,
        safeMessage: SENSITIVE_MARKER,
        name: 'OrchestratorError',
      },
    ],
    ['a bare safeMessage property', { safeMessage: SENSITIVE_MARKER }],
    [
      'a safeMessage on a real Error',
      Object.assign(new Error('x'), { safeMessage: SENSITIVE_MARKER }),
    ],
    [
      'a forged domain error id',
      { domainErrorId: 'ILLEGAL_TRANSITION', safeMessage: SENSITIVE_MARKER },
    ],
    [
      'a forged domain error id on a real Error',
      Object.assign(new Error(SENSITIVE_MARKER), { domainErrorId: 'INVALID_RESUME_POINT' }),
    ],
    [
      'the symbol, the id and the name together',
      Object.assign(new Error(SENSITIVE_MARKER), {
        [FORMER_SAFE_MESSAGE_SYMBOL]: true,
        domainErrorId: 'ORCHESTRATOR_INVARIANT_VIOLATED',
        name: 'IllegalTransitionError',
        safeMessage: SENSITIVE_MARKER,
        code: 'EACCES',
      }),
    ],
  ])('refuses to trust %s', (_label, impostor) => {
    const text = formatSafeError(impostor);
    expect(text).not.toContain(SENSITIVE_MARKER);
    expect(text).not.toContain('Everything is fine');
    expect(text).toBe(`${WITHHELD_ERROR_TEXT} [${UNEXPECTED_ERROR_CODE}]`);
    expect(safeDomainErrorId(impostor)).toBeNull();
  });

  it('refuses a duplicate, structurally identical error class', () => {
    // What a second loaded copy of this package would look like: same shape,
    // same names, same id — but not our class. It fails closed rather than
    // being recognised, which is the documented trade-off.
    class OrchestratorError2 extends Error {
      readonly domainErrorId = 'ILLEGAL_TRANSITION';
      readonly safeMessage = SENSITIVE_MARKER;
      constructor() {
        super(SENSITIVE_MARKER);
        this.name = 'OrchestratorError';
      }
    }
    const duplicate = new OrchestratorError2();

    expect(safeDomainErrorId(duplicate)).toBeNull();
    expect(formatSafeError(duplicate)).toBe(`${WITHHELD_ERROR_TEXT} [${UNEXPECTED_ERROR_CODE}]`);
  });

  it('exports no SAFE_MESSAGE symbol at all any more', async () => {
    const errors = await import('../src/core/errors.js');
    const safeError = await import('../src/core/safe-error.js');
    expect(errors).not.toHaveProperty('SAFE_MESSAGE');
    expect(safeError).not.toHaveProperty('SAFE_MESSAGE');
    for (const namespace of [errors, safeError]) {
      for (const key of Object.keys(namespace)) {
        expect(key.toLowerCase()).not.toContain('safemessage');
      }
    }
  });

  it('puts no safeMessage on our own errors either', () => {
    const error = new IllegalTransitionError('ABORTED', 'CREATED', [], 'terminal state');
    expect(error).not.toHaveProperty('safeMessage');
    expect(Object.getOwnPropertySymbols(error)).toEqual([]);
  });
});

describe('foreign errors are reduced to a fixed code', () => {
  it.each([
    ['a plain Error carrying untrusted text', new Error(SENSITIVE_MARKER)],
    ['a TypeError', new TypeError(`cannot read ${SENSITIVE_MARKER}`)],
    ['a SyntaxError from JSON.parse', new SyntaxError(`Unexpected token ${SENSITIVE_MARKER}`)],
    ['an errno exception', Object.assign(new Error(SENSITIVE_MARKER), { code: 'EACCES' })],
    ['a marker in error.code', Object.assign(new Error('x'), { code: SENSITIVE_MARKER })],
    [
      'a marker in an errno-shaped error.code',
      Object.assign(new Error('x'), { code: `E_${SENSITIVE_MARKER.toUpperCase()}` }),
    ],
    ['a thrown string', SENSITIVE_MARKER],
    ['a thrown object', { message: SENSITIVE_MARKER }],
    [
      'a thrown object with a safe-looking name',
      { name: 'OrchestratorError', message: SENSITIVE_MARKER },
    ],
    ['a thrown array', [SENSITIVE_MARKER]],
    ['null', null],
    ['undefined', undefined],
  ])('never republishes %s', (_label, error) => {
    const text = formatSafeError(error);
    expect(text).not.toContain(SENSITIVE_MARKER);
    expect(text).toContain(WITHHELD_ERROR_TEXT);
    expect(text).toContain(UNEXPECTED_ERROR_CODE);
    expect(text.length).toBeGreaterThan(0);
  });

  it('never echoes a foreign error name, however identifier-shaped', () => {
    expect(formatSafeError(new TypeError('x'))).not.toContain('TypeError');
    expect(safeDomainErrorId(new TypeError('x'))).toBeNull();

    const impostor = new Error('x');
    impostor.name = 'IllegalTransitionError';
    expect(safeDomainErrorId(impostor)).toBeNull();
    expect(formatSafeError(impostor)).not.toContain('IllegalTransitionError');

    const weird = new Error('x');
    weird.name = `Error${SENSITIVE_MARKER}`;
    expect(formatSafeError(weird)).not.toContain(SENSITIVE_MARKER);
    expect(safeDomainErrorId(weird)).toBeNull();
  });

  it('emits only text that appears literally in the static table', () => {
    const permitted = new Set<string>([
      `${WITHHELD_ERROR_TEXT} [${UNEXPECTED_ERROR_CODE}]`,
      ...DOMAIN_ERROR_IDS.map((id) => `${DOMAIN_ERROR_TEXT[id]} [${id}]`),
    ]);
    for (const value of [
      null,
      undefined,
      0,
      '',
      false,
      {},
      [],
      new Error(SENSITIVE_MARKER),
      { safeMessage: SENSITIVE_MARKER },
      new OrchestratorError('x'),
      new InvalidResumePointError('y'),
      new TrustedProfileUnavailableError('z'),
      new IllegalTransitionError('ABORTED', 'CREATED', [], 'terminal state'),
    ]) {
      expect(permitted.has(formatSafeError(value))).toBe(true);
    }
  });

  it('never returns an empty string', () => {
    for (const value of [null, undefined, 0, '', false, {}, []]) {
      expect(formatSafeError(value).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('safeErrnoCode uses a closed allow-list, not a shape test', () => {
  it.each(['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR'])(
    'passes through the allow-listed %s',
    (code) => {
      expect(ALLOWED_ERRNO_CODES).toContain(code);
      expect(safeErrnoCode(Object.assign(new Error('boom'), { code }))).toBe(code);
    },
  );

  it('emits the fixed allow-listed code and nothing else for a forged errno', () => {
    // A foreign object claiming an allow-listed code gets exactly that code —
    // a fixed literal from our own list — and none of its other properties.
    const forged = Object.assign(new Error(SENSITIVE_MARKER), {
      code: 'EACCES',
      name: SENSITIVE_MARKER,
      safeMessage: SENSITIVE_MARKER,
      [FORMER_SAFE_MESSAGE_SYMBOL]: true,
    });
    expect(safeErrnoCode(forged)).toBe('EACCES');
    expect(formatSafeError(forged)).not.toContain(SENSITIVE_MARKER);
  });

  it.each([
    ['an unknown but errno-shaped code', 'EMADEUP'],
    ['a marker in screaming snake case', SENSITIVE_MARKER.toUpperCase()],
    ['a prefixed marker', `E${SENSITIVE_MARKER.toUpperCase()}`],
    ['a lower-case code', 'enoent'],
    ['a message-shaped code', `failed: ${SENSITIVE_MARKER}`],
    ['an over-long code', 'E'.repeat(64)],
    ['a numeric code', 42],
  ])('reduces %s to UNKNOWN', (_label, code) => {
    const result = safeErrnoCode(Object.assign(new Error('boom'), { code }));
    expect(result).toBe(UNKNOWN_ERRNO_CODE);
    expect(result).not.toContain(SENSITIVE_MARKER.toUpperCase());
  });

  it('reduces a missing code to UNKNOWN', () => {
    expect(safeErrnoCode(new Error('boom'))).toBe(UNKNOWN_ERRNO_CODE);
    expect(safeErrnoCode(null)).toBe(UNKNOWN_ERRNO_CODE);
    expect(safeErrnoCode('nope')).toBe(UNKNOWN_ERRNO_CODE);
  });

  it('holds a small, closed, duplicate-free list', () => {
    expect(new Set(ALLOWED_ERRNO_CODES).size).toBe(ALLOWED_ERRNO_CODES.length);
    expect(ALLOWED_ERRNO_CODES.length).toBeLessThan(32);
    for (const code of ALLOWED_ERRNO_CODES) {
      expect(code).toMatch(/^E[A-Z0-9]{1,15}$/);
    }
  });
});
