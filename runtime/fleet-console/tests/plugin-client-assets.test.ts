import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as sdkPluginBrowser from "@fleet-console/sdk/plugin/browser";

import { createPluginClientAssets } from "../core/host/plugin-host/client-assets.js";
import type { DiscoveredFleetPlugin } from "../core/host/plugin-host/types.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("plugin client assets", () => {
  it("bundles TSX clients and rewrites React and SDK imports to runtime shims", async () => {
    const plugin = writeClientPlugin("notes", "index.tsx", [
      "import { definePlugin } from \"@fleet-console/sdk/plugin/browser\";",
      "export default definePlugin({",
      "  id: \"notes\",",
      "  operationKinds: [{",
      "    pluginId: \"notes\",",
      "    type: \"notes.panel\",",
      "    title: \"Notes\",",
      "    render: () => <div>Notes</div>,",
      "  }],",
      "});",
    ].join("\n"));
    const assets = createPluginClientAssets({ plugins: [plugin] });

    await assets.prepare();

    const source = assets.getClient("notes") ?? "";
    expect(source).toContain("/plugin-runtime/shim/react-jsx-runtime.mjs");
    expect(source).toContain("/plugin-runtime/shim/sdk-plugin-browser.mjs");
    expect(assets.manifest()).toEqual({
      plugins: [{
        id: "notes",
        name: "Notes",
        clientUrl: "/plugin-runtime/client/notes.mjs",
        apiVersion: 1,
      }],
    });
  });

  it("rejects browser client bundles that import Node builtins", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = writeClientPlugin("bad", "index.ts", [
      "import fs from \"node:fs\";",
      "export default fs;",
    ].join("\n"));
    const assets = createPluginClientAssets({ plugins: [plugin] });

    await assets.prepare();

    expect(assets.getClient("bad")).toBeNull();
    expect(assets.manifest()).toEqual({ plugins: [] });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Node builtin import is not allowed"));
  });

  it("serves only prepared external client entries in the manifest DTO", async () => {
    const external = writeClientPlugin("external", "index.mjs", "export const plugin = { id: \"external\" };", { sensitiveFields: ["secret"], rootName: "external-root" });
    const builtIn = writeClientPlugin("terminal", "index.mjs", "export const plugin = { id: \"terminal\" };", { external: false, rootName: "terminal-root" });
    const assets = createPluginClientAssets({ plugins: [external, builtIn] });

    await assets.prepare();

    const serialized = JSON.stringify(assets.manifest());
    expect(assets.manifest()).toEqual({
      plugins: [{
        id: "external",
        name: "External",
        clientUrl: "/plugin-runtime/client/external.mjs",
        apiVersion: 1,
      }],
    });
    expect(serialized).not.toContain(external.root);
    expect(serialized).not.toContain(external.clientEntry ?? "");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("sensitiveFields");
  });

  it("generates globalThis runtime shims from namespace keys", () => {
    const assets = createPluginClientAssets({ plugins: [] });
    const source = assets.getShim("sdk-plugin-browser") ?? "";

    for (const key of Object.keys(sdkPluginBrowser).filter((name) => name !== "default")) {
      expect(source).toContain(`export const ${key} = ns[${JSON.stringify(key)}];`);
    }
    expect(source).toContain("globalThis.__fleetConsoleRuntime__?.[\"@fleet-console/sdk/plugin/browser\"]");
    expect(source).toContain("export default ns.default;");
  });
});

function writeClientPlugin(id: string, filename: string, source: string, options: { readonly external?: boolean; readonly sensitiveFields?: readonly string[]; readonly rootName?: string } = {}): DiscoveredFleetPlugin {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-client-assets-"));
  tempDirs.push(dir);
  const root = path.join(dir, options.rootName ?? id);
  const clientEntry = path.join(root, filename);
  fs.mkdirSync(path.dirname(clientEntry), { recursive: true });
  fs.writeFileSync(clientEntry, source);
  return {
    root,
    external: options.external ?? true,
    manifest: {
      id,
      apiVersion: 1,
      name: id === "notes" ? "Notes" : id === "external" ? "External" : id,
      client: filename,
      ...(options.sensitiveFields ? { sensitiveFields: options.sensitiveFields } : {}),
    },
    clientEntry,
    routesEntry: null,
  };
}
