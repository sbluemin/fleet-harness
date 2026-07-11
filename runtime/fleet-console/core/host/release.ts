import { createRequire } from "node:module";
import path from "node:path";

import { isDesktopDevelopmentEnvironment, readDesktopProtocolEnvironment } from "./desktop-protocol.js";

export type FleetConsoleChannel = "stable" | "local" | "desktop";

export interface FleetConsoleRelease {
  readonly channel: FleetConsoleChannel;
  readonly version: string;
  readonly packageRoot: string;
}

export function readFleetConsoleRelease(env: NodeJS.ProcessEnv = process.env): FleetConsoleRelease {
  const desktop = readDesktopProtocolEnvironment(env);
  if (desktop) return readReleaseAt(desktop.resourceRoot, isDesktopDevelopmentEnvironment(env) ? "local" : "desktop");
  const requireFromHere = createRequire(import.meta.url);
  const packageJsonPath = resolvePackageJsonPath(requireFromHere);
  const packageRoot = path.dirname(packageJsonPath);
  const pkg = requireFromHere(packageJsonPath) as { private?: boolean };
  // 미게시 워크스페이스 빌드는 package.json의 private:true로 식별해 local 채널로 분류한다.
  // publish 스크립트가 게시 시 private를 제거하므로 게시본은 stable이 된다(fleet-cli release.ts와 대칭).
  if (pkg.private === true) {
    return readReleaseAt(packageRoot, "local", requireFromHere);
  }
  return readReleaseAt(packageRoot, "stable", requireFromHere);
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
