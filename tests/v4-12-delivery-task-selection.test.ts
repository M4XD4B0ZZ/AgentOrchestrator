/**
 * V4 slice 12 — delivery task selection.
 *
 * The suite is written against the four ways a selector over irreversible acts
 * goes wrong:
 *
 *  1. **choosing the wrong one, deterministically.** The order is the plan's own
 *     dependency order, and the tests that matter are the ones where it
 *     disagrees with something plausible: lexicographic id order, the order the
 *     definitions arrived in, and the order a filesystem listed them. Each is
 *     driven and the answer required to be the same;
 *  2. **selecting a task whose delivery is over.** `READY_FOR_PR` is terminal
 *     and stays terminal after a merge, so a scan for that state alone would
 *     hand the same concluded task to the driver for ever. The conclusion is
 *     read first, and — the load-bearing case — a conclusion whose merge receipt
 *     and verification history have been deleted *and* corrupted is still
 *     terminal, because neither is read at all;
 *  3. **stepping over a candidate nobody can read.** A malformed conclusion, a
 *     record from a newer build, an unreadable task state: each is surfaced with
 *     the task named, and the healthy pending task behind it is measured *not*
 *     to have been selected. Skipping would turn a visible evidence failure into
 *     an invisible bypass;
 *  4. **letting a choice become a permission.** A selection is routing. Every
 *     act still needs its own flag and `--attended`, and a drive that chose its
 *     own subject is measured to send nothing through any of the **three**
 *     mutation seams — the publication, the creation and the merge. The fourth
 *     seam the harness counts is the forge *reader*, and it is deliberately not
 *     held at zero: a drive reads github.com, which is the whole difference
 *     between contacting a forge and changing something on it.
 *
 * The classification tables are asserted **by value through behaviour**, not by
 * `satisfies`: a total map proves every member was graded, never that any grade
 * is right, and this repository has already paid for that difference.
 */

import { Command } from 'commander';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  DELIVERY_CANDIDATE_POSITIONS,
  DELIVERY_TASK_SELECTIONS,
  DELIVERY_TASK_SELECTION_DETAIL,
  selectDeliveryTask,
  type DeliveryCandidatePosition,
  type DeliverySelectionSeams,
  type DeliveryTaskSelection,
} from '../src/deliver/select-delivery-task.js';
import {
  DELIVERY_COMMAND_DESCRIPTION,
  SELECT_TASK_OPTION_DESCRIPTION,
  TASK_NAMING_REFUSALS,
  TASK_NAMING_REFUSAL_DETAIL,
  refuseTaskNaming,
  registerDeliveryCommand,
  type DeliveryCommandInput,
  type TaskNamingRefusal,
} from '../src/cli/delivery-command.js';
import { SELECTION_TRAILER } from '../src/cli/render-delivery-observation.js';
import {
  exitCodeForDeliverySelection,
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_NEEDS_OPERATOR,
  EXIT_RUN_OK,
} from '../src/cli/run-exit-codes.js';
import {
  DELIVERY_CONCLUSION_READINGS,
  DELIVERY_CONCLUSION_VERSION,
  deliveryConclusionBinding,
  type DeliveryConclusionPayload,
} from '../src/deliver/delivery-conclusion.js';
import { deliveryConclusionDirectory } from '../src/deliver/delivery-conclusion-store.js';
import { mergeReconciliationDirectory } from '../src/deliver/merge-reconciliation-store.js';
import { postMergeVerificationDirectory } from '../src/deliver/post-merge-verification-store.js';
import { normalizeTaskGraph, type NormalizedTaskGraph } from '../src/plan/task-graph.js';
import { parseTaskDefinition, type TaskDefinition } from '../src/plan/task-definition.js';
import { TERMINAL_STATES } from '../src/core/states.js';
import { TRANSITION_TABLE } from '../src/core/transitions.js';
import {
  loadTaskState,
  saveTaskState,
  STATE_LOAD_FAILURE_CODES,
} from '../src/state/state-store.js';
import { taskRuntimeDirectory } from '../src/state/state-location.js';
import { commandResult, SHA_B, validCreatedState, validReadyForPrState } from './fixtures.js';

/* ── scratch ──────────────────────────────────────────────────────────────── */

const roots: string[] = [];

function scratchRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ao-v412-')));
  roots.push(root);
  return root;
}

function disposeRoots(): void {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // A locked file on Windows must not fail an otherwise passing suite.
    }
  }
}

/* ── the plan, as a graph ─────────────────────────────────────────────────── */

function task(id: string, dependsOn: readonly string[] = [], status: 'OPEN' | 'DONE' = 'OPEN'): TaskDefinition {
  return parseTaskDefinition({
    id,
    title: `task ${id}`,
    status,
    kind: 'NORMAL',
    priority: 'NORMAL',
    currentFocus: false,
    dependsOn: [...dependsOn],
  });
}

/** The same task, as the bytes a repository would actually have written. */
function taskMarkdown(id: string, dependsOn: readonly string[] = []): string {
  return [
    '---',
    `id: ${id}`,
    `title: task ${id}`,
    'status: OPEN',
    'kind: NORMAL',
    'priority: NORMAL',
    'currentFocus: false',
    dependsOn.length === 0
      ? 'dependsOn: []'
      : `dependsOn:\n${dependsOn.map((d) => `  - ${d}`).join('\n')}`,
    '---',
    '',
    'Body prose, which nothing here interprets.',
    '',
  ].join('\n');
}

function graphOf(definitions: readonly TaskDefinition[]): NormalizedTaskGraph {
  const normalized = normalizeTaskGraph(definitions);
  if (!normalized.ok) throw new Error(`fixture graph is not normalisable: ${normalized.code}`);
  return normalized.graph;
}

/* ── durable records, written directly ────────────────────────────────────── */

const AT = '2026-08-26T12:00:00.000Z';
const MERGE = 'c'.repeat(40);
const HEAD = 'd'.repeat(40);
const DIGEST = 'a'.repeat(64);

function writeReadyState(root: string, taskId: string): void {
  const saved = saveTaskState(
    validReadyForPrState({ taskId, repositoryRoot: root, worktreePath: join(root, taskId) }),
    { repositoryRoot: root },
  );
  if (!saved.ok) throw new Error(`fixture state not saved: ${saved.code}`);
}

function writeCreatedState(root: string, taskId: string): void {
  // The compare-and-swap token when one is already there. There is deliberately
  // no overwrite flag in the store, so a fixture that replaces a state has to
  // read it first, exactly as the product does.
  const existing = loadTaskState(root, taskId);
  const saved = saveTaskState(
    validCreatedState({ taskId, repositoryRoot: root, worktreePath: join(root, taskId) }),
    {
      repositoryRoot: root,
      ...(existing.ok ? { expectedRevision: existing.revision } : {}),
    },
  );
  if (!saved.ok) throw new Error(`fixture state not saved: ${saved.code}`);
}

/**
 * A source file with its comments removed.
 *
 * The house helper, copied per slice file as every other V4 file copies it. A
 * pin scanned over prose is a pin a header can trip, and this module's header
 * has to be free to explain the very things the code must not reach for.
 */
function codeOnly(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function conclusionPath(root: string, taskId: string): string {
  return join(deliveryConclusionDirectory(root), `${taskId}.json`);
}

function writeConclusion(
  root: string,
  taskId: string,
  over: Partial<DeliveryConclusionPayload> = {},
): void {
  const payload: DeliveryConclusionPayload = {
    conclusionVersion: DELIVERY_CONCLUSION_VERSION,
    taskId,
    repositoryRoot: root,
    subjectCommit: HEAD,
    mergeCommit: MERGE,
    provider: 'github',
    host: 'github.com',
    owner: 'acme',
    name: 'widget',
    pullRequestNumber: 7,
    baseRef: 'main',
    profileDigest: DIGEST,
    verifiedAt: AT,
    receiptBinding: 'e'.repeat(64),
    verificationBinding: 'f'.repeat(64),
    concludedAt: AT,
    ...over,
  };
  mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
  writeFileSync(
    conclusionPath(root, taskId),
    `${JSON.stringify(
      { ...payload, binding: deliveryConclusionBinding({ taskId, repositoryRoot: root }, payload) },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

/** The seams a production-shaped selection runs on. */
const REAL: DeliverySelectionSeams = { loadState: loadTaskState };

/* ══ 1. the closed vocabularies ═══════════════════════════════════════════ */

describe('the selection vocabularies are closed and complete', () => {
  it('lists exactly three selection outcomes, in ladder order', () => {
    expect([...DELIVERY_TASK_SELECTIONS]).toEqual([
      'DELIVERY_TASK_SELECTED',
      'NO_DELIVERY_PENDING',
      'DELIVERY_EVIDENCE_UNREADABLE',
    ]);
  });

  it('lists exactly five candidate positions, selectable one first', () => {
    expect([...DELIVERY_CANDIDATE_POSITIONS]).toEqual([
      'DELIVERY_PENDING',
      'DELIVERY_CONCLUDED',
      'NOT_ORCHESTRATED',
      'NOT_READY_FOR_DELIVERY',
      'EVIDENCE_UNREADABLE',
    ]);
  });

  it('gives every selection outcome a sentence, and no sentence an outcome', () => {
    expect(Object.keys(DELIVERY_TASK_SELECTION_DETAIL).sort()).toEqual(
      [...DELIVERY_TASK_SELECTIONS].sort(),
    );
    for (const outcome of DELIVERY_TASK_SELECTIONS) {
      const detail = DELIVERY_TASK_SELECTION_DETAIL[outcome];
      expect(detail.length, outcome).toBeGreaterThan(20);
      // The sentence must not simply restate the code, which explains nothing
      // twice — the defect a review already caught on the `--record` line.
      expect(detail, outcome).not.toBe(outcome);
    }
  });

  it('lists exactly three task-naming refusals, and gives each a sentence', () => {
    expect([...TASK_NAMING_REFUSALS]).toEqual([
      'TASK_NOT_NAMED',
      'TASK_NAMED_AND_SELECTED',
      'SELECTION_REQUIRES_DRIVE',
    ]);
    expect(Object.keys(TASK_NAMING_REFUSAL_DETAIL).sort()).toEqual(
      [...TASK_NAMING_REFUSALS].sort(),
    );
    for (const refusal of TASK_NAMING_REFUSALS) {
      expect(TASK_NAMING_REFUSAL_DETAIL[refusal].length, refusal).toBeGreaterThan(20);
    }
  });
});

/* ══ 2. the classification tables, by value ═══════════════════════════════ */

describe('every conclusion reading is classified, and classified correctly', () => {
  /**
   * Driven through an injected reader rather than through files, because two of
   * the five readings cannot be produced on demand against a real filesystem —
   * `loadDeliveryConclusion` documents exactly that about its own `open` and
   * `readChunk` seams. The file-backed cases below drive the other three for
   * real, so this is a completeness sweep and not a substitute for them.
   */
  const readings = [
    ['DELIVERY_CONCLUDED', 'DELIVERY_CONCLUDED'],
    ['ABSENT', 'DELIVERY_PENDING'],
    ['MALFORMED', 'EVIDENCE_UNREADABLE'],
    ['UNSUPPORTED_VERSION', 'EVIDENCE_UNREADABLE'],
    ['NOT_THIS_TASK', 'EVIDENCE_UNREADABLE'],
  ] as const;

  it('covers every member of the reading vocabulary', () => {
    // Derived from production, not restated beside it. The first version of
    // this compared the table's own keys with a second hardcoded copy of the
    // same five strings — literal against literal — while its comment claimed a
    // sixth member "must fail here". It would not have: `satisfies` keeps the
    // production map total, so the new arm would have been graded and never
    // asserted by value, which is the exact distinction this suite's header
    // says it is built around.
    expect(readings.map(([reading]) => reading).sort()).toEqual(
      [...DELIVERY_CONCLUSION_READINGS].sort(),
    );
  });

  for (const [reading, expected] of readings) {
    it(`reads ${reading} as ${expected}`, () => {
      const root = scratchRoot();
      try {
        // `ABSENT` is the only reading that goes on to the state, so that is the
        // only case whose state has to exist for the expectation to hold.
        if (reading === 'ABSENT') writeReadyState(root, 'a');
        const result = selectDeliveryTask(root, graphOf([task('a')]), {
          loadState: loadTaskState,
          loadConclusion: () => ({ reading, path: null, conclusion: null }),
        });
        expect(result.examined).toEqual([{ taskId: 'a', position: expected }]);
      } finally {
        disposeRoots();
      }
    });
  }
});

describe('every task-state load failure is classified, and classified correctly', () => {
  const codes = [
    ['NO_STATE', 'NOT_ORCHESTRATED'],
    ['LOCATION_UNSUITABLE', 'EVIDENCE_UNREADABLE'],
    ['UNREADABLE', 'EVIDENCE_UNREADABLE'],
    ['STATE_TOO_LARGE', 'EVIDENCE_UNREADABLE'],
    ['REPOSITORY_ROOT_MISMATCH', 'EVIDENCE_UNREADABLE'],
    ['REPOSITORY_ROOT_NOT_ABSOLUTE', 'EVIDENCE_UNREADABLE'],
    ['TASK_ID_MISMATCH', 'EVIDENCE_UNREADABLE'],
    ['MALFORMED_JSON', 'EVIDENCE_UNREADABLE'],
    ['SCHEMA_VERSION_UNSUPPORTED', 'EVIDENCE_UNREADABLE'],
    ['CONTRACT_VIOLATION', 'EVIDENCE_UNREADABLE'],
  ] as const;

  it('covers every member of the load-failure vocabulary', () => {
    // Derived from production. The first version was `expect(codes.length)
    // .toBe(10)` under a comment claiming it was imported — a hand-written
    // count, which an eleventh code would satisfy by being absent. It is the
    // same defect as the reading control above, and the same fix.
    expect(codes.map(([code]) => code).sort()).toEqual([...STATE_LOAD_FAILURE_CODES].sort());
  });

  for (const [code, expected] of codes) {
    it(`reads ${code} as ${expected}`, () => {
      const root = scratchRoot();
      try {
        const result = selectDeliveryTask(root, graphOf([task('a')]), {
          loadState: () => ({ ok: false as const, code, classification: 'STATE_INVALID' as never, path: null, detail: null } as never),
        });
        expect(result.examined).toEqual([{ taskId: 'a', position: expected }]);
      } finally {
        disposeRoots();
      }
    });
  }

  it('reads a state that is not READY_FOR_PR as NOT_READY_FOR_DELIVERY', () => {
    const root = scratchRoot();
    try {
      writeCreatedState(root, 'a');
      const result = selectDeliveryTask(root, graphOf([task('a')]), REAL);
      expect(result.examined).toEqual([{ taskId: 'a', position: 'NOT_READY_FOR_DELIVERY' }]);
      expect(result.outcome).toBe('NO_DELIVERY_PENDING');
    } finally {
      disposeRoots();
    }
  });
});

/* ══ 3. the order ═════════════════════════════════════════════════════════ */

describe('the order is the plan’s dependency order, and nothing else', () => {
  it('selects the dependency before the dependent, both pending', () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      writeReadyState(root, 'b');
      const result = selectDeliveryTask(root, graphOf([task('a'), task('b', ['a'])]), REAL);
      expect(result.outcome).toBe('DELIVERY_TASK_SELECTED');
      expect(result.taskId).toBe('a');
      // The dependent was never even examined: the walk stops at the first
      // pending task, so `b`'s records were not opened.
      expect(result.examined.map((c) => c.taskId)).toEqual(['a']);
    } finally {
      disposeRoots();
    }
  });

  it('lets the dependency relation beat lexicographic id order', () => {
    const root = scratchRoot();
    try {
      // `t-10` sorts BEFORE `t-9` by UTF-16 code unit — the disagreement that
      // makes an id-ordered selector pick the wrong one — and `t-10` depends on
      // `t-9`, so the dependency order is the opposite.
      writeReadyState(root, 't-9');
      writeReadyState(root, 't-10');
      const definitions = [task('t-9'), task('t-10', ['t-9'])];
      // Control: the disagreement this case rests on is real.
      expect(graphOf(definitions).taskIds).toEqual(['t-10', 't-9']);
      const result = selectDeliveryTask(root, graphOf(definitions), REAL);
      expect(result.taskId).toBe('t-9');
    } finally {
      disposeRoots();
    }
  });

  it('breaks a tie between independent tasks by the smallest id', () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'b');
      writeReadyState(root, 'a');
      const result = selectDeliveryTask(root, graphOf([task('b'), task('a')]), REAL);
      expect(result.taskId).toBe('a');
    } finally {
      disposeRoots();
    }
  });

  it('gives one answer whatever order the definitions arrived in', () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'x');
      writeReadyState(root, 'y');
      writeReadyState(root, 'z');
      const definitions = [task('x'), task('y', ['x']), task('z', ['y'])];
      const forwards = selectDeliveryTask(root, graphOf(definitions), REAL);
      const backwards = selectDeliveryTask(root, graphOf([...definitions].reverse()), REAL);
      const shuffled = selectDeliveryTask(
        root,
        graphOf([definitions[1] as TaskDefinition, definitions[2] as TaskDefinition, definitions[0] as TaskDefinition]),
        REAL,
      );
      expect(forwards.taskId).toBe('x');
      expect(backwards).toEqual(forwards);
      expect(shuffled).toEqual(forwards);
    } finally {
      disposeRoots();
    }
  });

  it('selects a task whose markdown says DONE but whose delivery never happened', () => {
    const root = scratchRoot();
    try {
      // The starvation case. `a` is `status: DONE` in the roadmap — a human
      // marked it so `b` could start — and its delivery was never concluded.
      // `selectNextTask` reports it `ALREADY_DONE` and leaves it out of its
      // ranking for ever; this selector examines it like any other task and
      // finds it first.
      writeReadyState(root, 'a');
      writeReadyState(root, 'b');
      const graph = graphOf([task('a', [], 'DONE'), task('b', ['a'])]);
      const result = selectDeliveryTask(root, graph, REAL);
      expect(result.taskId).toBe('a');
    } finally {
      disposeRoots();
    }
  });
});

/* ══ 4. a concluded delivery is over, and stays over ══════════════════════ */

describe('a concluded delivery is never selected again', () => {
  it('answers NO_DELIVERY_PENDING for a single concluded task', () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      writeConclusion(root, 'a');
      const result = selectDeliveryTask(root, graphOf([task('a')]), REAL);
      expect(result.outcome).toBe('NO_DELIVERY_PENDING');
      expect(result.taskId).toBeNull();
      expect(result.examined).toEqual([{ taskId: 'a', position: 'DELIVERY_CONCLUDED' }]);
    } finally {
      disposeRoots();
    }
  });

  it('stays concluded after the merge receipt and the verification history are DELETED', () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      writeConclusion(root, 'a');
      // There were none to begin with, which is the point: the two directories
      // are created and then removed, so this is the world slice 10 says a
      // conclusion survives — not merely one where they were never written.
      mkdirSync(mergeReconciliationDirectory(root), { recursive: true });
      mkdirSync(postMergeVerificationDirectory(root), { recursive: true });
      writeFileSync(join(mergeReconciliationDirectory(root), 'a.json'), '{}', 'utf8');
      writeFileSync(join(postMergeVerificationDirectory(root), 'a.json'), '{}', 'utf8');
      rmSync(join(mergeReconciliationDirectory(root), 'a.json'));
      rmSync(join(postMergeVerificationDirectory(root), 'a.json'));
      const result = selectDeliveryTask(root, graphOf([task('a')]), REAL);
      expect(result.examined).toEqual([{ taskId: 'a', position: 'DELIVERY_CONCLUDED' }]);
      expect(result.outcome).toBe('NO_DELIVERY_PENDING');
    } finally {
      disposeRoots();
    }
  });

  it('stays concluded after the merge receipt and the verification history are CORRUPTED', () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      writeConclusion(root, 'a');
      mkdirSync(mergeReconciliationDirectory(root), { recursive: true });
      mkdirSync(postMergeVerificationDirectory(root), { recursive: true });
      writeFileSync(join(mergeReconciliationDirectory(root), 'a.json'), 'not json at all', 'utf8');
      writeFileSync(join(postMergeVerificationDirectory(root), 'a.json'), '\u0000\u0000', 'utf8');
      const result = selectDeliveryTask(root, graphOf([task('a')]), REAL);
      expect(result.examined).toEqual([{ taskId: 'a', position: 'DELIVERY_CONCLUDED' }]);
    } finally {
      disposeRoots();
    }
  });

  it('stays concluded when the task state itself has become unreadable', () => {
    const root = scratchRoot();
    try {
      writeConclusion(root, 'a');
      // No state file at all. A ladder that asked "is this READY_FOR_PR?" first
      // would report `NOT_ORCHESTRATED` here and, on a corrupt state, would
      // block the whole walk on a task whose delivery is finished.
      const result = selectDeliveryTask(root, graphOf([task('a')]), REAL);
      expect(result.examined).toEqual([{ taskId: 'a', position: 'DELIVERY_CONCLUDED' }]);
    } finally {
      disposeRoots();
    }
  });

  it('never opens the task state for a task it has already concluded', () => {
    const root = scratchRoot();
    try {
      writeConclusion(root, 'a');
      writeReadyState(root, 'b');
      const loadState = vi.fn(loadTaskState);
      const result = selectDeliveryTask(root, graphOf([task('a'), task('b', ['a'])]), { loadState });
      expect(result.taskId).toBe('b');
      // One read, for `b`. The conclusion answered `a` on its own — which is
      // what makes a deleted receipt unable to un-conclude anything.
      expect(loadState.mock.calls.map((c) => c[1])).toEqual(['b']);
    } finally {
      disposeRoots();
    }
  });

  it('selects the later pending task when the earlier one is concluded', () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      writeConclusion(root, 'a');
      writeReadyState(root, 'b');
      const result = selectDeliveryTask(root, graphOf([task('a'), task('b', ['a'])]), REAL);
      expect(result.outcome).toBe('DELIVERY_TASK_SELECTED');
      expect(result.taskId).toBe('b');
      expect(result.examined).toEqual([
        { taskId: 'a', position: 'DELIVERY_CONCLUDED' },
        { taskId: 'b', position: 'DELIVERY_PENDING' },
      ]);
    } finally {
      disposeRoots();
    }
  });
});

/* ══ 5. a candidate nobody can read is surfaced, never stepped over ═══════ */

describe('a candidate whose records cannot be read stops the walk', () => {
  /** Each case: how the earlier task is broken, driven against a healthy later one. */
  const breakages: readonly (readonly [string, (root: string) => void])[] = [
    [
      'a conclusion that is not JSON',
      (root) => {
        mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
        writeFileSync(conclusionPath(root, 'a'), 'nonsense', 'utf8');
      },
    ],
    [
      'a conclusion from a newer build',
      (root) => writeConclusion(root, 'a', { conclusionVersion: DELIVERY_CONCLUSION_VERSION + 1 }),
    ],
    [
      'a conclusion about another task',
      (root) => {
        // Written for `a`'s path but bound to `zzz`, so the binding fails and
        // the reading is `NOT_THIS_TASK` rather than `MALFORMED`.
        mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
        const payload: DeliveryConclusionPayload = {
          conclusionVersion: DELIVERY_CONCLUSION_VERSION,
          taskId: 'zzz',
          repositoryRoot: root,
          subjectCommit: HEAD,
          mergeCommit: MERGE,
          provider: 'github',
          host: 'github.com',
          owner: 'acme',
          name: 'widget',
          pullRequestNumber: 7,
          baseRef: 'main',
          profileDigest: DIGEST,
          verifiedAt: AT,
          receiptBinding: 'e'.repeat(64),
          verificationBinding: 'f'.repeat(64),
          concludedAt: AT,
        };
        writeFileSync(
          conclusionPath(root, 'a'),
          `${JSON.stringify({
            ...payload,
            binding: deliveryConclusionBinding({ taskId: 'zzz', repositoryRoot: root }, payload),
          })}\n`,
          'utf8',
        );
      },
    ],
    [
      'a task state that is not JSON',
      (root) => {
        mkdirSync(taskRuntimeDirectory(root), { recursive: true });
        writeFileSync(join(taskRuntimeDirectory(root), 'a.json'), 'not json', 'utf8');
      },
    ],
    [
      'a task state from a newer contract version',
      (root) => {
        mkdirSync(taskRuntimeDirectory(root), { recursive: true });
        writeFileSync(
          join(taskRuntimeDirectory(root), 'a.json'),
          `${JSON.stringify({ ...validReadyForPrState({ taskId: 'a', repositoryRoot: root }), schemaVersion: 99 })}\n`,
          'utf8',
        );
      },
    ],
  ];

  for (const [what, breakIt] of breakages) {
    it(`stops at ${what}, and does not select the healthy task behind it`, () => {
      const root = scratchRoot();
      try {
        breakIt(root);
        writeReadyState(root, 'b');
        const result = selectDeliveryTask(root, graphOf([task('a'), task('b', ['a'])]), REAL);
        expect(result.outcome).toBe('DELIVERY_EVIDENCE_UNREADABLE');
        expect(result.blockedTaskId).toBe('a');
        // The load-bearing negative: the later, perfectly deliverable task was
        // NOT selected. A selector that skipped would answer `b` here and never
        // mention `a` again.
        expect(result.taskId).toBeNull();
        expect(result.examined).toEqual([{ taskId: 'a', position: 'EVIDENCE_UNREADABLE' }]);
      } finally {
        disposeRoots();
      }
    });
  }

  it('keeps the blocker and the selection in separate fields', () => {
    // A caller must not be able to read one as the other: on every outcome, at
    // most one of the two is non-null.
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      const selected = selectDeliveryTask(root, graphOf([task('a')]), REAL);
      expect(selected.taskId).toBe('a');
      expect(selected.blockedTaskId).toBeNull();

      mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
      writeFileSync(conclusionPath(root, 'a'), '{', 'utf8');
      const blocked = selectDeliveryTask(root, graphOf([task('a')]), REAL);
      expect(blocked.taskId).toBeNull();
      expect(blocked.blockedTaskId).toBe('a');
    } finally {
      disposeRoots();
    }
  });
});

/* ══ 6. nothing to deliver, and nothing to deliver from ═══════════════════ */

describe('a plan with no pending delivery is a nominal answer', () => {
  it('examines every task and selects none when none has been orchestrated', () => {
    const root = scratchRoot();
    try {
      const result = selectDeliveryTask(root, graphOf([task('a'), task('b'), task('c')]), REAL);
      expect(result.outcome).toBe('NO_DELIVERY_PENDING');
      expect(result.examined.map((c) => c.position)).toEqual([
        'NOT_ORCHESTRATED',
        'NOT_ORCHESTRATED',
        'NOT_ORCHESTRATED',
      ]);
      // Every declared task really was examined; the walk did not stop early.
      expect(result.examined.map((c) => c.taskId)).toEqual(['a', 'b', 'c']);
    } finally {
      disposeRoots();
    }
  });

  it('grades it 0, and grades an unreadable record 3', () => {
    // A hand-written table, deliberately not derived from the production one:
    // a mapping asserted against itself proves only that it exists.
    const expected: Readonly<Record<DeliveryTaskSelection, number>> = {
      DELIVERY_TASK_SELECTED: EXIT_RUN_OK,
      NO_DELIVERY_PENDING: EXIT_RUN_OK,
      DELIVERY_EVIDENCE_UNREADABLE: EXIT_RUN_NEEDS_OPERATOR,
    };
    for (const outcome of DELIVERY_TASK_SELECTIONS) {
      expect(exitCodeForDeliverySelection(outcome), outcome).toBe(expected[outcome]);
    }
  });
});

/* ══ 7. selection is routing, not authority ═══════════════════════════════ */

describe('a selection authorises nothing', () => {
  it('mints nothing, takes no lease, contacts nothing and writes nothing', () => {
    const source = readFileSync('src/deliver/select-delivery-task.ts', 'utf8');
    for (const forbidden of [
      'mintHeadPublicationGrant',
      'mintPullRequestCreationGrant',
      'mintMergeGrant',
      'acquireRepositoryExecutionLease',
      'ExecutionLeaseAuthority',
      'runGitCommand',
      'createForgeCommandRunner',
      'saveTaskState',
      'advanceTaskState',
      'writeFileSync',
      'writeFileAtomically',
      'runOwnedCommand',
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // Positive control: the same search finds what the module DOES reach for,
    // so an empty file could not pass the sweep above.
    expect(source).toContain('loadDeliveryConclusion');
    expect(source).toContain('topologicalOrder');
  });

  it('leaves the runtime directory byte-for-byte as it found it', () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      const before = readdirSync(taskRuntimeDirectory(root)).sort();
      const bytes = readFileSync(join(taskRuntimeDirectory(root), 'a.json'), 'utf8');
      const result = selectDeliveryTask(root, graphOf([task('a')]), REAL);
      expect(result.taskId).toBe('a');
      expect(readdirSync(taskRuntimeDirectory(root)).sort()).toEqual(before);
      expect(readFileSync(join(taskRuntimeDirectory(root), 'a.json'), 'utf8')).toBe(bytes);
    } finally {
      disposeRoots();
    }
  });

  it('reads no block ledger, and has no concept of a block at all', () => {
    // Fixture 9-13 of the brief, answered structurally rather than by example:
    // block membership, block order and "the current block" cannot change this
    // selector's answer, because it cannot see any of them.
    const code = codeOnly('src/deliver/select-delivery-task.ts');
    // No edge to the area at all, and none of its concepts by name. The word
    // "blocked" is this module's own — `blockedTaskId` is the task the walk
    // stopped at — so the pin names what a block IS rather than a substring
    // that happens to spell it.
    expect(code).not.toMatch(/from\s+'[^']*\/block\//);
    for (const concept of [
      'BlockDefinition',
      'BlockRunLedger',
      'loadBlockLedger',
      'blockLedgerDirectory',
      'projectBlockDependencies',
      'chainShapeOf',
      'fingerprintBlockDefinition',
      'memberRunnability',
    ]) {
      expect(code, concept).not.toContain(concept);
    }
    // Two positive controls, and the second is the one that makes `codeOnly`
    // load-bearing rather than decorative. A review measured the first version:
    // it asserted only that the raw file contains 'block', which the production
    // identifier `blockedTaskId` satisfies in the *code*, so the identity
    // function would have passed it and the stripper proved nothing.
    expect(code.replace(/\s+/g, '').length).toBeGreaterThan(600);
    const raw = readFileSync('src/deliver/select-delivery-task.ts', 'utf8');
    // A phrase that exists only in the header, so it separates the stripped
    // text from the raw one: the module IS free to explain the block hazard it
    // deliberately does not model, and the pin above must not see that prose.
    expect(raw).toContain('block run');
    expect(code).not.toContain('block run');
  });

  it('cannot be seen by the driver at all, so no act can gain a meaning from it', () => {
    // The general form of the zero-egress case below, and stronger than it: the
    // driver is not merely measured not to mutate on one selected delivery — it
    // has no way to tell a selected task from a named one, because the word
    // does not appear in it. `mayPerform` reads `--attended` and the act's own
    // flag and nothing else, and it cannot start reading a third thing without
    // failing here.
    const code = codeOnly('src/cli/delivery-driver.ts');
    expect(code).not.toMatch(/\bselect/i);
    expect(code).not.toContain('selectTask');
    expect(code).not.toContain('selectDeliveryTask');
    // Positive control: the sweep really ran over the driver's code.
    expect(code).toContain('function mayPerform');
    expect(code).toContain("options.attended !== true");
  });

  it('leaves READY_FOR_PR terminal, with no outgoing transition', () => {
    expect([...TERMINAL_STATES]).toContain('READY_FOR_PR');
    expect(TRANSITION_TABLE.READY_FOR_PR).toEqual([]);
  });
});

/* ══ 8. the CLI contract ══════════════════════════════════════════════════ */

describe('naming the delivery', () => {
  const input = (over: Partial<DeliveryCommandInput> = {}): DeliveryCommandInput =>
    ({ repository: 'C:\\repo', ...over }) as DeliveryCommandInput;

  const cases: readonly (readonly [string, DeliveryCommandInput, TaskNamingRefusal | null])[] = [
    ['--task alone', input({ task: 't' }), null],
    ['--task with --drive', input({ task: 't', drive: true }), null],
    ['--drive --select-task', input({ drive: true, selectTask: true }), null],
    ['neither', input({}), 'TASK_NOT_NAMED'],
    ['neither, with --drive', input({ drive: true }), 'TASK_NOT_NAMED'],
    ['both', input({ task: 't', selectTask: true, drive: true }), 'TASK_NAMED_AND_SELECTED'],
    ['both, without --drive', input({ task: 't', selectTask: true }), 'TASK_NAMED_AND_SELECTED'],
    ['--select-task alone', input({ selectTask: true }), 'SELECTION_REQUIRES_DRIVE'],
    ['--select-task with --observe', input({ selectTask: true, observe: true }), 'SELECTION_REQUIRES_DRIVE'],
  ];

  for (const [what, invoked, expected] of cases) {
    it(`${what} → ${expected ?? 'accepted'}`, () => {
      expect(refuseTaskNaming(invoked)).toBe(expected);
    });
  }

  it('refuses an omitted --task rather than selecting on its own', () => {
    // The safety property of making `--task` optional. A script that dropped
    // the flag must not start choosing deliveries — under `--merge-pr
    // --attended` that would be a merge on a task nobody named.
    expect(refuseTaskNaming(input({ drive: true, mergePr: true, attended: true }))).toBe(
      'TASK_NOT_NAMED',
    );
  });
});

describe('the registered surface', () => {
  const registered = (): Command => {
    const program = new Command();
    registerDeliveryCommand(program, {});
    return program;
  };

  it('keeps --task registered, and makes it no longer mandatory', () => {
    const delivery = registered().commands.find((c) => c.name() === 'delivery');
    const task = (delivery?.options ?? []).find((o) => o.long === '--task');
    expect(task).toBeDefined();
    expect(task?.mandatory).toBe(false);
    // …and it still takes a value. An id-less `--task` would be a different flag.
    expect(task?.required).toBe(true);
  });

  it('registers --select-task as a flag that takes no value', () => {
    const delivery = registered().commands.find((c) => c.name() === 'delivery');
    const select = (delivery?.options ?? []).find((o) => o.long === '--select-task');
    expect(select).toBeDefined();
    expect(select?.mandatory).toBe(false);
    expect(select?.required).toBe(false);
    expect(select?.description).toBe(SELECT_TASK_OPTION_DESCRIPTION);
  });

  it('names both ways of naming a delivery in the command description', () => {
    // `--task` was exempt from the surface-wide rule only because it was a
    // `requiredOption`; it is not one any more, so it owes a clause like every
    // other optional flag. The rule itself is asserted in
    // `tests/v4-09-post-merge-verification.test.ts`; what is asserted here is
    // that this slice's two clauses say the load-bearing things.
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('--task');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('--select-task');
    expect(DELIVERY_COMMAND_DESCRIPTION).toContain('authorises nothing that naming one does not');
  });

  it('says on the flag itself that selecting authorises nothing', () => {
    expect(SELECT_TASK_OPTION_DESCRIPTION).toContain('It authorises nothing');
    expect(SELECT_TASK_OPTION_DESCRIPTION).toContain('Requires --drive');
    expect(SELECT_TASK_OPTION_DESCRIPTION).toContain('does not combine with --task');
    // The behaviour an operator would otherwise reasonably assume, denied in
    // writing on the surface they read before running it.
    expect(SELECT_TASK_OPTION_DESCRIPTION).toContain('rather than being stepped over');
  });

  it('carries no forbidden word in any registered option name', () => {
    // The repository-wide ban, re-asked against the live program rather than
    // remembered — this slice adds an option and is the reason to ask again.
    const program = registered();
    const longs = program.commands.flatMap((c) => c.options.map((o) => o.long ?? ''));
    expect(longs).toContain('--select-task');
    for (const long of longs) {
      expect(long, long).not.toMatch(/force|unattended|adopt|takeover|steal/i);
    }
  });

  it('tells an operator in the trailer that a choice is not a permission', () => {
    expect(SELECTION_TRAILER).toContain('authorises nothing');
    // The rule, not one flag's name. `toContain('--attended')` stood here and
    // went stale the moment V4 slice 13 gave the publication a second grant:
    // the sentence would still have contained the substring while telling an
    // operator running unattended that their act needs a flag their own
    // invocation refuses. What has to be true is that selecting adds no
    // authority and that each act still needs its own flag AND a grant.
    expect(SELECTION_TRAILER).toContain('their own flag and a grant that names that act');
    expect(SELECTION_TRAILER).toContain('--attended for any of them');
    expect(SELECTION_TRAILER).toContain('--automatic-publish-head-only for the publication alone');
    expect(SELECTION_TRAILER).toContain('the walk stops there');
  });
});

/* ══ 9. the command, end to end ═══════════════════════════════════════════ */

describe('delivery --drive --select-task, through the command', () => {
  const TASK_DIR = 'tasks';

  /** Counts of everything that could leave this machine. All must stay zero. */
  interface Egress {
    readonly forge: number;
    readonly publications: number;
    readonly creations: number;
    readonly merges: number;
  }

  interface CliRun {
    readonly stdout: string;
    readonly exitCode: number | undefined;
    readonly egress: Egress;
    readonly stateReads: readonly string[];
    /** How many times the repository resolver was called. */
    readonly resolves: number;
  }

  /**
   * One invocation, against a repository whose resolution is substituted.
   *
   * The resolver is a seam rather than a real profile because what this section
   * measures is the *selection* and the authority around it, and a real
   * `resolveRepository` would add a Git subprocess per case for a value every
   * case wants identical. The task source, however, is real: the files on disk
   * are what `discoverTasks` reads, which is the whole input set under test.
   */
  async function runCli(
    root: string,
    argv: readonly string[],
    tasks: Readonly<Record<string, string>>,
  ): Promise<CliRun> {
    mkdirSync(join(root, TASK_DIR), { recursive: true });
    for (const [name, contents] of Object.entries(tasks)) {
      writeFileSync(join(root, TASK_DIR, name), contents, 'utf8');
    }

    let forge = 0;
    let publications = 0;
    let creations = 0;
    let merges = 0;
    let resolves = 0;
    const stateReads: string[] = [];

    const program = new Command();
    program.exitOverride();
    registerDeliveryCommand(program, {
      resolveRepository: async () => (
        resolves += 1,
        {
          ok: true,
          repository: {
            id: 'fixture-repo',
            root,
            gitCommonDir: join(root, '.git'),
            taskSource: { kind: 'MARKDOWN_DIRECTORY', path: TASK_DIR },
            verification: { phases: [] },
            delivery: {
              declared: true,
              remoteName: 'origin',
              result: {
                outcome: 'RESOLVED',
                target: { provider: 'github', host: 'github.com', owner: 'acme', name: 'widget' },
              },
            },
          },
        }) as never,
      loadTaskState: ((r: string, id: string) => {
        stateReads.push(id);
        return loadTaskState(r, id);
      }) as never,
      // A forge that answers, so the driver reaches the authority question
      // rather than stopping at a reading it could not take: no open pull
      // request at this head, and a commit whose checks succeeded.
      runner: (async (_command: string, args: readonly string[]) => {
        forge += 1;
        const path = args.find((a) => a.startsWith('repos/')) ?? '';
        if (path.endsWith('/pulls')) return commandResult({ stdout: '[]' });
        if (path.endsWith('/check-runs')) {
          return commandResult({
            stdout: JSON.stringify({
              total_count: 1,
              check_runs: [{ head_sha: SHA_B, status: 'completed', conclusion: 'success' }],
            }),
          });
        }
        return commandResult({ stdout: JSON.stringify({ sha: SHA_B, state: 'success', total_count: 0, statuses: [] }) });
      }) as never,
      publicationRunner: (async () => {
        publications += 1;
        return { exitCode: 1, stdout: '', stderr: '' };
      }) as never,
      creationRunner: (async () => {
        creations += 1;
        return { exitCode: 1, stdout: '', stderr: '' };
      }) as never,
      mergeRunner: (async () => {
        merges += 1;
        return { exitCode: 1, stdout: '', stderr: '' };
      }) as never,
      checkIgnored: (async () => 'IGNORED') as never,
      now: () => new Date(AT),
    } as never);

    const chunks: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c));
      return true;
    });
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      await program.parseAsync(['node', 'ao', 'delivery', '--repository', root, ...argv]);
      return {
        stdout: chunks.join(''),
        exitCode: process.exitCode as number | undefined,
        egress: { forge, publications, creations, merges },
        stateReads,
        resolves,
      };
    } finally {
      write.mockRestore();
      process.exitCode = previous;
    }
  }

  it('drives the first pending delivery in dependency order, naming it', async () => {
    const root = scratchRoot();
    try {
      // `t-10` sorts first lexicographically and depends on `t-9`, so a selector
      // that fell back to id order would pick the wrong one here.
      writeReadyState(root, 't-9');
      writeReadyState(root, 't-10');
      const run = await runCli(root, ['--drive', '--select-task'], {
        't-9.md': taskMarkdown('t-9'),
        't-10.md': taskMarkdown('t-10', ['t-9']),
      });
      expect(run.stdout).toContain('Task         : t-9');
      expect(run.stdout).toContain('Selected     : DELIVERY_TASK_SELECTED');
      expect(run.stdout).toContain('Examined     : 1 of the plan’s tasks');
      expect(run.stdout).toContain(SELECTION_TRAILER);
    } finally {
      disposeRoots();
    }
  });

  it('changes nothing on github.com under --attended alone', async () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      const run = await runCli(root, ['--drive', '--select-task', '--attended'], {
        'a.md': taskMarkdown('a'),
      });
      // The authority property, measured through the four seams rather than
      // read off the flags: selecting a subject grants nothing about it.
      expect(run.egress.publications).toBe(0);
      expect(run.egress.creations).toBe(0);
      expect(run.egress.merges).toBe(0);
      expect(run.stdout).toContain('ATTENDED_AUTHORITY_REQUIRED');
    } finally {
      disposeRoots();
    }
  });

  it('re-reads the selected task rather than carrying the selection’s reading', async () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      const selected = await runCli(root, ['--drive', '--select-task'], {
        'a.md': taskMarkdown('a'),
      });
      const named = await runCli(root, ['--drive', '--task', 'a'], { 'a.md': taskMarkdown('a') });

      // A differential, and it has to be one. An absolute count cannot express
      // this property: the act ladders deliberately re-read the state through
      // the same seam to catch a subject that moved (`SUBJECT_CHANGED`), so the
      // total is whatever the drive happened to reach — 3 on this path, not 2,
      // which is how the first version of this case was measured wrong.
      //
      // What the difference isolates is exactly the question: selecting adds
      // the walk's read and **nothing else**. Had the selector handed its own
      // `StateLoadResult` through instead of a task id, the command's single
      // read would have been replaced rather than added to, the difference
      // would be 0, and the evidence would be bound to bytes read before the
      // walk instead of after it.
      const reads = (r: CliRun): number => r.stateReads.filter((id) => id === 'a').length;
      expect(reads(selected) - reads(named)).toBe(1);
      // Positive control: the named run really did read the task, so the
      // subtraction is between two live measurements and not against zero.
      expect(reads(named)).toBeGreaterThan(0);
    } finally {
      disposeRoots();
    }
  });

  it('answers exit 0 and contacts nothing when no delivery is pending', async () => {
    const root = scratchRoot();
    try {
      const run = await runCli(root, ['--drive', '--select-task'], { 'a.md': taskMarkdown('a') });
      expect(run.stdout).toContain('Selection    : NO_DELIVERY_PENDING');
      expect(run.stdout).toContain('1 NOT_ORCHESTRATED');
      expect(run.exitCode).toBe(EXIT_RUN_OK);
      expect(run.egress).toEqual({ forge: 0, publications: 0, creations: 0, merges: 0 });
      // No subject was resolved and no driver ran, so the report is the
      // selection's own and carries none of the act blocks.
      expect(run.stdout).not.toContain('Drive        :');
    } finally {
      disposeRoots();
    }
  });

  it('answers exit 3 and names the task when a record cannot be read', async () => {
    const root = scratchRoot();
    try {
      mkdirSync(deliveryConclusionDirectory(root), { recursive: true });
      writeFileSync(conclusionPath(root, 'a'), 'nonsense', 'utf8');
      writeReadyState(root, 'b');
      const run = await runCli(root, ['--drive', '--select-task'], {
        'a.md': taskMarkdown('a'),
        'b.md': taskMarkdown('b', ['a']),
      });
      expect(run.stdout).toContain('Selection    : DELIVERY_EVIDENCE_UNREADABLE');
      expect(run.stdout).toContain('Blocked at   : a');
      expect(run.exitCode).toBe(EXIT_RUN_NEEDS_OPERATOR);
      // The deliverable task behind the blocker was not driven.
      expect(run.stdout).not.toContain('Task         : b');
      expect(run.egress).toEqual({ forge: 0, publications: 0, creations: 0, merges: 0 });
    } finally {
      disposeRoots();
    }
  });

  it('answers exit 2 when the plan itself cannot be read', async () => {
    const root = scratchRoot();
    try {
      // A task source with no task files. `TASK_SOURCE_EMPTY` is deliberately
      // not "nothing to deliver": a mistyped path must not arrive as a clean
      // report that the work is done.
      const run = await runCli(root, ['--drive', '--select-task'], {});
      expect(run.stdout).toContain('TASK_SOURCE_EMPTY');
      expect(run.stdout).not.toContain('NO_DELIVERY_PENDING');
      expect(run.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    } finally {
      disposeRoots();
    }
  });

  it('refuses an invocation that names no delivery, before resolving anything', async () => {
    const root = scratchRoot();
    try {
      const run = await runCli(root, ['--drive'], { 'a.md': taskMarkdown('a') });
      expect(run.stdout).toContain('TASK_NOT_NAMED');
      expect(run.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      // The resolver was never called. Counted at the seam, because the first
      // version of this asserted only that 'fixture-repo' was absent from
      // stdout — and a review measured that moving the whole naming gate BELOW
      // the resolver keeps that true, since the refusal still returns before
      // anything prints the repository. An absence in the output cannot
      // distinguish "not resolved" from "resolved and not mentioned".
      expect(run.resolves).toBe(0);
      expect(run.stdout).not.toContain('fixture-repo');
    } finally {
      disposeRoots();
    }
  });

  it('refuses --select-task beside --task, and --select-task without --drive', async () => {
    const root = scratchRoot();
    try {
      const both = await runCli(root, ['--drive', '--select-task', '--task', 'a'], {});
      expect(both.stdout).toContain('TASK_NAMED_AND_SELECTED');
      expect(both.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      const alone = await runCli(root, ['--select-task', '--observe'], {});
      expect(alone.stdout).toContain('SELECTION_REQUIRES_DRIVE');
      expect(alone.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    } finally {
      disposeRoots();
    }
  });

  it('leaves the explicit --task path exactly as it was', async () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      // No task source is needed at all on this path, which is the property:
      // naming a task reads no plan. The directory is created empty by the
      // harness and `discoverTasks` would refuse it — and is never called.
      const run = await runCli(root, ['--drive', '--task', 'a'], {});
      expect(run.stdout).toContain('Task         : a');
      expect(run.stdout).not.toContain('Selected     :');
      expect(run.stdout).not.toContain('TASK_SOURCE_EMPTY');
      expect(run.stdout).not.toContain(SELECTION_TRAILER);
    } finally {
      disposeRoots();
    }
  });

  it('still refuses --drive beside a flag that names an act, selection or not', async () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      const run = await runCli(root, ['--drive', '--select-task', '--observe'], {
        'a.md': taskMarkdown('a'),
      });
      expect(run.stdout).toContain('DRIVE_NOT_COMBINABLE');
      expect(run.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      expect(run.egress).toEqual({ forge: 0, publications: 0, creations: 0, merges: 0 });
    } finally {
      disposeRoots();
    }
  });

  it('refuses that combination on the SAME repository state that has nothing to select', async () => {
    const root = scratchRoot();
    try {
      // The case above passes with a pending delivery on disk, and a review
      // measured that this one did not: the selection walk ran first, answered
      // `NO_DELIVERY_PENDING`, printed it and exited **0** — for a command line
      // this build refuses. Whether an invocation was refused for its flags
      // depended on repository state, which is the defect. No task state is
      // written here, so the walk would answer `NO_DELIVERY_PENDING` if it ran.
      const run = await runCli(root, ['--drive', '--select-task', '--observe'], {
        'a.md': taskMarkdown('a'),
      });
      expect(run.stdout).toContain('DRIVE_NOT_COMBINABLE');
      expect(run.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
      // The refusal is decided from the flags alone, so nothing was resolved and
      // no plan was walked — the two facts that make it state-independent.
      expect(run.resolves).toBe(0);
      expect(run.stdout).not.toContain('NO_DELIVERY_PENDING');
      expect(run.stateReads).toEqual([]);
    } finally {
      disposeRoots();
    }
  });

  it('refuses it identically whether or not a delivery is pending', async () => {
    // The property stated directly: one command line, two repository states,
    // one answer. A conditional refusal is the thing being forbidden, so it is
    // asserted as an equality between the two runs rather than twice over.
    const empty = scratchRoot();
    const pending = scratchRoot();
    try {
      writeReadyState(pending, 'a');
      const a = await runCli(empty, ['--drive', '--select-task', '--decide'], {
        'a.md': taskMarkdown('a'),
      });
      const b = await runCli(pending, ['--drive', '--select-task', '--decide'], {
        'a.md': taskMarkdown('a'),
      });
      expect(a.exitCode).toBe(b.exitCode);
      expect(a.stdout).toBe(b.stdout);
      expect(a.stdout).toContain('DRIVE_NOT_COMBINABLE');
    } finally {
      disposeRoots();
    }
  });
});

/* ══ 10. selection is a snapshot, and the driver reads again ══════════════ */

describe('a selection is a snapshot and not a claim about later', () => {
  it('reads each candidate’s state at most once', () => {
    const root = scratchRoot();
    try {
      writeCreatedState(root, 'a');
      writeCreatedState(root, 'b');
      writeReadyState(root, 'c');
      const loadState = vi.fn(loadTaskState);
      const result = selectDeliveryTask(
        root,
        graphOf([task('a'), task('b', ['a']), task('c', ['b'])]),
        { loadState },
      );
      expect(result.taskId).toBe('c');
      expect(loadState.mock.calls.map((c) => c[1])).toEqual(['a', 'b', 'c']);
    } finally {
      disposeRoots();
    }
  });

  it('answers from what it read, not from what the record became afterwards', () => {
    const root = scratchRoot();
    try {
      writeReadyState(root, 'a');
      const result = selectDeliveryTask(root, graphOf([task('a')]), REAL);
      expect(result.taskId).toBe('a');
      // The record moves after the answer was given. The answer does not, and
      // nothing durable was written that would carry the stale choice forward:
      // the next invocation walks the plan again and reads this.
      writeCreatedState(root, 'a');
      expect(result.taskId).toBe('a');
      expect(selectDeliveryTask(root, graphOf([task('a')]), REAL).outcome).toBe(
        'NO_DELIVERY_PENDING',
      );
    } finally {
      disposeRoots();
    }
  });
});
