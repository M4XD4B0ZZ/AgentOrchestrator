# DASHBOARD-001 slice 4 — the mobile UI, and what it refuses to claim

**Date:** 2026-09-16
**Status:** agreed, not implemented
**Base:** `main` at `534c47b` (slices 1–3, PR #106)

> **Revision note.** The first draft of this document was audited against the
> repository by 58 agents; 41 findings survived adversarial refutation, 13 of
> them blocking. This version is the corrected one. The defects are not listed
> as history — they are corrected in place — but the classes are worth naming
> because each is a way a *design* can be wrong rather than merely incomplete:
> prose asserting the opposite of the shipped code; a response type that cannot
> carry the bytes the design promises; a production deploy path the design never
> mentions; test levels with no harness behind them; and a duration derived from
> a field that does not mean what its name suggests.

---

## 1. What this slice is

Slices 1–3 built a read-only observation and put one HTTP route around it.
There is no user interface: the only way to read AgentOrchestrator's state from
a browser is to look at raw JSON.

This slice adds the interface. It is a mobile-first, installable web
application served by the **same process, on the same origin**, from the
listener slice 3 already owns.

It adds **no** authority. It takes no lease, writes no file, starts no program
and offers no control. It is a second way to *read* the value slice 2 already
decided may cross to a browser.

### The sentence this slice exists to keep true

> The phone tells me what is happening, what is done, what is still open, and
> what needs me — without inventing a completion percentage, and without ever
> showing an old state as if it were current.

Both halves are load-bearing. The first is the feature. The second is the
constraint, and it shapes nearly every decision below.

---

## 2. Decisions inherited, and not reopened here

| Decision | Stands because |
|---|---|
| the listener binds `127.0.0.1` and nothing else | a flag able to widen it is the public exposure slices 1–3 exist not to have. Reaching the UI from a phone is an **operator deployment concern** — Tailscale Serve, or a reverse proxy — never product code |
| no authentication | there is none to extend. A Host that matches proves only that the caller addressed the name it was told to |
| no CORS | UI and API share one origin, so nothing needs it, and its absence is what keeps another origin from reading these bytes |
| no Tailscale-specific code in `src/` | `src/` contains no occurrence of `tailscale` or `ts.net` today, and a sweep pins that absence |
| `READY_FOR_PR` stays terminal | this slice adds a reader, not a control plane |

### 2.1 The precondition the operator owns: a secure context

**The entire PWA half of this slice exists only on a secure context.** Service
workers, Cache Storage and installability are all gated on one, and a browser
supplies no fallback: on an insecure origin `navigator.serviceWorker` is simply
absent.

- `http://127.0.0.1` **is** a secure context. A browser on the AO machine gets
  the full application.
- `https://<host>.ts.net` behind Tailscale Serve **is** a secure context. The
  phone gets the full application.
- `http://100.x.y.z` — a bare-HTTP tailnet address — is **not**. There is no
  worker, no cache, no install prompt.

This is a property of the access layer the operator puts in front, and this
build cannot detect or influence it. Two consequences are binding on the
implementation:

1. `app.js` **must feature-detect** — `if ('serviceWorker' in navigator)` — and
   must render, poll and degrade completely normally when the answer is no. An
   unguarded `navigator.serviceWorker.register(...)` throws on an insecure
   origin and takes down the whole UI, turning a missing *offline* feature into
   a blank screen.
2. The UI is **network-only** in that case, which is a reduced product and not a
   broken one.

### 2.2 The one place the boundary really does move

Serving a UI is **not** free of security work. Today every response carries

```
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
```

which forbids loading *any* script, stylesheet, image or manifest. A UI cannot
be served under it. Section 6 defines the minimal change, and it is the only
security-relevant surface this slice adds.

---

## 3. What the data can actually answer

The landing screen must answer **eight** questions. Five are answerable from
the slice-2 public snapshot as it stands, one only partly, and two are not.

| Question | Source | Answerable |
|---|---|---|
| Is anything waiting for me? | `needsOperator[]` → `{repositoryKey, taskId, reason, text}` | yes |
| Which projects are there, and what are they called? | `repositories[]`; the name is `profile.repositoryId`, **present only** when `profile.reading === 'DECLARED'` | **partly** (3.4) |
| Is a project active? | `lease` | **partly** (3.2) |
| Which task is AO on? | *not carried* — the lease names no task | **no** (3.2) |
| What state is a task in? | `runtime.state`, `runtime.stateKind`, `runtime.stateEnteredAt` | yes |
| How far through is it? | *nothing* | **no** (3.1) |
| Blocked / waiting / failed? | `operational`, `runtime.blockedAgent`, `runtime.reportedResetAt`, `verification.lastAttempt.verdict` | yes |
| When was this last refreshed? | the client's own last successful fetch | yes |

### 3.1 There is no progress value, and this slice does not invent one

The snapshot carries no percentage, no step counter and no milestone. A
percentage derived from position in the state machine would be false precision:
the states are not equal in length.

So project completion is an authoritative count (3.3), and a task's position is
the **state name** plus the review round where one applies.

**`stateEnteredAt` is not "time in this state", and must not be printed as if
it were.** The field is stamped when the *step began* — before a multi-minute
agent ran — and a checkpoint rewrites it with no state change at all. A line
reading `REVIEWING · 8 min` is exactly the invented precision this section
refuses. The honest rendering names the record:

```
REVIEWING · recorded 8 min ago
```

**Every derived age is computed against `snapshot.observedAt`, never against
the phone's `Date.now()`.** `observedAt` is a server-side ISO instant; a phone
with a skewed clock would otherwise print a negative age. This is the one place
`observedAt` is used, and it does not contradict 7.1, which governs *freshness*
only.

A real progress contract — AO recording what it is executing and how far
through — is a later slice of its own (§11), not something smuggled into a UI
slice.

### 3.2 Uncertainty is preserved in the wording

**Repository activity.** `lease: HELD` proves something holds this repository.
It does not prove AgentOrchestrator is running: AO writes no pidfile, no
heartbeat and no daemon record, so an *absent* lease is not evidence that
nothing is running either. The wording table is **total** over
`PublicLeaseReading` × `ownerLiveness`:

| `lease.reading` | `ownerLiveness` | Shown as |
|---|---|---|
| `HELD` | `ALIVE` | `Repository activity: confirmed` |
| `HELD` | `NOT_FOUND` | `Lease held · recorded owner is gone` |
| `HELD` | `UNDETERMINED` | `Lease held · owner liveness could not be determined` |
| `HELD` | `UNKNOWABLE` | `Lease held · no owner recorded` |
| `FREE` | — | `No lease held` |
| `OTHER` | — | `Lease state: <state>` — the carried string verbatim, uninterpreted |
| `NOT_OBSERVED` | — | `Lease could not be read — <why>` |

`NOT_FOUND` is the row that matters most and the one the first draft got wrong
by folding it into "unknown". A held lease whose recorded owner is **gone** is a
stale lease — an operator fact requiring action — and it is not the same as a
probe that could not answer.

`FREE` is never rendered as "idle", which would claim AO is up and doing
nothing.

**The active task.** The lease names no task. "The task AO is working on" is
derived from tasks whose runtime reading is `LOADED` **and whose `stateKind` is
`REGULAR`**. `stateKind` is `'REGULAR' | 'BLOCKING' | 'TERMINAL'`, and
`REGULAR` is the precise reading: a `BLOCKING` task is by definition one AO is
*not* working on, and listing it here would page the operator twice with
contradictory framings — once under `NEEDS YOU`, once as "likely active".

It is a candidate, not a fact:

```
Likely active task
RESOLVER-V3-055
```

Never `Current task: …`. Where more than one task qualifies, **every**
qualifying task is listed, each with its own state and review block. Where none
qualifies, the line reads `No task in a work-loop state`.

### 3.3 Counts are never mixed across dimensions

`declaration` (`OPEN`/`DONE`/`NOT_DECLARED`/`UNDETERMINED`) and `operational`
(`ACTIONABLE`/`AUTOMATIC_WAIT`/`INACTIVE`/`CONFLICT`/`UNDETERMINED`) are
different axes. A task can be `OPEN` *and* `CONFLICT`, so `5 open · 3 done ·
1 conflict` would double-count and imply a partition that does not exist.

**Completion — the fields are named, not implied:**

- numerator: the count of `tasks[]` whose `declaration === 'DONE'`;
- denominator: `declaredTasks.count`, **only** when
  `declaredTasks.reading === 'DISCOVERED'`. Never `tasks.length`, which also
  contains runtime-only rows whose declaration is `NOT_DECLARED`.

```
3 / 11 declared tasks done
```

Two degenerate cases are specified rather than collapsed:

- any task whose `declaration` is `UNDETERMINED` is **named**, never folded into
  the remainder: `3 done · 7 open · 1 unreadable`;
- when `declaredTasks.reading` is `REFUSED` or `NOT_ATTEMPTED`, **no fraction is
  printed at all** — every declaration is `UNDETERMINED` in that case. The line
  is replaced by `Declared plan could not be read — <code>` / `<why>`.

Operational condition is a **separate** badge row: `1 conflict · 2 need
operator`.

### 3.4 A repository that cannot name itself

`profile.reading === 'UNUSABLE'` carries a `code` and **no `repositoryId`**.
Such a repository is never omitted — a repository AO cannot identify is itself
operator-relevant — and its `repositoryKey` is a digest, never silently
substituted for a name:

```
Unnamed repository · profile unusable (<code>)
```

### 3.5 Not carried by the snapshot

A task has an **id and no title**. The UI shows `RESOLVER-V3-055`. Adding a
title is read-model work, and belongs with the gaps in 3.2 (§11).

---

## 4. Shipping the assets

### 4.1 Authored files

```
src/dashboard/ui/
  index.html   app.css   app.js   sw.js
  manifest.webmanifest   icon-192.png   icon-512.png
src/dashboard/ui-assets.ts     the manifest + the startup loader
scripts/build-ui-assets.mjs    the shared emit step
```

The icons are **authored once and committed**, like every other asset. A
one-off generator may produce them during implementation; it is not part of the
build, which copies and never re-creates artwork.

### 4.2 The emit step runs on both paths — including deploy

This repository has **two** output paths, and the first draft's single biggest
defect was naming only one:

| Path | Writes | Produced by |
|---|---|---|
| `build/` | the verified, disposable build | `npm run build` |
| `dist/` | **the deployed runtime the production supervisor executes** | `npm run deploy` only |

`scripts/deploy-runtime.mjs` deliberately **re-compiles rather than copying**
`build/`: its entire emit set is `tsc -p tsconfig.build.json --outDir <staging>`,
`compileNativeBoundary`, `writeRuntimeProvenance`, `promoteRuntime`. There is no
`cpSync` anywhere in `scripts/`, and `tsconfig.build.json` includes only
`src/**/*.ts`, so **tsc emits no `.html`, `.css`, `.js`, `.webmanifest` or
`.png` at all.**

Left unaddressed, the first `npm run deploy` after this slice would produce a
`dist/` with no `dashboard/ui/`, and §4.4's all-or-nothing rule would then make
`dist/cli/index.js dashboard serve` **unstartable in production** — while every
gate stayed green, because `runtime-deployment-dist-artifact.mjs` only checks
the other direction (files the runtime carries that the build does not).

Therefore `scripts/build-ui-assets.mjs` exports a function taking a destination,
and it is invoked **twice**:

- by `npm run build`, into `build/dashboard/ui/`. The chain becomes
  `tsc -p tsconfig.build.json && npm run build:ui && npm run build:boundary &&
  npm run build:provenance`;
- by `deployRuntime`, into `<staging>/dashboard/ui/`, beside the existing
  `compileNativeBoundary` call and before promotion.

This mirrors the only precedent: `native/ao-launch.exe` is the other non-`tsc`
artefact, and it already has exactly these two call sites.

### 4.3 One authority, and the two derived lists

The **manifest in `src/dashboard/ui-assets.ts` is the single authority.**
`build-ui-assets.mjs` carries no second copy of the list — it copies the
`src/dashboard/ui/` directory wholesale, **with exactly one exception**: it
substitutes two placeholder tokens in `sw.js` (§5.3).

Two further lists are therefore *derived*, never hand-maintained:

| Derived list | Derived how |
|---|---|
| the digest input (§5.3) | the manifest's routes minus `/sw.js` |
| the worker's fetch allow-list (§5.2) | the same set, substituted into `sw.js` as `__AO_SHELL_ROUTES__` |

A bidirectional gate ties the manifest to each artefact: every manifest route
resolves to a present file, **and** every file in the artefact's `ui/` directory
is named by the manifest — run against `build/` *and* against a freshly
deployed `dist/`.

### 4.4 The route table is closed and literal

| Route | File | `Content-Type` |
|---|---|---|
| `/` | `index.html` | `text/html; charset=utf-8` |
| `/app.css` | `app.css` | `text/css; charset=utf-8` |
| `/app.js` | `app.js` | `text/javascript; charset=utf-8` |
| `/sw.js` | `sw.js` | `text/javascript; charset=utf-8` |
| `/manifest.webmanifest` | `manifest.webmanifest` | `application/manifest+json` |
| `/icon-192.png` | `icon-192.png` | `image/png` |
| `/icon-512.png` | `icon-512.png` | `image/png` |

`/api/snapshot` is decided **before** this table is consulted and never passes
through it.

**This is not a static-file server and must never become one.** The decision
order inside the contract is unchanged — Host, then route, then method — and the
asset step is a lookup in a frozen `Map`, on the request path exactly as it
arrived: no percent-decoding, no normalisation, no `path.join`, no filesystem
access during a request, no open handle.

Traversal is therefore not *mitigated*; it has nowhere to go. Note the two
refusal codes, because they differ and a test must assert the specific one:

| Input | Answer | Why |
|---|---|---|
| `/api/../app.js`, `//app.css`, `/%2e%2e/app.css` | `404` | origin-form, simply not a key |
| `../app.css`, `..%5capp.css`, `http://x/app.css`, `*` | `400` | not origin-form — refused before routing |

A future change that started decoding would show up as a **status change**, not
as a silently-still-passing test.

### 4.5 Startup is all-or-nothing

Before the socket is opened, the loader reads **every** asset the manifest
names. If any one is missing or unreadable the Manager **does not start**: a new
outcome `UI_ASSETS_UNUSABLE`, reported with the failing **route** (never a
filesystem path), exiting `EXIT_RUN_UNEXPECTED` — nothing the operator typed was
wrong; the artefact is defective.

There is no partial serve. Once built, the map is never updated and a request
never reads from disk — the NTFS rename guarantee slice 1 depends on is
untouched. A deployment changes files, the Manager is restarted, and exactly
one consistent UI version is in memory.

### 4.6 `http-server.ts` does change — the body type widens

The first draft claimed the socket module "gains nothing". **That was false.**
`DashboardHttpResponse.body` is `string | null` and `write()` calls
`response.end(decided.body, 'utf8')`. Two PNG icons cannot survive that: a
UTF-8 round trip corrupts the bytes and misreports `Content-Length`.

So:

- `DashboardHttpResponse.body` widens to `string | Uint8Array | null`;
- `Content-Length` is computed with `Buffer.byteLength(body, 'utf8')` for the
  string arm and `body.byteLength` for the bytes arm;
- `write()` passes **no encoding** for the bytes arm;
- the frozen asset map reaches the contract as a **fourth argument** to
  `respondToDashboardRequest`, alongside the snapshot thunk. Per-response header
  variation needs no server change — `writeHead(status, {...headers})` already
  passes any header record verbatim.

A pin compares a served icon's bytes to the file on disk. A string round trip
passes a status-and-content-type test and fails only that one.

---

## 5. The service worker

### 5.1 It must have a fetch handler

The first draft pre-cached the shell and deliberately registered **no** `fetch`
handler. **That does not work.** A service worker's cache is consulted only by
code that consults it: with no `fetch` handler every request goes to the network
as if the worker did not exist, the pre-cached shell is never served, and the
application does not open offline at all.

So there is a `fetch` handler, and it is the narrowest one that can do the job.

### 5.2 The handler is an allow-list, not a pattern

```
handled (cache-first, from the shell cache) — __AO_SHELL_ROUTES__:
  /   /app.css   /app.js   /manifest.webmanifest   /icon-192.png   /icon-512.png

explicitly bypassed, always network:
  /api/snapshot

everything else:
  not handled — respondWith is never called
```

No wildcard, no "same-origin means cache it", no runtime cache population, no
stale-while-revalidate. A path outside the list falls through untouched — the
same closed-set discipline the server's route table uses.

`/api/snapshot` is named explicitly rather than left to fall through, so the
*intent* is readable and a future broadening would have to delete a line that
says why.

### 5.3 The update lifecycle

The committed `sw.js` contains two placeholder tokens, `__AO_SHELL_DIGEST__`
and `__AO_SHELL_ROUTES__`. `build-ui-assets.mjs` substitutes both: the digest is
a SHA-256 over the shell assets — `index.html`, `app.css`, `app.js`,
`manifest.webmanifest` and both icons, **excluding `sw.js` itself** to avoid a
circular definition. The cache is named `ao-shell-<digest>`.

Because the digest is *in* `sw.js`, changing any shell asset changes the
worker's bytes, which is what makes a browser notice an update at all. **A
failed substitution is therefore invisible and catastrophic**: it ships a worker
whose bytes never change, so no update ever runs. A dist gate asserts the
shipped `sw.js` contains a 64-hex `ao-shell-` name, contains **no** remaining
placeholder token, and that the digest equals one recomputed over the six shell
assets in that artefact.

On `install`:
1. open `ao-shell-<digest>`;
2. add every shell asset;
3. if any one fails, **the installation fails** — a half-populated shell cache
   is the offline equivalent of the partial serve §4.5 refuses;
4. only on complete success, `skipWaiting()`.

On `activate`:
1. delete every cache whose name begins `ao-shell-` and is not the current
   digest;
2. `clients.claim()`.

**What is promised, and what is not.** An online update *eventually* replaces
the old shell deterministically, and two shell versions are never mixed — every
cached asset comes from one `ao-shell-<digest>`. This design deliberately does
**not** promise that a new deployment appears on the exact first navigation that
discovers the new worker; that depends on browser update timing, and asserting
it would claim behaviour this build does not control.

### 5.4 Cold offline launch shows no state at all

The shell may open offline. It then has **no snapshot**, and says so:

```
AO status unavailable
No live data received in this session.
```

The last good snapshot lives **in page memory only** — not Cache Storage, not
`localStorage`, not IndexedDB. A snapshot surviving a process restart would be
an old orchestration state presented by an app that looks live.

### 5.5 The manifest must actually install

"Installable" is a decided constraint, so the manifest's members are specified
rather than left to a build that ships a file which parses but installs nothing:

| Member | Value |
|---|---|
| `name` | `AO Manager` |
| `short_name` | `AO` |
| `start_url` | `/` — exactly the shell cache key, no query string |
| `scope` | `/` |
| `display` | `standalone` |
| `icons` | both, with `sizes` `192x192` / `512x512`, `type: "image/png"`, `purpose: "any"` |

`<link rel="manifest">` carries **no** `crossorigin` attribute. The deployment
must mount the app at the **origin root**, because §4.4's routes and §5.2's
allow-list are absolute paths.

---

## 6. Headers, and the minimal CSP change

Two policies, chosen per response.

**`/api/snapshot` — unchanged:**

```
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
```

**A successful UI asset response:**

```
Content-Security-Policy: default-src 'none';
  script-src 'self'; style-src 'self'; img-src 'self';
  connect-src 'self'; manifest-src 'self'; worker-src 'self';
  base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Still `default-src 'none'`, with exactly **six `'self'` grants and three further
lock-downs**, and nothing more. In particular there is **no `'unsafe-inline'`**,
which binds the authored files: **no inline `<script>`, no `<style>` block and
no `style=` attribute anywhere in `index.html`.** All behaviour lives in
`app.js`, all presentation in `app.css`.

**Refusals keep the API policy.** The UI policy attaches to a *successful asset
response only*; every `400`, `404`, `421` and `500` keeps the slice-3 policy and
the slice-3 JSON body, whatever path it was asked for. That is one observable
sentence a test can hold, unlike an ordering claim no test can see.

**Present on every response, and staying present:** `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`. (The first draft listed these among the
*absent* headers — the exact opposite of the shipped code, and `nosniff` is the
header the new PNG and JavaScript content types most need.)

**Absent on every response, and staying absent:** any `Access-Control-Allow-*`,
any `Set-Cookie`, HSTS, `Referrer-Policy`.

`no-store` does not fight the service worker: `cache.put` is an explicit call
into Cache Storage and is not governed by HTTP cache directives.

---

## 7. Freshness

### 7.1 The clock is the client's

The UI's freshness is `lastSuccessfulFetchAt` — a clock the **page** keeps — and
never `snapshot.observedAt`, because `observedAt` is excluded from the revision
and an unchanged machine legitimately returns one revision forever. (Derived
*ages* are a different question and do use `observedAt`; see 3.1.)

Both of these prove the Manager was reachable, and both reset the clock:

| Response | Meaning | Freshness |
|---|---|---|
| `200` | a snapshot, possibly changed | reset |
| `304 Not Modified` | the caller's tag is still current | **reset** |

A `304` is a successful refresh. Treating only `200` as success would make an
idle, healthy machine drift into "stale" and then "offline" while the Manager
answered every request. `Cache-Control: no-store` on every response is what
makes this sound: no intermediary can satisfy a request without the Manager.

### 7.2 A refusal is not staleness

Any other status means the Manager answered but declined. That is a
configuration fault, surfaced as its own state naming the code — e.g.
`Manager refused the request — HOST_NOT_ALLOWED` — never allowed to look like a
slow network.

### 7.3 The conditional request echoes the ETag verbatim

**`If-None-Match` carries the `ETag` field value exactly as received on the last
`200` — the full `W/"…"` form — never the bare `snapshot.revision`.** The
contract compares opaque tag strings including their quotes, so a client sending
the bare hex is answered `200` forever and the whole `304` path is dead code.
This is pinned by a real round trip against the built CLI, not against a stub.

### 7.4 Polling and degradation

Poll every **10 s** while the document is visible; pause when hidden; refetch
immediately on becoming visible again.

| Age of last successful fetch | State | Shown as |
|---|---|---|
| < 20 s | live | `LIVE` |
| 20–60 s | stale | `STALE` + banner |
| > 60 s | offline | `OFFLINE`, data dimmed |

Data already on screen is **kept** through all three. It is never cleared and
never re-presented as current. **Every derived age freezes** at the last
successful fetch — a `REVIEWING · recorded 8 min ago` line must not keep
advancing on a screen that has already declared itself `OFFLINE`.

### 7.5 Colour is never the only signal

Every state carries a **word**: `LIVE`, `STALE`, `OFFLINE`, `NEEDS YOU`,
`CONFLICT`. A greyscale screenshot loses nothing.

---

## 8. The screen

Mobile-first at ~390 px. One served page; drill-down is **in-page state with
hash navigation** (`#/repo/<repositoryKey>`), so the server's route surface
stays the closed set in §4.4 while **history back** still works.

`app.js` reads `location.hash` **on load**, not only on `hashchange`, so a
relaunch or a deep link at `#/repo/<key>` renders the detail view. The detail
view carries **its own in-page back control**: an installed PWA runs in
`standalone` display and has no browser Back button.

### 8.1 Landing, with attention

```
AO MANAGER                         LIVE
Updated 7 s ago

NEEDS YOU · 1
┌──────────────────────────────────┐
│ ZERA · RESOLVER-V3-054           │
│ ESCALATED_DECISION_REQUIRED      │
│ Resolve the escalation, then …   │
└──────────────────────────────────┘

PROJECTS

ZERA
3 / 11 declared tasks done
1 conflict · 1 needs operator

Repository activity: confirmed
Likely active task
RESOLVER-V3-055
REVIEWING · recorded 8 min ago
Review 2 / 3
```

The attention card is drawn **from what a `needsOperator` entry actually
carries** — `reason` (one of `AGENT_LOGIN_REQUIRED`,
`QUOTA_CONTINUATION_REQUIRED`, `VERIFICATION_REMEDIATION_REQUIRED`,
`SCOPE_REVIEW_REQUIRED`, `DIVERGENCE_REVIEW_REQUIRED`,
`ESCALATED_DECISION_REQUIRED`) and `text`, which is the actionable half. The
first draft printed `HUMAN_DECISION_REQUIRED`, a task *state* that is not a
member of that vocabulary, and dropped `text` entirely.

The project name on the card comes from a join on `repositoryKey`; where the
join yields no name, §3.4's wording is used.

### 8.2 Nothing needs you

`NEEDS YOU` appears **only** when `needsOperator[]` is non-empty — with the
exception in 8.3. An empty attention list is not a permanent empty box teaching
the reader to ignore that region.

### 8.3 A failed reading must never render as calm

`notes[]` entries whose `repositoryKey` is `null` concern the **whole** reading
and have nowhere to sit in a per-project layout. Without a home, two failures
render as good news — the most dangerous outcome this UI can produce:

| Condition | Must **not** read as | Must read as |
|---|---|---|
| `REGISTRY_UNUSABLE`, empty `repositories[]` | "no projects" | `Repository registry could not be read` |
| an attention-store note, empty `needsOperator[]` | "nothing needs you" | `Attention store could not be read` |

So the landing screen carries a **snapshot-level notes region**, rendered
whenever any note has `repositoryKey === null`, above `PROJECTS`. Per-repository
notes appear in that repository's detail view.

### 8.4 Offline

```
OFFLINE
Last successful contact 4 min ago

Showing data from the last successful fetch.
Current AO state cannot be established.
```

### 8.5 Cold offline launch

§5.4: the shell opens, and there is no state to show.

### 8.6 Drill-down

One tap on a project opens its detail view: the full lease reading, runtime
record, verification evidence, delivery reading, and that repository's `notes[]`
entries. Everything the landing screen leaves out lives here.

---

## 9. How this gets tested, given there is no browser

This repository has **seven** dependencies, no DOM, no Cache Storage and no
service-worker globals — the only runner is vitest in the `node` environment.
The first draft assigned eight pins to "sw test" and "UI test" levels that have
no harness. **No dependency is added.** Instead:

- `sw.js` and `app.js` are loaded **as text from the build output** and
  evaluated in a `node:vm` context against hand-written fakes for `self`,
  `caches`, `addEventListener`, `fetch`, `Response` and document visibility. The
  captured `install` / `activate` / `fetch` handlers are then invoked directly.

This tests **the shipped bytes**, which is the same instinct as this
repository's dist-artefact gates, and it keeps every logic pin real. What it
cannot reach — whether a real browser registers the worker, whether `fetch()`
surfaces a `304` to JavaScript rather than resolving it from the HTTP cache — is
**not claimed**, and §7.3's round-trip pin is asserted against the built CLI at
the HTTP level where it *is* observable.

---

## 10. What gets pinned

| Pin | Level | Catches |
|---|---|---|
| every manifest route present in `build/`, and in a freshly **deployed** `dist/` | dist gate | the deploy path shipping no UI |
| every file in each artefact's `ui/` is named by the manifest | dist gate | a stray or orphaned asset |
| `dashboard serve` from a deployed `dist/` serves every manifest route | dist gate | a production-only breakage |
| a served icon is byte-identical to the file on disk | contract | a UTF-8 round trip corrupting PNGs |
| `/api/../app.js`, `//app.css` → `404`; `../app.css`, `..%5c…`, absolute-form → `400` | contract | any drift toward a real static-file server |
| a missing asset refuses startup and **opens no socket** | server | a partial serve |
| a successful asset carries the UI CSP; every refusal carries the API CSP and JSON body | contract | a loosened policy leaking to refusals |
| `no-store` and `nosniff` present on **every** response, asset responses included | contract | the header PNG/JS most need being dropped |
| `index.html` has no inline `<script>`, `<style>` or `style=` | source sweep | a file that only works under a loosened policy |
| shipped `sw.js` has a 64-hex `ao-shell-` name and **no placeholder token** | dist gate | a silent substitution failure freezing the cache name forever |
| that digest equals one recomputed over the six shell assets in the artefact | dist gate | a digest over the wrong bytes |
| the worker's allow-list equals the manifest routes minus `/sw.js` | contract | the derived list drifting from its authority |
| the worker never calls `respondWith` for `/api/snapshot` | vm test | a generic runtime cache |
| a worker request outside the six shell routes is not handled | vm test | wildcard drift |
| a failed asset add fails the install | vm test | a half-populated shell |
| a new digest evicts every older `ao-shell-` cache | vm test | two mixed shell versions |
| a `304` resets the freshness clock | vm test | an idle machine drifting to "offline" |
| a real round trip against the built CLI yields a `304` | dist gate | an `If-None-Match` value the server never matches |
| a non-`200`/`304` shows a refusal, not staleness | vm test | a config fault hidden as a network fault |
| `STALE` / `OFFLINE` become visible, data retained, derived ages frozen | vm test | a silent stale view, or an age advancing while offline |
| the UI renders and polls with **no** service worker registered | vm test | a hard dependency on a secure context |
| a `REGISTRY_UNUSABLE` note does not render as "no projects" | vm test | a failed reading rendering as calm |
| no write to Cache Storage / `localStorage` / IndexedDB of snapshot data | source sweep | a snapshot outliving the session |
| the vendor (`tailscale`/`ts.net`) and `localhost` sweeps read `.js`, `.html`, `.css` and `.webmanifest` under `src/`, not only `.ts` | source sweep | the new asset files being invisible to the existing sweeps |

### 10.1 Prose this slice makes false, and must rewrite

Serving a UI falsifies shipped operator-facing sentences, one of which is
pinned by literal substring. These are **changed copy with their own pins**, not
incidental edits:

| Location | Today | Must become |
|---|---|---|
| `src/cli/dashboard-command.ts:128` (`DASHBOARD_SERVE_DESCRIPTION`) | "answers one route", "There is no user interface" | the UI exists, N routes are answered, **still nothing authenticates** |
| `src/cli/dashboard-command.ts:121` (the doc comment above it) | "there is no user interface at this address yet" | the same correction — it is a second copy of the same sentence |
| `src/cli/index.ts:91` front page | "answers one route with what this machine can observe" | the same correction |
| `README.md:14543` slice-3 section | "One command, one address, one route, one method" | the same correction |

Three existing pins must be **rewritten, not deleted**:

- `tests/dashboard-07-serve-command.test.ts:197` — asserts the help text
  contains `'no user interface'`;
- `tests/dashboard-05-http-contract.test.ts:295` — lists `/` among the targets
  expected to answer `404`;
- `tests/dashboard-06-http-server.test.ts:566` — asserts `/` is `404`.

Deleting them would leave the new promise unpinned; leaving them would land the
slice red. Rewriting each to the new promise is the only correct move.

---

## 11. Explicitly not in this slice

No control of any kind — no pause, resume, retry, decision or merge. No
authentication and no session. No change to the bind address. No Tailscale or
proxy code in `src/`. No task title. No progress percentage and no state-rank
progress model. No change to the read model or the public view. No snapshot
persistence. No push notifications. No charts, no history, no time series.

---

## 12. Follow-ups this slice deliberately leaves open

1. **A real progress contract.** AO records what it is executing and how far
   through, so the UI stops inferring. Covers the task-attribution gap (§3.2),
   the absent progress value (§3.1) and the missing task title (§3.5).
2. **Authentication**, if the access layer in front ever stops being the whole
   answer.
3. **Shell update determinism** — if "eventually" in §5.3 proves too weak, an
   explicit in-page "a new version is ready, reload" prompt.
4. **A real browser gate.** §9's `node:vm` harness cannot observe registration
   or `fetch()`'s treatment of a `304`. If those ever need pinning, that is a
   dependency decision of its own.
