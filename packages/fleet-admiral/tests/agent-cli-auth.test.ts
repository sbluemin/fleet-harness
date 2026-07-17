import { describe, expect, it } from "vitest";

import {
  KIMI_AUTH_PROVIDER_ID,
  getAgentCliAuthStatuses,
  resolveAgentCliAuthEnv,
} from "../src/index.js";

describe("Kimi Agent CLI authentication", () => {
  it("injects the stored key with the official Kimi Claude Code environment", async () => {
    const env = await resolveAgentCliAuthEnv("claude-kimi", {
      getApiKey: async (providerId) => providerId === KIMI_AUTH_PROVIDER_ID ? "kimi-secret" : undefined,
    });

    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
      ANTHROPIC_API_KEY: "kimi-secret",
      ANTHROPIC_MODEL: "kimi-for-coding",
      CLAUDE_CODE_SUBAGENT_MODEL: "kimi-for-coding",
    });
    expect(env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("rejects Kimi launch when no Fleet-owned key exists", async () => {
    await expect(resolveAgentCliAuthEnv("claude-kimi", {
      getApiKey: async () => undefined,
    })).rejects.toThrow("fleet auth login claude-kimi");
  });

  it("reports only boolean sign-in state", async () => {
    await expect(getAgentCliAuthStatuses({
      listProviderIds: async () => [KIMI_AUTH_PROVIDER_ID],
    })).resolves.toEqual([{ cli: "claude-kimi", signedIn: true }]);
  });
});
