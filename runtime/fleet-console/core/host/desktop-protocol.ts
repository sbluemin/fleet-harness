import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import {
  DESKTOP_DEVELOPMENT_ENV,
  DESKTOP_OWNER_ID_ENV,
  DESKTOP_OWNER_KIND_ENV,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION_ENV,
  DESKTOP_RESOURCE_ROOT_ENV,
  DESKTOP_RESOURCE_ROOT_MARKER,
  isDesktopDevelopmentEnvironment as isDesktopDevelopmentEnvironmentFor,
  isDesktopResourceRootMarkerValid,
} from "@fleet-console/desktop-protocol";
import type { DesktopProtocolEnvironment } from "@fleet-console/desktop-protocol";

export {
  DESKTOP_DEVELOPMENT_ENV,
  DESKTOP_OWNER_ID_ENV,
  DESKTOP_OWNER_KIND_ENV,
  DESKTOP_PROTOCOL_VERSION,
  DESKTOP_PROTOCOL_VERSION_ENV,
  DESKTOP_RESOURCE_ROOT_ENV,
  DESKTOP_RESOURCE_ROOT_MARKER,
  isCompatibleDesktopOwner,
  resolveCanonicalLocalConsolePaths,
  resolveCanonicalStableConsolePaths,
} from "@fleet-console/desktop-protocol";
export type {
  CanonicalConsolePaths,
  ConsoleOwnerKind,
  ConsoleOwnerMetadata,
  DesktopProtocolEnvironment,
  ResolveCanonicalConsolePathsInput,
  ResolveCanonicalLocalConsolePathsInput,
} from "@fleet-console/desktop-protocol";

export interface DesktopProtocolValidationDeps {
  readonly expectedPackageRoot?: string;
}

export function readDesktopProtocolEnvironment(env: NodeJS.ProcessEnv = process.env, deps: DesktopProtocolValidationDeps = {}): DesktopProtocolEnvironment | null {
  const resourceRoot = env[DESKTOP_RESOURCE_ROOT_ENV];
  const ownerId = env[DESKTOP_OWNER_ID_ENV];
  const ownerKind = env[DESKTOP_OWNER_KIND_ENV];
  const protocolVersion = env[DESKTOP_PROTOCOL_VERSION_ENV];
  const values = [resourceRoot, ownerId, ownerKind, protocolVersion];
  if (values.every((value) => value === undefined)) return null;
  if (values.some((value) => !value)) throw new Error("desktop_protocol_environment_incomplete");
  if (ownerKind !== "desktop") throw new Error("desktop_owner_kind_invalid");
  if (!isSafeOwnerId(ownerId!)) throw new Error("desktop_owner_id_invalid");
  if (protocolVersion !== String(DESKTOP_PROTOCOL_VERSION)) throw new Error("desktop_protocol_version_unsupported");
  const resolvedRoot = isDesktopDevelopmentEnvironment(env)
    ? validateDesktopDevelopmentResourceRoot(resourceRoot!)
    : validateDesktopResourceRoot(resourceRoot!, deps.expectedPackageRoot);
  return { owner: { kind: "desktop", id: ownerId!, protocolVersion: DESKTOP_PROTOCOL_VERSION }, resourceRoot: resolvedRoot };
}

export function isDesktopDevelopmentEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDesktopDevelopmentEnvironmentFor(env);
}

export function validateDesktopResourceRoot(root: string, expectedPackageRoot = resolveDesktopProtocolPackageRoot()): string {
  if (!path.isAbsolute(root)) throw new Error("desktop_resource_root_not_absolute");
  const resolvedRoot = fs.realpathSync(root);
  const expectedRoot = fs.realpathSync(expectedPackageRoot);
  if (resolvedRoot !== expectedRoot) throw new Error("desktop_resource_root_invalid");
  const markerPath = path.join(resolvedRoot, DESKTOP_RESOURCE_ROOT_MARKER);
  const marker = fs.readFileSync(markerPath, "utf8");
  if (!isDesktopResourceRootMarkerValid(marker)) throw new Error("desktop_resource_root_marker_invalid");
  return resolvedRoot;
}

export function validateDesktopDevelopmentResourceRoot(root: string): string {
  if (!path.isAbsolute(root)) throw new Error("desktop_resource_root_not_absolute");
  let resolvedRoot: string;
  try {
    resolvedRoot = fs.realpathSync(root);
  } catch {
    throw new Error("desktop_development_resource_root_invalid");
  }
  const expectedRoot = fs.realpathSync(resolveDesktopProtocolPackageRoot());
  if (resolvedRoot !== expectedRoot) throw new Error("desktop_development_resource_root_invalid");
  return resolvedRoot;
}

function resolveDesktopProtocolPackageRoot(): string {
  const requireFromHere = createRequire(import.meta.url);
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      return path.dirname(requireFromHere.resolve(candidate));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
    }
  }
  throw new Error("fleet_console_package_json_not_found");
}

function isSafeOwnerId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9._-]+$/.test(value);
}
