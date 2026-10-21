# Scratch workspace — operator working rule

**Binding for every operator and every agent, from 2026-10-20** — for scratch work on this
repository and on the repositories AgentOrchestrator runs (Zera / HealthApp included). Decided by
the operator; this file records it. `CLAUDE.md` is not changed by it.

Scratch work is everything that is not delivered: probes, labs, break-test (mutant) runs, review
notes, patches, prototype commits, logs and reports. It lives in one place:

```
D:\AgentOrchestrator\.scratch\
```

`.scratch/` at the repository root. Git ignores it (`.gitignore`). Nothing in it is ever committed,
pushed, built, tested by the gate or read by AgentOrchestrator. No new scratch folder is created
directly under `D:\`.

## Layout

```
.scratch/
  active/<ID>/                  work in progress, one folder per task or topic
  worktrees/<ID>-<purpose>/     git worktrees — only under the rules below
  reports/<YYYY-MM-DD>-<topic>.md
  archive/<YYYY-MM>/<ID>/       finished work, kept for reference
```

- `<ID>` is the task ID from `.agent-orchestrator/tasks/` when the work belongs to a task (for
  example `RM1-03A`). Work that belongs to no task uses a dated topic name, for example
  `2026-10-20-scratch-policy`. Never invent a name that looks like a task ID: it can collide with
  the registry.
- Inside a folder, use short plain names: `probes/`, `mutants/`, `review/`, `patches/`, `logs/`.
- A report names the exact commit SHAs it checked and where its evidence lies.

## What protects the repository

| Concern | Why `.scratch/` is safe | How to check |
| --- | --- | --- |
| Git and pull requests | `.scratch/` is in the root `.gitignore` | `git check-ignore -v .scratch/x` names `.gitignore`; before a PR, `git diff --name-only origin/main...HEAD` lists no `.scratch/` path. Never `git add -f` there |
| AO's clean-checkout check | `prepare-workspace.ts` runs `git status --porcelain --untracked-files=all`, which honours ignore rules, so `.scratch/` never makes the checkout dirty (`SOURCE_WORKTREE_DIRTY`) | `git status --porcelain --untracked-files=all` is empty |
| AO runtime, lease, task state | they live in `.agent-orchestrator/runtime/` and under the user profile; nothing reads `.scratch/` | never put scratch files under `.agent-orchestrator/` |
| Deployed runtime | `dist/` is written only by `npm run deploy` | never write into `dist/` from scratch work |
| MEMGUARD | it guards the memory folders, not repository paths; `.scratch/` changes nothing there | — |
| TypeScript, the build, the tests | `tsconfig.json` includes `src/`, `tests/`, `scripts/`; `tsconfig.build.json` includes `src/`; Vitest collects `tests/**/*.test.ts` | — |
| CodeGraph | its live watcher reads the root `.gitignore` **once, when its background service starts**. Measured 2026-10-20: with only a `.git/info/exclude` entry, the watcher indexed a `.ts` file under `.scratch/`; a full index and `codegraph sync` honour both. A service that was already running when `/.scratch/` entered `.gitignore` (PR #121) still indexes new code files there until it is restarted. Restart it from inside a session with CodeGraph's own `stopDaemonAt` (section "Restarting the CodeGraph service" below); closing every Claude Code session that uses this repository restarts it too. Until then, run `codegraph sync .` after writing code into `.scratch/` | `codegraph files` lists no `.scratch/` path; a new `.ts` probe there is not found by `codegraph query` |

### Restarting the CodeGraph service

A session does not have to be closed. Measured 2026-10-20 with CodeGraph 1.5.0, from inside a
running Claude Code session: CodeGraph's own `stopDaemonAt` stopped only this repository's service
(`"outcome":"term"`). The session's CodeGraph server went on answering in-process, with an ignore
matcher built from the current `.gitignore`: a new `.ts` probe under `.scratch/` was not indexed
(`codegraph query` found nothing after 25 s). On 2026-10-21, after a day of HealthApp worktrees and
probe files under `.scratch/`, `codegraph files` listed no `.scratch/` path.

Save this as a `.cjs` file under `.scratch/` and run `node <file> D:\AgentOrchestrator`:

```js
// Stops only the CodeGraph service registered for the given root, through CodeGraph's own registry.
const path = require('path');
const lib = path.join(process.env.APPDATA, 'npm', 'node_modules', '@colbymchenry', 'codegraph',
  'node_modules', '@colbymchenry', 'codegraph-win32-x64', 'lib', 'dist', 'mcp', 'daemon-registry.js');
const registry = require(lib);
const root = process.argv[2].toLowerCase();
const record = registry.listDaemons({ prune: false }).find((d) => d.root.toLowerCase() === root);
if (!record) {
  console.log('no CodeGraph service is registered for this root');
} else {
  registry.stopDaemonAt(record.root).then((result) => console.log(JSON.stringify(result)));
}
```

It prints the root, the process id and `"outcome":"term"`. Then check with a new `.ts` probe under
`.scratch/` and `codegraph query`. The path is the global npm install of CodeGraph 1.5.0 on
Windows; after an update, check that `daemon-registry.js` still exports `listDaemons` and
`stopDaemonAt`. Do not use `codegraph daemon` from an agent's shell: it is an interactive picker.

## Git worktrees under `.scratch/worktrees/`

AgentOrchestrator's own task worktrees live beside the repository (`D:\AgentOrchestrator.worktrees\`),
not inside it. A worktree under `.scratch/` is a nested one, and it has one measured trap: Node
looks for packages in every parent folder. A folder under `.scratch/` without its own
`node_modules` resolves `vitest` from `D:\AgentOrchestrator\node_modules` (measured 2026-10-20), so
`npx` and `node` there silently use the main checkout's packages. Rules:

1. Only once the `.gitignore` entry is on `main` and in the checkout, and the CodeGraph service has
   been restarted since (see CodeGraph above) — otherwise it indexes the worktree's whole source.
2. Run `npm ci` in the worktree before any `npx`, `node` or test command. Check that the test
   runner resolves inside the worktree — for this repository,
   `node -p "require.resolve('vitest/package.json')"`; for HealthApp, the same with `jest`. The
   same holds for a worktree of another repository placed here: it sits inside this checkout, so
   it, too, falls back to this checkout's `node_modules`.
3. `node_modules` is a real folder. Never a junction or a symbolic link.
4. Never check out an `ao/task/*` branch: those belong to AgentOrchestrator.
5. Remove with `git worktree remove <path>` without `--force`. If Git refuses, find out why first.
6. Before you delete any folder, list its reparse points: `cmd /c dir /AL /S /B <path>`. Never
   delete recursively through a junction.
7. Never run `git clean -x` in the main checkout: it deletes `.scratch/`.

At most one heavy gate (`npm run verify`, a full test run, an emulator) runs on the machine at a
time.

## Private data

Do not copy secrets, notification topics, tokens, transcripts or `C:\Users\Max\AO-runs` state into
`.scratch/`. When a probe needs one, refer to it by path and keep the value out of every file.

## Finishing and cleaning up

- When the pull request a folder belongs to is merged or closed, move the folder from `active/` to
  `archive/<YYYY-MM>/`.
- A worktree is removed after its branch is merged, by rule 5 above.
- Nothing in `archive/` is deleted without an operator decision.

## Old scratch folders

Scratch work before 2026-10-20 lies under `D:\scratch_ao\`. It is moved only by a migration plan
(kept in `.scratch/reports/`): a folder that is still active is not moved, every worktree is moved
with `git worktree move`, junctions are listed before anything is touched, and an old folder is
cleaned up only after its copy is proven complete.
