/**
 * Test helper, executed as its own process by `trusted-profile.test.ts`.
 *
 * It calls the *productive* trusted-profile resolver — not an injected one —
 * and prints the answer as a single delimited line. The test runs this with the
 * profile-relevant environment variables set to non-existent decoys and
 * requires the answer to be byte-identical to the baseline.
 *
 * The delimiter matters: anything else that reaches stdout (a preload, a
 * warning) stays out of the assertion, while an injected path would still be
 * caught, because the assertion is about the path itself.
 */

import { trustedProfileDirectory } from '../../src/config/internal/trusted-profile.js';
import { formatSafeError } from '../../src/core/safe-error.js';

const PREFIX = 'TRUSTED-PROFILE ';

try {
  process.stdout.write(`${PREFIX}${JSON.stringify({ profile: trustedProfileDirectory() })}\n`);
} catch (error: unknown) {
  // Fail closed and visibly, without echoing anything untrusted.
  process.stdout.write(`${PREFIX}${JSON.stringify({ error: formatSafeError(error) })}\n`);
  process.exitCode = 1;
}
