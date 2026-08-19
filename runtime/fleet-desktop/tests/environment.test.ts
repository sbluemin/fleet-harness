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

  it("routes a development shell into the isolated slots named by the current variables", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-isolated-"));
    TEMP_DIRS.push(worktree);
    const isolatedRoot = path.join(worktree, ".fleet", "isolated");
    const consoleDir = path.join(isolatedRoot, "console");
    const desktopDir = path.join(isolatedRoot, "desktop");
    const env = { FLEET_CONSOLE_DATA_DIR: consoleDir, FLEET_DESKTOP_DATA_DIR: desktopDir, FLEET_DATA_DIR: isolatedRoot };
    const resourceRoot = path.join(worktree, "runtime", "fleet-console");

    const environment = createDesktopEnvironment(path.join(worktree, "user-data"), "1.23.0", resourceRoot, false, env);

    expect(environment.consoleDir).toBe(consoleDir);
    expect(environment.dataDir).toBe(consoleDir);
    // owner 파일은 Console 슬롯이 아니라 Desktop 자기 자리에 앉는다.
    expect(fs.existsSync(path.join(desktopDir, "desktop-owner-id"))).toBe(true);
    expect(fs.existsSync(path.join(consoleDir, "desktop-owner-id"))).toBe(false);
    expect(resolveDesktopUserDataDirectory(path.join(worktree, "user-data"), resourceRoot, false, env)).toBe(desktopDir);
    // sidecar는 두 이름을 모두 받아, 한쪽만 아는 Console도 같은 슬롯을 찾는다.
    expect(environment.serviceEnv).toMatchObject({ FLEET_CONSOLE_DATA_DIR: consoleDir, FLEET_CONSOLE_DIR: consoleDir });
    // 루트는 Desktop이 다시 세우는 값이 아니라 통과시키는 입력이다.
    expect(environment.serviceEnv.FLEET_DATA_DIR).toBe(isolatedRoot);
  });

  it("rejects a relative isolation override instead of silently using the real user root", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-relative-"));
    TEMP_DIRS.push(worktree);
    const resourceRoot = path.join(worktree, "runtime", "fleet-console");

    expect(() => createDesktopEnvironment(path.join(worktree, "user-data"), "1.23.0", resourceRoot, false, { FLEET_DESKTOP_DATA_DIR: ".fleet/isolated/desktop" }))
      .toThrow("desktop_data_dir_must_be_absolute");
  });

  it("removes inherited control variables case-insensitively before adding packaged canonical values", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-packaged-env-"));
    TEMP_DIRS.push(userDataDir);
    const environment = createDesktopEnvironment(userDataDir, "1.23.0", "/packaged/resources/sidecar/fleet-console", true, {
      electron_run_as_node: "1",
      fleet_console_desktop_development: "1",
      fleet_console_dir: "/operator/console",
      fleet_console_owner_id: "inherited-owner",
      fleet_console_owner_kind: "cli",
      fleet_console_protocol_version: "999",
      fleet_console_resource_root: "/untrusted/root",
      fleet_console_desktop_version: "0.0.0",
      node_options: "--require untrusted.js",
      PRESERVED: "yes",
    });

    expect(environment.consoleDir).toBe("/operator/console");
    expect(environment.serviceEnv).toMatchObject({
      FLEET_CONSOLE_DIR: "/operator/console",
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_PROTOCOL_VERSION_ENV]: "1",
      [DESKTOP_RESOURCE_ROOT_ENV]: "/packaged/resources/sidecar/fleet-console",
      FLEET_CONSOLE_DESKTOP_VERSION: "1.23.0",
      PRESERVED: "yes",
    });
    expect(environment.serviceEnv[DESKTOP_DEVELOPMENT_ENV]).toBeUndefined();
    expect(environment.serviceEnv.NODE_OPTIONS).toBeUndefined();
    expect(environment.serviceEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(environment.serviceEnv[DESKTOP_OWNER_ID_ENV]).not.toBe("inherited-owner");
    expect(Object.keys(environment.serviceEnv).some((key) => key.toLowerCase() === "fleet_console_owner_id" && key !== DESKTOP_OWNER_ID_ENV)).toBe(false);
  });

  it("adds canonical development markers after removing inherited control variables", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-dev-env-"));
    TEMP_DIRS.push(worktree);
    const resourceRoot = path.join(worktree, "runtime", "fleet-console");
    const environment = createDesktopEnvironment(path.join(worktree, "user-data"), "1.23.0", resourceRoot, false, {
      FLEET_CONSOLE_DIR: "/wrong/console",
      fleet_console_desktop_development: "0",
      fleet_console_owner_kind: "cli",
      FLEET_CONSOLE_RESOURCE_ROOT: "/wrong/root",
    });
    const expectedConsoleDir = path.join(worktree, ".fleet", "console");

    expect(environment.serviceEnv).toMatchObject({
      FLEET_CONSOLE_DIR: expectedConsoleDir,
      [DESKTOP_DEVELOPMENT_ENV]: "1",
      [DESKTOP_OWNER_KIND_ENV]: "desktop",
      [DESKTOP_RESOURCE_ROOT_ENV]: resourceRoot,
    });
  });

  it("rejects relative packaged Console directory overrides", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-relative-dir-"));
    TEMP_DIRS.push(userDataDir);

    expect(() => createDesktopEnvironment(userDataDir, "1.23.0", "/packaged/resources/sidecar/fleet-console", true, { fleet_console_dir: "relative-console" })).toThrow("desktop_console_dir_must_be_absolute");
  });

  it("sanitizes case-insensitive Electron, Node, and Desktop control keys", () => {
    expect(sanitizeEnvironment({ Electron_No_Asar: "1", node_options: "--inspect", FLEET_CONSOLE_DIR: "/console", Fleet_Console_Owner_Id: "owner", PRESERVED: "yes" })).toEqual({ PRESERVED: "yes" });
  });

  it("reads only a valid interactive login-shell PATH with a sanitized probe environment", async () => {
    const run = vi.fn(async () => ({ stdout: "/Users/alice/.opencode/bin:/usr/bin" }));

    await expect(readInteractiveLoginShellPath(true, {
      SHELL: "/bin/zsh",
      PATH: "/usr/bin",
      NODE_OPTIONS: "--require attacker.js",
      ELECTRON_RUN_AS_NODE: "1",
      FLEET_CONSOLE_DIR: "/untrusted/console",
      PRESERVED: "yes",
    }, { platform: "darwin", loginShellPathProbe: { run } })).resolves.toBe("/Users/alice/.opencode/bin:/usr/bin");

    expect(run).toHaveBeenCalledWith("/bin/zsh", ["-ilc", "printf '%s' \"$PATH\""], {
      env: { SHELL: "/bin/zsh", PATH: "/usr/bin", PRESERVED: "yes" },
      maxBuffer: 8 * 1_024,
      timeout: 1_000,
      windowsHide: true,
    });
  });

  it("does not probe outside packaged macOS", async () => {
    const run = vi.fn(async () => ({ stdout: "/Users/alice/.opencode/bin" }));

    await expect(readInteractiveLoginShellPath(false, { SHELL: "/bin/zsh" }, { platform: "darwin", loginShellPathProbe: { run } })).resolves.toBeUndefined();
    await expect(readInteractiveLoginShellPath(true, { SHELL: "/bin/zsh" }, { platform: "linux", loginShellPathProbe: { run } })).resolves.toBeUndefined();
    await expect(readInteractiveLoginShellPath(true, {}, { platform: "darwin", loginShellPathProbe: { run } })).resolves.toBeUndefined();
    await expect(readInteractiveLoginShellPath(true, { SHELL: "zsh" }, { platform: "darwin", loginShellPathProbe: { run } })).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects invalid login-shell output and falls back after probe failure or timeout", async () => {
    for (const stdout of ["", "/Users/alice/.opencode/bin\n/usr/bin", "/Users/alice/.opencode\u0000/bin", "\u001b[31m/usr/bin"]) {
      const invalid = { run: vi.fn(async () => ({ stdout })) };
      await expect(readInteractiveLoginShellPath(true, { SHELL: "/bin/zsh" }, { platform: "darwin", loginShellPathProbe: invalid })).resolves.toBeUndefined();
    }

    const fallbackProbes = [
      { run: vi.fn(async () => ({ stdout: "/Users/alice/.opencode/bin\n/usr/bin" })) },
      { run: vi.fn(async () => { throw new Error("shell failed"); }) },
      { run: vi.fn(async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); }) },
    ];
    for (const loginShellPathProbe of fallbackProbes) {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-shell-path-fallback-"));
      TEMP_DIRS.push(userDataDir);
      const environment = await createHydratedDesktopEnvironment(userDataDir, "1.23.0", "/packaged/resources/fleet-console", true, {
        SHELL: "/bin/zsh",
        PATH: "/inherited/bin",
      }, { platform: "darwin", homeDirectory: "/Users/alice", loginShellPathProbe });
      expect(environment.serviceEnv.PATH?.split(":")).toEqual([
        "/Users/alice/.local/bin",
        "/Users/alice/Library/pnpm",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/inherited/bin",
      ]);
      expect(environment.serviceEnv.PATH).not.toContain(".opencode");
    }
  });

  it("orders and deduplicates packaged macOS shell, inherited, and deterministic PATH entries", async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-shell-path-"));
    TEMP_DIRS.push(userDataDir);
    const home = "/Users/alice";
    const environment = await createHydratedDesktopEnvironment(userDataDir, "1.23.0", "/packaged/resources/fleet-console", true, {
      SHELL: "/bin/zsh",
      PATH: "/inherited/bin:/shared/bin",
      npm_config_prefix: "/fallback-prefix",
      PNPM_HOME: "/shared/bin",
    }, { platform: "darwin", homeDirectory: "/Users/alice", loginShellPathProbe: { run: vi.fn(async () => ({ stdout: "/Users/alice/.opencode/bin:/shared/bin" })) } });

    expect(environment.serviceEnv.PATH).toBe([
      "/Users/alice/.opencode/bin",
      "/shared/bin",
      "/inherited/bin",
      "/fallback-prefix/bin",
      path.posix.join(home, ".local", "bin"),
      path.posix.join(home, "Library", "pnpm"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ].join(":"));
  });

  it("adds macOS user and npm executable locations for a packaged GUI launch", () => {
    expect(desktopExecutableSearchPaths("/Users/alice", { npm_config_prefix: "/Users/alice/.npm-global", PNPM_HOME: "/Users/alice/Library/pnpm" }, "darwin")).toEqual([
      "/Users/alice/.npm-global/bin",
      "/Users/alice/Library/pnpm",
      "/Users/alice/.local/bin",
      "/Users/alice/Library/pnpm",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]);
  });

  it("adds Windows npm shim and configured package-manager locations", () => {
    expect(desktopExecutableSearchPaths("C:\\Users\\alice", { APPDATA: "C:\\Users\\alice\\AppData\\Roaming", npm_config_prefix: "D:\\npm-prefix", PNPM_HOME: "D:\\pnpm" }, "win32")).toEqual([
      "D:\\npm-prefix",
      "D:\\pnpm",
      "C:\\Users\\alice\\AppData\\Roaming\\npm",
    ]);
  });

  it("defaults the sidecar service environment to trust the OS CA store", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-system-ca-"));
    TEMP_DIRS.push(worktree);
    const resourceRoot = path.join(worktree, "runtime", "fleet-console");
    const environment = createDesktopEnvironment(path.join(worktree, "user-data"), "1.23.0", resourceRoot, false, {});
    expect(environment.serviceEnv.NODE_USE_SYSTEM_CA).toBe("1");
  });

  it("honors the FLEET_CONSOLE_NO_SYSTEM_CA opt-out", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-system-ca-optout-"));
    TEMP_DIRS.push(worktree);
    const resourceRoot = path.join(worktree, "runtime", "fleet-console");
    const environment = createDesktopEnvironment(path.join(worktree, "user-data"), "1.23.0", resourceRoot, false, { FLEET_CONSOLE_NO_SYSTEM_CA: "1" });
    expect(environment.serviceEnv.NODE_USE_SYSTEM_CA).toBeUndefined();
  });

  it("does not override an explicitly set NODE_USE_SYSTEM_CA", () => {
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-system-ca-explicit-"));
    TEMP_DIRS.push(worktree);
    const resourceRoot = path.join(worktree, "runtime", "fleet-console");
    const environment = createDesktopEnvironment(path.join(worktree, "user-data"), "1.23.0", resourceRoot, false, { NODE_USE_SYSTEM_CA: "0" });
    expect(environment.serviceEnv.NODE_USE_SYSTEM_CA).toBe("0");
  });

  it("keeps NODE_USE_SYSTEM_CA on the packaged macOS PATH-normalizing branch", () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-desktop-system-ca-packaged-"));
    TEMP_DIRS.push(userDataDir);
    const environment = createDesktopEnvironment(userDataDir, "1.23.0", "/packaged/resources/sidecar/fleet-console", true, {
      SHELL: "/bin/zsh",
      PATH: "/inherited/bin",
    }, { platform: "darwin", loginShellPath: "/Users/alice/.opencode/bin:/usr/bin" });
    expect(environment.serviceEnv.NODE_USE_SYSTEM_CA).toBe("1");
  });
});
