/**
 * DASHBOARD-001 slice 3 — the one module in this build that owns a socket.
 *
 * It binds `node:http` to the decisions in `http-contract.ts` and does nothing
 * else: read the facts off a Node request, call the contract, write the answer.
 * Every status, every header and every refusal is decided there, and the reason
 * this file holds no `if` about routes or methods is that a second copy of
 * those rules would be the copy that drifts.
 *
 * ── The authority boundary, stated because it is the point ─────────────────
 *
 * This server reads. It takes no execution lease, advances no task state,
 * writes no file, creates no worktree, runs no Git, starts no agent, opens no
 * pull request and touches the repository registry not at all. Its only
 * contact with AgentOrchestrator is one call to the slice-1 read model and one
 * projection through the slice-2 public view, both of which are pure readers,
 * and neither of which this module is allowed to reinterpret.
 *
 * It is also a *separate process*. Nothing here is reachable from the
 * scheduler, nothing here spawns AgentOrchestrator, and AgentOrchestrator
 * spawns nothing here. If this process dies, orchestration is unaffected; if
 * orchestration dies, this process keeps answering for whatever durable state
 * is on disk — which is the honest answer, and is why nothing below ever says
 * that AgentOrchestrator is running.
 *
 * ── Handles ────────────────────────────────────────────────────────────────
 *
 * There is no watcher, no `fs.watch`, no open descriptor kept between requests
 * and no cached snapshot. Every request reads afresh through readers that open,
 * read and close within one synchronous call. That matters on NTFS in
 * particular: AgentOrchestrator publishes durable state by writing a temporary
 * file and renaming it over the old one, and a reader holding a handle across
 * that rename is a reader that can make the *writer* fail. A poll that costs a
 * few milliseconds and holds nothing is worth more than a cache that holds a
 * file open.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import { readDashboardSnapshot } from './read-model.js';
import { toPublicSnapshot, type PublicSnapshot } from './public-view.js';
import { respondToDashboardRequest, type DashboardHttpResponse } from './http-contract.js';

/**
 * Neutral server configuration, and the complete list of it.
 *
 * Three values, and every one of them is a property of an HTTP server rather
 * than of any particular way of reaching one. There is no public URL here, no
 * base path, no origin, no scheme, no tunnel, no proxy and no vendor. Nothing
 * in this build reads `process.env` to find any of it either: the values come
 * from the command line, which is the one place an operator can see what they
 * asked for.
 *
 * `allowedHosts` is the third, and it is the one worth being explicit about
 * because it looks like it could be transport configuration and is not. The
 * application never learns what an entry stands for. It compares a request's
 * `Host` against a set of opaque strings; whether one of them happens to name
 * a tunnel, a proxy, a VPN or the machine next door is invisible here and stays
 * invisible.
 */
export interface DashboardServerConfig {
  readonly bindHost: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
}

/**
 * Injectable dependencies. Production supplies none of them.
 *
 * `snapshot` exists so that the HTTP behaviour can be measured against a value
 * a test chose — a revision that changes, an observation that throws — without
 * a repository on disk to arrange it. Production is the real composition, and
 * it is written here rather than passed in so that no caller can substitute a
 * reader with more authority than the read model has.
 */
export interface DashboardServerSeams {
  readonly snapshot?: () => PublicSnapshot;
}

/** What starting the server did. Total: every path returns one of these. */
export type DashboardStartOutcome =
  | {
      readonly outcome: 'LISTENING';
      readonly boundHost: string;
      readonly boundPort: number;
      /** Resolves once the listener and every live connection are gone. */
      readonly stop: () => Promise<void>;
      /** Resolves when the server closes, however it was closed. */
      readonly closed: Promise<void>;
    }
  | { readonly outcome: 'BIND_FAILED'; readonly errnoCode: string | null }
  | { readonly outcome: 'BOUND_ELSEWHERE'; readonly boundHost: string | null };

/**
 * Production's reader: the slice-1 observation, projected through slice 2.
 *
 * One call each, in that order, and no third step. Anything this service wants
 * to say has to already be true in the public snapshot.
 */
function observePublicSnapshot(): PublicSnapshot {
  return toPublicSnapshot(readDashboardSnapshot());
}

/**
 * Every `Host` field value the request carried, in the order they arrived.
 *
 * `req.headers.host` cannot answer this: Node keeps the first `Host` and drops
 * the rest, so one and two are the same value there. `rawHeaders` is the pairs
 * as parsed, which is the only place the duplicate is still visible. Field
 * names are HTTP tokens — Node refuses a request whose header name is not —
 * so they are ASCII and `toLowerCase` on them cannot surprise.
 */
function hostHeadersOf(rawHeaders: readonly string[]): readonly string[] {
  const found: string[] = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if ((rawHeaders[index] ?? '').toLowerCase() === 'host') found.push(rawHeaders[index + 1] ?? '');
  }
  return found;
}

/**
 * The `If-None-Match` field value, or `null`.
 *
 * One string, because Node joins repeated `If-None-Match` headers with `", "`
 * before this is read — which is the same list the field would have carried in
 * one line, and is exactly what the contract's list parser expects. `Host` is
 * the header Node treats differently, and it is read from `rawHeaders` above
 * for that reason.
 */
function ifNoneMatchOf(request: IncomingMessage): string | null {
  const raw = request.headers['if-none-match'];
  return typeof raw === 'string' ? raw : null;
}

/** Writes a decided response. Node omits the body of a `304` on its own. */
function write(response: ServerResponse, decided: DashboardHttpResponse): void {
  response.writeHead(decided.status, { ...decided.headers });
  if (decided.body === null) {
    response.end();
    return;
  }
  response.end(decided.body, 'utf8');
}

/**
 * Builds the server. Binding is a separate step, so a caller can bind and fail.
 */
export function createDashboardServer(
  config: DashboardServerConfig,
  seams: DashboardServerSeams = {},
): Server {
  const snapshot = seams.snapshot ?? observePublicSnapshot;

  const server = createServer((request: IncomingMessage, response: ServerResponse): void => {
    try {
      write(
        response,
        respondToDashboardRequest(
          {
            method: request.method ?? '',
            target: request.url ?? '',
            hostHeaders: hostHeadersOf(request.rawHeaders),
            ifNoneMatch: ifNoneMatchOf(request),
          },
          config.allowedHosts,
          snapshot,
        ),
      );
    } catch {
      // Containment, and its whole extent. One request that threw — a defect in
      // this build, or a reader that failed in a way the read model does not
      // model — becomes one `500` and the server keeps answering. Nothing is
      // logged from here and no detail crosses: an exception raised while
      // reading somebody's state is exactly the value most likely to quote a
      // path or a file's contents.
      //
      // This is deliberately *not* a process-level handler. Installing
      // `uncaughtException` would be this module changing how the whole runtime
      // fails, and the containment this slice owes is the request's, not the
      // machine's.
      try {
        if (!response.headersSent) {
          write(response, {
            status: 500,
            headers: {
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': String(Buffer.byteLength('{"error":"INTERNAL"}\n', 'utf8')),
            },
            body: '{"error":"INTERNAL"}\n',
          });
        } else {
          // A status line already went out, so there is no honest way to change
          // the answer. Cutting the connection is the only signal left that the
          // body is not the one the status promised.
          response.destroy();
        }
      } catch {
        response.destroy();
      }
    }
  });

  // There is deliberately NO `clientError` listener here, and that is the
  // opposite of an oversight.
  //
  // The first version of this file had one. Its comment said it was restating
  // Node's default explicitly — and that premise was false twice over, which a
  // review caught. Registering a `clientError` listener *replaces* the default
  // rather than echoing it, and the default is strictly better than the one
  // that was written:
  //
  //  - it picks the status the fault deserves. A header block over
  //    `maxHeaderSize` is `431`, a request that timed out mid-headers is `408`;
  //    the handler that was here flattened both into `400`, telling a caller its
  //    request was malformed when it was merely too large;
  //  - it DESTROYS the socket. `socket.end(...)` only half-closes — it writes
  //    the refusal and sends FIN, and a peer that never answers keeps the
  //    server-side socket, and its entry in the connection set below, for the
  //    life of the process. One malformed request would have leaked one socket
  //    permanently, which is the shape of a slow resource exhaustion rather
  //    than the containment the comment claimed.
  //
  // So the listener is withdrawn rather than repaired. A malformed request is
  // Node's to refuse, it refuses it correctly, and nothing reaches the handler
  // above either way.

  return server;
}

/**
 * Binds, verifies what was bound, and hands back a way to stop.
 *
 * Three outcomes, and the third is the one worth explaining. After `listening`
 * fires, the address actually bound is read back and compared with the address
 * asked for. An instrument that cannot fail is not an instrument: if a future
 * Node, a future option or a mistake in this file ever produced a listener on
 * something other than the loopback literal, a server that trusted its own
 * request would serve AgentOrchestrator's state to a network and report success
 * while doing it. So the bind is measured, and a disagreement closes the
 * listener rather than serving through it.
 *
 * There is no port fallback and no address fallback on any path. A collision is
 * `BIND_FAILED` carrying the errno, and the caller reports it.
 */
export function startDashboardServer(
  config: DashboardServerConfig,
  seams: DashboardServerSeams = {},
): Promise<DashboardStartOutcome> {
  const server = createDashboardServer(config, seams);

  // Live connections, tracked so that stopping is actually finished when it
  // says it is. `server.close` stops accepting and then waits for existing
  // connections to end on their own, and a keep-alive connection does not end
  // on its own — a stop that only called `close` would hang for as long as a
  // browser kept its socket open.
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket): void => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  return new Promise<DashboardStartOutcome>((resolve) => {
    const onceFailed = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onceListening);
      resolve(Object.freeze({ outcome: 'BIND_FAILED' as const, errnoCode: error.code ?? null }));
    };

    const onceListening = (): void => {
      server.removeListener('error', onceFailed);

      const address = server.address();
      const boundHost = typeof address === 'object' && address !== null ? address.address : null;
      const boundPort = typeof address === 'object' && address !== null ? address.port : null;

      if (boundHost !== config.bindHost || boundPort === null) {
        server.close();
        for (const socket of sockets) socket.destroy();
        resolve(Object.freeze({ outcome: 'BOUND_ELSEWHERE' as const, boundHost }));
        return;
      }

      // After the bind is established, a later `error` is a runtime fault on the
      // listener rather than a failed start. It must not be an unhandled event —
      // an `error` with no listener is rethrown by Node and would take the
      // process down, which is the opposite of containment.
      server.on('error', () => {
        /* contained: the listener is already established and `closed` settles */
      });

      const closed = new Promise<void>((settle) => server.once('close', () => settle()));

      const stop = async (): Promise<void> => {
        server.close();
        for (const socket of sockets) socket.destroy();
        await closed;
      };

      resolve(
        Object.freeze({
          outcome: 'LISTENING' as const,
          boundHost,
          boundPort,
          stop,
          closed,
        }),
      );
    };

    server.once('error', onceFailed);
    server.once('listening', onceListening);

    // The host is named. Node reads an omitted host as "every interface", so
    // leaving it out is not a smaller bind than this one — and `exclusive`
    // makes a collision an error on this call rather than a handle quietly
    // shared with something else.
    server.listen({ host: config.bindHost, port: config.port, exclusive: true });
  });
}
