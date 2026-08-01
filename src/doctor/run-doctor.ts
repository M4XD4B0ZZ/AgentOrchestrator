/**
 * `agent-loop doctor` — read-only local diagnosis.
 *
 * What it does: starts read-only diagnostic child processes, writes artefacts
 * into a freshly created per-run directory under the per-user application-data
 * root, and performs reversible write probes.
 *
 * What it never does: run agent tasks, modify any repository, modify global
 * environment variables, perform a login, read a credential store, change any
 * configuration, overwrite an existing file, or write anything relative to the
 * current working directory.
 *
 * Report safety (AO-002): nothing in the produced report is copied from CLI
 * stdout, CLI stderr or an exception message. Checks carry fixed vocabulary
 * plus numbers; auth carries typed allow-list evidence; capability probes carry
 * allow-listed tokens only; write failures carry errno identifiers.
 *
 * Storage safety (AO-007): the write root is fixed to the OS user profile and
 * cannot be redirected, and each run writes into its own directory, which it
 * creates exclusively and never reuses.
 *
 * Run protocol (AO-007-R2-RR2): the run is append-only. Each artefact is
 * created once, directly under its final name, through an exclusive handle —
 * no temporary file, no rename, no hard link. When, and only when, every
 * artefact is complete, the `COMPLETED` marker is written last. The doctor
 * exits 0 only if that marker was created; a run without it is incomplete by
 * definition and no consumer may read it.
 */

import { join } from 'node:path';

import { runAuthPreflight } from '../auth/auth-preflight.js';
import { assessEnvironment, createSanitizedChildEnv } from '../auth/env-guard.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import {
  doctorDiagnosticsDir,
  doctorRunsRoot,
  homeOverrideWarningCode,
  orchestratorHome,
  UNSUPPORTED_HOME_OVERRIDE_VAR,
} from '../config/paths.js';
import {
  deriveCapabilityAnswers,
  findRecord,
  renderCapabilitySummary,
  runCapabilityDump,
  type CapabilityAnswers,
  type CapabilityRecord,
} from './capabilities.js';
import {
  completeRun,
  COMPLETION_MARKER_FILE_NAME,
  RUN_PROTOCOL_VERSION,
  type RunCompletionResult,
} from './run-completion.js';
import { createRunDirectory, newRunId } from './run-directory.js';
import { probeWriteAccess, type WriteAccessResult } from './write-access.js';
import { writeRunArtifact, type RunArtifactResult } from './safe-write.js';
import {
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
export const CAPABILITY_SUMMARY_FILE_NAME = 'cli-capabilities.txt';

export interface RunDoctorOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly commandTimeoutMs?: number;
  /**
   * INTERNAL test seam (AO-007-R1). Not reachable from the CLI, from
   * `process.env` or from the package's public exports; the productive code
   * path always uses {@link OS_PATH_PROVIDER}.
   */
  readonly pathProvider?: PathProvider;
}

function parseNodeMajor(versionText: string): number | null {
  const match = /^v?(\d+)\./.exec(versionText.trim());
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}

function versionFrom(records: readonly CapabilityRecord[], id: string): CliVersionInfo | null {
  const record = findRecord(records, id);
  if (record === undefined) return null;
  const name = record.probe.program;
  if (record.availability === 'EXECUTABLE_NOT_FOUND') {
    return { name, found: false, version: null };
  }
  return { name, found: true, version: record.facts.version };
}

/** Turns a write outcome into a report entry. */
function artefactOf(write: RunArtifactResult): DiagnosticArtefact {
  return {
    path: write.path,
    writeCode: write.code,
    written: write.written,
    bytesWritten: write.bytesWritten,
    synced: write.synced,
  };
}

function artefactCheck(id: string, title: string, write: RunArtifactResult): DoctorCheck {
  return {
    id,
    title,
    status: write.written ? 'PASS' : 'FAIL',
    mandatory: true,
    detail:
      `${write.code} at ${write.path}` +
      (write.errnoCode === null ? '' : ` (errno ${write.errnoCode})`) +
      `; ${write.bytesWritten} bytes, fsync ${write.synced ? 'applied' : 'not applied'}.`,
  };
}

/** The closing check: the run is finished only if the marker was created. */
function completionCheck(completion: RunCompletionResult): DoctorCheck {
  return {
    id: 'diagnostics:run-completed',
    title: 'Run marked COMPLETED',
    status: completion.completed ? 'PASS' : 'FAIL',
    // Mandatory on purpose: without the marker the run is not consumable, so
    // it must not exit 0 (AO-007-R2-RR2).
    mandatory: true,
    detail:
      `${completion.code} at ${completion.markerPath}` +
      (completion.errnoCode === null ? '' : ` (errno ${completion.errnoCode})`) +
      `. Only a run carrying this marker with protocol ${completion.protocolVersion} may be consumed.`,
  };
}

export async function runDoctor(options: RunDoctorOptions): Promise<DoctorReport> {
  const startedAt = new Date().toISOString();
  const checks: DoctorCheck[] = [];
  const todos: string[] = [];
  const provider = options.pathProvider ?? OS_PATH_PROVIDER;

  // --- 0. Diagnostics location --------------------------------------------
  // Always the per-user application-data root, never process.cwd() and never
  // an environment-supplied path (AO-007).
  const diagDir = doctorDiagnosticsDir(provider);
  const runsRoot = doctorRunsRoot(provider);
  const runId = newRunId();
  const runDirectory = createRunDirectory({ runsRoot, runId });

  checks.push({
    id: 'diagnostics:run-directory',
    title: 'Fresh run directory created',
    status: runDirectory.created ? 'PASS' : 'FAIL',
    mandatory: true,
    detail:
      `${runDirectory.code} at ${runDirectory.path}` +
      (runDirectory.errnoCode === null ? '' : ` (errno ${runDirectory.errnoCode})`) +
      '. Each run gets its own directory; an existing one is never reused.',
  });

  // The removed `AGENT_LOOP_HOME` override. Presence only — the value is never
  // read, printed or used to build a path (AO-007-R1).
  const overrideWarning = homeOverrideWarningCode(options.env);
  if (overrideWarning !== null) {
    checks.push({
      id: 'env:home-override',
      title: 'Unsupported home override',
      status: 'WARN',
      // Not execution-relevant: the value is ignored outright, so the run still
      // writes to the fixed per-user root. Reported so the operator knows the
      // variable no longer does anything.
      mandatory: false,
      detail:
        `${overrideWarning}: ${UNSUPPORTED_HOME_OVERRIDE_VAR} is set in this environment and is ` +
        'ignored. The persistent write root is always the OS user profile. The value is not read.',
    });
  }

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

  // --- B. CLI capability probes -------------------------------------------
  // `runCapabilityDump` consumes each probe's raw output and returns facts
  // only; no stdout or stderr survives this call (AO-002-R1).
  const capabilityOptions = {
    env: childEnv,
    ...(options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs }),
  };
  const capabilities = await runCapabilityDump(capabilityOptions);
  const capabilityAnswers: CapabilityAnswers = deriveCapabilityAnswers(capabilities);
  const capabilityFacts = capabilities.map((record) => record.facts);

  const artefacts: DiagnosticArtefact[] = [];

  if (runDirectory.created) {
    const capabilityWrite = writeRunArtifact({
      runDirectory: runDirectory.path,
      fileName: CAPABILITY_SUMMARY_FILE_NAME,
      contents: renderCapabilitySummary(capabilities, capabilityAnswers, startedAt, runId),
    });
    checks.push(
      artefactCheck(
        'diagnostics:capability-summary',
        'Capability summary written safely',
        capabilityWrite,
      ),
    );
    artefacts.push(artefactOf(capabilityWrite));
  }

  for (const record of capabilities) {
    const available = record.availability === 'AVAILABLE';
    const status: DoctorCheck['status'] = available
      ? 'PASS'
      : record.probe.required
        ? 'FAIL'
        : 'WARN';
    checks.push({
      id: `cli:${record.probe.id}`,
      title: `${record.probe.program} ${record.probe.args.join(' ')}`,
      status,
      mandatory: record.probe.required,
      detail:
        `${record.availability}; outcome=${record.facts.outcome}, ` +
        `exit=${record.facts.exitCode === null ? 'none' : record.facts.exitCode}, ` +
        `failure=${record.facts.failureCode ?? 'none'}, ` +
        `${record.facts.durationMs} ms.`,
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
    nodeRecord === undefined
      ? null
      : parseNodeMajor(nodeRecord.facts.version ?? process.version);
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
  //
  // Both targets are inside the fixed orchestrator data root (or, in tests, the
  // explicitly injected scratch root). The doctor writes nowhere else and takes
  // no path from the environment: the former `AGENT_LOOP_WORKTREES_ROOT` probe
  // let an environment variable name a directory the doctor would then create a
  // file in, which is a write-anywhere primitive dressed as a diagnosis. It has
  // been removed (AO-007-R1-RR2). Worktree roots return with the
  // repository/worktree onboarding work, with their own validation.
  const writeAccessAssessment: WriteAccessResult[] = [
    probeWriteAccess({ label: 'diagnostics directory', path: diagDir, createIfMissing: true }),
    probeWriteAccess({
      label: 'orchestrator home',
      path: orchestratorHome(provider),
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
        detail: 'The write-probe file could not be removed.',
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
  if (capabilityAnswers.codexLoginStatusMachineReadable !== 'YES') {
    todos.push(
      'auth/codex: `codex login status` offers no machine-readable output format in the installed ' +
        'version, so the check requires its output to be exactly the one observed English line. ' +
        'A localised or reworded build fails closed. Re-evaluate when a JSON output mode ships.',
    );
  }

  // --- Assemble ------------------------------------------------------------
  const finishedAt = new Date().toISOString();
  const reportPath = join(runDirectory.path, DOCTOR_REPORT_FILE_NAME);

  const buildReport = (
    reportChecks: readonly DoctorCheck[],
    diagnosticFiles: readonly DiagnosticArtefact[],
  ): DoctorReport => ({
    reportKind: DOCTOR_REPORT_KIND,
    schemaVersion: DOCTOR_REPORT_SCHEMA_VERSION,
    runId,
    startedAt,
    finishedAt,
    overallStatus: computeOverallStatus(reportChecks),
    checks: reportChecks,
    cliVersions,
    capabilityFacts,
    capabilityAnswers,
    authAssessment,
    environmentAssessment,
    writeAccessAssessment,
    diagnosticsDirectory: diagDir,
    runDirectory: runDirectory.path,
    reportPath,
    diagnosticFiles,
    runProtocolVersion: RUN_PROTOCOL_VERSION,
    completionMarkerFile: COMPLETION_MARKER_FILE_NAME,
    todos,
  });

  if (!runDirectory.created) {
    // Nothing was created, so nothing can be persisted and no marker can be
    // written. The mandatory run-directory check above already forces a
    // non-zero exit; the detail is reported through the returned report.
    return buildReport(checks, artefacts);
  }

  // The persisted copy carries the checks known at the moment it is written and
  // makes no claim about its own persistence or about the run being finished —
  // it is written *before* the marker, so it cannot know either. The returned
  // report, which drives the console and the exit code, gets the report-write
  // and completion checks appended below (AO-007-R2-RR2).
  const reportWrite = writeRunArtifact({
    runDirectory: runDirectory.path,
    fileName: DOCTOR_REPORT_FILE_NAME,
    contents: `${JSON.stringify(buildReport(checks, artefacts), null, 2)}\n`,
  });

  const finalChecks: DoctorCheck[] = [
    ...checks,
    artefactCheck('diagnostics:doctor-report', 'Doctor report written safely', reportWrite),
  ];
  const finalArtefacts = [...artefacts, artefactOf(reportWrite)];

  if (!reportWrite.written) {
    // No marker is attempted, so the run stays incomplete for good. Whatever
    // was written is deliberately left in place for diagnosis; the missing
    // marker is what keeps it from ever being consumed.
    return buildReport(finalChecks, finalArtefacts);
  }

  // The last step of the run, and the only thing that makes it consumable.
  const completion = completeRun({
    runDirectory: runDirectory.path,
    expectedArtefacts: [CAPABILITY_SUMMARY_FILE_NAME, DOCTOR_REPORT_FILE_NAME],
  });

  return buildReport([...finalChecks, completionCheck(completion)], finalArtefacts);
}
