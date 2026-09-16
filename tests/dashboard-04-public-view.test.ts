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
  PUBLIC_ARRAY_SEMANTICS,
  REPOSITORY_KEY_DOMAIN,
  canonicalJson,
  repositoryKeyFor,
  revisionOf,
  toPublicSnapshot,
  type PublicSnapshot,
} from '../src/dashboard/public-view.js';
import type {
  DashboardSnapshot,
  NeedsOperatorEntry,
  ReadingNote,
  RepositorySnapshot,
  TaskSnapshot,
} from '../src/dashboard/read-model.js';
import type { AttentionReason } from '../src/core/task-attention.js';

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

/* ═══════ the revision is a semantic hash ════════════════════════════════ */

/**
 * The change token must describe what a reader would see, not how the value was
 * built. Two snapshots holding the same repositories, tasks, needs-you entries
 * and notes carry the same public information; if an incidental collection order
 * moved the revision, every phone would re-download the world because a
 * directory listing came back shuffled — and the operator would learn that the
 * change indicator means nothing.
 *
 * Two of these arrays are already served in a decided order, so a pin driven
 * only through `toPublicSnapshot` would pass without any normalisation at all.
 * Those pins call `revisionOf` on a deliberately shuffled body instead, and each
 * one asserts that the faithful serialization really did differ — otherwise the
 * test proves that two identical strings hash the same.
 */
describe('the revision hashes public meaning, not insertion order', () => {
  function bodyOf(snapshot: PublicSnapshot): Omit<PublicSnapshot, 'observedAt' | 'revision'> {
    return {
      registry: snapshot.registry,
      repositories: snapshot.repositories,
      needsOperator: snapshot.needsOperator,
      notes: snapshot.notes,
    };
  }

  function needsEntry(taskId: string, reason: AttentionReason, action: string): NeedsOperatorEntry {
    return { repositoryRoot: SECRET_ROOT, taskId, reason, action };
  }

  it('answers one revision for the same repositories in a different order', () => {
    const first = repository();
    const second = repository({ canonicalRoot: SECRET_ROOT_TWO });
    const forward = toPublicSnapshot(internal({ repositories: [first, second] }));
    const backward = toPublicSnapshot(internal({ repositories: [second, first] }));

    // The served order really is different — presentation is untouched.
    expect(forward.repositories.map((r) => r.repositoryKey)).toEqual([
      repositoryKeyFor(SECRET_ROOT),
      repositoryKeyFor(SECRET_ROOT_TWO),
    ]);
    expect(backward.repositories.map((r) => r.repositoryKey)).toEqual([
      repositoryKeyFor(SECRET_ROOT_TWO),
      repositoryKeyFor(SECRET_ROOT),
    ]);
    // So the faithful serialization differs, and the revision must not.
    expect(canonicalJson(bodyOf(forward))).not.toBe(canonicalJson(bodyOf(backward)));
    expect(forward.revision).toBe(backward.revision);
  });

  it('answers one revision for the same tasks in a different order', () => {
    const first = task({ taskId: 'T-01' });
    const second = task({ taskId: 'T-02' });
    const forward = toPublicSnapshot(
      internal({ repositories: [repository({ tasks: [first, second] })] }),
    );
    const backward = toPublicSnapshot(
      internal({ repositories: [repository({ tasks: [second, first] })] }),
    );

    expect(forward.repositories[0]?.tasks.map((t) => t.taskId)).toEqual(['T-01', 'T-02']);
    expect(backward.repositories[0]?.tasks.map((t) => t.taskId)).toEqual(['T-02', 'T-01']);
    expect(canonicalJson(bodyOf(forward))).not.toBe(canonicalJson(bodyOf(backward)));
    expect(forward.revision).toBe(backward.revision);
  });

  it('answers one revision for the same needs-you entries in a different order', () => {
    const snapshot = toPublicSnapshot(
      internal({
        needsOperator: [
          needsEntry('T-01', 'ESCALATED_DECISION_REQUIRED', 'Decide T-01'),
          needsEntry('T-02', 'VERIFICATION_REMEDIATION_REQUIRED', 'Fix T-02'),
        ],
      } as Partial<DashboardSnapshot>),
    );

    const body = bodyOf(snapshot);
    const shuffled = { ...body, needsOperator: [...snapshot.needsOperator].reverse() };

    // The projection serves this list sorted, so the shuffle has to be applied
    // to the hash input directly for the pin to reach the normalisation.
    expect(snapshot.needsOperator).toHaveLength(2);
    expect(canonicalJson(shuffled)).not.toBe(canonicalJson(body));
    expect(revisionOf(shuffled)).toBe(revisionOf(body));
  });

  it('answers one revision for the same notes in a different order', () => {
    const snapshot = toPublicSnapshot(
      internal({
        notes: [
          { code: 'PROFILE_UNUSABLE', repositoryRoot: SECRET_ROOT, taskId: null, detail: null },
          {
            code: 'TASK_STATE_UNREADABLE',
            repositoryRoot: SECRET_ROOT,
            taskId: 'T-01',
            detail: 'SCHEMA_INVALID',
          },
          { code: 'ATTENTION_STORE_UNREADABLE', repositoryRoot: null, taskId: null, detail: 'EACCES' },
        ],
      } as Partial<DashboardSnapshot>),
    );

    const body = bodyOf(snapshot);
    const shuffled = { ...body, notes: [...snapshot.notes].reverse() };

    expect(snapshot.notes).toHaveLength(3);
    expect(canonicalJson(shuffled)).not.toBe(canonicalJson(body));
    expect(revisionOf(shuffled)).toBe(revisionOf(body));
  });

  it('normalizes members that share an identity, rather than trusting sort stability', () => {
    // Two needs-you entries naming ONE task. Their declared identity —
    // (repositoryKey, taskId) — cannot separate them, and the projection's own
    // sort is stable, so the served order is simply the order they arrived in.
    // Ordering on the identity alone would leave this pair exactly where it was
    // and hash two different strings.
    const escalated = needsEntry('T-01', 'ESCALATED_DECISION_REQUIRED', 'Decide it');
    const remediation = needsEntry('T-01', 'VERIFICATION_REMEDIATION_REQUIRED', 'Fix it');

    const forward = toPublicSnapshot(
      internal({ needsOperator: [escalated, remediation] } as Partial<DashboardSnapshot>),
    );
    const backward = toPublicSnapshot(
      internal({ needsOperator: [remediation, escalated] } as Partial<DashboardSnapshot>),
    );

    expect(forward.needsOperator.map((e) => e.reason)).toEqual([
      'ESCALATED_DECISION_REQUIRED',
      'VERIFICATION_REMEDIATION_REQUIRED',
    ]);
    expect(backward.needsOperator.map((e) => e.reason)).toEqual([
      'VERIFICATION_REMEDIATION_REQUIRED',
      'ESCALATED_DECISION_REQUIRED',
    ]);
    expect(canonicalJson(bodyOf(forward))).not.toBe(canonicalJson(bodyOf(backward)));
    expect(forward.revision).toBe(backward.revision);
  });

  it('still moves when a member of a normalized collection really changes', () => {
    const base = toPublicSnapshot(
      internal({
        repositories: [repository({ tasks: [task({ taskId: 'T-01' }), task({ taskId: 'T-02' })] })],
      }),
    );
    const changed = toPublicSnapshot(
      internal({
        repositories: [
          repository({
            tasks: [task({ taskId: 'T-01' }), task({ taskId: 'T-02', operational: 'CONFLICT' })],
          }),
        ],
      }),
    );
    expect(changed.revision).not.toBe(base.revision);
  });

  it('distinguishes two tasks that swapped their readings, which a key-only hash would not', () => {
    // The failure mode a normalisation can introduce: hashing the identities and
    // losing what was attached to them. Both snapshots hold {T-01, T-02}, and
    // they say opposite things about which one needs a person.
    const left = toPublicSnapshot(
      internal({
        repositories: [
          repository({
            tasks: [
              task({ taskId: 'T-01', operational: 'CONFLICT' }),
              task({ taskId: 'T-02', operational: 'INACTIVE' }),
            ],
          }),
        ],
      }),
    );
    const right = toPublicSnapshot(
      internal({
        repositories: [
          repository({
            tasks: [
              task({ taskId: 'T-01', operational: 'INACTIVE' }),
              task({ taskId: 'T-02', operational: 'CONFLICT' }),
            ],
          }),
        ],
      }),
    );
    expect(left.revision).not.toBe(right.revision);
  });

  it('moves when a needs-you sentence changes, though the identity did not', () => {
    const before = toPublicSnapshot(
      internal({
        needsOperator: [needsEntry('T-01', 'ESCALATED_DECISION_REQUIRED', 'Decide it')],
      } as Partial<DashboardSnapshot>),
    );
    const after = toPublicSnapshot(
      internal({
        needsOperator: [needsEntry('T-01', 'ESCALATED_DECISION_REQUIRED', 'Decide it differently')],
      } as Partial<DashboardSnapshot>),
    );
    expect(after.revision).not.toBe(before.revision);
  });

  it('moves when a note detail changes, though the code and subject did not', () => {
    const before = toPublicSnapshot(
      internal({
        notes: [
          { code: 'TASK_STATE_UNREADABLE', repositoryRoot: SECRET_ROOT, taskId: 'T-01', detail: 'A' },
        ],
      } as Partial<DashboardSnapshot>),
    );
    const after = toPublicSnapshot(
      internal({
        notes: [
          { code: 'TASK_STATE_UNREADABLE', repositoryRoot: SECRET_ROOT, taskId: 'T-01', detail: 'B' },
        ],
      } as Partial<DashboardSnapshot>),
    );
    expect(after.revision).not.toBe(before.revision);
  });

  it('still ignores observedAt when the collections are also reordered', () => {
    const first = repository();
    const second = repository({ canonicalRoot: SECRET_ROOT_TWO });
    const forward = toPublicSnapshot(internal({ repositories: [first, second] }));
    const backward = toPublicSnapshot(
      internal({ repositories: [second, first], observedAt: '2026-09-15T23:59:59.000Z' }),
    );
    expect(forward.revision).toBe(backward.revision);
    expect(forward.observedAt).not.toBe(backward.observedAt);
  });

  it('does not reorder the frozen public value it hashes', () => {
    // The normalisation builds its own arrays. If it sorted in place, the served
    // order — the thing this whole separation exists to protect — would change
    // as a side effect of taking the token.
    const snapshot = toPublicSnapshot(
      internal({
        repositories: [repository({ canonicalRoot: SECRET_ROOT_TWO }), repository()],
      }),
    );
    const served = snapshot.repositories.map((r) => r.repositoryKey);
    revisionOf(bodyOf(snapshot));
    expect(snapshot.repositories.map((r) => r.repositoryKey)).toEqual(served);
    expect(served).toEqual([repositoryKeyFor(SECRET_ROOT_TWO), repositoryKeyFor(SECRET_ROOT)]);
  });
});

/* ═══════ every public array is classified ═══════════════════════════════ */

/**
 * A declared semantic is worth having only if two separate things are true, and
 * each needs its own pin. A first version of this block had neither, and a
 * review found both holes.
 *
 * NAMED — no array the contract can produce is missing from the map. The walk is
 * fixture-driven, and that is exactly its limit: it sees an array only inside a
 * union variant something here actually builds. The first version walked ONE
 * comfortable snapshot, which instantiated six of the twenty-odd public union
 * members, so an array added to any other variant would have inherited `SET` by
 * omission — the thing the map's own comment says cannot happen. The fixtures
 * below therefore enumerate EVERY variant of every public union, and the
 * enumeration itself is asserted, so a reviewer can check the list against the
 * types rather than trust a sentence. What remains uncovered is honest and
 * stated: a union member added to the types and not added here is still
 * invisible to this walk.
 *
 * HONOURED — an array declared `SET` is really normalized for the revision.
 * Without this the map is decoration: nothing in the production path reads it,
 * so it can say `SET` while `revisionInput` has never heard of the array. The
 * pin permutes each declared array in the hash input and requires the token to
 * hold, which fails the moment a declaration and the normalizer disagree.
 */
describe('no public array carries an unstated order semantic', () => {
  /** Every array position in a value, as a path with `[]` for an element. */
  function arrayPaths(value: unknown, path = '', found = new Set<string>()): Set<string> {
    if (value === null || typeof value !== 'object') return found;
    if (Array.isArray(value)) {
      found.add(path);
      for (const item of value) arrayPaths(item, `${path}[]`, found);
      return found;
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      arrayPaths(item, path === '' ? key : `${path}.${key}`, found);
    }
    return found;
  }

  /** Every discriminated union in a value, by path, with the tags it carries. */
  function readingsByPath(
    value: unknown,
    path = '',
    found = new Map<string, Set<string>>(),
  ): Map<string, Set<string>> {
    if (value === null || typeof value !== 'object') return found;
    if (Array.isArray(value)) {
      for (const item of value) readingsByPath(item, `${path}[]`, found);
      return found;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.reading === 'string') {
      const tags = found.get(path) ?? new Set<string>();
      tags.add(record.reading);
      found.set(path, tags);
    }
    for (const [key, item] of Object.entries(record)) {
      readingsByPath(item, path === '' ? key : `${path}.${key}`, found);
    }
    return found;
  }

  /* ── one fixture per public union member ───────────────────────────────── */

  const ATTEMPT = {
    verdict: 'FAILED',
    attemptedAt: '2026-09-15T10:00:00.000Z',
    forCommit: 'c'.repeat(40),
    stoppedAtPhase: 'VERIFY',
    exitCode: 1,
  };

  /** Covers every PublicRuntimeReading, PublicVerificationReading, PublicDeliveryReading,
   *  every DeclarationReading and OperationalReading, and both shapes of `action`. */
  const TASK_VARIANTS: readonly Partial<TaskSnapshot>[] = [
    {}, // runtime LOADED, verification NONE, delivery NONE, declaration OPEN
    { runtime: { reading: 'NONE' } },
    { runtime: { reading: 'UNREADABLE', code: 'SCHEMA_INVALID', classification: 'MALFORMED' } },
    { verification: { reading: 'UNREADABLE', code: 'EACCES' } },
    { verification: { reading: 'RECORDED', lastAttempt: null, lastPass: null } },
    {
      verification: {
        reading: 'RECORDED',
        lastAttempt: ATTEMPT,
        lastPass: { forCommit: 'd'.repeat(40), measuredAt: '2026-09-15T09:00:00.000Z' },
      },
    },
    { delivery: { reading: 'UNKNOWN', why: 'DELIVERY_READER_THREW' } },
    {
      delivery: {
        reading: 'MERGE_RECORDED',
        pullRequestNumber: 7,
        mergeCommit: 'e'.repeat(40),
        baseRef: 'main',
      },
    },
    {
      delivery: {
        reading: 'DELIVERY_CONCLUDED',
        pullRequestNumber: 8,
        mergeCommit: 'f'.repeat(40),
        concludedAt: '2026-09-15T11:00:00.000Z',
      },
    },
    {
      // The only shape that carries an operator sentence.
      operational: 'ACTIONABLE',
      attention: {
        reading: 'OPERATOR_REQUIRED',
        reason: 'ESCALATED_DECISION_REQUIRED',
        action: 'Decide it',
        detail: null,
      },
    },
    {
      operational: 'AUTOMATIC_WAIT',
      attention: { reading: 'AUTOMATIC_WAIT', until: '2026-09-15T20:00:00.000Z' },
    },
    { declaration: 'DONE', operational: 'CONFLICT' },
    { declaration: 'NOT_DECLARED', operational: 'INACTIVE' },
    { declaration: 'UNDETERMINED', operational: 'UNDETERMINED' },
  ] as readonly Partial<TaskSnapshot>[];

  const everyTaskVariant = TASK_VARIANTS.map((overrides, index) =>
    task({ taskId: `T-${String(index + 1).padStart(2, '0')}`, ...overrides } as Partial<TaskSnapshot>),
  );

  /** Covers every PublicProfileReading, PublicDeclaredTaskReading,
   *  PublicRuntimeScanReading and PublicLeaseReading. */
  const REPOSITORY_VARIANTS: readonly Partial<RepositorySnapshot>[] = [
    {},
    {
      profile: { reading: 'UNUSABLE', code: 'PROFILE_MISSING' },
      declaredTasks: { reading: 'NOT_ATTEMPTED', why: 'PROFILE_UNUSABLE' },
    },
    { declaredTasks: { reading: 'REFUSED', code: 'TASK_SOURCE_EMPTY', taskId: null } },
    { runtimeScan: { reading: 'DIRECTORY_ABSENT' } },
    { runtimeScan: { reading: 'DIRECTORY_UNREADABLE', errnoCode: 'EACCES' } },
    { lease: { reading: 'FREE' } },
    { lease: { reading: 'OTHER', state: 'MALFORMED' } },
    { lease: { reading: 'NOT_OBSERVED', why: 'LEASE_LOCATION_UNDETERMINED' } },
  ] as readonly Partial<RepositorySnapshot>[];

  const everyRepositoryVariant = REPOSITORY_VARIANTS.map((overrides, index) =>
    repository({
      canonicalRoot: `${SECRET_ROOT}-${index}`,
      // The first repository carries every task variant; the rest carry one, so
      // the repository-level unions are covered without 100-odd tasks.
      tasks: index === 0 ? everyTaskVariant : [task({ taskId: 'T-01' })],
      ...overrides,
    } as Partial<RepositorySnapshot>),
  );

  const EVERY_NOTE: readonly ReadingNote[] = [
    { code: 'REGISTRY_UNUSABLE', repositoryRoot: null, taskId: null, detail: null },
    { code: 'PROFILE_UNUSABLE', repositoryRoot: `${SECRET_ROOT}-0`, taskId: null, detail: 'CODE' },
    { code: 'TASK_STATE_UNREADABLE', repositoryRoot: `${SECRET_ROOT}-0`, taskId: 'T-01', detail: null },
    {
      code: 'ATTENTION_STORE_DISAGREES',
      repositoryRoot: `${SECRET_ROOT}-0`,
      taskId: 'T-02',
      detail: 'NOT_ACTIONABLE',
    },
  ];

  const EVERY_NEEDS_OPERATOR: readonly NeedsOperatorEntry[] = [
    {
      repositoryRoot: `${SECRET_ROOT}-0`,
      taskId: 'T-10',
      reason: 'ESCALATED_DECISION_REQUIRED',
      action: 'Decide it',
    },
    {
      repositoryRoot: `${SECRET_ROOT}-0`,
      taskId: 'T-01',
      reason: 'VERIFICATION_REMEDIATION_REQUIRED',
      action: 'Fix it',
    },
  ];

  /** The populated snapshot, and the two registry readings it cannot also carry. */
  const populated = toPublicSnapshot(
    internal({
      repositories: everyRepositoryVariant,
      needsOperator: [...EVERY_NEEDS_OPERATOR],
      notes: [...EVERY_NOTE],
    }),
  );
  const notRegistered = toPublicSnapshot(
    internal({ registry: { reading: 'NOT_REGISTERED' }, repositories: [], needsOperator: [], notes: [] }),
  );
  const registryUnusable = toPublicSnapshot(
    internal({
      registry: { reading: 'UNUSABLE', code: 'REGISTRY_MALFORMED' },
      repositories: [],
      needsOperator: [],
      notes: [],
    }),
  );
  const EVERY_VARIANT = [populated, notRegistered, registryUnusable];

  /* ── NAMED ─────────────────────────────────────────────────────────────── */

  it('builds every public union member, so the walk below means something', () => {
    // This assertion IS the coverage claim. Compare it against the union types
    // in src/dashboard/public-view.ts: if a member is missing here, the walk
    // never sees that variant, and an array hiding in it is exempt from the map.
    const found = new Map<string, Set<string>>();
    for (const snapshot of EVERY_VARIANT) readingsByPath(snapshot, '', found);

    const asObject = Object.fromEntries(
      [...found.entries()].map(([path, tags]) => [path, [...tags].sort()]),
    );
    expect(asObject).toEqual({
      registry: ['NOT_REGISTERED', 'REGISTERED', 'UNUSABLE'],
      'repositories[].profile': ['DECLARED', 'UNUSABLE'],
      'repositories[].declaredTasks': ['DISCOVERED', 'NOT_ATTEMPTED', 'REFUSED'],
      'repositories[].runtimeScan': ['DIRECTORY_ABSENT', 'DIRECTORY_UNREADABLE', 'READ'],
      'repositories[].lease': ['FREE', 'HELD', 'NOT_OBSERVED', 'OTHER'],
      'repositories[].tasks[].runtime': ['LOADED', 'NONE', 'UNREADABLE'],
      'repositories[].tasks[].verification': ['NONE', 'RECORDED', 'UNREADABLE'],
      'repositories[].tasks[].delivery': ['DELIVERY_CONCLUDED', 'MERGE_RECORDED', 'NONE', 'UNKNOWN'],
    });

    // The two public fields that are plain strings rather than tagged unions,
    // plus both shapes of `action`, which no `reading` key would reveal.
    const tasks = populated.repositories.flatMap((r) => r.tasks);
    expect(new Set(tasks.map((t) => t.declaration))).toEqual(
      new Set(['OPEN', 'DONE', 'NOT_DECLARED', 'UNDETERMINED']),
    );
    expect(new Set(tasks.map((t) => t.operational))).toEqual(
      new Set(['INACTIVE', 'ACTIONABLE', 'AUTOMATIC_WAIT', 'CONFLICT', 'UNDETERMINED']),
    );
    expect(new Set(tasks.map((t) => t.action === null))).toEqual(new Set([true, false]));
  });

  it('names every array the public contract actually produces', () => {
    // A new public array inherits no semantic. It fails here until somebody
    // decides whether its order is information, which is the point.
    const found = new Set<string>();
    for (const snapshot of EVERY_VARIANT) arrayPaths(snapshot, '', found);
    expect([...found].sort()).toEqual(Object.keys(PUBLIC_ARRAY_SEMANTICS).sort());
  });

  it('records that none of them is a ranking today', () => {
    // An ORDERED array would need its own pin — a swap must MOVE the revision,
    // and the test would have to say what the order means. There is none, and
    // this assertion is what stops one appearing by inheritance.
    expect(new Set(Object.values(PUBLIC_ARRAY_SEMANTICS))).toEqual(new Set(['SET']));
  });

  /* ── HONOURED ──────────────────────────────────────────────────────────── */

  function bodyOf(snapshot: PublicSnapshot): Omit<PublicSnapshot, 'observedAt' | 'revision'> {
    return {
      registry: snapshot.registry,
      repositories: snapshot.repositories,
      needsOperator: snapshot.needsOperator,
      notes: snapshot.notes,
    };
  }

  /** A fixed permutation. Never random: a pin has to be reproducible. */
  function rotated<T>(items: readonly T[]): T[] {
    return items.length < 2 ? [...items] : [...items.slice(1), items[0] as T];
  }

  /** A copy of `value` with the array named by a PUBLIC_ARRAY_SEMANTICS path rotated. */
  function permuteAt(value: unknown, path: string): unknown {
    const [head, ...rest] = path.split('.');
    if (head === undefined) return value;
    const record = value as Record<string, unknown>;
    if (head.endsWith('[]')) {
      const key = head.slice(0, -2);
      const container = record[key];
      if (!Array.isArray(container)) return value;
      return { ...record, [key]: container.map((item) => permuteAt(item, rest.join('.'))) };
    }
    if (rest.length === 0) {
      const container = record[head];
      return { ...record, [head]: Array.isArray(container) ? rotated(container) : container };
    }
    return { ...record, [head]: permuteAt(record[head], rest.join('.')) };
  }

  for (const [path, semantic] of Object.entries(PUBLIC_ARRAY_SEMANTICS)) {
    it(`treats ${path} as the ${semantic} it is declared to be`, () => {
      const body = bodyOf(populated);
      const permuted = permuteAt(body, path) as typeof body;

      // Not vacuous: the permutation really changed the value being hashed.
      expect(canonicalJson(permuted)).not.toBe(canonicalJson(body));

      if (semantic === 'SET') {
        // Declared SET, so the token must not notice. This is the assertion that
        // catches a declaration the normalizer knows nothing about.
        expect(revisionOf(permuted)).toBe(revisionOf(body));
      } else {
        // Declared ORDERED, so the order is content and the token must move.
        expect(revisionOf(permuted)).not.toBe(revisionOf(body));
      }
    });
  }

  /* ── coverage of the hash input itself ─────────────────────────────────── */

  it('carries a public field it has never heard of into the token', () => {
    // The defect this nearly shipped: the hash input used to be rebuilt from a
    // list of four field names, so a field a later slice added to PublicSnapshot
    // was served to the browser and left OUT of the token — the phone would be
    // answered 304 forever while the value changed underneath it.
    //
    // The cast is the honest shape of the test: the field belongs to a type that
    // does not exist yet, and the whole point is that `revisionOf` must not need
    // to know its name.
    const body = bodyOf(populated);
    const withA = { ...body, futureField: 'A' } as unknown as typeof body;
    const withB = { ...body, futureField: 'B' } as unknown as typeof body;

    expect(revisionOf(withA)).not.toBe(revisionOf(body));
    expect(revisionOf(withA)).not.toBe(revisionOf(withB));
  });

  it('carries an undeclared future array into the token rather than dropping it', () => {
    // Worse than a scalar: an array outside the hash input hashes the same at
    // zero, one and two members, so its membership could change forever without
    // the token moving. Being INSIDE the token unnormalised is the safe failure
    // — noisy, never silent — and the classification pin above is what turns
    // that noise into a decision.
    const body = bodyOf(populated);
    const empty = { ...body, futureList: [] as string[] } as unknown as typeof body;
    const one = { ...body, futureList: ['a'] } as unknown as typeof body;
    const two = { ...body, futureList: ['a', 'b'] } as unknown as typeof body;

    expect(revisionOf(one)).not.toBe(revisionOf(empty));
    expect(revisionOf(two)).not.toBe(revisionOf(one));
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
