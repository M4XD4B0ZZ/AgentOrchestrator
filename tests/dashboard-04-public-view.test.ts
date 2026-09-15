/**
 * DASHBOARD-001 slice 2 — the public contract, pinned.
 *
 * Three properties are defended here, and each one fails silently if it is not
 * tested.
 *
 * REDACTION. The internal model holds absolute roots, worktree paths and a pid
 * because composing the readers needs them; none may reach a browser. The
 * fixtures below put adversarial, unmistakable strings into exactly those
 * fields, so a leak is a visible substring rather than something a reviewer has
 * to notice. Object KEYS are walked too: a field that merely exists with the
 * wrong name is a leak waiting for its value.
 *
 * NO RE-DERIVATION. Slice 1 already decided what is actionable, and it decided
 * it from two sources. If this layer recomputed that from a runtime state, the
 * phone would show the louder answer — the one that pages an operator about a
 * task the plan calls finished. The pins here drive real CONFLICT and
 * UNDETERMINED tasks through the projection and assert they cannot become
 * actionable on the way.
 *
 * THE CHANGE TOKEN. It describes the PUBLIC value, not the machine. Both
 * directions matter: a public semantic change must move it, and an internal-only
 * change must not.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  REPOSITORY_KEY_DOMAIN,
  canonicalJson,
  repositoryKeyFor,
  revisionOf,
  toPublicSnapshot,
  type PublicSnapshot,
} from '../src/dashboard/public-view.js';
import type { DashboardSnapshot, RepositorySnapshot, TaskSnapshot } from '../src/dashboard/read-model.js';

/* ── adversarial fixture values ───────────────────────────────────────────── */

/** Unmistakable, so a leak cannot hide inside ordinary prose. */
const SECRET_ROOT = 'D:\\Workspaces_VSCode\\LEAKCANARY-ROOT';
const SECRET_ROOT_TWO = 'D:\\Workspaces_VSCode\\LEAKCANARY-SECOND';
const SECRET_DECLARED = 'D:/Workspaces_VSCode/LEAKCANARY-DECLARED';
const SECRET_WORKTREE = 'D:\\Workspaces_VSCode\\LEAKCANARY-ROOT.worktrees\\T-01';
const SECRET_PID = 424242;

const FORBIDDEN_KEYS = [
  'canonicalRoot',
  'declaredPath',
  'repositoryRoot',
  'worktreePath',
  'recordedWorktreePath',
  'gitCommonDir',
  'ownerPid',
  'path',
];

function task(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'T-01',
    declaration: 'OPEN',
    runtime: {
      reading: 'LOADED',
      facts: {
        state: 'IMPLEMENTING',
        stateKind: 'REGULAR',
        stateEnteredAt: '2026-09-15T17:00:00.000Z',
        revision: 'f'.repeat(64),
        recordedPhaseAgent: 'claude',
        workBranch: 'ao/task/T-01',
        recordedWorktreePath: SECRET_WORKTREE,
        recordedCurrentCommit: 'b'.repeat(40),
        reviewRound: 1,
        reviewBudget: 3,
        blockedAgent: null,
        reportedResetAt: null,
      },
    },
    operational: 'INACTIVE',
    attention: { reading: 'NONE' },
    verification: { reading: 'NONE' },
    delivery: { reading: 'NONE' },
    ...overrides,
  } as TaskSnapshot;
}

function repository(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    canonicalRoot: SECRET_ROOT,
    declaredPath: SECRET_DECLARED,
    profile: {
      reading: 'DECLARED',
      repositoryId: 'canary',
      defaultBranch: 'main',
      taskSourcePath: 'tasks',
      maxReviewRounds: 3,
    },
    declaredTasks: { reading: 'DISCOVERED', tasks: [{ id: 'T-01', status: 'OPEN' }] },
    runtimeScan: { reading: 'READ', stateFileCount: 1, truncated: false },
    tasks: [task()],
    lease: {
      reading: 'HELD',
      ownerPid: SECRET_PID,
      acquiredAt: '2026-09-15T16:00:00.000Z',
      ownerLiveness: 'ALIVE',
      runId: null,
    },
    ...overrides,
  } as RepositorySnapshot;
}

function internal(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    observedAt: '2026-09-15T18:00:00.000Z',
    registry: {
      reading: 'REGISTERED',
      digest: 'a'.repeat(64),
      entryCount: 1,
      maxConcurrentRepositories: 1,
    },
    repositories: [repository()],
    needsOperator: [],
    notes: [],
    ...overrides,
  } as DashboardSnapshot;
}

/** Every object key anywhere in a value. */
function allKeys(value: unknown, found: string[] = []): string[] {
  if (value === null || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, found);
    return found;
  }
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    found.push(key);
    allKeys(item, found);
  }
  return found;
}

/* ═══════ redaction ══════════════════════════════════════════════════════ */

describe('nothing that names this machine crosses to the browser', () => {
  it('carries no fixture path, worktree or pid in the serialized value', () => {
    const serialized = JSON.stringify(toPublicSnapshot(internal()));

    expect(serialized).not.toContain(SECRET_ROOT);
    expect(serialized).not.toContain(SECRET_ROOT.replace(/\\/g, '\\\\'));
    expect(serialized).not.toContain(SECRET_DECLARED);
    expect(serialized).not.toContain(SECRET_WORKTREE);
    expect(serialized).not.toContain('LEAKCANARY');
    expect(serialized).not.toContain(String(SECRET_PID));
    // Structural markers of an AO checkout.
    expect(serialized).not.toContain('.agent-orchestrator');
    expect(serialized).not.toContain('.git');
    expect(serialized).not.toContain('D:\\\\');
    expect(serialized).not.toContain('D:/');
  });

  it('carries no internal-only property name, at any depth', () => {
    // A field with the wrong name is a leak that has not happened yet.
    const keys = new Set(allKeys(toPublicSnapshot(internal())));
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  it('proves the canary would have been caught, so the test is not vacuous', () => {
    // The internal value really does carry these; the assertions above are only
    // meaningful because the source of the projection contains them.
    const serializedInternal = JSON.stringify(internal());
    expect(serializedInternal).toContain('LEAKCANARY');
    expect(serializedInternal).toContain(String(SECRET_PID));
    expect(allKeys(internal())).toContain('canonicalRoot');
    expect(allKeys(internal())).toContain('ownerPid');
  });
});

/* ═══════ repository key ═════════════════════════════════════════════════ */

describe('the repository key is stable, distinct and opaque', () => {
  it('answers the same key for the same root, every time', () => {
    expect(repositoryKeyFor(SECRET_ROOT)).toBe(repositoryKeyFor(SECRET_ROOT));
    expect(toPublicSnapshot(internal()).repositories[0]?.repositoryKey).toBe(
      repositoryKeyFor(SECRET_ROOT),
    );
  });

  it('keeps two clones that declare one repositoryId apart', () => {
    const snapshot = toPublicSnapshot(
      internal({ repositories: [repository(), repository({ canonicalRoot: SECRET_ROOT_TWO })] }),
    );
    const keys = snapshot.repositories.map((r) => r.repositoryKey);
    const ids = snapshot.repositories.map((r) =>
      r.profile.reading === 'DECLARED' ? r.profile.repositoryId : null,
    );
    expect(ids).toEqual(['canary', 'canary']);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('contains no part of the path it was derived from', () => {
    const key = repositoryKeyFor(SECRET_ROOT);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('LEAKCANARY');
  });

  it('is domain-separated, so it differs from a bare digest of the path', () => {
    // The undomained digest, computed independently — which is exactly what a
    // later "simplification" would produce, and which would silently re-key
    // every preference a browser had stored against the old value.
    const undomained = createHash('sha256').update(SECRET_ROOT, 'utf8').digest('hex');
    expect(repositoryKeyFor(SECRET_ROOT)).not.toBe(undomained);

    // And the separator genuinely separates: a root that happens to begin with
    // the domain string must not collide with the empty root.
    expect(repositoryKeyFor('')).not.toBe(repositoryKeyFor(REPOSITORY_KEY_DOMAIN));
  });
});

/* ═══════ no re-derivation ═══════════════════════════════════════════════ */

describe('the public layer decides nothing Slice 1 already decided', () => {
  it('cannot turn a CONFLICT into an actionable item, even with attention set', () => {
    // The exact real-machine shape: a blocking record, AO's own attention
    // judgement saying a person is due, and a declaration that says DONE. Slice
    // 1 classified it CONFLICT. If this layer consulted `attention` instead of
    // `operational`, the phone would page about a finished task.
    const conflicted = task({
      declaration: 'DONE',
      operational: 'CONFLICT',
      runtime: {
        reading: 'LOADED',
        facts: {
          state: 'HUMAN_DECISION_REQUIRED',
          stateKind: 'BLOCKING',
          stateEnteredAt: '2026-09-15T17:00:00.000Z',
          revision: 'f'.repeat(64),
          recordedPhaseAgent: null,
          workBranch: 'ao/task/T-01',
          recordedWorktreePath: SECRET_WORKTREE,
          recordedCurrentCommit: 'b'.repeat(40),
          reviewRound: 1,
          reviewBudget: 3,
          blockedAgent: null,
          reportedResetAt: null,
        },
      },
      attention: {
        reading: 'OPERATOR_REQUIRED',
        reason: 'ESCALATED_DECISION_REQUIRED',
        action: 'Run agent-loop run --repository <path> --task <id> --attended',
        detail: null,
      },
    } as Partial<TaskSnapshot>);

    const snapshot = toPublicSnapshot(
      internal({ repositories: [repository({ tasks: [conflicted] })], needsOperator: [] }),
    );

    const published = snapshot.repositories[0]?.tasks[0];
    expect(published?.operational).toBe('CONFLICT');
    // No operator sentence, because the sentence is what gets acted on.
    expect(published?.action).toBeNull();
    expect(snapshot.needsOperator).toHaveLength(0);
    // And the command text itself must not have travelled.
    expect(JSON.stringify(snapshot)).not.toContain('--attended');
  });

  it('cannot turn an UNDETERMINED task into an actionable item', () => {
    const undetermined = task({
      declaration: 'UNDETERMINED',
      operational: 'UNDETERMINED',
      attention: {
        reading: 'OPERATOR_REQUIRED',
        reason: 'ESCALATED_DECISION_REQUIRED',
        action: 'Some operator sentence',
        detail: null,
      },
    } as Partial<TaskSnapshot>);

    const snapshot = toPublicSnapshot(
      internal({ repositories: [repository({ tasks: [undetermined] })] }),
    );
    expect(snapshot.repositories[0]?.tasks[0]?.action).toBeNull();
    expect(snapshot.needsOperator).toHaveLength(0);
  });

  it('publishes the needs-you list the internal model produced, and only that', () => {
    const actionable = task({
      operational: 'ACTIONABLE',
      attention: {
        reading: 'OPERATOR_REQUIRED',
        reason: 'ESCALATED_DECISION_REQUIRED',
        action: 'Continue it with --continue-human-decision',
        detail: null,
      },
    } as Partial<TaskSnapshot>);

    const snapshot = toPublicSnapshot(
      internal({
        repositories: [repository({ tasks: [actionable] })],
        needsOperator: [
          {
            repositoryRoot: SECRET_ROOT,
            taskId: 'T-01',
            reason: 'ESCALATED_DECISION_REQUIRED',
            action: 'Continue it with --continue-human-decision',
          },
        ],
      }),
    );

    expect(snapshot.needsOperator).toHaveLength(1);
    expect(snapshot.needsOperator[0]?.taskId).toBe('T-01');
    expect(snapshot.needsOperator[0]?.repositoryKey).toBe(repositoryKeyFor(SECRET_ROOT));
    // The entry names the repository by key, never by root.
    expect(JSON.stringify(snapshot.needsOperator)).not.toContain('LEAKCANARY');
    expect(snapshot.repositories[0]?.tasks[0]?.action?.text).toContain('--continue-human-decision');
  });

  it('never publishes a verified boolean or a stale flag', () => {
    const serialized = JSON.stringify(
      toPublicSnapshot(
        internal({
          repositories: [
            repository({
              tasks: [
                task({
                  verification: {
                    reading: 'RECORDED',
                    lastAttempt: {
                      verdict: 'FAILED',
                      attemptedAt: '2026-09-15T10:00:00.000Z',
                      forCommit: 'c'.repeat(40),
                      stoppedAtPhase: 'VERIFY',
                      exitCode: 1,
                    },
                    lastPass: { forCommit: 'd'.repeat(40), measuredAt: '2026-09-15T09:00:00.000Z' },
                  },
                } as Partial<TaskSnapshot>),
              ],
            }),
          ],
        }),
      ),
    );

    expect(serialized).toContain('passRecordedForCommit');
    expect(serialized).not.toContain('"verified"');
    expect(serialized).not.toContain('stale');
    expect(serialized).not.toContain('aoRunning');
    expect(serialized).not.toContain('QUEUED');
  });
});

/* ═══════ the change token ═══════════════════════════════════════════════ */

describe('the revision describes the public value, not the machine', () => {
  const base = internal();

  function revisionFor(snapshot: DashboardSnapshot): string {
    return toPublicSnapshot(snapshot).revision;
  }

  it('ignores observedAt, which changes on every poll and means nothing', () => {
    const later = internal({ observedAt: '2026-09-15T23:59:59.000Z' });
    expect(revisionFor(later)).toBe(revisionFor(base));
    expect(toPublicSnapshot(later).observedAt).not.toBe(toPublicSnapshot(base).observedAt);
  });

  it('moves when a lease owner stops answering, though no file changed', () => {
    // THE case the cheap token misses: composing the registry digest with the
    // task revisions would answer 304 here, and a dead run would read as live.
    const dead = internal({
      repositories: [
        repository({
          lease: {
            reading: 'HELD',
            ownerPid: SECRET_PID,
            acquiredAt: '2026-09-15T16:00:00.000Z',
            ownerLiveness: 'NOT_FOUND',
            runId: null,
          },
        } as Partial<RepositorySnapshot>),
      ],
    });
    expect(revisionFor(dead)).not.toBe(revisionFor(base));
  });

  it('moves when a task becomes actionable', () => {
    const changed = internal({
      repositories: [repository({ tasks: [task({ operational: 'ACTIONABLE' })] })],
    });
    expect(revisionFor(changed)).not.toBe(revisionFor(base));
  });

  it('moves when reading health degrades from READ to UNREADABLE', () => {
    const degraded = internal({
      repositories: [
        repository({ runtimeScan: { reading: 'DIRECTORY_UNREADABLE', errnoCode: 'EACCES' } } as Partial<RepositorySnapshot>),
      ],
    });
    expect(revisionFor(degraded)).not.toBe(revisionFor(base));
  });

  it('moves when needs-you membership changes', () => {
    const paged = internal({
      needsOperator: [
        {
          repositoryRoot: SECRET_ROOT,
          taskId: 'T-01',
          reason: 'ESCALATED_DECISION_REQUIRED',
          action: 'Do the thing',
        },
      ],
    });
    expect(revisionFor(paged)).not.toBe(revisionFor(base));
  });

  it('moves when verification evidence changes', () => {
    const verified = internal({
      repositories: [
        repository({
          tasks: [
            task({
              verification: {
                reading: 'RECORDED',
                lastAttempt: null,
                lastPass: { forCommit: 'e'.repeat(40), measuredAt: '2026-09-15T09:00:00.000Z' },
              },
            } as Partial<TaskSnapshot>),
          ],
        }),
      ],
    });
    expect(revisionFor(verified)).not.toBe(revisionFor(base));
  });

  it('does NOT move when only redacted internal state changed', () => {
    // The point of an ETag over the public representation: a worktree path that
    // moved, or a pid that differs, changes nothing a reader is shown. If this
    // ever fails, the public value is carrying something it should not.
    const movedInternals = internal({
      repositories: [
        repository({
          declaredPath: 'D:/somewhere/else/entirely',
          tasks: [
            task({
              runtime: {
                reading: 'LOADED',
                facts: {
                  state: 'IMPLEMENTING',
                  stateKind: 'REGULAR',
                  stateEnteredAt: '2026-09-15T17:00:00.000Z',
                  // A different bytes-digest: internal change detection only.
                  revision: '9'.repeat(64),
                  recordedPhaseAgent: 'claude',
                  workBranch: 'ao/task/T-01',
                  // A different worktree path.
                  recordedWorktreePath: 'D:\\elsewhere\\T-01',
                  recordedCurrentCommit: 'b'.repeat(40),
                  reviewRound: 1,
                  reviewBudget: 3,
                  blockedAgent: null,
                  reportedResetAt: null,
                },
              },
            } as Partial<TaskSnapshot>),
          ],
          lease: {
            reading: 'HELD',
            // A different pid, same liveness answer.
            ownerPid: 999_999,
            acquiredAt: '2026-09-15T16:00:00.000Z',
            ownerLiveness: 'ALIVE',
            runId: null,
          },
        } as Partial<RepositorySnapshot>),
      ],
    });
    expect(revisionFor(movedInternals)).toBe(revisionFor(base));
  });

  it('is insensitive to the order keys happened to be assigned in', () => {
    const snapshot = toPublicSnapshot(base);
    const body = {
      registry: snapshot.registry,
      repositories: snapshot.repositories,
      needsOperator: snapshot.needsOperator,
      notes: snapshot.notes,
    };
    // The same value, built with its keys in the opposite order.
    const reordered = {
      notes: snapshot.notes,
      needsOperator: snapshot.needsOperator,
      repositories: snapshot.repositories,
      registry: snapshot.registry,
    };
    expect(revisionOf(reordered as typeof body)).toBe(revisionOf(body));
    expect(canonicalJson(reordered)).toBe(canonicalJson(body));
  });
});

/* ═══════ deterministic ordering ═════════════════════════════════════════ */

describe('order is decided, not incidental', () => {
  it('keeps repositories in the order the internal model decided', () => {
    // AO's canonical-root ordering is applied upstream, while the roots still
    // exist. Re-sorting by the public key here would replace a meaningful order
    // with the output of a hash.
    const snapshot = toPublicSnapshot(
      internal({ repositories: [repository(), repository({ canonicalRoot: SECRET_ROOT_TWO })] }),
    );
    expect(snapshot.repositories.map((r) => r.repositoryKey)).toEqual([
      repositoryKeyFor(SECRET_ROOT),
      repositoryKeyFor(SECRET_ROOT_TWO),
    ]);
  });

  it('sorts notes deterministically, whatever order they were raised in', () => {
    const notes = [
      { code: 'TASK_STATE_UNREADABLE', repositoryRoot: SECRET_ROOT, taskId: 'T-02', detail: 'X' },
      { code: 'PROFILE_UNUSABLE', repositoryRoot: SECRET_ROOT, taskId: null, detail: null },
      { code: 'TASK_STATE_UNREADABLE', repositoryRoot: SECRET_ROOT, taskId: 'T-01', detail: 'X' },
    ];
    const forward = toPublicSnapshot(internal({ notes } as Partial<DashboardSnapshot>));
    const backward = toPublicSnapshot(
      internal({ notes: [...notes].reverse() } as Partial<DashboardSnapshot>),
    );
    expect(forward.notes.map((n) => `${n.code}/${n.taskId ?? ''}`)).toEqual(
      backward.notes.map((n) => `${n.code}/${n.taskId ?? ''}`),
    );
    expect(forward.revision).toBe(backward.revision);
  });
});

/* ═══════ the projection is pure ═════════════════════════════════════════ */

describe('the projection adds no authority', () => {
  it('does not mutate the internal snapshot it was handed', () => {
    const source = internal();
    const before = JSON.stringify(source);
    toPublicSnapshot(source);
    expect(JSON.stringify(source)).toBe(before);
  });

  it('produces the same public value twice for the same input', () => {
    const source = internal();
    const first: PublicSnapshot = toPublicSnapshot(source);
    const second: PublicSnapshot = toPublicSnapshot(source);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });
});
