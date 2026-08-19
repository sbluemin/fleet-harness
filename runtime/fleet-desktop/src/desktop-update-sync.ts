import { normalizeConsoleOrigin as normalizeAnyConsoleOrigin } from "./console-origin.js";
import { createDesktopEventStream, parseDesktopSseFrame, type DesktopEventStream } from "./desktop-event-stream.js";

/**
 * 이 설치 트리는 셸의 강화된 진입-흐름 트랜잭션이 만들었고, 그래서 콘솔이 자기 자신을
 * 제자리에서 갈아 끼울 수 없다. 사용자가 콘솔 안에서 업데이트를 눌렀을 때 그 요청이
 * 사라지지 않으려면, 수행자인 셸이 그 사실을 들어야 한다 — 이 구독이 그 귀다.
 *
 * 요청은 표(requestId)로 구분한다. 재연결하면 콘솔은 걸려 있던 요청을 다시 들려주는데,
 * 그 반복을 두 번의 재시작으로 받아들이면 사용자는 앱이 저 혼자 재시작하는 것을 본다.
 */
interface DesktopUpdateRequestSnapshot {
  readonly requestedVersion: string | null;
  readonly requestId: string | null;
}

const DESKTOP_UPDATE_PATH = "/api/v1/desktop/update";
const DESKTOP_UPDATE_EVENTS_PATH = "/api/v1/desktop/update/events";
const DESKTOP_UPDATE_EVENT = "desktop:update";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;

export type DesktopUpdateSynchronizer = DesktopEventStream;

export interface DesktopUpdateSynchronizerDeps {
  /** 셸이 실제로 업데이트를 수행한다. 같은 요청으로 두 번 불리지 않는다. */
  readonly applyUpdate: (version: string) => void;
  readonly fetch?: typeof fetch;
  readonly reconnectDelayMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export const MAX_DESKTOP_UPDATE_SSE_BUFFER_CHARS = 8 * 1024;

export function createDesktopUpdateSynchronizer(deps: DesktopUpdateSynchronizerDeps): DesktopUpdateSynchronizer {
  const handledRequestIds = new Set<string>();
  return createDesktopEventStream<DesktopUpdateRequestSnapshot>({
    snapshotPath: DESKTOP_UPDATE_PATH,
    eventsPath: DESKTOP_UPDATE_EVENTS_PATH,
    eventName: DESKTOP_UPDATE_EVENT,
    parseSnapshot: parseDesktopUpdateRequest,
    apply: (snapshot) => {
      if (snapshot.requestId === null || snapshot.requestedVersion === null) return;
      if (handledRequestIds.has(snapshot.requestId)) return;
      handledRequestIds.add(snapshot.requestId);
      deps.applyUpdate(snapshot.requestedVersion);
    },
    maxFrameChars: MAX_DESKTOP_UPDATE_SSE_BUFFER_CHARS,
    normalizeOrigin: (origin) => normalizeAnyConsoleOrigin(origin, "desktop_update_origin_invalid"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.reconnectDelayMs !== undefined ? { reconnectDelayMs: deps.reconnectDelayMs } : {}),
    ...(deps.setTimeout ? { setTimeout: deps.setTimeout } : {}),
    ...(deps.clearTimeout ? { clearTimeout: deps.clearTimeout } : {}),
  });
}

export function parseDesktopUpdateEvent(frame: string): DesktopUpdateRequestSnapshot | null {
  return parseDesktopSseFrame(frame, DESKTOP_UPDATE_EVENT, parseDesktopUpdateRequest);
}

export function parseDesktopUpdateRequest(value: unknown): DesktopUpdateRequestSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const { requestId, requestedVersion } = entry;
  if (requestId === null && requestedVersion === null) return { requestId: null, requestedVersion: null };
  if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return null;
  if (typeof requestedVersion !== "string" || !VERSION_PATTERN.test(requestedVersion)) return null;
  return { requestId, requestedVersion };
}
