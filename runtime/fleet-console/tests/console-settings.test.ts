import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { CreateDurableJsonStoreDeps, DurableJsonStore } from "@dotobokuri/core-infra";

import {
  createConsoleSettingsStore,
  sanitizeConsoleSettingsData,
  emptyConsoleSettingsData,
  type ConsoleSettingsData,
} from "../core/host/console-settings.js";
import type { ConsoleDataPaths } from "../core/host/paths.js";

const tempDirs: string[] = [];
const INSTRUMENT_THEME_PATH = new URL("../core/client/src/styles/theme.css", import.meta.url);

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

function createControlledMigrationStore(input: { readonly raw: unknown; readonly latest: unknown; readonly shouldFailWrite: () => boolean }) {
  let raw = input.raw;
  let updateCalls = 0;
  const dir = makeTempDir();
  const store = createConsoleSettingsStore({
    paths: makeFakePaths(dir),
    createStore: (deps: CreateDurableJsonStoreDeps<ConsoleSettingsData>): DurableJsonStore<ConsoleSettingsData> => ({
      path: deps.filePath,
      load: () => deps.sanitize(raw),
      save: (data) => { raw = data; },
      update: (mutate) => {
        updateCalls += 1;
        if (input.shouldFailWrite()) throw new Error("write failed");
        const next = mutate(deps.sanitize(input.latest));
        raw = next;
        return next;
      },
    }),
  });
  return { store, getUpdateCalls: () => updateCalls, getRaw: () => raw };
}

describe("sanitizeConsoleSettingsData", () => {
  it("returns empty for non-object input", () => {
    expect(sanitizeConsoleSettingsData(null)).toEqual({ version: 1, general: {}, plugins: {} });
    expect(sanitizeConsoleSettingsData("string")).toEqual({ version: 1, general: {}, plugins: {} });
    expect(sanitizeConsoleSettingsData([])).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("returns empty for version mismatch", () => {
    expect(sanitizeConsoleSettingsData({ version: 2, general: { theme: "instrument" } })).toEqual({ version: 1, general: {}, plugins: {} });
    expect(sanitizeConsoleSettingsData({ general: { theme: "instrument" } })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("accepts valid version 1 with no general", () => {
    expect(sanitizeConsoleSettingsData({ version: 1 })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("accepts valid general fields", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 9000, language: "ko", theme: "instrument", uiFont: "source-code-pro" },
    })).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 9000, language: "ko", theme: "instrument", uiFont: "source-code-pro" },
      plugins: {},
    });
  });

  it("drops invalid consolePortMode", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consolePortMode: "auto", theme: "instrument" },
    })).toEqual({ version: 1, general: { theme: "instrument" }, plugins: {} });
  });

  it("drops out-of-range consoleStaticPort", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 80, theme: "instrument" },
    })).toEqual({ version: 1, general: { theme: "instrument" }, plugins: {} });

    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { consoleStaticPort: 99999, theme: "instrument" },
    })).toEqual({ version: 1, general: { theme: "instrument" }, plugins: {} });
  });

  it("drops invalid theme", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "neon" },
    })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("promotes each legacy curated UI font to an atomic default-size value", () => {
    for (const uiFont of ["manrope", "jetbrains-mono", "source-code-pro"] as const) {
      expect(sanitizeConsoleSettingsData({
        version: 1,
        general: { uiFont },
      })).toEqual({ version: 1, general: { uiFont: { source: "builtin", id: uiFont, size: 14 } }, plugins: {} });
    }
  });

  it("drops an invalid UI font so the global settings DTO falls back to Manrope", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { uiFont: "comic-sans" },
    })).toEqual({ version: 1, general: {}, plugins: {} });
  });

  it("accepts a persisted system family at both atomic size boundaries", () => {
    expect(sanitizeConsoleSettingsData({ version: 1, general: { uiFont: { source: "system", familyName: "Noto Sans", size: 12 } } }).general?.uiFont).toEqual({ source: "system", familyName: "Noto Sans", size: 12 });
    expect(sanitizeConsoleSettingsData({ version: 1, general: { uiFont: { source: "system", familyName: "Noto Sans Mono", size: 18 } } }).general?.uiFont).toEqual({ source: "system", familyName: "Noto Sans Mono", size: 18 });
  });

  it("sanitizes persisted system families without changing valid sibling settings", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "carbon", uiFont: { source: "system", familyName: " \u0000Noto Sans\u007f ", size: 14 } },
      plugins: { terminal: { font: { size: 14 } } },
    })).toEqual({
      version: 1,
      general: { theme: "carbon", uiFont: { source: "system", familyName: "Noto Sans", size: 14 } },
      plugins: { terminal: { font: { size: 14 } } },
    });
  });

  it("drops malformed atomic UI font discriminants, sizes, and hostile family names", () => {
    for (const uiFont of [
      { source: "builtin", id: "comic-sans", size: 14 },
      { source: "system", familyName: "\u0000", size: 14 },
      { source: "system", familyName: "Noto Sans", size: 11 },
      { source: "system", familyName: "Noto Sans", size: 18.5 },
      { source: "other", id: "manrope", size: 14 },
    ]) {
      expect(sanitizeConsoleSettingsData({ version: 1, general: { uiFont } }).general).toEqual({});
    }
  });

  it("accepts maritime theme", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "instrument" },
    })).toEqual({ version: 1, general: { theme: "instrument" }, plugins: {} });
  });

  it("accepts carbon theme", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "instrument" },
    })).toEqual({ version: 1, general: { theme: "instrument" }, plugins: {} });
  });

  it("accepts instrument theme while preserving legacy maritime and carbon values", () => {
    expect(sanitizeConsoleSettingsData({
      version: 1,
      general: { theme: "instrument" },
    })).toEqual({ version: 1, general: { theme: "instrument" }, plugins: {} });
  });

  it("normalizes maritime and carbon saved values to Instrument without dropping siblings", () => {
    for (const theme of ["maritime", "carbon", "instrument"] as const) {
      expect(sanitizeConsoleSettingsData({ version: 1, general: { theme, language: "ko", uiFont: "source-code-pro" } })).toEqual({
        version: 1,
        general: { theme: "instrument", language: "ko", uiFont: "source-code-pro" },
        plugins: {},
      });
    }
  });

  it("snapshots the approved Instrument warn token below accent chroma", () => {
    const source = fs.readFileSync(INSTRUMENT_THEME_PATH, "utf8");
    const baseTokens = source.slice(0, source.indexOf(":root[data-ui-font"));
    const warnToken = baseTokens.match(/--warn: oklch\(([^)]+)\);/)?.[1];
    expect(warnToken).toMatchInlineSnapshot('"75% 0.08 90"');
  });

  it("accepts supported languages and drops invalid values", () => {
    expect(sanitizeConsoleSettingsData({ version: 1, general: { language: "ko" } })).toEqual({ version: 1, general: { language: "ko" }, plugins: {} });
    expect(sanitizeConsoleSettingsData({ version: 1, general: { language: "ja" } })).toEqual({ version: 1, general: {}, plugins: {} });
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
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "instrument", uiFont: "jetbrains-mono" },
    }));

    expect(store.load()).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "instrument", uiFont: "jetbrains-mono" },
      plugins: {},
    });

    const raw = JSON.parse(fs.readFileSync(paths.settingsFile, "utf-8")) as unknown;
    expect(raw).toMatchObject({ version: 1, general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "instrument", uiFont: "jetbrains-mono" } });
  });

  it("atomically normalizes a legacy saved theme while preserving general siblings and plugin settings", () => {
    const dir = makeTempDir();
    const paths = makeFakePaths(dir);
    fs.writeFileSync(paths.settingsFile, JSON.stringify({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "maritime", uiFont: "jetbrains-mono" },
      plugins: { terminal: { font: { size: 14 } }, skills: { includePrerelease: true } },
    }), "utf8");
    const store = createConsoleSettingsStore({ paths });

    expect(store.load()).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "instrument", uiFont: "jetbrains-mono" },
      plugins: { terminal: { font: { size: 14 } }, skills: { includePrerelease: true } },
    });
    expect(JSON.parse(fs.readFileSync(paths.settingsFile, "utf8"))).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "instrument", uiFont: "jetbrains-mono" },
      plugins: { terminal: { font: { size: 14 } }, skills: { includePrerelease: true } },
    });
    expect(store.load()).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "instrument", uiFont: "jetbrains-mono" },
      plugins: { terminal: { font: { size: 14 } }, skills: { includePrerelease: true } },
    });
  });

  it("normalizes inside the durable update lock from the latest interleaved settings", () => {
    const controlled = createControlledMigrationStore({
      raw: {
        version: 1,
        general: { language: "ko", theme: "maritime" },
        plugins: { terminal: { font: { size: 14 } } },
      },
      latest: {
        version: 1,
        general: { language: "en", theme: "instrument", uiFont: "source-code-pro" },
        plugins: { terminal: { font: { size: 16 } }, skills: { includePrerelease: true } },
      },
      shouldFailWrite: () => false,
    });

    expect(controlled.store.load()).toEqual({
      version: 1,
      general: { language: "en", theme: "instrument", uiFont: "source-code-pro" },
      plugins: { terminal: { font: { size: 16 } }, skills: { includePrerelease: true } },
    });
    expect(controlled.getRaw()).toEqual({
      version: 1,
      general: { language: "en", theme: "instrument", uiFont: "source-code-pro" },
      plugins: { terminal: { font: { size: 16 } }, skills: { includePrerelease: true } },
    });
    expect(controlled.getUpdateCalls()).toBe(1);
  });

  it("returns the normalized read and retries migration after an atomic write failure", () => {
    let failWrite = true;
    const controlled = createControlledMigrationStore({
      raw: {
        version: 1,
        general: { language: "ko", theme: "carbon" },
        plugins: { terminal: { font: { size: 14 } } },
      },
      latest: {
        version: 1,
        general: { language: "ko", theme: "carbon" },
        plugins: { terminal: { font: { size: 14 } } },
      },
      shouldFailWrite: () => failWrite,
    });

    expect(controlled.store.load()).toEqual({
      version: 1,
      general: { language: "ko", theme: "instrument" },
      plugins: { terminal: { font: { size: 14 } } },
    });
    failWrite = false;
    expect(controlled.store.load()).toEqual({
      version: 1,
      general: { language: "ko", theme: "instrument" },
      plugins: { terminal: { font: { size: 14 } } },
    });
    expect(controlled.getUpdateCalls()).toBe(2);
    expect(controlled.getRaw()).toEqual({
      version: 1,
      general: { language: "ko", theme: "instrument" },
      plugins: { terminal: { font: { size: 14 } } },
    });
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

  it("round-trips an atomic system UI font while retaining version and plugins", () => {
    const dir = makeTempDir();
    const store = createConsoleSettingsStore({ paths: makeFakePaths(dir) });
    const plugins = { terminal: { font: { size: 14 } } };
    store.update(() => ({ version: 1, general: { language: "ko", uiFont: { source: "system", familyName: "Removed Mono", size: 16 } }, plugins }));

    expect(store.load()).toEqual({ version: 1, general: { language: "ko", uiFont: { source: "system", familyName: "Removed Mono", size: 16 } }, plugins });
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
