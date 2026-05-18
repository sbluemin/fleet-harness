import { afterEach, describe, expect, it } from "vitest";

import {
  clearAllTools,
  registerToolsForSession,
  setOnToolCallArrived,
  startMcpServer,
  stopMcpServer,
} from "@sbluemin/fleet-mcp-server";
import type { IUnifiedAgentClient } from "@sbluemin/fleet-unified-agent";

import { deliverToolResults } from "../../src/admiral/agent/internal/session-engine.js";
import {
  getOrInitState,
  resetState,
  type AgentSessionState,
} from "../../src/admiral/agent/internal/state.js";

describe("session-engine MCP routing recovery", () => {
  afterEach(async () => {
    resetState();
    clearAllTools();
    await stopMcpServer();
  });

  it("FIFO head mismatch는 held MCP request에 error result를 반환하고 routing을 닫는다", async () => {
    const url = await startMcpServer();
    const token = "session-engine-mismatch-token";
    const toolCallId = "expected-head";
    const state = getOrInitState();
    const session: AgentSessionState = {
      sessionKey: "acp:codex:mismatch",
      scopeKey: "mismatch",
      client: {} as IUnifiedAgentClient,
      sessionId: "session-mismatch",
      cwd: "/tmp",
      lastSystemPromptHash: "",
      cli: "codex",
      firstPromptSent: true,
      currentModel: "gpt-test",
      mcpSessionToken: token,
      toolHash: "tool-hash",
      pendingToolCalls: [{
        toolCallId,
        toolName: "custom-tool",
        args: {},
        emitted: true,
      }],
      pendingToolCallNotifier: null,
      activePrompt: {
        promptId: "prompt-1",
        sessionGeneration: 0,
        retryConsumed: false,
        assistantOutputStarted: false,
        builtinToolStarted: false,
        mcpToolUseStarted: true,
      },
      sessionGeneration: 0,
      needsRecovery: false,
      lastError: null,
    };

    state.sessions.set(session.sessionKey, session);
    state.toolCallToSessionKey.set(toolCallId, session.sessionKey);
    registerToolsForSession(token, [{
      name: "custom-tool",
      description: "custom",
      parameters: { type: "object", properties: {} },
    }]);
    setOnToolCallArrived(token, () => toolCallId);

    const heldResponse = await Promise.race([
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "custom-tool", arguments: {} },
        }),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("held MCP request headers were not flushed")), 250);
      }),
    ]);

    await deliverToolResults(session, [{
      toolCallId: "wrong-head",
      content: "wrong",
    }]);

    const body = await heldResponse.json() as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    };

    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("FIFO head");
    expect(session.pendingToolCalls).toHaveLength(0);
    expect(session.pendingToolCallNotifier).toBeNull();
    expect(session.needsRecovery).toBe(true);
    expect(state.toolCallToSessionKey.has(toolCallId)).toBe(false);
  });
});
