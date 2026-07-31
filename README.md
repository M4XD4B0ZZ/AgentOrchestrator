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
  argv, exit code, stdout, stderr, start/end time, duration and whether the
  process started at all;
- checks that Claude Code reports a **Claude subscription** login and that
  Codex reports a **ChatGPT** login, using a fail-closed allow-list;
- probes Node/npm/Git/Claude/Codex versions and write access to the
  orchestrator home and worktrees root, using reversible probe files that are
  deleted immediately.

It never runs an agent task, never modifies a repository or any configuration,
never changes global environment variables, never performs a login, and never
reads a credential store.

### Artefacts

Written under `.diagnostics/` (git-ignored):

| File | Contents |
| --- | --- |
| `cli-capabilities.txt` | Full, redacted capability dump, one block per probe |
| `doctor-report.json` | Machine-readable report |

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

| State | Resumable | Unattended resume | Human decision |
| --- | --- | --- | --- |
| `BLOCKED_AUTH` | yes | no | yes |
| `BLOCKED_USAGE_LIMIT` | yes | **yes** | no |
| `BLOCKED_VERIFY` | yes | no | yes |
| `SCOPE_VIOLATION` | no | no | yes |
| `RESUME_STATE_DIVERGED` | no | no | yes |
| `HUMAN_DECISION_REQUIRED` | yes | no | yes |

### Resume points

`resumeFrom` is structured, not a free-form string:

```json
{ "phase": "IMPLEMENT", "round": 1 }
```

Phases: `IMPLEMENT`, `VERIFY`, `REVIEW`, `REMEDIATE`. The round is validated
against `maxReviewRounds`. `formatResumePoint()` renders the `IMPLEMENT_ROUND_1`
shorthand for display only.

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
