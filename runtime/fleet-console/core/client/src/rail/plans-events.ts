const PLANS_CHANGED_EVENT = "plans-changed";
const PLANS_RECONNECT_DELAY_MS = 30_000;

/** Connects a Theater-scoped, payload-free invalidation channel. */
export function subscribeToPlanChanges(theaterId: string, onInvalidate: () => void): () => void {
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribed = false;
  let initialAttempt = true;

  const connect = () => {
    // 게이트 기준은 "최초 open"이 아니라 "최초 소스의 첫 open"이다 — 최초 연결이 404로
    // open 없이 실패한 뒤의 재연결 open을 최초 open으로 오인하면 안 된다.
    const isInitialSource = initialAttempt;
    initialAttempt = false;
    let opens = 0;
    source = new EventSource(`/api/v1/plans/events?theaterId=${encodeURIComponent(theaterId)}`);
    source.addEventListener(PLANS_CHANGED_EVENT, () => {
      // The event is only an invalidation signal. Do not trust or parse its payload.
      onInvalidate();
    });
    // 최초 소스의 첫 open은 mount fetch와 중복이라 건너뛴다. 그 외의 open은 전부 재연결이며
    // (native retry든 30초 백오프 재생성이든) 스트림 부재 동안 놓친 변경 — 예: 첫 plans
    // 디렉터리 생성 — 을 refetch 한 번으로 복구한다.
    source.onopen = () => {
      opens += 1;
      if (!(isInitialSource && opens === 1)) onInvalidate();
    };
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
