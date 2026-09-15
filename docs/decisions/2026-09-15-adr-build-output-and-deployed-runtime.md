# The build output and the deployed runtime are two directories

**Date:** 2026-09-15 · **Status:** accepted, implemented by AO-RUNTIME-ISOLATION-001.

The scheduled production supervisor executes `D:\AgentOrchestrator\dist\cli\index.js`.
`npm run verify` runs `npm run build`, and `npm run build` wrote into that same
`dist/`.

So an ordinary verification run, on any feature branch, replaced the bytes
production was about to execute.

## The defect, measured before anything was changed

This is not a hypothesis. It happened on 2026-09-14/15: a feature-branch verify
for PR #103 rebuilt `dist/` before that pull request was merged, and the next
scheduled supervisor pass executed the unmerged parser. That code was correct
and it repaired CAPTURE-006's durable quota reset — but the outcome was
accidental, not delivered.

The measurement that opened this slice, taken on `main @ 2036198` before any
change:

| Fact | Measured |
| --- | --- |
| what the supervisor executes | `<repo>/dist/cli/index.js`, every 30 minutes |
| what `npm run build` writes | `<repo>/dist` |
| files one build wrote into the production runtime | **715** |
| bytes one build changed in the production runtime | `dist/native/ao-launch.exe` (a fresh MVID per compile) |
| other consumers of the same `dist/` | 9 operator scripts under `C:\Users\Max\AO-runs` |
| stale files in the live runtime, from sources that no longer exist | **9** (3 modules) |

The last row is a second defect the first one hid. `tsc` does not delete, so a
directory that has been rebuilt across branches for months accumulates the
emitted output of sources that have since been removed. The live production
runtime was executing three modules that are not in `main`.

The source delivery policy in `CLAUDE.md` protects `main` — pull request, CI,
merge only on green. None of it constrains the runtime, because the runtime was
never a delivered artefact. It was a side effect of testing.

## The sentence this slice is answerable for

> A verification run is a measurement. It may not be a deployment.

## The decision

Two directories, with two different lifetimes:

| | build output | deployed runtime |
| --- | --- | --- |
| path | `<repo>/build` | `<repo>/dist` |
| written by | `npm run build` | `npm run deploy`, and nothing else |
| written how often | every verify, every branch | when an operator decides |
| executed by | the dist-artefact gates | the scheduled production supervisor |
| carries provenance | yes, `channel: BUILD` | yes, `channel: DEPLOYED` |
| may be stale | yes, harmlessly | no — compiled fresh into an empty directory |

`dist/` keeps its name deliberately. It is the path the scheduled task's
supervisor script and eight sibling operator scripts already resolve, and none
of them changed. What changed is who is allowed to write it.

### Why the repository stopped writing the production path, rather than the supervisor moving

The alternative was to leave `npm run build` writing `dist/` and point the
supervisor at a new directory. It was rejected on a property, not a preference:
under that design the invariant "a verify does not touch production" would hold
only because of the contents of nine untracked scripts outside the repository.
No test here could see it, and re-pointing one script at `dist/` would silently
restore the defect with every gate green.

With the build moved instead, the invariant is a property of this repository's
own build, and `tests/dist-artifact/runtime-isolation-dist-artifact.mjs` fails
on CI the moment it stops holding.

### Deployment is explicit, and says so on the record

`npm run deploy` refuses two things by default, each with its own
authorisation and each recording its reason in the runtime's provenance:

- a **dirty tree** — `--allow-dirty "<reason>"`, recorded as
  `authorization: EXPLICIT_DIRTY`, `sourceTreeClean: false`;
- a commit that is **not the canonical tip** (`refs/remotes/origin/main`) —
  `--allow-non-canonical "<reason>"`, recorded as
  `authorization: EXPLICIT_NON_CANONICAL`.

They are two flags because they authorise two different claims. "Not the
canonical tip" still names a commit whose content *is* what was deployed. "The
tree is dirty" is the admission that the runtime corresponds to no commit at
all. Authorising the weaker one does not grant the stronger one, and that is
measured rather than asserted.

There is no environment variable and no configuration file that grants either.

### Fail closed: a runtime that cannot say where it came from does not run

Every runtime this repository produces carries `.ao-provenance.json` at its
root, written **last**, naming the commit, the channel, and the absolute root it
was deployed to. Before any command begins, the CLI reads its own record and
refuses — exit **7**, `EXIT_RUNTIME_PROVENANCE_UNKNOWN` — when there is none, when
it cannot be read, or when it is a record about a different root.

The last of those is what makes a hand-copied tree refusable: copying `build/`
into `dist/` produces a record that says `<repo>/build` and is read at
`<repo>/dist`.

**What this does not claim.** It does not verify the tree against the commit.
Nothing inside a deployed runtime can: there is no repository beside it and no
signature over its files. A runtime whose files were edited after deployment
passes this gate, and no sentence here says otherwise. What it proves is that
the tree was *put there by a deployment*, at this root, and which commit that
deployment named.

### Atomicity

The runtime is compiled into a staging directory in full and only then takes the
name, by rename. Replacing an existing runtime is two renames — move the old one
aside, then take the name — so at every instant `dist/` is the complete previous
runtime, absent, or the complete new one. Never a half-replaced tree.

The absent window is one rename wide and it is **fail-closed**: a supervisor
entering it cannot find `dist/cli/index.js` and stops. If the second rename
fails, the first is undone and the previous runtime is back in place, complete.
Removing that rollback was applied as a mutant and fails the deployment harness
three ways.

## What this slice deliberately did not do

- **The Zera supervisor path did not change.** `node .\dist\cli\index.js` is
  still what it runs, and the scheduled task was not modified. The scheduled
  task was *disabled* for the duration of the work, because measuring the
  pre-fix behaviour required running the very build that deployed to
  production; it was re-enabled immediately afterwards.
- **The supervisor does not check provenance itself.** The runtime refuses on
  its own behalf, which reaches every caller of the CLI rather than one script.
- **`READY_FOR_PR` is still terminal, and the product still knows nothing about
  deployment.** This is delivery infrastructure for this repository, exactly as
  `CLAUDE.md` says CI is.

## Accepted residuals

- **A deployed runtime is not self-contained.** `cli/index.js` imports
  `commander`, and Node resolves that by walking up to a `node_modules`. The
  production runtime works because `<repo>/dist` sits beside `<repo>/node_modules`.
  A runtime deployed outside a checkout dies on its first import, before any gate
  in it can be reached — measured while writing the harness, which now places
  every runtime it intends to execute under `<repo>/tmp`. `--target` is therefore
  only meaningful inside a checkout.
- **Provenance is a record, not an integrity proof.** See above.
- **`bin.agent-loop` and `exports` still point at `dist/cli/index.js`.** A
  developer who wants their own branch's CLI runs `node build/cli/index.js`;
  `npm link` hands out the deployed runtime, which is the deliberate reading —
  linking an unverified, branch-dependent build under the name `agent-loop`
  would be a smaller instance of the defect this slice closes.
- **The provenance gate guards the CLI entry, not every import of the runtime.**
  It runs in the Commander `preAction` hook, so it covers anything reached
  through `dist/cli/index.js`. The Zera operator scripts also `import()` modules
  out of the deployed runtime directly — `dist/core/task-attention.js`,
  `dist/verify/operator-repair.js` and six more — and those imports do not pass
  through the hook. A `dist/` with no provenance would therefore still answer
  those importers while refusing every command. The isolation half is what
  actually protects them: nothing writes `dist/` but a deployment. Stated here
  rather than closed, because closing it means a check at module load in eight
  modules, which is a cost this slice did not pay.
- **The provenance gate is inert when the TypeScript source is run directly.**
  A source tree is not a runtime and has no deployment that could have produced
  it. The consequence is that no vitest worker can observe the gate firing, so
  it is measured against a compiled runtime as a real child process by
  `tests/dist-artifact/runtime-deployment-dist-artifact.mjs` — the same
  arrangement, and for the same reason, as the V2 runtime gate.
