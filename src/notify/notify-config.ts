/**
 * The opt-in: whether this machine's operator wants to be told, and where (V2-10).
 *
 * ── One location, outside every repository ─────────────────────────────────
 *
 *     <OS user profile>/.agent-orchestrator/notify.yaml
 *
 * The endpoint, the topic and the token come from that file and from nowhere
 * else. Not from the repository profile, not from repository content, not from a
 * CLI option, not from the environment. The reason is the one `paths.ts` already
 * gives for the write root: a value that redirects where this process sends data
 * is a privilege the orchestrator does not need and somebody else very much
 * does — and unlike a write root, this one leaves the machine.
 *
 * The root it sits under is derived from `os.userInfo()` through
 * `config/internal/path-provider.ts`, so it consults no environment block and
 * cannot be relocated by a caller, a parent process or a repository file. A
 * target repository cannot place this file, whatever it contains.
 *
 * ── Absence is the switch ──────────────────────────────────────────────────
 *
 * No file means notifications are off, and "off" is total: no transport is
 * constructed, no host is resolved, no socket is opened. That is the whole
 * opt-in mechanism, and it is the absence of a file rather than the default of a
 * flag — a default is something a later edit can flip by forgetting a case.
 *
 * A file that is present and unusable is **also** off. It is reported, loudly
 * and immediately, and it does not stop the run: refusing to orchestrate because
 * a notification is misconfigured would hand the notifier authority over whether
 * work happens, which is the one thing this whole slice may not do.
 *
 * ── What a refusal may say ─────────────────────────────────────────────────
 *
 * A closed code and nothing else. Never the path, never the file's bytes, never
 * a YAML parser message, never an errno text, and never any part of the endpoint
 * or the token — a refusal must not become the channel for the value it refused.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { orchestratorHome } from '../config/paths.js';
import { OS_PATH_PROVIDER, type PathProvider } from '../config/internal/path-provider.js';
import { safeErrnoCode } from '../core/safe-error.js';
import { loadSafeYamlDocument } from '../yaml/safe-yaml.js';

/** The one file name. There is no alternative spelling and no `.yml` fallback. */
export const NOTIFY_CONFIG_FILE_NAME = 'notify.yaml';

/**
 * Largest configuration this build will read.
 *
 * A ceiling rather than a guess: the document is three scalars, and anything
 * approaching this is not one. Refused before parsing, so an enormous file is
 * never turned into a document.
 */
export const MAX_NOTIFY_CONFIG_BYTES = 65_536;

/** Where the configuration lives. A pure function of the OS user identity. */
export function notifyConfigPath(provider: PathProvider = OS_PATH_PROVIDER): string {
  return join(orchestratorHome(provider), NOTIFY_CONFIG_FILE_NAME);
}

/**
 * Every way the configuration can be present and unusable. Closed, and carrying
 * nothing from the file itself.
 */
export const NOTIFY_CONFIG_REFUSALS = [
  /** The OS could not be asked where the user profile is, so there is no place to look. */
  'PROFILE_UNAVAILABLE',
  /** The file exists and could not be read. */
  'CONFIG_UNREADABLE',
  'CONFIG_TOO_LARGE',
  /** Not one well-formed, warning-free YAML document. */
  'CONFIG_MALFORMED',
  /** Well-formed, and carries a mapping key this boundary refuses by name. */
  'CONFIG_FORBIDDEN_KEY',
  /** A document that is not this contract: missing, unknown or mistyped fields. */
  'CONFIG_CONTRACT_VIOLATION',
  'ENDPOINT_NOT_A_URL',
  /** Neither `https:` nor a loopback `http:`. */
  'ENDPOINT_SCHEME_REFUSED',
  /** Plain HTTP to something that is not literally 127.0.0.1 or ::1. */
  'ENDPOINT_PLAINTEXT_NOT_LOOPBACK',
  /** `https://user:password@host/` — a credential in a URL is a credential in a log. */
  'ENDPOINT_CARRIES_CREDENTIALS',
  'ENDPOINT_CARRIES_QUERY',
  'ENDPOINT_CARRIES_FRAGMENT',
  /** A token that could not be put in a header without changing the request. */
  'TOKEN_NOT_HEADER_SAFE',
] as const;

export type NotifyConfigRefusal = (typeof NOTIFY_CONFIG_REFUSALS)[number];

export interface NotificationConfig {
  /** Absolute, validated, normalised to end in `/`. */
  readonly endpoint: string;
  readonly topic: string;
  readonly token: string | null;
}

export type NotificationConfigOutcome =
  /** No file. Notifications are off and nothing will be constructed. */
  | { readonly state: 'NOT_CONFIGURED' }
  /** A file that cannot be used. Notifications are off, and the operator is told. */
  | { readonly state: 'UNUSABLE'; readonly code: NotifyConfigRefusal }
  | { readonly state: 'CONFIGURED'; readonly config: NotificationConfig };

const unusable = (code: NotifyConfigRefusal): NotificationConfigOutcome =>
  Object.freeze({ state: 'UNUSABLE' as const, code });

/**
 * The document contract. `.strict()`, so an unknown key is a refusal rather than
 * a silently ignored intention.
 *
 * The endpoint is only shape-checked here; what makes a URL *permissible* is
 * {@link validateNotificationEndpoint} below, which is a policy and not a type.
 */
const NotifyConfigSchema = z
  .object({
    endpoint: z.string().min(1).max(2048),
    /**
     * ntfy's own topic grammar. Constrained rather than free text because a topic
     * is the address half of the credential, and a value with a slash, a space or
     * a control character in it is a mistake this can catch before the network
     * does.
     */
    topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    token: z.string().min(1).max(512).optional(),
  })
  .strict();

/**
 * A token that can be placed in a header without changing the request.
 *
 * Visible ASCII only: no CR, no LF, no space, no control character, nothing
 * outside 7-bit. `fetch` would refuse most of these itself, later and as an
 * exception; refusing here makes it a stated part of the configuration contract
 * and turns "your notification silently never worked" into one printed code.
 */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;

export type EndpointVerdict =
  | { readonly ok: true; readonly endpoint: string }
  | { readonly ok: false; readonly code: NotifyConfigRefusal };

/**
 * Whether a configured URL is inside the egress boundary, and its normal form.
 *
 * Pure, and separate from reading the file, because this is the whole of the
 * bounded-egress decision and it deserves to be readable and testable on its
 * own.
 *
 * ── The rules ──────────────────────────────────────────────────────────────
 *
 *  - `https://<host>/…` is allowed. The operator chooses the host, because a
 *    self-hosted ntfy is a real deployment and hard-coding one vendor's domain
 *    would be a policy about somebody else's infrastructure.
 *  - `http://` is allowed **only** for the literal loopback addresses
 *    `127.0.0.1` and `::1`. Plaintext that cannot leave the machine is a
 *    different risk from plaintext that can. `localhost` is deliberately not
 *    equivalent: it is a name, and a name is answered by DNS or a hosts file,
 *    neither of which this process controls. The exception must not depend on
 *    something an attacker can answer.
 *  - Every other scheme is refused. There is no `file:`, no `ftp:`, no
 *    `data:` — a notifier that can write a file is not a notifier.
 *  - A URL may not carry credentials, a query or a fragment. ntfy's JSON
 *    publishing needs none of the three, and each is a way for configuration to
 *    smuggle content into the request line rather than into the body.
 *
 * A path prefix survives: `https://example.com/ntfy/` is a reverse-proxied
 * install and is normalised to end in a slash so the transport can post to it
 * without deciding how to join two strings.
 */
export function validateNotificationEndpoint(value: string): EndpointVerdict {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, code: 'ENDPOINT_NOT_A_URL' };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'ENDPOINT_CARRIES_CREDENTIALS' };
  }
  if (url.search !== '') return { ok: false, code: 'ENDPOINT_CARRIES_QUERY' };
  if (url.hash !== '') return { ok: false, code: 'ENDPOINT_CARRIES_FRAGMENT' };

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, code: 'ENDPOINT_SCHEME_REFUSED' };
  }
  // `URL` keeps an IPv6 host in its bracketed form, which is what has to be
  // compared: the literal, never a name and never a resolution.
  if (url.protocol === 'http:' && url.hostname !== '127.0.0.1' && url.hostname !== '[::1]') {
    return { ok: false, code: 'ENDPOINT_PLAINTEXT_NOT_LOOPBACK' };
  }

  const endpoint = url.pathname.endsWith('/') ? url.href : `${url.href}/`;
  return { ok: true, endpoint };
}

/**
 * Reads the operator's notification configuration, or says why there is none.
 *
 * Never throws. Every failure — including the operating system refusing to say
 * where the profile is — is a return value, because this is called on the way
 * into an attended run and a configuration problem may not become a run problem.
 */
export function loadNotificationConfig(
  provider: PathProvider = OS_PATH_PROVIDER,
): NotificationConfigOutcome {
  let path: string;
  try {
    path = notifyConfigPath(provider);
  } catch {
    // `trustedProfileDirectory` throws rather than guessing. Its message is
    // already value-free, and it is dropped here regardless.
    return unusable('PROFILE_UNAVAILABLE');
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (safeErrnoCode(error) === 'ENOENT') return Object.freeze({ state: 'NOT_CONFIGURED' as const });
    return unusable('CONFIG_UNREADABLE');
  }

  if (bytes.byteLength > MAX_NOTIFY_CONFIG_BYTES) return unusable('CONFIG_TOO_LARGE');

  const parsed = loadSafeYamlDocument(bytes.toString('utf8'));
  if (parsed.outcome === 'FORBIDDEN_KEY') return unusable('CONFIG_FORBIDDEN_KEY');
  if (parsed.outcome !== 'DOCUMENT') return unusable('CONFIG_MALFORMED');

  const contract = NotifyConfigSchema.safeParse(parsed.document);
  // The Zod issue is deliberately not carried: it is a message authored by a
  // dependency about a file this module refuses to quote.
  if (!contract.success) return unusable('CONFIG_CONTRACT_VIOLATION');

  const endpoint = validateNotificationEndpoint(contract.data.endpoint);
  if (!endpoint.ok) return unusable(endpoint.code);

  const token = contract.data.token ?? null;
  if (token !== null && !HEADER_SAFE_TOKEN.test(token)) return unusable('TOKEN_NOT_HEADER_SAFE');

  return Object.freeze({
    state: 'CONFIGURED' as const,
    config: Object.freeze({ endpoint: endpoint.endpoint, topic: contract.data.topic, token }),
  });
}
