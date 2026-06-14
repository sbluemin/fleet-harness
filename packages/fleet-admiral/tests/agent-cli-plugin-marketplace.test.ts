import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgentCliPlugin, ensureCodexPluginRegistered } from "../src/agent-cli/plugin/index.js";
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
    const projectFleetRoot = path.join(cwd, ".fleet");
    mkdirSync(path.join(dataDir, "skills", "custom"), { recursive: true });
    mkdirSync(path.join(homeMarketplace), { recursive: true });
    mkdirSync(path.join(projectFleetRoot, "skills", "project"), { recursive: true });
    writeFileSync(path.join(homeMarketplace, "user-note.txt"), "home user file\n", { flag: "wx" });
    writeFileSync(path.join(projectFleetRoot, "user-note.txt"), "project user file\n", { flag: "wx" });
    writeFileSync(path.join(dataDir, "skills", "custom", "SKILL.md"), "# Custom\n", { flag: "wx" });
    writeFileSync(path.join(projectFleetRoot, "skills", "project", "SKILL.md"), "# Project\n", { flag: "wx" });
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
      claudeDefinitions: [],
      cliId: "codex",
      cwd,
      dataDir,
      withMarketplaceLock,
    });
    await firstHomeEntered.promise;
    const secondRender = createAgentCliPlugin({
      claudeDefinitions: [],
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
    expect(lockLog.filter((entry) => entry.startsWith("enter:"))).toHaveLength(7);
    expect(readFileSync(path.join(homeMarketplace, "user-note.txt"), "utf8")).toBe("home user file\n");
    expect(readFileSync(path.join(projectFleetRoot, "user-note.txt"), "utf8")).toBe("project user file\n");
    expect(existsSync(path.join(homeMarketplace, ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(existsSync(path.join(projectFleetRoot, ".agents", "plugins", "marketplace.json"))).toBe(true);
    expect(findStagingEntries(homeMarketplace)).toEqual([]);
    expect(findStagingEntries(projectFleetRoot)).toEqual([]);

    const preservedPluginJson = readFileSync(path.join(second.pluginRoot, ".codex-plugin", "plugin.json"), "utf8");
    await expect(createAgentCliPlugin({
      claudeDefinitions: [],
      cliId: "claude",
      cwd,
      dataDir,
      withMarketplaceLock: async (_target, fn) => fn(),
    })).rejects.toThrow("Fleet Claude session hook command is required");
    expect(readFileSync(path.join(second.pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).toBe(preservedPluginJson);
    expect(findStagingEntries(homeMarketplace)).toEqual([]);
    expect(findStagingEntries(projectFleetRoot)).toEqual([]);
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
