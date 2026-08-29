import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

interface PluginRegistrySnapshot {
  readonly plugins: readonly FleetClientPlugin[];
  readonly operationKinds: readonly { readonly type: string }[];
  readonly settingsSections: readonly { readonly id: string }[];
  readonly notificationKinds: readonly { readonly id: string }[];
}

interface PluginRegistryModule {
  loadPluginRegistry(): Promise<PluginRegistrySnapshot>;
}

const builtInPlugin: FleetClientPlugin = {
  id: "terminal",
  operationKinds: [{ pluginId: "terminal", type: "shell", title: "Shell" }],
  settingsSections: [{ id: "terminal-settings", title: "Terminal" }],
  notificationKinds: [{ id: "terminal.notice", title: "Terminal Notice" }],
};

vi.mock("virtual:fleet-plugins", () => ({
  plugins: [builtInPlugin],
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin registry", () => {
  it("derives registry lists from built-in and external plugins", async () => {
    mockManifestResponse([{
      id: "notes",
      clientUrl: pluginModuleUrl({
        id: "notes",
        operationKinds: [{ pluginId: "notes", type: "notes", title: "Notes" }],
        settingsSections: [{ id: "general", title: "Notes" }],
        notificationKinds: [{ id: "notes.notice", title: "Notes Notice" }],
      }),
      apiVersion: 1,
    }]);

    const { loadPluginRegistry } = await importPluginRegistryModule("../core/client/src/plugin-registry.js");
    const registry = await loadPluginRegistry();

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["terminal", "notes"]);
    expect(registry.operationKinds.map((kind) => kind.type)).toEqual(["shell", "notes"]);
    expect(registry.settingsSections.map((section) => section.id)).toEqual(["terminal-settings", "general"]);
    expect(registry.notificationKinds.map((kind) => kind.id)).toEqual(["terminal.notice", "notes.notice"]);
  });

  it("skips external plugins that duplicate a built-in id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockManifestResponse([{
      id: "terminal",
      clientUrl: pluginModuleUrl({ id: "terminal" }),
      apiVersion: 1,
    }]);

    const { loadPluginRegistry } = await importPluginRegistryModule("../core/client/src/plugin-registry.js");
    const registry = await loadPluginRegistry();

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["terminal"]);
    expect(warn).toHaveBeenCalledWith("Skipping external plugin with duplicate id: terminal");
  });

  it("continues with built-ins when manifest fetch is not ok", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("missing", { status: 503 }));

    const { loadPluginRegistry } = await importPluginRegistryModule("../core/client/src/plugin-registry.js");
    const registry = await loadPluginRegistry();

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["terminal"]);
    expect(warn).toHaveBeenCalledWith("Plugin runtime manifest unavailable: 503");
  });

  it("continues with built-ins when manifest fetch throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("network_down");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);

    const { loadPluginRegistry } = await importPluginRegistryModule("../core/client/src/plugin-registry.js");
    const registry = await loadPluginRegistry();

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["terminal"]);
    expect(warn).toHaveBeenCalledWith("Plugin runtime manifest failed to load.", error);
  });

  it("filters malformed manifest entries before loading clients", async () => {
    mockManifestResponse([
      null,
      { id: "missing-client-url", apiVersion: 1 },
      { id: "bad-version", clientUrl: pluginModuleUrl({ id: "bad-version" }), apiVersion: "1" },
      {
        id: "notes",
        clientUrl: pluginModuleUrl({ id: "notes" }),
        apiVersion: 1,
      },
    ]);

    const { loadPluginRegistry } = await importPluginRegistryModule("../core/client/src/plugin-registry.js");
    const registry = await loadPluginRegistry();

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(["terminal", "notes"]);
  });
});

function mockManifestResponse(plugins: readonly unknown[]): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ plugins }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

async function importPluginRegistryModule(modulePath: string): Promise<PluginRegistryModule> {
  return await import(modulePath) as PluginRegistryModule;
}

function pluginModuleUrl(plugin: FleetClientPlugin): string {
  return `data:text/javascript,${encodeURIComponent(`export default ${JSON.stringify(plugin)};`)}`;
}

describe("built-in plugin composition order", () => {
  // rail 순서에 정렬 필드는 없다 — 합성 배열의 순서가 그대로 rail 순서다(plugin-registry가
  // 플러그인을 훑으며 railPanels를 쌓는다). Codex는 코어 내장 패널이던 시절 rail 최상위였고,
  // 플러그인으로 나간 뒤에도 그 자리를 지켜야 한다. 목록 끝에 덧붙이면 조용히 바닥으로 내려간다.
  it("keeps Codex first so its rail panel stays topmost", () => {
    const configPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../core/client/vite.config.ts",
    );
    const source = readFileSync(configPath, "utf8");
    const composition = /export const plugins = \[([^\]]*)\]/.exec(source)?.[1];
    expect(composition, "the built-in plugin composition line moved").toBeTypeOf("string");

    const spreads = [...(composition ?? "").matchAll(/\.\.\.(\w+)/g)].map((match) => match[1]);
    expect(spreads.length).toBeGreaterThan(1);
    expect(spreads[0]).toBe("codexPlugins");
  });
});
