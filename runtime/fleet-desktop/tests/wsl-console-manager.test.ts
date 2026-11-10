import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { WslConsoleManager } from "../src/wsl-console-manager.js";
import type { WslHost } from "../src/wsl-host.js";

describe("WSL console manager", () => {
  afterEach(() => vi.unstubAllGlobals());

  /**
   * The boundary a managed WSL Console depends on: a stopped distribution is never touched, another owner's Console is
   * shown but never asked to stop, and this Desktop's own is stopped through its stop request alone.
   */
  it("leaves a stopped distribution alone and asks only a Console it proved its own to stop", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wsl-"));
    const slot = path.join(root, "slot");
    fs.mkdirSync(slot, { mode: 0o700 });
    const lockFile = path.join(slot, "console.lock");
    const registryFile = path.join(root, "wsl-consoles.json");
    fs.writeFileSync(registryFile, JSON.stringify({ v: 1, consoles: [{ id: "one", distro: "Ubuntu", user: "me", uid: 1000, home: "/home/me", arch: "x64" }] }));
    let running = false;
    const sh = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    const windowsPath = vi.fn(() => lockFile);
    const host: WslHost = { distros: async () => [{ name: "Ubuntu", running, version: 2 }], sh, pipe: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), windowsPath };
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
      return init?.method === "POST" ? new Response(JSON.stringify({ accepted: true, pid: 4321 }), { status: 202 }) : new Response(JSON.stringify({ pid: 4321 }), { status: 200 });
    }));
    const publish = (owner: unknown): void => fs.writeFileSync(lockFile, JSON.stringify({ pid: 4321, host: "127.0.0.1", port: 4310, endpoint: "http://127.0.0.1:4310/", startedAt: Date.now(), token: "secret", version: "1.2.3", owner }), { mode: 0o600 });
    const manager = new WslConsoleManager({
      host, ownerId: "this-desktop", registryFile, cacheDirectory: root, fleetDirectory: ".fleet", isolatedData: true, desktopVersion: "1.0.0", development: false,
      packageName: "@dotobokuri/fleet-console", nodeManifest: () => ({ version: "22.0.0", source: "", targets: {} }), consoleTarball: async () => "",
      log: { info: () => undefined, error: () => undefined }, stopTimeoutMs: 5_000,
    });
    try {
      // A stopped distribution runs nothing: its files are not read (reading would start it) and Quit asks nothing of it.
      expect(await manager.list()).toMatchObject([{ distro: "Ubuntu", lifecycle: "stopped", origin: null }]);
      await manager.stopAll();
      expect(windowsPath).not.toHaveBeenCalled();
      expect(requests).toEqual([]);

      // Another Desktop's Console in the slot can be opened, and is neither stopped nor taken over.
      running = true;
      publish({ kind: "desktop", id: "another-desktop", protocolVersion: 1 });
      expect(await manager.list()).toMatchObject([{ management: "other-desktop", lifecycle: null, origin: "http://127.0.0.1:4310", takeover: false }]);
      await expect(manager.stop("one")).rejects.toThrow("wsl_console_other_owner");
      await expect(manager.takeOver("one")).rejects.toThrow("wsl_console_other_owner");
      await manager.stopAll();
      expect(requests.filter((request) => request.startsWith("POST"))).toEqual([]);

      // Its own Console is proved by the owner record and the authenticated answer, then asked to stop once.
      publish({ kind: "desktop", id: "this-desktop", protocolVersion: 1 });
      expect(await manager.list()).toMatchObject([{ management: "this-desktop", lifecycle: "running", identityProven: true }]);
      const stopping = manager.stop("one");
      await vi.waitFor(() => expect(requests).toContain("POST /api/v1/lifecycle/stop"));
      fs.rmSync(lockFile);
      await stopping;
      expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(1);
      // Nothing was run inside the distribution to observe or stop it: no signal, no distribution shutdown.
      expect(sh).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
