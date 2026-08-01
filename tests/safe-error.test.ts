import { describe, expect, it } from 'vitest';

import {
  IllegalTransitionError,
  InvalidResumePointError,
  OrchestratorError,
} from '../src/core/errors.js';
import {
  formatSafeError,
  safeErrnoCode,
  safeErrorName,
  UNKNOWN_ERRNO_CODE,
  WITHHELD_ERROR_TEXT,
} from '../src/core/safe-error.js';
import { assertTransition } from '../src/core/transitions.js';
import { SENSITIVE_MARKER } from './fixtures.js';

describe('formatSafeError', () => {
  it('shows the safe message of an orchestrator error', () => {
    const error = new OrchestratorError('internal detail', 'A documented invariant was violated.');
    expect(formatSafeError(error)).toBe('A documented invariant was violated.');
  });

  it('shows the full transition error, which is built from the state vocabulary', () => {
    let thrown: unknown;
    try {
      assertTransition('READY_FOR_PR', 'IMPLEMENTING');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(IllegalTransitionError);
    const text = formatSafeError(thrown);
    expect(text).toContain('READY_FOR_PR');
    expect(text).toContain('terminal state');
  });

  it('withholds the quoted input of a resume-point error', () => {
    const error = new InvalidResumePointError(`Not a valid resume point: "${SENSITIVE_MARKER}".`);
    const text = formatSafeError(error);
    expect(text).not.toContain(SENSITIVE_MARKER);
    expect(text).toContain('resume point');
  });

  it.each([
    ['a plain Error carrying untrusted text', new Error(SENSITIVE_MARKER)],
    ['a TypeError', new TypeError(`cannot read ${SENSITIVE_MARKER}`)],
    ['a SyntaxError from JSON.parse', new SyntaxError(`Unexpected token ${SENSITIVE_MARKER}`)],
    ['an errno exception', Object.assign(new Error(SENSITIVE_MARKER), { code: 'EACCES' })],
    ['a thrown string', SENSITIVE_MARKER],
    ['a thrown object', { message: SENSITIVE_MARKER }],
    ['a thrown array', [SENSITIVE_MARKER]],
    ['null', null],
    ['undefined', undefined],
  ])('never republishes %s', (_label, error) => {
    const text = formatSafeError(error);
    expect(text).not.toContain(SENSITIVE_MARKER);
    expect(text).toContain(WITHHELD_ERROR_TEXT);
    expect(text.length).toBeGreaterThan(0);
  });

  it('echoes only an identifier-shaped error name', () => {
    expect(formatSafeError(new TypeError('x'))).toContain('(TypeError)');

    const weird = new Error('x');
    weird.name = `Error ${SENSITIVE_MARKER}!!`;
    expect(formatSafeError(weird)).not.toContain(SENSITIVE_MARKER);
    expect(safeErrorName(weird)).toBeNull();
  });

  it('never returns an empty string', () => {
    for (const value of [null, undefined, 0, '', false, {}, []]) {
      expect(formatSafeError(value).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('safeErrnoCode', () => {
  it.each(['ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR'])('passes through %s', (code) => {
    expect(safeErrnoCode(Object.assign(new Error('boom'), { code }))).toBe(code);
  });

  it.each([
    ['a lower-case code', 'enoent'],
    ['a message-shaped code', `failed: ${SENSITIVE_MARKER}`],
    ['an over-long code', 'E'.repeat(64)],
    ['a numeric code', 42],
  ])('reduces %s to UNKNOWN', (_label, code) => {
    expect(safeErrnoCode(Object.assign(new Error('boom'), { code }))).toBe(UNKNOWN_ERRNO_CODE);
  });

  it('reduces a missing code to UNKNOWN', () => {
    expect(safeErrnoCode(new Error('boom'))).toBe(UNKNOWN_ERRNO_CODE);
    expect(safeErrnoCode(null)).toBe(UNKNOWN_ERRNO_CODE);
    expect(safeErrnoCode('nope')).toBe(UNKNOWN_ERRNO_CODE);
  });
});
