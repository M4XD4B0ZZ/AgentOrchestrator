# agent-orchestrator (`agent-loop`)

Foundation for a repository-agnostic orchestrator that will coordinate two
already-installed CLI agents:

- **Claude Code** — the only agent allowed to write.
- **Codex CLI** — a strictly read-only reviewer.

Both are intended to run on their existing **subscription logins**, never on
API keys.

> **There is no orchestration loop in this build.** Task creation, worktree
> management, implement/verify/review rounds and resume handling are not
> implemented. No command in this build starts an agent.

What *is* implemented:

1. A standalone TypeScript CLI project.
2. The binding **single-task state contract** (Zod → generated JSON Schema,
   plus an explicit state-transition table).
3. The read-only diagnosis command `agent-loop doctor`.

## Requirements

- Node.js **22 or newer** (24 LTS recommended)
- npm
- Git

## Install

```powershell
npm install
```

## Build and verify

```powershell
npm run schema:generate   # regenerate schemas/task-state.schema.json from Zod
npm run typecheck         # tsc --noEmit, strict
npm test                  # vitest
npm run build             # emit dist/ (Node-executable CLI)
```

`schemas/task-state.schema.json` is **generated**. Do not edit it by hand — a
test fails if it no longer matches the Zod schema in `src/core/task-state.ts`.

## Link the CLI globally

```powershell
npm link
agent-loop --help
```

`bin.agent-loop` points at `dist/cli/index.js`, so `npm run build` must have run
first.

## `agent-loop doctor`

```powershell
agent-loop doctor
```

A read-only local diagnosis. It:

- reports which of four API-key environment variables are `SET` / `NOT_SET`
  (never their values, lengths, prefixes or hashes) and builds a **sanitised
  child environment** with those four removed. `CLAUDE_CODE_OAUTH_TOKEN` is
  deliberately preserved — it is a subscription OAuth path, not an API key;
- probes the locally installed CLIs with `--version` / `--help` and records
  argv, exit code, start/end time, duration, a fixed failure code and whether
  the process started at all. Every probe runs with a wall-clock timeout **and**
  a hard byte budget per stream, both enforced while the output streams; a
  child that exceeds either is terminated together with its whole process tree
  (on Windows via `taskkill /T /F` with a validated numeric PID, so a `.cmd`
  shim cannot leave the real program running);
- checks that Claude Code reports a **Claude subscription** login and that
  Codex reports a **ChatGPT** login, using a fail-closed allow-list. The Codex
  check accepts *only* a command whose total normalised output — stdout and
  stderr together — is exactly the single line `Logged in using ChatGPT`. (The
  installed Codex CLI 0.146.0 writes that line to stderr and leaves stdout
  empty, which is why both streams are evaluated as one.) Extra words, an extra
  line, a mixed "ChatGPT and API key" message, a plan suffix, a warning, a
  banner or a localised wording all fail closed;
- probes Node/npm/Git/Claude/Codex versions and write access to the
  orchestrator home and worktrees root, using reversible probe files that are
  deleted immediately.

It never runs an agent task, never modifies a repository or any configuration,
never changes global environment variables, never performs a login, and never
reads a credential store.

### Artefacts

The orchestrator is repository-agnostic, so **nothing is ever written relative
to the current working directory**. Persistent diagnostics go to the per-user
application-data root:

```
%USERPROFILE%\.agent-orchestrator\diagnostics\doctor\      (Windows)
$HOME/.agent-orchestrator/diagnostics/doctor/              (POSIX)
```

| File | Contents |
| --- | --- |
| `cli-capabilities.txt` | Full, redacted capability dump, one block per probe |
| `doctor-report.json` | Machine-readable report |

The console summary prints the actual paths it used. Both files are written
through a containment-checked, atomic path:

- the target must resolve inside the application-data root; separators, `..`
  and absolute names are refused;
- a symbolic link or Windows junction anywhere in the directory path aborts the
  write, as does a target that is not a regular file;
- an existing file is only replaced when it carries this tool's own ownership
  marker, so a foreign file of the same name is never overwritten;
- content is written to a uniquely named temporary file and renamed over the
  target, and the temporary file is removed on every failure path too.

### What the report may contain

The report is built from a closed vocabulary. Raw CLI `stdout`/`stderr`,
exception messages and unknown status output are **not representable** in it:

- auth checks carry a fixed reason code, its static description, the constant
  argv, the numeric exit code, and — only on PASS — typed allow-list evidence.
  For Claude that is exactly `loggedIn`, `authMethod`, `apiProvider` and
  `subscriptionType`; account email, organisation id and organisation name are
  never copied, on success or failure;
- CLI versions are reported as an extracted dotted number, never as a whole
  output line;
- filesystem failures are reported as a fixed code plus an `errno` identifier
  such as `EACCES`;
- every error a user ever sees goes through one central safe formatter, so the
  CLI's top-level handler cannot republish an exception message.

Redaction still runs over the human-readable capability dump, but it is defence
in depth only — the boundary is that unknown text is never copied at all.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | `overallStatus: PASS` — every mandatory check passed |
| `1` | `overallStatus: FAIL` — a check failed, or a mandatory check only warned |

A `WARN` on a non-mandatory check does not fail the run. The only warnings
modelled that way are ones with a documented reason why they are neither a
security nor an execution risk — for example an `ANTHROPIC_API_KEY` present in
the parent environment, which is removed from every child environment by a
unit-tested guard and therefore cannot reach an agent.

The auth checks **fail closed**: they pass only on positively recognised
subscription output. Unknown, empty or unparseable status output is a failure,
not a pass. A `FAIL` from `agent-loop doctor` is a real finding about the local
machine, not a defect in the tool.

### Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `AGENT_LOOP_HOME` | Per-user orchestrator home probed for write access | `%USERPROFILE%\.agent-orchestrator` |
| `AGENT_LOOP_WORKTREES_ROOT` | Root for future per-task worktrees | `D:\AgentWorktrees` |

## The task-state contract

Source of truth: `src/core/task-state.ts` (Zod 4).
Generated artefact: `schemas/task-state.schema.json` (via `z.toJSONSchema()`).

### States

Regular: `CREATED`, `REPOSITORY_RESOLVED`, `CONFIG_VALIDATED`, `AUTH_PREFLIGHT`,
`GIT_PREFLIGHT`, `WORKTREE_READY`, `CONTEXT_LOADING`, `IMPLEMENTING`,
`VERIFYING`, `REVIEWING`, `REMEDIATING`, `READY_FOR_PR`.

Blocking / terminal: `BLOCKED_AUTH`, `BLOCKED_USAGE_LIMIT`, `BLOCKED_VERIFY`,
`SCOPE_VIOLATION`, `RESUME_STATE_DIVERGED`, `HUMAN_DECISION_REQUIRED`,
`ABORTED`.

`READY_FOR_PR` and `ABORTED` are **terminal** — they have no outgoing
transitions. Every other state has at least one documented way out.

Which blocking states can be continued, and how, is declared in
`src/core/resume-policy.ts`:

| State | Resumable | Unattended resume eligible | Human decision | Allowed resume phases |
| --- | --- | --- | --- | --- |
| `BLOCKED_AUTH` | yes | no | yes | `IMPLEMENT`, `REVIEW`, `REMEDIATE` |
| `BLOCKED_USAGE_LIMIT` | yes | **yes** | no | `IMPLEMENT`, `REVIEW`, `REMEDIATE` |
| `BLOCKED_VERIFY` | yes | no | yes | `REMEDIATE` |
| `SCOPE_VIOLATION` | no | no | yes | *(none)* |
| `RESUME_STATE_DIVERGED` | no | no | yes | *(none)* |
| `HUMAN_DECISION_REQUIRED` | yes | no | yes | all four |

The **allowed resume phases are derived from the transition table**, not
maintained by hand, and the schema validates against that same derived set. So
the contract cannot accept a re-entry point the loop could never reach — for
example `VERIFY` after a usage-limit block, when `VERIFYING` is not a successor
of `BLOCKED_USAGE_LIMIT` at all. A state that cannot be continued must not carry
a resume point either.

`BLOCKED_AUTH` re-enters through `AUTH_PREFLIGHT` and **preserves the stored
resume point**: a review interrupted by an expired token resumes at `REVIEW`,
not at `IMPLEMENT`.

### Unattended resume

"Eligible" is not "permitted". `automaticResumeEligible` only says a state may
be *considered*; the decision is made per task by the pure function

```ts
evaluateAutomaticResume(state, evidence)  // → { allowed, reasonCodes, missingChecks }
```

which grants a resume only when every check produced positive evidence: the
reported quota reset time exists, is a valid timestamp and has demonstrably
passed; the auth preflight passed again; repository id, canonical repository
root, canonical worktree path, pinned base commit and current commit all still
match; the worktree exists and is clean; and no divergence was reported.
Without a reliable reset timestamp, no unattended resume is ever granted.

There is still no resume runner — this build only decides and validates.

### Resume points

`resumeFrom` is structured, not a free-form string:

```json
{ "phase": "IMPLEMENT", "round": 1 }
```

Phases: `IMPLEMENT`, `VERIFY`, `REVIEW`, `REMEDIATE`. The round must lie in
`1..maxReviewRounds` and additionally within an absolute ceiling, so a parsed
value can never be `Infinity`, `NaN` or an unsafe integer.
`formatResumePoint()` renders the `IMPLEMENT_ROUND_1` shorthand for display
only, and `parseResumePoint()` validates everything it produces against
`ResumePointSchema` itself.

### `READY_FOR_PR`

The terminal success state must be fully settled and provable. The contract
requires a resolved full-SHA `basePinnedCommit` and `currentCommit`,
`worktreeCleanAtCheckpoint === true`, `blockedAgent`, `resumeFrom` and
`reportedResetAt` all `null`, and a `reviewRound` between 1 and
`maxReviewRounds` — the state is only reachable through a real `REVIEWING` pass.

### Runtime API

`TaskStateSchema`, `parseTaskState()` and `safeParseTaskState()` are the only
public runtime entry points. The weaker *structural* schema lives in
`src/core/internal/` and exists solely for JSON-Schema generation: it accepts
states the contract rejects, so it is deliberately not exported from any public
module, and a test fails if that ever changes.

### Transitions

`src/core/transitions.ts` holds one explicit table plus
`canTransition(from, to)` and `assertTransition(from, to)`. Forbidden
transitions are *derived* from the table, never maintained separately. There is
no blanket "any state may enter any error state" rule: each error edge is listed
with the reason it can physically occur there. For example `VERIFYING` cannot
enter `BLOCKED_USAGE_LIMIT`, because verification runs deterministic local
commands and consumes no agent quota.

## Not implemented yet

Planned commands — mentioned for orientation only, none of them exist in this
build: task creation, worktree setup, the implement/verify/review loop, resume
handling, and finding-fingerprint computation.
