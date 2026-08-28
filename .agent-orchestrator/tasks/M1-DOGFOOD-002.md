---
id: M1-DOGFOOD-002
title: Test fixtures leak their memoised Git repository template on every run
status: OPEN
kind: NORMAL
priority: HIGH
currentFocus: true
dependsOn: []
---

## 1. The one hard requirement, first

Each of the three files named below must remove its memoised template directory
after its own tests have finished, and **the hook that does it must not be able
to throw.**

That second half is the part a previous attempt failed three review rounds on,
so read it twice. `rmSync`'s `force: true` option suppresses exactly one thing —
a path that is not there. Every other error it can raise, and on Windows those
include a directory another handle still holds, propagates straight out of the
hook and fails the whole file. Toggling `force` does not change that, in either
direction.

So: an error from the removal must be swallowed **inside** the hook, and the
memo must end up cleared whether the removal succeeded or not. A leftover
directory is a leftover; it is not a test failure, and it must not be reported
as one.

## 2. The defect

Three test files build one real Git repository as a template, memoise it in a
module-level variable, and copy it per case. The per-case copies are disposed.
**The template itself is never removed.** One real repository is therefore left
in the operating system's temporary directory every time each of those files
runs — `git init`, commits, a merge, hundreds of files.

The three files, and the memo each one leaks:

- `tests/v4-09-post-merge-verification.test.ts` — `let templateRepo`, built by
  `repositoryTemplate()` into `scratchRoot('ao-v409-template-')`
- `tests/v4-10-delivery-completion.test.ts` — `let templateRepo`, built into
  `scratchRoot('ao-v410-template-')`
- `tests/v4-11-delivery-lifecycle-driver.test.ts` — `let template`, built into
  `scratchRoot('ao-v411-template-')`

Measured in `%TEMP%` on 2026-08-28: 704 `ao-v410-template-*`, 651
`ao-v411-template-*`, 255 `ao-v409-template-*`. 1610 leaked repositories from
these three files alone.

This is an omission, not a design decision, and each file's own code says so:
every one of them already disposes its per-case copy — `v4-11` returns
`dispose: () => rmSync(root, { recursive: true, force: true })` from `fixture()`.
The template built by the same file is held to no such discipline. None of the
three declares any teardown hook at all.

## 3. What not to change

Do not change what a template contains, when it is built, or how many cases
share it. The memoisation is deliberate and each file's comment defends it —
building one repository instead of one per case is why these suites finish in
seconds. This task is about the end of its life, not its existence.

## 4. Allowed scope

Only these three files:

- `tests/v4-09-post-merge-verification.test.ts`
- `tests/v4-10-delivery-completion.test.ts`
- `tests/v4-11-delivery-lifecycle-driver.test.ts`

The repository profile allows `src` and `tests`. Everything outside those two
directories is refused by the scope gate, which reads the whole delta from the
base commit, untracked files included.

## 5. Excluded scope — do not touch

- `src/`. This is a test-hygiene defect. No production module is implicated.
- Any other file under `tests/`. Other prefixes leak too — `ao-foreign-`,
  `ao-v1-08-contracts-`, `ao-real-git-` — and each is its own defect with its
  own file.
- `docs/`, `README.md`, `schemas/`, `package.json`, `.gitignore`,
  `.agent-orchestrator/`. All outside the allowed scope; writing to any of them
  ends this task at `SCOPE_VIOLATION`.
- Any Zod schema module. The gate regenerates `schemas/*.json` from them, and
  `schemas/` is outside the allowed scope.

## 6. Acceptance criteria

1. Each of the three files removes its own memoised template directory after
   its tests have run.
2. **The removal cannot throw out of the hook.** See section 1.
3. The memo is cleared afterwards on every path, including the one where the
   removal failed.
4. No case's behaviour changes: the template is still built once per file and
   still copied per case.
5. Nothing outside the three named files is modified, created or deleted.

## 7. Verify requirements

The repository's declared gate is `npm ci` followed by `npm run verify`, and it
must pass. Two of these three files do not run in the parallel gate:
`tests/v4-09-post-merge-verification.test.ts` has its own serial gate, and so
does `tests/windows-tree-kill-tool-release.test.ts`. The whole gate is the
answer here; a subset is not.

## 8. Known risks

- **Hook scope.** A teardown must run after its own file's tests and no
  earlier. Each of these files uses its template only from within its own
  cases, so a file-scoped hook is the right scope — check it.
- **Do not add a global hook.** A shared teardown in a helper would couple three
  independent files together and would run for suites that have no template.

## 9. Canonical repository documents

`CLAUDE.md` is this repository's declared canonical context source. Read it
before changing anything: it governs how work is delivered here, not what the
product does.
