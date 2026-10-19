/**
 * The Zera supervisor's source, versioned (ADR 2026-10-19, decision D6 = A).
 *
 * `ops/zera-supervisor/` holds the source of the files the scheduled task
 * `\Zera\Zera unattended supervisor` runs from `C:\Users\Max\AO-runs`: a
 * byte-for-byte copy in phase 1, with phase 2's path parameters since. It is not
 * executed by anything in this repository and not deployed by any change here.
 * These checks guard it in CI until a deployment exists:
 *
 *  - the set of files is exactly the versioned one (no transcript, no state
 *    file, no historical folder slips in: nine transcripts hold the ntfy topic);
 *  - every PowerShell file keeps its UTF-8 BOM and every file its LF line ends
 *    (measured on the production copy, 2026-10-19) — Windows PowerShell 5.1
 *    misreads an em-dash in a BOM-less script, and a deployed copy must stay
 *    byte-equal to a commit;
 *  - no credential is in any file;
 *  - every AO module the supervisor imports from `dist/` still has its source
 *    in `src/`, so a refactor of AO cannot silently break the supervisor;
 *  - on Windows, the supervisor passes its own wiring test (each grant flag is
 *    reachable only through the lane that proved it);
 *  - its paths come from one function, source and state apart (phase 2), and
 *    no output of it names the notification channel.
 *
 * The supervisor itself is never run or dot-sourced here. A case that needs one
 * of its functions parses the file, as the wiring test does, and loads that
 * function alone into a fresh PowerShell.
 */

import { randomBytes } from 'node:crypto';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OPS = join(REPO_ROOT, 'ops', 'zera-supervisor');
const SUPERVISOR = join(OPS, 'zera-supervisor.ps1');
const TODAY_DIR = 'C:\\Users\\Max\\AO-runs';

const HELPER_FILES = {
  Classifier: 'ao-classify.mjs',
  DeliveryGate: 'zera-delivery-gate.mjs',
  QuotaGrant: 'zera-quota-grant.mjs',
  RepairGrant: 'zera-operator-repair-grant.mjs',
  WriterGrant: 'zera-writer-death-grant.mjs',
} as const;

const STATE_FILES = {
  StatusFile: 'zera-unattended-status.txt',
  RetryFile: 'zera-retry-budget.json',
  LockFile: 'zera-supervisor.lock',
  NotifyStamp: 'zera-last-notify.txt',
  TranscriptDir: 'transcripts',
} as const;

/** Today's paths, value by value: what the supervisor resolved before phase 2. */
const TODAY_TABLE = {
  SourceDir: TODAY_DIR,
  StateDir: TODAY_DIR,
  AoRoot: 'D:\\AgentOrchestrator',
  RepoRoot: 'D:\\Workspaces_VSCode\\HealthApp',
  Classifier: 'C:\\Users\\Max\\AO-runs\\ao-classify.mjs',
  DeliveryGate: 'C:\\Users\\Max\\AO-runs\\zera-delivery-gate.mjs',
  QuotaGrant: 'C:\\Users\\Max\\AO-runs\\zera-quota-grant.mjs',
  RepairGrant: 'C:\\Users\\Max\\AO-runs\\zera-operator-repair-grant.mjs',
  WriterGrant: 'C:\\Users\\Max\\AO-runs\\zera-writer-death-grant.mjs',
  StatusFile: 'C:\\Users\\Max\\AO-runs\\zera-unattended-status.txt',
  RetryFile: 'C:\\Users\\Max\\AO-runs\\zera-retry-budget.json',
  LockFile: 'C:\\Users\\Max\\AO-runs\\zera-supervisor.lock',
  NotifyStamp: 'C:\\Users\\Max\\AO-runs\\zera-last-notify.txt',
  TranscriptDir: 'C:\\Users\\Max\\AO-runs\\transcripts',
};

const scratch: string[] = [];
const scratchDir = (label: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `zera-${label}-`));
  scratch.push(dir);
  return dir;
};

const psQuote = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/**
 * PowerShell that loads the named supervisor functions, and only those, from
 * the file's syntax tree. Nothing else in the supervisor runs.
 */
const loadFunctions = (names: readonly string[]): string => `
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest
$zeraTokens = $null; $zeraErrors = $null
$zeraAst = [System.Management.Automation.Language.Parser]::ParseFile(${psQuote(SUPERVISOR)}, [ref]$zeraTokens, [ref]$zeraErrors)
if ($zeraErrors.Count -gt 0) { throw 'the supervisor does not parse' }
foreach ($zeraName in @(${names.map(psQuote).join(', ')})) {
    $zeraFn = $zeraAst.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $zeraName }, $true)
    if ($null -eq $zeraFn) { throw "no function $zeraName in the supervisor" }
    . ([scriptblock]::Create($zeraFn.Extent.Text))
}
`;

const runPowerShell = (body: string, env: NodeJS.ProcessEnv = process.env): SpawnSyncReturns<string> => {
  const file = join(scratchDir('ps'), 'case.ps1');
  writeFileSync(file, body, 'utf8');
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
    { encoding: 'utf8', timeout: 120_000, env },
  );
};

const runWiringTest = (subject: string): SpawnSyncReturns<string> =>
  spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(OPS, 'zera-wiring-test.ps1'),
      subject,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );

/** The `KEY=<json>` lines a case prints, parsed. */
const tablesOf = (stdout: string): Record<string, Record<string, string>> => {
  const tables: Record<string, Record<string, string>> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([A-Z]+)=(\{.*\})$/.exec(line.trim());
    if (match) tables[match[1] as string] = JSON.parse(match[2] as string) as Record<string, string>;
  }
  return tables;
};

/** The supervisor's code lines: comments dropped, so prose cannot pass for a path. */
const codeLines = (text: string): string[] =>
  text.split('\n').filter((line) => !line.trim().startsWith('#'));

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VERSIONED_FILES = [
  'README.md',
  'ao-classify.mjs',
  'zera-delivery-gate.mjs',
  'zera-grant-lab.mjs',
  'zera-operator-repair-grant.mjs',
  'zera-quota-grant.mjs',
  'zera-register-task.ps1',
  'zera-supervisor.ps1',
  'zera-wiring-test.ps1',
  'zera-writer-death-grant.mjs',
] as const;

const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /ntfy\.sh\/[A-Za-z0-9_-]{6,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

const bytesOf = (name: string): Buffer => readFileSync(join(OPS, name));

describe('ops/zera-supervisor (ADR 2026-10-19, D6 = A)', () => {
  it('holds exactly the versioned source, test and guide files', () => {
    expect(readdirSync(OPS).sort()).toEqual([...VERSIONED_FILES].sort());
  });

  it('keeps the UTF-8 BOM on every PowerShell file', () => {
    const scripts = VERSIONED_FILES.filter((name) => name.endsWith('.ps1'));
    expect(scripts.length).toBe(3);
    for (const name of scripts) {
      expect([...bytesOf(name).subarray(0, 3)], name).toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it('keeps the LF line ends it runs with today', () => {
    for (const name of VERSIONED_FILES) {
      const text = bytesOf(name).toString('latin1');
      expect(text.includes('\n'), name).toBe(true);
      expect(text.includes('\r'), name).toBe(false);
    }
  });

  it('holds no credential', () => {
    for (const name of VERSIONED_FILES) {
      const text = bytesOf(name).toString('utf8');
      for (const pattern of CREDENTIAL_PATTERNS) {
        expect(pattern.test(text), `${name} matches ${pattern}`).toBe(false);
      }
    }
  });

  it('imports only AO modules whose source still exists', () => {
    const modules = new Set<string>();
    for (const name of VERSIONED_FILES.filter((file) => file.endsWith('.mjs'))) {
      // Written as `join(AO_ROOT, 'dist', 'core', 'task-state.js')`.
      const text = bytesOf(name).toString('utf8');
      for (const match of text.matchAll(/'dist'((?:,\s*'[A-Za-z0-9._-]+')+)\)/g)) {
        const segments = [...(match[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1]);
        modules.add(segments.join('/').replace(/\.js$/, ''));
      }
    }
    expect(modules.size).toBeGreaterThan(0);
    for (const module of modules) {
      expect(existsSync(join(REPO_ROOT, 'src', `${module}.ts`)), module).toBe(true);
    }
  });

  it.runIf(process.platform === 'win32')('passes its own wiring test', () => {
    const run = runWiringTest(SUPERVISOR);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/WIRING_VERDICT = ALL_PASS/);
    expect(run.stdout).toMatch(/WIRING_FAILED = 0/);
  }, 150_000);

  it.runIf(process.platform === 'win32')(
    'fails its wiring test when a prover is joined from the state folder',
    () => {
      const original = readFileSync(SUPERVISOR, 'utf8');
      const broken = original.replace(
        "Join-Path $SourceDir 'zera-operator-repair-grant.mjs'",
        "Join-Path $StateDir 'zera-operator-repair-grant.mjs'",
      );
      expect(broken).not.toBe(original);
      const copy = join(scratchDir('wiring'), 'zera-supervisor.ps1');
      writeFileSync(copy, broken, 'utf8');

      const run = runWiringTest(copy);
      expect(run.status, run.stdout + run.stderr).toBe(1);
      expect(run.stdout).toMatch(/FAIL {2}\$RepairGrant names zera-operator-repair-grant\.mjs in \$SourceDir/);
      expect(run.stdout).toMatch(/WIRING_VERDICT = FAILURES/);
    },
    150_000,
  );

  it('names today\'s folder once, as the state default, and no helper by a literal path', () => {
    const text = bytesOf('zera-supervisor.ps1').toString('utf8');
    expect(text.split(TODAY_DIR).length - 1).toBe(1);

    const code = codeLines(text);
    expect(code.filter((line) => line.includes(TODAY_DIR))).toEqual([
      "    if ([string]::IsNullOrWhiteSpace($StateDir)) { $StateDir = 'C:\\Users\\Max\\AO-runs' }",
    ]);
    for (const [key, file] of Object.entries(HELPER_FILES)) {
      const quoted = code.filter((line) => line.includes(`'${file}'`));
      expect(quoted, file).toHaveLength(1);
      expect(quoted[0], file).toMatch(new RegExp(`^\\s*${key}\\s*=\\s*Join-Path \\$SourceDir '${file.replace(/\./g, '\\.')}'\\s*$`));
      expect(code.some((line) => new RegExp(`[\\\\/]${file.replace(/\./g, '\\.')}`).test(line)), file).toBe(false);
    }
    for (const [key, file] of Object.entries(STATE_FILES)) {
      expect(text, file).toMatch(new RegExp(`\\n\\s*${key}\\s*=\\s*Join-Path \\$StateDir '${file.replace(/\./g, '\\.')}'\\s*\\n`));
    }

    // Every helper call carries the AO root and every ledger reader the ledger.
    expect(text).toMatch(/\n\$env:AO_ROOT = \$AoRoot\n/);
    expect(text).toMatch(/& node \$QuotaGrant --repository \$RepoRoot `\n\s*--budget \$RetryFile/);
    expect(text).toMatch(/Invoke-GrantProver -Script \$WriterGrant[^\n]*\n\s*'--budget', \$RetryFile,/);
  });

  describe.runIf(process.platform === 'win32')('Resolve-ZeraPaths', () => {
    const resolveTables = (src: string, state: string, fromEnv: string): Record<string, Record<string, string>> => {
      const env = { ...process.env };
      delete env.ZERA_STATE_DIR;
      const run = runPowerShell(
        `${loadFunctions(['Get-ZeraArg', 'Resolve-ZeraPaths'])}
'DEFAULT=' + (Resolve-ZeraPaths -SourceDir ${psQuote(TODAY_DIR)} | ConvertTo-Json -Compress)
'EXPLICIT=' + (Resolve-ZeraPaths -SourceDir ${psQuote(TODAY_DIR)} -StateDir ${psQuote(TODAY_DIR)} | ConvertTo-Json -Compress)
'SPLIT=' + (Resolve-ZeraPaths -SourceDir ${psQuote(src)} -StateDir ${psQuote(state)} | ConvertTo-Json -Compress)
$env:ZERA_STATE_DIR = ${psQuote(fromEnv)}
'ENV=' + (Resolve-ZeraPaths -SourceDir ${psQuote(src)} | ConvertTo-Json -Compress)
'PARAM=' + (Resolve-ZeraPaths -SourceDir ${psQuote(src)} -StateDir ${psQuote(state)} | ConvertTo-Json -Compress)
'ARGV=' + (Resolve-ZeraPaths -SourceDir ${psQuote(src)} -StateDir (Get-ZeraArg @('-DryRun', '-StateDir', ${psQuote(state)}) '-StateDir') | ConvertTo-Json -Compress)
try { Resolve-ZeraPaths -SourceDir ${psQuote(src)} -StateDir 'relative\\state' | Out-Null; 'RELATIVE=accepted' } catch { 'RELATIVE=refused' }
`,
        env,
      );
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toMatch(/^RELATIVE=refused\s*$/m);
      return tablesOf(run.stdout);
    };

    it('resolves today\'s paths by default, keeps source and state apart, and ranks -StateDir over ZERA_STATE_DIR over the default', () => {
      const root = scratchDir('paths');
      const src = join(root, 'source');
      const state = join(root, 'state');
      const fromEnv = join(root, 'from-env');
      const tables = resolveTables(src, state, fromEnv);

      expect(tables.DEFAULT).toEqual(TODAY_TABLE);
      expect(tables.EXPLICIT).toEqual(TODAY_TABLE);

      const split = tables.SPLIT as Record<string, string>;
      expect(split.SourceDir).toBe(src);
      expect(split.StateDir).toBe(state);
      for (const [key, file] of Object.entries(HELPER_FILES)) expect(split[key], key).toBe(join(src, file));
      for (const [key, file] of Object.entries(STATE_FILES)) expect(split[key], key).toBe(join(state, file));

      expect(tables.ENV?.StateDir).toBe(fromEnv);
      expect(tables.ENV?.RetryFile).toBe(join(fromEnv, 'zera-retry-budget.json'));
      expect(tables.PARAM?.StateDir).toBe(state);
      expect(tables.PARAM?.RetryFile).toBe(join(state, 'zera-retry-budget.json'));
      expect(tables.ARGV?.StateDir).toBe(state);
    }, 150_000);
  });

  describe.runIf(process.platform === 'win32')('Notify', () => {
    it('names neither the topic nor the URL, in a dry run or when the endpoint refuses', () => {
      const sentinel = `zera-sentinel-${randomBytes(8).toString('hex')}`;
      const endpoint = 'http://127.0.0.1:9';
      const home = scratchDir('home');
      mkdirSync(join(home, '.agent-orchestrator'));
      writeFileSync(join(home, '.agent-orchestrator', 'notify.yaml'), `endpoint: ${endpoint}\ntopic: ${sentinel}\n`);
      const state = scratchDir('state');
      const stamp = join(state, 'zera-last-notify.txt');

      const run = runPowerShell(
        `${loadFunctions(['Test-NotifyIsNew', 'Notify'])}
$NotifyStamp = ${psQuote(stamp)}
$DryRun = $true
Notify 'Zera redaction probe' 'probe body'
$DryRun = $false
Notify 'Zera redaction probe (live)' 'probe body'
`,
        { ...process.env, USERPROFILE: home },
      );
      const output = run.stdout + run.stderr;
      expect(run.status, output).toBe(0);

      // Both paths were reached, so the absence below is not vacuous.
      expect(run.stdout).toMatch(/^DRY-RUN: would notify -- Zera redaction probe\s*$/m);
      expect(run.stdout).toMatch(
        /^notify failed: the notification endpoint did not take the message -- Zera redaction probe \(live\)\s*$/m,
      );
      expect(existsSync(stamp)).toBe(true);

      expect(output).not.toContain(sentinel);
      expect(output).not.toContain('127.0.0.1:9');
    }, 150_000);
  });
});
