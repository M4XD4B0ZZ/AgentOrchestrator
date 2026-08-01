#!/usr/bin/env node
/**
 * AO-FOUNDATION-REM-002C4 (closes AO-FOUNDATION-REM-002C3-REREVIEW-01).
 *
 * Standalone Node script — deliberately not a vitest test file, and
 * deliberately plain JavaScript rather than TypeScript. It is spawned as its
 * own child process by `tests/run-completion-dist.test.ts` (and directly by
 * the `verify:dist-doctor` npm script), and it imports exactly one module:
 *
 *     dist/doctor/run-completion.js
 *
 * via an explicit, absolute `file://` URL computed from this script's own
 * location. There is no TypeScript compilation, no vitest module resolution,
 * and no `tsconfig`/`nodenext` path mapping involved in reaching that file,
 * so nothing here can be silently redirected back to `src/doctor/run-completion.ts`.
 *
 * Contract: exit code 0 means every check below passed. Any nonzero exit code
 * means at least one did not. Parsing stdout/stderr is never required to know
 * which — the exit code alone is the contract.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

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

const { completeRun, inspectRun, requiredArtefactFileNames } = distModule;

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
function freshRunId() {
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `${stamp.slice(0, 8)}T${stamp.slice(9, 18)}Z-${randomUUID()}`;
}

function makeRun(runsRoot, fileNames) {
  const runId = freshRunId();
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
  const oneArtefactRunId = makeRun(runsRoot, ['cli-capabilities.txt']);

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

  // Control case: a separate, fully valid run with both required artefacts.
  const fullRunId = makeRun(runsRoot, ['cli-capabilities.txt', 'doctor-report.json']);

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

// ── Result ────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`dist/doctor/run-completion.js integration check FAILED (${failures.length} issue(s)):`);
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}

console.log('dist/doctor/run-completion.js integration check passed.');
process.exit(0);
