/**
 * DASHBOARD-001 slice 3 — the verb, and the boundary around it.
 *
 * Two halves.
 *
 * THE VERB. `dashboard serve` as an operator reaches it: which options exist,
 * what each refusal costs, which exit code each ending grades to, and what the
 * process does when somebody presses Ctrl+C twice. The action is driven through
 * a real Commander program rather than by calling a function, because a verb
 * that is not registered — or is registered under another name — is invisible
 * to every test that imports the handler directly. This repository has a
 * recorded mutation campaign where exactly that survived the whole suite.
 *
 * THE BOUNDARY. A set of sweeps over `src/` which exist because the properties
 * they defend are *absences*, and an absence has no call site to test. A
 * listener that appears in a second module, a bind that stops naming its host,
 * an environment variable that starts deciding where this binds, a vendor's
 * name leaking into production code — none of those breaks a behaviour a
 * reviewer would notice, and all of them are one keystroke away.
 *
 * The sweeps are deliberately source-text sweeps, and their limit is stated:
 * a file determined to evade one can build a string at runtime. That is not the
 * threat model. The measured failure mode is the accidental one — a later slice
 * reaching for `node:http` in the obvious place — and these catch that.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../src/cli/index.js';
import {
  DASHBOARD_SERVE_DESCRIPTION,
  DASHBOARD_SERVE_EXIT,
  DASHBOARD_SERVE_OUTCOMES,
  REAL_STOP_EFFECTS,
  parsePort,
  registerDashboardCommand,
  stopOnSignals,
  type DashboardCommandSeams,
} from '../src/cli/dashboard-command.js';
import {
  DASHBOARD_BIND_HOST,
  DASHBOARD_DEFAULT_PORT,
  SNAPSHOT_PATH,
} from '../src/dashboard/http-contract.js';
import type { DashboardStartOutcome } from '../src/dashboard/http-server.js';
import {
  EXIT_RUN_INPUT_UNUSABLE,
  EXIT_RUN_OK,
  EXIT_RUN_REFUSED,
  EXIT_RUN_UNEXPECTED,
} from '../src/cli/run-exit-codes.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

/* ── driving the verb ─────────────────────────────────────────────────────── */

interface Run {
  readonly out: string;
  readonly err: string;
  readonly exitCode: number | undefined;
  readonly started: readonly { bindHost: string; port: number; allowedHosts: readonly string[] }[];
}

async function serve(
  argv: readonly string[],
  outcome: DashboardStartOutcome,
  extra: DashboardCommandSeams = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const started: { bindHost: string; port: number; allowedHosts: readonly string[] }[] = [];

  const program = new Command();
  program.exitOverride();
  registerDashboardCommand(program, {
    write: (text) => void out.push(text),
    writeError: (text) => void err.push(text),
    start: (config) => {
      started.push({
        bindHost: config.bindHost,
        port: config.port,
        allowedHosts: config.allowedHosts,
      });
      return Promise.resolve(outcome);
    },
    // A default that never touches the real filesystem. This suite is about
    // the verb, not the shipped UI; the asset-refusal case below overrides
    // this seam itself to exercise the one path that must not reach `start`.
    loadAssets: () => ({ outcome: 'LOADED', assets: new Map() }),
    ...extra,
  });

  process.exitCode = undefined;
  await program.parseAsync(['node', 'agent-loop', 'dashboard', 'serve', ...argv]);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { out: out.join(''), err: err.join(''), exitCode: exitCode as number | undefined, started };
}

/** A listening outcome whose lifetime the test controls. */
function listening(port = DASHBOARD_DEFAULT_PORT): {
  outcome: DashboardStartOutcome;
  close: () => void;
  stops: () => number;
} {
  let settle: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let stops = 0;
  return {
    outcome: {
      outcome: 'LISTENING',
      boundHost: DASHBOARD_BIND_HOST,
      boundPort: port,
      stop: (): Promise<void> => {
        stops += 1;
        settle();
        return closed;
      },
      closed,
    },
    close: settle,
    stops: (): number => stops,
  };
}

/* ── 1. the registered surface ────────────────────────────────────────────── */

describe('the verb an operator actually types', () => {
  const dashboard = (): Command | undefined =>
    buildProgram().commands.find((command) => command.name() === 'dashboard');

  it('is registered on the shipped program', () => {
    expect(dashboard()).toBeDefined();
    expect(dashboard()?.commands.map((command) => command.name())).toEqual(['serve']);
  });

  it('puts nothing on the group itself', () => {
    // A parent's options are parsed for every subcommand under it, so an option
    // here would be an option on a verb with no use for it — and a
    // `requiredOption` here would be enforced on one too.
    expect(dashboard()?.options.map((option) => option.long)).toEqual([]);
  });

  it('offers exactly two options, both valued and neither mandatory', () => {
    const serveCommand = dashboard()?.commands.find((command) => command.name() === 'serve');
    const options = serveCommand?.options ?? [];
    expect(options.map((option) => option.long).sort()).toEqual(['--allow-host', '--port']);
    for (const option of options) {
      expect(option.required, `${String(option.long)} must take a value`).toBe(true);
      expect(option.mandatory, `${String(option.long)} must not be required`).toBe(false);
    }
  });

  it('offers no flag that widens the bind, and no environment input', () => {
    const serveCommand = dashboard()?.commands.find((command) => command.name() === 'serve');
    const longs = (serveCommand?.options ?? []).map((option) => option.long);
    // A flag able to move the listener off loopback is the public exposure this
    // slice exists not to have, and so is a flag that teaches this build what a
    // transport in front of it looks like. Banned by long name, because
    // `--allow-host` is about which Host header is *accepted* and must stay.
    for (const banned of [
      '--host',
      '--bind',
      '--bind-host',
      '--bind-address',
      '--address',
      '--interface',
      '--public-url',
      '--base-url',
      '--base-path',
      '--origin',
      '--scheme',
      '--tls',
      '--cert',
      '--cors',
    ]) {
      expect(longs, banned).not.toContain(banned);
    }
    // `--allow-host` is about which Host header is accepted, never about where
    // the socket goes, and the help says so.
    expect(serveCommand?.description()).toContain('loopback');
  });

  it('says in its own help what it offers and what it still does not do', () => {
    for (const promise of [
      'read-only',
      DASHBOARD_BIND_HOST,
      SNAPSHOT_PATH,
      'a mobile-first page at /',
      'nothing authenticates',
      'takes no lease',
      'nothing about whether AgentOrchestrator itself is running',
    ]) {
      expect(DASHBOARD_SERVE_DESCRIPTION, promise).toContain(promise);
    }
    expect(DASHBOARD_SERVE_DESCRIPTION).not.toContain('localhost');
  });

  it('retracts the sentence slice 4 made false, in the help an operator prints', () => {
    // Read off the REGISTERED command rather than the exported constant. The
    // loop above would stay green if the description Commander prints stopped
    // being that constant, and a retraction that can be satisfied by an
    // unprinted string is not a retraction.
    //
    // `nothing authenticates` is asserted here as well as above, and the
    // duplication is the point: this is the pair that must not come apart. The
    // interface arriving is exactly the moment an operator might read "there is
    // a UI now" and infer "so something checks who I am", and the sentence that
    // stops that inference is the one kept beside the one being removed.
    const description = dashboard()
      ?.commands.find((command) => command.name() === 'serve')
      ?.description();
    expect(typeof description).toBe('string');
    expect(description).not.toContain('no user interface');
    expect(description).not.toContain('one route');
    expect(description).toContain('nothing authenticates');
  });
});

/* ── 2. the front page ────────────────────────────────────────────────────── */

describe('the front page is bound to the registered surface', () => {
  /**
   * Bidirectional, and the reason it is written this way is in the tree.
   *
   * `attention` shipped and the front page was not told, so the paragraph
   * headed "This build ships:" went on describing a build that was one command
   * smaller than the one an operator had. A list maintained by memory goes
   * stale exactly once per slice; a list checked against
   * `program.commands` fails the slice that forgot.
   */
  it('names every registered command group', () => {
    const program = buildProgram();
    const description = program.description();
    for (const command of program.commands) {
      const name = command.name();
      if (name === 'help') continue; // Commander's own, not this build's.
      expect(new RegExp('`' + name + '[ `]').test(description), name).toBe(true);
    }
  });

  it('states the listener inside the paragraph that calls itself exhaustive', () => {
    // The anchors are the ones tests/v4-02 slices on. A bullet placed after the
    // closing anchor would leave that paragraph calling itself complete while
    // omitting the listener, and every assertion would stay green.
    const flat = buildProgram().description().replace(/\s+/g, ' ');
    const start = flat.indexOf('Network access, stated in full');
    const end = flat.indexOf('Given none of the flags named above');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const paragraph = flat.slice(start, end);

    expect(paragraph).toContain('`dashboard serve`');
    expect(paragraph).toContain('127.0.0.1');
    expect(paragraph).toContain('Inbound');
    expect(paragraph).toContain('Outbound');
    // It must not promise anything about a transport it does not provide.
    expect(paragraph).toContain('terminates no TLS');
    expect(paragraph).toContain('is not authentication');
  });

  it('keeps the front page free of the phrases that were retracted before', () => {
    const description = buildProgram().description();
    const flat = description.replace(/\s+/g, ' ');
    for (const banned of ['and nothing else', 'no network']) {
      expect(description, banned).not.toContain(banned);
      expect(flat, banned).not.toContain(banned);
    }
  });
});

/* ── 3. the command line ──────────────────────────────────────────────────── */

describe('a port is a whole number, and never a request to choose one', () => {
  it('accepts the range and refuses everything else', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('47113')).toBe(47113);
    expect(parsePort('65535')).toBe(65535);
    for (const bad of ['0', '65536', '-1', '+8080', ' 8080', '8080 ', '0x1f90', '8080.0', '', 'http', '007a']) {
      expect(parsePort(bad), bad).toBeNull();
    }
  });

  it('refuses 0 with its own sentence, and starts nothing', async () => {
    const run = await serve(['--port', '0'], listening().outcome);
    expect(run.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(run.started).toEqual([]);
    expect(run.err).toContain('never chooses');
    expect(run.out).toBe('');
  });

  it('refuses an --allow-host that could not be a Host, and says how many', async () => {
    const run = await serve(['--allow-host', 'has space', '--allow-host', 'ok.example'], listening().outcome);
    expect(run.exitCode).toBe(EXIT_RUN_INPUT_UNUSABLE);
    expect(run.started).toEqual([]);
    expect(run.err).toContain('1 --allow-host');
    // The refusal does not echo what it refused: a message able to print an
    // arbitrary argument is a message able to print anything.
    expect(run.err).not.toContain('has space');
  });

  it('always binds the loopback literal, whatever the command line says', async () => {
    const server = listening(8080);
    const running = serve(['--port', '8080', '--allow-host', 'AO.Example'], server.outcome, {
      stopSignals: [],
    });
    server.close();
    const run = await running;
    expect(run.started).toEqual([
      {
        bindHost: '127.0.0.1',
        port: 8080,
        allowedHosts: ['127.0.0.1:8080', 'ao.example'],
      },
    ]);
  });

  it('defaults to the fixed port with no options at all', async () => {
    const server = listening();
    const running = serve([], server.outcome, { stopSignals: [] });
    server.close();
    const run = await running;
    expect(run.started[0]?.port).toBe(DASHBOARD_DEFAULT_PORT);
    expect(run.started[0]?.allowedHosts).toEqual([`127.0.0.1:${String(DASHBOARD_DEFAULT_PORT)}`]);
  });
});

/* ── 4. how it ends ───────────────────────────────────────────────────────── */

describe('every ending is graded, and the grades are total', () => {
  it('maps every outcome and nothing else', () => {
    expect(Object.keys(DASHBOARD_SERVE_EXIT).sort()).toEqual([...DASHBOARD_SERVE_OUTCOMES].sort());
    expect(DASHBOARD_SERVE_EXIT).toEqual({
      SERVED: EXIT_RUN_OK,
      PORT_UNUSABLE: EXIT_RUN_INPUT_UNUSABLE,
      ALLOW_HOST_UNUSABLE: EXIT_RUN_INPUT_UNUSABLE,
      UI_ASSETS_UNUSABLE: EXIT_RUN_UNEXPECTED,
      BIND_REFUSED: EXIT_RUN_REFUSED,
      BIND_NOT_LOOPBACK: EXIT_RUN_REFUSED,
    });
    // Never 0 for a start that did not happen.
    for (const outcome of DASHBOARD_SERVE_OUTCOMES) {
      if (outcome === 'SERVED') continue;
      expect(DASHBOARD_SERVE_EXIT[outcome], outcome).not.toBe(EXIT_RUN_OK);
    }
  });

  it('reports a collision with the address, the port and the errno', async () => {
    const run = await serve(['--port', '47113'], { outcome: 'BIND_FAILED', errnoCode: 'EADDRINUSE' });
    expect(run.exitCode).toBe(EXIT_RUN_REFUSED);
    expect(run.err).toContain('127.0.0.1:47113');
    expect(run.err).toContain('EADDRINUSE');
    expect(run.err).toContain('nothing else was tried');
    expect(run.out).toBe('');
  });

  it('still names the address when the errno could not be read', async () => {
    const run = await serve([], { outcome: 'BIND_FAILED', errnoCode: null });
    expect(run.err).toContain('UNKNOWN');
    expect(run.exitCode).toBe(EXIT_RUN_REFUSED);
  });

  it('refuses to serve a listener that came up elsewhere', async () => {
    const run = await serve([], { outcome: 'BOUND_ELSEWHERE', boundHost: '0.0.0.0' });
    expect(run.exitCode).toBe(EXIT_RUN_REFUSED);
    expect(run.err).toContain('0.0.0.0');
    expect(run.err).toContain('has been closed');
    expect(run.out).toBe('');
  });

  it('prints the local listener and nothing it would have to guess', async () => {
    const server = listening(47113);
    const done = serve([], server.outcome, { stopSignals: [] });
    server.close();
    const run = await done;

    expect(run.out).toContain('AO Manager listening on http://127.0.0.1:47113');
    expect(run.out).toContain('GET /api/snapshot');
    expect(run.exitCode).toBe(EXIT_RUN_OK);
    // Nothing about anywhere else. No interface scan, no external address, no
    // phone URL, no scheme this process does not serve.
    for (const guess of ['https://', 'ts.net', 'tailscale', '100.', '0.0.0.0', 'localhost']) {
      expect(run.out.toLowerCase(), guess).not.toContain(guess);
    }
  });
});

/* ── 4b. every asset loads before any socket opens ───────────────────────── */

describe('the shipped user interface must be complete before any socket opens', () => {
  it('refuses to serve when a UI asset is missing, and binds nothing', async () => {
    // The positive control is the `start` seam: if it is ever called, the
    // refusal did not happen before the socket, which is the whole claim.
    let started = 0;
    const run = await serve([], listening().outcome, {
      start: async () => {
        started += 1;
        return { outcome: 'BIND_FAILED', errnoCode: 'NOTREACHED' };
      },
      loadAssets: () => ({ outcome: 'MISSING', route: '/icon-512.png' }),
    });

    expect(started).toBe(0);
    expect(run.exitCode).toBe(DASHBOARD_SERVE_EXIT.UI_ASSETS_UNUSABLE);
    expect(run.err).toContain('/icon-512.png');
    // A refusal reaches an operator, so it names the route and not this machine.
    expect(run.err).not.toMatch(/[A-Za-z]:\\/);
    expect(run.out).toBe('');
  });
});

/* ── 5. stopping ──────────────────────────────────────────────────────────── */

describe('the process stops when it is asked, and stops harder when asked twice', () => {
  // SIGHUP rather than SIGINT: emitting SIGINT by hand would also reach the
  // test runner's own handler and cancel the run. Nothing here raises a real
  // signal; `process.emit` invokes the listeners, which is the whole subject.
  const SIGNAL: NodeJS.Signals = 'SIGHUP';

  it('asks the server to stop on the first signal', () => {
    let stops = 0;
    const request = stopOnSignals([SIGNAL], () => void (stops += 1), {
      raise: () => undefined,
      exit: () => undefined,
    });
    try {
      process.emit(SIGNAL);
      expect(stops).toBe(1);
    } finally {
      request.dispose();
    }
  });

  it('re-raises and then exits on the second, and takes its handlers off first', () => {
    const raised: NodeJS.Signals[] = [];
    const exits: number[] = [];
    const request = stopOnSignals([SIGNAL], () => undefined, {
      raise: (signal) => void raised.push(signal),
      exit: (code) => void exits.push(code),
    });
    try {
      process.emit(SIGNAL);
      const before = process.listenerCount(SIGNAL);
      process.emit(SIGNAL);
      expect(raised).toEqual([SIGNAL]);
      expect(exits).toEqual([1]);
      // Disposed before the re-raise, so the raised signal reaches the default
      // behaviour rather than this handler again.
      expect(process.listenerCount(SIGNAL)).toBe(before - 1);
    } finally {
      request.dispose();
    }
  });

  it('exits even when the platform refuses the self-signal', () => {
    // The measured Windows fact: `process.kill(process.pid, 'SIGBREAK')` throws
    // ENOSYS and leaves the process running. The exit is what actually stops
    // it, so it may not be conditional on the raise succeeding.
    const exits: number[] = [];
    const request = stopOnSignals([SIGNAL], () => undefined, {
      raise: () => {
        throw Object.assign(new Error('ENOSYS'), { code: 'ENOSYS' });
      },
      exit: (code) => void exits.push(code),
    });
    try {
      process.emit(SIGNAL);
      process.emit(SIGNAL);
      expect(exits).toEqual([1]);
    } finally {
      request.dispose();
    }
  });

  it('reaches the listener: a signal actually stops the server the action started', async () => {
    // The line this measures is the one that joins the two halves —
    // `stopOnSignals(seams.stopSignals ?? STOP_SIGNALS, () => void outcome.stop(), …)`.
    // The three cases above drive `stopOnSignals` with their own callback, so
    // every one of them would pass with that argument replaced by a no-op. The
    // fixture has exposed a `stops()` counter since it was written and nothing
    // read it; a review named that as the surviving mutation.
    const server = listening();
    const running = serve([], server.outcome, { stopSignals: [SIGNAL] });

    // Let the action reach the point where the handler is installed.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(server.stops()).toBe(0);

    process.emit(SIGNAL);
    const run = await running;

    expect(server.stops()).toBe(1);
    expect(run.exitCode).toBe(EXIT_RUN_OK);
    expect(run.out).toContain('AO Manager listening on');
  });

  it('leaves no handler behind once the server has closed', async () => {
    const before = process.listenerCount('SIGHUP');
    const server = listening();
    const done = serve([], server.outcome, { stopSignals: [SIGNAL] });
    server.close();
    await done;
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });

  it('production raises the real signal and exits the real process', () => {
    // A pin on the wiring rather than on the behaviour: calling either of these
    // in a test would end the test runner. What can be checked is that the
    // production pair is the real pair and not a pair of no-ops.
    expect(String(REAL_STOP_EFFECTS.raise)).toContain('process.kill');
    expect(String(REAL_STOP_EFFECTS.exit)).toContain('process.exit');
  });
});

/* ── 6. the boundary, swept over src/ ─────────────────────────────────────── */

/**
 * Every text file this build ships from `src/`, not only its TypeScript.
 *
 * The cases below say "the only place in src", "no module", "every listen call
 * in this build" — sentences about the whole tree. They only hold if the walk
 * reads the whole tree. Until DASHBOARD-001 slice 4 that was `.ts` and nothing
 * else, so the filter and the sentence agreed by accident; slice 4 put shipped
 * JavaScript under `src/` for the first time, alongside `.html`, `.css` and a
 * `.webmanifest`, and the `.ts` filter quietly narrowed every one of them.
 *
 * No current UI asset matches `createServer(` or `.listen(`, so nothing here
 * was *false*. What was wrong is that nothing had read the files — and this is
 * the sweep slice 3's "only one verb listens" claim rests on.
 *
 * `.png` is left out deliberately and by name: the two icons are binary, and
 * `codeOf` would hand these patterns mojibake rather than source.
 */
const SWEPT_EXTENSIONS = ['.ts', '.js', '.html', '.css', '.webmanifest'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.isFile()) return [];
    return SWEPT_EXTENSIONS.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

/** The shipped browser assets, by name, so the widening is asserted and not assumed. */
const SHIPPED_UI_ASSETS = [
  'dashboard/ui/app.css',
  'dashboard/ui/app.js',
  'dashboard/ui/index.html',
  'dashboard/ui/manifest.webmanifest',
  'dashboard/ui/sw.js',
];

/** Source with comments removed, so a module's prose is not an exception. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function named(path: string): string {
  return relative(SRC, path).split('\\').join('/');
}

describe('one module listens, and it is named', () => {
  it('reads the files this build ships that are not TypeScript', () => {
    // The *filter's* false-negative guard, a different instrument from the
    // pattern guards beside it. Every sweep in this section is an absence
    // assertion over a file list, so a narrowed or mistyped extension list
    // restores the blind spot with all of them still green — which is exactly
    // the state slice 4 left this file in. This case is the one that fails
    // when the walk stops reading a shipped asset.
    //
    // Bidirectional on purpose. One direction fails when the walk stops reading
    // an asset; the other fails when a sixth one is added, so a new shipped
    // file has to be put on this list by somebody who has decided that these
    // sweeps should read it. The two `.png` icons are absent from both sides,
    // which is what "`.png` is excluded by name" looks like when it is measured
    // rather than merely written down.
    const swept = sourceFiles(SRC)
      .map(named)
      .filter((file) => file.startsWith('dashboard/ui/'));
    expect(swept.sort()).toEqual(SHIPPED_UI_ASSETS);
  });

  it('is the only place in src that builds or binds a server', () => {
    const creates = /createServer\s*\(|\.listen\s*\(/;
    const offenders = sourceFiles(SRC).filter((path) => creates.test(codeOf(path)));
    expect(offenders.map(named).sort()).toEqual(['dashboard/http-server.ts']);
  });

  it('would notice if that pattern stopped matching the module it is aimed at', () => {
    // The false-negative guard. The sweep above is an absence assertion, and an
    // absence assertion whose pattern matches nothing passes for any tree.
    const code = codeOf(join(SRC, 'dashboard', 'http-server.ts'));
    expect(/createServer\s*\(/.test(code)).toBe(true);
    expect(/\.listen\s*\(/.test(code)).toBe(true);
  });

  it('is reached from exactly one module in the whole of src', () => {
    // Over all of `src/`, not only `src/cli/`. The narrower version said "one
    // command module" while the prose beside it claimed "one importer", and the
    // two were not the same sentence: a reader, a scheduler or a notifier could
    // have imported the listener with nothing to notice.
    const importers = sourceFiles(SRC)
      .filter((path) => /dashboard\/http-server\.js/.test(codeOf(path)))
      .map(named)
      .sort();
    expect(importers).toEqual(['cli/dashboard-command.ts']);
  });

  it('never binds without naming the host', () => {
    // Node reads an omitted host as every interface, so `listen(port)` is not a
    // smaller bind than `listen({host, port})` — it is the opposite one. Every
    // listen call in this build must carry a host.
    const code = codeOf(join(SRC, 'dashboard', 'http-server.ts'));
    const calls = code.match(/\.listen\s*\([^)]*\)/g) ?? [];
    expect(calls).toHaveLength(1);
    for (const call of calls) expect(call).toContain('host:');
  });
});

describe('what may not appear in production source', () => {
  const files = sourceFiles(SRC);

  it('reads no environment variable to decide where or whether to listen', () => {
    const dashboardFiles = files.filter(
      (path) => named(path).startsWith('dashboard/') || named(path) === 'cli/dashboard-command.ts',
    );
    expect(dashboardFiles.length).toBeGreaterThan(3);
    for (const path of dashboardFiles) {
      expect(codeOf(path), named(path)).not.toContain('process.env');
    }
  });

  it('derives no trust from a remote address or a forwarding header', () => {
    // The real form of a pin dashboard-05 once had wrongly: it asserted the key
    // set of its OWN fixture object, which measured the test rather than the
    // build, because the facts type is erased at runtime. The property belongs
    // to production source, and this is the only module that could read any of
    // these — the contract is handed four values and a socket is nowhere near
    // it.
    const untrustworthy = [
      'remoteaddress',
      'remotefamily',
      'remoteport',
      'x-forwarded',
      'x-real-ip',
      'true-client-ip',
      'cidr',
    ];
    const server = codeOf(join(SRC, 'dashboard', 'http-server.ts')).toLowerCase();
    for (const source of untrustworthy) expect(server, source).not.toContain(source);
    // `forwarded` on a word boundary, so the RFC 7239 field is covered without
    // banning the ordinary English word inside another one.
    expect(/\bforwarded\b/.test(server)).toBe(false);

    // Positive control: the sweep can see this module's real header reads, so
    // it is not passing because it is pointed at nothing.
    expect(server).toContain('rawheaders');
    expect(server).toContain('if-none-match');
  });

  it('never writes the literal localhost', () => {
    // It is a name, and what it resolves to is a property of a hosts file
    // rather than of this build. `notify-config.ts` already refuses it for an
    // endpoint; a bind address is the same argument.
    for (const path of files) {
      expect(codeOf(path).toLowerCase(), named(path)).not.toContain('localhost');
    }
  });

  it('carries no vendor of any access layer', () => {
    // The access layer that may one day sit in front of this is external
    // infrastructure an operator configures. This build must not name it,
    // detect it, parse its headers or grow a setting for it.
    const vendors = [
      'tailscale',
      'ts.net',
      'funnel',
      'cloudflare',
      'cloudflared',
      'ngrok',
      'x-forwarded-for',
      'forwarded-for',
    ];
    for (const path of files) {
      const lowered = codeOf(path).toLowerCase();
      for (const vendor of vendors) expect(lowered, `${named(path)} / ${vendor}`).not.toContain(vendor);
    }
  });

  it('opens no watcher and no stream over AgentOrchestrator’s state', () => {
    // A watcher or a held stream is the one way a reader can make the writer
    // fail: AO publishes durable state by renaming over the old file, and on
    // NTFS an open handle refuses that rename.
    //
    // Widening the walk to `.js` brought one construct with it, and it is named
    // here rather than filtered away with the file that carries it. A service
    // worker spells the browser Cache API `caches.open(NAME)`, which
    // `\bopen\s*\(` matches; that is a handle on a browser's cache store, held
    // in the browser's process, and it cannot refuse a rename AO makes. The
    // *file* stays in the sweep — `sw.js` is still read for `watch(`,
    // `createReadStream(`, `openSync(` and every other `open(` — because
    // excluding the file would put back the blind spot this change removes.
    const BROWSER_CACHE_HANDLE = /\bcaches\.open\s*\(/g;
    const watchers = /\bwatch(File)?\s*\(|createReadStream\s*\(|\bopenSync\s*\(|\bopen\s*\(/;
    const offenders = files
      .filter((path) => named(path).startsWith('dashboard/'))
      .filter((path) => watchers.test(codeOf(path).replace(BROWSER_CACHE_HANDLE, '')));
    expect(offenders.map(named)).toEqual([]);
  });

  it('strips the browser cache handle and nothing else', () => {
    // The carve-out's own control, so it cannot quietly grow into an exclusion
    // of the file. `caches.open(` is removed; any other `open(` in the same
    // file is not, and this fails if that stops being true.
    const worker = codeOf(join(SRC, 'dashboard', 'ui', 'sw.js'));
    expect(/\bcaches\.open\s*\(/.test(worker), 'sw.js no longer uses the Cache API').toBe(true);
    const stripped = worker.replace(/\bcaches\.open\s*\(/g, '');
    expect(/\bopen\s*\(/.test(stripped), 'the carve-out hid more than it names').toBe(false);
    expect(/\bopen\s*\(/.test(`${stripped}\nfs.open(statePath);\n`), 'a real open() survives').toBe(
      true,
    );
  });

  it('adds no runtime dependency for one route', () => {
    const manifest = JSON.parse(
      readFileSync(join(SRC, '..', 'package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['commander', 'yaml', 'zod']);
  });
});
