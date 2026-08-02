#!/usr/bin/env node
/**
 * AO-FOUNDATION-REM-002C4 (closes AO-FOUNDATION-REM-002C3-REREVIEW-01).
 *
 * Standalone Node script — deliberately not a vitest test file, and
 * deliberately plain JavaScript rather than TypeScript. It is spawned as its
 * own child process directly by the `test:dist-doctor` npm script (and
 * transitively by `verify:dist-doctor` and `verify`), and it imports exactly
 * one module:
 *
 *     dist/doctor/run-completion.js
 *
 * via an explicit, absolute `file://` URL computed from this script's own
 * location. There is no TypeScript compilation, no vitest module resolution,
 * and no `tsconfig`/`nodenext` path mapping involved in reaching that file,
 * so nothing here can be silently redirected back to `src/doctor/run-completion.ts`.
 * There used to also be a thin vitest wrapper, `tests/run-completion-dist.test.ts`,
 * that did nothing but spawn this same script; it was removed because vitest's
 * default `tests/**\/*.test.ts` glob picked it up, which made a plain `npm test`
 * on a clean checkout (no `dist/` yet) fail for a reason unrelated to the tests
 * vitest is meant to run. This script is the sole dist integration check now.
 *
 * Contract: exit code 0 means every check below passed. Any nonzero exit code
 * means at least one did not. Parsing stdout/stderr is never required to know
 * which — the exit code alone is the contract.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const distEntry = join(repoRoot, 'dist', 'doctor', 'run-completion.js');

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

// ── 5. Build freshness: a missing dist artefact is a hard, explicit failure ──
if (!existsSync(distEntry)) {
  console.error(
    'dist/doctor/run-completion.js does not exist. Run "npm run build" before this check ' +
      '(see the "verify:dist-doctor" npm script, which does this for you).',
  );
  process.exit(1);
}

const distModule = await import(pathToFileURL(distEntry).href);

// ── 2. Runtime export surface ────────────────────────────────────────────────
const ALLOWED_EXPORTS = new Set([
  'COMPLETION_MARKER_CONTENTS',
  'COMPLETION_MARKER_FILE_NAME',
  'RUN_PROTOCOL_VERSION',
  'completeRun',
  'inspectRun',
  'listCompletedRuns',
  'requiredArtefactFileNames',
]);

const actualExports = new Set(Object.keys(distModule));
for (const name of actualExports) {
  check(ALLOWED_EXPORTS.has(name), `dist module exports an unexpected name: ${name}`);
}
for (const name of ALLOWED_EXPORTS) {
  check(actualExports.has(name), `dist module is missing expected export: ${name}`);
}

const { completeRun, inspectRun, requiredArtefactFileNames, COMPLETION_MARKER_FILE_NAME, COMPLETION_MARKER_CONTENTS } =
  distModule;

// ── 3. Freeze and copy semantics, against the real dist module ──────────────
const CANONICAL = ['cli-capabilities.txt', 'doctor-report.json'];
const sameAsCanonical = (value) => JSON.stringify(value) === JSON.stringify(CANONICAL);

const first = requiredArtefactFileNames();
check(Array.isArray(first), 'requiredArtefactFileNames() did not return an array');
check(sameAsCanonical(first), 'requiredArtefactFileNames() did not return the canonical two names, in order');
check(Object.isFrozen(first), 'requiredArtefactFileNames() result is not frozen');

const second = requiredArtefactFileNames();
check(first !== second, 'requiredArtefactFileNames() returned the same array reference twice');
check(Object.isFrozen(second), 'a second requiredArtefactFileNames() result is not frozen');

const mutationAttempts = [
  ['pop', (arr) => arr.pop()],
  ['splice', (arr) => arr.splice(0, 1, 'evil.txt')],
  ['push', (arr) => arr.push('evil.txt')],
  ['index assignment', (arr) => { arr[0] = 'evil.txt'; }],
  ['length = 1', (arr) => { arr.length = 1; }],
  ['reverse', (arr) => arr.reverse()],
  ['sort', (arr) => arr.sort()],
];

for (const [label, mutate] of mutationAttempts) {
  const value = requiredArtefactFileNames();
  let threw = false;
  try {
    mutate(value);
  } catch (error) {
    threw = error instanceof TypeError;
  }
  // Acceptable: the mutation threw (frozen array), or it silently no-opped
  // and the value the caller is holding is still the canonical pair either
  // way. Not acceptable: it "worked" and changed what this caller sees.
  check(threw || sameAsCanonical(value), `mutation "${label}" neither threw nor left the value unchanged`);
  check(
    sameAsCanonical(requiredArtefactFileNames()),
    `mutation "${label}" changed what a later requiredArtefactFileNames() call returns`,
  );
}

// Full local replacement of the binding cannot reach back into the module.
let replaced = requiredArtefactFileNames();
replaced = ['evil.txt'];
check(
  sameAsCanonical(requiredArtefactFileNames()),
  'reassigning a local binding holding the result affected the internal contract',
);
void replaced;

// ── 4. Reproduce the original JavaScript-level attack against dist ──────────
// Two fixed, schema-valid run ids (see RUN_ID_PATTERN in
// src/doctor/run-directory.ts, deliberately not imported here — this script
// only ever exercises the built completion module). One fresh temporary
// runsRoot per script invocation already gives every run its own directory,
// so there is no need to generate a fresh id per call as well.
const ONE_ARTEFACT_RUN_ID = '20260101T000000000Z-00000000-0000-4000-8000-000000000001';
const CONTROL_RUN_ID = '20260101T000000001Z-00000000-0000-4000-8000-000000000002';

function makeRun(runsRoot, runId, fileNames) {
  const runDirectory = join(runsRoot, runId);
  mkdirSync(runDirectory);
  for (const name of fileNames) {
    writeFileSync(join(runDirectory, name), 'x\n', 'utf8');
  }
  return runId;
}

const runsRoot = mkdtempSync(join(tmpdir(), 'ao-dist-doctor-'));
try {
  // Negative case: a run holding only one of the two required artefacts.
  const oneArtefactRunId = makeRun(runsRoot, ONE_ARTEFACT_RUN_ID, ['cli-capabilities.txt']);

  const oneArtefactCompletion = completeRun(runsRoot, oneArtefactRunId);
  check(oneArtefactCompletion.code !== 'COMPLETED', 'one-artefact run was reported COMPLETED by completeRun');
  check(oneArtefactCompletion.completed === false, 'one-artefact run had completed:true from completeRun');
  check(
    oneArtefactCompletion.code === 'REQUIRED_ARTIFACT_MISSING',
    `one-artefact completeRun did not report a missing-artefact code (got ${oneArtefactCompletion.code})`,
  );

  const oneArtefactInspection = inspectRun(runsRoot, oneArtefactRunId);
  check(oneArtefactInspection.code !== 'COMPLETE', 'one-artefact run was reported COMPLETE by inspectRun');
  check(oneArtefactInspection.consumable === false, 'one-artefact run had consumable:true from inspectRun');
  check(
    oneArtefactInspection.code === 'REQUIRED_ARTIFACT_MISSING',
    `one-artefact inspectRun did not report a missing-artefact code (got ${oneArtefactInspection.code})`,
  );

  // ── AO-FOUNDATION-REM-002C4-FINAL-01 ───────────────────────────────────────
  // A pre-existing, byte-valid COMPLETED marker must never authorise a run
  // that is still missing a required artefact. Plant the exact marker bytes by
  // hand — bypassing completeRun entirely — directly in the one-artefact run's
  // own directory, then re-check both inspectRun and completeRun against it.
  const oneArtefactRunDirectory = join(runsRoot, oneArtefactRunId);
  writeFileSync(join(oneArtefactRunDirectory, COMPLETION_MARKER_FILE_NAME), COMPLETION_MARKER_CONTENTS, 'utf8');

  const plantedInspectionBefore = inspectRun(runsRoot, oneArtefactRunId);
  check(
    plantedInspectionBefore.code === 'REQUIRED_ARTIFACT_MISSING',
    `inspectRun with a planted marker but a missing artefact did not report REQUIRED_ARTIFACT_MISSING ` +
      `(got ${plantedInspectionBefore.code})`,
  );
  check(
    plantedInspectionBefore.code !== 'COMPLETE',
    'inspectRun reported COMPLETE for a run with a planted marker but a missing required artefact',
  );
  check(
    plantedInspectionBefore.consumable === false,
    'inspectRun reported consumable:true for a run with a planted marker but a missing required artefact',
  );

  const plantedCompletion = completeRun(runsRoot, oneArtefactRunId);
  check(
    plantedCompletion.code === 'COMPLETION_MARKER_ALREADY_EXISTS',
    `completeRun against a pre-existing marker did not report COMPLETION_MARKER_ALREADY_EXISTS ` +
      `(got ${plantedCompletion.code})`,
  );
  check(
    plantedCompletion.code !== 'COMPLETED',
    'completeRun reported COMPLETED for a run whose marker it never wrote and whose artefact is still missing',
  );
  check(
    plantedCompletion.completed === false,
    'completeRun reported completed:true for a run with a planted marker but a missing required artefact',
  );

  const plantedInspectionAfter = inspectRun(runsRoot, oneArtefactRunId);
  check(
    plantedInspectionAfter.code === 'REQUIRED_ARTIFACT_MISSING',
    `inspectRun after the completeRun attempt no longer reports REQUIRED_ARTIFACT_MISSING ` +
      `(got ${plantedInspectionAfter.code})`,
  );
  check(
    plantedInspectionAfter.consumable === false,
    'inspectRun reported consumable:true after the completeRun attempt against a planted marker',
  );

  // Control case: a separate, fully valid run with both required artefacts.
  const fullRunId = makeRun(runsRoot, CONTROL_RUN_ID, ['cli-capabilities.txt', 'doctor-report.json']);

  const fullCompletion = completeRun(runsRoot, fullRunId);
  check(fullCompletion.code === 'COMPLETED', `control run did not complete (got ${fullCompletion.code})`);
  check(fullCompletion.completed === true, 'control run had completed:false from completeRun');

  const fullInspection = inspectRun(runsRoot, fullRunId);
  check(fullInspection.code === 'COMPLETE', `control run was not COMPLETE on inspection (got ${fullInspection.code})`);
  check(fullInspection.consumable === true, 'control run had consumable:false from inspectRun');

  check(
    sameAsCanonical(requiredArtefactFileNames()),
    'requiredArtefactFileNames() changed after completing the control run',
  );
} finally {
  try {
    rmSync(runsRoot, { recursive: true, force: true });
  } catch (error) {
    failures.push(
      `cleanup of the temporary runsRoot failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ── 6. AO-FOUNDATION-REM-003B: Windows system tool provenance in the built
//      dist/doctor/exec.js, against the trusted internal resolver ─────────
//
// Added alongside the run-completion checks above rather than as a second
// dist script (see this file's own header comment on why a separate vitest
// wrapper around a dist script is avoided): `test:dist-doctor` is the one
// place a fresh build's *shipped* artefact — not `src/`, not anything
// vitest's module resolution could quietly redirect back to `src/doctor/
// exec.ts` — is exercised at all.

const execDistEntry = join(repoRoot, 'dist', 'doctor', 'exec.js');
const windowsSystemToolsDistEntry = join(repoRoot, 'dist', 'doctor', 'internal', 'windows-system-tools.js');
const reportDistEntry = join(repoRoot, 'dist', 'doctor', 'report.js');

if (!existsSync(execDistEntry)) {
  console.error('dist/doctor/exec.js does not exist. Run "npm run build" before this check.');
  process.exit(1);
}
if (!existsSync(windowsSystemToolsDistEntry)) {
  console.error(
    'dist/doctor/internal/windows-system-tools.js does not exist. Run "npm run build" before this check.',
  );
  process.exit(1);
}

const execSource = readFileSync(execDistEntry, 'utf8');

// ── 6a. Static evidence, against the shipped file's own text ───────────────

// The removed vulnerable pattern: `env['SystemRoot'] ?? env['windir']`, in
// every quoting style a bundler/tsc could emit.
for (const pattern of [
  "env['SystemRoot']",
  'env["SystemRoot"]',
  "env['windir']",
  'env["windir"]',
  "env['COMSPEC']",
  'env["COMSPEC"]',
  "env['ComSpec']",
  'env["ComSpec"]',
]) {
  check(!execSource.includes(pattern), `dist/doctor/exec.js still contains the removed pattern ${pattern}`);
}

// The removed function itself. Case-sensitive and lower-case `s`, so this
// does not false-positive on `windowsSystemTool(` (capital `S`), which is
// exactly what should be present instead.
check(
  !execSource.includes('systemTool('),
  'dist/doctor/exec.js still defines or calls the removed env-based systemTool() helper',
);
check(
  execSource.includes('windowsSystemTool'),
  'dist/doctor/exec.js does not reference the trusted windowsSystemTool resolver at all',
);
check(
  execSource.includes("from './internal/windows-system-tools.js'"),
  'dist/doctor/exec.js does not import the trusted resolver from ./internal/windows-system-tools.js',
);

// resolveOnPath's own body, isolated textually, must not spawn anything.
const resolveOnPathStart = execSource.indexOf('export function resolveOnPath');
check(resolveOnPathStart !== -1, 'dist/doctor/exec.js does not export resolveOnPath');
if (resolveOnPathStart !== -1) {
  const nextTopLevelBoundary = execSource.indexOf('\nfunction ', resolveOnPathStart + 1);
  const resolveOnPathBody = execSource.slice(
    resolveOnPathStart,
    nextTopLevelBoundary === -1 ? undefined : nextTopLevelBoundary,
  );
  check(
    !resolveOnPathBody.includes('execFileSync') && !resolveOnPathBody.includes('spawn('),
    'dist/doctor/exec.js resolveOnPath() body still spawns a process (where.exe/which)',
  );
  check(
    !resolveOnPathBody.toLowerCase().includes('where.exe'),
    'dist/doctor/exec.js resolveOnPath() body still references where.exe',
  );
}

// ── 6b. Dynamic evidence, against the actually-imported dist modules ───────

const execModule = await import(pathToFileURL(execDistEntry).href);
const windowsSystemToolsModule = await import(pathToFileURL(windowsSystemToolsDistEntry).href);

check(
  typeof execModule.resolveOnPath === 'function',
  'dist/doctor/exec.js does not export resolveOnPath as a function',
);
check(
  typeof windowsSystemToolsModule.windowsSystemTool === 'function',
  'dist/doctor/internal/windows-system-tools.js does not export windowsSystemTool as a function',
);
check(
  typeof windowsSystemToolsModule.createWindowsSystemToolResolverForTests === 'function',
  'dist/doctor/internal/windows-system-tools.js does not export the internal test resolver',
);
check(
  typeof windowsSystemToolsModule.WindowsSystemToolUnavailableError === 'function',
  'dist/doctor/internal/windows-system-tools.js does not export WindowsSystemToolUnavailableError',
);

// PATH resolution is unaffected by SystemRoot/windir/COMSPEC: build a
// harmless temporary directory tree, spoof all three to nonsense, and
// confirm the target program is still found via PATH alone.
const distProbeRoot = mkdtempSync(join(tmpdir(), 'ao-dist-doctor-exec-'));
try {
  const targetDir = join(distProbeRoot, 'bin');
  mkdirSync(targetDir, { recursive: true });
  const targetName = process.platform === 'win32' ? 'ao-dist-probe.exe' : 'ao-dist-probe';
  writeFileSync(join(targetDir, targetName), 'not a real executable, existence only\n', 'utf8');

  const spoofedEnv = {
    PATH: targetDir,
    PATHEXT: '.EXE',
    SystemRoot: join(distProbeRoot, 'does-not-exist-should-not-matter'),
    windir: join(distProbeRoot, 'does-not-exist-should-not-matter'),
    COMSPEC: join(distProbeRoot, 'does-not-exist-should-not-matter', 'evil.exe'),
  };
  const resolved = execModule.resolveOnPath('ao-dist-probe', spoofedEnv);
  check(
    Array.isArray(resolved) && resolved.length > 0,
    'dist/doctor/exec.js resolveOnPath() failed to find a PATH target under spoofed SystemRoot/windir/COMSPEC',
  );

  // The inverse: pointing SystemRoot/windir at a directory that *does* hold a
  // same-named `where.exe` must change nothing — it is never consulted.
  const fakeSystem32 = join(distProbeRoot, 'FakeWindows', 'System32');
  mkdirSync(fakeSystem32, { recursive: true });
  writeFileSync(join(fakeSystem32, 'where.exe'), 'not a real executable\n', 'utf8');
  const resolvedAgain = execModule.resolveOnPath('ao-dist-probe', {
    ...spoofedEnv,
    SystemRoot: join(distProbeRoot, 'FakeWindows'),
    windir: join(distProbeRoot, 'FakeWindows'),
  });
  check(
    JSON.stringify(resolvedAgain) === JSON.stringify(resolved),
    'dist/doctor/exec.js resolveOnPath() result changed when a fake where.exe was planted at a spoofed SystemRoot',
  );
} finally {
  rmSync(distProbeRoot, { recursive: true, force: true });
}

// The trusted system tools themselves: resolved on this Windows runtime, and
// stable under a full environment spoof. Individual keys are restored
// (never a wholesale `process.env = {...}` reassignment) — that corrupts
// Node's own internal environment block on Windows and breaks a
// subsequently spawned child's CSPRNG initialisation, unrelated to anything
// under test here.
if (process.platform === 'win32') {
  const cmdBefore = windowsSystemToolsModule.windowsSystemTool('cmd.exe');
  const taskkillBefore = windowsSystemToolsModule.windowsSystemTool('taskkill.exe');
  check(
    typeof cmdBefore === 'string' && cmdBefore.toLowerCase().endsWith('\\cmd.exe'),
    'dist windowsSystemTool("cmd.exe") did not resolve to a cmd.exe path',
  );
  check(
    typeof taskkillBefore === 'string' && taskkillBefore.toLowerCase().endsWith('\\taskkill.exe'),
    'dist windowsSystemTool("taskkill.exe") did not resolve to a taskkill.exe path',
  );

  const spoofedNames = ['SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'COMSPEC', 'ComSpec', 'PATH', 'PATHEXT'];
  const originalValues = new Map(spoofedNames.map((name) => [name, process.env[name]]));
  try {
    for (const name of spoofedNames) process.env[name] = 'C:\\ao-dist-spoofed-should-not-matter';
    // A fresh resolver instance over real dependencies, so this is not merely
    // reading back the already-memoised productive singleton.
    const freshResolve = windowsSystemToolsModule.createWindowsSystemToolResolverForTests({
      realpath: (await import('node:fs')).realpathSync.native,
      stat: (await import('node:fs')).statSync,
    });
    check(
      freshResolve('cmd.exe') === cmdBefore,
      'dist trusted cmd.exe path changed under a full SystemRoot/windir/COMSPEC/PATH spoof',
    );
    check(
      freshResolve('taskkill.exe') === taskkillBefore,
      'dist trusted taskkill.exe path changed under a full SystemRoot/windir/COMSPEC/PATH spoof',
    );
  } finally {
    for (const [name, value] of originalValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// ── 6c. Report schema stays v4 ──────────────────────────────────────────────
if (!existsSync(reportDistEntry)) {
  console.error('dist/doctor/report.js does not exist. Run "npm run build" before this check.');
  process.exit(1);
}
const reportModule = await import(pathToFileURL(reportDistEntry).href);
check(
  reportModule.DOCTOR_REPORT_SCHEMA_VERSION === 4,
  `dist/doctor/report.js DOCTOR_REPORT_SCHEMA_VERSION is not 4 (got ${reportModule.DOCTOR_REPORT_SCHEMA_VERSION})`,
);

// ── Result ────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`dist-doctor integration check FAILED (${failures.length} issue(s)):`);
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}

console.log(
  'dist-doctor integration check passed (run-completion.js, exec.js, internal/windows-system-tools.js, report.js).',
);
process.exit(0);
