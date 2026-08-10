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
4. The **repository-profile contract and repository resolution** (Zod →
   generated JSON Schema, plus a fail-closed resolver). This is a runtime
   library layer with no command attached: it can tell you what contract
   governs a repository, but nothing in this build acts on that answer.

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
npm run verify
```

`verify` is the canonical full Foundation verify command. It runs, in this
order: `schema:generate`, `typecheck`, `build`, `test:dist-doctor`,
`test:dist-trusted-profile`, `test:foundation-safe`,
`test:windows-tree-kill-tool-release`. `build` runs immediately before the two
dist artefact checks, so both always run against a fresh build, never a stale
or missing one, and there is only ever one build per `verify` run. The two test
gates run **sequentially**, in that order — the real-process harness never runs
alongside the foundation set.

`test:dist-trusted-profile` checks the *built* trusted-profile module
(`dist/config/internal/trusted-profile.js`): that it resolves the OS user
profile through `os.userInfo()`, that a child process with spoofed profile
environment variables gets the identical answer, and that no remnant of the
removed PowerShell resolver survives in the shipped artefact.

**`test:foundation-safe` is not "all tests", but it is the full regression
set.** It runs every vitest file except one:
`tests/windows-tree-kill-tool-release.test.ts`. That file is excluded (via
vitest's `--exclude` flag) not because it is unstable, but because it drives
real-process churn of its own — a child Node harness process per case plus a
detached, deliberately surviving Node helper — which intermittently
destabilised unrelated files running in parallel beside it (AO-008-S2-R1-F1).
It runs in its own serial gate, `test:windows-tree-kill-tool-release`, with
`--no-file-parallelism`, and never alongside the foundation set. Together the
two gates cover every vitest file exactly once.

`tests/exec.test.ts` — the real exec-lifecycle suite — is **no longer
excluded**. It is a regular part of `test:foundation-safe`, and therefore of
`verify`. The temporary AO-008 exclusion it used to carry was retired in
AO-008-S3.

CI runs exactly this command. `.github/workflows/verify.yml` calls `npm run
verify` on `windows-latest` for every pull request against `main` and every push
to `main` — the same canonical gate, not a reduced substitute, and deliberately
not on a Linux runner: `verify` ends in a real-process probe of the Windows
process-tree termination path and checks a Windows profile resolver, so a green
Ubuntu run would not carry the same meaning. The delivery rules that gate sits
in — pull requests, required checks, what "merge" means here — are in
`CLAUDE.md`.

The individual steps remain available on their own:

```powershell
npm run schema:generate     # regenerate schemas/task-state.schema.json from Zod
npm run typecheck           # tsc --noEmit, strict
npm test                    # vitest, unrestricted — every file, including the
                             # real-process tool-release harness, in one run
npm run test:foundation-safe  # vitest, excluding only the tool-release harness —
                               # the set `verify` runs first
npm run test:windows-tree-kill-tool-release
                              # the real-process tool-release harness on its own,
                              # serially (--no-file-parallelism); the gate
                              # `verify` runs last
npm run build                # emit dist/ (Node-executable CLI)
npm run test:dist-doctor     # run only the dist-artefact child check
                              # (tests/dist-artifact/run-completion-dist-artifact.mjs),
                              # against whatever dist/ already exists — no build
npm run verify:dist-doctor   # build, then check the *built* doctor run-completion
                              # artefact (dist/doctor/run-completion.js) in a
                              # separate Node process — not the TypeScript source
npm run test:dist-trusted-profile   # run only the built trusted-profile check
                              # (tests/dist-artifact/trusted-profile-dist-artifact.mjs),
                              # against whatever dist/ already exists — no build
npm run verify:dist-trusted-profile # build, then check the *built* trusted-profile
                              # module (dist/config/internal/trusted-profile.js)
```

Both dist artefact checks are plain Node scripts, not vitest test files, so
they are never picked up by vitest's default `tests/**/*.test.ts` glob and a
plain `npm test` on a clean checkout (no `dist/` yet) does not depend on a
prior build.

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
  (never their values, lengths, prefixes or hashes) and builds each probe's
  child environment from a **per-probe allow-list** rather than by cleaning a
  copy of the caller's environment. `CLAUDE_CODE_OAUTH_TOKEN` is **not**
  forwarded to any probe — not to `node`/`npm`/`git`, and not to the Claude auth
  probe either: a login check handed a token out of the environment would only
  prove its own input, while the doctor has to verify the *stored* login that
  will really be used. Its presence is reported as `SET`/`NOT_SET` and its value
  is never read or logged;
- probes the locally installed CLIs with `--version` / `--help` from a static
  allow-list of commands, and records argv, exit code, start/end time,
  duration, a fixed failure code and whether the process started at all. The
  probes' `stdout`/`stderr` are **discarded**: only an extracted version
  number and allow-listed flag/subcommand names survive (see
  [Artefacts](#artefacts) and [Version detection](#version-detection)). Every
  probe runs with a wall-clock timeout **and**
  a hard byte budget per stream, both enforced while the output streams; a
  child that exceeds either has termination **attempted, best-effort** — on
  Windows via `taskkill /T /F` with a validated numeric PID, so a `.cmd`
  shim's real program is targeted too, not just the shim. The module then
  waits, with a bound, for the immediate child's `close` event — not for a
  verified absence of the whole tree — reporting a distinct failure code
  (`PROCESS_TREE_KILL_FAILED`) if that event is not observed within the grace
  window. What that attempt does and does not guarantee is spelled out in
  [Windows process-tree termination](#windows-process-tree-termination);
- checks that Claude Code reports a **Claude subscription** login and that
  Codex reports a **ChatGPT** login, using a fail-closed allow-list. The Codex
  check accepts *only* a command whose total normalised output — stdout and
  stderr together — is exactly the single line `Logged in using ChatGPT`. (The
  installed Codex CLI 0.146.0 writes that line to stderr and leaves stdout
  empty, which is why both streams are evaluated as one.) Extra words, an extra
  line, a mixed "ChatGPT and API key" message, a plan suffix, a warning, a
  banner or a localised wording all fail closed;
- probes Node/npm/Git/Claude/Codex versions and write access to the
  diagnostics directory and the orchestrator home, using reversible probe files
  that are deleted immediately. Those two directories are the only write
  targets: the doctor never probes, creates or writes a path named by an
  environment variable.

It never runs an agent task, never modifies a repository or any configuration,
never changes global environment variables, never performs a login, and never
reads a credential store.

### How `runCommand` starts a process

`runCommand` never assembles a free-form command string out of caller input.
Every argument is first validated against a conservative allow-list
(`SAFE_ARG_PATTERN` in `src/doctor/exec.ts`), which already excludes quotes and
shell metacharacters. Beyond that there are exactly **two** execution paths, and
they have deliberately different properties.

**A. Direct executables.** The resolved executable and its arguments are handed
to `spawn` structurally: a literal argument vector, `shell: false`, no shell and
no command processor anywhere in the chain. Nothing on this path is re-parsed by
a shell or an interpreter.

**B. `.cmd` / `.bat` targets.** Node cannot spawn a batch file directly, so this
path runs it through the trusted Windows command processor **on purpose**.
`cmd.exe` therefore does perform its own parsing of the command line it is
given, and this document does not claim otherwise. What is claimed is that the
command line it parses is not freely constructed:

- the interpreter is the trusted, environment-independent `cmd.exe` resolved
  through `src/doctor/internal/windows-system-tools.ts`. `COMSPEC` is never
  read, so a caller-controlled `COMSPEC` cannot substitute the interpreter;
- it is invoked as `cmd.exe /d /s /c "<inner>"` with `shell: false` and
  `windowsVerbatimArguments: true`, so Node performs no quoting of its own and
  the string `cmd.exe` receives is exactly the one this module built;
- every argument is encoded by the strict, fail-closed batch codec
  (`src/doctor/internal/windows-batch-command.ts`): each one — including an
  empty one — is wrapped in a matched quote pair so it produces exactly one
  batch parameter, and every character that remains special *inside* quotes
  (`(`, `)`, `%`, `!`, `^`, `<`, `>`, `&`, `|`) is caret-escaped. The batch
  target reads those arguments back as `%~1`, `%~2`, …; that is part of the
  contract, not an accident of the encoding;
- a literal `"` has no encoding that round-trips through this transport, so an
  argument or a target path containing one is **refused**, not guessed at. An
  explicit batch path with an embedded quote is refused *before* any resolution
  is attempted, so the refusal can never be masked by a "not found" result.

The honest statement for path B is therefore not "no parsing happens" — it is
that the batch command line is narrowly encoded and fail-closed, with no free,
user-controlled command-string construction anywhere in it.

### Windows process-tree termination

The termination path is deliberately small, and its guarantee is deliberately
narrow. It is a separate mechanism from the two execution paths above and shares
none of their command-line construction. What is implemented is exactly this:

- Windows tree termination uses **only** the validated system-tool path for
  `taskkill.exe`, resolved through the trusted boundary
  (`src/doctor/internal/windows-system-tools.ts`). There is **no `PATH` and no
  `COMSPEC` fallback** of any kind.
- The tool is invoked as `taskkill /PID <root pid> /T /F`, with
  `shell: false`, `windowsHide: true` and `stdio: 'ignore'`.
- **No process enumeration** is performed anywhere on this path: no WMI, no
  `wmic`, no PowerShell, no `tasklist`.

On POSIX the equivalent step targets the child's process group
(`kill(-pid, SIGKILL)`), falling back to the immediate child — the same
best-effort shape, with the same limits.

#### The supervisor is asynchronous

- The `taskkill` attempt is supervised **asynchronously**. The event loop is
  never blocked synchronously waiting for the tool (there is no
  `execFileSync`).
- The tool attempt is **time-bounded** by its own timeout
  (`WINDOWS_TREE_KILL_TIMEOUT_MS`, stage 1). The caller's existing child-grace
  window (`killGraceMs`) follows it as stage 2.
- **First termination reason wins**: a later event can never overwrite the
  reason the result already settled on.
- The tree-kill attempt and the settlement are each **exactly-once guarded**.
- Every timer the supervisor arms is `unref`'d, so a diagnostic never holds the
  process open on its own.

#### What `processTreeKilled: true` does and does not mean

`processTreeKilled: true` means **exactly one thing**: the best-effort
tree-kill mechanism reported success.

It does **not** mean:

- kernel-level ownership of the process tree;
- a verified absence of descendants;
- a process tree observed to be empty.

Two further honesties follow from that:

- a `taskkill` tool process can, under OS or policy failures, **outlive the
  settlement**. The supervisor then requests one bounded, best-effort kill of
  that tool process and releases its handle from the event loop; it never waits
  for a confirmation that may never come. What is guaranteed is only that the
  supervisor stops waiting on it and stops holding the event loop open for it;
- when the tool attempt does not succeed there is exactly one fallback: a
  direct kill of the **immediate child**. It reaches the immediate child only,
  never a descendant, and is therefore deliberately *not* reported as a
  successful tree kill.

**Windows Job Objects** would be the separate architecture for hard,
kernel-enforced ownership — a child assigned to a job the kernel tears down
with it, rather than a tool process asked to do the tearing down. That is not
part of the current contract.

#### Test gates for this path

- `test:foundation-safe` carries the ordinary foundation and execution
  regression set, including the real exec-lifecycle suite
  (`tests/exec.test.ts`) and the deterministic supervisor and race suites.
- The real-process tool-release probe
  (`tests/windows-tree-kill-tool-release.test.ts`) runs **separately and
  serially**, in its own gate. It starts real processes — a child Node harness
  per case, which in turn spawns a detached, long-lived Node helper that stands
  in for the tool process — but it does **not** start a real `taskkill.exe` for
  this mechanism: the supervisor's tool seam is injected, so the tool path and
  the tool's `kill()` are the harness's own. It exercises `kill()` returning
  `false`, `kill()` throwing, an ignored `kill()` (the helper survives by
  construction), both the timeout and the `cancel()` trigger, the `unref`-based
  release, and a negative control without `unref` that must hang. What it proves
  is that this Node process still resolves and exits while the tool process is
  provably still alive — **not** that a real `taskkill.exe` can always be
  terminated.
- `verify` runs those gates sequentially, foundation set first.

See [Build and verify](#build-and-verify) for the exact commands.

### Artefacts

The orchestrator is repository-agnostic, so **nothing is ever written relative
to the current working directory**. Persistent diagnostics go to the per-user
application-data root, and **every run gets its own immutable directory**:

```
%USERPROFILE%\.agent-orchestrator\diagnostics\doctor\runs\<run-id>\   (Windows)
$HOME/.agent-orchestrator/diagnostics/doctor/runs/<run-id>/           (POSIX)
```

`<run-id>` is a UTC timestamp plus a cryptographically random UUID, validated
as a single path segment, e.g. `20260801T121500123Z-<uuid>`.

| File | Contents |
| --- | --- |
| `cli-capabilities.txt` | Structured capability summary — facts only, no process output |
| `doctor-report.json` | Machine-readable report, carrying its own run id and run path |
| `COMPLETED` | End-of-run marker: the fixed protocol version `agent-loop-doctor-run/1` and nothing else |

The console summary prints the exact run directory it used and whether the run
completed.

#### The run protocol is append-only

Each file is created **once**, directly under its final name, through a single
exclusive handle — written, `fsync`ed where the filesystem supports it, and
closed. There is no temporary file, no `rename`, no hard link and no unlink
anywhere in the persistence path:

- the run directory is created with `mkdir` **without** `recursive`, so an
  already existing directory is an error and never a reuse;
- the file name must resolve directly inside that run directory; separators,
  `..` and absolute names are refused;
- a symbolic link or Windows junction anywhere in the directory path aborts the
  write;
- **nothing is ever overwritten.** The file is opened with `wx`, so whether the
  name is free is answered by the kernel in the same syscall that would create
  it. There is deliberately no `lstat`-then-open sequence, because that gap is
  the race — and no ownership check, because there is nothing to take ownership
  of. (An earlier scheme proved ownership by looking for a marker string
  *inside* the existing file; that marker is printed into every artefact, so
  anyone could plant it. A later one finalised a temporary file with
  `link`, falling back to a check-then-`rename` that silently replaces an
  existing target on both Windows and POSIX.);
- **nothing is ever deleted.** A run directory, once created, stays — including
  when the run failed. Partial artefacts are left in place as diagnostic
  evidence.

#### Completion

`COMPLETED` is written **last**, and only after both artefacts are fully
written, synced and closed, and the run directory contains exactly those two
files and nothing else. It is created with the same exclusive `wx` semantics and
is never replaced.

- A run directory **with** a `COMPLETED` file whose content is exactly
  `agent-loop-doctor-run/1` is a finished run.
- A run directory **without** that marker — or with one carrying a different
  protocol version — is incomplete. **Consumers must ignore it**, whichever
  artefacts happen to be present. `listCompletedRuns()` in
  `src/doctor/run-completion.ts` is the supported way to enumerate runs and
  implements exactly that rule.
- `agent-loop doctor` exits `0` only if the marker was created.

`doctor-report.json` is written *before* the marker, so it cannot know whether
the run finished and does not claim to. It names the run id, the run directory,
its own intended path, the protocol version and the marker file to look for —
but carries no completion or cleanup status, and does not list itself among the
artefacts it reports as written. Completion is a fact about the directory, not
a statement in the document.

#### Report schema version

`doctor-report.json` carries its own `schemaVersion`. **The current format is
v4**, and every report this version writes states `"schemaVersion": 4`.

v4 replaces two v3 names, both because `CLAUDE_CODE_OAUTH_TOKEN` is now withheld
from every probe rather than forwarded:

| v3 (historical) | v4 (current) |
| --- | --- |
| `environmentAssessment.preservedAuthVars` | `environmentAssessment.withheldAuthVars` |
| check id `env:oauth-token-preserved` | check id `env:oauth-token-withheld` |

The field and the check say the opposite of what their v3 names claimed, so a
consumer written against v3 must not read a v4 document: check `schemaVersion`
before anything else. v3 is only the previous format — nothing writes it any
more, and existing v3 files are never rewritten, migrated or reinterpreted.

#### The protocol is fixed, and binds only to `(runsRoot, runId)`

The two artefact names and the marker name are **not configurable**. There is
no parameter anywhere in `src/doctor/run-completion.ts`'s public functions
through which a caller can name a different or additional required file — the
three-entry shape a completed run must have is a single internal constant, not
an argument.

`completeRun(runsRoot, runId)` and `inspectRun(runsRoot, runId)` take exactly
that: a trusted runs root and a run id, never a `runDirectory` path a caller
could point anywhere. The run directory is always computed internally as
`join(runsRoot, runId)`, after `runId` is validated against the same schema
the run directory was created with. The result must then be a *lexical and
canonical* direct child of `runsRoot` — both checked independently, with no
symlink or Windows junction anywhere between them — before either function
reads a byte from it. A validly-named run directory living under a different
parent, reached through a nested path, or sitting behind a junction is
rejected before it is ever inspected.

Producer and consumer — `completeRun` and `inspectRun` — run through the
*same* internal validators, not two independently maintained copies. Every
path segment that this process cannot conclusively `lstat` (a permission
error, for instance, on an intermediate directory) is treated exactly as
suspiciously as a segment proven to be a link: neither is ever accepted as
"probably fine".

After creating the marker, `completeRun` does not simply trust its own write.
It re-runs the *entire* completed-run validation — the same one `inspectRun`
uses — before reporting success, and reports failure (never `COMPLETED`,
never `completed: true`) if anything about the run no longer validates at
that point, including a mutation an external process made in the instant
between the marker write and that re-check.

None of this claims a stronger atomicity guarantee than Node and the
filesystem actually provide. The orchestrator is built for a local,
single-writer doctor run: it does not defend against a second process racing
the same run directory concurrently. What it does guarantee is narrower: a
successful `completeRun` return means the full contract held at the moment
that call returned, and every later reader of a run directory — `inspectRun`,
`listCompletedRuns`, any future consumer — re-validates the complete contract
from scratch rather than trusting a past success. A writer that modifies the
directory *after* `completeRun` has already returned is not something this
module can prevent; it is something the next `inspectRun` call catches.

Retention of old completed runs is not implemented yet — they are left alone.

### What the artefacts may contain

Both artefacts are built from a closed vocabulary. Raw CLI `stdout`/`stderr`,
exception messages and unknown status output are **not representable** in
them:

- **capability probes** contribute only: the probe id, the program as a fixed
  known label, the statically configured argv, start status, exit code,
  timestamps, duration, a fixed timeout/spawn/output-limit code, an allow-listed
  `errno` identifier, a strictly extracted version number, allow-listed
  subcommand and flag names, boolean capability answers, and a flag recording
  that the raw output was discarded. **The former raw `--help`/`--version` dump
  in `cli-capabilities.txt` was removed for security reasons:** pattern-based
  redaction cannot recognise unknown sensitive content, so process output is
  discarded rather than sanitised. Token recognition is conservative — a token
  must match a strict syntactic pattern *and* appear in a closed vocabulary, so
  a probe cannot introduce a new string into an artefact; output that yields no
  recognised token leaves the capability `UNKNOWN`, which fails closed;
- **auth checks** carry a fixed reason code, its static description, the
  constant argv, the numeric exit code, and — only on PASS — typed allow-list
  evidence. For Claude that is exactly `loggedIn`, `authMethod`, `apiProvider`
  and `subscriptionType`; account email, organisation id and organisation name
  are never copied, on success or failure;
- **CLI versions** are reported as a bare numeric triple, never as a whole
  output line — see [Version detection](#version-detection);
- **filesystem failures** are reported as a fixed code plus an `errno`
  identifier drawn from a closed allow-list (`ENOENT`, `EACCES`, `EPERM`, …);
  anything else becomes `UNKNOWN`;
- **every error** a user ever sees goes through one central safe formatter. It
  emits only string literals written in this repository: a sentence looked up
  in a static table by the error's closed domain id, or the fixed code
  `UNEXPECTED_ERROR`. Our own errors are recognised **by `instanceof` alone**;
  there is no `Symbol.for` marker, no `safeMessage` property and no
  duplicate-module fallback, because all three let a foreign object choose the
  text that gets printed. A foreign `error.name`, `error.code` or
  `error.message` is never printed, however well-formed it looks, and an error
  from a second loaded copy of this package fails closed to `UNEXPECTED_ERROR`.

### Version detection

Each `--version` probe has its **own** fully anchored parser, derived from the
output of the actually installed CLIs (observed 2026-08-01):

| Probe | Expected `stdout` | Reported |
| --- | --- | --- |
| `node.version` | `v24.18.1` | `24.18.1` |
| `npm.version` | `11.12.1` | `11.12.1` |
| `git.version` | `git version 2.55.0.windows.3` | `2.55.0` |
| `claude.version` | `2.1.220 (Claude Code)` | `2.1.220` |
| `codex.version` | `codex-cli 0.146.0` | `0.146.0` |

The rules are deliberately strict:

- only these five probes extract a version at all. A `--help` probe has no
  parser, so it can never contribute one;
- the probe's whole normalised output must be **one** non-empty line, and that
  entire line must match that probe's pattern. A prefix, a suffix, an extra
  line, a banner, help prose or an account line means the output is not the
  format we know;
- only `stdout` is read — a version on `stderr` is not the expected output of
  these commands;
- the reported value is a bare numeric triple. No word from the line — not
  `git version`, not `(Claude Code)`, not `codex-cli`, not a `.windows.N` build
  suffix — can reach a report or an artefact.

This is brittle on purpose: if a CLI changes its output format the version
becomes `UNKNOWN` rather than being guessed at. The previous implementation
scanned any line for anything dotted-numeric and consequently reported versions
taken from account lines and help text.

`src/auth/redaction.ts` remains as a defence-in-depth helper for future
free-form text. It is deliberately *not* the boundary and is not applied to any
persisted artefact — the boundary is that unknown text is never copied at all.

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

**There is none.** No environment variable and no CLI flag influences any path
this build reads or writes.

That still holds now that repository profiles exist. A profile is *repository-side*
configuration: it is found at one fixed path relative to a canonical repository
root the caller stated explicitly, and no variable can name it, relocate it,
rename it or supply a substitute — see
[the repository-profile contract](#the-repository-profile-contract).

The persistent write root is:

```
<OS user profile>\.agent-orchestrator\      (Windows)
<OS user profile>/.agent-orchestrator/      (POSIX)
```

Two removed overrides, and why:

- `AGENT_LOOP_HOME` used to relocate the write root. A variable that redirects
  where a diagnostics run writes its files is a privilege the diagnosis does not
  need. If it is still set, the value is ignored and never read or printed; the
  doctor reports a non-blocking warning carrying only the fixed code
  `UNSUPPORTED_HOME_OVERRIDE_IGNORED`.
- `AGENT_LOOP_WORKTREES_ROOT` used to name a directory that the doctor then
  created a write-probe file in — the same class of defect, one step removed.
  Both the variable and that probe are gone: `agent-loop doctor` does not read
  it, does not resolve it, and writes nothing outside the orchestrator data
  root. Worktree-root configuration returns with the repository/worktree
  onboarding work, with its own explicit validation.

#### How the profile directory is determined

Not by `os.homedir()`. On Windows that function returns `%USERPROFILE%`
whenever the variable is set, so calling it would make the write root
environment-controlled with extra steps. Instead
(`src/config/internal/trusted-profile.ts`):

- `os.userInfo()` is called directly, in this process — no child process, no
  shell, no interpreter, no search list, no output to parse and no
  environment consulted. On Windows it resolves the profile directory from
  the process token; on POSIX, from the passwd entry for the real uid;
- the call itself, the returned value, and that value's `homedir` field are
  each validated behind their own narrow boundary: an unusable dependency, a
  query that throws, a non-object result or a throwing `homedir` accessor are
  all refused fail-closed, never surfaced as a foreign exception;
- the `homedir` value must be a non-empty, non-whitespace string with no
  embedded NUL, and must be absolute;
- it is then canonicalised and the canonical path must, on re-validation,
  `stat` as an existing directory.

**There is no fallback.** A query, validation or canonicalisation failure
fails closed with `TRUSTED_PROFILE_UNAVAILABLE`; it never degrades to an
environment value, and the static error text carries no path, user name,
errno or foreign exception detail.

Tests redirect the root through internal dependency injection
(`src/config/internal/path-provider.ts`), which is not exported from the
package, not reachable from the CLI and reads no environment value.
`tests/paths.test.ts` additionally runs real isolated child processes with each
of those variables manipulated and requires the resolved root to be identical
every time.

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

`src/core/task-state.ts` exports exactly three runtime values:

```ts
TaskStateSchema        // the contract: shape + every cross-field invariant
parseTaskState()       // throwing validator
safeParseTaskState()   // non-throwing validator
```

plus the two TypeScript types needed to use them, `TaskState` and
`TaskStateInput`. Types are erased at build time and add nothing to the runtime
surface. `tests/public-state-api.test.ts` pins that set exactly, so adding to it
has to be a deliberate decision.

Nothing else is public. The weaker *structural* schema
(`TaskStateObjectSchema`), the field-level schemas (`GitShaSchema`,
`IsoDateTimeSchema`, `FindingRecordSchema`), `ResumePointSchema`, `MAX_ROUND`,
the contract-version constant and the evidence helper all live in their own
modules and are used internally only. Three of them are *weaker* validators:
handing them to a caller would offer a way to validate a state while bypassing
the invariants that make it trustworthy. `package.json#exports` publishes only
the CLI entry point and the generated JSON Schema, so `dist/core/**` has no
deep-import path either.

### Transitions

`src/core/transitions.ts` holds one explicit table plus
`canTransition(from, to)` and `assertTransition(from, to)`. Forbidden
transitions are *derived* from the table, never maintained separately. There is
no blanket "any state may enter any error state" rule: each error edge is listed
with the reason it can physically occur there. For example `VERIFYING` cannot
enter `BLOCKED_USAGE_LIMIT`, because verification runs deterministic local
commands and consumes no agent quota.

## The repository-profile contract

Source of truth: `src/repo/repo-profile.ts` (Zod 4).
Generated artefact: `schemas/repo-profile.schema.json` (via `z.toJSONSchema()`).

The orchestrator is repository-agnostic, which means the project-specific facts
have to live somewhere else: in the target repository, in a file that repository
reviews and owns. That file is the **repository profile**, and
`resolveRepository()` is what turns a path plus a profile into a validated,
frozen contract the rest of the system reads.

**Repo-profile and resolution are implemented; the orchestration loop that would
consume them is not.** Nothing in this build discovers a task, creates a
worktree, runs a verification command or starts an agent.

### Where the profile lives

```
<canonical repository root>/.agent-orchestrator/repo-profile.yaml
```

Exactly one location. There is no `.yml` spelling, no root-level alternative, no
upward directory search and no environment override. That is deliberate: the
profile declares which paths a writer agent may touch and which capabilities are
mandatory, so every additional candidate location is another way to put a policy
in force that nobody reviewed. A repository with no file at that exact path has
no profile, and resolution fails with `PROFILE_MISSING` rather than falling back
to a default the repository never agreed to.

YAML is the format because the file is written and reviewed by humans, and
because `yaml` was already a dependency. It is parsed as plain YAML 1.2 core
schema with merge keys disabled — no custom tags, so the document can only
produce the JSON data model.

`src/repo/profile-yaml.ts` owns that conversion, and two rules are established
there rather than downstream:

- **A document the parser warns about is refused**, with `PROFILE_PARSE_FAILED`.
  A warning marks a construct outside the plain 1.2 core schema — an unresolved
  tag, an ambiguous anchor or alias, a bad directive — so refusing it is what the
  format rule already claimed. It also removes a leak: `YAML.parse()` routes
  warnings to `process.emitWarning`, and those messages quote the offending
  source line, which put profile text on stderr past every containment rule the
  resolver observes for its own return value. No warning is handed to the
  library's logger at all, and `logLevel: 'silent'` is set besides. Errors are
  read from the parsed document rather than caught, because a silent log level
  makes `YAML.parse()` *discard* `doc.errors` instead of throwing — silencing
  the logger without that care would have turned malformed YAML into accepted
  YAML. A profile stream of more than one document is refused for the same
  reason: silently taking the first is what a single-document parse would do.
- **A `__proto__` mapping key is refused at any depth**, with
  `PROFILE_SCHEMA_INVALID`. The generated JSON Schema sets
  `additionalProperties: false` everywhere and so rejects it like any other
  unknown property, while Zod's `.strict()` treats `__proto__` as *not a key* and
  drops it silently — the same document meant two different things to the shipped
  schema and to the runtime. Nothing was polluted by that (Zod discards the
  value, and the resolver rebuilds its result field by field), but V1-02+ would
  have been built on the weaker half of a split contract. The check walks the
  parsed document tree, over the mapping keys the parser actually read and
  *before* any JavaScript object exists, because a check performed after the
  conversion can only see keys the conversion chose to keep.

### What a profile declares

```yaml
schemaVersion: 1
repository:
  id: fixture-alpha          # stable slug; becomes TaskState.repositoryId
  defaultBranch: main        # must exist locally; never guessed
taskSource:                  # declared only — nothing is discovered in this build
  kind: MARKDOWN_DIRECTORY
  path: tasks
context:                     # declared only — no file is opened in this build
  canonicalSources:
    - README.md
capabilities:
  codegraph: OPTIONAL        # or REQUIRED, which is fail-closed
verification:                # declared only — nothing is executed in this build
  phases:
    - phase: BUILD
      command: [npm, run, build]
    - phase: VERIFY
      command: [npm, run, verify]
scope:                       # declared only — no scope is enforced in this build
  allowedPaths: [src, tests]
  protectedPaths: [dist]     # wins over allowedPaths where the two overlap
completion:
  maxReviewRounds: 3         # bounded by the same RoundSchema as the state contract
remote:
  required: false            # a repository with no remote is a valid target
```

Unknown keys are refused at every level, and the fields are limited to those
with a concrete consumer. There is no UI, cloud-provider, CI-provider,
GitHub-specific, PR-automation, merge-policy or parallel-worker configuration —
a profile field that nothing reads is a promise the build cannot keep.

Verification commands are **argv vectors, not shell strings**, and every token
must be shell-inert, as must every path and the branch name. A repository
profile is input: it must not be able to place a shell metacharacter into a
command line at all. Paths are POSIX-shaped and repository-relative; an absolute
path, a drive letter, a backslash, a `..` segment and a `.` segment are each
refused by the schema, and containment is then re-checked against the canonical
root at resolution time.

**Default-branch names are limited in v1 to the safe ASCII-inert argument
grammar of the execution layer.** The branch name becomes an argument to a real
`git` process, and the hardened `runCommand` argument contract established in
AO-008 accepts only that grammar; the profile schema enforces it on the way in
rather than letting a value through that the execution layer would have to
refuse later. The practical consequence is worth stating plainly, because it is a
limit of this build and not of Git: a branch name Git accepts perfectly well —
`feature/café`, `Ünicode` — **cannot currently be profiled as `defaultBranch`**,
and such a profile is refused with `PROFILE_SCHEMA_INVALID`. Onboarding a
repository whose default branch carries non-ASCII characters therefore needs the
argument grammar widened first; V1-01 does not widen it.

Cross-field invariants that JSON Schema cannot express — a supported
`schemaVersion`, distinct verification phases, a mandatory `VERIFY` phase,
duplicate-free path lists — are enforced by `RepoProfileSchema` at runtime, and
the *structural* schema that lacks them stays internal, exactly as it does for
the task state.

### How a repository is resolved

`resolveRepository({ repositoryPath })` runs these steps and stops at the first
failure:

1. the input must be a non-empty **absolute** path with no NUL;
2. it is canonicalised with `realpath` and must be an existing directory;
3. `git rev-parse --show-toplevel` must succeed, and its canonical answer must
   be *this* path — a subdirectory of a repository is `REPOSITORY_ROOT_MISMATCH`,
   not a silent promotion to the root;
4. `git rev-parse --git-dir` must succeed;
5. the profile directory and file are classified with `lstat`, so a link is seen
   rather than followed; either being a link is `REPOSITORY_PATH_UNSAFE`;
6. the file must be a regular file within a 256 KiB ceiling, and its canonical
   path must still be the joined one and still contained in the root;
7. it must parse as YAML and satisfy the contract;
8. every declared path is re-checked for containment against the canonical root;
9. the default branch must be a legal Git branch name (`check-ref-format` rules,
   implemented in-process) **and** must exist locally;
10. every `REQUIRED` capability must be positively available;
11. the remote expectation must hold.

The result is a deeply frozen `ResolvedRepository`. No raw YAML object is
carried through it, so no later step can re-derive a policy from the document.

Git is used **read-only** — `rev-parse` and `remote`, nothing else. No branch,
worktree, checkout, commit, fetch or push happens here. Execution goes through
the same hardened `runCommand` the doctor uses, and the child environment is
`createProbeEnv('capability:generic', …)`: `PATH` and `PATHEXT` and nothing
else. That is what a `git` process needs to start, and it is also what keeps
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_CEILING_DIRECTORIES`, `GIT_CONFIG_*` and every
other `GIT_*` variable out of the child, so which repository answers is decided
by the canonical path this module passes and by nothing in the environment.

**`process.cwd()` is never consulted.** The caller states the repository; a
relative or empty input is `REPOSITORY_PATH_INVALID` even when the working
directory *is* a valid repository. `tests/repo-resolution.test.ts` resolves the
same fixture from three different working directories and requires an identical
answer.

### CodeGraph capability

The profile declares `REQUIRED` or `OPTIONAL`. `REQUIRED` is fail-closed:
resolution refuses with `REQUIRED_CAPABILITY_UNAVAILABLE` unless the capability
is *positively* proven. `OPTIONAL` records what was observed and resolves either
way.

The probe answers one question honestly — **does this repository carry a
CodeGraph index?** — by looking for a real `.codegraph` directory at the
canonical root, in-process, with no subprocess and no environment value. A
symlink there is not followed and yields `UNKNOWN`.

The status vocabulary is named after that evidence and nothing beyond it:

| status | what was observed | what it does **not** claim |
| --- | --- | --- |
| `INDEX_PRESENT` | a real `.codegraph` directory at the canonical root | valid index contents, a *fresh* index, a configured MCP server, or a reachable `codegraph_explore` tool |
| `UNAVAILABLE` | no local index there | — |
| `UNKNOWN` | the probe could not conclude (a link, a permission failure, an I/O error) | — |

The positive member is `INDEX_PRESENT` rather than `AVAILABLE` deliberately.
`AVAILABLE` reads as "the capability can be used", and a consumer written
against that reading would be relying on something no code in this build
measures: the orchestrator runtime is not the agent session that owns the MCP
tools and cannot call one, so asserting reachability would be a fabricated pass.
The name was corrected before the first consumer existed, so nothing had to be
migrated. When a later slice can actually prove tool reachability, it earns a
second status of its own; it does not redefine this one.

So `REQUIRED` in a profile means **this repository must carry a local CodeGraph
index**, which is what the resolver can check. `UNKNOWN` never satisfies it —
"could not be determined" is representable rather than rounded to either answer —
and an `OPTIONAL` capability that is unavailable still resolves.

### Failure codes

Failures are data, never exceptions. Every expected condition returns a code
from a closed set together with a static sentence written in this repository:

`REPOSITORY_PATH_INVALID`, `REPOSITORY_NOT_FOUND`, `REPOSITORY_NOT_DIRECTORY`,
`REPOSITORY_PATH_UNSAFE`, `GIT_UNAVAILABLE`, `NOT_A_GIT_REPOSITORY`,
`REPOSITORY_ROOT_MISMATCH`, `PROFILE_MISSING`, `PROFILE_NOT_REGULAR_FILE`,
`PROFILE_TOO_LARGE`, `PROFILE_READ_FAILED`, `PROFILE_PARSE_FAILED`,
`PROFILE_SCHEMA_INVALID`, `DEFAULT_BRANCH_INVALID`, `DEFAULT_BRANCH_NOT_FOUND`,
`REQUIRED_CAPABILITY_UNAVAILABLE`, `REMOTE_REQUIRED_BUT_ABSENT`.

Nothing is interpolated into those sentences: not the repository path, not the
profile path, not the branch name, not a Zod issue message, not a YAML or `fs`
exception. Those messages quote paths, command lines and the offending input
itself, which is the class of value `src/core/safe-error.ts` exists to keep out
of user-facing output. `PROFILE_SCHEMA_INVALID` additionally carries an
`issueCount` — a count, not the issues.

## The task-selection contract

The repository profile *declares* where tasks live. This is the layer that
reads them, and turns them into one decision: **which task now?**

It is a planning layer only. Selecting a task neither starts it nor writes
anything: no worktree, no branch, no `TaskState`, no Git call at all.

### `TaskDefinition` is not `TaskState`

The two contracts are deliberately unrelated, and the separation is enforced by
a test rather than by convention:

| | `TaskDefinition` (`src/plan/`) | `TaskState` (`src/core/`) |
| --- | --- | --- |
| what it is | the **static plan** a repository wrote down | the **runtime record** of one task run |
| who writes it | a human, in the repository | the orchestrator |
| how many | one per task file, many per repository | exactly one per task |
| versioned | no — it is read, never persisted by this tool | yes, `TASK_STATE_SCHEMA_VERSION` |
| fields | `id`, `title`, `status`, `kind`, `priority`, `currentFocus`, `dependsOn` | states, rounds, commits, worktree, resume point, findings |

Neither module imports the other. `TaskState` gained no `dependsOn`, `priority`,
`currentFocus` or `kind`; `TaskDefinition` carries no state, no round, no commit
and no `schemaVersion`. Merging them would have produced a value that is
simultaneously a plan and a state — one in which a repository's markdown could
assert a runtime fact.

### What a task file looks like

Every task is exactly one `<id>.md` file directly inside the declared
`MARKDOWN_DIRECTORY`. There is no recursion, so an `archive/` subdirectory is
not a task source.

```markdown
---
id: V1-02
title: Task source and deterministic selection
status: OPEN            # or DONE
kind: NORMAL            # or REMEDIATION
priority: HIGH          # or NORMAL, LOW
currentFocus: true
dependsOn:
  - V1-01
---

Optional prose for a human reader.
```

Every field is required; nothing is defaulted on the repository's behalf, and
unknown keys are refused. **The body is never interpreted** — it contributes no
dependency, no priority and no focus. There is no markdown heuristic and no
natural-language extraction anywhere in this layer, because a plan that could be
changed by rewording a paragraph would make the orchestrator's behaviour a
function of prose.

`currentFocus` is a ranking signal and explicitly *not* a singleton: any number
of tasks may claim focus, and the ranking decides between them.

### Identifiers, and the filename they imply

A task id matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` — so `V1-02`, `AO-008`
and `AO-008-S2-R1` are ids, while anything carrying a path separator,
whitespace, a control character or a shell metacharacter is not. Three further
refusals are Windows-shaped: `.` and `..`, a **trailing dot** (Windows strips
it when opening a file, so `V1-02..md` and `V1-02.md` would be one file with two
ids), and a **reserved device name** in any case — `NUL.md` is not a file on
Windows but the null device, and reading it would succeed and yield nothing.

The filename must be exactly `<id>.md`, lowercase extension, and the frontmatter
`id` must agree with it exactly. A `V1-02.md` declaring `id: V1-03` is
`TASK_ID_FILENAME_MISMATCH`; there is no implicit renaming in either direction.

An id is the only piece of repository-authored task text that travels: it is the
one value a planning failure carries, precisely because it has passed that
grammar. A title, a filename or a path never appears in a failure.

### Discovery, and its safety rules

The task source is located from `ResolvedRepository.root` — **`process.cwd()` is
never consulted** — and then checked afresh, because V1-01 proved only that the
declared string was containable, not that anything exists:

1. the directory is classified with `lstat`, so a link is seen rather than
   followed; a link is `TASK_SOURCE_PATH_UNSAFE`;
2. it must exist and be a directory;
3. its canonical `realpath` must still be the joined path and still contained in
   the canonical root;
4. only **direct children** ending in a lowercase `.md` are candidates —
   `.MD`, `.markdown` and `.md.bak` are not task files and are ignored;
5. candidates are sorted **by id before any of them is opened**, so which file
   is read first, and therefore which failure is reported first, is a property
   of the repository rather than of the filesystem;
6. every candidate is `lstat`-classified, size-capped and re-canonicalised the
   same way. A link, a directory that merely ends in `.md`, or a file whose
   canonical path is not itself, is `TASK_FILE_UNSAFE`.

**An empty task source is `TASK_SOURCE_EMPTY`, never `ALL_TASKS_COMPLETE`.**
That is the most important negative result in the layer: the other reading would
turn a mistyped path, or a directory that never got committed, into a confident
report that the work is finished.

### Frontmatter safety

A task file is untrusted repository input, so its frontmatter goes through the
same hardened YAML boundary the repository profile uses. Those rules moved into
`src/yaml/safe-yaml.ts` in this slice — plain YAML 1.2 core schema, merge keys
off, a warned document refused, errors read from the document rather than
caught, one document rather than a silently truncated stream, an explicit alias
budget, and `__proto__` refused at any depth *before* any JavaScript object
exists. The extraction changed none of V1-01's behaviour; it made two boundaries
share one policy instead of two that could drift apart.

On top of that, the frontmatter must be delimited exactly: `---` on the very
first line, and a closing line that is exactly `---`. A BOM is stripped first,
CRLF is accepted. The block is capped at 8 KiB and the file at 256 KiB — the
budget is measured on the frontmatter, so a long human-written body never costs
a task its validity.

### The dependency DAG

`dependsOn: [A]` on task `B` means the edge **A → B**: A must be `DONE` before B
becomes eligible. The graph is normalised from the ids alone — tasks sorted by
id, both edge lists sorted by id, and a topological order that breaks its own
ties by id — so the same tasks produce one identical graph whatever order they
arrived in. Nothing mutable is handed out.

Validation is whole-set and fail-closed. Nothing is repaired: a cycle is not
broken by dropping an edge, an unknown dependency is not ignored, and a
duplicate id does not resolve to "last one wins".

| code | meaning |
| --- | --- |
| `TASK_GRAPH_EMPTY` | no definitions at all |
| `TASK_GRAPH_TOO_LARGE` | more than 512 tasks |
| `TASK_ID_DUPLICATE` | two tasks claim one id — **including ids differing only in case**, which cannot both exist on Windows |
| `TASK_DEPENDENCY_SELF` | a task lists itself |
| `TASK_DEPENDENCY_UNKNOWN` | a dependency names no declared task |
| `TASK_GRAPH_CYCLE` | the edges contain a cycle |

The graph layer re-checks the self-dependency rule that `TaskDefinitionSchema`
already enforces. It is typed to receive validated definitions but does not rely
on that: a builder that assumed its input was validated is one refactor away
from being wrong, and its failure mode is an orchestrator acting on a plan that
is not one.

### Eligibility and selection

A task is **eligible** when it is `OPEN` and every task it depends on is `DONE`.
The two ways of not being eligible are reported separately, because they mean
opposite things to an operator: `ALREADY_DONE` is finished work,
`BLOCKED_BY_DEPENDENCIES` is waiting work — and the dependencies it waits for
are named.

Eligible tasks are ordered by a five-element tuple, compared most-significant
first:

1. **kind** — `REMEDIATION` before `NORMAL`. Starting new work while a known
   defect stands is how a plan accumulates unfinished corrections.
2. **`currentFocus`** — focused first. Priority is a standing property of a
   task; focus is a statement about *now*, so it outranks priority.
3. **priority** — `HIGH`, `NORMAL`, `LOW`.
4. **unlock count**, descending — the number of distinct not-yet-`DONE` tasks
   that *transitively* depend on this one. Between otherwise equal tasks, the
   one that releases more blocked work goes first.
5. **id**, ascending by UTF-16 code unit (never `localeCompare`, which would
   make the winner a function of the operator's Windows region setting).

The id is unique, so the order is **total**: no two eligible tasks can tie and
no residual choice is left to an implementation detail. The selection outcome
carries the ranking and the full eligibility report alongside the winner — the
reasoning is part of the answer.

| outcome | meaning |
| --- | --- |
| `TASK_SELECTED` | one task chosen; it is the head of the published ranking |
| `ALL_TASKS_COMPLETE` | the plan is non-empty and every task is `DONE` |
| `NO_ELIGIBLE_TASK` | a fail-closed floor, not a reachable state |

`NO_ELIGIBLE_TASK` cannot occur for a graph this layer accepts: in an acyclic
graph whose dependencies all resolve, the topologically first `OPEN` task can
have no `OPEN` dependency, so an eligible task always exists. It is kept so that
a future rule which broke that argument would surface explicitly instead of
being rounded to `ALL_TASKS_COMPLETE`. A test asserts the unreachability over a
hundred generated graphs.

### Failure codes

As everywhere else, failures are data and carry a static sentence written in
this repository, never an interpolated path, filename, title, Zod issue or `fs`
exception:

`TASK_SOURCE_NOT_FOUND`, `TASK_SOURCE_NOT_DIRECTORY`, `TASK_SOURCE_PATH_UNSAFE`,
`TASK_SOURCE_READ_FAILED`, `TASK_SOURCE_EMPTY`, `TASK_FILE_NAME_INVALID`,
`TASK_FILE_UNSAFE`, `TASK_FILE_TOO_LARGE`, `TASK_FILE_READ_FAILED`,
`TASK_FRONTMATTER_MISSING`, `TASK_FRONTMATTER_MALFORMED`,
`TASK_FRONTMATTER_TOO_LARGE`, `TASK_FRONTMATTER_FORBIDDEN_KEY`,
`TASK_DEFINITION_INVALID`, `TASK_ID_FILENAME_MISMATCH`, plus the six graph codes
above. A failure additionally carries the offending `taskId` where there is one,
and an `issueCount` — a count, not the issues.

`schemas/task-definition.schema.json` is generated from the same Zod source by
`npm run schema:generate` and is drift-checked against it, exactly like the
state and profile documents. The task-state schema was not touched.

## The workspace-lifecycle contract

V1-03 answers one question, for one selected task:

> can this task be given a safe isolated workspace, and if so, what exact
> branch, worktree and base commit belong to it?

It takes a `ResolvedRepository` (V1-01) and a `TaskDefinition` (V1-02) and
produces a `WORKTREE_READY` receipt describing a real `git worktree`. It writes
no state file, loads no context, runs no verification, starts no agent and
touches no forge. V1-04 persists and reconciles the receipt.

### Identity is derived, never assigned

`deriveTaskWorkspaceIdentity()` is a pure function of the repository root, the
declared default branch and the task id. No timestamp, no counter, no random
suffix, no `process.cwd()`:

```
branch     ao/task/<task id>
worktree   <parent of root>/<name of root>.worktrees/<task id>
```

Determinism is what lets a later step *re-derive* a workspace instead of
trusting a path someone wrote down, and it is what makes cleanup safe: removal
recomputes the name and refuses anything that does not match, so there is no
parameter for "the directory to delete".

The workspace is a **sibling** of the repository, never a directory inside it.
Inside would put a second checkout in the tree a writer agent is about to work
in, where it would appear in `git status`, in every glob a verification command
expands, and in the scope rules the profile declares.

A task id is repository-authored text that already passed V1-02's grammar — but
that grammar describes a *filename*, and a filename is not a branch name.
`V1..03`, `spec.lock` and `release.` are all legal task ids and none of them is
a legal Git branch. The derived name is therefore validated with the same
`isValidBranchName` a profile's default branch must pass, and anything that
fails is refused rather than slugified: a silent rewrite would break
re-derivation, which is the whole point.

The derived path must also be acceptable as a Git *argument* under the
execution layer's shell-inert grammar (AO-008). A repository checked out under a
path containing a space therefore cannot be given a workspace by this build, and
says so with `WORKTREE_PATH_UNSAFE` rather than provoking the
`UnsafeArgumentError` that `doctor/exec.ts` documents as a programming error.
Git is not the limit here; this build is.

### The base commit is pinned, and pinned first

The default branch is read once, resolved to a full object name, and the
worktree is created **at that object name** — not at the branch. Between the
read and the create, a concurrent fetch, merge or reset can move the branch; a
worktree created "at the branch" would silently start from wherever it had got
to, and the receipt would name a commit the work is not based on. Post-create
verification then confirms `HEAD` is exactly the pinned object, so a branch that
moves mid-flight produces a refusal, never a wrong base.

### Refusal means nothing happened

Every check runs before anything is created, so a refusal always leaves the
repository exactly as it was found. The one exception is post-create
verification: if it fails, the worktree this call created is removed again — and
if *that* removal fails, the outcome says `WORKTREE_ROLLBACK_INCOMPLETE` and
sets `residue: true` rather than reporting a clean refusal over a half-built
workspace.

### Cleanup requires proof of ownership

`removeTaskWorkspace()` deletes nothing until three things hold:

1. the branch and path are **re-derived**, not supplied;
2. Git registers a worktree at that exact path, with that exact task branch
   checked out — a directory that merely sits at the right path, and a
   registered worktree holding another branch, are both refused;
3. nothing unsaved would be lost: the worktree must be clean, and the task
   branch must contain no commit the base branch does not already have.

`git worktree remove` is never given `--force` and `git branch -d` never becomes
`-D`. There is deliberately no option to force: discarding real work is a
decision for a human with Git, not an orchestrator primitive.

The third proof reads an exit status, and it is the one place in this slice that
does, so the protocol is stated rather than assumed. `git merge-base
--is-ancestor` exits **0** for "yes", **1** for "no", and **anything else**
(128 in practice) when it could not evaluate the question at all — a ref that no
longer resolves, say. Only exit 1 is an answer. Collapsing every non-zero into
one bucket would let "the base branch is gone" be reported as "your task branch
holds unmerged work", which is not merely vaguer but false; a deleted base is
therefore its own outcome, and an unevaluable probe is `GIT_UNAVAILABLE`.

### Failure codes

Failures are data and carry a static sentence, never an interpolated path, task
id or Git output.

Preparation: `TASK_ID_INVALID`, `REPOSITORY_ROOT_UNSUITABLE`,
`BASE_BRANCH_INVALID`, `TASK_BRANCH_NAME_INVALID`, `WORKTREE_PATH_UNSAFE`,
`GIT_UNAVAILABLE`, `REPOSITORY_ROOT_MISMATCH`, `SOURCE_BRANCH_UNEXPECTED`,
`SOURCE_WORKTREE_DIRTY`, `BASE_BRANCH_NOT_FOUND`, `BASE_COMMIT_UNRESOLVED`,
`TASK_BRANCH_EXISTS`, `WORKTREE_PATH_OCCUPIED`, `WORKTREE_ALREADY_REGISTERED`,
`WORKTREE_PARENT_UNUSABLE`, `WORKTREE_CREATE_FAILED`,
`WORKTREE_VERIFICATION_FAILED`, `WORKTREE_ROLLBACK_INCOMPLETE`.

Removal: the five identity codes, plus `GIT_UNAVAILABLE`, `WORKTREE_NOT_OWNED`,
`WORKTREE_DIRTY`, `TASK_BRANCH_HAS_UNMERGED_WORK`, `BASE_BRANCH_NOT_FOUND`,
`WORKTREE_REMOVE_FAILED`. `BASE_BRANCH_NOT_FOUND` carries the same meaning it
does during preparation — a code means one thing wherever it is read.
Success is `WORKSPACE_REMOVED`, or `WORKSPACE_PARTIALLY_REMOVED` when the
worktree went and the owned branch did not — reported as its own outcome so a
leftover branch is never invisible.

### The Git seam

`src/worktree/git-command.ts` is the one place in this slice that may *change* a
repository, and it is injectable. It is deliberately separate from
`repo/git-query.ts`, which opens by promising it writes nothing — routing a
`worktree add` through it would retract that promise for every existing caller.
Both share the same posture: no shell, an argument vector, no inherited `GIT_*`
environment, bounded output and wall clock, failures as data.

This is the broader Git seam that V1-01's review item **RR-F6** was deferred
against. It covers this slice's own Git access; `repo/git-query.ts` still has no
injection point, so V1-01's `GIT_UNAVAILABLE` path remains without a
deterministic test. Closing RR-F6 fully means threading an injectable runner
through `resolveRepository`, which is a change to the V1-01 contract and is left
as its own decision rather than folded into this slice.

### What V1-03 is not

`READY_FOR_PR` remains terminal and gained no outgoing transition. No state was
added to `src/core/states.ts`: `WORKTREE_READY` was already in the vocabulary,
and this slice produces the value a task in that state describes — it does not
persist one. Nothing here opens a pull request, pushes, fetches, or reads CI.

## The state-persistence and reconciliation contract

V1-04 is the first slice that *writes down* what a run believed and then checks
that belief against the world on the way back in. It answers one question: what
did the orchestrator previously persist, what does Git actually look like now,
and is it safe to continue?

`TaskState` itself is unchanged. `TASK_STATE_SCHEMA_VERSION` is still `1` and
`schemas/task-state.schema.json` is byte-identical — this slice persists the
existing contract rather than extending it.

### Where a state lives

    <canonical repository root>/.agent-orchestrator/runtime/<taskId>.json

The same shape, and the same reasoning, as the repository profile: exactly one
location, no fallback name, no fallback extension, no upward search and no
environment override. The path is a pure function of `ResolvedRepository.root`
and the task id, and is never derived from `process.cwd()`.

State belongs to the repository it describes, so it sits under the directory
that already holds the orchestrator's per-repository files. A checkout carries
its own runtime record: copy the repository and it comes along, delete it and it
goes, and two checkouts of one project never share a record. That is also why
the path carries **no `repositoryId` segment** — the repository root *is* the
identity, and an id in the path would be a second, weaker spelling of it that
could disagree with the directory it sits in.

`runtime/` rather than something beside `repo-profile.yaml` without
distinction: the profile is authored and reviewed, this is machine-written
per-run data, and the directory name says which is which. It is expected to be
ignored by the repository's VCS — nothing here creates or edits an ignore rule.

`taskId` is repository-authored text and this is where it becomes a path
segment, so it is re-checked against V1-02's canonical grammar; a failure is
refused with `TASK_ID_UNSUITABLE`, never slugified or truncated.

The name is judged by the state layer's own `isStateFileName`, deliberately
*not* by `doctor/safe-write.ts`'s `isPlainFileName`. Sharing that helper would
have imported the artefact writer's unrelated 64-character budget into the
task-id contract, so ids the planner accepts and V1-03 can build a workspace for
— anything past 59 characters, once `.json` is appended — could never be written
down at all. A task that can be started and never checkpointed is worse than one
that is refused up front. The safety properties are unchanged, because they come
from the task-id grammar itself: one plain segment, no separators, no traversal,
no absolute path, no trailing dot, no Windows device name, plus a containment
proof on the derived path. Only the length budget is the storage layer's own,
and it is derived from `MAX_TASK_ID_LENGTH` rather than chosen.

### Absolute paths, or no comparison at all

A non-absolute root is refused with `REPOSITORY_ROOT_UNSUITABLE` rather than
resolved, because resolving it is exactly the `process.cwd()` dependency this
must not have — and the same rule governs every *comparison* of two paths.
`core/path-identity.ts` is the single such comparison in the codebase, and it is
three-valued on purpose:

| Input | Answer |
| --- | --- |
| two absolute paths | `EQUAL` / `DIFFERENT` |
| anything relative or blank | `NOT_ABSOLUTE` — a refusal, never an equality |

It normalises rather than resolves: `.`/`..` segments are folded, separator
shape is unified, a trailing separator is dropped and Windows casing is ignored,
but nothing is ever measured against the current working directory. Without
that, a persisted `repositoryRoot` of `"."` would compare *equal* to whichever
checkout the process was launched from, and one project's record could be
accepted, resumed and overwritten as another's. A relative recorded root is
therefore refused: `REPOSITORY_ROOT_MISMATCH` on save (detail
`REPOSITORY_ROOT_NOT_ABSOLUTE`), and `REPOSITORY_ROOT_NOT_ABSOLUTE` on load. A
save whose state describes a different repository than the root it is being
filed under is refused with `REPOSITORY_ROOT_MISMATCH` as before.

### Writes are atomic; `doctor/safe-write.ts` is not reused for them

`writeRunArtifact` is deliberately append-only — it opens each artefact `wx`
under its final name and documents that nothing is ever replaced. That is right
for a run artefact and wrong for a checkpoint, which is rewritten at every
transition over a file whose previous contents are the only thing standing
between a killed process and a lost task.

So `src/state/atomic-file.ts` exists alongside it and *imports* the shared
safety posture rather than restating it: `isPlainFileName`, `isContained`,
`pathContainsLink` and `safeErrnoCode` all come from the existing modules.

The guarantee is that after a write returns, the file holds **either** its
previous complete contents **or** the new complete contents. Contents go to a
temporary file *in the same directory* — `rename` is only atomic within a
filesystem — which is flushed, closed, and only then moved onto the target in
one step. The target is never opened for writing, never truncated and never
unlinked, so every failure before the rename could not have touched it. A
failure removes the staging file; a *crash* may leave one, which is inert
because readers open the target by name and never enumerate the directory.

### Loading is validation

A persisted file is untrusted input, whoever wrote it. Every load answers with
one of four classifications — `STATE_MISSING`, `STATE_VALID`, `STATE_INVALID`,
`STATE_MISPLACED` — alongside a precise code from a closed exported set.

Rejected as `STATE_INVALID`: anything at the path that is not a regular file; a
document larger than the 1 MiB read budget; malformed JSON; an unsupported
`schemaVersion`; an unknown field, since the contract is `.strict()`; an invalid
state enum; anything else the canonical `TaskStateSchema` rejects; and a
recorded repository root that is not absolute, which cannot be compared at all.

`STATE_MISPLACED` is kept apart from that list, and this is the distinction the
composed outcome below depends on. `REPOSITORY_ROOT_MISMATCH` and
`TASK_ID_MISMATCH` are reported separately from each other and from
`STATE_INVALID`, because a well-formed state found in the wrong place is not a
broken document — it is an intact record of something else. Calling it
"invalid" would send an operator looking for corruption instead of for the
copied checkout or the crossed-over task that actually happened, and the two
mismatches have different causes and different repairs. Both are provable
without resolving anything, so both are refused at load rather than deferred.

No raw parser, JSON or filesystem text ever reaches a result. Only closed codes
and allow-listed errno identifiers, per AO-002.

### Nothing is ever repaired

`loadTaskState()` performs no writes on any path. A malformed, stale or
unsupported state file is reported and left exactly as found. Not migrated, not
truncated, not renamed aside, not deleted.

The same restraint applies to the writer: a failed write removes *only* the
staging file it created itself, by the exact path it constructed. The state
directory is never enumerated and no other temporary file is ever touched — a
concurrent writer's in-flight staging file is none of our business.

That is a refusal, not an omission. Every repair is a guess about what the
previous run meant, made when the evidence for it is weakest, and it destroys
that evidence in the process. The contract is applied on both sides of the disk:
a state that violates it is never written, because a self-contradictory state
that survives a restart is indistinguishable from a real one.

### Creation and movement are different operations

`saveTaskState()` validates a state *in isolation*. That is right for it — the
first state a task ever has must be writable and has no predecessor — but it
means it cannot see the one thing that makes a move legal: where the task came
from. `TaskStateSchema` accepts a `CREATED` document and an `IMPLEMENTING`
document equally; only the transition table knows the second may not directly
follow the first.

So the two are separate:

- `saveTaskState()` — **creation**, a state with no predecessor;
- `advanceTaskState()` — **movement**, which requires the state that was read
  and consults `canTransition()` before writing anything, refusing an
  undeclared edge with `ILLEGAL_TRANSITION`.

The table is consulted, never restated: a new edge is added in
`core/transitions.ts` or nowhere. Re-persisting the *same* state is a
checkpoint rather than a move — no state lists itself as its own successor, so
requiring a declared edge would make recording progress impossible — and only a
genuine change is checked.

This is the persistence primitive the runtime loop will call. It is not the
loop: nothing here decides which state comes next, runs an agent, or reads a
repository.

### Concurrent writers

Two orchestrator processes may be pointed at the same task. Neither is expected
to win a race, but the loser must *know* it lost rather than silently flattening
the winner's work.

`loadTaskState()` returns a `revision` — a content digest of the exact bytes it
read — and `saveTaskState()` takes it back as `expectedRevision`. A save whose
expectation no longer matches what is on disk fails with `STATE_CONFLICT` and
writes nothing. A digest rather than a counter: it needs no field in `TaskState`,
it cannot drift from the file it describes, and two writers that independently
produce byte-identical states correctly do not conflict.

**Bytes, never decoded text.** The digest is taken over the raw bytes, not over
the string they decoded to, because decoding is lossy in exactly the direction
that matters: every invalid UTF-8 sequence — an overlong encoding, a surrogate
half, a truncated character — decodes to the same replacement character, so two
files that differ on disk can decode to one identical string. Hashing that
string would hand both the same revision and wave a stale writer straight
through the check that exists to stop it.

### One bounded raw-byte read

There is exactly one way this module reads a persisted state, and both the
loader and the compare-and-swap go through it: open the canonical path, `fstat`
the *handle* (so the thing measured and the thing read cannot be two different
files), refuse anything that is not a regular file or is past the 1 MiB budget,
read that many bytes, and hand them back undecoded. Digesting happens on those
bytes; decoding and parsing happen afterwards, separately.

The write side is the same budget seen from the other direction. `saveTaskState`
validates, serialises, encodes the exact bytes it would persist and checks their
length **before touching the filesystem at all** — before the runtime directory,
before a staging file, before the revision check. A schema-valid state can
serialise past the budget (an unbounded `findingHistory` will do it), and
writing one would checkpoint a task into a file this same build refuses to load:
permanently unrecoverable, by our own hand. It is refused with
`STATE_TOO_LARGE`, and nothing is created. An *existing* oversize document is
likewise refused rather than read: the compare-and-swap answers
`STATE_CONFLICT` with detail `CURRENT_STATE_TOO_LARGE` and replaces nothing,
because a file we may not read is a file we cannot prove is ours to overwrite.

Omitting `expectedRevision` does **not** mean "overwrite whatever is there" — it
means "I read nothing, so I expect nothing", and the save is refused if a state
already exists. There is deliberately no force flag: an unconditional overwrite
is the operation this mechanism exists to prevent.

This is optimistic concurrency, and the residual window is stated rather than
papered over. Between the compare and the `rename` a third writer could land its
own state. Closing that entirely needs a lock, and a lock is a service — owner,
lease, timeout, and a recovery story for the process that died holding it. The
window is one `rename` wide and corrupts nothing: the loser's file is complete
and valid, merely superseded. What this actually defends against is the writer
that read a state minutes ago, went away to run an agent, and came back to
persist a conclusion drawn from a world that has since moved.

### Reconciliation, and two ways to fail

Reconciliation consumes the freshly **resolved repository**, the selected
**task id**, the validated persisted state, and current Git/worktree
observations. A state file that parses cleanly proves only that something wrote
valid JSON — persisted Git facts are never trusted because the document is
well-formed. `repositoryId`, `repositoryRoot`, `taskId` and `baseBranch` are
compared against resolved reality *first*, and for every state rather than only
on the unattended-resume path: a state resumed into the wrong repository is the
one failure this slice exists to make impossible, and that must not depend on
which state the task happens to be in. Roots are compared as paths, so separator
shape, a trailing separator and Windows' case-insensitivity do not read as
divergence.

`observe-runtime.ts` asks Git and the filesystem what is true now and changes
nothing; `reconcile.ts` is the only place those facts meet the persisted record.
Splitting them is what keeps "we could not find out" from becoming "we found out
that it is false".

`DIVERGED` means the world contradicts the record — the worktree is
unregistered or gone, another branch is checked out, HEAD moved, the base pin is
no longer an ancestor, there is uncommitted work. `UNOBSERVABLE` means the world
could not be read. Both refuse, so collapsing them would change no decision —
which is exactly why they stay apart: they are shown to a human, and "your base
commit was rewritten" is the wrong thing to say when the truth is that Git could
not be run. A false reason is worse than none. In the same spirit, an unreadable
registry is never reported as proof that the worktree is unregistered.

The base pin is checked with `merge-base --is-ancestor`, whose exit status is
its answer, on the protocol `remove-workspace.ts` already documents: `0` yes,
`1` a genuine no, anything else a refusal to evaluate. The happy path costs one
Git call; only an indeterminate answer pays for a second probe asking whether
the pinned object still exists at all — and that probe reads its own exit status
under the same discipline. `rev-parse --verify --quiet` exits `1` to say "does
not resolve" and `128` when it could not evaluate the question, so only `1` is
read as absence. Everything else — an unexpected exit, Git unavailable, a
refused argument — is `null`, and the reconciler reports
`BASE_COMMIT_UNVERIFIABLE` rather than `BASE_COMMIT_ABSENT`. An indeterminate
failure turned into proof of absence would send an operator hunting for a
force-push that never happened.

### Git's registry is the authority; the record is only a claim

A persisted `worktreePath` is a sentence in a file. Running `git status` inside
it — or `rev-parse`, or anything — before Git has confirmed that directory *is*
this task's worktree means executing somewhere nothing has vouched for: a stale
record, a hand-edited file or a state copied from another machine would each be
enough to point the probes at somebody else's checkout.

So the order is fixed, and each step gates the next:

1. read `git worktree list --porcelain` for the repository;
2. the registry must itself be readable — an unreadable one authorises nothing;
3. find the registration for the recorded path (a *comparison*, which is all the
   recorded path is ever used for);
4. confirm that registration holds this task's own work branch, judged on the
   ref Git printed;
5. only then, and only at **the path Git printed**, ask the filesystem whether
   the directory exists and ask Git for HEAD, cleanliness and ancestry.

Where any step fails, the dependent observations stay `null` — "never
established" — and the reconciler never reads a `null` as a `false`. In
particular `worktreeExists` is tri-state: `false` means Git named a directory
and it is not there, and that is divergence; `null` means the question was never
asked, and the unreadable registry or absent registration is reported as itself
instead. This mirrors the three proofs `worktree/remove-workspace.ts` requires
before it deletes anything, for the same reason.

### Git reality is phase-sensitive

Two of those checks have no phase-independent answer, and asking them globally
is how a reconciler starts reporting the loop's own work as divergence.

`HEAD == basePinnedCommit` is **not** a task-wide invariant. It is the truth for
a worktree that has just been created and nothing more; from `IMPLEMENTING`
onwards the writing agent legitimately commits into it. Uncommitted work is the
same story: an interrupted `IMPLEMENTING` is *supposed* to have some, and
refusing every dirty worktree would make the ordinary crash — the one this slice
exists to survive — permanently unresumable.

So both are asked against what the record claims, and fall back to a phase
expectation only for a worktree in which nothing can yet have run:

| Phase | Expected `HEAD` | A dirty worktree is |
| --- | --- | --- |
| `WORKTREE_READY`, `CONTEXT_LOADING`, **with no prior-work evidence** | `currentCommit`, else `basePinnedCommit` | always divergence |
| the same two phases **re-entered after a block**, and `IMPLEMENTING` onwards | `currentCommit` when recorded; otherwise no exact expectation | divergence only when the checkpoint recorded a clean tree |

Those two pre-work phases are read off `TRANSITION_TABLE`, not chosen:
`WORKTREE_READY` is entered from `GIT_PREFLIGHT` the moment V1-03 created the
worktree at the pin, and `CONTEXT_LOADING` has `WORKTREE_READY` as its sole
predecessor and `IMPLEMENTING` as its sole work successor. The two
direct-predecessor facts are pinned by a test, so a table change that
invalidated them fails rather than drifts.

But the phase name alone is not the question, because
`BLOCKED_AUTH → AUTH_PREFLIGHT → GIT_PREFLIGHT → WORKTREE_READY` is a *declared
path*: re-authenticating genuinely re-enters the setup chain, and a task that
walks it after days of implementation arrives at `WORKTREE_READY` carrying
commits and often uncommitted work. Judging that arrival as a freshly created
worktree would report the loop's own work as corruption at the exact moment an
operator has just repaired the thing that blocked it.

So the fallback applies only to a **virgin** pre-work state: the phase, *and* no
evidence of work in the record. The evidence is what `TaskState` already
carries — a `resumeFrom` (which `BLOCKED_AUTH` requires and the re-entry path
exists to carry through), a checkpointed `currentCommit`, `reviewRound > 0`, or
a non-empty `findingHistory`. No new field, no event history, and no second
workflow. `worktreeCleanAtCheckpoint === false` is deliberately *not* evidence:
letting a dirty checkpoint excuse itself would accept a dirty tree in a phase
where nothing could have dirtied it.

What is still refused after an auth cycle: a HEAD that no longer descends from
the pinned base, a HEAD that contradicts a recorded `currentCommit`, somebody
else's branch in the worktree, and uncommitted work the checkpoint said was not
there.

What stays global is the invariant that actually holds everywhere: the work must
still descend from the pinned base. And none of this widens autonomy —
`evaluateAutomaticResume()` independently requires an exact recorded
`currentCommit`, a clean tree *and* `worktreeCleanAtCheckpoint === true`, and is
neither wrapped nor weakened by reconciliation.

### One closed outcome

`reconcileTask()` composes load, observation and comparison into a single value
a caller can branch on without re-deriving it:

| Outcome | Meaning |
| --- | --- |
| `RECONCILED` | the only outcome anything may continue from |
| `NO_PERSISTED_STATE` | the task has never run — the normal start, not an error |
| `STATE_INVALID` | something is there and it is not usable as state |
| `STATE_REPOSITORY_MISMATCH` | well-formed, but about a *different* repository |
| `STATE_TASK_MISMATCH` | well-formed and about this repository, but a different task |
| `STATE_DIVERGED` | the world contradicts the record |
| `STATE_UNOBSERVABLE` | the world could not be read |

The derivation is where mistakes live, which is why it happens once, here.
"Nothing persisted" and "unreadable state" both invite the same `if (!loaded)`,
and a wrong repository invites being folded in with "someone committed since we
last looked". A repository mismatch therefore outranks every other finding: it
is not a repository that drifted, it is the wrong repository, and continuing
would apply one project's work to another. A task mismatch ranks next, and stays
its own outcome rather than collapsing into either neighbour: a copied checkout
and two crossed-over tasks of one project are different accidents with different
repairs, and neither is a corrupt document.

### One deterministic decision

`classifyResume()` returns exactly one classification, in a fixed order, with no
clock and no I/O of its own: terminal states first (a finished task is not a
resume question), then reconciliation, then the block. Judging the block first
would grant "resume allowed" for a task whose worktree is gone and then need
overriding — a decision made twice is one that can disagree with itself.

### Reconciliation is not permission

The result carries **two** fields, because they answer two questions:
`classification` says what the situation is, and `continuation` says what may be
done about it. Nothing named in the first suggests a machine may act on it.

| `continuation` | Meaning |
| --- | --- |
| `TERMINAL` | the task is over; there is nothing to continue |
| `BLOCKED` | nothing continues until something changes — the record and reality disagree, or the unattended-resume authority denied it |
| `ATTENDED_ONLY` | a human may continue this; a machine may not do so alone |
| `AUTOMATIC_ALLOWED` | unattended execution is permitted |

`AUTOMATIC_ALLOWED` has exactly one source: an `AutomaticResumeDecision` from
`evaluateAutomaticResume()` with `allowed === true`. It is not derivable from a
classification, from a `CONSISTENT` reconciliation, or from any combination of
the two, and a test pins that equivalence in both directions.

This is why there is no `RESUME_READY`. A single status meaning "everything
checks out" invites a future caller to read it as "carry on" — and the most
common thing that checks out is an interrupted task with half-written work in
its worktree, which reconciles precisely because the phase-sensitive checks are
doing their job. That case is now `RECONCILED_IN_FLIGHT` / `ATTENDED_ONLY`: the
record is accurate, and that is all it says.

`evaluateAutomaticResume()` remains the authority on unattended resumes and is
fed, not re-implemented; `BLOCKED_USAGE_LIMIT` is still the only state it will
ever consider, and only on positive evidence. There is no second resume policy
and no second state machine. Auth arrives as supplied evidence because re-proving
it is an *execution*, and this slice performs none; repository identity is
compared during reconciliation, so by the time the block is judged it has
already been checked. `STATE_DIVERGED` is named for the existing
`RESUME_STATE_DIVERGED` state rather than inventing a second vocabulary for the
same condition.

### What V1-04 is not

It decides; it does not act. Nothing here transitions a task, writes a state as
a side effect of reading one, runs an agent, or touches a repository. Performing
the transition a classification implies belongs to the loop. `RR-F6` is
unchanged: `repo/git-query.ts` still has no injection point, and this slice did
not need one — it re-observes through V1-03's `GitRunner` seam and takes
repository identity as evidence rather than resolving it.

## The agent-runner contract

Source of truth: `src/agent/`.

V1-05 answers one question, for one agent run: **how did it end, and what may
the task do about it?** It starts a Claude writer or a Codex reviewer, reads
what came back, and classifies it. It does not decide what happens next, and it
runs no loop.

### Two agents, one execution seam

`src/agent/agent-command.ts` wraps `doctor/exec.ts` the way
`worktree/git-command.ts` does: agent-sized budgets (thirty minutes, 8 MiB per
stream), the one thrown condition translated into data, and an injectable
`AgentRunner` so a quota refusal or a process killed mid-sentence is
reproducible without a real CLI. There is no second spawn implementation — the
bounded sinks, the two-stage process-tree termination and the `.cmd` codec
exist once.

Each agent runs under its own environment policy, `agent:claude` and
`agent:codex`: `PATH`, `PATHEXT`, `HOME`, `USERPROFILE`, and no credential.
CLI-login operation is the expected mode, so an agent uses the stored login the
auth preflight verified; an API key arriving out of the environment would mean
the run was authenticated by a path nothing checked.

### The prompt travels on stdin, never in argv

`SAFE_ARG_PATTERN` excludes spaces and quotes, so instructions are not
expressible as an argument at all — and must not be, because an argument is the
one thing on this path a command processor ever reads. `RunOptions` gained a
`stdin` payload for this. It defaults to absent, which keeps every diagnostic
probe on the historical `'ignore'` descriptor, and on the `.cmd` route the
payload never touches the `cmd.exe` command line.

Both installed CLIs read it there. Observed while implementing: `codex exec
--help` (codex-cli 0.146.0) — "If not provided as an argument (or if `-` is
used), instructions are read from stdin", confirmed by a run printing `Reading
additional input from stdin...`; `claude --help` (Claude Code 2.1.226) —
"`-p, --print`  Print response and exit (useful for pipes)".

A failure to hand the payload over is reported on
`CommandResult.stdinDelivery`, and the agent seam folds it into `UNAVAILABLE`
alongside truncation — a run that received a fraction of its instructions
answered a different question, so its output is not evidence about this task.
It used to be caught by an empty `'error'` listener and discarded, on the
reasoning that the child's exit code would say so. It does not: a child that
reads a prefix of its prompt, closes its read end and exits 0 with a
well-formed result is, at the process level, indistinguishable from one that
did the work. What is claimed is exact — a delivery failure *Node reported* is
never thrown away — and no more: a payload below the OS pipe buffer is accepted
whole even by a child that has already exited, and no parent-side observation
can see that.

### Success is recognised, never inferred

Both boundaries classify in a fixed order, and the order is the contract:
nothing spawned → the process never reached its own end → a recognised quota
refusal → a non-zero exit → an unrecognised result → completed.

Truncation is folded into "never reached its own end", above parsing, because a
stream cut at its byte budget can still end on a closing brace and parse
perfectly. So is **termination by a signal**: `runCommand` reports a child
killed from outside this process as an ordinary completion — nothing here
issued the termination — so a SIGKILLed agent arrives as `outcome: 'RAN'`
carrying whatever bytes it had already written. The invariant is unconditional:
*a process terminated by a signal is never classified from its own output*, not
as a success and not as a usage limit. Asking about the signal after parsing
let a killed agent's partial bytes park a task on `BLOCKED_USAGE_LIMIT`.

The step is `endedUnderOwnControl` — outcome plus signal — rather than the
stronger "ran cleanly", precisely so the quota check below it still works: the
quota check sits above the exit-code check because a quota refusal *is* a
non-zero exit, and gating the parse on a zero exit code would bury the one
outcome a run driver is meant to pause on. "Ran cleanly" then asks the third
question, the exit code, and each of the three is individually insufficient.

A failed run is diagnosed for what it was. A run whose exit status was zero is
never reported as a "non-zero exit" because it carried a signal:
`AGENT_NONZERO_EXIT` means what it says — exited non-zero, *without* a
recognised signal — and a terminated process is `AGENT_PROCESS_UNAVAILABLE`.

For the writer, success is the `--output-format json` envelope observed at
2.1.226: `type: "result"`, `subtype: "success"`, `is_error: false`, and no
`api_error_status`. The envelope must be the whole of stdout — not something
found inside it. That is not paranoia about a hostile agent: the reviewer in
this system reads *this* repository, so an agent quoting a success envelope out
of a source file or a test fixture is ordinary traffic.

### Findings, and who names them

The reviewer runs `codex exec --json --sandbox read-only` — the sandbox flag
because the reviewer is contractually read-only, which is why
`REVIEWING → SCOPE_VIOLATION` exists at all. Its transcript must carry a
completed turn, and its final agent message must validate as a review document:
a version, a `PASS`/`FINDINGS` verdict, and a finding list that *agrees* with
that verdict. A document claiming to pass while listing findings is not a pass
with a caveat; it is unreadable, and the safe reading of an unreadable review
is never "no problems found".

Each finding supplies a severity, a repository-relative path and a rule id, all
validated against closed vocabularies — an unrecognised severity invalidates
the document rather than degrading into `info`. The **fingerprint is computed
here**, as a fixed-width digest of that triple. `findingHistory[].fingerprint`
is the only free-form string in the durable contract, so a reviewed-repository
agent does not get to choose it, and a fixed width is what makes the 1 MiB
state bound arithmetic rather than hopeful. A review exceeding the per-review
cap is refused, never silently shortened.

#### The review document, canonically

This is the shape the reviewer's final agent message must have. It is written
down here because the parser that enforces it is deliberately internal, while
the prompt that has to *ask* for it is not yet written — V1-06 supplies that
prompt, and it needs something stable to quote that is not a private constant:

```json
{
  "reviewVersion": 1,
  "verdict": "FINDINGS",
  "findings": [
    { "severity": "high", "path": "src/agent/claude-writer.ts", "rule": "classification.order" }
  ]
}
```

- `reviewVersion` — exactly `1`. A later version is unrecognised, not assumed
  compatible.
- `verdict` — `"PASS"` or `"FINDINGS"`, and it must agree with the list:
  `PASS` requires an empty `findings`, `FINDINGS` requires a non-empty one.
- `severity` — one of `critical`, `high`, `medium`, `low`, `info`.
- `path` — repository-relative POSIX, at most 1 024 characters, built only from
  `[A-Za-z0-9]` and `._:@=+/-`: no drive letter, no leading `/`, no `\`, no
  `.`/`..` segment, and no space, line break or control character. The class is
  an allow-list rather than a list of refusals, because the path is quoted into
  the remediation prompt the *writer* is given — a `path` carrying a newline
  would arrive there as a free-standing line of instructions.
- `rule` — a bounded slug (`[A-Za-z0-9]`, inner `._:-`), at most 128 characters.
- at most **64** findings per review.

Anything else — a missing field, an unknown severity, a document wrapped in
prose, more than the cap — is `AGENT_RESULT_MALFORMED`, which is
`HUMAN_DECISION_REQUIRED`. **Exit 0 alone is never a review pass**: the absence
of a valid document is not the absence of findings.

### Usage exhaustion is a governed pause

A quota refusal is recognised **structurally**: `api_error_status` carrying the
standard `429`, in an envelope that also admits to being an error. It is not a
phrase matched against free text, and it cannot be — a sentinel string would
eventually be matched against a review that quotes the sentinel's own source
file.

`recordAgentInterruption` composes V1-04 rather than reimplementing it: it
builds the successor state and hands it to `advanceTaskState`, so the
transition table and the exact-byte revision apply automatically. A usage-limit
block recorded from `VERIFYING` is refused as `ILLEGAL_TRANSITION`, because
verification consumes no agent quota and that edge does not exist. Everything
already persisted is carried forward — `findingHistory` above all, which
`reconcile.ts` reads as evidence that a task has done work.

**The blocked agent and the resume phase are derived from the running phase,
never copied from the caller.** `IMPLEMENTING` and `REMEDIATING` are the
writer's, `REVIEWING` is the reviewer's, and the persisted state already knows
which it is. Every agent × phase combination validates against the schema —
`allowedBlockedAgents` and `allowedResumePhases` are set per blocking state, not
per predecessor — so a Codex review interrupted in `REVIEWING` could be written
down as *Claude's quota is exhausted, continue at IMPLEMENT round 1* with every
gate passing and the operator sent to re-authenticate the wrong CLI. Only the
*round* comes from the run, because only the run knows which pass it was. A
caller whose evidence contradicts the phase is refused with
`INTERRUPTION_INCONSISTENT` rather than believed: a disagreement between the
caller and the durable state is not resolved by picking one.

That derivation covers the three states in which an agent actually runs, and
V1-06 closed the gap around them. A task **already parked in a blocking state**
had no agent running, so there is no interruption to record against it — and
because `AGENT_PHASES` holds no entry for those states, every guard above was
inoperative for them: the agent identity and resume phase were taken from the
caller verbatim and nothing stale was withdrawn. The sharp case was a
`BLOCKED_USAGE_LIMIT` self-write: `from === to` is a checkpoint rather than a
transition, so the table never judged it, and an already-elapsed
`reportedResetAt` could be written onto a state that carried none — turning a
block `evaluateAutomaticResume` refuses with `RESET_TIME_MISSING` into one it
grants on a timer. Such a write is now refused with
`INTERRUPTION_INCONSISTENT`. `AUTH_PREFLIGHT` is deliberately still allowed to
record an auth block: it probes real agent credentials, and it is a regular
state, not a blocking one.

**A writer's interruption withdraws the checkpoint claims it may have
invalidated.** `worktreeCleanAtCheckpoint` and `currentCommit` were true when
something last looked, and a writing agent changing the worktree is the job, not
an edge case. Carrying `worktreeCleanAtCheckpoint: true` across the interruption
made `reconcile.ts` read a dirty tree as contradicting the record —
`WORKTREE_DIRTY`, verdict `DIVERGED`, and `classifyResume` short-circuits every
diverged reconciliation to `BLOCKED`. A self-clearing quota pause was becoming
`RESUME_STATE_DIVERGED`, which is `resumable: false`, for a condition true of
every interrupted writer. Neither value is fabricated in the other direction:
`false` withdraws a claim of cleanliness rather than asserting dirtiness, and
`null` means the recorded HEAD is no longer known to be current. The reviewer is
contractually read-only, so its interruption withdraws nothing. The rule and the
phase table it reads live in `core/agent-phases.ts`, stated once, because more
than one durable write has to answer the same question — see the run driver's
resume below.

The run driver receives one of `RUN_COMPLETED`, `PAUSED_USAGE_LIMIT`,
`NEEDS_ATTENTION` or `STATE_NOT_RECORDED`. There is deliberately no
`RESUME_READY`, no `RETRY` and no `AUTOMATIC_ALLOWED`: that authority has
exactly one source, `evaluateAutomaticResume` reached through `classifyResume`
after reconciliation, and a second value a driver could mistake for it would be
a way to resume without ever having checked.

**No reset timestamp is ever invented.** None was observed in either CLI's
output, so `reportedResetAt` is `null` in practice, `evaluateAutomaticResume`
refuses with `RESET_TIME_MISSING`, and the block waits for a human. That is the
correct outcome for evidence we do not have — a fabricated timestamp would not
merely mislead a report, it would convert a governed block into an automatic
retry on a timer.

Nothing here retries, sleeps, polls or backs off. One call, one process, one
result.

### What V1-05 is not

No state was added to `src/core/states.ts`, no edge to `src/core/transitions.ts`,
and `TaskState` is unchanged at schema version 1 — the block fields the
contract already had are the ones used. `READY_FOR_PR` remains terminal.

Deliberately not wired, and left to the slices that own them:

- **V1-07** — the run driver. It arrived in the slice of that name; no CLI
  command exposes it.
- **Scope enforcement.** `scope.allowedPaths` remains declared, not enforced;
  the reviewer's read-only sandbox is asked of the CLI, not verified afterwards.
- **A Codex usage-limit signal.** No evidence of one exists, so none is
  recognised, and an exhausted Codex allowance reaches a human rather than a
  pause. Adding one means capturing a dated, version-pinned observation first.

Review item **RR-F6** is untouched and remains open: it is about
`repo/git-query.ts` having no injection point, and adding an agent seam does
not give it one.

## The verify / review / remediate loop

V1-06 is the first slice that *drives* anything. It composes what the earlier
ones built — the verification commands a profile declares, the two agent
boundaries, and V1-04's compare-and-swap persistence — into the one cycle the
transition table describes, and adds no state and no edge to do it.

### One step, one durable write

Every step performs **at most one** `advanceTaskState` call and returns
immediately afterwards. That single decision is what makes the rest cheap:
there is no window in which half a step's progress is on disk, so a restart
reads a state that is exactly "before" or exactly "after"; and a step that
never writes twice never needs to re-derive a revision, which is the one way a
stale-writer refusal gets laundered into a successful overwrite. Progress lives
on disk, never in a closure — a driver that dies between steps loses nothing
but the in-memory remediation prompt, and the loop says so in the next prompt
when that happens.

### The flow

```
VERIFYING ──pass──> REVIEWING ──clean review, settled worktree──> READY_FOR_PR
    │                   │
    │                   └──findings, budget left──> REMEDIATING ──> VERIFYING
    │
    └──failed──> BLOCKED_VERIFY        (the loop stops; a human decides)
    └──unrunnable──> HUMAN_DECISION_REQUIRED
```

A **failed** verification and an **unrunnable** one are different answers.
"The build is broken" and "we could not run the build" send an operator to
different places, and only one of them is about the repository, so only the
first reaches `BLOCKED_VERIFY`.

`PASSED` is a positive conjunction over phases that actually ran, in the order
the profile declares them, stopping at the first that does not pass. An empty
phase list is `UNAVAILABLE`, not a vacuous pass: a gate that can be satisfied by
the absence of evidence is not a gate. Nothing is ever retried — a suite that
passes on the second attempt has not passed.

### Rounds and history

`reviewRound` counts **completed** reviews and starts at 0, so the review being
attempted is `reviewRound + 1`. It is incremented exactly once, on the write
that *leaves* `REVIEWING`. An interrupted review does not increment it: a round
that was interrupted was not completed.

`findingHistory` is appended to and never rewritten, and repeats are kept. The
same finding in rounds 1 and 2 is two records with the same fingerprint — that
pair is the evidence that remediation did not work, and de-duplicating on the
fingerprint would delete precisely the fact worth knowing.

The durable record stays `{ round, severity, fingerprint }`. `path` and `rule`
are carried **in memory only**, because they are agent-authored text and the
fingerprint remains the only free-form string the state contract accepts. They
are what lets a remediation prompt name the files to fix; a pass resumed after a
restart gets a weaker prompt built from the durable record, and that prompt says
so rather than presenting a degraded brief as a complete one.

### The bound has an owner

The loop is bounded by `completion.maxReviewRounds` from the repository profile,
mirrored into `TaskState.maxReviewRounds` and already enforced by the state
contract as `reviewRound <= maxReviewRounds`. No retry count was invented here.
A remediation pass is only started if its result could still be reviewed; at the
last permitted round it could not, so the task goes to a human with its evidence
intact.

The one cycle `maxReviewRounds` does not bound —
`VERIFYING → BLOCKED_VERIFY → REMEDIATING → VERIFYING`, which never touches
`reviewRound` — is bounded instead by the loop refusing to leave
`BLOCKED_VERIFY` at all. That state is `resumable: true` but
`automaticResumeEligible: false`, and `resume-policy.ts` gives the reason:
*resuming means handing the failure to the writing agent, which is a decision,
not an automatic retry.* So the only cycle this loop drives unattended is
`VERIFYING → REVIEWING → REMEDIATING → VERIFYING`, and every traversal of it
consumes exactly one review round.

### Completion is observed, not asserted

`READY_FOR_PR` demands a resolved `currentCommit` and
`worktreeCleanAtCheckpoint === true`, and no reviewer can attest to either. A
clean review is therefore necessary and never sufficient: the worktree is
observed through V1-04's observation half, and the state is claimed only when
both facts were *positively* established. Anything else — a dirty tree, an
unresolved HEAD, a Git that could not be asked — goes to a human.

Entering `REMEDIATING` withdraws `worktreeCleanAtCheckpoint` and
`currentCommit`, for the reason the interruption path already gives: carrying a
clean checkpoint into a state whose whole purpose is to modify the worktree
makes `reconcile.ts` read the writer's own work as divergence.

### What V1-06 is not

No state, no edge, and `TaskState` unchanged at schema version 1.
`READY_FOR_PR` remains terminal, and remains reachable only from `REVIEWING`.
There is no queue, no task selection, no CLI command, and no PR, CI or merge
concept — those stay outside the product contract. `scope.allowedPaths` is still
declared rather than enforced.

Two V1-05 followups were closed here because V1-06 made them live: an agent or
verification command is now refused unless its worktree path is **absolute** as
well as shell-inert (a relative `cwd` resolves against `process.cwd()` at
`spawn`), and an interruption recorded against a task that is *already* in a
blocking state is refused. Review item **RR-F6** remains open and untouched.

## The run driver

V1-07 is what makes the state machine runnable. It composes the earlier slices —
task selection, state loading, reconciliation, the resume decision, runtime
observation and the V1-06 loop — and adds one ordering and one closed outcome.
It adds no state, no edge and no field, and `TaskState` stays at schema
version 1.

### A step is never executed from persisted state alone

This is the invariant the whole slice exists to hold. Every iteration, in this
order, with each gate closing on the one before it:

1. **`reconcileTask`** — load the durable state *and* compare it against what
   Git says now. `RECONCILED` is the only outcome anything continues from.
2. **`classifyResume`** — decide what, if anything, may continue. The driver
   feeds that authority; it never re-implements or widens it.
3. **`observed.authorisedWorktreePath`** — the directory Git vouched for. No
   authority, nothing spawned.
4. **`runLoopStep`**, with that path handed to it explicitly.

Reversing any two of them produces a failure this repository had already written
down: judging the block before reconciling yields "resume allowed" for a task
whose worktree is gone; executing before observing runs an agent in a directory
nothing vouched for; and re-reading the state to get a fresh revision after a
refused write is precisely how a stale-writer refusal becomes a successful
overwrite.

Reconciliation is re-run **every iteration**, not once per run. A step is a
subprocess that took minutes and changed the worktree, so the world it left is
not the world the previous observation described. Re-loading is also how the
compare-and-swap token is obtained: `advanceTaskState` threads the revision of
the `StateLoadSuccess` it was handed and `StateSaveSuccess` carries no new one,
so exactly one write may be made per load.

### Terminal is judged before the world is

A `READY_FOR_PR` or `ABORTED` task stops the run whatever Git says. It has no
outgoing transition, so nothing could run in any case — and asking anyway
invites "your completed task diverged", which is noise about something nobody
will continue. `classifyResume` orders itself the same way. The gate is reached
only for a state that *loaded*, so a record belonging to another repository
never passes it.

### Fresh, resumed, and refused

| durable state | what the driver does |
| --- | --- |
| none | `TASK_NOT_STARTED`. Nothing is created — see below |
| `VERIFYING` / `REVIEWING` / `REMEDIATING` | steps, given an attended grant |
| `IMPLEMENTING` and the setup chain | `NO_PROGRESS`; the loop does not drive them |
| `READY_FOR_PR` / `ABORTED` | terminal, nothing run |
| `BLOCKED_USAGE_LIMIT` | resumed **only** on `AUTOMATIC_ALLOWED` *and* an attended grant; otherwise stops with the checks that denied it, writing nothing |
| `BLOCKED_VERIFY` | stops. Never an automatic retry |
| `BLOCKED_AUTH`, `HUMAN_DECISION_REQUIRED`, `SCOPE_VIOLATION`, `RESUME_STATE_DIVERGED` | stop; each keeps its own outcome |
| diverged / unobservable / unusable | stop, fail-closed, repair nothing |

**A fresh task is not started here.** Creating the first `TaskState` means
recording a `worktreePath`, and this driver prepares no workspace; writing one
anyway would durably assert a directory nobody created. `runLoopStep` also does
not drive `IMPLEMENTING`, so a freshly created state could not be moved even if
it existed. Both belong to the slice that composes the setup chain.

**An in-flight task needs an attended grant.** `classifyResume` reports a
healthy in-flight task as `ATTENDED_ONLY`, because the most common thing that
reconciles is an interrupted task with half-written work in its worktree.
`RunRequest.attendedContinuation` is the operator saying they are present for
*this run*. It is a second requirement on top of the authority module's answer
and never a substitute: it can only narrow what runs, and it grants nothing for
a blocked task, which moves only on `AUTOMATIC_ALLOWED` and stops on anything
else whatever is set here.

**The grant is checked before any durable write, including a resume.** Because
it is a requirement on the *invocation*, the order matters: a resume written
first spends `resumeFrom`, `reportedResetAt` and `blockedAgent`, and the
work-loop state it lands in classifies `ATTENDED_ONLY` from then on — so an
unattended run that wrote the resume and then refused to execute would have
converted a self-clearing quota pause into a task no unattended run can ever
pick up, having done no work at all. The gates that decide whether this run may
act therefore all precede the write, and an unattended `AUTOMATIC_ALLOWED` run
stops with `CONTINUATION_NOT_AUTHORISED` / `ATTENDED_CONTINUATION_NOT_GRANTED`,
leaving every field of the block intact for a later one (V1-07-RR-B1).

**A resume into a writing phase withdraws the checkpoint it is about to
invalidate.** `currentCommit` and `worktreeCleanAtCheckpoint` are exactly the
evidence `evaluateAutomaticResume` demanded, but they describe the worktree as
the *pause* left it. Carrying them into `IMPLEMENTING` or `REMEDIATING` asserts
"known HEAD, clean tree" about a phase whose purpose is to modify the worktree,
and `reconcile.ts` reads that literally: the writer's own commit becomes
`CURRENT_COMMIT_MOVED`, its own uncommitted work becomes `WORKTREE_DIRTY`, and
the verdict is `DIVERGED` — for the mutation the orchestrator itself
authorised. The resume write therefore withdraws both, from the same
`AGENT_PHASES` table the interruption path and the loop's own writing edge
consult, and leaves them untouched for the read-only `REVIEWING` target
(V1-07-RR-B2).

### Stopping, and the absence of a retry

Nothing retries, sleeps, polls or backs off. A block is a stop, a refused write
is a stop, `NOT_APPLICABLE` is a stop. The loop continues only while the
previous iteration made a durable change — **measured by the state file's
revision moving**, never by a step having returned a hopeful outcome. A
`replace` that silently does nothing produces a `SAVED` result over an unchanged
file, and a driver that trusted the outcome would spend its whole budget on a
task standing still.

The bound on the *loop* is still `maxReviewRounds`, the repository's.
`RunRequest.maxSteps` bounds one *invocation*, so a future edge that made an
unbounded cycle reachable cannot run away.

Every authority boundary keeps its own outcome. "The quota ran out", "the build
is broken", "a human must decide", "we were never allowed to run here" and
"another writer got there first" have nothing in common except that the run
stopped, and they send an operator to five different places.

### Queue: one task per invocation

Selection goes through V1-02's selector unchanged — no ordering, filter or
eligibility rule is restated in the driver, and `selectRunTask` reports why
there is nothing to do, naming the ineligible tasks.

The driver drives **one** task and then returns. That is a refusal rather than
an omission. `selectNextTask` decides eligibility from `status: DONE` in the
repository's own task files; nothing in this build writes a task file; and
`READY_FOR_PR` is terminal precisely because a human takes the task from there.
So "this task is finished, move on" is a statement only the repository can make.
A driver that made it — by treating `READY_FOR_PR` as `DONE`, or by keeping its
own list of attempted ids — would be inventing completion semantics the
repository has not defined, and would either re-select the same task forever or
silently disagree with the published ranking. **The repository is silent on
whether an independent task may run after one blocks, and this slice does not
answer it.**

### Three V1-06 followups closed here, because V1-07 made them live

**F-6 — execution authority.** `observeRuntime` already computed the one
directory a task may execute in — the path Git printed for a registration
holding *this task's* branch — and threw it away. It is now reported as
`ObservedRuntime.authorisedWorktreePath`, deliberately narrower than
`registeredWorktreePath`, which is populated whenever Git lists the recorded
path *whatever branch is checked out there*. `LoopDependencies` gained a
**required** `authorisedWorktreePath`, and the three `spawn` sites — the
verification commands, the reviewer, the writer — use it instead of
`state.worktreePath`. The persisted path is compared against it as identity
evidence and is never a `cwd`. A step handed no authority, a relative one, or
one belonging to a different state, returns `EXECUTION_UNAUTHORISED` and starts
nothing.

**F-3 — the empty resumed remediation brief.** A resumed `REMEDIATING` whose
durable history held no finding for its round produced a document in the
reviewer's voice claiming a review had reported findings and then listing none,
and handed it to an agent with a worktree to modify. Both claims were invented.
`buildResumedRemediationBrief` now returns a discriminated result whose
`NO_DURABLE_FINDINGS` member carries no payload — the falsehood is
unrepresentable — and the remediate step fails closed to
`HUMAN_DECISION_REQUIRED` without starting a writer. `BLOCKED_VERIFY →
REMEDIATING` stays usable: a caller that has just run the verification may
supply its own brief. What changed is that a caller who has *not* may no longer
borrow the reviewer's voice. No verification report is fabricated, because none
is persisted.

**Stale resume evidence.** Three loop writes spread `...state` while naming
neither `resumeFrom` nor `reportedResetAt`, so a point left over from an earlier
block rode `REMEDIATING → VERIFYING → REVIEWING → REMEDIATING` indefinitely, and
an elapsed reset time would have sat on a running task waiting to be read as
"the quota has cleared" by the next resume decision — the fabrication V1-05's
NEW-4 already had to close once, one layer up. The fix is a **contract**
invariant, not a habit: the four work-loop states may carry neither field.
Reaching the state a resume point names *is* the continuation it asked for, and
a running task is not waiting on anyone's quota. Forgetting to clear is now a
refused write that persists nothing, rather than a silent lie. The set is
derived from `RESUME_PHASE_STATES` so the contract and the resume policy cannot
drift, and it is deliberately scoped to the work loop: `BLOCKED_AUTH →
AUTH_PREFLIGHT → GIT_PREFLIGHT → WORKTREE_READY → CONTEXT_LOADING` is a declared
path that must carry the stored point through. `RESUME_EVIDENCE_SPENT` states
the clearing once, for the loop and the driver alike.

### What V1-07 is not

No state, no edge, `TaskState` unchanged at schema version 1, `READY_FOR_PR`
still terminal and still reachable only from `REVIEWING`. No PR, CI, merge or
post-merge concept entered the product. `scope.allowedPaths` is still declared
rather than enforced.

There is **no CLI command**: the driver is a library, like every slice before
it. Exposing it needs argv semantics for the operator grant and the task
override that the repository does not define, and it belongs with the
end-to-end wiring rather than here.

Left to the slice that owns them: creating a task's first state, the setup chain
`CREATED → … → IMPLEMENTING`, a `runImplementStep`, multi-task queue
progression, and a `run` command. Review item **RR-F6** — `repo/git-query.ts`
having no injection seam — remains **open and untouched**: the driver takes its
`GitRunner` from V1-03's seam, which does not give V1-01's queries one.

## Not implemented yet

Planned commands — mentioned for orientation only, none of them exist in this
build: any command exposing the loop or the run driver. The repository profile
*declares* the context sources and the write scope; no code in this build opens
a context file or enforces a scope. Task selection, workspace preparation, state
persistence, the agent runners, the verify/review/remediate loop and the run
driver exist as libraries and have no CLI command yet: nothing in `agent-loop`
calls them.
