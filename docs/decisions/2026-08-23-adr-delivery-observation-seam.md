# ADR — The delivery observation seam (V4 slice 2)

- Date: 2026-08-23
- Status: **Accepted.** Implemented as V4 slice 2.
- Extends `2026-08-23-adr-autonomous-delivery-m1.md`. Discharges the part of
  invariants 1–6 that observation can discharge, and no more.

## Context

Slice 1 made the delivery target *nameable*: a profile declares
`delivery.remote`, and AO turns that remote's push URL into a
`{ host, owner, name }` identity. It contacts nothing.

This slice makes that identity *askable*. For one repository identity and one
exact commit object name it answers two independent questions, read-only:

1. is there exactly one **open** pull request whose current head object name is
   exactly this commit?
2. what is the check state attached to exactly this commit?

It answers neither "may this be merged" nor anything that could be read as it.

## The forge, egress and credential contract

### A. Supported forge

**GitHub only. One host: `github.com`.** The list is a constant in code
(`SUPPORTED_FORGE_HOSTS`), not configuration, and an unsupported host is refused
before a process is started.

This is the decision on slice 1's residual `L-V4-01-2` ("the host is carried,
not judged"). It is judged now, and judged narrowly. The reasoning is the
existing egress precedent rather than a preference: the ntfy notification is
enabled by a file under the operator's own profile directory and can never be
switched on by repository content. A delivery target, by contrast, is parsed out
of a repository's own Git configuration. If that parsed host chose the
destination, a checked-out repository could point AO's authenticated client at a
host of its choosing. So the host is used as a *predicate* and never as a
*destination*: the request carries `--hostname github.com`, written in this
build.

No GitLab or Bitbucket abstraction was built. There is one forge, and the code
says so.

### B. Transport: the GitHub CLI, over REST

`gh` 2.97.0, spawned through the existing owned-process boundary
(`doctor/exec.ts` → `boundary/owned-command.ts`, Windows Job Object, byte
budget, timeout, `shell: false`, `SAFE_ARG_PATTERN`).

**Why a CLI rather than an HTTP client:** `gh` owns the credential, so AO does
not. An HTTP client here would mean this build reading a token, holding it in a
TypeScript value and putting it in a header. That is the one material every
other part of this repository is built never to touch, and avoiding a small
dependency is not worth acquiring it.

**Why REST rather than GraphQL**, stated accurately because the obvious argument
is wrong: a GraphQL document cannot be an *argument* — `SAFE_ARG_PATTERN` refuses
braces and spaces — but it **is** reachable, via `gh api graphql -F query=@-` on
the stdin channel this build already uses for agent prompts. That was measured
working. The grammar narrows the shape; it does not decide the question.

The deciding property is how each fails. A GraphQL response can be HTTP 200
carrying `data` **and** `errors` — measured, with an over-paginated rollup
returning `{"data":{…"statusCheckRollup":null},"errors":[…]}`. A reader taking
`data` at face value would read that as "this commit has no checks": a fail-open
on the *successful* path. A REST non-2xx is a non-zero exit and no body this
build parses.

GraphQL's one real advantage — `GitObjectID!` refuses anything but a full 40-hex
object name, where REST's `{ref}` accepts an abbreviation or a branch name — is
not given up. It is moved into this build, where it can be mutation-tested.

### C. Credentials

- **Who authenticates:** the operator, previously, with `gh auth login`.
- **Where credentials live:** the client's own config directory under `APPDATA`.
- **Does AO ever receive credential bytes:** no. No token is passed in, none is
  read out, `gh auth token` is never called, and no result type here has a field
  that could carry one. `stderr` is never read, parsed, rendered or logged.
- **Which environment overrides are admitted:** none. The policy
  `forge:github` supplies `PATH`, `PATHEXT`, `APPDATA` and nothing else. On
  Windows the child additionally receives the eleven names `runCommand`
  back-fills — `SYSTEMROOT`, `USERPROFILE`, `TEMP` and eight more — and none of
  those can carry a credential, choose a host, move a config directory or name a
  proxy. Checked as disjointness from the client's own documented override
  list, with the limits of that check carried as `L-V4-02-9`.
- **Which are refused:** everything else, by construction rather than by
  filtering — including `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`,
  `GITHUB_ENTERPRISE_TOKEN`, `GH_HOST`, `GH_REPO`, `GH_CONFIG_DIR`,
  `XDG_CONFIG_HOME`, `GH_DEBUG`, `GH_PAGER`, and the proxy variables.
- **May credentials come from repository-controlled state:** no. Nothing in a
  repository reaches the client's environment, its host, or its config location.
- **What "not authenticated" means:** a closed refusal, `NOT_AUTHENTICATED`,
  from the client's documented exit code 4. It is never read as "no pull
  request" and never as success.

### D. Network egress

`agent-loop run` gained nothing and contacts nothing. Egress lives on a new
command, behind an explicit flag:

```
agent-loop delivery --repository <path> --task <id> [--observe]
```

Without `--observe` there is no branch on which a client is constructed.

## The observation contract

**Subject:** `{ host, owner, name }` + one exact commit object name, 40
lowercase hex digits. Never a branch, never a remembered pull-request number.

**Pull-request vocabulary:** `MATCHED` (carries the number, and only here),
`NO_MATCHING_PULL_REQUEST`, `AMBIGUOUS` (carries every claimant), plus the
shared refusals.

**Check vocabulary:** `SUCCESS`, `PENDING`, `FAILED`, `NO_CHECKS`, plus the
shared refusals.

**Shared refusals:** `UNSUPPORTED_HOST`, `SUBJECT_UNUSABLE`,
`FORGE_CLIENT_ABSENT`, `ENVIRONMENT_UNUSABLE`, `FORGE_CLIENT_UNUSABLE`,
`NOT_AUTHENTICATED`, `REQUEST_FAILED`, `RESPONSE_MALFORMED`, `SUBJECT_MISMATCH`,
`RESULTS_TRUNCATED`.

### The measurements that shaped it

All against `github.com` on 2026-08-23, `gh` 2.97.0, `git 2.55.0.windows.3`.

| Measured | Consequence |
| --- | --- |
| `GET /repos/{o}/{r}/commits/46629f0…/pulls` returns pull request 55 whose `head.sha` is `10583ee…` — a **different** commit. The endpoint matches "the commit is in this pull request". | The endpoint is a **locator**. Every candidate is re-tested against its own reported head, and only an exact match counts. Without that test, an old commit's identity authorises a new head. |
| The same is true of GraphQL `associatedPullRequests`, and of the search API. **No GitHub API filters by exact head object name.** | The equality test is necessarily client-side. There is no server-side alternative to fall back to. |
| `GET /commits/{sha}/status` answers `{"state":"pending","total_count":0,"statuses":[]}` for a commit with no legacy statuses. Documented: *"pending if there are no statuses or a context is pending"*. | The summary word is never read. Only the `statuses` records are. Reading `state` would make every GitHub-Actions-only repository permanently pending. |
| `GET /commits/{sha}/check-runs` says nothing about legacy status contexts. | Both mechanisms are read. Either can gate a merge, and a build that read one would report a subset as the whole. |
| `GET /commits/{sha}/status` answers **HTTP 200 `pending`** for a commit that is **not in the repository**, echoing the requested sha back. `check-runs` and `pulls` answer 422. | Check runs are asked for **first**. A commit that does not exist is refused before the endpoint that would have invented a `PENDING` is reached. The order is a guard. |
| REST `{ref}` accepts an abbreviated object name and a branch name: `commits/10583ee/check-runs` and `commits/main/check-runs` both answer 200. | The 40-hex grammar is enforced in this build before a path is built. Nothing on the far side will insist the subject is an object name. |
| `gh api` documents its default method as "GET normally and **POST if any parameters were added**", and every request here adds `per_page`. | `-X GET` is in the vector. Its removal turns a read-only observation into a POST. |
| Every check run carries `head_sha`; the combined status carries a top-level `sha`. | The evidence is bound to the question, not only the request: an answer naming another commit is `SUBJECT_MISMATCH`. |
| On both **check** endpoints `total_count` is the ref-wide total, not the page length. The **locator** endpoint returns a bare array and carries no total at all. | Truncation is provable in one round trip for the check endpoints: a disagreement is `RESULTS_TRUNCATED`, never a smaller answer. For the locator there is nothing to compare, so the test is that the page came back full — a conservative heuristic, and a commit contained in exactly a page's worth of open pull requests is reported truncated rather than answered. Carried as `L-V4-02-8`. |
| A non-2xx still writes GitHub's error document to **stdout**, and exits 1. | The exit code is judged before the body is parsed. |
| Exit 4 is documented as "a command requires authentication" and is reachable. | `NOT_AUTHENTICATED` is a distinct refusal, not folded into failure. |
| `env -i PATH … PATHEXT …` → exit 4, unauthenticated. Adding `APPDATA` → exit 0. Adding `USERPROFILE` or `LOCALAPPDATA` instead → still exit 4. | The policy allow-list is exactly `PATH`, `PATHEXT`, `APPDATA` — the smallest measured set, not the variables a credential might live under. |
| **The row above measures a shell environment, not the shipped one.** On Windows `runCommand` back-fills eleven OS names — `SYSTEMROOT`, `USERPROFILE`, `TEMP` among them — into every child, so the client always receives them. Re-measured against the shipped path: `PATH + PATHEXT + APPDATA + SYSTEMROOT` → exit 0, the full back-filled shape → exit 0, and a real `agent-loop delivery --observe` returned a graded check state for a real commit. | A policy names what AO **supplies**, never what the child receives. An earlier version of this ADR read one as the other and recorded `SystemRoot` as load-bearing for connectivity; it is not, and the claim is withdrawn. What replaces it is checkable rather than rhetorical: none of the eleven back-filled names is one of the client's own documented override variables, pinned in `tests/v4-02-…` as disjointness from `FORGE_CLIENT_OVERRIDE_ENV_VARS`. That is a bounded check — the two lists come from different families, so it cannot see an influence route the client does not document — and its limits are carried as `L-V4-02-9` rather than presented as a proof. |
| `HTTPS_PROXY` redirects every request and `NO_PROXY` undoes it. **Neither appears in `gh help environment`.** | The refused-variable list was built from measurement as well as from the client's own documentation. AO does not forward proxy configuration, so behind a proxy the observation refuses rather than succeeding. |
| Given only the names this policy supplies, the client writes `.local/state/gh/device-id` **relative to its working directory** — it has no `HOME`/`XDG_STATE_HOME` to use. Re-measured with `USERPROFILE` present — which the back-fill always supplies — it wrote **nothing** there. | The client is run in the OS temp directory, never in a repository. The dirtied checkout is a property of the policy block alone and is **not** reproduced by the shipped Windows path, so this is defence in depth rather than the fix for a live defect. It stays on three grounds: it costs nothing, it is still right if that back-fill ever narrows, and it independently removes the last path by which a checkout could influence the request. |

## What `SUCCESS` means, exactly

Every check run and every legacy commit status attached to this commit has
finished, and none of them blocks. `success`, `neutral` and `skipped` are
defined here as non-blocking; the counts are rendered separately so that
definition is visible rather than hidden inside one word.

**It is not a claim that no further record will appear.** GitHub has a third
concept — the check *suite* — and a suite that has registered but produced no
check run is invisible to both mechanisms read here. Measured on this
repository's own commit `10583ee…`: `check-suites` reported three suites, two of
them `queued` with `conclusion: null` and zero runs, while `check-runs` reported
two successes and GitHub's own `statusCheckRollup` reported `SUCCESS`. Those two
suites have sat that way across every commit measured, so treating a runless
queued suite as `PENDING` would leave this repository permanently pending.
Carried as `L-V4-02-1`.

## Non-goals, held

No pull-request creation, update, review, comment or merge. No auto-merge. No
merge-eligibility policy, no risk classification, no post-merge verification. No
durable pull-request identity and no durable forge evidence — nothing is
written. No task state and no transition: `READY_FOR_PR: []` is unchanged. No
remediation loop driven by CI. No GitLab or Bitbucket abstraction.

## Invariants, restated against M1

| # | Invariant | Status |
| --- | --- | --- |
| 1 | A green check for an old head never authorises the current head | `[held]` — evidence binds to a commit object name in both directions: the request names it, and every record is re-checked to name it back. Stated exactly, because an empty set has no record to do it with: the check-runs response carries no subject of its own, so a page of *zero* runs binds nothing on its own — the combined-status response, which is always also required, names its subject at the top level and binds the pair in every case including `NO_CHECKS` |
| 2 | "A pull request exists" is not "mergeable" | `[held]` — no mergeability concept exists here |
| 3 | "Mergeable" is not "CI passed" | `[held]` — the two answers are separate values and nothing combines them |
| 4 | "CI passed" is not "review requirements passed" | `[held]` — no review state is read, and none is implied |
| 5 | A moved head invalidates evidence attached to the previous head | `[held]` — a moved head produces `NO_MATCHING_PULL_REQUEST`, measured live |
| 6 | Ambiguous or unavailable forge state fails closed | `[held]` — ten closed refusals, none of which carries a payload |
| 7 | A merge observes the exact resulting commit | `[open]` — nothing merges |
| 8 | A successful merge API call is not completion | `[open]` |
| 9 | Delivery authority is separate from execution authority | `[held]` — observing needs no lease and grants nothing |
| 10 | No repository gains delivery because AO can perform it | `[held]` — and the misdeclared-target residual `L-V4-01-5` is narrowed: a mistyped remote now surfaces on this surface too, as `DELIVERY_TARGET_UNRESOLVED` |
| 11 | Existing execution guarantees do not widen | `[held]` — no gate changed; one environment policy was added and one app-data assertion narrowed, both with the exception named |
| 12 | Delivery state survives restart where called durable | `[held]` — nothing is called durable, because nothing is written |

## Residuals

- `L-V4-02-1` — a registered check suite with no check runs is invisible;
  `SUCCESS` is about the records that exist.
- `L-V4-02-2` — `REQUEST_FAILED` does not distinguish "no such repository",
  "not visible to this login" and "the network failed". Measured: all three exit
  1, and only `stderr` distinguishes them, which is not read.
- `L-V4-02-3` — proxy configuration is not forwarded, so behind a proxy the
  observation refuses.
- `L-V4-02-4` — POSIX is not supported for this capability. The policy carries
  `APPDATA`, which is a Windows path; elsewhere the client reports that it needs
  an authentication and the observation refuses. Consistent with the
  Windows/NTFS-first platform contract.
- `L-V4-02-5` — `filter=latest` is sent explicitly, and whether `total_count`
  under that filter counts filtered or unfiltered runs was not measured. If it
  is unfiltered, a repository with a re-run check reports `RESULTS_TRUNCATED`
  rather than an answer. That is the fail-closed direction, and it is untested.
- `L-V4-02-6` — the client makes network calls of its own beyond the request:
  telemetry is on by default and carries a per-machine device id, and an update
  check runs once every 24 hours. Neither is suppressed, because suppressing
  them would mean inventing environment values rather than forwarding measured
  ones.
- `L-V4-02-7` — whether two open pull requests can share a head commit was not
  established; the mechanism reports all of them either way, and `AMBIGUOUS`
  exists for the case.
- `L-V4-02-9` — the platform back-fill is checked only for disjointness from the
  client's own documented override variables. That cannot see an influence route
  the client does not document. Two names are worth naming: `PATH`, which is in
  both this policy and the back-fill and does decide which `gh` runs (supplied
  deliberately; executable provenance is settled by AO-FOUNDATION-REM-003B), and
  `HOMEDRIVE`/`HOMEPATH`, which compose into a home directory a config-directory
  fallback could in principle consult. Measured only to the extent that
  `USERPROFILE` alone does not authenticate the client.
- `L-V4-02-8` — the locator endpoint returns a bare array with no `total_count`,
  so truncation there is detected by the page coming back full rather than
  proved. A commit contained in exactly `OBSERVATION_PAGE_SIZE` open pull
  requests is reported `RESULTS_TRUNCATED` rather than answered. Fail-closed,
  and not reachable on any repository this build has been used on.

## The next slice, named only

**Durable delivery evidence.** Nothing here is written down, so every answer is
re-derived and no later slice can say "this is the pull request we observed at
this head". That is the piece a merge decision would need, and it needs its own
decision about what may be pinned, for how long, and what invalidates it. It is
not started.
