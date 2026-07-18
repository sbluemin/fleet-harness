const PLANS_CHANGED_EVENT = "plans-changed";
const PLANS_RECONNECT_DELAY_MS = 30_000;

/** Connects a Theater-scoped, payload-free invalidation channel. */
export function subscribeToPlanChanges(theaterId: string, onInvalidate: () => void): () => void {
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribed = false;

  const connect = () => {
    source = new EventSource(`/api/v1/plans/events?theaterId=${encodeURIComponent(theaterId)}`);
    source.addEventListener(PLANS_CHANGED_EVENT, () => {
      // The event is only an invalidation signal. Do not trust or parse its payload.
      onInvalidate();
    });
    source.onerror = () => {
      if (source?.readyState !== EventSource.CLOSED || reconnectTimer !== null) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!unsubscribed) connect();
      }, PLANS_RECONNECT_DELAY_MS);
    };
  };

  connect();
  return () => {
    unsubscribed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    source?.close();
  };
}
