import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { satisfiesNodeEngine } from "./node-bootstrap.js";
import type { RuntimePaths } from "./runtime-paths.js";

export interface ConsoleInstallerFileSystem {
  mkdir(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<readonly string[]>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  stat(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
}

export interface ConsoleInstallerDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly fileSystem: ConsoleInstallerFileSystem;
  readonly run: (command: string, arguments_: readonly string[], options: { readonly env: NodeJS.ProcessEnv }) => Promise<void>;
  readonly randomSuffix: () => string;
}

export interface InstallConsoleOptions {
  readonly paths: RuntimePaths;
  readonly nodeRoot: string;
  readonly packageName: string;
  readonly version: string;
  readonly nodeRuntimeVersion: string;
  readonly platform: NodeJS.Platform;
  readonly dependencies?: ConsoleInstallerDependencies;
}

export interface InstalledConsole {
  readonly root: string;
  readonly version: string;
}

const STABLE_SEMVER = /^\d+\.\d+\.\d+$/;
const RESOURCE_ROOT_MARKER = ".fleet-console-resource-root";
const DESKTOP_PROTOCOL_VERSION = "1";

export async function installConsole(options: InstallConsoleOptions): Promise<InstalledConsole> {
  if (!STABLE_SEMVER.test(options.version)) throw new Error("console_install_version_invalid");
  const dependencies = options.dependencies ?? createConsoleInstallerDependencies();
  const staging = path.join(options.paths.console, `.staging-${dependencies.randomSuffix()}`);
  try {
    await dependencies.fileSystem.mkdir(options.paths.console);
    await reconcileConsoleInstallations(options.paths, dependencies.fileSystem);
    await dependencies.fileSystem.rm(staging);
    await dependencies.fileSystem.mkdir(staging);
    const npmConfiguration = path.join(staging, ".npmrc");
    await dependencies.fileSystem.writeFile(npmConfiguration, "");
    // npm 셔뱅(#!/usr/bin/env node)·Windows .cmd 직접 실행은 시스템 Node 부재/spawn 보안 정책에서 깨진다 —
    // 번들 node 바이너리로 npm-cli.js를 직접 구동해야 postinstall(node-pty)도 번들 node의 PATH로 돈다.
    try {
      await dependencies.run(nodeBinaryPath(options.nodeRoot, options.platform), [npmCliPath(options.nodeRoot, options.platform), "install", "--prefix", staging, "--global=false", "--force=false", "--package-lock=false", "--no-audit", "--no-fund", `${options.packageName}@${options.version}`], { env: createConsoleInstallerEnvironment(dependencies.environment, npmConfiguration) });
    } finally {
      await dependencies.fileSystem.rm(npmConfiguration);
    }
    await normalizePrefixInstallation(staging, options.packageName, dependencies.fileSystem);
    await verifyInstallation(staging, options.version, options.nodeRuntimeVersion, dependencies.fileSystem);
    await replaceLatest(options.paths.latest, staging, dependencies.fileSystem);
    return { root: options.paths.latest, version: options.version };
  } catch (error) {
    await dependencies.fileSystem.rm(staging);
    throw error;
  }
}

export function createConsoleInstallerDependencies(): ConsoleInstallerDependencies {
  return {
    environment: process.env,
    fileSystem: {
      mkdir: async (target) => { await mkdir(target, { recursive: true }); },
      readFile: async (target) => readFile(target, "utf8"),
      readdir,
      rename,
      rm: async (target) => { await rm(target, { force: true, recursive: true }); },
      stat: async (target) => { await stat(target); },
      writeFile: async (target, content) => { await writeFile(target, content); },
    },
    randomSuffix: () => Math.random().toString(36).slice(2),
    run: async (command, arguments_, options) => { await promisify(execFile)(command, [...arguments_], options); },
  };
}

export function createConsoleInstallerEnvironment(source: NodeJS.ProcessEnv = process.env, npmConfiguration = path.join(os.tmpdir(), "fleet-console-desktop-empty.npmrc")): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toLowerCase();
    if (value !== undefined && normalizedKey !== "node_options" && !normalizedKey.startsWith("npm_config_")) environment[key] = value;
  }
  return {
    ...environment,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_userconfig: npmConfiguration,
    npm_config_globalconfig: npmConfiguration,
  };
}

export async function reconcileConsoleInstallations(paths: RuntimePaths, fileSystem: ConsoleInstallerFileSystem): Promise<void> {
  const backup = `${paths.latest}.rollback`;
  let hasLatest = await pathExists(paths.latest, fileSystem);
  const hasBackup = await pathExists(backup, fileSystem);
  if (!hasLatest && hasBackup) {
    await fileSystem.rename(backup, paths.latest);
    hasLatest = true;
  } else if (hasLatest && hasBackup) await bestEffortCleanup(backup, fileSystem);
  try {
    for (const entry of await fileSystem.readdir(paths.console)) {
      if (entry.startsWith(".staging-")) {
        const staging = path.join(paths.console, entry);
        if (hasLatest) await bestEffortCleanup(staging, fileSystem);
        else await fileSystem.rm(staging);
      }
    }
  } catch (error) {
    if (!hasLatest && !isMissing(error)) throw error;
  }
}

export async function replaceLatest(latest: string, staging: string, fileSystem: ConsoleInstallerFileSystem): Promise<void> {
  const backup = `${latest}.rollback`;
  let movedLatest = false;
  try {
    const hasLatest = await pathExists(latest, fileSystem);
    const hasBackup = await pathExists(backup, fileSystem);
    if (!hasLatest && hasBackup) await fileSystem.rename(backup, latest);
    else if (hasLatest && hasBackup) await fileSystem.rm(backup);
    if (await pathExists(latest, fileSystem)) {
      await fileSystem.rename(latest, backup);
      movedLatest = true;
    }
    await fileSystem.rename(staging, latest);
  } catch (error) {
    if (movedLatest && !await pathExists(latest, fileSystem)) {
      try {
        await fileSystem.rename(backup, latest);
      } catch {
        // 원래 설치본 복구 실패는 호출자가 즉시 발견할 수 있도록 원인 오류를 유지한다.
      }
    }
    throw error;
  }
  // 새 latest는 이미 검증을 끝낸 설치본이다. 정리 실패가 이를 폐기하거나 부팅을 막아서는 안 되며,
  // 다음 시작의 reconciliation이 고아 rollback을 제거한다.
  if (movedLatest) {
    try {
      await fileSystem.rm(backup);
    } catch {
      // 유효한 latest를 유지한다.
    }
  }
}

async function normalizePrefixInstallation(root: string, packageName: string, fileSystem: ConsoleInstallerFileSystem): Promise<void> {
  const packageRoot = path.join(root, "node_modules", packageName);
  const heldPackage = `${root}.package`;
  await fileSystem.rm(heldPackage);
  await fileSystem.rename(packageRoot, heldPackage);
  try {
    for (const entry of await fileSystem.readdir(heldPackage)) {
      await fileSystem.rename(path.join(heldPackage, entry), path.join(root, entry));
    }
  } finally {
    await fileSystem.rm(heldPackage);
  }
  await fileSystem.writeFile(path.join(root, RESOURCE_ROOT_MARKER), `${DESKTOP_PROTOCOL_VERSION}\n`);
}

async function verifyInstallation(root: string, expectedVersion: string, nodeRuntimeVersion: string, fileSystem: ConsoleInstallerFileSystem): Promise<void> {
  await fileSystem.stat(path.join(root, "dist", "cli.mjs"));
  await fileSystem.stat(path.join(root, "dist", "desktop-protocol.mjs"));
  await fileSystem.stat(path.join(root, "node_modules", "node-pty"));
  await fileSystem.stat(path.join(root, "node_modules", "ws"));
  const packageJson = JSON.parse(await fileSystem.readFile(path.join(root, "package.json"))) as { version?: unknown; engines?: { node?: unknown } };
  if (packageJson.version !== expectedVersion) throw new Error("console_install_version_mismatch");
  const engine = typeof packageJson.engines?.node === "string" ? packageJson.engines.node : null;
  if (!satisfiesNodeEngine(nodeRuntimeVersion, engine)) throw new Error("console_install_node_engine_incompatible");
  const marker = await fileSystem.readFile(path.join(root, RESOURCE_ROOT_MARKER));
  if (marker.trim() !== DESKTOP_PROTOCOL_VERSION) throw new Error("console_install_marker_invalid");
}

function nodeBinaryPath(nodeRoot: string, platform: NodeJS.Platform): string {
  return path.join(nodeRoot, platform === "win32" ? "node.exe" : "bin/node");
}

function npmCliPath(nodeRoot: string, platform: NodeJS.Platform): string {
  return path.join(nodeRoot, platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "lib/node_modules/npm/bin/npm-cli.js");
}

async function pathExists(target: string, fileSystem: ConsoleInstallerFileSystem): Promise<boolean> {
  try {
    await fileSystem.stat(target);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function bestEffortCleanup(target: string, fileSystem: ConsoleInstallerFileSystem): Promise<void> {
  try {
    await fileSystem.rm(target);
  } catch {
    // 유효 latest가 존재할 때의 정리 실패는 다음 시작으로 미루고 부팅을 막지 않는다.
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
