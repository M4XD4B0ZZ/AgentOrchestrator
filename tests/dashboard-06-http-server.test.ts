/**
 * DASHBOARD-001 slice 3 — the socket, against real sockets.
 *
 * `dashboard-05` pins the decisions; this pins the things only a listener can
 * be wrong about. Each case here exists because it is unreachable from a pure
 * function:
 *
 *  - WHICH ADDRESS was bound, read back off the listener rather than off the
 *    argument that asked for it. An instrument that cannot fail is not an
 *    instrument, so the readback guard is also provoked: a bind asked for by
 *    *name* is refused, and the listener it opened is proved closed by binding
 *    the same port again straight afterwards.
 *  - A COLLISION, with a real second listener holding the port, ending as a
 *    refusal carrying `EADDRINUSE` and never as a quiet move to another port.
 *  - A DUPLICATED `Host`, which needs a hand-written request because no HTTP
 *    client will send two.
 *  - A REQUEST THAT THREW, and the next request on the same server answering
 *    normally — containment is a property of the server, not of a value.
 *  - NO HANDLE HELD. After a request has read a task's durable state, that file
 *    is renamed over, which is exactly what AgentOrchestrator's atomic publish
 *    does and exactly what an open handle on NTFS makes fail.
 *  - NOTHING WRITTEN. The fixture's every byte and every modification time is
 *    compared before and after a sequence of requests.
 *
 * ── Why the fixture has no Git ─────────────────────────────────────────────
 *
 * `node:child_process` is refused for this whole module, which is the only
 * honest way to pin "the HTTP layer starts nothing". That rules out the
 * repository fixture helper, which runs `git init`, so the repository here is
 * built by hand — a stricter fixture, because a reader that quietly needed Git
 * fails here rather than passing by accident. Slice 1 made the same choice for
 * the same reason.
 */

import { createServer, connect, type AddressInfo } from 'node:net';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { DASHBOARD_BIND_HOST, allowedHostsFor } from '../src/dashboard/http-contract.js';
import {
  createDashboardServer,
  startDashboardServer,
  type DashboardStartOutcome,
} from '../src/dashboard/http-server.js';
import { readDashboardSnapshot } from '../src/dashboard/read-model.js';
import { toPublicSnapshot, type PublicSnapshot } from '../src/dashboard/public-view.js';
import { fixedPathProvider } from '../src/config/internal/path-provider.js';
import type { RepositoryRegistryOutcome } from '../src/registry/repository-registry.js';

/** THE PIN. Any spawn, by anything, from anywhere in the import graph. */
vi.mock('node:child_process', () => {
  const refuse = (): never => {
    throw new Error('the dashboard server started a subprocess');
  };
  return {
    default: {},
    spawn: refuse,
    spawnSync: refuse,
    exec: refuse,
    execSync: refuse,
    execFile: refuse,
    execFileSync: refuse,
    fork: refuse,
  };
});

/* ── scratch ──────────────────────────────────────────────────────────────── */

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A leftover scratch directory is not worth failing a suite over.
    }
  }
});

function scratch(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/* ── the fixture, built with no Git ───────────────────────────────────────── */

const PROFILE = [
  'schemaVersion: 1',
  'repository:',
  '  id: dashboard-http',
  '  defaultBranch: main',
  'taskSource:',
  '  kind: MARKDOWN_DIRECTORY',
  '  path: tasks',
  'context:',
  '  canonicalSources:',
  '    - README.md',
  'capabilities:',
  '  codegraph: OPTIONAL',
  'verification:',
  '  phases:',
  '    - phase: VERIFY',
  '      command: [npm, run, verify]',
  'scope:',
  '  allowedPaths:',
  '    - src',
  '  protectedPaths: []',
  'completion:',
  '  maxReviewRounds: 2',
  'remote:',
  '  required: false',
  '',
].join('\n');

function taskFile(id: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: Task ${id}`,
    'status: OPEN',
    'kind: NORMAL',
    'priority: NORMAL',
    'currentFocus: false',
    'dependsOn: []',
    '---',
    '',
    'Body.',
    '',
  ].join('\n');
}

function runtimeState(root: string, taskId: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      taskId,
      repositoryId: 'dashboard-http',
      repositoryRoot: root,
      worktreePath: join(`${root}.worktrees`, taskId),
      state: 'IMPLEMENTING',
      stateEnteredAt: '2026-09-15T17:00:00.000Z',
      baseBranch: 'main',
      basePinnedCommit: 'a'.repeat(40),
      scopeAuthorityCommit: null,
      workBranch: `ao/task/${taskId}`,
      currentCommit: 'b'.repeat(40),
      reviewRound: 0,
      maxReviewRounds: 2,
      blockedAgent: null,
      resumeFrom: null,
      reportedResetAt: null,
      worktreeCleanAtCheckpoint: true,
      findingHistory: [],
    },
    null,
    2,
  )}\n`;
}

/** A repository-shaped directory, one open task, one durable record. */
function gitFreeRepository(taskId = 'DASH-01'): string {
  const root = scratch('ao-dash-http-');
  mkdirSync(join(root, '.agent-orchestrator', 'runtime'), { recursive: true });
  writeFileSync(join(root, '.agent-orchestrator', 'repo-profile.yaml'), PROFILE, 'utf8');
  mkdirSync(join(root, 'tasks'), { recursive: true });
  writeFileSync(join(root, 'tasks', `${taskId}.md`), taskFile(taskId), 'utf8');
  writeFileSync(
    join(root, '.agent-orchestrator', 'runtime', `${taskId}.json`),
    runtimeState(root, taskId),
    'utf8',
  );
  return root;
}

function registryOf(...paths: readonly string[]): RepositoryRegistryOutcome {
  return {
    state: 'REGISTERED',
    registryDigest: 'e'.repeat(64),
    entries: paths.map((path) => ({ path })),
    maxConcurrentRepositories: 1,
  } as RepositoryRegistryOutcome;
}

/**
 * The REAL reader, pointed at a scratch profile.
 *
 * Only the registry and the profile directory are substituted. Everything the
 * snapshot does afterwards — reading task files, loading durable state,
 * inspecting the lease, deriving attention — is the production path, which is
 * what makes "nothing was written" and "no handle was held" statements about
 * this build rather than about a stub.
 */
function realSnapshotOver(root: string): () => PublicSnapshot {
  const home = scratch('ao-dash-home-');
  return (): PublicSnapshot =>
    toPublicSnapshot(
      readDashboardSnapshot({
        pathProvider: fixedPathProvider(home),
        loadRegistry: () => registryOf(root),
      }),
    );
}

/* ── talking to it ────────────────────────────────────────────────────────── */

/** A port nothing is using right now. Bound explicitly, never by omission. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Holds a port open, so a collision is a real one. */
async function occupy(port: number): Promise<() => Promise<void>> {
  const squatter = createServer();
  await new Promise<void>((resolve, reject) => {
    squatter.once('error', reject);
    squatter.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  return (): Promise<void> => new Promise<void>((resolve) => squatter.close(() => resolve()));
}

/**
 * Awaits `work`, failing loudly instead of hanging the worker, and clears the
 * timer on every path.
 *
 * Written out rather than `Promise.race([work, sleep(ms)])`: `race` settles on
 * the winner and abandons the loser, so the guard timer stays armed and holds
 * the process alive for the whole guard after the work it guarded finished.
 * A harness in this repository hung for exactly that reason.
 */
function bounded<T>(work: Promise<T>, what: string, ms = 15_000): Promise<T> {
  return new Promise<T>((settle, fail) => {
    const timer = setTimeout(() => fail(new Error(`timed out waiting for ${what}`)), ms);
    void work.then(
      (value) => {
        clearTimeout(timer);
        settle(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

interface RawAnswer {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
  readonly raw: string;
}

/**
 * One request, written by hand onto a socket.
 *
 * Hand-written because the cases that matter here are ones no client will
 * produce: two `Host` headers, a request line that is not origin-form, bytes
 * that are not a request at all.
 */
async function raw(port: number, requestText: string): Promise<RawAnswer> {
  const text = await bounded(
    new Promise<string>((resolve, reject) => {
      let received = '';
      const socket = connect({ host: '127.0.0.1', port }, () => socket.write(requestText));
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        received += chunk;
      });
      socket.on('close', () => resolve(received));
      socket.on('error', reject);
    }),
    `a reply to ${requestText.split('\r\n')[0] ?? 'a request'}`,
  );

  const split = text.indexOf('\r\n\r\n');
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? '' : text.slice(split + 4);
  const lines = head.split('\r\n');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return {
    status: Number((lines[0] ?? '').split(' ')[1] ?? '0'),
    headers,
    body,
    raw: text,
  };
}

function getRequest(port: number, path = '/api/snapshot', extra: readonly string[] = []): string {
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${DASHBOARD_BIND_HOST}:${String(port)}`,
    ...extra,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
}

/** Starts a server on a free port, runs the body, and always stops it. */
async function serving(
  snapshot: () => PublicSnapshot,
  body: (port: number, outcome: DashboardStartOutcome & { outcome: 'LISTENING' }) => Promise<void>,
  extraHosts: readonly string[] = [],
): Promise<void> {
  const port = await freePort();
  const outcome = await startDashboardServer(
    {
      bindHost: DASHBOARD_BIND_HOST,
      port,
      allowedHosts: allowedHostsFor(DASHBOARD_BIND_HOST, port, extraHosts),
      assets: new Map(),
    },
    { snapshot },
  );
  expect(outcome.outcome).toBe('LISTENING');
  if (outcome.outcome !== 'LISTENING') return;
  try {
    await body(port, outcome);
  } finally {
    await outcome.stop();
  }
}

/* ── tree comparison ──────────────────────────────────────────────────────── */

interface FileFact {
  readonly bytes: string;
  readonly modifiedAt: number;
}

function treeOf(root: string): ReadonlyMap<string, FileFact> {
  const facts = new Map<string, FileFact>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      facts.set(relative(root, path).split('\\').join('/'), {
        bytes: readFileSync(path, 'utf8'),
        modifiedAt: statSync(path).mtimeMs,
      });
    }
  };
  walk(root);
  return facts;
}

/* ── 1. the mock is live ──────────────────────────────────────────────────── */

describe('the subprocess pin means something', () => {
  it('refuses a spawn from the test itself', () => {
    expect(() => execFileSync('git', ['--version'])).toThrow(/started a subprocess/);
  });
});

/* ── 2. what gets bound ───────────────────────────────────────────────────── */

describe('the bind is the loopback literal, and it is measured', () => {
  it('reports the address it actually bound', async () => {
    await serving(realSnapshotOver(gitFreeRepository()), (port, outcome) => {
      expect(outcome.boundHost).toBe('127.0.0.1');
      expect(outcome.boundPort).toBe(port);
      return Promise.resolve();
    });
  });

  it('refuses to serve when the listener came up on something else, and closes it', async () => {
    const port = await freePort();

    // A NAME, not a literal. Whatever the resolver answers — `::1` on this
    // machine, `127.0.0.1` on one that prefers it — the address bound is not
    // the string that was asked for, and the guard fires. This is the case that
    // proves the readback is capable of failing at all.
    const refused = await startDashboardServer(
      { bindHost: 'localhost', port, allowedHosts: [], assets: new Map() },
      { snapshot: realSnapshotOver(gitFreeRepository()) },
    );
    expect(refused.outcome).toBe('BOUND_ELSEWHERE');
    if (refused.outcome !== 'BOUND_ELSEWHERE') return;
    expect(refused.boundHost).not.toBeNull();

    // And the listener it opened is gone: the SAME address binds again.
    //
    // "The same" is the correction. The first version re-bound `127.0.0.1`,
    // and on this machine `localhost` resolves to `::1` — so the re-bind
    // succeeded on a different socket and would have succeeded whether or not
    // the guard had closed anything. Re-binding whatever the guard *reported*
    // is the only form of this proof that cannot pass vacuously.
    const after = await startDashboardServer(
      { bindHost: refused.boundHost ?? DASHBOARD_BIND_HOST, port, allowedHosts: [], assets: new Map() },
      { snapshot: realSnapshotOver(gitFreeRepository()) },
    );
    expect(after.outcome).toBe('LISTENING');
    if (after.outcome === 'LISTENING') {
      expect(after.boundHost).toBe(refused.boundHost);
      await after.stop();
    }
  });

  it('reports a collision and never moves to another port', async () => {
    const port = await freePort();
    const release = await occupy(port);
    try {
      const outcome = await startDashboardServer(
        { bindHost: DASHBOARD_BIND_HOST, port, allowedHosts: [], assets: new Map() },
        { snapshot: realSnapshotOver(gitFreeRepository()) },
      );
      expect(outcome.outcome).toBe('BIND_FAILED');
      if (outcome.outcome === 'BIND_FAILED') expect(outcome.errnoCode).toBe('EADDRINUSE');
      // The outcome carries no port and no address, so there is nothing a
      // caller could mistake for a listener that came up somewhere else.
      expect(Object.keys(outcome).sort()).toEqual(['errnoCode', 'outcome']);
    } finally {
      await release();
    }
  });
});

/* ── 3. answering ─────────────────────────────────────────────────────────── */

describe('the one route, over a real socket', () => {
  it('answers 200 with the public snapshot and a weak tag', async () => {
    const root = gitFreeRepository();
    const snapshot = realSnapshotOver(root);
    await serving(snapshot, async (port) => {
      const answer = await raw(port, getRequest(port));
      expect(answer.status).toBe(200);
      expect(answer.headers.get('content-type')).toBe('application/json; charset=utf-8');
      expect(answer.headers.get('cache-control')).toBe('no-store');
      expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
      expect(answer.headers.get('content-security-policy')).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(answer.headers.get('etag')?.startsWith('W/"')).toBe(true);
      expect(answer.headers.has('access-control-allow-origin')).toBe(false);
      expect(answer.headers.has('set-cookie')).toBe(false);
      expect(answer.headers.has('strict-transport-security')).toBe(false);
      expect(answer.headers.has('location')).toBe(false);

      const parsed: PublicSnapshot = JSON.parse(answer.body) as PublicSnapshot;
      expect(parsed.revision).toBe(snapshot().revision);
      expect(parsed.repositories).toHaveLength(1);

      // The redaction slice 2 decided still holds across the wire — checked in
      // BOTH spellings, which the first version of this pin did not. The
      // fixture root is a Windows path, JSON doubles every backslash, and the
      // raw form therefore could not appear in the body whatever the server
      // leaked. On this repository's Windows-only CI that assertion was
      // vacuous every time it passed.
      const escaped = JSON.stringify(root).slice(1, -1);
      expect(escaped).not.toBe(root); // the pin is only meaningful if they differ
      expect(answer.body).not.toContain(root);
      expect(answer.body).not.toContain(escaped);
      expect(answer.body).not.toContain(root.split('\\').join('/'));
      // And no drive-letter path of any kind, whoever owns it.
      expect(/[A-Za-z]:\\\\/.test(answer.body)).toBe(false);
    });
  });

  it('answers 304 with a body of zero bytes', async () => {
    await serving(realSnapshotOver(gitFreeRepository()), async (port) => {
      const first = await raw(port, getRequest(port));
      const tag = first.headers.get('etag') ?? '';
      const second = await raw(port, getRequest(port, '/api/snapshot', [`If-None-Match: ${tag}`]));
      expect(second.status).toBe(304);
      expect(second.body).toBe('');
      expect(second.headers.get('etag')).toBe(tag);
      expect(second.headers.has('content-length')).toBe(false);
    });
  });

  it('serves a new body and a new tag once the observation changes', async () => {
    const root = gitFreeRepository();
    const snapshot = realSnapshotOver(root);
    await serving(snapshot, async (port) => {
      const first = await raw(port, getRequest(port));
      const tag = first.headers.get('etag') ?? '';

      // A real change to the durable record, published the way AO publishes:
      // a new file renamed over the old one.
      const statePath = join(root, '.agent-orchestrator', 'runtime', 'DASH-01.json');
      const staged = `${statePath}.staged`;
      writeFileSync(staged, runtimeState(root, 'DASH-01').replace('IMPLEMENTING', 'VERIFYING'));
      renameSync(staged, statePath);

      const second = await raw(port, getRequest(port, '/api/snapshot', [`If-None-Match: ${tag}`]));
      expect(second.status).toBe(200);
      expect(second.headers.get('etag')).not.toBe(tag);
      expect(second.body).toContain('VERIFYING');
    });
  });

  it('refuses a Host nobody allowed, and accepts one the operator added', async () => {
    await serving(
      realSnapshotOver(gitFreeRepository()),
      async (port) => {
        const refused = await raw(
          port,
          ['GET /api/snapshot HTTP/1.1', 'Host: evil.example', 'Connection: close', '', ''].join(
            '\r\n',
          ),
        );
        expect(refused.status).toBe(421);

        const accepted = await raw(
          port,
          ['GET /api/snapshot HTTP/1.1', 'Host: AO.Example:443', 'Connection: close', '', ''].join(
            '\r\n',
          ),
        );
        expect(accepted.status).toBe(200);
      },
      ['ao.example:443'],
    );
  });

  it('refuses two Host headers rather than choosing one', async () => {
    // The case that needs a hand-written request. Node keeps the first `Host`
    // and drops the rest, so this is indistinguishable from one header unless
    // `rawHeaders` is read — which is exactly the smuggling shape.
    await serving(realSnapshotOver(gitFreeRepository()), async (port) => {
      const answer = await raw(
        port,
        [
          'GET /api/snapshot HTTP/1.1',
          `Host: ${DASHBOARD_BIND_HOST}:${String(port)}`,
          'Host: evil.example',
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      );
      expect(answer.status).toBe(400);
      expect(answer.body).toContain('BAD_REQUEST');
    });
  });

  it('answers 404 and 405 deterministically, and offers no write route', async () => {
    await serving(realSnapshotOver(gitFreeRepository()), async (port) => {
      // `/nope` and not `/`: `serving()` starts this listener with an empty
      // asset map, so `/` would answer 404 here for a reason that has nothing
      // to do with routing, while since slice 4 the shipped build answers the
      // document there. dashboard-08 pins that half against the real manifest.
      expect((await raw(port, getRequest(port, '/nope'))).status).toBe(404);
      expect((await raw(port, getRequest(port, '/api/snapshot/'))).status).toBe(404);

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const answer = await raw(
          port,
          [
            `${method} /api/snapshot HTTP/1.1`,
            `Host: ${DASHBOARD_BIND_HOST}:${String(port)}`,
            'Content-Length: 0',
            'Connection: close',
            '',
            '',
          ].join('\r\n'),
        );
        expect(answer.status, method).toBe(405);
        expect(answer.headers.get('allow'), method).toBe('GET');
      }

      // The routes a control plane would add, each still absent.
      for (const path of ['/pause', '/resume', '/retry', '/decision', '/tasks/DASH-01', '/health']) {
        expect((await raw(port, getRequest(port, path))).status, path).toBe(404);
      }
    });
  });
});

/* ── 4. one bad request is one bad request ────────────────────────────────── */

describe('a failure is contained to the request that caused it', () => {
  it('answers 500 without detail when the observation throws, and keeps serving', async () => {
    let fail = true;
    const good = realSnapshotOver(gitFreeRepository());
    await serving(
      (): PublicSnapshot => {
        if (fail) throw new Error('D:\\Workspaces_VSCode\\LEAKCANARY exploded');
        return good();
      },
      async (port) => {
        const failed = await raw(port, getRequest(port));
        expect(failed.status).toBe(500);
        expect(failed.body).toBe('{"error":"INTERNAL"}\n');
        expect(failed.raw).not.toContain('LEAKCANARY');
        // The exception's own words, and the shape a stack frame takes. The
        // status line's reason phrase is HTTP's, not this build's, so it is not
        // what is being banned here.
        expect(failed.raw).not.toContain('exploded');
        expect(failed.raw).not.toContain('    at ');

        fail = false;
        const recovered = await raw(port, getRequest(port));
        expect(recovered.status).toBe(200);
      },
    );
  });

  it('survives bytes that are not a request at all, and grades the fault', async () => {
    // This file used to install a `clientError` listener whose comment claimed
    // it restated Node's default. It REPLACED it, and with something worse:
    // every parse fault was flattened to `400`, and the socket was only
    // half-closed, so one malformed request leaked one connection for the life
    // of the process. Withdrawing that listener is what the statuses below
    // measure — a header block over the limit is `431`, and only Node's own
    // handler knows that.
    await serving(realSnapshotOver(gitFreeRepository()), async (port) => {
      expect((await raw(port, 'not-a-request\r\n\r\n')).status).toBe(400);
      expect(
        (
          await raw(
            port,
            [
              'GET /api/snapshot HTTP/1.1',
              `Host: ${DASHBOARD_BIND_HOST}:${String(port)}`,
              `X-Big: ${'x'.repeat(20_000)}`,
              'Connection: close',
              '',
              '',
            ].join('\r\n'),
          )
        ).status,
      ).toBe(431);
      // Bytes with no request line at all. What Node answers here is Node's
      // affair rather than this build's, so only the survival below is pinned.
      await raw(port, '\u0000\u0001\u0002 GARBAGE\r\n').catch(() => undefined);
      const answer = await raw(port, getRequest(port));
      expect(answer.status).toBe(200);
    });
  });

  it('installs no clientError listener, so Node keeps its own refusal', () => {
    // The structural half of the case above: a listener registered here would
    // silently take over both the status choice and the socket's fate, and
    // nothing about the happy path would change.
    const server = createDashboardServer(
      { bindHost: DASHBOARD_BIND_HOST, port: 1, allowedHosts: [], assets: new Map() },
      { snapshot: realSnapshotOver(gitFreeRepository()) },
    );
    expect(server.listenerCount('clientError')).toBe(0);
  });

  it('stops promptly with a keep-alive connection still open', async () => {
    // `server.close` alone waits for existing connections to end on their own,
    // and a keep-alive connection does not. A stop that only called it would
    // hang for as long as a browser kept its socket.
    const port = await freePort();
    const outcome = await startDashboardServer(
      { bindHost: DASHBOARD_BIND_HOST, port, allowedHosts: allowedHostsFor(DASHBOARD_BIND_HOST, port, []), assets: new Map() },
      { snapshot: realSnapshotOver(gitFreeRepository()) },
    );
    expect(outcome.outcome).toBe('LISTENING');
    if (outcome.outcome !== 'LISTENING') return;

    // Everything between here and the stop is wrapped, and every wait is
    // bounded. Without both, a server that accepted and then said nothing would
    // leave two promises pending and a listener up — which turns a failure into
    // a hung worker rather than a red test. That failure mode is on this
    // repository's record.
    const socket = connect({ host: '127.0.0.1', port });
    try {
      await bounded(
        new Promise<void>((resolve) => socket.once('connect', () => resolve())),
        'connect',
      );
      socket.write(
        [
          'GET /api/snapshot HTTP/1.1',
          `Host: ${DASHBOARD_BIND_HOST}:${String(port)}`,
          'Connection: keep-alive',
          '',
          '',
        ].join('\r\n'),
      );
      await bounded(
        new Promise<void>((resolve) => socket.once('data', () => resolve())),
        'first response byte',
      );
    } finally {
      socket.destroy();
      await outcome.stop();
    }

    // Proof the listener is really gone rather than merely reported gone.
    const reused = await startDashboardServer(
      { bindHost: DASHBOARD_BIND_HOST, port, allowedHosts: [], assets: new Map() },
      { snapshot: realSnapshotOver(gitFreeRepository()) },
    );
    expect(reused.outcome).toBe('LISTENING');
    if (reused.outcome === 'LISTENING') await reused.stop();
  });

  it('builds a server without binding one', () => {
    // `createDashboardServer` opens nothing. The split exists so a caller can
    // bind and fail; a constructor that listened would make that impossible.
    const server = createDashboardServer(
      { bindHost: DASHBOARD_BIND_HOST, port: 1, allowedHosts: [], assets: new Map() },
      { snapshot: realSnapshotOver(gitFreeRepository()) },
    );
    expect(server.listening).toBe(false);
    expect(server.address()).toBeNull();
  });
});

/* ── 5. the authority boundary ────────────────────────────────────────────── */

describe('serving changes nothing on disk', () => {
  it('leaves every byte and every modification time as it found them', async () => {
    const root = gitFreeRepository();
    const before = treeOf(root);
    await serving(realSnapshotOver(root), async (port) => {
      for (let index = 0; index < 5; index += 1) {
        expect((await raw(port, getRequest(port))).status).toBe(200);
      }
      expect((await raw(port, getRequest(port, '/nope'))).status).toBe(404);
    });
    const after = treeOf(root);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [path, fact] of after) {
      expect(fact.bytes, path).toBe(before.get(path)?.bytes);
      expect(fact.modifiedAt, path).toBe(before.get(path)?.modifiedAt);
    }
  });

  it('creates no lease, no runtime file and no directory of its own', async () => {
    const root = gitFreeRepository();
    const home = scratch('ao-dash-home-empty-');
    const port = await freePort();
    const outcome = await startDashboardServer(
      { bindHost: DASHBOARD_BIND_HOST, port, allowedHosts: allowedHostsFor(DASHBOARD_BIND_HOST, port, []), assets: new Map() },
      {
        snapshot: (): PublicSnapshot =>
          toPublicSnapshot(
            readDashboardSnapshot({
              pathProvider: fixedPathProvider(home),
              loadRegistry: () => registryOf(root),
            }),
          ),
      },
    );
    expect(outcome.outcome).toBe('LISTENING');
    if (outcome.outcome !== 'LISTENING') return;
    try {
      expect((await raw(port, getRequest(port))).status).toBe(200);
    } finally {
      await outcome.stop();
    }

    // The profile directory is where a lease, an attention record or a
    // publication authorisation would be written. Nothing put anything there.
    expect(readdirSync(home)).toEqual([]);
    // And the repository's own runtime directory holds exactly the one record
    // the fixture wrote.
    expect(readdirSync(join(root, '.agent-orchestrator', 'runtime'))).toEqual(['DASH-01.json']);
  });

  it('holds no handle across AgentOrchestrator’s atomic publish', async () => {
    // The NTFS property, provoked rather than asserted. A rename over an open
    // file fails on Windows, so if a request left a descriptor on the state
    // file — a cache, a stream, a watcher — this throws. That is the failure
    // mode the whole "read, close, answer" rule exists to avoid, and it would
    // make the *writer* fail rather than the reader.
    const root = gitFreeRepository();
    await serving(realSnapshotOver(root), async (port) => {
      expect((await raw(port, getRequest(port))).status).toBe(200);

      const statePath = join(root, '.agent-orchestrator', 'runtime', 'DASH-01.json');
      const staged = `${statePath}.staged`;
      writeFileSync(staged, runtimeState(root, 'DASH-01'), 'utf8');
      expect(() => renameSync(staged, statePath)).not.toThrow();

      // And the profile the reader also opens.
      const profilePath = join(root, '.agent-orchestrator', 'repo-profile.yaml');
      const stagedProfile = `${profilePath}.staged`;
      writeFileSync(stagedProfile, PROFILE, 'utf8');
      expect(() => renameSync(stagedProfile, profilePath)).not.toThrow();
    });
  });

  it('reads fresh every time rather than caching an observation', async () => {
    // No in-memory cache in V1: the measured cost is low enough, and a cache is
    // the thing that would need a handle or a watcher to stay correct.
    let calls = 0;
    const good = realSnapshotOver(gitFreeRepository());
    await serving(
      (): PublicSnapshot => {
        calls += 1;
        return good();
      },
      async (port) => {
        for (let index = 0; index < 3; index += 1) await raw(port, getRequest(port));
        expect(calls).toBe(3);
      },
    );
  });
});

/* ── 6. the shape of a response ───────────────────────────────────────────── */

describe('the server writes what the contract decided, and nothing more', () => {
  /**
   * The body-less branch, measured on the wire.
   *
   * The first version of this section constructed a `DashboardHttpResponse`
   * literal with `body: null` and asserted that literal's `body` was null. It
   * exercised no production code at all — `DashboardHttpResponse` is a
   * type-only import, so the block would have passed unchanged with
   * `http-server.ts` deleted. A review named the surviving mutation, and the
   * replacement below is a real one: the bytes after the header block are
   * counted, and no header describes a body that is not there.
   */
  it('writes zero body bytes, and nothing describing one, for a 304', async () => {
    await serving(realSnapshotOver(gitFreeRepository()), async (port) => {
      const first = await raw(port, getRequest(port));
      const tag = first.headers.get('etag') ?? '';
      const answer = await raw(port, getRequest(port, '/api/snapshot', [`If-None-Match: ${tag}`]));

      expect(answer.status).toBe(304);
      // Everything after the blank line, counted in bytes rather than compared
      // to a string, so a single stray newline fails this.
      expect(Buffer.byteLength(answer.body, 'utf8')).toBe(0);
      expect(answer.headers.has('content-length')).toBe(false);
      expect(answer.headers.has('content-type')).toBe(false);
      expect(answer.headers.has('transfer-encoding')).toBe(false);
    });
  });

  /**
   * The other body-less branch — and the only one this build does not write.
   *
   * `write` hands Node the same refusal for a `HEAD` as for a `POST`: the
   * contract decided one `405` with a body and a `Content-Length` describing
   * it, and Node then discards every body byte because the request method was
   * `HEAD`. So on this one path the header block IS the whole answer, and
   * whether `Allow` survived a rewrite this build never performs is a property
   * of the socket rather than of the decision. `dashboard-05` cannot reach it:
   * it calls a pure function, which returns the same value for both methods
   * whatever the wire would afterwards do to it.
   *
   * RFC 9110 requires a `405` to carry `Allow`, and this service's `405` on a
   * `HEAD` is a deliberate, stated departure from the `HEAD`-follows-`GET`
   * rule — which makes `Allow: GET` the half of that refusal a caller can act
   * on, and the half worth pinning where the bytes are.
   *
   * Measured against the `POST` beside it rather than against literals. The
   * `POST` is the positive control: without it the byte count is an absence
   * over nothing, and would pass against a server that had stopped sending a
   * refusal body at all.
   */
  it('keeps every header a 405 declared when Node strips the HEAD body', async () => {
    const refusal = (port: number, method: string): string =>
      [
        `${method} /api/snapshot HTTP/1.1`,
        `Host: ${DASHBOARD_BIND_HOST}:${String(port)}`,
        'Connection: close',
        '',
        '',
      ].join('\r\n');

    await serving(realSnapshotOver(gitFreeRepository()), async (port) => {
      const bodied = await raw(port, refusal(port, 'POST'));
      const headed = await raw(port, refusal(port, 'HEAD'));

      for (const answer of [bodied, headed]) {
        expect(answer.status).toBe(405);
        expect(answer.headers.get('allow')).toBe('GET');
      }

      // The same declared length on both, because the contract decided one
      // refusal and `HEAD` is answered from it unchanged.
      expect(headed.headers.get('content-length')).toBe(bodied.headers.get('content-length'));

      // Everything after the blank line, counted in bytes rather than compared
      // to a string, so a single stray newline fails this.
      expect(Buffer.byteLength(headed.body, 'utf8')).toBe(0);
      expect(Buffer.byteLength(bodied.body, 'utf8')).toBe(
        Number(bodied.headers.get('content-length')),
      );
    });
  });

  it('writes exactly the bytes it declared for a 200', async () => {
    await serving(realSnapshotOver(gitFreeRepository()), async (port) => {
      const answer = await raw(port, getRequest(port));
      expect(answer.status).toBe(200);
      expect(Buffer.byteLength(answer.body, 'utf8')).toBe(
        Number(answer.headers.get('content-length')),
      );
    });
  });
});

/* ── 7. the claim about caching, in every copy of it ──────────────────────── */

describe('the no-cache claim is scoped to the thing that is actually re-read', () => {
  /**
   * The cases above measure the property: no handle is held across
   * AgentOrchestrator's atomic rename, and nothing on disk moves. This one
   * pins the SENTENCE, because the sentence went out of date on its own.
   *
   * Until slice 4 this server answered one route by reading the disk, so "every
   * request reads afresh" described every request there was. Since slice 4 it
   * also answers the UI from a map loaded before the socket existed, and those
   * requests read nothing — so the old sentence claims disk I/O that does not
   * happen, in a paragraph whose whole point is which I/O happens.
   *
   * Both copies are checked in one case because they are one claim.
   * `http-server.ts` states it for a reader of the module and `README.md`
   * states it for an operator, and fixing a sentence in one copy while its twin
   * stands is the defect this branch has hit more often than any other.
   */
  const flatten = (at: string): string =>
    readFileSync(new URL(at, import.meta.url), 'utf8')
      // Strip a JSDoc line's leading `*`, but never Markdown's `**bold**`.
      .replace(/^[ \t]*\*(?!\*)[ \t]?/gm, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();

  // Retracted: true of slice 3, false of seven of this build's eight routes —
  // the seven assets read nothing at all, and only /api/snapshot re-reads.
  const RETRACTED = [
    'every request reads afresh',
    'each request reads afresh',
    'there is no cache.',
  ];

  // The argument that survives, and the half slice 4 added to it. The second is
  // what makes the first stronger rather than narrower: an asset cannot hold a
  // handle across a rename either, because it never opens one.
  const REQUIRED = ['the snapshot is never cached', 'reads nothing at all'];

  it('never says, in either copy, that every request reads afresh', () => {
    // Asserted as booleans rather than through `toContain`, because a failing
    // `toContain` prints its subject — and one of these subjects is the whole
    // of README.md. A message naming the phrase and the file is the useful one.
    for (const copy of ['../src/dashboard/http-server.ts', '../README.md']) {
      const text = flatten(copy);
      for (const phrase of RETRACTED) {
        expect(text.includes(phrase), `${copy} still says "${phrase}"`).toBe(false);
      }
      for (const phrase of REQUIRED) {
        expect(text.includes(phrase), `${copy} does not say "${phrase}"`).toBe(true);
      }
    }
  });
});
