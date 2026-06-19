import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGlobalPackageUpdater, type GlobalPackageInstallProcess } from "../src/global-package-updater.js";

const TEMP_DIRS: string[] = [];
const PACKAGE_NAMES = ["@example/cli", "@example/console"] as const;

describe("global package updater", () => {
  afterEach(() => {
    for (const dir of TEMP_DIRS.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("npm 글로벌 루트 안의 현재 패키지를 감지한다", async () => {
    const binDir = makeTempDir();
    const npmBin = touch(path.join(binDir, "npm"));
    const globalRoot = makeTempDir();
    const packageRoot = path.join(globalRoot, PACKAGE_NAMES[0]);
    mkdirSync(packageRoot, { recursive: true });
    const updater = createGlobalPackageUpdater({
      packageNames: PACKAGE_NAMES,
      resolveCurrentPackageRoot: () => packageRoot,
      resolveCurrentVersion: () => "1.0.0",
      env: { PATH: binDir },
      execFile: (file, args) => {
        expect(file).toBe(npmBin);
        expect(args).toEqual(["root", "-g"]);
        return globalRoot;
      },
    });

    await expect(updater.detectPackageManager()).resolves.toMatchObject({
      manager: {
        command: "npm",
        globalRoot: realpathSync(globalRoot),
        resolved: {
          bin: npmBin,
          prefixArgs: [],
        },
      },
      reason: undefined,
    });
  });

  it("pnpm 글로벌 루트의 패키지 심링크가 현재 패키지 루트로 resolve 되는지 확인한다", async () => {
    const packageRoot = "/store/example-cli/1.0.0";
    const npmRoot = "/global/npm/node_modules";
    const pnpmRoot = "/global/pnpm/global/5/node_modules";
    const expectedPnpmPackage = path.join(pnpmRoot, PACKAGE_NAMES[0]);
    const updater = createGlobalPackageUpdater({
      packageNames: PACKAGE_NAMES,
      resolveCurrentPackageRoot: () => packageRoot,
      resolveCurrentVersion: () => "1.0.0",
      resolveBinary: (command) => ({ bin: command, prefixArgs: [] }),
      execFile: (file) => (file === "npm" ? npmRoot : pnpmRoot),
      realpath: (targetPath) => (targetPath === expectedPnpmPackage ? packageRoot : targetPath),
      canWrite: () => true,
    });

    await expect(updater.detectPackageManager()).resolves.toMatchObject({
      manager: {
        command: "pnpm",
        globalRoot: pnpmRoot,
      },
      reason: undefined,
    });
  });

  it("현재/최신 버전 hook을 호출하고 최신 버전으로 설치한다", async () => {
    const calls: string[] = [];
    const installed = createInstallRecorder(0);
    const updater = createGlobalPackageUpdater({
      packageNames: PACKAGE_NAMES,
      resolveCurrentPackageRoot: () => "/global/node_modules/@example/cli",
      resolveCurrentVersion: () => {
        calls.push("current");
        return "1.0.0";
      },
      resolveLatestVersion: (packageName, channel) => {
        calls.push(`${packageName}:${channel}`);
        return Promise.resolve("1.2.0");
      },
      isVersionGreater: (left, right) => {
        calls.push(`${left}>${right}`);
        return true;
      },
      resolveBinary: () => ({ bin: "npm", prefixArgs: [] }),
      execFile: () => "/global/node_modules",
      realpath: (targetPath) => targetPath,
      canWrite: () => true,
      spawnInstall: installed.spawn,
    });

    await expect(updater.update()).resolves.toMatchObject({
      status: "installed",
      code: 0,
      currentVersion: "1.0.0",
      latestVersion: "1.2.0",
      versionOrChannel: "1.2.0",
    });
    expect(calls).toEqual(["current", "@example/cli:latest", "1.2.0>1.0.0"]);
    expect(installed.calls).toEqual([
      {
        file: "npm",
        args: ["i", "-g", "--force", "@example/cli@1.2.0", "@example/console@1.2.0"],
      },
    ]);
  });

  it("쓰기 권한이 없으면 수동 설치 메시지를 반환한다", async () => {
    const updater = createGlobalPackageUpdater({
      packageNames: PACKAGE_NAMES,
      resolveCurrentPackageRoot: () => "/global/node_modules/@example/cli",
      resolveCurrentVersion: () => "1.0.0",
      resolveBinary: () => ({ bin: "npm", prefixArgs: [] }),
      execFile: () => "/global/node_modules",
      realpath: (targetPath) => targetPath,
      canWrite: () => false,
    });

    await expect(updater.update({ channel: "beta" })).resolves.toEqual({
      status: "manual",
      code: 0,
      reason: "permission",
      manualMessage: [
        "Global package install location is not writable, so no installer was run.",
        "Run one of these commands manually:",
        "npm i -g @example/cli@beta @example/console@beta",
        "pnpm i -g @example/cli@beta @example/console@beta",
      ].join("\n"),
    });
  });

  it("win32 경로 판정은 대소문자를 정규화한다", async () => {
    const updater = createGlobalPackageUpdater({
      packageNames: PACKAGE_NAMES,
      resolveCurrentPackageRoot: () => "C:\\Tools\\Node\\node_modules\\@example\\cli",
      resolveCurrentVersion: () => "1.0.0",
      platform: "win32",
      resolveBinary: () => ({ bin: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "call", "npm.cmd "] }),
      execFile: () => "c:\\tools\\node\\NODE_MODULES",
      realpath: (targetPath) => targetPath,
      canWrite: () => true,
    });

    await expect(updater.detectPackageManager()).resolves.toMatchObject({
      manager: {
        command: "npm",
        globalRoot: "c:\\tools\\node\\node_modules",
      },
      reason: undefined,
    });
  });

  it("설치 커맨드는 manager prefixArgs와 i -g --force 대상 패키지를 보존한다", async () => {
    const installed = createInstallRecorder(0);
    const updater = createGlobalPackageUpdater({
      packageNames: PACKAGE_NAMES,
      resolveCurrentPackageRoot: () => undefined,
      resolveCurrentVersion: () => undefined,
      spawnInstall: installed.spawn,
    });

    await expect(
      updater.install(
        {
          command: "pnpm",
          globalRoot: "/global",
          resolved: {
            bin: "cmd.exe",
            prefixArgs: ["/d", "/s", "/c", "call", "pnpm.cmd "],
          },
        },
        "2.0.0",
      ),
    ).resolves.toBe(0);
    expect(installed.calls).toEqual([
      {
        file: "cmd.exe",
        args: ["/d", "/s", "/c", "call", "pnpm.cmd ", "i", "-g", "--force", "@example/cli@2.0.0", "@example/console@2.0.0"],
      },
    ]);
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "global-updater-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function touch(filePath: string): string {
  closeSync(openSync(filePath, "w"));
  return filePath;
}

function createInstallRecorder(code: number): {
  readonly calls: Array<{ readonly file: string; readonly args: readonly string[] }>;
  readonly spawn: (file: string, args: readonly string[]) => GlobalPackageInstallProcess;
} {
  const calls: Array<{ readonly file: string; readonly args: readonly string[] }> = [];
  return {
    calls,
    spawn: (file, args) => {
      calls.push({ file, args });
      return createInstallProcess(code);
    },
  };
}

function createInstallProcess(code: number): GlobalPackageInstallProcess {
  return new FakeInstallProcess(code);
}

class FakeInstallProcess implements GlobalPackageInstallProcess {
  private readonly exitListeners: Array<() => void> = [];

  constructor(private readonly code: number) {
    queueMicrotask(() => {
      for (const listener of this.exitListeners) {
        listener();
      }
    });
  }

  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error" | "exit", listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): this {
    if (event === "exit") {
      const exitListener = listener as (code: number | null, signal: NodeJS.Signals | null) => void;
      this.exitListeners.push(() => exitListener(this.code, null));
    }
    return this;
  }
}
