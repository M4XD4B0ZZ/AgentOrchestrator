# V2-07P Platform Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the V2 support contract — Windows, Node major 22 or 24, no UNC or device-namespace repository path — executable and documented, refusing fail-closed before any command action runs, without turning any preflight into an authority the lease effects lean on.

**Architecture:** Three layers, kept apart on purpose. A pure evaluator (`src/platform/runtime-support.ts`) decides support from two process-constant facts and nothing else. A Commander `preAction` hook in `src/cli/index.ts` enforces it by writing synchronously to fd 2 and terminating. Path shape is classified syntactically inside `deriveExecutionLeaseLocation`. The lease's real filesystem capability check stays exactly where it is — at the hard-link effect — and this slice does not touch it.

**Tech Stack:** TypeScript 7 (ESM, `nodenext`), Commander 15, vitest 4, plain-`.mjs` dist-artefact harnesses, GitHub Actions on `windows-latest`.

**Spec:** `docs/superpowers/specs/2026-08-14-v2-07p-platform-contract-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Supported Node majors are the whitelist `[22, 24]`.** Never a floor. `>= 22` is wrong: it admits 23 and 25.
- **Supported platform is `win32` only.**
- **Refusal order is fixed:** write the complete message to fd 2 synchronously → terminate with exit code 6 → no command action may begin.
- `--help`, `--version` and `help <command>` must keep working on an unsupported runtime, at every nesting level.
- **No filesystem measurement in the runtime gate.** No `GetDriveType`, no `net use`, no NTFS probe. Nothing added here may read as "the filesystem was checked at startup, so this effect is safe".
- **No POSIX code is deleted in this slice.** `exec.ts`, `path-identity.ts`, `safe-write.ts` and the POSIX profile resolver keep their branches. Out of scope, deliberately.
- **No new recovery, break, or portable fallback.** `putBack`'s copying restore stays.
- Repository delivery policy is `PR_REQUIRED` + `CI_REQUIRED` (`CLAUDE.md`). Never commit to `main`. Branch is `feat/v2-07p-platform-contract`, which already exists and already carries the spec commits.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01BaE9b5RWjuCCPZqapWPSXK
  ```
- Run `npm run typecheck` before every commit. The canonical gate is `npm run verify`; run it at Task 7 and before opening the PR.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/platform/runtime-support.ts` *(create)* | The pure support decision and the Node-version parser. No `process` access, no I/O. |
| `src/cli/runtime-gate.ts` *(create)* | Renders the refusal text (pure) and enforces it (impure, no seams). Kept out of `index.ts` so the pure half is importable by tests without running `main()`. |
| `src/cli/index.ts` *(modify)* | Installs the `preAction` hook. |
| `src/cli/run-exit-codes.ts` *(modify)* | Adds `EXIT_RUNTIME_UNSUPPORTED = 6`, deliberately outside `CliExitCode`. |
| `src/doctor/run-doctor.ts` *(modify)* | Node check becomes whitelist membership; `MINIMUM_NODE_MAJOR` removed. |
| `src/lease/execution-lease.ts` *(modify)* | Path-shape classification; two new failure codes; two new inspection states; dead prose. |
| `src/cli/render-lease.ts` *(modify)* | Sentences for the two new codes and two new states; dead prose. |
| `tests/v2-07p-platform-contract.test.ts` *(create)* | All in-process tests for this slice. |
| `tests/dist-artifact/runtime-gate-preload.cjs` *(create)* | Self-verifying `process.platform` / `process.version` override. |
| `tests/dist-artifact/runtime-gate-dist-artifact.mjs` *(create)* | Real-process positive and negative controls against `dist/cli/index.js`. |
| `package.json` *(modify)* | `engines.node`, two new scripts, `verify` wiring. |
| `.github/workflows/verify.yml` *(modify)* | Node matrix `[22, 24]`. |
| `README.md` *(modify)* | Supported-runtime section, reconciliation of stale platform claims, V2-07P narrative. |

---

### Task 1: The pure runtime-support decision

**Files:**
- Create: `src/platform/runtime-support.ts`
- Create: `tests/v2-07p-platform-contract.test.ts`
- Modify: `src/doctor/run-doctor.ts` (lines 70–71, 91–95, 320–334)
- Modify: `package.json` (`engines.node`)

**Interfaces:**
- Produces: `SUPPORTED_NODE_MAJORS: readonly number[]`; `RUNTIME_SUPPORT_CODES`; `type RuntimeSupportCode`; `type RuntimeSupport`; `evaluateRuntimeSupport(platform: string, nodeVersion: string): RuntimeSupport`; `parseNodeMajor(versionText: string): number | null`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `tests/v2-07p-platform-contract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import {
  evaluateRuntimeSupport,
  parseNodeMajor,
  SUPPORTED_NODE_MAJORS,
} from '../src/platform/runtime-support.js';

describe('the runtime support decision is a whitelist, not a floor', () => {
  // The two rows that matter most are 23 and 25. `includes(major)` and
  // `major >= 22` agree on 21, 22 and 24 and disagree ONLY here, so a suite
  // without them passes against an implementation that silently reverted to a
  // floor — and the contract would then be wider than the document claims with
  // every test still green.
  const cases: ReadonlyArray<readonly [string, string, string | null]> = [
    ['win32', 'v21.7.3', 'RUNTIME_NODE_UNSUPPORTED'],
    ['win32', 'v22.11.0', null],
    ['win32', 'v23.5.0', 'RUNTIME_NODE_UNSUPPORTED'],
    ['win32', 'v24.18.1', null],
    ['win32', 'v25.0.0', 'RUNTIME_NODE_UNSUPPORTED'],
    ['win32', 'not-a-version', 'RUNTIME_NODE_VERSION_UNREADABLE'],
    ['win32', '', 'RUNTIME_NODE_VERSION_UNREADABLE'],
  ];

  for (const [platform, version, expected] of cases) {
    it(`${platform} ${version || '<empty>'} -> ${expected ?? 'supported'}`, () => {
      const result = evaluateRuntimeSupport(platform, version);
      if (expected === null) {
        expect(result.supported).toBe(true);
        return;
      }
      expect(result.supported).toBe(false);
      if (result.supported) return;
      expect(result.code).toBe(expected);
    });
  }

  // Driven at BOTH supported majors so a platform refusal cannot come out of
  // the Node check by accident.
  for (const platform of ['linux', 'darwin', 'freebsd', 'android']) {
    for (const version of ['v22.11.0', 'v24.18.1']) {
      it(`${platform} ${version} -> RUNTIME_PLATFORM_UNSUPPORTED`, () => {
        const result = evaluateRuntimeSupport(platform, version);
        expect(result.supported).toBe(false);
        if (result.supported) return;
        expect(result.code).toBe('RUNTIME_PLATFORM_UNSUPPORTED');
      });
    }
  }

  it('refuses the platform before it reads the version at all', () => {
    // Otherwise an unreadable version on POSIX would report a Node problem to
    // an operator whose actual problem is the operating system.
    const result = evaluateRuntimeSupport('linux', 'not-a-version');
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.code).toBe('RUNTIME_PLATFORM_UNSUPPORTED');
  });

  it('states the supported set as exactly two majors', () => {
    expect([...SUPPORTED_NODE_MAJORS]).toEqual([22, 24]);
  });

  it('parses a major only from a well-formed version', () => {
    expect(parseNodeMajor('v24.18.1')).toBe(24);
    expect(parseNodeMajor('24.18.1')).toBe(24);
    expect(parseNodeMajor('  v22.11.0  ')).toBe(22);
    expect(parseNodeMajor('v24')).toBeNull();
    expect(parseNodeMajor('')).toBeNull();
  });

  it('carries a detail that names what was found and what is supported', () => {
    // The refusal message is the diagnosis, so the detail may not be generic.
    const result = evaluateRuntimeSupport('win32', 'v25.0.0');
    expect(result.supported).toBe(false);
    if (result.supported) return;
    expect(result.detail).toContain('25');
    expect(result.detail).toContain('22');
    expect(result.detail).toContain('24');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-07p-platform-contract.test.ts`
Expected: FAIL — cannot resolve `../src/platform/runtime-support.js`.

- [ ] **Step 3: Write the implementation**

Create `src/platform/runtime-support.ts`:

```ts
/**
 * The V2 runtime support decision, and nothing else.
 *
 * ── Why this may be decided once, at the entry, and trusted afterwards ──────
 *
 * Because both facts it reads are **process-constant**. `process.platform` and
 * `process.version` are fixed by the Node binary that is already running; there
 * is no later moment at which either could answer differently, so checking them
 * once is not a check relocated away from its effect.
 *
 * That reasoning does **not** extend to the filesystem, and nothing here may be
 * read as though it did. Whether the repository's Git common directory can
 * carry a lease is not process-constant, is not consulted here, and stays where
 * it belongs: at the hard-link operation in `lease/execution-lease.ts`, which
 * answers `LEASE_FILESYSTEM_UNSUPPORTED` from the errno the link was refused
 * with. This module measures nothing about any filesystem, which is why it
 * cannot become an authority a later effect leans on — a property of its
 * inputs, not a discipline its callers have to keep.
 *
 * Pure by construction: it reads no `process`, opens no file and starts no
 * child. The caller supplies both facts, which is what makes the whole decision
 * testable in-process against runtimes this machine is not.
 */

/**
 * The supported Node majors. **A whitelist, deliberately not a floor.**
 *
 * `>= 22` would admit 23, 25 and everything after them on a promise nobody has
 * tested. Every member here is measured by CI (`.github/workflows/verify.yml`
 * runs the whole gate against each), so on this axis "enforced" and "verified"
 * are the same set.
 *
 * 24 is a member because it is what the development host runs. A contract that
 * refused the machine the tool is used on would reproduce, on a new axis, the
 * verified/deployed mismatch this slice exists to remove.
 *
 * Typed `readonly number[]` rather than a literal tuple on purpose: no caller
 * needs the `22 | 24` union, and `includes(major)` against a tuple type forces
 * a cast at the one call site whose correctness matters most.
 */
export const SUPPORTED_NODE_MAJORS: readonly number[] = Object.freeze([22, 24]);

/** The supported platform. `process.platform`'s value, not a friendly name. */
export const SUPPORTED_PLATFORM = 'win32';

export const RUNTIME_SUPPORT_CODES = [
  /** Not Windows. */
  'RUNTIME_PLATFORM_UNSUPPORTED',
  /**
   * Windows, but the Node major is outside {@link SUPPORTED_NODE_MAJORS}.
   *
   * Not `..._TOO_OLD`: Node 25 is refused and is not old. A code that
   * misdescribes its own refusal sends an operator to the wrong fix.
   */
  'RUNTIME_NODE_UNSUPPORTED',
  /**
   * The version string could not be read.
   *
   * Its own code, and a refusal rather than a pass: an unknown answer is not a
   * supported one.
   */
  'RUNTIME_NODE_VERSION_UNREADABLE',
] as const;

export type RuntimeSupportCode = (typeof RUNTIME_SUPPORT_CODES)[number];

export type RuntimeSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly code: RuntimeSupportCode;
      /** One sentence naming what was found and what is supported. */
      readonly detail: string;
    };

const SUPPORTED: RuntimeSupport = Object.freeze({ supported: true as const });

function refuse(code: RuntimeSupportCode, detail: string): RuntimeSupport {
  return Object.freeze({ supported: false as const, code, detail });
}

/**
 * The major from a Node version string, or `null` when there is not one.
 *
 * Exported so `doctor/run-doctor.ts` reports on the same reading the gate
 * refuses on. Two parsers would be two contracts.
 */
export function parseNodeMajor(versionText: string): number | null {
  const match = /^v?(\d+)\./.exec(versionText.trim());
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}

/** Whether this runtime is inside the V2 support contract. */
export function evaluateRuntimeSupport(platform: string, nodeVersion: string): RuntimeSupport {
  // Platform first, and that order is load-bearing: an unreadable version on
  // POSIX must report the operating system, which is the operator's actual
  // problem, not a Node problem they would then go and fail to fix.
  if (platform !== SUPPORTED_PLATFORM) {
    return refuse(
      'RUNTIME_PLATFORM_UNSUPPORTED',
      `Detected platform ${platform}; V2 supports ${SUPPORTED_PLATFORM} only.`,
    );
  }

  const major = parseNodeMajor(nodeVersion);
  if (major === null) {
    return refuse(
      'RUNTIME_NODE_VERSION_UNREADABLE',
      `Node reported the version ${JSON.stringify(nodeVersion)}, which could not be read. ` +
        `V2 supports Node ${SUPPORTED_NODE_MAJORS.join(' and ')}.`,
    );
  }

  if (!SUPPORTED_NODE_MAJORS.includes(major)) {
    return refuse(
      'RUNTIME_NODE_UNSUPPORTED',
      `Detected Node major ${major}; V2 supports ${SUPPORTED_NODE_MAJORS.join(' and ')} ` +
        `and nothing else. This is a whitelist, not a minimum.`,
    );
  }

  return SUPPORTED;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/v2-07p-platform-contract.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Point the doctor at the same whitelist**

In `src/doctor/run-doctor.ts`, delete lines 70–71:

```ts
/** Node version the orchestrator requires. */
export const MINIMUM_NODE_MAJOR = 22;
```

Delete the private parser at lines 91–95:

```ts
function parseNodeMajor(versionText: string): number | null {
  const match = /^v?(\d+)\./.exec(versionText.trim());
  if (match?.[1] === undefined) return null;
  return Number.parseInt(match[1], 10);
}
```

Add to the import block (after the `./report.js` import ending at line 68):

```ts
import { parseNodeMajor, SUPPORTED_NODE_MAJORS } from '../platform/runtime-support.js';
```

Replace the check at lines 325–334 with:

```ts
  checks.push({
    id: 'env:node-version',
    title: `Node.js ${SUPPORTED_NODE_MAJORS.join(' or ')}`,
    // Membership, not `>=`. Left as a floor this would report PASS for Node 25
    // on a build whose entry gate refuses it — the tool contradicting itself in
    // the one command whose whole job is to describe the environment.
    status: nodeMajor !== null && SUPPORTED_NODE_MAJORS.includes(nodeMajor) ? 'PASS' : 'FAIL',
    mandatory: true,
    detail:
      nodeMajor === null
        ? 'Node version could not be determined.'
        : `Detected major version ${nodeMajor}; supported: ${SUPPORTED_NODE_MAJORS.join(', ')}.`,
  });
```

- [ ] **Step 6: Narrow the declared engine range**

In `package.json`, replace:

```json
  "engines": {
    "node": ">=22"
  },
```

with:

```json
  "engines": {
    "node": "22.x || 24.x"
  },
```

`">=22"` states a wider contract than the build enforces, and `engines` is the field other tooling reads.

- [ ] **Step 7: Run typecheck and the full in-process suite**

Run: `npm run typecheck`
Expected: clean — this is what proves no other module still imports `MINIMUM_NODE_MAJOR`.

Run: `npx vitest run tests/v2-07p-platform-contract.test.ts tests/doctor.test.ts`
Expected: PASS. `tests/doctor.test.ts:176` builds its own check object with the title `'Node.js >= 22'` and asserts the *renderer* echoes it; it does not read the real title, so it is unaffected. If it fails, the renderer is being tested through the producer and that is a separate defect — report it rather than editing the fixture to match.

- [ ] **Step 8: Commit**

```bash
git add src/platform/runtime-support.ts tests/v2-07p-platform-contract.test.ts src/doctor/run-doctor.ts package.json
git commit
```

Message:

```
feat: the V2 runtime support decision, as a whitelist (V2-07P)

Windows and Node major 22 or 24. A whitelist rather than a floor, because
`>= 22` enforces a contract wider than CI proves: 23 and 25 are the only
inputs on which the two disagree, and both are pinned. The doctor now reports
membership of the same set rather than a minimum, so the command whose job is
to describe the environment cannot contradict the gate that refuses it.
```

---

### Task 2: The entry gate

**Files:**
- Create: `src/cli/runtime-gate.ts`
- Modify: `src/cli/run-exit-codes.ts` (after line 41)
- Modify: `src/cli/index.ts` (imports; `buildProgram`)
- Modify: `tests/v2-07p-platform-contract.test.ts`

**Interfaces:**
- Consumes: `evaluateRuntimeSupport`, `RuntimeSupport` (Task 1).
- Produces: `EXIT_RUNTIME_UNSUPPORTED = 6`; `renderRuntimeRefusal(support, platform, nodeVersion): string`; `enforceSupportedRuntime(): void`.

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-07p-platform-contract.test.ts`:

```ts
import { EXIT_RUNTIME_UNSUPPORTED } from '../src/cli/run-exit-codes.js';
import { renderRuntimeRefusal } from '../src/cli/runtime-gate.js';

describe('the runtime refusal is the diagnosis', () => {
  const refusal = (platform: string, version: string): string => {
    const support = evaluateRuntimeSupport(platform, version);
    expect(support.supported).toBe(false);
    if (support.supported) throw new Error('unreachable');
    return renderRuntimeRefusal(support, platform, version);
  };

  it('names what was found, on both axes', () => {
    const text = refusal('linux', 'v22.11.0');
    expect(text).toContain('linux');
    expect(text).toContain('v22.11.0');
  });

  it('names the supported configuration', () => {
    const text = refusal('linux', 'v22.11.0');
    expect(text).toContain('Windows');
    expect(text).toContain('22');
    expect(text).toContain('24');
  });

  it('says that nothing was started', () => {
    // An operator who cannot tell whether the tool half-ran will go looking for
    // state that does not exist.
    expect(refusal('linux', 'v22.11.0')).toContain('Nothing was started');
  });

  it('tells the operator what still works here', () => {
    const text = refusal('win32', 'v25.0.0');
    expect(text).toContain('--help');
    expect(text).toContain('--version');
  });

  it('carries the code and the detail from the decision', () => {
    expect(refusal('win32', 'v25.0.0')).toContain('RUNTIME_NODE_UNSUPPORTED');
    expect(refusal('win32', 'nonsense')).toContain('RUNTIME_NODE_VERSION_UNREADABLE');
  });

  it('ends with a newline, so a terminal does not eat the last line', () => {
    expect(refusal('linux', 'v22.11.0').endsWith('\n')).toBe(true);
  });

  it('uses an exit code no run outcome uses', () => {
    expect(EXIT_RUNTIME_UNSUPPORTED).toBe(6);
  });
});

describe('the gate does not disturb the supported path', () => {
  it('lets a command action run on this (supported) runtime', async () => {
    // The in-process positive control. Its counterpart — that an action does
    // NOT run on an unsupported runtime — cannot be measured in-process,
    // because the gate terminates the process; that half is
    // tests/dist-artifact/runtime-gate-dist-artifact.mjs.
    expect(process.platform).toBe('win32');
    const { buildProgram } = await import('../src/cli/index.js');
    const program = buildProgram();
    program.exitOverride();

    const written: string[] = [];
    program.configureOutput({
      writeOut: (text) => written.push(text),
      writeErr: (text) => written.push(text),
    });

    await program.parseAsync(
      ['node', 'agent-loop', 'lease', 'status', '--repository', 'definitely-not-a-repository'],
      { from: 'user' },
    );

    // The action ran: this marker can only come from lease-command.ts's own
    // resolution failure path, which sits after the hook.
    expect(written.join('')).toContain('could not be resolved');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-07p-platform-contract.test.ts`
Expected: FAIL — cannot resolve `../src/cli/runtime-gate.js`, and `EXIT_RUNTIME_UNSUPPORTED` is not exported.

- [ ] **Step 3: Add the exit code**

In `src/cli/run-exit-codes.ts`, after line 41 (`export const EXIT_RUN_CALL_AGAIN = 5;`) add:

```ts
/**
 * The runtime is outside the V2 support contract, so no command ran.
 *
 * Housed here because this is where every exit code this binary can produce
 * lives, and a code allocated anywhere else is a code that eventually collides.
 *
 * **Deliberately not a member of {@link CliExitCode}.** That union is the
 * exit-code contract of `agent-loop run` — the codomain of three total mappings
 * from run outcomes — and this is not a run outcome. It is a refusal that
 * happens *before* any command begins, on a machine where no run is possible at
 * all. Folding it into the union would invite a future outcome to be mapped
 * onto it, which would tell an operator their task failed when in fact their
 * runtime was never supported.
 */
export const EXIT_RUNTIME_UNSUPPORTED = 6;
```

- [ ] **Step 4: Write the gate**

Create `src/cli/runtime-gate.ts`:

```ts
/**
 * The V2 runtime gate: the one place this build refuses to run at all.
 *
 * Split from `index.ts` so the *rendering* half can be imported by a test
 * without also importing the module that calls `main()` at load time.
 *
 * ── What this does not do ──────────────────────────────────────────────────
 *
 * It measures nothing about any filesystem, and it grants nothing. It reads two
 * process-constant facts, and it can only ever *narrow* what runs. Nothing
 * downstream may treat "the gate did not refuse" as evidence about a
 * repository, a volume or a lease — the lease proves its own capability at the
 * link that needs it, and this module is not part of that argument.
 */

import {
  evaluateRuntimeSupport,
  SUPPORTED_NODE_MAJORS,
  type RuntimeSupport,
} from '../platform/runtime-support.js';
import { EXIT_RUNTIME_UNSUPPORTED } from './run-exit-codes.js';

type RuntimeRefusal = Extract<RuntimeSupport, { supported: false }>;

/**
 * The whole refusal, as text. Pure.
 *
 * Everything an operator gets on an unsupported machine is this string, so it
 * has to answer three questions without a follow-up command: what is this
 * machine, what would be supported, and did anything happen.
 */
export function renderRuntimeRefusal(
  refusal: RuntimeRefusal,
  platform: string,
  nodeVersion: string,
): string {
  return (
    `agent-loop: unsupported runtime. Nothing was started.\n` +
    `\n` +
    `  Detected  : ${platform}, Node ${nodeVersion}\n` +
    `  Supported : Windows, Node ${SUPPORTED_NODE_MAJORS.join(' or ')}\n` +
    `  Refusal   : ${refusal.code}\n` +
    `\n` +
    `  ${refusal.detail}\n` +
    `\n` +
    `V2 of this orchestrator is built and verified for one configuration:\n` +
    `Windows, Node ${SUPPORTED_NODE_MAJORS.join(' or ')}, and a repository whose Git\n` +
    `common directory is on a local NTFS volume. FAT and exFAT, SMB and other\n` +
    `network filesystems, UNC-hosted repository storage and POSIX runtimes are\n` +
    `outside that contract, and this build refuses rather than running unverified.\n` +
    `\n` +
    `\`--help\` and \`--version\` still work here. No other command does.\n`
  );
}

/**
 * Refuse, completely, if this runtime is outside the contract.
 *
 * Returns normally when it is inside; never returns when it is not.
 *
 * **No injection seams.** A substitutable platform or version would be a seam
 * whose only power is to make this function *not* refuse, which is the one
 * direction a gate may never be moved from a test. The decision it acts on is
 * `evaluateRuntimeSupport`, which is pure and exhaustively tested; what is left
 * here is one read, one write loop and one exit, and those are measured against
 * the built artefact by `tests/dist-artifact/runtime-gate-dist-artifact.mjs`.
 */
export function enforceSupportedRuntime(): void {
  const support = evaluateRuntimeSupport(process.platform, process.version);
  if (support.supported) return;

  writeAllSync(renderRuntimeRefusal(support, process.platform, process.version));
  process.exit(EXIT_RUNTIME_UNSUPPORTED);
}

/**
 * Write every byte to fd 2 before returning.
 *
 * Not `process.stderr.write`. On Windows a stderr that is a pipe — a test
 * harness, a CI log, any `2>` redirection — is written asynchronously, and the
 * `process.exit` that follows can discard a buffered tail. "The refusal message
 * is the diagnosis" is only true if the whole message survives; a truncated one
 * is a build that refuses without saying why.
 *
 * The loop is the mechanism, not a formality: `writeSync` may report a short
 * count, and a single call is a message that is *usually* complete.
 */
function writeAllSync(text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(2, bytes, written, bytes.length - written);
    } catch (error) {
      // EAGAIN on a non-blocking pipe is the one condition worth retrying; any
      // other failure means stderr cannot be written at all, and looping on it
      // would hang the refusal instead of delivering it. Exit anyway: refusing
      // silently is bad, refusing forever is worse.
      if ((error as NodeJS.ErrnoException).code === 'EAGAIN') continue;
      return;
    }
  }
}
```

Add at the top of the import block:

```ts
import { writeSync } from 'node:fs';
```

- [ ] **Step 5: Install the hook**

In `src/cli/index.ts`, add to the imports:

```ts
import { enforceSupportedRuntime } from './runtime-gate.js';
```

In `buildProgram`, immediately after the `.showSuggestionAfterError(true);` chain (line 64) and **before** the `registerDoctorCommand(program);` line, add:

```ts
  // The V2 runtime gate. `preAction` runs after Commander has parsed, so
  // `--help` and `--version` — which Commander resolves during parse — are
  // still reachable on a machine this build refuses to run on. Refusing to
  // print help is not a safety property, and the operator who most needs the
  // help output is exactly the one whose runtime is unsupported.
  //
  // Whether this hook is inherited by nested subcommands (`lease status`) is a
  // property of Commander that is *measured* rather than assumed, by
  // tests/dist-artifact/runtime-gate-dist-artifact.mjs. If a future Commander
  // stops inheriting it, that harness fails on the nested case rather than this
  // gate quietly covering only the top level.
  program.hook('preAction', () => {
    enforceSupportedRuntime();
  });
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/v2-07p-platform-contract.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Confirm the gate did not break the existing suite**

Run: `npm run test:foundation-safe`
Expected: PASS.

Two files import `src/cli/index.js`, which calls `main()` at module load: `tests/v2-07l-execution-lease.test.ts:1081` and `tests/v2-07lr-lease-recovery.test.ts:600`. On this host the runtime is supported, so the hook returns and nothing changes. Note for the record, and for anyone who later runs the suite on an unsupported runtime: there the gate would terminate the vitest worker, which is correct behaviour reported confusingly. Do not add a test-mode escape hatch for it — an environment variable that switches the gate off is the back door the whole slice exists to not have.

- [ ] **Step 8: Commit**

```bash
git add src/cli/runtime-gate.ts src/cli/run-exit-codes.ts src/cli/index.ts tests/v2-07p-platform-contract.test.ts
git commit
```

Message:

```
feat: refuse an unsupported runtime before any command action (V2-07P)

Every action refuses, doctor included: a build that is officially Windows-only
while shipping a product path that still executes on POSIX has a soft contract.
Help and version stay reachable, because refusing to print help is not a safety
property.

The refusal is ordered — the complete message to fd 2 synchronously, then
terminate. A buffered write followed by a hard exit can drop its tail on a
Windows pipe, and a truncated refusal is a build that refuses without saying
why. The exit code is deliberately outside CliExitCode: it is not a run
outcome, and a future outcome mapped onto it would tell an operator their task
failed when their runtime was never supported.
```

---

### Task 3: UNC and device paths are refused, and say which they are

**Files:**
- Modify: `src/lease/execution-lease.ts` (lines 288–339, 456–473, 513–517, 621–645, ~913)
- Modify: `src/cli/render-lease.ts` (lines 33–84)
- Modify: `tests/v2-07lr-lease-recovery.test.ts` (lines 418–452)
- Modify: `tests/v2-07p-platform-contract.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2.
- Produces: `type LeaseLocationFailureCode`; the acquire codes `LEASE_LOCATION_NETWORK_UNSUPPORTED` and `LEASE_LOCATION_DEVICE_NAMESPACE`; the inspection states `LOCATION_NETWORK_UNSUPPORTED` and `LOCATION_DEVICE_NAMESPACE`.

> **Measured premise.** Against the current build on this host,
> `\\server\share\repo\.git`, `\\?\UNC\server\share\r` and `\\.\PhysicalDrive0`
> are all **accepted** today. This task removes a real acceptance, not a
> theoretical one.

- [ ] **Step 1: Write the failing test**

Append to `tests/v2-07p-platform-contract.test.ts`:

```ts
import {
  deriveExecutionLeaseLocation,
  inspectRepositoryExecutionLease,
} from '../src/lease/execution-lease.js';
import { LEASE_ACQUIRE_SENTENCES, LEASE_STATE_SENTENCES } from '../src/cli/render-lease.js';

describe('the lease location refuses network and device paths, and says which', () => {
  const derive = (key: string) =>
    deriveExecutionLeaseLocation({ gitCommonDir: key, root: 'C:\\repo', id: 'shape' });

  const refused: ReadonlyArray<readonly [string, string]> = [
    ['\\\\server\\share\\repo\\.git', 'LEASE_LOCATION_NETWORK_UNSUPPORTED'],
    ['//server/share/repo/.git', 'LEASE_LOCATION_NETWORK_UNSUPPORTED'],
    ['\\\\?\\UNC\\server\\share\\repo\\.git', 'LEASE_LOCATION_NETWORK_UNSUPPORTED'],
    ['\\\\?\\unc\\server\\share\\repo\\.git', 'LEASE_LOCATION_NETWORK_UNSUPPORTED'],
    ['\\\\.\\PhysicalDrive0', 'LEASE_LOCATION_DEVICE_NAMESPACE'],
    ['\\\\.\\C:\\repo\\.git', 'LEASE_LOCATION_DEVICE_NAMESPACE'],
    ['\\repo\\.git', 'LEASE_LOCATION_UNSUITABLE'],
    ['/repo/.git', 'LEASE_LOCATION_UNSUITABLE'],
    ['\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\r', 'LEASE_LOCATION_UNSUITABLE'],
  ];

  for (const [key, code] of refused) {
    it(`${key} -> ${code}`, () => {
      const derived = derive(key);
      expect(derived.ok).toBe(false);
      if (derived.ok) return;
      // The specific code, never merely `ok === false`: a refusal that
      // misdescribes itself is worse than a verbose one, and the whole point of
      // splitting these classes is that they are told apart.
      expect(derived.code).toBe(code);
    });
  }

  // The control against an over-broad refusal. Without it, an implementation
  // that refuses every Windows path passes every case above.
  for (const key of ['C:\\repo\\.git', 'c:/repo/.git', '\\\\?\\C:\\repo\\.git']) {
    it(`${key} is still accepted`, () => {
      expect(derive(key).ok).toBe(true);
    });
  }

  it('an extended-length drive path is accepted without claiming the volume is local', () => {
    // Stated as a test because it is the ACCEPTED LIMIT: a drive letter can be
    // a mapped network share in either form, and neither is detected.
    const extended = derive('\\\\?\\C:\\repo\\.git');
    const plain = derive('C:\\repo\\.git');
    expect(extended.ok).toBe(true);
    expect(plain.ok).toBe(true);
  });
});

describe('lease status describes the refusal it actually met', () => {
  const inspect = (key: string) =>
    inspectRepositoryExecutionLease({ gitCommonDir: key, root: 'C:\\repo', id: 'shape' });

  it('reports a network path as such, not as "no location could be derived"', () => {
    expect(inspect('\\\\server\\share\\repo\\.git').state).toBe('LOCATION_NETWORK_UNSUPPORTED');
  });

  it('reports a device path as such', () => {
    expect(inspect('\\\\.\\PhysicalDrive0').state).toBe('LOCATION_DEVICE_NAMESPACE');
  });

  it('still reports an underivable location as underivable', () => {
    expect(inspect('\\repo\\.git').state).toBe('LOCATION_UNSUITABLE');
  });
});

describe('every new code carries its own sentence', () => {
  it('names the network refusal as network storage outside the contract', () => {
    const sentence = LEASE_ACQUIRE_SENTENCES.LEASE_LOCATION_NETWORK_UNSUPPORTED;
    expect(sentence).toMatch(/UNC|network/i);
    expect(sentence).not.toContain('No lease location could be derived');
  });

  it('names the device refusal without calling it UNC', () => {
    const sentence = LEASE_ACQUIRE_SENTENCES.LEASE_LOCATION_DEVICE_NAMESPACE;
    expect(sentence).toMatch(/device/i);
    expect(sentence).not.toMatch(/UNC/);
  });

  it('gives each new inspection state a distinct sentence', () => {
    const sentences = [
      LEASE_STATE_SENTENCES.LOCATION_UNSUITABLE,
      LEASE_STATE_SENTENCES.LOCATION_NETWORK_UNSUPPORTED,
      LEASE_STATE_SENTENCES.LOCATION_DEVICE_NAMESPACE,
    ];
    expect(new Set(sentences).size).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/v2-07p-platform-contract.test.ts`
Expected: FAIL — UNC and device paths currently derive successfully; the new codes and states do not exist.

- [ ] **Step 3: Classify the path shape**

In `src/lease/execution-lease.ts`, replace the `LeaseLocationFailure` interface (lines 296–299) with:

```ts
/**
 * Why no lease location exists for a repository. A closed set.
 *
 * Three codes rather than one, following the reasoning already recorded for
 * `REPOSITORY_RECORD_INCOHERENT` below: a refusal that misdescribes itself is
 * worse than a verbose one. `LEASE_LOCATION_UNSUITABLE`'s sentence says no
 * location could be derived, which is plainly false for a UNC path that
 * resolves perfectly well and is refused because V2 does not support network
 * storage.
 */
export type LeaseLocationFailureCode =
  | 'LEASE_LOCATION_UNSUITABLE'
  | 'LEASE_LOCATION_NETWORK_UNSUPPORTED'
  | 'LEASE_LOCATION_DEVICE_NAMESPACE';

export interface LeaseLocationFailure {
  readonly ok: false;
  readonly code: LeaseLocationFailureCode;
}
```

Replace the Windows check at lines 316–333 with:

```ts
  const shapeFailure = classifyWindowsKey(key);
  if (shapeFailure !== null) {
    return Object.freeze({ ok: false as const, code: shapeFailure });
  }
  return Object.freeze({
    ok: true as const,
    path: join(key, EXECUTION_LEASE_FILE_NAME),
    key,
  });
}

/**
 * Which V2 path class this key is, or `null` when it is one V2 supports.
 *
 * Purely syntactic: no filesystem is consulted, nothing is measured, and the
 * answer for a given string never changes. That is what keeps it out of the
 * class of check that has to sit at its effect — and it is *not* a statement
 * about the volume. A drive letter can be a mapped network share, in the plain
 * and the extended form alike, and neither is detected here or anywhere else in
 * this build. See the ACCEPTED LIMIT in README's supported-runtime section; the
 * real protection for that case is the link refusal at the acquire effect.
 *
 * ── Why `isAbsolute` is not enough, and which case it does catch ───────────
 *
 * `isAbsolute` answers `false` for a genuinely **drive-relative** key —
 * `C:repo\.git`, relative to the current directory of that drive — so line 313
 * above already refuses that one. What it answers `true` for, and this function
 * must refuse, is a **root-relative** key: `\foo`, and `/foo` which normalises
 * to the same thing, absolute only within whichever volume the process happens
 * to be standing on. One such key could denote two places, which is two
 * repositories sharing one lease or one repository holding two. (`F-4` in the
 * README records the same gap for `core/path-identity.ts`, where the value is
 * only ever a comparison operand and the gap stays open.)
 *
 * Refusing only ever narrows, so nothing here can make reachable what was not.
 */
function classifyWindowsKey(key: string): LeaseLocationFailureCode | null {
  // One normalisation, because every rule below is about shape and none of them
  // is about which separator character was used. Windows accepts both.
  const shape = key.replace(/\//g, '\\');

  if (shape.startsWith('\\\\?\\')) {
    // The extended-length namespace carries both a local and a network form.
    if (/^\\\\\?\\UNC\\/i.test(shape)) return 'LEASE_LOCATION_NETWORK_UNSUPPORTED';
    if (/^\\\\\?\\[A-Za-z]:\\/.test(shape)) return null;
    // `\\?\Volume{…}` and anything else in that namespace: not refused as
    // network, not accepted either. V2 supports the drive-letter forms, and a
    // shape nobody has verified is not one of them.
    return 'LEASE_LOCATION_UNSUITABLE';
  }

  // `\\.\…` — the device namespace. Its own code: subsuming it under "UNC"
  // would make the network code as imprecise as the one it replaces.
  if (shape.startsWith('\\\\.\\')) return 'LEASE_LOCATION_DEVICE_NAMESPACE';

  // `\\server\share\…` — plain UNC.
  if (/^\\\\[^\\]/.test(shape)) return 'LEASE_LOCATION_NETWORK_UNSUPPORTED';

  // `C:\…` — the supported shape, and the only one.
  if (/^[A-Za-z]:\\/.test(shape)) return null;

  // Root-relative, and anything else `isAbsolute` let through.
  return 'LEASE_LOCATION_UNSUITABLE';
}
```

Note the platform condition is gone. It was `process.platform === 'win32' && …`; under the V2 contract there is no other platform, the classification is deterministic on any host, and it only ever narrows — so a branch that skipped it was a branch that could only widen.

- [ ] **Step 4: Forward the code instead of re-deriving one**

At line ~913, replace:

```ts
  if (!location.ok) return acquireFailure('LEASE_LOCATION_UNSUITABLE');
```

with:

```ts
  // The code the derivation produced, not a fresh one. Collapsing three
  // distinct refusals into the vaguest of them is the defect this slice removes
  // one layer up; re-introducing it here would put it back.
  if (!location.ok) return acquireFailure(location.code);
```

- [ ] **Step 5: Add the two acquire codes**

In `LEASE_ACQUIRE_FAILURE_CODES` (line 621), after the `'LEASE_LOCATION_UNSUITABLE'` entry, add:

```ts
  /**
   * The repository's Git common directory is on an explicitly unsupported
   * UNC/network path.
   *
   * A location was derived perfectly well; V2 does not support network storage
   * for it. Its own code rather than {@link LEASE_LOCATION_UNSUITABLE} for the
   * reason recorded on `REPOSITORY_RECORD_INCOHERENT`: that code's sentence
   * says no location could be derived, and `lease status` would print a path
   * for the very same repository.
   */
  'LEASE_LOCATION_NETWORK_UNSUPPORTED',
  /**
   * The key is in the Windows device namespace (`\\.\…`).
   *
   * Kept apart from the network code deliberately. A device path is not network
   * storage, and one code covering both would be exactly the over-broad refusal
   * this vocabulary exists to avoid.
   */
  'LEASE_LOCATION_DEVICE_NAMESPACE',
```

- [ ] **Step 6: Add the two inspection states**

In `LEASE_STATES` (line 456), after the `'LOCATION_UNSUITABLE'` entry, add:

```ts
  /** The location is a UNC/network path, which V2 does not support. */
  'LOCATION_NETWORK_UNSUPPORTED',
  /** The location is in the Windows device namespace. */
  'LOCATION_DEVICE_NAMESPACE',
```

Because `LEASE_STATE_SENTENCES` is typed `Record<LeaseInspection['state'], string>`, this is a compile error until Step 8 supplies both sentences. That is the mechanism working: the vocabulary cannot grow a member nobody described.

Introduce a name for the location states and use it in `ReadLease` (line 514), which must exclude all three:

```ts
/** The states that mean "there is no lease path", as opposed to what is at one. */
export type LeaseLocationState =
  | 'LOCATION_UNSUITABLE'
  | 'LOCATION_NETWORK_UNSUPPORTED'
  | 'LOCATION_DEVICE_NAMESPACE';

interface ReadLease {
  readonly state: Exclude<LeaseState, LeaseLocationState>;
  readonly bytes: Buffer | null;
  readonly document: ExecutionLease | null;
}
```

- [ ] **Step 7: Carry the code into the inspection**

In `inspectRepositoryExecutionLease` (line 569), replace:

```ts
  if (!location.ok) {
    return inspection({ state: 'LOCATION_UNSUITABLE', path: '' });
  }
```

with:

```ts
  if (!location.ok) {
    // The state that matches the refusal, so `lease status` and a refused
    // `run --attended` tell an operator the same story about the same
    // repository. Reporting "no location could be derived" for a UNC path the
    // tool understood perfectly well is the misdescription this slice removes.
    return inspection({ state: LOCATION_STATE_FOR[location.code], path: '' });
  }
```

and add above the function:

```ts
/** One inspection state per location failure. Total by type. */
const LOCATION_STATE_FOR: Readonly<Record<LeaseLocationFailureCode, LeaseLocationState>> =
  Object.freeze({
    LEASE_LOCATION_UNSUITABLE: 'LOCATION_UNSUITABLE',
    LEASE_LOCATION_NETWORK_UNSUPPORTED: 'LOCATION_NETWORK_UNSUPPORTED',
    LEASE_LOCATION_DEVICE_NAMESPACE: 'LOCATION_DEVICE_NAMESPACE',
  });
```

- [ ] **Step 8: Write the sentences**

In `src/cli/render-lease.ts`, add to `LEASE_ACQUIRE_SENTENCES` (after the `LEASE_LOCATION_UNSUITABLE` entry, line 50):

```ts
    LEASE_LOCATION_NETWORK_UNSUPPORTED:
      "This repository's Git common directory is on a UNC or network path, which is outside\n" +
      '  the V2 support contract. Nothing was started and nothing was created. V2 is built and\n' +
      '  verified for one configuration: Windows, Node 22 or 24, and a repository whose Git\n' +
      '  common directory is on a local NTFS volume. Move the repository, or its Git common\n' +
      '  directory, onto a local volume. Note what this refusal does not claim: a repository\n' +
      '  reached through a drive letter is accepted, and this build cannot tell whether such a\n' +
      '  letter is a mapped network share.',
    LEASE_LOCATION_DEVICE_NAMESPACE:
      "This repository's Git common directory is a Windows device path (\\\\.\\...), which is\n" +
      '  not a filesystem location a lease can be kept in. Nothing was started and nothing was\n' +
      '  created. This is reported apart from the network refusal because it is a different\n' +
      '  thing: a device path is not network storage.',
```

Add to `LEASE_STATE_SENTENCES` (after `LOCATION_UNSUITABLE`, line 83):

```ts
    LOCATION_NETWORK_UNSUPPORTED:
      'This repository is on a UNC or network path, which V2 does not support, so it has no\n' +
      '  lease location. This is a refusal, not a failure to understand the path.',
    LOCATION_DEVICE_NAMESPACE:
      'This repository path is in the Windows device namespace, which is not a place a lease\n' +
      '  can be kept.',
```

- [ ] **Step 9: Re-base the existing control, which this slice inverts**

`tests/v2-07lr-lease-recovery.test.ts:435-452` currently asserts that a UNC key **derives a location**. That assertion is the contract this task changes, so it is rewritten rather than deleted — the *control* it provides (a refusal broad enough to catch root-relative keys would catch every Windows path) is still needed. Replace lines 418–452 with:

```ts
  onWindows('refuses a root-relative Git common directory', () => {
    // The premise, asserted rather than asserted-about: without the extra check
    // this key passes the absolute test and a lease path is derived from it.
    //
    // "Root-relative", not "drive-relative": `\foo` is absolute within whichever
    // volume the process is standing on. The genuinely drive-relative form is
    // `C:foo`, and `isAbsolute` already refuses that one a few lines earlier —
    // so the two are caught by different guards and naming them alike sent a
    // reader to the wrong one.
    expect(isAbsolute('\\repo\\.git')).toBe(true);
    expect(isAbsolute('C:repo\\.git')).toBe(false);

    for (const key of ['\\repo\\.git', '/repo/.git', '\\', '/']) {
      const derived = deriveExecutionLeaseLocation({
        gitCommonDir: key,
        root: 'C:\\repo',
        id: 'root-relative',
      });
      expect(derived.ok).toBe(false);
      if (derived.ok) return;
      expect(derived.code).toBe('LEASE_LOCATION_UNSUITABLE');
    }
  });

  onWindows('still derives a location for the two shapes V2 supports', () => {
    // The control. A refusal broad enough to catch the root-relative case is a
    // refusal that can quietly catch every Windows path, and a suite without
    // this case would pass against one that refuses them all.
    //
    // This used to include a UNC key and assert it derived. V2-07P withdrew
    // that: UNC is network storage and is outside the support contract, so the
    // control now stands on the two drive-letter forms.
    for (const key of ['C:\\repo\\.git', '\\\\?\\C:\\repo\\.git']) {
      const derived = deriveExecutionLeaseLocation({
        gitCommonDir: key,
        root: 'C:\\repo',
        id: 'volume',
      });
      expect(derived.ok).toBe(true);
    }
  });
```

- [ ] **Step 10: Run the tests**

Run: `npx vitest run tests/v2-07p-platform-contract.test.ts tests/v2-07lr-lease-recovery.test.ts tests/v2-07l-execution-lease.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 11: Run the whole in-process suite**

Run: `npm run test:foundation-safe`
Expected: PASS. If another test asserts a UNC location derives, it is asserting the contract this task changes — rewrite it the way Step 9 rewrote its neighbour, preserving whatever control it was providing, and say so in the commit message.

- [ ] **Step 12: Commit**

```bash
git add src/lease/execution-lease.ts src/cli/render-lease.ts tests/v2-07p-platform-contract.test.ts tests/v2-07lr-lease-recovery.test.ts
git commit
```

Message:

```
feat: refuse network and device repository paths, by their own names (V2-07P)

Measured before changing: \\server\share, \\?\UNC\... and \\.\... were all
accepted by the shipped build. This removes a real acceptance.

Two codes, not one. A device path is not network storage, and one code for
both would be the over-broad refusal this vocabulary exists to avoid - the
same argument REPOSITORY_RECORD_INCOHERENT already records against folding
itself into LEASE_LOCATION_UNSUITABLE. Both reach `lease status` too, as
inspection states, so the status command and a refused run tell an operator
the same story rather than "no location could be derived" about a path the
tool understood perfectly well.

The refusal claims only what it can: a drive letter is accepted, and this
build cannot tell whether one is a mapped network share.

The existing UNC control asserted the opposite contract and is re-based onto
the two drive-letter shapes rather than deleted - it is what stops a refusal
from quietly catching every Windows path.
```

---

### Task 4: Prose that names things that no longer exist, or never did

**Files:**
- Modify: `src/lease/execution-lease.ts` (lines ~506, ~1273, ~1356 — line numbers shift after Task 3; find by quoted text)
- Modify: `src/cli/render-lease.ts` (line ~121)
- Modify: `README.md` (the F-4 entry, ~line 2862)

No test changes: this task changes no behaviour. It is separated from Task 3 so a reviewer can accept the mechanism and judge the prose independently.

- [ ] **Step 1: Retarget the broken `@link`**

In `src/lease/execution-lease.ts`, find:

```
   * empty object has the same digest. See {@link leaseObjectIdentity}. An
```

Replace with:

```
   * empty object has the same digest. See {@link readObject}, which produces
   * this value. An
```

- [ ] **Step 2: Correct the sentence that is actively false**

Find:

```
 * accidentally share; `leaseObjectIdentity` remains, for `lease status` to report.
```

Replace with:

```
 * accidentally share. The object identity is still *reported* — `lease status`
 * prints it — but no function by that name remains: the inspection reads
 * {@link readObject} directly. An exported reader of exactly the value a
 * withdrawn authority rested on is the affordance that authority leaves behind.
```

This sentence claimed a function existed after it had been removed. It is the one correction in this task that a reader could have acted on.

- [ ] **Step 3: Make the historical reference unmistakably historical**

Find:

```
  // The decision, on the object this call detached rather than on the name it
  // came from. The predicate is handed the bytes and nothing else: it used to
  // also receive `leaseObjectIdentity(quarantine)`, which was the attended
  // break's authority and is now no caller's.
```

Replace with:

```
  // The decision, on the object this call detached rather than on the name it
  // came from. The predicate is handed the bytes and nothing else: it used to
  // also receive the quarantined file's `(dev,ino)` identity, read by a
  // since-removed `leaseObjectIdentity` helper. That was the attended break's
  // authority; the break is withdrawn and so is the helper, and neither name
  // resolves to anything in this build.
```

Kept as history rather than deleted: it is the reason the predicate has the shape it has, and a removed citation takes its reasoning with it.

- [ ] **Step 4: Reattribute the reasoning in the renderer**

In `src/cli/render-lease.ts`, find:

```
 * which contradicts `leaseObjectIdentity`'s own reasoning that content cannot
 * identify an object whose content is nothing.
```

Replace with:

```
 * which contradicts the reasoning recorded on `readObject` in
 * `lease/execution-lease.ts` — that content cannot identify an object whose
 * content is nothing.
```

- [ ] **Step 5: Correct the path class in the F-4 entry**

In `README.md`, find:

```
- **F-4** — on Windows `isAbsolute` accepts a drive-relative root (`\foo`), so
```

Replace with:

```
- **F-4** — on Windows `isAbsolute` accepts a root-relative path (`\foo` —
  absolute within whichever volume the process is standing on), so
```

The genuinely drive-relative form is `C:foo`, which `isAbsolute` refuses. The two are caught by different guards, and V2-07P corrected the same mislabel in `execution-lease.ts`; leaving it here would leave the follow-up register pointing at the wrong mechanism.

- [ ] **Step 6: Prove no live citation remains**

Run: `git grep -n "leaseObjectIdentity" -- src/ README.md`
Expected: only the two historical mentions — the "Not exported, and that is the point" block, and the `removeVerifiedLease` comment from Step 3 — and each one explicitly says the name no longer resolves.

Run: `npm run typecheck && npx vitest run tests/v2-07lr-enoent-window.test.ts`
Expected: clean, PASS. (`tests/v2-07lr-enoent-window.test.ts:155-158` already documents the removal; it needs no change.)

- [ ] **Step 7: Commit**

```bash
git add src/lease/execution-lease.ts src/cli/render-lease.ts README.md
git commit
```

Message:

```
docs: stop naming a function that was removed, and a path class that is wrong
(V2-07P)

Four references outlived `leaseObjectIdentity`. One of them said it "remains,
for lease status to report", which was simply false and is the only one a
reader could have acted on. The historical references are reworded rather than
deleted: they carry the reason the break is gone, and a removed citation takes
its reasoning with it.

Separately, `\foo` is root-relative, not drive-relative. The drive-relative
form is `C:foo`, and the two are refused by different guards - so the comment
sat on the guard that does not catch the case it named. Corrected in the module
and in the F-4 register entry.
```

---

### Task 5: The real-process controls, against the built artefact

**Files:**
- Create: `tests/dist-artifact/runtime-gate-preload.cjs`
- Create: `tests/dist-artifact/runtime-gate-dist-artifact.mjs`
- Modify: `package.json` (scripts, `verify`)

**Interfaces:**
- Consumes: `EXIT_RUNTIME_UNSUPPORTED = 6` (Task 2), the built `dist/cli/index.js`.
- Produces: `test:dist-runtime-gate`, `verify:dist-runtime-gate`.

- [ ] **Step 1: Write the self-verifying preload**

Create `tests/dist-artifact/runtime-gate-preload.cjs`:

```js
/**
 * Substitutes `process.platform` / `process.version` before the CLI's ESM entry
 * point loads, so the runtime gate can be driven against runtimes this machine
 * is not.
 *
 * CommonJS on purpose: `--require` runs it before the ESM entry, which is
 * exactly the window needed.
 *
 * ── This file proves its own instrumentation, and that is the point ─────────
 *
 * Both properties are `writable: false`. Their descriptors were measured
 * `configurable: true` on v24.18.1 on the development host — and NOT on the
 * Node 22 the CI runner uses. So the override is attempted, and then the value
 * is READ BACK. If the read-back does not show the substitute, this process
 * dies with a distinct code rather than continuing.
 *
 * Without that, a future runtime that made either property non-configurable
 * would turn every negative control green: the CLI would start on a supported
 * runtime, the gate would correctly not refuse, and the harness would read that
 * as "the gate refused" only if it were looking at the wrong thing. Failing
 * loudly here is the only reason this control may be trusted on a Node the
 * measurement did not cover.
 */

'use strict';

const { writeSync } = require('node:fs');

/** Distinct from any exit code the CLI itself produces (0-6). */
const EXIT_INSTRUMENTATION_FAILED = 97;

function override(name, value) {
  try {
    Object.defineProperty(process, name, {
      value,
      writable: false,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Fall through to the read-back, which reports it uniformly.
  }
  if (process[name] !== value) {
    writeSync(
      2,
      `runtime-gate-preload: could not substitute process.${name}; ` +
        `wanted ${JSON.stringify(value)}, got ${JSON.stringify(process[name])}\n`,
    );
    process.exit(EXIT_INSTRUMENTATION_FAILED);
  }
}

if (process.env.V2_07P_FAKE_PLATFORM) override('platform', process.env.V2_07P_FAKE_PLATFORM);
if (process.env.V2_07P_FAKE_NODE_VERSION) override('version', process.env.V2_07P_FAKE_NODE_VERSION);
```

- [ ] **Step 2: Write the harness**

Create `tests/dist-artifact/runtime-gate-dist-artifact.mjs`:

```js
#!/usr/bin/env node
/**
 * V2-07P. The runtime gate, measured against the SHIPPED CLI.
 *
 * Standalone Node script, plain JavaScript, spawned by `test:dist-runtime-gate`
 * (and transitively by `verify`). It spawns `dist/cli/index.js` as a real child
 * process — the gate lives at the CLI entry, terminates the process and writes
 * synchronously to fd 2, and none of those three things can be observed from
 * inside a vitest worker.
 *
 * Contract: exit 0 means every check passed. Nonzero means at least one did not.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const distEntry = join(repoRoot, 'dist', 'cli', 'index.js');
const preload = join(scriptDir, 'runtime-gate-preload.cjs');

const EXIT_RUNTIME_UNSUPPORTED = 6;
const EXIT_INSTRUMENTATION_FAILED = 97;

/** @type {string[]} */
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

if (!existsSync(distEntry)) {
  console.error(
    'dist/cli/index.js does not exist. Run "npm run build" before this check ' +
      '(see the "verify:dist-runtime-gate" npm script, which does this for you).',
  );
  process.exit(1);
}

/**
 * Run the shipped CLI. `env` entries drive the preload; when none are given the
 * preload is not loaded at all, so the process sees this real machine.
 */
function runCli(args, env = null) {
  const argv = env === null ? [distEntry, ...args] : ['--require', preload, distEntry, ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}) },
    windowsHide: true,
    timeout: 60_000,
  });
  check(
    result.status !== EXIT_INSTRUMENTATION_FAILED,
    `the preload could not substitute the runtime facts, so nothing below was measured: ${result.stderr}`,
  );
  return result;
}

const UNSUPPORTED_PLATFORM = { V2_07P_FAKE_PLATFORM: 'linux' };
const UNSUPPORTED_NODE = { V2_07P_FAKE_NODE_VERSION: 'v20.11.1' };

// ── 1. The positive control, on the configuration actually claimed ───────────
//
// Without the preload, so the gate sees this real Windows host. If this fails,
// the gate is written so broadly that it refuses everything, and every negative
// check below would pass for the wrong reason.
{
  const positive = runCli(['lease', 'status', '--repository', repoRoot]);
  check(positive.status === 0, `supported runtime: expected exit 0, got ${positive.status}`);
  check(
    positive.stdout.includes('Lease'),
    'supported runtime: the lease report did not reach stdout, so the action did not run',
  );
  check(
    !positive.stderr.includes('unsupported runtime'),
    'supported runtime: the gate refused on a supported machine',
  );
}

// ── 2. Negative: an unsupported platform, and an unsupported Node ────────────
for (const [label, env] of [
  ['platform', UNSUPPORTED_PLATFORM],
  ['node version', UNSUPPORTED_NODE],
]) {
  const refused = runCli(['lease', 'status', '--repository', repoRoot], env);

  check(
    refused.status === EXIT_RUNTIME_UNSUPPORTED,
    `unsupported ${label}: expected exit ${EXIT_RUNTIME_UNSUPPORTED}, got ${refused.status}`,
  );

  // The message survived a hard exit, in full. Both the first and the last line
  // are asserted: a truncated refusal is the failure mode `writeAllSync` exists
  // to prevent, and checking only the opening line would not see it.
  check(
    refused.stderr.includes('unsupported runtime. Nothing was started.'),
    `unsupported ${label}: the refusal did not reach stderr`,
  );
  check(
    refused.stderr.includes('No other command does.'),
    `unsupported ${label}: the refusal reached stderr truncated`,
  );

  // THE EFFECT. Not "a message was printed" — that the action never ran. On a
  // supported runtime this exact invocation prints the lease report; its
  // absence is what proves the gate stopped the command rather than merely
  // complaining alongside it.
  check(
    !refused.stdout.includes('Lease'),
    `unsupported ${label}: the lease action ran anyway and wrote its report`,
  );
}

// ── 3. Nested commands are gated too ─────────────────────────────────────────
//
// This settles empirically whether Commander inherits a program-level
// `preAction` hook into subcommands. If it does not, this fails here rather
// than the gate silently covering only the top level.
{
  const nested = runCli(['release', '--help'], UNSUPPORTED_PLATFORM);
  check(
    nested.status !== EXIT_RUNTIME_UNSUPPORTED,
    'nested --help was refused by the gate; help must stay reachable',
  );
}

// ── 4. Help and version stay reachable on an unsupported runtime ─────────────
//
// §4 of the design promises this, so it is measured rather than assumed. The
// operator who most needs the help output is the one whose runtime is refused.
for (const args of [
  ['--help'],
  ['--version'],
  ['lease', '--help'],
  ['lease', 'status', '--help'],
  ['help', 'lease'],
]) {
  const label = args.join(' ');
  const result = runCli(args, UNSUPPORTED_PLATFORM);
  check(
    result.status !== EXIT_RUNTIME_UNSUPPORTED,
    `\`${label}\` on an unsupported runtime: the gate refused it (exit ${result.status})`,
  );
  check(
    result.stdout.trim().length > 0,
    `\`${label}\` on an unsupported runtime: printed nothing to stdout`,
  );
  check(
    !result.stdout.includes('Lease  '),
    `\`${label}\` on an unsupported runtime: ran an action instead of printing help`,
  );
}

if (failures.length > 0) {
  console.error(`runtime-gate dist artefact check: ${failures.length} failure(s)`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('runtime-gate dist artefact check: all checks passed');
```

- [ ] **Step 3: Run it against a fresh build**

Run: `npm run build && node tests/dist-artifact/runtime-gate-dist-artifact.mjs`
Expected: `all checks passed`.

If `help lease` is refused, the measurement has answered the open question from the design: add an exemption in `src/cli/index.ts` for Commander's help command inside the hook, and note in the commit message that the exemption was measured into existence rather than predicted. Do **not** widen the exemption beyond the help command.

- [ ] **Step 4: Prove the harness can fail**

A control that cannot fail pins nothing. Temporarily change `enforceSupportedRuntime` in `src/cli/runtime-gate.ts` to return immediately:

```ts
export function enforceSupportedRuntime(): void {
  return;
}
```

Run: `npm run build && node tests/dist-artifact/runtime-gate-dist-artifact.mjs`
Expected: **FAIL**, and specifically on the "the lease action ran anyway and wrote its report" checks — not only on the exit-code checks. If it fails only on exit codes, the effect assertion is not reaching the effect; fix it before continuing.

Then revert the temporary change (`git checkout src/cli/runtime-gate.ts`) and re-run to confirm it passes again.

- [ ] **Step 5: Wire it into the gate**

In `package.json`, add after the `verify:dist-lease-release` entry:

```json
    "//test:dist-runtime-gate": "The V2 runtime gate against the shipped CLI. It exists because the gate terminates the process and writes synchronously to fd 2 at the CLI entry, and none of that is observable from inside a vitest worker. A self-verifying preload substitutes process.platform/process.version and dies with exit 97 if the substitution did not take, so an ineffective preload cannot manufacture a green result. The negative cases assert that the lease report is ABSENT from stdout - that the action did not run - rather than only that a message was printed.",
    "test:dist-runtime-gate": "node tests/dist-artifact/runtime-gate-dist-artifact.mjs",
    "verify:dist-runtime-gate": "npm run build && npm run test:dist-runtime-gate",
```

Update the `verify` script to insert `test:dist-runtime-gate` after `test:dist-lease-release`:

```json
    "verify": "npm run schema:generate && npm run typecheck && npm run build && npm run test:dist-doctor && npm run test:dist-trusted-profile && npm run test:dist-lease-race && npm run test:dist-lease-release && npm run test:dist-runtime-gate && npm run test:foundation-safe && npm run test:windows-tree-kill-tool-release"
```

- [ ] **Step 6: Run the canonical gate**

Run: `npm run verify`
Expected: PASS end to end.

- [ ] **Step 7: Commit**

```bash
git add tests/dist-artifact/runtime-gate-preload.cjs tests/dist-artifact/runtime-gate-dist-artifact.mjs package.json
git commit
```

Message:

```
test: the runtime gate, measured against the shipped CLI (V2-07P)

The gate terminates the process and writes synchronously to fd 2 at the CLI
entry; none of that is observable from inside a vitest worker, so it is
measured as a real child process against dist/.

Two things this harness does that a weaker one would not. The preload proves
its own instrumentation - it reads process.platform back after substituting it
and dies with a distinct code if the substitution did not take, so a runtime
that made the property non-configurable fails loudly instead of turning every
negative case green. And the negative cases assert the lease report is ABSENT
from stdout: that the action did not run, not merely that a message was
printed. Verified by mutation - stubbing the gate to return immediately fails
those checks, not only the exit-code ones.

The positive control runs without the preload on the real host, which is what
stops the gate from being written so broadly that it refuses everything.
```

---

### Task 6: CI measures every member of the whitelist

**Files:**
- Modify: `.github/workflows/verify.yml`

- [ ] **Step 1: Add the matrix**

Replace the `jobs:` block's opening through the `Set up Node.js` step with:

```yaml
jobs:
  verify:
    name: verify (windows, node ${{ matrix.node }})
    runs-on: windows-latest
    strategy:
      # Never cancel the sibling on a failure: which majors passed and which
      # failed is the whole information this matrix exists to produce.
      fail-fast: false
      matrix:
        # Exactly the members of SUPPORTED_NODE_MAJORS in
        # src/platform/runtime-support.ts. Not a sample of them: the runtime
        # gate is a whitelist, and a whitelist whose members are not all
        # measured is a floor wearing a disguise.
        node: [22, 24]
    # `verify` starts real processes, including a detached helper that survives
    # on purpose, so a defect here can hang rather than fail. This bound is not a
    # performance budget, only a ceiling that stops a hung probe from holding a
    # runner open indefinitely.
    #
    # It was 20, with a comment claiming the gate took "about 30 seconds
    # locally". Both had gone stale: the gate now runs ~2700 tests plus five
    # dist-artefact checks, two of which are multi-process races, and the last
    # five green runs on this runner took 9, 14, 18:45, 18:48 and 19:19 minutes.
    # A ceiling a passing run reaches by chance is not a hang detector — it is a
    # coin toss whose tails side reports `cancelled`, which this repository's own
    # merge policy reads as a blocking failure. V2-07LR's break race is what
    # finally tipped it over, and raising the ceiling is the honest fix rather
    # than trimming a check to fit under a number.
    timeout-minutes: 40

    steps:
      - name: Check out the repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
```

- [ ] **Step 2: Rewrite the header comment, which now argues the opposite**

The file header currently ends with a paragraph explaining there is no Linux job. Keep that. The `node-version` step previously carried this reasoning:

> The floor this project declares: package.json `engines.node` is ">=22" and MINIMUM_NODE_MAJOR in src/doctor/run-doctor.ts is 22. Gating on the floor is what makes that claim verified rather than assumed. No matrix: a second version would test a promise nobody made.

That is deleted with the step, and replaced by a paragraph appended to the file header:

```yaml
# There are two jobs, one per supported Node major, and that is a change of
# contract rather than of thoroughness. This project used to declare a floor
# (`engines.node: ">=22"`) and gate on it, and the honest comment then was "no
# matrix: a second version would test a promise nobody made". V2-07P replaced
# the floor with a whitelist — `SUPPORTED_NODE_MAJORS = [22, 24]` in
# src/platform/runtime-support.ts, enforced by the CLI's runtime gate — so the
# promise IS now made, for exactly two majors, and each of them is measured
# here. A member of that array without a job here would be an enforced claim
# nobody verified.
#
# Still no Linux job, for the reason above: `verify` ends in a real-process
# probe of the Windows process-tree termination path, and V2 refuses to run on
# anything but Windows at all.
```

- [ ] **Step 3: Verify the workflow parses**

Run: `node -e "const y=require('yaml');const f=require('node:fs');const d=y.parse(f.readFileSync('.github/workflows/verify.yml','utf8'));console.log(JSON.stringify(d.jobs.verify.strategy,null,2));console.log(d.jobs.verify.name)"`
Expected: the matrix `{ "fail-fast": false, "matrix": { "node": [22, 24] } }`, and the templated job name.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/verify.yml
git commit
```

Message:

```
ci: measure every supported Node major, because it is now a whitelist (V2-07P)

The workflow comment said "no matrix: a second version would test a promise
nobody made". That was true of a floor. V2-07P replaced the floor with an
enforced whitelist of exactly two majors, so the promise is made and each
member needs a job - a member of SUPPORTED_NODE_MAJORS without a job here would
be an enforced claim nobody verified. fail-fast is off: which major failed is
the information this matrix exists to produce.
```

---

### Task 7: The contract, written down

**Files:**
- Modify: `README.md` (line ~76–83 gate enumeration; line ~2829–2858; line ~3895; new supported-runtime section; new V2-07P narrative section)

- [ ] **Step 1: Add the supported-runtime section**

Insert immediately before `## Build and verify` (line 70) a new section:

```markdown
## Supported runtime

V2 is built for one configuration and refuses to run outside it. Three claims,
kept apart on purpose, because they have different strengths:

**Verified** — Windows, Node major 22 or 24, and a repository whose Git common
directory is on a local NTFS volume. This is the configuration the project is
measured on: `verify` runs on `windows-latest` against Node 22 *and* Node 24.

**Enforced** — Windows, Node major in `{22, 24}`, and no explicit UNC or device
path for the repository. This is what the build refuses to run outside of, and
it is what can be decided from process-constant facts and the shape of a path.
The refusal happens at the CLI entry, before any command action begins, with
exit code 6; `--help` and `--version` keep working.

**Proved at the effect** — the lease's own filesystem capability, checked at the
hard link that needs it, answering `LEASE_FILESYSTEM_UNSUPPORTED` with the errno
the link was refused with. Not a preflight, and deliberately not derived from
one.

The two axes behave differently, and the difference matters:

- **on the Node axis, enforced and verified coincide exactly.** The supported
  set is the whitelist `[22, 24]` (`src/platform/runtime-support.ts`), not a
  floor: `>= 22` would admit 23 and 25 on a promise nobody has tested. CI
  measures both members.
- **on the filesystem axis, enforced is strictly narrower than verified.** The
  build does **not** establish that an accepted volume is local, or that it is
  NTFS.

### Not part of the V2 support contract

FAT, exFAT, SMB and other network filesystems, UNC-hosted repository storage,
and POSIX/macOS/Linux runtimes.

### ACCEPTED LIMIT: a network share mapped to a drive letter

A share mounted as `Z:\` is path-shaped like a local volume and **is not
detected by this build**. It is outside the supported configuration and the tool
will not tell you so. This is recorded as an accepted limit rather than left as
an unlikely case:

- closing it needs a Windows drive-type query, which would introduce a preflight
  *measurement of the filesystem* — precisely the construct the lease's whole
  safety argument avoids — plus its own tail of questions (`SUBST`, junctions,
  reparse points, Dev Drives, VHDX, UNC behind a local redirect, and
  disagreement between what the query answers and where the lease directory
  actually is);
- the residual protection is real but partial: where such a share cannot hard
  link, the lease refuses at the effect. A share that *can* hard link runs,
  unverified.

The runtime gate is not part of any safety argument downstream of it. It reads
`process.platform` and `process.version`, both fixed by the running Node binary,
and it measures nothing about any filesystem — which is why nothing in this
build may read as "NTFS was established at startup, so this effect is safe".
```

- [ ] **Step 2: Update the gate enumeration**

At line ~77, replace:

```
order: `schema:generate`, `typecheck`, `build`, `test:dist-doctor`,
`test:dist-trusted-profile`, `test:dist-lease-race`, `test:dist-lease-release`,
`test:foundation-safe`, `test:windows-tree-kill-tool-release`. `build` runs
immediately before the four dist artefact checks, so all of them always run
```

with:

```
order: `schema:generate`, `typecheck`, `build`, `test:dist-doctor`,
`test:dist-trusted-profile`, `test:dist-lease-race`, `test:dist-lease-release`,
`test:dist-runtime-gate`, `test:foundation-safe`,
`test:windows-tree-kill-tool-release`. `build` runs
immediately before the five dist artefact checks, so all of them always run
```

Then add a paragraph after the `test:dist-lease-release` description:

```markdown
`test:dist-runtime-gate` drives the **runtime gate** against the shipped CLI as
a real child process. The gate terminates the process and writes synchronously
to fd 2 at the CLI entry, and none of that is observable from inside a vitest
worker. A preload substitutes `process.platform` / `process.version` and
verifies its own substitution took, dying with a distinct exit code if it did
not — an ineffective preload would otherwise turn every negative case green. The
negative cases assert that the lease report is **absent** from stdout, which is
what proves the action never ran rather than merely that a message was printed.
```

- [ ] **Step 3: Reconcile the stale platform claims**

At line ~2844, replace:

```
- V1's canonical verification evidence is **Windows + Node 22** — `verify` runs
  on `windows-latest`, and `tests/v1-08-verification-boundary.test.ts` spawns its
  real processes there;
```

with:

```
- V1's canonical verification evidence is **Windows + Node 22 or 24** — `verify`
  runs on `windows-latest` against both majors (V2-07P widened this from Node 22
  alone when the Node contract became a whitelist), and
  `tests/v1-08-verification-boundary.test.ts` spawns its real processes there;
```

At the end of the "Verification is a stated V1 platform limitation" section (after line ~2858), append:

```markdown
**V2-07P narrowed this from the other end.** The limitation above was written
when portability was an open question: the build did not run on POSIX and did
not claim to. V2 now *refuses* to, at the CLI entry, so "portability to POSIX is
not proven by V1" has become "POSIX is outside the support contract". The
paragraph is kept rather than rewritten because it records what was true of V1,
and because the failure mode it describes — a command that cannot start is
`UNAVAILABLE`, never a false `PASSED` — is unchanged.
```

At the end of the "stated reduction in supported platforms" passage (after line ~3901), append:

```markdown
**V2-07P made the surrounding contract match this refusal.** When this was
written, the filesystem boundary was enforced while the runtime around it was
not: the build refused a filesystem that could not link, and would happily start
on Linux or on an untested Node. The runtime is now gated too, and the
repository path is refused by shape when it is explicitly UNC or a device path.
The division of labour is unchanged and deliberate — the *runtime* facts are
decided once at the entry because they are process-constant, and the
*filesystem* capability stays where it was, proved at the link that needs it.
```

- [ ] **Step 4: Add the V2-07P narrative section**

Add a section in the established style, after the V2-07LR-AA section (line ~3924 onwards, at the end of the V2-07 narrative block):

```markdown
### The platform contract, made executable (V2-07P)

Six adversarial review rounds on the execution lease spent their budget on
filesystems this project will never run on, and each repair widened the surface
the next round had to break. The decision behind this slice is that V2 is built
for its actual deployment and says so.

**What was measured before anything changed.** Against the shipped build,
`\\server\share\repo\.git`, `\\?\UNC\server\share\repo\.git` and
`\\.\PhysicalDrive0` were all **accepted** as lease locations — the Windows
check admitted the UNC shape explicitly. So this slice removes a real
acceptance, not a theoretical one.

**The runtime gate is not a filesystem preflight, and could not become one.**
It reads `process.platform` and `process.version` and nothing else. Both are
fixed by the running Node binary, so there is no later moment at which either
could answer differently — which is why deciding them once at the entry is not
a check relocated away from its effect. The lease's filesystem capability is not
like that, and it stayed exactly where it was.

**Three refusals where there was one.** A UNC path resolves perfectly well; the
build refuses it because V2 does not support network storage. Reporting that as
`LEASE_LOCATION_UNSUITABLE` — whose sentence says no location could be derived —
would have been the same defect `REPOSITORY_RECORD_INCOHERENT` already records
against itself. A device path got a third code rather than being folded into the
network one, because a device path is not network storage.

**What the contract deliberately does not claim.** A drive letter can be a
mapped network share, in the plain and the extended-length form alike, and this
build does not detect it. That is recorded as an ACCEPTED LIMIT in the
supported-runtime section rather than described as unlikely, because closing it
would require the filesystem preflight the whole design avoids.

**Node became a whitelist.** `[22, 24]`, not `>= 22`. A floor enforces a
contract wider than CI proves; the two disagree only on 23 and 25, and both are
pinned by test. CI gained a second job so that every enforced member is a
verified one.

**POSIX code was not deleted.** The gate makes the `exec.ts` process-group
branches, `path-identity.ts`'s casing fold and the POSIX profile resolver
unreachable. They stay: removing them means rewriting the most dangerous module
in the build inside a slice whose purpose was to stop opening review surfaces.
```

- [ ] **Step 5: Check the document is internally consistent**

Run: `git grep -n "engines.node\|>=22\|>= 22\|MINIMUM_NODE_MAJOR" -- README.md .github/`
Expected: no hit claims a floor. Any survivor is a stale claim — fix it.

Run: `git grep -n "four dist artefact" -- README.md`
Expected: no hits.

- [ ] **Step 6: Run the canonical gate**

Run: `npm run verify`
Expected: PASS end to end.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit
```

Message:

```
docs: the V2 support contract, and the claims it makes false (V2-07P)

The supported-runtime section states three claims separately - verified,
enforced, proved at the effect - because they have different strengths, and
because collapsing them is how a document ends up promising local NTFS while
the build checks a path shape. A drive letter can be a mapped network share and
this build does not detect it; that is written down as an ACCEPTED LIMIT rather
than left as an unlikely case.

Two older passages said something that is no longer true and are reconciled
rather than left to contradict the new section: V1's verification evidence was
"Windows + Node 22", and the lease's platform reduction was written when the
runtime around it was ungated.
```

---

## Delivery

- [ ] **Push and open the pull request**

```bash
git push -u origin feat/v2-07p-platform-contract
gh pr create --base main --title "V2-07P: the platform contract, made executable" --body-file -
```

- [ ] **Wait for CI, and classify the result before merging**

Per `CLAUDE.md`, the merge gate distinguishes four states and only one permits merging. Read them structurally, not from one exit code:

```bash
gh pr checks --json name,bucket,state
gh pr view --json statusCheckRollup
```

- zero checks → **stop**, `MERGE_BLOCKED_NO_CHECKS`
- any pending → wait
- any failure, cancellation or timeout → **stop**, `MERGE_BLOCKED_CHECKS_FAILED`
- checks exist and all relevant ones passed → merge may proceed

There must be **two** check runs now — `verify (windows, node 22)` and
`verify (windows, node 24)`. One of them missing is a mis-scoped matrix, which
under `CI_REQUIRED` is a defect in the delivery setup rather than permission to
merge.

- [ ] **After merging, the independent adversarial closing review runs against the merged head** — not against `ba72566`, so the review target does not move underneath the review.

---

## Self-Review

**Spec coverage.**

| Spec section | Task |
| --- | --- |
| §1 contract, exclusions, ACCEPTED LIMIT | 7 |
| §2 two layers | 1 (module doc), 7 (README) |
| §3 `runtime-support.ts`, doctor, `engines` | 1 |
| §4 CLI enforcement, ordered refusal, help carve-out | 2 (mechanism), 5 (proof) |
| §5 UNC / device / terminology | 3 (mechanism), 4 (prose) |
| §6 dead `leaseObjectIdentity` prose | 4 |
| §7 controls: positive, negative, help matrix, in-process matrix | 1, 2, 3, 5 |
| §7 `test:dist-runtime-gate` in `verify`, README gate list | 5, 7 |
| §7 CI matrix | 6 |
| §8 documentation | 4 (F-4), 7 |
| §9 out of scope | enforced by Global Constraints |
| §10 done | Delivery |

**Gap found and closed during planning:** the spec did not say what `lease
status` reports for a UNC repository. `inspectRepositoryExecutionLease`
collapses every location failure into the single state `LOCATION_UNSUITABLE`,
whose sentence says no location could be derived — the exact misdescription §5
argues against, on the status path instead of the acquire path. Task 3 Steps 6–8
add two inspection states and their sentences. The `Record<LeaseInspection['state'], string>`
typing makes this a compile error until both sentences exist, which is the
repository's own mechanism for a vocabulary that may not grow a member nobody
described.

**Second gap:** `tests/v2-07lr-lease-recovery.test.ts:435-452` asserts that a
UNC key derives a location. That is the contract this slice reverses. Task 3
Step 9 re-bases it rather than deleting it — it is the control that stops an
over-broad refusal from passing.

**Placeholder scan:** none. Every code step carries the code; every test step
carries the assertions; the one genuinely open question (Commander hook
inheritance, and whether `help <command>` needs an exemption) is written as a
measurement with a defined response in Task 5 Step 3, not as a TODO.

**Type consistency:** `SUPPORTED_NODE_MAJORS`, `parseNodeMajor`,
`evaluateRuntimeSupport`, `RuntimeSupport`, `renderRuntimeRefusal`,
`enforceSupportedRuntime`, `EXIT_RUNTIME_UNSUPPORTED`,
`LeaseLocationFailureCode`, `LeaseLocationState`, `LOCATION_STATE_FOR` are each
defined once and used under the same name and shape everywhere afterwards.
`MINIMUM_NODE_MAJOR` is removed in Task 1 Step 5 and referenced nowhere later
except in prose that describes its removal.
