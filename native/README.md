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
the job, verifies membership before the target executes, forwards stdio, and
reports a primitive status. That is the whole component.

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

## Verifying

```
npm run test:dist-boundary
```

Real processes, real deaths, and an instrument that is itself checked: see the
header of `tests/dist-artifact/launch-boundary-dist-artifact.mjs`.
