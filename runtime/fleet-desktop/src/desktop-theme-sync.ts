import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import { createDesktopEventStream, parseDesktopSseFrame, type DesktopEventStream } from "./desktop-event-stream.js";

interface DesktopTitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

interface DesktopThemeSnapshot {
  readonly theme: string;
  readonly titleBarOverlay: DesktopTitleBarOverlay;
}

const DESKTOP_THEME_PATH = "/api/v1/desktop/theme";
const DESKTOP_THEME_EVENTS_PATH = "/api/v1/desktop/theme/events";
const DESKTOP_THEME_EVENT = "desktop:theme";
const ELECTRON_COLOR_PATTERN = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;
const MIN_TITLE_BAR_OVERLAY_HEIGHT = 24;
const MAX_TITLE_BAR_OVERLAY_HEIGHT = 128;
const DESKTOP_THEME_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type DesktopThemeSynchronizer = DesktopEventStream;

export interface DesktopThemeSynchronizerDeps {
  readonly applyTheme: (snapshot: DesktopThemeSnapshot) => void;
  readonly fetch?: typeof fetch;
  readonly reconnectDelayMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export const MAX_DESKTOP_THEME_SSE_BUFFER_CHARS = 64 * 1024;

export function createDesktopThemeSynchronizer(deps: DesktopThemeSynchronizerDeps): DesktopThemeSynchronizer {
  return createDesktopEventStream<DesktopThemeSnapshot>({
    snapshotPath: DESKTOP_THEME_PATH,
    eventsPath: DESKTOP_THEME_EVENTS_PATH,
    eventName: DESKTOP_THEME_EVENT,
    parseSnapshot: (value) => (isDesktopThemeSnapshot(value) ? value : null),
    apply: deps.applyTheme,
    maxFrameChars: MAX_DESKTOP_THEME_SSE_BUFFER_CHARS,
    normalizeOrigin: normalizeConsoleOrigin,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.reconnectDelayMs !== undefined ? { reconnectDelayMs: deps.reconnectDelayMs } : {}),
    ...(deps.setTimeout ? { setTimeout: deps.setTimeout } : {}),
    ...(deps.clearTimeout ? { clearTimeout: deps.clearTimeout } : {}),
  });
}

export function parseDesktopThemeEvent(frame: string): DesktopThemeSnapshot | null {
  return parseDesktopSseFrame(frame, DESKTOP_THEME_EVENT, (value) => (isDesktopThemeSnapshot(value) ? value : null));
}

function isDesktopThemeSnapshot(value: unknown): value is DesktopThemeSnapshot {
  if (!isRecord(value) || !isDesktopThemeId(value.theme) || !isRecord(value.titleBarOverlay)) return false;
  return isElectronColor(value.titleBarOverlay.color)
    && isElectronColor(value.titleBarOverlay.symbolColor)
    && isTitleBarOverlayHeight(value.titleBarOverlay.height);
}

function isDesktopThemeId(value: unknown): value is string {
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

function normalizeConsoleOrigin(origin: string): string {
  return normalizeAnyConsoleOrigin(origin, "desktop_theme_origin_invalid");
}
