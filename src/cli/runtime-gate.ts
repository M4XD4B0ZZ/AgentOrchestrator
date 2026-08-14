/**
 * The V2 runtime gate: the one place this build refuses to run at all.
 *
 * Split from `index.ts` so the *rendering* half can be imported by a test
 * without also importing the module that calls `main()` at load time.
 *
 * ── What this does not do ──────────────────────────────────────────────────
 *
 * It measures nothing about any filesystem, and it grants nothing. It reads two
 * process-constant facts, and it can only ever *narrow* what runs. Nothing
 * downstream may treat "the gate did not refuse" as evidence about a
 * repository, a volume or a lease — the lease proves its own capability at the
 * link that needs it, and this module is not part of that argument.
 */

import { writeSync } from 'node:fs';

import {
  evaluateRuntimeSupport,
  SUPPORTED_NODE_MAJORS,
  type RuntimeSupport,
} from '../platform/runtime-support.js';
import { EXIT_RUNTIME_UNSUPPORTED } from './run-exit-codes.js';

type RuntimeRefusal = Extract<RuntimeSupport, { supported: false }>;

/**
 * The whole refusal, as text. Pure.
 *
 * Everything an operator gets on an unsupported machine is this string, so it
 * has to answer three questions without a follow-up command: what is this
 * machine, what would be supported, and did anything happen.
 */
export function renderRuntimeRefusal(
  refusal: RuntimeRefusal,
  platform: string,
  nodeVersion: string,
): string {
  return (
    `agent-loop: unsupported runtime. Nothing was started.\n` +
    `\n` +
    `  Detected  : ${platform}, Node ${nodeVersion}\n` +
    `  Supported : Windows, Node ${SUPPORTED_NODE_MAJORS.join(' or ')}\n` +
    `  Refusal   : ${refusal.code}\n` +
    `\n` +
    `  ${refusal.detail}\n` +
    `\n` +
    `V2 of this orchestrator is built and verified for one configuration:\n` +
    `Windows, Node ${SUPPORTED_NODE_MAJORS.join(' or ')}, and a repository whose Git\n` +
    `common directory is on a local NTFS volume. FAT and exFAT, SMB and other\n` +
    `network filesystems, UNC-hosted repository storage and POSIX runtimes are\n` +
    `outside that contract, and this build refuses rather than running unverified.\n` +
    `\n` +
    `\`--help\` and \`--version\` still work here. No other command does.\n`
  );
}

/**
 * Refuse, completely, if this runtime is outside the contract.
 *
 * Returns normally when it is inside; never returns when it is not.
 *
 * **No injection seams.** A substitutable platform or version would be a seam
 * whose only power is to make this function *not* refuse, which is the one
 * direction a gate may never be moved from a test. The decision it acts on is
 * `evaluateRuntimeSupport`, which is pure and exhaustively tested; what is left
 * here is one read, one write loop and one exit, and those are measured against
 * the built artefact by `tests/dist-artifact/runtime-gate-dist-artifact.mjs`.
 */
export function enforceSupportedRuntime(): void {
  const support = evaluateRuntimeSupport(process.platform, process.version);
  if (support.supported) return;

  writeAllSync(renderRuntimeRefusal(support, process.platform, process.version));
  process.exit(EXIT_RUNTIME_UNSUPPORTED);
}

/**
 * Write every byte to fd 2 before returning.
 *
 * Not `process.stderr.write`. On Windows a stderr that is a pipe — a test
 * harness, a CI log, any `2>` redirection — is written asynchronously, and the
 * `process.exit` that follows can discard a buffered tail. "The refusal message
 * is the diagnosis" is only true if the whole message survives; a truncated one
 * is a build that refuses without saying why.
 *
 * The loop is the mechanism, not a formality: `writeSync` may report a short
 * count, and a single call is a message that is *usually* complete.
 */
function writeAllSync(text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(2, bytes, written, bytes.length - written);
    } catch (error) {
      // EAGAIN on a non-blocking pipe is the one condition worth retrying; any
      // other failure means stderr cannot be written at all, and looping on it
      // would hang the refusal instead of delivering it. Exit anyway: refusing
      // silently is bad, refusing forever is worse.
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      return;
    }
  }
}
