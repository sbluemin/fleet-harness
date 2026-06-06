import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSystemPromptBuilder } from "@dotobokuri/fleet-admiral";
import { createCarrierRuntime } from "@dotobokuri/fleet-carriers";
import { buildClaudeNativeArgs } from "../src/agent-cli/builders/claude.js";
import { buildCodexNativeArgs } from "../src/agent-cli/builders/codex.js";
import { injectAgentCliProfile } from "../src/agent-cli/injection.js";
import type { AgentCliInjectionContext } from "../src/agent-cli/types.js";
import type { CodexPluginRegistrationCommand } from "../src/agent-cli/session-plugin/types.js";
import { createFleetRuntimeLifecycle, type FleetRuntimeLifecycle } from "../src/runtime/runtime.js";

interface McpToolListResponse {
  readonly result?: {
    readonly tools?: ReadonlyArray<{ readonly name?: string }>;
  };
}

const EXPECTED_WIKI_TOOL_IDS = [
  "wiki_briefing",
  "wiki_drydock",
  "wiki_ingest",
  "wiki_orient",
  "wiki_patch_edit",
  "wiki_patch_queue",
  "wiki_compile_source",
  "wiki_query",
  "wiki_read",
  "wiki_resolve",
] as const;

const EXPECTED_CARRIER_TOOL_IDS = [
  "carrier_dispatch",
  "carrier_jobs",
] as const;

describe("fleet-cli agent CLI MCP registration", () => {
  let lifecycle: FleetRuntimeLifecycle | undefined;

  afterEach(async () => {
    await lifecycle?.shutdown();
    lifecycle = undefined;
  });

  it("exposes carrier and wiki tools on separate dedicated MCP servers", async () => {
    lifecycle = createFleetRuntimeLifecycle();
    const runtime = await lifecycle.start();
    const endpoint = await runtime.dedicatedMcpSession.getEndpoint();
    const tokens = runtime.dedicatedMcpSession.issueSessionToken({
      label: "agent:test-wiki",
      cwd: process.cwd(),
    });
    const servers = endpoint.servers.map((server) => ({
      ...server,
      token: tokens.find((entry) => entry.name === server.name)?.token,
    }));
    const carriers = servers.find((server) => server.name === "fleet-carriers");
    const wiki = servers.find((server) => server.name === "fleet-wiki");

    expect(carriers?.token).toBeDefined();
    expect(wiki?.token).toBeDefined();
    expect(carriers?.token).not.toEqual(wiki?.token);

    const carrierToolNames = await listMcpTools(carriers!.url, carriers!.token!);
    const wikiToolNames = await listMcpTools(wiki!.url, wiki!.token!);

    expect([...carrierToolNames].sort()).toEqual([...EXPECTED_CARRIER_TOOL_IDS].sort());
    for (const toolId of EXPECTED_WIKI_TOOL_IDS) {
      expect(wikiToolNames.has(toolId)).toBe(true);
    }
    expect(wikiToolNames.size).toBe(EXPECTED_WIKI_TOOL_IDS.length);
    expect(carrierToolNames.has("wiki_briefing")).toBe(false);
    expect(wikiToolNames.has("carrier_dispatch")).toBe(false);

    const systemPrompt = createSystemPromptBuilder({
      carrierRuntime: runtime.carrierRuntime,
      mcpRegistry: runtime.mcpRegistry,
    }).build(false);
    expect(systemPrompt).toContain('<fleet section="tool-guide" tool="carrier_dispatch">');
    expect(systemPrompt).toContain('<fleet section="tool-guide" tool="wiki_query">');
  });

  it("builds provider args with session plugin activation only", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-args-"));
    const context = makeAgentCliInjectionContext(root);
    try {
      expect(buildClaudeNativeArgs(context)).toEqual([
        "--plugin-dir",
        context.pluginRoot,
        "--dangerously-skip-permissions",
      ]);
      expect(buildCodexNativeArgs(context)).toEqual([
        "--enable",
        "plugins",
        "--enable",
        "plugin_hooks",
        "--enable",
        "child_agents_md",
        "--dangerously-bypass-hook-trust",
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="danger-full-access"',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("injects rendered plugin paths, child env, Claude agents, and cleanup", async () => {
    const cleanups: Array<() => void> = [];
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-root-"));
    const releaseSessionToken = vi.fn();
    try {
      const profile = await injectAgentCliProfile({
        args: [],
        bin: "claude",
        cwd: process.cwd(),
        env: {},
        id: "claude",
        label: "Claude",
        terminalName: "claude",
      }, {
        buildSystemPrompt: () => "private fleet prompt",
        carrierRuntime: createCarrierRuntime(),
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet-carriers", url: "http://127.0.0.1:1000/carriers" }],
          }),
          issueSessionToken: () => [{ name: "fleet-carriers", token: "carriers-token" }],
          releaseSessionToken,
        } as never,
        onCleanup: (cleanup) => cleanups.push(cleanup),
        sessionPluginRootDir: rootDir,
      });
      const pluginRoot = profile.args[profile.args.indexOf("--plugin-dir") + 1]!;

      expect(readFileSync(path.join(pluginRoot, "hooks", "session-start.mjs"), "utf8")).toContain("private fleet prompt");
      expect(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).not.toContain("carriers-token");
      expect(readFileSync(path.join(pluginRoot, "skills", "fleet-usage", "SKILL.md"), "utf8")).toContain("name: fleet-usage");
      expect(Object.values(profile.env)).toContain("carriers-token");

      profile.cleanup?.();
      for (const cleanup of cleanups) {
        cleanup();
      }

      expect(existsSync(pluginRoot)).toBe(true);
      expect(releaseSessionToken).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("registers Codex plugin through the resolved Codex CLI before launch args are returned", async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-root-"));
    const commands: string[] = [];
    const releaseSessionToken = vi.fn();
    try {
      const profile = await injectAgentCliProfile({
        args: ["--no-alt-screen"],
        bin: "/usr/local/bin/codex",
        cwd: process.cwd(),
        env: { PATH: process.env.PATH ?? "" },
        id: "codex",
        label: "Codex",
        terminalName: "xterm-256color",
      }, {
        buildSystemPrompt: () => "private fleet prompt",
        carrierRuntime: createCarrierRuntime(),
        codexCommandRunner: (command: CodexPluginRegistrationCommand) => {
          expect(command.bin).toBe("/usr/local/bin/codex");
          commands.push(command.args.join(" "));
          if (command.args.join(" ") === "plugin marketplace list") {
            return { status: 0, stderr: "", stdout: "" };
          }
          if (command.args.join(" ") === "plugin list") {
            return { status: 0, stderr: "", stdout: "" };
          }
          return { status: 0, stderr: "", stdout: "" };
        },
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet-carriers", url: "http://127.0.0.1:1000/carriers" }],
          }),
          issueSessionToken: () => [{ name: "fleet-carriers", token: "carriers-token" }],
          releaseSessionToken,
        } as never,
        sessionPluginRootDir: rootDir,
      });

      expect(commands).toEqual([
        "plugin marketplace list",
        `plugin marketplace add ${path.join(rootDir, "plugins")}`,
        "plugin list",
        "plugin add fleet -m fleet",
      ]);
      expect(profile.args).toContain("--enable");
      expect(profile.args).toContain("child_agents_md");
      expect(profile.args).toContain("--dangerously-bypass-hook-trust");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("continues Codex launch profile injection when plugin registration fails", async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-root-"));
    try {
      const profile = await injectAgentCliProfile({
        args: [],
        bin: "/usr/local/bin/codex",
        cwd: process.cwd(),
        env: {},
        id: "codex",
        label: "Codex",
        terminalName: "xterm-256color",
      }, {
        buildSystemPrompt: () => "private fleet prompt",
        carrierRuntime: createCarrierRuntime(),
        codexCommandRunner: () => ({ status: 1, stderr: "codex plugin exploded", stdout: "" }),
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet-carriers", url: "http://127.0.0.1:1000/carriers" }],
          }),
          issueSessionToken: () => [{ name: "fleet-carriers", token: "carriers-token" }],
          releaseSessionToken: vi.fn(),
        } as never,
        sessionPluginRootDir: rootDir,
      });

      expect(profile.args).toContain("child_agents_md");
      expect(profile.launchWarnings?.[0]).toContain("codex plugin marketplace list failed");
      expect(profile.launchWarnings?.[0]).toContain("codex plugin exploded");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

async function listMcpTools(url: string, token: string): Promise<Set<string>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    }),
  });
  const body = await response.json() as McpToolListResponse;
  return new Set(body.result?.tools?.map((tool) => tool.name).filter((name): name is string => Boolean(name)));
}

function makeAgentCliInjectionContext(root: string): AgentCliInjectionContext {
  const pluginRoot = path.join(root, "plugins");
  mkdirSync(pluginRoot, { recursive: true, mode: 0o700 });
  return {
    cliId: "codex",
    pluginRoot,
  };
}
