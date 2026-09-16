/**
 * `agent-loop dashboard serve` — the AO Manager's read-only HTTP surface
 * (DASHBOARD-001 slice 3).
 *
 * One long-lived process that binds `127.0.0.1` and answers exactly one
 * question: `GET /api/snapshot`, returning the public dashboard snapshot slice 2
 * settled. It is the first **inbound** socket this build has ever had, and it
 * is opened only when this command is typed.
 *
 * ── Why this is a command and not a mode of something else ─────────────────
 *
 * The Manager is a separate operating-system process from AgentOrchestrator, on
 * purpose and not incidentally. Nothing here is reachable from the scheduler,
 * this command starts no orchestration and no orchestration starts this. The
 * two share durable state on disk and share nothing else — no lifetime, no
 * lease, no pipe, no parent. So the dashboard dying leaves orchestration
 * untouched, the orchestrator dying leaves the dashboard answering for whatever
 * is on disk, and neither is ever required for the other to work.
 *
 * ── What it cannot tell you ────────────────────────────────────────────────
 *
 * Whether AgentOrchestrator is running. This build writes no heartbeat, no pid
 * file and no daemon record, so "AO is idle", "AO finished" and "AO was never
 * started" are one observation from here. The snapshot says so rather than
 * guessing, and this command adds nothing to it: a listening Manager is
 * evidence about the Manager.
 *
 * ── The configuration values, and the ones that are absent ─────────────────
 *
 * The bind host is a constant. The port and the extra allowed `Host` values
 * come from the command line. Nothing here reads `process.env`, and there is no
 * public URL, base path, origin, scheme, tunnel or proxy setting — reaching
 * this service from anywhere other than this machine is an access layer the
 * operator puts in front of it, and this build neither provides one nor knows
 * that one exists.
 */

import type { Command } from 'commander';

import {
  DASHBOARD_BIND_HOST,
  DASHBOARD_DEFAULT_PORT,
  SNAPSHOT_METHOD,
  SNAPSHOT_PATH,
  allowedHostsFor,
  normaliseHost,
} from '../dashboard/http-contract.js';
import { startDashboardServer } from '../dashboard/http-server.js';
import { loadUiAssets, uiAssetRoot, type UiAssetLoad } from '../dashboard/ui-assets.js';
import { formatSafeError } from '../core/safe-error.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
  type CliExitCode,
} from './run-exit-codes.js';

/* ── outcomes ──────────────────────────────────────────────────────────────── */

/**
 * Every way this command can end. A closed set of six.
 *
 * Two of them are refusals of the command line, decided before a socket is
 * touched; one is the shipped UI failing to load, also decided before a
 * socket is touched; two are a bind that did not produce the listener that
 * was asked for; one is the service having run and stopped. An exception is
 * not a member — reaching the `catch` below means a defect in this build
 * rather than a state of the machine, and grading it beside these would blur
 * that line.
 */
export const DASHBOARD_SERVE_OUTCOMES = [
  'SERVED',
  'PORT_UNUSABLE',
  'ALLOW_HOST_UNUSABLE',
  'UI_ASSETS_UNUSABLE',
  'BIND_REFUSED',
  'BIND_NOT_LOOPBACK',
] as const;

export type DashboardServeOutcome = (typeof DASHBOARD_SERVE_OUTCOMES)[number];

/**
 * The exit grade of each outcome. Total by type and written out member by
 * member, so a new outcome is a compile error and a grading decision rather
 * than whatever a default arm happened to say.
 *
 * `BIND_REFUSED` is `4` and deliberately not `3`. Code `3` is this build's
 * "the durable state needs an operator before anything may run", and a port
 * that is busy or an address the operating system will not give out is not a
 * statement about durable state at all — it is this invocation being refused,
 * with the state left exactly as it was, and with a different machine or a
 * different moment giving a different answer. That is the sentence code `4`
 * already carries. `EADDRINUSE` and `EACCES` grade the same for the same
 * reason: they differ in what the operator does next, which is why the errno is
 * printed, and not in what happened to this invocation.
 *
 * `BIND_NOT_LOOPBACK` cannot be produced by any input and would mean this build
 * asked for the loopback literal and was given something else. It is graded as
 * a refusal rather than as a defect because the operator-visible fact is the
 * same one — no service is listening — and because the alternative is a build
 * that serves AgentOrchestrator's state to an address it did not choose.
 *
 * `UI_ASSETS_UNUSABLE` is `EXIT_RUN_UNEXPECTED` and deliberately not `4`. A
 * refused invocation is one the operator could have typed differently; this one
 * cannot be. Every asset is fixed by the manifest and shipped by the build, so
 * a missing one means the artefact is defective — a different port, a different
 * moment and a different machine all give the same answer.
 */
export const DASHBOARD_SERVE_EXIT: Readonly<Record<DashboardServeOutcome, CliExitCode>> =
  Object.freeze({
    SERVED: EXIT_RUN_OK,
    PORT_UNUSABLE: EXIT_RUN_INPUT_UNUSABLE,
    ALLOW_HOST_UNUSABLE: EXIT_RUN_INPUT_UNUSABLE,
    UI_ASSETS_UNUSABLE: EXIT_RUN_UNEXPECTED,
    BIND_REFUSED: EXIT_RUN_REFUSED,
    BIND_NOT_LOOPBACK: EXIT_RUN_REFUSED,
  });

/* ── help ──────────────────────────────────────────────────────────────────── */

/** What the group is for, printed in `--help`. */
export const DASHBOARD_GROUP_DESCRIPTION =
  'The AO Manager: a read-only observation of what this machine’s orchestration is doing, over ' +
  'HTTP, for a browser. It reads durable state — no lease is taken, no task state is written, ' +
  'no repository is opened for writing and no program is started.';

/**
 * What `serve` is for, printed in `--help`.
 *
 * Says what is *not* offered as plainly as what is, because both surprises an
 * operator can get here are absences: there is no user interface at this
 * address yet, and there is nothing authenticating in front of it.
 */
export const DASHBOARD_SERVE_DESCRIPTION =
  `Start the read-only HTTP server. It binds ${DASHBOARD_BIND_HOST} — loopback, never a LAN or ` +
  `public address — on port ${DASHBOARD_DEFAULT_PORT} unless --port says otherwise, and answers ` +
  `one route: ${SNAPSHOT_METHOD} ${SNAPSHOT_PATH}, the public dashboard snapshot as JSON with a ` +
  'weak ETag so a poll that changed nothing costs a 304. There is no user interface and nothing ' +
  'authenticates: whatever can reach this port can read the snapshot, which is why it is bound ' +
  'to loopback and why reaching it from elsewhere is an access layer an operator puts in front ' +
  'of it rather than anything this build does. The port is fixed — a collision is reported and ' +
  'no other port is tried. It writes nothing, takes no lease and starts no program, and it says ' +
  'nothing about whether AgentOrchestrator itself is running, because this build records ' +
  'nothing that would answer that.';

/* ── seams ─────────────────────────────────────────────────────────────────── */

/** Injectable dependencies. Production supplies none of them. */
export interface DashboardCommandSeams {
  readonly start?: typeof startDashboardServer | undefined;
  /**
   * Loads the shipped UI. Production reads the real manifest off disk,
   * beside this module; a test substitutes an outcome to drive the refusal
   * path without a filesystem fixture. This is a seam and `assets` on
   * `DashboardServerConfig` is not: this decides WHETHER the build is
   * usable, before there is a config to build at all.
   */
  readonly loadAssets?: (() => UiAssetLoad) | undefined;
  readonly write?: ((text: string) => void) | undefined;
  readonly writeError?: ((text: string) => void) | undefined;
  /**
   * Signals that stop the server. Substituted in tests, which cannot raise a
   * real one at themselves without stopping the test runner with it.
   */
  readonly stopSignals?: readonly NodeJS.Signals[] | undefined;
  /** What a second signal may do to this process. Production raises and exits. */
  readonly stopEffects?: StopEffects | undefined;
}

/** The signals a person uses to stop a foreground process on this platform. */
const STOP_SIGNALS: readonly NodeJS.Signals[] = Object.freeze([
  'SIGINT',
  'SIGTERM',
  'SIGBREAK',
]);

/** Installed handlers, and the way to take them off again. */
export interface StopRequest {
  /** Removes the handlers. Must run on every path out, including a throw. */
  readonly dispose: () => void;
}

/**
 * What the second signal is allowed to do to this process.
 *
 * Both are parameters rather than direct calls so that the double-signal path
 * can be measured. A test cannot raise a real signal at itself without taking
 * the test runner with it, and a path that can only be read is a path that goes
 * wrong unobserved.
 */
export interface StopEffects {
  readonly raise: (signal: NodeJS.Signals) => void;
  readonly exit: (code: number) => void;
}

/** Production's: the real signal, then the real exit. */
export const REAL_STOP_EFFECTS: StopEffects = Object.freeze({
  raise: (signal: NodeJS.Signals): void => void process.kill(process.pid, signal),
  exit: (code: number): void => process.exit(code),
});

/**
 * Asks the server to stop on the first signal, and guarantees an exit on the
 * second.
 *
 * The same shape `repositories --wait-for-reset` uses, and the Windows fact
 * behind the second half is recorded there in full rather than re-derived here:
 * `process.kill(process.pid, 'SIGBREAK')` answers `ENOSYS` on this platform and
 * leaves the process running, so a handler that only re-raised would make an
 * operator's second press appear to do nothing. The re-raise is attempted
 * because it is the polite ending, and the exit is unconditional because it is
 * the one that works.
 *
 * (The two copies of this shape are a known duplication, recorded rather than
 * hidden: extracting it would mean editing the scheduling command in a slice
 * that has no other reason to touch it.)
 */
export function stopOnSignals(
  signals: readonly NodeJS.Signals[],
  stop: () => void,
  effects: StopEffects,
): StopRequest {
  let asked = false;
  const handlers = new Map<NodeJS.Signals, () => void>();

  const dispose = (): void => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    handlers.clear();
  };

  for (const signal of signals) {
    const handler = (): void => {
      if (asked) {
        // The second one. An operator asking twice is telling this process to
        // stop being careful about it.
        dispose();
        try {
          effects.raise(signal);
        } catch {
          /* the exit below is the answer; the signal was only the polite one */
        }
        effects.exit(EXIT_RUN_UNEXPECTED);
        return;
      }
      asked = true;
      stop();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return Object.freeze({ dispose });
}

/* ── the command line ──────────────────────────────────────────────────────── */

/**
 * A port from the command line, or `null`.
 *
 * Strict digits, and `0` is refused along with everything out of range. Node
 * reads port `0` as "any free port the operating system likes", which is a
 * silent port selection wearing a number — precisely the fallback this command
 * promises never to do. An operator who wants a different fixed port names it.
 */
export function parsePort(raw: string): number | null {
  if (!/^[0-9]{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

/** Collects a repeated `--allow-host`, in the order the operator wrote them. */
function collect(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

export function registerDashboardCommand(
  program: Command,
  seams: DashboardCommandSeams = {},
): void {
  // Nothing is registered on the group itself. A parent's options are parsed
  // for every subcommand under it, so an option here would be an option on a
  // verb that has no use for it.
  const dashboard = program.command('dashboard').description(DASHBOARD_GROUP_DESCRIPTION);

  dashboard
    .command('serve')
    .description(DASHBOARD_SERVE_DESCRIPTION)
    // `option`, never `requiredOption`. A missing `requiredOption` is refused by
    // Commander with exit 1 — this build's code for a defect inside the tool —
    // on a bare stderr line that never reaches the safe formatter. Both of these
    // have a meaning when absent, and that meaning is the default.
    .option(
      '--port <port>',
      `Port to bind on ${DASHBOARD_BIND_HOST}. Default ${DASHBOARD_DEFAULT_PORT}. A port already ` +
        'in use is reported and no other port is tried.',
      String(DASHBOARD_DEFAULT_PORT),
    )
    .option(
      '--allow-host <host>',
      'Additionally accept requests whose Host header is this exact value; repeatable. The ' +
        `address being bound (${DASHBOARD_BIND_HOST}:<port>) is always accepted. The value is ` +
        'opaque to this build — it is compared, never interpreted, and nothing is derived from ' +
        'what it might name. This is request-routing hardening, not authentication: it refuses ' +
        'a request naming an authority this service was not told to answer for, and it proves ' +
        'nothing about who is calling. It does not stop a page on another origin from reaching ' +
        'this port — a browser sends the authority of the URL it was given, so such a request ' +
        'carries an allowed Host and is answered; what keeps the bytes from that page is that ' +
        'no CORS header is ever sent.',
      collect,
      [] as readonly string[],
    )
    .action(async (options: { port: string; allowHost: readonly string[] }): Promise<void> => {
      const write = seams.write ?? ((text: string): void => void process.stdout.write(text));
      const writeError =
        seams.writeError ?? ((text: string): void => void process.stderr.write(text));
      const start = seams.start ?? startDashboardServer;

      let stopping: StopRequest | null = null;
      try {
        const port = parsePort(options.port);
        if (port === null) {
          writeError(
            'agent-loop: --port must be a whole number from 1 to 65535. Port 0 is refused ' +
              'because it asks the operating system to choose, and this command never chooses ' +
              'a port.\n',
          );
          process.exitCode = DASHBOARD_SERVE_EXIT.PORT_UNUSABLE;
          return;
        }

        const refused = options.allowHost.filter((host) => normaliseHost(host) === null);
        if (refused.length > 0) {
          // The count, not the values. They came from this operator's own
          // command line, but a refusal that echoes what it refused is a
          // refusal that can be made to print anything.
          writeError(
            `agent-loop: ${refused.length} --allow-host value(s) cannot be an HTTP Host. A Host ` +
              'is printable US-ASCII, at most 255 characters, and contains no space, comma, ' +
              'slash, backslash, quote or "@".\n',
          );
          process.exitCode = DASHBOARD_SERVE_EXIT.ALLOW_HOST_UNUSABLE;
          return;
        }

        // Loaded, and refused if incomplete, BEFORE the socket. All-or-
        // nothing, and before `start` so a partial UI is never the thing that
        // ends up listening.
        const loadAssets =
          seams.loadAssets ?? ((): UiAssetLoad => loadUiAssets(uiAssetRoot(import.meta.url)));
        const loaded = loadAssets();
        if (loaded.outcome === 'MISSING') {
          // The route, never the path. This sentence reaches an operator.
          writeError(
            `agent-loop: refused to serve. The shipped user interface is incomplete — ` +
              `${loaded.route} is missing or unreadable. This build's assets are fixed, so ` +
              `nothing was served and no socket was opened.\n`,
          );
          process.exitCode = DASHBOARD_SERVE_EXIT.UI_ASSETS_UNUSABLE;
          return;
        }

        const outcome = await start(
          {
            bindHost: DASHBOARD_BIND_HOST,
            port,
            allowedHosts: allowedHostsFor(DASHBOARD_BIND_HOST, port, options.allowHost),
            assets: loaded.assets,
          },
          {},
        );

        if (outcome.outcome === 'BIND_FAILED') {
          // The address and the port are both named — "in use" without them
          // sends an operator to look at the wrong thing — and the errno is
          // carried through, because `EADDRINUSE` and `EACCES` are different
          // problems with different answers even though they grade alike.
          writeError(
            `agent-loop: could not bind ${DASHBOARD_BIND_HOST}:${port} ` +
              `[${outcome.errnoCode ?? 'UNKNOWN'}]. The port is fixed: nothing else was tried.\n`,
          );
          process.exitCode = DASHBOARD_SERVE_EXIT.BIND_REFUSED;
          return;
        }

        if (outcome.outcome === 'BOUND_ELSEWHERE') {
          writeError(
            'agent-loop: refused to serve. The listener came up on ' +
              `${outcome.boundHost ?? 'an address that could not be read'} rather than ` +
              `${DASHBOARD_BIND_HOST}, and it has been closed.\n`,
          );
          process.exitCode = DASHBOARD_SERVE_EXIT.BIND_NOT_LOOPBACK;
          return;
        }

        write(
          `AO Manager listening on http://${outcome.boundHost}:${String(outcome.boundPort)}\n` +
            `${SNAPSHOT_METHOD} ${SNAPSHOT_PATH} — read-only. Stop with Ctrl+C.\n`,
        );

        stopping = stopOnSignals(
          seams.stopSignals ?? STOP_SIGNALS,
          () => void outcome.stop(),
          seams.stopEffects ?? REAL_STOP_EFFECTS,
        );

        // Ending by the listener closing rather than by exiting from inside a
        // handler: an in-flight response gets to finish, and the process then
        // dies of its own accord because nothing else holds the loop open.
        await outcome.closed;
        process.exitCode = DASHBOARD_SERVE_EXIT.SERVED;
      } catch (error) {
        // Reaching here is a defect in this build rather than a state of the
        // machine: a bind that failed is an outcome above, not an exception.
        // Reported through the central safe formatter, never as an exception
        // message (AO-002).
        writeError(`agent-loop: ${formatSafeError(error)}\n`);
        process.exitCode = EXIT_RUN_UNEXPECTED;
      } finally {
        // On every path out, including the throw. A listener left behind would
        // keep this process from dying on the interrupt that follows it.
        stopping?.dispose();
      }
    });
}
