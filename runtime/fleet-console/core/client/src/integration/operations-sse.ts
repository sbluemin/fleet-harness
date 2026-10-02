import { ApiError, fetchGroups, fetchObserverStatus, fetchOperations, fetchTheaters, resumeConsoleSession } from "./api.js";
import { refreshOperationArchive } from "./operation-archive.js";
import { OPERATION_CLUSTER_CHANGED_EVENT } from "@fleet-console/sdk/operations/browser";
import type { SessionEndedReason } from "../../../../features/remote-access/client/control-session.js";
import { applyDesktopFullscreenSnapshot, resetDesktopFullscreenSnapshot } from "./desktop-fullscreen.js";
import { applyDesktopShellSnapshot } from "./desktop-shell.js";
import { applyDesktopShellUpdateSnapshot } from "./desktop-shell-update.js";
import { forgetTriageOperation } from "../../../../features/workspace/client/canvas/triage-store.js";
import { applyTheaterLifecycle } from "../../../../features/workspace/client/theater.js";
import { applyControlHolder, applyControlReclaimed, applyGroupRemoved, applyGroupUpdate, applyObserverStatus, applyOperationRemoved, applyOperationUpdate, getState, hydrateGroups, hydrateOperations, hydrateTheaters, setConnectionState } from "./store.js";
import type { ControlHolder, OperationNode } from "./types.js";

const MAX_RECONNECT_DELAY_MS = 30_000;
/** 깨우기가 앞당긴 시도도 직전 시도와 이만큼은 떨어진다 — 백오프의 가장 짧은 대기와 같다. */
const WAKE_MIN_GAP_MS = 1_000;
/** 서버는 30초마다 heartbeat를 보낸다 — 두 번을 놓치고도 아무 프레임이 없으면 조용히 끊긴 연결로 본다. */
const STALE_AFTER_MS = 75_000;
/** 잠에서 깬 직후에는 커널 버퍼에 쌓인 프레임이 먼저 처리되도록 이만큼 기다린 뒤 판정한다. */
const FRESHNESS_GRACE_MS = 1_500;
/**
 * 재연결 시도(스냅숏 3종 조회와 세션 재합류)의 기한. 이 조회들은 로컬 상태를 읽는 가벼운 응답이라 건강한 연결에서는
 * 원격 화면에서도 1초 안팎에 끝난다. 그 열 배 넘게 기다려 느린 망을 오판하지 않으면서, 최대 백오프(30초)보다 짧게 잡아
 * 답 없는 요청 하나가 재연결 일정을 백오프 한 칸 넘게 밀지 않게 한다.
 */
const RECONNECT_ATTEMPT_DEADLINE_MS = 15_000;

// 누락 스냅샷은 SSE가 열리기 전에만 hydrate해 이후 실시간 프레임을 덮어쓰지 않는다.
let reconnectDelayMs = 1_000;
let reconnectHandle: ReturnType<typeof setTimeout> | null = null;
let pendingRetry: (() => void) | null = null;
let reconnectDueAt = 0;
let lastAttemptAt = 0;
/**
 * 깨우기는 시도를 **더하지 않고 당겨 쓴다.**
 *
 * 대기 중인 시도를 지금 돌리면, 앞당긴 시간만큼 다음 대기가 길어져 그다음 시도는 원래 일정의
 * 자리에 그대로 선다. 그 빚을 다 갚기 전에는 다시 당기지 않으므로, 탭 전환을 아무리 연타해도
 * 어느 구간의 시도 수는 백오프 일정보다 많아야 한 번 더 많다 — 장기 단절에서는 그대로 분당 2회다.
 * 실패한 깨우기가 백오프를 1초로 되돌리지 않는 것도 같은 이유다: 되돌리면 1·2·4·8·16초 계단이
 * 깨울 때마다 처음부터 다시 돌아 이 상한을 우회한다.
 */
let wakeBorrowedMs = 0;
let wakeAllowedAt = 0;
let wakeListenersInstalled = false;
let activeSource: EventSource | null = null;
let connectionGeneration = 0;
/**
 * 오류 없이 멈춘 연결(half-open)은 `onerror`가 오지 않아 화면이 live인 채로 낡는다.
 *
 * 그래서 생존은 "마지막으로 무언가를 받은 시각"으로만 판정한다. 점검 타이머가 늦게 돌아도(숨긴 탭의
 * throttling) 프레임이 오고 있었다면 시각 비교가 오탐하지 않는다. 정상 연결에서 이 감시는 타이머뿐이다
 * — 요청을 더 보내지 않는다.
 */
let lastFrameAt = 0;
let freshnessHandle: ReturnType<typeof setTimeout> | null = null;
let freshnessDueAt = 0;
/** 지금 스트림을 `onerror`와 같은 길로 끊는다 — 스트림이 없으면 null이다. */
let dropActiveSource: (() => void) | null = null;
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
    lastFrameAt = Date.now();
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

/**
 * 재연결 신호. 서버는 단절 중에 보낸 프레임을 다시 보내지 않으므로, 채널 구독만으로는 놓친 사건을 되찾을 수 없다.
 * 코어는 스냅숏을 다시 읽고 스트림을 연다. 플러그인은 이 신호에서 자기 데이터를 다시 읽는다. 첫 연결은 놓친 것이
 * 없으므로 울리지 않는다.
 */
const reconnectListeners = new Set<() => void>();
let streamOpenedOnce = false;

export function subscribeConsoleReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener);
  return () => {
    reconnectListeners.delete(listener);
  };
}

function notifyReconnected(): void {
  for (const listener of reconnectListeners) {
    try {
      listener();
    } catch (error) {
      console.error("Console reconnect listener failed", error);
    }
  }
}

/** 테스트 전용 — 모듈 전역 구독을 비운다. */
export function resetConsoleChannelsForTest(): void {
  channelListeners.clear();
  attachedChannels = new Set();
  reconnectListeners.clear();
}

export function connectOperationsSse(): void {
  if (getState().controlReclaimed !== null) return;
  cancelScheduledRetry();
  activeSource?.close();
  const generation = ++connectionGeneration;
  const source = new EventSource("/api/v1/operations/events");
  activeSource = source;
  const isCurrentSource = () => generation === connectionGeneration && activeSource === source;
  // 지금 스트림의 프레임이면 받은 시각을 남긴다 — 어떤 프레임이든 연결이 살아 있다는 증거다.
  const acceptFrame = () => {
    if (!isCurrentSource()) return false;
    lastFrameAt = Date.now();
    return true;
  };

  // 재연결마다 새 EventSource가 서므로 채널도 다시 붙인다 — 구독자는 그대로 남는다.
  attachedChannels = new Set();
  for (const channel of channelListeners.keys()) attachChannel(source, channel);

  // 한가한 Console에서도 생존을 알 수 있게 서버가 보내는 프레임이다. 받은 시각만 남긴다.
  source.addEventListener("heartbeat", () => {
    acceptFrame();
  });

  source.addEventListener("operation:changed", (e) => {
    if (!acceptFrame()) return;
    const msg = e as MessageEvent<string>;
    try {
      const data = JSON.parse(msg.data) as { readonly operation?: unknown };
      if (isRecord(data.operation)) applyOperationUpdate(data.operation as unknown as OperationNode);
    } catch {
      // ignore malformed SSE event
    }
  });

  // 삭제 유예에 들어간 Operation — 누른 창은 스스로 다시 조회하지만, 다른 창과 Console Use 의 닫기는 이 프레임으로만 온다.
  source.addEventListener("operation:removed", (e) => {
    if (!acceptFrame()) return;
    try {
      const data = JSON.parse((e as MessageEvent<string>).data) as { readonly operationId?: unknown };
      if (typeof data.operationId !== "string") return;
      forgetTriageOperation(data.operationId);
      applyOperationRemoved(data.operationId);
    } catch {
      // ignore malformed SSE event
    }
  });

  // 보관·복원은 Cluster 단위로 한 번에 일어난다 — 빠진 Operation 과 돌아온 Operation 을 같은 프레임에서 반영한다.
  // 보관된 노드는 일반 목록에 싣지 않는다(서버도 operations 에 active 노드만 보낸다).
  source.addEventListener(OPERATION_CLUSTER_CHANGED_EVENT, (e) => {
    if (!acceptFrame()) return;
    try {
      const data = JSON.parse((e as MessageEvent<string>).data) as { readonly removedIds?: unknown; readonly operations?: unknown };
      if (Array.isArray(data.removedIds)) {
        for (const id of data.removedIds) {
          if (typeof id !== "string") continue;
          forgetTriageOperation(id);
          applyOperationRemoved(id);
        }
      }
      if (Array.isArray(data.operations)) {
        for (const operation of data.operations) if (isRecord(operation)) applyOperationUpdate(operation as unknown as OperationNode);
      }
    } catch {
      // ignore malformed SSE event
    }
  });

  // 그룹은 Operation 과 별개의 실체다 — 모르는 groupId 를 단 operation:changed 가 먼저 와도 이 사건이 뒤따르면 자리를 찾는다.
  source.addEventListener("group:changed", (e) => {
    if (!acceptFrame()) return;
    try {
      const data = JSON.parse((e as MessageEvent<string>).data) as { readonly group?: unknown };
      const group = data.group as Record<string, unknown> | undefined;
      if (isRecord(group) && typeof group.id === "string" && typeof group.name === "string" && typeof group.color === "string" && typeof group.theaterId === "string" && typeof group.order === "number") applyGroupUpdate({ id: group.id, name: group.name, color: group.color, theaterId: group.theaterId, order: group.order, createdAt: typeof group.createdAt === "number" ? group.createdAt : Date.now() });
    } catch {
      // ignore malformed SSE event
    }
  });
  source.addEventListener("group:removed", (e) => {
    if (!acceptFrame()) return;
    try {
      const data = JSON.parse((e as MessageEvent<string>).data) as { readonly groupId?: unknown };
      if (typeof data.groupId === "string") applyGroupRemoved(data.groupId);
    } catch {
      // ignore malformed SSE event
    }
  });

  // 다른 창·API·Console Use가 Theater를 등록·잊기·되돌린 순간. 누른 창은 스스로 다시 조회하지만 나머지 창은
  // 이 프레임이 아니면 다음 재수화까지 옛 목록을 보인다.
  for (const event of ["registered", "forgotten", "restored"] as const) {
    source.addEventListener(`theater:${event}`, (e) => {
      if (!acceptFrame()) return;
      try {
        const data = JSON.parse((e as MessageEvent<string>).data) as { readonly theaterId?: unknown };
        if (typeof data.theaterId === "string") applyTheaterLifecycle(event, data.theaterId);
      } catch {
        // ignore malformed SSE event
      }
    });
  }

  source.addEventListener("update:available", () => {
    if (!acceptFrame()) return;
    refreshObserverStatus();
  });

  // 셸이 게시한 집. 붙는 순간과 게시가 도착하는 순간 모두 이 길로 온다 — 화면의 한 번뿐인 물음이
  // 빈손으로 끝났어도 창은 돌아갈 곳을 되찾는다.
  source.addEventListener("desktop:shell", (e) => {
    if (!acceptFrame()) return;
    const msg = e as MessageEvent<string>;
    try {
      applyDesktopShellSnapshot(JSON.parse(msg.data));
    } catch {
      // 잘못된 프레임은 아는 것을 지우지 않는다.
    }
  });

  // 셸 자신의 갱신 상태. 집 주소와 같은 길로 온다 — 화면이 이미 열어 둔 스트림 하나면 충분하다.
  source.addEventListener("desktop:shell-update", (e) => {
    if (!acceptFrame()) return;
    const msg = e as MessageEvent<string>;
    try {
      applyDesktopShellUpdateSnapshot(JSON.parse(msg.data));
    } catch {
      // 잘못된 프레임은 아는 것을 지우지 않는다.
    }
  });

  source.addEventListener("desktop:fullscreen", (e) => {
    if (!acceptFrame()) return;
    const msg = e as MessageEvent<string>;
    try {
      applyDesktopFullscreenSnapshot(JSON.parse(msg.data));
    } catch {
      resetDesktopFullscreenSnapshot();
    }
  });


  source.addEventListener("control:changed", (e) => {
    if (!acceptFrame()) return;
    const msg = e as MessageEvent<string>;
    try {
      const data = JSON.parse(msg.data) as { readonly holder?: unknown };
      if (isControlHolderSnapshot(data)) applyControlHolder(data.holder);
    } catch {
      // ignore malformed SSE event
    }
  });

  source.addEventListener("control:reclaimed", (e) => {
    if (!acceptFrame()) return;
    const msg = e as MessageEvent<string>;
    try {
      const data = JSON.parse(msg.data) as { readonly reason?: unknown };
      if (!isSessionEnded(data)) return;
      endSession(data.reason);
    } catch {
      // ignore malformed SSE event
    }
  });

  source.onopen = () => {
    if (!acceptFrame()) return;
    reconnectDelayMs = 1_000;
    wakeBorrowedMs = 0;
    wakeAllowedAt = 0;
    sessionResumeRefused = false;
    setConnectionState("live");
    refreshObserverStatus();
    // 단절 중 놓친 보관·복원·삭제 사건은 서버가 재전송하지 않는다.
    void refreshOperationArchive();
    if (streamOpenedOnce) notifyReconnected();
    streamOpenedOnce = true;
  };

  const drop = () => {
    if (!isCurrentSource()) return;
    source.close();
    activeSource = null;
    stopFreshnessWatch();
    resetDesktopFullscreenSnapshot();
    // SSE 단절은 원격 제어 세션이 끝났다는 증거가 아니므로 holder는 마지막 권위 스냅샷을 유지한다.
    scheduleReconnect();
  };
  source.onerror = drop;

  // 여는 중에 멈춘 연결도 같은 기한으로 거둔다 — 그래서 감시는 열리기 전부터 시작한다.
  lastFrameAt = Date.now();
  dropActiveSource = drop;
  scheduleFreshnessCheck(STALE_AFTER_MS, false);
}

/** offline으로 두고 백오프 일정의 다음 시도를 예약한다 — 끊긴 스트림과 기한을 넘긴 시도가 같은 길로 온다. */
function scheduleReconnect(): void {
  const retryGeneration = ++connectionGeneration;
  setConnectionState("offline");
  const retry = () => {
    reconnectHandle = null;
    pendingRetry = null;
    if (retryGeneration !== connectionGeneration) return;
    lastAttemptAt = Date.now();
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    attemptReconnect();
  };
  // 깨우기로 당겨 쓴 시간은 이 대기에 얹어 갚고, 다 갚기 전에는 다시 당기지 않는다.
  const now = Date.now();
  // 방금 끊긴 연결도 직전 시도로 친다 — 첫 깨우기도 단절 1초 안에는 서버를 두드리지 않는다.
  lastAttemptAt = now;
  const delayMs = reconnectDelayMs + wakeBorrowedMs;
  wakeAllowedAt = now + wakeBorrowedMs;
  wakeBorrowedMs = 0;
  pendingRetry = retry;
  reconnectDueAt = now + delayMs;
  reconnectHandle = setTimeout(retry, delayMs);
}

/**
 * 재연결 시도 하나 — 스냅숏을 모두 받은 뒤에야 스트림을 연다. 예약된 시도와 수동 재연결이 같은 길을 쓴다.
 *
 * 그룹·Theater는 사건으로만 흐르므로 끊긴 사이의 변경은 재조회로 메운다. 그룹 조회가 늦게 끝나면 새 스트림의 사건을
 * 옛 스냅숏이 덮으므로 순서는 바꾸지 않는다. 그룹·Theater 조회 실패는 목록만 유지하고, Operation 조회가 실패해도 스트림은
 * 연다 — 그 실패는 스트림의 onerror가 백오프로 이어 간다.
 *
 * 다만 답이 없는 조회는 실패도 아니어서, 기한이 없으면 시도 하나가 재연결 전체를 무기한 막는다. 망이 바뀐 뒤 죽은
 * keep-alive 소켓을 다시 쓴 요청은 OS의 TCP 재전송 기한(수 분)까지 그렇게 매달린다. 그래서 시도 전체에
 * `RECONNECT_ATTEMPT_DEADLINE_MS`를 두고, 넘기면 요청을 끊고 offline으로 되돌려 다음 시도를 예약한다 — 그 대기는
 * 깨우기가 당길 수 있다.
 */
function attemptReconnect(): void {
  const attemptGeneration = ++connectionGeneration;
  // "다시 연결하는 중"으로 전이시킨다 — 상태를 offline에 둔 채 재접속하면 서버가 여전히 죽어 있을 때
  // 수동 재연결 버튼을 눌러도 화면이 그대로여서 눌린 것인지 알 수 없다.
  setConnectionState("connecting");
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    if (attemptGeneration !== connectionGeneration) return;
    controller.abort();
    scheduleReconnect();
  }, RECONNECT_ATTEMPT_DEADLINE_MS);
  const { signal } = controller;
  void Promise.all([fetchOperations(null, signal), fetchGroups(null, signal).catch(() => null), fetchTheaters(signal).catch(() => null)])
    .then(([operations, groups, theaters]) => {
      if (attemptGeneration !== connectionGeneration) return;
      if (theaters) hydrateTheaters(theaters);
      if (groups) hydrateGroups(groups);
      hydrateOperations(operations);
    })
    // 콘솔이 재기동하면 이 화면의 세션은 사라지지만 페어링은 남는다. 그 사실을 아무도
    // 쓰지 않으면 원격 화면은 401을 영원히 반복하며, 사람에게는 "새 액세스 링크를
    // 받으라"는 잘못된 결론만 남는다. 여기서 한 번, 조용히 다시 합류한다.
    .catch(async (error: unknown) => {
      if (attemptGeneration !== connectionGeneration || !(error instanceof ApiError) || error.status !== 401) return;
      // 회수·대체된 세션의 401은 사유를 싣고 온다. 재시작·유휴(vanished)와 달리 자동
      // 재합류로 되살리지 않고, 살아 있는 프레임과 같은 종료 안내로 수렴한다.
      if (error.sessionEndReason === "reclaimed" || error.sessionEndReason === "superseded") {
        endSession(error.sessionEndReason);
        return;
      }
      if (sessionResumeRefused) return;
      await resumeConsoleSession(signal).catch((joinError: unknown) => {
        // 401은 페어링이 정말 사라졌다는 답이다 — 더 두드려도 거절 카운터만 올린다.
        // 그 밖의 실패는 아직 답이 아니므로 다음 재시도에서 한 번 더 묻는다.
        if (attemptGeneration === connectionGeneration && joinError instanceof ApiError && joinError.status === 401) sessionResumeRefused = true;
      });
    })
    .finally(() => {
      clearTimeout(deadline);
      if (attemptGeneration === connectionGeneration) connectOperationsSse();
    });
}

function scheduleFreshnessCheck(delayMs: number, settled: boolean): void {
  if (freshnessHandle !== null) clearTimeout(freshnessHandle);
  freshnessDueAt = Date.now() + delayMs;
  freshnessHandle = setTimeout(() => checkFreshness(settled), delayMs);
}

/**
 * 마지막 프레임 뒤 기한이 지났으면 `onerror`와 같은 길로 끊고, 아니면 남은 기한에 다시 본다.
 *
 * 타이머 자체가 크게 늦었다면 페이지나 기기가 멈춰 있었다는 뜻이다 — 그사이 도착한 프레임이 아직
 * 처리되지 않았을 수 있으므로, 한 번은 유예를 두고 다시 본 뒤에 판정한다(`settled`).
 */
function checkFreshness(settled: boolean): void {
  freshnessHandle = null;
  if (dropActiveSource === null) return;
  const now = Date.now();
  if (!settled && now - freshnessDueAt > FRESHNESS_GRACE_MS) {
    scheduleFreshnessCheck(FRESHNESS_GRACE_MS, true);
    return;
  }
  const silentMs = now - lastFrameAt;
  if (silentMs >= STALE_AFTER_MS) {
    dropActiveSource();
    return;
  }
  scheduleFreshnessCheck(STALE_AFTER_MS - silentMs, false);
}

function stopFreshnessWatch(): void {
  if (freshnessHandle !== null) clearTimeout(freshnessHandle);
  freshnessHandle = null;
  dropActiveSource = null;
}

/**
 * 잠에서 깬 기기, 다시 붙은 네트워크, 돌아온 사람은 예약된 시도를 기다릴 이유가 없다.
 *
 * 백오프 타이머가 대기 중이면 그 시도를 당긴다. 시도를 새로 만들지 않으므로 상한은 백오프 일정이
 * 그대로 쥔다(`wakeBorrowedMs` 참고). 스트림이 열려 있으면 잠든 사이 조용히 끊겼을 수 있으므로,
 * 짧은 유예 뒤 마지막 수신 시각만 본다 — 신선하면 아무것도 하지 않는다. 회수처럼 의도적으로 닫혀
 * 타이머도 스트림도 없는 화면에서는 아무것도 하지 않는다.
 */
function wakeOperationsSse(): void {
  if (reconnectHandle === null || pendingRetry === null) {
    // 깨어나면 세 신호가 한꺼번에 온다 — 이미 유예 안에 잡힌 점검이 있으면 그것이 같은 점검이다.
    if (dropActiveSource !== null && !(freshnessHandle !== null && freshnessDueAt - Date.now() <= FRESHNESS_GRACE_MS)) {
      scheduleFreshnessCheck(FRESHNESS_GRACE_MS, true);
    }
    return;
  }
  const now = Date.now();
  if (now < wakeAllowedAt) return;
  const runAt = Math.max(now, lastAttemptAt + WAKE_MIN_GAP_MS);
  // 잠든 사이 타이머가 멈췄다면 벽시계 기한은 이미 지났다 — 당겨 쓴 것 없이 지금 돌린다.
  if (now < reconnectDueAt && runAt >= reconnectDueAt) return;
  wakeBorrowedMs = Math.max(0, reconnectDueAt - runAt);
  // 깨어나면 online·visibilitychange·focus가 한꺼번에 온다 — 이 시도가 끝나기 전의 신호는 모두 같은 시도다.
  wakeAllowedAt = Number.POSITIVE_INFINITY;
  clearTimeout(reconnectHandle);
  reconnectDueAt = runAt;
  reconnectHandle = setTimeout(pendingRetry, runAt - now);
}

/**
 * 깨우기 신호는 문서 수명 동안 한 벌만 듣는다.
 *
 * focus도 듣는다: 창이 보이는 채 초점만 잃었다 돌아오는 경우(나란히 둔 창, Desktop 창)에는
 * visibilitychange가 오지 않는다. 세 신호가 같은 상한을 거치므로 focus가 더하는 시도는 없다.
 */
export function installOperationsSseWake(): void {
  if (wakeListenersInstalled) return;
  wakeListenersInstalled = true;
  window.addEventListener("online", wakeOperationsSse);
  window.addEventListener("focus", wakeOperationsSse);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wakeOperationsSse();
  });
}

function cancelScheduledRetry(): void {
  if (reconnectHandle !== null) clearTimeout(reconnectHandle);
  reconnectHandle = null;
  pendingRetry = null;
}

/**
 * 이 세션이 끝났다(회수·대체). 살아 있는 프레임으로 알았든 재연결 401 사유로 알았든 이 한
 * 곳으로 수렴한다 — 스트림·재시도·자동 재합류를 모두 걷고 종료 안내만 남긴다. reload하지
 * 않는다: 세션 없는 `/console/`은 401 JSON이므로 reload는 사람을 그 문서에 가둔다. 명시적
 * 재오픈(Desktop·모바일 셸 join)만이 복귀 경로다.
 */
function endSession(reason: SessionEndedReason): void {
  sessionResumeRefused = true;
  cancelScheduledRetry();
  activeSource?.close();
  activeSource = null;
  // 끝난 세션은 생존 감시도 깨우기 점검도 받지 않는다.
  stopFreshnessWatch();
  connectionGeneration += 1;
  setConnectionState("offline");
  applyControlReclaimed(reason);
}

export function reconnectOperationsSseNow(): void {
  if (getState().controlReclaimed !== null) return;
  cancelScheduledRetry();
  reconnectDelayMs = 1_000;
  wakeBorrowedMs = 0;
  wakeAllowedAt = 0;
  lastAttemptAt = Date.now();
  activeSource?.close();
  activeSource = null;
  stopFreshnessWatch();
  attemptReconnect();
}

export function refreshObserverStatus(): void {
  if (getState().controlReclaimed !== null) return;
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
