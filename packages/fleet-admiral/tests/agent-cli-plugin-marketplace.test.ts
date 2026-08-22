import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentCliPlugin } from "../src/agent-cli/plugin/index.js";

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
    mkdirSync(homeMarketplace, { recursive: true });
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

    const firstRender = createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withMarketplaceLock });
    await firstHomeEntered.promise;
    const secondRender = createAgentCliPlugin({ cliId: "claude-gateway", cwd, dataDir, withMarketplaceLock });
    await secondHomeWaited.promise;
    releaseFirstHome.resolve(undefined);
    const [first, second] = await Promise.all([firstRender, secondRender]);

    expect(first.pluginRoots).toEqual(second.pluginRoots);
    expect(lockLog.indexOf(`exit:${path.relative(root, homeMarketplace)}`)).toBeLessThan(lockLog.lastIndexOf(`enter:${path.relative(root, homeMarketplace)}`));
    expect(lockLog.filter((entry) => entry.startsWith("enter:"))).toHaveLength(2);
    expect(readFileSync(path.join(homeMarketplace, "user-note.txt"), "utf8")).toBe("home user file\n");
    expect(existsSync(path.join(homeMarketplace, ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(findStagingEntries(homeMarketplace)).toEqual([]);
  });

  it("wires AskUserQuestion PreToolUse and input-waiting Notification hooks for a gateway session", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-hooks-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const inputWaitingHookExec = { command: "node", args: ["cli.mjs", "hook", "attention"] };

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      inputWaitingHookExec,
      backgroundReportHookExec: { command: "node", args: ["cli.mjs", "hook", "background-report"] },
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    const hooksJson = JSON.parse(readFileSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"), "utf8")) as {
      readonly hooks: Record<string, unknown>;
    };
    // AskUserQuestion은 Notification 훅을 발화하지 않으므로 PreToolUse(정확 매처)로 잡는다.
    // Agent|Workflow에는 위임 게이트가 상주한다. spawn 카운팅 신호가 아니라 핀되지 않은 위임을
    // 실행 전에 차단할 뿐이라 #554가 우려한 카운팅 불일치와 무관하다.
    expect(hooksJson.hooks.PreToolUse).toEqual([
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "attention"] }] },
      { matcher: "Agent|Workflow", hooks: [{ type: "command", command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs", "gate-delegation"] }] },
    ]);
    expect(hooksJson.hooks.PostToolUse).toEqual([
      {
        matcher: "Workflow",
        hooks: [{
          type: "command",
          command: process.execPath,
          args: ["${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs", "workflow-receipt"],
        }],
      },
    ]);
    // orchestration \uc2a4\ud0ac \uc804\ud6c4\uc5d0\ub294 \ud6c5\uc744 \uac78\uc9c0 \uc54a\ub294\ub2e4. Claude Code\uc758 `if`\ub294 \ud37c\ubbf8\uc158 \ub8f0\ub85c \ud3c9\uac00\ub418\uace0
    // Skill \ub3c4\uad6c\uc5d0\ub294 \ub8f0 \ucf58\ud150\uce20 \ub9e4\ucc98\uac00 \uc5c6\uc5b4 `Skill(<name>)` \uc870\uac74\uc774 \ud56d\uc0c1 \uac70\uc9d3\uc774 \ub418\uae30 \ub54c\ubb38\uc774\ub2e4.
    expect(hooksJson.hooks.PostToolUseFailure).toBeUndefined();
    expect(hooksJson.hooks.SessionEnd).toBeUndefined();
    expect(JSON.stringify(hooksJson)).not.toContain("Skill(fleet:orchestration)");
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"))).toBe(true);
    expect(hooksJson.hooks.SubagentStop).toEqual([
      { hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "background-report"] }] },
    ]);
    // 그 외 입력 대기는 입력 대기 Notification 타입만 |-구분 정확 매처로 거른다.
    expect(hooksJson.hooks.Notification).toEqual([
      { matcher: "permission_prompt|elicitation_dialog", hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "attention"] }] },
    ]);
  });

  it("wires capture, turn-start, and auto-name onto Claude UserPromptSubmit in order", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-uphooks-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "project");
    mkdirSync(cwd, { recursive: true });

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
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
    const userPromptSubmit = hooksJson.hooks.UserPromptSubmit?.[0]?.hooks ?? [];
    expect(userPromptSubmit.slice(0, 3).map((hook) => hook.args[2])).toEqual(["capture-session", "turn-start", "auto-name"]);
    // orchestration 스킬 라우팅 트립와이어는 host 훅 뒤에 선다. 로스터와 핀 문법은
    // 스킬 완료 뒤 PostToolUse가 공급하고, 여기서는 필요한 요청에서 스킬을 먼저 열게 한다.
    expect(userPromptSubmit[3]?.args).toEqual([
      "${CLAUDE_PLUGIN_ROOT}/hooks/fleet-gateway-model-guard.mjs",
      "remind",
    ]);
    expect(userPromptSubmit).toHaveLength(4);
    expect(hooksJson.hooks.Stop?.[0]?.hooks.map((hook) => hook.args[2])).toEqual(["turn-end"]);
  });



  it("prunes legacy Cursor plugin artifacts without generating new ones", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-cursor-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const marketplaceRoot = path.join(dataDir, "marketplace");
    const legacyMarketplace = path.join(marketplaceRoot, ".cursor-plugin", "marketplace.json");
    const legacyManifest = path.join(marketplaceRoot, "plugins", "fleet", ".cursor-plugin", "plugin.json");
    mkdirSync(path.dirname(legacyMarketplace), { recursive: true });
    mkdirSync(path.dirname(legacyManifest), { recursive: true });
    writeFileSync(legacyMarketplace, "{}\n");
    writeFileSync(legacyManifest, "{}\n");

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd: path.join(root, "project"),
      dataDir,
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    expect(existsSync(path.join(marketplaceRoot, ".cursor-plugin"))).toBe(false);
    expect(existsSync(path.join(plugin.pluginRoot, ".cursor-plugin"))).toBe(false);
    expect(existsSync(path.join(plugin.pluginRoot, "mcp.json"))).toBe(false);
    expect(existsSync(path.join(plugin.pluginRoot, "doctrine.md"))).toBe(false);
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
      cliId: "claude-gateway",
      cwd,
      dataDir,
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    expect(existsSync(stalePluginDir)).toBe(false);
    expect(existsSync(path.join(dataDir, "marketplace", "plugins", "fleet-gateway"))).toBe(true);
  });

  it("renders exactly the selected on-demand skill assets", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-gateway-skills-"));
    tempDirs.push(root);

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd: path.join(root, "project"),
      dataDir: path.join(root, "data"),
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    const skillsRoot = path.join(plugin.pluginRoot, "skills");
    expect(readdirSync(skillsRoot).sort()).toEqual([
      "orchestration",
      "professional-pushback",
    ]);
    for (const skillName of readdirSync(skillsRoot)) {
      expect(existsSync(path.join(skillsRoot, skillName, "SKILL.md"))).toBe(true);
    }
    // 실시간 로스터·핀 규율은 스킬 본문이 아니라 훅과 모델 가드가 소유한다.
    expect(existsSync(path.join(plugin.pluginRoot, "agents"))).toBe(true);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "fleet-gateway-model-guard.mjs"))).toBe(true);
  });

  it("renders only the gateway asset root and prunes retired roots", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-gateway-root-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const pluginsRoot = path.join(dataDir, "marketplace", "plugins");
    const retiredClassicRoot = path.join(pluginsRoot, "fleet");
    const retiredNativeRoot = path.join(pluginsRoot, "fleet-native");
    mkdirSync(retiredClassicRoot, { recursive: true });
    mkdirSync(retiredNativeRoot, { recursive: true });

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd,
      dataDir,
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    expect(plugin.pluginRoot).toBe(path.join(pluginsRoot, "fleet-gateway"));
    expect(existsSync(retiredClassicRoot)).toBe(false);
    expect(existsSync(retiredNativeRoot)).toBe(false);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"))).toBe(true);
    expect(readdirSync(path.join(plugin.pluginRoot, "skills")).sort()).toEqual([
      "orchestration",
      "professional-pushback",
    ]);
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
