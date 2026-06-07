import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildFleetHookCommand } from "../src/agent-cli/injection.js";
import { createAgentCliPlugin, ensureCodexPluginRegistered } from "../src/agent-cli/plugin/index.js";
import { neutralizeCodexFleetPluginConfig } from "../src/agent-cli/plugin/codex-config.js";
import { cleanupPrivateRoot } from "../src/agent-cli/plugin/fs.js";
import { runSubagentsContextHook } from "../src/hooks/subagents-context.js";
import type { AgentCliPlugin, CodexPluginRegistration, CodexPluginRegistrationCommand } from "../src/agent-cli/plugin/types.js";

const PLUGIN_ASSETS_DIR = path.resolve("assets");
const tempCodexHomes: string[] = [];
const EXPECTED_SUBAGENTS_CONTEXT = `<fleet section="subagents">
# Claude Native Subagents

The following Fleet carriers are exposed as Claude native subagents for this session:

- Nimitz (nimitz): invoke as Claude native subagent \`nimitz\`.
- Kirov (kirov): invoke as Claude native subagent \`kirov\`.
- Genesis (genesis): invoke as Claude native subagent \`genesis\`.
- Ohio (ohio): invoke as Claude native subagent \`ohio\`.
- Sentinel (sentinel): invoke as Claude native subagent \`sentinel\`.
- Vanguard (vanguard): invoke as Claude native subagent \`vanguard\`.
- Tempest (tempest): invoke as Claude native subagent \`tempest\`.
- Chronicle (chronicle): invoke as Claude native subagent \`chronicle\`.

Native subagent calls return inline and do not emit \`[carrier:result]\`. Do not wait for a carrier job completion push after native invocation.

\`carrier_dispatch\` remains available as a separate Fleet delegation path for carriers that are not invoked through the native subagent interface.
</fleet>`;
const TEST_HOOK_EXEC = buildFleetHookCommand({
  entryPath: "/opt/fleet/dist/index.js",
  execPath: "/opt/node/bin/node",
});

describe("agent CLI plugin renderer", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
    for (const root of tempCodexHomes.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders one marketplace with one Fleet Claude/Codex plugin bundle without MCP definitions", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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
      marketplaceName: "fleet-harness",
      pluginName: "fleet",
      pluginRoot: fleetRoot,
    });

    expect(readJson(path.join(fleetRoot, ".claude-plugin", "plugin.json"))).toMatchObject({ name: "fleet" });
    expect(readFileSync(path.join(fleetRoot, "agents", "Ohio.md"), "utf8")).toContain("Ohio prompt");

    const marketplace = readJson(path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"));
    expect(marketplace).toEqual({
      name: "fleet-harness",
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
      name: "fleet-harness",
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
    expect(readFileSync(path.join(fleetRoot, "skills", "fleet-wiki-usage", "SKILL.md"), "utf8")).toContain("Fleet Wiki");
    expect(readFileSync(path.join(fleetRoot, "skills", "fleet-wiki-usage", "SKILL.md"), "utf8")).toBe(
      readFileSync(path.join(PLUGIN_ASSETS_DIR, "plugins", "fleet", "skills", "fleet-wiki-usage", "SKILL.md"), "utf8"),
    );
    expect(statSync(path.join(rootDir, "marketplace")).mode & 0o777).toBe(0o700);
    assertPrivateTree(path.join(rootDir, "marketplace"));
  });

  it("renders every skill directory found under the Fleet plugin assets", () => {
    const assetsDir = makeRoot();
    const rootDir = makeRoot();
    createSkillAssetFile(assetsDir, path.join("alpha-skill", "SKILL.md"), "Alpha skill");
    createSkillAssetFile(assetsDir, path.join("alpha-skill", "references", "example.md"), "Alpha reference");
    createSkillAssetFile(assetsDir, path.join("zeta-skill", "SKILL.md"), "Zeta skill");

    const plugin = createAgentCliPlugin({
      assetsDir,
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });

    const skillsRoot = path.join(plugin.pluginRoot, "skills");
    expect(readdirSync(skillsRoot).sort()).toEqual(["alpha-skill", "zeta-skill"]);
    expect(readFileSync(path.join(skillsRoot, "alpha-skill", "SKILL.md"), "utf8")).toBe("Alpha skill");
    expect(readFileSync(path.join(skillsRoot, "alpha-skill", "references", "example.md"), "utf8")).toBe("Alpha reference");
    expect(readFileSync(path.join(skillsRoot, "zeta-skill", "SKILL.md"), "utf8")).toBe("Zeta skill");
  });

  it("throws a clear renderer error when required assets are not provided", () => {
    const rootDir = makeRoot();

    expect(() => createAgentCliPlugin({
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    })).toThrow(/assets directory is required/);
  });

  it("does not chmod existing ancestors on first render and only hardens created managed dirs", () => {
    const parent = makeRoot();
    chmodSync(parent, 0o755);
    const rootDir = path.join(parent, ".fleet");

    createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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

    expect(() => createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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

    expect(() => createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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

    expect(() => createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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

    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
      claudeDefinitions: [],
      cliId: "claude",
      cwd: process.cwd(),
      hookExec: TEST_HOOK_EXEC,
      rootDir,
    });

    expect(plugin.codexRegistrations).toEqual([]);
    expect(existsSync(path.join(rootDir, "marketplace", ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(existsSync(path.join(rootDir, "marketplace", ".fleet-codex-plugin.hash"))).toBe(false);
    expect(readJson(path.join(rootDir, "marketplace", "plugins", "fleet", "hooks", "hooks.json"))).toEqual({
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
  });

  it("builds PATH-independent exec-form Fleet hook commands for bundled and dev entries", () => {
    // .js entry: 셸 없이 직접 spawn되는 exec form (command + args)
    expect(buildFleetHookCommand({
      entryPath: "/opt/fleet/dist/index.js",
      execPath: "/opt/node/bin/node",
    })).toEqual({
      command: "/opt/node/bin/node",
      args: ["/opt/fleet/dist/index.js", "hook", "subagents-context"],
    });
    // .ts dev entry: tsx loader는 Windows 호환을 위해 file:// URL로 변환되어야 한다.
    expect(buildFleetHookCommand({
      entryPath: "/workspace/fleet/runtime/fleet-cli/src/index.ts",
      execPath: "/opt/node/bin/node",
      tsxLoaderPath: "/workspace/fleet/node_modules/tsx/dist/loader.mjs",
    })).toEqual({
      command: "/opt/node/bin/node",
      args: [
        "--import",
        "file:///workspace/fleet/node_modules/tsx/dist/loader.mjs",
        "/workspace/fleet/runtime/fleet-cli/src/index.ts",
        "hook",
        "subagents-context",
      ],
    });
    expect(() => buildFleetHookCommand({
      entryPath: "/workspace/fleet/runtime/fleet-cli/src/index.ts",
      execPath: "/opt/node/bin/node",
    })).toThrow(/requires a tsx loader path/);
  });

  it("executes fleet hook subagents-context using the canonical subagents formatter", () => {
    const rootDir = makeRoot();
    writeJsonFile(path.join(rootDir, "carriers.json"), { carriers: {} });

    const result = spawnSync("pnpm", ["exec", "tsx", "src/index.ts", "hook", "subagents-context"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FLEET_ROOT: rootDir },
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput?: { additionalContext?: string; hookEventName?: string };
    };
    expect(output.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput?.additionalContext).toContain('<fleet section="subagents">');
    expect(output.hookSpecificOutput?.additionalContext).toBe(EXPECTED_SUBAGENTS_CONTEXT);
    expect(output).toEqual(JSON.parse(runSubagentsContextHook({ ...process.env, FLEET_ROOT: rootDir })));
  });

  it("emits an empty hook context when carriers.json is missing, corrupt, or schema-invalid", () => {
    const roots = [
      makeRoot(),
      makeRoot(),
      makeRoot(),
      makeRoot(),
    ];
    writeFileSync(path.join(roots[1]!, "carriers.json"), "{", { encoding: "utf8" });
    writeJsonFile(path.join(roots[2]!, "carriers.json"), []);
    writeJsonFile(path.join(roots[3]!, "carriers.json"), { carriers: "not-an-object" });

    for (const rootDir of roots) {
      const result = spawnSync("pnpm", ["exec", "tsx", "src/index.ts", "hook", "subagents-context"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, FLEET_ROOT: rootDir },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "",
        },
      });
    }
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

    const first = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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
    const second = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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
    expect(existsSync(path.join(registrationByName(second, "fleet").pluginRoot, "skills", "fleet-wiki-usage", "SKILL.md"))).toBe(true);
  });

  it("leaves the old flat Fleet plugin root untouched while rendering the marketplace root", () => {
    const rootDir = makeRoot();
    createSentinel(path.join(rootDir, "plugins", "skills", "old-skill", "SKILL.md"));

    createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });

    expect(existsSync(path.join(rootDir, "plugins", "skills", "old-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(rootDir, "marketplace", "plugins", "fleet", "skills", "fleet-wiki-usage", "SKILL.md"))).toBe(true);
  });

  it("registers Codex marketplace and plugin idempotently through codex CLI", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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
      "plugin add fleet -m fleet-harness",
      "plugin marketplace list",
      "plugin list",
    ]);
  });

  it("prepends the resolved Codex binary prefix args to every registration command", () => {
    // Windows .cmd shim 시나리오: bin=cmd.exe, base args=/d /s /c <shim>. 모든 codex 호출이 이 prefix를 유지해야 한다.
    const rootDir = makeRoot();
    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });
    const registration = registrationByName(plugin, "fleet");
    const prefix = ["/d", "/s", "/c", "C:\\tools\\codex.cmd"];
    const calls: string[][] = [];
    ensureCodexPluginRegistered(registration, {
      args: prefix,
      bin: "C:\\Windows\\System32\\cmd.exe",
      cwd: process.cwd(),
      env: {},
    }, (command) => {
      calls.push([...command.args]);
      const sub = command.args.slice(prefix.length).join(" ");
      if (sub === "plugin marketplace list") {
        return { status: 0, stderr: "", stdout: `fleet-harness ${registration.marketplaceDir}\n` };
      }
      return { status: 0, stderr: "", stdout: "" };
    });

    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) {
      expect(args.slice(0, prefix.length)).toEqual(prefix);
    }
    expect(calls.map((args) => args.join(" "))).toContain(
      "/d /s /c C:\\tools\\codex.cmd plugin add fleet -m fleet-harness",
    );
  });

  it("removes stale Codex marketplace roots before readding the Fleet root", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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
      "plugin marketplace remove fleet-harness",
      `plugin marketplace add ${registration.marketplaceDir}`,
      "plugin list",
      "plugin add fleet -m fleet-harness",
    ]);
  });

  it("continues Codex registration when a stale auto-discovered marketplace cannot be removed", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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
        return { status: 0, stderr: "", stdout: "fleet-harness /Users/sbluemin\n" };
      }
      if (line === "plugin marketplace remove fleet-harness") {
        return { status: 1, stderr: "marketplace `fleet-harness` is not configured or installed", stdout: "" };
      }
      return { status: 0, stderr: "", stdout: "" };
    });

    expect(warning).toBeUndefined();
    expect(calls).toEqual([
      "plugin marketplace list",
      "plugin marketplace remove fleet-harness",
      `plugin marketplace add ${registration.marketplaceDir}`,
      "plugin list",
      "plugin add fleet -m fleet-harness",
    ]);
  });

  it("leaves non-Fleet ~/.agents plugin entries untouched", () => {
    const homeDir = makeRoot();
    const rootDir = path.join(homeDir, ".fleet");
    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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
    const first = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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

    const second = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
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

    expect(calls.flat().map((args) => args.join(" ")).filter((line) => line === "plugin add fleet -m fleet-harness")).toHaveLength(2);
  });

  it("does not treat Codex plugin list headers or not-installed rows as installed", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });
    const registration = registrationByName(plugin, "fleet");
    writeFileSync(registration.hashPath, `${registration.contentHash}\n`, { encoding: "utf8", mode: 0o600 });
    const calls: string[] = [];

    ensureCodexPluginRegistered(registration, codexCommand(), (command) => {
      const line = command.args.join(" ");
      calls.push(line);
      if (line === "plugin marketplace list") {
        return { status: 0, stderr: "", stdout: `fleet-harness ${registration.marketplaceDir}\n` };
      }
      if (line === "plugin list") {
        return {
          status: 0,
          stderr: "",
          stdout: [
            "Marketplace `fleet-harness`",
            "fleet@fleet-harness not installed disabled",
          ].join("\n"),
        };
      }
      return { status: 0, stderr: "", stdout: "" };
    });

    expect(calls).toEqual([
      "plugin marketplace list",
      "plugin list",
      "plugin add fleet -m fleet-harness",
    ]);
  });

  it("treats installed disabled Codex plugin list rows as installed", () => {
    const rootDir = makeRoot();
    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });
    const registration = registrationByName(plugin, "fleet");
    writeFileSync(registration.hashPath, `${registration.contentHash}\n`, { encoding: "utf8", mode: 0o600 });
    const calls: string[] = [];

    ensureCodexPluginRegistered(registration, codexCommand(), (command) => {
      const line = command.args.join(" ");
      calls.push(line);
      if (line === "plugin marketplace list") {
        return { status: 0, stderr: "", stdout: `fleet-harness ${registration.marketplaceDir}\n` };
      }
      if (line === "plugin list") {
        return { status: 0, stderr: "", stdout: "fleet@fleet-harness  installed, disabled\n" };
      }
      return { status: 0, stderr: "", stdout: "" };
    });

    expect(calls).toEqual([
      "plugin marketplace list",
      "plugin list",
    ]);
  });

  it("neutralizes Codex Fleet plugin enablement after plugin add", () => {
    const rootDir = makeRoot();
    const codexHome = makeCodexHome();
    const plugin = createAgentCliPlugin({
      assetsDir: PLUGIN_ASSETS_DIR,
      claudeDefinitions: [],
      cliId: "codex",
      cwd: process.cwd(),
      rootDir,
    });
    const registration = registrationByName(plugin, "fleet");
    const state = { marketplaceRoot: registration.marketplaceDir, plugin: false };

    ensureCodexPluginRegistered(registration, codexCommand(codexHome), createCodexRunner(state, []));

    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain([
      `[plugins."fleet@fleet-harness"]`,
      "enabled = false",
    ].join("\n"));
  });

  it("preserves unrelated Codex config lines while disabling Fleet plugin tables", () => {
    const codexHome = makeCodexHome();
    const fleetRoot = makeRoot();
    const marketplaceDir = path.join(fleetRoot, "marketplace");
    const configPath = path.join(codexHome, "config.toml");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, [
      "# user comment",
      "model = \"gpt-5\"",
      "",
      "[plugins.\"fleet@fleet-harness\"] # fleet",
      "enabled = true # codex plugin add",
      "mcp_servers = {}",
      "",
      "[plugins.\"fleet@fleet\"]",
      "enabled = true",
      "",
      "[plugins.\"user@fleet-harness\"]",
      "enabled = true",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    neutralizeCodexFleetPluginConfig({
      codexHome,
      pluginKey: "fleet@fleet-harness",
    });

    expect(readFileSync(configPath, "utf8")).toBe([
      "# user comment",
      "model = \"gpt-5\"",
      "",
      "[plugins.\"fleet@fleet-harness\"] # fleet",
      "enabled = false # codex plugin add",
      "mcp_servers = {}",
      "",
      "[plugins.\"fleet@fleet\"]",
      "enabled = false",
      "",
      "[plugins.\"user@fleet-harness\"]",
      "enabled = true",
      "",
    ].join("\n"));
  });

  it("leaves Codex marketplace tables untouched while neutralizing the Fleet plugin", () => {
    const codexHome = makeCodexHome();
    const fleetRoot = makeRoot();
    const configPath = path.join(codexHome, "config.toml");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, [
      "[marketplaces.fleet]",
      "source_type = \"local\"",
      `source = "${fleetRoot}/marketplace"`,
      "",
      "[marketplaces.other]",
      "source_type = \"local\"",
      `source = "${fleetRoot}/other"`,
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    neutralizeCodexFleetPluginConfig({
      codexHome,
      pluginKey: "fleet@fleet-harness",
    });

    // 활성 마켓플레이스 키가 "fleet"여도 [marketplaces.*]는 보존되고, 끝에 plugin enable=false만 추가된다.
    expect(readFileSync(configPath, "utf8")).toBe([
      "[marketplaces.fleet]",
      "source_type = \"local\"",
      `source = "${fleetRoot}/marketplace"`,
      "",
      "[marketplaces.other]",
      "source_type = \"local\"",
      `source = "${fleetRoot}/other"`,
      "",
      "[plugins.\"fleet@fleet-harness\"]",
      "enabled = false",
      "",
    ].join("\n"));
  });

  it("disables a literal-quoted Fleet plugin table in place without appending a duplicate", () => {
    const codexHome = makeCodexHome();
    const configPath = path.join(codexHome, "config.toml");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(configPath, [
      "[plugins.'fleet@fleet-harness']",
      "enabled = true",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });

    neutralizeCodexFleetPluginConfig({
      codexHome,
      pluginKey: "fleet@fleet-harness",
    });

    // single-quoted(literal) 키를 동일 테이블로 인식해 in-place로 false 처리, 중복 테이블 append 금지.
    expect(readFileSync(configPath, "utf8")).toBe([
      "[plugins.'fleet@fleet-harness']",
      "enabled = false",
      "",
    ].join("\n"));
  });

  it("follows a symlinked Codex config and preserves the symlink while neutralizing", () => {
    const codexHome = makeCodexHome();
    const realDir = makeRoot();
    const realConfig = path.join(realDir, "real-config.toml");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(realConfig, [
      "[plugins.\"fleet@fleet-harness\"]",
      "enabled = true",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    // dotfiles 저장소 링크처럼 config.toml이 심링크인 경우.
    symlinkSync(realConfig, path.join(codexHome, "config.toml"));

    neutralizeCodexFleetPluginConfig({
      codexHome,
      pluginKey: "fleet@fleet-harness",
    });

    // 심링크는 보존되고 실제 대상 파일 내용만 false로 갱신된다(O_NOFOLLOW로 인한 throw 회피).
    expect(lstatSync(path.join(codexHome, "config.toml")).isSymbolicLink()).toBe(true);
    expect(readFileSync(realConfig, "utf8")).toBe([
      "[plugins.\"fleet@fleet-harness\"]",
      "enabled = false",
      "",
    ].join("\n"));
  });

  function makeRoot(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-plugin-test-"));
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

function createSkillAssetFile(assetsDir: string, relativePath: string, content: string): void {
  const skillPath = path.join(assetsDir, "plugins", "fleet", "skills", relativePath);
  mkdirSync(path.dirname(skillPath), { recursive: true, mode: 0o700 });
  writeFileSync(skillPath, content, { encoding: "utf8", mode: 0o600 });
}

function registrationByName(plugin: AgentCliPlugin, pluginName: string): CodexPluginRegistration {
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
      return { status: 0, stderr: "", stdout: state.marketplaceRoot === undefined ? "" : `fleet-harness ${state.marketplaceRoot}\n` };
    }
    if (line === "plugin marketplace remove fleet-harness") {
      state.marketplaceRoot = undefined;
      return { status: 0, stderr: "", stdout: "" };
    }
    if (line.startsWith("plugin marketplace add ")) {
      state.marketplaceRoot = line.slice("plugin marketplace add ".length);
      return { status: 0, stderr: "", stdout: "" };
    }
    if (line === "plugin list") {
      return { status: 0, stderr: "", stdout: state.plugin ? "fleet@fleet-harness  installed, enabled\n" : "" };
    }
    if (line.startsWith("plugin add ") && line.endsWith(" -m fleet-harness")) {
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
    env: { CODEX_HOME: homeDir ?? makeCodexHome() },
  };
}

function makeCodexHome(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "fleet-codex-home-"));
  tempCodexHomes.push(root);
  return root;
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
