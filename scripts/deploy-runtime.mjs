#!/usr/bin/env node
/**
 * Promotes a verified canonical build into the **deployed runtime**.
 *
 * ── The two directories, and why they are two ───────────────────────────────
 *
 * `build/` is the **build output**. `npm run build` writes it, `npm run verify`
 * rebuilds it, every branch overwrites it, and nothing outside this checkout
 * executes it.
 *
 * `dist/` is the **deployed runtime**. It is what the scheduled production
 * supervisor executes (`dist/cli/index.js`), and this script is the only thing
 * that writes it.
 *
 * They used to be one directory, and that was a real defect rather than an
 * untidiness: `npm run verify` runs `npm run build`, so an ordinary
 * verification run on a feature branch replaced the bytes production was about
 * to execute. On 2026-09-14/15 a verify for PR #103 deployed that pull
 * request's parser before it was merged, and the next scheduled supervisor pass
 * ran it. The source delivery policy protected `main`; the runtime moved ahead
 * of it anyway. `tests/dist-artifact/runtime-isolation-dist-artifact.mjs` is
 * the standing measurement that the build no longer reaches the runtime, and
 * `tests/dist-artifact/runtime-deployment-dist-artifact.mjs` measures this
 * script.
 *
 * ── What "explicit" means here ──────────────────────────────────────────────
 *
 * A deployment refuses a dirty tree, and refuses a commit that is not the
 * canonical tip. Each refusal has its own authorisation, each takes a reason,
 * and the reason is written into the runtime's own provenance record where it
 * stays visible for as long as those bytes are deployed:
 * `--allow-non-canonical "<reason>"` and `--allow-dirty "<reason>"`.
 *
 * They are two flags rather than one because they authorise two different
 * claims. "This is not the canonical tip" is a statement about which commit is
 * deployed; the runtime still corresponds to *a* commit, and the record names
 * it. "The tree is dirty" is the stronger admission that the runtime
 * corresponds to no commit at all, and the record says so
 * (`sourceTreeClean: false`, `authorization: EXPLICIT_DIRTY`) rather than
 * naming a commit whose content is not what was deployed. Authorising the
 * weaker one must not quietly grant the stronger one, so it does not.
 *
 * There is no environment variable and no config file that can grant either.
 * Both live in the command line of the one operation that changes production,
 * and `npm run deploy` with no flags refuses both.
 *
 * ── Why it compiles rather than copying `build/` ────────────────────────────
 *
 * Two reasons, both measured. `tsc` does not delete, so an output directory
 * that has been rebuilt across branches accumulates the emitted files of
 * sources that no longer exist — the live runtime of this checkout was carrying
 * nine such files when this script was written. And a `build/` inherited from
 * some earlier invocation is not evidence about the commit being deployed. A
 * fresh compile into an empty staging directory answers both: the deployed tree
 * contains exactly what this commit produces, and nothing else.
 *
 * It is the *same* compile — the same `tsconfig.build.json` and the same
 * `compileNativeBoundary` — so the bytes the gates verified in `build/` and the
 * bytes promoted here are produced by one procedure from one commit. The
 * deployment harness asserts that equality rather than assuming it.
 *
 * ── Atomicity ───────────────────────────────────────────────────────────────
 *
 * The runtime is compiled into a staging directory **in full**, and only then
 * takes the name, by rename. A directory rename on NTFS is atomic with respect
 * to other processes: the supervisor sees either the previous runtime or the
 * new one, never a half-replaced tree. Replacing an existing runtime is two
 * renames — move the old one aside, then take the name — and the window between
 * them is the one moment `dist/` does not exist. That is a *fail-closed*
 * window: a supervisor entering it cannot find `dist/cli/index.js` and stops,
 * rather than executing half a runtime. If the second rename fails, the first
 * is undone and the previous runtime is back in place.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileNativeBoundary } from './build-native-boundary.mjs';
import { emitUiAssets } from './build-ui-assets.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDir, '..');

/** The provenance record, at the root of every runtime this repository produces. */
export const PROVENANCE_FILENAME = '.ao-provenance.json';

/** Bumped when the record's shape changes. A runtime refuses a version it cannot read. */
export const PROVENANCE_SCHEMA_VERSION = 1;

/** The ref a deployment is canonical *against*. */
export const DEFAULT_CANONICAL_REF = 'refs/remotes/origin/main';

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitOrNull(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/**
 * Whether this source tree may be deployed, and on whose authority.
 *
 * Pure with respect to the filesystem: it reads Git and decides. Nothing here
 * compiles, writes or promotes, which is what lets the refusals be measured
 * against small throwaway repositories instead of against a real deployment.
 *
 * The order is deliberate. A dirty tree is refused **before** canonicality is
 * even looked at, and `allowNonCanonical` does not reach it: authorising "this
 * commit is not the canonical tip" is a statement about a commit, and a dirty
 * tree has uncommitted content that no commit describes. Only `allowDirty`
 * reaches it, and what it produces is not a quieter canonical deployment — it
 * is a record that says the runtime corresponds to no commit.
 */
export function assessDeploymentSource(
  repoRoot,
  { canonicalRef = DEFAULT_CANONICAL_REF, allowNonCanonical = null, allowDirty = null } = {},
) {
  const topLevel = gitOrNull(repoRoot, ['rev-parse', '--show-toplevel']);
  if (topLevel === null) {
    return {
      ok: false,
      code: 'NOT_A_GIT_REPOSITORY',
      message: `${repoRoot} is not a Git repository, so no commit can be attributed to a deployment.`,
    };
  }

  const status = git(repoRoot, ['status', '--porcelain']);
  const dirty = status !== '';
  if (dirty && allowDirty === null) {
    return {
      ok: false,
      code: 'SOURCE_TREE_DIRTY',
      message:
        'The source tree has uncommitted changes. A deployment records the commit it came ' +
        'from, and a dirty tree has content no commit describes. To deploy it anyway, say ' +
        'so and say why: --allow-dirty "<reason>". The runtime will record that it ' +
        'corresponds to no commit.\n\n' +
        status,
    };
  }

  const commit = git(repoRoot, ['rev-parse', 'HEAD']);
  const branch = gitOrNull(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const canonicalCommit = gitOrNull(repoRoot, ['rev-parse', '--verify', '--quiet', canonicalRef]);
  const common = { commit, branch, canonicalRef, canonicalCommit, sourceTreeClean: !dirty };

  if (dirty) {
    // Canonicality is not asked about, and that is not a shortcut: a dirty tree
    // is not the content of any commit, so "which commit is this" has no true
    // answer to compare against the canonical one. The record says the tree was
    // dirty, which is the only honest thing it can say.
    return { ok: true, ...common, authorization: 'EXPLICIT_DIRTY', authorizationReason: allowDirty };
  }

  if (canonicalCommit === null && allowNonCanonical === null) {
    return {
      ok: false,
      code: 'CANONICAL_REF_UNKNOWN',
      message:
        `This repository has no ${canonicalRef}, so there is nothing to call canonical. ` +
        'Fetch it, or authorise the deployment explicitly with ' +
        '--allow-non-canonical "<reason>".',
    };
  }

  if (commit === canonicalCommit) {
    return { ok: true, ...common, authorization: 'CANONICAL', authorizationReason: null };
  }

  if (allowNonCanonical === null) {
    return {
      ok: false,
      code: 'SOURCE_NOT_CANONICAL',
      message:
        `HEAD is ${commit}, and ${canonicalRef} is ${canonicalCommit ?? '(absent)'}. ` +
        'The production runtime is deployed from the canonical tip, which is the commit ' +
        'CI has verified. To deploy this one anyway, say so and say why: ' +
        '--allow-non-canonical "<reason>".',
    };
  }

  return {
    ok: true,
    ...common,
    authorization: 'EXPLICIT_NON_CANONICAL',
    authorizationReason: allowNonCanonical,
  };
}

/** Every file under `root`, counted. */
function countFiles(root) {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(join(root, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

/**
 * Writes the provenance record at the root of a runtime tree.
 *
 * `runtimeRoot` is where the tree will *live*, which is not where it is being
 * written: a deployment stages the tree under a temporary name and the record
 * has to be about the final location. That is the whole point of the field —
 * a runtime read at a root its own record does not name has been copied there
 * by something other than a deployment, and refuses to run.
 *
 * Written last, deliberately. Everything else in the tree is already in place
 * when this file appears, so a record that exists is a record about a complete
 * tree.
 */
export function writeRuntimeProvenance({
  writeInto,
  runtimeRoot,
  channel,
  commit,
  branch = null,
  canonicalRef = null,
  canonicalCommit = null,
  authorization,
  authorizationReason = null,
  sourceTreeClean,
}) {
  const record = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    channel,
    runtimeRoot: resolve(runtimeRoot),
    commit,
    branch,
    canonicalRef,
    canonicalCommit,
    authorization,
    authorizationReason,
    sourceTreeClean,
    producedAt: new Date().toISOString(),
    node: process.version,
    fileCount: countFiles(writeInto),
  };
  writeFileSync(join(writeInto, PROVENANCE_FILENAME), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

/**
 * Puts a complete staged runtime in place of whatever is at `target`.
 *
 * `onBeforeTakeName` is a seam with exactly one caller — the deployment harness
 * — and it is a parameter of *this* function rather than a second copy of it,
 * because a rollback path that only a duplicate implementation exercises proves
 * nothing about this one. It is invoked at the single instant that matters: the
 * previous runtime has been moved aside and the new one has not yet taken the
 * name. Its default is a no-op, so every caller, failing and succeeding alike,
 * runs the same code.
 */
export function promoteRuntime({ staging, target, onBeforeTakeName = () => {} }) {
  mkdirSync(dirname(target), { recursive: true });

  if (!existsSync(target)) {
    // Nothing to displace: the runtime appears in one atomic step.
    onBeforeTakeName();
    renameSync(staging, target);
    return { promoted: target, superseded: null };
  }

  const superseded = `${target}.superseded-${process.pid}-${Date.now()}`;
  renameSync(target, superseded);
  try {
    onBeforeTakeName();
    renameSync(staging, target);
  } catch (error) {
    // The name is free and the previous runtime is intact under another one.
    // Put it back: a failed deployment must leave the operator with the runtime
    // they already had, not with none.
    renameSync(superseded, target);
    throw error;
  }

  // The previous runtime is no longer reachable by name and nothing is expected
  // to be executing out of it. A file still open — a boundary helper outliving
  // the run that started it is ordinary here — makes this fail, and that is not
  // a failed deployment: the new runtime is already in place.
  try {
    rmSync(superseded, { recursive: true, force: true });
  } catch {
    return { promoted: target, superseded };
  }
  return { promoted: target, superseded: null };
}

/**
 * Compiles this commit into a staging directory and promotes it.
 *
 * Returns the assessment's refusal unchanged when the source tree may not be
 * deployed. A compile that fails throws, because a build failure is not a
 * policy decision and there is nothing useful to return about it.
 */
export function deployRuntime({
  repoRoot = defaultRepoRoot,
  target = join(repoRoot, 'dist'),
  canonicalRef = DEFAULT_CANONICAL_REF,
  allowNonCanonical = null,
  allowDirty = null,
} = {}) {
  const assessment = assessDeploymentSource(repoRoot, {
    canonicalRef,
    allowNonCanonical,
    allowDirty,
  });
  if (assessment.ok !== true) return assessment;

  const staging = `${target}.incoming-${process.pid}-${Date.now()}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  try {
    execFileSync(
      process.execPath,
      [
        join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        join(repoRoot, 'tsconfig.build.json'),
        '--outDir',
        staging,
      ],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    compileNativeBoundary({ outFile: join(staging, 'native', 'ao-launch.exe') });
    // The UI is the second non-`tsc` artefact, and the compile above emits none
    // of it: `tsconfig.build.json` names TypeScript sources only. Without this
    // line a deployed runtime has no `dashboard/ui/` at all, `loadUiAssets`
    // refuses the whole set, and the Manager will not start on the one machine
    // where nobody is watching. Until DASHBOARD-001 slice 4 nothing would have
    // caught that, because every dist-artefact harness then ran against
    // `build/`; `test:dist-dashboard-ui` now deploys a runtime and STARTS it,
    // so removing this line fails that gate — naming every manifest file the
    // deployment did not carry — instead of shipping silently.
    emitUiAssets({ outDir: join(staging, 'dashboard', 'ui') });

    const provenance = writeRuntimeProvenance({
      writeInto: staging,
      runtimeRoot: target,
      channel: 'DEPLOYED',
      commit: assessment.commit,
      branch: assessment.branch,
      canonicalRef: assessment.canonicalRef,
      canonicalCommit: assessment.canonicalCommit,
      authorization: assessment.authorization,
      authorizationReason: assessment.authorizationReason,
      sourceTreeClean: assessment.sourceTreeClean,
    });

    const promotion = promoteRuntime({ staging, target });
    return { ...assessment, target, provenance, superseded: promotion.superseded };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

// ── Command line ────────────────────────────────────────────────────────────

/** Parses argv. Unknown flags are refused rather than ignored. */
export function parseDeployArguments(argv) {
  const options = {
    target: null,
    canonicalRef: DEFAULT_CANONICAL_REF,
    allowNonCanonical: null,
    allowDirty: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--target') {
      if (value === undefined) return { ok: false, message: '--target needs a directory.' };
      options.target = value;
      index += 1;
    } else if (argument === '--canonical-ref') {
      if (value === undefined) return { ok: false, message: '--canonical-ref needs a ref.' };
      options.canonicalRef = value;
      index += 1;
    } else if (argument === '--allow-non-canonical') {
      if (value === undefined || value.startsWith('--')) {
        return {
          ok: false,
          message: '--allow-non-canonical needs a reason, which is recorded in the runtime.',
        };
      }
      options.allowNonCanonical = value;
      index += 1;
    } else if (argument === '--allow-dirty') {
      if (value === undefined || value.startsWith('--')) {
        return {
          ok: false,
          message: '--allow-dirty needs a reason, which is recorded in the runtime.',
        };
      }
      options.allowDirty = value;
      index += 1;
    } else {
      return { ok: false, message: `Unknown argument: ${argument}` };
    }
  }
  return { ok: true, options };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const parsed = parseDeployArguments(process.argv.slice(2));
  if (parsed.ok !== true) {
    console.error(`agent-loop deploy: ${parsed.message}`);
    console.error(
      'Usage: npm run deploy [-- --target <dir>] [--canonical-ref <ref>] ' +
        '[--allow-non-canonical "<reason>"] [--allow-dirty "<reason>"]',
    );
    process.exit(2);
  }

  const target = parsed.options.target ?? join(defaultRepoRoot, 'dist');
  let outcome;
  try {
    outcome = deployRuntime({
      repoRoot: defaultRepoRoot,
      target,
      canonicalRef: parsed.options.canonicalRef,
      allowNonCanonical: parsed.options.allowNonCanonical,
      allowDirty: parsed.options.allowDirty,
    });
  } catch (error) {
    console.error('agent-loop deploy: the runtime was not built, and nothing was replaced.');
    console.error(String(error?.stdout ?? '') + String(error?.stderr ?? '') || String(error));
    process.exit(1);
  }

  if (outcome.ok !== true) {
    console.error(`agent-loop deploy: refused (${outcome.code}). Nothing was replaced.\n`);
    console.error(outcome.message);
    process.exit(3);
  }

  const runtimeRoot = existsSync(target) ? realpathSync.native(target) : target;
  console.log(`agent-loop deploy: runtime deployed.`);
  console.log(`  runtime       : ${runtimeRoot}`);
  console.log(`  commit        : ${outcome.commit} (${outcome.branch ?? 'detached'})`);
  console.log(`  canonical ref : ${outcome.canonicalRef} = ${outcome.canonicalCommit ?? '(absent)'}`);
  console.log(`  authorization : ${outcome.authorization}`);
  if (outcome.authorizationReason !== null) {
    console.log(`  reason        : ${outcome.authorizationReason}`);
  }
  console.log(`  files         : ${outcome.provenance.fileCount}`);
  if (outcome.superseded !== null) {
    console.log(`  note          : the previous runtime is still on disk at ${outcome.superseded}`);
    console.log(`                  because a file in it was in use. It is safe to delete.`);
  }
  process.exit(0);
}
