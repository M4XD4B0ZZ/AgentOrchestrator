/**
 * Path identity: the one comparison persisted locations are judged by.
 *
 * The property under test is narrow and absolute: two *absolute* canonical
 * paths may be compared, and a relative one may not be compared at all. A
 * relative path has no identity of its own — it only acquires one by being
 * resolved against something, and the only thing available to resolve it
 * against here would be `process.cwd()`. That is precisely the authority this
 * codebase refuses to give the operator's shell.
 */

import { sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { absolutePathsEqual, comparePathIdentity } from '../src/core/path-identity.js';

const WINDOWS = process.platform === 'win32';
const ABSOLUTE = WINDOWS ? 'D:\\srv\\projects\\alpha' : '/srv/projects/alpha';

describe('comparing two absolute paths', () => {
  it('calls the same directory equal', () => {
    expect(comparePathIdentity(ABSOLUTE, ABSOLUTE)).toBe('EQUAL');
  });

  it('ignores a trailing separator', () => {
    expect(comparePathIdentity(`${ABSOLUTE}${sep}`, ABSOLUTE)).toBe('EQUAL');
  });

  it('normalises a traversal segment inside an absolute path', () => {
    const detoured = WINDOWS
      ? 'D:\\srv\\projects\\beta\\..\\alpha'
      : '/srv/projects/beta/../alpha';
    expect(comparePathIdentity(detoured, ABSOLUTE)).toBe('EQUAL');
  });

  it('calls two different directories different', () => {
    expect(comparePathIdentity(`${ABSOLUTE}2`, ABSOLUTE)).toBe('DIFFERENT');
  });

  it.runIf(WINDOWS)('treats Windows casing and separator shape as one spelling', () => {
    expect(comparePathIdentity('D:\\Repos\\Alpha', 'd:/repos/alpha')).toBe('EQUAL');
  });
});

/**
 * The reason this module exists. Under a comparison built on `path.resolve()`,
 * every one of these would be answered by whatever directory the process
 * happens to be standing in.
 */
describe('refusing to compare a relative path', () => {
  it('refuses a relative left-hand side', () => {
    expect(comparePathIdentity('some/relative/path', ABSOLUTE)).toBe('NOT_ABSOLUTE');
  });

  it('refuses a relative right-hand side', () => {
    expect(comparePathIdentity(ABSOLUTE, 'some/relative/path')).toBe('NOT_ABSOLUTE');
  });

  it('refuses "." rather than answering with the current working directory', () => {
    expect(comparePathIdentity('.', process.cwd())).toBe('NOT_ABSOLUTE');
    expect(absolutePathsEqual('.', process.cwd())).toBe(false);
  });

  it('refuses the empty string and blank text', () => {
    expect(comparePathIdentity('', ABSOLUTE)).toBe('NOT_ABSOLUTE');
    expect(comparePathIdentity('   ', ABSOLUTE)).toBe('NOT_ABSOLUTE');
  });

  it('never repairs a relative path into an equal one', () => {
    // A relative spelling that `path.resolve()` would turn into exactly the
    // right-hand side. Equality here would be an accident of the cwd.
    expect(absolutePathsEqual('.', process.cwd())).toBe(false);
    expect(absolutePathsEqual(process.cwd(), '.')).toBe(false);
  });
});

describe('absolutePathsEqual', () => {
  it('is true only for the EQUAL verdict', () => {
    expect(absolutePathsEqual(ABSOLUTE, `${ABSOLUTE}${sep}`)).toBe(true);
    expect(absolutePathsEqual(ABSOLUTE, `${ABSOLUTE}2`)).toBe(false);
    expect(absolutePathsEqual('relative', 'relative')).toBe(false);
  });
});
