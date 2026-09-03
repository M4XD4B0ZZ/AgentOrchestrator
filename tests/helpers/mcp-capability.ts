/**
 * Test stubs for the MCP capability preflight (M5).
 *
 * Every one of these answers `NOT_REQUIRED`, which is what a repository that
 * declares `codegraph: OPTIONAL` produces — the shape all but a handful of
 * fixtures in this suite have. They exist so a test that is about something
 * else states "no capability was involved" in one word instead of spelling a
 * closure, and so the day a fixture *should* have required one, the difference
 * is visible in the diff.
 *
 * They deliberately do **not** default anything in production: the fields they
 * fill are required, and `claude-writer.ts` says why — a call site that forgot
 * one would otherwise get whichever authority the default happened to be.
 */
import type {
  McpCapabilityOutcome,
  McpPreflightFactory,
} from '../../src/agent/mcp-capability-preflight.js';

/** The outcome of a repository that requires no capability. */
export const NO_CAPABILITY_REQUIRED: McpCapabilityOutcome = Object.freeze({
  state: 'NOT_REQUIRED' as const,
});

/** For `LifecycleDependencies.mcpPreflight` and `AttendedBlockDependencies.mcpPreflight`. */
export const noMcpPreflight = async (): Promise<McpCapabilityOutcome> => NO_CAPABILITY_REQUIRED;

/** For `CrossRepositoryRunDependencies.mcpPreflight`. */
export const noMcpPreflightFactory: McpPreflightFactory = () => noMcpPreflight;

/**
 * For `SchedulerDependencies.mcpPreflight` and
 * `UnattendedResumeDependencies.mcpPreflight` — the factory-of-factories those
 * two take so that a memo cannot cross a sleep.
 */
export const noMcpPreflightPerCycle = (): McpPreflightFactory => noMcpPreflightFactory;
