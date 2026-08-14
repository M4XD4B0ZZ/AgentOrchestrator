# V2-10 — Operator notification: being told the run needs you

**Status:** design, not yet planned into tasks.
**Predecessors:** V2-08 (attended block runner). Depends on its *result*, nothing else.
**Independent of:** V2-09 (dependent commit chain). May ship before it, after it, or never.

## Why this is its own slice

A block run takes as long as its tasks take. An operator who started one and is
sitting in front of a terminal that prints nothing for forty minutes learns the
outcome by going back and looking. That is the whole problem, and it is a small
one.

What makes it a slice rather than a corner of V2-08 is what solving it costs:

> **This product makes no outbound network request today.** Not one. Its effects
> are Git, the filesystem, and subprocesses it starts itself. Its dependencies
> are `commander`, `yaml` and `zod`.

Sending a push notification adds the first egress surface the orchestrator has
ever had. That is the decision this slice is about. The message format is the
easy part.

It is *not* an extension of V2-08, and needs no change to it:
`AttendedBlockResult` already carries `outcome`, `stopReason`, `detail`, `runId`,
`blockId`, `tasks[]` and `steps`. The event this slice sends **is** that value.
A notifier built on top of it couples to nothing.

## 1. The rule everything else follows from

> **The notification is never a gate.**

It runs after the run's result is final. It changes no outcome, no exit code and
no ledger byte. An unreachable server, an expired token, a DNS failure and a
five-second timeout all produce exactly one effect: a line in the report saying
the notification did not go out.

The inversion — a run whose outcome depends on whether a phone could be reached
— would make an external host part of this repository's correctness argument.
Nothing about a block run is improved by knowing that a message was delivered.

Two consequences, both structural rather than advisory:

- **It runs after the lease is released.** `block-command.ts` releases in a
  `finally`; the notification happens after that block, so a slow or hanging
  POST cannot extend the window in which this invocation is the repository's
  writer. A notifier inside the leased scope would make an external host able to
  lengthen an exclusive claim.
- **It has a hard deadline and no unbounded retry.** `AbortSignal.timeout`, a
  small budget, then give up and say so. A CLI that will not exit because a push
  service is slow has made the notification a gate through the back door.

## 2. What may cross the wire, and what may not

The message is assembled from **closed vocabularies and validated identifiers
only**. Nothing is interpolated from anything a human or an agent wrote.

| Permitted | Because |
| --- | --- |
| `repositoryId` | the profile's declared identity, 1–64 chars, already a validated field |
| `blockId`, `runId`, `taskId` | the canonical id grammar: no whitespace, no separator, no shell metacharacter, no path |
| `outcome`, `stopReason`, `disposition` | closed enums, every member written in this repository |
| `detail` | an allow-listed code from another module's closed set — an errno, a save code, a gate token |
| a timestamp | supplied by the caller's clock, ISO-8601 |

| Refused | Because |
| --- | --- |
| paths, branch names, worktree locations | AO-002: these routinely appear in exception text and say where a machine keeps things |
| agent output, review findings, verify logs | untrusted text, unbounded size |
| task titles and task prose | a repository's own words, which nothing here validates |
| exception messages | the reason `formatSafeError` exists |
| the token, in any form | including as a "redacted" echo |

This is the same rule `task-graph.ts` already states about its failure details —
*"Nothing is interpolated — not a task id, not a title, not a path"* — applied to
a channel that leaves the machine. Here it is stricter for an obvious reason: a
line printed on the operator's own terminal stays there, and a push notification
sits in a third party's queue and on a lock screen.

A worked message, and it is deliberately dull:

```
AgentOrchestrator — attention

repository : cargocheck
block      : CARGO-PLATFORM   run br-0007
outcome    : BLOCK_RUN_ENDED
reason     : LEDGER_DIVERGED
tasks      : 1 SETTLED · 1 ACTIVE · 1 PLANNED
at         : 2026-08-14T22:14:03Z
```

Note what an operator can and cannot conclude from it. They know *which* run
needs them and *what class* of thing happened, which is enough to decide whether
to walk back to the machine now or after dinner. They cannot debug from it, and
it does not try to let them.

## 3. Configuration lives in the environment, never in the profile

The repository profile is checked in and its schema is `.strict()` with eight
sections. Putting a channel there would be wrong twice over:

1. **A topic name is a secret.** Without access control, anyone who knows an
   ntfy topic can read it and publish to it. A secret in a profile is a secret in
   Git history.
2. **A profile travels with the repository.** Every clone and every fork would
   inherit the endpoint, so somebody else's runs would notify the original
   owner's phone — and the original owner's runs would be readable by anyone who
   cloned.

So the channel is configured **per machine, in the environment**, and this slice
changes the profile schema not at all — no new section, no `schemaVersion` bump,
no migration:

```
AGENT_ORCHESTRATOR_NOTIFY_URL     the full topic URL, e.g. https://ntfy.sh/<unguessable>
AGENT_ORCHESTRATOR_NOTIFY_TOKEN   optional bearer token, when the topic is access-controlled
```

Absent or empty → notification is off, silently and by default. Off is not a
degraded mode; it is what this build does unless a human on this machine asked
otherwise.

The token inherits `env-guard.ts`'s discipline rather than its mechanism: read
once, never logged, never serialised, never copied into an error, and never
handed to a child process. `env-guard` governs the environment *supplied to
children*, and this value is read by the orchestrator itself — so the two do not
overlap, and the notifier must not become a reason to widen any probe policy.

`doctor` gains one read-only check: configured / not configured. It reports the
*presence* of a URL and never its value.

## 4. Provider-neutral, but only one provider

```
AttendedBlockResult
        │
        ▼
  RunAttentionEvent        pure; no network, no clock, no environment
        │
        ▼
  NotificationPort         one method; returns a delivery report, never throws
        │
        ├── NtfyNotifier   ships
        └── (nothing else)
```

The port exists because the event is worth having as a value on its own: it is
what a test asserts against, what a future channel would consume, and what keeps
the HTTP effect from reaching into the block layer's vocabulary.

**Exactly one implementation ships.** A second one written now would be an
interface designed against one real consumer and one imagined one, which is how
an abstraction acquires the shape of neither. Email, Pushover, Slack and a
webhook are all reachable from the same port later; none of them is built here,
and the port is not "designed for" them.

## 5. What this slice does not do

- **It does not make unattended running possible, and must not be described as
  though it did.** `--attended` states that a human authorised *this invocation*.
  A notification does not extend what runs without a human: the run still stops
  on every condition it stops on today, and nothing continues while the operator
  is away. What it shortens is the gap between a stop and the operator learning
  about it — see the open question below, because that sentence is doing real
  work and deserves a decision rather than an assumption.
- **No incoming channel.** Nothing is ever read back from the notification
  service. A phone cannot answer, approve, resume or stop anything. An inbound
  path would be a remote control for a tool whose entire execution authority
  rests on a local lease and a local operator grant.
- **No per-task notifications.** One message per invocation, at the end. A
  task-local failure does not end the run — that is V2-08's whole point — so an
  early ping would say "something is wrong" about a run that is still doing
  exactly what it should, and an operator cannot act on it anyway while the
  invocation holds the lease. Three pings per block is how a notification
  becomes something people swipe away.
- **No delivery guarantee, and no queue.** Nothing is stored, nothing is retried
  after the process exits, and a missed notification is not recoverable. The
  ledger remains the durable record; the push is a courtesy on top of it.
- **No new dependency.** Node 22 and 24 both have a global `fetch`. The V2
  platform contract is a whitelist of exactly those two majors, so this is a
  fact about the supported runtime rather than a bet.

## 6. The case that justifies the feature

`DURABLE_WRITE_FAILED`.

When the disk or a permission refuses a write, the ledger cannot record the
condition — that is the whole reason it is a runner outcome and not a stop
reason. A log file cannot be written either, for the same reason. The report on
stdout reaches whoever is looking at the terminal, and nobody is.

The notification is the only channel that still works, and it is the case where
an operator most needs to be told. That, rather than convenience, is the
argument for shipping this at all.

## 7. Controls

1. **A failed send changes nothing** — drive a run to `COMPLETE` against a
   server that refuses the connection, and assert the exit code, the persisted
   ledger bytes and the run result are identical to the same run with
   notification off. Asserting "the run still passed" is weaker: it passes
   against an implementation that swallowed a different failure too.
2. **A hanging server does not hang the CLI** — a local server that accepts and
   never answers; the invocation still exits, within the deadline, reporting the
   timeout.
3. **The message carries no forbidden material** — drive a run in a repository
   whose task titles, branch names and paths contain distinctive markers, and
   assert none of them appears in the request body. Driven against a *real* local
   HTTP server, so the body asserted on is the body that was actually sent.
4. **The token is never in the message** — same case, asserting the configured
   token appears in the `Authorization` header and nowhere in the body, and in no
   line of the CLI report.
5. **Off by default** — with neither variable set, no request is attempted at
   all. Measured by a local server that records connections, not by reading a
   flag.
6. **The notification happens after the lease is released** — a server that
   blocks until told to answer, and a second acquire attempted while it blocks,
   which must succeed. This is the control that fails against a notifier placed
   inside the leased scope.
7. **Every terminal result maps to a priority** — a total table over
   `BlockRunOutcome` and `BlockStopReason`, pinned by a hand-written correctness
   test rather than derived from the production map. `satisfies Record<…>` proves
   every member was considered and nothing about whether each landed on the right
   side.

Controls 1, 2 and 6 are the ones that fail against a plausible-looking wrong
implementation. The rest are hygiene.

## 8. Decisions to take before planning

| # | question | recommendation |
| --- | --- | --- |
| 1 | Does shipping this change what `--attended` **means**? | **Yes, and it should be said.** Today the flag's documentation says a human is *present for this invocation*. A tool that pings a phone is a tool that expects the human to be reachable rather than watching. Either the wording becomes "authorised this invocation and is reachable", or the feature quietly makes an existing claim false. This is a product-contract edit, not a doc tidy-up. |
| 2 | Does a refusal *before* the ledger exists notify? | **No.** A gate refusal — bad arguments, a taken run id, a failed auth preflight — happens in the first seconds while the operator is still at the keyboard. Notifying there is noise that trains an operator to ignore the channel. Notify only once a run was actually started. |
| 3 | How many delivery attempts? | **Two, inside one total budget of about ten seconds.** One attempt loses a message to a single dropped packet; a retry loop makes a push service able to delay a CLI exit. |
| 4 | Does `COMPLETE` notify, or only the endings that need action? | **Both, at different priorities.** "It finished" is exactly what somebody who walked away wants, and suppressing it would make silence ambiguous between success and a broken notifier. |
| 5 | ntfy, or Pushover? | **ntfy first.** One HTTP POST, no account, no cost, and the topic-as-secret weakness is closed by an access token, which the design already carries. Pushover is equally simple and adds a vendor and a per-platform purchase for no property this slice needs. Both sit behind the same port. |

Question 1 is the one that must be answered before anything is planned. The
others change the shape of a task; that one changes what the tool claims about
itself.

## 9. What "done" means

- an attended block run that ends for any reason produces exactly one push, and
  the operator can tell from it which run needs them and what class of condition
  it met;
- with no configuration present, the build makes no outbound request at all;
- an unreachable, slow or hostile notification server changes no exit code, no
  ledger byte and no lease timing;
- nothing that leaves the machine came from a path, an agent, or a repository's
  prose;
- `npm run verify` green, and CI green on Windows for both supported Node majors.
