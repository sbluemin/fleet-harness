import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as sdkPluginBrowser from "@fleet-console/sdk/plugin/browser";

import { createPluginClientAssets } from "../core/host/plugin-host/plugin-host.js";
import type { DiscoveredFleetPlugin } from "../core/host/plugin-host/plugin-host.js";

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

  it("externalizes every SDK subpath an external plugin may import", async () => {
    // SDK exports에 subpath를 더해 놓고 shim 목록에 올리지 않으면, 그 export는 내장 플러그인
    // 에서만 동작하고 외부 플러그인은 준비 단계에서 통째로 탈락한다 — 광고만 하고 못 쓰는 상태다.
    const plugin = writeClientPlugin("notice", "index.tsx", [
      'import { FailureNotice } from "@fleet-console/sdk/components/failure-notice";',
      'import { EffortTrack } from "@fleet-console/sdk/components/effort-track";',
      'import { launchProviderFromModelId } from "@fleet-console/sdk/components/launch-provider-glyphs";',
      'import { ShellGlyph } from "@fleet-console/sdk/components/shell-glyph";',
      'const row = { id: "m", label: "M", launch: { model: "m" }, chips: [{ id: "low", label: "LOW", launch: { model: "m", effort: "low" } }] };',
      'export default { id: "notice", railPanels: [{ id: "n", title: "N", render: () => <><FailureNotice title="t" /><EffortTrack row={row} value="low" onChange={() => {}} autoLabel="AUTO" ariaLabel="effort" autoValueText="auto" /><span>{launchProviderFromModelId("sonnet")}</span><ShellGlyph /></> }] };',
    ].join("\n"));
    const assets = createPluginClientAssets({ plugins: [plugin] });

    await assets.prepare();

    const source = assets.getClient("notice") ?? "";
    expect(source).toContain("/plugin-runtime/shim/sdk-components-failure-notice.mjs");
    expect(source).toContain("/plugin-runtime/shim/sdk-components-effort-track.mjs");
    expect(source).toContain("/plugin-runtime/shim/sdk-components-launch-provider-glyphs.mjs");
    expect(source).toContain("/plugin-runtime/shim/sdk-components-shell-glyph.mjs");
    expect(assets.manifest().skipped ?? []).toEqual([]);
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
    // 빠진 플러그인은 목록에서 사라지되 그 사실 자체는 남는다 — 예전에는 서버 로그에만 남아
    // 운영자에게는 패널이 그냥 없는 것으로 보였다.
    expect(assets.manifest()).toEqual({
      plugins: [],
      skipped: [{ id: "bad", name: "bad", reason: "client_build_failed" }],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Node builtin import is not allowed"));
  });

  it("allows browser client imports that stay inside the plugin root", async () => {
    const plugin = writeClientPlugin("inside", "index.ts", [
      "import { label } from \"./shared\";",
      "export default { id: label };",
    ].join("\n"));
    fs.writeFileSync(path.join(plugin.root, "shared.ts"), "export const label = \"inside\";");
    const assets = createPluginClientAssets({ plugins: [plugin] });

    await assets.prepare();

    expect(assets.getClient("inside")).toContain("inside");
    expect(assets.manifest().plugins.map((entry) => entry.id)).toEqual(["inside"]);
  });

  it("rejects browser client imports that escape the plugin root", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const plugin = writeClientPlugin("escape", "index.ts", [
      "import { secret } from \"../secret\";",
      "export default { id: \"escape\", secret };",
    ].join("\n"));
    fs.writeFileSync(path.join(path.dirname(plugin.root), "secret.ts"), "export const secret = \"outside\";");
    const assets = createPluginClientAssets({ plugins: [plugin] });

    await assets.prepare();

    expect(assets.getClient("escape")).toBeNull();
    expect(assets.manifest()).toEqual({
      plugins: [],
      skipped: [{ id: "escape", name: "escape", reason: "client_build_failed" }],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plugin client import escapes plugin root"));
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
