import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";

import { resolvePathBinary, type ResolveBinaryOptions, type ResolvedBinary } from "@fleet-console/process";
import {
  CONSOLE_RELEASE_TARBALL_ALIAS,
  consoleReleaseLatestAssetUrl,
  consoleReleaseTarballUrl,
  type ConsoleReleaseManifest,
} from "@fleet-console/protocol/release";

export type GlobalPackageManagerCommand = "npm" | "pnpm";
export type GlobalPackageUpdateReason = "local" | "permission";
export type GlobalPackageUpdaterReport = (message: string) => void;
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
  /** 전역 설치가 쓰는 bin 디렉터리: npm은 `prefix -g`의 bin(POSIX)·prefix 자체(Windows), pnpm은 `bin -g`. */
  readonly globalBinDir: string;
  readonly resolved: ResolvedBinary;
}

export interface GlobalPackageManagerDetection {
  readonly manager: GlobalPackageManagerInstall | undefined;
  readonly reason: GlobalPackageUpdateReason | undefined;
}

export interface GlobalPackageInstallContext {
  readonly manager: GlobalPackageManagerInstall;
  /** An already verified local tarball; the installer never resolves a version from a registry. */
  readonly tarballPath: string;
}

export interface GlobalPackageSpawnContext extends GlobalPackageInstallContext {
  readonly commandArgs: readonly string[];
}

export interface GlobalPackageInstallProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface GlobalPackageUpdater {
  detectPackageManager(): Promise<GlobalPackageManagerDetection>;
  install(manager: GlobalPackageManagerInstall, tarballPath: string): Promise<number>;
}

export interface CreateGlobalPackageUpdaterDeps {
  readonly packageNames: readonly [string, ...string[]];
  readonly resolveCurrentPackageRoot: GlobalPackageRootResolver;
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
  readonly report: GlobalPackageUpdaterReport | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly resolveBinary: GlobalPackageBinaryResolver;
  readonly execFile: GlobalPackageExecFile;
  readonly spawnInstall: GlobalPackageSpawnInstall;
  readonly realpath: GlobalPackageRealpath;
  readonly canWrite: GlobalPackageCanWrite;
}

const PACKAGE_MANAGER_COMMANDS = ["npm", "pnpm"] as const;

export function createGlobalPackageUpdater(deps: CreateGlobalPackageUpdaterDeps): GlobalPackageUpdater {
  const resolvedDeps = resolveDeps(deps);
  return {
    detectPackageManager: () => detectPackageManager(resolvedDeps),
    install: (manager, tarballPath) => installTarball(resolvedDeps, manager, tarballPath),
  };
}

/** npm and pnpm both accept `i -g --force <absolute .tgz>`; `--force` lets a same-version reinstall replace the bins. */
export function globalTarballInstallArgs(prefixArgs: readonly string[], tarballPath: string): readonly string[] {
  return [...prefixArgs, "i", "-g", "--force", tarballPath];
}

/**
 * Commands a person can run when Console cannot install for them. They point at the release asset
 * itself, never at the npm registry, so a manual update lands on the same build an automatic one would.
 */
export function formatConsoleReleaseInstallCommands(manifest: Pick<ConsoleReleaseManifest, "tag" | "tarball"> | null): readonly string[] {
  const url = manifest === null ? consoleReleaseLatestAssetUrl(CONSOLE_RELEASE_TARBALL_ALIAS) : consoleReleaseTarballUrl(manifest);
  return [`npm i -g ${url}`, `pnpm add -g ${url}`];
}

/**
 * npm 전역 bin 디렉터리: `prefix -g`의 bin(POSIX), prefix 자체(Windows).
 * npm 9+에는 `npm bin -g`가 없으므로 prefix에서 유도한다.
 * host 조기 검사의 판정이며, worker preflight(host/update-apply.ts의 resolveGlobalBinDir)가
 * 같은 규칙을 inline으로 mirror한다. 양쪽을 함께 고친다.
 */
function resolveNpmGlobalBinDir(prefixOutput: string, platform: NodeJS.Platform): string {
  const prefix = prefixOutput.trim();
  if (platform === "win32") {
    return path.win32.resolve(prefix).toLowerCase();
  }
  return path.posix.join(path.posix.resolve(prefix), "bin");
}

/** pnpm 전역 bin 디렉터리: `pnpm bin -g` 출력 자체. worker preflight가 같은 규칙을 mirror한다. */
function normalizeGlobalBinPath(binOutput: string, platform: NodeJS.Platform): string {
  const value = binOutput.trim();
  if (platform === "win32") {
    return path.win32.resolve(value).toLowerCase();
  }
  return path.posix.resolve(value);
}

function resolveDeps(deps: CreateGlobalPackageUpdaterDeps): ResolvedUpdaterDeps {
  if (deps.packageNames.length === 0) {
    throw new Error("packageNames must contain at least one package");
  }
  return {
    packageNames: deps.packageNames,
    resolveCurrentPackageRoot: deps.resolveCurrentPackageRoot,
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
  // 전역 설치는 lib/node_modules와 bin 양쪽에 쓴다. bin이 막히면 `npm i -g`가
  // 실패하므로 root만 보고 수락하지 않고 같은 permission으로 거절한다.
  let rawBinDir: string;
  try {
    if (command === "npm") {
      const prefixOutput = deps.execFile(resolved.bin, [...resolved.prefixArgs, "prefix", "-g"]);
      rawBinDir = resolveNpmGlobalBinDir(prefixOutput, deps.platform);
    } else {
      const binOutput = deps.execFile(resolved.bin, [...resolved.prefixArgs, "bin", "-g"]);
      rawBinDir = normalizeGlobalBinPath(binOutput, deps.platform);
    }
  } catch (error) {
    deps.report?.(`Failed to detect global ${command} bin: ${formatError(error)}`);
    return { manager: undefined, reason: "permission" };
  }
  let binDir = rawBinDir;
  try {
    binDir = normalizePath(deps, deps.realpath(rawBinDir));
  } catch {
    // 존재하지 않거나 읽을 수 없는 bin은 아래 쓰기 검사에서 걸러진다.
  }
  if (!deps.canWrite(binDir)) {
    return { manager: undefined, reason: "permission" };
  }
  return {
    manager: {
      command,
      globalRoot,
      globalBinDir: binDir,
      resolved,
    },
    reason: undefined,
  };
}

function installTarball(deps: ResolvedUpdaterDeps, manager: GlobalPackageManagerInstall, tarballPath: string): Promise<number> {
  const commandArgs = globalTarballInstallArgs(manager.resolved.prefixArgs, tarballPath);
  const child = deps.spawnInstall(manager.resolved.bin, commandArgs, { manager, tarballPath, commandArgs });
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
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function defaultSpawnInstall(file: string, args: readonly string[]): GlobalPackageInstallProcess {
  // fleet-allow-visible-spawn: foreground npm install shares the user's terminal and Ctrl+C; libuv ignores windowsHide with inherited stdio.
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
