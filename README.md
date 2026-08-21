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

## Status, and where to start

**Released for attended, supervised use on real projects.** The closing audit
found no `ATTENDED_RELEASE_BLOCKER`; unattended operation stays unsupported until
U1–U4 are resolved. See
[The closing audit](#the-closing-audit-attended-release-gate).

This README is the design record: what was built, why it was built that way, and
what each guarantee is actually worth. **If you want to *run* the orchestrator on
a project, read [`docs/OPERATOR-GUIDE.md`](docs/OPERATOR-GUIDE.md) instead** — how
to prepare a repository, what a preview must show before an attended run, what
`COMPLETE` does and does not mean, how to stop a run and what the stale lease it
leaves behind requires of you.

```powershell
npm install
npm run build

# always the preview first: it starts no agent, writes nothing, takes no lease
node .\dist\cli\index.js block `
  --repository "D:\Path\To\Project" `
  --block PROJECT-AREA-001 `
  --tasks PROJECT-AREA-001A PROJECT-AREA-001B `
  --run project-area-001-20260816-01
```

## Requirements

- Windows, Node.js major in `{22, 24}` — a whitelist, not a floor; see
  [Supported runtime](#supported-runtime)
- npm
- Git

## Install

```powershell
npm install
```

## Supported runtime

V2 is built for one configuration and refuses to run outside it. Three claims,
kept apart on purpose, because they have different strengths:

**Verified** — Windows, Node major in `{22, 24}`, and a repository whose Git
common directory is on a local NTFS volume. This is the configuration the
project is measured on: `verify` runs on `windows-latest` against every member
of `{22, 24}`, one job per member.

**Enforced** splits into two commitments, because they are decided and
refused by two different mechanisms — naming both separately is the point,
since "enforced" does not mean "enforced by the same mechanism":

**Runtime enforced** — Windows, and Node major in `{22, 24}`. Decided from
process-constant facts alone (`process.platform`, `process.version`) by the
**runtime gate**, which refuses at the CLI entry, before any command action
begins, with exit code 6; `--help` and `--version` keep working.

**Lease-location enforced** — no explicit UNC or device-namespace path for
the repository's Git common directory. Decided from the shape of a path, and
refused by a different mechanism at a different point — the **lease-location
gate**, where the command attempts to acquire the repository execution
lease, after the repository has already been resolved — through the
lease-acquisition refusal path and its own exit-code contract, not the
runtime gate's.

**Proved at the effect** — the lease's own filesystem capability, checked at the
hard link that needs it, answering `LEASE_FILESYSTEM_UNSUPPORTED` with the errno
the link was refused with. Not a preflight, and deliberately not derived from
one.

The two axes behave differently, and the difference matters:

- **on the Node axis, enforced and verified coincide exactly.** The supported
  set is the whitelist `{22, 24}` (`src/platform/runtime-support.ts`), not a
  floor: `>= 22` would admit 23 and 25 on a promise nobody has tested. CI
  measures both members.
- **on the filesystem axis, enforced is strictly narrower than verified.** The
  build does **not** establish that an accepted volume is local, or that it is
  NTFS.

**How this document writes that set.** Wherever it states which Node majors are
supported, it writes them in one form — a braced list in backticks, `{22, 24}`
— and `tests/v2-07p-platform-contract.test.ts` checks *every* occurrence of that
form, anywhere in this file, against `SUPPORTED_NODE_MAJORS` in
`src/platform/runtime-support.ts`, alongside `engines.node` and the CI matrix.
The form exists so that check can be an exact match on a fixed token instead of
a parser for prose: this document used to spell the same set four different
ways, and a test that reads prose fails for the wrong reasons. Two kinds of
sentence stay outside the form deliberately and are not pinned by it — one that
names a major this build does **not** support (`>= 22` would admit 23 and 25,
above), and a dated record of what the set was at an earlier slice.

### Not part of the V2 support contract

FAT, exFAT, SMB and other network filesystems, UNC-hosted repository storage,
and POSIX/macOS/Linux runtimes.

### ACCEPTED LIMIT: a network share mapped to a drive letter

A share mounted as `Z:\` is path-shaped like a local volume and **is not
detected by this build**. It is outside the supported configuration and the tool
will not tell you so. This is recorded as an accepted limit rather than left as
an unlikely case:

- closing it needs a Windows drive-type query, which would introduce a preflight
  *measurement of the filesystem* — precisely the construct the lease's whole
  safety argument avoids — plus its own tail of questions (`SUBST`, junctions,
  reparse points, Dev Drives, VHDX, UNC behind a local redirect, and
  disagreement between what the query answers and where the lease directory
  actually is);
- the residual protection is real but partial: where such a share cannot hard
  link, the lease refuses at the effect. A share that *can* hard link runs,
  unverified.

The runtime gate is not part of any safety argument downstream of it. It reads
`process.platform` and `process.version`, both fixed by the running Node binary,
and it measures nothing about any filesystem — which is why nothing in this
build may read as "NTFS was established at startup, so this effect is safe".

## Build and verify

```powershell
npm run verify
```

`verify` is the canonical full Foundation verify command. It runs, in this
order: `schema:generate`, `typecheck`, `build`, `test:dist-doctor`,
`test:dist-trusted-profile`, `test:dist-lease-race`, `test:dist-lease-release`,
`test:dist-runtime-gate`, `test:dist-notify-egress`, `test:dist-boundary`,
`test:foundation-safe`, `test:windows-tree-kill-tool-release`. `build` runs
immediately before the seven dist artefact checks, so all of them always run
against a fresh build, never a stale or missing one, and there is only ever one
build per `verify` run. The two vitest gates run **sequentially**, in that order
— the real-process harness never runs alongside the foundation set.

`build` itself now produces two artefacts: the TypeScript `dist/`, and
`dist/native/ao-launch.exe`, the Windows launch boundary compiled from
`native/ao-launch/AoLaunch.cs` with the in-box .NET Framework compiler. A
missing compiler fails the build rather than producing a `dist` without the
boundary in it.

`test:dist-trusted-profile` checks the *built* trusted-profile module
(`dist/config/internal/trusted-profile.js`): that it resolves the OS user
profile through `os.userInfo()`, that a child process with spoofed profile
environment variables gets the identical answer, and that no remnant of the
removed PowerShell resolver survives in the shipped artefact.

`test:dist-lease-race` puts the **execution lease** under real concurrency:
sixteen OS processes race for one lease, released together from a shared start
barrier, eight times over, and exactly one must win each round. It is a separate
gate for the reason the property is: a second `acquire` inside one process proves
that the exclusive create refuses an existing file, and cannot prove the claim is
*atomic*, because two synchronous calls in one thread cannot interleave. V2-07's
compare-and-swap passed every single-process test it had and lost writes to a
concurrent second caller; this is the check that would have caught it, pointed at
the mechanism that replaced it. It found a real defect on its first run — see
"The lease appears complete, or not at all" below.

`test:dist-lease-release` measures the **other half of a lease's life**: six OS
processes contend, the winner gives the lease back, and the directory is then
read. Four properties per round — exactly one owner, every loser refused with
`LEASE_HELD`, a reported release having actually destroyed the lease, and
nothing of the protocol left in the Git administrative directory afterwards —
and then the same six contend again, so "the file is gone" is distinguished from
"the file is gone and the protocol still works".

It is a separate gate for the same reason its sibling is: a release is an
**effect on a directory several writers share**, and no return value can show it
happened. Two mutants state what it is for, and the difference between them was
measured rather than assumed:

- dropping the `discard` that deletes the detached record after a successful
  removal **survived the entire pre-existing suite**. Against this gate it fails
  in every round, and the leftovers accumulate: one `.breaking-…` record after
  the first release, two after the second;
- `removeVerifiedLease` reduced to `return 'REMOVED'` fails this gate four ways
  per round — and is *also* caught in process, because a second release of the
  same evidence then reports `RELEASED` where it must report `LEASE_ABSENT`.
  (An earlier version of this paragraph, and of the commit that added the gate,
  claimed that mutant "satisfies every in-process assertion in this repository".
  That was written before it was measured, and it is wrong: the assertion that
  kills it predates this gate.)

It exists because the only real-process measurement of the release effect used
to be incidental to the attended-break harness, and was lost when that harness
was withdrawn with the break: a coverage regression a green gate cannot show
you.

`test:dist-runtime-gate` drives the **runtime gate** against the shipped CLI as
a real child process. The gate terminates the process and writes synchronously
to fd 2 at the CLI entry, and none of that is observable from inside a vitest
worker. A preload substitutes `process.platform` / `process.version` and
verifies its own substitution took, dying with a distinct exit code if it did
not — an ineffective preload would otherwise turn every negative case green. The
negative cases assert that the lease report is **absent** from stdout, which is
what proves the action never ran rather than merely that a message was printed.

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
npm run build                # emit dist/ (Node-executable CLI) and the native
                             # launch boundary, dist/native/ao-launch.exe
npm run build:boundary       # only the native launch boundary
npm run test:dist-boundary   # only the real-process launch-boundary check
                             # (tests/dist-artifact/launch-boundary-dist-artifact.mjs),
                             # against whatever dist/ already exists — no build
npm run test:dist-lease-race  # only the real-process execution-lease race
npm run test:dist-lease-release # only the real-process acquire -> release check
                              # (tests/dist-artifact/execution-lease-release-dist-artifact.mjs),
                              # against whatever dist/ already exists — no build
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

Every dist artefact check is a plain Node script, not a vitest test file, so
none of them is picked up by vitest's default `tests/**/*.test.ts` glob and a
plain `npm test` on a clean checkout (no `dist/` yet) does not depend on a
prior build. (This paragraph said "both" while there were three of them, which
is the same class of stale count this repository keeps having to correct: the
authority is the `verify` chain above.)

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
  child that exceeds either is terminated. **On Windows that is now the launch
  boundary's job** and the guarantee is the kernel's — the helper holding the
  only handle to a `KILL_ON_JOB_CLOSE` job dies, and the job takes the target
  and every descendant with it (see
  [The productive Windows runner (V3 slice 3)](#the-productive-windows-runner-v3-slice-3)).
  On POSIX termination stays **best-effort**, through the process group the
  detached child leads: the module then waits, with a bound, for the immediate
  child's `close` event — not for a verified absence of the whole tree —
  reporting a distinct failure code (`PROCESS_TREE_KILL_FAILED`) if that event
  is not observed within the grace window. What that attempt does and does not
  guarantee is spelled out in
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

Where the process is *created* differs by platform since V3 slice 3 — on
Windows it is the launch boundary's helper rather than `child_process.spawn` —
but what is created does not: the same resolution, the same planning, the same
allow-list and the same two paths decide the executable and the command line
before either mechanism is reached.

**A. Direct executables.** The resolved executable and its arguments are handed
over structurally: a literal argument vector, `shell: false`, no shell and no
command processor anywhere in the chain. Nothing on this path is re-parsed by a
shell or an interpreter. On Windows the boundary rebuilds the command line with
the same MSVCRT quoting rule node applies. That equivalence is measured against
this repository's own artefact rather than quoted from the spike: eight
differential argv cases in
[`tests/dist-artifact/launch-boundary-dist-artifact.mjs`](tests/dist-artifact/launch-boundary-dist-artifact.mjs),
plus one for the `.cmd` verbatim route.

**B. `.cmd` / `.bat` targets.** Node cannot spawn a batch file directly, so this
path runs it through the trusted Windows command processor **on purpose**.
`cmd.exe` therefore does perform its own parsing of the command line it is
given, and this document does not claim otherwise. What is claimed is that the
command line it parses is not freely constructed:

- the interpreter is the trusted, environment-independent `cmd.exe` resolved
  through `src/doctor/internal/windows-system-tools.ts`. `COMSPEC` is never
  read, so a caller-controlled `COMSPEC` cannot substitute the interpreter;
- it is invoked as `cmd.exe /d /s /c "<inner>"` with `shell: false` and
  verbatim command-line semantics, so nothing performs quoting of its own and
  the string `cmd.exe` receives is exactly the one this module built. On Windows
  that verbatim flag now travels to the boundary as part of the launch plan,
  where the helper reproduces the same rule;
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

> **Superseded on Windows by V3 slice 3, and no longer wired to anything.**
> `runCommand` does not use this mechanism any more: a Windows process's
> lifetime is decided by the launch boundary's job object, because `taskkill`'s
> success was measured as no evidence at all — exit code 0 in ten of ten rounds
> with 38 orphaned descendants alive. The supervisor
> (`src/doctor/internal/windows-process-tree-termination.ts`) is still in the
> repository, still has both of its own test suites, and has **no production
> caller**. This section describes it as it stands; the POSIX paragraph below is
> the only part still on a productive path.

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

- V1's canonical verification evidence is **Windows + Node major in
  `{22, 24}`** — `verify` runs on `windows-latest` against both majors (V2-07P
  widened this from Node 22 alone when the Node contract became a whitelist), and
  `tests/v1-08-verification-boundary.test.ts` spawns its real processes there;
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

**V2-07P narrowed this from the other end.** The limitation above was written
when portability was an open question: the build did not run on POSIX and did
not claim to. V2 now *refuses* to, at the CLI entry, so "portability to POSIX is
not proven by V1" has become "POSIX is outside the support contract". The
paragraph is kept rather than rewritten because it records what was true of V1,
and because the failure mode it describes — a command that cannot start is
`UNAVAILABLE`, never a false `PASSED` — is unchanged.

### Carried forward, deliberately

- **F-4** — on Windows `isAbsolute` accepts a root-relative path (`\foo` —
  absolute within whichever volume the process is standing on), so
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
- **L-V2-07L-1** — the five acquire refusal codes all exit `EXIT_RUN_REFUSED`,
  so `LEASE_HELD` ("another run owns this, wait") and
  `STALE_LEASE_RECOVERY_UNSAFE` ("a human must decide about this by hand") are
  indistinguishable at the shell. They are two outcomes precisely because they
  send an operator to two places, and the printed sentences do distinguish them;
  only the exit code does not. Deferred rather than fixed because widening the
  exit-code contract is a product decision of its own, and because
  `STALE_LEASE_RECOVERY_UNSAFE` also covers `UNDETERMINED` liveness, where a
  retry genuinely can differ. **Scope:** `cli/run-command.ts`,
  `cli/release-command.ts`, `cli/run-exit-codes.ts`.
  **V2-07P sharpened this rather than closing it:** the two new location
  refusals, `LEASE_LOCATION_NETWORK_UNSUPPORTED` and
  `LEASE_LOCATION_DEVICE_NAMESPACE`, also exit `EXIT_RUN_REFUSED`, whose
  contract reads "the state may be fine … re-invoking under other conditions
  can differ". For these two nothing can ever differ — the path shape is
  fixed — so a scheduler that retries on 4 loops forever against a UNC-hosted
  repository. The runtime gate got its own code 6 for exactly this reason;
  the lease-location gate makes the same class of statement and did not.
- **D-REM-001-6 — the test budget was wrong for this slice, and is raised
  deliberately rather than met by simulation.** DOGFOOD-REM-001 was planned with
  a ceiling of five new controls above 2 s. Measured inside the parallel gate,
  where durations roughly double, it lands at **twelve**: 17.0 s, 13.0 s, 8.6 s,
  7.9 s, 5.5 s, 5.0 s, 4.8 s, 4.6 s, 4.5 s, 4.4 s, 4.1 s, 3.3 s. The whole
  `test:foundation-safe` gate went from ~216 s to ~236 s, so the developer loop
  pays about 9%.

  The plan's own remedies were applied in its order and are what took the count
  from seventeen to twelve: the step-budget pair was merged into one case with
  two fixtures instead of three, and four of the five reviewer-payload controls
  were moved off a real run onto the pure builder they actually test, leaving one
  real step to prove the transport.

  The third remedy — lowering a control's tier — was **not** applied to any of
  the twelve, and the plan forbids it here by name: every one of them measures an
  effect that is Git's. A commit that really moved HEAD, a worktree that is
  really clean, an identity really on an object, a scope violation that really
  refused. Rewriting any of them against a mock would prove the mock agreed,
  which is precisely the failure this slice exists to remove — the first dogfood
  was green because every control substituted the seam above the effect. So the
  number is stated instead of being met. **Scope:** `tests/dogfood-rem-001.test.ts`.
- **D-REM-001-7 — a task id, once used, cannot be made runnable again by any
  product operation.** Established read-only, from the source, as the
  rerun-preparation question DOGFOOD-REM-001 was required to answer before a
  second dogfood.

  `release` refuses these records, and refuses them correctly:
  `assessWorkspaceAdoption` requires the **positive absence** of a durable state
  (`STATE_ALREADY_EXISTS`, `worktree/adopt-workspace.ts`), so
  `releaseTaskWorkspace` answers `NOT_RELEASABLE` for any task that has one. The
  first dogfood's `CARGO-UI-001A` / `CARGO-UI-001B` records have durable state —
  A is precisely the false `READY_FOR_PR` that `PREDECESSOR_DELIVERED_NOTHING`
  now refuses to chain from.

  And **nothing else removes or archives a task state**. There is no
  `removeTaskState` anywhere in `src/`; `state-store.ts` states its own contract
  as a record found being "not migrated, not truncated, not renamed aside, not
  deleted", and the only `unlink` in the state layer is `atomic-file.ts`
  discarding its own temp file. The record's path is derived from the repository
  root and the task id (`state-location.ts`), so the id and the record are the
  same fact.

  So the answer to "is there a canonical path?" is **no**, and that is recorded
  as a finding rather than resolved by hand. Deleting the two files would free
  the ids, destroy the forensic evidence, and prove nothing about the product.

  **It is not a rerun blocker**, because the plan's third option is available and
  is hereby taken deliberately: the second dogfood runs on **fresh task ids**,
  and the first dogfood's records stay exactly where they are as evidence. That
  costs nothing — the ids are labels — and it preserves the artefacts by
  construction rather than by an operator remembering to copy them.

  What is left open is the product question underneath: an orchestrator that can
  never retire a task id accumulates records forever, and a repository that
  genuinely wants to re-run a task has no supported way to say so. Adding one is
  a decision of its own — what evidence must survive, what proof authorises the
  removal, whether it is a new command or a widening of `release` — and is
  deliberately not made here. **Scope:** `run/release-workspace.ts`,
  `worktree/adopt-workspace.ts`, `state/state-store.ts`.
- **D-REM-001-8 — a quoted refusal string is evidence only if it came from the
  emitter.** Rerun-gate item 10 was written as a literal-string comparison
  against two phrases the G5 analysis had recorded as the CLI's own narration:
  *"outside my allowed folder"* and *"This path is outside the working folder"*.
  Neither is CLI output. Both are an **agent's paraphrase** of a refusal it
  received, taken from the probe sessions' assistant text, and the word
  "outside" appears **zero times** in either dogfood writer transcript. So the
  comparison as specified could only ever return "no match" — and the gate's own
  rule made "no match" mean *a live second mechanism*, which would have blocked
  the second dogfood on a phantom.

  The rule that replaces it: **quoted refusal strings used as evidence must come
  from the emitting CLI or tool, not from an agent's paraphrase or diagnosis of
  that refusal.** Before pinning a check to a literal string, confirm the string
  is in the emitter's output — a `tool_result` — and not in an assistant `text`
  block. The two are indistinguishable once copied into a plan.

  G5 itself closes, on the instrument named in item 10 rather than on the string
  comparison: within one dogfood session, for one target path in one worktree,
  `printf > src/ui/.permcheck.tmp` and `rm src/ui/.permcheck.tmp` were reported
  as *requiring approval* while `touch src/ui/.permcheck.tmp` was reported as
  *blocked … allowed working directories*. One path, one moment, two messages —
  one a permission refusal, one a path refusal. That co-occurrence is what shows
  the path prose to be a permission denial, and no string match could have shown
  it.
- **D-REM-001-1** — `git worktree add` through this product's seam **runs the
  target repository's `post-checkout` hook**. Measured, with a sentinel. So the
  orchestrator already executes target-repository hook code today, before any
  writing agent starts and outside everything DOGFOOD-REM-001 fenced. It was
  fenced out of that slice deliberately: the commit path is where the new effect
  was, and widening the slice to workspace preparation would have been a second
  change. **Scope:** `worktree/prepare-workspace.ts`.
- **D-REM-001-2** — a `.gitattributes` clean filter first executes during
  `observeTaskDelta`'s own reads — `status` and `diff` must apply it to decide
  whether a file differs from the index — so that exposure **predates** the
  commit path and is older than the slice that first had to name it. Measured:
  the sentinel appears at the observation, and after `git add` the staged blob is
  the filter's output rather than the bytes on disk. Control two refuses the
  commit; nothing yet bounds the observation. **Scope:** `scope/task-delta.ts`.
- **D-REM-001-3** — path-independent executable configuration (`core.fsmonitor`
  and relatives) is **not** covered by control two: it is unreachable via
  `check-attr`, it already runs during today's observation, and refusing on its
  mere presence would fail closed on ordinary machines for a pre-existing
  exposure. Named as a non-goal rather than silently omitted. **Scope:**
  `worktree/commit-task-work.ts`.
- **D-REM-001-4** — the stale-record race the settlement conjunct was designed to
  catch is caught **earlier**, by reconciliation (`CURRENT_COMMIT_MOVED`, zero
  steps, no reviewer started) — measured while building that gate's fixture. The
  conjunct is what refuses the ordinary shape: a `currentCommit` withdrawn to
  `null` by a writing phase over a worktree still standing at the base pin.
  Recorded because attributing a guarantee to the wrong line is how the
  empty-delta defect survived review the first time.
- **D-REM-001-5** — `commitTaskWork` names every approved path as an argument to
  `check-attr`, so a repository containing a path the argument grammar cannot
  express (a space, a `%`) refuses the commit rather than committing unchecked.
  Fail-closed and deliberate, and unmeasured against a large delta: the argument
  vector has an operating-system length limit that a big enough approved set
  would reach, where the seam reports the spawn failure and the commit refuses.
  **Scope:** `worktree/commit-task-work.ts`.
- **L-V2-07P-1** — `classifyWindowsKey` lost its `process.platform === 'win32'`
  guard, so it now classifies on every platform: a POSIX `gitCommonDir`
  normalises to a shape matching none of the accept rules and every repository
  on Linux or macOS is refused a lease location, described as "a shape this
  build has not verified". That is consistent with V2 being Windows-only and is
  unreachable through `agent-loop`, because the runtime gate refuses POSIX
  first — but it is stated nowhere at the call site and nothing measures it.
  The positive control in `tests/v2-07lr-lease-recovery.test.ts` is
  `it.runIf(win32)`, so the suite stays green on POSIX against a lease module
  that refuses everything. **Scope:** `lease/execution-lease.ts`.
- **L-V2-07P-2** — `writeAllSync` in `cli/runtime-gate.ts` retries `EAGAIN` by
  re-entering `writeSync` immediately, with no yield, backoff or attempt cap.
  The one platform where a non-blocking fd 2 is real is POSIX, which is exactly
  where this function always runs, because every POSIX invocation is refused
  there. With a pipe whose reader is not draining, the process pins a core
  inside the function whose purpose is to fail fast and exit. **Scope:**
  `cli/runtime-gate.ts`.
- **L-V2-07P-3** — `tests/v2-07p-platform-contract.test.ts` imports
  `src/cli/index.js` to reach `buildProgram`, and that module calls `main()` at
  load, so the import runs the whole CLI against vitest's own argv: it prints
  the command table and an `[UNEXPECTED_ERROR]` line into the gate's log, and
  sets `process.exitCode = 1` asynchronously — possibly after the test's
  `finally` has restored its snapshot. `tests/run-command.test.ts` and
  `tests/v2-06a-release.test.ts` both avoid the import for this reason, but
  neither substitute works here: the runtime gate is installed by
  `buildProgram` itself, so a bare `Command` would make the positive control
  vacuous. Closing it properly means deciding whether `cli/index.ts` stays
  "an executable entry point, not a library", which is a contract decision and
  not a test fix. **Scope:** `cli/index.ts`,
  `tests/v2-07p-platform-contract.test.ts`.
- **LF-1** — `loop/leased-spawns.ts:52-53` says the spawn denylist covers `eval`;
  the regex has no `eval` term, and an indirect `eval` reaching a process passed
  all five reachability pins. No safety claim is wrong — the same paragraph
  disclaims the denylist as a bound rather than a barrier, and the lease fence is
  what actually stops a spawn — but the coverage sentence is false and a
  maintainer would read it as a guarantee. Not fixed in V2-07LR deliberately:
  that slice is about ABA/TOCTOU and operator authority, and a comment-versus-regex
  correction there would dilute exactly the review it needs. **Scope:**
  `loop/leased-spawns.ts:52-53`, `tests/v2-07l-execution-lease.test.ts:2372-2386`.
- **LF-4** — editing artefacts: a 153-character run-on in this file whose second
  clause lost its subject, and a stray double blank line in
  `loop/loop-step.ts:1122-1131`. Cosmetic, and carried rather than folded into a
  safety slice for the same reason.
- **L-V2-07L-2** — four of the five acquire refusals end "Nothing was started.",
  and `release --attended` prints them verbatim. A release starts nothing in any
  case, and the question its operator has is whether anything was *removed*.
  Cosmetic: no safety claim is wrong, and the release outcome sentences answer
  the removal question separately. **Scope:** `cli/render-lease.ts`,
  `cli/release-command.ts`.
- **L-V3-05-1** — the writer-launch history records the productive writer only.
  The reviewer and the verification command are contained in fact on Windows —
  `doctor/exec.ts` routes every spawn through `runOwnedCommand` — and no reading
  of the history is evidence about them, so `SAFE_TO_RECOVER` means "no *writer*
  tree can still be running" and not "no process of this run can". Deliberate:
  the prompt's predicate is about writer launches, slice 4 drew the same
  boundary, and widening it changes what the record claims rather than how it is
  read. Left open because it is a real narrowing of the sentence an operator will
  hear as "nothing survives". **Scope:** `lease/writer-launch-ledger.ts`,
  `loop/leased-spawns.ts`.
- **L-V3-05-2** — **withdrawn, having been false.** It claimed
  `HISTORY_DISCARDED`, `LAUNCH_MUST_NOT_START` and `LEDGER_WRITE_FAILED` needed a
  filesystem refusal "which nothing single-threaded can produce". An adversarial
  review produced all three in process with plain `node:fs`: a held-open handle
  blocks a rename onto that name on Windows and does not block an unlink of it —
  the mechanism `clearContainmentEvidence`'s own docstring already records as
  measured — and a directory at the ledger's name refuses both. The slice had
  documented the mechanism in one file and called it unreachable in another. All
  three now have cases. One member remains unproduced, `LEASE_UNREADABLE`, and the
  test that enumerates the set says so by name rather than leaving it implied.
- **L-V3-05-3** — the crash-window artefact is still unrecoverable, and always
  will be under this design. A run that dies between claiming the lease name and
  writing the record leaves a zero-byte file with no owner and no nonce, so there
  is nothing for a removal to bind to; `recover` answers `LEASE_UNPARSEABLE` and
  a human deletes the file. Stated as a permanent limit rather than a follow-up:
  closing it needs an atomic compare-and-delete on a directory entry, which is
  the primitive six review rounds established does not exist. **Scope:**
  `lease/execution-lease.ts`.
- **L-V3-05-4** — `assessLeaseRecovery` now probes the owner's liveness **twice**
  per call: once for the inspection and once inside the recovery predicate. That
  is deliberate — sharing one answer would mean the predicate trusting a liveness
  result taken by somebody else at some other moment — and it does make one
  `lease status` two probes. Cosmetic for the CLI; worth knowing for any caller
  that counts probe invocations. **Scope:** `lease/lease-recovery.ts`.
- **L-V3-06-1 — the continuation grant was examined and is unchanged.** The
  first draft of this entry claimed slice 6 widened it, and that claim was
  wrong. `attendedContinuation` has never meant "one `runTask` call": it means
  an operator is present for *this invocation of the command*, and
  `block --attended` has driven a `for(;;)` loop over many tasks, each its own
  `runTask`, under a single `--attended` since V2-08 —
  `block/block-runner.ts:887` passes `attendedContinuation: true` from inside
  that loop. `driveLifecycle` does the same for one task, in one foreground
  process the operator started and can stop, and `--max-invocations` defaults to
  one so the command drives a task exactly as far as it did before unless an
  operator asks otherwise. No authority was extended.

  **Not byte-identical output, though, and an earlier draft of this entry said
  it was.** Routing `run --attended` through the driver changed three visible
  things on purpose, and **five** rather than the three an earlier draft of this
  entry listed:

  1. the step-budget stop is spelled `INVOCATION_BUDGET_EXHAUSTED` — same exit
     code 5, same meaning;
  2. the report comes from `renderLifecycleRun`, which adds the lease and release
     lines this slice exists to produce;
  3. **seven** of the eight acquire refusals moved from exit 4 to exit 3. Only
     `LEASE_HELD` keeps 4, because another run working here clears itself; an
     unusable lease location, an incoherent repository record and a filesystem
     that cannot support the claim do not, and code 4 promises that re-invoking
     under other conditions can differ. `STALE_LEASE_RECOVERY_UNSAFE` is the
     seventh — it is what a crashed repository answers, so it is the one a
     scheduler actually meets — and it lands on exit 3 through whichever of
     `STALE_LEASE_PRESENT`, `RECOVERY_UNSAFE`, `LEASE_CHANGED`,
     `LEASE_DISPLACED`, `RECOVERY_FAILED` or `LEASE_ACQUISITION_REFUSED`
     applies. One ending is the exception: a recovery that succeeds and is then
     beaten to the acquisition reports `LIVE_OWNER_PRESENT`, exit 4, correctly.
     This narrows `L-V2-07L-1` rather than carrying it forward. (This paragraph
     said "six" while also saying "only `LEASE_HELD` keeps 4", which cannot both
     be true of an eight-member vocabulary. The code was corrected in review
     round 2 and this entry was not — the same sibling-site miss that round was
     convened to fix.);
  4. each acquire refusal keeps its own sentence in the report, printed beneath
     the outcome sentence, which is what the command did before the rewiring;
  5. task selection now happens **outside** the lease. It only reads the
     repository's own task files, and an invocation with nothing to run should
     not take a writer lease to discover that. The visible consequence: when a
     lease is held *and* the selector finds nothing, the report is now the
     read-only plan rather than a lease refusal, so the exit code is the plan's
     rather than 4.

  **Scope:** `run/lifecycle-driver.ts`, `cli/run-command.ts`,
  `cli/run-exit-codes.ts`.
- **L-V3-06-2 — the reset wait was WITHDRAWN from slice 6, and needs a contract
  decision before it can exist.** The slice was to let an unattended run sleep
  until `reportedResetAt` and carry on. It cannot be built without extending an
  authority this product has not granted, and the chain is short:
  `run/run-driver.ts` refuses **every** continuation when `attendedContinuation`
  is false — including one `evaluateAutomaticResume` has already allowed,
  because the grant is checked before the resume write and can only withhold.
  So AO has no unattended execution path at all today; the automatic-resume
  machinery decides *eligibility*, and operator presence is still required on
  top of it.

  That makes the wait unbuildable in both directions. Keeping the grant across a
  multi-hour sleep spends a claim of operator presence made long before, which
  is the widening. Dropping the grant after the sleep makes the wait pointless,
  because the resume it slept for is refused too.

  **The minimal contract change, if it is ever wanted:** a third continuation
  authority — "may continue with nobody present, but *only* where
  `classifyResume` already answered `AUTOMATIC_ALLOWED`" — distinct from
  `attendedContinuation` and never a substitute for it. It would let an
  unattended run clear a self-clearing quota pause while still refusing ordinary
  in-flight work, which is the only shape that satisfies *unattended
  continuation must not increase authority*. That is a product-contract
  decision, so it is reported here rather than implemented. Until it is made,
  `BLOCKED_USAGE_LIMIT` stops the lifecycle driver exactly as it stops every
  other caller. **Scope:** `run/run-driver.ts`, `core/resume-policy.ts`,
  `run/lifecycle-driver.ts`.
- **L-V3-06-3 — the real-process harness measures the lease phase, not a driven
  task.** `tests/dist-artifact/lifecycle-restart-dist-artifact.mjs` names a task
  the plan does not contain, so the one phase that reaches `startTask` stops at
  `TASK_START_REFUSED`; the other three stop in the lease phase and assert
  `start === null`. (An earlier version of this entry said "every phase" reaches
  it, which is wrong in three cases out of four.) That is what makes the harness
  agent-free, and `startTask` being reached *at all* in phase A is the proof that
  the recovery was followed by a real acquisition — but it does mean no *durable
  phase* is continued by a real second process anywhere in the gate. Continuation
  from durable state is covered in-process only. **Scope:**
  `tests/dist-artifact/lifecycle-restart-dist-artifact.mjs`.
- **L-V3-06-4 — the lifecycle driver does not start what it cannot select.** It
  takes a definite `taskId` and never consults the selector; `run --attended`
  selects before calling it. An unattended run therefore continues *one* task and
  stops, exactly as `runTask` does, and nothing here decides that a finished task
  means "move on to the next". Automatic task selection stays out of scope.
  **Scope:** `run/lifecycle-driver.ts`.
- **L-V3-06-5 — the post-recovery lost race is produced by no test.** The path
  where a stale lease is recovered and the *ordinary* acquisition that follows
  then loses to a successor — `run/lifecycle-driver.ts`'s second `acquireOnce`,
  and the `ACQUISITION_AFTER_RECOVERY_LOST` reason code — is unexercised, in
  process and against the artefact alike. Reaching it needs a lease recovery
  *accepts* (a real proved launch history) plus a competitor arriving inside the
  window between the removal and the second acquire, which no harness here can
  stage deterministically. `LEASE_CHANGED`, `LEASE_DISPLACED` and
  `RECOVERY_FAILED` are likewise produced by no test. The property they carry —
  recovery grants nothing, and the acquisition after it is allowed to lose — is
  therefore argued from the code rather than measured. A review found the case
  named for this path did not reach it; the case was renamed to what it does
  measure rather than left claiming more.

  Two further outcomes are asserted by no case at runtime and are named here so
  the list is complete: `AUTH_PREFLIGHT_FAILED` and `LEASE_ACQUISITION_REFUSED`.
  Both are reachable; neither is exercised. **Scope:**
  `run/lifecycle-driver.ts`, `tests/v3-06-lifecycle-driver.test.ts`.
- **L-V3-06-6 — a lease that clears itself between the refused acquire and the
  recovery is reported as an operator condition.** The first acquire refuses
  `STALE_LEASE_RECOVERY_UNSAFE`; another invocation legitimately recovers and
  acquires in the window; `recoverStaleLease` then re-probes — correctly, it
  binds to bytes and takes its own liveness reading — and refuses. The run
  reports `RECOVERY_UNSAFE`, exit 3, "an operator must act", when the truth is
  `LIVE_OWNER_PRESENT`, exit 4, and it clears itself. No wrong *effect*: nothing
  is removed, and recovery is still attempted at most once. Only the reported
  condition and exit class are wrong, and narrowing it means a second inspection
  whose answer would be just as stale. **Scope:** `run/lifecycle-driver.ts`.
- **L-V3-06-7 — the discarded lease-release result is closed on every controlled
  path, and open on one exceptional path of one command.** The slice's third
  stated gap was that every call site threw the release result away, leaving a
  quarantined record inside `.git` that nobody was told about. `run --attended`
  closed it first, for its controlled path only. **V3-07 closed the other two.**
  `cli/block-command.ts` and `cli/release-command.ts` now keep the result, print
  it through one shared closed renderer in `cli/render-lease.ts`, and cannot exit
  nominal on any code but `RELEASED` — on every path that acquired a lease,
  including the refusals that `return` from inside the `try`, and including a
  thrown operation, whose `catch` prints the release after the safe error text.
  Both primary results are printed unchanged next to it: a failed release decides
  the exit code and rewrites no block outcome and no workspace verdict. The rule
  exempts no primary code, not even `EXIT_RUN_UNEXPECTED`; the two `catch` blocks
  set code 1 where they catch, and say why there.

  The sentences that report those codes say only what is true of **every**
  producer of the code they are keyed on, which took four passes to get right and
  in the end a change of shape. Every pass found the same class one level
  further in: a sentence true of the removal states and false of the refusals
  that share the code, then true of those and false of one removal state.
  `LEASE_ABSENT` claimed "nothing is left behind" about a code reachable three
  ways, none of which looks past the lease name; `LEASE_REMOVE_FAILED` glossed
  `UNREADABLE_AFTER_DETACH` as a record left in quarantine when
  `removeVerifiedLease` puts that record back and deletes the quarantine copy —
  which is the harm `VerifiedRemoval`'s own docstring records having been
  reproduced once before, on a different code.

  Rewording stopped being the fix. A code sentence now states only what the code
  establishes, and everything about the resulting state on disk moved to
  `LEASE_RELEASE_DETAIL_SENTENCES`, **keyed on the detail token** — a much finer
  key, and one the fifth review then showed is still not one-per-end-state:
  `RECORD_QUARANTINED` comes from `Restoration.NAME_TAKEN`, which `putBack`
  reaches both by proof (`link` refused `EEXIST`) and by `occupancyOf` treating a
  *failed* `stat` as occupancy — a default that function's own docstring calls
  proof of nothing. So the token sentence says a copy was kept aside, which every
  producer shares, and names the uncertainty about who holds the name, which they
  do not. The rule is the same at both levels: say what every producer of this
  key shares, and name the uncertainty where they differ. The token table is
  complete against the producer by test, not against itself, and a second test
  pins that `LEASE_REMOVE_FAILED` never pairs with a null token — because its
  sentence promises one without a condition.

  One asymmetry worth knowing when reading two reports side by side: on a failed
  release `run --attended` replaces its outcome with `LEASE_RELEASE_FAILED` and
  demotes the reached outcome to a reason code, while `block` and `release` keep
  their primary verdict and move only the exit code. Both are truthful; they are
  not the same shape, and V3-07 deliberately did not change the older one. The counter-proof for
  `LEASE_ABSENT` is in `tests/v3-07-lease-release-observability.test.ts`: a real
  lease moved aside under a quarantine-shaped name releases `LEASE_ABSENT` with
  the record still on disk, byte for byte.

  The two commands' `finally` blocks now also *contain* the release, so a release
  that throws cannot replace the exception that entered — and a release that
  throws still prints a line, `RELEASE_NOT_REPORTED`, because the one occasion a
  record is provably still in the repository is the last place an absent line
  would be readable as "fine". Both halves are produced rather than argued, for
  both commands, in `tests/v3-07-lease-release-fault.test.ts`: the throwing
  release is reached with no production edit at all, by refusing the one
  `randomBytes` call that names the quarantine file.

  An earlier version of this entry said the condition existed "on three paths".
  Two of the three are now closed. **The third is not, and it is exactly this:**
  the lifecycle driver's own `catch` gives the lease back and discards the
  answer, because on a throw there is no `LifecycleResult` to attach it to —
  `driveUnderLease` rethrows, and `cli/run-command.ts` prints the safe error text
  and exits 1. The two commands could close their equivalent because a command
  owns its own stdout; the driver does not, and giving it one would be a change
  to `LifecycleResult` rather than a report — a contract decision, and not this
  slice's. So `run --attended` is now the one command whose *exceptional*
  release result is still invisible. This narrows the item rather than carrying
  it forward whole. **Scope:** `run/lifecycle-driver.ts`.
- **L-V3-06-8 — the loop has two floors; one does the work and one cannot fire.**
  The live one is the revision comparison: an invocation that reports
  `STEP_BUDGET_EXHAUSTED` while leaving the state file identical to the one its
  predecessor left does not get to run again.

  The other, `steps === 0`, is **unreachable**, and the mutant that deletes it
  survives the suite. `run-driver.ts` refuses a step budget below one before its
  loop, so any run reaching the budget stop completed at least one iteration and
  every iteration that does not stop early performs a durable write — so
  `STEP_BUDGET_EXHAUSTED` implies `steps >= 1`. It is kept for parity with
  `block-runner.ts`, which carries the identical guard on the identical loop, and
  because a change to that budget check one module over would otherwise turn a
  nothing-invocation into a spin in silence. A round of review claimed this floor
  "covers the first invocation, which the revision comparison cannot"; there is
  nothing there to cover, because the first invocation provably wrote. What is
  pinned instead is the refusal the argument rests on.

  The live floor compares **one** invocation back. A durable two-cycle — state A
  to B to A to B, each step a real write — never equals its immediate predecessor
  and runs to `--max-invocations`. Bounded rather than a spin, and no such cycle
  is reachable through the current transition table, so widening it to a set of
  seen revisions would defend against a shape the state machine does not have.
  **Scope:** `run/lifecycle-driver.ts`.
- **L-V3-06-9 — two lifecycle outcomes are unreachable through the CLI, and one
  exported accessor has no production caller.**

  `CONTINUATION_NOT_AUTHORISED` is the second one, and it was missed when this
  entry was first written. `cli/run-command.ts` hardcodes
  `continuationGrant: true` — the function is only reached under `--attended` —
  and the sole producer of the underlying run outcome is gated on that grant
  being false. So the member, its exit-code entry and its operator sentence are
  dead through the shipped command, exactly as below. Both are kept for the same
  reason: `driveLifecycle` is an exported API with a second consumer.

  `exitCodeForLifecycle` likewise has no `src/` caller — `exitCodeForLifecycleRun`
  indexes the table directly. It is kept because it is what
  `tests/run-exit-codes.test.ts` pins the table through, and a table reachable
  only via the function that also delegates would be pinned less directly.
  `exitCodeForRunOutcome` lost its last production caller to this slice's
  rewiring and is now in the same position; its own doc comment already said "not
  consumed by any command yet", which became false in V2-05 and is true again.

  And the original subject of this entry:
  `cli/run-command.ts` validates `--max-invocations` and refuses before
  `driveLifecycle` is called, so in the shipped product the outcome, its
  exit-code entry and its operator sentence are all dead. They are kept because
  the driver is an exported API with a second consumer — the dist harness — and
  because a guard that answers only when its caller forgot to guard is the kind
  that must not silently return something wrong. The two checks are now the same
  check (`Number.isSafeInteger`); they were not, and the driver's was the weaker,
  which is the defect a defence-in-depth layer is supposed to make impossible.
  **Scope:** `run/lifecycle-driver.ts`, `cli/run-command.ts`.
- **L-V3-06-10 — the release-ordering guard is unpinned.** `finish` sets its
  "already released" flag *after* the release call returns, so a release that
  threw leaves the flag clear and the outer `catch` tries once more rather than
  standing down. The mutant that restores the original ordering survived, and the
  stated reason was that no reachable throw could be constructed inside
  `releaseRepositoryExecutionLease` because every filesystem call on that path is
  already wrapped.

  **That reason was too strong, and an instrument now exists.** Not every call on
  that path is a filesystem call, and at least one of the others sits outside
  every `try`:
  `removeVerifiedLease` names its quarantine file with `randomBytes(6)` before it
  opens one, so a `vi.mock('node:crypto')` refusing that one call makes the
  release throw with production unedited. `tests/v3-07-lease-release-fault.test.ts`
  does exactly that, and uses it to kill the equivalent mutant in
  `cli/block-command.ts` and `cli/release-command.ts`.

  Two things this does *not* establish, and the correction is meant to be
  narrow. It does not show a **production-reachable** throw: `randomBytes(6)`
  failing in a real process is exactly as unlikely as it was. And the other half
  of the old reason still stands — `releaseRepositoryExecutionLease` is still not
  an injectable seam. What has changed is only that the ordering in `finish` is
  now unpinned for want of a test rather than for want of an instrument, which is
  a smaller claim and a truer one. **Scope:** `run/lifecycle-driver.ts`.
- **L-V3-07-1 — the operator notification does not know about the lease
  release.** `notifyBlockRun` builds its payload from `AttendedBlockResult`
  alone, and `judgeBlockRun` decides `SILENT` from that same value. So a block
  that ends `COMPLETE` and then fails to give the lease back now exits 3 and says
  so on the console — and sends **no notification at all**. The one channel an
  absent operator has is the one that stays quiet about a repository that will
  refuse its next run. Deliberately not fixed in V3-07: carrying the release
  result to the wire is a change to `OperatorNotification`'s schema *and* to what
  counts as an ending worth waking somebody for, which is the planned
  actionable-notifications redesign rather than a rendering change. What that
  redesign must not undo is already in place — the notification is sent after the
  release attempt, never before, so the payload it will one day carry is a fact
  and not a prediction.

  One narrow behaviour change V3-07 did introduce and did not guard: the release
  report is written to stdout *between* the exit code and `notifyBlockRun`, so a
  synchronous throw from that one write now skips the notification, which on
  `main` nothing could. Deliberately left unguarded, because guarding it would
  remove the retry the `catch` performs — and that retry is the only thing that
  reports a stuck lease when the console refuses once. The trade is a rare lost
  notification against a routinely-useful retry, and it is recorded rather than
  silently taken. **Scope:** `notify/notification.ts`, `notify/attention.ts`,
  `cli/block-command.ts`.
- **L-V3-07-2 — an exception under the lease exits 1, not 3, even when the lease
  is provably stuck.** `exitCodeWithLeaseRelease` answers
  `EXIT_RUN_NEEDS_OPERATOR` for every release that is not `RELEASED`, and its own
  reasoning says code 1 would be the substitution V3-07 exists to prevent. Both
  commands' `catch` blocks then do exactly that: a thrown operation keeps code 1
  whatever the release did. That is deliberate, and it is the one place the two
  rules pull against each other.

  The reason it is written this way: a thrown operation produced no primary
  result to combine with, and code 1 is the only value that says *this build
  failed in a way it did not plan for* — which an operator needs told before they
  are sent to inspect a lease. The stuck lease is not hidden by the choice; the
  release line is printed on the same console, `RELEASE_NOT_REPORTED` included.
  What is lost is only the machine-readable half: a script routing 1 to "file a
  bug" and 3 to "inspect the repository" takes the wrong branch here.

  The same function relabels in a second direction, and that is worth stating
  too: a controlled refusal that would have exited 2 — a `--tasks` argument the
  repository does not declare — becomes 3 when the release also fails. That is
  intended (the argument is gone when the operator retypes it; the record in the
  repository is not) and it is tested, but a script routing 2 to "fix the
  arguments" takes the wrong branch there.

  Recorded rather than resolved because resolving either direction is a decision
  about the exit-code contract, not a fix: code 1 grows a second meaning, or the
  thrown-operation case gets a code of its own, or a release condition gets one.
  **Scope:**
  `cli/block-command.ts`, `cli/release-command.ts`, `cli/run-exit-codes.ts`.
- **L-V3-07-3 — the release's own `EVIDENCE_INVALID` guard cannot fire, and one
  build defect is reported as a filesystem condition.** `releaseRepositoryExecutionLease`
  wraps `ExecutionLeaseProof.leasePathOf` in a `try` and answers
  `EVIDENCE_INVALID` if it throws. That arm is dead: `verifyExecutionLeaseHeld`
  runs first, and *its* call to the same function sits inside the `try` around
  the record read, so a throwing private-field lookup is caught there and
  classified by `safeErrnoCode` — which answers `UNKNOWN`, not `ENOENT`, and so
  returns `LEASE_UNREADABLE`. The release then returns on that code before it
  ever reaches its own guard.

  The consequence is small and worth naming: a value that satisfies the brand
  check and cannot yield its path is a defect in this build, and an operator is
  told this build could not get at the lease record. V3-07's sentence for that
  code is written to survive it — it says what stopped this build, and says the
  existence question is unsettled, rather than asserting a record is present —
  but the classification is still wrong, and correcting it
  is a change to `lease/execution-lease.ts`, which this slice does not touch.
  **Scope:** `lease/execution-lease.ts`.
- **L-V3-06-11 — three sibling dist harnesses hand-build a repository identity,
  and are consistent rather than correct.** `test:dist-lifecycle-restart` failed
  both CI jobs because its owner process built
  `{ gitCommonDir: join(root, '.git'), root, id }` from a raw `tmpdir()` while
  the parent used `resolveRepository`. On a GitHub Windows runner `tmpdir()` is
  the 8.3 short form; the resolver returns the long form; and
  `lease/execution-lease.ts` reads a lease whose recorded `leaseKey` is not
  path-identical to the reader's derived key as `UNPARSEABLE`. One physical file,
  two identities. Reproduced and measured locally before it was fixed: for a
  single directory, `KEYS EQUAL: false`.

  That harness now resolves on both sides and requires them to agree. The same
  construct survives in `tests/dist-artifact/stale-lease-recovery-dist-artifact.mjs`,
  `execution-lease-race-dist-artifact.mjs` and `lease-containment-dist-artifact.mjs`,
  which pass only because *both* of their sides hand-build from the same raw
  string. They are not broken and are not fixed here — the moment either side of
  any of them adopts the resolver, this reproduces. `runtime-gate-dist-artifact.mjs`
  already does the right thing. **Scope:** the three harnesses named.
  **Not a production defect:** nothing in `src/` hand-builds a repository record.

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
so answering it needs no new ledger shape. That held: V2-09 answers it against
real Git at the moment the base is used, and added no ledger field.

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
`tests/dist-artifact/execution-lease-race-dist-artifact.mjs` runs sixteen real OS
processes at one lease, eight rounds, and requires exactly one winner each time —
and it is itself held to biting: replacing the exclusive create with an
overwriting one makes all sixteen win.

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
a nominal type with a `#private` field so no literal is assignable, a runtime
gate so a cast fails closed, and a reachability test pinning that exactly one
module in `src/` imports the mint.

The gate itself had to be replaced twice, and the arrangement is worth stating
precisely because both earlier versions *looked* sufficient. `instanceof` was
forged with `Object.create` and the real prototype; `#nonce in value` was forged
by reaching the class through `Object.getPrototypeOf(evidence).constructor`,
which needs no import at all. The gate is now membership of a `WeakSet` only the
mint writes to — not reachable from an instance, a prototype, or the class — so
re-deriving the artefact by any route produces something the gate does not
recognise.

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

Which means the proof sits at the **effect**, not at the entrance to the function
that eventually performs it. Four review rounds each found the same defect in a
new place, and each time the fix was to move the proof rather than to widen it:

| Effect | What the window was | Where the proof is now |
| --- | --- | --- |
| branch + worktree creation | 6 Git subprocesses, 383 ms after `startTask`'s gate | immediately before `mkdirSync` / `worktree add` |
| the writing agent | 9 subprocesses, 585 ms after the driver's gate — it landed a real commit | the agent and verify **seams**, proved at the call; a missing seam is a compile error |
| durable state writes | a cached boolean from the caller | immediately before the write, which also derives the write target |
| worktree + branch **removal** | one gate for two commands | one gate per command |
| the **rollback** of a failed creation | `worktree add` plus six verification probes — a wider window than the creation one | one gate per command, and it removes nothing without them |

The last row is the one that says why the pattern kept recurring. The rollback is
an *undo*, and an undo does not read as an effect until it deletes a branch a
successor has since adopted — which a review then did, end to end. A refusal
there reports `WORKTREE_ROLLBACK_NOT_AUTHORISED` with residue declared, kept
apart from `WORKTREE_ROLLBACK_INCOMPLETE`: Git declining to remove something this
run still owns, and this run no longer being allowed to remove anything, look
identical on disk and are opposite instructions to a human.

### One repository, proved before anything is claimed for it

The lease key is the Git common directory, and `LeaseRepository` is a structural
interface, so nothing in the type system ties its fields to one place. A review
paired repository A's `gitCommonDir` — which decides *which lease file is read* —
with repository B's `root`, which is what callers then write into. Every field
was genuine; only the combination was a lie, and it acquired a second live
authority over B alongside B's own honest lease.

No field of the record can settle that, because the record's own
`repositoryRoot` is written *from* the record at acquire time and so agrees with
it. It is settled against the filesystem instead — by performing **Git's own
resolution**, not by matching layouts:

```
1.  <root>/.git   directory            -> that is the git dir
                  file "gitdir: <X>"   -> <X> is the git dir, resolved against
                                          <root> when it is relative
2.  <git dir>/commondir present        -> the common dir is what it records
                             absent    -> the git dir is the common dir
```

The first attempt at this *did* match layouts — it enumerated the three shapes
someone had thought to measure and refused everything else — and that is worth
recording, because the failure was not subtle. A **submodule** working tree
became permanently unrunnable: Git writes its pointer *relative*
(`gitdir: ../.git/modules/<name>`), a rule inferred from three absolute samples
rejected it, and `run --attended` and `release --attended` were then refused for
good while `lease status` printed a derived path for the same repository. A
`.git` that is a symlink or a junction failed the same way, because only one side
of the comparison was canonicalised.

A whitelist of measured shapes presented as a rule fails in exactly one
direction: every layout nobody measured becomes a lockout, and a lockout is not a
conservative default — it is an outage. Reading `commondir` is what Git itself
does, so it cannot be fooled by a directory that merely happens to be named
`worktrees` either.

This is still not the containment check it looks like it should be: a linked
worktree's root is nowhere near its common dir, and two worktrees of one clone
are deliberately **one** execution domain.

The refusal has its own code, `REPOSITORY_RECORD_INCOHERENT`. It was folded into
`LEASE_LOCATION_UNSUITABLE` at first, whose sentence says no location could be
derived — while `lease status` prints one for the same repository. Two commands
contradicting each other about one repository is worse than a long refusal.

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

Read-only. Reports the state, the owner, the run, the liveness, the revision of
the exact bytes on disk, the filesystem object they are in, and — since V3 slice 5
— whether this build can prove the lease removable, with the missing fact named
when it cannot. It prints no command line with a fact filled into it: the one
command that can act on a lease, `lease recover`, takes no such argument, which is
what keeps a report from becoming an authorisation.

### The break was withdrawn, brought back, and withdrawn again (V2-07LR-Y)

An attended `lease break` existed here twice. The first time, three independent
adversarial review rounds each found a fresh way for it to destroy an authority
somebody had legitimately acquired:

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

It came back in V2-07LR under a contract written from what had defeated it: the
operator naming the lease by the digest of its bytes **and** by the filesystem
object, both re-established on the record the removal had already detached. The
argument for bringing it back was that refusing to ship the destructive operation
did not remove the destructive operation — `status` printed a manual procedure
instead — it only removed the place where the race could be closed.

**That argument was wrong, and a sixth review proved it by closing nothing.**
The race could not be closed there either.

```
v4  digest + object identity, re-established  -> removed a LEGITIMATELY ACQUIRED
    on the detached record                       lease, reproduced end to end
```

**Why the contract cannot be written.** A break has to name one object and still
be acting on that same object after the window between an operator reading a
report and the removal running. For the record that most needs recovering — the
zero-byte artefact a crash leaves between taking the name and writing the record
— every available fact collapses at once:

```
owner pid   absent, so the in-predicate liveness re-check is skipped entirely
revision    sha256(""), a constant every empty file in existence shares
object id   a (dev,ino) pair, on a module that then still shipped fallbacks for
            FAT and network mounts, where such pairs are reused promptly
```

The two conditions were not an unlucky coincidence. The transient empty lease name
existed because `link` failed and the claim fell back to `openSync(path,'wx')` —
so it arose on exactly the filesystems where the index is reusable. That fallback
has since been withdrawn too (below), which removes the empty-name class; the
break was already gone by then, and it is the collapse of all three facts at once
that is the reason, not any one of them being separately repairable. Closing this
needs an atomic compare-and-delete on a directory entry, which no portable
filesystem primitive offers. **A contract that requires a primitive which does
not exist is not repaired by asking harder**, and four consecutive rounds of
asking harder is the evidence.

So there is no `lease break`, no `--force`, no unattended break, no environment
variable and no API back door, and `status` does not print a manual procedure
either: a printed procedure is the same destructive operation with the tool's help
removed. **None of that was reversed.** V3 slice 5 ships a different operation
under a different name — see [Safe stale-lease recovery (V3 slice
5)](#safe-stale-lease-recovery-v3-slice-5) — which refuses the zero-byte artefact
this section is about, permanently, and removes only a lease it has *just proved*
dead inside the call that removes it.

**The renderer was not merely a caller of the unsafe operation.** For a
crash-window record it filled the constant `sha256("")` into a ready-made command
line under the heading "This lease is recoverable", and then stated "Nothing is
removed on a revision you did not see" — a guarantee that is empty for exactly
that class — and "the revision is the lease's identity", which contradicts the
module that computes the identity. The tool supplied the fact that made the
authorisation vacuous and described it as the fact that made it safe. That is why
a report here may state what was observed and may not offer a destructive next
step.

This section predicted the later recovery would be quarantine-and-report, which
never unlinks. It is not: V3 slice 5 unlinks, and what made that safe was not a
better protocol but a *new fact* — owned process containment, and a per-launch
history poisoned before each writer starts, so "no writer of this lease can still
be running" became provable. The prediction is left here because being wrong about
the shape while right about the reason is worth being able to read.

### The acquire fallback is withdrawn, and the lease now needs hard links (V2-07LR-Z)

Independent of the break, and the change that closes the class rather than one
caller. `claimViaExclusiveCreate` was the second claim mechanism: where `link`
failed it took the lease name with `openSync(path,'wx')` and wrote the record
afterwards. Two defects were reproduced on the object it produced, and a third
was one path difference away.

**One.** Its rollback gave the claim back with

```
(present) => nonceOfBytes(present) === null || nonce === ourNonce
```

and `nonceOfBytes` answers `null` for anything unparseable — including an empty
file, because `JSON.parse('')` throws. The empty file at that name is not
necessarily ours: it is exactly what a *competing* acquirer leaves while it sits
in its own pre-write window. Reproduced with **measurably different inodes**, so
no identity collision and no filesystem assumption were involved: P1's rollback
deleted P2's file, P2 kept its descriptor and still believed it held the claim,
and the lease name was left free for a third writer.

**Two.** Fixing that predicate was not enough. `removeVerifiedLease` detaches a
record by `rename`, and when it may not remove it, puts it back by `link`. On a
filesystem with no links the restore falls back to writing a **copy** and the
caller then discards the detached original — destroying the object of a writer
that still holds its descriptor. Measured end state: the victim writes its record
into an orphaned inode, the lease name holds a different permanently-empty file,
every later acquirer is refused, and nothing in the build can clear it. That
artefact is not a crash window: no run died, the build created it.

**Three.** `release` reaches the same code by the same route.

So the mechanism is gone rather than patched a fourth time:

```
hard-link path available      -> lease lifecycle supported
hard-link path unavailable    -> no exclusive-create substitute
                              -> fail closed BEFORE a lease exists
                              -> LEASE_FILESYSTEM_UNSUPPORTED, with the errno
```

**This is a stated reduction in supported platforms, not a silent one.** FAT,
exFAT and some network or container-mounted paths can no longer host a
repository's execution lease, and `agent-loop run --attended` refuses there
before creating anything. The alternative was an acquisition whose release and
rollback could not be implemented safely — a supported-looking lease whose
destructive operations lack the primitive they need. A named unsupported
filesystem is the better product.

Three consequences worth stating plainly:

- the lease name now only ever appears **already complete**, published by a
  `link` of a fully written staged record. No acquirer ever holds it with an
  unwritten file, which is what makes the copying restore in `putBack` safe: its
  victim class no longer exists;
- `putBack` keeps that copying fallback anyway, for the link failure that is an
  anomaly rather than a platform fact — NTFS's 1024-name limit on the object
  being restored, or a permission refusal. Without it a refused restore leaves
  the lease name free while reporting that nothing was removed, which is the
  dispossession defect the fallback was added to close;
- the acquire rollback predicate is strict regardless: `nonceOfBytes` answering
  `null` is the **absence** of an ownership fact, never one. A failed write leaves
  its own half-written file at the lease name rather than risking a stranger's.
  **A crash artefact left behind is strictly better than two writers.**

`removeVerifiedLease` now has two call sites, both inside `execution-lease.ts` —
the evidence-mint rollback and `release` — and a test pins that no module outside
it calls the function, scanning code with comments stripped so that explaining
the mechanism is not mistaken for reaching it.

**V2-07P made the surrounding contract match this refusal.** When this was
written, the filesystem boundary was enforced while the runtime around it was
not: the build refused a filesystem that could not link, and would happily start
on Linux or on an untested Node. The runtime is now gated too, and the
repository path is refused by shape when it is explicitly UNC or a device path.
The division of labour is unchanged and deliberate — the *runtime* facts are
decided once at the entry because they are process-constant, and the
*filesystem* capability stays where it was, proved at the link that needs it.

### The release contract is pinned by value and by effect (V2-07LR-AA)

This round changed **no release behaviour**. It is a remediation of the
*observability* of behaviour that was already correct, and it is here because
for an authority layer that distinction does not lower the bar: a guarantee
nothing can break is a guarantee nobody is keeping.

Two gaps, both established by mutation against the shipped head rather than by
reading:

**One — the failure half of the release map was pinned by outcome type only.**
`releaseRepositoryExecutionLease` maps nine `VerifiedRemoval` states onto six
codes and five `detail` tokens, and the suite asserted `result.code` alone.
Every token could be exchanged for another, or for `null`, with the whole suite
green — and those tokens are the difference between *"a successor holds this
repository"*, *"this repository has no owner and there is a record in
quarantine"*, and *"the lease is still exactly where it was"*. Three sentences
that send an operator to three different places.

The map is one-to-one, which is what makes it pinnable: each of the nine states
produces a distinct `(code, detail)` pair, so a test that asserts the pair has
named the state. `tests/v2-07lr-release-window.test.ts` asserts all nine as
whole values, reaching four of them through the window between the read that
proves the lease and the syscall that removes it — the `vi.mock('node:fs')`
after-read hook `tests/v2-07lr-enoent-window.test.ts` already established, with
no sleep, no barrier and no child process. Where a real refusal is available it
is used rather than injected: the `DETACH_REFUSED` case renames a directory
Windows will not rename.

**Two — a release was never checked to have had an effect.** The `discard` that
deletes the detached record after a successful removal could be dropped
entirely: the lease name is free either way, so every assertion still held —
while every release left a full copy of a live lease record under a
`.breaking-…` name inside the Git administrative directory, permanently, with
nothing in the build that removes it. So the rule now is that a release is read
from the *directory*: after every successful one, no entry whose name this
protocol owns may remain — not the lease, not a quarantine record, not a staging
file.

That is also why `test:dist-lease-release` exists. The only real-process
measurement of the release effect used to be incidental to the attended-break
harness and was deleted with it, which is the coverage class this round is
really about: **when a test or harness is removed, the question is not only
which of its assertions were replaced, but which production claims cite it as
their only instrument.** Nothing load-bearing was deleted knowingly; the
measurement went anyway.

Twenty-five mutants of the release path — every `detail` token, both directions
of the `ENOENT` discriminations in the detach and in the read of the detached
object, the removal predicate, both `discard` calls, `occupancyOf`'s fail-closed
answer, the staging cleanup, the quarantine marker, and `removeVerifiedLease`
reduced to `return 'REMOVED'` — are killed by the two new vitest files.
Nineteen were the list this round set out to kill; six more were invented
afterwards, adversarially, and died too.

Four of them were then run against the **pre-existing** suite, to establish that
the gap was real rather than assumed. Three survived it: two exchanged `detail`
tokens, and the effect mutant that leaks a quarantined record on every release.
One did not — the whole-function `return 'REMOVED'`, which an existing test
catches. A claim that *nothing* in process caught it stood in this file and in
the commit message of `588cb1a` before that measurement; it is corrected above
and in `package.json`, and left standing here rather than quietly deleted,
because this repository's recurring defect is exactly a claim about coverage
written before the coverage was measured.

One documentation defect went with it: the `ENOENT` arm of the detached-object
read cited the break harness as its empirical record, and that harness is no
longer in the repository. The measurement stands as history and now says so,
beside the instrument that pins the branch today.

### One reading of the authority record (LF-2)

`LeaseRepository` is a structural interface, so nothing said its three fields
were *values*. A record whose `root` is an accessor answers one repository when
the authority gate asks and another when the effect asks — both truthfully — and
an adversarial review drove exactly that through three entry points with nothing
forged anywhere: a branch and a worktree created in repository B on a lease held
over A, a workspace *deleted* in B the same way, and a durable transition aimed
at B.

The fix is that there is no second read: `advanceTaskState`, `startTask`,
`prepareTaskWorkspace` and `removeTaskWorkspace` each take one frozen reading at
their top and use only that. What proves it is not the snapshot's existence but
the effect — `tests/v2-07lr-lease-recovery.test.ts` asserts that the repository
the gate never saw is byte-identical afterwards, and each of those assertions
fails on the code as it stood.

### What V2-07L is not

No owned process containment: the orchestrator still does not create a Job Object
on Windows or supervise a process group on POSIX, so it cannot assert that its
agents die with it. That is the missing mechanism, and automatic stale-lease
recovery needs it first — necessarily before unattended running.

No TTL and no renewal. A lease does not expire, because time alone is never
evidence that a writer has stopped: a suspended or badly delayed writer can wake
up and write beside its successor. No block runner, and no change to what the
ledger means.

### The platform contract, made executable (V2-07P)

Six adversarial review rounds on the execution lease spent their budget on
filesystems this project will never run on, and each repair widened the surface
the next round had to break. The decision behind this slice is that V2 is built
for its actual deployment and says so.

**What was measured before anything changed.** Against the shipped build,
`\\server\share\repo\.git`, `\\?\UNC\server\share\repo\.git` and
`\\.\PhysicalDrive0` were all **accepted** as lease locations — the Windows
check admitted the UNC shape explicitly. So this slice removes a real
acceptance, not a theoretical one.

**The runtime gate is not a filesystem preflight, and could not become one.**
It reads `process.platform` and `process.version` and nothing else. Both are
fixed by the running Node binary, so there is no later moment at which either
could answer differently — which is why deciding them once at the entry is not
a check relocated away from its effect. The lease's filesystem capability is not
like that, and it stayed exactly where it was.

**Three refusals where there was one.** A UNC path resolves perfectly well; the
build refuses it because V2 does not support network storage. Reporting that as
`LEASE_LOCATION_UNSUITABLE` — whose sentence says no location could be derived —
would have been the same defect `REPOSITORY_RECORD_INCOHERENT` already records
against itself. A device path got a third code rather than being folded into the
network one, because a device path is not network storage.

**What the contract deliberately does not claim.** A drive letter can be a
mapped network share, in the plain and the extended-length form alike, and this
build does not detect it. That is recorded as an ACCEPTED LIMIT in the
supported-runtime section rather than described as unlikely, because closing it
would require the filesystem preflight the whole design avoids.

**Node became a whitelist.** At V2-07P, `[22, 24]`, not `>= 22`. A floor
enforces a contract wider than CI proves; the two disagree only on 23 and 25,
and both are pinned by test. CI gained a second job so that every enforced
member is a verified one.

**POSIX code was not deleted.** The gate makes the `exec.ts` process-group
branches, `path-identity.ts`'s casing fold and the POSIX profile resolver
unreachable. They stay: removing them means rewriting the most dangerous module
in the build inside a slice whose purpose was to stop opening review surfaces.

## The attended block runner (V2-08)

Everything needed to *record* a block run existed and was proved. What did not
exist is the thing the product is for: **something that actually runs a block.**
V2-08 adds that driver and nothing else. `block-runner.ts` decides *sequence*,
`block-conclusion.ts` decides *meaning*, and neither invents orchestration truth:
the lease decides who may write, `startPlannedTask` prepares a workspace,
`runTask` drives one task, and `block-progress.ts` records every outcome against
the task's own durable record and refuses whatever that record does not prove.
Nothing in the runner writes the ledger except through those primitives.

### Two classes of bad news, and confusing them is the defect

| | class 1 — *a task failed* | class 2 — *the run cannot safely continue* |
| --- | --- | --- |
| what it is about | one task's own outcome | the run's ability to make any further durable claim |
| effect on the block | the run continues with tasks already known to be independent | the whole block stops immediately |
| example | the agent could not finish A; a human must resolve it | the lease is no longer certainly held |

A block of `A, B, C` where `A` fails locally and `B` and `C` are independent ends
as

```
A = BLOCKED          B = READY_FOR_PR          C = READY_FOR_PR
```

and the run's reason is `TASK_BLOCKED`. That block is **not `COMPLETE`** —
`COMPLETE` still means every member `SETTLED` — and it is not a wasted run
either. "Not complete" and "wasted" are different statements; the ledger already
had the vocabulary for the first, and what it lacked was a runner that would not
throw the other two tasks away in order to say it.

Continuing after a task-local failure is safe **because every continuation is
still gated by the same proof.** `settleBlockTask` reads B's own durable state
and refuses a settlement that state does not support, whatever happened to A. A
failed A cannot make a false claim about B possible. What a failed A *can* do is
consume the operator's attention — which is why the run stops for class 2, where
the machinery that would catch a false claim is itself in doubt. Continuing is
the safe direction here, and only here.

### The policy this reverses, named as a reversal

`TASK_DISPOSITIONS` documented `BLOCKED` as *"waiting for a human and stops the
run as a matter of policy"*, and `parkBlockTask` implemented that sentence by
writing a stop reason. Both are gone. It was a documented contract statement in a
shipped, proved artefact, so amending it was a task of this slice with its own
control rather than a comment edited in passing — and the control that proves the
reversal happened is the one that fails against V2-07's behaviour: a two-task
block whose first member parks, and whose second is then still activated. The
runner-level control beside it drives a block of three independent tasks where
the first fails locally and the other two still settle.

What did **not** change: `BLOCKED` and `ABANDONED` are still `EVIDENCE_BACKED`,
still terminal for their task, and still unrecordable without the task state that
proves them. Only the *run's reaction* to them moved. `TASK_BLOCKED` and
`TASK_ABANDONED` survive as stop reasons with their meaning narrowed from "abort
now" to "this run ended without completing, and a task outcome is why", and they
stay in `PROGRESS_CLAIMING_STOP_REASONS`, because they still assert something
about the tasks and must still be proved against every task record.

### A `stopReason` is itself a durable claim

This is the insight that reshaped the design. When the condition *is* that the
run has no write authority, or no durable write capability at all, a runner that
records it is asserting durably that it cannot assert durably. So class 2 splits
by **representability** rather than by severity, and a condition becomes a
persisted `stopReason` only where writing it is something the run can still
honestly do:

```
recorded    OPERATOR_STOPPED · LEDGER_DIVERGED · STATE_UNUSABLE
            DEFINITION_DRIFTED · ACTIVE_TASK_UNRESOLVED

reported    LEASE_AUTHORITY_UNCERTAIN · DURABLE_WRITE_FAILED
            RUN_GATE_REFUSED · RECONCILIATION_UNRESOLVED
```

`BLOCK_RUN_OUTCOMES` therefore has five members: `BLOCK_RUN_ENDED`, where the
ledger carries the ending, and the four above, which reach the operator through
the runner's report. They stay four rather than one generic `RUN_UNSAFE` because
they demand four different reactions — find out who else holds the lease, fix the
disk or the permission, satisfy the gate, look at task state that moved under a
held lease — and the exit table grades them by that: a lease somebody else holds
and an unsatisfied gate exit 4, whose sentence is "nothing durable is wrong and
re-invoking under other conditions can differ", while a refused write and a
refused reconciliation exit 3, because a scheduler told 4 would retry into the
same refusal forever.

For two of them the no-write rule is a consequence and not a preference. With
`LEASE_AUTHORITY_UNCERTAIN` any further mutation is precisely the act the run may
have lost the authority for; with `DURABLE_WRITE_FAILED` the failed write is the
condition being reported. A best-effort stop write there would be the run's least
trustworthy claim, made at its least trustworthy moment.

**Across each of the four the ledger is left byte-identical**, and that sentence
is the exact one. It is deliberately weaker than "nothing was written": all four
are reachable after this run has already recorded settlements, parks and
abandonments, and those records are true and they stay. What none of the four
adds is a stop claim. Two of them can additionally strike before any ledger
exists, which is a fact about where the condition arose and not about what the
outcome means. The suite anchors the bytes at the last write that landed and
compares them *across* the condition — and asserts the anchor's own `stopReason`
as well, because an anchor defined as "the last write that landed" moves with an
extra write and would not, on its own, notice one.

### `ACTIVE_TASK_UNRESOLVED`, and why it is not `STATE_UNUSABLE`

`STATE_UNUSABLE` says something about the task *state*: damaged, foreign, not
trustworthy. A task can hold entirely legitimate prior evidence and still end in
a condition whose outcome cannot be determined — a driver that made no progress,
a settlement whose proof no longer holds, an interruption nothing can conclude.
That is a **different fact**, and folding it into `STATE_UNUSABLE` is exactly the
misdescription class V2-07P spent three review rounds deleting.

It **may coexist** with `ACTIVE` and an unchanged `activeTaskId`: it does not
require the run to first invent a disposition for the task it could not conclude.
It drags no disposition and no commit evidence with it, which
`UNRESOLVED_STOP_CARRIED_MORE` already enforces. And it is deliberately **not**
in `PROGRESS_CLAIMING_STOP_REASONS` — sorted in, it would be proved against every
task record before it could be written, and it exists precisely for the case
where one of those records cannot be judged. It would be unwritable exactly when
it is true. That sorting is pinned by a hand-written correctness table, one case
per reason: `satisfies Record<…>` proves every member was considered and proves
nothing about which side each landed on.

### The frozen plan carries the dependency relation

**V2-08 does not interpret dependencies.** Only tasks already established as
independent may continue after a sibling's local failure, and the runner reads
that property rather than deriving it. Except that it could not read it:
`BlockDefinition` was `blockId` plus ordered `taskIds` and nothing else, so the
slice's headline behaviour would have been unreachable in *every* block —
continue-on-task-local-failure shipped as dead code.

So the frozen plan gained the relation, and `fingerprintBlockDefinition` binds
it. Not derived live from `task-graph.ts` during the run, because a roadmap edit
would then change the answer to "may B continue after A?", which is the opposite
of frozen-plan authority. Not a bare `independent: true` flag either, which would
freeze the *judgement* while leaving the evidence it came from unfrozen.

**A direct intra-block edge check would have been unsound**, and that is a
measured result rather than a caution. `normalizeTaskGraph` stores each
definition's own edge list and its direct reverse, computes no transitive closure
anywhere, and normalises over the whole discovered task set. A block is an
arbitrary subset of a repository-wide DAG, so this is representable:

```
A: dependsOn []
X: dependsOn [A]      <- not a block member
B: dependsOn [X]

block = {A, B}   ->   no direct intra-block edge exists,
                      yet B transitively depends on A through X
```

A member's frozen `dependsOn` is therefore **the set of block members it
transitively depends on**, walked over the full normalised graph and restricted
to members once, at the end, never at each hop. Freeze time, never run time:
`projectBlockDependencies` has exactly one production importer — the CLI freeze
site — and the runner reaching it by any route fails that assertion.

`independenceIsEstablished` then asks the relation one question, *does any member
depend on any member*, and answers it for the block rather than for a pair.
Per-pair continuation is a dependency scheduler and V2-08 does not get one: as
soon as any relation holds between members the block still has to process, that
block is not supported input, and the run degrades to stopping at the first
task-local failure exactly as V2-07 does. That degradation is the correct one,
because it is the behaviour that is already proved.

### Cause beats consequence

`NO_ELIGIBLE_TASK` became reachable in a new way under the reversed policy: after
A fails and B and C settle, a block with nothing left to run is *finished*, not
obstructed. It must not become the generic "the loop ended" code, because an
operator told "no eligible task" has learned the consequence and not the cause.
The end reason is the most specific task disposition that explains the ending:

| condition | reason |
| --- | --- |
| every member settled | `COMPLETE` |
| at least one `BLOCKED`, nothing runnable left | `TASK_BLOCKED` |
| no `BLOCKED`, at least one `ABANDONED`, nothing runnable left | `TASK_ABANDONED` |
| no disposition explains why nothing is eligible | `NO_ELIGIBLE_TASK` |

`BLOCKED` beats `ABANDONED` where both are present, because a human can act on a
blocked task and nobody can act on an abandoned one, so the reason names the one
with a next step. `NO_ELIGIBLE_TASK` is now **reserved** for a genuine
eligibility dead end that no persisted disposition accounts for — a member whose
path to eligibility runs through a non-member, which the frozen relation
deliberately records nothing about (F-B4). As V2-08 shipped, a member blocked by
another *member* ended the same way; V2-09 removes that half.

### Schema version 2, and version 1 refused rather than migrated

`frozenDependencies` and `ACTIVE_TASK_UNRESOLVED` land under **one** bump of
`BLOCK_LEDGER_SCHEMA_VERSION` — not one per value, and with no "the enum grew but
the version stayed" exception. A version-1 reader genuinely cannot understand a
version-2 document: it meets a stop reason outside its closed vocabulary and a
field its `.strict()` schema refuses.

A version-1 ledger is refused on load as `LEDGER_SCHEMA_UNSUPPORTED` and is
**never migrated**, which is a decision rather than an omission. It carries no
`frozenDependencies`, and the only way to give it one is to invent it — which
would hand the run authority to continue after a task-local failure on a relation
nobody froze. Refusing costs an operator one new run id; migrating would cost
them a guarantee.

The version boundary is also kept apart from corruption in both directions. A
document with **no usable declaration** is not "written by an older build", it is
unreadable, and belongs on the ordinary contract-violation path that explains why
it was refused; only a version this build can name and does not match earns the
gentler label. One classifier answers that for the load path and the update path
alike, so the two cannot drift back apart.

### One reading of the roadmap, taken under the lease

```
attended:  resolve -> lease -> plan -> project -> define -> run -> release
default:   resolve -> plan -> project -> define -> report    (no lease, no writes)
```

The lease comes first because a plan frozen above that line is a plan this
invocation was not yet the writer of: a legitimate other writer could edit the
roadmap between the reading the block was frozen from and the moment the lease
landed. `run-command.ts` already took the lease before selecting a task, so the
block command was the anomaly and not the correction. The cost is that an
unusable `--tasks` argument is now refused while the lease is held, for the few
milliseconds it takes to plan and project; `finally` gives it back on every path
out, including a throw.

That single `planNextTask` result is then the projection, the fingerprint, the
eligibility filter and every task's start gate. The runner takes the whole
`TaskPlanningSuccess` rather than a list of eligible ids, because a list handed in
beside a plan read somewhere else is two readings that can disagree — and the
disagreement would surface as `TASK_INELIGIBLE` for a task the run had already
chosen.

**`startPlannedTask` had to exist for that to be true rather than asserted.** The
runner imports no planner, and that was not enough: `startTask` called
`planNextTask` itself and refused `TASK_INELIGIBLE` from *that* reading, so a
mid-run roadmap edit was back in charge of what runs — behind a primitive instead
of in the loop, with every module in `src/block/` looking innocent. `startTask`
now reads the plan once and delegates; `startPlannedTask` is *given* a planning
result and has no way to produce one; the runner uses only the latter. The second
read is not hidden, it is absent.

The block layer's planner use is pinned twice, because one scan was not enough. A
path-scoped assertion walks every occurrence of the planner's module specifier
back to the declaration that owns it and classifies it as a value import or a
type-only one — the runner must keep naming `TaskPlanningSuccess`, so an
assertion that reddened on the type would force the module to stop naming what it
legitimately consumes. A name-scoped companion catches the laundered route, where
a module under `src/run/` re-exports `planNextTask` and `src/block/` imports it
from there, naming no planner path anywhere. Neither subsumes the other, and both
directions of both were established by mutation.

### A block run's lifetime is its invocation's lifetime

An earlier draft let a run survive its invocation: the driver's step budget ran
out, the process exited, and a later invocation picked the same run up. Three
statements were asserted at once and they cannot all hold — the same durable run
survives, the invocation terminates, and one lease spans the whole block run. A
terminating invocation gives the lease back, so between two invocations the run
would be open with no holder; leaving the lease behind on purpose is the
stale-lease surface this slice may not reopen, and a later process adopting a run
it never started is worse.

So there is **no resume**, and `startBlockRun`'s existing refusal *is* the
answer: a run id that already has a ledger belongs to an invocation that is over,
whether it stopped cleanly or was interrupted, and that record is not overwritten
(`RUN_ID_ALREADY_USED`). An operator continues by starting a new run id. One run
id, one invocation, one lease.

The driver's `STEP_BUDGET_EXHAUSTED` is **absorbed** rather than allowed to end
the invocation: the runner drives the same task again under the same lease, and
re-proves the lease between continuations. `maxSteps` bounds one `runTask` call
so a driver cannot run away, and says nothing about a task's outcome — graded as
an ending it would turn a scheduling limit into a claim about a task, and graded
as an ending of the *invocation* it would need a block run that outlives its
holder. The continuation terminates: every `STEP_BUDGET_EXHAUSTED` carries
durable progress by its own definition, the task's state machine is bounded by
the repository's `maxReviewRounds`, and a continuation that lands zero durable
steps is refused as unresolved rather than tried again. `agent-loop block`
therefore never exits 5, because there is no state in which calling again would
continue anything.

### `agent-loop block`

```powershell
agent-loop block --repository <abs path> --block <id> --tasks <id...> --run <id>
agent-loop block --repository <abs path> --block <id> --tasks <id...> --run <id> --attended
```

Read-only by default. It resolves, plans, projects, defines and prints what a run
*would* be started against — including whether the members are established as
independent, which is the property the whole slice turns on — while starting no
agent, writing no ledger and taking no lease. A command that wrote nothing and
drove nothing has no claim on the repository's turn as writer, and the snapshot
it prints authorises nothing.

The report states plainly that eligibility and independence are two different
questions, because a member independent of every other member can still be
waiting on a task the block does not hold. `--run` is required and never
generated: a run id the tool invented would be a run an operator cannot name
back. `--attended` states that an operator is present for this invocation; it is
not a claim about credentials, and a fresh auth preflight must still pass.

### Carried forward from V2-08, deliberately

- **F-B1 — an attended invocation acts on one snapshot of the roadmap.** One
  `planNextTask` result, taken under the lease, is the projection, the
  fingerprint, the eligibility filter and every task's start gate. So a roadmap
  edited while the invocation is in flight changes nothing about it in either
  direction: it cannot stop a member that was eligible when the operator asked,
  and it cannot make one runnable that was not. Accepted deliberately — the
  alternative is a run whose authority a mid-run edit can move, and the version
  of that which re-derives the relation is the inversion the whole slice exists
  to prevent. There is no drift check to notice the edit either, because with no
  resume there is no persisted predecessor to compare against. The edit is seen
  by the next invocation.

  What this cost, and it is worth naming: `startTask` read the plan itself, so
  the property was false one layer below a runner that looked correct. Closed by
  splitting the start path rather than by documenting the exception.
- **F-B2 — `independenceIsEstablished` is all-or-nothing.** A block with any
  frozen edge degrades to V2-07's behaviour — stop at the first task-local
  failure — even where the remaining members happen to be mutually independent.
  Accepted: the finer answer is a dependency scheduler, and V2-09 owns it.

  V2-09 kept the behaviour and gave it a better reason. In a dependent block a
  task-local failure is not merely a sibling's bad luck: it is the absence of the
  commit some successor was to be built on, so continuing past it would leave the
  run choosing which of the operator's members to abandon quietly. What changed is
  that this is now the *correct* ending rather than a degradation, and it has its
  own end-to-end control.
- **F-B3 — two persisted reasons have no producer in this runner.**
  `OPERATOR_STOPPED` has none because the runner installs no signal handling.
  `DEFINITION_DRIFTED` has none because a block run does not outlive its
  invocation, so there is never a persisted predecessor whose fingerprint could
  differ from the plan just frozen; `reconcileBlockRun` still reports drift to a
  caller that supplies a definition. Both stay in the vocabulary and stay graded
  in the exit table. Either a later slice gives them producers or the members are
  withdrawn — neither is treated as reachable in the meantime, and the suite says
  so in a list rather than by omission.
- **F-B4 — a member blocked by anything the run cannot finish ends the run
  `NO_ELIGIBLE_TASK`.** As shipped in V2-08 this covered *any* unfinished
  dependency, member or not: the eligibility snapshot is taken once and never
  revisited, so a member whose dependency was another member of the same block
  was equally unreachable. The sentence here previously named only non-members,
  which understated it — and understated it in the direction that mattered,
  because it read as though a dependent block merely lacked a scheduler when in
  fact it could not run at all. V2-09 removes the member half — see below — and
  leaves the non-member half exactly as it was, deliberately: the frozen relation
  records nothing about non-members, so a block can be frozen while that member
  can never become eligible, and that is the honest dead end rather than a defect.
- **F-B5 — an interrupted invocation leaves a run nothing can continue.** A
  crashed or killed attended invocation leaves an open ledger, possibly with an
  `ACTIVE` entry, and no later invocation may adopt it: the run id is spent and
  `startBlockRun` refuses it. Accepted as the fail-closed side of the lifetime
  decision — the record still says what happened and which task was in flight,
  and `release --attended` still handles the workspace that task left behind.
  What is *not* offered is a continuation, because offering one would mean a
  durable run outliving the lease that authorised it.

### What V2-08 is not

**Attended only**, and that is the single most important scope line in the slice.
Unattended running needs *owned process containment* rather than merely the
lease, and automatic recovery of a stale lease stays refused until the
orchestrator creates that containment itself — so staying attended is exactly
what keeps that surface closed. Nothing here creates a Job Object, supervises a
process group, or changes the lease's recovery answer.

**Sequential only.** The ledger enforces one `ACTIVE` task and this runner drives
one at a time; "several independent tasks" is about surviving a sibling's
failure, never about concurrency. Parallel execution would need the same
containment.

No commit chain and no dependency scheduler — V2-09 owns both, and the chain must
earn a claim V2-07 explicitly refused to make: that a `READY_FOR_PR` task has a
commit fit to be a successor's base. No new platform, filesystem or ownership
behaviour: V2-07P closed that block and it is not reopened here. And
`READY_FOR_PR` is still terminal, so the orchestrator still hands a finished task
to a human and stops.

## The dependent commit chain (V2-09)

V2-08 could run a block whose members were independent. A member that depended on
another was not merely unscheduled — it was **unreachable**, and by more than one
mechanism at once. `chooseTask` filtered candidates against a frozen eligibility
snapshot; `startPlannedTask` gated each start against the same reading; and the
planner calls a task eligible only when every direct dependency has roadmap
status `DONE`. For a block containing `A → B`, `A` has to be `OPEN` at freeze or
it could not run either, so `B` was `BLOCKED_BY_DEPENDENCIES` at freeze and there
was no second reading. `B` never ran, in any block, and the run ended
`NO_ELIGIBLE_TASK`.

V2-09 removes exactly that, and adds nothing else to the frozen snapshot.

### `SETTLED` is a disposition; `SETTLED` + chain-fit is a satisfied dependency

The one thing added to the snapshot is **this run's own settlements**, which are
monotone (`PLANNED → SETTLED`) and were each proved against the task's own
durable record before they were written. No second reading of the roadmap is
taken, and no roadmap file is ever written.

```
runnable(T) :=
    frozenEligible(T)
  OR (
    frozen ineligibility of T is BLOCKED_BY_DEPENDENCIES
    AND every unsatisfied dependency of T is a block member
    AND every such member is SETTLED in this ledger
    AND the selected successor base is chain-fit
  )
```

The last two conditions do not subsume one another and both are required.
Runnability is answered from the planner's *direct* `unsatisfiedDependencies`;
chain fitness is answered from the frozen *transitive* required set, against real
Git. Each can hold while the other fails, and the suite pins both directions
against each other rather than trusting that one implies the other.

A dependency on a **non-member** is still a hard dead end. The ledger holds no
entry for it, so there is nothing this run could have proved about it.

What this cost is one widening of the start gate, and it is narrow by
construction: `startPlannedTask` accepts `satisfiedDependencies`, overrules
`BLOCKED_BY_DEPENDENCIES` and nothing else, and only for dependencies named one
by one. A caller cannot turn it into "start anything" — naming a dependency does
not produce a base, and the workspace is still the one the caller pinned, under
the lease, in this repository. `startTask` passes an empty list, so the
single-task path is exactly the path it was.

### Two commit roles, and only one travels — and the authority is durable

```
executionBaseCommit    what the task's code is built on
                       = blockBaseCommit for a root member
                       = resultCommit(M) for a chained member

scopeAuthorityCommit   which commit's profile decides the allowed scope
                       = blockBaseCommit for EVERY member of the block
```

A predecessor may pass its successor code. It may never pass it authority: if `A`
commits a profile widening `allowedPaths` to everything, `B` is still judged
against the profile at `blockBaseCommit`. A legitimate profile change becomes
authority only in a later, newly frozen invocation.

**And the invariant outlives the invocation, or it is not one.** This is where an
earlier draft of the design was wrong, and the correction is the substance of the
slice rather than a detail of it. A chained task's durable `TaskState` is an
ordinary task state: it pins `basePinnedCommit = A.resultCommit`, and nothing in
it says that some *other* commit governs its scope. So an invocation-scoped
answer — the block runner handing the authority to the driver it starts —
protects the run and nothing after it:

```
block run:   blockBase = M0,  A settles at A1 (A1 widens the profile),
             B is started chained at A1 and the invocation then ends

later:       the roadmap says A is DONE, but the authoritative default branch
             does not contain A1 - A was squash-merged, reworked, or the
             status was simply written by hand

standalone:  agent-loop run --attended --task B
             eligibility now passes, B's existing state is used,
             the scope is read from B.basePinnedCommit = A1
             -> agent A decides B's scope after all
```

So the two roles are separated **in the durable record**. `TaskState` gains
`scopeAuthorityCommit`, written once at start, `null` meaning *this task's own
base pin governs*. It is additive, nullable and defaulted, and it is deliberately
**not** a schema version bump: a state written before this slice parses unchanged
and means exactly what it meant, because no pre-V2-09 task had a base authored by
a sibling. Nothing is invented for an old document, which is the test the ledger's
version-1 refusal applied and failed. The other direction fails closed on its own
— an older build meets an unknown key at a `.strict()` boundary and refuses the
state.

`assessTaskScope` therefore takes two commits on purpose: the **delta** is
measured from the base pin, because that is the tree the work sits on, and the
**declaration** is read from the scope authority. The `??` fallback exists in
exactly one place, so "which commit governed" has one answer. No profile object
is copied anywhere.

The control that proves this is the only kind that can: a block run that ends with
`B` chained and unfinished, the roadmap then marked `DONE` for `A`, and an
ordinary `runTask` under a fresh lease continuing `B` afterwards. It was seen to
fail with the runner passing `null` — and seen to fail *at the effect*, with the
continuation completing the task under the widened profile, not merely at the
assertion about the field.

### Roadmap `DONE` is not evidence about Git

An earlier draft of this design argued that once `A` is roadmap-`DONE`, a human
has accepted `A`'s commits, so `A`'s widened profile is no longer
self-authorisation. **That inference is unsupported, and it is retracted here
rather than quietly replaced.**

`status: DONE` is a markdown field written by whoever edits the file. It says
nothing about which commits reached the default branch, or in what shape. `A` can
be squash-merged without the profile hunk, reworked before merge, or simply marked
done by hand, and `B`'s durable state still pins `A1`. Nothing in this build
treats that field as evidence about Git, and the gate ordering in `start-task.ts`
that closes the window *while* `A` is not `DONE` buys invocation safety — not the
durable invariant.

### The unique maximum, and why a diamond is refused

The chain shape is read from `frozenDependencies` and from nothing else:

```
frozen member dependencies empty
→ base(T) = blockBaseCommit

frozen member dependencies non-empty
→ there must be exactly one unique maximum M in the frozen transitive
  member relation
→ base(T) = resultCommit(M)

no unique maximum
→ unsupported block input, refused at freeze
```

`A1 → A2 → B` gives `base(B) = resultCommit(A2)`, and `A2`'s history already
contains `A1`'s. `A1 → B ← A2` with `A1` and `A2` incomparable has no such commit:
the only ways to invent one are to merge — a Git effect this slice does not make —
or to pick one and silently drop the other's work. So the **whole block** is
refused, in both modes, before anything durable happens. Refusing only the
offending member and running the rest would be this build improvising which half
of an operator's request to honour.

**No implicit linearisation.** Independent members are never stacked on one
another to manufacture an order; a root member takes the block base, never a
sibling's result.

### Chain fitness is proved at the effect

Nothing about a base is ever stored. A recorded "this base was fine" is a claim
about a repository at an earlier instant, and the repository is the one thing an
operator can change between two instants. For a chained member `T` with unique
maximum `M` and required predecessor set `R`, immediately before the base is used:

| # | question | refusal |
| --- | --- | --- |
| 1 | every `P` in `R` is `SETTLED` in this ledger | `PREDECESSOR_NOT_SETTLED` |
| 2 | `M`'s entry carries a `resultCommit` | `PREDECESSOR_RESULT_ABSENT` |
| 3 | that commit exists, as a commit | `BASE_OBJECT_ABSENT` / `BASE_OBJECT_UNREADABLE` |
| 4 | some ref contains it | `BASE_NOT_REFERENCED` |
| 5 | `blockBaseCommit` is ancestor-or-equal of it | `BASE_NOT_DESCENDED_FROM_BLOCK_BASE` |
| 6 | every `P` in `R` is contained in it | `BASE_MISSING_REQUIRED_PREDECESSOR` |
| 7 | the ledger names exactly one block base, and it is ours | `CHAIN_ANCHOR_MISSING` / `CHAIN_ANCHOR_AMBIGUOUS` |

Existence and reachability are different facts and the chain needs both: an object
no ref contains is either about to be pruned or is the discarded tip of a deleted
branch, and chaining onto the second would resurrect abandoned work into a
successor's pull request, silently. Rule 6 is what excludes a `READY_FOR_PR`
record from an older run, which `applyForcedProgress` may legitimately settle and
which does not thereby authorise this chain.

### The chain anchor is a cardinality rule

Rule 7 is the one that looks like an existence check and is not. `blockBaseCommit`
is an invocation input; what makes it *derivable* from the ledger afterwards is
that the empty-row members which have started agree on **one** value:

```
R1  frozen row []   baseCommit = M0     started by this run
R2  frozen row []   baseCommit = M1     forced-settled from an older run

reader of the durable document alone:
  "blockBase := the baseCommit of an empty-row member"  ->  M0 or M1
```

Two answers is no answer. So the set of recorded empty-row base commits must have
cardinality exactly one, and its element must be this invocation's base. More than
one distinct value is `CHAIN_ANCHOR_AMBIGUOUS`; no value, or one that is not ours,
is `CHAIN_ANCHOR_MISSING`. Both are refusals and never repairs, and the rule is
evaluated only on a chained start, so a wholly independent block is unaffected.
Several roots that legitimately agree on one base stay permitted, and a root that
has not started yet carries no base and is not evidence either way.

### A chain refusal is a gate refusal

An unfit base ends the run through the **report**, exactly like a refused
workspace: `RUN_GATE_REFUSED` with the fitness code as its detail, the member
stays `PLANNED` — which is true, nothing was started for it — and the ledger is
byte-identical across the condition. It is not a claim about the member's outcome,
and it is not a durable-write problem.

No new ledger field, no new stop reason, no ledger schema bump. The chain is read
out of `frozenDependencies` plus `entry.baseCommit` plus `entry.resultCommit` plus
the anchor. Exactly one new task-state field, and no task-state version bump
either.

### What V2-09 is not

**Attended only. Sequential only.** No unattended mode, no stale-lease recovery,
no process containment, no parallel execution, no resume across invocations, no
outgoing transition from `READY_FOR_PR`, and no product-side PR/CI/merge concept.
V2-07P's platform contract is unchanged and not reopened.

The block produces a **stack**: `B`'s branch contains `A`'s commits, so a pull
request for `B` carries `A`'s work. That is what "dependent execution" means here,
and merging out of order is an operator decision this build does not model.

### What the controls cost, measured

Re-measured with `scripts/measure-verify.sh` — the script the baseline was
produced with, unchanged, on the same machine, from a clean tree — because a
comparison is only worth making if both sides were measured the same way.

```
                    baseline (pre-V2-09)      V2-09
npm run verify              289.4 s          238.0 s
  foundation-safe           261.7 s          214.7 s
  files / tests           79 / 2928        80 / 2994
```

**The slice added 66 tests and no wall-clock time, and that is a fact about
parallelism rather than a saving.** `foundation-safe` runs test files
concurrently, so its wall clock is bounded below by its slowest file — 212.0 s
for `v2-08-attended-block-runner.test.ts`, which V2-09 does not touch. The new
file's 103.9 s of work fits inside that critical path and never extends it.

**The total came in 51 s below the recorded baseline, and that is not attributed
to anything this slice did.** Nothing here removes work; the one change that
touches a hot path adds a subprocess rather than removing one, because
`commitObjectPresent` used to be refused at the argument gate without spawning
and now really runs `cat-file`. Two consecutive measurements today agree to
within 0.1 s, so the current figure is stable — the baseline was taken in an
earlier session and the difference is most likely machine state. Reported as
unexplained rather than banked.

Every control this slice added that costs more than 2 s, with the defect it
proves that a cheaper one cannot. Measured under full parallel load, which is
what the baseline was measured under and roughly twice what the file costs when
run alone:

| Control | s | Defect only this can prove |
| --- | --- | --- |
| E2E-1 the whole command, chained | 18.4 | lease + snapshot + relation + block base + ledger + workspace + scope authority, satisfied at the same instant |
| G-5 authority survives the block run | 18.0 | the guarantee holds after the invocation that made it |
| G-1 the chain lands | 16.8 | the worktree is really at the predecessor's commit |
| G-4 older-run result refused | 9.7 | ancestry of two real commit histories |
| G-3 unreferenced base refused | 8.8 | reachability is a Git fact, not a record fact |
| E2E-2 the predecessor blocks | 7.8 | the widening rule does not over-reach end to end |
| the widened start gate | 5.6 | a frozen-ineligible member really starts, and records no authority of its own |
| G-6 frozen base beats a moving branch | 3.1 | which commit `worktree add` used |

Six git-tier rows of the eight allowed, and exactly two end-to-end.

**The count was over budget first, and controls moved down a tier rather than
being deleted.** Measured alone the file had six tests over 2 s; measured under
load — the honest comparison, because that is how the baseline was taken — it had
thirteen, eleven of them git-tier against a limit of eight. Four moved:

- the default-branch specificity case now asks `proveSourcePreflight`, which is
  where the switch on the base actually lives, instead of creating a second
  workspace to observe a commit every V1-03 control already asserts;
- the two real-repository probe controls use a bare fixture root instead of a
  resolved repository, because a probe takes a `cwd` and a commit and has no use
  for a parsed profile;
- the two freeze-site refusals share one fixture, which is safe for exactly the
  reason under test: neither path writes anything;
- the standalone "no scope authority" assertion folded into the start-gate
  control, which was already paying for a repository and a start.

None was deleted and none lost an assertion.

### Carried forward from V2-09, deliberately

- **F-C1 — a ledger whose roots do not agree on one base cannot be chained onto
  (`CHAIN_ANCHOR_MISSING` / `CHAIN_ANCHOR_AMBIGUOUS`).** `blockBaseCommit` is an
  invocation input, and the anchor is what makes it *derivable* from the ledger
  afterwards — which needs one value, not merely one occurrence. A run whose roots
  were all forced-settled from an older run, or which holds roots pinned at two
  different bases, refuses rather than chaining onto a base the document cannot
  name. Accepted: an operator clears it by starting the block from its root, and
  the alternative is a durable answer nobody can reconstruct.
- **F-C2 — an unfit base ends the run rather than skipping the member.** A
  chain-fitness refusal is `RUN_GATE_REFUSED`, so independent members the run had
  not yet reached stay `PLANNED`. Accepted: it matches how every other start-gate
  refusal is graded, and continuing past a Git state nobody understands is the
  direction this repository does not take.
- **F-C3 — a chained member *can* be continued outside its block, and keeps the
  scope it was started under.** Its state is an ordinary `TaskState`, so any later
  caller may drive it; what travels with it is `scopeAuthorityCommit`, so the
  profile at the block base still governs however long afterwards that happens and
  whatever the roadmap has since been edited to say. Not a residue but the property
  the durable control exists to prove — recorded here because the *execution* base
  is still the predecessor's commit, so such a continuation extends a stack whose
  first half was never separately reviewed.
- **F-C4 — the block produces a stack.** `B`'s branch contains `A`'s commits, so a
  pull request for `B` carries `A`'s work. The report says so; merging out of order
  is an operator decision this build does not model.
- **F-C5 — an orphaned workspace of a *chained* start is not releasable.**
  `agent-loop release` names a task rather than a run, so it has no frozen block
  base to consult and no durable state to read one from — an orphan has no task
  state by definition. It therefore assesses against the default-branch tip, which
  is what it always did, and a chained orphan sitting at its predecessor's result
  is refused as `WORKSPACE_HEAD_MOVED`. Accepted rather than repaired: the fix is
  either a second authority for the release path to consult or a release command
  that takes a base on trust, and neither is worth a durable claim nobody can check.
- **F-C6 — the published JSON schema now requires `scopeAuthorityCommit`.** It is
  generated with `io: 'output'` and so describes a state *after* parsing, where the
  default has been applied. A pre-V2-09 state file still parses through
  `parseTaskState` — that is what the additive default is for and it is controlled
  — but an external validator holding the new schema would reject the old file.
  Accepted: each build's published schema describes its own output, and the
  alternative is a second spelling of "no authority recorded" in the type.

## The operator notification (V2-10)

An attended block run can take an hour. The operator is present in the sense the
lease and the auth preflight mean — they started it, they are answerable for it —
and absent in the sense that matters here: they are not watching the console. So
when the orchestrator stops working usefully on its own, something has to say so.

```text
AttendedBlockResult
        |
        v
attentionForBlockRun(result)        ATTENTION | SILENT
        |
        v
NotificationTransport
        |
        +-- ntfy
```

### It observes; it never decides

The notifier runs after the run is over, on the result the run already produced.
It is called from one place — `block-command.ts`, after the `finally` that gives
the execution lease back — and it changes nothing: not the stop reason, not a
task disposition, not the ledger, not the process exit code. A failed push is
printed and nothing else. `notifyBlockRun` is total, so a transport that throws
cannot reach the command's own `catch` and relabel a finished run as an internal
failure.

Two of the endings it reports (`DURABLE_WRITE_FAILED`, `LEASE_AUTHORITY_UNCERTAIN`)
exist precisely because the ledger may *not* be made to carry them. The payload is
therefore built from the runner's result rather than from a re-read of the
ledger — a notification path that needed a durable write first would be
unavailable in exactly the cases it exists for.

### Opt-in is the absence of a file

```text
<OS user profile>\.agent-orchestrator\notify.yaml

endpoint: https://ntfy.sh/
topic: <your topic>
token: <optional access token>
```

No file: notifications are off, no transport is constructed, and no socket is
opened. A file that cannot be used is also off — reported immediately, by a
closed code, and the run still proceeds: a notifier with authority over whether
work happens is the one thing this may not be.

The endpoint, the topic and the token come from that file and nowhere else. Not
from the repository profile, not from repository content, not from a CLI option,
not from the environment. The root it sits under is derived from `os.userInfo()`
and cannot be relocated by anything a caller, a parent process or a repository
file can set, so a target repository cannot place this file whatever it contains.
The state is decided **before** the run, above the lease line, because an
operator who is about to walk away has to learn now that nothing will reach them.

### Bounded egress

`https://` to a host the operator chose; plain `http://` only to the literal
loopback addresses `127.0.0.1` and `::1` — not `localhost`, which is a name
answered by DNS or a hosts file, neither of which this process owns. Every other
scheme is refused, as is a URL carrying credentials, a query or a fragment. One
attempt, a timeout, `redirect: 'error'` so an allowed endpoint cannot forward the
request out of the validated boundary, and no retry.

The payload is a JSON document, and the title, priority and tags go in it rather
than in ntfy's header form. A header value is a line in a request, and no value
derived from a run belongs in one. The single dynamic header is `Authorization`,
carrying the operator's own configured token, which the configuration contract has
already refused if it is not header-safe.

What goes on the wire: the repository's *declared id* — never its root — the
block and run ids, the ending, the step count, the task ids with their
dispositions, and one static sentence saying what to do. No prompt, no agent
output, no verifier output, no exception text, no path: none of those is
representable in an `AttendedBlockResult`.

### `detail` is gated at the boundary, and the gate claims only what it proves

`AttendedBlockResult.detail` is documented as an allow-listed code from a closed
vocabulary. That is not quite true: `block-store.ts` builds
`LEDGER_CONTRACT_VIOLATION:<message>` out of a Zod issue, so one producer's text
is authored by a dependency's formatter. Every value that reaches the field today
*is* code-shaped, by a chain of upstream validations — and a chain of upstream
validations is not a claim worth exporting over a network on somebody else's
behalf.

So the shape is checked where the exporting happens. A value matching
`^[A-Z][A-Z0-9_]*(:[A-Z][A-Z0-9_,]*)?$` is sent; anything else becomes
`DETAIL_WITHHELD`. Stated narrowly, because the narrow statement is the true one:
this does **not** prove that `detail` is a globally closed vocabulary. It proves
that unbounded free text does not leave the machine.

### Which endings notify

`COMPLETE` is silent — it is the intended end. `OPERATOR_STOPPED` is silent too:
it is the one ending a human caused, and telling them about their own
intervention is noise. The other eleven notify.

The decision is **not** derived from the exit code. "The shell should say
something went wrong" and "this person's phone should buzz" are two questions:
`OPERATOR_STOPPED` exits 4 and is silent. Two total tables answer them
separately, and one cross-invariant ties them without coupling them — every
ending the exit table grades `EXIT_RUN_OK` must be silent here.

Completeness is the compiler's (`satisfies Record<…>`). Correctness is the
suite's, and it takes two forms, because the operator-facing sentence is where a
swap would otherwise survive: each sentence must carry a token of its own, and
**no other sentence may carry it** — checked over every pair, so a permutation of
any size fails. Exchanging `TASK_BLOCKED`'s advice with `NO_ELIGIBLE_TASK`'s
leaves both dispositions correct and both operators looking for the wrong thing;
that mutant dies here.

### "No egress without opt-in", measured against the shipped artefact

`test:dist-notify-egress` runs `dist/cli/index.js` twice as a real process, with
a self-verifying preload that points the OS profile at a scratch directory and
arms every socket surface — `fetch`, `net`, `http`, `https`, `dns`.

Without a configuration the run must complete having opened nothing. That control
is not vacuous, and the measurement is on the record: with the opt-in check
removed, the unconfigured run reaches `fetch` and the gate dies with exit 96.
With a configuration pointing at a loopback server, exactly one POST arrives, its
bytes are read, and the payload is checked to name the same ending the console
printed.

What the gate deliberately does **not** claim: it does not kill the `detail`
form-gate mutant. Neither ending reachable there carries free text, so removing
the gate changes nothing in those bytes. That mutant is killed in
`tests/v2-10-operator-notification.test.ts`, on the pair it exists for.

### What V2-10 is not

No notification for `run --attended`, no "completed successfully" push, no
retries, no second channel, and no product-side PR/CI/merge concept. The
orchestrator still hands a finished task to a human and stops.

### Carried forward from V2-10, deliberately

- **F-D1 — an exception is not notified.** A throw hours into a run reaches the
  command's `catch` and produces no `AttendedBlockResult`, so there is nothing to
  observe. Building a payload out of the exception would be reconstructing an
  ending rather than reporting one, which is the rule the whole slice is organised
  around. Accepted and stated: an internal failure is silent to an absent
  operator.
- **F-D2 — a failed push is indistinguishable from a quiet run.** The console says
  `NOT DELIVERED (<code>)`, and an operator who has walked away sees neither that
  nor the notification. There is no second channel and no retry, because both
  would be the notifier deciding things on its own.
- **F-D3 — the `detail` form gate is not a proof of closed vocabulary.** It bounds
  the shape of what leaves the machine. Whether `detail` is genuinely closed is a
  property of its producers, and `block-store.ts` still builds one value out of a
  Zod message.
- **F-D4 — a refusal above `runAttendedBlock` never notifies.** A lease refusal, an
  unusable input, an unresolvable block base: all of them happen in the first
  seconds, while the operator is still there, and none of them produces a result to
  observe. Deliberate, and the boundary is pinned by test.

## The first dogfood, and what it proved (DOGFOOD-REM-001)

The first time this orchestrator was pointed at a real task, it reported a
delivered task and delivered nothing. Every test was green while it happened.
That run is the most useful thing this repository has produced, and this section
is what it cost.

### The two defects, and how each hid

**The writer had no authority to write.** `CLAUDE_WRITER_ARGS` carried
`--print --output-format json` and nothing else, so no permission mode was set —
and with no mode, every write is denied. The run looked exactly like a healthy
one: the seam reported `RAN` with exit 0, the envelope said `subtype: "success"`
and `is_error: false`, and the only trace of the truth was a field nothing read,
`permission_denials: [Write, Bash]`.

It hid because **no test pinned the vector**. `tests/claude-writer.test.ts`
asserts that whatever the constant holds is passed through to the seam, which is
equally true of an empty vector. Pass-through is not authority — and every
control in the suite substitutes the agent seam, that is, replaces the layer
*above* the argument vector, so nothing here could observe what the real CLI was
given. That gap is now closed by `npm run verify:writer-authority`, which drives
the real CLI through the shipped adapter and asserts on measured filesystem and
git state rather than on the agent's prose.

**A run with no effect could settle as complete.** `READY_FOR_PR` required a
clean worktree and a known HEAD, and a task that never changed anything has
both. The reviewer had nothing to object to, because it was asked only about
defects *introduced by* the task — a task that did nothing introduces nothing —
and because it was told the task's **id** and no more: `buildReviewPayload` took
a string, and both producers passed `taskId`.

### The authority split, measured

The writer edits; the orchestrator commits. Not a convention — the writer holds
`Read Edit Write Glob Grep` and no shell, so it cannot commit. Measured through
the production adapter against throwaway repositories:

| configuration | in-worktree edit | commit | tree | escape to sibling | tamper main checkout |
| --- | --- | --- | --- | --- | --- |
| the pre-fix vector (`--print --output-format json`) | **denied** | no | clean at base | — | — |
| `+ --permission-mode acceptEdits` | yes | denied | dirty | blocked | blocked (even read) |
| `+ --tools Read Edit Write Glob Grep` (shipped) | yes | **no shell tool exists** | dirty | blocked | blocked |
| settings file, `allow: ["Write","Edit"]` | yes | yes | clean | **ESCAPED** | **TAMPERED** |
| settings file, `allow: ["Write(**)","Edit(**)"]` | yes | yes | clean | blocked | blocked |

The fourth row is why authorisation is expressed as a flag rather than a settings
file: an unqualified `Write` allow-rule grants unbounded write authority, and the
containment-restoring spelling differs from it by two characters.

Two flags were refused for measured reasons. `--bare` would be hermetic and would
break authentication — the installed binary's own help states its auth is
strictly `ANTHROPIC_API_KEY` or `apiKeyHelper`, with OAuth and the keychain never
read, and this product runs on the subscription login. `--safe-mode` was refused
as the hermeticity mechanism because its documented and measured behaviour
disagree: it suppressed user-scope configuration while the *project* `CLAUDE.md`
still took effect.

`--strict-mcp-config` is load-bearing and non-obvious: `--tools` does **not**
bound MCP authority. Without it the writer held the operator's own MCP tools and
attempted one.

### Hermeticity has a cost, and it is paid deliberately

`--setting-sources ''` suppresses the target repository's own `CLAUDE.md` along
with user-scope configuration. That is the point — the operator's machine must
not decide the writer's behaviour — but those conventions are often genuinely
useful. Where a repository wants them, the `CLAUDE.md` **path** travels in the
payload's context-sources section and the writer opens it itself. Paths only,
never contents; the channel is explicit and orchestrator-controlled instead of
ambient.

### What the orchestrator's commit proves, and what it does not

Two controls, and neither covers the other:

- **Control one — path authority.** The committed path set equals the set the
  scope gate approved, compared as sets from the same base pin. This covers
  path-adding injection by *any* mechanism, including ones nobody has
  enumerated. It proves nothing about the approved files' **bytes**, and nothing
  about whether code ran.
- **Control two — no configured content filter runs.** Before anything is
  staged, Git is asked twice: which drivers the effective configuration defines
  (`config --list --show-scope --name-only -z`, so the configured command never
  enters this process at all) and which of them apply to the paths being staged
  (`check-attr filter -z`). The predicate is the **conjunction**, and widening it
  to either half is measurably wrong: this machine's system *and* global scopes
  both define `filter.lfs.*`, so "any driver configured" refuses every commit in
  every repository, while a `.gitattributes` naming a driver the configuration
  never defines makes Git run nothing at all.

The neutralisation of hooks and signing is **defence in depth, not the primary
control**. Measured on git 2.55.0.windows.3: all four commit hooks fire on this
path; `--no-verify` does not suppress them (`prepare-commit-msg` and
`post-commit` still ran); `-c core.hooksPath=` does, is unconditionally
shell-inert, and cannot be planted — a *relative* value stops suppressing the
moment the writer creates that directory, which was measured by planting one.

**Accepted consequences, stated rather than discovered:** a repository whose
`pre-commit` formats or generates will see commits that skipped it; and the
orchestrator will not commit a path whose assigned filter driver has an
executable clean or process command configured in the effective Git
configuration — LFS-tracked files included. It parks, and an operator commits.

### The identity on the commit, and why the leak control is load-bearing

Author and committer are `AgentOrchestrator <agent-orchestrator@local.invalid>`,
supplied per invocation with `-c` and never written into any git-config at any
scope. `.invalid` is reserved by RFC 2606, so it asserts no real address.

The design predicted that the execution seam — which forwards `PATH` and
`PATHEXT` and nothing else — would leave Git unable to see any ambient identity.
**That prediction was wrong, and it was measured wrong**: `git config
--show-origin --get user.email` answered out of the operator's global
`~/.gitconfig`, and a commit made without `-c` was authored by whoever is logged
in. The mechanism stands; the counter-control that a foreign identity must not
reach the object is what actually holds the line.

### Two layers of the settlement rule, and why the schema did not change

- `READY_FOR_PR` additionally requires the **observed** HEAD to differ from the
  record's base pin. Observed-vs-pin, never record-vs-record: comparing two
  fields of one record would have it agree with itself and would relocate the
  race rather than close it.
- A chained member may not be built on a predecessor whose result commit is the
  commit it started on (`PREDECESSOR_DELIVERED_NOTHING`). This is not redundant
  with the first: task-state files survive every later run, and
  `applyForcedProgress` copies a stale `READY_FOR_PR` record's commits straight
  into a new ledger, so the first dogfood's own records can re-enter a chain.

No durable schema change was needed for either, and none was made.

### The rerun gate

Carried here verbatim from the plan, so the session that runs the second dogfood
does not have to reconstruct it. The second CargoCheck dogfood counts only when
all of these are true:

1. The measured vector is in production, pinned by a test, and
   `npm run verify:writer-authority` passes **both** stages: the writer edits
   inside the worktree and **cannot** commit (no shell, no MCP, escape blocked,
   tree left dirty), then the orchestrator's path measures the delta, enforces
   scope, commits, and leaves HEAD moved and the tree clean.
2. Authority is hermetic — `--setting-sources ""` and `--strict-mcp-config` — so
   the run proves something about the product and not about one laptop.
3. A writer pass with no measured effect cannot be a success, and
   `permission_denials` is reported **in the rendered operator output of a run
   that continued past the writer step** — distinct tool names and count, on
   failing and succeeding passes alike, accumulated across rounds — without
   being a verdict.
4. The commit is bounded on all of its controls: the committed path set equals
   the approved set against a hook that tries to inject; a target repository
   with a configured executable driver is refused *before* staging, with the
   driver provably never run; signing is demanded and neutralised; and the
   divergence case parks without an undo. The path-set check is not claimed to
   be more than it is.
5. `READY_FOR_PR` refuses an empty delta against freshly observed evidence, with
   the negative and positive controls green and the record-vs-record mutant red.
6. A tautological predecessor is refused by name, and the legal chain still
   starts.
7. The reviewer receives body, truncation flag and round, proven by the
   differential payload control; absence parks rather than degrading.
8. The remediation hand-off survives the budget boundary, with the
   byte-identical no-boundary variant green.
9. The no-effect controls are inverted rather than deleted, and the deliberate
   scope-violation and lease-loss cases stay green.
10. **G5 residual closed.** The dogfood's literal CLI refusal strings match the
    measured pre-fix corpus in both observed refusal families. The apparent
    in-worktree path refusal is the same permission-denial mechanism expressed
    in path language, proven within one dogfood session: for the same worktree
    and the same target path, one command form reported that approval was
    required while another emitted the "blocked … allowed working directories"
    refusal; reads of that directory succeeded, `Get-Location` matched the
    allowed worktree exactly, and the directory was not a junction. No
    independent path/sandbox mechanism remains evidenced.
11. `npm run verify` passes on a clean machine, and the opt-in gate has been run
    at least once.
12. The rerun-preparation question is answered in writing — **it is**, as
    register entry D-REM-001-7: there is no canonical path to make a used task
    id runnable again, so the second dogfood runs on **fresh task ids** and the
    first dogfood's records stay untouched as evidence. The missing operation is
    recorded as a finding rather than improvised around.

Then the run can deliver what the first could not:

```text
real Claude writer actually edits
        ↓
AO commits → A produces A1, A1 != blockBase
        ↓
A SETTLED
        ↓
B.basePinnedCommit == A1
        ↓
B sees A's actual code
        ↓
both tasks complete, or stop truthfully for a genuine product reason
```

### Residuals, carried rather than closed

- The settlement rule is a **SHA-inequality** test, which is strictly weaker than
  a non-empty-diff test. `observeTaskDelta` is the primitive that would close it.
  It is not needed today because the orchestrator commits without
  `--allow-empty`, so no result commit exists without staged changes.
- The reviewer's payload interpolates repository-authored task prose into an
  instruction stream, so a hostile task file can try to instruct a PASS.
  Identical in kind to a risk already accepted for the writer's payload, and
  bounded on the way back: a PASS carrying findings is `UNRECOGNISED`.
- The path/sandbox anomaly the dogfood also reported was closed as the same
  defect. Three candidate mechanisms were probed and all three falsified — writes
  succeed in a plain clone, in a linked worktree whose `.git` is a file pointing
  outside its own directory, and through an NTFS junction. The positive
  explanation is that the CLI emits a working-directory refusal for a
  write-class operation whose true cause is an unmatched permission rule:
  `mkdir`, `touch`, `new-item` and an output redirection, all onto paths under
  the declared worktree, were refused with "was blocked. For security, Claude
  Code may only … in the allowed working directories for this session:
  '<that same worktree>'".

  The evidence for that is an **emitter** string, and the distinction is the
  point — see **D-REM-001-8**. The phrases originally quoted here as the CLI's
  narration ("outside my allowed folder", "This path is outside the working
  folder") are not CLI output at all; they are the probe agents' own
  descriptions of a denial, and the word "outside" does not occur anywhere in
  the dogfood writer transcripts.

## The closing audit (attended release gate)

Before AgentOrchestrator was used on any project other than its own, one closing
audit was run against `main` at 877ffdc, on 2026-08-16, with the second
dogfood's `DOGFOOD_PASS` as the evidence base and no new feature scope. It asked
a single question — *is there a known or newly-findable defect that makes this
build unsafe or unreliable for **attended** production use on real projects?* —
and required every item to land in exactly one of three classes.

The canonical gate was run first, so the audit rests on a measured-green `main`
rather than on an assumption: 82 test files, **3087 passed, 2 skipped, exit 0**
(236 s parallel, plus the serial tree-kill gate). Then the attended path was read
end to end at the source — `cli/block-command.ts` → `block/block-runner.ts` →
`run/start-task.ts` → `block/block-progress.ts` → `notify/*`, with the lease,
scope, chain-fitness and commit surfaces underneath it — and where reading
produced a claim about behaviour, the claim was measured rather than predicted.
Fifteen items were examined: the eight carried-forward residuals named for the
audit, and seven conditions found by reading the attended path itself.

**The end state:**

```text
Closing Audit: PASS for attended real-world use.
No ATTENDED_RELEASE_BLOCKER found.
Unattended operation remains unsupported until U1–U4 are resolved.
```

**The classification, recorded unchanged:**

```text
ATTENDED_RELEASE_BLOCKER
→ none

UNATTENDED_BLOCKER
→ U1–U4

ACCEPTED_LIMIT / FOLLOWUP
→ including A1–A6
```

This section records that outcome and the items the audit found. It reclassifies
nothing else: the `F-` and `DOGFOOD-` items the audit examined keep the
dispositions their own registers already give them, and **no finding here was
remediated** — the audit changed no file in the repository.

### The four unattended blockers, which are not follow-ups (U1–U4)

They are all one shape: **the run's ending, and the machine's state after it,
depend on a human being there.** That is precisely what `--attended` asserts,
which is why none of them blocks the attended release; and each one is fatal to
unsupervised automation, so they are recorded here as **blockers for unattended
use** and are not to be read as follow-ups.

- **U1 — an interrupted run leaves the lease, and no product command removes
  it.** Measured, not reasoned: a real holder process took a real lease over a
  scratch repository and was terminated the way a console interrupt terminates
  it.

  ```text
  while holder alive : HELD / owner pid 22092
  holder ending      : {"code":null,"signal":"SIGINT"}
  holder stdout      : "HELD"        <- the release in `finally` never printed
  lease file exists  : true
  after interrupt    : HELD / liveness NOT_FOUND
  recovery verdict   : STALE_OWNER_GONE
  next acquire       : STALE_LEASE_RECOVERY_UNSAFE
  ```

  `block-runner.ts` installs no signal handling (F-B3), so a console interrupt —
  the ordinary way an operator stops a run — terminates the process without
  unwinding, and the `finally` that returns the lease never runs. The next
  invocation is refused `STALE_LEASE_RECOVERY_UNSAFE`. Since V3 slice 5 a lease
  left this way is recoverable with `agent-loop lease recover` **when its writer
  launches are all proved contained** — the common case for a run interrupted
  between spawns, and not the case for one interrupted mid-writer, where the open
  generation is exactly what refuses. The transcript above predates that command.

  **Attended:** loud, fail-closed and correct — the refusal
  sentence says exactly this, and `lease status` prints the path, so an operator
  who is present pays one manual step. **Unattended:** a single crash makes the
  repository permanently unrunnable, which no scheduler recovers from.
- **U2 (F-D2) — a failed notification is indistinguishable from a silent run.**
  One bounded attempt, ten seconds, no retry and no second channel. A dropped
  push prints `NOT DELIVERED (<code>)` to a console nobody is reading, and since
  `COMPLETE` is also silent, a quiet phone carries no information at all.
  **Attended:** acceptable, because the console holds the truth and the operator
  returns to it — they started the run and are answerable for it.
  **Unattended:** the notifier would be the only signal, and a best-effort
  channel with no acknowledgement cannot be one.
- **U3 (F-D1, F-D4) — an exception, and every refusal above the runner, notify
  nobody.** A throw leaves `outcome` null, so there is no result to observe and
  nothing is sent; a lease refusal, an unusable input or an unresolvable block
  base all happen before a result exists. Both are correct as designed — building
  a payload out of an exception would be reconstructing an ending rather than
  reporting one — and neither loses work: the `finally` still returns the lease
  on a throw, task states stay durable, and the above-runner refusals happen in
  the first seconds while the operator is still standing there. **Unattended:**
  together with U2 this means the absence of a message proves nothing, which is
  the property unsupervised running would have to rest on.
- **U4 (F-B5, D-REM-001-7) — nothing continues an interrupted run, and no task id
  is ever freed.** The run id is spent (`startBlockRun` refuses it), the
  interrupted task may be left `ACTIVE` in the ledger, and `release` refuses any
  task that has a durable state — `assessWorkspaceAdoption` requires the positive
  absence of one, so it accepts pristine orphans and nothing else, confirmed at
  `worktree/adopt-workspace.ts:242`. **Attended:** the record still says what
  happened and which task was in flight; a human resumes the task itself or
  starts a new run id. **Unattended:** there is no retry an automation could
  perform.

### Found by the closing audit, carried rather than closed (A1–A6)

All six are `ACCEPTED_LIMIT` / `FOLLOWUP`. None of them is an
`ATTENDED_RELEASE_BLOCKER`, and none of them changes the classification of
anything already in the registers above.

- **A1 — `COMPLETE` is silent, and a completed block is when a human must act.**
  Correctly classified — the emitter prints `SILENT - this ending does not need
  an operator` (`cli/render-block-run.ts:174`) — and consistent with V2-10's
  stated scope of no success push. Worth stating as an operational consequence
  rather than as a defect: a block that finishes at `READY_FOR_PR` has left pull
  requests for a human to open, and an operator who walked away learns that only
  by coming back. The notifier reports faults, not readiness.
- **A2 — finished work has no product-side cleanup.** The consequence of U4 in
  ordinary use rather than after a crash: every completed task leaves a worktree
  and a branch that `release` will not take (it has durable state), and its id can
  never be made runnable again. On a real project this accumulates **one
  worktree, one branch and one spent id per task**. All of it is honest and
  inspectable; none of it is automatic. Cleaning it up is **product ergonomics
  and operations, not a correctness blocker for attended operation** — an
  operator can see and remove all three by hand.
- **A3 — a proved chain base is not compared against the base the member already
  has.** `driveOneTask` proves a chained member's base through `proveChainBase`,
  then calls `startPlannedTask`, which answers `ALREADY_STARTED` for a task that
  already has a durable state — graded `DRIVE` (`block-conclusion.ts:250`). On
  that path the proved commit is discarded and the existing workspace pin is
  used, with nothing comparing the two: a **possibly missing equality check**.

  **No harmful case was reached.** A dependent member cannot be started
  standalone (`BLOCKED_BY_DEPENDENCIES` → `TASK_INELIGIBLE`), a re-run of the
  same block re-derives the same base, and a moved default branch is caught by
  `CHAIN_ANCHOR_MISSING`; the ledger also records the truth, because
  `block-evidence.ts:199` proves the entry's `baseCommit` against the record's own
  pin. So the property holds today by three separate arguments — and **none of
  the three is measured**: the suite pins only that `ALREADY_STARTED` grades
  `DRIVE`. That is why this is a **follow-up and not an attended blocker**: the
  harmful case is unreachable today, but the safety rests on argument rather than
  on a control. One equality check would make it structural.
- **A4 — how to stop a run is documented only inside a refusal.** The consequence
  measured in U1 is stated accurately in two places an operator reaches only
  *after* they have hit it: the `STALE_LEASE_RECOVERY_UNSAFE` sentence and the
  `lease-recovery.ts` module header. The README has no "stopping a run" section,
  so the first interrupt of the first real project is where this gets learned. A
  **documentation gap**, not a runtime defect.
- **A5 — an orphaned agent process survives its orchestrator.** Already the stated
  reason a stale lease is never taken over automatically, and the liveness
  sentence says so: a dead owner does not prove that no agent survived it. What
  follows from U1 is that the operator clearing the lease by hand is the one
  making that judgement, with no instrument offered for it. Correct as designed —
  this is precisely why unattended running needs owned process containment first
  — and an **operations gap** worth one sentence of operator guidance.
- **A6 — README's historical "verbatim" wording.** Documentation precision,
  carried in as named. No behaviour depends on it.

### What the audit checked and found sound

Recorded because an audit that lists only findings does not say where it looked.

- **Scope authority is durable, not invocation-scoped.** `assessTaskScope` reads
  `scopeAuthorityCommit` off the persisted state and falls back to the base pin in
  exactly one place; `readPinnedScope` takes the declaration out of the commit
  with `--no-replace-objects`. A predecessor hands its successor code and never
  permission, and the answer outlives the block run that made it.
- **The verification policy cannot be rewritten by a writer.** It comes from
  `repository.verification` — one reading of the source checkout taken at
  invocation start and carried by value — not from the worktree the writing agent
  can edit.
- **The lease is re-proved at every effect, not once.** Every loop iteration,
  between driver continuations, before workspace creation, before the first
  durable write, and again immediately before a release deletes anything.
- **Endings that cannot be written are not written.** The four unrecorded
  outcomes leave the ledger at its last provably durable state instead of
  asserting a stop the run had no authority to make.
- **The commit path proves what it committed.** Control two refuses before
  staging when Git would run a program for a path in the commit; control one
  compares the object's own path set against the approved one afterwards, and a
  refusal keeps the commit as evidence rather than undoing it.
- **Nothing in `src/` can write outside the runtime root and the task worktree,**
  and the runtime directory is proven ignorable before the first durable write.

Two things were **not** done, and are stated rather than implied: no adversarial
escalation attempt was made against a live predecessor profile (DOGFOOD-L1 stands
as carried), and no third dogfood was run. The notification wording quoted above
is taken from the emitter, `cli/render-block-run.ts:174`, rather than from any
paraphrase of it — per the rule D-REM-001-8 established.

### The status this establishes

**AgentOrchestrator is released for supervised use on real projects.** The four
`UNATTENDED_BLOCKER` items are all the one shape named above, and that bound is
what the build already claims; nothing found argues for another round of
hardening before first use.

Two things are worth doing that are **not** release gates, and deliberately not
done here: give the README a short section on stopping a run, naming the lease
file and the surviving-agent judgement (A4, A5), and add the base equality check
that would make A3 structural. A3 is a very small hardening fix — an equality
check is cheap and makes the chain authority structural — and it belongs *after*
the first regular use, not before it. Taking either one now would move the
finish line again after a passed dogfood and a passed closing audit.

## The Windows launch boundary (V3 slice 1)

**Delivered as an isolated component.** This is slice 1 of the sequence the ADR
([`docs/decisions/2026-08-19-adr-windows-launch-boundary.md`](docs/decisions/2026-08-19-adr-windows-launch-boundary.md))
sliced: the boundary and its contract, built and verified without touching a
single runner. It stayed unused through slice 2 as well, deliberately.

**Slice 3 has since made it productive** — every Windows command now runs behind
it; see "The productive Windows runner (V3 slice 3)" below. What this section
describes is the component and its guarantees, which are unchanged by that.

| Part | Where |
| --- | --- |
| The boundary itself | `native/ao-launch/AoLaunch.cs` → `dist/native/ao-launch.exe` |
| Its build | `scripts/build-native-boundary.mjs` (`npm run build:boundary`) |
| The contract: request, status, endings | `src/boundary/launch-boundary.ts` |
| Starting one owned process | `src/boundary/start-owned-process.ts` |
| The contract's in-process checks | `tests/boundary-contract.test.ts` |
| The real-process gate | `tests/dist-artifact/launch-boundary-dist-artifact.mjs` |

### What the boundary guarantees

It creates a strict Job Object (`KILL_ON_JOB_CLOSE`, neither breakaway flag),
arms its coupling to the AO process that asked for the launch, creates the
target **inside** the job, confirms membership before the target executes,
forwards stdio, and keeps the only — non-inheritable — job handle. Cancellation
is helper death: the kernel takes the tree when the last handle to the job
closes. There is no `taskkill`, no descendant walk, and no list of pids anyone
has to keep correct.

"Before the target executes" means the default `JOBLIST` placement has the
kernel put the process in the job *at creation* — there is no instant at which a
created process is not yet owned — while `SUSPENDED` creates it suspended and
checks before the resume. Both were measured; the default is the one with no
window, and `native/README.md` states what the other one's window is.

It owns **nothing else**. Byte budgets, timeouts, the stdin delivery
vocabulary, result classification, lease and scope authority and task state all
stay in TypeScript, exactly as the ADR splits them.

It also bounds **process lifetime only**, against a cooperative or crashing
tree — not against a hostile one running under the same Windows account. What
that excludes is written down in `native/README.md` ("What it does not defend
against") rather than left for a later slice to assume away.

### `BOUNDARY_LOST` is modelled here, before any runner consumes it

`classifyBoundaryEnding` reports one of four endings — `CHILD_EXITED`,
`TERMINATED_BY_CALLER`, `BOUNDARY_LOST`, `BOUNDARY_REFUSED` — and the
load-bearing rule is that an *unknown* outcome is never a completion. A missing
or unreadable status, a `boundary=OK` that carries no membership evidence, a
status belonging to another launch, an exit the helper could not prove, and a
helper that vanished without reporting a child exit are all endings of their
own. That is the defect the spike found: when the helper was killed, the tree
died correctly and the run still looked exactly like a finished one.
`TERMINATED_BY_CALLER` exists so that a cancellation the caller asked for
cannot be mistaken for a boundary that was lost.

Two details keep those endings honest, and both came out of the slice's
adversarial review:

- **a status has to belong to its launch.** Every request carries a nonce the
  helper echoes back, and the reader also requires the status to name the
  helper it started. The first read of a launch happens before the helper has
  written anything, so without that check a status left in a reused working
  directory would be accepted as this run's evidence — complete with another
  run's child pid;
- **a refusal says whether anything ran.** `BOUNDARY_REFUSED` always means
  ownership was not established and whatever was created has been terminated;
  it does not always mean nothing executed, because in `JOBLIST` mode the
  target runs from its first instruction. The ending therefore carries
  `targetStarted` — `NO`, `YES` or `UNKNOWN` — and `UNKNOWN`, meaning no
  readable status, is to be treated as `YES`.

### Fail closed, with no bypass to find

Every path that cannot establish or keep verified ownership refuses, and leaves
nothing it created alive. It does **not** promise that the target never ran —
in `JOBLIST` mode the target executes from its first instruction — which is
what `targetStarted` on the refusal is for, and why `UNKNOWN` there has to be
read as `YES`. The helper refuses an **unknown request key**
rather than ignoring it, which is what keeps the two switches that weaken
containment — an inheritable job handle, and passing no handle list — out of
the shipped binary: they exist only under the `AO_BOUNDARY_TEST_CONTROLS`
define, which the shipped build never sets. The gate asserts that too, by
sending the shipped helper each of those keys and requiring a refusal with
nothing started.

### How the guarantee is measured

`test:dist-boundary` runs sixteen cases against the built artefacts with real
processes: ownership established and verified; the caller's own termination;
**helper death → `BOUNDARY_LOST` with zero survivors**; **AO death → helper and
tree gone, with no cleanup code running, and what it leaves behind unreadable
as a completion**; processes the child orphaned confirmed as job members **by
pid** and killed with the job; exit-code fidelity; three real fail-closed
refusals with a marker file proving nothing ran; the weakening-key refusals,
with a positive control that the same request minus the key is accepted and
runs; verify-before-execute; both placement modes; the argument vector, working
directory and replaced environment arriving exactly; a reused working directory
being unable to lend its evidence to the next launch; and **an owner that is not
the parent** — the only case that reaches the helper's own owner watch, because
every other launch here is owned by the process that spawned it.

The argument-vector cases are **differential**: the same arguments — quotes,
backslashes, a trailing backslash before a quote, Unicode, an empty argument,
shell metacharacters — go through the boundary and through
`child_process.spawn`, and the target reports what arrived. Two more cover the
verbatim `cmd.exe /d /s /c` route a `.cmd` shim is started through, which is how
AO starts the Claude CLI — including the one construction where the boundary
deliberately differs from Node. In verbatim mode libuv passes `argv[0]`
unquoted, so a target whose path contains a space is split by the child's own C
runtime; the boundary quotes it, and a case with a compiled target under a
spaced path holds that behaviour in place. The boundary builds
its own Win32 command line, so without that case its quoting would be asserted
only by a comment citing a program this repository does not contain.

Survivors are counted by **heartbeat** — every fixture process rewrites its own
file ten times a second, and "alive" means the number kept growing — because
the spike measured that a process walk counts a terminated process whose object
is still referenced as alive. The instrument is only worth anything if it can
see a survivor, so the negative control builds a deliberately weakened helper
and kills it, as a **pair** of runs: with only the job handle inheritable it
requires **0** survivors, because the handle list holds on its own; with the
handle list also gone it requires all **7** — the whole fixture tree. That pair
establishes "two independent lines of defence, and it takes both being wrong"
inside this repository rather than by citation, and without it every "0
survivors" above could be an instrument that cannot see anything.

One measured fact runs through two of those cases: **node puts every child it
spawns into a kill-on-close job of its own.** It explains what the AO-death case
deliberately does not assert — when AO dies the helper is killed by that job,
usually before its own owner watch can record anything, so containment holds
twice over there and the owner watch is what covers an owner that is *not* the
parent.

It also invalidated an earlier version of the orphan case, which is worth
stating because a green test hid it. That case launched a tree of Node
processes, let the root exit, and asserted the job then had six members. A Node
root takes its whole subtree with it, so nothing was ever orphaned; the six
members were the descendants' `conhost.exe` processes, and resolving the job's
member pids against a process snapshot showed that not one of them was a
fixture process. The case now uses a root that is *not* a Node process — three
lines of C# compiled for it — so the children it leaves behind are genuinely
orphaned, and it asserts membership **by pid** rather than by a count that
cannot tell a descendant from a conhost.

## The owned-command adapter (V3 slice 2)

**Also isolated, and reachable from nothing.** Slice 2 is the TypeScript half
the ADR keeps *above* the boundary: byte budgets, a wall-clock timeout,
cancellation, the stdin delivery vocabulary, and the translation of a boundary
ending into a result a runner could consume. The boundary owns none of that, and
still does not.

`runCommand`, the Claude writer and the verification runner were unchanged by
*this* slice, and the reachability pin in `tests/v2-07l-execution-lease.test.ts`
stated that as an assertion rather than an intention: the adapter was the only
module importing `start-owned-process`, and nothing imported the adapter —
type-only imports included, which is why those pins count erased imports too.

Slice 3 created that reachability and the pin duly failed, which is what it was
for. It was replaced rather than deleted: see slice 3 below for the structural
statement that took its place.

| Part | Where |
| --- | --- |
| The adapter | `src/boundary/owned-command.ts` |
| Its in-process contract | `tests/v3-02-owned-command.test.ts` |
| The real-process gate | `tests/dist-artifact/owned-command-dist-artifact.mjs` (`npm run test:dist-owned-command`, in `verify`) |
| Its target program | `tests/dist-artifact/fixtures/owned-command-fixture.mjs` |

### The one guarantee, and how it is stated

`classifyOwnedCommand` is a total function over everything it is told — the
boundary's ending, the reason this side terminated, and three facts only the run
loop knows — with exactly one path to `COMPLETED`: the boundary observed the
child exit, no policy here terminated it, and nothing said ownership was never
established. Everything else, including combinations unreachable by
construction, lands on a non-success, and the test enumerates that whole product
rather than sampling it. `BOUNDARY_LOST` cannot be read as a completion down any
combination, which is the defect the ADR added the state for.

Termination goes through the boundary and only through it: one kill of the
helper, which holds the only handle to the job. No `taskkill`, no descendant
walk, no list of pids — for the timeout, for a byte budget, and for an explicit
cancellation alike.

### What the gate measures, and what it deliberately does not

Nine of the twenty cases run the same invocation through **both** runners —
`runCommand`, the contract AO has today, and `runOwnedCommand` — and require
them to agree about
output, budgets, exit codes, timeouts and stdin delivery. That differential is
not an attempt to reproduce `taskkill` containment, which the ADR replaces; it
is the guard against the adapter quietly inventing a different command
semantics, which a green suite of its own tests cannot see. It caught the first defect this
slice had: a Windows exit code reported signed on the owned path and unsigned on
the diagnostics one, for the same process — `0xC0000005`, which is what a
crashed agent comes back with.

It does **not** claim the containment settings are load-bearing. That claim needs
a negative control — a deliberately weakened helper that leaves survivors — and
it belongs to slice 1's gate, which has one. Here the survivor sweep is hygiene:
whatever policy ended a run, nothing of that run is left executing.

Two divergences from `runCommand` were recorded here rather than smoothed over,
and slice 3 settled both. `timeoutMs: Infinity` was effectively unbounded here
and fired at 1 ms there; `runCommand` now applies the same clamp on both
platforms, from this module's own exported constant. A stdin write that fails
while the child exits cleanly is `FAILED` on the POSIX path and `UNCONFIRMED`
here; the weaker word stands, because behind a boundary the broken pipe is the
*helper's* and says nothing about what the child received. Both are documented
on the types themselves and pinned in `tests/v3-03-owned-runner.test.ts`.

## The productive Windows runner (V3 slice 3)

**Every Windows command AO runs is now created behind the launch boundary.**
This is slice 3 of the ADR's sequence, and it is the first one that changes what
a productive run does: the agent seam, the verification seam, the Git seam and
every diagnostic probe reach `runCommand`, and on Windows `runCommand` hands a
resolved launch plan to the owned adapter instead of spawning the target itself.

    leased-spawns.ts  →  agent-command / verify-command / git-command
                      →  doctor/exec.ts  (resolution, planning, budgets, policy)
                      →  boundary/owned-command.ts
                      →  boundary/start-owned-process.ts
                      →  ao-launch.exe  →  strict Job Object  →  target + tree

There is **no second path**. A boundary that cannot be established is
`SPAWN_FAILED`; one established and then lost is `BOUNDARY_LOST`; nothing runs
unowned, and no `taskkill` decides a Windows process's lifetime any more. The
supervisor that used to is still in the repository and is wired to nothing.

| Part | Where |
| --- | --- |
| The dispatch and the translation | `src/doctor/exec.ts` |
| Its contract, dispatch and mapping | `tests/v3-03-owned-runner.test.ts` |
| The productive real-process gate | `tests/dist-artifact/owned-command-dist-artifact.mjs` (case 5b) |
| The reachability and lease pins | `tests/v2-07l-execution-lease.test.ts` |

### What is preserved, and what is new

`CommandResult` gained exactly one member, `BOUNDARY_LOST`, on `outcome` and on
`failureCode`. Everything else is the contract AO already had: PATH/PATHEXT
resolution, `.cmd`/`.bat` through the trusted `cmd.exe /d /s /c` route with its
batch codec and verbatim command line, cwd, the environment, separate streams,
per-stream byte budgets, timeouts, exit-code fidelity, the fixed failure codes
and the four-word stdin vocabulary.

`NOT_FOUND` in particular is **kept**, although the ADR's five-member list omits
it. It answers a different question — "there is no such program on this machine"
— it is decided by resolution before anything is launched, and a capability
probe reads it. `processTreeKilled` is also kept, with its narrow legacy meaning
intact: it says a *best-effort* mechanism reported success, none runs behind the
boundary, so it is `false` there. Whether containment held is reported on
`outcome`, where it is actually decided.

### What fences it

The boundary carries process **ownership** and no authority of its own: it
contains whatever it is asked to start. So the question this slice had to answer
is what may ask. The answer is unchanged by the boundary, and asserted
structurally: `owned-command.ts` has exactly one importer and it is
`doctor/exec.ts`; no module under `src/loop/`, `src/agent/`, `src/verify/` or
`src/worktree/` may import any boundary module; and the productive runners stay
reachable only through `leasedAgent`/`leasedVerify`, with the Git mutations
fenced immediately before the effect. No lease logic went into the adapter or
the native helper.

### Two defects the productive path exposed

Both were in slice 1/2 code, both were invisible to their own gates because
those gates run a handful of commands rather than thousands, and both are now
pinned by a counter-proof that was confirmed to fail against the unfixed code.

**The status publish lost a race with its own reader.** The helper publishes by
atomic rename; AO polls that same file to learn that ownership holds; and a file
open for reading cannot be replaced, because a plain read handle carries no
`FILE_SHARE_DELETE`. The rename failed, the staging file was deleted, and the
child's exit code was never published — so a run that completed normally with
exit code 0 came back `BOUNDARY_LOST / NO_CHILD_EXIT_OBSERVED`. Measured at 3 of
320 fast commands under eight-way concurrency. The publish now retries, bounded.

**A short-lived child's output was discarded.** The adapter attached its output
listeners after establishment — and a fast child finishes inside that window, so
node, with nothing reading the pipe, ended and destroyed the stream and took the
buffered bytes with it. The run reported `COMPLETED`, exit code 0, empty
`stdout`: indistinguishable from a command that printed nothing, which is the
worst shape a defect can take on a path `git-query.ts` reads a repository's
identity from. Measured at 4 of 60 identical `.cmd` runs. The streams are handed
to the adapter in the same tick as the spawn now.

### The costs, stated

Establishment is a real cost: one extra process and a status handshake per
command, ~30 ms on an idle machine and 228 ms as the worst of three under load
(`test:dist-owned-command` prints the number every run). The suite's per-test
ceiling was raised from 30 s to 90 s because of it, not to accommodate a flaky
test — a case driving a real remediation loop pays that cost dozens of times.

One test file was withdrawn rather than adapted:
`tests/run-command-tree-kill-races.test.ts` pinned `runCommand`'s Windows
tree-kill lifecycle, and that lifecycle no longer exists. The supervisor itself
keeps both of its own suites, including the serial real-process gate in
`verify`.

## Safe stale-lease recovery (V3 slice 5)

The gap the withdrawn `lease break` left is now closed **for the leases whose
death can be proved**, and left open — deliberately, permanently — for the one it
cannot.

Read "The break was withdrawn, brought back, and withdrawn again" above before
this section. What changed is not that the contract was written more carefully on
the sixth attempt. It is that V3 slices 1–4 produced a *fact* that did not exist
in V2, and the fact is what carries the removal.

### The safety predicate, stated exactly

```text
SAFE_TO_RECOVER
iff  a lease document is at this repository's lease path
and  the process it names does not exist
and  the writer-launch history beside it is complete, bound to this exact lease,
     about this exact owner and run, and every launch in it is proved contained
```

Anything else is a refusal, and there is no override: no `--force`, no
environment variable, no API back door. `unknown => do not recover` is the whole
of the default arm, and there is no other.

"No override" is a claim about an argument list, so it is worth being exact. The
first version of `recoverStaleLease` took a liveness *probe* — the same test seam
the reporting paths take — and a review removed a demonstrably living process's
lease through it in a single call, because that probe **is** the first conjunct.
What it takes now is an additional liveness *opinion*, combined with the
operating system's by taking the more refusing of the two: it can stop a recovery
and cannot cause one. The rule that fixed it is the one this module states
everywhere else and had broken in the one place it could least afford to — **a
probe may refuse and may never permit**.

Neither conjunct works alone, which is why both are there. A dead owner proves
nothing — that is the measurement this repository has been carrying since V2-07L,
and it has not been repealed. A complete all-contained history beside a *living*
owner describes a run that is working perfectly. Together they say the one thing a
removal needs: every writer tree that ever existed under this lease was created
inside a Job Object coupled to the owner, and the kernel destroys that job when
the owner dies. Not "probably gone" — gone, because the kernel says so.

### Why slice 4's record could not be the input

Slice 4 records that **one writer launch** was contained, and its own contract
says so. A run makes several `claude` spawns under one lease; a failed publish
leaves the previous launch's positive record standing; so does a failed clear.
So `latestLaunchContained === true` means "the last launch anybody managed to
write about was contained", which is a strictly weaker sentence than "this lease
is safe".

The predicate therefore **never reads that record**. A lease can report
`CONTAINED` and be refused recovery in the same breath, and **three cases** in
`tests/v3-05-stale-lease-recovery.test.ts` assert exactly that pairing. Teaching
the predicate to accept it kills all three.

### The writer-launch ledger: poisoned first, confirmed after

```text
lease acquired      -> history published, historyComplete: true, no entries
before each launch  -> generation N appended as PENDING, published
launch happens      -> only after that publish is known to have landed
kernel-confirmed    -> generation N replaced by CONTAINED, published
anything else       -> generation N stays PENDING, for good
```

The ordering is the safety argument and it only works in one direction: a record
written after a launch cannot describe a launch that was killed mid-flight, and a
mark written before it can. `BOUNDARY_LOST`, a refused launch, an unconfirmed
termination and a killed orchestrator all leave the same visible state — an open
generation — rather than leaving nothing.

`historyComplete` is what makes a *lost* history safe. A ledger that is missing,
torn, versioned for another build, or bound to another lease is rebuilt from
empty with `historyComplete: false`, permanently, because starting a fresh
*complete* history at generation 1 would hide every launch the lost file
described. Nothing promotes a `false` back, since nothing can learn what the lost
file said. It lives in its own file beside the lease and never inside it: the
lease document is not rewritten at all, for the reason slice 4 already paid for —
an interrupted rewrite of a lease leaves one with no legible owner, which its own
holder cannot release and nothing in this build can clear.

The ledger records the **productive writer** and nothing else, exactly as slice
4's record does. The reviewer and the verification command go through the same
owned boundary on Windows, so they are contained in fact; they are not recorded,
so no reading here is evidence about them.

### The one place a failure to record stops productive work

If the pending mark cannot be published, the history on disk is an affirmative
one that does not mention the launch about to happen — which reads as a complete
proof and is a lie. There is one fallback: **delete the history**, which asserts
nothing, and let the launch proceed with this lease permanently unrecoverable.
Only when even that fails does the launch itself lose, and the agent seam answers
with its own refusal rather than borrowing the lost-lease one. Every other
recording failure in this build is an enrichment that may not stop a run; this
one is not an enrichment, because a stale affirmative history is worse than none.

### Why the removal can be bound, when the break's could not

`break` failed because for the artefact that most needed recovering — the
zero-byte file a crash leaves between taking the lease name and writing the
record — every fact that could name one object collapsed at once: no owner pid,
the constant digest `sha256("")`, and a reused `(dev,ino)`.

`recover` does not stand on any of that:

- **it refuses that artefact.** The predicate requires a lease document it
  *parsed*, so the object is named by 32 random bytes of `ownerNonce` inside its
  own record. The crash-window case is reported as `LEASE_UNPARSEABLE` and stays
  refused. The gap is smaller than it was — a crash *after* the record is written
  is now recoverable — and it is not closed;
- **there is no window to carry a fact across.** `break` minted an
  authorisation, printed it, and acted on what an operator typed back. Here the
  predicate is evaluated inside the call that removes, and the one argument
  besides the repository can only ever *refuse*, so no verdict and no permission
  can arrive from a caller at all;
- **and the removal binds to the object.** It goes through
  `removeVerifiedLease`, which detaches into a private name and decides on that
  object, and the predicate requires the exact bytes the assessment read. A lease
  that changed hands in the window cannot match, so it is put back and the call
  answers `LEASE_CHANGED` — or, when the put-back itself fails, the record is
  *kept* in a quarantine file and the call answers `LEASE_DISPLACED`, because a
  displaced writer and a file left inside `.git` are not a clean abort. Replacing
  that predicate with `() => true` fails a case that swaps the lease from inside
  the liveness probe.

### `agent-loop lease recover`

```powershell
agent-loop lease recover --repository <abs path>
```

Removes a stale lease and nothing else. It grants no authority — `containment !=
authority` — so the next run takes its own lease through the ordinary exclusive
create, and lease fencing remains the writer authority exactly as before. It
acquires nothing, restarts nothing and retries nothing.

`lease status` reports the verdict beside the state, and the launch history's own
reading on its own line — read independently, so it is shown for a healthy
repository too, where the predicate stops at the living owner and never gets that
far. It prints no command line with a fact filled into it: `recover` has no argument to fill in, which is what
stops a report from becoming an authorisation.

### What it is measured by

`tests/v3-05-stale-lease-recovery.test.ts` covers the format, the lifecycle, the
seam, the predicate and the operator vocabulary, and eight mutants were run
against it rather than described, each a single edit to `src`:

```text
the pending mark is never written                    27 cases red
slice 4's record is treated as sufficient             3
the removal stops binding to the object it proved     1
an unreadable history reads as contained              4
the seam stops refusing an unrecordable launch        1
a supplied liveness opinion may permit                3
a displaced successor is reported as a clean abort    1
an incomplete history is reported as an absent one    1
```

Re-measured against the file as it stands, not carried forward. Two of those
numbers had drifted, and the coupling is not one-to-one: the case that feeds the
reader a malformed ledger accounts for the fourth row entirely and for one third
of the first, whose other two increments come from a hostile-deps block added to
a different case and from an assertion added for the report's `End state` label.
A count beside code with nothing keeping the two in step is the defect
`VerifiedRemoval`'s own docstring polices. These are a property of one commit's
test file, and any case added to it can move any of them.

The last three were added after review rounds found them unpinned, and two of
them were live defects rather than hypotheticals: a supplied liveness answer
could remove a living owner's lease (see "no override" above), and a successor
displaced into a quarantine file was reported to the operator as a clean abort.
The seventh is pinned against a **table** rather than against a reachable state:
the two members that report `LEASE_DISPLACED` need a failed restore, which no
caller of `recoverStaleLease` can arrange, so the mapping is asserted by value
where the arm cannot be produced. (Four of the nine need a failed restore, not
two — this sentence carried the count that was corrected in the source and not
here.)

Two limits in the format were caught by review rather than by a test, and are
recorded because the second was a silent one. The entry cap was **dead**: a
`CONTAINED` entry is about 465 bytes, so 4096 of them need ~1.9 MB and the
companion reader's byte cap was 1 MiB, described as "sized for the entry cap".
Past ~2261 entries every confirmation failed its read-back, so every generation
stayed `PENDING` and the lease became permanently unrecoverable **with no signal
at all** — the seam discards the confirmation's result. The byte cap now covers
the entry cap, and reaching the entry cap discards the history and says so
(`HISTORY_DISCARDED` / `HISTORY_FULL`) instead of degrading in silence. Separately,
one attestation could confirm several generations; the digest is now refused if it
has already proved one, so "every launch is proved contained" is enforced by the
format rather than by its caller.

Its stale leases are built by acquiring for real, driving real launches, and then
rewriting the owner pid to one whose process has exited — genuinely dead, and the
real `osProcessLiveness` is what confirms it. What that file never does is let a
second OS process **hold** the lease — it starts one, which is where the dead pid
comes from, and that child never touches the lease — or run against what is
shipped.
`npm run test:dist-stale-recovery` does both: a separate process acquires the
lease through the built artefact and exits still holding it. Its
load-bearing case is the **negative control** — an owner kept alive must be
refused with `OWNER_RUNNING` — because without it every recovery above could be
an instrument that cannot tell a living process from a dead one. Disabling the
liveness gate in the built artefact fails that check four ways per run, measured.

### What this slice deliberately did not do

No unattended retry loop, no automatic restart of anything, no change to the task
state machine, no POSIX containment, and no product-side PR/CI/merge automation.
`READY_FOR_PR` is still terminal and `maxReviewRounds` is still not resettable: a
recovery is not a review round and does not touch that budget. Acquisition does
**not** recover automatically — that stays an operator decision, taken by running
one command.

## Not implemented yet

Still missing, deliberately: unattended operation; owned process containment on
POSIX; and any product-side PR/CI/merge automation. `READY_FOR_PR` remains
terminal — the orchestrator hands a finished task to a human and stops there.

Containment evidence in the lease and the recovery contract are **no longer** on
that list: V3 slice 4 delivered the per-launch record and V3 slice 5 the writer-
launch history and the proof-gated removal built on it — see [Safe stale-lease
recovery (V3 slice 5)](#safe-stale-lease-recovery-v3-slice-5). Recovery is an
**operator command**, not an automatic step: nothing acquires a lease it recovered
and no acquisition path recovers one.

Owned process containment in the productive runner is **no longer** on that
list on Windows: V3 slice 3 delivered it — see "The productive Windows runner
(V3 slice 3)" above.

Owned containment is still missing, but it is no longer an open *question*. A
measurement spike on 2026-08-18 settled which mechanism can provide it on
Windows and which cannot, and
[`docs/decisions/2026-08-18-windows-owned-process-containment.md`](docs/decisions/2026-08-18-windows-owned-process-containment.md)
records that: a Job Object that **creates** the process under its ownership owns
the whole tree and kills it, including the real Claude Code tree; attaching a job
to an already-spawned process is refuted, and `taskkill /T /F` reporting success
is not evidence that no descendant survived. No technology is chosen there and
nothing in `src/` changed — the record exists so that neither refuted variant is
investigated a second time.

A second spike then measured the smallest boundary that can use that mechanism —
a small out-of-process helper that creates and owns the target — against this
runner's actual contract, and
[`docs/decisions/2026-08-19-adr-windows-launch-boundary.md`](docs/decisions/2026-08-19-adr-windows-launch-boundary.md)
chooses it. Two things in that ADR bind whatever implements it: containment that
cannot be established or kept is **fail-closed**, and a boundary lost mid-run is
**`BOUNDARY_LOST`, never `COMPLETED`** — when the boundary was killed under
measurement the tree died correctly and the run still looked like a normal
completion, which is the failure that state exists to prevent. The ADR itself
changed no `src/` file; **slices 1, 2 and 3 have since been built** — see the
three sections above — so on Windows a productive runner now does obtain a
contained process, and each remaining slice (lease and recovery evidence, then
unattended recovery on top of it) is still its own decision to start.

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
V2-08  attended block runner                <- shipped
         |
V2-09  dependent tasks / commit chain        <- shipped
         |
V2-10  operator notification                 <- shipped
         |
DOGFOOD-REM-001  the first dogfood's two defects   <- shipped
         |
       the second dogfood, then the closing audit  <- both done
```

One prerequisite is now explicit that was not before. **Unattended running needs
owned process containment**, not merely the lease: *automatic* recovery of a
stale lease is refused because a dead owner does not prove that no agent process
survived it, and that stays true until the orchestrator creates the containment
itself — a Windows Job Object, a supervised POSIX process group.

Recovering a dead lease used to be described here as never a step towards it,
because the judgement it depends on ("nothing of that run is still alive") was one
no job could make. **Owned containment is what changed that**, and V3 slice 5 is
the step: the judgement is now a proof rather than an opinion, which is precisely
why it can be written down and checked. What has *not* changed is that recovery is
still an operator command; nothing runs it on a schedule, and unattended operation
needs its own decision.

The crash window is **narrower and still open, and stated as open**: a repository
whose run died *between claiming the lease name and writing the record* leaves a
zero-byte artefact with no owner and no identity, and this build refuses it as
`LEASE_UNPARSEABLE` rather than guessing. Clearing that one still needs a human to
delete a file inside `.git`.

Inventing a cross-platform atomic file compare-and-swap inside V2-07 was the
alternative, and it would have burst the slice for a guarantee the lease has to
provide anyway. It is also, as it turns out, the primitive an attended break
would have needed: see the withdrawal above.

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
