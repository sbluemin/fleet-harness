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
    expect(sanitizeConsoleSettingsData(null)).toEqual({ version: 1, general: {} });
    expect(sanitizeConsoleSettingsData("string")).toEqual({ version: 1, general: {} });
    expect(sanitizeConsoleSettingsData([])).toEqual({ version: 1, general: {} });
  });

  it("returns empty for version mismatch", () => {
    expect(sanitizeConsoleSettingsData({ version: 2, general: { theme: "carbon" } })).toEqual({ version: 1, general: {} });
    expect(sanitizeConsoleSettingsData({ general: { theme: "carbon" } })).toEqual({ version: 1, general: {} });
  });

  it("accepts valid version 1 with no general", () => {
    expect(sanitizeConsoleSettingsData({ version: 1 })).toEqual({ version: 1, general: {} });
  });

  it("accepts valid general fields", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 9000, theme: "carbon" },
    })).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 9000, theme: "carbon" },
    });
  });

  it("drops invalid consolePortMode", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consolePortMode: "auto", theme: "maritime" },
    })).toEqual({ version: 1, general: { theme: "maritime" } });
  });

  it("drops out-of-range consoleStaticPort", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 80, theme: "maritime" },
    })).toEqual({ version: 1, general: { theme: "maritime" } });

    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 99999, theme: "maritime" },
    })).toEqual({ version: 1, general: { theme: "maritime" } });
  });

  it("drops invalid theme", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "neon" },
    })).toEqual({ version: 1, general: {} });
  });

  it("accepts maritime theme", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "maritime" },
    })).toEqual({ version: 1, general: { theme: "maritime" } });
  });

  it("accepts carbon theme", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "carbon" },
    })).toEqual({ version: 1, general: { theme: "carbon" } });
  });

  it("accepts minimum valid port boundary", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 1024 },
    })).toEqual({ version: 1, general: { consoleStaticPort: 1024 } });
  });

  it("accepts maximum valid port boundary", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 65535 },
    })).toEqual({ version: 1, general: { consoleStaticPort: 65535 } });
  });

  it("drops non-integer port", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 8080.5 },
    })).toEqual({ version: 1, general: {} });
  });

  it("round-trips valid data through store", () => {
    const dir = makeTempDir();
    const paths = makeFakePaths(dir);
    const store = createConsoleSettingsStore({ paths });

    expect(store.load()).toEqual({ version: 1, general: {} });

    store.update(() => ({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, theme: "carbon" },
    }));

    expect(store.load()).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, theme: "carbon" },
    });

    const raw = JSON.parse(fs.readFileSync(paths.settingsFile, "utf-8")) as unknown;
    expect(raw).toEqual({ version: 1, general: { consolePortMode: "static", consoleStaticPort: 7777, theme: "carbon" } });
  });
});

describe("emptyConsoleSettingsData", () => {
  it("returns version 1 with empty general", () => {
    expect(emptyConsoleSettingsData()).toEqual({ version: 1, general: {} });
  });
});
