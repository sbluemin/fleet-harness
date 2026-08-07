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
    // 백그라운드 축은 PreToolUse spawn을 세지 않는다 — 워크플로우 1건이 spawn 1회·stop N회를 내기 때문이다.
    expect(hooksJson.hooks.PreToolUse).toEqual([
      { matcher: "AskUserQuestion", hooks: [{ type: "command", command: "node", args: ["cli.mjs", "hook", "attention"] }] },
    ]);
    expect(JSON.stringify(hooksJson.hooks)).not.toContain("Task|Agent|Workflow");
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
    const userPromptSubmit = hooksJson.hooks.UserPromptSubmit?.[0]?.hooks.map((hook) => hook.args[2]);
    expect(userPromptSubmit).toEqual(["capture-session", "turn-start", "auto-name"]);
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

  it("omits protocol skills and carrier-operations for gateway doctrine", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-gateway-doctrine-"));
    tempDirs.push(root);

    const plugin = await createAgentCliPlugin({
      cliId: "claude-gateway",
      cwd: path.join(root, "project"),
      dataDir: path.join(root, "data"),
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    const skillsRoot = path.join(plugin.pluginRoot, "skills");
    expect(existsSync(path.join(skillsRoot, "carrier-operations", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(skillsRoot, "gateway"))).toBe(false);
    for (const mode of ["protocol-baseline", "protocol-frontline", "protocol-midline", "protocol-redline"]) {
      expect(existsSync(path.join(skillsRoot, mode, "SKILL.md"))).toBe(false);
    }
    expect(existsSync(path.join(skillsRoot, "wiki-operations", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(skillsRoot, "assumption-audit", "SKILL.md"))).toBe(true);
    // gateway 전용 오버레이는 대응하는 base 자산이 없어도 렌더된다.
    // 캐리어 페르소나가 맡던 역할은 gateway에서 작전별 워크플로 스킬이 대신한다.
    for (const skill of [
      "workflow",
      "workflow-architecting",
      "workflow-implementing",
      "workflow-review",
      "workflow-research",
    ]) {
      expect(existsSync(path.join(skillsRoot, skill, "SKILL.md")), skill).toBe(true);
    }
    // 구명 디렉터리가 되살아나면 스킬이 두 벌 렌더되어 어느 쪽이 로드될지 갈라진다.
    for (const retired of ["architecture-review", "implementation-run", "quality-review", "codebase-research"]) {
      expect(existsSync(path.join(skillsRoot, retired)), retired).toBe(false);
    }
    // 모델·effort 배정은 workflow 스킬이 흡수했으므로 별도 스킬로 렌더되지 않는다.
    expect(existsSync(path.join(skillsRoot, "model-loadout"))).toBe(false);

    // gateway/assumption-audit 오버레이가 base 자산을 대체하고 protocol 참조를 남기지 않는다.
    const assumptionAudit = readFileSync(path.join(skillsRoot, "assumption-audit", "SKILL.md"), "utf8");
    expect(assumptionAudit).not.toContain("protocol mode");
    expect(assumptionAudit).not.toContain("Protocol Gate");

    // gateway 경로가 렌더하는 모든 스킬은 프롬프트와 같은 어휘 계약을 따른다:
    // 실행자를 지칭하지 않고 워크플로 스테이지로만 실행을 기술한다.
    const renderedSkills = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(renderedSkills.length).toBeGreaterThan(0);
    for (const skill of renderedSkills) {
      const body = readFileSync(path.join(skillsRoot, skill, "SKILL.md"), "utf8");
      for (const pattern of [/\bcarriers?\b/i, /\bsubagents?\b/i, /\bdelegat\w*/i]) {
        expect(body, `${skill}/SKILL.md`).not.toMatch(pattern);
      }
    }
  });

  it("renders wiki-operations only for native doctrine", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-native-doctrine-"));
    tempDirs.push(root);

    const plugin = await createAgentCliPlugin({
      cliId: "claude-native",
      cwd: path.join(root, "project"),
      dataDir: path.join(root, "data"),
      captureSessionHookExec: { command: "node", args: ["cli.mjs", "hook", "capture-session", "claude"] },
      withMarketplaceLock: async (_target, fn) => fn(),
    });

    expect(plugin.pluginRoot).toBe(path.join(root, "data", "marketplace", "plugins", "fleet-native"));
    const skillsRoot = path.join(plugin.pluginRoot, "skills");
    expect(existsSync(path.join(skillsRoot, "wiki-operations", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(skillsRoot, "carrier-operations", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(skillsRoot, "assumption-audit", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(skillsRoot, "protocol-baseline", "SKILL.md"))).toBe(false);
    expect(existsSync(path.join(plugin.pluginRoot, "hooks", "hooks.json"))).toBe(true);
  });

  it("keeps gateway and native asset roots isolated under the same dataDir", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "fleet-admiral-plugin-doctrine-roots-"));
    tempDirs.push(root);
    const dataDir = path.join(root, "data");
    const cwd = path.join(root, "project");
    mkdirSync(cwd, { recursive: true });
    const withMarketplaceLock = async <T>(_target: string, fn: () => T | Promise<T>): Promise<T> => fn();
    const retiredClassicRoot = path.join(dataDir, "marketplace", "plugins", "fleet");
    const gatewayRoot = path.join(dataDir, "marketplace", "plugins", "fleet-gateway");
    const nativeRoot = path.join(dataDir, "marketplace", "plugins", "fleet-native");

    for (const order of [
      ["claude-gateway", "claude-native"],
      ["claude-native", "claude-gateway"],
    ] as const) {
      let gatewayPluginRoot = "";
      let nativePluginRoot = "";
      for (const cliId of order) {
        const plugin = await createAgentCliPlugin({ cliId, cwd, dataDir, withMarketplaceLock });
        if (cliId === "claude-gateway") gatewayPluginRoot = plugin.pluginRoot;
        else nativePluginRoot = plugin.pluginRoot;
      }

      expect(gatewayPluginRoot).toBe(gatewayRoot);
      expect(nativePluginRoot).toBe(nativeRoot);
      expect(existsSync(gatewayRoot)).toBe(true);
      expect(existsSync(nativeRoot)).toBe(true);
      // 퇴역한 Classic 루트는 다시 렌더되지 않고, 남아 있으면 다음 렌더가 정리한다.
      expect(existsSync(retiredClassicRoot)).toBe(false);
      expect(existsSync(path.join(gatewayRoot, "skills", "carrier-operations", "SKILL.md"))).toBe(false);
      expect(existsSync(path.join(nativeRoot, "skills", "carrier-operations", "SKILL.md"))).toBe(false);
      expect(existsSync(path.join(gatewayRoot, "skills", "protocol-baseline", "SKILL.md"))).toBe(false);
      expect(existsSync(path.join(nativeRoot, "skills", "wiki-operations", "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(nativeRoot, "skills", "assumption-audit", "SKILL.md"))).toBe(false);
    }
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
