/**
 * The instructions handed to the writing agent for a first implementation pass.
 *
 * The counterpart to `buildRemediationPayload`, and it follows the same rules:
 * deterministic, bounded, and honest about what it does not carry. The same
 * task file always produces the same bytes, so an implement prompt is
 * reproducible from the repository rather than composed afresh each run.
 *
 * ── Context is named, not pasted ───────────────────────────────────────────
 *
 * The declared context sources appear as **paths**, not as contents. The agent
 * runs inside the task's worktree and can open them itself, when it needs them
 * and in the order its own work requires; a snapshot taken here would be a
 * truncated copy chosen by the wrong layer. `task-brief.ts` makes the same
 * argument at length, and this module is where the consequence shows up: the
 * payload stays a fixed size no matter how large the repository's
 * documentation grows.
 *
 * A source that could not be opened is named too, with its status. The agent is
 * better told "this file was declared and is missing" than left to discover it,
 * and an operator reading the prompt can see the same thing.
 */

import type { ExecutionBrief } from '../plan/task-brief.js';
import { writerBriefingLines, type OrchestratorBriefing } from './orchestrator-briefing.js';
import { clampPayload } from './payload-budget.js';

/**
 * Builds the implement-pass instructions for `brief`.
 *
 * `round` is the pass this work belongs to, carried so the prompt and the
 * resume point a failure records name the same number.
 */
export function buildImplementPayload(
  brief: ExecutionBrief,
  round: number,
  briefing: OrchestratorBriefing,
): string {
  const lines = [
    `Implement task ${brief.taskId} (pass ${round}).`,
    '',
    // Above the task body, because `clampPayload` cuts the tail: a block
    // appended after a maximal body would be the first thing truncated away,
    // and a writer that never sees it is a writer back to reading the tree's
    // prose for facts this orchestrator has already measured.
    ...writerBriefingLines(briefing),
    '',
    'Work only inside this worktree. Make the change the task describes, and',
    'nothing beyond it. The repository’s own verification commands will be run',
    'afterwards and an independent reviewer will look at the result; neither is',
    'satisfied by a change that merely appears to compile.',
    '',
    'TASK',
    brief.body,
  ];

  if (brief.bodyTruncated) {
    lines.push(
      '',
      '[The task text above was truncated at the payload budget. Read the task',
      'file in the repository for the remainder.]',
    );
  }

  if (brief.contextSources.length > 0) {
    lines.push(
      '',
      'CONTEXT SOURCES (paths in this worktree — open them yourself as needed)',
    );
    for (const source of brief.contextSources) {
      lines.push(
        source.status === 'PRESENT' ? `- ${source.path}` : `- ${source.path} [${source.status}]`,
      );
    }
  }

  return clampPayload(lines.join('\n'));
}
