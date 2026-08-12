import { fetchObserverStatus, fetchOperations } from "./api.js";
import { CONTROL_RECLAIMED_EVENT, type SessionEndedDetail, type SessionEndedReason } from "./control-session.js";
import { applyDesktopFullscreenSnapshot, resetDesktopFullscreenSnapshot } from "./desktop-fullscreen.js";
import { applyControlHolder, applyObserverStatus, applyOperationUpdate, getState, hydrateOperations, setConnectionState } from "./store.js";
import type { ControlHolder, OperationNode } from "./types.js";

const MAX_RECONNECT_DELAY_MS = 30_000;
const CONTROL_RECLAIM_NAVIGATION_DELAY_MS = 2_500;

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

  source.addEventListener("control:changed", (e) => {
    if (!isCurrentSource()) return;
    const msg = e as MessageEvent<string>;
    try {
      const data = JSON.parse(msg.data) as { readonly holder?: unknown };
      if (isControlHolderSnapshot(data)) applyControlHolder(data.holder);
    } catch {
      // ignore malformed SSE event
    }
  });

  source.addEventListener("control:reclaimed", (e) => {
    if (!isCurrentSource()) return;
    const msg = e as MessageEvent<string>;
    try {
      const data = JSON.parse(msg.data) as { readonly reason?: unknown };
      if (!isSessionEnded(data)) return;
      // 사유를 실어 보낸다 — 안내 문구는 "주인이 되찾았다"와 "다른 기기가 이어받았다"로 갈린다.
      window.dispatchEvent(new CustomEvent<SessionEndedDetail>(CONTROL_RECLAIMED_EVENT, { detail: { reason: data.reason } }));
      window.setTimeout(() => location.reload(), CONTROL_RECLAIM_NAVIGATION_DELAY_MS);
    } catch {
      // ignore malformed SSE event
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
    // SSE 단절은 원격 제어 세션이 끝났다는 증거가 아니므로 holder는 마지막 권위 스냅샷을 유지한다.
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

function isControlHolderSnapshot(value: unknown): value is { readonly holder: ControlHolder | null } {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("holder" in value)) return false;
  if (value.holder === null) return true;
  if (!isRecord(value.holder) || Object.keys(value.holder).length !== 3) return false;
  return typeof value.holder.handle === "string"
    && (value.holder.device === null || typeof value.holder.device === "string")
    && typeof value.holder.openedAt === "number"
    && Number.isFinite(value.holder.openedAt);
}

function isSessionEnded(value: unknown): value is { readonly reason: SessionEndedReason } {
  return isRecord(value) && Object.keys(value).length === 1 && (value.reason === "reclaimed" || value.reason === "superseded");
}
