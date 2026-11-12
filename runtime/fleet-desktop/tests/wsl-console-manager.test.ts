import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DESKTOP_RESOURCE_ROOT_MARKER, isDesktopResourceRootMarkerValid } from "@fleet-console/protocol/desktop";
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
      host, ownerId: "this-desktop", registryFile, cacheDirectory: root, fleetDirectory: ".fleet", isolatedData: true, desktopVersion: "1.0.0", development: false, systemCa: true,
      packageName: "@dotobokuri/fleet-console", nodeManifest: () => ({ version: "24.0.0", source: "", targets: {} }), consoleTarball: async () => "",
      log: { info: () => undefined, error: () => undefined }, stopTimeoutMs: 5_000,
    });
    try {
      // A stopped distribution runs nothing: its files are not read (reading would start it) and Quit asks nothing of it.
      expect(await manager.list()).toMatchObject([{ distro: "Ubuntu", lifecycle: "stopped", origin: null }]);
      expect(await manager.managedBrowsers()).toEqual([]);
      await manager.stopAll();
      expect(windowsPath).not.toHaveBeenCalled();
      expect(requests).toEqual([]);

      // Another Desktop's Console in the slot can be opened, and is neither stopped nor taken over.
      running = true;
      publish({ kind: "desktop", id: "another-desktop", protocolVersion: 1 });
      expect(await manager.list()).toMatchObject([{ management: "other-desktop", lifecycle: null, origin: "http://127.0.0.1:4310", takeover: false }]);
      expect(await manager.managedBrowsers()).toEqual([]);
      await expect(manager.stop("one")).rejects.toThrow("wsl_console_other_owner");
      await expect(manager.takeOver("one")).rejects.toThrow("wsl_console_other_owner");
      await manager.stopAll();
      expect(requests.filter((request) => request.startsWith("POST"))).toEqual([]);

      // Its own Console is proved by the owner record and the authenticated answer, then asked to stop once.
      publish({ kind: "desktop", id: "this-desktop", protocolVersion: 1 });
      expect(await manager.list()).toMatchObject([{ management: "this-desktop", lifecycle: "running", identityProven: true }]);
      expect(await manager.managedBrowsers()).toEqual([{ key: "wsl:one", origin: "http://127.0.0.1:4310", token: "secret", ownerId: "this-desktop", accessPath: "wsl" }]);
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

  /** The explicit update path protects ownership and keeps failures visible without silently restarting or updating. */
  it("offers only newer owned runtimes and stops only after download and transfer succeed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wsl-update-"));
    const slot = path.join(root, "slot");
    fs.mkdirSync(slot, { mode: 0o700 });
    const lockFile = path.join(slot, "console.lock");
    const registryFile = path.join(root, "registry.json");
    fs.writeFileSync(registryFile, JSON.stringify({ consoles: [{ id: "one", distro: "Ubuntu", user: "me", uid: 1000, home: "/home/me", arch: "x64" }] }));
    let owner = "this-desktop";
    let version = "1.2.3";
    let transferFails = false;
    let installFails = false;
    let downloadFails = false;
    let stops = 0;
    let launches = 0;
    let withholdLock = false;
    const publish = () => fs.writeFileSync(lockFile, JSON.stringify({ pid: 4321, host: "127.0.0.1", port: 4310, endpoint: "http://127.0.0.1:4310/", startedAt: Date.now(), token: "secret", version, owner: { kind: "desktop", id: owner, protocolVersion: 1 } }), { mode: 0o600 });
    publish();
    let resolveTarget!: () => void;
    let resolveVersions!: () => void;
    const targetReady = new Promise<void>((resolve) => { resolveTarget = resolve; });
    const versionsReady = new Promise<void>((resolve) => { resolveVersions = resolve; });
    const target = vi.fn(async () => { await targetReady; return { version: "1.3.0", tarball: async () => { if (downloadFails) throw new Error("download"); return "verified.tgz"; } }; });
    const host: WslHost = {
      distros: async () => [{ name: "Ubuntu", running: true, version: 2 }], windowsPath: () => lockFile,
      pipe: vi.fn(async () => ({ code: transferFails ? 1 : 0, stdout: "", stderr: "transfer" })),
      sh: vi.fn(async (_distro, _user, script) => {
        if (script.includes("nohup setsid")) { launches++; if (!withholdLock) publish(); return { code: 0, stdout: "launched", stderr: "" }; }
        if (script.includes("npm install")) return { code: installFails ? 1 : 0, stdout: installFails ? "" : "prepared", stderr: "install" };
        if (script.includes("echo installed")) { version = "1.3.0"; return { code: 0, stdout: "installed", stderr: "" }; }
        if (script.includes("echo node=")) await versionsReady;
        return { code: 0, stdout: `node=v22.0.0\nconsole=1\nconsole_version=${version}\n`, stderr: "" };
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "POST") { stops++; fs.rmSync(lockFile); return new Response(JSON.stringify({ accepted: true, pid: 4321 }), { status: 202 }); }
      return new Response(JSON.stringify({ pid: 4321 }), { status: 200 });
    }));
    const manager = new WslConsoleManager({ host, ownerId: "this-desktop", registryFile, cacheDirectory: root, fleetDirectory: ".fleet", isolatedData: true,
      desktopVersion: "1.0.0", development: false, systemCa: true, packageName: "@dotobokuri/fleet-console", nodeManifest: () => ({ version: "22.0.0", source: "", targets: {} }),
      consoleTarget: target, consoleTarball: async () => "verified.tgz", log: { info: () => undefined, error: () => undefined }, stopTimeoutMs: 1000, startTimeoutMs: 20,
    });
    try {
      // The directory answers even while both background sources are unresolved.
      expect(await manager.list()).toMatchObject([{ update: null, lifecycle: "running" }]);
      await manager.list();
      expect(host.sh).toHaveBeenCalledTimes(1);
      resolveVersions(); resolveTarget();
      await vi.waitFor(async () => expect(await manager.list()).toMatchObject([{ update: { node: { installed: "22.0.0", target: "22.0.0" }, console: { installed: "1.2.3", target: "1.3.0" } } }]));
      await manager.list(); await manager.list();
      expect(target).toHaveBeenCalledTimes(1);
      expect(host.sh).toHaveBeenCalledTimes(1);
      expect(host.pipe).not.toHaveBeenCalled();
      expect(stops).toBe(0);
      owner = "other-desktop"; publish();
      expect(await manager.list()).toMatchObject([{ update: null }]);
      await expect(manager.update("one")).rejects.toThrow("other_owner");
      expect(stops).toBe(0);
      owner = "this-desktop"; publish();
      downloadFails = true;
      await expect(manager.update("one")).rejects.toThrow("download");
      expect(stops).toBe(0);
      expect(await manager.list()).toMatchObject([{ failure: "download" }]);
      downloadFails = false; transferFails = true;
      await expect(manager.update("one")).rejects.toThrow("install");
      expect(stops).toBe(0);
      transferFails = false; installFails = true;
      await expect(manager.update("one")).rejects.toThrow("install");
      expect(stops).toBe(1);
      expect(launches).toBe(0);
      expect(await manager.list()).toMatchObject([{ lifecycle: "failed", failure: "install", update: null }]);
      await manager.start("one");
      expect(version).toBe("1.2.3");
      expect(await manager.list()).toMatchObject([{ failure: null }]);
      installFails = false;
      await manager.update("one");
      expect(version).toBe("1.3.0");
      expect(stops).toBe(2);
      expect(launches).toBe(2);
      expect(await manager.list()).toMatchObject([{ update: null, failure: null }]);
      // A late healthy start clears its obsolete timeout, unlike a failed update on the still-running old Console.
      await manager.stop("one");
      withholdLock = true;
      await expect(manager.start("one")).rejects.toThrow("start");
      expect(await manager.list()).toMatchObject([{ failure: "start", lifecycle: "failed" }]);
      publish();
      expect(await manager.list()).toMatchObject([{ failure: null, lifecycle: "running" }]);

      // Node trusts the system CA store in the Console and in the npm commands that install it; opting out drops it from both.
      const scripts = () => vi.mocked(host.sh).mock.calls.map((call) => call[2]);
      const trusted = scripts().length;
      const commands = scripts().filter((script) => script.includes("nohup setsid") || script.includes("npm install"));
      expect(commands.length).toBeGreaterThan(0);
      expect(commands.every((script) => script.includes('NODE_USE_SYSTEM_CA="1"'))).toBe(true);
      await manager.stop("one");
      withholdLock = false; version = "1.2.3";
      const optedOut = new WslConsoleManager({ host, ownerId: "this-desktop", registryFile, cacheDirectory: root, fleetDirectory: ".fleet", isolatedData: true,
        desktopVersion: "1.0.0", development: false, systemCa: false, packageName: "@dotobokuri/fleet-console", nodeManifest: () => ({ version: "22.0.0", source: "", targets: {} }),
        consoleTarget: target, consoleTarball: async () => "verified.tgz", log: { info: () => undefined, error: () => undefined }, stopTimeoutMs: 1000, startTimeoutMs: 20 });
      await optedOut.start("one");
      await vi.waitFor(async () => expect(await optedOut.list()).toMatchObject([{ update: { console: { target: "1.3.0" } } }]));
      await optedOut.update("one");
      const after = scripts().slice(trusted);
      expect(after.filter((script) => script.includes("nohup setsid") || script.includes("npm install")).length).toBeGreaterThanOrEqual(3);
      expect(after.some((script) => script.includes("NODE_USE_SYSTEM_CA"))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  /** Quit must not leave behind a Console it was in the middle of starting. */
  it("stops a Console whose start was still in flight when Desktop quits, and starts none afterwards", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wsl-"));
    const slot = path.join(root, "slot");
    fs.mkdirSync(slot, { mode: 0o700 });
    const lockFile = path.join(slot, "console.lock");
    const registryFile = path.join(root, "wsl-consoles.json");
    fs.writeFileSync(registryFile, JSON.stringify({ v: 1, consoles: [{ id: "one", distro: "Ubuntu", user: "me", uid: 1000, home: "/home/me", arch: "x64" }] }));
    const launches: number[] = [];
    const sh = vi.fn(async (_distro: string, _user: string | null, script: string) => {
      if (!script.includes("nohup setsid")) return { code: 0, stdout: "node=v22.0.0\nconsole=1\n", stderr: "" };
      // The Console publishes its lock a moment after the launch command returns.
      launches.push(Date.now());
      setTimeout(() => fs.writeFileSync(lockFile, JSON.stringify({ pid: 4321, host: "127.0.0.1", port: 4310, endpoint: "http://127.0.0.1:4310/", startedAt: Date.now(), token: "secret", version: "1.2.3", owner: { kind: "desktop", id: "this-desktop", protocolVersion: 1 } }), { mode: 0o600 }), 60);
      return { code: 0, stdout: "launched\n", stderr: "" };
    });
    const host: WslHost = { distros: async () => [{ name: "Ubuntu", running: true, version: 2 }], sh, pipe: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })), windowsPath: () => lockFile };
    const stops: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return new Response(JSON.stringify({ pid: 4321 }), { status: 200 });
      stops.push(new URL(String(url)).pathname);
      fs.rmSync(lockFile, { force: true });
      return new Response(JSON.stringify({ accepted: true, pid: 4321 }), { status: 202 });
    }));
    const manager = new WslConsoleManager({
      host, ownerId: "this-desktop", registryFile, cacheDirectory: root, fleetDirectory: ".fleet", isolatedData: true, desktopVersion: "1.0.0", development: false, systemCa: true,
      packageName: "@dotobokuri/fleet-console", nodeManifest: () => ({ version: "24.0.0", source: "", targets: {} }), consoleTarball: async () => "",
      log: { info: () => undefined, error: () => undefined }, stopTimeoutMs: 5_000,
    });
    try {
      const starting = manager.start("one").catch((error: unknown) => error);
      await vi.waitFor(() => expect(launches).toHaveLength(1));
      await manager.stopAll();
      await starting;
      expect(stops).toEqual(["/api/v1/lifecycle/stop"]);
      expect(fs.existsSync(lockFile)).toBe(false);
      // Once Desktop is quitting, nothing is started again.
      await expect(manager.start("one")).rejects.toThrow("wsl_console_quitting");
      expect(launches).toHaveLength(1);
      // An installed Node older than the fresh-install manifest is still used by start, never silently replaced.
      expect(host.pipe).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * The packaged Console refuses to start from a runtime root that lacks the Desktop marker. The other tests replace
   * the shell, so this one runs the generated scripts for real, with only `npm` stubbed: a fresh install, a runtime
   * installed before the marker existed, and a confirmed update must each leave the root the Console will validate.
   */
  it.skipIf(process.platform === "win32")("leaves every installed Console package root with the marker the packaged Console demands", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wsl-marker-"));
    const name = "@dotobokuri/fleet-console";
    const runtime = `${root}/home/.fleet/desktop/runtime`;
    const pkg = `${runtime}/console/latest/node_modules/${name}`;
    const marker = `${pkg}/${DESKTOP_RESOURCE_ROOT_MARKER}`;
    const lockFile = `${root}/console.lock`;
    const write = (file: string, body: string, mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body, { mode }); };
    for (const tool of ["python3", "make", "g++"]) write(`${root}/tools/${tool}`, "#!/bin/sh\n", 0o755);
    write(`${runtime}/node/bin/node`, '#!/bin/sh\ncase "$1" in -v) echo v22.0.0;; -p) echo 1.0.0;; esac\n', 0o755);
    write(`${runtime}/node/bin/npm`, `#!/bin/sh\n[ "$1" = install ] || exit 0\nmkdir -p "$3/node_modules/${name}/dist" && : > "$3/node_modules/${name}/dist/cli.mjs"\n`, 0o755);
    const publish = () => write(lockFile, JSON.stringify({ pid: 4321, host: "127.0.0.1", port: 4310, endpoint: "http://127.0.0.1:4310/", startedAt: Date.now(), token: "secret", version: "1.0.0", owner: { kind: "desktop", id: "this-desktop", protocolVersion: 1 } }), 0o600);
    const registryFile = `${root}/registry.json`;
    write(registryFile, JSON.stringify({ consoles: [{ id: "one", distro: "Ubuntu", user: "me", uid: 1000, home: `${root}/home`, arch: "x64" }] }));
    let launches = 0;
    let updating = false;
    const host: WslHost = {
      distros: async () => [{ name: "Ubuntu", running: true, version: 2 }], windowsPath: () => lockFile,
      pipe: vi.fn(async (_distro, _user, input) => { if ("file" in input) write(`${runtime}/console/.incoming.tgz`, ""); return { code: 0, stdout: "", stderr: "" }; }),
      sh: vi.fn(async (_distro, _user, script) => {
        if (script.includes("nohup setsid")) { launches++; if (updating) publish(); return { code: 0, stdout: "launched", stderr: "" }; }
        const ran = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: `${root}/tools:${process.env.PATH}` } });
        return { code: ran.status ?? 1, stdout: ran.stdout, stderr: ran.stderr };
      }),
    };
    vi.stubGlobal("fetch", vi.fn(async (_url, init?: RequestInit) => {
      if (init?.method === "POST") { fs.rmSync(lockFile, { force: true }); return new Response(JSON.stringify({ accepted: true, pid: 4321 }), { status: 202 }); }
      return new Response(JSON.stringify({ pid: 4321 }), { status: 200 });
    }));
    const manager = new WslConsoleManager({
      host, ownerId: "this-desktop", registryFile, cacheDirectory: root, fleetDirectory: ".fleet", isolatedData: true, desktopVersion: "1.0.0", development: false, systemCa: false,
      packageName: name, nodeManifest: () => ({ version: "22.0.0", source: "", targets: {} }), consoleTarball: async () => "x.tgz",
      consoleTarget: async () => ({ version: "1.3.0", tarball: async () => "x.tgz" }), log: { info: () => undefined, error: () => undefined }, stopTimeoutMs: 1000, startTimeoutMs: 20,
    });
    const accepted = () => isDesktopResourceRootMarkerValid(fs.readFileSync(marker, "utf8"));
    try {
      // First install: the Console is never launched from a tree without the marker (the start itself times out, as no lock appears).
      await expect(manager.start("one")).rejects.toThrow("wsl_console_start");
      expect(launches).toBe(1);
      expect(accepted()).toBe(true);
      // An install made before the marker existed is repaired where it stands, with no reinstall.
      write(`${pkg}/kept.txt`, "");
      fs.rmSync(marker);
      await expect(manager.start("one")).rejects.toThrow("wsl_console_start");
      expect(accepted()).toBe(true);
      expect(fs.existsSync(`${pkg}/kept.txt`)).toBe(true);
      // A confirmed update replaces the tree, and the replacement carries the marker too.
      publish();
      updating = true;
      await expect(manager.update("one")).resolves.toBeTypeOf("string");
      expect(launches).toBe(3);
      expect(fs.existsSync(`${pkg}/kept.txt`)).toBe(false);
      expect(accepted()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
