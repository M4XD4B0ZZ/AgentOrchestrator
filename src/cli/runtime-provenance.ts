/**
 * The provenance gate: this build refuses to run out of a tree that cannot say
 * where it came from.
 *
 * ── What it is for ─────────────────────────────────────────────────────────
 *
 * The scheduled production supervisor executes a **deployed runtime**, and one
 * operation produces one — `scripts/deploy-runtime.mjs`, from a clean commit,
 * recording that commit in `.ao-provenance.json` at the runtime's root. This
 * module is the other end of that: before any command begins, the runtime reads
 * its own record and refuses if there is not one it can believe.
 *
 * It exists because the failure it closes actually happened. `npm run verify`
 * used to rebuild the production runtime in place, so the bytes production
 * executed could move ahead of `main` with nothing recording that they had.
 * Splitting the build output from the deployed runtime stops new bytes arriving
 * that way; this stops *old* bytes — the residue of that build, or any hand
 * copy — from going on being executed as though someone had deployed them.
 *
 * ── What it does not do ────────────────────────────────────────────────────
 *
 * It does not verify the tree against the commit. Nothing in a deployed runtime
 * can: there is no repository beside it and no signature over its files. What
 * it proves is narrower and worth stating exactly — that this tree was put here
 * by a deployment, at this root, and which commit that deployment named. A tree
 * whose files were edited afterwards passes, and no claim here says otherwise.
 *
 * It grants nothing, measures no repository, and can only ever narrow what
 * runs.
 */

import { existsSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EXIT_RUNTIME_PROVENANCE_UNKNOWN } from './run-exit-codes.js';

/** The record's filename, at the root of the runtime tree. */
export const RUNTIME_PROVENANCE_FILENAME = '.ao-provenance.json';

/** The only record shape this build can read. */
export const RUNTIME_PROVENANCE_SCHEMA_VERSION = 1;

/** Which producer wrote the record. */
export type RuntimeChannel = 'BUILD' | 'DEPLOYED';

export interface RuntimeProvenance {
  readonly schemaVersion: number;
  readonly channel: RuntimeChannel;
  readonly runtimeRoot: string;
  readonly commit: string;
  readonly authorization: string;
}

export type RuntimeProvenanceRefusal =
  | { readonly code: 'PROVENANCE_ABSENT'; readonly detail: string }
  | { readonly code: 'PROVENANCE_UNREADABLE'; readonly detail: string }
  | { readonly code: 'PROVENANCE_ROOT_MISMATCH'; readonly detail: string };

export type RuntimeProvenanceReading =
  | { readonly established: true; readonly provenance: RuntimeProvenance }
  | { readonly established: false; readonly refusal: RuntimeProvenanceRefusal };

/**
 * One spelling for one directory.
 *
 * Two absolute paths can name the same directory and not compare equal: a
 * `8.3` short name, a substituted drive, a differently cased volume. The record
 * is written before its tree exists at the final root, so the comparison has to
 * survive that — resolve both sides through the filesystem where it can, and
 * fold case on Windows, where the filesystem does.
 */
function sameDirectory(a: string, b: string): boolean {
  const normalise = (path: string): string => {
    const absolute = resolve(path);
    const real = existsSync(absolute) ? realpathSync.native(absolute) : absolute;
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return normalise(a) === normalise(b);
}

/**
 * Reads the record at the root of a runtime tree and decides whether it
 * establishes that tree's provenance.
 *
 * Pure apart from two reads, and exported separately from the enforcement so
 * every refusal can be measured without a process that exits.
 */
export function readRuntimeProvenance(runtimeRoot: string): RuntimeProvenanceReading {
  const recordPath = join(runtimeRoot, RUNTIME_PROVENANCE_FILENAME);
  if (!existsSync(recordPath)) {
    return {
      established: false,
      refusal: { code: 'PROVENANCE_ABSENT', detail: `There is no ${recordPath}.` },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch {
    return {
      established: false,
      refusal: { code: 'PROVENANCE_UNREADABLE', detail: `${recordPath} is not readable JSON.` },
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      established: false,
      refusal: { code: 'PROVENANCE_UNREADABLE', detail: `${recordPath} is not a record.` },
    };
  }

  const record = parsed as Record<string, unknown>;
  if (record['schemaVersion'] !== RUNTIME_PROVENANCE_SCHEMA_VERSION) {
    return {
      established: false,
      refusal: {
        code: 'PROVENANCE_UNREADABLE',
        detail:
          `${recordPath} is schema version ${String(record['schemaVersion'])}; this build ` +
          `reads version ${RUNTIME_PROVENANCE_SCHEMA_VERSION}.`,
      },
    };
  }

  const channel = record['channel'];
  if (channel !== 'BUILD' && channel !== 'DEPLOYED') {
    return {
      established: false,
      refusal: {
        code: 'PROVENANCE_UNREADABLE',
        detail: `${recordPath} names an unknown channel: ${String(channel)}.`,
      },
    };
  }

  const recordedRoot = record['runtimeRoot'];
  const commit = record['commit'];
  const authorization = record['authorization'];
  if (
    typeof recordedRoot !== 'string' ||
    typeof commit !== 'string' ||
    typeof authorization !== 'string'
  ) {
    return {
      established: false,
      refusal: {
        code: 'PROVENANCE_UNREADABLE',
        detail: `${recordPath} is missing runtimeRoot, commit or authorization.`,
      },
    };
  }

  if (!sameDirectory(recordedRoot, runtimeRoot)) {
    return {
      established: false,
      refusal: {
        code: 'PROVENANCE_ROOT_MISMATCH',
        detail:
          `${recordPath} is a record about ${recordedRoot}, and it was read at ${runtimeRoot}. ` +
          'A runtime that was copied rather than deployed carries exactly this shape.',
      },
    };
  }

  return {
    established: true,
    provenance: { schemaVersion: RUNTIME_PROVENANCE_SCHEMA_VERSION, channel, runtimeRoot: recordedRoot, commit, authorization },
  };
}

/** The whole refusal, as text. Pure. */
export function renderProvenanceRefusal(
  refusal: RuntimeProvenanceRefusal,
  runtimeRoot: string,
): string {
  return (
    `agent-loop: this runtime's provenance could not be established. Nothing was started.\n` +
    `\n` +
    `  Runtime : ${runtimeRoot}\n` +
    `  Refusal : ${refusal.code}\n` +
    `\n` +
    `  ${refusal.detail}\n` +
    `\n` +
    `A runtime this build will execute is produced by one operation — \`npm run deploy\` —\n` +
    `which compiles a clean, canonical commit into a staging directory, records that\n` +
    `commit in ${RUNTIME_PROVENANCE_FILENAME} at the runtime's root, and takes the name by\n` +
    `rename. A tree with no such record was not deployed: it was copied, or it is the\n` +
    `residue of a build that used to write the production runtime in place.\n` +
    `\n` +
    `Deploy it rather than repairing the record by hand:\n` +
    `\n` +
    `    npm run deploy\n` +
    `\n` +
    `\`--help\` and \`--version\` still work here. No other command does.\n`
  );
}

/**
 * True when this module is the TypeScript source rather than a compiled tree.
 *
 * A source tree is not a runtime and has no provenance to establish — there is
 * no deployment that produced it and no record that could be about it — so the
 * gate does not apply there. The discriminator is the module's own file
 * extension, because that is the thing that actually differs: `tsc` emits
 * `.js`, and every tree this gate is about is reached as `.js`.
 *
 * It is also the reason this gate is measured against a compiled runtime by
 * `tests/dist-artifact/runtime-deployment-dist-artifact.mjs` rather than from
 * inside a vitest worker: in a worker it is, correctly, inert.
 */
const RUNNING_FROM_SOURCE = fileURLToPath(import.meta.url).endsWith('.ts');

/** Where this module's own tree begins: `<root>/cli/runtime-provenance.js` → `<root>`. */
function ownRuntimeRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

/**
 * Refuse, completely, if this runtime's provenance cannot be established.
 *
 * Returns normally when it can; never returns when it cannot.
 *
 * **No injection seams.** A substitutable root or record would be a seam whose
 * only power is to make this function *not* refuse, which is the one direction
 * a gate may never be moved from a test. The decision it acts on is
 * {@link readRuntimeProvenance}, which is pure and separately tested.
 */
export function enforceRuntimeProvenance(): void {
  if (RUNNING_FROM_SOURCE) return;

  const runtimeRoot = ownRuntimeRoot();
  const reading = readRuntimeProvenance(runtimeRoot);
  if (reading.established) return;

  writeAllSync(renderProvenanceRefusal(reading.refusal, runtimeRoot));
  process.exit(EXIT_RUNTIME_PROVENANCE_UNKNOWN);
}

/**
 * Write every byte to fd 2 before returning.
 *
 * The same mechanism, and for the same measured reason, as the runtime gate's:
 * on Windows a stderr that is a pipe is written asynchronously, and the
 * `process.exit` that follows can discard a buffered tail. A truncated refusal
 * is a build that refuses without saying why.
 */
function writeAllSync(text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(2, bytes, written, bytes.length - written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      return;
    }
  }
}
