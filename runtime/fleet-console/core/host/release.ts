import { createRequire } from "node:module";
import path from "node:path";

import { readDesktopProtocolEnvironment } from "./desktop-protocol.js";

export type FleetConsoleChannel = "stable" | "local";

export interface FleetConsoleRelease {
  readonly channel: FleetConsoleChannel;
  readonly version: string;
  readonly packageRoot: string;
}

export function readFleetConsoleRelease(env: NodeJS.ProcessEnv = process.env): FleetConsoleRelease {
  const desktop = readDesktopProtocolEnvironment(env);
  // Supervision metadata selects the actual package root but never a Console feature mode.
  if (desktop) return readReleaseAt(desktop.resourceRoot, readPackageChannel(desktop.resourceRoot));
  const requireFromHere = createRequire(import.meta.url);
  const packageJsonPath = resolvePackageJsonPath(requireFromHere);
  const packageRoot = path.dirname(packageJsonPath);
  return readReleaseAt(packageRoot, readPackageChannel(packageRoot, requireFromHere), requireFromHere);
}

function readPackageChannel(packageRoot: string, requireFromHere = createRequire(import.meta.url)): FleetConsoleChannel {
  const pkg = requireFromHere(path.join(packageRoot, "package.json")) as { private?: boolean };
  return pkg.private === true ? "local" : "stable";
}

function readReleaseAt(packageRoot: string, channel: FleetConsoleChannel, requireFromHere = createRequire(import.meta.url)): FleetConsoleRelease {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const pkg = requireFromHere(packageJsonPath) as { version?: string };
  return { channel, version: pkg.version ?? "", packageRoot };
}

function resolvePackageJsonPath(requireFromHere: NodeJS.Require): string {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      return requireFromHere.resolve(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("fleet_console_package_json_not_found");
}
