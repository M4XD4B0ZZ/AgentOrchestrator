# Repository governance

Instructions for agents working in this repository. This file governs **how
work is delivered here** — branching, verification and merging. It says nothing
about what the orchestrator product does; that is `README.md`.

## Delivery policy

```
mergePolicy: PR_REQUIRED
ciPolicy:    CI_REQUIRED
```

**`CI_REQUIRED` is explicit and deliberate.** This repository's canonical gate,
`npm run verify`, includes real-process and dist-artefact checks that a reviewer
cannot reproduce by reading a diff. A change that has not passed that gate on a
clean machine is unverified, whatever it looks like. So a pull request here must
carry at least one real check, and a pull request showing **zero** checks is a
defect in the delivery setup — a mis-scoped trigger, a workflow missing from the
branch — not permission to merge.

`CI_REQUIRED` is a statement about *this* repository. It is not a default for
other repositories, and nothing here should be generalised into one: a project
whose CI is genuinely optional is entitled to say so, and blocking it on absent
checks would be wrong.

## What "merge" means here

When you are asked to "merge" in ordinary conversation, without further
qualification, it means **the pull-request delivery flow**:

1. the changes must sit on a feature branch — never commit directly to `main`;
2. push the branch to `origin`;
3. open a pull request against `main`, or reuse the existing one;
4. wait for CI;
5. merge **only** on a successful CI result;
6. afterwards update local `main` and confirm the post-merge state.

It does **not** mean:

```
git checkout main
git merge <branch>
git push
```

That direct, local path is reserved for an explicit instruction that
unmistakably asks for it — "lokal mergen", "direkt nach main mergen", "merge
locally without a PR", or an equally unambiguous equivalent. Ambiguity resolves
to the pull-request flow, because that is the reversible one: an unmerged PR
costs a round trip, while an unverified commit on `main` is already delivered.

### Check states are distinguished, and zero checks is not success

The merge gate must classify a pull request's checks into exactly one of four
states, and only one of them permits merging:

| State | Meaning | Action |
| --- | --- | --- |
| `NO_CHECKS` | the PR has no checks at all | **stop** — `MERGE_BLOCKED_NO_CHECKS` |
| `PENDING` | at least one relevant check is still running | wait |
| `FAILED` | at least one check failed, was cancelled, timed out, or ended in any other non-successful state | **stop** — `MERGE_BLOCKED_CHECKS_FAILED` |
| `SUCCESS` | checks exist and every relevant one passed | merge may proceed |

**Zero checks is never `SUCCESS`.** Under `CI_REQUIRED` the absence of checks is
a blocking condition in its own right, distinct from failure and reported as
such, so that "CI is broken" is never silently delivered as "CI is fine".

This classification is a property of the merge gate, not of a single exit code.
The installed `gh` CLI exposes it structurally — `gh pr checks --json
name,bucket,state` categorises each check into `pass` / `fail` / `pending` /
`skipping` / `cancel`, and `gh pr view --json statusCheckRollup` answers the
zero-checks question without erroring — so the state is read from that data
rather than inferred from one process exit status.

## `/merge` and model invocation

The `/merge` slash command lives in the **user scope**
(`~/.claude/commands/merge.md`) and carries `disable-model-invocation: true`.
That property stays as it is. The consequences are:

- `/merge` runs only when the **user** types it. An agent cannot invoke it, and
  must not claim to have invoked it.
- When the user asks for a merge in conversation instead, the agent may carry
  out the same canonical steps **manually**, under the policy above. That is
  performing the contract, not running the command, and it should be described
  that way.

## CI is development infrastructure, not product semantics

The GitHub Actions workflow in `.github/workflows/` verifies *this repository's
own source*. It is not part of the orchestrator's product contract and does not
extend it:

- `READY_FOR_PR` remains a **terminal** state (`src/core/states.ts`,
  `src/core/transitions.ts`). The orchestrator hands a finished task to a human
  and stops there;
- opening pull requests, reading CI results and merging remain **outside v1** of
  the orchestrator runtime. Nothing in `src/` gained a CI, PR or merge concept
  by adding a workflow to this repository.

A change that would blur that boundary — teaching the product to merge, or
giving `READY_FOR_PR` an outgoing transition — is a product-contract change and
needs its own decision, not a delivery-infrastructure commit.
