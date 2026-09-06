import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DESKTOP_DEVELOPMENT_ENV, DESKTOP_OWNER_ID_ENV, DESKTOP_OWNER_KIND_ENV, DESKTOP_PROTOCOL_VERSION_ENV, DESKTOP_RESOURCE_ROOT_ENV } from "@fleet-console/desktop-protocol";

import { createDesktopEnvironment, createHydratedDesktopEnvironment, desktopExecutableSearchPaths, readInteractiveLoginShellPath, resolveDesktopUserDataDirectory, sanitizeEnvironment } from "../src/environment.js";

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
