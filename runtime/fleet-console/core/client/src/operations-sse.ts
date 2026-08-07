import { fetchObserverStatus, fetchOperations } from "./api.js";
import { applyDesktopFullscreenSnapshot, resetDesktopFullscreenSnapshot } from "./desktop-fullscreen.js";
import { applyObserverStatus, applyOperationUpdate, getState, hydrateOperations, setConnectionState } from "./store.js";
import type { OperationNode } from "./types.js";

const MAX_RECONNECT_DELAY_MS = 30_000;

// 누락 스냅샷은 SSE가 열리기 전에만 hydrate해 이후 실시간 프레임을 덮어쓰지 않는다.
let reconnectDelayMs = 1_000;
let reconnectHandle: ReturnType<typeof setTimeout> | null = null;
let activeSource: EventSource | null = null;
let connectionGeneration = 0;
let statusRefreshInFlight: Promise<void> | null = null;
let statusRefreshPending = false;

export function connectOperationsSse(): void {
  if (reconnectHandle !== null) {
    clearTimeout(reconnectHandle);
    reconnectHandle = null;
  }
  activeSource?.close();
  const generation = ++connectionGeneration;
  const source = new EventSource("/api/v1/operations/events");
  activeSource = source;
  const isCurrentSource = () => generation === connectionGeneration && activeSource === source;

  source.addEventListener("operation:changed", (e) => {
    if (!isCurrentSource()) return;
    const msg = e as MessageEvent<string>;
    try {
      const data = JSON.parse(msg.data) as { readonly operation?: unknown };
      if (isRecord(data.operation)) applyOperationUpdate(data.operation as unknown as OperationNode);
    } catch {
      // ignore malformed SSE event
    }
  });

  source.addEventListener("update:available", () => {
    if (!isCurrentSource()) return;
    refreshObserverStatus();
  });

  source.addEventListener("desktop:fullscreen", (e) => {
    if (!isCurrentSource()) return;
    const msg = e as MessageEvent<string>;
    try {
      applyDesktopFullscreenSnapshot(JSON.parse(msg.data));
    } catch {
      resetDesktopFullscreenSnapshot();
    }
  });

  source.onopen = () => {
    if (!isCurrentSource()) return;
    reconnectDelayMs = 1_000;
    setConnectionState("live");
    refreshObserverStatus();
  };

  source.onerror = () => {
    if (!isCurrentSource()) return;
    source.close();
    activeSource = null;
    const retryGeneration = ++connectionGeneration;
    resetDesktopFullscreenSnapshot();
    setConnectionState("offline");
    reconnectHandle = setTimeout(() => {
      reconnectHandle = null;
      if (retryGeneration !== connectionGeneration) return;
      setConnectionState("connecting");
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      void fetchOperations()
        .then((operations) => {
          if (retryGeneration === connectionGeneration) hydrateOperations(operations);
        })
        .catch(() => undefined)
        .finally(() => {
          if (retryGeneration === connectionGeneration) connectOperationsSse();
        });
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
  activeSource?.close();
  activeSource = null;
  const reconnectGeneration = ++connectionGeneration;
  void fetchOperations()
    .then((operations) => {
      if (reconnectGeneration === connectionGeneration) hydrateOperations(operations);
    })
    .catch(() => undefined)
    .finally(() => {
      if (reconnectGeneration === connectionGeneration) connectOperationsSse();
    });
}

export function refreshObserverStatus(): void {
  if (statusRefreshInFlight) {
    statusRefreshPending = true;
    return;
  }
  const generation = connectionGeneration;
  statusRefreshInFlight = fetchObserverStatus(getState().activeTheaterId)
    .then((status) => {
      if (generation === connectionGeneration) applyObserverStatus(status);
    })
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
