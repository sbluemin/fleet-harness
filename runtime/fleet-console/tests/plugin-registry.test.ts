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
