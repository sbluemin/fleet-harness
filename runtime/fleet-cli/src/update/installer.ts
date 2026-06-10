import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { resolvePathBinary, type ResolvedBinary } from "../process/resolve-bin.js";
import { readFleetCliRelease } from "../release.js";
import { checkUpdateStatus, resolveUpdateChannel } from "./check.js";
import type { UpdateChannel } from "./registry.js";
import type { UpdateCommandIo } from "./types.js";

interface PackageManagerInstall {
  readonly command: "npm" | "pnpm";
  readonly globalRoot: string;
  readonly resolved: ResolvedBinary;
}

interface GlobalInstallTarget {
  readonly channel: UpdateChannel;
  readonly manager: PackageManagerInstall | undefined;
  readonly reason: "local" | "permission" | undefined;
}

const PACKAGE_NAMES = ["@dotobokuri/fleet-cli", "@dotobokuri/fleet-wiki-ui"] as const;
const FLEET_CLI_PACKAGE_NAME = "@dotobokuri/fleet-cli";
const PACKAGE_JSON_CANDIDATES = ["../package.json", "../../package.json"] as const;

export const __installerTestHooks = {
  detectGlobalRoot,
  installFleetPackages,
} as const;

export async function runFleetUpdate(io: UpdateCommandIo): Promise<number> {
  const release = readFleetCliRelease();
  const channel = resolveUpdateChannel(release.version);
  if (release.channel === "local") {
    io.stdout.write(`Fleet is running from a local development build (v${release.version}) — nothing to update here.\n`);
    return 0;
  }
  const target = resolveGlobalInstallTarget(channel, io);
  if (target.manager === undefined) {
    writeManualInstallMessage(io, target.channel, target.reason);
    return 0;
  }
  const updateCheck = await checkUpdateStatus(release, { forceRefresh: true }).catch(() => ({ status: "unavailable" as const }));
  if (updateCheck.status === "current") {
    io.stdout.write(`Fleet is already on the latest version (v${release.version}).\n`);
    return 0;
  }
  const versionOrChannel = updateCheck.status === "update" ? updateCheck.latest : target.channel;
  if (updateCheck.status === "unavailable") {
    io.stdout.write(`Could not reach the npm registry to check for updates; reinstalling the latest published version with ${target.manager.command}...\n`);
  } else {
    io.stdout.write(`Updating Fleet packages with ${target.manager.command} (${versionOrChannel})...\n`);
  }
  const status = await installFleetPackages(target.manager, versionOrChannel, io);
  if (status !== 0) {
    io.stderr.write(`Fleet update did not complete. You can run this manually:\n${formatInstallCommand(target.manager.command, target.channel)}\n`);
  }
  return status;
}

function resolveGlobalInstallTarget(channel: UpdateChannel, io: UpdateCommandIo): GlobalInstallTarget {
  const { manager, reason } = detectGlobalPackageManager(io);
  return { channel, manager, reason };
}

function detectGlobalPackageManager(io: UpdateCommandIo): { readonly manager: PackageManagerInstall | undefined; readonly reason: "local" | "permission" | undefined } {
  const packageRoot = getCurrentPackageRoot();
  if (packageRoot === undefined) {
    return { manager: undefined, reason: "local" };
  }
  const npm = detectGlobalRoot("npm", packageRoot, io);
  if (npm?.manager !== undefined || npm?.reason === "permission") {
    return npm;
  }
  const pnpm = detectGlobalRoot("pnpm", packageRoot, io);
  return pnpm ?? { manager: undefined, reason: "local" };
}

function detectGlobalRoot(command: "npm" | "pnpm", packageRoot: string, io: UpdateCommandIo): { readonly manager: PackageManagerInstall | undefined; readonly reason: "local" | "permission" | undefined } | undefined {
  try {
    const resolved = resolvePathBinary(command, process.env);
    if (resolved === undefined) {
      return undefined;
    }
    const globalRoot = execFileSync(resolved.bin, [...resolved.prefixArgs, "root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const resolvedRoot = normalizePath(realpathSync(path.resolve(globalRoot)));
    // 직접 경로 포함 확인 (npm 표준 레이아웃)
    if (isPathInside(normalizePath(packageRoot), resolvedRoot)) {
      if (!canWrite(resolvedRoot)) {
        return { manager: undefined, reason: "permission" };
      }
      return { manager: { command, globalRoot: resolvedRoot, resolved }, reason: undefined };
    }
    // pnpm 심링크 레이아웃 대응: 글로벌 루트 아래 패키지 심링크가
    // 현재 패키지 경로로 resolve 되는지 역추적
    const expectedPkgDir = path.join(globalRoot, FLEET_CLI_PACKAGE_NAME);
    try {
      const resolvedPkgDir = normalizePath(realpathSync(expectedPkgDir));
      if (resolvedPkgDir === normalizePath(packageRoot)) {
        if (!canWrite(resolvedRoot)) {
          return { manager: undefined, reason: "permission" };
        }
        return { manager: { command, globalRoot: resolvedRoot, resolved }, reason: undefined };
      }
    } catch {
      // 글로벌 루트에 패키지가 없으면 무시
    }
  } catch (error) {
    io.stderr.write(`Failed to detect Fleet's global ${command} install: ${formatError(error)}\n`);
    return undefined;
  }
  return undefined;
}

function getCurrentPackageRoot(): string | undefined {
  const requireFromHere = createRequire(import.meta.url);
  for (const candidate of PACKAGE_JSON_CANDIDATES) {
    try {
      const packageJsonPath = requireFromHere.resolve(candidate);
      const pkg = requireFromHere(packageJsonPath) as { name?: string };
      if (pkg.name === FLEET_CLI_PACKAGE_NAME) {
        return normalizePath(realpathSync(path.dirname(packageJsonPath)));
      }
    } catch {}
  }
  return undefined;
}

function installFleetPackages(manager: PackageManagerInstall, versionOrChannel: string, io: UpdateCommandIo): Promise<number> {
  const child = spawn(manager.resolved.bin, [...manager.resolved.prefixArgs, "i", "-g", ...PACKAGE_NAMES.map((name) => `${name}@${versionOrChannel}`)], {
    stdio: "inherit",
  });
  return new Promise((resolve) => {
    child.on("error", (error) => {
      io.stderr.write(`Failed to run ${manager.command} installer: ${formatError(error)}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        if (code !== 0) {
          io.stderr.write(`${manager.command} installer exited with code ${code}.\n`);
        }
        resolve(code);
        return;
      }
      if (signal) {
        io.stderr.write(`${manager.command} installer exited after signal ${signal}.\n`);
        resolve(1);
        return;
      }
      resolve(0);
    });
  });
}

function writeManualInstallMessage(io: UpdateCommandIo, channel: UpdateChannel, reason: "local" | "permission" | undefined): void {
  if (reason === "permission") {
    io.stdout.write("Fleet's global install location is not writable, so no installer was run.\n");
  } else {
    io.stdout.write("Fleet could not detect its global npm or pnpm installation, so no installer was run.\n");
  }
  writeManualInstallCommands(io, channel, "Run one of these commands manually:");
}

function writeManualInstallCommands(io: UpdateCommandIo, channel: UpdateChannel, header: string): void {
  io.stdout.write(`${header}\n`);
  io.stdout.write(`${formatInstallCommand("npm", channel)}\n`);
  io.stdout.write(`${formatInstallCommand("pnpm", channel)}\n`);
}

function formatInstallCommand(command: "npm" | "pnpm", channel: UpdateChannel): string {
  return `${command} i -g ${PACKAGE_NAMES.map((name) => `${name}@${channel}`).join(" ")}`;
}

function isPathInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function canWrite(targetPath: string): boolean {
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
