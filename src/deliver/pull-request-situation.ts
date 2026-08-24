/**
 * What the forge's answer says about one exact commit's pull requests.
 *
 * Pure: it takes the candidate set slice 2's locator endpoint returns and
 * classifies it. No process, no clock, no filesystem, no network.
 *
 * ── Why the locator endpoint and not the `head` filter ────────────────────
 *
 * There is a shorter-looking query — `GET /repos/{o}/{r}/pulls?head=OWNER:BRANCH`
 * — and it is not used here, for a measured reason. **An unqualified `head` is
 * silently ignored by that endpoint.** Measured against github.com:
 *
 *     ?head=M4XD4B0ZZ:v4-slice-4-delivery-decision&state=all  ->  1 result
 *     ?head=v4-slice-4-delivery-decision&state=all            -> 30 results
 *     ?head=zzz-no-such-branch-at-all&state=all               -> 30 results
 *     (no head parameter at all)&state=all                    -> 30 results
 *
 * A nonsense unqualified head returns byte-identical results to sending no
 * filter, so a duplicate check written that way would read a whole page of
 * unrelated pull requests as matches. The 30 above was that day's page size,
 * not a repository total — re-measured at `per_page=100` the three unfiltered
 * answers are 60, which is every pull request this repository has had. The
 * defect reproduces either way; the number was a page. The failure is silent,
 * not an error.
 *
 * The commit-keyed locator this build already uses has no such mode: it is
 * asked about one object name, and every candidate is re-tested against its own
 * head anyway.
 *
 * ── Why the state split, and why `CLOSED_ONLY` is not `NONE` ──────────────
 *
 * The uniqueness GitHub enforces is scoped to *open* pull requests, and that is
 * measured rather than assumed: in `withastro/astro`, 928 pull requests share
 * one head branch and base, and exactly one of them is open. So a closed or
 * merged pull request does not stop a new one being created — which is
 * precisely why this build has to see the difference. A closed pull request at
 * this exact commit means somebody already decided about this delivery, and an
 * absence does not.
 */

import type { PullCandidate } from './forge-observation.js';
import type { PullRequestSituation } from './pull-request-creation.js';

const NO_NUMBERS: readonly number[] = Object.freeze([]);

/** The reading that says nothing could be established. */
export const SITUATION_UNKNOWN: PullRequestSituation = Object.freeze({
  outcome: 'UNKNOWN' as const,
  open: null,
  numbers: NO_NUMBERS,
});

function ascending(numbers: readonly number[]): readonly number[] {
  return Object.freeze([...new Set(numbers)].sort((a, b) => a - b));
}

/**
 * Classifies the candidate set into one situation about this exact commit.
 *
 * The commit is compared by exact string equality. There is no prefix match and
 * no case folding: a pull request whose head is an abbreviation of this commit
 * is a pull request about something this build cannot identify, and the parse
 * has already refused any candidate whose head is not a full lowercase hex
 * object name.
 *
 * A candidate that is open at this head but whose `base.ref` or `draft` the
 * forge did not report is graded `UNKNOWN` rather than being read past. Both
 * fields decide whether an existing pull request is *the intended one*, and a
 * missing one means the question cannot be answered — which is a different fact
 * from "there is no pull request", and the fail-closed one.
 */
export function classifyPullRequestSituation(
  candidates: readonly PullCandidate[],
  commit: string,
): PullRequestSituation {
  const atHead = candidates.filter((candidate) => candidate.headSha === commit);
  const open = atHead.filter((candidate) => candidate.state === 'open');

  if (open.length > 1) {
    return Object.freeze({
      outcome: 'OPEN_MANY' as const,
      open: null,
      numbers: ascending(open.map((candidate) => candidate.number)),
    });
  }

  const only = open[0];
  if (only !== undefined) {
    if (only.baseRef === null || only.draft === null) return SITUATION_UNKNOWN;
    return Object.freeze({
      outcome: 'OPEN_ONE' as const,
      open: Object.freeze({
        number: only.number,
        baseRef: only.baseRef,
        draft: only.draft,
      }),
      numbers: ascending([only.number]),
    });
  }

  if (atHead.length > 0) {
    return Object.freeze({
      outcome: 'CLOSED_ONLY' as const,
      open: null,
      numbers: ascending(atHead.map((candidate) => candidate.number)),
    });
  }

  return Object.freeze({ outcome: 'NONE' as const, open: null, numbers: NO_NUMBERS });
}
