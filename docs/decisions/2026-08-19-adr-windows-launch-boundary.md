# ADR — the Windows launch boundary for productive agent execution

**Date:** 2026-08-19 · **Status:** accepted · **Scope:** the technology that
creates and owns an agent process on Windows, and the runner state that reports
losing it. Nothing else.

This is the ADR the evidence record of 2026-08-18
([`2026-08-18-windows-owned-process-containment.md`](2026-08-18-windows-owned-process-containment.md))
deliberately refused to write. That record settled which *mechanism* can own a
process tree; it named no technology, because none had been measured. One has
now been measured, and this ADR chooses it.

It decides a boundary. It does not implement one: no file under `src/` changes
because of this document, `READY_FOR_PR` stays terminal, and the implementation
sequence at the end is a plan, not a commitment made here.

## Context

Two measurement spikes, both run outside this repository, both preserved with
checksums beside their instruments.

**Spike 1 (2026-08-18)** established the primitive: a Windows Job Object owns
the complete tree when the owner *creates* the process inside it;
`KILL_ON_JOB_CLOSE` takes the tree when the owner is lost, with no cleanup code
running; a strict inner job vetoes breakaway even under libuv's permissive one.
It also refuted two things — attaching a job after `child_process.spawn`
(1 of 7 processes captured against the real Claude tree) and `taskkill /T /F`
success as evidence of an empty tree (exit code 0 in ten of ten rounds while
leaving 38 orphaned descendants alive).

**Spike 2 (2026-08-19)** measured the smallest external boundary that can use
that primitive: one small out-of-process helper that creates the strict job,
creates the target inside it, forwards stdio, and holds the only job handle.
It was measured against `runCommand`'s existing observable contract, mostly
differentially — the same case run through the boundary and through a plain
`child_process.spawn`, then compared.

| What was measured | Result |
| --- | --- |
| Argument vector, 10 differential cases (`.exe` and `.cmd`, spaces, quotes, backslashes, Unicode, empty and shell-metacharacter arguments) | identical in **10/10**, exit code identical in 10/10 |
| stdin at 1 KiB, 1 MiB, 8 MiB | delivered, SHA-256 identical to the control |
| Child's real exit code (0, 1, 7, 42, 255) | exact, 5/5 |
| `cwd` and environment, with spaces, umlauts, quotes, `λ`, `日本` | exact; exactly the variables supplied, nothing inherited |
| stdout/stderr as separate channels, byte budgets enforced in JavaScript | held; 65 536-byte budget hit exactly, truncation reported |
| Timeout, output limit, AO death, helper death | 3/3 rounds each, 7-process tree alive before, **0 survivors** |
| Real Claude Code tree (`.cmd` shim, prompt on stdin) | contained; 3/3 genuine mid-run kills with 0 survivors; AO death with Claude running, 0 survivors |
| `PROC_THREAD_ATTRIBUTE_JOB_LIST` | works, including against the real Claude tree |
| `windows-latest` (GitHub-hosted) | the runner **is** already in a job; a strict job nested inside it contains the tree, refuses breakaway from inside (Win32 5), accepts `JOB_LIST`, kills with 0 survivors |
| Fail-closed under five injected failure points and one real one | refused; nothing ran; no leftover process; no fallback |

Survivor counts are from an instrument independent of the job — a Toolhelp32
walk of the real process table, with identity as (pid, creation time) **and** a
`STILL_ACTIVE` check. Negative controls exist for the load-bearing settings: an
inheritable job handle with no handle list leaves 7 survivors, so the guarantee
is doing real work rather than being asserted.

This repository's own gate stays green on Node 22 and Node 24 throughout.

## Decision

**Windows productive agent execution uses a small native out-of-process
launch and ownership helper.**

The helper:

- creates the strict Job Object — `KILL_ON_JOB_CLOSE`, neither breakaway flag;
- creates the target process **inside** that ownership boundary, and verifies
  membership before the target can execute;
- uses `PROC_THREAD_ATTRIBUTE_JOB_LIST` where the proven implementation supports
  it, and create-suspended-then-assign otherwise — both were measured, including
  against the real Claude tree;
- keeps its job handle **non-inheritable**, and passes exactly the three stdio
  handles through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`. Both are load-bearing:
  with the handle inheritable *and* no handle list, containment disappears;
- never exposes an attach-after-spawn fallback, in any form, under any timing;
- owns the lifetime primitive, and nothing else;
- couples its own lifetime to the AO caller: it waits on the caller's process
  handle and takes the tree down when that handle signals;
- does **not** own AO domain logic — no byte budgets, no task state, no review
  or verification policy.

AO (TypeScript) retains:

- stdin delivery semantics and their vocabulary;
- stdout/stderr byte budgets;
- timeout policy;
- result classification;
- lease authority;
- scope authority;
- verification and task-state transitions.

**Any inability to establish or retain owned containment is fail-closed.** If
the job cannot be created, configured, assigned or verified, no writer starts,
and the failure is reported as itself. Falling back to an ordinary spawn plus a
best-effort kill would turn a guarantee into a feature while leaving every
caller believing the guarantee holds.

### `BOUNDARY_LOST` is not `COMPLETED`

The runner's outcome vocabulary gains a fifth member:

```
COMPLETED
TIMED_OUT
OUTPUT_LIMIT_EXCEEDED
SPAWN_FAILED
BOUNDARY_LOST
```

`BOUNDARY_LOST` means: *the ownership and supervision boundary was lost before
AO could observe a regular completion of the managed process. The job tree was,
or is being, terminated by the ownership semantics. The work product is not
trustworthy and must not be continued as a successful completion.*

This is not a refinement of the containment result — it is a defect the
containment result hides. When the helper was killed in spike 2, the tree died
correctly and **the run still looked exactly like a normal completion**: the
boundary had reported ownership earlier, the pipes closed cleanly, and no child
exit code ever arrived. A caller reading that as `COMPLETED` would continue a
destroyed run. The state is therefore a requirement of this ADR, not an
implementation detail left to the slice that adopts the boundary.

One measured consequence belongs with it. With a boundary in the middle, the
caller writes into the *helper's* stdin, not the child's, so a child that closes
its read end early is observed only because the helper exits and its own pipe
breaks in turn. The direct and owned paths agreed in every measured case, but a
production adapter must read the boundary's reported delivery state rather than
rely on that coincidence.

> **Correction, 2026-08-19 (V3 slice 2).** The conclusion stands and the
> mechanism does not. The helper that shipped does *not* exit when the child
> closes its read end: `PumpStdin` in `native/ao-launch/AoLaunch.cs` records
> `stdinForward=BROKEN_PIPE`, closes the child's handle and returns from its
> thread, and the helper stays alive to report the child's exit. The
> dist-artifact case "a child that exits without reading is never DELIVERED"
> measures exactly that — a run completing with the child's own exit code *and*
> a broken-pipe report, which the mechanism described above could not produce.
> The requirement this paragraph exists for is unaffected, and is in fact
> stronger: the boundary's reported delivery state is not merely more reliable
> than the caller's own pipe, it is the only evidence there is.

## Alternatives considered — not selected

**N-API addon.** Not selected, and **not refuted**: it was deliberately not
built. It has an architectural attraction the helper does not — AO would own the
job handle directly, which matches the owner-death semantics already proven —
and a corresponding cost: native failures land inside the AO process, and a
prebuild matrix appears. It is not chosen because it has no evidence yet, and a
second large spike purely for symmetry is not justified while no concrete
weakness of the helper needs solving. If such a weakness appears, this is the
first alternative to measure.

**FFI from Node.** Not selected. `STARTUPINFOEX`, `PROC_THREAD_ATTRIBUTE_LIST`,
`JOBOBJECT_EXTENDED_LIMIT_INFORMATION` and `PROCESS_INFORMATION` are exactly the
kind of struct, pointer and alignment surface where a silent mistake is possible
and load-bearing for an ownership primitive.

**Attach after `child_process.spawn`.** Rejected on 2026-08-18 by measurement,
and it stays rejected. The root process must not get the chance to create
children before ownership exists.

**`taskkill /T /F` as the lifetime mechanism.** Rejected as evidence on the same
date. It remains usable as best-effort cleanup for non-critical processes; it
may not decide a writer's lifetime.

## Not decided by this ADR

- `Bash` sandboxing;
- filesystem, network or credential isolation;
- POSIX containment;
- stale-lease schema details;
- PR, CI or merge automation in the product;
- the broader AO V3 orchestration architecture.

A job object bounds process lifetime. It bounds no file, no network access and
no credential, so nothing here is an argument for widening an agent's authority.

## Risks and verification gaps

**Node 22 boundary execution was not measured locally**, because Node 22 was not
installed on the measurement host. This is a verification gap, not evidence of
incompatibility: the selected boundary is out-of-process and has no Node ABI
dependency, and this repository's gate runs green on Node 22 and Node 24. A real
boundary integration test must cover both supported majors when the
implementation exists.

**One runner image, one measurement.** `windows-latest` was measured on
2026-08-19. Runner images change; the probe is kept in this repository
(`.github/workflows/spike-containment-probe.yml`, opt-in and non-gating) so the
question can be re-asked rather than re-derived.

**The spike helper is not the production helper.** It is throwaway measurement
code. What transfers is the contract and the numbers, not the file.

## Implementation sequence, deliberately sliced

Not authorised by this ADR beyond its shape; each slice is its own decision to
start, and none of them is a "job object plus runner plus lease plus recovery"
change:

1. the native boundary as an isolated module and executable with its own
   contract, without touching the existing runner;
2. the TypeScript adapter and `BOUNDARY_LOST`, with adversarial tests;
3. `runCommand` and the agent runner moved onto the owned boundary, preserving
   the existing result semantics;
4. only then, lease format and recovery extended with containment evidence;
5. only when that layer is stable, unattended recovery built on top of it.

## Evidence

Instruments, reports and raw results are preserved outside this repository, with
checksums: the 2026-08-18 spike under `ao-evidence/containment-spike-2026-08-18/`
and the 2026-08-19 spike under `ao-evidence/containment-spike-2-2026-08-19/`,
the latter carrying the acceptance-criteria verdicts this ADR rests on.
