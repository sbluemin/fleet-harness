import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGlobalOptionsService, createGlobalOptionsStore, sanitizeGlobalOptionsData } from "../src/data-dir/settings/index.js";

const tempDirs: string[] = [];

describe("data-dir settings store", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads empty defaults from the injected data directory", () => {
    const dataDir = makeTempDir();
    const store = createGlobalOptionsStore({ dataDir });

    expect(store.load()).toEqual({
      version: 1,
    });
    expect(store.path).toBe(path.join(dataDir, "settings.json"));
  });

  it("does not migrate presets.json", () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, "presets.json"), JSON.stringify({
      version: 1,
      [["default", "CliId"].join("")]: "codex",
      byCli: {
        codex: {
          replaceSystemPrompt: true,
          enableMetaphor: true,
        },
      },
    }));

    expect(createGlobalOptionsStore({ dataDir }).load()).toEqual({
      version: 1,
    });
    expect(fs.existsSync(path.join(dataDir, "settings.json"))).toBe(false);
  });

  it("recovers malformed JSON as safe defaults", () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, "settings.json"), "{nope", "utf-8");

    expect(createGlobalOptionsStore({ dataDir }).load()).toEqual({
      version: 1,
    });
  });

  it("sanitizes unknown schema fields and invalid values", () => {
    expect(sanitizeGlobalOptionsData({
      version: 1,
      obsoleteOption: true,
      replaceSystemPrompt: "yes",
      enableMetaphor: false,
      byCli: { claude: { model: "opus" } },
      [["cursor", "Sync"].join("")]: false,
      [["default", "CliId"].join("")]: "claude",
      model: "opus",
      consolePortMode: "static",
      consoleStaticPort: 8080,
    })).toEqual({
      changed: true,
      data: {
        version: 1,
        enableMetaphor: false,
      },
    });
  });

  it("preserves valid codex launch modes and strips invalid values", () => {
    expect(sanitizeGlobalOptionsData({
      version: 1,
      codexLaunchMode: "acp",
    })).toEqual({
      changed: false,
      data: {
        version: 1,
        codexLaunchMode: "acp",
      },
    });
    expect(sanitizeGlobalOptionsData({
      version: 1,
      codexLaunchMode: "app-server",
    })).toEqual({
      changed: false,
      data: {
        version: 1,
        codexLaunchMode: "app-server",
      },
    });
    expect(sanitizeGlobalOptionsData({
      version: 1,
      codexLaunchMode: "legacy",
    })).toEqual({
      changed: true,
      data: {
        version: 1,
      },
    });
  });

  it("drops the legacy replaceSystemPrompt option while preserving enableMetaphor", () => {
    // 이전 릴리스가 남긴 ~/.fleet/settings.json의 replaceSystemPrompt(boolean) 키는
    // 이제 미허용 키이므로 changed=true와 함께 안전 드롭되고 enableMetaphor는 보존되어야 한다.
    expect(sanitizeGlobalOptionsData({
      version: 1,
      replaceSystemPrompt: true,
      enableMetaphor: false,
    })).toEqual({
      changed: true,
      data: {
        version: 1,
        enableMetaphor: false,
      },
    });
  });

  it("ignores stale settings files without the current schema marker", () => {
    expect(sanitizeGlobalOptionsData({
      obsoleteOption: true,
      replaceSystemPrompt: true,
      enableMetaphor: true,
      oldSection: {},
    })).toEqual({
      changed: true,
      data: {
        version: 1,
      },
    });
  });

  it("ignores settings files with a stale schema marker", () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({
      version: 99,
      obsoleteOption: true,
      replaceSystemPrompt: true,
      enableMetaphor: true,
    }));

    expect(createGlobalOptionsStore({ dataDir }).load()).toEqual({
      version: 1,
    });
  });

  it("writes through temp rename and cleans temp files", () => {
    const dataDir = makeTempDir();
    const service = createGlobalOptionsService({ dataDir });

    service.save({
      version: 1,
      enableMetaphor: true,
    });

    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8"))).toEqual({
      version: 1,
      enableMetaphor: true,
    });
    expect(fs.readdirSync(dataDir).filter((name) => name.startsWith(".tmp-settings.json"))).toEqual([]);
  });

  it("sanitizes stale console port fields that migrated to console-settings store", () => {
    expect(sanitizeGlobalOptionsData({
      version: 1,
      enableMetaphor: false,
      consolePortMode: "static",
      consoleStaticPort: 8080,
    })).toEqual({
      changed: true,
      data: {
        version: 1,
        enableMetaphor: false,
      },
    });
  });

  it("recovers stale locks and times out on fresh locks", () => {
    const dataDir = makeTempDir();
    const lockPath = path.join(dataDir, "settings.json.lock");
    fs.mkdirSync(lockPath);
    const old = Date.now() - 60_000;
    fs.writeFileSync(path.join(lockPath, "owner"), JSON.stringify({ hostname: os.hostname(), pid: 99_999_999, startedAt: old }));
    fs.utimesSync(lockPath, old / 1000, old / 1000);
    const staleStore = createGlobalOptionsStore({ dataDir, staleLockMs: 1, timeoutMs: 50 });

    expect(staleStore.update((current) => current)).toEqual({
      version: 1,
    });

    fs.mkdirSync(lockPath);
    const freshStore = createGlobalOptionsStore({ dataDir, staleLockMs: 60_000, timeoutMs: 20 });
    expect(() => freshStore.update((current) => current)).toThrow(/Timed out waiting/);
  });

  it("does not recover stale locks owned by a live same-host process", () => {
    const dataDir = makeTempDir();
    const lockPath = path.join(dataDir, "settings.json.lock");
    fs.mkdirSync(lockPath);
    const old = Date.now() - 60_000;
    fs.writeFileSync(path.join(lockPath, "owner"), JSON.stringify({ hostname: os.hostname(), pid: process.pid, startedAt: old }));
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    const store = createGlobalOptionsStore({ dataDir, staleLockMs: 1, timeoutMs: 20 });

    expect(() => store.update((current) => current)).toThrow(/Timed out waiting/);
  });

  it("cleans only old global-options temp files after acquiring the lock", () => {
    const dataDir = makeTempDir();
    const oldTemp = path.join(dataDir, ".tmp-settings.json-old");
    const freshTemp = path.join(dataDir, ".tmp-settings.json-fresh");
    fs.writeFileSync(oldTemp, "old");
    fs.writeFileSync(freshTemp, "fresh");
    const now = Date.now();
    fs.utimesSync(oldTemp, (now - 120_000) / 1000, (now - 120_000) / 1000);

    createGlobalOptionsStore({ dataDir, now: () => now }).update((current) => current);

    expect(fs.existsSync(oldTemp)).toBe(false);
    expect(fs.existsSync(freshTemp)).toBe(true);
  });

  it("keeps overlapping read mutate write operations from losing the latest snapshot", async () => {
    const dataDir = makeTempDir();
    const first = createGlobalOptionsStore({ dataDir, timeoutMs: 1_000 });
    const second = createGlobalOptionsStore({ dataDir, timeoutMs: 1_000 });

    await Promise.all([
      Promise.resolve().then(() => first.update((current) => ({ ...current, enableMetaphor: false }))),
      Promise.resolve().then(() => second.update((current) => ({ ...current, enableMetaphor: true }))),
    ]);

    expect(first.load()).toEqual({
      version: 1,
      enableMetaphor: true,
    });
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-global-options-"));
  tempDirs.push(dir);
  return dir;
}
