import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-links.js";
import { createDesktopEventStream, parseDesktopSseFrame, type DesktopEventStream } from "./desktop-event-stream.js";
import { readEntryPalette, type EntryPalette } from "./entry-page.js";

interface DesktopTitleBarOverlay {
  readonly color: string;
  readonly symbolColor: string;
  readonly height: number;
}

export interface DesktopThemeSnapshot {
  readonly theme: string;
  readonly titleBarOverlay: DesktopTitleBarOverlay;
  /** 진입 화면·종료 인사·창 바탕의 색. 이 필드를 싣지 않는 Console이거나 모양이 어긋나면 없다. */
  readonly entry?: EntryPalette;
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
    parseSnapshot: readDesktopThemeSnapshot,
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
  return parseDesktopSseFrame(frame, DESKTOP_THEME_EVENT, readDesktopThemeSnapshot);
}

/**
 * 받아들일 수 있는 필드만 골라 새로 만든다. 팔레트가 어긋나도 제목 표시줄 색은 살린다 — 둘은 따로 쓰인다.
 * 지난 실행에 기억해 둔 스냅샷도 같은 문을 지난다.
 */
export function readDesktopThemeSnapshot(value: unknown): DesktopThemeSnapshot | null {
  if (!isRecord(value) || !isDesktopThemeId(value.theme) || !isRecord(value.titleBarOverlay)) return null;
  const { color, symbolColor, height } = value.titleBarOverlay;
  if (!isElectronColor(color) || !isElectronColor(symbolColor) || !isTitleBarOverlayHeight(height)) return null;
  const entry = readEntryPalette(value.entry);
  return { theme: value.theme, titleBarOverlay: { color, symbolColor, height }, ...(entry ? { entry } : {}) };
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
