import { fetchObserverStatus, fetchOperations } from "./api.js";
import { applyDesktopFullscreenSnapshot, resetDesktopFullscreenSnapshot } from "./desktop-fullscreen.js";
import { applyObserverStatus, applyOperationUpdate, getState, hydrateOperations, setConnectionState } from "./store.js";
import type { OperationNode } from "./types.js";

const MAX_RECONNECT_DELAY_MS = 30_000;

let reconnectDelayMs = 1_000;
let reconnectHandle: ReturnType<typeof setTimeout> | null = null;
let statusRefreshInFlight: Promise<void> | null = null;
let statusRefreshPending = false;

export function connectOperationsSse(): void {
  if (reconnectHandle !== null) {
    clearTimeout(reconnectHandle);
    reconnectHandle = null;
  }
  const source = new EventSource("/api/v1/operations/events");

  source.addEventListener("operation:changed", (e) => {
    const msg = e as MessageEvent<string>;
    try {
      const data = JSON.parse(msg.data) as { readonly operation?: unknown };
      if (isRecord(data.operation)) applyOperationUpdate(data.operation as unknown as OperationNode);
    } catch {
      // ignore malformed SSE event
    }
  });

  source.addEventListener("update:available", () => {
    refreshObserverStatus();
  });

  source.addEventListener("desktop:fullscreen", (e) => {
    const msg = e as MessageEvent<string>;
    try {
      applyDesktopFullscreenSnapshot(JSON.parse(msg.data));
    } catch {
      resetDesktopFullscreenSnapshot();
    }
  });

  source.onopen = () => {
    reconnectDelayMs = 1_000;
    setConnectionState("live");
    refreshObserverStatus();
  };

  source.onerror = () => {
    source.close();
    resetDesktopFullscreenSnapshot();
    setConnectionState("offline");
    reconnectHandle = setTimeout(() => {
      reconnectHandle = null;
      setConnectionState("connecting");
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      void fetchOperations()
        .then(hydrateOperations)
        .catch(() => undefined)
        .finally(connectOperationsSse);
    }, reconnectDelayMs);
  };
}

export function reconnectOperationsSseNow(): void {
  if (reconnectHandle !== null) {
    clearTimeout(reconnectHandle);
    reconnectHandle = null;
  }
  reconnectDelayMs = 1_000;
  // 수동 재연결도 "다시 연결하는 중"으로 전이시킨다 — 상태를 offline에 둔 채 재접속하면
  // 서버가 여전히 죽어 있을 때 버튼을 눌러도 화면이 그대로여서 눌린 것인지 알 수 없다.
  setConnectionState("connecting");
  connectOperationsSse();
}

export function refreshObserverStatus(): void {
  if (statusRefreshInFlight) {
    statusRefreshPending = true;
    return;
  }
  statusRefreshInFlight = fetchObserverStatus(getState().activeTheaterId)
    .then(applyObserverStatus)
    .catch(() => undefined)
    .finally(() => {
      statusRefreshInFlight = null;
      if (!statusRefreshPending) return;
      statusRefreshPending = false;
      refreshObserverStatus();
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
