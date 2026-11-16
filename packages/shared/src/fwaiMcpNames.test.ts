import { describe, expect, it } from "vite-plus/test";

import { agentFacingMcpText, agentMcpToolName, internalMcpToolName } from "./fwaiMcpNames.ts";

describe("fwaiMcpNames", () => {
  it("maps only t3_ tools to fwai_code_ and back", () => {
    expect(agentMcpToolName("t3_thread_send")).toBe("fwai_code_thread_send");
    expect(agentMcpToolName("delegate_task")).toBe("delegate_task");
    expect(internalMcpToolName("fwai_code_thread_send")).toBe("t3_thread_send");
    expect(internalMcpToolName("t3_thread_send")).toBe("t3_thread_send");
  });

  it("rewrites tool mentions in agent text but not tags, env vars or other words", () => {
    expect(
      agentFacingMcpText(
        "<t3_code_instructions>Call `t3_thread_read`, then mcp__t3-code__t3_thread_send or `t3_pending_request_*`. T3_MCP_URL stays; so does at3_x.</t3_code_instructions>",
      ),
    ).toBe(
      "<t3_code_instructions>Call `fwai_code_thread_read`, then mcp__fwai-code__fwai_code_thread_send or `fwai_code_pending_request_*`. T3_MCP_URL stays; so does at3_x.</t3_code_instructions>",
    );
  });
});
