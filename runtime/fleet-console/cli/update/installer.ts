import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  createGlobalPackageUpdater,
  type GlobalPackageManagerInstall,
  type GlobalPackageSpawnContext,
  type GlobalPackageUpdater,
} from "@dotobokuri/core-agent";
import {
  resolvePathBinary,
} from "@dotobokuri/core-process";
import { readFleetCliRelease } from "../release.js";
import { checkUpdateStatus, resolveUpdateChannel } from "./check.js";
import { resolveSiblingConsoleCliPath, stopRunningConsoleBeforeUpdate } from "./stop-console.js";
import type { UpdateChannel } from "./registry.js";
import type { UpdateCommandIo } from "./dispatcher.js";

type PackageManagerInstall = GlobalPackageManagerInstall;

interface GlobalInstallTarget {
  readonly channel: UpdateChannel;
  readonly manager: PackageManagerInstall | undefined;
  readonly reason: "local" | "permission" | undefined;
}

const PACKAGE_NAMES = ["@dotobokuri/fleet-console"] as const;
const FLEET_CONSOLE_PACKAGE_NAME = "@dotobokuri/fleet-console";
const PACKAGE_JSON_CANDIDATES = ["../package.json", "../../package.json"] as const;

export const __installerTestHooks = {
  installFleetPackages,
} as const;

export interface RunFleetUpdateOptions {
  readonly siblingCliPath?: string;
}

export async function runFleetUpdate(io: UpdateCommandIo, options: RunFleetUpdateOptions = {}): Promise<number> {
  const siblingCliPath = options.siblingCliPath ?? resolveSiblingConsoleCliPath();
  const release = readFleetCliRelease();
  const channel = resolveUpdateChannel(release.version);
  if (release.channel === "local") {
    io.stdout.write(`Fleet is running from a local development build (v${release.version}) — nothing to update here.\n`);
    return 0;
  }
  const updater = createFleetPackageUpdater(io, release.version, siblingCliPath);
  const target = await resolveGlobalInstallTarget(channel, updater);
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
    io.stdout.write(`Updating Fleet with ${target.manager.command} (${versionOrChannel})...\n`);
  }
  await stopRunningConsoleBeforeUpdate(io, { siblingCliPath });
  const status = await installFleetPackages(target.manager, versionOrChannel, io, siblingCliPath);
  if (status !== 0) {
    io.stderr.write(`Fleet update did not complete. You can run this manually:\n${formatInstallCommand(target.manager.command, target.channel)}\n`);
  }
  return status;
}

async function resolveGlobalInstallTarget(channel: UpdateChannel, updater: GlobalPackageUpdater): Promise<GlobalInstallTarget> {
  const { manager, reason } = await updater.detectPackageManager();
  return { channel, manager, reason };
}

function createFleetPackageUpdater(
  io: UpdateCommandIo,
  currentVersion = "",
  siblingCliPath?: string,
): GlobalPackageUpdater {
  return createGlobalPackageUpdater({
    packageNames: PACKAGE_NAMES,
    resolveCurrentPackageRoot: getCurrentPackageRoot,
    resolveCurrentVersion: () => currentVersion,
    prepareInstall: () => stopRunningConsoleBeforeUpdate(io, { siblingCliPath }),
    report: (message) => reportUpdaterMessage(io, message),
    resolveBinary: (command, env, options) => resolvePathBinary(command, env, options),
    execFile: (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    spawnInstall: (file, args, context) => spawnInstallProcess(file, args, context, io),
    realpath: (targetPath) => realpathSync(targetPath),
    canWrite,
  });
}

function reportUpdaterMessage(io: UpdateCommandIo, message: string): void {
  const match = /^Failed to detect global (npm|pnpm) install: (.+)$/.exec(message);
  if (match !== null) {
    io.stderr.write(`Failed to detect Fleet's global ${match[1]} install: ${match[2]}\n`);
  }
}

function getCurrentPackageRoot(): string | undefined {
  const requireFromHere = createRequire(import.meta.url);
  for (const candidate of PACKAGE_JSON_CANDIDATES) {
    try {
      const packageJsonPath = requireFromHere.resolve(candidate);
      const pkg = requireFromHere(packageJsonPath) as { name?: string };
      if (pkg.name === FLEET_CONSOLE_PACKAGE_NAME) {
        return realpathSync(path.dirname(packageJsonPath));
      }
    } catch {}
  }
  return undefined;
}

function installFleetPackages(
  manager: PackageManagerInstall,
  versionOrChannel: string,
  io: UpdateCommandIo,
  siblingCliPath?: string,
): Promise<number> {
  return createFleetPackageUpdater(io, "", siblingCliPath).install(manager, versionOrChannel);
}

function spawnInstallProcess(file: string, args: readonly string[], context: GlobalPackageSpawnContext, io: UpdateCommandIo): ReturnType<typeof spawn> {
  const child = spawn(file, args, { stdio: "inherit" });
  child.on("error", (error) => {
    io.stderr.write(`Failed to run ${context.manager.command} installer: ${formatError(error)}\n`);
  });
  child.on("exit", (code, signal) => {
    if (typeof code === "number") {
      if (code !== 0) {
        io.stderr.write(`${context.manager.command} installer exited with code ${code}.\n`);
      }
      return;
    }
    if (signal) {
      io.stderr.write(`${context.manager.command} installer exited after signal ${signal}.\n`);
    }
  });
  return child;
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
