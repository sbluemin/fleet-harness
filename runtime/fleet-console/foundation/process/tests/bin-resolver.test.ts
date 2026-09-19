import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findBinaryPath, prependPathEntries, resolvePathBinary } from "../src/bin-resolver.js";

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

  it("keeps POSIX executables as bare argv targets", () => {
    const binDir = makeTempDir();
    const npmBin = touchExecutable(path.join(binDir, "npm"));

    expect(resolvePathBinary("npm", { PATH: binDir }, { platform: "linux" })).toEqual({
      bin: npmBin,
      prefixArgs: [],
    });
  });
});

describe("findBinaryPath — POSIX 실행권한(X_OK) 검사", () => {
  afterEach(() => {
    for (const dir of TEMP_DIRS.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("PATH 앞 비실행(0644) 파일을 건너뛰고 뒤쪽 실행(0755) 파일을 반환한다", () => {
    const nonExecDir = makeTempDir();
    const execDir = makeTempDir();
    touch(path.join(nonExecDir, "npx"));
    const execBin = touchExecutable(path.join(execDir, "npx"));
    const pathValue = `${nonExecDir}:${execDir}`;

    const result = findBinaryPath("npx", { PATH: pathValue }, { platform: "linux" });
    expect(result).toBe(execBin);
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

function touchExecutable(filePath: string): string {
  closeSync(openSync(filePath, "w"));
  chmodSync(filePath, 0o755);
  return filePath;
}
