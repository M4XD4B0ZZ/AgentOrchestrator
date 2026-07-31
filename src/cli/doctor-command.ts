import type { Command } from 'commander';

import { renderReportSummary } from '../doctor/render.js';
import { exitCodeFor } from '../doctor/report.js';
import { runDoctor } from '../doctor/run-doctor.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description(
      'Diagnose the local environment: CLI capabilities, subscription auth, and write access. ' +
        'Read-only — it never logs in, never reads a credential store and never modifies a repository.',
    )
    .action(async () => {
      const report = await runDoctor({ cwd: process.cwd(), env: process.env });
      process.stdout.write(renderReportSummary(report));
      process.exitCode = exitCodeFor(report.overallStatus);
    });
}
