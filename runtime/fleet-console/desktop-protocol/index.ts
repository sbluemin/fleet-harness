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

export type ConsoleThemeId = "instrument" | "maritime" | "carbon";
export type DesktopThemeId = string;

export interface DesktopTitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

export interface DesktopThemeSnapshot {
  readonly theme: DesktopThemeId;
  readonly titleBarOverlay: DesktopTitleBarOverlay;
}

export const DESKTOP_PROTOCOL_VERSION = 1;
export const DESKTOP_RESOURCE_ROOT_ENV = "FLEET_CONSOLE_RESOURCE_ROOT";
export const DESKTOP_OWNER_ID_ENV = "FLEET_CONSOLE_OWNER_ID";
export const DESKTOP_OWNER_KIND_ENV = "FLEET_CONSOLE_OWNER_KIND";
export const DESKTOP_PROTOCOL_VERSION_ENV = "FLEET_CONSOLE_PROTOCOL_VERSION";
export const DESKTOP_RESOURCE_ROOT_MARKER = ".fleet-console-resource-root";
export const DESKTOP_DEVELOPMENT_ENV = "FLEET_CONSOLE_DESKTOP_DEVELOPMENT";
export const DESKTOP_THEME_PATH = "/api/v1/desktop/theme";
export const DESKTOP_THEME_EVENTS_PATH = "/api/v1/desktop/theme/events";
export const DESKTOP_THEME_EVENT = "desktop:theme";

const LOCK_DIR_NAME = "fleet-console";
const LOCK_FILE_NAME = "console.lock";
const CONSOLE_DATA_DIR_NAME = "console";
const CONSOLE_STATE_FILE_NAME = "state.json";
const CONSOLE_SETTINGS_FILE_NAME = "settings.json";
const CONSOLE_CAPTURES_DIR_NAME = "captures";
const ELECTRON_COLOR_PATTERN = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const MIN_TITLE_BAR_OVERLAY_HEIGHT = 24;
const MAX_TITLE_BAR_OVERLAY_HEIGHT = 128;
const DESKTOP_THEME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isDesktopDevelopmentEnvironment(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[DESKTOP_DEVELOPMENT_ENV] === "1";
}

export function isCompatibleDesktopOwner(owner: ConsoleOwnerMetadata | undefined, version: string, expected: { readonly id: string; readonly version: string }): boolean {
  return owner?.kind === "desktop"
    && owner.id === expected.id
    && owner.protocolVersion === DESKTOP_PROTOCOL_VERSION
    && version === expected.version;
}

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

export function formatDesktopResourceRootMarker(): string {
  return `${DESKTOP_PROTOCOL_VERSION}\n`;
}

export function isDesktopResourceRootMarkerValid(content: string): boolean {
  return content.trim() === String(DESKTOP_PROTOCOL_VERSION);
}

export function isDesktopThemeSnapshot(value: unknown): value is DesktopThemeSnapshot {
  if (!isRecord(value) || !isDesktopThemeId(value.theme) || !isRecord(value.titleBarOverlay)) return false;
  return isElectronColor(value.titleBarOverlay.color)
    && isElectronColor(value.titleBarOverlay.symbolColor)
    && isTitleBarOverlayHeight(value.titleBarOverlay.height);
}

function isDesktopThemeId(value: unknown): value is DesktopThemeId {
  return typeof value === "string" && DESKTOP_THEME_ID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isElectronColor(value: unknown): value is string {
  return typeof value === "string" && ELECTRON_COLOR_PATTERN.test(value);
}

function isTitleBarOverlayHeight(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= MIN_TITLE_BAR_OVERLAY_HEIGHT
    && value <= MAX_TITLE_BAR_OVERLAY_HEIGHT;
}
