import { describe, expect, it } from "vitest";

import { UnifiedAgent, UnifiedClaudeAgentClient } from "../../src/index.js";

describe("UnifiedAgent Kimi provider", () => {
  it("builds Kimi with the Claude-family client", () => {
    const client = UnifiedAgent.createClient("claude-kimi");

    expect(client).toBeInstanceOf(UnifiedClaudeAgentClient);
    expect(client.getAvailableModels()?.defaultModel).toBe("kimi-for-coding");
  });
});
