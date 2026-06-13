import crypto from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSystemPromptBuilder } from "@dotobokuri/fleet-admiral";
import { createCarrierRuntime } from "@dotobokuri/fleet-carriers";
import {
  executorMcpRuntimeProviderRuntime,
  executorPortRuntime,
} from "@dotobokuri/core-agent";
import { buildClaudeNativeArgs } from "../src/agent-cli/builders/claude.js";
import { buildCodexNativeArgs } from "../src/agent-cli/builders/codex.js";
import { buildFleetHookCommand, injectAgentCliProfile } from "../src/agent-cli/injection.js";
import type { AgentCliInjectionContext } from "../src/agent-cli/types.js";
import type { CodexPluginRegistrationCommand } from "../src/agent-cli/plugin/types.js";
import { createGatewayDedicatedSessionManager } from "../src/runtime/gateway.js";
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
const CHRONICLE_ONLY_WIKI_TOOL_IDS = [
  "wiki_drydock",
  "wiki_ingest",
  "wiki_patch_edit",
  "wiki_compile_source",
  "wiki_query",
] as const;
const CODEX_FLEET_PROFILE_MARKER = "# Fleet-managed Codex session profile";
const FLEET_PROFILE_NAME_PATTERN = /^fleet-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLUGIN_ASSETS_DIR = path.resolve("assets");
const TEST_HOOK_ENTRY = {
  entryPath: "/opt/fleet/dist/index.js",
  execPath: "/opt/node/bin/node",
};
const TEST_HOOK_EXEC = buildFleetHookCommand(TEST_HOOK_ENTRY);

describe("fleet-cli agent CLI MCP registration", () => {
  let lifecycle: FleetRuntimeLifecycle | undefined;

  afterEach(async () => {
    await lifecycle?.shutdown();
    lifecycle = undefined;
  });

  it("exposes carrier and wiki tools on one dedicated Fleet MCP server", async () => {
    lifecycle = createFleetRuntimeLifecycle();
    const runtime = await lifecycle.start();
    const endpoint = await runtime.dedicatedMcpSession.getEndpoint();
    const tokens = await runtime.dedicatedMcpSession.issueSessionToken({
      label: "agent:test-wiki",
      cwd: process.cwd(),
    });
    const servers = endpoint.servers.map((server) => ({
      ...server,
      token: tokens.find((entry) => entry.name === server.name)?.token,
    }));
    const fleet = servers.find((server) => server.name === "fleet");

    expect(servers.map((server) => server.name)).toEqual(["fleet"]);
    expect(tokens.map((entry) => entry.name)).toEqual(["fleet"]);
    expect(fleet?.token).toBeDefined();

    const fleetToolNames = await listMcpTools(fleet!.url, fleet!.token!);

    for (const toolId of EXPECTED_CARRIER_TOOL_IDS) {
      expect(fleetToolNames.has(toolId)).toBe(true);
    }
    for (const toolId of EXPECTED_WIKI_TOOL_IDS) {
      expect(fleetToolNames.has(toolId)).toBe(true);
    }
    expect(fleetToolNames.size).toBe(EXPECTED_CARRIER_TOOL_IDS.length + EXPECTED_WIKI_TOOL_IDS.length);
    expect(fleetToolNames.has("mcp__fleet__wiki_query")).toBe(false);
    expect(fleetToolNames.has("mcp__carrier__carrier_dispatch")).toBe(false);
    expect(fleetToolNames.has("mcp__wiki__wiki_query")).toBe(false);

    const executorPort = executorPortRuntime;
    expect(executorMcpRuntimeProviderRuntime.getExecutorMcpRouterRuntimes().map((entry) => entry.name)).toEqual(["fleet"]);
    expect(executorPort.getExecutorMcpTools("unknown", "chronicle")).toEqual([]);

    const chronicleTools = new Set(executorPort.getExecutorMcpTools("fleet", "chronicle").map((tool) => tool.id));
    const nonChronicleTools = new Set(executorPort.getExecutorMcpTools("fleet", "nimitz").map((tool) => tool.id));

    for (const toolId of CHRONICLE_ONLY_WIKI_TOOL_IDS) {
      expect(chronicleTools.has(toolId)).toBe(true);
      expect(nonChronicleTools.has(toolId)).toBe(false);
    }
    expect(chronicleTools.has("wiki_patch_queue")).toBe(false);
    expect(nonChronicleTools.has("wiki_patch_queue")).toBe(false);
    expect(nonChronicleTools.has("wiki_briefing")).toBe(true);
    expect(nonChronicleTools.has("wiki_orient")).toBe(true);
    expect(nonChronicleTools.has("wiki_read")).toBe(true);
    expect(nonChronicleTools.has("wiki_resolve")).toBe(true);
    expect(nonChronicleTools.has("carrier_jobs")).toBe(true);

    const systemPrompt = createSystemPromptBuilder({
      carrierRuntime: runtime.carrierRuntime,
    }).build(false);
    const roughTokens = Math.ceil(systemPrompt.length / 4);

    expect(systemPrompt).toContain('<fleet section="role">');
    expect(systemPrompt).toContain('<fleet section="persona">');
    expect(systemPrompt).toContain('<fleet section="roster">');
    expect(systemPrompt).toContain('<fleet section="protocol-gate">');
    expect(systemPrompt).not.toContain('<fleet section="protocol">');
    expect(systemPrompt).toContain('<fleet section="standing-orders"');
    expect(systemPrompt).not.toContain('<fleet section="tool-guide"');
    expect(roughTokens).toBeLessThanOrEqual(8_500);
  });

  it("builds provider args with plugin activation and spawn-time MCP injection", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-args-"));
    const context = makeAgentCliInjectionContext(root);
    try {
      expect(buildClaudeNativeArgs(context)).toEqual([
        "--system-prompt-file",
        context.systemPromptFile,
        "--plugin-dir",
        context.pluginRoots[0],
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            fleet: {
              type: "http",
              url: "http://127.0.0.1:1000/fleet",
              headers: { Authorization: "Bearer fleet-token" },
            },
          },
        }),
        "--dangerously-skip-permissions",
      ]);
      expect(buildCodexNativeArgs(context)).toEqual([
        "--enable",
        "plugins",
        "--enable",
        "child_agents_md",
        "--profile",
        context.codexProfileName,
        "-c",
        'approval_policy="never"',
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'mcp_servers.fleet.url="http://127.0.0.1:1000/fleet"',
        "-c",
        'mcp_servers.fleet.http_headers={"Authorization" = "Bearer fleet-token"}',
        "-c",
        "mcp_servers.fleet.tool_timeout_sec=1800",
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
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "fleet-token" }],
          releaseSessionToken,
        } as never,
        onCleanup: (cleanup) => cleanups.push(cleanup),
        pluginRootDir: rootDir,
        pluginAssetsDir: PLUGIN_ASSETS_DIR,
        pluginEntry: TEST_HOOK_ENTRY,
      });
      const pluginRoots = pluginDirArgs(profile.args);
      const pluginRoot = path.join(rootDir, "marketplace", "plugins", "fleet");
      const systemPromptFile = argValue(profile.args, "--system-prompt-file");

      expect(pluginRoots).toEqual([pluginRoot]);
      expect(systemPromptFile).toBeDefined();
      expect(readFileSync(systemPromptFile!, "utf8")).toBe("private fleet prompt");
      expect(readJson(path.join(pluginRoot, "hooks", "hooks.json"))).toMatchObject({
        hooks: {
          SessionStart: [{
            hooks: [{
              args: TEST_HOOK_EXEC.args,
              command: TEST_HOOK_EXEC.command,
              type: "command",
            }],
          }],
        },
      });
      expect(existsSync(path.join(pluginRoot, ".mcp.json"))).toBe(false);
      expect(readFileSync(path.join(pluginRoot, "skills", "fleet-protocol-standard", "SKILL.md"), "utf8")).toContain("name: fleet-protocol-standard");
      const renderedArgs = profile.args.join(" ");
      expect(renderedArgs).toContain("fleet-token");
      expect(Object.values(profile.env)).not.toContain("fleet-token");

      profile.cleanup?.();
      for (const cleanup of cleanups) {
        cleanup();
      }

      expect(existsSync(pluginRoot)).toBe(true);
      expect(existsSync(systemPromptFile!)).toBe(false);
      expect(releaseSessionToken).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("registers Codex plugin through the resolved Codex CLI before launch args are returned", async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-root-"));
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "fleet-codex-home-"));
    const staleProfilePath = path.join(codexHome, "fleet-00000000-0000-4000-8000-000000000000.config.toml");
    const freshProfilePath = path.join(codexHome, "fleet-00000000-0000-4000-8000-000000000001.config.toml");
    const userFleetProfilePath = path.join(codexHome, "fleet.config.toml");
    const commands: string[] = [];
    const codexState = {
      installed: new Set<string>(),
      marketplaceRoot: undefined as string | undefined,
    };
    const releaseSessionToken = vi.fn();
    try {
      writeFileSync(staleProfilePath, `${CODEX_FLEET_PROFILE_MARKER}\nold = true\n`, { encoding: "utf8" });
      writeFileSync(freshProfilePath, `${CODEX_FLEET_PROFILE_MARKER}\nfresh = true\n`, { encoding: "utf8" });
      writeFileSync(userFleetProfilePath, "user = true\n", { encoding: "utf8" });
      const staleMtime = new Date(Date.now() - (25 * 60 * 60 * 1000));
      utimesSync(staleProfilePath, staleMtime, staleMtime);
      const profile = await injectAgentCliProfile({
        args: ["--no-alt-screen"],
        bin: "/usr/local/bin/codex",
        cwd: process.cwd(),
        env: { CODEX_HOME: codexHome, PATH: process.env.PATH ?? "" },
        id: "codex",
        label: "Codex",
        terminalName: "xterm-256color",
      }, {
        buildSystemPrompt: () => "private fleet prompt",
        carrierRuntime: createCarrierRuntime(),
        codexCommandRunner: (command: CodexPluginRegistrationCommand) => {
          expect(command.bin).toBe("/usr/local/bin/codex");
          const line = command.args.join(" ");
          commands.push(line);
	          if (line === "plugin marketplace list") {
	            return {
	              status: 0,
	              stderr: "",
	              stdout: codexState.marketplaceRoot === undefined ? "" : `fleet-harness ${codexState.marketplaceRoot}\n`,
	            };
	          }
          if (line.startsWith("plugin marketplace add ")) {
            codexState.marketplaceRoot = line.slice("plugin marketplace add ".length);
            return { status: 0, stderr: "", stdout: "" };
          }
          if (line === "plugin list") {
	            return {
	              status: 0,
	              stderr: "",
	              stdout: [...codexState.installed].map((pluginName) => `${pluginName}@fleet-harness  installed, enabled`).join("\n"),
	            };
	          }
	          if (line.startsWith("plugin add ") && line.endsWith(" -m fleet-harness")) {
	            codexState.installed.add(line.slice("plugin add ".length, line.length - " -m fleet-harness".length));
	            return { status: 0, stderr: "", stdout: "" };
	          }
          return { status: 0, stderr: "", stdout: "" };
        },
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "fleet-token" }],
          releaseSessionToken,
        } as never,
        pluginRootDir: rootDir,
        pluginAssetsDir: PLUGIN_ASSETS_DIR,
      });

      expect(commands).toEqual([
	        "plugin marketplace list",
	        `plugin marketplace add ${path.join(rootDir, "marketplace")}`,
	        "plugin list",
	        "plugin add fleet -m fleet-harness",
	      ]);
      expect(profile.args).toContain("--enable");
      expect(profile.args).toContain("child_agents_md");
      expect(profile.args).toContain("--profile");
      const profileName = argValue(profile.args, "--profile");
      expect(profileName).toMatch(FLEET_PROFILE_NAME_PATTERN);
      const profilePath = path.join(codexHome, `${profileName}.config.toml`);
      expect(profile.args).not.toContain("plugin_hooks");
      expect(profile.args).not.toContain("--dangerously-bypass-hook-trust");
      expect(readFileSync(profilePath, "utf8")).toBe([
        CODEX_FLEET_PROFILE_MARKER,
        'developer_instructions = """',
        "private fleet prompt",
        '"""',
        "",
        '[plugins."fleet@fleet-harness"]',
        "enabled = true",
        "",
      ].join("\n"));
      expect(existsSync(staleProfilePath)).toBe(false);
      expect(existsSync(freshProfilePath)).toBe(true);
      expect(existsSync(userFleetProfilePath)).toBe(true);
      profile.cleanup?.();
      expect(existsSync(profilePath)).toBe(false);
      expect(releaseSessionToken).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("enables every rendered Codex plugin in the Fleet session profile", async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-root-"));
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "fleet-codex-home-"));
    const cwd = mkdtempSync(path.join(os.tmpdir(), "fleet-project-cwd-"));
    const commands: string[] = [];
    const codexState = {
      installed: new Set<string>(),
      marketplaces: new Map<string, string>(),
    };
    try {
      mkdirSync(path.join(cwd, ".fleet", "skills", "project-skill"), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(cwd, ".fleet", "skills", "project-skill", "SKILL.md"), "Project skill", { encoding: "utf8" });
      const projectMarketplaceRoot = path.resolve(cwd, ".fleet");
      const projectMarketplaceName = projectMarketplaceNameForCwd(cwd);

      const profile = await injectAgentCliProfile({
        args: [],
        bin: "/usr/local/bin/codex",
        cwd,
        env: { CODEX_HOME: codexHome },
        id: "codex",
        label: "Codex",
        terminalName: "xterm-256color",
      }, {
        buildSystemPrompt: () => "private fleet prompt",
        carrierRuntime: createCarrierRuntime(),
        codexCommandRunner: (command: CodexPluginRegistrationCommand) => {
          const line = command.args.join(" ");
          commands.push(line);
          if (line === "plugin marketplace list") {
            return {
              status: 0,
              stderr: "",
              stdout: [...codexState.marketplaces].map(([name, root]) => `${name} ${root}`).join("\n"),
            };
          }
          if (line.startsWith("plugin marketplace add ")) {
            const marketplaceRoot = line.slice("plugin marketplace add ".length);
            const marketplaceName = marketplaceRoot === projectMarketplaceRoot ? projectMarketplaceName : "fleet-harness";
            codexState.marketplaces.set(marketplaceName, marketplaceRoot);
            return { status: 0, stderr: "", stdout: "" };
          }
          if (line === "plugin list") {
            return {
              status: 0,
              stderr: "",
              stdout: [...codexState.installed].map((pluginKey) => `${pluginKey}  installed, enabled`).join("\n"),
            };
          }
          const addMatch = line.match(/^plugin add (\S+) -m (\S+)$/);
          if (addMatch) {
            codexState.installed.add(`${addMatch[1]}@${addMatch[2]}`);
            return { status: 0, stderr: "", stdout: "" };
          }
          return { status: 0, stderr: "", stdout: "" };
        },
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "fleet-token" }],
          releaseSessionToken: vi.fn(),
        } as never,
        pluginRootDir: rootDir,
        pluginAssetsDir: PLUGIN_ASSETS_DIR,
      });

      expect(commands).toEqual([
        "plugin marketplace list",
        `plugin marketplace add ${path.join(rootDir, "marketplace")}`,
        "plugin list",
        "plugin add fleet -m fleet-harness",
        "plugin marketplace list",
        `plugin marketplace add ${projectMarketplaceRoot}`,
        "plugin list",
        `plugin add fleet-project -m ${projectMarketplaceName}`,
      ]);
      expect(codexState.installed).toEqual(new Set(["fleet@fleet-harness", `fleet-project@${projectMarketplaceName}`]));
      const profileName = argValue(profile.args, "--profile");
      expect(profileName).toMatch(FLEET_PROFILE_NAME_PATTERN);
      expect(readFileSync(path.join(codexHome, `${profileName}.config.toml`), "utf8")).toBe([
        CODEX_FLEET_PROFILE_MARKER,
        'developer_instructions = """',
        "private fleet prompt",
        '"""',
        "",
        '[plugins."fleet@fleet-harness"]',
        "enabled = true",
        "",
        `[plugins."fleet-project@${projectMarketplaceName}"]`,
        "enabled = true",
        "",
      ].join("\n"));
      profile.cleanup?.();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("continues Codex launch profile injection when plugin registration fails", async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-root-"));
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "fleet-codex-home-"));
    try {
      const profile = await injectAgentCliProfile({
        args: [],
        bin: "/usr/local/bin/codex",
        cwd: process.cwd(),
        env: { CODEX_HOME: codexHome },
        id: "codex",
        label: "Codex",
        terminalName: "xterm-256color",
      }, {
        buildSystemPrompt: () => "private fleet prompt",
        carrierRuntime: createCarrierRuntime(),
        codexCommandRunner: () => ({ status: 1, stderr: "codex plugin exploded", stdout: "" }),
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "fleet-token" }],
          releaseSessionToken: vi.fn(),
        } as never,
        pluginRootDir: rootDir,
        pluginAssetsDir: PLUGIN_ASSETS_DIR,
      });

      expect(profile.args).toContain("child_agents_md");
      const profileName = argValue(profile.args, "--profile");
      expect(profileName).toMatch(FLEET_PROFILE_NAME_PATTERN);
      const profilePath = path.join(codexHome, `${profileName}.config.toml`);
      expect(readFileSync(profilePath, "utf8")).toBe([
        CODEX_FLEET_PROFILE_MARKER,
        'developer_instructions = """',
        "private fleet prompt",
        '"""',
        "",
        '[plugins."fleet@fleet-harness"]',
        "enabled = true",
        "",
      ].join("\n"));
      expect(profile.launchWarnings?.[0]).toContain("codex plugin marketplace list failed");
      expect(profile.launchWarnings?.[0]).toContain("codex plugin exploded");
      profile.cleanup?.();
      expect(existsSync(profilePath)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("reconnects the gateway call consumer without executing duplicate calls", async () => {
    let ensureCount = 0;
    let registerCount = 0;
    let callStreamCount = 0;
    const resultPosts: string[] = [];
    const invoke = vi.fn(async () => ({ content: [{ type: "text", text: "pong" }], isError: false }));
    const manager = createGatewayDedicatedSessionManager({
      name: "fleet",
      lifecycle: {
        ensureDaemon: async () => {
          ensureCount += 1;
          return "http://127.0.0.1:37283/mcp";
        },
      } as never,
      readBootstrapToken: async () => "bootstrap",
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      registry: {
        getAllAgentTools: () => [{ id: "ping", description: "Ping", parameters: {} }],
        invoke,
      } as never,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url);
        if (target.endsWith("/admin/register")) {
          registerCount += 1;
          return jsonResponse({
            tenantId: `tenant-${registerCount}`,
            sessionId: `session-${registerCount}`,
            endpoint: "http://127.0.0.1:37283/mcp",
            controlToken: `control-${registerCount}`,
            sessionToken: `session-token-${registerCount}`,
            observerToken: `observer-${registerCount}`,
          });
        }
        if (target.endsWith("/control/calls")) {
          callStreamCount += 1;
          return new Response(sseStream({
            callId: "call-1",
            sessionId: `session-${callStreamCount}`,
            toolName: "ping",
            args: {},
            createdAt: Date.now(),
          }, callStreamCount === 1), { status: 200 });
        }
        if (target.includes("/control/results/")) {
          resultPosts.push(JSON.parse(String(init?.body)).sessionId as string);
          return jsonResponse({ ok: true });
        }
        if (target.endsWith("/control/release")) {
          return jsonResponse({ ok: true });
        }
        return jsonResponse({ error: "unexpected" }, 500);
      }) as typeof fetch,
    });

    await manager.issueSessionToken({ label: "agent:test-reconnect", cwd: "/tmp" });
    await waitFor(() => registerCount >= 2 && resultPosts.length >= 1);
    manager.releaseSessionToken("agent:test-reconnect");

    expect(ensureCount).toBeGreaterThanOrEqual(2);
    expect(registerCount).toBeGreaterThanOrEqual(2);
    expect(resultPosts).toEqual(["session-1"]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(manager.getConnectionState().state).toBe("ready");
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

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseStream(body: unknown, close = true): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(body)}\n\n`));
      if (close) controller.close();
    },
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 1_000) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeAgentCliInjectionContext(root: string): AgentCliInjectionContext {
  const pluginRoot = path.join(root, "marketplace", "plugins", "fleet");
  mkdirSync(pluginRoot, { recursive: true, mode: 0o700 });
  return {
    cliId: "codex",
    mcpServers: [
      { name: "fleet", endpointUrl: "http://127.0.0.1:1000/fleet", bearerToken: "fleet-token" },
    ],
    pluginRoot,
    pluginRoots: [pluginRoot],
    codexProfileName: "fleet-00000000-0000-4000-8000-000000000000",
    replaceSystemPrompt: true,
    systemPromptFile: path.join(root, "system-prompt.md"),
  };
}

function projectMarketplaceNameForCwd(cwd: string): string {
  const hash = crypto.createHash("sha256").update(path.resolve(cwd, ".fleet")).digest("hex").slice(0, 12);
  return `fleet-project-${hash}`;
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function pluginDirArgs(args: readonly string[]): string[] {
  const pluginDirs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--plugin-dir") {
      pluginDirs.push(args[index + 1]!);
    }
  }
  return pluginDirs;
}
