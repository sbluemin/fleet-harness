import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentCliSessionPlugin, ensureCodexPluginRegistered } from "../src/agent-cli/session-plugin/index.js";
import { cleanupPrivateRoot } from "../src/agent-cli/session-plugin/fs.js";
import type { CodexPluginRegistrationCommand } from "../src/agent-cli/session-plugin/types.js";

const DOCTRINE = "FLEET_DOCTRINE_MARKER";
const CARRIER_TOKEN = "carrier-secret-token";
const WIKI_TOKEN = "wiki-secret-token";

describe("agent CLI session plugin renderer", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders one flat Claude and Codex plugin root with env-only MCP tokens", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [{
        carrierId: "ohio",
        color: "yellow",
        description: "Ohio carrier",
        effort: "low",
        model: "sonnet",
        name: "Ohio",
        prompt: "Ohio prompt",
      }],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });

    expect(plugin.pluginRoot).toBe(path.join(rootDir, "plugins"));
    expect(plugin.codexRegistration).toMatchObject({
      marketplaceDir: path.join(rootDir, "plugins"),
      marketplaceName: "fleet",
      pluginName: "fleet",
      pluginRoot: path.join(rootDir, "plugins"),
    });

    assertHookOutput(plugin.pluginRoot);
    expect(readJson(path.join(plugin.pluginRoot, ".claude-plugin", "plugin.json"))).toMatchObject({ name: "fleet" });
    expect(readFileSync(path.join(plugin.pluginRoot, "agents", "Ohio.md"), "utf8")).toContain("Ohio prompt");

    const codexRoot = plugin.codexRegistration!.pluginRoot;
    const marketplace = readJson(path.join(plugin.codexRegistration!.marketplaceDir, ".agents", "plugins", "marketplace.json"));
    expect(marketplace).toEqual({
      name: "fleet",
      plugins: [{
        name: "fleet",
        source: {
          source: "local",
          path: "./plugins/fleet",
        },
      }],
    });
    expect(readlinkSync(path.join(plugin.pluginRoot, "plugins", "fleet"))).toBe("..");
    expect(readJson(path.join(codexRoot, ".codex-plugin", "plugin.json"))).toMatchObject({
      hooks: "./hooks/hooks.json",
      mcpServers: "./.mcp.json",
      name: "fleet",
      skills: "./skills/",
    });
    assertHookOutput(codexRoot);

    const mcpConfigText = readFileSync(path.join(codexRoot, ".mcp.json"), "utf8");
    expect(mcpConfigText).not.toContain(CARRIER_TOKEN);
    expect(mcpConfigText).not.toContain(WIKI_TOKEN);
    expect(mcpConfigText).toContain("bearer_token_env_var");
    expect(Object.values(plugin.env)).toContain(CARRIER_TOKEN);
    expect(Object.values(plugin.env)).toContain(WIKI_TOKEN);
    expect(statSync(path.join(rootDir, "plugins")).mode & 0o777).toBe(0o700);
    assertPrivateTree(path.join(rootDir, "plugins"));
  });

  it("does not chmod existing ancestors on first render and only hardens created managed dirs", () => {
    const parent = makeRoot();
    chmodSync(parent, 0o755);
    const rootDir = path.join(parent, ".fleet");

    createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });

    expect(statSync(parent).mode & 0o777).toBe(0o755);
    expect(statSync(rootDir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(rootDir, "plugins")).mode & 0o777).toBe(0o700);
  });

  it("rejects unsafe Claude agent file names without leaving rendered agents", () => {
    const rootDir = makeRoot();

    expect(() => createAgentCliSessionPlugin({
      claudeDefinitions: [{
        carrierId: "ohio",
        description: "Unsafe carrier",
        name: "../outside",
        prompt: "prompt",
      }],
      cliId: "claude",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    })).toThrow(/Invalid Claude agent file name/);
    expect(existsSync(path.join(rootDir, "plugins", "agents"))).toBe(false);
  });

  it("rejects ancestor symlinks before writing session assets", () => {
    const rootDir = makeRoot();
    const outside = makeRoot();
    const linkRoot = path.join(rootDir, "linked-root");
    symlinkSync(outside, linkRoot);

    expect(() => createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir: linkRoot,
    })).toThrow(/symlink/);
    expect(existsSync(path.join(outside, "plugins"))).toBe(false);
  });

  it("rejects intermediate rootDir symlinks without writing or cleaning outside targets", () => {
    const base = makeRoot();
    const outside = makeRoot();
    const linkRoot = path.join(base, "link");
    const escapedRoot = path.join(linkRoot, ".fleet");
    const outsideSentinel = path.join(outside, ".fleet", "sentinel.txt");
    symlinkSync(outside, linkRoot);

    expect(() => createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir: escapedRoot,
    })).toThrow(/symlink/);
    expect(existsSync(path.join(outside, ".fleet", "plugins"))).toBe(false);

    createSentinel(outsideSentinel);
    expect(() => cleanupPrivateRoot(
      path.join(escapedRoot, "plugins"),
      escapedRoot,
    )).toThrow(/symlink/);
    expect(readFileSync(outsideSentinel, "utf8")).toBe("outside");
  });

  it("does not create Codex registration metadata for Claude launches", () => {
    const rootDir = makeRoot();

    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "claude",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });

    expect(plugin.codexRegistration).toBeUndefined();
    expect(existsSync(path.join(rootDir, "plugins", ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(existsSync(path.join(rootDir, "plugins", ".fleet-codex-plugin.hash"))).toBe(false);
  });

  it("updates plugin content idempotently and prunes stale managed tree entries", () => {
    const rootDir = makeRoot();
    const pluginRoot = path.join(rootDir, "plugins");
    createSentinel(path.join(pluginRoot, "skills", "old-skill", "SKILL.md"));
    createSentinel(path.join(pluginRoot, "hooks", "old-hook.mjs"));
    createSentinel(path.join(pluginRoot, "codex-marketplace", "plugins", "old", ".codex-plugin", "plugin.json"));

    const first = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: "first",
      mcpServers: mcpServers(),
      rootDir,
    });
    const second = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: "second",
      mcpServers: mcpServers(),
      rootDir,
    });

    expect(first.pluginRoot).toBe(second.pluginRoot);
    expect(first.codexRegistration!.marketplaceDir).toBe(second.codexRegistration!.marketplaceDir);
    expect(first.codexRegistration!.contentHash).not.toBe(second.codexRegistration!.contentHash);
    expect(readFileSync(path.join(second.pluginRoot, "hooks", "session-start.mjs"), "utf8")).toContain("second");
    expect(existsSync(path.join(pluginRoot, "skills", "old-skill"))).toBe(false);
    expect(existsSync(path.join(pluginRoot, "hooks", "old-hook.mjs"))).toBe(false);
    expect(existsSync(path.join(pluginRoot, "codex-marketplace"))).toBe(false);
    expect(existsSync(path.join(second.codexRegistration!.pluginRoot, "skills", "fleet-usage", "SKILL.md"))).toBe(true);
  });

  it("registers Codex marketplace and plugin idempotently through codex CLI", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });
    const calls: readonly string[][][] = [];
    const state = { marketplaceRoot: undefined as string | undefined, plugin: false };
    const runner = createCodexRunner(state, calls);
    const command = codexCommand();

    ensureCodexPluginRegistered(plugin.codexRegistration!, command, runner);
    ensureCodexPluginRegistered(plugin.codexRegistration!, command, runner);

    expect(calls.flat().map((args) => args.join(" "))).toEqual([
      "plugin marketplace list",
      `plugin marketplace add ${plugin.codexRegistration!.marketplaceDir}`,
      "plugin list",
      "plugin add fleet -m fleet",
      "plugin marketplace list",
      "plugin list",
    ]);
  });

  it("removes stale Codex marketplace roots before readding the Fleet root", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });
    const calls: readonly string[][][] = [];
    const state = { marketplaceRoot: "/Users/sbluemin", plugin: false };
    const runner = createCodexRunner(state, calls);

    ensureCodexPluginRegistered(plugin.codexRegistration!, codexCommand(), runner);

    expect(calls.flat().map((args) => args.join(" "))).toEqual([
      "plugin marketplace list",
      "plugin marketplace remove fleet",
      `plugin marketplace add ${plugin.codexRegistration!.marketplaceDir}`,
      "plugin list",
      "plugin add fleet -m fleet",
    ]);
  });

  it("continues Codex registration when a stale auto-discovered marketplace cannot be removed", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });
    const calls: string[] = [];
    const warning = ensureCodexPluginRegistered(plugin.codexRegistration!, codexCommand(), (command) => {
      const line = command.args.join(" ");
      calls.push(line);
      if (line === "plugin marketplace list") {
        return { status: 0, stderr: "", stdout: "fleet /Users/sbluemin\n" };
      }
      if (line === "plugin marketplace remove fleet") {
        return { status: 1, stderr: "marketplace `fleet` is not configured or installed", stdout: "" };
      }
      return { status: 0, stderr: "", stdout: "" };
    });

    expect(warning).toBeUndefined();
    expect(calls).toEqual([
      "plugin marketplace list",
      "plugin marketplace remove fleet",
      `plugin marketplace add ${plugin.codexRegistration!.marketplaceDir}`,
      "plugin list",
      "plugin add fleet -m fleet",
    ]);
  });

  it("removes only the legacy Fleet entry from ~/.agents/plugins/marketplace.json", () => {
    const homeDir = makeRoot();
    const rootDir = path.join(homeDir, ".fleet");
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });
    const marketplacePath = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    writeJsonFile(marketplacePath, {
      name: "fleet",
      plugins: [
        {
          name: "fleet",
          source: { source: "local", path: path.join(homeDir, ".fleet", "plugins") },
        },
        {
          name: "other",
          source: { source: "local", path: "/opt/other-plugin" },
        },
      ],
    });
    const state = { marketplaceRoot: plugin.codexRegistration!.marketplaceDir, plugin: false };

    ensureCodexPluginRegistered(plugin.codexRegistration!, codexCommand(homeDir), createCodexRunner(state, []));

    expect(readJson(marketplacePath)).toEqual({
      name: "fleet",
      plugins: [
        {
          name: "other",
          source: { source: "local", path: "/opt/other-plugin" },
        },
      ],
    });
  });

  it("removes legacy ~/.agents marketplace files that only contain Fleet's old entry", () => {
    const homeDir = makeRoot();
    const rootDir = path.join(homeDir, ".fleet");
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });
    const marketplacePath = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    writeJsonFile(marketplacePath, {
      name: "fleet",
      plugins: [{
        name: "fleet",
        source: { source: "local", path: path.join(homeDir, ".fleet", "plugins") },
      }],
    });
    const state = { marketplaceRoot: plugin.codexRegistration!.marketplaceDir, plugin: false };

    ensureCodexPluginRegistered(plugin.codexRegistration!, codexCommand(homeDir), createCodexRunner(state, []));

    expect(existsSync(marketplacePath)).toBe(false);
  });

  it("removes empty legacy Fleet ~/.agents marketplace files", () => {
    const homeDir = makeRoot();
    const rootDir = path.join(homeDir, ".fleet");
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });
    const marketplacePath = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    writeJsonFile(marketplacePath, { name: "fleet", plugins: [] });
    const state = { marketplaceRoot: plugin.codexRegistration!.marketplaceDir, plugin: false };

    ensureCodexPluginRegistered(plugin.codexRegistration!, codexCommand(homeDir), createCodexRunner(state, []));

    expect(existsSync(marketplacePath)).toBe(false);
  });

  it("leaves non-Fleet ~/.agents plugin entries untouched", () => {
    const homeDir = makeRoot();
    const rootDir = path.join(homeDir, ".fleet");
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: DOCTRINE,
      mcpServers: mcpServers(),
      rootDir,
    });
    const marketplacePath = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    const original = {
      name: "fleet",
      plugins: [{
        name: "fleet",
        source: { source: "local", path: "/opt/not-fleet" },
      }],
    };
    writeJsonFile(marketplacePath, original);
    const state = { marketplaceRoot: plugin.codexRegistration!.marketplaceDir, plugin: false };

    ensureCodexPluginRegistered(plugin.codexRegistration!, codexCommand(homeDir), createCodexRunner(state, []));

    expect(readJson(marketplacePath)).toEqual(original);
  });

  it("reruns codex plugin add when rendered content hash changes", () => {
    const rootDir = makeRoot();
    const first = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: "first",
      mcpServers: mcpServers(),
      rootDir,
    });
    const state = { marketplaceRoot: first.codexRegistration!.marketplaceDir, plugin: true };
    const calls: readonly string[][][] = [];
    const runner = createCodexRunner(state, calls);
    const command = codexCommand();
    ensureCodexPluginRegistered(first.codexRegistration!, command, runner);

    const second = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      doctrine: "second",
      mcpServers: mcpServers(),
      rootDir,
    });
    ensureCodexPluginRegistered(second.codexRegistration!, command, runner);

    expect(calls.flat().map((args) => args.join(" ")).filter((line) => line === "plugin add fleet -m fleet")).toHaveLength(2);
  });

  function makeRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-session-plugin-test-"));
    tempRoots.push(root);
    return root;
  }
});

function mcpServers() {
  return [
    { name: "fleet-carriers", endpointUrl: "http://127.0.0.1:1000/carriers", token: CARRIER_TOKEN },
    { name: "fleet-wiki", endpointUrl: "http://127.0.0.1:1001/wiki", token: WIKI_TOKEN },
  ];
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function createSentinel(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, "outside", { encoding: "utf8", mode: 0o600 });
}

function writeJsonFile(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function assertHookOutput(pluginRoot: string): void {
  const hooks = readJson(path.join(pluginRoot, "hooks", "hooks.json"));
  expect(hooks).toEqual({
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"',
        }],
      }],
    },
  });
  const hookOutput = spawnSync("node", [path.join(pluginRoot, "hooks", "session-start.mjs")], {
    encoding: "utf8",
  });
  expect(hookOutput.status).toBe(0);
  expect(JSON.parse(hookOutput.stdout)).toEqual({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: DOCTRINE,
    },
  });
}

function createCodexRunner(
  state: { marketplaceRoot: string | undefined; plugin: boolean },
  calls: readonly string[][][],
): (command: CodexPluginRegistrationCommand) => { readonly status: number; readonly stderr: string; readonly stdout: string } {
  const mutableCalls = calls as string[][][];
  return (command) => {
    mutableCalls.push([Array.from(command.args)]);
    const line = command.args.join(" ");
    if (line === "plugin marketplace list") {
      return { status: 0, stderr: "", stdout: state.marketplaceRoot === undefined ? "" : `fleet ${state.marketplaceRoot}\n` };
    }
    if (line === "plugin marketplace remove fleet") {
      state.marketplaceRoot = undefined;
      return { status: 0, stderr: "", stdout: "" };
    }
    if (line.startsWith("plugin marketplace add ")) {
      state.marketplaceRoot = line.slice("plugin marketplace add ".length);
      return { status: 0, stderr: "", stdout: "" };
    }
    if (line === "plugin list") {
      return { status: 0, stderr: "", stdout: state.plugin ? "fleet@fleet\n" : "" };
    }
    if (line === "plugin add fleet -m fleet") {
      state.plugin = true;
      return { status: 0, stderr: "", stdout: "" };
    }
    return { status: 1, stderr: `unexpected ${line}`, stdout: "" };
  };
}

function codexCommand(homeDir?: string): CodexPluginRegistrationCommand {
  return {
    args: [],
    bin: "codex",
    cwd: process.cwd(),
    env: homeDir === undefined ? {} : { HOME: homeDir },
  };
}

function assertPrivateTree(rootPath: string): void {
  if (!existsSync(rootPath)) return;
  const stat = lstatSync(rootPath);
  if (stat.isSymbolicLink()) {
    expect(readlinkSync(rootPath)).toBe("..");
    return;
  }
  expect(stat.mode & 0o777).toBe(stat.isDirectory() ? 0o700 : 0o600);
  if (!stat.isDirectory()) return;
  for (const entry of readdirSync(rootPath)) {
    assertPrivateTree(path.join(rootPath, entry));
  }
}
