import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPresetService, createPresetStore, sanitizePresetData } from "../src/preset/index.js";

const tempDirs: string[] = [];

describe("preset store", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads empty defaults from the injected data directory", () => {
    const dataDir = makeTempDir();
    const store = createPresetStore({ dataDir });

    expect(store.load()).toEqual({ version: 1, byCli: {} });
    expect(store.path).toBe(path.join(dataDir, "presets.json"));
  });

  it("recovers malformed JSON as safe defaults", () => {
    const dataDir = makeTempDir();
    fs.writeFileSync(path.join(dataDir, "presets.json"), "{nope", "utf-8");

    expect(createPresetStore({ dataDir }).load()).toEqual({ version: 1, byCli: {} });
  });

  it("sanitizes unknown schema fields and invalid values", () => {
    expect(sanitizePresetData({
      version: 99,
      defaultCliId: "",
      byCli: {
        constructor: {
          model: "poison",
        },
        claude: {
          model: "opus",
          native: true,
          replaceSystemPrompt: "yes",
          extra: "drop",
        },
      },
    })).toEqual({
      changed: true,
      data: {
        version: 1,
        byCli: {
          claude: {
            model: "opus",
            native: true,
          },
        },
      },
    });
  });

  it("uses null-prototype dictionaries and rejects prototype pollution keys", () => {
    const result = sanitizePresetData(JSON.parse('{"version":1,"byCli":{"__proto__":{"model":"poison"},"prototype":{"model":"poison"},"constructor":{"model":"poison"},"claude":{"model":"opus"}}}')).data;

    expect(Object.getPrototypeOf(result.byCli)).toBeNull();
    expect(Object.hasOwn(result.byCli, "__proto__")).toBe(false);
    expect(Object.hasOwn(result.byCli, "prototype")).toBe(false);
    expect(Object.hasOwn(result.byCli, "constructor")).toBe(false);
    expect(result.byCli.claude).toEqual({ model: "opus" });
    expect((result.byCli as Record<string, unknown>).model).toBeUndefined();
  });

  it("writes through temp rename and cleans temp files", () => {
    const dataDir = makeTempDir();
    const service = createPresetService({ dataDir });

    service.update({
      defaultCliId: "codex",
      cliId: "codex",
      values: { cursorSync: false, model: "gpt-5.4", native: true },
    });

    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "presets.json"), "utf-8"))).toEqual({
      version: 1,
      defaultCliId: "codex",
      byCli: {
        codex: {
          cursorSync: false,
          model: "gpt-5.4",
          native: true,
        },
      },
    });
    expect(fs.readdirSync(dataDir).filter((name) => name.startsWith(".tmp-presets.json"))).toEqual([]);
  });

  it("supports reset/delete semantics", () => {
    const service = createPresetService({ dataDir: makeTempDir() });

    service.saveCliPreset("claude", { model: "opus" });
    service.resetCliPreset("claude");

    expect(service.load()).toEqual({ version: 1, byCli: {} });
  });

  it("rejects dangerous service mutation keys", () => {
    const service = createPresetService({ dataDir: makeTempDir() });

    service.saveCliPreset("__proto__", { model: "poison" });
    service.saveCliPreset("constructor", { model: "poison" });
    service.saveCliPreset("claude", { model: "opus" });

    const loaded = service.load();
    expect(Object.hasOwn(loaded.byCli, "__proto__")).toBe(false);
    expect(Object.hasOwn(loaded.byCli, "constructor")).toBe(false);
    expect((loaded.byCli as Record<string, unknown>).model).toBeUndefined();
    expect(loaded.byCli.claude).toEqual({ model: "opus" });
  });

  it("recovers stale locks and times out on fresh locks", () => {
    const dataDir = makeTempDir();
    const lockPath = path.join(dataDir, "presets.json.lock");
    fs.mkdirSync(lockPath);
    const old = Date.now() - 60_000;
    fs.writeFileSync(path.join(lockPath, "owner"), JSON.stringify({ hostname: os.hostname(), pid: 99_999_999, startedAt: old }));
    fs.utimesSync(lockPath, old / 1000, old / 1000);
    const staleStore = createPresetStore({ dataDir, staleLockMs: 1, timeoutMs: 50 });

    expect(staleStore.update((current) => current)).toEqual({ version: 1, byCli: {} });

    fs.mkdirSync(lockPath);
    const freshStore = createPresetStore({ dataDir, staleLockMs: 60_000, timeoutMs: 20 });
    expect(() => freshStore.update((current) => current)).toThrow(/Timed out waiting/);
  });

  it("does not recover stale locks owned by a live same-host process", () => {
    const dataDir = makeTempDir();
    const lockPath = path.join(dataDir, "presets.json.lock");
    fs.mkdirSync(lockPath);
    const old = Date.now() - 60_000;
    fs.writeFileSync(path.join(lockPath, "owner"), JSON.stringify({ hostname: os.hostname(), pid: process.pid, startedAt: old }));
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    const store = createPresetStore({ dataDir, staleLockMs: 1, timeoutMs: 20 });

    expect(() => store.update((current) => current)).toThrow(/Timed out waiting/);
  });

  it("recovers ownerless stale lock directories", () => {
    const dataDir = makeTempDir();
    const lockPath = path.join(dataDir, "presets.json.lock");
    fs.mkdirSync(lockPath);
    const old = Date.now() - 60_000;
    fs.utimesSync(lockPath, old / 1000, old / 1000);

    const store = createPresetStore({ dataDir, staleLockMs: 1, timeoutMs: 50 });

    expect(store.update((current) => ({
      ...current,
      byCli: { ...current.byCli, codex: { model: "gpt-5.4" } },
    }))).toEqual({
      version: 1,
      byCli: {
        codex: { model: "gpt-5.4" },
      },
    });
  });

  it("cleans only old preset temp files after acquiring the lock", () => {
    const dataDir = makeTempDir();
    const oldTemp = path.join(dataDir, ".tmp-presets.json-old");
    const freshTemp = path.join(dataDir, ".tmp-presets.json-fresh");
    fs.writeFileSync(oldTemp, "old");
    fs.writeFileSync(freshTemp, "fresh");
    const now = Date.now();
    fs.utimesSync(oldTemp, (now - 120_000) / 1000, (now - 120_000) / 1000);

    createPresetStore({ dataDir, now: () => now }).update((current) => current);

    expect(fs.existsSync(oldTemp)).toBe(false);
    expect(fs.existsSync(freshTemp)).toBe(true);
  });

  it("keeps overlapping read mutate write operations from losing updates", async () => {
    const dataDir = makeTempDir();
    const first = createPresetStore({ dataDir, timeoutMs: 1_000 });
    const second = createPresetStore({ dataDir, timeoutMs: 1_000 });

    await Promise.all([
      Promise.resolve().then(() => first.update((current) => ({
        ...current,
        byCli: { ...current.byCli, claude: { model: "opus" } },
      }))),
      Promise.resolve().then(() => second.update((current) => ({
        ...current,
        byCli: { ...current.byCli, codex: { model: "gpt-5.4" } },
      }))),
    ]);

    expect(first.load().byCli).toEqual({
      claude: { model: "opus" },
      codex: { model: "gpt-5.4" },
    });
  });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-preset-"));
  tempDirs.push(dir);
  return dir;
}
