import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { RuntimePaths } from "./runtime-paths.js";

export interface ConsoleInstallerFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  stat(path: string): Promise<void>;
}

export interface ConsoleInstallerDependencies {
  readonly fileSystem: ConsoleInstallerFileSystem;
  readonly run: (command: string, arguments_: readonly string[]) => Promise<void>;
  readonly randomSuffix: () => string;
}

export interface InstallConsoleOptions {
  readonly paths: RuntimePaths;
  readonly nodeRoot: string;
  readonly packageName: string;
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly dependencies?: ConsoleInstallerDependencies;
}

export interface InstalledConsole {
  readonly root: string;
  readonly version: string;
}

export async function installConsole(options: InstallConsoleOptions): Promise<InstalledConsole> {
  const dependencies = options.dependencies ?? createConsoleInstallerDependencies();
  const staging = path.join(options.paths.console, `.staging-${dependencies.randomSuffix()}`);
  try {
    await dependencies.fileSystem.mkdir(options.paths.console);
    await dependencies.fileSystem.rm(staging);
    await dependencies.fileSystem.mkdir(staging);
    // npm 셔뱅(#!/usr/bin/env node)·Windows .cmd 직접 실행은 시스템 Node 부재/spawn 보안 정책에서 깨진다 —
    // 번들 node 바이너리로 npm-cli.js를 직접 구동해야 postinstall(node-pty)도 번들 node의 PATH로 돈다.
    await dependencies.run(nodeBinaryPath(options.nodeRoot, options.platform), [npmCliPath(options.nodeRoot, options.platform), "install", "--prefix", staging, "--global=false", "--force=false", `${options.packageName}@${options.version}`]);
    await verifyInstallation(staging, options.packageName, options.version, dependencies.fileSystem);
    await replaceLatest(options.paths.latest, staging, dependencies.fileSystem);
    return { root: options.paths.latest, version: options.version };
  } catch (error) {
    await dependencies.fileSystem.rm(staging);
    throw error;
  }
}

export function createConsoleInstallerDependencies(): ConsoleInstallerDependencies {
  return {
    fileSystem: { mkdir: async (target) => { await mkdir(target, { recursive: true }); }, readFile: async (target) => readFile(target, "utf8"), rename, rm: async (target) => { await rm(target, { force: true, recursive: true }); }, stat: async (target) => { await stat(target); } },
    randomSuffix: () => Math.random().toString(36).slice(2),
    run: async (command, arguments_) => { await promisify(execFile)(command, [...arguments_]); },
  };
}

export async function replaceLatest(latest: string, staging: string, fileSystem: ConsoleInstallerFileSystem): Promise<void> {
  const backup = `${latest}.rollback`;
  let movedLatest = false;
  try {
    await fileSystem.rm(backup);
    try {
      await fileSystem.rename(latest, backup);
      movedLatest = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await fileSystem.rename(staging, latest);
    if (movedLatest) await fileSystem.rm(backup);
  } catch (error) {
    if (movedLatest) {
      try {
        await fileSystem.rename(backup, latest);
      } catch {
        // 원래 설치본 복구 실패는 호출자가 즉시 발견할 수 있도록 원인 오류를 유지한다.
      }
    }
    throw error;
  }
}

async function verifyInstallation(root: string, packageName: string, expectedVersion: string, fileSystem: ConsoleInstallerFileSystem): Promise<void> {
  const packageRoot = path.join(root, "node_modules", packageName);
  await fileSystem.stat(path.join(packageRoot, "dist", "cli.mjs"));
  const packageJson = JSON.parse(await fileSystem.readFile(path.join(packageRoot, "package.json"))) as { version?: unknown };
  if (packageJson.version !== expectedVersion) throw new Error("console_install_version_mismatch");
}

function nodeBinaryPath(nodeRoot: string, platform: NodeJS.Platform): string {
  return path.join(nodeRoot, platform === "win32" ? "node.exe" : "bin/node");
}

function npmCliPath(nodeRoot: string, platform: NodeJS.Platform): string {
  return path.join(nodeRoot, platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js");
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
