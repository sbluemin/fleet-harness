import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDedicatedCliInjectionCapability } from "../../src/dedicated-cli/capabilities.js";
import {
  getDedicatedCliIds,
  resolveDedicatedCliProfile,
} from "../../src/dedicated-cli/registry.js";

const mocks = vi.hoisted(() => ({
  resolveAuthEnvMock: vi.fn(),
}));

vi.mock("@sbluemin/fleet-core", () => ({
  admiral: {
    mcp: {
      getEndpoint: vi.fn(),
      issueDedicatedSessionToken: vi.fn(),
    },
    prompts: {
      buildSystemPrompt: vi.fn(),
    },
  },
  infra: {
    auth: {
      resolveAuthEnv: mocks.resolveAuthEnvMock,
    },
  },
}));

const tempRoots: string[] = [];

describe("dedicated CLI catalog", () => {
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

  it("includes Claude-family alternate backends", () => {
    expect(getDedicatedCliIds()).toEqual([
      "claude",
      "claude-zai",
      "claude-kimi",
      "codex",
    ]);
  });

  it("parses --cli, --cli=, and FLEET_DEDICATED_CLI values", async () => {
    const env = createEnvWithBins();

    await expect(resolveDedicatedCliProfile(env, "/tmp", { cliId: "claude-zai" })).resolves.toMatchObject({
      id: "claude-zai",
    });
    await expect(resolveDedicatedCliProfile(env, "/tmp", { cliId: "claude-kimi" })).resolves.toMatchObject({
      id: "claude-kimi",
    });
    await expect(resolveDedicatedCliProfile({ ...env, FLEET_DEDICATED_CLI: "claude-zai" }, "/tmp")).resolves.toMatchObject({
      id: "claude-zai",
    });
  });

  it("shares Claude-family terminal and message policy", async () => {
    const env = createEnvWithBins();
    const claude = await resolveDedicatedCliProfile(env, "/tmp", { cliId: "claude" });
    const zai = await resolveDedicatedCliProfile(env, "/tmp", { cliId: "claude-zai" });
    const kimi = await resolveDedicatedCliProfile(env, "/tmp", { cliId: "claude-kimi" });

    expect(zai.terminalName).toBe(claude.terminalName);
    expect(kimi.terminalName).toBe(claude.terminalName);
    expect(zai.messagePolicy).toEqual(claude.messagePolicy);
    expect(kimi.messagePolicy).toEqual(claude.messagePolicy);
  });

  it("resolves variant auth env before profile creation succeeds", async () => {
    const env = createEnvWithBins();

    const profile = await resolveDedicatedCliProfile(env, "/tmp", { cliId: "claude-zai" });

    expect(mocks.resolveAuthEnvMock).toHaveBeenCalledWith("claude-zai");
    expect(profile.env.ANTHROPIC_AUTH_TOKEN).toBe("variant-token");
    expect(profile.env.ANTHROPIC_BASE_URL).toBe("https://example.invalid/anthropic");
  });

  it("fails before returning a variant profile when auth resolution fails", async () => {
    const env = createEnvWithBins();
    mocks.resolveAuthEnvMock.mockRejectedValue(new Error("Validation failed"));

    await expect(resolveDedicatedCliProfile(env, "/tmp", { cliId: "claude-kimi" })).rejects.toThrow("Validation failed");
  });

  it("does not mutate process.env while creating profiles", async () => {
    const env = createEnvWithBins();
    const before = { ...process.env };

    await resolveDedicatedCliProfile(env, "/tmp", { cliId: "claude-zai" });

    expect(process.env).toEqual(before);
  });

  it("forwards model values into dedicated CLI profile args", async () => {
    const env = createEnvWithBins();

    const profile = await resolveDedicatedCliProfile(env, "/tmp", { cliId: "codex", model: "gpt-5.2" });

    expect(profile.args).toContain("--model");
    expect(profile.args).toContain("gpt-5.2");
  });

  it("omits model args when no model is provided", async () => {
    const env = createEnvWithBins();

    const profile = await resolveDedicatedCliProfile(env, "/tmp", { cliId: "codex" });

    expect(profile.args).not.toContain("--model");
  });

  it("uses the Claude native injection builder for alternate backends", () => {
    expect(getDedicatedCliInjectionCapability("claude-zai")).toEqual({
      builderId: "claude-native",
      enabled: true,
    });
    expect(getDedicatedCliInjectionCapability("claude-kimi")).toEqual({
      builderId: "claude-native",
      enabled: true,
    });
  });
});

function createEnvWithBins(): NodeJS.ProcessEnv {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-dedicated-cli-"));
  tempRoots.push(tempRoot);
  fs.writeFileSync(path.join(tempRoot, "claude"), "");
  fs.writeFileSync(path.join(tempRoot, "codex"), "");
  return {
    PATH: tempRoot,
  };
}
