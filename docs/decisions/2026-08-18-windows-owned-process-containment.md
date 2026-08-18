# Windows owned process containment — what the first spike settled

**Date:** 2026-08-18 · **Status:** evidence record, binding on scope. **Not** an
ADR: it chooses no technology.

The README has said since V2-07L that unattended running needs *owned process
containment*, and that the orchestrator does not have it. A measurement spike on
2026-08-18 asked one question — can this process obtain kernel-enforced ownership
of the complete process tree it launches, such that no descendant survives
deliberate termination or loss of that ownership? — and answered it by
measurement rather than by reading documentation.

This file records what that answer settles, so that a later reader does not
re-open a question already closed, and does not treat a refuted variant as an
option still on the table. It deliberately stops short of naming a launch
technology, because the spike did not measure one.

Nothing in `src/` changes because of this file. `READY_FOR_PR` remains terminal,
owned containment remains unimplemented, and the product contract is untouched.

## Where the evidence lives

The spike was forbidden to touch this repository and did not: it ran entirely in
a session scratch directory, and the repository stayed clean at `d0cff41`. Its
instruments — a 901-line C# probe and five Node drivers — the published report,
an independent review of it, and the raw runs that survived are preserved
**outside** the repository, on the machine that measured it, under
`ao-evidence/containment-spike-2026-08-18/` with a `SHA256SUMS` beside them. The
probe is not copied in here: it is throwaway measurement code, not product
source, and a copy in `src/` would have to be maintained as if it were.

One gap is stated rather than hidden. The 116 raw evidence directories of the C#
probe's own runs were deleted at the end of that session and are not
recoverable. The instrument survives; those particular outputs do not. The
results are therefore re-measurable, not re-readable — and re-running the first
spike to recover them would buy nothing this record does not already carry.

Measured on Windows 10 Pro N 10.0.19045, Node v24.18.1 (libuv 1.52.1), Claude
Code 2.1.234. Every claim below is a claim about that host.

## Proven

- **A Windows Job Object can own the complete launched process tree.** Four
  generations plus the console hosts Windows creates for them, 8 of 8 in the
  job, membership read from the job rather than inferred from process names.
- **`TerminateJobObject` removes that tree.** Zero survivors in every round,
  including a deliberately adversarial run where the deepest node spawned a new
  descendant every 5 ms and 108–110 processes were in the job at the moment of
  the kill. Every member carried the caller's exit code, not merely an absent
  PID.
- **`KILL_ON_JOB_CLOSE` kills the owned tree when the owner is lost**, with no
  cleanup code running: the owner killed from outside and the owner terminating
  itself gave identical results. Handle closure is the kernel's work on process
  teardown, so nothing in user space has to survive to make it fire.
- **A strict inner job vetoes breakaway even under libuv's permissive one.**
  With the inner job carrying neither breakaway flag, a child created with
  `CREATE_BREAKAWAY_FROM_JOB` was refused at `CreateProcess` — while the outer
  job, shaped exactly like libuv's, permitted it. The immediate job governs.
  Relaxing either flag on the inner job made descendants escape and survive the
  kill, which is what makes the refusal mean something.
- **The real Claude Code tree was contained** — the `cmd.exe` shim, `claude.exe`,
  its three `node.exe` helpers and the console hosts — with the descendant tree
  enumerated from an OS snapshot rather than from the job, so an escape would
  have been visible. None had escaped, and the kill left the real tree empty.

## Rejected

- **`child_process.spawn()` followed by `AssignProcessToJobObject()`.** Against
  the real Claude tree this captured 1 of 7 processes in three rounds and failed
  to attach at all in the other two. A separate run with an artificial delay
  before the first descendant isolated the cause as the ordering race, not the
  assignment call — so better timing, an earlier call site, or a retry do not
  repair it. The root process must not get the chance to create children before
  ownership exists. This path is closed, not merely disfavoured.
- **`taskkill /T /F` as proof that no descendant survives.** Against the same
  adversarial fixture it returned **exit code 0 in all ten rounds** while
  leaving 3–5 orphaned descendants alive each time, 38 in total. `exec.ts`
  already disclaims the guarantee; this puts a number on it. The tool remains
  usable as best-effort cleanup for non-critical processes. It may not be the
  basis on which a writer's lifetime is decided.

## Required, when owned containment is built

- **The boundary must create the process under ownership.** The proven sequence
  is create-suspended, assign, verify membership, resume — the child cannot
  execute, and so cannot spawn, before it is in the job. Any future
  implementation has to own the launch itself; adopting the job afterwards is
  the refuted path above.
- **Fail closed.** If the job cannot be created, configured, assigned or
  verified, no writer starts. Falling back to an ordinary spawn plus `taskkill`
  would turn a guarantee into a best-effort feature while leaving the callers
  believing the guarantee holds.
- **The job handle must not be inherited.** With the handle created inheritable
  and inherited by the contained child, closing the owner's handle killed
  nothing: 5 of 5 processes stayed alive, and stayed alive after the owner
  exited. The processes to be killed were the ones holding the job open. This is
  not theoretical here — libuv calls `CreateProcessW` with `bInheritHandles =
  TRUE` and no handle list, so every inheritable handle in this process reaches
  every non-detached child.
- **Old leases do not become recoverable by this result.** A lease written
  before owned containment existed carries no evidence about the tree its run
  started, so a dead owner still does not prove no writer survived. Containment
  can only unlock stale-lease recovery *forward*, for leases that record it.

## Not proven, and therefore still open

- native helper vs. N-API vs. FFI as the launch boundary
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` (and `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`)
- stdin, stdout and stderr fidelity through such a boundary — including partial
  stdin delivery, which today has its own distinguished outcome
- Windows command-line fidelity: `.exe` and `.cmd` targets, quoting, spaces,
  Unicode, `cwd` and `env`
- owner-death semantics when the job is owned by a *helper* process rather than
  by the orchestrator itself
- Node 22 (only Node 24 was measured)
- GitHub Actions `windows-latest`: whether the runner is already in a job, with
  which limit flags, and whether nesting is accepted there
- sandboxing of any kind. A job object bounds process lifetime. It bounds no
  file, no network access and no credential, so it is not an argument for
  granting an agent `Bash`.

## What comes next, in order

1. a second spike, read-only against the product code, covering the open list
   above as its acceptance contract;
2. only then an ADR naming a launch technology;
3. only then implementation.

Writing the ADR before the second spike would be choosing a boundary before
knowing whether it can carry the runner contract that everything else is built
on.
