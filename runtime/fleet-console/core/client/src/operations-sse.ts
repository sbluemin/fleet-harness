import { ApiError, fetchObserverStatus, fetchOperations, resumeConsoleSession } from "./api.js";
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
/**
 * 다시 합류하기를 그만두는 조건은 "한 번 해봤다"가 아니라 **"이 콘솔이 이 기기를 잊었다"**이다.
 *
 * 원격 리스너는 조인 시도에 실패 예산을 매기고 거절 횟수를 주인에게 보고하므로, 되살아나지
 * 않는 페어링(401)으로 계속 두드리면 주인의 화면에 거짓 경보가 쌓인다. 반대로 일시적인
 * 거절(429/503, 아직 덜 뜬 콘솔)에서까지 빗장을 걸면, 화면은 되살아날 수 있는데도 영영
 * 401 루프에 남는다 — 이 변경이 없애려던 바로 그 실패다.
 */
let sessionResumeRefused = false;

/**
 * 플러그인 채널 다리.
 *
 * 서버는 플러그인이 명시적으로 올린 채널만 이 스트림으로 흘려보낸다(server의
 * publishPluginEvent). 받는 쪽이 없으면 그 프레임은 그대로 버려진다 — Codex의 실시간
 * 갱신이 실제로 그렇게 죽어 있었다: 서버는 계속 보내고, 코어는 자기 이벤트만 듣고,
 * 플러그인은 들을 방법이 없었다.
 *
 * 코어가 채널 이름을 알아보지 않는다는 것이 요점이다. 이름은 구독하는 쪽이 가져온다.
 */
const channelListeners = new Map<string, Set<(payload: unknown) => void>>();
let attachedChannels = new Set<string>();

export function subscribeConsoleChannel(channel: string, listener: (payload: unknown) => void): () => void {
  let listeners = channelListeners.get(channel);
  if (!listeners) {
    listeners = new Set();
    channelListeners.set(channel, listeners);
  }
  listeners.add(listener);
  // 스트림이 이미 열려 있으면 지금 붙인다 — 구독이 연결보다 늦게 오는 것이 보통이다.
  if (activeSource) attachChannel(activeSource, channel);
  return () => {
    listeners.delete(listener);
  };
}

function attachChannel(source: EventSource, channel: string): void {
  if (attachedChannels.has(channel)) return;
  attachedChannels.add(channel);
  source.addEventListener(channel, (event) => {
    // 프레임은 지금 살아 있는 스트림의 것만 받는다.
    if (activeSource !== source) return;
    let payload: unknown = null;
    try {
      payload = JSON.parse((event as MessageEvent<string>).data);
    } catch {
      return;
    }
    // 한 구독자의 실패가 같은 프레임의 다른 구독자를 삼키지 않게 한다.
    for (const listener of channelListeners.get(channel) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        console.error(`Console channel listener failed: ${channel}`, error);
      }
    }
  });
}

/** 테스트 전용 — 모듈 전역 구독을 비운다. */
export function resetConsoleChannelsForTest(): void {
  channelListeners.clear();
  attachedChannels = new Set();
}

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

  // 재연결마다 새 EventSource가 서므로 채널도 다시 붙인다 — 구독자는 그대로 남는다.
  attachedChannels = new Set();
  for (const channel of channelListeners.keys()) attachChannel(source, channel);

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
      /**
       * 서버는 이 프레임 뒤 스트림을 닫는다. 그 close가 onerror로 번지기 전에 이 source를 폐기해야
       * 일반 단절로 오인한 자동 재합류가 호스트의 Take back을 곧바로 뒤집지 않는다.
       *
       * 페어링은 남기므로 Desktop의 호스트 목록처럼 사람이 명시적으로 다시 여는 길은 그대로다.
       * 현재 문서의 401 자동 복구만 멈춘 뒤 reload한다. 새 문서는 일반 API의 401에서 pairing join을
       * 시도하지 않고 종료 안내를 그대로 그리므로, 회수된 session이 같은 문서에서 되살아나지 않는다.
       */
      source.close();
      if (activeSource === source) activeSource = null;
      connectionGeneration += 1;
      if (reconnectHandle !== null) {
        clearTimeout(reconnectHandle);
        reconnectHandle = null;
      }
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
    sessionResumeRefused = false;
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
        // 콘솔이 재기동하면 이 화면의 세션은 사라지지만 페어링은 남는다. 그 사실을 아무도
        // 쓰지 않으면 원격 화면은 401을 영원히 반복하며, 사람에게는 "새 액세스 링크를
        // 받으라"는 잘못된 결론만 남는다. 여기서 한 번, 조용히 다시 합류한다.
        .catch(async (error: unknown) => {
          if (!(error instanceof ApiError) || error.status !== 401) return;
          if (sessionResumeRefused) return;
          await resumeConsoleSession().catch((joinError: unknown) => {
            // 401은 페어링이 정말 사라졌다는 답이다 — 더 두드려도 거절 카운터만 올린다.
            // 그 밖의 실패는 아직 답이 아니므로 다음 재시도에서 한 번 더 묻는다.
            if (joinError instanceof ApiError && joinError.status === 401) sessionResumeRefused = true;
          });
        })
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
