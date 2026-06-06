import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentCliSessionPlugin, ensureCodexPluginRegistered } from "../src/agent-cli/session-plugin/index.js";
import { cleanupPrivateRoot } from "../src/agent-cli/session-plugin/fs.js";
import type { AgentCliSessionPlugin, CodexPluginRegistration, CodexPluginRegistrationCommand } from "../src/agent-cli/session-plugin/types.js";

describe("agent CLI session plugin renderer", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders one marketplace with one Fleet Claude/Codex plugin bundle without MCP definitions", () => {
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
      rootDir,
    });

    const marketplaceRoot = path.join(rootDir, "marketplace");
    const fleetRoot = path.join(marketplaceRoot, "plugins", "fleet");
    const registration = registrationByName(plugin, "fleet");

    expect(plugin.pluginRoot).toBe(fleetRoot);
    expect(plugin.pluginRoots).toEqual([fleetRoot]);
    expect(plugin.codexRegistrations).toHaveLength(1);
    expect(registration).toMatchObject({
      marketplaceDir: path.join(rootDir, "marketplace"),
      marketplaceName: "fleet",
      pluginName: "fleet",
      pluginRoot: fleetRoot,
    });

    expect(readJson(path.join(fleetRoot, ".claude-plugin", "plugin.json"))).toMatchObject({ name: "fleet" });
    expect(readFileSync(path.join(fleetRoot, "agents", "Ohio.md"), "utf8")).toContain("Ohio prompt");

    const marketplace = readJson(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"));
    expect(marketplace).toEqual({
      name: "fleet",
      plugins: [{
        name: "fleet",
        displayName: "Fleet",
        source: {
          source: "local",
          path: "./plugins/fleet",
        },
        description: "Fleet carrier delegation and wiki evidence plugin",
      }],
    });
    expect(readJson(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"))).toMatchObject({
      name: "fleet",
      plugins: [{
        name: "fleet",
        source: "./plugins/fleet",
      }],
    });
    expect(readJson(path.join(fleetRoot, ".codex-plugin", "plugin.json"))).toMatchObject({
      name: "fleet",
      skills: "./skills/",
    });
    expect(readJson(path.join(fleetRoot, ".codex-plugin", "plugin.json"))).not.toHaveProperty("hooks");
    expect(readJson(path.join(fleetRoot, ".codex-plugin", "plugin.json"))).not.toHaveProperty("mcpServers");
    expect(existsSync(path.join(fleetRoot, "hooks"))).toBe(false);
    expect(existsSync(path.join(fleetRoot, ".mcp.json"))).toBe(false);
    expect(readFileSync(path.join(fleetRoot, "skills", "fleet-usage", "SKILL.md"), "utf8")).toContain("carrier_dispatch");
    expect(readFileSync(path.join(fleetRoot, "skills", "fleet-wiki-usage", "SKILL.md"), "utf8")).toContain("Fleet Wiki");
    expect(statSync(path.join(rootDir, "marketplace")).mode & 0o777).toBe(0o700);
    assertPrivateTree(path.join(rootDir, "marketplace"));
  });

  it("does not chmod existing ancestors on first render and only hardens created managed dirs", () => {
    const parent = makeRoot();
    chmodSync(parent, 0o755);
    const rootDir = path.join(parent, ".fleet");

    createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });

    expect(statSync(parent).mode & 0o777).toBe(0o755);
    expect(statSync(rootDir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(rootDir, "marketplace")).mode & 0o777).toBe(0o700);
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
      rootDir,
    })).toThrow(/Invalid Claude agent file name/);
    expect(existsSync(path.join(rootDir, "marketplace", "plugins", "fleet", "agents"))).toBe(false);
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
      rootDir: linkRoot,
    })).toThrow(/symlink/);
    expect(existsSync(path.join(outside, "marketplace"))).toBe(false);
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
      rootDir: escapedRoot,
    })).toThrow(/symlink/);
    expect(existsSync(path.join(outside, ".fleet", "marketplace"))).toBe(false);

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
      rootDir,
    });

    expect(plugin.codexRegistrations).toEqual([]);
    expect(existsSync(path.join(rootDir, "marketplace", ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(existsSync(path.join(rootDir, "marketplace", ".fleet-codex-plugin.hash"))).toBe(false);
  });

  it("updates plugin content idempotently and prunes stale managed tree entries", () => {
    const rootDir = makeRoot();
    const marketplaceRoot = path.join(rootDir, "marketplace");
    const pluginRoot = path.join(marketplaceRoot, "plugins", "fleet");
    createSentinel(path.join(pluginRoot, "skills", "old-skill", "SKILL.md"));
    createSentinel(path.join(pluginRoot, "hooks", "old-hook.mjs"));
    createSentinel(path.join(marketplaceRoot, "plugins", "carrier", "skills", "old-skill", "SKILL.md"));
    createSentinel(path.join(marketplaceRoot, "plugins", "wiki", "skills", "old-skill", "SKILL.md"));
    createSentinel(path.join(marketplaceRoot, "codex-marketplace", "plugins", "old", ".codex-plugin", "plugin.json"));

    const first = createAgentCliSessionPlugin({
      claudeDefinitions: [{
        carrierId: "ohio",
        description: "Ohio carrier",
        name: "Ohio",
        prompt: "first",
      }],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });
    const second = createAgentCliSessionPlugin({
      claudeDefinitions: [{
        carrierId: "ohio",
        description: "Ohio carrier",
        name: "Ohio",
        prompt: "second",
      }],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });

    expect(first.pluginRoot).toBe(second.pluginRoot);
    expect(registrationByName(first, "fleet").marketplaceDir).toBe(registrationByName(second, "fleet").marketplaceDir);
    expect(registrationByName(first, "fleet").contentHash).not.toBe(registrationByName(second, "fleet").contentHash);
    expect(readFileSync(path.join(second.pluginRoot, "agents", "Ohio.md"), "utf8")).toContain("second");
    expect(existsSync(path.join(pluginRoot, "skills", "old-skill"))).toBe(false);
    expect(existsSync(path.join(pluginRoot, "hooks", "old-hook.mjs"))).toBe(false);
    expect(existsSync(path.join(pluginRoot, "hooks"))).toBe(false);
    expect(existsSync(path.join(marketplaceRoot, "plugins", "carrier"))).toBe(false);
    expect(existsSync(path.join(marketplaceRoot, "plugins", "wiki"))).toBe(false);
    expect(existsSync(path.join(marketplaceRoot, "codex-marketplace"))).toBe(false);
    expect(existsSync(path.join(registrationByName(second, "fleet").pluginRoot, "skills", "fleet-usage", "SKILL.md"))).toBe(true);
  });

  it("leaves the old flat Fleet plugin root untouched while rendering the marketplace root", () => {
    const rootDir = makeRoot();
    createSentinel(path.join(rootDir, "plugins", "skills", "old-skill", "SKILL.md"));

    createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });

    expect(existsSync(path.join(rootDir, "plugins", "skills", "old-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(rootDir, "marketplace", "plugins", "fleet", "skills", "fleet-usage", "SKILL.md"))).toBe(true);
  });

  it("registers Codex marketplace and plugin idempotently through codex CLI", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });
    const calls: readonly string[][][] = [];
    const state = { marketplaceRoot: undefined as string | undefined, plugin: false };
    const runner = createCodexRunner(state, calls);
    const command = codexCommand();
    const registration = registrationByName(plugin, "fleet");

    ensureCodexPluginRegistered(registration, command, runner);
    ensureCodexPluginRegistered(registration, command, runner);

    expect(calls.flat().map((args) => args.join(" "))).toEqual([
      "plugin marketplace list",
      `plugin marketplace add ${registration.marketplaceDir}`,
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
      rootDir,
    });
    const calls: readonly string[][][] = [];
    const state = { marketplaceRoot: "/Users/sbluemin", plugin: false };
    const runner = createCodexRunner(state, calls);
    const registration = registrationByName(plugin, "fleet");

    ensureCodexPluginRegistered(registration, codexCommand(), runner);

    expect(calls.flat().map((args) => args.join(" "))).toEqual([
      "plugin marketplace list",
      "plugin marketplace remove fleet",
      `plugin marketplace add ${registration.marketplaceDir}`,
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
      rootDir,
    });
    const calls: string[] = [];
    const registration = registrationByName(plugin, "fleet");
    const warning = ensureCodexPluginRegistered(registration, codexCommand(), (command) => {
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
      `plugin marketplace add ${registration.marketplaceDir}`,
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
    const registration = registrationByName(plugin, "fleet");
    const state = { marketplaceRoot: registration.marketplaceDir, plugin: false };

    ensureCodexPluginRegistered(registration, codexCommand(homeDir), createCodexRunner(state, []));

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
    const registration = registrationByName(plugin, "fleet");
    const state = { marketplaceRoot: registration.marketplaceDir, plugin: false };

    ensureCodexPluginRegistered(registration, codexCommand(homeDir), createCodexRunner(state, []));

    expect(existsSync(marketplacePath)).toBe(false);
  });

  it("removes empty legacy Fleet ~/.agents marketplace files", () => {
    const homeDir = makeRoot();
    const rootDir = path.join(homeDir, ".fleet");
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });
    const marketplacePath = path.join(homeDir, ".agents", "plugins", "marketplace.json");
    writeJsonFile(marketplacePath, { name: "fleet", plugins: [] });
    const registration = registrationByName(plugin, "fleet");
    const state = { marketplaceRoot: registration.marketplaceDir, plugin: false };

    ensureCodexPluginRegistered(registration, codexCommand(homeDir), createCodexRunner(state, []));

    expect(existsSync(marketplacePath)).toBe(false);
  });

  it("leaves non-Fleet ~/.agents plugin entries untouched", () => {
    const homeDir = makeRoot();
    const rootDir = path.join(homeDir, ".fleet");
    const plugin = createAgentCliSessionPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
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
    const registration = registrationByName(plugin, "fleet");
    const state = { marketplaceRoot: registration.marketplaceDir, plugin: false };

    ensureCodexPluginRegistered(registration, codexCommand(homeDir), createCodexRunner(state, []));

    expect(readJson(marketplacePath)).toEqual(original);
  });

  it("reruns codex plugin add when rendered content hash changes", () => {
    const rootDir = makeRoot();
    const first = createAgentCliSessionPlugin({
      claudeDefinitions: [{
        carrierId: "ohio",
        description: "Ohio carrier",
        name: "Ohio",
        prompt: "first",
      }],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });
    const firstRegistration = registrationByName(first, "fleet");
    const state = { marketplaceRoot: firstRegistration.marketplaceDir, plugin: true };
    const calls: readonly string[][][] = [];
    const runner = createCodexRunner(state, calls);
    const command = codexCommand();
    ensureCodexPluginRegistered(firstRegistration, command, runner);

    const second = createAgentCliSessionPlugin({
      claudeDefinitions: [{
        carrierId: "ohio",
        description: "Ohio carrier",
        name: "Ohio",
        prompt: "second",
      }],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });
    ensureCodexPluginRegistered(registrationByName(second, "fleet"), command, runner);

    expect(calls.flat().map((args) => args.join(" ")).filter((line) => line === "plugin add fleet -m fleet")).toHaveLength(2);
  });

  function makeRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-session-plugin-test-"));
    tempRoots.push(root);
    return root;
  }
});

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

function registrationByName(plugin: AgentCliSessionPlugin, pluginName: string): CodexPluginRegistration {
  const registration = plugin.codexRegistrations.find((entry) => entry.pluginName === pluginName);
  expect(registration).toBeDefined();
  return registration!;
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
    if (line.startsWith("plugin add ") && line.endsWith(" -m fleet")) {
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
