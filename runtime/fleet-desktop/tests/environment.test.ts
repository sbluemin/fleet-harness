import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DESKTOP_CONSOLE_SOURCE_ENV, DESKTOP_DEVELOPMENT_ENV, DESKTOP_OWNER_ID_ENV, DESKTOP_OWNER_KIND_ENV, DESKTOP_PROTOCOL_VERSION_ENV, DESKTOP_RESOURCE_ROOT_ENV } from "@fleet-console/protocol/desktop";

import { createDesktopEnvironment, createHydratedDesktopEnvironment, desktopExecutableSearchPaths, migrateLegacyBrowserProfileRoot, readInteractiveLoginShellPath, resolveBrowserProfileRoot, resolveDesktopUserDataDirectory, sanitizeEnvironment } from "../src/environment.js";

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { force: true, recursive: true });
});

describe("desktop environment", () => {
  it("isolates development ownership and Console state in the current worktree", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-dev-"));
    TEMP_DIRS.push(worktree);
    const resourceRoot = path.join(worktree, "runtime", "fleet-console");
    const environment = createDesktopEnvironment(path.join(worktree, "user-data"), "1.23.0", resourceRoot, false, {});
    const expectedConsoleDir = path.join(worktree, ".fleet", "console");

    expect(environment.consoleDir).toBe(expectedConsoleDir);
    expect(environment.dataDir).toBe(expectedConsoleDir);
    expect(environment.serviceEnv.FLEET_CONSOLE_DIR).toBe(expectedConsoleDir);
    expect(environment.serviceEnv[DESKTOP_DEVELOPMENT_ENV]).toBe("1");
    expect(fs.existsSync(path.join(expectedConsoleDir, "desktop-owner-id"))).toBe(true);
    expect(resolveDesktopUserDataDirectory(path.join(worktree, "user-data"), resourceRoot, false, {})).toBe(path.join(expectedConsoleDir, "desktop"));
  });

  it("does not pass a development protocol marker to packaged sidecars", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-packaged-"));
    TEMP_DIRS.push(userDataDir);
    const environment = createDesktopEnvironment(userDataDir, "1.23.0", "/packaged/resources/sidecar/fleet-console", true, {
      [DESKTOP_DEVELOPMENT_ENV]: "1",
    });
    expect(environment.serviceEnv[DESKTOP_DEVELOPMENT_ENV]).toBeUndefined();
    // Without this capability Console treats the shell as npm-only and holds every in-place update.
    expect(environment.serviceEnv[DESKTOP_CONSOLE_SOURCE_ENV]).toBe("github-release");
    expect(fs.existsSync(path.join(userDataDir, "desktop-owner-id"))).toBe(true);
    expect(resolveDesktopUserDataDirectory(userDataDir, "/packaged/resources/sidecar/fleet-console", true, {})).toBe(userDataDir);
  });

  it("rejects a relative isolation override instead of silently using the real user root", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-relative-"));
    TEMP_DIRS.push(worktree);
    const resourceRoot = path.join(worktree, "runtime", "fleet-console");

    expect(() => createDesktopEnvironment(path.join(worktree, "user-data"), "1.23.0", resourceRoot, false, { FLEET_DESKTOP_DATA_DIR: ".fleet/isolated/desktop" }))
      .toThrow("desktop_data_dir_must_be_absolute");
  });

  it("rejects relative packaged Console directory overrides", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-relative-dir-"));
    TEMP_DIRS.push(userDataDir);

    expect(() => createDesktopEnvironment(userDataDir, "1.23.0", "/packaged/resources/sidecar/fleet-console", true, { fleet_console_dir: "relative-console" })).toThrow("desktop_console_dir_must_be_absolute");
  });

  it("keeps browser profiles inside userData except on Windows, where roaming userData is avoided", () => {
    const userData = path.join(os.tmpdir(), "fleet-desktop-userdata");
    const fleetRoot = path.join(os.tmpdir(), "fleet-desktop-fleet");
    expect(resolveBrowserProfileRoot(userData, true, {}, "darwin")).toBe(path.join(userData, "browser-profiles"));
    expect(resolveBrowserProfileRoot(userData, false, { FLEET_DATA_DIR: fleetRoot }, "linux")).toBe(path.join(userData, "browser-profiles"));
    expect(resolveBrowserProfileRoot(userData, false, { FLEET_DATA_DIR: fleetRoot }, "win32")).toBe(path.join(fleetRoot, "desktop", "browser-profiles"));
    // 패키지된 앱은 격리 지정에도 userData 를 옮기지 않으므로, 지정된 자리를 써야 사람의 실제 프로필과 섞이지 않는다.
    expect(resolveBrowserProfileRoot(userData, true, { FLEET_DATA_DIR: fleetRoot }, "darwin")).toBe(path.join(fleetRoot, "desktop", "browser-profiles"));
    expect(resolveBrowserProfileRoot(userData, true, { FLEET_DESKTOP_DATA_DIR: fleetRoot }, "linux")).toBe(path.join(fleetRoot, "browser-profiles"));
  });

  it("moves a packaged legacy profile root once and refuses isolated or unpackaged runs", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-profile-move-"));
    TEMP_DIRS.push(root);
    const legacy = path.join(root, "legacy");
    const target = path.join(root, "user-data", "browser-profiles");
    fs.mkdirSync(path.join(legacy, "default"), { recursive: true });
    fs.writeFileSync(path.join(legacy, "default", "marker.txt"), "keep");

    expect(migrateLegacyBrowserProfileRoot({ targetRoot: target, legacyRoot: legacy, isPackaged: false })).toBe("skipped");
    expect(fs.existsSync(path.join(legacy, "default", "marker.txt"))).toBe(true);
    expect(migrateLegacyBrowserProfileRoot({ targetRoot: target, legacyRoot: legacy, isPackaged: true, env: { FLEET_DATA_DIR: root } })).toBe("skipped");
    expect(migrateLegacyBrowserProfileRoot({ targetRoot: target, legacyRoot: legacy, isPackaged: true, env: { FLEET_DESKTOP_DATA_DIR: root } })).toBe("skipped");
    expect(fs.existsSync(path.join(legacy, "default", "marker.txt"))).toBe(true);

    expect(migrateLegacyBrowserProfileRoot({ targetRoot: target, legacyRoot: legacy, isPackaged: true, env: {} })).toBe("moved");
    expect(fs.readFileSync(path.join(target, "default", "marker.txt"), "utf8")).toBe("keep");
    expect(fs.existsSync(legacy)).toBe(false);
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, "other.txt"), "nope");
    expect(migrateLegacyBrowserProfileRoot({ targetRoot: target, legacyRoot: legacy, isPackaged: true, env: {} })).toBe("occupied");
    expect(fs.existsSync(path.join(target, "other.txt"))).toBe(false);

    const legacyFail = path.join(root, "legacy-fail");
    const targetFail = path.join(root, "user-data-fail", "browser-profiles");
    fs.mkdirSync(path.join(legacyFail, "default"), { recursive: true });
    fs.writeFileSync(path.join(legacyFail, "default", "marker.txt"), "keep");
    const exdev = Object.assign(new Error("cross device"), { code: "EXDEV" });
    expect(() => migrateLegacyBrowserProfileRoot({
      targetRoot: targetFail,
      legacyRoot: legacyFail,
      isPackaged: true,
      env: {},
      renameDirectory: () => { throw exdev; },
      copyDirectory: (_from, to) => {
        fs.mkdirSync(to, { recursive: true });
        fs.writeFileSync(path.join(to, "partial.txt"), "partial");
        throw Object.assign(new Error("copy failed"), { code: "EIO" });
      },
    })).toThrow(/copy failed/);
    expect(fs.readFileSync(path.join(legacyFail, "default", "marker.txt"), "utf8")).toBe("keep");
    expect(fs.existsSync(targetFail)).toBe(false);
    expect(fs.existsSync(`${path.dirname(targetFail)}/${path.basename(targetFail)}.partial`)).toBe(false);
  });

  it("sanitizes case-insensitive Electron, Node, and Desktop control keys", () => {
    expect(sanitizeEnvironment({ Electron_No_Asar: "1", node_options: "--inspect", FLEET_CONSOLE_DIR: "/console", Fleet_Console_Owner_Id: "owner", PRESERVED: "yes" })).toEqual({ PRESERVED: "yes" });
  });

  it("defaults the sidecar service environment to trust the OS CA store", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-system-ca-"));
    TEMP_DIRS.push(worktree);
    const resourceRoot = path.join(worktree, "runtime", "fleet-console");
    const environment = createDesktopEnvironment(path.join(worktree, "user-data"), "1.23.0", resourceRoot, false, {});
    expect(environment.serviceEnv.NODE_USE_SYSTEM_CA).toBe("1");
  });
});
