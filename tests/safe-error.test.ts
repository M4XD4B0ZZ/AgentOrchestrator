/**
 * AO-002-R2: the error formatter emits only allow-listed text.
 *
 * The previous implementation echoed any `error.name` that *looked* like a JS
 * identifier and any `error.code` that *looked* like an errno constant. Shape
 * is not provenance: both properties are writable, so a foreign object could
 * choose what the CLI printed. The probes below pass a marker through both
 * properties and require it never to surface.
 */

import { describe, expect, it } from 'vitest';

import {
  IllegalTransitionError,
  InvalidResumePointError,
  OrchestratorError,
} from '../src/core/errors.js';
import {
  ALLOWED_ERRNO_CODES,
  formatSafeError,
  ORCHESTRATOR_ERROR_NAMES,
  safeErrnoCode,
  safeErrorName,
  UNEXPECTED_ERROR_CODE,
  UNKNOWN_ERRNO_CODE,
  WITHHELD_ERROR_TEXT,
} from '../src/core/safe-error.js';
import { assertTransition } from '../src/core/transitions.js';
import { SENSITIVE_MARKER } from './fixtures.js';

describe('our own domain errors', () => {
  it('shows the safe message of an orchestrator error', () => {
    const error = new OrchestratorError('internal detail', 'A documented invariant was violated.');
    expect(formatSafeError(error)).toContain('A documented invariant was violated.');
    expect(formatSafeError(error)).toContain('[OrchestratorError]');
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
    expect(safeErrorName(thrown)).toBe('IllegalTransitionError');
  });

  it('withholds the quoted input of a resume-point error', () => {
    const error = new InvalidResumePointError(`Not a valid resume point: "${SENSITIVE_MARKER}".`);
    const text = formatSafeError(error);
    expect(text).not.toContain(SENSITIVE_MARKER);
    expect(text).toContain('resume point');
    expect(safeErrorName(error)).toBe('InvalidResumePointError');
  });

  it('only ever names a class from the closed list', () => {
    for (const error of [
      new OrchestratorError('x'),
      new InvalidResumePointError('y'),
      new IllegalTransitionError('ABORTED', 'CREATED', [], 'terminal state'),
    ]) {
      expect(ORCHESTRATOR_ERROR_NAMES).toContain(safeErrorName(error));
    }
  });

  it('degrades a tampered name on our own error to the base class name', () => {
    const error = new OrchestratorError('x', 'Safe text.');
    error.name = `Evil ${SENSITIVE_MARKER}`;
    expect(safeErrorName(error)).toBe('OrchestratorError');
    expect(formatSafeError(error)).not.toContain(SENSITIVE_MARKER);
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
    ['a thrown object with a safe-looking name', { name: 'OrchestratorError', message: SENSITIVE_MARKER }],
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
    // The old formatter printed "(TypeError)" here, and would equally have
    // printed any name a foreign object assigned to itself.
    expect(formatSafeError(new TypeError('x'))).not.toContain('TypeError');
    expect(safeErrorName(new TypeError('x'))).toBeNull();

    const impostor = new Error('x');
    impostor.name = 'IllegalTransitionError';
    expect(safeErrorName(impostor)).toBeNull();
    expect(formatSafeError(impostor)).not.toContain('IllegalTransitionError');

    const weird = new Error('x');
    weird.name = `Error${SENSITIVE_MARKER}`;
    expect(formatSafeError(weird)).not.toContain(SENSITIVE_MARKER);
    expect(safeErrorName(weird)).toBeNull();
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
