import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { findGatewayModel } from "@dotobokuri/core-ai-gateway";
import { afterEach, describe, expect, it } from "vitest";

import {
  GENERAL_PURPOSE_AGENT_PROMPT,
  buildGatewayCustomAgents,
  buildGatewayDisallowedAgentTools,
  injectAgentCliProfile,
  resolveAgentCliProfile,
  toGatewayAgentName,
  type AgentCliProfile,
  type FleetHookExec,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

describe("claude-gateway custom agents", () => {
  it("builds legacy and current deny entries for the built-in agents", () => {
    expect(buildGatewayDisallowedAgentTools()).toEqual([
      "Task(claude)",
      "Agent(claude)",
      "Task(Explore)",
      "Agent(Explore)",
      "Task(general-purpose)",
      "Agent(general-purpose)",
      "Task(Plan)",
      "Agent(Plan)",
    ]);
  });

  it("expands exposed models into claude-gateway-- agents with GP prompt", () => {
    const model = requireGatewayModel("cursor--claude-opus-5");
    const agents = buildGatewayCustomAgents([model]);
    const names = Object.keys(agents);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const agent = agents[name]!;
      expect(name.startsWith("gw-")).toBe(false);
      expect(name.startsWith("cursor-")).toBe(true);
      expect(agent.model.startsWith("claude-gateway--")).toBe(true);
      expect(agent.prompt).toBe(GENERAL_PURPOSE_AGENT_PROMPT);
      expect(agent.description).toContain("gateway_models");
    }
    const withEffort = names.find((name) => name.endsWith("-high"));
    expect(withEffort).toBeDefined();
    expect(agents[withEffort!]!.effort).toBe("high");
    expect(toGatewayAgentName(agents[withEffort!]!.model, "high")).toBe(withEffort);
  });

  it("injects --disallowedTools and --agents only for claude-gateway", async () => {
    const root = createTempRoot("fleet-admiral-gateway-agents-");
    const model = requireGatewayModel("cursor--claude-opus-5");
    const gateway = baseProfile("claude-gateway", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });
    const classic = baseProfile("claude", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });

    const injectedGateway = await injectAgentCliProfile(gateway, baseInjectOptions(root, {
      gatewayExposedModels: [model],
    }));
    const injectedClassic = await injectAgentCliProfile(classic, baseInjectOptions(root, {
      gatewayExposedModels: [model],
    }));

    const disallowedIndex = injectedGateway.args.indexOf("--disallowedTools");
    expect(disallowedIndex).toBeGreaterThanOrEqual(0);
    expect(injectedGateway.args.slice(disallowedIndex + 1, disallowedIndex + 9)).toEqual([
      "Task(claude)",
      "Agent(claude)",
      "Task(Explore)",
      "Agent(Explore)",
      "Task(general-purpose)",
      "Agent(general-purpose)",
      "Task(Plan)",
      "Agent(Plan)",
    ]);

    const agentsIndex = injectedGateway.args.indexOf("--agents");
    expect(agentsIndex).toBeGreaterThanOrEqual(0);
    const agentsJson = injectedGateway.args[agentsIndex + 1];
    expect(typeof agentsJson).toBe("string");
    const agents = JSON.parse(agentsJson as string) as Record<string, {
      model: string;
      prompt: string;
      effort?: string;
    }>;
    expect(Object.keys(agents).length).toBeGreaterThan(0);
    for (const agent of Object.values(agents)) {
      expect(agent.model.startsWith("claude-gateway--")).toBe(true);
      expect(agent.prompt).toBe(GENERAL_PURPOSE_AGENT_PROMPT);
    }

    expect(injectedClassic.args).not.toContain("--disallowedTools");
    expect(injectedClassic.args).not.toContain("--agents");

    injectedGateway.cleanup?.();
    injectedClassic.cleanup?.();
  });

  it("still disables built-ins when no gateway models are exposed", async () => {
    const root = createTempRoot("fleet-admiral-gateway-agents-empty-");
    const profile = baseProfile("claude-gateway", {
      args: [],
      cwd: root,
      env: { HOME: root },
    });
    const injected = await injectAgentCliProfile(profile, baseInjectOptions(root));
    expect(injected.args).toContain("--disallowedTools");
    expect(injected.args).not.toContain("--agents");
    injected.cleanup?.();
  });
});

function requireGatewayModel(id: string) {
  const model = findGatewayModel(id);
  if (!model) throw new Error(`missing gateway model fixture: ${id}`);
  return model;
}

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

function baseInjectOptions(
  root: string,
  overrides: {
    readonly gatewayExposedModels?: Parameters<typeof injectAgentCliProfile>[1]["gatewayExposedModels"];
    readonly captureSessionHookExec?: FleetHookExec;
  } = {},
): Parameters<typeof injectAgentCliProfile>[1] {
  return {
    buildSystemPrompt: () => "Fleet doctrine",
    codexCommandRunner: () => ({ status: 0, stderr: "", stdout: "" }),
    dataDir: path.join(root, "data"),
    dedicatedMcpSession: {
      async getEndpoint() {
        return { servers: [{ name: "fleet", url: "http://127.0.0.1:48123/mcp" }] };
      },
      issueSessionToken() {
        return [{ name: "fleet", token: "token-123" }];
      },
      releaseSessionToken() {},
    },
    ...(overrides.captureSessionHookExec ? { captureSessionHookExec: overrides.captureSessionHookExec } : {}),
    ...(overrides.gatewayExposedModels ? { gatewayExposedModels: overrides.gatewayExposedModels } : {}),
    withMarketplaceLock: async (_target, fn) => fn(),
  };
}
