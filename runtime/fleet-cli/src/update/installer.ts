import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { readFleetCliRelease } from "../release.js";
import { resolveUpdateChannel, checkForUpdate } from "./check.js";
import type { UpdateCommandIo } from "./dispatcher.js";
import type { UpdateChannel } from "./registry.js";

interface PackageManagerInstall {
  readonly command: "npm" | "pnpm";
  readonly globalRoot: string;
}

interface GlobalInstallTarget {
  readonly channel: UpdateChannel;
  readonly latest: string | undefined;
  readonly manager: PackageManagerInstall | undefined;
  readonly reason: "local" | "permission" | undefined;
}

const PACKAGE_NAMES = ["@dotobokuri/fleet-cli", "@dotobokuri/fleet-wiki-ui"] as const;
const FLEET_CLI_PACKAGE_NAME = "@dotobokuri/fleet-cli";
const PACKAGE_JSON_CANDIDATES = ["../package.json", "../../package.json"] as const;

export async function runFleetUpdate(io: UpdateCommandIo): Promise<number> {
  const release = readFleetCliRelease();
  const target = await resolveGlobalInstallTarget(release.version);
  if (target.manager === undefined) {
    writeManualInstallMessage(io, target.channel, target.reason);
    return 0;
  }
  const versionOrChannel = target.latest ?? target.channel;
  io.stdout.write(`Updating Fleet packages with ${target.manager.command} (${versionOrChannel})...\n`);
  const status = await installFleetPackages(target.manager.command, versionOrChannel);
  if (status !== 0) {
    io.stderr.write(`Fleet update did not complete. You can run this manually:\n${formatInstallCommand(target.manager.command, target.channel)}\n`);
  }
  return status;
}

async function resolveGlobalInstallTarget(currentVersion: string): Promise<GlobalInstallTarget> {
  const channel = resolveUpdateChannel(currentVersion);
  const { manager, reason } = detectGlobalPackageManager();
  if (manager === undefined) {
    return { channel, latest: undefined, manager, reason };
  }
  const latest = await checkForUpdate(readFleetCliRelease()).catch(() => undefined);
  return { channel, latest, manager, reason };
}

function detectGlobalPackageManager(): { readonly manager: PackageManagerInstall | undefined; readonly reason: "local" | "permission" | undefined } {
  const packageRoot = getCurrentPackageRoot();
  if (packageRoot === undefined) {
    return { manager: undefined, reason: "local" };
  }
  const npm = detectGlobalRoot("npm", packageRoot);
  if (npm?.manager !== undefined || npm?.reason === "permission") {
    return npm;
  }
  const pnpm = detectGlobalRoot("pnpm", packageRoot);
  return pnpm ?? { manager: undefined, reason: "local" };
}

function detectGlobalRoot(command: "npm" | "pnpm", packageRoot: string): { readonly manager: PackageManagerInstall | undefined; readonly reason: "local" | "permission" | undefined } | undefined {
  try {
    const globalRoot = execFileSync(command, ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const resolvedRoot = normalizePath(realpathSync(path.resolve(globalRoot)));
    if (isPathInside(normalizePath(packageRoot), resolvedRoot)) {
      if (!canWrite(resolvedRoot)) {
        return { manager: undefined, reason: "permission" };
      }
      return { manager: { command, globalRoot: resolvedRoot }, reason: undefined };
    }
  } catch {
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

function installFleetPackages(command: "npm" | "pnpm", versionOrChannel: string): Promise<number> {
  const child = spawn(command, ["i", "-g", ...PACKAGE_NAMES.map((name) => `${name}@${versionOrChannel}`)], {
    stdio: "inherit",
  });
  return new Promise((resolve) => {
    child.on("error", () => resolve(1));
    child.on("exit", (code, signal) => {
      if (typeof code === "number") {
        resolve(code);
        return;
      }
      resolve(signal ? 1 : 0);
    });
  });
}

function writeManualInstallMessage(io: UpdateCommandIo, channel: UpdateChannel, reason: "local" | "permission" | undefined): void {
  if (reason === "permission") {
    io.stdout.write("Fleet's global install location is not writable, so no installer was run.\n");
  } else {
    io.stdout.write("Fleet was not recognized as a global npm or pnpm install, so no installer was run.\n");
  }
  io.stdout.write("Run one of these commands manually:\n");
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
