import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createNativeFolderPicker } from "../src/terminal/folder-picker.js";
import { createFolderGrantStore, validateAbsoluteDirectory } from "../src/terminal/folder-grants.js";

describe("folder grants", () => {
  it("consumes folder grants exactly once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-grant-"));
    const store = createFolderGrantStore({ randomId: () => "grant-a" });

    const grantId = store.issue(dir);

    expect(grantId).toBe("grant-a");
    expect(store.consume(grantId)).toBe(dir);
    expect(store.consume(grantId)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts only absolute directories", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-grant-"));
    const file = path.join(dir, "file.txt");
    fs.writeFileSync(file, "x");

    expect(validateAbsoluteDirectory(dir)).toBe(dir);
    expect(() => validateAbsoluteDirectory("relative")).toThrow("invalid_folder");
    expect(() => validateAbsoluteDirectory(file)).toThrow("invalid_folder");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("expires folder grants after the TTL so a leaked grant cannot be reused later", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-console-grant-"));
    let clock = 1_000;
    const store = createFolderGrantStore({ randomId: () => "grant-ttl", ttlMs: 500, now: () => clock });

    const grantId = store.issue(dir);
    clock += 600; // TTL(500ms) 초과

    expect(store.consume(grantId)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("native folder picker", () => {
  it("returns cancelled when the native dialog is cancelled", async () => {
    const pick = createNativeFolderPicker({
      platform: "darwin",
      runCommand: async () => {
        const error = new Error("User canceled.") as NodeJS.ErrnoException & { stderr?: string };
        error.stderr = "User canceled.";
        throw error;
      },
    });

    await expect(pick()).resolves.toEqual({ kind: "cancelled" });
  });

  it("treats a non-zero dialog exit without an English cancel message as cancelled", async () => {
    const pick = createNativeFolderPicker({
      platform: "darwin",
      runCommand: async () => {
        // 비영어(예: 한국어) macOS에서 osascript 취소 메시지는 로케일화되어 "cancel" 텍스트가 없다.
        const error = new Error("Command failed: osascript") as NodeJS.ErrnoException & { stderr?: string };
        error.stderr = "execution error: 사용자가 취소했습니다. (-128)";
        throw error;
      },
    });

    await expect(pick()).resolves.toEqual({ kind: "cancelled" });
  });

  it("returns dialog_unavailable when platform commands are missing", async () => {
    const pick = createNativeFolderPicker({
      platform: "linux",
      runCommand: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
    });

    await expect(pick()).resolves.toEqual({ kind: "error", error: "dialog_unavailable" });
  });

  it("returns dialog_timeout when the native dialog times out", async () => {
    const pick = createNativeFolderPicker({
      platform: "darwin",
      runCommand: async () => {
        const error = new Error("timeout") as NodeJS.ErrnoException;
        error.code = "ETIMEDOUT";
        throw error;
      },
    });

    await expect(pick()).resolves.toEqual({ kind: "error", error: "dialog_timeout" });
  });

  it("returns invalid_folder when the selected path is not an absolute directory", async () => {
    const pick = createNativeFolderPicker({
      platform: "darwin",
      runCommand: async () => ({ stdout: "relative\n" }),
    });

    await expect(pick()).resolves.toEqual({ kind: "error", error: "invalid_folder" });
  });
});

describe("native folder picker — WSL", () => {
  const mockStatSync = (() => ({ isDirectory: () => true })) as unknown as typeof fs.statSync;

  it("converts a Windows drive path via wslpath and returns selected", async () => {
    const pick = createNativeFolderPicker({
      platform: "linux",
      readProcVersion: () => "Linux version 5.15.0-43-generic Microsoft WSL2",
      env: {},
      runCommand: async (bin) => {
        if (bin === "powershell.exe") return { stdout: "C:\\Users\\x\r\n" };
        if (bin === "wslpath") return { stdout: "/mnt/c/Users/x\n" };
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      statSync: mockStatSync,
    });

    await expect(pick()).resolves.toEqual({ kind: "selected", cwd: "/mnt/c/Users/x" });
  });

  it("converts a UNC wsl.localhost path via wslpath and returns selected", async () => {
    const pick = createNativeFolderPicker({
      platform: "linux",
      readProcVersion: () => "",
      env: { WSL_DISTRO_NAME: "Ubuntu-26.04" },
      runCommand: async (bin) => {
        if (bin === "powershell.exe") return { stdout: "\\\\wsl.localhost\\Ubuntu-26.04\\home\\u\r\n" };
        if (bin === "wslpath") return { stdout: "/home/u\n" };
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      statSync: mockStatSync,
    });

    await expect(pick()).resolves.toEqual({ kind: "selected", cwd: "/home/u" });
  });

  it("wslpath failure yields invalid_folder and not cancelled", async () => {
    // 등록되지 않은 네트워크 공유 등 wslpath가 변환 불가한 경로: rc=1 → invalid_folder
    const pick = createNativeFolderPicker({
      platform: "linux",
      readProcVersion: () => "",
      env: { WSL_DISTRO_NAME: "Ubuntu-26.04" },
      runCommand: async (bin) => {
        if (bin === "powershell.exe") return { stdout: "\\\\fileserver\\share\\proj\r\n" };
        if (bin === "wslpath") throw new Error("wslpath: failed to retrieve drive or UNC path");
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      statSync: mockStatSync,
    });

    await expect(pick()).resolves.toEqual({ kind: "error", error: "invalid_folder" });
  });

  it("all commands ENOENT in WSL yields dialog_unavailable", async () => {
    const pick = createNativeFolderPicker({
      platform: "linux",
      readProcVersion: () => "",
      env: { WSL_INTEROP: "/run/WSL/1_interop" },
      runCommand: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });

    await expect(pick()).resolves.toEqual({ kind: "error", error: "dialog_unavailable" });
  });

  it("powershell non-ENOENT exit (user cancel) yields cancelled before zenity/kdialog", async () => {
    // PowerShell exit 1(취소)는 non-ENOENT이므로 cancelled를 즉시 반환해야 한다.
    const pick = createNativeFolderPicker({
      platform: "linux",
      readProcVersion: () => "",
      env: { WSL_DISTRO_NAME: "Ubuntu-26.04" },
      runCommand: async (bin) => {
        if (bin === "powershell.exe") throw new Error("Command failed: powershell.exe");
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });

    await expect(pick()).resolves.toEqual({ kind: "cancelled" });
  });

  it("non-WSL linux never invokes powershell, only zenity then kdialog", async () => {
    const invocations: string[] = [];
    const pick = createNativeFolderPicker({
      platform: "linux",
      readProcVersion: () => "",
      env: {},
      runCommand: async (bin) => {
        invocations.push(bin);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });

    await pick();
    expect(invocations).not.toContain("powershell.exe");
    expect(invocations).toEqual(["zenity", "kdialog"]);
  });

  it("WSL detection works via WSL_INTEROP env var when /proc/version is empty", async () => {
    const invocations: string[] = [];
    const pick = createNativeFolderPicker({
      platform: "linux",
      readProcVersion: () => "",
      env: { WSL_INTEROP: "/run/WSL/1_interop" },
      runCommand: async (bin) => {
        invocations.push(bin);
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });

    await pick();
    expect(invocations[0]).toBe("powershell.exe");
  });

  it("injects the WSL home as the IFileOpenDialog start folder and drops FORCEFILESYSTEM", async () => {
    let powershellArgs: readonly string[] = [];
    const pick = createNativeFolderPicker({
      platform: "linux",
      readProcVersion: () => "",
      env: { WSL_DISTRO_NAME: "Ubuntu-26.04", HOME: "/home/u" },
      runCommand: async (bin, args) => {
        if (bin === "powershell.exe") {
          powershellArgs = args;
          return { stdout: "\\\\wsl.localhost\\Ubuntu-26.04\\home\\u\r\n" };
        }
        if (bin === "wslpath") return { stdout: "/home/u\n" };
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      statSync: mockStatSync,
    });

    await expect(pick()).resolves.toEqual({ kind: "selected", cwd: "/home/u" });
    const script = powershellArgs.join("\n");
    expect(script).toContain("\\\\wsl.localhost\\Ubuntu-26.04\\home\\u");
    expect(script).toContain("[FleetPicker.Picker]::Pick(");
    expect(script).not.toContain("FORCEFILESYSTEM");
  });

  it("win32 builds the modern IFileOpenDialog command with an empty start folder", async () => {
    let powershellArgs: readonly string[] = [];
    const pick = createNativeFolderPicker({
      platform: "win32",
      runCommand: async (bin, args) => {
        powershellArgs = args;
        throw new Error("cancel"); // 경로 검증까지 갈 필요 없이 args만 캡처
      },
    });

    await pick();
    const script = powershellArgs.join("\n");
    expect(script).toContain("[FleetPicker.Picker]::Pick('')");
    expect(script).toContain("IFileOpenDialog");
  });
});
