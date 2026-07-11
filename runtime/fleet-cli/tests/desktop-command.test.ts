import { describe, expect, it, vi } from "vitest";

import { runDesktopDev } from "../src/desktop-command.js";

describe("fleet desktop development command", () => {
  it("starts the workspace desktop dev script with inherited terminal I/O and environment", async () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: unknown) => ({
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
      }),
    }));
    const result = runDesktopDev({
      cwd: "/workspace",
      desktopPackageDirectory: "/workspace/runtime/fleet-desktop",
      platform: "darwin",
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith("pnpm", ["--dir", "/workspace/runtime/fleet-desktop", "dev"], {
      cwd: "/workspace",
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    listeners.get("exit")?.(0, null);
    await expect(result).resolves.toBe(0);
  });

  it("uses Node to invoke the verified pnpm executable on Windows", async () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: unknown) => ({
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
      }),
    }));
    const result = runDesktopDev({
      desktopPackageDirectory: "C:\\workspace\\runtime\\fleet-desktop",
      env: { npm_execpath: "C:\\tools\\pnpm.cjs" },
      execPath: "C:\\node\\node.exe",
      isPackageManagerExecutable: () => true,
      platform: "win32",
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith("C:\\node\\node.exe", ["C:\\tools\\pnpm.cjs", "--dir", "C:\\workspace\\runtime\\fleet-desktop", "dev"], {
      cwd: process.cwd(),
      env: { npm_execpath: "C:\\tools\\pnpm.cjs" },
      stdio: "inherit",
      windowsHide: true,
    });
    listeners.get("exit")?.(0, null);
    await expect(result).resolves.toBe(0);
  });

  it("fails closed on Windows without a verified package-manager executable", async () => {
    const spawn = vi.fn();

    await expect(runDesktopDev({ env: {}, platform: "win32", spawn })).rejects.toThrow("desktop_development_package_manager_unavailable");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("spawns a verified native pnpm.exe directly on Windows", async () => {
    const listeners = new Map<string, (...args: never[]) => void>();
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: unknown) => ({
      on: vi.fn((event: string, listener: (...args: never[]) => void) => {
        listeners.set(event, listener);
      }),
    }));
    const result = runDesktopDev({
      desktopPackageDirectory: "C:\\workspace\\runtime\\fleet-desktop",
      env: { npm_execpath: "C:\\tools\\pnpm.exe" },
      execPath: "C:\\tools\\pnpm.exe",
      isPackageManagerExecutable: () => true,
      platform: "win32",
      spawn,
    });

    expect(spawn).toHaveBeenCalledWith("C:\\tools\\pnpm.exe", ["--dir", "C:\\workspace\\runtime\\fleet-desktop", "dev"], {
      cwd: process.cwd(),
      env: { npm_execpath: "C:\\tools\\pnpm.exe" },
      stdio: "inherit",
      windowsHide: true,
    });
    listeners.get("exit")?.(0, null);
    await expect(result).resolves.toBe(0);
  });
});
