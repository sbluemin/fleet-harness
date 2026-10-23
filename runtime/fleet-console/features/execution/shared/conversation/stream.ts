/** 화면용 델타의 적용 시점은 모든 채팅이 공유한다. 저장 원장과 확정 사건의 순서는 바꾸지 않는다. */
export interface ConversationStream<E> {
  readonly push: (event: E) => void;
  readonly flush: () => void;
  /** 마지막 흐름까지 적용하고 예약·visibility 구독을 걷는다. 이후 사건은 받지 않는다. */
  readonly dispose: () => void;
}

const MAX_PENDING_TEXT = 60_000;
const MAX_PENDING_EVENTS = 256;

/** 인접한 같은 흐름의 글자만 합친다. 확정 경계는 대기 글자와 한 번에 적용해 정정 앵커 뒤로 델타가 새지 않는다. */
export function createConversationStream<E>(options: {
  readonly apply: (events: readonly E[]) => void;
  readonly delta: (event: E) => { readonly key: string; readonly text: string } | null;
  readonly withText: (event: E, text: string) => E;
}): ConversationStream<E> {
  let pending: E[] = [];
  let frame: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const cancel = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    frame = undefined;
    timer = undefined;
  };
  const flush = () => {
    cancel();
    const events = pending;
    pending = [];
    if (events.length) options.apply(events);
  };
  // 숨은 탭에서도 확정 줄을 기다리며 무한히 쌓지 않는다. 복귀 시에는 타이머 지연도 기다리지 않는다.
  const visibility = () => { if (document.visibilityState === "visible") flush(); };
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibility);
  return {
    push(event) {
      if (disposed) return;
      const delta = options.delta(event);
      if (!delta) { pending.push(event); flush(); return; }
      const last = pending.at(-1);
      const previous = last === undefined ? null : options.delta(last);
      if (last !== undefined && previous?.key === delta.key) pending[pending.length - 1] = options.withText(last, (previous.text + delta.text).slice(0, MAX_PENDING_TEXT));
      else pending.push(options.withText(event, delta.text.slice(0, MAX_PENDING_TEXT)));
      if (pending.length >= MAX_PENDING_EVENTS) { flush(); return; }
      if (timer !== undefined) return;
      if (typeof requestAnimationFrame === "function") frame = requestAnimationFrame(flush);
      timer = setTimeout(flush, 100);
    },
    flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibility);
      flush();
    },
  };
}
