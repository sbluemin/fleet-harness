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
