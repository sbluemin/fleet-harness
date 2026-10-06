import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { getFleetDataDir } from "@fleet-console/infra/data-dir";
import { hasDesktopGithubReleaseConsoleSource } from "@fleet-console/protocol/desktop";
import type { ConsoleReleaseManifest } from "@fleet-console/protocol/release";
import {
  consoleReleaseTarballDir,
  createGlobalPackageUpdater,
  downloadVerifiedConsoleTarball,
  formatConsoleReleaseInstallCommands,
  retainOnlyConsoleReleaseTarball,
  type GlobalPackageManagerInstall,
  type GlobalPackageSpawnContext,
  type GlobalPackageUpdater,
} from "@fleet-console/updates";
import {
  resolvePathBinary,
} from "@fleet-console/process";
import { readFleetCliRelease } from "../release.js";
import { isManagedRuntimePackageRoot } from "../../features/updates/host/update-apply.js";
import { checkUpdateStatus, describeReleaseLookupFailure, type UpdateCheckResult } from "./check.js";
import { resolveSiblingConsoleCliPath, stopRunningConsoleBeforeUpdate } from "./stop-console.js";
import type { UpdateCommandIo } from "./dispatcher.js";

type PackageManagerInstall = GlobalPackageManagerInstall;

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
  if (release.channel === "local") {
    io.stdout.write(`Fleet is running from a local development build (v${release.version}) — nothing to update here.\n`);
    return 0;
  }
  const updateCheck = await checkUpdateStatus(release, { forceRefresh: true }).catch((): UpdateCheckResult => ({ status: "unavailable" }));
  if (updateCheck.status === "current") {
    io.stdout.write(`Fleet is already on the latest version (v${release.version}).\n`);
    return 0;
  }
  // Without a verified manifest there is nothing safe to install; reinstalling "whatever is latest" is not an update.
  if (updateCheck.status !== "update" || updateCheck.release === undefined) {
    io.stderr.write(`${describeReleaseLookupFailure(updateCheck.status === "unavailable" ? updateCheck.reason : undefined)} Nothing was installed.\n`);
    // A bad tag is fixed by the variable, not by installing something else, and Fleet Desktop's
    // install tree is never replaced by a global install.
    const invalidTag = updateCheck.status === "unavailable" && updateCheck.reason === "invalid_override";
    if (!invalidTag && !isDesktopManagedInstall()) {
      writeManualInstallCommands(io, null, "You can install the latest release manually:");
    }
    return 1;
  }
  const manifest = updateCheck.release;
  // Fleet Desktop owns this install tree, exactly as the Console update menu treats it: a global
  // install would land somewhere else and leave the running Console unchanged.
  if (isDesktopManagedInstall()) {
    io.stderr.write(hasDesktopGithubReleaseConsoleSource(process.env)
      ? `Fleet Desktop installs Console updates for this install. Apply v${manifest.version} from the Console update menu, or restart Fleet Desktop.\n`
      : `Fleet v${manifest.version} is available, but this Fleet Desktop cannot install it. Update Fleet Desktop first; it brings the new Console with it.\n`);
    return 1;
  }
  const updater = createFleetPackageUpdater(io, siblingCliPath);
  const { manager, reason } = await updater.detectPackageManager();
  if (manager === undefined) {
    writeManualInstallMessage(io, manifest, reason);
    return 0;
  }
  io.stdout.write(`Downloading Fleet v${manifest.version} from GitHub Releases...\n`);
  const releasesDir = consoleReleaseTarballDir(getFleetDataDir());
  const download = await downloadVerifiedConsoleTarball(manifest, { releasesDir });
  if (!download.ok) {
    io.stderr.write(download.reason === "checksum_mismatch"
      ? "The downloaded release did not match its published checksum, so nothing was installed.\n"
      : "The release could not be downloaded, so nothing was installed.\n");
    return 1;
  }
  io.stdout.write(`Updating Fleet with ${manager.command} (v${manifest.version})...\n`);
  await stopRunningConsoleBeforeUpdate(io, { siblingCliPath });
  const status = await installFleetPackages(manager, download.tarballPath, io, siblingCliPath);
  if (status === 0) {
    retainOnlyConsoleReleaseTarball(releasesDir, download.tarballPath);
  } else {
    removeFileBestEffort(download.tarballPath);
    io.stderr.write(`Fleet update did not complete. You can run this manually:\n${formatConsoleReleaseInstallCommands(manifest).filter((command) => command.startsWith(manager.command)).join("\n")}\n`);
  }
  return status;
}

function createFleetPackageUpdater(io: UpdateCommandIo, siblingCliPath?: string): GlobalPackageUpdater {
  return createGlobalPackageUpdater({
    packageNames: PACKAGE_NAMES,
    resolveCurrentPackageRoot: getCurrentPackageRoot,
    report: (message) => reportUpdaterMessage(io, message),
    resolveBinary: (command, env, options) => resolvePathBinary(command, env, options),
    execFile: (file, args) => execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
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

export function isDesktopManagedInstall(): boolean {
  const packageRoot = getCurrentPackageRoot();
  return packageRoot !== undefined && isManagedRuntimePackageRoot(packageRoot);
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
  tarballPath: string,
  io: UpdateCommandIo,
  siblingCliPath?: string,
): Promise<number> {
  return createFleetPackageUpdater(io, siblingCliPath).install(manager, tarballPath);
}

function removeFileBestEffort(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {}
}

function spawnInstallProcess(file: string, args: readonly string[], context: GlobalPackageSpawnContext, io: UpdateCommandIo): ReturnType<typeof spawn> {
  // fleet-allow-visible-spawn: foreground install shares the user's terminal and Ctrl+C; libuv ignores windowsHide with inherited stdio.
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

function writeManualInstallMessage(io: UpdateCommandIo, manifest: ConsoleReleaseManifest, reason: "local" | "permission" | undefined): void {
  if (reason === "permission") {
    io.stdout.write("Fleet's global install location is not writable, so no installer was run.\n");
  } else {
    io.stdout.write("Fleet could not detect its global npm or pnpm installation, so no installer was run.\n");
  }
  writeManualInstallCommands(io, manifest, "Run one of these commands manually:");
}

function writeManualInstallCommands(io: UpdateCommandIo, manifest: ConsoleReleaseManifest | null, header: string): void {
  io.stdout.write(`${header}\n`);
  for (const command of formatConsoleReleaseInstallCommands(manifest)) {
    io.stdout.write(`${command}\n`);
  }
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
