# `native/` — the Windows launch boundary

One component lives here: `ao-launch/AoLaunch.cs`, the process that creates and
**owns** a productive agent process on Windows.

It is not a utility, and it is not general. It exists because a Windows Job
Object owns a complete process tree only when the owner *creates* the process
inside it — attaching a job after `child_process.spawn` was measured and
refuted (1 of 7 processes captured against the real Claude tree), and
`taskkill /T /F` reported success in ten of ten rounds while leaving 38
orphaned descendants alive. Node cannot create a process inside a job, so the
creation has to happen somewhere else, and this is that somewhere.

Decision and evidence:
[`docs/decisions/2026-08-19-adr-windows-launch-boundary.md`](../docs/decisions/2026-08-19-adr-windows-launch-boundary.md).

## What it does, and what it must never do

It creates a strict job (`KILL_ON_JOB_CLOSE`, neither breakaway flag), arms its
coupling to the AO process that asked for the launch, creates the target inside
the job, confirms membership before the target executes, forwards stdio, and
reports a primitive status. That is the whole component.

"Before the target executes" means one of two things, and which one depends on
the placement mode:

- **`JOBLIST`** (the default) has the kernel place the process in the job *at
  creation*, so there is no instant at which a created process is not yet
  owned. The membership check confirms what is already true. This is the mode
  with no window;
- **`SUSPENDED`** creates the process suspended, assigns it, checks membership
  and only then resumes, so the check precedes the target's first instruction —
  but between `CreateProcess` and `AssignProcessToJobObject` there is a window
  in which a helper killed from outside leaves a suspended, unowned process
  that nothing will resume or reap. The owner-death case is closed by a lock;
  an external kill in that window is not, and that is why it is not the
  default.

It owns **no** AO domain logic: no byte budgets, no timeouts, no stdin
vocabulary, no result classification, no task state. Those stay in TypeScript
(`src/boundary/`, and the adapter slices after it). The smaller this file, the
less of the system depends on native code being right.

It also has **no fallback**. Every path that cannot establish or keep ownership
refuses, and an unknown request key is a refusal rather than an ignored option.
That last rule is why the two switches that weaken containment — an inheritable
job handle, and passing no handle list — exist only under the
`AO_BOUNDARY_TEST_CONTROLS` define. The shipped build does not implement them,
so asking it for them fails the request; the negative control that proves the
guarantee is load-bearing is a separate binary, built into a temporary
directory by the test that needs it, and never into `dist`.

## Building

```
npm run build:boundary        # -> dist/native/ao-launch.exe
```

`scripts/build-native-boundary.mjs` compiles it with the in-box .NET Framework
compiler (`%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`), which is
part of Windows and is present on GitHub's `windows-latest` runners. No SDK, no
toolchain download, no prebuild matrix, and — because the boundary is
out-of-process — no Node ABI dependency. A missing compiler fails the build
rather than producing a `dist` without the boundary in it.

`npm run build` runs it, so the ordinary gate always produces both artefacts.

## What it does not defend against

The boundary bounds **process lifetime**. It bounds no file, no network access
and no credential, and — this part is easy to over-read — it is a guarantee
against a *cooperative or crashing* tree, not against a hostile one. The
contained process runs under the same user account as the helper, and on
Windows that account has full access to both. Concretely, a deliberately
hostile child can:

- `DuplicateHandle` the job handle out of the helper (`PROCESS_DUP_HANDLE`),
  after which it holds a reference to the job and `KILL_ON_JOB_CLOSE` no longer
  fires when the helper dies — the "cancellation is helper death" mechanism is
  defeated with no other change;
- write the status file the TypeScript side reads. The per-launch nonce and the
  helper-pid check make a *stale* or mismatched status impossible to mistake
  for a live one — which is the failure that actually happens — but they are
  not secrets against an account that can read the request file. That file is
  deleted by the helper the moment it has been parsed, and it carries the
  environment the caller substituted, so the window is short rather than
  absent.

Neither is a defect in the implementation; both are properties of same-account
Windows security, and closing them needs a different security boundary (a
separate account or an integrity level), not a different job configuration.
They are written down because the alternative is that a later slice builds on a
stronger promise than the mechanism makes.

## Verifying

```
npm run test:dist-boundary
```

Real processes, real deaths, and an instrument that is itself checked: see the
header of `tests/dist-artifact/launch-boundary-dist-artifact.mjs`.
