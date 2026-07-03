import { fetchOperations } from "./api.js";
import { applyOperationUpdate, hydrateOperations } from "./store.js";
import type { OperationNode } from "./types.js";

const MAX_RECONNECT_DELAY_MS = 30_000;

let reconnectDelayMs = 1_000;
let reconnectHandle: ReturnType<typeof setTimeout> | null = null;

export function connectOperationsSse(): void {
  if (reconnectHandle !== null) clearTimeout(reconnectHandle);
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

  source.onopen = () => {
    reconnectDelayMs = 1_000;
  };

  source.onerror = () => {
    source.close();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
