/** Console rendering for the doctor. Plain ASCII, no secrets, no colour deps. */

import type { DoctorCheck, DoctorReport } from './report.js';

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** Wraps long detail text so the table stays readable in a narrow terminal. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

export function renderChecksTable(checks: readonly DoctorCheck[]): string {
  const statusWidth = 6;
  const titleWidth = Math.min(
    38,
    Math.max(12, ...checks.map((c) => c.title.length)),
  );
  const detailWidth = 62;

  const sep = `+${'-'.repeat(statusWidth + 2)}+${'-'.repeat(titleWidth + 2)}+${'-'.repeat(detailWidth + 2)}+`;
  const lines: string[] = [
    sep,
    `| ${pad('STATUS', statusWidth)} | ${pad('CHECK', titleWidth)} | ${pad('DETAIL', detailWidth)} |`,
    sep,
  ];

  for (const check of checks) {
    const marker = check.mandatory ? '' : ' (optional)';
    const titleLines = wrap(check.title + marker, titleWidth);
    const detailLines = wrap(check.detail, detailWidth);
    const rows = Math.max(titleLines.length, detailLines.length);

    for (let i = 0; i < rows; i += 1) {
      lines.push(
        `| ${pad(i === 0 ? check.status : '', statusWidth)} ` +
          `| ${pad(titleLines[i] ?? '', titleWidth)} ` +
          `| ${pad(detailLines[i] ?? '', detailWidth)} |`,
      );
    }
    lines.push(sep);
  }

  return lines.join('\n');
}

export function renderReportSummary(report: DoctorReport): string {
  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const check of report.checks) counts[check.status] += 1;

  const lines: string[] = [
    '',
    renderChecksTable(report.checks),
    '',
    `Overall: ${report.overallStatus}  ` +
      `(${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL)`,
  ];

  if (report.todos.length > 0) {
    lines.push('', 'Open evidence gaps (TODO):');
    for (const todo of report.todos) {
      for (const [index, line] of wrap(todo, 92).entries()) {
        lines.push(index === 0 ? `  - ${line}` : `    ${line}`);
      }
    }
  }

  // The real, containment-checked location is named here, so the operator does
  // not have to guess where the doctor put anything (AO-007).
  lines.push('', `Diagnostic artefacts (${report.diagnosticsDirectory}):`);
  for (const file of report.diagnosticFiles) {
    lines.push(`  - ${file.path}  [${file.writeCode}]`);
    if (!file.temporaryFileRemoved) {
      lines.push('    WARNING: a temporary write file could not be removed.');
    }
  }

  if (report.overallStatus === 'FAIL') {
    lines.push(
      '',
      'The doctor failed closed. Auth checks only pass on a positively recognised',
      'Claude subscription login and Codex ChatGPT login; unknown or unparseable',
      'status output is treated as a failure by design.',
    );
  }

  lines.push('');
  return lines.join('\n');
}
