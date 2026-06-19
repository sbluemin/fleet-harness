import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getAgentCliInjectionCapability,
  getAgentCliIds,
  parseAgentCliId,
  resolveAgentCliProfile,
} from "@dotobokuri/fleet-admiral";

const mocks = vi.hoisted(() => ({
  resolveAuthEnvMock: vi.fn(),
}));

const tempRoots: string[] = [];

describe("agent CLI catalog", () => {
  beforeEach(() => {
    mocks.resolveAuthEnvMock.mockResolvedValue({
      ANTHROPIC_AUTH_TOKEN: "variant-token",
      ANTHROPIC_BASE_URL: "https://example.invalid/anthropic",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("includes dedicated Agent CLI profiles", () => {
    expect(getAgentCliIds()).toEqual([
      "claude",
      "claude-kimi",
      "claude-glm",
      "codex",
    ]);
  });

  it("parses --cli, --cli=, and FLEET_AGENT_CLI values", async () => {
    const env = createEnvWithBins();

    await expect(resolveAgentCliProfile(env, "/tmp", { cliId: "codex" })).resolves.toMatchObject({
      id: "codex",
    });
    await expect(resolveAgentCliProfile(env, "/tmp", { cliId: "claude-kimi" })).resolves.toMatchObject({
      id: "claude-kimi",
    });
    await expect(resolveAgentCliProfile({ ...env, FLEET_AGENT_CLI: "claude-kimi" }, "/tmp")).resolves.toMatchObject({
      id: "claude-kimi",
    });
  });

  it("rejects inherited object keys as CLI IDs", () => {
    for (const cliId of ["toString", "constructor", "__proto__"]) {
      expect(() => parseAgentCliId(cliId)).toThrow(`Unsupported agent CLI "${cliId}"`);
    }
  });

  it("shares Claude-family terminal and message policy", async () => {
    const env = createEnvWithBins();
    const claude = await resolveAgentCliProfile(env, "/tmp", { cliId: "claude" });
    const kimi = await resolveAgentCliProfile(env, "/tmp", { cliId: "claude-kimi" });

    expect(claude.terminalName).toBe("xterm-256color");
    expect(claude.messagePolicy).toEqual({
      bracketedPaste: true,
      lineTerminator: "\r",
      multilineStrategy: "paste-mode",
    });
    expect(kimi.terminalName).toBe(claude.terminalName);
    expect(kimi.messagePolicy).toEqual(claude.messagePolicy);
  });

  it("resolves Claude Kimi auth env before profile creation succeeds", async () => {
    const env = createEnvWithBins();

    const profile = await resolveAgentCliProfile(env, "/tmp", {
      authEnvResolver: mocks.resolveAuthEnvMock,
      cliId: "claude-kimi",
    });

    expect(mocks.resolveAuthEnvMock).toHaveBeenCalledWith("claude-kimi", { authService: undefined });
    expect(profile.env.ANTHROPIC_AUTH_TOKEN).toBe("variant-token");
    expect(profile.env.ANTHROPIC_BASE_URL).toBe("https://example.invalid/anthropic");
  });

  it("fails before returning a Claude Kimi profile when auth resolution fails", async () => {
    const env = createEnvWithBins();
    mocks.resolveAuthEnvMock.mockRejectedValue(new Error("Validation failed"));

    await expect(resolveAgentCliProfile(env, "/tmp", {
      authEnvResolver: mocks.resolveAuthEnvMock,
      cliId: "claude-kimi",
    })).rejects.toThrow("Validation failed");
  });

  it("does not mutate process.env while creating profiles", async () => {
    const env = createEnvWithBins();
    const before = { ...process.env };

    await resolveAgentCliProfile(env, "/tmp", {
      authEnvResolver: mocks.resolveAuthEnvMock,
      cliId: "claude-kimi",
    });

    expect(process.env).toEqual(before);
  });

  it("forwards model values into agent CLI profile args", async () => {
    const env = createEnvWithBins();

    const profile = await resolveAgentCliProfile(env, "/tmp", { cliId: "codex", model: "gpt-5.2" });

    expect(profile.args).toContain("--model");
    expect(profile.args).toContain("gpt-5.2");
  });

  it("omits model args when no model is provided", async () => {
    const env = createEnvWithBins();

    const profile = await resolveAgentCliProfile(env, "/tmp", { cliId: "codex" });

    expect(profile.args).not.toContain("--model");
  });

  it("uses native injection builders for dedicated profiles", () => {
    expect(getAgentCliInjectionCapability("claude")).toEqual({
      builderId: "claude-native",
      enabled: true,
    });
    expect(getAgentCliInjectionCapability("claude-kimi")).toEqual({
      builderId: "claude-native",
      enabled: true,
    });
    expect(getAgentCliInjectionCapability("codex")).toEqual({
      builderId: "codex-native",
      enabled: true,
    });
  });
});

function createEnvWithBins(): NodeJS.ProcessEnv {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-agent-cli-"));
  tempRoots.push(tempRoot);
  fs.writeFileSync(path.join(tempRoot, "claude"), "");
  fs.writeFileSync(path.join(tempRoot, "codex"), "");
  return {
    PATH: tempRoot,
  };
}
