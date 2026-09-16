/**
 * DASHBOARD-001 slice 3 — the HTTP contract, decided without a socket.
 *
 * Every question this service answers about a request — is this Host allowed,
 * is this a route this build answers, is this the one method, is the caller's
 * copy still good, which headers go out — is decided here, in a pure function
 * over a description of the request. `http-server.ts` is the only module that
 * owns a socket, and all it does is read those facts off a Node request, call
 * this, and write the answer back.
 *
 * The split is not tidiness. The properties worth pinning are refusals — a
 * duplicated `Host`, a request target that is not origin-form, a method nobody
 * offered, an entity-tag list with a `*` in it — and a test that has to open a
 * listening socket to provoke one is a test that provokes it rarely and reads
 * badly. Here every one of them is a value in, a value out.
 *
 * ── What this layer is not ─────────────────────────────────────────────────
 *
 * It forms no opinion about AgentOrchestrator. It does not decide what is
 * actionable, what a task's state means, or whether anything is running: slice 1
 * decided all of that and slice 2 chose what may cross to a browser. This layer
 * receives the finished public value and puts HTTP around it. If it ever starts
 * reading a field to make a decision, that is a second domain layer and the
 * reason this file says so here is that it is easy to do by accident.
 */

import { canonicalJson, type PublicSnapshot } from './public-view.js';
import type { DashboardAssetMap } from './ui-assets.js';

/* ── the fixed surface ─────────────────────────────────────────────────────── */

/**
 * The only address this service binds, written out rather than defaulted.
 *
 * Node treats an omitted host as "every interface", so an omitted host is not a
 * smaller version of this constant — it is the opposite of it. There is
 * deliberately no option to change it: a flag able to widen the bind is exactly
 * the public exposure this slice exists to not have, and an operator who wants
 * this service reachable from elsewhere puts an access layer in front of it
 * rather than asking the product to listen wider.
 *
 * The literal `localhost` is not used anywhere in this service. It is a name,
 * it is resolved by the machine's resolver, and what it resolves to is a
 * property of a hosts file rather than of this build.
 */
export const DASHBOARD_BIND_HOST = '127.0.0.1';

/** The default port. Fixed: a collision is reported, never worked around. */
export const DASHBOARD_DEFAULT_PORT = 47113;

/** The one data route. Compared literally — never decoded, never normalised. */
export const SNAPSHOT_PATH = '/api/snapshot';

/** The one method this service offers, on that route and on every asset. */
export const SNAPSHOT_METHOD = 'GET';

/**
 * Headers every response carries, whatever its status.
 *
 * `no-store` because a snapshot is a momentary observation and a shared cache
 * holding one is worse than no answer at all. `nosniff` because the body is
 * JSON and a browser guessing otherwise is the whole content-type-confusion
 * class. The policy is the empty one, and it governs exactly the responses
 * this constant is the whole of: every refusal, and the snapshot. None of them
 * is a document, so one that somehow rendered may load nothing and may not be
 * framed. A served asset replaces this single line with
 * `UI_CONTENT_SECURITY_POLICY` below and keeps every other header — which is
 * the right way round, because it leaves the empty policy as the default a new
 * kind of response inherits by forgetting rather than by choosing.
 *
 * Four things are deliberately absent, and each is a decision rather than an
 * omission:
 *
 *  - **HSTS** — this process terminates no TLS and has no opinion about what
 *    might one day sit in front of it. A build that asserts a transport it does
 *    not provide is asserting something it cannot know.
 *  - **CORS** — no `Access-Control-Allow-*` of any kind. The absence is what
 *    keeps a page on another origin from reading these bytes.
 *  - **cookies** — nothing here has a session, and a `Set-Cookie` on a
 *    read-only observation is a credential looking for somewhere to be sent.
 *  - **`Referrer-Policy`** — it governs what a *document* sends when it
 *    navigates somewhere else. No response these headers are the whole of is a
 *    document, and the page slice 4 added links nowhere but its own fragments,
 *    so there is still no navigation for a policy to govern.
 */
export const CONSTANT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
});

/** The media type of every body this service produces. */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * The policy a SERVED asset carries. Refusals keep `CONSTANT_HEADERS`.
 *
 * Still `default-src 'none'`: six `'self'` grants for the six things a
 * same-origin application actually loads, and three further lock-downs. There
 * is deliberately no `'unsafe-inline'`, which is not a detail — it is what
 * makes `index.html` carry no inline script, no `<style>` and no `style=`
 * attribute, and it is the difference between a policy and a decoration.
 *
 * `worker-src` is what governs registering the service worker; `manifest-src`
 * governs `<link rel="manifest">`; `connect-src` governs the `fetch` to
 * `/api/snapshot`. Each is present because something in this build needs it,
 * and nothing else is.
 */
export const UI_CONTENT_SECURITY_POLICY =
  "default-src 'none'; " +
  "script-src 'self'; style-src 'self'; img-src 'self'; " +
  "connect-src 'self'; manifest-src 'self'; worker-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/* ── refusals ──────────────────────────────────────────────────────────────── */

/**
 * Why a request was refused, as a code and never as a sentence.
 *
 * A body here reaches a caller this service has already decided it does not
 * trust, so it carries a closed vocabulary and nothing else: no path, no header
 * value, no exception text, no stack. `INTERNAL` in particular must stay empty
 * of detail — it is reached when this build has a defect, which is the moment
 * an error string is most likely to be quoting something it should not.
 */
export type DashboardRefusalCode =
  | 'BAD_REQUEST'
  | 'HOST_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'INTERNAL';

/* ── the request, as facts ─────────────────────────────────────────────────── */

/**
 * Everything about a request this contract is allowed to see.
 *
 * `hostHeaders` is a list on purpose. Node's `req.headers.host` keeps the first
 * `Host` and silently discards the rest, so a request carrying two of them
 * looks identical to a request carrying one — and "which Host did the thing in
 * front of us route on" is precisely the question a duplicated Host makes
 * unanswerable. The server reads `rawHeaders` to fill this, and a length other
 * than one is refused below rather than resolved.
 *
 * `target` is the request target exactly as it arrived. Nothing decodes it.
 */
export interface DashboardRequestFacts {
  readonly method: string;
  readonly target: string;
  readonly hostHeaders: readonly string[];
  /** The joined `If-None-Match` field value, or `null` when absent. */
  readonly ifNoneMatch: string | null;
}

/** What to write back. Header names are already in the casing to send. */
export interface DashboardHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * `null` means no body at all — not an empty one.
   *
   * `Uint8Array` is not a convenience. Two of this build's assets are PNG, and
   * a PNG is full of bytes that are not valid UTF-8. `write` (in
   * `http-server.ts`) sends the string arm with an explicit `'utf8'`
   * encoding, which re-interprets every UTF-16 code unit as a Unicode code
   * point and re-encodes it — the identity mapping only below U+0080. A byte
   * held in a string this way is therefore not the byte that reaches the
   * wire, and the declared `Content-Length` ends up describing bytes that
   * never left. The two arms are measured separately, by `bodyByteLength`
   * below, for that same reason.
   */
  readonly body: string | Uint8Array | null;
}

/**
 * The length of a body in bytes, for either arm.
 *
 * `String.prototype.length` counts UTF-16 code units and is the wrong number
 * for any non-ASCII character; `Buffer.byteLength` counts what goes on the
 * wire. A `Uint8Array` is already bytes.
 */
export function bodyByteLength(body: string | Uint8Array): number {
  return typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength;
}

/* ── hosts ─────────────────────────────────────────────────────────────────── */

/**
 * A `Host` value reduced to the form the allow-list compares, or `null`.
 *
 * Case-folded over ASCII only, by hand. `String.prototype.toLowerCase` is
 * Unicode case folding: `'İ'` (LATIN CAPITAL I WITH DOT ABOVE) lowercases
 * to *two* code points, so a Unicode fold can change a string's length and can
 * map two distinct inputs onto one allow-list entry. A host is ASCII by the
 * time it is on the wire, so folding only `A-Z` is both sufficient and the only
 * mapping with no such surprise.
 *
 * `null` is returned for anything that cannot be a Host field value at all —
 * empty, over-long, or carrying a byte that has no business in one. That is not
 * an interpretation of what the value *means*: this build never learns that a
 * host names a VPN, a proxy, a tunnel or a machine. It only refuses a string
 * that could not have been a host in the first place.
 */
export function normaliseHost(value: string): string | null {
  if (value.length === 0 || value.length > 255) return null;
  let folded = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // Printable US-ASCII minus space, and minus the delimiters a Host field
    // value cannot contain. A control character or a non-ASCII byte here means
    // the value was never a Host, whatever it was.
    if (code <= 0x20 || code >= 0x7f) return null;
    if (character === ',' || character === '/' || character === '\\') return null;
    if (character === '"' || character === "'" || character === '@') return null;
    folded += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : character;
  }
  return folded;
}

/**
 * The port a client omits from the authority, for the scheme this service
 * speaks.
 *
 * Not transport knowledge. This process terminates no TLS and says so in its
 * own startup line — it serves cleartext HTTP and nothing else — so `80` is
 * simply the default port of its own protocol, and a client addressing
 * `http://127.0.0.1/` sends `Host: 127.0.0.1` with no port at all.
 *
 * Measured, because it is the kind of thing that is easy to be wrong about:
 * with `--port 80`, `curl http://127.0.0.1/api/snapshot` puts `Host: 127.0.0.1`
 * on the wire, and an allow-list holding only `127.0.0.1:80` answered `421` to
 * every request made to the address the command had just printed. `443` is not
 * affected and is not listed here: it is the default for `https`, which this
 * service does not speak, so a client asking it for `http://127.0.0.1:443/`
 * does send the port.
 */
const ELIDED_PORT = 80;

/**
 * The allow-list a given bind produces, with the operator's additions folded in.
 *
 * The derived entries come from the address and port actually being bound, so
 * the default can never disagree with the default bind. Additions are opaque:
 * this function normalises them and puts them in a set, and that is the whole
 * of what the application ever does with them. An addition that cannot be a
 * Host is dropped — the caller validates and refuses before reaching here, and
 * this is the second of the two places that says so.
 *
 * There are two derived entries on exactly one port, and never more than that.
 * The authority a client puts in `Host` is the one it addressed, which is the
 * bind's address and port — except when the port is the one its scheme lets it
 * leave out, in which case the *same* authority is spelled without it. Both
 * spellings therefore name this bind, and admitting the second is not a
 * widening: it is still the loopback literal, so a name an attacker controls is
 * refused exactly as before.
 */
export function allowedHostsFor(
  bindHost: string,
  port: number,
  operatorSupplied: readonly string[],
): readonly string[] {
  const entries = new Set<string>();
  const own = normaliseHost(`${bindHost}:${port}`);
  if (own !== null) entries.add(own);
  if (port === ELIDED_PORT) {
    const elided = normaliseHost(bindHost);
    if (elided !== null) entries.add(elided);
  }
  for (const supplied of operatorSupplied) {
    const folded = normaliseHost(supplied);
    if (folded !== null) entries.add(folded);
  }
  return Object.freeze([...entries]);
}

/* ── entity tags ───────────────────────────────────────────────────────────── */

/**
 * The entity-tag for a snapshot: the slice-2 revision, always weak.
 *
 * Weak is not caution, it is the correct classification, and the difference is
 * load-bearing. `revisionOf` deliberately excludes `observedAt` — the instant
 * the reader looked is not something a reader can act on — so two responses
 * carrying the same revision are *semantically* the same observation while
 * differing byte for byte in that one field. RFC 9110 calls exactly that a weak
 * validator, and `If-None-Match` is specified to use the weak comparison
 * function, which is what makes `W/` both honest and sufficient here.
 *
 * A strong tag would be a lie about bytes nobody needs to be told about, and
 * the alternative — hashing the response JSON in this layer — would invent a
 * second change token beside the one slice 2 already defends with its own pins.
 */
export function entityTagFor(snapshot: PublicSnapshot): string {
  return `W/"${snapshot.revision}"`;
}

/**
 * Whether an `If-None-Match` field value selects the tag we are holding.
 *
 * The weak comparison function of RFC 9110: the `W/` prefix is ignored on both
 * sides and the opaque strings are compared as code units. `*` matches any
 * current representation, so it always selects.
 *
 * The split on `,` is naive, and that is a bounded imprecision rather than a
 * defect. An opaque-tag string may itself contain a comma, and a client sending
 * one would have its list mis-parsed here — the consequence is that no element
 * matches and the caller is answered `200` with the current body, which is
 * always a correct answer and never a stale one. Failing towards the full
 * response is the only direction this function is allowed to be wrong in.
 */
export function ifNoneMatchSelects(fieldValue: string, tag: string): boolean {
  const opaque = (candidate: string): string =>
    candidate.startsWith('W/') ? candidate.slice(2) : candidate;
  const wanted = opaque(tag);
  for (const raw of fieldValue.split(',')) {
    const candidate = raw.trim();
    if (candidate === '') continue;
    if (candidate === '*') return true;
    if (opaque(candidate) === wanted) return true;
  }
  return false;
}

/* ── the decision ──────────────────────────────────────────────────────────── */

function refuse(
  status: number,
  code: DashboardRefusalCode,
  extra: Readonly<Record<string, string>> = {},
): DashboardHttpResponse {
  const body = `${JSON.stringify({ error: code })}\n`;
  return Object.freeze({
    status,
    headers: Object.freeze({
      ...CONSTANT_HEADERS,
      ...extra,
      'Content-Type': JSON_CONTENT_TYPE,
      'Content-Length': String(bodyByteLength(body)),
    }),
    body,
  });
}

/**
 * The path a request target names, or `null` if the target is not origin-form.
 *
 * Only origin-form is accepted — a target beginning `/`, with any query and any
 * fragment cut off. Absolute-form (`GET http://elsewhere/api/snapshot`) is
 * legal on the wire and is refused here on purpose: it carries a *second*
 * authority beside the `Host` header, and a service that accepted both would
 * have to decide which of the two its allow-list is about. Refusing removes the
 * question. Authority-form (`CONNECT`) and asterisk-form (`OPTIONS *`) are
 * refused by the same rule.
 *
 * Nothing is percent-decoded and nothing is collapsed. `/api%2Fsnapshot` and
 * `/api/snapshot/` are simply not the route, which is deterministic and is the
 * property a test can hold on to.
 */
export function pathOf(target: string): string | null {
  if (!target.startsWith('/')) return null;
  const queryAt = target.indexOf('?');
  const fragmentAt = target.indexOf('#');
  const cut = [queryAt, fragmentAt].filter((index) => index >= 0);
  const end = cut.length === 0 ? target.length : Math.min(...cut);
  return target.slice(0, end);
}

/**
 * The whole HTTP contract, as one total function.
 *
 * The order of the decisions is itself part of the contract, and it is Host
 * first. Host validation is request-routing hardening: its job is to refuse a
 * request naming an authority this service was never told to answer for, which
 * is the DNS-rebinding shape — an attacker's own name resolved to the loopback
 * address, so the victim's browser puts *that name* in `Host`. A service that
 * routed first would let such a request learn which paths exist before being
 * refused.
 *
 * What it does **not** do, stated because the opposite is the easy thing to
 * believe: it does not stop a page on another origin from reaching this port. A
 * browser sends the authority of the URL it was given, so a page on any origin
 * fetching `http://127.0.0.1:47113/api/snapshot` sends the allowed Host and is
 * answered in full. What keeps the bytes from that page is the absence of
 * `Access-Control-Allow-*`, which is why that absence is a decision above and
 * is pinned on every status.
 *
 * It is **not** authentication either, and nothing downstream may treat a
 * passing Host as one: this
 * build derives no trust from a remote address, from `X-Forwarded-For`, from
 * `Forwarded`, from any vendor's identity header, or from membership of any
 * network. There is no authentication in this slice, and a Host that matches
 * proves only that the caller addressed the name it was told to.
 *
 * `snapshot` is a thunk so that a refused request costs no observation at all.
 * If it throws, this function does not catch: the server turns that into a
 * `500` with no detail, and swallowing it here would make a defect in the read
 * model indistinguishable from an empty machine.
 */
export function respondToDashboardRequest(
  request: DashboardRequestFacts,
  allowedHosts: readonly string[],
  snapshot: () => PublicSnapshot,
  assets: DashboardAssetMap = new Map(),
): DashboardHttpResponse {
  // ── 1. the Host ──────────────────────────────────────────────────────────
  //
  // Exactly one is required. Zero is an HTTP/1.1 request without the field its
  // own version makes mandatory; two is a request whose authority depends on
  // which one a reader picks. Neither is "misdirected" — nothing was decided
  // about where they were aimed — so both are `400` and only a well-formed
  // Host that is not on the list is `421`.
  if (request.hostHeaders.length !== 1) return refuse(400, 'BAD_REQUEST');
  const host = normaliseHost(request.hostHeaders[0] ?? '');
  if (host === null) return refuse(400, 'BAD_REQUEST');
  if (!allowedHosts.includes(host)) return refuse(421, 'HOST_NOT_ALLOWED');

  // ── 2. the route ─────────────────────────────────────────────────────────
  const path = pathOf(request.target);
  if (path === null) return refuse(400, 'BAD_REQUEST');

  // The API is decided BEFORE the asset map is consulted and never passes
  // through it. That ordering is what stops an asset table ever shadowing
  // the one route this service existed for before it had a UI.
  if (path !== SNAPSHOT_PATH) {
    const asset = assets.get(path);
    if (asset === undefined) return refuse(404, 'NOT_FOUND');
    if (request.method !== SNAPSHOT_METHOD) {
      return refuse(405, 'METHOD_NOT_ALLOWED', { Allow: SNAPSHOT_METHOD });
    }
    return Object.freeze({
      status: 200,
      headers: Object.freeze({
        ...CONSTANT_HEADERS,
        'Content-Security-Policy': UI_CONTENT_SECURITY_POLICY,
        'Content-Type': asset.contentType,
        'Content-Length': String(bodyByteLength(asset.bytes)),
      }),
      body: asset.bytes,
    });
  }

  // ── 3. the method ────────────────────────────────────────────────────────
  //
  // `GET` and nothing else, `HEAD` included. A `HEAD` would have to promise the
  // same entity-tag and the same length as the `GET` beside it, which means
  // taking the whole observation to answer a request whose body is then thrown
  // away — and no client this slice ships needs it. `Allow` names the one
  // method rather than leaving the caller to guess, which is what makes the
  // refusal actionable.
  if (request.method !== SNAPSHOT_METHOD) {
    return refuse(405, 'METHOD_NOT_ALLOWED', { Allow: SNAPSHOT_METHOD });
  }

  // ── 4. the observation ───────────────────────────────────────────────────
  const current = snapshot();
  const tag = entityTagFor(current);

  if (request.ifNoneMatch !== null && ifNoneMatchSelects(request.ifNoneMatch, tag)) {
    // A `304` carries the validator and the caching directives and nothing
    // else. No `Content-Type` and no `Content-Length`: there is no body to
    // describe, and a length of `0` would describe one that is empty.
    return Object.freeze({
      status: 304,
      headers: Object.freeze({ ...CONSTANT_HEADERS, ETag: tag }),
      body: null,
    });
  }

  // Serialised by the same function the change token is taken over, not by
  // `JSON.stringify`. That is what makes the weak tag defensible in both
  // directions: two observations answering one revision serialise to bytes that
  // differ in `observedAt` and nowhere else, because nothing else about the
  // encoding is free to move. Two serialisers would have let key order drift
  // under a tag that says the representation has not changed.
  //
  // `canonicalJson` has a precondition rather than a guarantee — it drops keys
  // whose value is `undefined` and writes a `Map`, a `Set` or a class instance
  // as `{}`. Every type in `PublicSnapshot` is a plain object of strings,
  // numbers, booleans, `null` and arrays, so the precondition holds; it is
  // stated here because it is a property of the value, not of the function.
  const body = `${canonicalJson(current)}\n`;
  return Object.freeze({
    status: 200,
    headers: Object.freeze({
      ...CONSTANT_HEADERS,
      ETag: tag,
      'Content-Type': JSON_CONTENT_TYPE,
      'Content-Length': String(bodyByteLength(body)),
    }),
    body,
  });
}
