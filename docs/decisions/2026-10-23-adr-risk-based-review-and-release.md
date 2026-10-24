# ADR 2026-10-23: risk-based review and release for the Zera deliveries

- **Status:** proposed. It is accepted with the merge of its pull request. **Accepting it activates
  nothing.** The rules act only from the operator's activation (step M3 below). That activation is a
  separate act in the operator's own words, and it needs the activation gate of this record first.
- **Merging this record while gates are open.** This record may be merged as a documentation
  change while the technical activation gates (T1 to T4) are open. That does not mean that the
  rules are active, that unattended AO work is allowed, that an automatic merge is allowed, that
  #359 or #360 is released, or that a security gate is met. A supervised pilot stays a separate,
  later decision of the operator.
- **Operator decisions of 2026-10-23.** E1 = 1: the governance rule texts are the basis for the
  further work — "noch keine Aktivierung der Governance und keine pauschale Freigabe aller
  vorgeschlagenen Regeltexte". E2 = 1: the rules are prepared only for a bounded pilot of PR #359,
  PR #360 and one third pull request that the operator names later. No release exists for the third
  one, and no other pull request or task is covered.
- **Operator decisions of 2026-10-24.** B = 1: a LOW change also needs an independent AI review of
  its diff, which may be short, in proportion to the risk. G4 = A: the technical protections of the
  activation gate must be shown to work before any activation; a check after the fact alone is not
  enough. Neither decision activates anything.
- **Roadmap:** section 5, boundaries 2 and 7 (an amendment that waits for the activation); section
  14, decision D8.
- **Not changed by this record:** any code in `src/`; `READY_FOR_PR` stays terminal; `/merge`; the
  supervisor, its scheduled task and its merge list; `delivery-automation.yaml`; decisions D1, D3,
  D4 and D5; this repository's own delivery policy (`CLAUDE.md`: `PR_REQUIRED`, `CI_REQUIRED`). No
  queue, label or workflow is switched on or off.

## Context

Boundary 7 says a task is not delivery-ready "without a review by Codex or by a person". Since
2026-10-02, attended Zera work runs without Codex unless the operator orders it. On 2026-10-21 the
operator decided to act as Product Owner, and not as a technical code reviewer. With both rules in
force, no attended delivery can meet boundary 7. Appendix A.5 already lets "an attended Claude
session on the operator's order" review, so the two texts also disagree with each other.

The operator and the agents use the same GitHub account, `M4XD4B0ZZ`. A comment, an approval or a
label from it does not show that a person acted.

The drafts of 2026-10-21 (revision 1 with the conflicts K1 to K13, and revision 2) and the decision
package of 2026-10-23 are the provenance. They are kept outside this repository. The HealthApp side
of the rules (its `AGENTS.md` section "Risk-Based Review and Release (Binding)") is step M2, a pull
request of its own.

## Decision

1. **Classes by the risk that is real.** Engineering classifies a change by the guarantee its code
   gives, not by file type. If a change touches several classes, the highest applies. The writer
   proposes the class, and the independent reviewer confirms or raises it. Only a new independent
   review with a written reason lowers it. The operator never lowers a class.

   | Class | What it covers | Independent technical review | Operator |
   | --- | --- | --- | --- |
   | LOW | documentation without normative effect; tests that are only added | one fresh agent; a short review of the diff, in proportion to the risk | product, risks and merge, per pull request and head |
   | MEDIUM | features, search logic, UI, non-critical logic | one fresh agent | as LOW |
   | HIGH | persistence, data loss, migration, backup and recovery, privacy, permissions, secrets, dependencies, workflows | two; one adversarial; from another provider when one is available, otherwise a recorded fallback | as LOW, and an explicit decision on each named risk; attended only; never a standing permission |
   | HIGH contract | a documentation-only pull request that defines a HIGH task | one contract review on six points | as LOW; merging it never starts the implementation |
   | G | governance, gates, grants, the supervisor, merge automation | at least one fresh agent, more where the target repository requires it; here an ADR first | always explicit; never released under the rules it introduces |

2. **Independent reviewer (boundary 7).** The writer never reviews its own change. A task is not
   delivery-ready without an independent review: by Codex, by a person, or by a fresh agent with its
   own context. Every class needs one; the class sets how deep it goes, and HIGH needs a second
   one. A fork of the writer's session, and the session that wrote, repaired or fixed the change,
   are not independent. An agent's review may do the technical check. It is never reported as a
   person's review. A Codex review stays one-shot (boundary 6).
3. **Separate gates.** Automated checks, the technical review, the product decision, the risk
   acceptance and the merge authorization are five separate gates; the merge execution is a sixth
   act, with no decision in it. None replaces another. If one is missing, there is no merge.
4. **One exact head.** Every check, review and release names the head commit (40 characters). A new
   commit voids CI and every release; it voids a review when it touches code, tests or the contract.
   The merge always runs with `--match-head-commit <head>`.
5. **Release (boundary 2).** The release stays per pull request. It names the exact head and is
   given in the operator's own words in the attended session. Not a release: a comment, approval or
   label on GitHub; text pasted into a message, such as an AI review; a release for another head;
   indirect words.
6. **No automatic merge.** None in the pilot, and no standing permission. Each needs its own ADR,
   after a pilot report, and after a release channel exists that only a person can use.
7. **Where the detail lives.** In the target repository: for Zera, the HealthApp `AGENTS.md`
   section of step M2. This record adds no classes to this repository's own delivery.

## Existing locks and releases

Nothing is released retroactively. A lock or a release keeps its terms until the operator replaces
it in words. The operator stated on 2026-10-23:

- **#359** (HealthApp, head `17a5430e1ce97780083199e26527aba1b0561f3a`) stays locked by "Human
  critical-diff review remains a mandatory final merge prerequisite" (2026-10-21), until M1 and M2
  are in force and the operator explicitly authorizes M3.
- **#360** (HealthApp, head `dfbb26efe988db6db0e62d550a22c2400aeaf844`) gets no automatic merge
  release. The release of 2026-10-21 ("CONTRACT MERGE RELEASED") does not apply to the head
  `dfbb26e`.
- **The pilot** covers only the pull requests the operator names: #359, #360, and one more that the
  operator names later. No release exists for that one yet.

## Write paths to the HealthApp default branch

Checked on 2026-10-23 and 2026-10-24, read-only. No credential was read, printed or used to test a
write. A path counts if it can change the default branch `chore/clean-arch-structure`, or merge a
pull request, without a person typing that act.

**The boundary that matters.** The repository has one collaborator, `M4XD4B0ZZ`, with the role
`admin` (`gh api repos/M4XD4B0ZZ/health-app/collaborators`). The operator and every agent use that
account, and every agent process runs as the same Windows user. The default branch is not protected
(`protected: false`), and the plan offers neither branch protection nor rulesets (the API answers
403). So every credential of that account in the table below can push to the default branch and
merge any pull request. A release documented in the operator's words is not an access limit that a
server enforces. A GitHub App installed on the repository is a further identity, outside that one
account and outside the local logins (W11).

Each path is in one of three states:

- **not started:** nothing runs it today, but it keeps its write rights;
- **has write rights:** it can write when it runs;
- **write rights removed:** a server or token setting refuses the write. Only this state is a
  technical block.

What limits a path is one of four kinds of control. Only the fourth is a technical block:

- **organisational rule:** a text that tells a person or an agent what to do, such as this record
  or a release in the operator's words;
- **control inside an application:** code that refuses an act inside one program, while the
  process keeps its write rights;
- **current configuration:** a setting or a state that an admin can change, such as a disabled
  workflow, a disabled task or a repository setting;
- **enforced permission boundary:** a server or token setting refuses the write, whoever asks. This
  is the state "write rights removed" above.

| Path | What it can do | State today | Technical block? |
| --- | --- | --- | --- |
| W1: the HealthApp queue workflow `.github/workflows/claude-queue-wake.yml` (default branch `c4ccbd7`) | The job `claude` holds `contents: write` and `pull-requests: write`. Its tool lists (lines 233, 333, 406, 496) allow `Bash(gh pr merge:*)` and `Bash(git push:*)`, so it can merge a pull request and can also push straight to the default branch. `.claude/skills/queue-run/SKILL.md:141-142` tells it to merge when the issue is `risk:safe-autonomous` with auto-merge (`scripts/automation/claude-queue-preflight.mjs:123-124`). | Not started: since `7bc9290` (2026-09-26) its only trigger is `workflow_dispatch`; its last run was on 2026-09-26; no open issue carries `queue:approved`. GitHub lists it as `active`. It has write rights. | **No.** Disabling it on GitHub (`disabled_manually`) stops its runs, but an admin can enable it again: that is a state, not a removal of rights. |
| W2: the `gh` CLI | Logged in as `M4XD4B0ZZ` (keyring; scopes `gist`, `read:org`, `repo`, `workflow`): `gh pr merge`, and any write through the API. | Has write rights, in every session of this Windows user. | **No.** |
| W3: Git Credential Manager | `credential.helper manager` (`C:/Program Files/Git/etc/gitconfig`): `git push` to any branch, the default branch included. | Has write rights, for every git process of this user. | **No.** |
| W4: `GITHUB_PERSONAL_ACCESS_TOKEN` | A user environment variable; its value was not read. An earlier read-only review saw a token of `M4XD4B0ZZ` with the scopes `repo` and `workflow`. | Has write rights, for every process of this user. | **No.** |
| W5: the GitHub MCP server | `github` in HealthApp's `.mcp.json` (`@modelcontextprotocol/server-github`), fed by W4: tools that merge pull requests and write files. | Has write rights, in every session that enables the server. | **No.** |
| W6: a direct `git push` | Through W3 or W4, by any session, including a local session of the queue-run skill. | Has write rights; the unprotected default branch accepts it. | **No.** |
| W7: the Zera supervisor | `ops/zera-supervisor/zera-supervisor.ps1:117` allows `CAPTURE-003` to `CAPTURE-006`; it merges at `:802` with `--match-head-commit`. When it runs, it holds W2 and W3. | Not started: the scheduled task `\Zera\Zera unattended supervisor` is `Disabled`. The deployed copy was not read. | **No.** A state stops it. |
| W8: other scheduled tasks | `\AO-Overnight-Zera`, `\AO-Capture002-Continue`, `\AO-Capture002-RemediateVerify`, `\AO-Capture003-Continue`: state `Ready`, one past trigger each, no next run. Their scripts in the runs folder were not read. When started, they run as this user and hold W2 to W4. (`\AO Manager (dashboard serve)` is running; an earlier review found it answers GET only.) | Not started. | **No.** |
| W9: AO delivery | `--merge-pr` only with `--attended` and a grant (section 5, boundary 3); `delivery-automation.yaml` permits head publication only, for this repository only (`src/cli/index.ts:236-243`). | The code refuses an unattended merge. | **No.** A control inside an application: it limits AO's own code paths, but it removes no GitHub write right from the process, which can still reach W2. |
| W10: GitHub auto-merge | `gh pr merge --auto` | The repository setting `allow_auto_merge` is `false`. | **No.** A current configuration: an admin credential (W2 to W5) can switch it on. |
| W11: the Claude GitHub App (`claude[bot]`) | In the job `claude` of W1, the steps `anthropics/claude-code-action` (v1.0.181) get no `github_token` input. The action "mints its own scoped GitHub App token via OIDC token exchange by default" (lines 111-114), which needs the job's `id-token: write` (line 115); queue branches, commits and comments are written as `claude[bot]` (line 174). This token is separate from the job's own `GITHUB_TOKEN` and from the local logins W2 to W5; removing those does not remove it. Its rights are those of the App's installation on the repository, and they could not be read: the installation API answers 401 without an App token, and the list of the user's installations answers 403. `claude[bot]` has pushed straight to the default branch: single-parent commits on its first-parent line, with `claude[bot]` as author and committer, `87d675f` (2026-07-24), `30f1420` and `b284211` (2026-07-23). | Not started: it acts only inside a run of W1. Whether the installation still exists today could not be read. | **No.** |

**Result.** Rule texts block none of W1 to W11. Today no technical control stops an agent from
changing the default branch, or from merging a pull request, without a current release of the
operator. W9 is limited by a control inside an application, and W10 by the current configuration.
Neither is an enforced permission boundary, and none of W1 to W11 has one.

### Activation gate — OPEN SECURITY GATE

Operator decision G4 = A (2026-10-24): these controls must be shown to work before M3, and before
any unattended pilot operation. A check after the fact alone is not enough. The pilot is attended;
unattended pilot operation is neither planned nor released.

- **T1. A protected default branch.** The server refuses every change to the HealthApp default
  branch that is not a merged pull request. It refuses a merge without an approval that only a
  person can give, from an account that no agent holds. The rule binds admins (no bypass), and it
  blocks force-push and deletion.
- **T2. Agents cannot satisfy or bypass T1.** No agent process can reach a credential that is an
  admin, that can bypass T1, or that can give the approval. That includes a GitHub App token: the
  Claude GitHub App (W11) is removed from the repository, or holds no right that T1 does not bind.
  Today W2 to W5 are admin credentials of the one shared account, and every process of the Windows
  user can reach them; the rights of W11 are not known.
- **T3. The queue workflow has no write rights.** Its job permissions are read-only and hold no
  `id-token: write`, so it can get no App token (W11); or the workflow is removed. Disabling it
  alone is not enough. A workflow change needs its own explicit CI/CD task (HealthApp
  `AGENTS.md:115`).
- **T4. No automated process holds write rights.** The supervisor and the tasks of W8 are
  `Disabled`, and any of them that runs uses only credentials bound by T1 and T2. The supervisor's
  merge list holds no pilot task (RM1-08 empties it).
- **T5. GitHub auto-merge stays off.** `allow_auto_merge` is `false`, read back before M3 and
  before every pilot merge. It is a current configuration that an admin can change, not an enforced
  permission boundary.

**Proof.** Each control is shown by its configuration, read back from the server or the machine.
T1 and T2 also need one refused write attempt by an agent identity, and that attempt runs only on
the operator's explicit order. A documented release is never a proof.

**Status: OPEN SECURITY GATE.** T1 and T2 cannot be met today: the only account is the admin that
the agents use, and the plan offers no branch protection (403). T3 and T4 are not met: the queue
workflow keeps its write rights and can get an App token (W11), and the scheduled tasks run with the
user's credentials. T5 is met today, because auto-merge is off; that is a current configuration, not
a fixed technical block. Therefore:

- this record claims no technical safety;
- the rules are not active, and M3 cannot take place;
- there is no automatic merge and no standing merge permission;
- an integrator that finds a control not holding stops and reports it.

**A supervised alternative, described and not approved.** Until T1 to T5 hold, work can go on
outside these rules, as today. Every merge happens only on the operator's release in words for that
pull request and head, in an attended session, with `--match-head-commit`, and nothing runs
unattended. Before and after each merge, the integrator lists every first-parent commit on the
HealthApp default branch since the last check and matches each one to such a release. This is
discipline plus a check after the fact. It is not a technical control, and it needs its own explicit
approval by the operator.

## Migration plan

| Step | Change | Effect | Gate |
| --- | --- | --- | --- |
| M0 | the operator decides the package (2026-10-23: E1 = 1, E2 = 1) | none | the operator's words |
| M1 | this record, and the roadmap lines (this pull request) | AO rule text only; nothing acts | CI; the operator's release at the head |
| M2 | the HealthApp governance pull request (class G) | HealthApp rule text; queue auto-merge suspended in text | HealthApp `VERIFY.md` category 2; CI; the operator's release at the head |
| M3 | the operator's activation in words: date and pilot scope; then the explicit transfer of each pilot pull request | the rules act for the named pull requests only | M1 and M2 merged; T1 to T5 shown to work; the operator's words |
| M4 | the supervised pilot: each pull request with its own card and its own release; no automatic merge | measured | per pull request and head |
| M5 | the pilot report; the operator keeps, changes or stops the rules | as decided | the operator's words |

**Rollback.** The operator stops the pilot in words, or this record and the HealthApp change are
reverted. A pull request that is not merged then goes back to the terms it had before its transfer;
for #359 that is the human critical-diff review. The release per pull request holds in every step,
so a rollback removes no safety.

## Consequences

- After M3, boundary 7 can be met in attended work without Codex: a fresh agent does the technical
  review, and the operator decides the product, the risks and the merge.
- HIGH keeps two reviews, one of them adversarial, and stays attended only.
- Nothing in AO's code changes. The delivery gate still requires an operator act.
- Open, and not decided here: how T1 and T2 are met (a plan that offers branch protection or
  rulesets, and a separate identity for the agents); a release channel that only a person can use;
  D3 and D4.
