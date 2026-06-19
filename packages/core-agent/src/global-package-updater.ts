import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";

import { resolvePathBinary, type ResolveBinaryOptions, type ResolvedBinary } from "./bin-resolver.js";
import { fetchLatestVersion, isVersionGreater } from "./version-check.js";

export type GlobalPackageManagerCommand = "npm" | "pnpm";
export type GlobalPackageUpdateReason = "local" | "permission";
export type GlobalPackageUpdateStatus = "current" | "installed" | "failed" | "manual";
export type GlobalPackageUpdaterReport = (message: string) => void;
export type GlobalPackageUpdaterHook<T> = (context: T) => MaybePromise<void>;
export type GlobalPackageVersionResolver = (packageName: string, channel: string) => Promise<string | undefined>;
export type GlobalPackageCurrentVersionResolver = () => MaybePromise<string | undefined>;
export type GlobalPackageRootResolver = () => MaybePromise<string | undefined>;
export type GlobalPackageBinaryResolver = (command: GlobalPackageManagerCommand, env: NodeJS.ProcessEnv, options: ResolveBinaryOptions) => ResolvedBinary | undefined;
export type GlobalPackageExecFile = (file: string, args: readonly string[]) => string;
export type GlobalPackageSpawnInstall = (file: string, args: readonly string[], context: GlobalPackageSpawnContext) => GlobalPackageInstallProcess;
export type GlobalPackageRealpath = (targetPath: string) => string;
export type GlobalPackageCanWrite = (targetPath: string) => boolean;

type MaybePromise<T> = T | Promise<T>;

export interface GlobalPackageManagerInstall {
  readonly command: GlobalPackageManagerCommand;
  readonly globalRoot: string;
  readonly resolved: ResolvedBinary;
}

export interface GlobalPackageManagerDetection {
  readonly manager: GlobalPackageManagerInstall | undefined;
  readonly reason: GlobalPackageUpdateReason | undefined;
}

export interface GlobalPackageUpdateOptions {
  readonly channel?: string;
}

export interface GlobalPackageInstallContext {
  readonly manager: GlobalPackageManagerInstall;
  readonly versionOrChannel: string;
  readonly packageNames: readonly [string, ...string[]];
}

export interface GlobalPackageSpawnContext extends GlobalPackageInstallContext {
  readonly commandArgs: readonly string[];
}

export interface GlobalPackageUpdateResult {
  readonly status: GlobalPackageUpdateStatus;
  readonly code: number;
  readonly manager?: GlobalPackageManagerInstall;
  readonly reason?: GlobalPackageUpdateReason;
  readonly currentVersion?: string;
  readonly latestVersion?: string;
  readonly versionOrChannel?: string;
  readonly manualMessage?: string;
}

export interface GlobalPackageInstallProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface GlobalPackageUpdater {
  detectPackageManager(): Promise<GlobalPackageManagerDetection>;
  update(options?: GlobalPackageUpdateOptions): Promise<GlobalPackageUpdateResult>;
  install(manager: GlobalPackageManagerInstall, versionOrChannel: string): Promise<number>;
  createManualInstallMessage(channel: string, reason: GlobalPackageUpdateReason | undefined): string;
  formatInstallCommand(command: GlobalPackageManagerCommand, versionOrChannel: string): string;
}

export interface CreateGlobalPackageUpdaterDeps {
  readonly packageNames: readonly [string, ...string[]];
  readonly resolveCurrentPackageRoot: GlobalPackageRootResolver;
  readonly resolveCurrentVersion: GlobalPackageCurrentVersionResolver;
  readonly resolveLatestVersion?: GlobalPackageVersionResolver;
  readonly isVersionGreater?: (left: string, right: string) => boolean;
  readonly prepareInstall?: GlobalPackageUpdaterHook<GlobalPackageInstallContext>;
  readonly finalizeSuccess?: GlobalPackageUpdaterHook<GlobalPackageInstallContext>;
  readonly report?: GlobalPackageUpdaterReport;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly resolveBinary?: GlobalPackageBinaryResolver;
  readonly execFile?: GlobalPackageExecFile;
  readonly spawnInstall?: GlobalPackageSpawnInstall;
  readonly realpath?: GlobalPackageRealpath;
  readonly canWrite?: GlobalPackageCanWrite;
}

interface ResolvedUpdaterDeps {
  readonly packageNames: readonly [string, ...string[]];
  readonly resolveCurrentPackageRoot: GlobalPackageRootResolver;
  readonly resolveCurrentVersion: GlobalPackageCurrentVersionResolver;
  readonly resolveLatestVersion: GlobalPackageVersionResolver;
  readonly isVersionGreater: (left: string, right: string) => boolean;
  readonly prepareInstall: GlobalPackageUpdaterHook<GlobalPackageInstallContext> | undefined;
  readonly finalizeSuccess: GlobalPackageUpdaterHook<GlobalPackageInstallContext> | undefined;
  readonly report: GlobalPackageUpdaterReport | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly resolveBinary: GlobalPackageBinaryResolver;
  readonly execFile: GlobalPackageExecFile;
  readonly spawnInstall: GlobalPackageSpawnInstall;
  readonly realpath: GlobalPackageRealpath;
  readonly canWrite: GlobalPackageCanWrite;
}

const DEFAULT_CHANNEL = "latest";
const PACKAGE_MANAGER_COMMANDS = ["npm", "pnpm"] as const;

export function createGlobalPackageUpdater(deps: CreateGlobalPackageUpdaterDeps): GlobalPackageUpdater {
  const resolvedDeps = resolveDeps(deps);
  return {
    detectPackageManager: () => detectPackageManager(resolvedDeps),
    update: (options = {}) => updatePackages(resolvedDeps, options),
    install: (manager, versionOrChannel) => installPackages(resolvedDeps, manager, versionOrChannel),
    createManualInstallMessage: (channel, reason) => createManualInstallMessage(resolvedDeps, channel, reason),
    formatInstallCommand: (command, versionOrChannel) => formatInstallCommand(resolvedDeps.packageNames, command, versionOrChannel),
  };
}

function resolveDeps(deps: CreateGlobalPackageUpdaterDeps): ResolvedUpdaterDeps {
  if (deps.packageNames.length === 0) {
    throw new Error("packageNames must contain at least one package");
  }
  return {
    packageNames: deps.packageNames,
    resolveCurrentPackageRoot: deps.resolveCurrentPackageRoot,
    resolveCurrentVersion: deps.resolveCurrentVersion,
    resolveLatestVersion: deps.resolveLatestVersion ?? fetchLatestVersion,
    isVersionGreater: deps.isVersionGreater ?? isVersionGreater,
    prepareInstall: deps.prepareInstall,
    finalizeSuccess: deps.finalizeSuccess,
    report: deps.report,
    env: deps.env ?? process.env,
    platform: deps.platform ?? process.platform,
    resolveBinary: deps.resolveBinary ?? resolvePathBinary,
    execFile: deps.execFile ?? defaultExecFile,
    spawnInstall: deps.spawnInstall ?? defaultSpawnInstall,
    realpath: deps.realpath ?? realpathSync,
    canWrite: deps.canWrite ?? defaultCanWrite,
  };
}

async function updatePackages(deps: ResolvedUpdaterDeps, options: GlobalPackageUpdateOptions): Promise<GlobalPackageUpdateResult> {
  const channel = options.channel ?? DEFAULT_CHANNEL;
  const detection = await detectPackageManager(deps);
  if (detection.manager === undefined) {
    return {
      status: "manual",
      code: 0,
      reason: detection.reason,
      manualMessage: createManualInstallMessage(deps, channel, detection.reason),
    };
  }

  const currentVersion = await deps.resolveCurrentVersion();
  const latestVersion = await deps.resolveLatestVersion(deps.packageNames[0], channel);
  if (currentVersion !== undefined && latestVersion !== undefined && !deps.isVersionGreater(latestVersion, currentVersion)) {
    deps.report?.(`Global package is already on the latest version (v${currentVersion}).`);
    return {
      status: "current",
      code: 0,
      manager: detection.manager,
      currentVersion,
      latestVersion,
    };
  }

  const versionOrChannel = latestVersion ?? channel;
  if (latestVersion === undefined) {
    deps.report?.(`Could not resolve the latest package version; reinstalling ${channel}.`);
  } else {
    deps.report?.(`Installing global packages at ${versionOrChannel}.`);
  }

  const context = createInstallContext(deps, detection.manager, versionOrChannel);
  await deps.prepareInstall?.(context);
  const code = await installPackages(deps, detection.manager, versionOrChannel);
  if (code === 0) {
    await deps.finalizeSuccess?.(context);
    return {
      status: "installed",
      code,
      manager: detection.manager,
      currentVersion,
      latestVersion,
      versionOrChannel,
    };
  }

  return {
    status: "failed",
    code,
    manager: detection.manager,
    currentVersion,
    latestVersion,
    versionOrChannel,
    manualMessage: createManualInstallMessage(deps, channel, undefined),
  };
}

async function detectPackageManager(deps: ResolvedUpdaterDeps): Promise<GlobalPackageManagerDetection> {
  const packageRoot = await deps.resolveCurrentPackageRoot();
  if (packageRoot === undefined) {
    return { manager: undefined, reason: "local" };
  }

  for (const command of PACKAGE_MANAGER_COMMANDS) {
    const detected = detectGlobalRoot(deps, command, packageRoot);
    if (detected?.manager !== undefined || detected?.reason === "permission") {
      return detected;
    }
  }
  return { manager: undefined, reason: "local" };
}

function detectGlobalRoot(deps: ResolvedUpdaterDeps, command: GlobalPackageManagerCommand, packageRoot: string): GlobalPackageManagerDetection | undefined {
  try {
    const resolved = deps.resolveBinary(command, deps.env, { platform: deps.platform });
    if (resolved === undefined) {
      return undefined;
    }

    const globalRoot = deps.execFile(resolved.bin, [...resolved.prefixArgs, "root", "-g"]).trim();
    const resolvedRoot = normalizePath(deps, deps.realpath(resolvePathForPlatform(deps.platform, globalRoot)));
    const normalizedPackageRoot = normalizeExistingPath(deps, packageRoot);
    if (isPathInside(deps, normalizedPackageRoot, resolvedRoot)) {
      return createManagerDetection(deps, command, resolvedRoot, resolved);
    }

    const expectedPackageDir = joinPathForPlatform(deps.platform, globalRoot, deps.packageNames[0]);
    try {
      const resolvedPackageDir = normalizePath(deps, deps.realpath(expectedPackageDir));
      if (resolvedPackageDir === normalizedPackageRoot) {
        return createManagerDetection(deps, command, resolvedRoot, resolved);
      }
    } catch {
      // pnpm 글로벌 루트에 패키지 심링크가 없으면 일반 미탐지로 처리한다.
    }
  } catch (error) {
    deps.report?.(`Failed to detect global ${command} install: ${formatError(error)}`);
    return undefined;
  }
  return undefined;
}

function createManagerDetection(
  deps: ResolvedUpdaterDeps,
  command: GlobalPackageManagerCommand,
  globalRoot: string,
  resolved: ResolvedBinary,
): GlobalPackageManagerDetection {
  if (!deps.canWrite(globalRoot)) {
    return { manager: undefined, reason: "permission" };
  }
  return {
    manager: {
      command,
      globalRoot,
      resolved,
    },
    reason: undefined,
  };
}

function installPackages(deps: ResolvedUpdaterDeps, manager: GlobalPackageManagerInstall, versionOrChannel: string): Promise<number> {
  const context = createInstallContext(deps, manager, versionOrChannel);
  const commandArgs = [...manager.resolved.prefixArgs, "i", "-g", "--force", ...deps.packageNames.map((name) => `${name}@${versionOrChannel}`)];
  const child = deps.spawnInstall(manager.resolved.bin, commandArgs, { ...context, commandArgs });
  return new Promise((resolve) => {
    child.once("error", () => {
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      resolve(signal === null ? 0 : 1);
    });
  });
}

function createInstallContext(deps: ResolvedUpdaterDeps, manager: GlobalPackageManagerInstall, versionOrChannel: string): GlobalPackageInstallContext {
  return {
    manager,
    versionOrChannel,
    packageNames: deps.packageNames,
  };
}

function createManualInstallMessage(deps: ResolvedUpdaterDeps, channel: string, reason: GlobalPackageUpdateReason | undefined): string {
  const reasonLine =
    reason === "permission"
      ? "Global package install location is not writable, so no installer was run."
      : "Global npm or pnpm installation could not be detected, so no installer was run.";
  const commands = PACKAGE_MANAGER_COMMANDS.map((command) => formatInstallCommand(deps.packageNames, command, channel));
  return [reasonLine, "Run one of these commands manually:", ...commands].join("\n");
}

function formatInstallCommand(packageNames: readonly [string, ...string[]], command: GlobalPackageManagerCommand, versionOrChannel: string): string {
  return `${command} i -g ${packageNames.map((name) => `${name}@${versionOrChannel}`).join(" ")}`;
}

function isPathInside(deps: ResolvedUpdaterDeps, child: string, parent: string): boolean {
  const separator = deps.platform === "win32" ? "\\" : path.sep;
  return child === parent || child.startsWith(`${parent}${separator}`);
}

function normalizeExistingPath(deps: ResolvedUpdaterDeps, value: string): string {
  try {
    return normalizePath(deps, deps.realpath(value));
  } catch {
    return normalizePath(deps, value);
  }
}

function normalizePath(deps: ResolvedUpdaterDeps, value: string): string {
  const resolved = resolvePathForPlatform(deps.platform, value);
  return deps.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolvePathForPlatform(platform: NodeJS.Platform, value: string): string {
  return platform === "win32" ? path.win32.resolve(value) : path.resolve(value);
}

function joinPathForPlatform(platform: NodeJS.Platform, ...parts: readonly string[]): string {
  return platform === "win32" ? path.win32.join(...parts) : path.join(...parts);
}

function defaultExecFile(file: string, args: readonly string[]): string {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function defaultSpawnInstall(file: string, args: readonly string[]): GlobalPackageInstallProcess {
  return spawn(file, args, { stdio: "inherit" });
}

function defaultCanWrite(targetPath: string): boolean {
  try {
    accessSync(targetPath, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function formatError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const stderr = "stderr" in error ? (error as { readonly stderr?: unknown }).stderr : undefined;
    if (Buffer.isBuffer(stderr)) {
      const text = stderr.toString("utf8").trim();
      if (text.length > 0) {
        return text;
      }
    }
    if (typeof stderr === "string" && stderr.trim().length > 0) {
      return stderr.trim();
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
