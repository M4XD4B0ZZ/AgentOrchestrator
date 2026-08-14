# V2-07P — Platform contract: Windows, Node 22 or 24, local NTFS

Status: **approved for planning** — approved 2026-08-14 after one review round,
which corrected §§1, 4, 5 and 7. The first draft carried this status before that
review had happened, which it had not earned.
Date: 2026-08-14 · Baseline: `ba72566` · Branch: `feat/v2-07p-platform-contract`

## Why this slice exists

V2 was being built as though portability were a requirement nobody had decided
on. Six adversarial review rounds on the execution lease spent their budget on
filesystems this project will never run on — FAT, exFAT, network mounts — and
the repair for each one widened the surface the next round had to break. The
decision recorded on 2026-08-14 is that **V2 is built for its actual deployment
and says so**, rather than carrying portability it cannot verify.

This slice makes that decision executable and states it in the terms it is
actually true in. It is the **final planned** change to the lease boundary
before the independent closing review. That is a statement of intent, not a
guarantee about the outcome: a review is entitled to force another remediation,
and a plan that promised the head would not move again would be promising
something the process cannot deliver.

## 1. The contract, in three separable claims

The central risk in writing this contract is overclaiming, so the three claims
are kept apart and each is stated at the strength it actually has:

```
verified   Windows · Node major 22 or 24 · repository Git common directory on
           local NTFS — the configuration this project is measured on. `verify`
           runs on windows-latest against node 22 AND node 24; that is the whole
           of the evidence.

enforced   Windows · Node major in {22, 24} · no explicit UNC or
           device-namespace path — what the build refuses to run outside of.
           What can be decided from process-constant facts and from the shape of
           a path.

proved     the lease's own filesystem capability, at the moment of the effect
           — unchanged by this slice. `LEASE_FILESYSTEM_UNSUPPORTED`.
```

The two axes behave differently, and saying so is the point of keeping them
apart:

- **on the Node axis, `enforced` and `verified` coincide exactly.** The set is a
  whitelist, `{22, 24}`, and CI measures every member of it. Not `>= 22`: that
  would admit 23, 25 and everything after them on a promise nobody has tested.
  Node 24 is in the set because it is what the development host actually runs
  (measured: v24.18.1) — a contract that refused the machine the tool is used on
  would reproduce, on a new axis, exactly the verified/deployed mismatch this
  slice exists to remove;
- **on the filesystem axis, `enforced` is strictly narrower than `verified`.**
  The build does not establish that an accepted volume is local, or that it is
  NTFS. Writing "V2 guarantees only local NTFS volumes run" would be false under
  this design and would be a truthfulness defect of exactly the kind this
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
/** A whitelist, deliberately not a floor. Every member is measured by CI. */
export const SUPPORTED_NODE_MAJORS = [22, 24] as const;

export const RUNTIME_SUPPORT_CODES = [
  'RUNTIME_PLATFORM_UNSUPPORTED',
  'RUNTIME_NODE_UNSUPPORTED',
  'RUNTIME_NODE_VERSION_UNREADABLE',
] as const;

export type RuntimeSupportCode = (typeof RUNTIME_SUPPORT_CODES)[number];

export type RuntimeSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly code: RuntimeSupportCode; readonly detail: string };

export function evaluateRuntimeSupport(platform: string, nodeVersion: string): RuntimeSupport;
```

`RUNTIME_NODE_UNSUPPORTED`, not `..._TOO_OLD`: Node 25 is refused and is not
old. A code that misdescribes the refusal is the same defect §5 avoids with the
device-namespace path.

`RUNTIME_NODE_VERSION_UNREADABLE` exists because an unparseable version string
must refuse rather than pass. Fail-closed: an unknown answer is not a supported
one.

**The whitelist has to stay a whitelist**, and that is a property the tests
carry rather than the type: `SUPPORTED_NODE_MAJORS.includes(major)` and
`major >= Math.min(...SUPPORTED_NODE_MAJORS)` agree on 21, 22 and 24 and
disagree only on 23 and 25 — so a refactor that quietly restores a floor passes
any suite that does not test the gaps. §7 tests the gaps.

### Two dependent changes this constant forces

1. **`src/doctor/run-doctor.ts`** — `MINIMUM_NODE_MAJOR` (line 71) is replaced
   by an import of `SUPPORTED_NODE_MAJORS`, and the check at line 328 changes
   from `nodeMajor >= MINIMUM_NODE_MAJOR` to whitelist membership. Left as a
   floor, the doctor would report `PASS` for Node 25 on a build whose gate
   refuses it — the tool contradicting itself in the one command whose job is to
   describe the environment.
2. **`package.json`** — `engines.node` becomes `"22.x || 24.x"`. `">=22"` states
   a wider contract than the build enforces, and `engines` is the field other
   tooling reads.

## 4. Enforcement at the CLI

`src/cli/index.ts` installs the gate so that it runs after argument parsing and
before any command action:

- `--help` and `--version` still work, at every nesting level, and so does
  Commander's `help <command>`. Refusing to print help is not a safety property,
  and an operator on an unsupported machine is precisely the one who needs it.
  The option forms are resolved during parse and so sit outside the gate by
  construction; `help <command>` is an actual command and may not, which §7
  measures rather than assumes.
- every command action refuses, **including `doctor`**. A build that is
  officially Windows-only while shipping a product path that still executes on
  POSIX has a soft contract, and would force the portability code to keep being
  treated as live.
- the refusal is ordered, and the order is part of the contract:

  ```
  1. write the COMPLETE refusal message to stderr, synchronously
  2. terminate with EXIT_RUNTIME_UNSUPPORTED = 6   (0–5 are taken; run-exit-codes.ts:36)
  3. no command action may begin
  ```

  Step 1 is `writeSync` against fd 2 in a loop until every byte is accounted
  for, not `process.stderr.write`. On Windows a stderr that is a pipe — which is
  what a test harness, a CI log and any `2>` redirection give it — is written
  asynchronously, and a hard `process.exit` can discard a buffered tail. "The
  refusal message *is* the diagnosis" is only true if the whole message
  survives; a truncated one is a build that refuses without saying why.
  `writeSync` may also return a short count, so the loop is the mechanism, not a
  formality.

  Step 2 terminates rather than setting `process.exitCode` and returning: a hook
  that returns normally lets the action run, and an exit code the action then
  overwrites is a refusal that refuses nothing.

  The decision this acts on comes from the pure evaluator, so the part that
  cannot be exercised in-process is one call, one write loop and one exit — and
  all three are measured through the dist-artefact control in §7 rather than
  argued here.

**Open mechanism question, to be settled by a test rather than by
documentation:** whether a Commander 15 `preAction` hook registered on the
program is inherited by a nested subcommand (`lease status`). If it is, one hook
covers everything. If it is not, each registered action is wrapped instead. The
test decides; no shape is assumed.

## 5. UNC and device paths in `deriveExecutionLeaseLocation`

Today's single regex at `src/lease/execution-lease.ts:331` accepts UNC
explicitly (`[\\/]{2}[^\\/]`). It is split into named classes. The three
rejected classes get **two** codes, not one, because subsuming a device path
under "UNC" would make the new code as imprecise as the one it replaces.

The table below is **measured** against the current build on this Windows host,
not derived from the comments, because the comments turned out to name the wrong
guard (see below):

| `gitCommonDir` | Today | After |
| --- | --- | --- |
| `C:\repo\.git` | accepted | accepted |
| `\\?\C:\repo\.git` | accepted | accepted — extended-length drive path. Like any drive-letter path this does **not** establish that the volume is local; see the ACCEPTED LIMIT in §1 |
| `\\server\share\repo\.git` | **accepted** | `LEASE_LOCATION_NETWORK_UNSUPPORTED` |
| `\\?\UNC\server\share\repo\.git` | **accepted** | `LEASE_LOCATION_NETWORK_UNSUPPORTED` |
| `\\.\PhysicalDrive0` | **accepted** | `LEASE_LOCATION_DEVICE_NAMESPACE` |
| `\repo\.git` — root-relative | refused by the regex | unchanged |
| `/repo/.git` — root-relative | refused by the regex | unchanged |
| `C:repo\.git` — drive-relative | refused by `isAbsolute` | unchanged |

### The existing prose names the wrong path class, and this slice fixes it

The comment at `execution-lease.ts:316` and the F-4 entry at README:2862 both
call `\foo` a "**drive-relative** root". On Windows it is not: `\foo` is
*root-relative* — absolute within whichever volume the process is standing on,
with the drive unspecified. The genuinely drive-relative form is `C:foo`,
relative to the current directory *of that drive*.

The distinction is not pedantry here, because the two are caught by **different
guards**, and the comment sits on the one that does not catch the case it names:

- `C:repo\.git` — `isAbsolute` answers `false`, so it is refused at line 313,
  before the Windows regex is ever reached;
- `\repo\.git` — `isAbsolute` answers `true`, and it is the regex at line 331
  that refuses it. This is the case F-4 is actually about.

Both comments are corrected to say *root-relative*. This is prose in a function
this slice is already editing, and leaving a mislabelled path class in the one
module whose whole argument is about naming things exactly would be the wrong
trade.

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
   `process.version` are `writable: false` but `configurable: true` — measured
   on v24.18.1 on the development host, **not** on the Node 22 the CI runner
   uses. The override therefore uses `Object.defineProperty` and then *reads the
   value back*; if the read-back does not show the substituted value, the
   preload aborts the process with a distinct exit code rather than letting the
   harness continue.

   That read-back is what makes the unmeasured Node-22 case safe: should a
   future runtime make either property non-configurable, the control fails
   loudly instead of passing green from a gate that never ran. It is not a
   belt-and-braces check — it is the only reason this control may be trusted on
   a Node this measurement did not cover.
2. **The assertion reaches the effect.** The control does not assert only that a
   message was printed. The invoked command is one whose action has an
   observable effect, and the control asserts **that effect did not happen**. An
   absence assertion that cannot fail pins nothing.

**The help and version carve-out, pinned as the product guarantee it is.** §4
promises that `--help` and `--version` keep working on an unsupported runtime.
That is a guarantee, so the same dist-artefact script measures it under the
simulated-unsupported preload, across every form the CLI offers:

```
agent-loop --help
agent-loop --version
agent-loop lease --help              (nested)
agent-loop lease status --help       (twice nested)
agent-loop help lease                (Commander's implicit help command)
```

For each: normal help or version output on stdout, exit code **not**
`EXIT_RUNTIME_UNSUPPORTED`, and no action executed.

`help <command>` is the one that may not come for free. Commander implements it
as an actual command rather than as an option, so a `preAction` hook could
intercept it and the gate would swallow the one output an operator on an
unsupported machine most needs. If the measurement shows that, the gate gains an
explicit exemption for the help command — decided by this control, not
predicted. Together with the nested cases this control also settles the open
mechanism question in §4 empirically: a hook that never fires for `lease status`
shows up here as a nested command that *should* have been refused and was not.

**Negative, in-process, pure.** `evaluateRuntimeSupport` against the full
matrix, asserting the specific code and not merely `supported === false`:

| Input | Expected |
| --- | --- |
| `win32`, v21 | `RUNTIME_NODE_UNSUPPORTED` |
| `win32`, v22 | supported |
| `win32`, **v23** | `RUNTIME_NODE_UNSUPPORTED` |
| `win32`, v24 | supported |
| `win32`, **v25** | `RUNTIME_NODE_UNSUPPORTED` |
| `win32`, unparseable | `RUNTIME_NODE_VERSION_UNREADABLE` |
| `linux` / `darwin`, v22 **and** v24 | `RUNTIME_PLATFORM_UNSUPPORTED` |

The bold rows are the whole point: **23 and 25 are the only inputs on which a
whitelist and a `>= 22` floor disagree.** Without them the suite would pass
against an implementation that silently reverted to a floor, and the contract
would be wider than the document claims while every test stayed green. The
platform rows are driven at both supported majors so that a refusal cannot come
out of the Node check by accident.

`deriveExecutionLeaseLocation` is driven against every row of the table in §5,
likewise asserting the specific code.

The dist-artefact script is registered as `test:dist-runtime-gate` /
`verify:dist-runtime-gate`, added to `verify`, and listed in the README gate
enumeration at README:79 and in the CI workflow's description of what `verify`
contains.

### CI becomes a matrix, and its own comment has to change

`.github/workflows/verify.yml` gains `strategy.matrix.node: [22, 24]`, so that
every member of `SUPPORTED_NODE_MAJORS` is measured. Its current comment reads:

> No matrix: a second version would test a promise nobody made.

That reasoning was sound while the contract was a floor nobody had committed to.
Under this design the promise **is** made — `{22, 24}` and nothing else — so the
comment is rewritten to say why the matrix exists and why it has exactly two
entries. The `node-version` comment naming `MINIMUM_NODE_MAJOR in
src/doctor/run-doctor.ts` is retargeted to `SUPPORTED_NODE_MAJORS` in
`src/platform/runtime-support.ts`.

Wall-clock is roughly unchanged — the jobs run in parallel — and the cost is
runner minutes. The job name (`verify (windows, node 22)`) becomes matrix-derived
so both appear distinctly in the checks list; under `CI_REQUIRED` a PR must show
real checks, and two named jobs are two real checks.

## 8. Documentation

- README gains a **Supported runtime** section carrying §1 verbatim in
  structure: the three claims kept apart, the two axes behaving differently, the
  exclusions, and the mapped-drive ACCEPTED LIMIT stated as such.
- The existing platform passages are reconciled rather than left to contradict
  the new one. Each is a specific edit, not a sweep:
  - README:2829 ("Verification is a stated V1 platform limitation") and
    README:3895 ("a stated reduction in supported platforms") predate this
    decision and describe a different contract from the one now in force;
  - README:2844 states V1's canonical verification evidence as "**Windows +
    Node 22**". With the matrix that becomes Node 22 and 24. This is a V1
    passage being corrected by a V2 change, so it says which slice moved it.
- `package.json` `engines.node` → `"22.x || 24.x"` (§3).
- The V2-07P narrative section is added in the established style, including the
  measured path-class table from §5 — the acceptance of UNC, extended-UNC and
  device paths in the shipped build is a fact worth recording, since it is what
  the slice removes.

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
- **F-4** (`path-identity.ts` comparing root-relative paths as equal across
  volumes). Still carried forward. Only its *wording* is corrected here, per
  §5 — the gap itself is untouched.
- **the ~120 orphaned agent worktrees** under `.claude/worktrees/` and ~110
  `worktree-*` branches. Untracked, outside the commit path, and an inventory
  and classification job of their own — not something to sweep with a broad
  delete alongside a product-contract change.

## 10. What "done" means

`npm run verify` green on a clean Windows/Node-22 machine via CI, on a PR
against `main`, with at least one real check. Then, and only then, the
independent adversarial closing review runs against **that** head — not against
`ba72566`, so that the review target does not move underneath the review.
