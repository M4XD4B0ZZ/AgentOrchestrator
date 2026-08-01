/**
 * `agent-loop doctor` — read-only local diagnosis.
 *
 * What it does: starts read-only diagnostic child processes, writes artefacts
 * into the per-user application-data root, and performs reversible write
 * probes.
 *
 * What it never does: run agent tasks, modify any repository, modify global
 * environment variables, perform a login, read a credential store, change any
 * configuration, or write anything relative to the current working directory.
 *
 * Report safety (AO-002): nothing in the produced report is copied from CLI
 * stdout, CLI stderr or an exception message. Checks carry fixed vocabulary
 * plus numbers; auth carries typed allow-list evidence; versions carry an
 * extracted dotted number; write failures carry errno identifiers.
 */

import { join } from 'node:path';

import { runAuthPreflight } from '../auth/auth-preflight.js';
import { assessEnvironment, createSanitizedChildEnv } from '../auth/env-guard.js';
import { doctorDiagnosticsDir, orchestratorHome, worktreesRoot } from '../config/paths.js';
import {
  extractVersion,
  findRecord,
  renderCapabilityDump,
  runCapabilityDump,
  type CapabilityRecord,
} from './capabilities.js';
import { probeWriteAccess, type WriteAccessResult } from './write-access.js';
import { writeDiagnosticFile, type DiagnosticWriteResult } from './safe-write.js';
import {
  CAPABILITY_DUMP_KIND,
  computeOverallStatus,
  DOCTOR_REPORT_KIND,
  DOCTOR_REPORT_SCHEMA_VERSION,
  type CliVersionInfo,
  type DiagnosticArtefact,
  type DoctorCheck,
  type DoctorReport,
} from './report.js';

/** Node version the orchestrator requires. */
export const MINIMUM_NODE_MAJOR = 22;

export const DOCTOR_REPORT_FILE_NAME = 'doctor-report.json';
export const CAPABILITY_DUMP_FILE_NAME = 'cli-capabilities.txt';

export interface RunDoctorOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly commandTimeoutMs?: number;
}

function parseNodeMajor(versionText: string): number | null {
  const match = /^v?(\d+)\./.exec(versionText.trim());
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}

function versionFrom(records: readonly CapabilityRecord[], id: string): CliVersionInfo | null {
  const record = findRecord(records, id);
  if (record === undefined) return null;
  const name = record.probe.command;
  if (record.availability === 'EXECUTABLE_NOT_FOUND') {
    return { name, found: false, version: null };
  }
  return {
    name,
    found: true,
    version: extractVersion(record.result.stdout) ?? extractVersion(record.result.stderr),
  };
}

/** Turns a write outcome into a check plus a report entry. */
function artefactOf(path: string, write: DiagnosticWriteResult): DiagnosticArtefact {
  return {
    path,
    writeCode: write.code,
    written: write.written,
    temporaryFileRemoved: write.temporaryFileRemoved,
  };
}

function artefactCheck(id: string, title: string, write: DiagnosticWriteResult): DoctorCheck {
  const cleanupFailed = !write.temporaryFileRemoved;
  return {
    id,
    title,
    status: write.written && !cleanupFailed ? 'PASS' : 'FAIL',
    mandatory: true,
    detail:
      `${write.code} at ${write.path}` +
      (write.errnoCode === null ? '' : ` (errno ${write.errnoCode})`) +
      (cleanupFailed ? '; the temporary write file could not be removed.' : '.'),
  };
}

export async function runDoctor(options: RunDoctorOptions): Promise<DoctorReport> {
  const startedAt = new Date().toISOString();
  const checks: DoctorCheck[] = [];
  const todos: string[] = [];

  // --- 0. Diagnostics directory -------------------------------------------
  // Always the per-user application-data root, never process.cwd() (AO-007).
  const diagDir = doctorDiagnosticsDir(options.env);

  // --- A. Environment guard ------------------------------------------------
  // The child environment is derived once and reused for every probe, so no
  // diagnostic process can ever see an API key. The parent environment and the
  // machine's global environment are left untouched.
  const childEnv = createSanitizedChildEnv(options.env);
  const environmentAssessment = assessEnvironment(options.env);

  if (environmentAssessment.warnedCredentialVars.length > 0) {
    checks.push({
      id: 'env:credential-vars',
      title: 'API-key environment variables',
      status: 'WARN',
      // Not execution-relevant: these four are stripped from every child
      // environment by createSanitizedChildEnv, which is unit-tested. They are
      // reported so the operator knows metered credentials exist here.
      mandatory: false,
      detail:
        `SET in the parent environment: ${environmentAssessment.warnedCredentialVars.join(', ')}. ` +
        'Removed from every child environment, so agents cannot reach them. Values are never read or logged.',
    });
  } else {
    checks.push({
      id: 'env:credential-vars',
      title: 'API-key environment variables',
      status: 'PASS',
      mandatory: false,
      detail:
        'None of the four API-key variables are set. Child environments are sanitised regardless.',
    });
  }

  if (environmentAssessment.blockingProviderFlags.length > 0) {
    checks.push({
      id: 'env:provider-flags',
      title: 'Provider / gateway overrides',
      status: 'FAIL',
      mandatory: true,
      detail:
        `SET: ${environmentAssessment.blockingProviderFlags.join(', ')}. ` +
        'These route an agent to a third-party provider or a custom gateway whose subscription ' +
        'status cannot be proven from here. Failing closed.',
    });
  } else {
    checks.push({
      id: 'env:provider-flags',
      title: 'Provider / gateway overrides',
      status: 'PASS',
      mandatory: true,
      detail: 'No Bedrock/Vertex/Foundry switch and no custom base URL is configured.',
    });
  }

  checks.push({
    id: 'env:oauth-token-preserved',
    title: 'CLAUDE_CODE_OAUTH_TOKEN handling',
    status: 'PASS',
    mandatory: false,
    detail:
      `Presence: ${environmentAssessment.preservedAuthVars[0]?.presence ?? 'NOT_SET'}. ` +
      'This variable is deliberately preserved in child environments: it is a subscription OAuth path, not an API key.',
  });

  // --- B. CLI capability dump ---------------------------------------------
  const capabilityOptions = {
    env: childEnv,
    ...(options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs }),
  };
  const capabilities = await runCapabilityDump(capabilityOptions);

  const capabilityWrite = writeDiagnosticFile({
    root: diagDir,
    fileName: CAPABILITY_DUMP_FILE_NAME,
    contents: renderCapabilityDump(capabilities, startedAt),
    ownershipMarker: CAPABILITY_DUMP_KIND,
  });
  checks.push(
    artefactCheck('diagnostics:capability-dump', 'Capability dump written safely', capabilityWrite),
  );

  for (const record of capabilities) {
    const available = record.availability === 'AVAILABLE';
    const status: DoctorCheck['status'] = available
      ? 'PASS'
      : record.probe.required
        ? 'FAIL'
        : 'WARN';
    checks.push({
      id: `cli:${record.probe.id}`,
      title: `${record.probe.command} ${record.probe.args.join(' ')}`,
      status,
      mandatory: record.probe.required,
      detail:
        `${record.availability}; outcome=${record.result.outcome}, ` +
        `exit=${record.result.exitCode === null ? 'none' : record.result.exitCode}, ` +
        `failure=${record.result.failureCode ?? 'none'}, ` +
        `${record.result.durationMs} ms.`,
    });
  }

  // --- D. Local environment ------------------------------------------------
  const cliVersions: CliVersionInfo[] = [];
  for (const id of [
    'node.version',
    'npm.version',
    'git.version',
    'claude.version',
    'codex.version',
  ]) {
    const info = versionFrom(capabilities, id);
    if (info !== null) cliVersions.push(info);
  }

  const nodeRecord = findRecord(capabilities, 'node.version');
  const nodeMajor =
    nodeRecord === undefined ? null : parseNodeMajor(nodeRecord.result.stdout || process.version);
  checks.push({
    id: 'env:node-version',
    title: 'Node.js >= 22',
    status: nodeMajor !== null && nodeMajor >= MINIMUM_NODE_MAJOR ? 'PASS' : 'FAIL',
    mandatory: true,
    detail:
      nodeMajor === null
        ? 'Node version could not be determined.'
        : `Detected major version ${nodeMajor}; minimum is ${MINIMUM_NODE_MAJOR}.`,
  });

  // Write probes. Reversible: each creates one uniquely named file and deletes
  // it immediately. Nothing sensitive is written.
  const writeAccessAssessment: WriteAccessResult[] = [
    probeWriteAccess({ label: 'diagnostics directory', path: diagDir, createIfMissing: true }),
    probeWriteAccess({
      label: 'orchestrator home',
      path: orchestratorHome(options.env),
      createIfMissing: false,
    }),
    probeWriteAccess({
      label: 'worktrees root',
      path: worktreesRoot(options.env),
      createIfMissing: false,
    }),
  ];

  for (const probe of writeAccessAssessment) {
    // A missing directory is a setup gap, not a permission problem: the doctor
    // does not create directories it does not own. NOT_WRITABLE is a real
    // failure, because the orchestrator could not function.
    const status: DoctorCheck['status'] =
      probe.status === 'WRITABLE' ? 'PASS' : probe.status === 'DIRECTORY_MISSING' ? 'WARN' : 'FAIL';
    checks.push({
      id: `write:${probe.label.replace(/\s+/g, '-')}`,
      title: `Write access: ${probe.label}`,
      status,
      // Not mandatory-to-PASS: a missing directory is a WARN that the setup
      // step will resolve. NOT_WRITABLE still yields FAIL, which fails the run.
      mandatory: false,
      detail:
        `${probe.path} — ${probe.reason}` +
        (probe.errnoCode === null ? '' : ` (errno ${probe.errnoCode})`),
    });
    if (probe.status === 'WRITABLE' && !probe.probeFileRemoved) {
      checks.push({
        id: `write:${probe.label.replace(/\s+/g, '-')}:cleanup`,
        title: `Probe cleanup: ${probe.label}`,
        status: 'FAIL',
        mandatory: true,
        detail: 'The temporary write-probe file could not be removed.',
      });
    }
  }

  // --- C. Auth preflight ---------------------------------------------------
  const authAssessment = await runAuthPreflight(capabilities, options.env, options.commandTimeoutMs);

  for (const check of authAssessment.checks) {
    checks.push({
      id: `auth:${check.agent}`,
      title: `${check.agent} subscription login`,
      status: check.passed ? 'PASS' : 'FAIL',
      mandatory: true,
      // Both parts are fixed vocabulary: a status code and a static sentence.
      detail: `${check.status} [${check.reasonCode}] — ${check.reason}`,
    });

    if (check.status === 'UNVERIFIABLE' || check.status === 'STATUS_COMMAND_UNAVAILABLE') {
      todos.push(
        `auth/${check.agent}: the installed CLI did not yield output that reliably distinguishes a ` +
          `subscription login from API-key auth (${check.status}/${check.reasonCode}). Additional ` +
          `official or local evidence is needed before this check can pass.`,
      );
    }
  }

  // Standing evidence gaps, independent of this run's outcome.
  todos.push(
    'auth/claude: only the positive case (authMethod="claude.ai", apiProvider="firstParty") has been ' +
      'observed locally. No sample of `--console`/API-key status output was captured, and none was ' +
      'fabricated. The allow-list fails closed, so the negative case is safe but unverified.',
  );
  const codexStatusHelp = findRecord(capabilities, 'codex.login.status.help');
  if (codexStatusHelp !== undefined && !/--json|--format/.test(codexStatusHelp.result.stdout)) {
    todos.push(
      'auth/codex: `codex login status` offers no machine-readable output format in the installed ' +
        'version, so the check requires its output to be exactly the one observed English line. ' +
        'A localised or reworded build fails closed. Re-evaluate when a JSON output mode ships.',
    );
  }

  // --- Assemble ------------------------------------------------------------
  const finishedAt = new Date().toISOString();

  const capabilityArtefact = artefactOf(capabilityWrite.path, capabilityWrite);

  // The report references itself. The persisted copy records its own path with
  // `written: true` because a reader can only ever see that file if the atomic
  // rename succeeded; the *returned* report carries the real write outcome.
  const reportPath = join(diagDir, DOCTOR_REPORT_FILE_NAME);

  const preliminaryChecks = [...checks];
  const report: DoctorReport = {
    reportKind: DOCTOR_REPORT_KIND,
    schemaVersion: DOCTOR_REPORT_SCHEMA_VERSION,
    startedAt,
    finishedAt,
    overallStatus: computeOverallStatus(preliminaryChecks),
    checks: preliminaryChecks,
    cliVersions,
    authAssessment,
    environmentAssessment,
    writeAccessAssessment,
    diagnosticsDirectory: diagDir,
    diagnosticFiles: [
      capabilityArtefact,
      { path: reportPath, writeCode: 'WRITTEN', written: true, temporaryFileRemoved: true },
    ],
    todos,
  };

  const reportWrite = writeDiagnosticFile({
    root: diagDir,
    fileName: DOCTOR_REPORT_FILE_NAME,
    contents: `${JSON.stringify(report, null, 2)}\n`,
    ownershipMarker: DOCTOR_REPORT_KIND,
  });

  // If persisting the report failed, say so in the returned report (which the
  // console renders) rather than pretending it was written.
  if (!reportWrite.written || !reportWrite.temporaryFileRemoved) {
    const withFailure: DoctorCheck[] = [
      ...preliminaryChecks,
      artefactCheck('diagnostics:doctor-report', 'Doctor report written safely', reportWrite),
    ];
    return {
      ...report,
      checks: withFailure,
      overallStatus: computeOverallStatus(withFailure),
      diagnosticFiles: [capabilityArtefact, artefactOf(reportWrite.path, reportWrite)],
    };
  }

  return {
    ...report,
    diagnosticFiles: [capabilityArtefact, artefactOf(reportWrite.path, reportWrite)],
  };
}
