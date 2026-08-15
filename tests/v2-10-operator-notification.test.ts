/**
 * V2-10 — the operator notification.
 *
 * Four properties, and they take four different instruments:
 *
 *  1. the classification is **total** (the compiler) and **correct** (this
 *     suite, per member and pairwise). A `satisfies Record<…>` table proves that
 *     every ending was considered; it cannot tell two considered endings apart,
 *     and the operator-facing sentence is exactly where a swap would survive;
 *  2. the payload carries only what may leave the machine, which is measured on
 *     a value that must survive and a value that must not;
 *  3. the configuration is the opt-in, and every way of being unusable is a
 *     printed code rather than an exception or a default;
 *  4. the transport is the only network surface, which is measured over the tree
 *     — and its bytes are measured against a real loopback server rather than a
 *     stub, because "what does this actually put on a socket" is not a question
 *     an injected seam can answer.
 *
 * What is **not** claimed here: that the shipped binary opens no socket without
 * a configuration file. Every notifier in this file is either built over a
 * scratch profile or handed in, so nothing here would notice a build that
 * ignored the file. That property is measured against `dist` in a process with
 * no seams in it — `tests/dist-artifact/notification-egress-dist-artifact.mjs`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

import { BLOCK_STOP_REASONS, type BlockStopReason } from '../src/block/block-ledger.js';
import {
  BLOCK_RUN_OUTCOMES,
  type AttendedBlockResult,
  type BlockRunOutcome,
} from '../src/block/block-runner.js';
import { registerBlockCommand, type BlockCommandSeams } from '../src/cli/block-command.js';
import { EXIT_RUN_INPUT_UNUSABLE, EXIT_RUN_OK, exitCodeForBlockRun } from '../src/cli/run-exit-codes.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import {
  attentionForBlockRun,
  ENDING_JUDGEMENTS,
  judgeBlockRun,
  type NotificationDisposition,
} from '../src/notify/attention.js';
import {
  createOperatorNotifier,
  DETAIL_WITHHELD,
  notificationForBlockRun,
  notifyBlockRun,
  type NotificationTransport,
  type OperatorNotification,
  type OperatorNotifier,
  type TransportResult,
} from '../src/notify/notification.js';
import {
  loadNotificationConfig,
  MAX_NOTIFY_CONFIG_BYTES,
  validateNotificationEndpoint,
  type NotifyConfigRefusal,
} from '../src/notify/notify-config.js';
import { createNtfyTransport } from '../src/notify/ntfy-transport.js';
import { makeCanonicalTempDir } from './helpers/canonical-temp-dir.js';
import { authPreflightPasses } from './helpers/auth-evidence.js';
import {
  e2eProfile,
  recordedAgent,
  recordedVerify,
  reviewResult,
  taskFile,
  writerThatEdits,
} from './helpers/e2e-fixtures.js';
import { passingReview } from './fixtures.js';
import { releaseTestLeases } from './helpers/lease.js';
import { createRepoFixture, removeRepoFixtures } from './helpers/repo-fixtures.js';
import { removeTrackedWorkspaces, resolveFixture, trackWorkspacesOf } from './helpers/worktree-fixtures.js';

/* ─────────────────────────────── fixtures ────────────────────────────────── */

const scratchHomes: string[] = [];

/** A profile directory nobody else owns, so the real one is never touched. */
function scratchProfile(config: string | null): string {
  const home = makeCanonicalTempDir('agent-loop-notify-');
  scratchHomes.push(home);
  if (config !== null) {
    mkdirSync(join(home, '.agent-orchestrator'), { recursive: true });
    writeFileSync(join(home, '.agent-orchestrator', 'notify.yaml'), config, 'utf8');
  }
  return home;
}

const VALID_CONFIG = 'endpoint: https://ntfy.example/\ntopic: agent-loop-alpha\ntoken: tk_secret\n';

function blockResult(over: Partial<AttendedBlockResult> = {}): AttendedBlockResult {
  return Object.freeze({
    outcome: 'BLOCK_RUN_ENDED' as BlockRunOutcome,
    stopReason: 'TASK_BLOCKED' as BlockStopReason | null,
    detail: null,
    runId: 'run-0001',
    blockId: 'V2',
    steps: 3,
    tasks: Object.freeze([Object.freeze({ taskId: 'A-001', disposition: 'BLOCKED' as const, runOutcome: null })]),
    ...over,
  }) as AttendedBlockResult;
}

/** Every ending this build can reach, as a result each. */
const EVERY_ENDING: readonly AttendedBlockResult[] = [
  ...BLOCK_STOP_REASONS.map((stopReason) => blockResult({ outcome: 'BLOCK_RUN_ENDED', stopReason })),
  ...BLOCK_RUN_OUTCOMES.filter((outcome) => outcome !== 'BLOCK_RUN_ENDED').map((outcome) =>
    blockResult({ outcome, stopReason: null }),
  ),
];

function recordingTransport(answer: TransportResult = { ok: true }) {
  const sent: OperatorNotification[] = [];
  const transport: NotificationTransport = async (notification) => {
    sent.push(notification);
    return answer;
  };
  return { transport, sent };
}

/** An armed notifier whose configuration is real and whose socket is not. */
function armedNotifier(transport: NotificationTransport): OperatorNotifier {
  return createOperatorNotifier(fixedPathProvider(scratchProfile(VALID_CONFIG)), () => transport);
}

afterEach(() => {
  releaseTestLeases();
  removeRepoFixtures();
});

afterAll(() => {
  removeTrackedWorkspaces();
  for (const home of scratchHomes) rmSync(home, { recursive: true, force: true });
  scratchHomes.length = 0;
});

/* ───────────────── 1. the classification, total and correct ──────────────── */

describe('every ending is judged, and judged as itself', () => {
  /**
   * The expected disposition of every member, written out by hand.
   *
   * Deliberately a second, independent statement rather than a loop over the
   * production table: a test that reads the answer it is checking passes for any
   * answer at all.
   */
  const EXPECTED: Readonly<Record<string, NotificationDisposition>> = Object.freeze({
    COMPLETE: 'SILENT',
    OPERATOR_STOPPED: 'SILENT',
    TASK_BLOCKED: 'ATTENTION',
    TASK_ABANDONED: 'ATTENTION',
    NO_ELIGIBLE_TASK: 'ATTENTION',
    LEDGER_DIVERGED: 'ATTENTION',
    STATE_UNUSABLE: 'ATTENTION',
    DEFINITION_DRIFTED: 'ATTENTION',
    ACTIVE_TASK_UNRESOLVED: 'ATTENTION',
    LEASE_AUTHORITY_UNCERTAIN: 'ATTENTION',
    DURABLE_WRITE_FAILED: 'ATTENTION',
    RUN_GATE_REFUSED: 'ATTENTION',
    RECONCILIATION_UNRESOLVED: 'ATTENTION',
  });

  it('classifies every stop reason exactly as decided', () => {
    for (const reason of BLOCK_STOP_REASONS) {
      const disposition = attentionForBlockRun(
        blockResult({ outcome: 'BLOCK_RUN_ENDED', stopReason: reason }),
      );
      expect(disposition, reason).toBe(EXPECTED[reason]);
    }
  });

  it('classifies every unrecorded outcome exactly as decided', () => {
    for (const outcome of BLOCK_RUN_OUTCOMES) {
      if (outcome === 'BLOCK_RUN_ENDED') continue;
      expect(attentionForBlockRun(blockResult({ outcome, stopReason: null })), outcome).toBe(
        EXPECTED[outcome],
      );
    }
  });

  it('leaves nothing in either vocabulary unnamed by the expectation above', () => {
    // Guards the guard: a new member added to a vocabulary must fail here rather
    // than be skipped by two loops that only walk what they were given.
    const named = new Set(Object.keys(EXPECTED));
    for (const reason of BLOCK_STOP_REASONS) expect(named.has(reason), reason).toBe(true);
    for (const outcome of BLOCK_RUN_OUTCOMES) {
      if (outcome !== 'BLOCK_RUN_ENDED') expect(named.has(outcome), outcome).toBe(true);
    }
    expect(named.size).toBe(BLOCK_STOP_REASONS.length + BLOCK_RUN_OUTCOMES.length - 1);
  });

  it('never lets an ending that exits 0 buzz somebody, and does not read the exit table to decide', () => {
    // The cross-invariant, and the reason it is a test rather than a dependency:
    // "attention" and "what should the shell say" are two questions. A member
    // added to both tables inconsistently fails here without either table
    // knowing about the other.
    for (const ending of EVERY_ENDING) {
      if (exitCodeForBlockRun(ending) !== EXIT_RUN_OK) continue;
      expect(attentionForBlockRun(ending), ending.stopReason ?? ending.outcome).toBe('SILENT');
    }
    // And the converse is deliberately *not* asserted: OPERATOR_STOPPED exits 4
    // and is silent, which is the whole reason the two tables are two tables.
    expect(attentionForBlockRun(blockResult({ stopReason: 'OPERATOR_STOPPED' }))).toBe('SILENT');
    expect(exitCodeForBlockRun(blockResult({ stopReason: 'OPERATOR_STOPPED' }))).not.toBe(
      EXIT_RUN_OK,
    );
  });

  it('gives an instruction to exactly the endings that need one', () => {
    for (const ending of EVERY_ENDING) {
      const judged = judgeBlockRun(ending);
      if (judged.disposition === 'SILENT') expect(judged.action).toBeNull();
      else expect(judged.action.length).toBeGreaterThan(0);
    }
  });

  it('treats an ending with no reason as the defect it would be, rather than dropping it', () => {
    // `RunState.stop` always names a reason, so this is unreachable by
    // construction. Unreachable is not the same as unjudged: a lookup on
    // `undefined` would have thrown inside the notifier.
    const judged = judgeBlockRun(blockResult({ outcome: 'BLOCK_RUN_ENDED', stopReason: null }));
    expect(judged.disposition).toBe('ATTENTION');
  });
});

/* ────────────── 2. the sentence an operator acts on, pinned ──────────────── */

/**
 * One token per ending that must appear in its own action and in no other.
 *
 * This is what closes the swap: with `TASK_BLOCKED` and `NO_ELIGIBLE_TASK` both
 * `ATTENTION`, exchanging their two sentences leaves every disposition correct
 * and tells the operator to look for the wrong thing. Requiring a token is only
 * half of it — the pairwise assertion below is what proves the tokens
 * *discriminate*, rather than being satisfied by every sentence in the table.
 */
const ACTION_TOKENS: Readonly<Record<string, RegExp>> = Object.freeze({
  TASK_BLOCKED: /blocked on something a human/i,
  TASK_ABANDONED: /given up on/i,
  NO_ELIGIBLE_TASK: /eligible/i,
  LEDGER_DIVERGED: /disagree/i,
  STATE_UNUSABLE: /cannot be used/i,
  DEFINITION_DRIFTED: /no longer matches/i,
  ACTIVE_TASK_UNRESOLVED: /left active/i,
  LEASE_AUTHORITY_UNCERTAIN: /execution lease/i,
  DURABLE_WRITE_FAILED: /disk or a permission/i,
  RUN_GATE_REFUSED: /gate refused/i,
  RECONCILIATION_UNRESOLVED: /moved under a held lease/i,
});

function actionOf(ending: string): string {
  const judged =
    ending in ENDING_JUDGEMENTS.stopReasons
      ? ENDING_JUDGEMENTS.stopReasons[ending as BlockStopReason]
      : ENDING_JUDGEMENTS.outcomes[ending as Exclude<BlockRunOutcome, 'BLOCK_RUN_ENDED'>];
  if (judged.action === null) throw new Error(`${ending} is silent and has no action`);
  return judged.action;
}

describe('the sentence the operator acts on says which ending they met', () => {
  const attentionEndings = Object.keys(ACTION_TOKENS);

  it('covers every ending that needs an operator, and only those', () => {
    const needing = EVERY_ENDING.filter(
      (ending) => attentionForBlockRun(ending) === 'ATTENTION',
    ).map((ending) => ending.stopReason ?? ending.outcome);
    expect(new Set(attentionEndings)).toEqual(new Set(needing));
  });

  it('names its own ending', () => {
    for (const ending of attentionEndings) {
      expect(actionOf(ending), ending).toMatch(ACTION_TOKENS[ending]!);
    }
  });

  it('cannot be swapped with any other ending: no other sentence satisfies it', () => {
    // The other direction, and the one that makes the assertion above worth
    // anything. Every pair is checked, so a permutation of any size is caught -
    // and the constraint set is proved to be discriminating rather than merely
    // satisfied.
    for (const ending of attentionEndings) {
      for (const other of attentionEndings) {
        if (other === ending) continue;
        expect(actionOf(other), `${other} must not satisfy ${ending}`).not.toMatch(
          ACTION_TOKENS[ending]!,
        );
      }
    }
  });

  it('never tells an operator that an unrecorded ending was written down', () => {
    // A class invariant rather than four sentence assertions. For all four the
    // ledger stands at its last durable state and carries no stop reason, so a
    // sentence implying a persisted ending would send somebody looking for a
    // record that is not there.
    for (const outcome of BLOCK_RUN_OUTCOMES) {
      if (outcome === 'BLOCK_RUN_ENDED') continue;
      expect(actionOf(outcome), outcome).not.toMatch(/recorded|persisted|ledger carries/i);
    }
  });

  it('prints ASCII only, like every other operator-facing table here', () => {
    const all = attentionEndings.map((ending) => actionOf(ending)).join('');
    expect([...all].filter((character) => character.codePointAt(0)! > 0x7f)).toEqual([]);
  });
});

/* ─────────────────────────── 3. the payload ──────────────────────────────── */

describe('the payload carries only what may leave the machine', () => {
  it('does not exist at all for an ending nobody needs to hear about', () => {
    expect(notificationForBlockRun('alpha', blockResult({ stopReason: 'COMPLETE' }))).toBeNull();
    expect(
      notificationForBlockRun('alpha', blockResult({ stopReason: 'OPERATOR_STOPPED' })),
    ).toBeNull();
  });

  it('carries the ids, the ending, the steps and the tasks', () => {
    const payload = notificationForBlockRun(
      'alpha',
      blockResult({ stopReason: 'TASK_BLOCKED', detail: null }),
    );
    expect(payload).not.toBeNull();
    expect(payload?.repositoryId).toBe('alpha');
    expect(payload?.blockId).toBe('V2');
    expect(payload?.runId).toBe('run-0001');
    expect(payload?.stopReason).toBe('TASK_BLOCKED');
    expect(payload?.steps).toBe(3);
    expect(payload?.tasks).toEqual([{ taskId: 'A-001', disposition: 'BLOCKED' }]);
    expect(payload?.action).toMatch(ACTION_TOKENS['TASK_BLOCKED']!);
  });

  it('keeps a code-shaped detail and withholds anything else', () => {
    // The counter-proof pair. The first is a real store code an operator has to
    // see; the second is the shape `block-store.ts` builds out of a Zod issue,
    // which is text authored by a dependency about a document this build refuses
    // to quote over a network.
    const kept = notificationForBlockRun(
      'alpha',
      blockResult({ outcome: 'DURABLE_WRITE_FAILED', stopReason: null, detail: 'WRITE_FAILED:EPERM' }),
    );
    expect(kept?.detail).toBe('WRITE_FAILED:EPERM');

    const withheld = notificationForBlockRun(
      'alpha',
      blockResult({
        outcome: 'DURABLE_WRITE_FAILED',
        stopReason: null,
        detail: "LEDGER_CONTRACT_VIOLATION:Unrecognized key(s) in object: 'C:\\\\repos\\\\alpha'",
      }),
    );
    expect(withheld?.detail).toBe(DETAIL_WITHHELD);
  });

  it('withholds a detail that would end a line, whatever else it says', () => {
    const injected = notificationForBlockRun(
      'alpha',
      blockResult({ outcome: 'RUN_GATE_REFUSED', stopReason: null, detail: 'OK\r\nX-Evil: 1' }),
    );
    expect(injected?.detail).toBe(DETAIL_WITHHELD);
  });

  it('has no parameter through which a repository root could reach it', () => {
    // Structural rather than a string search: the builder takes the declared id,
    // and a caller that wanted to send a path would have to change the
    // signature. The assertion is the regression fence for exactly that edit.
    const payload = notificationForBlockRun('alpha', blockResult());
    expect(JSON.stringify(payload)).not.toMatch(/[A-Za-z]:\\|\/tmp\/|\/home\//);
  });
});

/* ──────────────────── 4. the opt-in, and its refusals ────────────────────── */

describe('the configuration is the opt-in', () => {
  it('is off when there is no file, and builds no transport', () => {
    const notifier = createOperatorNotifier(fixedPathProvider(scratchProfile(null)), () => {
      throw new Error('a transport must not be built for an unconfigured machine');
    });
    expect(notifier.state).toBe('NOT_CONFIGURED');
    expect(notifier.transport).toBeNull();
  });

  it('reads a usable file and normalises the endpoint', () => {
    const loaded = loadNotificationConfig(fixedPathProvider(scratchProfile(VALID_CONFIG)));
    expect(loaded.state).toBe('CONFIGURED');
    if (loaded.state !== 'CONFIGURED') return;
    expect(loaded.config).toEqual({
      endpoint: 'https://ntfy.example/',
      topic: 'agent-loop-alpha',
      token: 'tk_secret',
    });
  });

  it('is off, loudly, for every way of being unusable', () => {
    const cases: readonly (readonly [string, NotifyConfigRefusal])[] = [
      ['endpoint: https://ntfy.example/\ntopic: a\nextra: 1\n', 'CONFIG_CONTRACT_VIOLATION'],
      ['endpoint: https://ntfy.example/\n', 'CONFIG_CONTRACT_VIOLATION'],
      ['topic: a\nendpoint: https://ntfy.example/\ntoken: with a space\n', 'TOKEN_NOT_HEADER_SAFE'],
      ['topic: a\nendpoint: https://ntfy.example/\ntoken: "line\\r\\nX-Evil: 1"\n', 'TOKEN_NOT_HEADER_SAFE'],
      ['topic: has/slash\nendpoint: https://ntfy.example/\n', 'CONFIG_CONTRACT_VIOLATION'],
      ['endpoint: http://example.com/\ntopic: a\n', 'ENDPOINT_PLAINTEXT_NOT_LOOPBACK'],
      ['endpoint: http://localhost:8080/\ntopic: a\n', 'ENDPOINT_PLAINTEXT_NOT_LOOPBACK'],
      ['endpoint: file:///etc/passwd\ntopic: a\n', 'ENDPOINT_SCHEME_REFUSED'],
      ['endpoint: "https://u:p@ntfy.example/"\ntopic: a\n', 'ENDPOINT_CARRIES_CREDENTIALS'],
      ['endpoint: "https://ntfy.example/?x=1"\ntopic: a\n', 'ENDPOINT_CARRIES_QUERY'],
      ['endpoint: "https://ntfy.example/#x"\ntopic: a\n', 'ENDPOINT_CARRIES_FRAGMENT'],
      ['endpoint: not-a-url\ntopic: a\n', 'ENDPOINT_NOT_A_URL'],
      ['endpoint: [unclosed\n', 'CONFIG_MALFORMED'],
      ['__proto__:\n  polluted: true\nendpoint: https://ntfy.example/\ntopic: a\n', 'CONFIG_FORBIDDEN_KEY'],
    ];

    for (const [document, code] of cases) {
      const loaded = loadNotificationConfig(fixedPathProvider(scratchProfile(document)));
      expect(loaded.state, document).toBe('UNUSABLE');
      if (loaded.state === 'UNUSABLE') expect(loaded.code, document).toBe(code);
    }
  });

  it('refuses a file too large to be this document, before parsing it', () => {
    const huge = `topic: a\nendpoint: https://ntfy.example/\n# ${'x'.repeat(MAX_NOTIFY_CONFIG_BYTES)}\n`;
    const loaded = loadNotificationConfig(fixedPathProvider(scratchProfile(huge)));
    expect(loaded.state).toBe('UNUSABLE');
    if (loaded.state === 'UNUSABLE') expect(loaded.code).toBe('CONFIG_TOO_LARGE');
  });

  it('allows plaintext to the loopback literals and to nothing else', () => {
    expect(validateNotificationEndpoint('http://127.0.0.1:8080/').ok).toBe(true);
    expect(validateNotificationEndpoint('http://[::1]:8080/').ok).toBe(true);
    // A name is answered by DNS or a hosts file, neither of which this process
    // owns, so the exception may not be stated in terms of one.
    expect(validateNotificationEndpoint('http://localhost/').ok).toBe(false);
    expect(validateNotificationEndpoint('http://127.0.0.1.attacker.example/').ok).toBe(false);
  });

  it('keeps a reverse-proxied path and gives it a trailing slash', () => {
    const verdict = validateNotificationEndpoint('https://example.com/ntfy');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.endpoint).toBe('https://example.com/ntfy/');
  });

  it('never carries the file, the path or the endpoint into its refusal', () => {
    const loaded = loadNotificationConfig(
      fixedPathProvider(scratchProfile('endpoint: https://secret.example/hook\ntopic: a\nnope: 1\n')),
    );
    expect(loaded.state).toBe('UNUSABLE');
    if (loaded.state === 'UNUSABLE') {
      expect(JSON.stringify(loaded)).not.toMatch(/secret\.example|nope|notify\.yaml/);
    }
  });
});

/* ─────────────────────────── 5. the delivery ─────────────────────────────── */

describe('delivery is a consequence and never a decision', () => {
  it('sends exactly one payload for an ending that needs an operator', async () => {
    const recorder = recordingTransport();
    const result = await notifyBlockRun(
      armedNotifier(recorder.transport),
      'alpha',
      blockResult({ stopReason: 'LEDGER_DIVERGED' }),
    );
    expect(result.outcome).toBe('DELIVERED');
    expect(recorder.sent).toHaveLength(1);
    expect(recorder.sent[0]?.stopReason).toBe('LEDGER_DIVERGED');
  });

  it('sends nothing at all for a silent ending', async () => {
    const recorder = recordingTransport();
    const result = await notifyBlockRun(
      armedNotifier(recorder.transport),
      'alpha',
      blockResult({ stopReason: 'COMPLETE' }),
    );
    expect(result.outcome).toBe('SILENT');
    expect(recorder.sent).toEqual([]);
  });

  it('reports a refusing server without turning it into anything else', async () => {
    const recorder = recordingTransport({ ok: false, code: 'REJECTED_UNAUTHORISED' });
    const result = await notifyBlockRun(armedNotifier(recorder.transport), 'alpha', blockResult());
    expect(result).toEqual({ outcome: 'FAILED', code: 'REJECTED_UNAUTHORISED' });
  });

  it('does not throw when the transport does', async () => {
    // The property that lets the call site sit after the `finally`: an exception
    // here would reach the command's own catch and relabel a finished run as an
    // internal failure - the notifier rewriting the run's answer.
    const notifier = armedNotifier(() => {
      throw new Error('the network stack does this, with hosts in the message');
    });
    const result = await notifyBlockRun(notifier, 'alpha', blockResult());
    expect(result).toEqual({ outcome: 'FAILED', code: 'TRANSPORT_THREW' });
  });

  it('does not throw when the transport rejects', async () => {
    const notifier = armedNotifier(async () => Promise.reject(new Error('ECONNREFUSED 10.0.0.1')));
    const result = await notifyBlockRun(notifier, 'alpha', blockResult());
    expect(result.outcome).toBe('FAILED');
    expect(JSON.stringify(result)).not.toMatch(/10\.0\.0\.1|ECONNREFUSED/);
  });
});

/* ─────────────────── 6. the transport, against a real socket ─────────────── */

interface Captured {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeJS.Dict<string | string[]>;
  readonly raw: string;
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (endpoint: string, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      captured.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        raw: Buffer.concat(chunks).toString('utf8'),
      });
      handler(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${String(port)}/`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('the transport puts a bounded JSON document on the socket', () => {
  it('posts the payload as JSON, with the token in the one header it belongs in', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(200).end('ok');
      },
      async (endpoint, captured) => {
        const transport = createNtfyTransport({ endpoint, topic: 'alpha-topic', token: 'tk_secret' });
        const payload = notificationForBlockRun('alpha', blockResult({ stopReason: 'TASK_BLOCKED' }));
        const sent = await transport(payload!);

        expect(sent.ok).toBe(true);
        expect(captured).toHaveLength(1);
        const request = captured[0]!;
        expect(request.method).toBe('POST');
        expect(request.headers['content-type']).toBe('application/json');
        expect(request.headers['authorization']).toBe('Bearer tk_secret');
        const body = JSON.parse(request.raw) as Record<string, unknown>;
        expect(body['topic']).toBe('alpha-topic');
        expect(body['message']).toContain('TASK_BLOCKED');
        expect(body['message']).toContain('A-001');
      },
    );
  });

  it('cannot be made to write a second header, whatever a payload contains', async () => {
    // The payload here is hand-made and could not be produced by this build - a
    // run id passes the ledger's grammar. That is the point: the transport's
    // safety must not rest on an upstream validation, and JSON.stringify encodes
    // what a header would have obeyed.
    await withServer(
      (_request, response) => {
        response.writeHead(200).end('ok');
      },
      async (endpoint, captured) => {
        const transport = createNtfyTransport({ endpoint, topic: 'alpha-topic', token: null });
        await transport({
          repositoryId: 'alpha',
          blockId: 'V2',
          runId: 'run\r\nX-Evil: 1',
          outcome: 'RUN_GATE_REFUSED',
          stopReason: null,
          detail: 'AUTH_PREFLIGHT_FAILED',
          steps: 0,
          tasks: [],
          action: 'a gate refused and no task was driven',
        });

        const request = captured[0]!;
        expect(request.headers['x-evil']).toBeUndefined();
        expect(request.raw).toContain('run\\r\\nX-Evil: 1');
        expect(request.headers['authorization']).toBeUndefined();
      },
    );
  });

  it('refuses to follow a redirect out of the validated boundary', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(302, { location: 'https://elsewhere.example/' }).end();
      },
      async (endpoint) => {
        const transport = createNtfyTransport({ endpoint, topic: 'alpha-topic', token: null });
        const sent = await transport(notificationForBlockRun('alpha', blockResult())!);
        expect(sent).toEqual({ ok: false, code: 'TRANSPORT_FAILED' });
      },
    );
  });

  it('tells an unauthorised rejection apart from a broken server', async () => {
    await withServer(
      (_request, response) => {
        response.writeHead(401).end();
      },
      async (endpoint) => {
        const transport = createNtfyTransport({ endpoint, topic: 't', token: null });
        expect(await transport(notificationForBlockRun('alpha', blockResult())!)).toEqual({
          ok: false,
          code: 'REJECTED_UNAUTHORISED',
        });
      },
    );
    await withServer(
      (_request, response) => {
        response.writeHead(503).end();
      },
      async (endpoint) => {
        const transport = createNtfyTransport({ endpoint, topic: 't', token: null });
        expect(await transport(notificationForBlockRun('alpha', blockResult())!)).toEqual({
          ok: false,
          code: 'REJECTED_BY_SERVER',
        });
      },
    );
  });
});

/* ───────────────── 7. one file may reach the network, and one only ───────── */

describe('the network surface of this build is one module', () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const ALLOWED = 'notify/ntfy-transport.ts';

  function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    });
  }

  it('is the only place that can open a socket', () => {
    // Over the tree rather than by convention: the property is that egress
    // happens in one file, and a reviewer cannot maintain that by reading
    // diffs. Comments are stripped first, so this module's own prose about the
    // rule does not become an exception to it.
    const network = /(^|[^\w.])fetch\s*\(|['"]node:(http|https|net|tls|dgram|dns)['"]/;
    const offenders = sourceFiles(SRC).filter((path) => {
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      return network.test(code);
    });

    expect(offenders.map((path) => relative(SRC, path).split('\\').join('/'))).toEqual([ALLOWED]);
  });

  it('would notice if the pattern stopped matching the module it is aimed at', () => {
    // The false-negative guard: a scan that matches nothing is a scan that
    // passes for any tree at all.
    const code = readFileSync(join(SRC, 'notify', 'ntfy-transport.ts'), 'utf8');
    expect(/(^|[^\w.])fetch\s*\(/.test(code)).toBe(true);
  });
});

/* ──────────────── 8. the command, and the one hook it has ────────────────── */

const RUN_ID = 'run-0001';
const BLOCK_ID = 'V2';

let stdout: string[] = [];

beforeEach(() => {
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function invokeBlock(args: readonly string[], seams: BlockCommandSeams = {}): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerBlockCommand(program, seams);
  await program.parseAsync(['block', ...args], { from: 'user' });
}

async function repoWith(tasks: Readonly<Record<string, readonly string[]>>) {
  const files: Record<string, string> = { '.gitignore': '.agent-orchestrator/runtime/\n' };
  for (const [taskId, dependsOn] of Object.entries(tasks)) {
    files[`tasks/${taskId}.md`] = taskFile(taskId, { dependsOn });
  }
  const root = createRepoFixture({ defaultBranch: 'main', profile: e2eProfile(), files });
  const repository = await resolveFixture(root);
  trackWorkspacesOf(repository);
  return { repository, root };
}

/**
 * Seams that drive a block to its end.
 *
 * The writer edits and AO commits it (DOGFOOD-REM-001 G1): a pass that leaves
 * nothing behind now parks, and the completion cases here need the block to
 * really complete before they can assert that nothing was sent.
 */
function drivingSeams() {
  let pass = 0;
  const agent = recordedAgent({
    claude: (call) => {
      pass += 1;
      return writerThatEdits(`src/work-${pass}.ts`, `export const pass = ${pass};
`)(call);
    },
    codex: () => reviewResult(passingReview()),
  });
  return { agent: agent.runner, verify: recordedVerify().runner };
}

describe('the command reports an ending that needs an operator, and only that', () => {
  it('says the notifier is off, before the run, when nothing is configured', async () => {
    const fixture = await repoWith({ 'A-001': ['Z-999'], 'Z-999': [] });
    const notifier = createOperatorNotifier(fixedPathProvider(scratchProfile(null)));

    await invokeBlock(
      [
        '--repository', fixture.root,
        '--block', BLOCK_ID,
        '--tasks', 'A-001',
        '--run', RUN_ID,
        '--attended',
      ],
      { authPreflight: authPreflightPasses, notifier },
    );

    // Before the run, not after it: the placement is the decision. An operator
    // who is about to walk away has to learn now that nothing will reach them.
    const printed = stdout.join('');
    expect(printed).toContain('OFF (not configured)');
    expect(printed.indexOf('OFF (not configured)')).toBeLessThan(printed.indexOf('Outcome'));
    expect(printed).toContain('NOT SENT (not configured)');
  }, 600_000);

  it('has no notification concept at all without --attended', async () => {
    // The read-only mode returns before a notifier exists. Nothing is read from
    // the operator's profile, and the report says nothing about notification:
    // there is no run to report the ending of.
    const fixture = await repoWith({ 'A-001': [] });

    await invokeBlock([
      '--repository', fixture.root,
      '--block', BLOCK_ID,
      '--tasks', 'A-001',
      '--run', RUN_ID,
    ]);

    expect(process.exitCode).toBe(EXIT_RUN_OK);
    expect(stdout.join('')).not.toContain('Notification');
  }, 600_000);

  it('delivers once for a run that ends needing an operator', async () => {
    // All members ineligible: the block opens, chooses nothing and stops
    // NO_ELIGIBLE_TASK - a real ending, with no agent started.
    const fixture = await repoWith({ 'A-001': ['Z-999'], 'Z-999': [] });
    const recorder = recordingTransport();

    await invokeBlock(
      [
        '--repository', fixture.root,
        '--block', BLOCK_ID,
        '--tasks', 'A-001',
        '--run', RUN_ID,
        '--attended',
      ],
      { authPreflight: authPreflightPasses, notifier: armedNotifier(recorder.transport) },
    );

    expect(recorder.sent).toHaveLength(1);
    expect(recorder.sent[0]?.stopReason).toBe('NO_ELIGIBLE_TASK');
    expect(recorder.sent[0]?.repositoryId).toBe(fixture.repository.id);
    expect(stdout.join('')).toContain('Notification : DELIVERED');
    // The run's own answer, unchanged by the notification beside it.
    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
  }, 600_000);

  it('sends nothing when the block completes', async () => {
    const fixture = await repoWith({ 'A-001': [] });
    const recorder = recordingTransport();
    const seams = drivingSeams();

    await invokeBlock(
      [
        '--repository', fixture.root,
        '--block', BLOCK_ID,
        '--tasks', 'A-001',
        '--run', RUN_ID,
        '--attended',
      ],
      {
        authPreflight: authPreflightPasses,
        agent: seams.agent,
        verify: seams.verify,
        notifier: armedNotifier(recorder.transport),
      },
    );

    expect(process.exitCode).toBe(EXIT_RUN_OK);
    expect(recorder.sent).toEqual([]);
    expect(stdout.join('')).toContain('SILENT');
  }, 900_000);

  it('sends nothing for a refusal that never produced a run', async () => {
    // The scope line, at the command: a member the repository does not declare
    // is refused above `runAttendedBlock`, there is no result, and a payload
    // built from one would be reconstructed rather than observed.
    const fixture = await repoWith({ 'A-001': [] });
    const recorder = recordingTransport();

    await invokeBlock(
      [
        '--repository', fixture.root,
        '--block', BLOCK_ID,
        '--tasks', 'A-001', 'GHOST-001',
        '--run', RUN_ID,
        '--attended',
      ],
      { authPreflight: authPreflightPasses, notifier: armedNotifier(recorder.transport) },
    );

    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(recorder.sent).toEqual([]);
  }, 600_000);

  it('keeps the run\'s exit code when the notification fails', async () => {
    const fixture = await repoWith({ 'A-001': ['Z-999'], 'Z-999': [] });
    const notifier = armedNotifier(() => {
      throw new Error('the push failed, and the run did not');
    });

    await invokeBlock(
      [
        '--repository', fixture.root,
        '--block', BLOCK_ID,
        '--tasks', 'A-001',
        '--run', RUN_ID,
        '--attended',
      ],
      { authPreflight: authPreflightPasses, notifier },
    );

    expect(process.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(stdout.join('')).toContain('NOT DELIVERED (TRANSPORT_THREW)');
  }, 600_000);
});
