# agent-orchestrator (`agent-loop`)

Foundation for a repository-agnostic orchestrator that will coordinate two
already-installed CLI agents:

- **Claude Code** — the only agent allowed to write.
- **Codex CLI** — a strictly read-only reviewer.

Both are intended to run on their existing **subscription logins**, never on
API keys.

> **One command executes, behind one explicit grant.** `agent-loop run
> --attended` starts a single task and drives it. Everything else is read-only:
> `agent-loop doctor`, and `agent-loop run` without the grant, which still starts
> no agent, writes no task state and prepares no workspace. Unattended operation,
> multi-task blocks, scope enforcement and any PR/CI/merge automation are **not**
> in this build.

What *is* implemented:

1. A standalone TypeScript CLI project.
2. The binding **single-task state contract** (Zod → generated JSON Schema,
   plus an explicit state-transition table).
3. The read-only diagnosis command `agent-loop doctor`.
4. The **repository-profile contract and repository resolution** (Zod →
   generated JSON Schema, plus a fail-closed resolver).
5. The orchestration runtime as a **library** — task selection (V1-02),
   workspace lifecycle (V1-03), durable state and reconciliation (V1-04), the
   agent runners (V1-05), the verify/findings/remediation loop (V1-06) and the
   run driver (V1-07/V1-08) — each documented in its own section below.
6. The read-only planning command **`agent-loop run`** (V2-01): which task is
   next and why, what its durable state permits, and on whose authority
   anything may continue — with a documented exit-code contract. It executes
   nothing.
7. **Attended execution of one task** — `agent-loop run --attended` (V2-05):
   starts the task if needed, drives it, and exits on a total mapping from its
   outcome. Requires an operator grant *and* a passing auth preflight, which are
   independent requirements; auth evidence is an unforgeable artefact rather than
   a boolean a caller can assert. See
   [Attended execution](#attended-execution-v2-05).
8. **Scope enforcement** (V2-06): `scope.allowedPaths` is enforced against the
   task's actual repository effect — the whole delta from `basePinnedCommit`,
   untracked files included — before *and* after every writing agent, under the
   scope declared by the profile at the pinned commit. See
   [Scope enforcement](#scope-enforcement-v2-06).
9. **Workspace recovery** (V2-06A): a start that died between `git worktree add`
   and its first durable write is recognised on the next attempt and adopted —
   but only when every part of that claim is proven — plus
   `release --attended` to hand such a workspace back. See
   [Workspace recovery](#workspace-recovery-v2-06a).
10. The **block-run ledger** (V2-07): the durable record of one started block
    run, with frozen membership, a successor contract deciding which fields a
    writer may change at all, evidence-backed progress proved at the store, and
    a reconciliation that believes the task records rather than the ledger. It
    stores; it does not drive. See
    [The block-run ledger](#the-block-run-ledger-v2-07).

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
`test:dist-trusted-profile`, `test:dist-lease-race`, `test:foundation-safe`,
`test:windows-tree-kill-tool-release`. `build` runs immediately before the three
dist artefact checks, so all of them always run against a fresh build, never a
stale or missing one, and there is only ever one build per `verify` run. The two
vitest gates run **sequentially**, in that order — the real-process harness never
runs alongside the foundation set.

`test:dist-trusted-profile` checks the *built* trusted-profile module
(`dist/config/internal/trusted-profile.js`): that it resolves the OS user
profile through `os.userInfo()`, that a child process with spoofed profile
environment variables gets the identical answer, and that no remnant of the
removed PowerShell resolver survives in the shipped artefact.

`test:dist-lease-race` puts the **execution lease** under real concurrency:
eight OS processes race for one lease, released together from a shared start
barrier, five times over, and exactly one must win each round. It is a separate
gate for the reason the property is: a second `acquire` inside one process proves
that the exclusive create refuses an existing file, and cannot prove the claim is
*atomic*, because two synchronous calls in one thread cannot interleave. V2-07's
compare-and-swap passed every single-process test it had and lost writes to a
concurrent second caller; this is the check that would have caught it, pointed at
the mechanism that replaced it. It found a real defect on its first run — see
"The lease appears complete, or not at all" below.

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
npm run test:dist-lease-race  # only the real-process execution-lease race
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

## `agent-loop run`

```powershell
agent-loop run --repository D:\path\to\repo
agent-loop run --repository D:\path\to\repo --task V2-01
```

Read-only **by default**: without `--attended` the command **plans** and does not
execute. For the execution mode see
[Attended execution](#attended-execution-v2-05); everything in this section
describes the default, which V2-05 left unchanged. It

- resolves the repository through `resolveRepository`. `--repository` is
  required and must be absolute — there is deliberately no `process.cwd()`
  default, because nothing in the library ever consults the working directory,
  and a command that defaulted to it would make the answer a property of the
  shell rather than of the input;
- asks the repository's own selector which task is next, and prints the full
  ranking plus every ineligible task with its reason and unsatisfied
  dependencies;
- loads the durable state of the selected task — or of the task named with
  `--task`, whose id must satisfy the task-id grammar before it is looked up —
  reconciles it against observed Git reality, and prints the continuation
  authority. The resume decision is computed with `authEvidence: null`: no
  preflight ran, and evidence is never assumed — since V2-05 that is also the
  only value a plan *could* supply, because the artefact has one producer;
- reports whether the task's **brief** can be assembled — its prose, and
  whether every declared context source can actually be opened. Reported, never
  enforced: no run is refused for want of a brief, because no run exists yet.
  See [the task brief](#the-task-brief);
- concludes with one code from a closed vocabulary
  (`src/run/run-plan.ts`) and exits accordingly.

It starts no agent, writes no task state, prepares no workspace and performs
no login or auth preflight. `tests/run-plan.test.ts` asserts that on the
durable state file's bytes and on the absence of a runtime directory.

The claim stops exactly there, on purpose. Observing a worktree runs `git
status` inside it, and Git may refresh that worktree's own index while
answering — so "the repository is byte-identical afterwards" is not something
this command can promise, and it does not. What it does promise is that no
ref, branch or tracked file moves, and that nothing the orchestrator owns is
written.

### `run` exit codes

| Code | Meaning |
| --- | --- |
| `0` | Nominal answer: `TASK_NOT_STARTED`, `RECONCILED_IN_FLIGHT`, `TASK_COMPLETED`, `ALL_TASKS_COMPLETE` |
| `1` | Unexpected failure inside the tool |
| `2` | Input unusable: resolution or planning failed, or the named task is invalid, unknown or ineligible |
| `3` | The durable state needs an operator: parked, aborted, diverged, unusable or unobservable |

Codes `4` (invocation refused / no progress) and `5` (step budget exhausted —
call again) are reserved for the execution mode of a later slice. The mapping
for **every** run outcome and every plan conclusion is already fixed in
`src/cli/run-exit-codes.ts` and pinned as total by
`tests/run-exit-codes.test.ts`, so widening either vocabulary forces a
deliberate decision there rather than an accidental exit status.

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
passed; the auth preflight passed again — proven by the artefact it mints, not
by a flag a caller set, and verified with `instanceof` so a cast denies too;
repository id, canonical repository root, canonical worktree path, pinned base
commit and current commit all still match; the worktree exists and is clean; and
no divergence was reported.
Without a reliable reset timestamp, no unattended resume is ever granted.

> **In this build no unattended resume is ever granted at all.** The table above
> describes the decision function, not an operating capability: three
> independent locks — no CLI reports a reset time, the writing phases withdraw
> the checkpoint claims the function demands, and Codex has no quota recogniser
> — each deny it on their own. See
> [Unattended resume is inert in this build](#unattended-resume-is-inert-in-this-build-and-that-is-now-stated).

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

## Starting a task

Source: `src/run/start-task.ts`. Called by `agent-loop run --attended`, and by no
other command: see [why there is no separate `start`
command](#why-there-is-no-separate-start-command).

`startTask` is the entry point V1 deliberately did not have. It walks the setup
chain `CREATED → REPOSITORY_RESOLVED → CONFIG_VALIDATED → AUTH_PREFLIGHT →
GIT_PREFLIGHT → WORKTREE_READY` and persists **only the last one**.

### Why persistence begins at `WORKTREE_READY`

The five earlier phases are real and they still happen; they are *transient* —
process-local steps of one start attempt rather than restartable checkpoints.

Persistence begins where a record can first be reconciled against the outside
world. A `TaskState` names a `worktreePath`, a `workBranch` and a
`basePinnedCommit`; before the workspace exists there is nothing for any of
those to describe, and `reconcile.ts` reads such a record as
`WORKTREE_NOT_REGISTERED` → `DIVERGED` → blocked — for every one of the five.
`PRE_WORK_STATES` already contains exactly `WORKTREE_READY` and
`CONTEXT_LOADING`, which is the same boundary drawn from the other side.

Persisting the earlier phases would mean inventing a second reconciliation
world for "the task exists but its workspace does not", which nothing needs
yet, and would make the caller-chosen-identity residual (**F-7**) live by
giving a non-agent phase a durable state to be interrupted in. A persistable
pre-workspace state machine is a later extension, to be built only if resuming
*inside* the setup chain is ever actually needed.

### Three invariants

1. **No durable state before the workspace exists.** An ineligible task, an
   unignored runtime directory, a failed auth preflight and a refused workspace
   all write no state, create no branch and create no runtime directory. A
   failed start cannot be resumed into existence, because there is no record to
   resume.

   That claim is about *task state*, and it holds without exception. The weaker
   claim "a refusal leaves nothing behind at all" would be false, and is not
   made: `prepareTaskWorkspace` can fail with `WORKTREE_ROLLBACK_INCOMPLETE`
   (it created a worktree, rejected it, and could not remove it again), and a
   refused durable write leaves a correct but orphaned worktree. Both set
   `residue: true` on the result, because an operator with a stray worktree
   beside their repository should hear it from the thing that made it. Neither
   is tidied up automatically — removing a worktree is a destructive act on a
   path the code has just failed to reason about, which is the same argument
   `remove-workspace.ts` makes about `--force`.

2. **The first state carries derived identity, never supplied identity.** Every
   identity field comes from the `TaskWorkspace` receipt that
   `prepareTaskWorkspace` verified *from inside the worktree it created*.
   `reconcile.ts` re-derives the same values and refuses a mismatch, so a state
   built from anything else would be diverged from the moment it was written.

3. **The runtime directory is proven ignorable before the first write.** See
   below.

The initial state is a **literal**, not a parameter. `saveTaskState` writes a
state with no predecessor, so the transition table has no edge to judge and
cannot defend the setup chain here — a creation call naming `IMPLEMENTING`, or
`READY_FOR_PR`, would simply be written. `tests/start-task.test.ts` pins
structurally that `WORKTREE_READY` is the only state any production path can
create.

### The runtime directory must be provably ignored

Source: `src/state/runtime-ignored.ts`.

Task state lives *inside* the target repository, and `prepareTaskWorkspace`
refuses `SOURCE_WORKTREE_DIRTY` on an untracked file. Those two facts collide:
if `.agent-orchestrator/runtime/` is not ignored, starting task one leaves an
untracked file, and preparing task two fails. **The first task succeeds, every
later task refuses, and the cause is a file the orchestrator wrote itself.**

For one manual run that is a confusing afternoon. For a roadmap block running
tasks in sequence it is a guaranteed stall after the first one. So it is a
check, not a paragraph: `startTask` asks Git — with read-only `git check-ignore
--quiet` — about the exact path it is about to write, before it writes it or
creates anything.

Git is asked rather than `.gitignore` parsed, because ignore rules compose from
several files with precedence, negation and per-directory scope, and the only
opinion that matters is Git's own. The index is deliberately *not* excluded:
a **tracked** runtime file answers `NOT_IGNORED`, which is the right refusal —
writing to a tracked path dirties the tree just as effectively.

The three answers stay apart. `check-ignore --quiet` exits `0` for ignored, `1`
for not ignored, and otherwise could not evaluate the question at all; reporting
that third case as "not ignored" would refuse a correctly configured repository
because Git hiccuped, and reporting it as "ignored" would walk into the defect.
It is `RUNTIME_IGNORE_UNDETERMINED`, and it refuses.

**Onboarding requirement:** a repository the orchestrator starts tasks in must
ignore `.agent-orchestrator/runtime/`.

### Why there is no separate `start` command

There is no `agent-loop start`, and starting is not a mode of its own: `run
--attended` starts the task if it needs starting and then drives it, because
those two are one operator intention. Splitting them would make an operator issue
two commands to get one task moving, and would put two closed outcome
vocabularies behind one exit code without either being the answer.

So the start half is reachable only as part of executing, which is also why its
outcomes needed exit codes of their own (`START_TASK_EXIT_CODES`): an invocation
can legitimately end on a start outcome — `RUNTIME_NOT_IGNORED`,
`WORKSPACE_COLLISION`, `AUTH_PREFLIGHT_FAILED` — with nothing to drive. See
[Attended execution](#attended-execution-v2-05).

## The setup hops and the implement step

Source: `src/loop/loop-step.ts` (`runWorktreeReadyStep`,
`runContextLoadingStep`, `runImplementStep`) and
`src/loop/implement-payload.ts`.

`startTask` stops at `WORKTREE_READY`. These three steps are what move a task
from there into the work loop, and they are ordinary loop steps: dispatched on
the durable state, at most one durable write each, refusing without an
authorised worktree.

**`WORKTREE_READY → CONTEXT_LOADING`** starts no process and reads no
repository. That is not an oversight — `startTask` created and verified the
workspace, the driver reconciled the record against Git before the step ran,
and the step re-checks execution authority. There is nothing left to establish.
It exists because the transition table declares the hop, and writing
`IMPLEMENTING` straight from `WORKTREE_READY` is an illegal transition
`advanceTaskState` would refuse.

**`CONTEXT_LOADING → IMPLEMENTING`** is where the repository's account of the
task has to actually exist. Two different failures get one response, and both
are checked:

- the **task file** itself is absent, unreadable, has no frontmatter or no
  prose — `readExecutionBrief` returns `ok: false`;
- a **declared context source** could not be opened: missing, unreadable, or a
  link out of the repository. This one arrives on a *successful* brief, as a
  per-source status plus `contextComplete: false`, so a step that only asked
  `brief.ok` would advance straight past it. That was the shape of a real
  defect in this slice: the gate was documented here and in the step's own
  header, and implemented in neither.

Either parks the task at `HUMAN_DECISION_REQUIRED` with `resumeFrom` naming
`IMPLEMENT`, so a human who fixes the repository resumes into the pass it was
heading for. The check is repeated in the implement step, because a restarted
driver enters there directly.

Parking on an incomplete context is the fail-closed reading, and it is the one
that matches what the payload does: it hands the agent those paths *to open*.
An unopenable one would be an instruction to read a file that is not there, and
an `UNSAFE` one a path the reader already refused to follow.

The write into `IMPLEMENTING` **withdraws the checkpoint**
(`worktreeCleanAtCheckpoint: false`, `currentCommit: null`). `IMPLEMENTING` is
a mutating phase: a state carrying a clean checkpoint into it would be claiming
a settled tree for exactly the period the tree is expected to move, and the next
reconciliation would read the writer's own work as `CURRENT_COMMIT_MOVED` +
`WORKTREE_DIRTY` → `RESUME_STATE_DIVERGED`, which nothing resumes.

**`IMPLEMENTING → VERIFYING`** runs the Claude writer with `phase: 'IMPLEMENT'`
in the authorised worktree, and is the mirror of the remediate step — they
differ in the cause they are given and in nothing else.

A completed writer is **not** a completed task. `runClaudeWriter` returning `ok`
means an argument-safe process ran to its own end, exited 0 and printed a
recognised `COMPLETED` envelope; it carries no evidence that any file changed.
So the only destination is `VERIFYING` — the transition table offers no other
forward edge — and `reviewRound` is untouched, because it counts *completed
reviews* and an implement pass that spent one would consume the repository's
review budget on work no reviewer had seen.

### The implement payload

Deterministic and bounded, like the remediation brief. Context sources appear
as **paths, not contents**, for the reason [the task brief](#the-task-brief)
gives: the agent runs inside the worktree and can open them itself.

Both builders are held to one budget by `src/loop/payload-budget.ts`. They were
briefly bounded separately, by two constants of the same value and two private
clamps — and the clamps disagreed on their first day: one reserved a character
for its trailing newline and stayed inside the budget, the other appended its
marker after slicing and overshot it. A clamped payload is now always at or
under the ceiling, marker included, because a budget a result can exceed is not
a budget.

A source that could not be opened is still rendered with its status rather than
omitted, even though the step above now parks before such a brief can reach
here. That branch is for any other caller: silently dropping a declared path
would be the worse failure.

### One consequence worth stating

`RESUME_PHASE_NOT_DRIVEN` is now unreachable through any legal resume point.
All four resume phases map to states the loop drives, so the driver's gate can
no longer fire from a valid `resumeFrom`. It is kept as a fail-closed floor
against a widened vocabulary, not removed — but an `IMPLEMENT` pause now
genuinely resumes instead of being refused.

## The task brief

Source: `src/plan/task-brief.ts`.

Task *discovery* answers "which tasks exist and how do they relate", and its
whole discipline is that a task file's prose contributes nothing to that
answer. The brief answers a different question — "what should the writing agent
be told" — and prose is the only correct source for it. Keeping them apart is
what lets both rules hold at once: **the plan still cannot be changed by
rewording a paragraph, and the paragraph can still reach an agent.**

`TaskDefinition` therefore gains no `body` field, and nothing in `task-brief.ts`
is consulted by the selector, the graph or the eligibility rules. A body that
says `status: DONE` changes nothing, and `tests/task-brief.test.ts` pins that.

### Two briefs, and why they are different types

`previewTaskBrief` is for a **plan**; `readExecutionBrief` is for a **run**.
They return different types on purpose.

A preview inspects the **source checkout** — whatever `main` looks like now — so
an operator can see whether a repository looks onboarded. It carries no
`contextComplete`, because there is no completeness question to answer about a
tree the run will not use, and it cannot be handed to the loop: that is a type
error rather than a subtle mistake.

An execution brief inspects the **authorised task worktree**, pinned at
`basePinnedCommit` — the tree `buildImplementPayload` tells the agent to open,
and the tree the agent's `cwd` really is.

They were one function once, proved against the source checkout, while the
payload told the agent those paths were "in this worktree". Once execution
gated on that verdict, a file present on `main` and absent from the pinned
worktree produced a writer briefed on a promise nobody had checked — and a file
deleted on `main` while a task was in flight parked a task whose own worktree
still had it.

The task's **prose** still comes from the repository's task source rather than
from the worktree, deliberately: a human who corrects a task file to release a
parked task edits it on the default branch, and a run reading its instructions
from the pinned worktree could never see that correction.

### Context sources are named, not inlined

The profile declares `context.canonicalSources`. The brief proves each one is
present and safe to open, and then reports its **path** — it does not copy the
file's contents.

Because nothing is parsed, the inspection has **no size ceiling**. It used to
borrow the 256 KiB *task-file parsing* ceiling and then discard the bytes, which
protected nothing and reported a perfectly readable architecture note as
unreadable — blocking every task in the repository once execution gated on the
verdict. `PRESENT` means exactly: the path exists, lies safely inside the tree,
is a regular file, is not a link, and opens read-only. The byte budget for
actually *loading* context is a separate contract, and belongs wherever that
loading is implemented.

A **directory** is not a legal context source. `docs/` is refused when the
repository is resolved, as `CONTEXT_SOURCE_NOT_REGULAR_FILE` — a configuration
error judged where configuration is judged. Left to execution it became a
permanent `HUMAN_DECISION_REQUIRED` on every task, telling an operator that a
task is stuck rather than that a profile line is wrong. A source that simply
does not exist is *not* this: absence is an ordinary execution-time `MISSING`,
and a repository may declare a document it has not written yet. Directories and
globs may become legal later, with their own source type and a bounded
enumeration.

That is a design decision, not a budget compromise. The writing agent is Claude
Code running *inside the task's worktree*: it can open those files itself, when
it needs them, in the order its own work requires. Inlining them would replace
that with a fixed, truncated snapshot chosen by the wrong layer, make every
payload grow with the repository, and cap the useful context at whatever
ceiling happened to be set in this module. Naming a file the agent can read is
strictly more useful than pasting a prefix of it.

What the orchestrator does owe the operator is the guarantee that the names are
good: a declared source that is missing, unreadable, or a link out of the
repository is reported here rather than met by an agent halfway through a task.

### Bounds and refusals

The body is clamped to `MAX_TASK_BODY_BYTES` (8 192 **UTF-8 bytes**) and a clamp
is **reported** (`bodyTruncated`), never silent — the rule
`buildRemediationPayload` already follows when it briefs an agent from partial
evidence. The same file always produces the same brief, and CRLF is normalised
so a task does not mean two different things on two platforms.

Bytes rather than JavaScript string length, and never mid-code-point. Slicing
UTF-16 code units could keep a high surrogate and drop its low one, yielding a
string with no valid UTF-8 representation: it reached the agent as U+FFFD while
`bodyTruncated` reported only that the tail had been cut, and "the same brief,
byte for byte" was vacuous because encoding it was lossy rather than an
identity. Truncation now cuts between code points, so a body ending in an emoji
loses the emoji rather than half of it. (Grapheme clusters may still split —
that is a different contract, and this one is stated in code points because
that is what valid UTF-8 requires.)

A file whose frontmatter parses but which carries **no prose at all** is
`TASK_BODY_EMPTY` rather than an empty brief: a title is not a task, and a
repository is better told its file is incomplete than handed an agent run that
guesses. Failures carry a closed code and a static sentence — no path, no
filename, no file content.

### One owner for "safe to open"

`src/repo/internal/contained-file.ts` owns the chain every reader of repository
content uses: classify with `lstat` so a link is *seen* rather than followed,
refuse a link outright, re-canonicalise, re-test containment, then either read
(`readContainedFile`, with a **parsing** ceiling), inspect without reading
(`inspectContainedFile`, no ceiling), or prove a directory
(`proveContainedDirectory`).

It lives under `repo/` because `plan/` already depends on `repo/` and not the
other way round. An earlier version of this section named a module under
`plan/internal/` and claimed discovery had held "the only copy" of the chain —
which was false when it was written: the resolver held `isContained`,
`samePath` and `classify` verbatim and ran the same steps inline. Both are now
callers.

Discovery, the brief reader and the resolver each translate the refusals into
their own vocabulary, because "this file is a symlink" is `TASK_FILE_UNSAFE` to
one, a context-source status to another and `PROFILE_NOT_REGULAR_FILE` to the
third. Callers may differ there; they may not each re-derive the chain.

Three other modules define a same-named helper — `doctor/safe-write.ts` and the
two worktree modules — and none is a copy of *this* chain: one contains a
diagnostics artefact inside the per-user run directory, the others compare paths
Git printed. They are named in `tests/v2-02-remediation.test.ts` rather than
silently excluded, because a claim of "one owner" was already false once.

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
scope:                       # enforced since V2-06, against the pinned commit
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
`REQUIRED_CAPABILITY_UNAVAILABLE`, `REMOTE_REQUIRED_BUT_ABSENT`,
`CONTEXT_SOURCE_NOT_REGULAR_FILE`.

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
anyway would durably assert a directory nobody created. That refusal still
stands: starting a task is `startTask`'s job (see [Starting a
task](#starting-a-task)), and the driver's `TASK_NOT_STARTED` is the correct
answer to "drive a task that has no state". `runLoopStep` also does not drive
`IMPLEMENTING`, so a freshly created state cannot yet be moved out of the setup
chain — that belongs to the implement step.

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

## Integrated validation

V1-08 adds no state, no edge and no field. `TaskState` stays at schema
version 1 and `READY_FOR_PR` stays terminal. What it adds is evidence — and,
where that evidence found something, four fixes.

Every slice before this one is tested against a *literal* of the layer beneath
it: `tests/run-driver.test.ts` writes its own `ResolvedRepository` and scripts a
`GitRunner` that answers `worktree list` from a string. That is the right shape
for asking "does the driver stop when the registry is unreadable?", because no
real repository can be asked to have an unreadable registry on demand. It cannot
answer whether the slices agree with each other.

So `tests/v1-08-e2e.test.ts` composes the real things: a real `git init`
repository, a real `git worktree add` made by `prepareTaskWorkspace`, a real
state file written by `saveTaskState`, and the registry that `git worktree list
--porcelain` really prints. Only the two agent boundaries are injected — Claude
and Codex are subscription CLIs, and `AgentRunner` exists so that no test starts
one.

The composition had a seam worth naming, and V2-03 closed half of it. When this
suite was written there was **no production entry point from a resolved
repository to a first `TaskState`**: `runTask` refuses to create one, so the
suite seeds a state at `VERIFYING` from the real workspace receipt, and that
step was the test's rather than the product's.

`startTask` is now that entry point — see [Starting a task](#starting-a-task) —
so the *creation* half is shipped code. The seeding here remains the test's own
for a different reason: `startTask` creates a state at `WORKTREE_READY`, and
these scenarios need one at `VERIFYING`, which requires the setup chain and the
implement step that still do not exist. The boundary has moved rather than
disappeared, and it will move again with the implement step.

### What the composition found

**The recorded workspace was never checked against the derived one
(V1-07-R-1).** `observe-runtime.ts` looked the recorded `worktreePath` up in
Git's registry and required the recorded `workBranch` to be checked out there —
both sides of both comparisons coming from the same file. Two claims that agree
with each other are not authority; they are one claim written twice. Since
`git worktree list` registers the **main working tree**, and it does hold the
default branch, a state naming the repository root and `main` satisfied every
check, and the verifier, the reviewer and the **Claude writer** were handed the
canonical checkout as their working directory.

`reconcileTaskState` now re-derives both claims through the same
`deriveTaskWorkspaceIdentity` that `prepare-workspace.ts` built the workspace
with, and refuses a record that does not match:
`WORK_BRANCH_NOT_DERIVED`, `WORKTREE_PATH_NOT_DERIVED`, and
`WORKSPACE_IDENTITY_UNDERIVABLE` when no identity exists to check against. The
comparison is by path identity, not by string — Git prints `C:/…/wt` where
`node:path` builds `C:\…\wt`, and a string comparison would refuse every real
task on Windows.

**The persisted fingerprint accepted anything non-blank (RR-B1-N4).** The one
producer emits a 32-character lowercase hex digest; the contract accepted any
non-blank string, and `buildResumedRemediationBrief` renders the durable value
into a **writing** agent's prompt, one record per newline-joined line. A
persisted state is untrusted input whoever wrote it, so a fingerprint carrying a
line break arrived in those instructions as a free-standing line, able to forge
the `FINDINGS (n; …)` header above it. That is the reasoning the reviewer's
`path` allow-list already applies, and the defence belongs in the same place:
`FindingRecordSchema` now pins `^[0-9a-f]{32}$`, so the value is refused where it
is admitted rather than escaped where it is rendered. The generated JSON Schema
carries the pattern; the contract version is unchanged, because narrowing an
accepted set is only safe while no states exist in the wild.

**A resume could land a task where nothing could continue it.** `IMPLEMENT` is a
declared resume phase of `BLOCKED_USAGE_LIMIT` and `evaluateAutomaticResume` will
authorise it, but `runLoopStep` has no implement step. Writing that resume spends
`resumeFrom`, `reportedResetAt` and `blockedAgent` and withdraws both checkpoint
claims — so the task landed in `IMPLEMENTING` carrying none of the evidence a
later run needs, and `evaluateAutomaticResume` could never grant it again. A
self-clearing pause became a task no run can pick up, in exchange for no work at
all. That is the V1-07-RR-B1 failure on a second axis, so the same rule applies:
the driver now refuses with `RESUME_PHASE_NOT_DRIVEN` **before** the write, and
`isLoopDrivenState` is pinned against `runLoopStep`'s own dispatch.

**A refused write still carried a remediation brief.** `LoopStepResult.remediationPayload`
is documented as present only on the write that enters `REMEDIATING`. The driver
happened to be safe, because it carries a payload only out of `ADVANCED` — but
the contract held by the caller's good manners rather than by the value.

### Unattended resume is inert in this build, and that is now stated

`BLOCKED_USAGE_LIMIT` is the one state `automaticResumeEligible` marks, which
reads as though unattended resume operates. It does not, and cannot:

1. **No reset time exists.** `readClaudeResultEnvelope` returns
   `reportedResetAt: null` unconditionally, because no such field was observed in
   either CLI's output, and this build refuses to invent one.
   `evaluateAutomaticResume` denies `RESET_TIME_MISSING`. This lock is
   phase-independent.
2. **The checkpoint claims are withdrawn (F-10).** Entering `REMEDIATING` sets
   `currentCommit: null` and `worktreeCleanAtCheckpoint: false` — correctly,
   because a phase whose purpose is to modify the worktree may not assert a clean
   one. `evaluateAutomaticResume` independently requires both, and denies
   `CURRENT_COMMIT_MISMATCH` and `WORKTREE_NOT_CLEAN`.
3. **Codex has no quota recogniser at all**, so `blockedAgent: 'codex'` is
   unreachable.

Each lock is sufficient alone. F-10 is therefore **not remediated here**: closing
it would open one of three doors, and the other two are shut for reasons this
repository considers correct. Weakening `evaluateAutomaticResume` to accept
freshly observed facts in place of the withdrawn claims would trade a real safety
property — "nothing moved while we waited" — for a capability that still would
not work. The V1-08 suite pins the denial with its three reason codes, driven
through a real 429 envelope rather than a hand-built state, so the gap is a
tested fact rather than an implication of fixtures.

### The verification seam now runs (F-8)

`runVerificationCommand` is what will run a target repository's own `npm run
build`. Until V1-08 **no test had ever executed it**: the pure translation was
covered, and every caller injected a runner.
`tests/v1-08-verification-boundary.test.ts` spawns real processes through it and
pins `cwd` propagation, the argument vector, a non-zero exit, a failing run's
retained output, a command that cannot start, an argument refused as
shell-unsafe, and an output budget that terminates the child. The timeout is
asserted as the constant it is; the mechanism belongs to `runCommand` and is
exercised in `tests/exec.test.ts`.

### Verification is a stated V1 platform limitation, not a hidden followup

The item carried as **F-9** is resolved here as a documented limitation rather
than as code: it was never a defect to fix, it is a boundary to state.

The verification child runs under the `capability:generic` environment policy:
**`PATH` and `PATHEXT` are the only variables explicitly supplied**, plus
whatever the platform back-fills of its own accord. On Windows libuv adds
`SYSTEMROOT`, `TEMP`, `USERPROFILE` and friends, which is why a Windows build
starts at all.

The consequence is a boundary on what V1 has actually demonstrated, and it is
stated here rather than carried as a followup because an operator meets it on
their first run:

- V1's canonical verification evidence is **Windows + Node 22** — `verify` runs
  on `windows-latest`, and `tests/v1-08-verification-boundary.test.ts` spawns its
  real processes there;
- **portability to POSIX, or to any project toolchain that needs `HOME`,
  `npm_config_*`, `TMPDIR`, `LANG` or a proxy variable, is not proven by V1.** A
  POSIX `npm` without `HOME` is the concrete case;
- the failure mode is **fail-closed**: a command that cannot start is
  `UNAVAILABLE`, which `run-verification.ts` reports as unrunnable rather than
  failed, and the loop sends the task to a human. It never becomes a false
  `PASSED`, and it never becomes `BLOCKED_VERIFY`, which would blame the
  repository for something that is this build's limitation.

Widening the policy is a product decision with a failing test behind it, not a
quiet edit — `tests/v1-08-verification-boundary.test.ts` asserts the current
narrow answer, so changing it has to be deliberate.

### Carried forward, deliberately

- **F-4** — on Windows `isAbsolute` accepts a drive-relative root (`\foo`), so
  two states recording it compare equal while naming different volumes. No
  producer can emit such a path, and the one axis on which a hand-written value
  could have reached a spawned `cwd` is now closed upstream by the derived
  identity check. Tightening it additionally means teaching every fixture a
  platform-specific absolute path, which is its own change.
- **F-2** — no invariant ties `findingHistory[].round` to `reviewRound`. The loop
  writes both on one write and cannot violate it; only a hand-edited state can.
- **F-5** — `remediationPayload` carries no round or revision. The driver carries
  it across exactly one edge and drops it otherwise; a second producer would make
  this live.
- **F-7** — caller-chosen interruption identity is reachable only from a
  non-agent phase, which is the unimplemented setup chain.
- **AGENT_SESSION_REJECTED** has no producer, so `BLOCKED_AUTH` is unreachable
  from the loop and auth failures land in `HUMAN_DECISION_REQUIRED`.
- **RR-F6** — `repo/git-query.ts` still has no injection seam, and V1-08 did not
  add one: the E2E suite uses real repositories throughout, which is the reason
  that seam has not been missed. It remains **open and deferred**.

### What V1-08 is not

No CLI command, no setup chain, no `runImplementStep`, no multi-task queue. The
driver still runs one task per invocation, `scope.allowedPaths` is still declared
rather than enforced, and nothing here opens a pull request, pushes or reads CI.

## Attended execution (V2-05)

One task can now be run from the CLI:

```
agent-loop run --repository <abs path> --attended [--task <id>] [--max-steps <n>]
```

**A bare `agent-loop run` is unchanged and still writes nothing.** That is a
contract, not a phase of development: the command shipped as read-only in V2-01,
and scripts may be invoking it on that promise, so execution arrived as a new
flag rather than as a new meaning for an existing verb.
`tests/run-command.test.ts` proves the default by driving the real command
against a real repository with a startable task and checking that no state file,
branch or worktree appeared.

Executing requires **two independent things**, and neither implies the other:

| Requirement | What it states | How it is satisfied |
| --- | --- | --- |
| `--attended` | An operator is present for *this* invocation | Passing the flag |
| Auth evidence | The agent CLIs are logged in on an accepted subscription | A real preflight passing |

Passing `--attended` on a machine that is not logged in refuses with
`AUTH_PREFLIGHT_FAILED` and creates nothing. Being fully logged in without
`--attended` still only produces a plan. There is no flag that declares the
preflight satisfied, and there is no `--force`, `--adopt` or `--unattended`.

Every way a start can end has an exit code (`START_TASK_EXIT_CODES`), mapped onto
the six codes the command already used rather than onto thirteen new ones. The
mapping is total by `satisfies`, and `tests/run-exit-codes.test.ts` proves its
expectation table is load-bearing by mutating it.

### Auth evidence is produced, not asserted (I4)

`RunRequest` used to carry `authPreflightPassed: boolean`, documented as
"evidence, never assumed" — and it was not. Nothing on the execution path called
`runAuthPreflight`, so `runTask({ …, authPreflightPassed: true })` was a
type-correct way to claim a preflight that never ran, and the test suite did it
routinely.

It now carries `authEvidence: AuthPreflightEvidence | null`: an opaque artefact
whose only producer is the real preflight. A plain evidence *object* would not
have fixed this — TypeScript is structural, so `{ allPassed: true, checks: [] }`
would have been the same assertion in a longer spelling. Three layers hold it,
of three different kinds:

- **nominal typing** — the artefact carries a `#private` field, so no object
  literal is assignable to it and `{ proven: true }` does not compile as evidence;
- **a runtime check** — `isAuthPreflightEvidence` is an `instanceof` test, so
  `as unknown as` fails closed and denies exactly as an absent value does;
- **reachability** — the mint lives in `core/internal/`, and a test walks `src/`
  to pin that exactly one module imports it.

What this does *not* claim is freshness: it proves the preflight ran in this
process and passed, not that it did so recently. `tests/auth-preflight-evidence.test.ts`
is written as the counter-proof — four routes back to the old position, each
refused.

## Scope enforcement (V2-06)

`scope.allowedPaths` is now enforced. Until this slice it was declared and
nothing read it, so a writing agent was confined only by its `cwd`.

The guarantee is about **effect, not intention**:

> A mutating step cannot be left successfully until the task's *actual*
> cumulative effect on the repository has been measured against the scope it
> was pinned under.

`runImplementStep` and `runRemediateStep` both run the same guard, twice:

```
load the scope out of the pinned commit
         ↓
PRE-SCOPE   full task delta ⊆ allowed scope?
         ├── no → SCOPE_VIOLATION, and the writer never starts
         ↓
the writing agent
         ↓
POST-SCOPE  full task delta ⊆ allowed scope?
         ├── no → SCOPE_VIOLATION, no verification and no reviewer
         ↓
durable transition → VERIFYING
```

The second check is the one the guarantee rests on. A scope tested only
*before* a writer governs what the loop intended to permit; the repository only
ever suffers what the writer actually did. The pre-check is not symmetry — a
violation is left in the tree as evidence, so a step can legitimately *begin* on
an already-violated worktree, and without it the next run would hand that tree
to an agent and only notice afterwards.

**No state and no edge were added.** `SCOPE_VIOLATION` was already in
`src/core/states.ts`, already a declared successor of both mutating states, and
already the one block that is not resumable at all. `TaskState` is unchanged at
schema version 1.

### The delta is the whole task effect, not `git status`

A writing agent is allowed to commit, and a writer that commits leaves a
**clean** worktree — so the observation an agent most easily makes invisible is
exactly the one a `git status` check misses. The guard measures the cumulative
state instead:

```
basePinnedCommit
      ├── committed tracked changes   ┐
      ├── staged tracked changes      ├── git diff <base>
      ├── unstaged tracked changes    ┘
      └── untracked, non-ignored      ─── git ls-files --others
```

Ignored files are deliberately **not** a scope effect — the orchestrator writes
its own runtime state into an ignored directory, so counting them would fail
every correctly configured repository. A *tracked* file stays observed even when
an ignore rule matches it: an ignore rule does not un-track a file.

Renames are split rather than parsed. `--no-renames` turns a move of
`secret/key.ts` into `src/key.ts` into two records — `D secret/key.ts` and
`A src/key.ts` — so both endpoints are classified and the forbidden deletion
cannot hide behind the allowed addition. `protectedPaths` wins over
`allowedPaths` wherever they overlap, and is consulted first.

### Attacking the observation, not the files

A writer that cannot hide *in* the delta will try to break the instrument. Three
ways it can, each verified against real Git and each closed:

| Attack | What it does | How it is closed |
| --- | --- | --- |
| `git replace -f <base> <forged>` | Re-points the pinned commit, so the diff is taken against a tree the writer built. `refs/replace` lives in the common ref store, so a linked worktree can install one. | `--no-replace-objects` on both object reads |
| `update-index --assume-unchanged` / `--skip-worktree` | Tells Git to stop comparing a tracked path with the worktree; `git diff <base>` then reports nothing however far the file moved. No flag makes `diff` look anyway. | `ls-files -v` detects the bits → `INDETERMINATE` |
| A writer-authored `.gitignore` containing `*` | Excludes the writer's new files from `ls-files --others --exclude-standard` — and excludes itself along with them. **Needs no Git command at all: two plain file writes.** | Ignore files are recovered from the ignored listing and classified like any other path |

The third rests on a property of the workspace rather than a new rule: a task
worktree starts as a clean checkout of `basePinnedCommit`, so every untracked
file in it is the task's own doing, and an untracked `.gitignore` is therefore
always writer-authored. One planted *inside* the allowed subtree is permitted,
because an ignore pattern cannot reach above its own directory and so can only
hide paths that were already allowed.

`ls-files -v` lists every tracked path and the Git seam caps output at 1 MiB, so
a repository large enough to exceed that parks the task as `INDETERMINATE`
rather than passing it — the right direction to fail in, stated here rather than
left to be discovered.

### The scope is the pinned one, and the writer cannot widen it

The governing declaration is read with `git show <basePinnedCommit>:<profile>`,
not from `repository.scope` and not from the worktree:

- **not `repository.scope`** — that describes the source checkout, so a profile
  edited on the default branch would silently re-scope a run already under way;
- **not the worktree** — that is the tree the writing agent has write access to,
  so reading the policy there would be asking the agent how far it may go.
  Self-authorisation, one file edit away.

A writer can dirty a worktree; it cannot change what an existing commit
contains. The profile is re-validated through the same YAML and contract
boundaries as any other profile, because a commit is not trustworthy merely for
being immutable.

### "Could not check" is neither a pass nor an accusation

The verdict is three-way. An unreadable Git, a pin that no longer resolves or a
profile missing from the pinned tree produce `INDETERMINATE`, which parks the
task at `HUMAN_DECISION_REQUIRED` carrying the phase it was heading for — *not*
`SCOPE_VIOLATION`, which says an agent left its sandbox and sends an operator to
look at damage that may not exist. Both stop the task; only one accuses. It is
the same split `runVerifyStep` already makes between `BLOCKED_VERIFY` and a
verification that could not be run.

Nothing is ever reverted. The offending changes are the evidence a human is
being asked to inspect, and undoing them would hide the effect *and* risk
destroying legitimate work in the same tree.

### The verdict cannot be handed in

There is no `scopePassed` flag, no scope override and no caller-constructible
assessment anywhere in `LoopDependencies`. The mutating step calls the assessor
itself, and the assessor reads the scope out of the pinned commit rather than
taking one as a parameter — so unlike V2-05's auth evidence there is no artefact
in flight to forge. The one seam a caller may substitute is the `GitRunner`,
which supplies raw evidence a step still judges for itself.

`tests/v2-06-scope-enforcement.test.ts` is written as the counter-proof, against
real repositories and real commits: a committing writer whose tree is provably
clean, a rename out of a forbidden directory, a writer that rewrites its own
profile to authorise itself, and a profile widened on the default branch after
the pin — each refused.

## Workspace recovery (V2-06A)

`startTask` creates the workspace and then writes the first durable state. The
gap between those two acts was the last hand-cleanup in the product:

```
prepareTaskWorkspace succeeds
         ↓
worktree + branch exist
         ↓
CRASH                          ← the window
         ↓
no TaskState was ever written
         ↓
the next start collides with its own leftovers
```

A start now *tests* that collision instead of refusing it outright. Where the
leftovers are provably this task's own untouched workspace they are adopted, and
the start writes the ordinary `WORKTREE_READY` it would have written anyway.

### Adoption is a conjunction, and every term is proven

A workspace is adopted only when **all** of these hold, each established from
Git or from canonical derivation and none from a caller's claim:

- no durable `TaskState` exists — and the absence is *positive*: an unreadable
  or invalid record is a record, never an absence;
- the identity is re-derived by the same pure function preparation uses, so
  there is no "workspace to adopt" parameter for anyone to point somewhere;
- Git registers that exact path, holding this task's branch — judged on the
  branch Git reports, never on the derived name compared with itself;
- read from inside the worktree: right root, right branch, right commit,
  nothing done in it;
- `HEAD` is the commit a fresh start would pin **now**;
- the source checkout still satisfies every invariant a start requires.

**`HEAD` must equal the current base tip**, not merely some ancestor. A pristine
orphan left behind at an earlier tip — because the base branch moved on after
the crash — is not the workspace a fresh start would produce, and adopting it
would silently start the task from a base nobody chose. It is reported as
`WORKSPACE_HEAD_MOVED` and a human decides.

**A commit in the orphan makes it less adoptable, not more.** Without durable
state nothing records whether an agent ran, whether verification passed, or what
authority was lost. There is nothing to reconstruct, so nothing is reconstructed.

### No second truth

There is no `ADOPTED` task state and no second recovery lifeline. Adoption
produces the ordinary `TaskWorkspace` receipt and `startTask` writes the ordinary
first state from it, so a task recovered from a crash and a task freshly created
are indistinguishable from the next step onwards, and both run through the same
reconciliation. `ADOPTED` exists only as a *start outcome* — a fact about the
invocation, reported to the operator, carried nowhere.

`WORKSPACE_COLLISION` gained no new meaning either: reaching it now means the
recovery assessor looked and refused, and its verdict is the second reason code.
The vocabulary — `STATE_ALREADY_EXISTS`, `STATE_UNREADABLE`,
`WORKSPACE_NOT_REGISTERED`, `WORKSPACE_PATH_MISMATCH`,
`WORKSPACE_BRANCH_MISMATCH`, `WORKSPACE_HEAD_MOVED`, `WORKSPACE_DIRTY`,
`WORKSPACE_UNTRACKED_CONTENT`, `OWNERSHIP_UNPROVEN`, … — is a *recovery*
vocabulary translated into outcomes, not ten new task states.

### `agent-loop release --attended`

```
agent-loop release --repository <abs path> --task <id> --attended
```

The other thing an operator may want from a proven orphan: not to continue it,
but to be rid of it. It removes **exactly** the workspaces adoption would have
accepted — the same proof, reused rather than restated, so there is no laxer
notion of ownership on the destructive path. A worktree holding a commit, a
dirty one, one whose base has moved, or one whose task has durable state is
refused with the verdict that refused it.

`--attended` is required, and there is no `--force`.

### What recovery does not solve

**Mutual exclusion.** Two processes starting the same task concurrently can
still race for creation or adoption. This slice detects *crash artefacts*; it
does not prevent *concurrent owners* on its own. That is the execution lease's job (V2-07L), and `release --attended` now holds one for the whole removal
and is still required before unattended block autonomy.

## The block-run ledger (V2-07)

The durable record of one started block run — and the first piece of
multi-task machinery in the build. It stores; it does not drive.

One principle governs the whole contract:

> The ledger is durable **orchestration** truth, and never the primary truth
> about a single task.

A `TaskState` proves what happened to a task. The ledger references it and
derives block progress from it; it never overwrites it, and where the two
disagree the ledger never wins.

### Two words that must not become one

```
BlockDefinition   what this block should work through
BlockRunLedger    what durably happened in one started run of it
```

The same line V1-02 holds between `TaskDefinition` and `TaskState`, one level
up. A run **freezes** its membership: `frozenTaskIds` and a `planFingerprint`
over the block id and ordered task ids are written once and never again. A
roadmap edited mid-run cannot silently swap task four while tasks one to three
have already gone — the drift is reported, never adopted.

The fingerprint deliberately covers identity and order only, not task prose or
status: a task's `status` becomes `DONE` precisely *because* the run worked on
it, and a fingerprint that moved with it would report drift on every success.

The fingerprint is **re-derived from the document that carries it** on every
create, update and load. A stored digest describing a plan the document does not
list would not merely lose drift detection — it inverts it, so the honest
roadmap reports as drifted and the edited one reports as clean.

Reconciliation derives it too, rather than reading the stored field.
`reconcileBlockRun` takes a ledger *value*, and a value did not have to come
through the store to get here — so it recomputes the frozen membership from the
document's own `blockId` and `frozenTaskIds`, and holds both the ledger's stored
digest and the repository's current definition against that. A value whose
stored digest describes a plan it does not list is reported as
`PLAN_FINGERPRINT_UNSOUND` rather than believed. Believing it was the one door
the store does not stand in, and every drift answer behind that door was
inverted.

### Progress is evidence, not assignment

`SETTLED`, `BLOCKED` and `ABANDONED` are not setters. `settleBlockTask` reads
the task's durable state and refuses unless it proves the claim —
`READY_FOR_PR`, which the task contract already makes expensive to reach — and
writes the **revision** of that state into the entry. A claim with no evidence
is refused by the contract itself, before reconciliation ever looks.

That proof lives at the **store**, in `block/block-evidence.ts`, and is applied
by `updateBlockLedger` before anything lands. One definition of "supported",
used by the gate that writes and by the reconciler that observes: a proof that
lived one layer above the store was a proof a caller could walk around, and a
reconciler with its own weaker idea of what a record proves would certify what
the gate refused.

A run drives at most one task at a time; parallelism inside a block is not a V2
contract. A run may not simply stop, either: `stopReason` is a closed
vocabulary (`COMPLETE`, `TASK_BLOCKED`, `TASK_ABANDONED`, `NO_ELIGIBLE_TASK`,
`OPERATOR_STOPPED`, `LEDGER_DIVERGED`, `STATE_UNUSABLE`, `DEFINITION_DRIFTED`).

Three of those are claims about what the tasks did, and each is **proved against
every task's own record** before it is written, not checked against the ledger's
own entries. Checking `COMPLETE` against the entries that assert it is asking
the document that makes the claim whether the claim is true.

Any write that moves a disposition is held to the same standard, and to *every*
entry rather than only the one it moved. A write re-serialises the whole
document, so an entry forged on disk by hand would otherwise ride out on the
next legitimate activation, carried forward under the store's signature having
been examined by nothing — and there is no such thing as progressing a run whose
record is already unsupported.

The exempt write is a stop whose reason asserts no progress:
`OPERATOR_STOPPED`, `NO_ELIGIBLE_TASK`, `LEDGER_DIVERGED`, `STATE_UNUSABLE`,
`DEFINITION_DRIFTED`. Those say the run *cannot continue*, which is exactly what
a run with an unsupported ledger needs to be able to say. Requiring a clean
proof there would mean a run that has just detected a divergence could not
record having detected it — the one thing it must always be able to do.

For one slice that exemption was unreachable in the case it was written for,
because a second rule said a stopped run may not also have an active task. A task
whose record has become unreadable proves neither settlement nor blocking nor
abandonment, so nothing could move it off `ACTIVE`, so `activeTaskId` could not
be cleared, so no stop could be written at all: a run could *see*
`STATE_UNUSABLE` and never record it, and the only move left was hand-editing the
ledger. A non-progress stop may therefore now be recorded **over a task that is
still unresolved**, and the document then says what actually happened — the block
stopped, and this task was `ACTIVE` when it did. Rewinding the entry to `PLANNED`
was the alternative and is the worse one: it claims the task was never started,
when the run knows perfectly well that it was.

That write is held to its minimum. It may set `stopReason` and change nothing
else — no disposition, no commit, no evidence, no identity, and not
`activeTaskId` itself — or it is refused as `UNRESOLVED_STOP_CARRIED_MORE`. The
one write that needs no evidence is thereby also the one write that can carry
none. The three reasons that *do* claim something about the tasks stay
unavailable while a task is unresolved, refused by the contract rather than
merely discouraged by the caller.

And an ended run is history rather than a present tense: once `stopReason` is
set, no later successor may move a disposition or edit an entry
(`STOPPED_RUN_PROGRESSED`). `block-progress` had refused that all along, which
made it caller manners rather than contract — and manners are precisely what a
caller going one layer down walks around. Without the rule the store accepted
genuinely-proved progress *after* the ending, leaving a durable ledger that read
`LEDGER_DIVERGED` over entries which had all since moved to `SETTLED`, and which
reconciliation then called consistent.

A stop reason is also **written once**. `LEDGER_DIVERGED` relabelled
`OPERATOR_STOPPED` destroys the only durable trace that a divergence was ever
detected and leaves an operator reading a run that looks deliberately ended.

### `ABANDONED`, and the wedge it exists to prevent

`ABORTED` is terminal and *not* blocking: the task is over, deliberately and
irreversibly, and there is nothing for a human to resolve. Without a disposition
that says so, an `ACTIVE` task whose record reached `ABORTED` could not be
settled (it did not finish), could not be parked (it is not blocked), and while
it stayed `ACTIVE` the run could not be stopped. The block was wedged, and the
only remaining move was to falsify one of its own records — and a contract that
leaves inventing progress as the only escape will eventually be escaped that
way.

`abandonBlockTask` is evidence-backed exactly as settling and parking are: the
task's own state must be `ABORTED`, and the revision that proved it is written
into the entry. It is deliberately not `BLOCKED`: an operator triaging a stalled
roadmap needs "waiting for a human" and "over" apart, and since `COMPLETE`
requires every task `SETTLED`, an abandoned task correctly makes the block
uncompletable rather than silently forgivable.

### Persistence: create and update are different operations

Not one `saveBlockLedger` whose meaning turned on whether an optional field was
present. That reads as a convenience and is the hole: an update presented a
schema-valid document plus a current revision and got a write.

> A compare-and-swap answers *has anybody written since my revision?* It never
> answered *may this successor change these fields at all?*

`createBlockLedger` writes a first ledger and refuses if one exists.
`updateBlockLedger` requires the revision it read, then asks
`assessLedgerSuccession` whether the change was permitted at all: run identity
(`runId`, `repositoryId`, `repositoryRoot`, `blockId`, `startedAt`,
`schemaVersion`) and the frozen plan are immutable; dispositions move forward
only, and nothing leaves `SETTLED` or `ABANDONED`; an entry whose disposition did
not change may not be edited; a terminal stop reason is neither relabelled nor
cleared. `LEDGER_SUCCESSION_REFUSED` is kept apart from `LEDGER_CONFLICT` on
purpose — a conflict says *somebody else wrote*, and this says *you may not write
this*, however current your revision, so re-reading and retrying is not the fix.

A **creation claims no progress** — every entry `PLANNED`, nothing active, no
stop reason — and that is enforced rather than assumed. Splitting the store gave
the update path a predecessor to be held against and left creation with none, so
under an unused run id a first ledger needs no predecessor and no revision to
get written. Without the rule, that door takes the same forged `COMPLETE` the
update path had just been taught to refuse.

The file is named by the **run**, not the block, so starting the same block again
never destroys the record of the last attempt.

### The compare-and-swap is advisory, not atomic

Stated here because the store used to imply otherwise. Every write is a read
followed, several syscalls later, by an unconditional rename: two writers holding
one revision both pass the comparison, both are told they succeeded, and the
later rename wins — so a recorded `LEDGER_DIVERGED` can be lost to a concurrent
`OPERATOR_STOPPED` that had every reason to believe it was first.
`createBlockLedger`'s "only if there is none" is the same shape, a read and then
a write. It defends against starting the same run twice in sequence, which is the
mistake that actually happens; it does not defend against two callers racing, and
no longer claims to.

`state-store.ts` documents the same window and justifies it: the loser's file is
complete and valid, merely superseded. That reasoning does **not** carry over
here, because the loser is a run's whole recorded history rather than one task's
latest state. Closing it properly needs a repository-wide owner — the execution
lease. **One writer per ledger is a prerequisite this store depends on and
cannot enforce**, and `tests/v2-07-remediation.test.ts` pins that limitation with
a deliberate two-writer counter-proof so it stays a known boundary rather than
becoming a surprise. V2-07L now *supplies* the prerequisite from outside: the
lease makes at most one invocation the writer of a repository, and V2-08 holds one
across a whole block run with its ledger writes underneath it. The store's own
window is unchanged — it is guarded, not closed.

A block id may also not collide with one of its own task ids. The two grammars
are deliberately one rule, so an id alone never says which of the two it names —
and a reconciliation files findings about the block under the same field it uses
for findings about a task, which would leave a consumer unable to tell "this plan
drifted" from "this task's record does not support it".

### A ledger is bound to the file it came from

A document found *by* one identity that carries another is not that run's
ledger. The copy/backup shape this store names as its threat model made that
concrete: `run-0001.json` copied to `run-0002.json` loaded happily as run 0002,
and every later write through that value landed back in `run-0001.json` — a run
the caller never opened, under a revision it never read. `loadBlockLedger`
refuses it as `RUN_ID_MISMATCH`, exactly as the task store refuses
`TASK_ID_MISMATCH`, and compares the recorded root by path identity rather than
by string, as its sibling does.

The declared `repositoryId` is checked the same way, against the profile the
checkout actually carries (`repo/declared-identity.ts`). A field a store only
ever writes is a field nobody checks, and this one would otherwise travel intact
inside a ledger copied out of another project.

`repository.id` is configurable **logical** identity, though, not local Git
identity — two clones of one remote declare the same id and are two independent
local execution domains, while two worktrees of one clone are one. Holding a
ledger to it is right; keying an execution lease on it would not be.

### Reconciliation believes the records

The shape this exists to catch:

```
ledger:  A = SETTLED,  B = ACTIVE
reality: A never reached READY_FOR_PR
```

Taken at face value, a corrupted ledger has unlocked B — and once V2-09 makes
B's base A's result, it would have unlocked a *dependency edge on work that does
not exist*. So every outcome claim is re-checked against the task state, and
disagreement is `DIVERGED`. `tests/v2-07-block-ledger.test.ts` hand-edits a
ledger into exactly that shape and asserts it is not believed; removing the
check makes that test fail.

The commit fields are re-checked too, and were not at first. `evidenceRevision`
was re-derived on every reconciliation while `baseCommit` and `resultCommit`
were carried, so a hand-edited `resultCommit` — a perfectly shaped object name
belonging to no task and to nothing in the repository — survived every later
check and reconciled `CONSISTENT`. A field validated once is a field an editor
can change afterwards for free, and that particular field is what V2-09 intends
to make a successor's base: a forgery there is a forged dependency edge, not a
cosmetic error. `COMMIT_NOT_PROVEN_BY_STATE` is now a divergent finding, derived
from the task record's own `basePinnedCommit` and `currentCommit`.

Reconciliation also asks *whose repository is this* before it reads anything
from one, and reports `REPOSITORY_IDENTITY_DRIFTED`. `loadBlockLedger` already
holds both identities, but `reconcileBlockRun` takes a ledger **value** and a
root, and a value did not have to come through the store to get there — while
every task record it reads is looked up under that root. A ledger describing
another project is not slightly wrong there; it is asking about somebody else's
tasks.

**Reporting, not repairing.** The opposite direction — a task that reached
`READY_FOR_PR` while the ledger still says `ACTIVE` — is benign and is reported
as `TASK_AHEAD_OF_LEDGER` with `progressAvailable`, and **not** written. Which
positive reconciliations may safely be applied on their own is V2-08's decision,
made with a runner in front of it.

### Room for the chain, without the chain

Each entry carries `baseCommit` and `resultCommit`. `resultCommit` records the
commit a settled task's own record proves it ended at — and that is **not** a
claim that the commit is a fit base for a dependent successor. Whether a settled
task yields a usable chain commit is V2-09's separate question; the fields exist
so answering it needs no new ledger shape.

### One active task *per ledger* — and what that deliberately does not say

A ledger is a document about one run, so "at most one `ACTIVE` task" is a
guarantee about that document and nothing wider. Two runs in one repository can
each hold the same task `ACTIVE`, and both are internally correct about it: a
ledger knows only its own run, and two ledgers agreeing that a task is theirs is
exactly the absence of a repository-wide owner.

That is **not** a ledger defect and is deliberately not fixed here. Deciding
which process may produce effects for a task is repository-wide execution
ownership — the execution lease's contract (V2-07L), keyed on the local Git
administrative identity (the normalised `git-common-dir`, the same information
that proved two worktrees belong to one repository in V2-06A) rather than on the
profile's `repositoryId`. `tests/v2-07-remediation.test.ts` pins both halves:
the guarantee the ledger holds, and the guarantee it must not claim. Smuggling
half a lease into the ledger store would make the missing contract harder to
write, not easier.

### What the remediation closed

The eight cases in `tests/v2-07-remediation.test.ts` were reproduced against the
shipped V2-07 ledger, in real repository fixtures, through the ordinary public
API — no corruption, and hand-editing only where the attack genuinely needed a
file on disk. They are conserved as assertions of the contract rather than as
probes, in four clusters: successor authority and loaded identity; progress only
from external evidence; a terminal reason as history; and commit fields that
stay provable after the fact. Each is described in its own section above.

Two further cases are not from those probes. They are doors the remediation
**opened** and had to close behind itself — an unguarded creation, and a
reconciliation handed a ledger that never came through the store — and they are
labelled as such in the file, because where a case came from is part of what it
is worth.

Two more assert the opposite direction, and matter as much. A proof strong
enough to refuse a forgery is a proof that can quietly make the legitimate case
unreachable, so a block whose every task really finished must still record
`COMPLETE`, and a genuinely blocked task must still park and stop its run.

One of them is not a contract at all. The separator in
`fingerprintBlockDefinition` was a **raw NUL byte** in the source — invisible in
an editor, in a diff and in a review, and load-bearing, because it is the whole
reason two definitions cannot encode to one string. It is written as `'\u0000'`
now, and the test compares the digest with one computed from an independently
constructed separator, so the change is proven to move no existing fingerprint.

### Carried forward from the second adversarial review, deliberately

That review broke the remediation rather than reading it: six independent
read-only reviewers, every finding reproduced through a production boundary. Four
findings were fixed on the spot and are the rules above. These are the ones taken
as decisions instead.

- **F-5** — renaming `repository.id` while a run is open strands that run: it can
  no longer be loaded, written keeping the recorded id, or written adopting the
  new one. Accepted as fail-closed product behaviour. `repository.id` is
  *declared logical identity*, so changing it mid-run is a **migration**, not a
  transparent rename, and inventing a mechanism for it now would be inventing the
  answer early. Nothing false is persisted, and reconciliation still reports
  `REPOSITORY_IDENTITY_DRIFTED`.
- **F-7** — `BlockStoreOptions.replace` is a production type, and supplying one
  lets bytes the store never validated land while `LedgerSaveSuccess.revision`
  still describes the bytes it *intended* to write. Not an escalation: a caller
  that can pass a function into the store can already write the file. It should
  stay explicitly documented as a test seam rather than quietly available.
- **F-9** — `LEDGER_TOO_LARGE` on the save path has a producer but no reachable
  input: `encode` runs after the identity check, and every remaining field is
  bounded well under the ceiling. Harmless defensive symmetry with the load path;
  either the union is sharpened or the unreachability is documented, later.

Two things a later slice must not read into the ledger, neither of them defects:

- **`COMPLETE` is not run-scoped.** It means *every task of this block is in
  `READY_FOR_PR`*, never *this run produced these commits*. A `TaskState` carries
  no run identity, so a fresh run over already-finished tasks reaches `COMPLETE`
  immediately, doing no work, with every claim genuinely evidence-backed. V2-09
  makes one task's `resultCommit` the next task's base, and that is exactly the
  assumption it has to earn rather than inherit.
- **`loadBlockLedger` proves identity, never evidence.** It answers
  `LEDGER_VALID` for a document whose entries are fiction, by construction — the
  store's rule is scoped to *mutating* calls. A runner that reads
  `stopReason: 'COMPLETE'` without reconciling is trusting a forgery the store
  considers valid.

### What V2-07 is not

No block execution: nothing here drives a run. No dependent commit chain. No
execution lease — the ledger orchestrates no agent and no Git effect, and the
lease that supplies its missing single-writer prerequisite is V2-07L's, sited
outside this store rather than smuggled into it.

What the remediation established is narrower than it first looked, and worth
stating exactly: a compare-and-swap plus a successor contract is sufficient for
**one run's own record, against one writer at a time**. It says nothing about two
runs sharing a repository — and, as the second adversarial review showed, nothing
about two writers sharing one ledger either. The lease was previously described
here as required before *unattended* running. That was wrong by one slice; see
below.

## The execution lease (V2-07L)

> For one repository, at most one productive orchestrator writer holds authority
> at a time.

That sentence is the whole slice. V2-07 proved it was missing — two run ledgers
in one repository can each hold the same task `ACTIVE`, and neither document is
wrong — and it proved the ledger could not supply it: a store that writes one
run's record cannot decide which process may write at all.

### Keyed on the local Git domain, never on `repositoryId`

`repository.id` is *declared logical* identity. Two clones of one remote answer
the same id and are two independent local execution domains that must not exclude
each other; two worktrees of one clone answer the same id and are one domain that
must. Only the local Git administrative identity separates those, so the lease is
keyed on the normalised, absolute `git-common-dir` — the same information that
proved worktree membership in V2-06A. `ResolvedRepository` now carries it as
`gitCommonDir`, resolved once by the module whose job identity already is.

The file lives in that directory:

```
<git common dir>/agent-orchestrator-execution-lease.json
```

Every worktree of a clone resolves to it, including the orchestrator's own
`<root>.worktrees/<task>` workspaces. It is deliberately not under
`~/.agent-orchestrator/`: a per-OS-user lock would let two users of one checkout
each hold "the" lease, which is the split-brain the lease exists to prevent. And
it is deliberately not inside any working tree, where it would dirty the checkout
and refuse the next workspace with `SOURCE_WORKTREE_DIRTY`.

### Acquisition is exclusive, and proven so against real processes

The claim is a single exclusive-create operation, not a read followed by a write.
`tests/dist-artifact/execution-lease-race-dist-artifact.mjs` runs eight real OS
processes at one lease, five rounds, and requires exactly one winner each time —
and it is itself held to biting: replacing the exclusive create with an
overwriting one makes all eight win.

### The lease appears complete, or not at all

The first version claimed with `open(…, 'wx')` and wrote the record through the
same handle afterwards. That is exclusive, and it was not enough — and the race
harness is what said so, on its first run, rather than a review. Some losers saw
the winner's file *before its record was in it*, and refused with
`STALE_LEASE_RECOVERY_UNSAFE` for a lease whose owner was running perfectly well.
Fail-closed, and the wrong word: that code points an operator straight at `lease
break` for a healthy run, which is exactly the confusion the two codes exist to
prevent.

So the record is now written to a temporary file beside the target, flushed, and
**linked** onto the lease name. `link` is atomic and fails with `EEXIST` when the
target exists, so it is exclusive *and* publishes the whole record in one
instant. A filesystem that will not link falls back to the `wx` claim, which is
still exclusive and only reopens that narrow window. A crash before the link
leaves an orphan temporary file nothing reads; a crash after it leaves a
complete, parseable lease with a dead owner — which is precisely the case the
recovery contract is written for.

### Evidence, not assertion

`acquireRepositoryExecutionLease` returns an opaque `ExecutionLeaseEvidence`, and
a `leaseHeld: true` would have been the `authPreflightPassed: true` defect again
in a new place. The arrangement is `core/auth-preflight-evidence.ts`'s, verbatim:
a nominal type with a `#private` field so no literal is assignable, an
`instanceof` gate so a cast fails closed, and a reachability test pinning that
exactly one module in `src/` imports the mint.

Four productive writer paths **require** it, non-optionally:

```
startTask · runTask · runNextTask · releaseTaskWorkspace
```

`releaseTaskWorkspace` is on that list for a specific reason.
`assessWorkspaceAdoption` proves a workspace is a *pristine* crash artefact — and
a workspace a concurrent run has only just prepared looks exactly like one. Only
exclusive ownership separates them, so leaving `release --attended` outside the
lease would have been a genuine split-brain hole, not a tidiness question.

The block store keeps its signature. The lease guarantee is **run-scoped** — V2-08
must hold one lease across a whole block run and perform its ledger writes
underneath it — and a per-write lease parameter would misstate that. What stops a
future runner reaching the store from outside a leased scope is an architecture
test: `createBlockLedger` and `updateBlockLedger` are pinned to exactly one
importer in `src/`, so a second one is a deliberate act that breaks the build.

### A lease acquired minutes ago is not a lease held now

The driver re-proves the lease against the file **every iteration**, before
anything else, for the same reason it re-reconciles every iteration: the previous
step was a subprocess that took minutes. A lease removed underneath a run stops it
with `EXECUTION_LEASE_LOST`, distinct from `EXECUTION_LEASE_NOT_HELD` — "you lost
it" and "you never had it" send an operator to different places.

### Recovery is refused, and the refusal is measured

The question a stale lease asks is whether a dead owner proves no writer survives
it. That was measured against this build's spawn path rather than read out of
documentation:

- killing **only** the orchestrator process did take its whole agent tree with it
  on the Windows host this was measured on — three launch paths, same result;
- and every process involved was inside a **Job Object the orchestrator did not
  create**, inherited from whatever launched it. `IsProcessInJob` says so
  directly, and `src/doctor/exec.ts` disclaims owning the tree in its own header:
  kernel-enforced ownership "would need … a Windows Job Object, which is a
  separate architecture and deliberately not part of this module";
- on POSIX the agent is spawned `detached`, making it a process-group leader —
  the opposite of a lifetime tied to its parent's.

**That is a platform observation, not a platform guarantee**, and it is not the
orchestrator's to assert. So nothing takes a lease over automatically:

```
owner observably running   -> LEASE_HELD                   -> wait
owner not observably there -> STALE_LEASE_RECOVERY_UNSAFE  -> operator decides
liveness undetermined      -> STALE_LEASE_RECOVERY_UNSAFE  -> operator decides
```

Liveness may **refuse and may never permit**. It exists so an operator is told
"somebody is running" rather than "a run died here", and no path anywhere permits
an effect because a probe said a process is gone — pids are reused, so `ALIVE` can
be a stranger and `NOT_FOUND` can be a lie.

### `agent-loop lease status`

```powershell
agent-loop lease status --repository <abs path>
```

Read-only. Reports the state, the owner, the run, the liveness and the revision
of the exact bytes on disk. For a lease whose owner is *not* running it also
prints what clearing it would require of an operator — and that is prose, not a
command.

### There is no command that clears a lease, and that is a withdrawal

An attended `lease break` existed here, shaped so that using it was a decision:
`--attended`, plus the revision and owner that `status` printed, plus a refusal
for any lease whose owner was running, and no `--force`.

**Three independent adversarial review rounds each found a fresh way for it to
destroy an authority somebody had legitimately acquired.**

```
v1  read, decide, unlink the PATH            -> ABA: destroyed a successor's lease
v2  detach, re-occupy with a placeholder     -> the same defect one level up: a
                                                0-byte placeholder is UNPARSEABLE
                                                with the constant revision
                                                sha256(""), so a second break
                                                removed it and the first then
                                                destroyed whatever took the name
                                                (12/12, real processes)
v3  detach, restore with link only           -> holds on NTFS; on a filesystem
                                                that refuses hard links, which
                                                this module explicitly claims to
                                                support, every non-matching
                                                detach becomes an unconditional
                                                destruction reported as
                                                "Nothing was removed"
```

Each fix was reproduced broken by the next round. A destructive operator command
that has never survived a review is worse than none: it carries the tool's
authority and was wrong every time anyone looked. So the productive path is
**gone** — no subcommand, no exported function, no exit-code contract, no
sentence pointing at it. `tests/v2-07l-execution-lease.test.ts` pins that as a
contract rather than leaving it to tidiness, including that no shipped source
file mentions such a command.

What remains for a crashed run is a **manual step, explicitly outside what this
build guarantees**, printed by `lease status` when the recorded owner cannot be
found:

1. establish that no orchestrator process and no agent process of that run is
   still alive — a process id that is gone does not prove this, because an agent
   can outlive the orchestrator that started it;
2. re-run `lease status` and confirm it still reports what was read, in
   particular the same revision;
3. delete the file at the printed path, deliberately.

Step 1 is a judgement this build cannot make, which is exactly why it is not a
command. A supported attended recovery flow is its own slice, and its first
acceptance condition is the one that defeated three attempts here: a stale or
unreadable lease must be removable by an explicit operator flow **without** any
possibility that a lease acquired in the meantime is destroyed by an ABA or
TOCTOU race.

### What V2-07L is not

No owned process containment: the orchestrator still does not create a Job Object
on Windows or supervise a process group on POSIX, so it cannot assert that its
agents die with it. That is the missing mechanism, and automatic stale-lease
recovery needs it first — necessarily before unattended running.

No TTL and no renewal. A lease does not expire, because time alone is never
evidence that a writer has stopped: a suspended or badly delayed writer can wake
up and write beside its successor. No block runner, and no change to what the
ledger means.

## Not implemented yet

Still missing, deliberately: block execution (V2-08); the dependent commit chain
(V2-09); unattended operation; owned process containment; and any product-side
PR/CI/merge automation.

**The lease came before the block runner, not after it**, and V2-07 is what forced
that change of order. The ledger's compare-and-swap is advisory, so two concurrent
writers of one ledger can each be told they succeeded while one of the two records
is silently lost — and "attended" is not mutual exclusion: two terminals, two
remote-control calls, or one accidental double start are enough. A block runner
built on this ledger before the lease existed would have been building on a record
that can lose writes. So the order was, and the remaining order is:

```
V2-07  ledger authority
         |
V2-07L execution lease / ownership          <- shipped
         |
V2-08  attended block runner
         |
V2-09  dependent tasks / commit chain
```

One prerequisite is now explicit that was not before. **Unattended running needs
owned process containment**, not merely the lease: automatic recovery of a stale
lease is refused today because a dead owner does not prove that no agent process
survived it, and that stays true until the orchestrator creates the containment
itself — a Windows Job Object, a supervised POSIX process group. Until then a
crashed run is cleared by an operator by hand, following the steps `lease status`
prints — a judgement a scheduled job cannot make, and one this build does not
offer a command for.

Inventing a cross-platform atomic file compare-and-swap inside V2-07 was the
alternative, and it would have burst the slice for a guarantee the lease has to
provide anyway. Recovery closed the crash window, which is a different problem
and was the one blocking a block runner from being *restartable*.

V2-07 sharpened what the lease has to be, in three ways. It showed the gap
concretely — two run ledgers in one repository can each hold the same task
`ACTIVE`, and neither document is wrong — and it settled what the lease may
**not** be keyed on. `repositoryId` is the profile's configurable logical
identity: two clones of one remote declare the same id and are two independent
local execution domains, while two worktrees of one clone are one. The lease key
must therefore be the local Git administrative identity — the normalised
`git-common-dir`, which is exactly what proved worktree membership in V2-06A —
and `repositoryId` stays what it is, a declared identity a ledger is held to.

The third is scope. The lease is not only about two processes believing they own
the same *task*: it is also what makes one writer per *ledger file* true, which
the store cannot establish for itself. Both guarantees come from the same owner,
which is the other reason for taking it before the runner rather than beside it.

Scope enforcement covers the **repository** effect of a writing agent, which is
what the profile declares. It is not a sandbox: an agent's `cwd` is its worktree,
and nothing here constrains what a process does outside the repository.
