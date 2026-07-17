import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentCliInjectionCapability,
  getAgentCliIds,
  parseAgentCliId,
  resolveAgentCliProfile,
} from "@dotobokuri/fleet-admiral";

const tempRoots: string[] = [];

describe("agent CLI catalog", () => {
  afterEach(() => {
    for (const tempRoot of tempRoots.splice(0)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("includes dedicated Agent CLI profiles", () => {
    expect(getAgentCliIds()).toEqual([
      "claude",
      "claude-kimi",
      "codex",
    ]);
  });

  it("parses --cli, --cli=, and FLEET_AGENT_CLI values", async () => {
    const env = createEnvWithBins();

    await expect(resolveAgentCliProfile(env, "/tmp", { cliId: "codex" })).resolves.toMatchObject({
      id: "codex",
    });
    await expect(resolveAgentCliProfile({ ...env, FLEET_AGENT_CLI: "codex" }, "/tmp")).resolves.toMatchObject({
      id: "codex",
    });
  });

  it("rejects inherited object keys as CLI IDs", () => {
    for (const cliId of ["cursor", "toString", "constructor", "__proto__"]) {
      expect(() => parseAgentCliId(cliId)).toThrow(`Unsupported agent CLI "${cliId}"`);
    }
  });

  it("shares Claude terminal and message policy", async () => {
    const env = createEnvWithBins();
    const claude = await resolveAgentCliProfile(env, "/tmp", { cliId: "claude" });

    expect(claude.terminalName).toBe("xterm-256color");
    expect(claude.messagePolicy).toEqual({
      bracketedPaste: true,
      lineTerminator: "\r",
      multilineStrategy: "paste-mode",
    });
  });

  it("launches Kimi through Claude Code with a Fleet-owned API key", async () => {
    const env = { ...createEnvWithBins(), ANTHROPIC_AUTH_TOKEN: "anthropic-secret" };
    const profile = await resolveAgentCliProfile(env, "/tmp", {
      cliId: "claude-kimi",
      authService: {
        getApiKey: async () => "kimi-secret",
      },
    });

    expect(profile).toMatchObject({
      id: "claude-kimi",
      label: "Kimi (Claude Code)",
      env: {
        ANTHROPIC_API_KEY: "kimi-secret",
        ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/",
        ANTHROPIC_MODEL: "kimi-for-coding",
      },
    });
    expect(profile.bin).toContain("claude");
    expect(profile.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
    expect(profile.messagePolicy).toEqual({
      bracketedPaste: true,
      lineTerminator: "\r",
      multilineStrategy: "paste-mode",
    });
  });

  it("enables the Codex ConPTY paste-burst workaround", async () => {
    const env = createEnvWithBins();
    const codex = await resolveAgentCliProfile(env, "/tmp", { cliId: "codex" });

    expect(codex.messagePolicy).toEqual({
      bracketedPaste: true,
      conptyPasteBurst: true,
      lineTerminator: "\r",
      multilineStrategy: "paste-mode",
    });
  });

  it("does not mutate process.env while creating profiles", async () => {
    const env = createEnvWithBins();
    const before = { ...process.env };

    await resolveAgentCliProfile(env, "/tmp", { cliId: "claude" });

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
  for (const bin of ["claude", "codex"]) {
    const binPath = path.join(tempRoot, bin);
    fs.writeFileSync(binPath, "");
    fs.chmodSync(binPath, 0o755);
  }
  return {
    PATH: tempRoot,
  };
}
