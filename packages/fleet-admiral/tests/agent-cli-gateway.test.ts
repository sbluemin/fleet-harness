import { describe, expect, it } from "vitest";

import { resolveAgentCliProfile } from "../src/index.js";

describe("claude-gateway profile", () => {
  it("uses Claude Code while stripping inherited provider credentials", async () => {
    const profile = await resolveAgentCliProfile({
      ANTHROPIC_API_KEY: "api-secret",
      ANTHROPIC_AUTH_TOKEN: "bearer-secret",
      CLAUDE_BIN: process.execPath,
      KEEP_ME: "yes",
    }, "/tmp", {
      cliId: "claude-gateway",
      model: "claude-gateway--cursor-auto",
    });

    expect(profile).toMatchObject({
      args: ["--model", "claude-gateway--cursor-auto"],
      bin: process.execPath,
      id: "claude-gateway",
      label: "Claude (Gateway • Experimental)",
      renameCommand: "/rename",
    });
    expect(profile.env.KEEP_ME).toBe("yes");
    expect(profile.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(profile.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });
});
