import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export type ConsoleOwnerKind = "cli" | "desktop";

export interface ConsoleOwnerMetadata {
  readonly kind: ConsoleOwnerKind;
  readonly id: string;
  readonly protocolVersion: number;
}

export interface DesktopProtocolEnvironment {
  readonly owner: ConsoleOwnerMetadata;
  readonly resourceRoot: string;
}

export interface CanonicalConsolePaths {
  readonly dir: string;
  readonly lockFile: string;
  readonly dataDir: string;
  readonly stateFile: string;
  readonly settingsFile: string;
  readonly capturesDir: string;
}

export interface ResolveCanonicalConsolePathsInput {
  readonly tmpDir: string;
  readonly uid: number;
  readonly fleetDataDir: string;
  readonly consoleDirOverride?: string;
}

export interface ResolveCanonicalLocalConsolePathsInput {
  readonly packageRoot: string;
}

export interface DesktopProtocolValidationDeps {
  readonly expectedPackageRoot?: string;
}

export const DESKTOP_PROTOCOL_VERSION = 1;
export const DESKTOP_RESOURCE_ROOT_ENV = "FLEET_CONSOLE_RESOURCE_ROOT";
export const DESKTOP_OWNER_ID_ENV = "FLEET_CONSOLE_OWNER_ID";
export const DESKTOP_OWNER_KIND_ENV = "FLEET_CONSOLE_OWNER_KIND";
export const DESKTOP_PROTOCOL_VERSION_ENV = "FLEET_CONSOLE_PROTOCOL_VERSION";
export const DESKTOP_RESOURCE_ROOT_MARKER = ".fleet-console-resource-root";
export const DESKTOP_DEVELOPMENT_ENV = "FLEET_CONSOLE_DESKTOP_DEVELOPMENT";
const LOCK_DIR_NAME = "fleet-console";
const LOCK_FILE_NAME = "console.lock";
const CONSOLE_DATA_DIR_NAME = "console";
const CONSOLE_STATE_FILE_NAME = "state.json";
const CONSOLE_SETTINGS_FILE_NAME = "settings.json";
const CONSOLE_CAPTURES_DIR_NAME = "captures";

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
  return env[DESKTOP_DEVELOPMENT_ENV] === "1";
}

export function isCompatibleDesktopOwner(owner: ConsoleOwnerMetadata | undefined, version: string, expected: { readonly id: string; readonly version: string }): boolean {
  return owner?.kind === "desktop"
    && owner.id === expected.id
    && owner.protocolVersion === DESKTOP_PROTOCOL_VERSION
    && version === expected.version;
}

// Published CLI/browser and desktop share this resolver. Inputs are supplied by each host so
// this leaf has no dependency on Console runtime internals, Electron, or process-global state.
export function resolveCanonicalStableConsolePaths(input: ResolveCanonicalConsolePathsInput): CanonicalConsolePaths {
  const dir = input.consoleDirOverride ?? path.join(input.tmpDir, `${LOCK_DIR_NAME}-${input.uid}-stable`);
  const dataDir = input.consoleDirOverride ?? path.join(input.fleetDataDir, CONSOLE_DATA_DIR_NAME);
  return {
    dir,
    lockFile: path.join(dir, LOCK_FILE_NAME),
    dataDir,
    stateFile: path.join(dataDir, CONSOLE_STATE_FILE_NAME),
    settingsFile: path.join(dataDir, CONSOLE_SETTINGS_FILE_NAME),
    capturesDir: path.join(dataDir, CONSOLE_CAPTURES_DIR_NAME),
  };
}

export function resolveCanonicalLocalConsolePaths(input: ResolveCanonicalLocalConsolePathsInput): CanonicalConsolePaths {
  const dir = path.join(path.resolve(input.packageRoot, "..", ".."), ".fleet", CONSOLE_DATA_DIR_NAME);
  return {
    dir,
    lockFile: path.join(dir, LOCK_FILE_NAME),
    dataDir: dir,
    stateFile: path.join(dir, CONSOLE_STATE_FILE_NAME),
    settingsFile: path.join(dir, CONSOLE_SETTINGS_FILE_NAME),
    capturesDir: path.join(dir, CONSOLE_CAPTURES_DIR_NAME),
  };
}

export function validateDesktopResourceRoot(root: string, expectedPackageRoot = resolveDesktopProtocolPackageRoot()): string {
  if (!path.isAbsolute(root)) throw new Error("desktop_resource_root_not_absolute");
  const resolvedRoot = fs.realpathSync(root);
  const expectedRoot = fs.realpathSync(expectedPackageRoot);
  if (resolvedRoot !== expectedRoot) throw new Error("desktop_resource_root_invalid");
  const markerPath = path.join(resolvedRoot, DESKTOP_RESOURCE_ROOT_MARKER);
  const marker = fs.readFileSync(markerPath, "utf8").trim();
  if (marker !== String(DESKTOP_PROTOCOL_VERSION)) throw new Error("desktop_resource_root_marker_invalid");
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
