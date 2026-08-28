---
id: M1-DOGFOOD-001
title: Test fixtures leak their memoised Git repository template on every run
status: OPEN
kind: NORMAL
priority: HIGH
currentFocus: true
dependsOn: []
---

## 1. The defect

Three test files build one real Git repository as a template, memoise it in a
module-level variable, and copy it per case. The per-case copies are disposed.
**The template itself is never removed.** One real repository is therefore left
in the operating system's temporary directory every time each of those files
runs, and it is a real repository — `git init`, commits, a merge — not an empty
directory.

The three files, and the memo each one leaks:

- `tests/v4-09-post-merge-verification.test.ts` — `let templateRepo` near line
  348, built by `repositoryTemplate()` into `scratchRoot('ao-v409-template-')`
- `tests/v4-10-delivery-completion.test.ts` — `let templateRepo` near line 1730,
  built into `scratchRoot('ao-v410-template-')`
- `tests/v4-11-delivery-lifecycle-driver.test.ts` — `let template` near line 163,
  built into `scratchRoot('ao-v411-template-')`

Measured on the operator's machine on 2026-08-28, in `%TEMP%`:

```
704  ao-v410-template-*
651  ao-v411-template-*
255  ao-v409-template-*
```

1610 leaked repositories from these three files alone.

This is an omission rather than a design decision, and each file's own code says
so: every one of them already disposes its per-case copy. `v4-11`, for example,
returns `dispose: () => rmSync(root, { recursive: true, force: true })` from its
`fixture()`. The template built by the same file is held to no such discipline.
None of the three files declares an `afterAll` hook at all.

## 2. The change to make

In each of the three files, remove the memoised template directory once the
file's tests have finished, and leave the memo in a state that does not name a
directory which no longer exists.

Follow the disposal idiom the same file already uses. Removal must be
best-effort and must not fail the suite: a template directory that Windows
refuses to delete is a leftover, not a test failure.

Do not change what a template contains, when it is built, or how many cases
share it. The memoisation is deliberate and is defended in each file's own
comment — building one repository instead of one per case is why these suites
finish in seconds. This task is about the end of its life, not its existence.

## 3. Allowed scope

Only these three files:

- `tests/v4-09-post-merge-verification.test.ts`
- `tests/v4-10-delivery-completion.test.ts`
- `tests/v4-11-delivery-lifecycle-driver.test.ts`

The repository profile allows `src` and `tests`. Everything outside those two
directories is refused by the scope gate, and the gate reads the whole delta
from the base commit, untracked files included.

## 4. Excluded scope — do not touch

- `src/` — this is a test-hygiene defect. No production module is implicated,
  and a change there would be outside this task even though the profile allows
  the directory.
- Any other file under `tests/`. Other prefixes leak too — `ao-foreign-`,
  `ao-v1-08-contracts-`, `ao-real-git-` — and each is its own defect with its
  own file. Fixing them here would make one review answer for four changes.
- `docs/`, `README.md`, `schemas/`, `package.json`, `.gitignore`,
  `.agent-orchestrator/`. All outside the allowed scope; writing to any of them
  ends this task at `SCOPE_VIOLATION`.
- Any Zod schema module. `npm run verify` regenerates `schemas/*.json` from
  them, and `schemas/` is outside the allowed scope, so a schema change turns
  the next scope reading into a violation.

## 5. Acceptance criteria

1. Each of the three files removes its own memoised template directory after
   its tests have run.
2. No case's behaviour changes. The template is still built once per file and
   still copied per case.
3. A failed removal does not fail the suite.
4. The memo does not survive pointing at a removed directory.
5. Nothing outside the three named files is modified, created or deleted.

## 6. Verify requirements

The repository's declared gate is `npm ci` followed by `npm run verify`, and it
must pass. Two of these three files do not run in the parallel gate:
`tests/v4-09-post-merge-verification.test.ts` has its own serial gate, and so
does `tests/windows-tree-kill-tool-release.test.ts`. `npm run verify` runs all
of them, so the whole gate is the answer here and a subset is not.

## 7. Known risks

- **Hook ordering.** An `afterAll` in a file runs after that file's tests. If a
  template were removed while another case still needed it, cases would fail
  with a missing path. Each of these files uses its template only from within
  its own cases, so a file-scoped hook is the right scope — but check it.
- **Windows deletion.** `rmSync` on a real `.git` directory can be refused
  while a handle is still open. Use `force: true` and tolerate a failure.
- **Do not add a global hook.** A shared teardown in a helper would couple three
  independent files together and would run for suites that have no template.

## 8. Canonical repository documents

`CLAUDE.md` is this repository's declared canonical context source. Read it
before changing anything: it governs how work is delivered here, not what the
product does.
