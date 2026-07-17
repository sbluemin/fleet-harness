import { fetchObserverStatus, fetchOperations } from "./api.js";
import { applyDesktopFullscreenSnapshot, resetDesktopFullscreenSnapshot } from "./desktop-fullscreen.js";
import { applyObserverStatus, applyOperationUpdate, getState, hydrateOperations } from "./store.js";
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
    refreshObserverStatus();
  };

  source.onerror = () => {
    source.close();
    resetDesktopFullscreenSnapshot();
    reconnectHandle = setTimeout(() => {
      reconnectHandle = null;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      void fetchOperations()
        .then(hydrateOperations)
        .catch(() => undefined)
        .finally(connectOperationsSse);
    }, reconnectDelayMs);
  };
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
