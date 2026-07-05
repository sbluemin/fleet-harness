import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolvePathBinary } from "../src/bin-resolver.js";

const TEMP_DIRS: string[] = [];

describe("process binary resolution", () => {
  afterEach(() => {
    for (const dir of TEMP_DIRS.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps Windows npm.cmd and pnpm.cmd shims without shell:true", () => {
    const binDir = makeTempDir();
    const npmShim = touch(path.join(binDir, "npm.CMD"));
    const pnpmShim = touch(path.join(binDir, "pnpm.CMD"));
    const env = {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".CMD;.EXE",
      Path: binDir,
    };

    expect(resolvePathBinary("npm", env, { platform: "win32" })).toEqual({
      bin: env.ComSpec,
      prefixArgs: ["/d", "/s", "/c", "call", `${npmShim} `],
    });
    expect(resolvePathBinary("pnpm", env, { platform: "win32" })).toEqual({
      bin: env.ComSpec,
      prefixArgs: ["/d", "/s", "/c", "call", `${pnpmShim} `],
    });
  });

  it("wraps Windows shims with spaces in the path as parse-safe cmd argv", () => {
    const binDir = makeTempDir("fleet resolve bin space - ");
    const npmShim = touch(path.join(binDir, "npm.CMD"));
    const env = {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".CMD;.EXE",
      Path: binDir,
    };

    expect(resolvePathBinary("npm", env, { platform: "win32" })).toEqual({
      bin: env.ComSpec,
      prefixArgs: ["/d", "/s", "/c", "call", `${npmShim} `],
    });
  });

  it("wraps Windows shims with cmd metacharacters in the path as parse-safe cmd argv", () => {
    const binDir = makeTempDir("fleet&resolve-bin-");
    const npmShim = touch(path.join(binDir, "npm.CMD"));
    const env = {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".CMD;.EXE",
      Path: binDir,
    };

    expect(resolvePathBinary("npm", env, { platform: "win32" })).toEqual({
      bin: env.ComSpec,
      prefixArgs: ["/d", "/s", "/c", "call", `${npmShim} `],
    });
  });

  it("rejects Windows shims with percent expansion syntax in the path", () => {
    const binDir = makeTempDir("fleet%FLEET_TOKEN%resolve-bin-");
    touch(path.join(binDir, "npm.CMD"));

    expect(() => resolvePathBinary("npm", { PATHEXT: ".CMD;.EXE", Path: binDir }, { platform: "win32" })).toThrow(
      "Refusing to run Windows shim path with cmd.exe expansion-sensitive characters",
    );
  });

  it("rejects Windows shims with caret escape syntax in the path", () => {
    const binDir = makeTempDir("fleet^resolve-bin-");
    touch(path.join(binDir, "npm.CMD"));

    expect(() => resolvePathBinary("npm", { PATHEXT: ".CMD;.EXE", Path: binDir }, { platform: "win32" })).toThrow(
      "Refusing to run Windows shim path with cmd.exe expansion-sensitive characters",
    );
  });

  it.runIf(process.platform === "win32")("executes a resolved Windows .cmd shim from a path with spaces", () => {
    const binDir = makeTempDir("fleet resolve bin space - ");
    writeFileSync(path.join(binDir, "npm.CMD"), "@echo off\necho OK:%1:%2\nexit /b 7\n");
    const resolved = resolvePathBinary("npm", { PATHEXT: ".CMD;.EXE", Path: binDir }, { platform: "win32" });

    const result = spawnSync(resolved!.bin, [...resolved!.prefixArgs, "root", "-g"], { encoding: "utf8" });

    expect(result.status).toBe(7);
    expect(result.stdout.trim()).toBe("OK:root:-g");
    expect(result.stderr.trim()).toBe("");
  });

  it.runIf(process.platform === "win32")("executes a resolved Windows .cmd shim from a path with cmd metacharacters", () => {
    const binDir = makeTempDir("fleet&resolve-bin-");
    writeFileSync(path.join(binDir, "npm.CMD"), "@echo off\necho OK:%1:%2\nexit /b 7\n");
    const resolved = resolvePathBinary("npm", { PATHEXT: ".CMD;.EXE", Path: binDir }, { platform: "win32" });

    const result = spawnSync(resolved!.bin, [...resolved!.prefixArgs, "root", "-g"], { encoding: "utf8" });

    expect(result.status).toBe(7);
    expect(result.stdout.trim()).toBe("OK:root:-g");
    expect(result.stderr.trim()).toBe("");
  });

  it("keeps POSIX executables as bare argv targets", () => {
    const binDir = makeTempDir();
    const npmBin = touch(path.join(binDir, "npm"));

    expect(resolvePathBinary("npm", { PATH: binDir }, { platform: "linux" })).toEqual({
      bin: npmBin,
      prefixArgs: [],
    });
  });
});

function makeTempDir(prefix = "fleet-resolve-bin-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}

function touch(filePath: string): string {
  closeSync(openSync(filePath, "w"));
  return filePath;
}
