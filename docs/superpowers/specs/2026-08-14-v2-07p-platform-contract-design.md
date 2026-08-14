# V2-07P — Platform contract: Windows, Node 22, local NTFS

Status: **design, approved for planning** · Date: 2026-08-14 ·
Baseline: `ba72566` · Branch: `feat/v2-07p-platform-contract`

## Why this slice exists

V2 was being built as though portability were a requirement nobody had decided
on. Six adversarial review rounds on the execution lease spent their budget on
filesystems this project will never run on — FAT, exFAT, network mounts — and
the repair for each one widened the surface the next round had to break. The
decision recorded on 2026-08-14 is that **V2 is built for its actual deployment
and says so**, rather than carrying portability it cannot verify.

This slice makes that decision executable and states it in the terms it is
actually true in. It is the last change to the lease boundary before the
independent closing review, so that the review target is a head that will not
move again.

## 1. The contract, in three separable claims

The central risk in writing this contract is overclaiming, so the three claims
are kept apart and each is stated at the strength it actually has:

```
verified   Windows 11 · Node 22+ · repository Git common directory on local NTFS
           — the configuration this project is measured on. `verify` runs on
             windows-latest with node 22; that is the whole of the evidence.

enforced   Windows · Node major >= 22 · no explicit UNC or device-namespace path
           — what the build refuses to run outside of. A strict subset of
             `verified`: it is what can be decided from process-constant facts
             and from the shape of a path.

proved     the lease's own filesystem capability, at the moment of the effect
           — unchanged by this slice. `LEASE_FILESYSTEM_UNSUPPORTED`.
```

**`enforced` is narrower than `verified`, and the documentation must not blur
them.** The build does not establish that an accepted volume is local, or that
it is NTFS. Writing "V2 guarantees only local NTFS volumes run" would be false
under this design and would be a truthfulness defect of exactly the kind this
repository keeps finding in its own prose.

### Not part of the V2 support contract

FAT · exFAT · SMB and other network filesystems · UNC-hosted repository storage
· POSIX/macOS/Linux runtime guarantees.

### ACCEPTED LIMIT: a network share mapped to a drive letter

A share mounted as `Z:\` is path-shaped like a local volume and **is not
detected by this build**. It is outside the supported configuration and the tool
will not say so. This is recorded as an accepted limit, not as an unlikely case:

- closing it needs a Windows drive-type query, which introduces a preflight
  measurement of the filesystem — the exact construct this slice exists to avoid
  creating — plus its own tail of questions (`SUBST`, junctions, reparse points,
  Dev Drives, VHDX, UNC behind a local redirect, and disagreement between what
  the query answers and where the lease directory actually is);
- the residual protection is real but partial: where such a share cannot hard
  link, the lease refuses at the effect with `LEASE_FILESYSTEM_UNSUPPORTED`. A
  share that *can* hard link runs, unverified.

## 2. Two layers, and why the boundary falls where it does

| Layer | Fact consulted | Why it may be checked there |
| --- | --- | --- |
| Entry gate | `process.platform`, `process.version` | **Process-constant.** Both are fixed by the Node binary and cannot change during the run, so reading them once and refusing is not a check relocated away from its effect — there is no later moment at which the answer could differ. |
| Path shape | `gitCommonDir` string | **Syntactic.** No filesystem is consulted at all. |
| The effect | hard-link capability | **Not process-constant**, so it stays where it is: at the operation that needs it. Unchanged by this slice. |

The new preflight measures nothing about the filesystem. It therefore cannot
become an authority that a later effect leans on — that is a property of its
inputs, not a discipline its callers have to keep. Nothing anywhere in this
slice may read as "NTFS was established at startup, so this effect is safe".

## 3. `src/platform/runtime-support.ts` — new

A pure evaluator, with no access to `process` and no I/O:

```ts
export const MINIMUM_NODE_MAJOR = 22;

export const RUNTIME_SUPPORT_CODES = [
  'RUNTIME_PLATFORM_UNSUPPORTED',
  'RUNTIME_NODE_TOO_OLD',
  'RUNTIME_NODE_VERSION_UNREADABLE',
] as const;

export type RuntimeSupportCode = (typeof RUNTIME_SUPPORT_CODES)[number];

export type RuntimeSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly code: RuntimeSupportCode; readonly detail: string };

export function evaluateRuntimeSupport(platform: string, nodeVersion: string): RuntimeSupport;
```

`RUNTIME_NODE_VERSION_UNREADABLE` exists because an unparseable version string
must refuse rather than pass. Fail-closed: an unknown answer is not a
supported one.

`MINIMUM_NODE_MAJOR` moves here from `src/doctor/run-doctor.ts:71` and is
re-exported there, so the gate and the doctor report cannot drift apart. The CI
workflow comment naming `run-doctor.ts` as the home of the constant is updated
with it.

## 4. Enforcement at the CLI

`src/cli/index.ts` installs the gate so that it runs after argument parsing and
before any command action:

- `--help` and `--version` still work — Commander resolves both during parse.
  Refusing to print help is not a safety property.
- every command action refuses, **including `doctor`**. A build that is
  officially Windows-only while shipping a product path that still executes on
  POSIX has a soft contract, and would force the portability code to keep being
  treated as live.
- the refusal writes the contract text to stderr and **terminates the process**
  with a new `EXIT_RUNTIME_UNSUPPORTED = 6` (0–5 are taken; see
  `run-exit-codes.ts:36`). Not `process.exitCode` and a return: a hook that
  returns normally lets the action run, and setting an exit code the action then
  overwrites is a refusal that refuses nothing. The termination is the gate. The
  decision it acts on comes from the pure evaluator, so the untestable part is
  one call and one write.

**Open mechanism question, to be settled by a test rather than by
documentation:** whether a Commander 15 `preAction` hook registered on the
program is inherited by a nested subcommand (`lease status`). If it is, one hook
covers everything. If it is not, each registered action is wrapped instead. The
test decides; no shape is assumed.

## 5. UNC and device paths in `deriveExecutionLeaseLocation`

Today's single regex at `src/lease/execution-lease.ts:331` accepts UNC
explicitly (`[\\/]{2}[^\\/]`). It is split into named classes. The three
rejected classes get **two** codes, not one, because subsuming a device path
under "UNC" would make the new code as imprecise as the one it replaces:

| `gitCommonDir` | Result |
| --- | --- |
| `C:\repo\.git` | accepted |
| `\\?\C:\repo\.git` | accepted — local extended-length, **not** UNC |
| `\\server\share\repo\.git` | `LEASE_LOCATION_NETWORK_UNSUPPORTED` |
| `\\?\UNC\server\share\repo\.git` | `LEASE_LOCATION_NETWORK_UNSUPPORTED` |
| `\\.\...` | `LEASE_LOCATION_DEVICE_NAMESPACE` |
| `\repo\.git` | `LEASE_LOCATION_UNSUITABLE` — unchanged (drive-relative, F-4) |

Both new codes join `LEASE_ACQUIRE_FAILURE_CODES` and get their own sentence in
`LEASE_ACQUIRE_SENTENCES` (`src/cli/render-lease.ts:33`), following the
precedent argued at `execution-lease.ts:638`: a refusal that misdescribes itself
is worse than a verbose one. `LEASE_LOCATION_UNSUITABLE`'s sentence says no
location could be derived, which is plainly wrong for a UNC path that resolves.

The network sentence says, in substance: *this repository's Git common directory
is on an explicitly unsupported UNC/network path; V2 supports the verified
local-Windows configuration only.*

`LeaseLocationFailure.code` widens from a single literal to the union, and every
`if (!location.ok)` site is re-read to confirm it forwards the code rather than
re-deriving `LEASE_LOCATION_UNSUITABLE`.

## 6. Dead `leaseObjectIdentity` prose

The function was removed; four references outlived it.

| Site | Current text | Action |
| --- | --- | --- |
| `execution-lease.ts:506` | `See {@link leaseObjectIdentity}` | retarget to `readObject`, the reader that actually produces the value |
| `execution-lease.ts:1273` | "`leaseObjectIdentity` remains, for `lease status` to report" | **actively false** — rewrite: the identity is still reported, via the inspection's `readObject`, and no function by that name remains |
| `execution-lease.ts:1356` | "it used to also receive `leaseObjectIdentity(quarantine)`" | keep as history, reworded so it cannot read as naming a live symbol |
| `render-lease.ts:121` | "contradicts `leaseObjectIdentity`'s own reasoning" | reattribute the reasoning to where it now lives |

The historical references are **reworded, not deleted**: the argument for why the
attended break is gone is the most valuable prose in the module, and a removed
citation would take its reasoning with it.

## 7. Controls

**Positive, real process, on the configuration that is actually claimed.** In
the same dist-artefact script, the built CLI is spawned on this Windows host
**without** the preload and passes *through* the gate: `lease status
--repository <a scratch repository>` produces its normal report, exits `0`, and
carries no runtime refusal. This is the only control that exercises the
supported path end to end, and it is what stops the gate from being written so
broadly that it refuses everything.

**Negative, real process, against the built artefact.** A new dist-artefact
script spawns `node --require <preload> dist/cli/index.js …` where the preload
overrides `process.platform` to `linux`, and in a second case `process.version`
to a v20 string.

Two requirements on this control, both load-bearing:

1. **The preload proves its own instrumentation.** `process.platform` and
   `process.version` are not ordinarily writable; their descriptors are
   configurable on the Node 22 under test, so the override uses
   `Object.defineProperty` and then *reads the value back*. If the override did
   not take, the preload aborts the process with a distinct failure rather than
   letting the harness continue — an ineffective preload would otherwise
   manufacture a green result from a gate that never ran.
2. **The assertion reaches the effect.** The control does not assert only that a
   message was printed. The invoked command is one whose action has an
   observable effect, and the control asserts **that effect did not happen**. An
   absence assertion that cannot fail pins nothing.

**Negative, in-process, pure.** `evaluateRuntimeSupport` against a matrix of
platform and version strings including the unparseable case;
`deriveExecutionLeaseLocation` against every row of the table in §5, asserting
the specific code rather than merely `ok === false`.

The dist-artefact script is registered as `test:dist-runtime-gate` /
`verify:dist-runtime-gate`, added to `verify`, and listed in the README gate
enumeration at README:79 and in the CI workflow's description of what `verify`
contains.

## 8. Documentation

- README gains a **Supported runtime** section carrying §1 verbatim in
  structure: the three claims kept apart, the exclusions, and the mapped-drive
  ACCEPTED LIMIT stated as such.
- The existing platform passages are reconciled rather than left to contradict
  the new one: README:2829 ("Verification is a stated V1 platform limitation")
  and README:3895 ("a stated reduction in supported platforms") both predate
  this decision and now describe a narrower contract than the one in force.
- The V2-07P narrative section is added in the established style.

## 9. Explicitly out of scope

Each of these is a deliberate exclusion, not an oversight:

- **removing POSIX code.** The entry gate makes `exec.ts`'s `detached` /
  process-group termination branches, `path-identity.ts:56`, `safe-write.ts:109`
  and `:118`, and the POSIX profile resolver unreachable. They stay. Deleting
  them means rewriting the most dangerous module in the build inside a slice
  whose purpose is to *stop* opening review surfaces. A separate mechanical
  cleanup slice, or nothing at all if V2 never needs it.
- **drive-type detection** — see the ACCEPTED LIMIT in §1.
- **any new recovery, break, or portable fallback.** None. `putBack`'s copying
  restore stays: it exists for a link failure that is an anomaly (NTFS's
  1024-name limit, a permission refusal), not for a platform that has no links.
- **F-4** (`path-identity.ts` drive-relative comparison). Still carried forward.
- **the ~120 orphaned agent worktrees** under `.claude/worktrees/` and ~110
  `worktree-*` branches. Untracked, outside the commit path, and an inventory
  and classification job of their own — not something to sweep with a broad
  delete alongside a product-contract change.

## 10. What "done" means

`npm run verify` green on a clean Windows/Node-22 machine via CI, on a PR
against `main`, with at least one real check. Then, and only then, the
independent adversarial closing review runs against **that** head — not against
`ba72566`, so that the review target does not move underneath the review.
