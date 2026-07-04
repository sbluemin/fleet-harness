import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSystemPromptBuilder,
  injectAgentCliProfile,
  type CodexPluginRegistrationCommand,
} from "@dotobokuri/fleet-admiral";
import { createCarrierRuntime } from "@dotobokuri/fleet-carriers";
import {
  executorMcpRuntimeProviderRuntime,
  executorPortRuntime,
} from "@dotobokuri/core-agent";
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
const CODEX_FLEET_PROFILE_MARKER = "# Fleet-managed Codex profile";
const CODEX_LEGACY_FLEET_PROFILE_MARKER = "# Fleet-managed Codex session profile";
const FLEET_PROFILE_NAME = "fleet";
const FLEET_PROFILE_FILE_NAME = `${FLEET_PROFILE_NAME}.config.toml`;
const WITH_TEST_MARKETPLACE_LOCK = <T>(_target: string, fn: () => T): T => fn();

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
        dataDir: rootDir,
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "fleet-token" }],
          releaseSessionToken,
        } as never,
        onCleanup: (cleanup) => cleanups.push(cleanup),
        pluginRootDir: rootDir,
        withMarketplaceLock: WITH_TEST_MARKETPLACE_LOCK,
      });
      const pluginRoots = pluginDirArgs(profile.args);
      const pluginRoot = path.join(rootDir, "marketplace", "plugins", "fleet");
      const systemPromptFile = argValue(profile.args, "--append-system-prompt-file");

      expect(pluginRoots).toEqual([pluginRoot]);
      expect(systemPromptFile).toBeDefined();
      expect(readFileSync(systemPromptFile!, "utf8")).toBe("private fleet prompt");
      expect(existsSync(path.join(pluginRoot, ".mcp.json"))).toBe(false);
      expect(readFileSync(path.join(pluginRoot, "skills", "protocol-midline", "SKILL.md"), "utf8")).toContain("name: protocol-midline");
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
    const legacyProfilePath = path.join(codexHome, "fleet-00000000-0000-4000-8000-000000000000.config.toml");
    const legacyFreshProfilePath = path.join(codexHome, "fleet-00000000-0000-4000-8000-000000000001.config.toml");
    const fleetProfilePath = path.join(codexHome, FLEET_PROFILE_FILE_NAME);
    const commands: string[] = [];
    const codexState = {
      installed: new Set<string>(),
      marketplaceRoot: undefined as string | undefined,
    };
    const releaseSessionToken = vi.fn();
    try {
      writeFileSync(legacyProfilePath, `${CODEX_LEGACY_FLEET_PROFILE_MARKER}\nold = true\n`, { encoding: "utf8" });
      writeFileSync(legacyFreshProfilePath, `${CODEX_LEGACY_FLEET_PROFILE_MARKER}\nfresh = true\n`, { encoding: "utf8" });
      writeFileSync(fleetProfilePath, "user = true\n", { encoding: "utf8" });
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
        dataDir: rootDir,
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "fleet-token" }],
          releaseSessionToken,
        } as never,
        pluginRootDir: rootDir,
        withMarketplaceLock: WITH_TEST_MARKETPLACE_LOCK,
      });

      expect(commands).toEqual([
        "plugin marketplace list",
        "plugin list",
        "plugin marketplace list",
        `plugin marketplace add ${path.join(rootDir, "marketplace")}`,
        "plugin list",
        "plugin add fleet -m fleet-harness",
      ]);
      expect(profile.args).toContain("--enable");
      // codex 0.142.0에서 제거된 기능 플래그라 인자에 포함되면 "Unknown feature flag"로 기동 실패한다.
      expect(profile.args).not.toContain("child_agents_md");
      expect(profile.args).toContain("--profile");
      const profileName = argValue(profile.args, "--profile");
      expect(profileName).toBe(FLEET_PROFILE_NAME);
      expect(profile.args).not.toContain("plugin_hooks");
      expect(profile.args).not.toContain("--dangerously-bypass-hook-trust");
      expect(readFileSync(fleetProfilePath, "utf8")).toBe([
        CODEX_FLEET_PROFILE_MARKER,
        'developer_instructions = """',
        "private fleet prompt",
        '"""',
        "",
        "[features]",
        "hooks = true",
        "",
        '[plugins."fleet@fleet-harness"]',
        "enabled = true",
        "",
      ].join("\n"));
      expect(existsSync(legacyProfilePath)).toBe(false);
      expect(existsSync(legacyFreshProfilePath)).toBe(false);
      expect(existsSync(fleetProfilePath)).toBe(true);
      profile.cleanup?.();
      expect(existsSync(fleetProfilePath)).toBe(true);
      expect(releaseSessionToken).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("enables every rendered Codex plugin in the fixed Fleet profile", async () => {
    const rootDir = mkdtempSync(path.join(os.tmpdir(), "fleet-agent-root-"));
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "fleet-codex-home-"));
    const cwd = mkdtempSync(path.join(os.tmpdir(), "fleet-project-cwd-"));
    const commands: string[] = [];
    const codexState = {
      installed: new Set<string>(),
      marketplaces: new Map<string, string>(),
    };
    try {
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
            codexState.marketplaces.set("fleet-harness", marketplaceRoot);
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
        dataDir: rootDir,
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "fleet-token" }],
          releaseSessionToken: vi.fn(),
        } as never,
        pluginRootDir: rootDir,
        withMarketplaceLock: WITH_TEST_MARKETPLACE_LOCK,
      });

      expect(commands).toEqual([
        "plugin marketplace list",
        "plugin list",
        "plugin marketplace list",
        `plugin marketplace add ${path.join(rootDir, "marketplace")}`,
        "plugin list",
        "plugin add fleet -m fleet-harness",
      ]);
      expect(codexState.installed).toEqual(new Set(["fleet@fleet-harness"]));
      const profileName = argValue(profile.args, "--profile");
      expect(profileName).toBe(FLEET_PROFILE_NAME);
      expect(readFileSync(path.join(codexHome, FLEET_PROFILE_FILE_NAME), "utf8")).toBe([
        CODEX_FLEET_PROFILE_MARKER,
        'developer_instructions = """',
        "private fleet prompt",
        '"""',
        "",
        "[features]",
        "hooks = true",
        "",
        '[plugins."fleet@fleet-harness"]',
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
        codexCommandRunner: () => ({ status: 1, stderr: "codex plugin exploded", stdout: "" }),
        dataDir: rootDir,
        dedicatedMcpSession: {
          getEndpoint: async () => ({
            servers: [{ name: "fleet", url: "http://127.0.0.1:1000/fleet" }],
          }),
          issueSessionToken: () => [{ name: "fleet", token: "fleet-token" }],
          releaseSessionToken: vi.fn(),
        } as never,
        pluginRootDir: rootDir,
        withMarketplaceLock: WITH_TEST_MARKETPLACE_LOCK,
      });

      expect(profile.args).not.toContain("child_agents_md");
      const profileName = argValue(profile.args, "--profile");
      expect(profileName).toBe(FLEET_PROFILE_NAME);
      const profilePath = path.join(codexHome, FLEET_PROFILE_FILE_NAME);
      expect(readFileSync(profilePath, "utf8")).toBe([
        CODEX_FLEET_PROFILE_MARKER,
        'developer_instructions = """',
        "private fleet prompt",
        '"""',
        "",
        "[features]",
        "hooks = true",
        "",
        '[plugins."fleet@fleet-harness"]',
        "enabled = true",
        "",
      ].join("\n"));
      expect(profile.launchWarnings?.[0]).toContain("codex plugin marketplace list failed");
      expect(profile.launchWarnings?.[0]).toContain("codex plugin exploded");
      profile.cleanup?.();
      expect(existsSync(profilePath)).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
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

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
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
