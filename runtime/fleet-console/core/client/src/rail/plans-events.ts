const PLANS_CHANGED_EVENT = "plans-changed";

/** Connects a Theater-scoped, payload-free invalidation channel. */
export function subscribeToPlanChanges(theaterId: string, onInvalidate: () => void): () => void {
  const source = new EventSource(`/api/v1/plans/events?theaterId=${encodeURIComponent(theaterId)}`);
  source.addEventListener(PLANS_CHANGED_EVENT, () => {
    // The event is only an invalidation signal. Do not trust or parse its payload.
    onInvalidate();
  });
  // Native EventSource reconnects when appropriate; 404 and network failures leave
  // the existing manual refresh path available without changing panel state.
  source.onerror = () => undefined;
  return () => source.close();
}
