/**
 * Test helper, executed as its own process by `paths.test.ts`.
 *
 * It resolves the *productive* diagnostics root — the OS path provider, not an
 * injected one — and prints it as a single delimited line. The test runs this
 * repeatedly with one home/loader variable manipulated at a time and requires
 * the answer to be identical every time.
 *
 * The delimiter matters: if a manipulated `NODE_OPTIONS` were honoured by a
 * preload, its output would land on stdout too. Parsing only the delimited line
 * keeps that noise out of the assertion, and the assertion itself is about the
 * path, so an injected path would still be caught.
 */

import { doctorRunsRoot, orchestratorHome } from '../../src/config/paths.js';
import { formatSafeError } from '../../src/core/safe-error.js';

const PREFIX = 'DIAGNOSTICS-ROOT ';

try {
  process.stdout.write(
    `${PREFIX}${JSON.stringify({
      home: orchestratorHome(),
      runsRoot: doctorRunsRoot(),
    })}\n`,
  );
} catch (error: unknown) {
  // Fail closed and visibly, without echoing anything untrusted.
  process.stdout.write(`${PREFIX}${JSON.stringify({ error: formatSafeError(error) })}\n`);
  process.exitCode = 1;
}
