import { describe, expect, it } from "vite-plus/test";

import { agentMcpToolName } from "./fwaiMcpNames.ts";
import {
  T3_MCP_TOOL_NAMES,
  resolveT3McpToolId,
  resolveT3McpToolPresentation,
} from "./t3McpToolPresentation.ts";

describe("resolveT3McpToolPresentation", () => {
  it("recognizes every T3 tool across provider prefixes and completion suffixes", () => {
    for (const tool of T3_MCP_TOOL_NAMES) {
      const presentation = resolveT3McpToolPresentation(tool);
      for (const prefix of [
        "mcp__t3-code__",
        "mcp__t3_code__",
        "mcp__t3code__",
        "T3-code.",
        "t3_code/",
        "t3code:",
        "mcp_t3-code_",
        "T3 Code ",
        "t3-code · ",
      ]) {
        expect(resolveT3McpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveT3McpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveT3McpToolPresentation("t3-code-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveT3McpToolPresentation("t3-code-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });

  it("recognizes fwai's agent-facing names as well as upstream's", () => {
    for (const tool of T3_MCP_TOOL_NAMES) {
      const presentation = resolveT3McpToolPresentation(tool);
      const exposed = agentMcpToolName(tool);
      for (const label of [
        exposed,
        `mcp__fwai-code__${exposed}`,
        `mcp__fwai_code__${exposed} completed`,
        `fwai-code.${exposed}`,
        `fwai-code_${exposed}`,
        `fwai-code-thread_opencode2-adapter_${exposed}`,
        `mcp__t3-code__${tool}`,
      ]) {
        expect(resolveT3McpToolPresentation(label), label).toEqual(presentation);
        expect(resolveT3McpToolId(label), label).toBe(tool);
      }
    }
    expect(resolveT3McpToolId("mcp__fwai-code__fwai_code_thread_send")).toBe("t3_thread_send");
    expect(resolveT3McpToolId("mcp__another-server__fwai_code_thread_send")).toBeNull();
  });
});
