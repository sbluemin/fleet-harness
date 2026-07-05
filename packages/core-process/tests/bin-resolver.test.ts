import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findBinaryPath, resolvePathBinary } from "../src/bin-resolver.js";

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
    const npmBin = touchExecutable(path.join(binDir, "npm"));

    expect(resolvePathBinary("npm", { PATH: binDir }, { platform: "linux" })).toEqual({
      bin: npmBin,
      prefixArgs: [],
    });
  });
});

describe("findBinaryPath — raw 경로 반환 (shim 래핑 없음)", () => {
  afterEach(() => {
    for (const dir of TEMP_DIRS.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32에서 .cmd shim을 cmd.exe로 변환하지 않고 raw 경로를 반환한다", () => {
    const binDir = makeTempDir();
    const npxShim = touch(path.join(binDir, "npx.CMD"));
    const env = {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".CMD;.EXE",
      Path: binDir,
    };

    const result = findBinaryPath("npx", env, { platform: "win32" });
    expect(result).toBe(npxShim);
  });

  it("win32에서 .exe 바이너리는 그대로 raw 경로를 반환한다", () => {
    const binDir = makeTempDir();
    const nodeBin = touch(path.join(binDir, "node.EXE"));
    const env = {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".CMD;.EXE",
      Path: binDir,
    };

    const result = findBinaryPath("node", env, { platform: "win32" });
    expect(result).toBe(nodeBin);
  });

  it("POSIX에서 raw 실행 파일 경로를 반환한다", () => {
    const binDir = makeTempDir();
    const npxBin = touchExecutable(path.join(binDir, "npx"));

    const result = findBinaryPath("npx", { PATH: binDir }, { platform: "linux" });
    expect(result).toBe(npxBin);
  });

  it("존재하지 않는 바이너리에 undefined를 반환한다", () => {
    const result = findBinaryPath("does-not-exist-xyz-fleet", { PATH: "" }, { platform: "linux" });
    expect(result).toBeUndefined();
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

  it.runIf(process.platform !== "win32")("후보가 비실행(0644)뿐이면 undefined를 반환한다", () => {
    const binDir = makeTempDir();
    touch(path.join(binDir, "npx"));

    const result = findBinaryPath("npx", { PATH: binDir }, { platform: "linux" });
    expect(result).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")("실행 파일(0755)은 정상 반환한다 (X_OK 회귀 없음)", () => {
    const binDir = makeTempDir();
    const npxBin = touchExecutable(path.join(binDir, "npx"));

    const result = findBinaryPath("npx", { PATH: binDir }, { platform: "linux" });
    expect(result).toBe(npxBin);
  });

  it("win32는 파일 권한 무관하게 확장자 기반으로 반환한다", () => {
    const binDir = makeTempDir();
    const npxShim = touch(path.join(binDir, "npx.CMD"));
    const env = {
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".CMD;.EXE",
      Path: binDir,
    };

    const result = findBinaryPath("npx", env, { platform: "win32" });
    expect(result).toBe(npxShim);
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
