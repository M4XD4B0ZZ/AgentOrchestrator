import type { Command } from 'commander';

import { formatSafeError } from '../core/safe-error.js';
import { renderReportSummary } from '../doctor/render.js';
import { exitCodeFor, EXIT_DIAGNOSTIC_FAILURE } from '../doctor/report.js';
import { runDoctor } from '../doctor/run-doctor.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Diagnose the local environment: CLI capabilities, subscription auth, and write access. ' +
        'Read-only — it never logs in, never reads a credential store and never modifies a repository. ' +
        'Artefacts are written under the per-user orchestrator home, never into the current directory.',
    )
    .action(async () => {
      try {
        const report = await runDoctor({ env: process.env });
        process.stdout.write(renderReportSummary(report));
        process.exitCode = exitCodeFor(report.overallStatus);
      } catch (error: unknown) {
        // An unexpected failure inside the doctor must not print an exception
        // message: those routinely quote CLI output and filesystem paths
        // (AO-002). Fail closed with the diagnostic-failure exit code.
        process.stderr.write(`agent-loop doctor: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_DIAGNOSTIC_FAILURE;
      }
    });
}
