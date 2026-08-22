import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { listRemoteInterfaces } from "../core/host/remote-discovery.js";
import {
  createConsoleSettingsStore,
  sanitizeConsoleSettingsData,
  sanitizeRemoteAccessSettings,
  emptyConsoleSettingsData,
  type ConsoleSettingsData,
} from "../core/host/settings/settings-domain.js";
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
  };
}

describe("remote interface candidates", () => {
  it("keeps device names in local and Tailscale labels", () => {
    expect(listRemoteInterfaces({
      en0: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
      tailscale0: [{ family: "IPv4", internal: false, address: "100.64.0.7" }],
    })).toEqual([
      { kind: "tailscale", label: "Tailscale (tailscale0)", address: "100.64.0.7" },
      { kind: "local", label: "Local network (en0)", address: "192.168.1.20" },
    ]);
  });
});

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
      general: { consolePortMode: "static", consoleStaticPort: 9000, language: "ko", theme: "instrument", uiFont: { source: "builtin", id: "source-code-pro", size: 14 } },
    })).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 9000, language: "ko", theme: "instrument", uiFont: { source: "builtin", id: "source-code-pro", size: 14 } },
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
      general: { theme: "instrument", uiFont: { source: "system", familyName: " \u0000Noto Sans\u007f ", size: 14 } },
      plugins: { terminal: { font: { size: 14 } } },
    })).toEqual({
      version: 1,
      general: { theme: "instrument", uiFont: { source: "system", familyName: "Noto Sans", size: 14 } },
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

  it("preserves each supported theme without dropping siblings", () => {
    for (const theme of ["maritime", "carbon", "instrument", "whites"] as const) {
      expect(sanitizeConsoleSettingsData({ version: 1, general: { theme, language: "ko", uiFont: { source: "builtin", id: "source-code-pro", size: 14 } } })).toEqual({
        version: 1,
        general: { theme, language: "ko", uiFont: { source: "builtin", id: "source-code-pro", size: 14 } },
        plugins: {},
      });
    }
    expect(sanitizeConsoleSettingsData({ version: 1, general: { theme: "neon" } })).toEqual({
      version: 1,
      general: {},
      plugins: {},
    });
  });

  it("maps retired light themes to whites without dropping siblings", () => {
    for (const legacy of ["daywatch", "drydock"]) {
      expect(sanitizeConsoleSettingsData({ version: 1, general: { theme: legacy, language: "ko" } })).toEqual({
        version: 1,
        general: { theme: "whites", language: "ko" },
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

  // 퇴역한 reducePanelMotion 키가 남은 기존 settings.json은 다음 sanitize에서 조용히 떨어진다 —
  // 마이그레이션 단계 없이도 일반 설정 전체가 초기화되지 않는다는 계약이다.
  it("drops the retired reducePanelMotion key without resetting sibling general settings", () => {
    expect(sanitizeConsoleSettingsData({ version: 1, general: { language: "ko", reducePanelMotion: true } })).toEqual({ version: 1, general: { language: "ko" }, plugins: {} });
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

  it("normalizes current v2 data without the public opt-in key from a valid acknowledgment", () => {
    const tuple = {
      enabled: true,
      listenAddress: "192.0.2.10",
      advertisedHost: "console.example",
      listenPort: { mode: "custom", value: 50_001 },
      advertisedPort: { mode: "custom", value: 50_002 },
    } as const;
    const acknowledgment = { version: 1, listenAddress: tuple.listenAddress, listenPort: 50_001, advertisedHost: tuple.advertisedHost, advertisedPort: 50_002 };

    expect(sanitizeConsoleSettingsData({ version: 1, general: { remoteAccess: { ...tuple, acknowledgment } } }).general?.remoteAccess)
      .toEqual({ ...tuple, publicEndpointEnabled: true, acknowledgment });
    expect(sanitizeConsoleSettingsData({ version: 1, general: { remoteAccess: { ...tuple, enabled: false, acknowledgment: null } } }).general?.remoteAccess)
      .toEqual({ ...tuple, enabled: false, publicEndpointEnabled: false, acknowledgment: null });

    const dir = makeTempDir();
    const paths = makeFakePaths(dir);
    fs.writeFileSync(paths.settingsFile, JSON.stringify({ version: 1, general: { remoteAccess: { ...tuple, acknowledgment } }, plugins: {} }));
    createConsoleSettingsStore({ paths }).load();
    expect(JSON.parse(fs.readFileSync(paths.settingsFile, "utf8"))).toMatchObject({ general: { remoteAccess: { publicEndpointEnabled: true } } });
  });

  it("sanitizes LAN-only state without a public hostname or acknowledgment", () => {
    const remoteAccess = {
      enabled: true,
      publicEndpointEnabled: false,
      listenAddress: "192.0.2.10",
      advertisedHost: "",
      listenPort: { mode: "auto", value: 49_152 },
      advertisedPort: { mode: "custom", value: 443 },
      acknowledgment: null,
    } as const;
    expect(sanitizeConsoleSettingsData({ version: 1, general: { remoteAccess } }).general?.remoteAccess).toEqual(remoteAccess);
    expect(sanitizeConsoleSettingsData({ version: 1, general: { remoteAccess: { ...remoteAccess, acknowledgment: { version: 1, listenAddress: "192.0.2.10", listenPort: 49_152, advertisedHost: "console.example", advertisedPort: 443 } } } }).general?.remoteAccess)
      .toEqual(remoteAccess);
  });

  it("generates concrete Auto port defaults once and persists them", () => {
    const dir = makeTempDir();
    const paths = makeFakePaths(dir);
    const ports = [49_152, 65_535];
    const store = createConsoleSettingsStore({ paths, randomInt: () => ports.shift()! });

    expect(store.load().general?.remoteAccess).toEqual({
      enabled: false,
      publicEndpointEnabled: false,
      listenAddress: "",
      advertisedHost: "",
      listenPort: { mode: "auto", value: 49_152 },
      advertisedPort: { mode: "auto", value: 65_535 },
      acknowledgment: null,
    });
    expect(createConsoleSettingsStore({ paths, randomInt: () => { throw new Error("must not regenerate"); } }).load().general?.remoteAccess)
      .toEqual(store.load().general?.remoteAccess);
  });

  it("migrates legacy bindHost plus listener v1 port without rotating adjacent remote state", () => {
    const dir = makeTempDir();
    const paths = makeFakePaths(dir);
    fs.mkdirSync(path.join(dir, "remote"), { recursive: true });
    fs.writeFileSync(paths.settingsFile, JSON.stringify({ version: 1, general: { remoteAccess: { enabled: true, bindHost: "Console.Example" } }, plugins: {} }));
    fs.writeFileSync(path.join(dir, "remote", "listener.json"), JSON.stringify({ version: 1, port: 54_321 }));
    fs.writeFileSync(path.join(dir, "remote", "pairings.json"), "preserve-me");

    const migrated = createConsoleSettingsStore({ paths }).load().general?.remoteAccess;

    expect(migrated).toEqual({
      enabled: true,
      publicEndpointEnabled: false,
      listenAddress: "console.example",
      advertisedHost: "console.example",
      listenPort: { mode: "custom", value: 54_321 },
      advertisedPort: { mode: "custom", value: 54_321 },
      acknowledgment: null,
    });
    expect(fs.readFileSync(path.join(dir, "remote", "pairings.json"), "utf8")).toBe("preserve-me");
    expect(JSON.stringify(createConsoleSettingsStore({ paths }).load())).not.toContain("bindHost");
  });

  it("round-trips valid data through store", () => {
    const dir = makeTempDir();
    const paths = makeFakePaths(dir);
    const store = createConsoleSettingsStore({ paths });

    expect(store.load()).toMatchObject({ version: 1, general: { remoteAccess: { enabled: false, acknowledgment: null } }, plugins: {} });

    store.update(() => ({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "instrument", uiFont: { source: "builtin", id: "jetbrains-mono", size: 14 } },
    }));

    expect(store.load()).toEqual({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "instrument", uiFont: { source: "builtin", id: "jetbrains-mono", size: 14 } },
      plugins: {},
    });

    const raw = JSON.parse(fs.readFileSync(paths.settingsFile, "utf-8")) as unknown;
    expect(raw).toMatchObject({ version: 1, general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "instrument", uiFont: { source: "builtin", id: "jetbrains-mono", size: 14 } } });
  });

  it("preserves a saved legacy theme without rewriting it", () => {
    const dir = makeTempDir();
    const paths = makeFakePaths(dir);
    fs.writeFileSync(paths.settingsFile, JSON.stringify({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "maritime", uiFont: { source: "builtin", id: "jetbrains-mono", size: 14 } },
      plugins: { terminal: { font: { size: 14 } }, skills: { includePrerelease: true } },
    }), "utf8");
    const store = createConsoleSettingsStore({ paths });

    expect(store.load()).toMatchObject({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "maritime", uiFont: { source: "builtin", id: "jetbrains-mono", size: 14 }, remoteAccess: { enabled: false, acknowledgment: null } },
      plugins: { terminal: { font: { size: 14 } }, skills: { includePrerelease: true } },
    });
    expect(JSON.parse(fs.readFileSync(paths.settingsFile, "utf8"))).toMatchObject({
      version: 1,
      general: { consolePortMode: "static", consoleStaticPort: 7777, language: "ko", theme: "maritime", uiFont: { source: "builtin", id: "jetbrains-mono", size: 14 }, remoteAccess: { enabled: false, acknowledgment: null } },
      plugins: { terminal: { font: { size: 14 } }, skills: { includePrerelease: true } },
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

describe("remote advertised host validity", () => {
  it("refuses the hosts a bind address refuses, because a device that dials them reaches itself", () => {
    for (const advertisedHost of ["127.0.0.1", "0.0.0.0", "localhost"]) {
      expect(sanitizeRemoteAccessSettings({
        enabled: false, publicEndpointEnabled: true, listenAddress: "192.168.0.68", advertisedHost,
        listenPort: { mode: "custom", value: 55551 }, advertisedPort: { mode: "custom", value: 55552 }, acknowledgment: null,
      })).toBeUndefined();
    }
    expect(sanitizeRemoteAccessSettings({
      enabled: false, publicEndpointEnabled: true, listenAddress: "192.168.0.68", advertisedHost: "console.example.com",
      listenPort: { mode: "custom", value: 55551 }, advertisedPort: { mode: "custom", value: 55552 }, acknowledgment: null,
    })).toMatchObject({ advertisedHost: "console.example.com" });
  });
});
