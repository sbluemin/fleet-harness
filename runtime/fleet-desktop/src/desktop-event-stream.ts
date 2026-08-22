/**
 * 셸이 콘솔에게서 무언가를 계속 듣는 방법은 하나다 — 콘솔이 여는 SSE를 셸이 구독한다.
 * 방향은 언제나 이쪽이다. 렌더러는 샌드박스이고 프로세스 간 통로가 없으므로, 페이지가
 * 셸에게 말을 걸 길은 없고 있어서도 안 된다(package-boundary 계약이 그 식별자들을 금지한다).
 *
 * 그 배관(스냅샷 선적재 → 스트림 → 재연결 → 프레임 크기 규율)은 듣는 대상이 무엇이든
 * 같다. 두 벌로 복사하면 프로토콜 결함도 두 곳에서 고쳐야 하므로 여기 한 벌만 둔다.
 */

class DesktopSseProtocolError extends Error {}

export interface DesktopEventStream {
  start(origin: string): Promise<void>;
  stop(): void;
}

export interface DesktopEventStreamDeps<T> {
  readonly snapshotPath: string;
  readonly eventsPath: string;
  readonly eventName: string;
  /** 신뢰하지 않는 페이로드를 이 셸이 쓸 수 있는 값으로 좁힌다. 아니면 null. */
  readonly parseSnapshot: (value: unknown) => T | null;
  readonly apply: (snapshot: T) => void;
  readonly maxFrameChars: number;
  readonly normalizeOrigin: (origin: string) => string;
  readonly fetch?: typeof fetch;
  readonly reconnectDelayMs?: number;
  readonly setTimeout?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

const INITIAL_LOAD_TIMEOUT_MS = 1_000;
const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const MAX_PROTOCOL_VIOLATION_RECONNECT_DELAY_MS = 30_000;

/** 스냅샷 라우트를 모르는 옛 콘솔(404/405)에는 스트림도 없다 — 조용히 물러난다. */
type SnapshotEndpointStatus = "supported" | "legacy" | "transient";

export function createDesktopEventStream<T>(deps: DesktopEventStreamDeps<T>): DesktopEventStream {
  const fetchFor = deps.fetch ?? globalThis.fetch;
  const reconnectDelayMs = deps.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  const schedule = deps.setTimeout ?? globalThis.setTimeout;
  const cancelSchedule = deps.clearTimeout ?? globalThis.clearTimeout;
  let activeOrigin: string | null = null;
  let eventController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let protocolViolationCount = 0;

  const stop = (): void => {
    activeOrigin = null;
    eventController?.abort();
    eventController = null;
    if (reconnectTimer !== null) cancelSchedule(reconnectTimer);
    reconnectTimer = null;
    protocolViolationCount = 0;
  };

  const scheduleReconnect = (origin: string, delay: number): void => {
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      connect(origin);
    }, delay);
  };

  const connect = (origin: string): void => {
    if (activeOrigin !== origin) return;
    eventController?.abort();
    const controller = new AbortController();
    eventController = controller;
    void consumeEvents(controller.signal, streamUrl(origin, deps.eventsPath))
      .then(() => {
        if (activeOrigin !== origin || controller.signal.aborted) return;
        protocolViolationCount = 0;
        scheduleReconnect(origin, reconnectDelayMs);
      })
      .catch((error: unknown) => {
        if (activeOrigin !== origin || controller.signal.aborted) return;
        const delay = error instanceof DesktopSseProtocolError
          ? Math.min(reconnectDelayMs * 2 ** Math.min(++protocolViolationCount, 5), MAX_PROTOCOL_VIOLATION_RECONNECT_DELAY_MS)
          : reconnectDelayMs;
        scheduleReconnect(origin, delay);
      });
  };

  async function consumeEvents(signal: AbortSignal, url: string): Promise<void> {
    const response = await fetchFor(url, { headers: { Accept: "text/event-stream", Origin: new URL(url).origin }, signal });
    if (!response.ok || !response.body) throw new Error("desktop_event_stream_unavailable");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) return;
        buffered += decoder.decode(result.value, { stream: true });
        const frames = buffered.split(/\r?\n\r?\n/u);
        buffered = frames.pop() ?? "";
        if (buffered.length > deps.maxFrameChars || frames.some((frame) => frame.length > deps.maxFrameChars)) {
          await reader.cancel().catch(() => undefined);
          throw new DesktopSseProtocolError("desktop_sse_frame_too_large");
        }
        for (const frame of frames) {
          const snapshot = parseDesktopSseFrame(frame, deps.eventName, deps.parseSnapshot);
          if (snapshot !== null) deps.apply(snapshot);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function loadInitialSnapshot(origin: string): Promise<SnapshotEndpointStatus> {
    try {
      const response = await fetchFor(streamUrl(origin, deps.snapshotPath), {
        headers: { Accept: "application/json", Origin: origin },
        signal: AbortSignal.timeout(INITIAL_LOAD_TIMEOUT_MS),
      });
      if (response.status === 404 || response.status === 405) return "legacy";
      if (!response.ok) return "transient";
      const snapshot = deps.parseSnapshot(await response.json());
      if (snapshot !== null) deps.apply(snapshot);
      return "supported";
    } catch {
      return "transient";
    }
  }

  return {
    async start(origin: string): Promise<void> {
      const normalizedOrigin = deps.normalizeOrigin(origin);
      stop();
      activeOrigin = normalizedOrigin;
      const snapshotStatus = await loadInitialSnapshot(normalizedOrigin);
      if (activeOrigin === normalizedOrigin && snapshotStatus !== "legacy") connect(normalizedOrigin);
    },
    stop,
  };
}

export function parseDesktopSseFrame<T>(frame: string, eventName: string, parseSnapshot: (value: unknown) => T | null): T | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) data.push(line.slice("data:".length).trimStart());
  }
  if (event !== eventName || data.length === 0) return null;
  try {
    return parseSnapshot(JSON.parse(data.join("\n")));
  } catch {
    return null;
  }
}

function streamUrl(origin: string, pathname: string): string {
  return new URL(pathname, `${origin}/`).toString();
}
