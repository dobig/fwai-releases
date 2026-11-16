/**
 * fwai: agents see the built-in MCP server as `fwai-code` and its `t3_*` tools as `fwai_code_*`.
 * Code and tool definitions keep upstream's names; translate only where a name reaches an agent
 * or comes back from one. See docs/fwai/upstream.md.
 */
export const FWAI_MCP_SERVER_NAME = "fwai-code";

/** Upstream's server name, still found in thread histories. */
export const LEGACY_MCP_SERVER_NAME = "t3-code";

const INTERNAL_TOOL_PREFIX = "t3_";
const AGENT_TOOL_PREFIX = "fwai_code_";

export const agentMcpToolName = (tool: string): string =>
  tool.startsWith(INTERNAL_TOOL_PREFIX)
    ? AGENT_TOOL_PREFIX + tool.slice(INTERNAL_TOOL_PREFIX.length)
    : tool;

export const internalMcpToolName = (tool: string): string =>
  tool.startsWith(AGENT_TOOL_PREFIX)
    ? INTERNAL_TOOL_PREFIX + tool.slice(AGENT_TOOL_PREFIX.length)
    : tool;

// `t3_code_*` are prompt tags, not tools.
const INTERNAL_TOOL_MENTION = /(?<![A-Za-z0-9])t3_(?!code_)(?=[a-z])/g;

/** Rewrites tool and server names in text written for agents (descriptions, prompts, errors). */
export const agentFacingMcpText = (text: string): string =>
  text
    .replaceAll(`mcp__${LEGACY_MCP_SERVER_NAME}__`, `mcp__${FWAI_MCP_SERVER_NAME}__`)
    .replace(INTERNAL_TOOL_MENTION, AGENT_TOOL_PREFIX);
