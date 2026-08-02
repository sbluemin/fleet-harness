import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentCliIds,
  getAgentCliMetadata,
  injectAgentCliProfile,
  resolveAgentCliProfile,
  type AgentCliProfile,
  type FleetHookExec,
} from "../src/index.js";
import { createAgentCliPlugin } from "../src/agent-cli/plugin/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claude-native profile", () => {
  it("resolves as Claude Code with the Native label", async () => {
    const profile = await resolveAgentCliProfile({
      CLAUDE_BIN: process.execPath,
    }, "/tmp", {
      cliId: "claude-native",
    });

    expect(profile).toMatchObject({
      bin: process.execPath,
      id: "claude-native",
      label: "Claude (Native)",
      renameCommand: "/rename",
    });
  });

  it("lists Native ahead of Classic in the console-only catalog", () => {
    const ids = getAgentCliIds({ includeConsoleOnly: true });
    expect(ids.indexOf("claude-native")).toBeLessThan(ids.indexOf("claude"));
    expect(ids).toContain("claude-gateway");
    expect(getAgentCliIds()).not.toContain("claude-native");
    expect(getAgentCliMetadata(ids).find((entry) => entry.id === "claude-native")?.label).toBe("Claude (Native)");
  });
});

describe("claude-native injection", () => {
  it("omits the Admiral system prompt and keeps plugin/MCP args", async () => {
    const root = createTempRoot("fleet-admiral-native-inject-");
    const profile = baseProfile("claude-native", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });
    let builtPrompt = false;
    const injected = await injectAgentCliProfile(profile, {
      buildSystemPrompt: () => {
        builtPrompt = true;
        return "Fleet doctrine";
      },
      codexCommandRunner: () => ({ status: 0, stderr: "", stdout: "" }),
      dataDir: path.join(root, "data"),
      dedicatedMcpSession: {
        async getEndpoint() {
          return { servers: [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }] };
        },
        issueSessionToken(request) {
          expect(request.includeTool?.("carrier_dispatch")).toBe(false);
          expect(request.includeTool?.("carrier_jobs")).toBe(false);
          expect(request.includeTool?.("gateway_models")).toBe(false);
          expect(request.includeTool?.("wiki_read")).toBe(true);
          return [{ name: "fleet", token: "token-123" }];
        },
        releaseSessionToken() {},
      },
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    expect(builtPrompt).toBe(false);
    expect(injected.args).not.toContain("--append-system-prompt-file");
    expect(injected.args).toContain("--plugin-dir");
    expect(injected.args).toContain("--mcp-config");
    expect(injected.args).toContain("--dangerously-skip-permissions");
    expect(injected.args).not.toContain("--agents");

    const mcpIndex = injected.args.indexOf("--mcp-config");
    const mcpJson = JSON.parse(injected.args[mcpIndex + 1] as string) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(Object.keys(mcpJson.mcpServers)).toEqual(["fleet"]);
    injected.cleanup?.();
  });

  it("renders wiki-operations and console hooks only under fleet-native", async () => {
    const root = createTempRoot("fleet-admiral-native-plugin-");
    const plugin = await createAgentCliPlugin({
      cliId: "claude-native",
      cwd: path.join(root, "project"),
      dataDir: path.join(root, "data"),
      captureSessionHookExec: hookExec("node", ["console.js", "hook", "capture-session", "claude"]),
      turnStartHookExec: hookExec("node", ["console.js", "hook", "turn-start"]),
      turnEndHookExec: hookExec("node", ["console.js", "hook", "turn-end"]),
      inputWaitingHookExec: hookExec("node", ["console.js", "hook", "attention"]),
      autoNameHookExec: hookExec("node", ["console.js", "hook", "auto-name"]),
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    expect(plugin.pluginRoot).toBe(path.join(root, "data", "marketplace", "plugins", "fleet-native"));
    const skillsRoot = path.join(plugin.pluginRoot, "skills");
    expect(existsSync(path.join(skillsRoot, "wiki-operations", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(skillsRoot, "carrier-operations", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(skillsRoot, "assumption-audit", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(skillsRoot, "workflow", "SKILL.md"))).toBe(false);
    for (const mode of ["protocol-baseline", "protocol-frontline", "protocol-midline", "protocol-redline"]) {
      expect(existsSync(path.join(skillsRoot, mode, "SKILL.md"))).toBe(false);
    }
    const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(skillNames).toEqual(["wiki-operations"]);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"))).toBe(true);
  });
});

function createTempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

function baseProfile(
  id: AgentCliProfile["id"],
  options: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
  },
): AgentCliProfile {
  return {
    args: options.args,
    bin: id,
    cwd: options.cwd,
    env: options.env,
    id,
    label: id,
    terminalName: "xterm-256color",
  };
}

function hookExec(command: string, args: readonly string[]): FleetHookExec {
  return { command, args };
}
