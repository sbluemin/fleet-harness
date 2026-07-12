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

export interface DesktopThemeSynchronizer {
  start(origin: string): Promise<void>;
  stop(): void;
}

export interface DesktopThemeSynchronizerDeps {
  readonly applyTheme: (snapshot: DesktopThemeSnapshot) => void;
  readonly fetch?: typeof fetch;
  readonly reconnectDelayMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

const INITIAL_LOAD_TIMEOUT_MS = 1_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_PROTOCOL_VIOLATION_RECONNECT_DELAY_MS = 30_000;
type SnapshotEndpointStatus = "supported" | "legacy" | "transient";

export const MAX_DESKTOP_THEME_SSE_BUFFER_CHARS = 64 * 1024;

class DesktopThemeSseProtocolError extends Error {}

export function createDesktopThemeSynchronizer(deps: DesktopThemeSynchronizerDeps): DesktopThemeSynchronizer {
  const fetchFor = deps.fetch ?? globalThis.fetch;
  const reconnectDelayMs = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const schedule = deps.setTimeout ?? globalThis.setTimeout;
  const cancelSchedule = deps.clearTimeout ?? globalThis.clearTimeout;
  let activeOrigin: string | null = null;
  let eventController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let protocolViolationCount = 0;

  const stop = (): void => {
    activeOrigin = null;
    eventController?.abort();
    eventController = null;
    if (reconnectTimer !== null) cancelSchedule(reconnectTimer);
    reconnectTimer = null;
    protocolViolationCount = 0;
  };

  const scheduleReconnect = (origin: string, delay: number): void => {
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect(origin);
    }, delay);
  };

  const connect = (origin: string): void => {
    if (activeOrigin !== origin) return;
    eventController?.abort();
    const controller = new AbortController();
    eventController = controller;
    void consumeThemeEvents(fetchFor, desktopThemeUrl(origin, DESKTOP_THEME_EVENTS_PATH), controller.signal, deps.applyTheme)
      .then(() => {
        if (activeOrigin !== origin || controller.signal.aborted) return;
        protocolViolationCount = 0;
        scheduleReconnect(origin, reconnectDelayMs);
      })
      .catch((error: unknown) => {
        if (activeOrigin !== origin || controller.signal.aborted) return;
        const delay = error instanceof DesktopThemeSseProtocolError
          ? Math.min(reconnectDelayMs * 2 ** Math.min(++protocolViolationCount, 5), MAX_PROTOCOL_VIOLATION_RECONNECT_DELAY_MS)
          : reconnectDelayMs;
        scheduleReconnect(origin, delay);
      });
  };

  return {
    async start(origin: string): Promise<void> {
      const normalizedOrigin = normalizeConsoleOrigin(origin);
      stop();
      activeOrigin = normalizedOrigin;
      const snapshotStatus = await loadInitialTheme(fetchFor, normalizedOrigin, deps.applyTheme);
      if (activeOrigin === normalizedOrigin && snapshotStatus !== "legacy") connect(normalizedOrigin);
    },
    stop,
  };
}

async function loadInitialTheme(fetchFor: typeof fetch, origin: string, applyTheme: (snapshot: DesktopThemeSnapshot) => void): Promise<SnapshotEndpointStatus> {
  try {
    const response = await fetchFor(desktopThemeUrl(origin, DESKTOP_THEME_PATH), {
      headers: { Accept: "application/json", Origin: origin },
      signal: AbortSignal.timeout(INITIAL_LOAD_TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 405) return "legacy";
    if (!response.ok) return "transient";
    const payload: unknown = await response.json();
    if (isDesktopThemeSnapshot(payload)) applyTheme(payload);
    return "supported";
  } catch {
    return "transient";
  }
}

async function consumeThemeEvents(
  fetchFor: typeof fetch,
  url: string,
  signal: AbortSignal,
  applyTheme: (snapshot: DesktopThemeSnapshot) => void,
): Promise<void> {
  const response = await fetchFor(url, { headers: { Accept: "text/event-stream", Origin: new URL(url).origin }, signal });
  if (!response.ok || !response.body) throw new Error("desktop_theme_stream_unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      buffered += decoder.decode(result.value, { stream: true });
      const frames = buffered.split(/\r?\n\r?\n/u);
      buffered = frames.pop() ?? "";
      if (buffered.length > MAX_DESKTOP_THEME_SSE_BUFFER_CHARS || frames.some((frame) => frame.length > MAX_DESKTOP_THEME_SSE_BUFFER_CHARS)) {
        await reader.cancel().catch(() => undefined);
        throw new DesktopThemeSseProtocolError("desktop_theme_sse_frame_too_large");
      }
      for (const frame of frames) {
        const snapshot = parseDesktopThemeEvent(frame);
        if (snapshot) applyTheme(snapshot);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function parseDesktopThemeEvent(frame: string): DesktopThemeSnapshot | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (event !== DESKTOP_THEME_EVENT || data.length === 0) return null;
  try {
    const payload: unknown = JSON.parse(data.join("\n"));
    return isDesktopThemeSnapshot(payload) ? payload : null;
  } catch {
    return null;
  }
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

function desktopThemeUrl(origin: string, pathname: string): string {
  return new URL(pathname, `${origin}/`).toString();
}

function normalizeConsoleOrigin(origin: string): string {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) throw new Error("desktop_theme_origin_invalid");
  return parsed.origin;
}
