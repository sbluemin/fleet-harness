import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupDeprecatedCodexPluginState, createAgentCliPlugin, ensureCodexPluginRegistered } from "../src/agent-cli/plugin/index.js";
import type { CodexCommandRunner } from "../src/agent-cli/plugin/index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent CLI plugin marketplace rendering", () => {
  it("serializes concurrent marketplace renders and preserves user-owned files", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-race-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "project");
    const homeMarketplace = path.join(dataDir, "marketplace");
    mkdirSync(path.join(dataDir, "skills", "custom"), { recursive: true });
    mkdirSync(path.join(homeMarketplace), { recursive: true });
    writeFileSync(path.join(homeMarketplace, "user-note.txt"), "home user file\n", { flag: "wx" });
    writeFileSync(path.join(dataDir, "skills", "custom", "SKILL.md"), "# Custom\n", { flag: "wx" });
    let firstHomeLockHeld = false;
    const firstHomeEntered = createDeferred<void>();
    const releaseFirstHome = createDeferred<void>();
    const secondHomeWaited = createDeferred<void>();
    const lockLog: string[] = [];
    const activeLocksByTarget = new Map<string, number>();
    const lockTailByTarget = new Map<string, Promise<void>>();
    const withMarketplaceLock = async <T>(target: string, fn: () => T | Promise<T>): Promise<T> => {
      const previous = lockTailByTarget.get(target);
      const releaseCurrent = createDeferred<void>();
      lockTailByTarget.set(target, releaseCurrent.promise);
      if (previous) {
        if (target === homeMarketplace) secondHomeWaited.resolve(undefined);
        await previous;
      }
      lockLog.push(`enter:${path.relative(root, target)}`);
      activeLocksByTarget.set(target, (activeLocksByTarget.get(target) ?? 0) + 1);
      expect(activeLocksByTarget.get(target)).toBe(1);
      try {
        if (target === homeMarketplace && !firstHomeLockHeld) {
          firstHomeLockHeld = true;
          firstHomeEntered.resolve(undefined);
          await releaseFirstHome.promise;
        }
        return await fn();
      } finally {
        activeLocksByTarget.set(target, (activeLocksByTarget.get(target) ?? 1) - 1);
        releaseCurrent.resolve(undefined);
        if (lockTailByTarget.get(target) === releaseCurrent.promise) lockTailByTarget.delete(target);
        lockLog.push(`exit:${path.relative(root, target)}`);
      }
    };

    const firstRender = createAgentCliPlugin({
      cliId: "codex",
      cwd,
      dataDir,
      withMarketplaceLock,
    });
    await firstHomeEntered.promise;
    const secondRender = createAgentCliPlugin({
      cliId: "codex",
      cwd,
      dataDir,
      withMarketplaceLock,
    });
    await secondHomeWaited.promise;
    releaseFirstHome.resolve(undefined);
    const [first, second] = await Promise.all([firstRender, secondRender]);
    const runCodex: CodexCommandRunner = () => ({ status: 0, stdout: "", stderr: "" });
    for (const registration of second.codexRegistrations) {
      const warning = await ensureCodexPluginRegistered(registration, {
        args: [],
        bin: "codex",
        cwd,
        env: { CODEX_HOME: path.join(root, "codex-home") },
      }, runCodex, withMarketplaceLock);
      expect(warning).toBeUndefined();
      expect(readFileSync(registration.hashPath, "utf8")).toBe(`${registration.contentHash}\n`);
    }

    expect(first.pluginRoots).toEqual(second.pluginRoots);
    expect(lockLog.indexOf(`exit:${path.relative(root, homeMarketplace)}`)).toBeLessThan(lockLog.lastIndexOf(`enter:${path.relative(root, homeMarketplace)}`));
    expect(lockLog.filter((entry) => entry.startsWith("enter:"))).toHaveLength(3);
    expect(readFileSync(path.join(homeMarketplace, "user-note.txt"), "utf8")).toBe("home user file\n");
    expect(existsSync(path.join(homeMarketplace, ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(findStagingEntries(homeMarketplace)).toEqual([]);
  });

  it("wires AskUserQuestion PreToolUse and input-waiting Notification hooks for Claude", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-hooks-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const inputWaitingHookExec = { command: "node", args: ["cli.mjs", "hook", "attention"] };

    const plugin = await createAgentCliPlugin({
      cliId: "claude",
      cwd,
      dataDir,
      inputWaitingHookExec,
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, unknown>;
    };
    // AskUserQuestion은 Notification 훅을 발화하지 않으므로 PreToolUse(정확 매처)로 잡는다.
    expect(hooksJson.hooks.PreToolUse).toEqual([
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "attention"] }] },
    ]);
    // 그 외 입력 대기는 입력 대기 Notification 타입만 |-구분 정확 매처로 거른다.
    expect(hooksJson.hooks.Notification).toEqual([
      { matcher: "permission_prompt|elicitation_dialog", hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "attention"] }] },
    ]);
  });

  it("wires capture, turn-start, and auto-name hooks onto Claude UserPromptSubmit in order", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-uphooks-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "project");
    mkdirSync(cwd, { recursive: true });

    const plugin = await createAgentCliPlugin({
      cliId: "claude",
      cwd,
      dataDir,
      captureSessionHookExec: { command: "node", args: ["cli.mjs", "hook", "capture-session", "claude"] },
      turnStartHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-start"] },
      turnEndHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-end"] },
      autoNameHookExec: { command: "node", args: ["cli.mjs", "hook", "auto-name"] },
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, ReadonlyArray<{ readonly hooks: ReadonlyArray<{ readonly args: readonly string[] }> }>>;
    };
    const userPromptSubmit = hooksJson.hooks.UserPromptSubmit?.[0]?.hooks.map((hook) => hook.args[2]);
    expect(userPromptSubmit).toEqual(["capture-session", "turn-start", "auto-name"]);
  });

  it("renders Cursor doctrine hook, session hooks, and MCP config", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-cursor-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "project");
    mkdirSync(cwd, { recursive: true });

    const plugin = await createAgentCliPlugin({
      cliId: "cursor",
      cwd,
      dataDir,
      doctrine: "Fleet doctrine",
      captureSessionHookExec: { command: "node", args: ["cli.mjs", "hook", "capture-session", "cursor"] },
      turnStartHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-start"] },
      turnEndHookExec: { command: "node", args: ["cli.mjs", "hook", "turn-end"] },
      autoNameHookExec: { command: "node", args: ["cli.mjs", "hook", "auto-name"] },
      mcpServers: [{ name: "fleet", endpointUrl: "http://127.0.0.1:48123/mcp", bearerToken: "token-123" }],
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    const manifest = JSON.parse(readFileSync(path.join(plugin.pluginRoot, ".cursor-plugin", "plugin.json"), "utf8")) as { readonly name?: unknown };
    const doctrineFile = path.join(plugin.pluginRoot, "doctrine.md");
    const doctrine = readFileSync(doctrineFile, "utf8");
    const doctrineHookScript = path.join(plugin.pluginRoot, "hooks", "inject-doctrine.mjs");
    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly version?: unknown;
      readonly hooks?: Record<string, ReadonlyArray<{ readonly command?: string }>>;
    };
    const mcpJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "mcp.json"), "utf8")) as {
      readonly mcpServers?: Record<string, { readonly headers?: { readonly Authorization?: string } }>;
    };
    const hookOutput = spawnSync(process.execPath, [doctrineHookScript], { encoding: "utf8" });

    expect(manifest.name).toBe("fleet");
    expect(doctrine).toContain("Fleet Runtime Doctrine for Cursor Agent");
    expect(doctrine).toContain("sessionStart hook");
    expect(doctrine).toContain("identity anchor for this session");
    expect(doctrine).toContain("Do not merely summarize or acknowledge the embedded prompt");
    expect(doctrine).toContain("<fleet-system-prompt>\nFleet doctrine\n</fleet-system-prompt>");
    expect(existsSync(path.join(plugin.pluginRoot, "rules", "fleet-doctrine.mdc"))).toBe(false);
    expect(existsSync(path.join(plugin.pluginRoot, "context", "fleet-system-prompt.txt"))).toBe(false);
    expect(hookOutput.status).toBe(0);
    expect(JSON.parse(hookOutput.stdout)).toEqual({
      additional_context: doctrine,
    });
    expect(hooksJson.version).toBe(1);
    expect(hooksJson.hooks?.sessionStart).toHaveLength(2);
    expect(hooksJson.hooks?.sessionStart?.[0]?.command).toContain("inject-doctrine.mjs");
    expect(hooksJson.hooks?.sessionStart?.[0]?.command).not.toContain(".fleet-stage-");
    expect(hooksJson.hooks?.sessionStart?.[1]?.command).toBe("'node' 'cli.mjs' 'hook' 'capture-session' 'cursor'");
    expect(JSON.stringify(hooksJson)).not.toContain("subagents-context");
    expect(JSON.stringify(hooksJson)).not.toContain("additional-context-file");
    expect(hooksJson.hooks?.beforeSubmitPrompt?.map((hook) => hook.command)).toEqual([
      "'node' 'cli.mjs' 'hook' 'turn-start'",
      "'node' 'cli.mjs' 'hook' 'auto-name'",
    ]);
    expect(hooksJson.hooks?.stop?.map((hook) => hook.command)).toEqual([
      "'node' 'cli.mjs' 'hook' 'turn-end'",
    ]);
    expect(mcpJson.mcpServers?.fleet?.headers?.Authorization).toBe("Bearer token-123");
  });

  it("prunes stale plugin directories left by removed bundles", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-stale-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "project");
    const stalePluginDir = path.join(dataDir, "marketplace", "plugins", "fleet-global");
    mkdirSync(path.join(stalePluginDir, "skills", "legacy"), { recursive: true });
    writeFileSync(path.join(stalePluginDir, "skills", "legacy", "SKILL.md"), "# Legacy\n", { flag: "wx" });

    await createAgentCliPlugin({
      cliId: "codex",
      cwd,
      dataDir,
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    // 제거된 fleet-global 잔재는 사라지고, 활성 fleet 코어 플러그인은 보존된다.
    expect(existsSync(stalePluginDir)).toBe(false);
    expect(existsSync(path.join(dataDir, "marketplace", "plugins", "fleet"))).toBe(true);
  });
});

describe("deprecated codex plugin cleanup", () => {
  function runCleanup(input: {
    readonly marketplaceList: string;
    readonly pluginList: string;
    readonly cwd: string;
    readonly targets: { readonly homeMarketplaceName: string; readonly homeMarketplaceRoot: string; readonly projectMarketplaceRoot: string };
    readonly failOn?: string;
  }): { readonly commands: string[]; readonly warning: Promise<string | undefined> } {
    const commands: string[] = [];
    const runCommand: CodexCommandRunner = (command) => {
      const line = command.args.join(" ");
      commands.push(line);
      if (line === "plugin marketplace list") return { status: 0, stderr: "", stdout: input.marketplaceList };
      if (line === "plugin list") return { status: 0, stderr: "", stdout: input.pluginList };
      if (input.failOn !== undefined && line === input.failOn) return { status: 1, stderr: "codex boom", stdout: "" };
      return { status: 0, stderr: "", stdout: "" };
    };
    const warning = cleanupDeprecatedCodexPluginState(
      { args: [], bin: "codex", cwd: input.cwd, env: {} },
      runCommand,
      async (_target, fn) => fn(),
      input.targets,
    );
    return { commands, warning };
  }

  it("removes the deprecated fleet-global plugin and keeps the home marketplace", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-cleanup-global-"));
    tempDirs.push(root);
    const { commands, warning } = runCleanup({
      marketplaceList: `fleet-harness ${path.join(root, "marketplace")}\n`,
      pluginList: "fleet@fleet-harness  installed, enabled\nfleet-global@fleet-harness  installed, enabled\n",
      cwd: path.join(root, "project"),
      targets: { homeMarketplaceName: "fleet-harness", homeMarketplaceRoot: path.join(root, "marketplace"), projectMarketplaceRoot: path.join(root, "project", ".fleet") },
    });
    expect(await warning).toBeUndefined();
    expect(commands).toContain("plugin remove fleet-global -m fleet-harness");
    expect(commands).not.toContain("plugin marketplace remove fleet-harness");
  });

  it("removes the project marketplace and flat filesystem residue for the current cwd", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-cleanup-project-"));
    tempDirs.push(root);
    const projectFleetRoot = path.join(root, "project", ".fleet");
    for (const entry of [".agents", ".claude-plugin", "plugin", "knowledge"]) {
      mkdirSync(path.join(projectFleetRoot, entry), { recursive: true });
    }
    const marketplaceName = "fleet-project-abc123def456";
    const { commands, warning } = runCleanup({
      marketplaceList: `fleet-harness ${path.join(root, "marketplace")}\n${marketplaceName} ${projectFleetRoot}\n`,
      pluginList: `fleet@fleet-harness  installed, enabled\nfleet-project@${marketplaceName}  installed, enabled\n`,
      cwd: path.join(root, "project"),
      targets: { homeMarketplaceName: "fleet-harness", homeMarketplaceRoot: path.join(root, "marketplace"), projectMarketplaceRoot: projectFleetRoot },
    });
    expect(await warning).toBeUndefined();
    expect(commands).toContain(`plugin remove fleet-project -m ${marketplaceName}`);
    expect(commands).toContain(`plugin marketplace remove ${marketplaceName}`);
    expect(existsSync(path.join(projectFleetRoot, ".agents"))).toBe(false);
    expect(existsSync(path.join(projectFleetRoot, ".claude-plugin"))).toBe(false);
    expect(existsSync(path.join(projectFleetRoot, "plugin"))).toBe(false);
    // flat 잔재 3개만 제거하고 다른 .fleet 콘텐츠(knowledge)는 보존한다.
    expect(existsSync(path.join(projectFleetRoot, "knowledge"))).toBe(true);
  });

  it("does not touch project marketplaces rooted at a different cwd", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-cleanup-other-"));
    tempDirs.push(root);
    const projectFleetRoot = path.join(root, "project", ".fleet");
    const otherFleetRoot = path.join(root, "other", ".fleet");
    mkdirSync(projectFleetRoot, { recursive: true });
    mkdirSync(otherFleetRoot, { recursive: true });
    const otherName = "fleet-project-999888777666";
    const { commands, warning } = runCleanup({
      marketplaceList: `${otherName} ${otherFleetRoot}\n`,
      pluginList: `fleet-project@${otherName}  installed, enabled\n`,
      cwd: path.join(root, "project"),
      targets: { homeMarketplaceName: "fleet-harness", homeMarketplaceRoot: path.join(root, "marketplace"), projectMarketplaceRoot: projectFleetRoot },
    });
    expect(await warning).toBeUndefined();
    expect(commands).not.toContain(`plugin marketplace remove ${otherName}`);
    expect(existsSync(otherFleetRoot)).toBe(true);
  });

  it("is a no-op when no deprecated state remains", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-cleanup-noop-"));
    tempDirs.push(root);
    const { commands, warning } = runCleanup({
      marketplaceList: `fleet-harness ${path.join(root, "marketplace")}\n`,
      pluginList: "fleet@fleet-harness  installed, enabled\n",
      cwd: path.join(root, "project"),
      targets: { homeMarketplaceName: "fleet-harness", homeMarketplaceRoot: path.join(root, "marketplace"), projectMarketplaceRoot: path.join(root, "project", ".fleet") },
    });
    expect(await warning).toBeUndefined();
    expect(commands).toEqual(["plugin marketplace list", "plugin list"]);
  });

  it("returns a warning without throwing when a codex remove command fails", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-cleanup-fail-"));
    tempDirs.push(root);
    const { warning } = runCleanup({
      marketplaceList: `fleet-harness ${path.join(root, "marketplace")}\n`,
      pluginList: "fleet-global@fleet-harness  installed, enabled\n",
      cwd: path.join(root, "project"),
      failOn: "plugin remove fleet-global -m fleet-harness",
      targets: { homeMarketplaceName: "fleet-harness", homeMarketplaceRoot: path.join(root, "marketplace"), projectMarketplaceRoot: path.join(root, "project", ".fleet") },
    });
    expect(await warning).toContain("codex plugin remove fleet-global");
  });
});

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function findStagingEntries(root: string): string[] {
  const entries: string[] = [];
  collectStagingEntries(root, entries);
  return entries.sort();
}

function collectStagingEntries(current: string, entries: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const entryPath = path.join(current, entry.name);
    if (entry.name.startsWith(".fleet-stage-")) {
      entries.push(entryPath);
      continue;
    }
    if (entry.isDirectory()) collectStagingEntries(entryPath, entries);
  }
}
