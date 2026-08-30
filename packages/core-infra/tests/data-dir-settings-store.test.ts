import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGlobalOptionsService, createGlobalOptionsStore, sanitizeGlobalOptionsData } from "../src/data-dir/settings/store.js";

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
      },
    });
  });

  it("preserves claudeCodeSystemPrompt and drops values outside the two modes", () => {
    for (const mode of ["on", "off"] as const) {
      expect(sanitizeGlobalOptionsData({ version: 1, claudeCodeSystemPrompt: mode })).toEqual({
        changed: false,
        data: { version: 1, claudeCodeSystemPrompt: mode },
      });
    }
    // 키가 없는 것은 결함이 아니라 기본값(on)이므로 그대로 비워 둔다.
    expect(sanitizeGlobalOptionsData({ version: 1 })).toEqual({ changed: false, data: { version: 1 } });
    // 알 수 없는 값은 지워지고, 그 사실이 changed로 보고되어 파일이 정리된다.
    expect(sanitizeGlobalOptionsData({ version: 1, claudeCodeSystemPrompt: "append" })).toEqual({
      changed: true,
      data: { version: 1 },
    });
  });

  it("keeps claudeCodeSkipPermissions only as a real boolean", () => {
    for (const skip of [true, false]) {
      expect(sanitizeGlobalOptionsData({ version: 1, claudeCodeSkipPermissions: skip })).toEqual({
        changed: false,
        data: { version: 1, claudeCodeSkipPermissions: skip },
      });
    }
    // 키가 없으면 게이트가 살아 있는 것이고, 그 부재는 결함이 아니다.
    expect(sanitizeGlobalOptionsData({ version: 1 })).toEqual({ changed: false, data: { version: 1 } });
    // 참으로 읽히는 값은 동의가 아니다 — 지우고 그 사실을 changed로 보고해 파일을 정리한다.
    for (const value of ["true", 1, "on"]) {
      expect(sanitizeGlobalOptionsData({ version: 1, claudeCodeSkipPermissions: value })).toEqual({
        changed: true,
        data: { version: 1 },
      });
    }
  });

  it("preserves valid agentIdleDormantMinutes and drops invalid values", () => {
    expect(sanitizeGlobalOptionsData({
      version: 1,
      agentIdleDormantMinutes: 60,
    })).toEqual({
      changed: false,
      data: {
        version: 1,
        agentIdleDormantMinutes: 60,
      },
    });
    expect(sanitizeGlobalOptionsData({
      version: 1,
      agentIdleDormantMinutes: null,
    })).toEqual({
      changed: false,
      data: {
        version: 1,
        agentIdleDormantMinutes: null,
      },
    });
    expect(sanitizeGlobalOptionsData({
      version: 1,
      agentIdleDormantMinutes: 0,
    })).toEqual({
      changed: true,
      data: { version: 1 },
    });
    expect(sanitizeGlobalOptionsData({
      version: 1,
      agentIdleDormantMinutes: -5,
    })).toEqual({
      changed: true,
      data: { version: 1 },
    });
    expect(sanitizeGlobalOptionsData({
      version: 1,
      agentIdleDormantMinutes: 1.5,
    })).toEqual({
      changed: true,
      data: { version: 1 },
    });
    expect(sanitizeGlobalOptionsData({
      version: 1,
      agentIdleDormantMinutes: Number.POSITIVE_INFINITY,
    })).toEqual({
      changed: true,
      data: { version: 1 },
    });
    expect(sanitizeGlobalOptionsData({
      version: 1,
      agentIdleDormantMinutes: "60",
    })).toEqual({
      changed: true,
      data: { version: 1 },
    });
  });

  it("drops the relocated aiGateway key from global options", () => {
    // AI Gateway 선별은 core-ai-gateway가 소유하는 별도 파일(`<dataDir>/ai-gateway.json`)로 이전됐다.
    expect(sanitizeGlobalOptionsData({
      version: 1,
      aiGateway: { models: [{ id: "cursor--grok-4.5" }] },
    })).toEqual({
      changed: true,
      data: { version: 1 },
    });
  });

  it("drops legacy codex launch modes", () => {
    expect(sanitizeGlobalOptionsData({
      version: 1,
      codexLaunchMode: "acp",
    })).toEqual({
      changed: true,
      data: { version: 1 },
    });
    expect(sanitizeGlobalOptionsData({
      version: 1,
      codexLaunchMode: "app-server",
    })).toEqual({
      changed: true,
      data: { version: 1 },
    });
  });

  it("drops the legacy replaceSystemPrompt and retired enableMetaphor options", () => {
    // 이전 릴리스가 남긴 ~/.fleet/settings.json의 replaceSystemPrompt와, Classic과 함께
    // 퇴역한 enableMetaphor는 둘 다 미허용 키이므로 changed=true와 함께 안전 드롭된다.
    expect(sanitizeGlobalOptionsData({
      version: 1,
      replaceSystemPrompt: true,
      enableMetaphor: false,
      agentIdleDormantMinutes: 45,
    })).toEqual({
      changed: true,
      data: {
        version: 1,
        agentIdleDormantMinutes: 45,
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
      agentIdleDormantMinutes: 90,
    });

    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf-8"))).toEqual({
      version: 1,
      agentIdleDormantMinutes: 90,
    });
    expect(fs.readdirSync(dataDir).filter((name) => name.startsWith(".tmp-settings.json"))).toEqual([]);
  });

  it("sanitizes stale console port fields that migrated to console-settings store", () => {
    expect(sanitizeGlobalOptionsData({
      version: 1,
      agentIdleDormantMinutes: 30,
      consolePortMode: "static",
      consoleStaticPort: 8080,
    })).toEqual({
      changed: true,
      data: {
        version: 1,
        agentIdleDormantMinutes: 30,
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
      Promise.resolve().then(() => first.update((current) => ({ ...current, agentIdleDormantMinutes: 15 }))),
      Promise.resolve().then(() => second.update((current) => ({ ...current, agentIdleDormantMinutes: 45 }))),
    ]);

    expect(first.load()).toEqual({
      version: 1,
      agentIdleDormantMinutes: 45,
    });
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-global-options-"));
  tempDirs.push(dir);
  return dir;
}
