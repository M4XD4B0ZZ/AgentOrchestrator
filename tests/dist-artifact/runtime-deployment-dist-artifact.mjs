#!/usr/bin/env node
/**
 * AO-RUNTIME-ISOLATION-001, second half — the deployed runtime.
 *
 * Its sibling, `runtime-isolation-dist-artifact.mjs`, measures the negative
 * half: the ordinary build writes nothing into the directory the production
 * supervisor executes. That on its own would leave the runtime with no way to
 * ever change. This harness measures the positive half — the one explicit
 * operation that does change it — and the four properties that operation has to
 * have before it is allowed to point at production:
 *
 *   5. it produces a complete runtime, and the same bytes the gates verified;
 *   6. it records which canonical commit it deployed;
 *   7. a runtime whose provenance cannot be established refuses to run;
 *   8. a promotion that fails part-way leaves the previous runtime complete
 *      and usable, and never exposes a half-replaced one;
 *   9. a compiled runtime resolves its own launch boundary and never reaches
 *      out of its own tree for one.
 *
 * Everything below runs against real directories under the OS temp root. The
 * production runtime of this checkout is never read, written, renamed or
 * deleted by this harness.
 *
 * Contract: exit 0 means every check passed. Nonzero means at least one did not.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');

const EXIT_RUNTIME_PROVENANCE_UNKNOWN = 7;

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

/** @type {string[]} */
const scratchRoots = [];

/** A throwaway directory under the OS temp root, for anything that is not a runtime. */
function scratch(prefix) {
  const raw = mkdtempSync(join(tmpdir(), prefix));
  const root = realpathSync.native(raw);
  scratchRoots.push(root);
  return root;
}

/**
 * A throwaway directory for a runtime that has to be **executable**, which means
 * inside this checkout.
 *
 * A deployed runtime is not self-contained: `cli/index.js` imports `commander`,
 * and Node resolves that by walking up from the file to a `node_modules`. The
 * production runtime works because `<repo>/dist` sits beside `<repo>/node_modules`.
 * A runtime deployed under the OS temp root has no such parent and dies on its
 * first import, before any gate in it can be reached — which was measured here
 * first, by writing this harness the other way round and getting
 * ERR_MODULE_NOT_FOUND instead of a refusal. So every runtime this harness
 * intends to *execute* is placed under `<repo>/tmp`, which is ignored by Git.
 */
function runtimeScratch(prefix) {
  const parent = join(repoRoot, 'tmp');
  mkdirSync(parent, { recursive: true });
  const raw = mkdtempSync(join(parent, prefix));
  const root = realpathSync.native(raw);
  scratchRoots.push(root);
  return root;
}

function cleanUp() {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
}
process.on('exit', cleanUp);

/** Every file under `root`, by relative POSIX path. */
function fileSet(root) {
  /** @type {Set<string>} */
  const files = new Set();
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.add(relative(root, full).split(sep).join('/'));
    }
  };
  if (existsSync(root)) visit(root);
  return files;
}

const deploy = await import(pathToFileURL(join(repoRoot, 'scripts', 'deploy-runtime.mjs')).href);

const headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).trim();

// ── 5. Deployment produces a complete runtime, from this exact tree ─────────
//
// Both authorisations are passed on purpose, and their effect is asserted
// below rather than assumed: this harness runs wherever it is run — a branch
// under CI, a dirty working tree during development — and a deployment that
// silently accepted either would be the defect rather than the fixture. What
// the gate refuses *without* them is measured against real throwaway
// repositories further down.
//
// Which authorisation the deployment should end up recording is derived from
// Git here, not read back from the code under test, so this is a comparison
// against the real state of this checkout rather than against itself.

const sourceIsDirty =
  execFileSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' }).trim() !== '';
const canonicalCommit = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
})();
const expectedAuthorization = sourceIsDirty
  ? 'EXPLICIT_DIRTY'
  : headCommit === canonicalCommit
    ? 'CANONICAL'
    : 'EXPLICIT_NON_CANONICAL';
const expectedReason =
  expectedAuthorization === 'EXPLICIT_DIRTY'
    ? 'runtime deployment harness (dirty)'
    : expectedAuthorization === 'EXPLICIT_NON_CANONICAL'
      ? 'runtime deployment harness'
      : null;

const target = join(runtimeScratch('ao-runtime-deploy-'), 'runtime');
const result = deploy.deployRuntime({
  repoRoot,
  target,
  allowNonCanonical: 'runtime deployment harness',
  allowDirty: 'runtime deployment harness (dirty)',
});

if (result.ok !== true) {
  console.error(`runtime deployment check FAILED: the deployment was refused (${result.code}):`);
  console.error(result.message);
  process.exit(1);
}
check(existsSync(join(target, 'cli', 'index.js')), 'the deployed runtime has no cli/index.js');
check(
  existsSync(join(target, 'native', 'ao-launch.exe')),
  'the deployed runtime has no native/ao-launch.exe',
);
check(
  existsSync(join(target, deploy.PROVENANCE_FILENAME)),
  `the deployed runtime has no ${deploy.PROVENANCE_FILENAME}`,
);

// The same bytes the gates verified. `tsc` is deterministic, so a deployment
// compiled from the same commit with the same settings reproduces the build
// output exactly — and if it ever stops doing so, "verify measured these bytes"
// stops being true of the bytes production runs, which is worth failing over.
const builtCli = join(repoRoot, 'build', 'cli', 'index.js');
if (existsSync(builtCli) && existsSync(join(target, 'cli', 'index.js'))) {
  check(
    readFileSync(builtCli).equals(readFileSync(join(target, 'cli', 'index.js'))),
    'the deployed CLI differs byte for byte from the build output of the same tree',
  );
}

// A deployment carries no leftovers: it is compiled into an empty directory,
// never merged into whatever was there before. `npm run build` does not delete,
// so an in-place rebuild accumulates the outputs of sources that have since
// been removed — the live runtime of this checkout was carrying nine such files
// when this harness was written.
const deployedFiles = fileSet(target);
const buildFiles = fileSet(join(repoRoot, 'build'));
const stale = [...deployedFiles].filter(
  (path) => path !== deploy.PROVENANCE_FILENAME && !buildFiles.has(path),
);
check(
  buildFiles.size === 0 || stale.length === 0,
  `the deployed runtime carries ${stale.length} file(s) the build does not produce: ${stale
    .slice(0, 5)
    .join(', ')}`,
);

// ── 6. The deployment records the commit it deployed ────────────────────────

const provenancePath = join(target, deploy.PROVENANCE_FILENAME);
const provenance = existsSync(provenancePath)
  ? JSON.parse(readFileSync(provenancePath, 'utf8'))
  : {};

check(provenance.commit === headCommit, `provenance names ${provenance.commit}, not HEAD ${headCommit}`);
check(
  typeof provenance.runtimeRoot === 'string' &&
    realpathSync.native(provenance.runtimeRoot) === realpathSync.native(target),
  `provenance records the runtime root as ${provenance.runtimeRoot}, not ${target}`,
);
check(
  provenance.authorization === expectedAuthorization,
  `provenance records the authorization as ${provenance.authorization}, not ${expectedAuthorization}`,
);
check(
  provenance.authorizationReason === expectedReason,
  `provenance records the reason as ${String(provenance.authorizationReason)}, not ${String(expectedReason)}`,
);
check(
  provenance.sourceTreeClean === !sourceIsDirty,
  `provenance records sourceTreeClean as ${String(provenance.sourceTreeClean)}`,
);
check(provenance.channel === 'DEPLOYED', `provenance records channel ${provenance.channel}`);

// ── 7. A runtime whose provenance cannot be established refuses to run ──────

function runDeployedCli(runtimeRoot) {
  return spawnSync(
    process.execPath,
    [join(runtimeRoot, 'cli', 'index.js'), 'lease', 'status', '--repository', runtimeRoot],
    { cwd: runtimeRoot, encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
}

// Positive control first: with its provenance intact the same invocation gets
// past the gate and fails — or succeeds — for its own reasons. Without this,
// the refusal below would be indistinguishable from "this command never works".
const intact = runDeployedCli(target);
check(
  intact.status !== EXIT_RUNTIME_PROVENANCE_UNKNOWN,
  `a runtime with intact provenance was refused (exit ${String(intact.status)}): ${intact.stderr}`,
);
check(
  !/provenance/i.test(intact.stderr ?? ''),
  'a runtime with intact provenance printed a provenance refusal',
);

const parkedProvenance = readFileSync(provenancePath);
rmSync(provenancePath, { force: true });
const withoutProvenance = runDeployedCli(target);
check(
  withoutProvenance.status === EXIT_RUNTIME_PROVENANCE_UNKNOWN,
  `a runtime with no provenance exited ${String(withoutProvenance.status)}, not ` +
    `${EXIT_RUNTIME_PROVENANCE_UNKNOWN}: ${withoutProvenance.stderr}`,
);
check(
  /provenance/i.test(withoutProvenance.stderr ?? ''),
  'a runtime with no provenance did not say why it refused',
);
check(
  (withoutProvenance.stdout ?? '') === '',
  'a runtime with no provenance still produced output, so something ran',
);
writeFileSync(provenancePath, parkedProvenance);

// A runtime that was copied somewhere else carries a provenance record about a
// root it is no longer at. That is the shape a hand-copied build takes, and it
// is refused: the record has to be about the tree it is found in.
const moved = join(runtimeScratch('ao-runtime-moved-'), 'runtime');
cpSync(target, moved, { recursive: true });
const atWrongRoot = runDeployedCli(moved);
check(
  atWrongRoot.status === EXIT_RUNTIME_PROVENANCE_UNKNOWN,
  `a runtime copied away from its recorded root exited ${String(atWrongRoot.status)}, not ` +
    `${EXIT_RUNTIME_PROVENANCE_UNKNOWN}: ${atWrongRoot.stderr}`,
);

// ── 8. A promotion that fails part-way leaves the previous runtime intact ───
//
// The seam is one optional callback on the real `promoteRuntime`, invoked at
// the one instant that matters — after the previous runtime has been moved
// aside and before the new one takes its name. It is not a second code path:
// the default is a no-op and every case below, failing and succeeding alike,
// runs the same function.

function runtimeFixture(root, marker) {
  mkdirSync(join(root, 'cli'), { recursive: true });
  writeFileSync(join(root, 'cli', 'index.js'), `// ${marker}\n`, 'utf8');
  writeFileSync(join(root, deploy.PROVENANCE_FILENAME), JSON.stringify({ marker }), 'utf8');
  return root;
}

const promotionRoot = scratch('ao-runtime-promote-');
const previous = runtimeFixture(join(promotionRoot, 'runtime'), 'previous');
const incoming = runtimeFixture(join(promotionRoot, 'staging'), 'incoming');

let promotionThrew = false;
try {
  deploy.promoteRuntime({
    staging: incoming,
    target: previous,
    onBeforeTakeName: () => {
      throw new Error('interrupted');
    },
  });
} catch {
  promotionThrew = true;
}
check(promotionThrew, 'an interrupted promotion reported success');
check(
  existsSync(join(previous, 'cli', 'index.js')) &&
    readFileSync(join(previous, 'cli', 'index.js'), 'utf8').includes('previous'),
  'an interrupted promotion did not leave the previous runtime in place',
);
check(
  existsSync(join(previous, deploy.PROVENANCE_FILENAME)),
  'an interrupted promotion left the previous runtime without its provenance',
);
check(
  readdirSync(promotionRoot).filter((name) => name.startsWith('runtime.')).length === 0,
  'an interrupted promotion left the previous runtime parked under a superseded name',
);

// And the same function, with no interruption, does replace it.
const promoted = deploy.promoteRuntime({ staging: incoming, target: previous });
check(promoted.promoted === previous, 'a successful promotion reported a different target');
check(
  readFileSync(join(previous, 'cli', 'index.js'), 'utf8').includes('incoming'),
  'a successful promotion did not replace the previous runtime',
);

// A target that never existed is taken by a single rename, with nothing to
// move aside — the case a first deployment on a new machine is.
const fresh = join(scratch('ao-runtime-fresh-'), 'runtime');
const freshStaging = runtimeFixture(join(dirname(fresh), 'staging'), 'first');
deploy.promoteRuntime({ staging: freshStaging, target: fresh });
check(
  existsSync(join(fresh, 'cli', 'index.js')) &&
    readFileSync(join(fresh, 'cli', 'index.js'), 'utf8').includes('first'),
  'a first promotion onto an absent target did not produce the runtime',
);

// ── 9. A compiled runtime never reaches out of its own tree for the boundary ─
//
// A deployed runtime that had lost its own boundary must refuse, not borrow one
// from a build output — borrowing it would put unverified bytes behind the
// ownership guarantee, which is the same defect this whole slice is about.
//
// The decoy is the point. `resolveBoundaryExecutable` resolves its second
// candidate as `<tree>/../../build/native/ao-launch.exe`, so a probe placed
// anywhere else makes that path nonexistent and the check passes whatever the
// code does. (It did, when this harness was first written: the unconditional
// fallback was restored as a mutant and survived.) So the harness lays a real
// file at exactly the path the fallback would resolve to, and then requires the
// runtime not to find it.

const boundaryProbeRoot = runtimeScratch('ao-runtime-boundary-');
const boundaryProbe = join(boundaryProbeRoot, 'runtime');
cpSync(target, boundaryProbe, { recursive: true });
rmSync(join(boundaryProbe, 'native', 'ao-launch.exe'), { force: true });

const decoy = join(boundaryProbeRoot, 'build', 'native', 'ao-launch.exe');
mkdirSync(dirname(decoy), { recursive: true });
cpSync(join(target, 'native', 'ao-launch.exe'), decoy);
check(
  existsSync(decoy),
  'the decoy boundary was not laid, so the check below would prove nothing',
);
check(
  resolve(join(boundaryProbe, 'boundary'), '..', '..', 'build', 'native', 'ao-launch.exe') ===
    decoy,
  'the decoy is not at the path the out-of-tree candidate resolves to, so it is not a decoy',
);

const started = await import(
  pathToFileURL(join(boundaryProbe, 'boundary', 'start-owned-process.js')).href
);
check(
  started.resolveBoundaryExecutable().path === undefined,
  `a compiled runtime with no boundary of its own resolved one from outside its tree: ${String(
    started.resolveBoundaryExecutable().path,
  )}`,
);

// ── 10. The canonical gate, against real throwaway repositories ─────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ao-runtime-deployment',
  GIT_AUTHOR_EMAIL: 'ao-runtime-deployment@example.invalid',
  GIT_COMMITTER_NAME: 'ao-runtime-deployment',
  GIT_COMMITTER_EMAIL: 'ao-runtime-deployment@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** A repository whose `origin/main` is a real remote-tracking ref. */
function canonicalRepo() {
  const root = scratch('ao-runtime-canonical-');
  const origin = join(root, 'origin.git');
  const clone = join(root, 'clone');
  git(root, ['init', '--bare', '-b', 'main', '--quiet', origin]);
  git(root, ['clone', '--quiet', origin, clone]);
  writeFileSync(join(clone, 'README.md'), '# fixture\n', 'utf8');
  git(clone, ['add', '.']);
  git(clone, ['commit', '--quiet', '-m', 'first']);
  git(clone, ['push', '--quiet', 'origin', 'main']);
  return clone;
}

const canonical = canonicalRepo();

const onCanonical = deploy.assessDeploymentSource(canonical, {});
check(onCanonical.ok === true, `a clean canonical checkout was refused: ${onCanonical.code}`);
check(
  onCanonical.ok === true && onCanonical.authorization === 'CANONICAL',
  'a clean canonical checkout was not recorded as CANONICAL',
);

writeFileSync(join(canonical, 'README.md'), '# dirtied\n', 'utf8');
const onDirty = deploy.assessDeploymentSource(canonical, {});
check(onDirty.ok === false && onDirty.code === 'SOURCE_TREE_DIRTY', 'a dirty tree was accepted');
const onDirtyForced = deploy.assessDeploymentSource(canonical, { allowNonCanonical: 'because' });
check(
  onDirtyForced.ok === false && onDirtyForced.code === 'SOURCE_TREE_DIRTY',
  'a dirty tree was accepted once a non-canonical commit was authorised',
);
const onDirtyAuthorised = deploy.assessDeploymentSource(canonical, { allowDirty: 'measured' });
check(
  onDirtyAuthorised.ok === true &&
    onDirtyAuthorised.authorization === 'EXPLICIT_DIRTY' &&
    onDirtyAuthorised.authorizationReason === 'measured' &&
    onDirtyAuthorised.sourceTreeClean === false,
  'an explicitly authorised dirty tree was not accepted and recorded as corresponding to no commit',
);
git(canonical, ['checkout', '--quiet', '--', 'README.md']);

writeFileSync(join(canonical, 'AHEAD.md'), '# ahead\n', 'utf8');
git(canonical, ['add', '.']);
git(canonical, ['commit', '--quiet', '-m', 'ahead of origin/main']);
const onAhead = deploy.assessDeploymentSource(canonical, {});
check(
  onAhead.ok === false && onAhead.code === 'SOURCE_NOT_CANONICAL',
  `a commit ahead of origin/main was accepted: ${JSON.stringify(onAhead)}`,
);
const onAheadAuthorised = deploy.assessDeploymentSource(canonical, {
  allowNonCanonical: 'measured',
});
check(
  onAheadAuthorised.ok === true &&
    onAheadAuthorised.authorization === 'EXPLICIT_NON_CANONICAL' &&
    onAheadAuthorised.authorizationReason === 'measured',
  'an explicitly authorised non-canonical commit was not accepted and recorded as such',
);

const noRemote = scratch('ao-runtime-no-remote-');
git(noRemote, ['init', '-b', 'main', '--quiet']);
writeFileSync(join(noRemote, 'README.md'), '# fixture\n', 'utf8');
git(noRemote, ['add', '.']);
git(noRemote, ['commit', '--quiet', '-m', 'first']);
const withoutCanonicalRef = deploy.assessDeploymentSource(noRemote, {});
check(
  withoutCanonicalRef.ok === false && withoutCanonicalRef.code === 'CANONICAL_REF_UNKNOWN',
  'a repository with no origin/main was accepted as canonical',
);

// ── Result ──────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`runtime deployment check FAILED (${failures.length} issue(s)):`);
  for (const message of failures) console.error(` - ${message}`);
  process.exit(1);
}

console.log('runtime deployment check passed.');
process.exit(0);
