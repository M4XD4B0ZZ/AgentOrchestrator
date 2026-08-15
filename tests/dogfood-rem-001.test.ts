/**
 * DOGFOOD-REM-001 — the two defects the first dogfood run exposed.
 *
 * The run reported a delivered task and delivered nothing. Two causes, and
 * this file holds the controls for both as they land:
 *
 *  1. the writing agent had no authority to edit anything, because the
 *     argument vector never granted it — and no test pinned that vector, so
 *     the absence was invisible;
 *  2. a run with no effect could still settle as complete.
 *
 * The first is pinned here **as a whole**. `tests/claude-writer.test.ts`
 * asserts only that whatever `CLAUDE_WRITER_ARGS` holds is passed through to
 * the seam, which is true of an empty vector too. Pass-through is not
 * authority.
 */

import { describe, expect, it } from 'vitest';
import { CLAUDE_WRITER_ARGS } from '../src/agent/claude-writer.js';
import { isShellInertArgument } from '../src/doctor/exec.js';

describe('the writer is configured hermetically and can actually edit', () => {
  // Pinned as a whole. Today NO test pins the contents of this constant —
  // tests/claude-writer.test.ts asserts only that whatever it holds is passed
  // through — so any change to it is currently invisible. That is the gap.
  it('is exactly the measured vector for CLI 2.1.233', () => {
    expect([...CLAUDE_WRITER_ARGS]).toEqual([
      '--print',
      '--output-format',
      'json',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--permission-mode',
      'acceptEdits',
      '--tools',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
    ]);
  });

  it('is expressible as argv at all', () => {
    for (const token of CLAUDE_WRITER_ARGS) {
      expect(isShellInertArgument(token)).toBe(true);
    }
  });

  // The authority ceiling, asserted as absence with a live mutant (G7): each of
  // these tokens would widen authority past what the payload asks for.
  it.each([
    'bypassPermissions',
    '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions',
    '--add-dir',
  ])('does not grant authority through %s', (forbidden) => {
    expect(CLAUDE_WRITER_ARGS).not.toContain(forbidden);
  });

  it('grants no shell and no git tool', () => {
    const toolsAt = CLAUDE_WRITER_ARGS.indexOf('--tools');
    expect(toolsAt).toBeGreaterThanOrEqual(0);
    const tools = CLAUDE_WRITER_ARGS.slice(toolsAt + 1);
    expect(tools).toEqual(['Read', 'Edit', 'Write', 'Glob', 'Grep']);
    expect(tools).not.toContain('Bash');
    expect(tools).not.toContain('PowerShell');
  });

  it('bounds MCP authority, which --tools does not', () => {
    // Measured: without this flag the writer held the operator's MCP tools and
    // attempted mcp__claude_ai_Gmail__list_labels.
    expect(CLAUDE_WRITER_ARGS).toContain('--strict-mcp-config');
  });

  it('takes its settings from no ambient source', () => {
    const at = CLAUDE_WRITER_ARGS.indexOf('--setting-sources');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(CLAUDE_WRITER_ARGS[at + 1]).toBe('');
    // --bare would also be hermetic and would break subscription auth: its help
    // says OAuth and the keychain are never read. Measured from the binary.
    expect(CLAUDE_WRITER_ARGS).not.toContain('--bare');
    // --safe-mode's documented and measured behaviour disagree on CLAUDE.md.
    expect(CLAUDE_WRITER_ARGS).not.toContain('--safe-mode');
  });
});
