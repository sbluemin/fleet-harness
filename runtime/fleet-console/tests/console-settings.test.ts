import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  createConsoleSettingsStore,
  sanitizeConsoleSettingsData,
  emptyConsoleSettingsData,
} from "../core/host/console-settings.js";
import type { ConsoleDataPaths } from "../core/host/paths.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-settings-"));
  tempDirs.push(dir);
  return dir;
}

function makeFakePaths(dir: string): ConsoleDataPaths {
  return {
    dir,
    stateFile: path.join(dir, "state.json"),
    settingsFile: path.join(dir, "settings.json"),
    capturesDir: path.join(dir, "captures"),
  };
}

describe("sanitizeConsoleSettingsData", () => {
  it("returns empty for non-object input", () => {
    expect(sanitizeConsoleSettingsData(null)).toEqual({ version: 1, general: {}, plugins: {} });
    expect(sanitizeConsoleSettingsData("string")).toEqual({ version: 1, general: {}, plugins: {} });
    expect(sanitizeConsoleSettingsData([])).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("returns empty for version mismatch", () => {
    expect(sanitizeConsoleSettingsData({ version: 2, general: { theme: "carbon" } })).toEqual({ version: 1, general: {}, plugins: {} });
    expect(sanitizeConsoleSettingsData({ general: { theme: "carbon" } })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("accepts valid version 1 with no general", () => {
    expect(sanitizeConsoleSettingsData({ version: 1 })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("accepts valid general fields", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 9000, theme: "carbon" },
    })).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 9000, theme: "carbon" },
      plugins: {},
    });
  });

  it("drops invalid consolePortMode", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consolePortMode: "auto", theme: "maritime" },
    })).toEqual({ version: 1, general: { theme: "maritime" }, plugins: {} });
  });

  it("drops out-of-range consoleStaticPort", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 80, theme: "maritime" },
    })).toEqual({ version: 1, general: { theme: "maritime" }, plugins: {} });

    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 99999, theme: "maritime" },
    })).toEqual({ version: 1, general: { theme: "maritime" }, plugins: {} });
  });

  it("drops invalid theme", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "neon" },
    })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("accepts maritime theme", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "maritime" },
    })).toEqual({ version: 1, general: { theme: "maritime" }, plugins: {} });
  });

  it("accepts carbon theme", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "carbon" },
    })).toEqual({ version: 1, general: { theme: "carbon" }, plugins: {} });
  });

  it("accepts minimum valid port boundary", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 1024 },
    })).toEqual({ version: 1, general: { consoleStaticPort: 1024 }, plugins: {} });
  });

  it("accepts maximum valid port boundary", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 65535 },
    })).toEqual({ version: 1, general: { consoleStaticPort: 65535 }, plugins: {} });
  });

  it("drops non-integer port", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 8080.5 },
    })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("round-trips valid data through store", () => {
    const dir = makeTempDir();
    const paths = makeFakePaths(dir);
    const store = createConsoleSettingsStore({ paths });

    expect(store.load()).toEqual({ version: 1, general: {}, plugins: {} });

    store.update(() => ({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, theme: "carbon" },
    }));

    expect(store.load()).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, theme: "carbon" },
      plugins: {},
    });

    const raw = JSON.parse(fs.readFileSync(paths.settingsFile, "utf-8")) as unknown;
    expect(raw).toMatchObject({ version: 1, general: { consolePortMode: "static", consoleStaticPort: 7777, theme: "carbon" } });
  });

  it("preserves valid plugins record on round-trip", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      plugins: { terminal: { font: { size: 14 } }, "my-plugin": { key: "value" } },
    })).toEqual({
      version: 1,
      general: {},
      plugins: { terminal: { font: { size: 14 } }, "my-plugin": { key: "value" } },
    });
  });

  it("drops plugins entry with invalid pluginId (uppercase, special chars)", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      plugins: { "Bad-Id": { x: 1 }, "_bad": { x: 1 }, "good": { x: 1 } },
    })).toEqual({ version: 1, general: {}, plugins: { good: { x: 1 } } });
  });

  it("drops plugins entry whose value is not a plain object (array, string, null)", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      plugins: { terminal: [1, 2, 3], other: "string", notes: null, valid: { k: 1 } },
    })).toEqual({ version: 1, general: {}, plugins: { valid: { k: 1 } } });
  });

  it("does not validate inner nested values of plugins entries", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      plugins: { terminal: { font: { name: null, size: "large", nested: { deep: true } } } },
    })).toEqual({
      version: 1,
      general: {},
      plugins: { terminal: { font: { name: null, size: "large", nested: { deep: true } } } },
    });
  });

  it("returns plugins: {} when plugins field is absent", () => {
    expect(sanitizeConsoleSettingsData({ version: 1, general: {} })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("returns plugins: {} when plugins field is not a plain object", () => {
    expect(sanitizeConsoleSettingsData({ version: 1, plugins: "bad" })).toEqual({ version: 1, general: {}, plugins: {} });
    expect(sanitizeConsoleSettingsData({ version: 1, plugins: [] })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("returns empty for version mismatch even with plugins present", () => {
    expect(sanitizeConsoleSettingsData({ version: 2, plugins: { terminal: { x: 1 } } })).toEqual({ version: 1, general: {}, plugins: {} });
  });
});

describe("emptyConsoleSettingsData", () => {
  it("returns version 1 with empty general and plugins", () => {
    expect(emptyConsoleSettingsData()).toEqual({ version: 1, general: {}, plugins: {} });
  });
});
