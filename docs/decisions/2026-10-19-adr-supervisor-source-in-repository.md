# ADR 2026-10-19: the Zera supervisor's source lives in this repository

- **Status:** proposed — the operator decided D6 = A on 2026-10-19 ("Supervisor-Quellcode ins
  AO-Repository"); this record states how, and is accepted with the merge of its pull request.
- **Roadmap item:** RM1-10 (`ROADMAP.md`, section 4 and RM1). It comes before RM1-01, RM1-02,
  RM1-03b and RM1-08, which all change the supervisor.
- **Not changed by this record:** the running supervisor, its scheduled task, `dist/`, any AO code.

## Context

The external Zera supervisor (`C:\Users\Max\AO-runs`) drives AO on the HealthApp repository from
the Windows Task Scheduler. That folder is no Git repository: a change to it gets no pull request,
no CI and no history, and its labs run only by hand. The pilot P1 needs four supervisor changes
(RM1-01, RM1-02, RM1-03b, RM1-08), so the supervisor goes under version control first.

### Inventory (read-only, 2026-10-19)

| Class | Files |
| --- | --- |
| Source | `zera-supervisor.ps1` (entry point, 85,758 bytes), `ao-classify.mjs`, `zera-quota-grant.mjs`, `zera-operator-repair-grant.mjs`, `zera-writer-death-grant.mjs`, `zera-delivery-gate.mjs`, `zera-register-task.ps1` (installs the scheduled task) |
| Tests | `zera-grant-lab.mjs` (49 checks, 28 scenarios), `zera-wiring-test.ps1` (30 checks; parses the supervisor's syntax tree) |
| Guide | `README.md` |
| State (stays outside Git) | `zera-retry-budget.json` (the durable retry bound, schema 2), `zera-unattended-status.txt`, the lock, the last-notify stamp, `*.tmp` |
| Output (stays outside Git) | `transcripts/` (266 files, 13.3 MB; **9 of them hold the ntfy topic in clear text**) |
| History (stays outside Git) | `ao-overnight-run.ps1`, three `ao-capture-*.ps1`, `recovery-2026-09-18/`, `v1gap-004-salvage-2026-09-23/` (182 MB, with Codex rollouts and private memory backups) |

- **Dependencies.** The `.mjs` files use only `node:` built-ins and import seven AO modules by file
  URL out of the deployed `dist/` (`core/task-attention`, `core/usage-limit-continuation`,
  `core/task-state`, `core/review-budget`, `verify/operator-repair`, `verify/verification-attempt`,
  `worktree/git-command`) and spawn `dist/cli/index.js`. These deep imports are not public API
  (`package.json`, AO-009); they make the supervisor an internal consumer of `dist/`. External
  commands: `git`, `gh`, `node`, `Invoke-RestMethod` (ntfy), the ScheduledTasks cmdlets.
- **Machine configuration.** Absolute paths: `D:\AgentOrchestrator`, `D:\Workspaces_VSCode\HealthApp`,
  `C:\Users\Max\AO-runs` (`$RunsDir`; every check script and state file is joined from it, not from
  `$PSScriptRoot`), the branch `chore/clean-arch-structure`, the stale merge list `CAPTURE-003..006`.
  `AO_ROOT` can be overridden by an environment variable in the `.mjs` files.
- **Credentials.** No source or test file embeds one (scanned: the ntfy topic, token patterns). The
  ntfy endpoint and topic are read at run time from `%USERPROFILE%\.agent-orchestrator\notify.yaml`.
  `gh` and `git` use their own credential stores (Git Credential Manager; `gh` keyring). The Claude
  and Codex logins live in the user profile, which is why the task runs only when the user is logged
  on.
- **Scheduled task** `\Zera\Zera unattended supervisor`: disabled; triggers at boot (+3 min) and
  every 30 minutes; action `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File
  "C:\Users\Max\AO-runs\zera-supervisor.ps1"`, working directory `C:\Users\Max\AO-runs`; user Max,
  interactive token, highest privileges; 8-hour limit; overlapping runs ignored. Its description is
  stale ("never passes AO a grant flag").
- **Encoding.** The three `.ps1` files start with a UTF-8 BOM, and it is required: Windows
  PowerShell 5.1 (the only version that ever ran it, 266 of 266 transcripts) misreads the em-dashes
  in them without it. Measured on 2026-10-19: without the BOM the wiring test fails. All ten files
  use LF line ends.
- **Tests.** The wiring test needs only the supervisor file and runs in CI. The grant lab needs a
  deployed AO runtime (`<AO_ROOT>\dist` with a provenance record), an explicit long-path lab folder
  (a hosted runner's `%TEMP%` is an 8.3 path) and an explicit retry ledger (it falls back to the real
  one, read-only). It cannot run in CI as it is.

## Decision

1. **Place.** The source and its tests live in `ops/zera-supervisor/`. Not under `src/`: the
   supervisor opens and merges pull requests, and `CLAUDE.md` keeps that outside the orchestrator
   product. It is operations code that consumes AO.
2. **What is versioned.** The seven source files, the two tests and the guide — nothing else. State,
   transcripts and history stay outside Git for good.
3. **Exact bytes.** `.gitattributes` keeps every byte of `ops/zera-supervisor/` as committed
   (`-text`), so the BOM survives and a deployed copy can be compared byte for byte.
4. **No secret in Git.** The ntfy topic stays in `notify.yaml`; CI scans the folder for credentials;
   transcripts are never copied in.
5. **Production never runs from a working tree.** As with `dist/` (ADR 2026-09-15), a branch switch
   in the checkout must not change what the scheduled task runs. A deploy step copies
   `ops/zera-supervisor/` from a canonical, clean commit (the tip of `origin/main`) to the deployed
   folder and writes a provenance file (commit, one hash per file). The scheduled task keeps running
   the deployed copy.
6. **State stays where it is.** The retry ledger and the status file keep their path and shape; the
   ledger is the durable retry bound and is never reset by a deploy.

## Migration plan

| Phase | Change | Production effect | Gate |
| --- | --- | --- | --- |
| 1 (this pull request) | This record; a byte-equal copy of the ten files in `ops/zera-supervisor/`; `.gitattributes`; `tests/ops-zera-supervisor.test.ts` | none | CI; the copy is byte-equal to production (checked by hash before the commit) |
| 2 | Paths from parameters: `$RunsDir` from the deployed folder (`$PSScriptRoot`), a separate `$StateDir` defaulting to today's folder; the wiring test updated for it | none until deployed | CI: the wiring test; the grant lab with explicit lab folder, ledger and runtime |
| 3 | A deploy script with provenance and a dry run; the grant lab runs against a deployed runtime before every deploy | none until run | A dry run shows the file list and hashes; nothing is written |
| 4 | First deploy, while the scheduled task is disabled: back up the current production files, deploy, prove byte-equality with the named commit, keep the scheduled task's action path | the same bytes as before (phase 1 copy) | Hash compare; the wiring test on the deployed copy |
| 5 | RM1-01, RM1-02, RM1-03b, RM1-08 as pull requests against `ops/zera-supervisor/` | after each deploy | CI + the lab |

**Deployment to the Windows machine.** Only from `origin/main`, clean tree, scheduled task
disabled, no AO process running, every lease `FREE` — the same preconditions as `npm run deploy`.
The deployed folder holds the provenance file; a copy whose hashes do not match it is not run
(phase 3 decides whether the supervisor checks this itself at start).

**Rollback.** Before every deploy the deployed files are copied to a dated backup folder beside
them. Going back is a deploy of an earlier commit, or restoring that backup, with the scheduled
task disabled. The state files are never part of a deploy or a rollback.

**Scheduler integration.** The scheduled task stays disabled until decision D5. Its action path
and working directory do not change in phases 1 to 4; `zera-register-task.ps1` stays the only way
to change the task, and its description is corrected in RM1-08. Enabling the task is the operator's
act for the pilot window only.

## Consequences

- A supervisor change gets a pull request, CI and history; the labs become CI tests step by step.
- An AO refactor that removes or moves a module the supervisor imports fails AO's own CI (the import
  check in `tests/ops-zera-supervisor.test.ts`).
- Until phase 4, the copy in Git and the running files are two copies; phase 1's byte-equality is
  the baseline, and no one edits `C:\Users\Max\AO-runs` by hand after it (a hand edit there would be
  lost by the first deploy).
- Open for phase 2/3 (no decision needed now): whether the grant lab runs in CI against a deploy
  made for the job, or only locally before each deploy.
