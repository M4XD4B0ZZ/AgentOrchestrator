#!/usr/bin/env node
/**
 * AO-WINPROFILE-001 (closes AO-007-R1-RR1-REVIEW-01).
 *
 * Standalone Node script — deliberately not a vitest test file, and
 * deliberately plain JavaScript rather than TypeScript. It is spawned as its
 * own child process by the `test:dist-trusted-profile` npm script (and
 * transitively by `verify:dist-trusted-profile` and `verify`), and it imports
 * exactly one module:
 *
 *     dist/config/internal/trusted-profile.js
 *
 * via an explicit, absolute `file://` URL computed from this script's own
 * location. There is no TypeScript compilation, no vitest module resolution and
 * no `tsconfig`/`nodenext` path mapping involved in reaching that file, so
 * nothing here can be silently redirected back to
 * `src/config/internal/trusted-profile.ts`. The point is to prove that the
 * *shipped* artefact — not the source a test runner happens to transpile — is
 * free of the removed PowerShell resolver and answers from the operating
 * system.
 *
 * Contract: exit code 0 means every check below passed. Any nonzero exit code
 * means at least one did not.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const distEntry = join(repoRoot, 'dist', 'config', 'internal', 'trusted-profile.js');

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// ── Build freshness: a missing dist artefact is a hard, explicit failure ─────
if (!existsSync(distEntry)) {
  console.error(
    'dist/config/internal/trusted-profile.js does not exist. Run "npm run build" before this ' +
      'check (see the "verify:dist-trusted-profile" npm script, which does this for you).',
  );
  process.exit(1);
}

const distModule = await import(pathToFileURL(distEntry).href);

// ── 1./2. The removed helper mechanism is gone from the shipped artefact ────
const REMOVED_NAMES = [
  'HELPER_OUTPUT_PREFIX',
  'HELPER_SOURCE',
  'WINDOWS_HELPER_COMMAND',
  'windowsPowerShellPath',
  'helperInvocation',
  'parseHelperOutput',
];

for (const name of REMOVED_NAMES) {
  check(
    !(name in distModule),
    `dist module still exposes the removed helper export: ${name}`,
  );
  check(
    distModule[name] === undefined,
    `dist module still resolves a value for the removed helper name: ${name}`,
  );
}

/**
 * Every emitted file for this module, so a removed mechanism cannot survive as
 * dead shipped code, as a stale declaration, or inside a source map.
 */
const emittedFiles = [
  distEntry,
  join(repoRoot, 'dist', 'config', 'internal', 'trusted-profile.d.ts'),
  `${distEntry}.map`,
  join(repoRoot, 'dist', 'config', 'internal', 'trusted-profile.d.ts.map'),
].filter((file) => existsSync(file));

check(emittedFiles.includes(distEntry), 'the built JavaScript module was not among the emitted files');

/**
 * ── The scan strategy (AO-WINPROFILE-001-R1, REV-02) ────────────────────────
 *
 * There used to be a line-based comment filter here: every line beginning with
 * `//`, a block-comment opener or `*` was dropped before scanning, so the
 * module's historical prose could name the mechanism it had removed. That
 * filter was unsound — a line filter cannot tell a comment from code, and two
 * shapes walked straight through it:
 *
 *   - executable code following a block-comment terminator on the same line,
 *     because the line starts with `*` and was therefore dropped whole;
 *   - a line of a template literal that happens to start with `*`, which is
 *     ordinary program data and not a comment at all.
 *
 * Both are reproduced as self-tests below. The fix is not a cleverer filter:
 * the emitted files are scanned as complete text, with no filtering of any
 * kind, and the module's prose was rewritten to describe only what it does
 * today. No comment parser is needed, and none is used.
 */
const FORBIDDEN_TOKENS = [
  ...REMOVED_NAMES,
  'powershell',
  'pwsh',
  'System32',
  'WindowsPowerShell',
  'GetFolderPath',
  'SpecialFolder',
  'spawnSync',
  'child_process',
  'execPath',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'process.env',
];

/**
 * Every forbidden token occurring anywhere in `text`, matched
 * case-insensitively over the whole input. No line handling, no filtering, no
 * comment awareness — that is the entire point.
 *
 * @param {string} text
 * @returns {string[]}
 */
const forbiddenTokensIn = (text) => {
  const haystack = String(text).toLowerCase();
  return FORBIDDEN_TOKENS.filter((token) => haystack.includes(token.toLowerCase()));
};

// ── Scanner self-tests ──────────────────────────────────────────────────────
// The first two are the bypasses the review reproduced against the old filter.
// A misclassification here is a failure like any other, so the whole check
// exits non-zero rather than silently scanning with a broken scanner.
const SCANNER_MUST_REJECT = [
  [
    'executable code directly after a block-comment terminator',
    `/* removed helper documentation
*/ function helperInvocation() { return spawnSync; }`,
  ],
  [
    'an old helper call in a template literal, on a line beginning with *',
    `const payload = \`
* spawnSync('powershell')
\`;`,
  ],
  ['a plain executable line naming an old token', `void "spawnSync";`],
];

for (const [label, sample] of SCANNER_MUST_REJECT) {
  check(
    forbiddenTokensIn(sample).length > 0,
    `the emitted-artefact scanner failed to flag ${label}`,
  );
}

// A harmless, current code sample must not be flagged, or the scan would be a
// tautology that proves nothing about the artefact.
const SCANNER_MUST_ACCEPT = `export function trustedProfileDirectory() {
  const info = userInfo();
  return realpathSync.native(info.homedir);
}`;
check(
  forbiddenTokensIn(SCANNER_MUST_ACCEPT).length === 0,
  `the emitted-artefact scanner flagged a harmless current code sample: ${forbiddenTokensIn(SCANNER_MUST_ACCEPT).join(', ')}`,
);

// ── The real artefacts: JavaScript and declarations, scanned in full ─────────
for (const file of emittedFiles.filter((f) => !f.endsWith('.map'))) {
  for (const token of forbiddenTokensIn(readFileSync(file, 'utf8'))) {
    failures.push(`${file.slice(repoRoot.length + 1)} still contains "${token}"`);
  }
}

/**
 * A source map is scanned as complete text as well, with exactly one documented
 * exclusion: the `mappings` field. That field is not text — it is a base64 VLQ
 * encoding of integer positions over the alphabet [A-Za-z0-9+/], so a short
 * token can occur inside it by arithmetic coincidence and would mean nothing.
 * Every field that can actually carry source text — `sources`,
 * `sourcesContent`, `names`, `file` and anything else the map declares — is
 * scanned in full. A map that cannot be parsed as JSON is scanned raw rather
 * than skipped.
 *
 * @param {string} raw
 * @returns {string}
 */
const scannableMapText = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return raw;
    const withoutMappings = { ...parsed };
    delete withoutMappings.mappings;
    return JSON.stringify(withoutMappings);
  } catch {
    return raw;
  }
};

for (const file of emittedFiles.filter((f) => f.endsWith('.map'))) {
  for (const token of forbiddenTokensIn(scannableMapText(readFileSync(file, 'utf8')))) {
    failures.push(
      `${file.slice(repoRoot.length + 1)} still carries the old resolver token "${token}"`,
    );
  }
}

// ── Runtime export surface: exactly the intended internal surface ───────────
const ALLOWED_EXPORTS = new Set([
  'trustedProfileDirectory',
  'resetTrustedProfileCacheForTests',
  'createTrustedProfileResolverForTests',
]);

const actualExports = new Set(Object.keys(distModule));
for (const name of actualExports) {
  check(ALLOWED_EXPORTS.has(name), `dist module exports an unexpected name: ${name}`);
}
for (const name of ALLOWED_EXPORTS) {
  check(actualExports.has(name), `dist module is missing expected export: ${name}`);
}

const {
  trustedProfileDirectory,
  resetTrustedProfileCacheForTests,
  createTrustedProfileResolverForTests,
} = distModule;

// ── 6. No internal provider reference leaks out ─────────────────────────────
for (const forbidden of [
  'PRODUCTION_DEPENDENCIES',
  'setTrustedProfileProvider',
  'setTrustedProfileDependencies',
  'trustedProfileDependencies',
  'resolveTrustedProfile',
]) {
  check(!(forbidden in distModule), `dist module exposes an internal provider handle: ${forbidden}`);
}

check(
  typeof trustedProfileDirectory === 'function' && trustedProfileDirectory.length === 0,
  'trustedProfileDirectory must take no argument, so no caller can supply a profile path',
);
check(
  typeof createTrustedProfileResolverForTests === 'function' &&
    createTrustedProfileResolverForTests.length === 1,
  'createTrustedProfileResolverForTests must take exactly one dependency object',
);

// The test factory must not accept a ready-made path in place of dependencies.
try {
  const bogus = createTrustedProfileResolverForTests('C:\\ao-not-a-dependency-object');
  let threw = false;
  try {
    bogus();
  } catch {
    threw = true;
  }
  check(threw, 'the test factory accepted a bare string instead of a dependency object');
} catch {
  // Throwing at construction time is equally acceptable.
}

/** The one character no filesystem path may contain. */
const NUL = String.fromCharCode(0);

/**
 * The full acceptance contract for a resolved profile path, checked against the
 * real filesystem (AO-WINPROFILE-001-R1, REV-03).
 *
 * The last step is the one that matters most: `realpathSync.native` must both
 * succeed and return a value **identical** to what the resolver returned. The
 * comparison is a strict `===` between the exact strings — no case folding, no
 * separator normalisation, no trimming — because each of those would hide
 * precisely the non-canonical answer this check exists to catch. A `realpath`
 * that throws is a failure, never a skipped check.
 *
 * @param {string} label
 * @param {unknown} value
 */
const checkCanonicalDirectory = (label, value) => {
  check(typeof value === 'string', `${label}: resolved a non-string value`);
  if (typeof value !== 'string') return;

  check(value.length > 0, `${label}: resolved an empty path`);
  check(isAbsolute(value), `${label}: the resolved path is not absolute`);
  check(!value.includes(NUL), `${label}: the resolved path carries an embedded NUL`);
  check(existsSync(value), `${label}: the resolved path does not exist`);

  try {
    check(statSync(value).isDirectory() === true, `${label}: the resolved path is not a directory`);
  } catch {
    failures.push(`${label}: the resolved path could not be stat-ed`);
  }

  let canonical = null;
  try {
    canonical = realpathSync.native(value);
  } catch {
    failures.push(`${label}: realpathSync.native failed on the resolved path`);
  }
  check(canonical !== null, `${label}: the resolved path could not be canonicalised`);
  check(canonical === value, `${label}: the resolved path is not its own canonical form`);
};

// ── 3. The real resolver answers from the operating system ──────────────────
const profile = trustedProfileDirectory();
checkCanonicalDirectory('the productive resolver', profile);

// Memoisation and the reset seam behave as contracted.
check(trustedProfileDirectory() === profile, 'a second call returned a different profile path');
resetTrustedProfileCacheForTests();
check(
  trustedProfileDirectory() === profile,
  'the profile path changed after a cache reset',
);

// ── 4./5. A fresh process with a spoofed environment gets the same answer ───
/**
 * `SystemRoot` and `windir` are deliberately NOT spoofed here: Node v24.18.1
 * aborts during process initialisation (exit 134, `ncrypto::CSPRNG`) when they
 * point somewhere invalid, before any JavaScript runs, so the child could never
 * reach the resolver. `tests/trusted-profile.test.ts` covers those two
 * in-process instead.
 */
const SPOOFED = {
  USERPROFILE: 'Z:\\ao-spoof\\profile',
  HOME: 'Z:\\ao-spoof\\home',
  HOMEDRIVE: 'Z:',
  HOMEPATH: '\\ao-spoof\\homepath',
  APPDATA: 'Z:\\ao-spoof\\appdata',
  LOCALAPPDATA: 'Z:\\ao-spoof\\localappdata',
  PATHEXT: '.AO-SPOOF',
};

const CHILD_PREFIX = 'DIST-TRUSTED-PROFILE ';
const childSource =
  `const m = await import(${JSON.stringify(pathToFileURL(distEntry).href)});` +
  `process.stdout.write(${JSON.stringify(CHILD_PREFIX)} + ` +
  'JSON.stringify({ profile: m.trustedProfileDirectory() }) + "\\n");';

let childProfile = null;
try {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', childSource], {
    env: { ...process.env, ...SPOOFED },
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(CHILD_PREFIX));
  check(line !== undefined, 'the spoofed child produced no delimited output line');
  if (line !== undefined) {
    childProfile = JSON.parse(line.slice(CHILD_PREFIX.length)).profile;
  }
} catch (error) {
  failures.push(
    `the spoofed child process failed to run (exit ${error && error.status !== undefined ? error.status : 'unknown'})`,
  );
}

check(
  childProfile === profile,
  'a child process with spoofed profile variables resolved a different profile path',
);
// The child's answer earns no exemption: it faces the same canonical contract.
if (childProfile !== null) checkCanonicalDirectory('the spoofed child probe', childProfile);
for (const decoy of Object.values(SPOOFED)) {
  check(
    childProfile === null || !String(childProfile).startsWith(decoy),
    'the child accepted a spoofed decoy as the profile path',
  );
}

// ── Fail-closed, without leaking, against the built module ──────────────────
const SECRET = 'ao-dist-secret-must-not-leak';
const failingResolver = createTrustedProfileResolverForTests({
  userInfo: () => {
    throw new Error(SECRET);
  },
  realpath: (p) => p,
  stat: () => ({ isDirectory: () => true }),
});

let leaked = null;
let failedClosed = false;
try {
  failingResolver();
} catch (error) {
  failedClosed = true;
  const text = `${error && error.message ? error.message : ''}\n${error && error.stack ? error.stack : ''}`;
  if (text.includes(SECRET)) leaked = 'the injected exception message';
  check(
    error && error.name === 'TrustedProfileUnavailableError',
    `a failing resolution threw ${error && error.name ? error.name : 'an unknown error'} instead of TrustedProfileUnavailableError`,
  );
  check(
    error && typeof error.domainErrorId === 'string' && error.domainErrorId === 'TRUSTED_PROFILE_UNAVAILABLE',
    'a failing resolution did not carry the TRUSTED_PROFILE_UNAVAILABLE domain error id',
  );
}
check(failedClosed, 'a resolution whose OS query throws did not fail closed');
check(leaked === null, `a failing resolution leaked ${leaked}`);

// A failure must not be cached as a success.
const spoofedProfile = 'Z:\\ao-spoof\\never-accepted';
check(
  trustedProfileDirectory() === profile,
  'the productive resolver changed after an isolated resolver failed',
);
check(profile !== spoofedProfile, 'the resolver returned a decoy path');

// ── 7. Deep imports of the internal module stay unpublished ─────────────────
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
for (const exported of Object.keys(manifest.exports ?? {})) {
  check(!exported.includes('internal'), `package.json exports an internal path: ${exported}`);
  check(!exported.includes('config'), `package.json exports a config path: ${exported}`);
}
for (const target of Object.values(manifest.exports ?? {})) {
  check(
    typeof target !== 'string' || !target.includes('trusted-profile'),
    'package.json publishes the trusted-profile module as an export target',
  );
}

// ── Result ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(
    `dist/config/internal/trusted-profile.js integration check FAILED (${failures.length} issue(s)):`,
  );
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}

console.log('dist/config/internal/trusted-profile.js integration check passed.');
process.exit(0);
