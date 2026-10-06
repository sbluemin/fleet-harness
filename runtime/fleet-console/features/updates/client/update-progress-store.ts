import { useSyncExternalStore } from "react";

import { UPDATE_FAILED_CONSOLE_RETURN_MS } from "@fleet-console/protocol/lifecycle/update";
import type { ConsoleLifecycleWait } from "@fleet-console/protocol/lifecycle/wait";

import { ConsoleUpdateApplyFailure, applyConsoleUpdate, fetchUpdateProgress } from "../../../core/client/src/integration/api.js";
import { hasConsoleVersionDrifted } from "../../../core/client/src/integration/console-version.js";
import type { ConsoleUpdateApplyFailureProgress, ConsoleUpdateProgress } from "../../../core/client/src/integration/types.js";

/**
 * 업데이트는 이 화면이 잠시 서버를 잃는 일이다. 그동안 사실을 들고 있을 수 있는 것은
 * 서버가 아니라 이 탭과, 돌아온 서버가 디스크에서 읽어 오는 기록 둘뿐이다.
 *
 * 그래서 이 store는 두 축으로 판정한다.
 * - **watching**: 이 탭이 방금 업데이트를 눌렀다(또는 진행 중인 것을 발견했다). 서버가
 *   닿지 않아도 커튼은 내려가지 않는다 — 닿지 않는 것이 곧 진행 중이라는 뜻이기 때문이다.
 * - **progress**: 서버가 답할 수 있을 때 읽어 온 사실. 종착(completed/failed)만이 커튼을 걷는다.
 *
 * 새로고침해도 커튼이 유지돼야 하므로 watching은 sessionStorage에 남긴다. 완료 통보를
 * 영원히 반복하지 않도록, 확인한 실행은 그 실행의 startedAt으로 기억한다.
 */

/**
 * 화면이 **직접 겪은** 단계. 워커의 국면은 서버가 살아 있을 때만 읽히고, 서버가 사라지는
 * 동안에는 마지막으로 읽은 국면이 낡은 채 남는다. 그래서 단계는 국면이 아니라 이 탭이
 * 관측한 사실로 정한다 — 적용 직후(stopping), 처음 닿지 않음(installing), 끊긴 뒤 다시
 * 닿음(reconnecting). 한 번 도달한 단계로 되돌아가지 않는다.
 */
export type UpdateCurtainStage = "stopping" | "installing" | "reconnecting";

/** 커튼이 약속하는 단계, 순서 그대로. */
export const UPDATE_CURTAIN_STAGES: readonly UpdateCurtainStage[] = ["stopping", "installing", "reconnecting"];

export interface UpdateProgressSnapshot {
  /** 커튼을 내릴지 여부. 이 탭이 업데이트를 지켜보는 중이면 true. */
  readonly watching: boolean;
  /**
   * 수락 전에 사람이 기다리는 대기. sessionStorage에 쓰지 않는다. 요청은 이 문서의 것이고,
   * 새로고침은 서버 progress의 wait에서 같은 값을 다시 읽는다.
   */
  readonly preparing: ConsoleLifecycleWait | null;
  readonly progress: ConsoleUpdateProgress | null;
  /** 종착에 도달했고 아직 사용자가 확인하지 않은 결과. 배너가 이것을 읽는다. */
  readonly outcome: "completed" | "failed" | null;
  /** 셸이 수행하기로 한 요청. 이 창은 곧 재시작된다. */
  readonly delegated: boolean;
  readonly targetVersion: string | null;
  readonly stage: UpdateCurtainStage;
  /**
   * The Console has stayed silent for UPDATE_FAILED_CONSOLE_RETURN_MS since it stopped answering (a stopping Console closes
   * its listeners first). An update that failed before its install has brought a Console back by then; one that is still
   * installing has not either. The screen says both and keeps watching: only a Console that answers again says which.
   */
  readonly silentPastReturn: boolean;
}

type Listener = () => void;

const WATCH_KEY = "fleet-console.update.watching";
/** 도달한 단계. 버전이 바뀌어 문서를 다시 받아도 새 문서가 같은 단계에서 이어 가게 한다. */
const STAGE_KEY = "fleet-console.update.stage";
const SEEN_KEY = "fleet-console.update.seen";
const POLL_INTERVAL_MS = 1_500;
/**
 * 한 번의 진행 조회가 기다리는 한도. 멈춘(SIGSTOP 등) 서버는 연결을 받고도 답하지 않아 요청이 끝나지 않는다 —
 * 그러면 다음 폴링도, 위의 지켜보기 한도도 영영 오지 않는다. 답 없는 조회는 닿지 않은 것으로 다룬다.
 */
const POLL_REQUEST_TIMEOUT_MS = 5_000;
/**
 * 위임에는 진행 기록이 없다 — 워커가 없고, 수행자인 셸은 곧 이 창을 통째로 재시작한다.
 * 폴링은 서버가 아직 닿는지만 확인한다. 그런데 듣는 셸이 없으면 아무 일도 일어나지 않으므로,
 * 그때 커튼이 영원히 남지 않도록 이만큼만 기다린다.
 */
const DELEGATED_TIMEOUT_MS = 60 * 1000;

const listeners = new Set<Listener>();
const IDLE_SNAPSHOT: UpdateProgressSnapshot = { watching: false, preparing: null, progress: null, outcome: null, delegated: false, targetVersion: null, stage: "stopping", silentPastReturn: false };
let store: UpdateProgressSnapshot = IDLE_SNAPSHOT;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let delegatedTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * 이 탭이 Console의 침묵을 처음 본 시각. 정지하는 Console은 listener부터 닫으므로 이 시각이 곧 계약의 정지 진입이다 —
 * 그 뒤의 설치는 옛 Console이 끝난 다음에야 시작하므로, 설치 중에 progress를 읽을 수 있는 Console은 없다.
 */
let silentSince: number | null = null;
/** 지켜보기가 끝날 때마다 바뀐다. 끝난 지켜보기의 조회가 늦게 돌아와도 폴링을 되살리지 않는다. */
let watchGeneration = 0;
/**
 * 이 문서는 끊김을 겪은 뒤 다시 받은 문서다. 여기서 보이는 버전 차이는 낡은 번들이 아니라
 * 서버가 이 실행의 목표와 다른 버전을 말한다는 뜻이므로, 다시 불러와도 해결되지 않는다.
 */
let reloadedAfterDisconnect = false;

function getUpdateProgressSnapshot(): UpdateProgressSnapshot {
  return store;
}

function subscribeUpdateProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useUpdateProgress(): UpdateProgressSnapshot {
  return useSyncExternalStore(subscribeUpdateProgress, getUpdateProgressSnapshot, getUpdateProgressSnapshot);
}

function setStore(next: UpdateProgressSnapshot): void {
  store = next;
  for (const listener of listeners) listener();
}

/** 이 탭이 업데이트를 시작시켰다. 서버가 사라지는 것은 이제 고장이 아니라 진행이다. */
export function beginUpdateWatch(targetVersion: string | null): void {
  writeSessionValue(WATCH_KEY, String(Date.now()));
  writeSessionValue(STAGE_KEY, "stopping");
  setStore({ ...store, preparing: null, watching: true, outcome: null, delegated: false, targetVersion, stage: "stopping", silentPastReturn: false });
  schedulePoll(0);
}

export type ConsoleUpdateRequestResult = "accepted" | "rejected" | "busy";

/**
 * 버전 행과 업데이트 말풍선이 같이 타는 수락 요청. 대기 중인 상태는 store가 들고,
 * 화면은 그 상태를 읽기만 한다. 이미 준비 중이거나 커튼을 지켜보는 중이면 아무 일도 하지 않는다.
 */
export async function requestConsoleUpdate(
  targetVersion: string,
  options: { readonly acknowledgeHostRestart?: boolean } = {},
): Promise<ConsoleUpdateRequestResult> {
  if (store.preparing !== null || store.watching) return "busy";
  setStore({ ...store, preparing: "update-preflight", outcome: null });
  try {
    const result = await applyConsoleUpdate(options.acknowledgeHostRestart === true ? { acknowledgeHostRestart: true } : {});
    if (result.status === "delegated") markUpdateDelegated(targetVersion);
    else beginUpdateWatch(targetVersion);
    return "accepted";
  } catch (error) {
    if (error instanceof ConsoleUpdateApplyFailure) {
      reportUpdateApplyFailure(error.progress);
      return "rejected";
    }
    setStore({ ...store, preparing: null });
    throw error;
  }
}

/** 아직 살아 있는 host가 거절한 이번 실행의 결론. 사유와 설명은 DTO 그대로 표시한다. */
export function reportUpdateApplyFailure(progress: ConsoleUpdateApplyFailureProgress): void {
  stopWatching();
  setStore({ ...IDLE_SNAPSHOT, progress, outcome: "failed", targetVersion: progress.targetVersion });
}

/** 이 설치 레이아웃은 셸이 갈아 끼운다. 창은 곧 재시작되므로 서버가 닿는지만 지켜본다. */
export function markUpdateDelegated(targetVersion: string | null): void {
  setStore({ ...store, preparing: null, watching: true, delegated: true, outcome: null, targetVersion, stage: "stopping", silentPastReturn: false });
  schedulePoll(POLL_INTERVAL_MS);
  if (delegatedTimer !== null) clearTimeout(delegatedTimer);
  delegatedTimer = setTimeout(() => {
    delegatedTimer = null;
    // 재시작이 오지 않았다. 성공했다고도 실패했다고도 말할 수 없으므로 아무것도 지어내지
    // 않고 화면만 돌려준다 — 업데이트 표식은 그대로 남아 다시 시도할 수 있다.
    stopWatching();
    setStore({ ...store, preparing: null, watching: false, delegated: false });
  }, DELEGATED_TIMEOUT_MS);
}

/**
 * 사람이 기다림을 거둔다. 결과를 지어내지 않는다 — 진행 기록은 서버에 남아 있으므로, Console이 돌아오면 다음 부팅이
 * 그 결과를 알린다.
 */
export function dismissUpdateWatch(): void {
  stopWatching();
  setStore(IDLE_SNAPSHOT);
}

export function acknowledgeUpdateOutcome(): void {
  const startedAt = store.progress?.startedAt;
  if (startedAt) writeLocalValue(SEEN_KEY, startedAt);
  stopWatching();
  setStore(IDLE_SNAPSHOT);
}

function stopWatching(): void {
  watchGeneration += 1;
  silentSince = null;
  // 재접속 뒤 드리프트 reload를 막는 표시는 이 실행에만 속한다. 같은 탭의 다음 업데이트는
  // 다시 옛 번들로 시작하므로 reload가 필요하다.
  reloadedAfterDisconnect = false;
  removeSessionValue(WATCH_KEY);
  removeSessionValue(STAGE_KEY);
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  if (delegatedTimer !== null) {
    clearTimeout(delegatedTimer);
    delegatedTimer = null;
  }
}

/** 단계는 앞으로만 간다. 위임은 창째 재시작되므로 새 문서에 넘길 것이 없다. */
function reachStage(stage: UpdateCurtainStage): void {
  if (UPDATE_CURTAIN_STAGES.indexOf(stage) <= UPDATE_CURTAIN_STAGES.indexOf(store.stage)) return;
  if (!store.delegated) writeSessionValue(STAGE_KEY, stage);
  setStore({ ...store, stage });
}

function schedulePoll(delayMs: number): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollOnce();
  }, delayMs);
}

/** 이 탭이 요청하지 않은 preflight를 따라가는 중인가. 원래 탭의 요청은 HTTP 응답으로 끝나고 이 폴링을 걸지 않는다. */
function followingPreflight(): boolean {
  return store.preparing === "update-preflight" && !store.watching;
}

/**
 * running progress를 받는 곳은 hydrate와 지켜보는 중의 폴링 둘이다. phase 문자열은 여기서 읽지 않는다.
 * wait가 update-preflight면 정지 커튼 대신 준비 상태이고, 없으면 수락 뒤 커튼이다.
 */
function adoptRunningProgress(progress: ConsoleUpdateProgress): void {
  if (progress.wait === "update-preflight") {
    if (delegatedTimer !== null) {
      clearTimeout(delegatedTimer);
      delegatedTimer = null;
    }
    removeSessionValue(WATCH_KEY);
    removeSessionValue(STAGE_KEY);
    silentSince = null;
    setStore({
      ...store,
      preparing: "update-preflight",
      watching: false,
      delegated: false,
      outcome: null,
      progress,
      targetVersion: progress.targetVersion ?? store.targetVersion,
      silentPastReturn: false,
    });
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }
  if (store.watching) {
    setStore({ ...store, preparing: null, progress, targetVersion: progress.targetVersion ?? store.targetVersion });
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }
  writeSessionValue(WATCH_KEY, String(Date.now()));
  writeSessionValue(STAGE_KEY, "stopping");
  setStore({
    ...store,
    preparing: null,
    watching: true,
    outcome: null,
    delegated: false,
    progress,
    targetVersion: progress.targetVersion ?? null,
    stage: "stopping",
    silentPastReturn: false,
  });
  schedulePoll(POLL_INTERVAL_MS);
}

function concludePreparing(progress: ConsoleUpdateProgress): void {
  if (progress.state === "running") {
    adoptRunningProgress(progress);
    return;
  }
  if (progress.state === "completed" || progress.state === "failed") {
    stopWatching();
    setStore({
      ...store,
      preparing: null,
      watching: false,
      progress,
      outcome: progress.state,
      delegated: false,
      targetVersion: progress.targetVersion ?? store.targetVersion,
    });
    return;
  }
  stopWatching();
  setStore(IDLE_SNAPSHOT);
}

async function pollOnce(): Promise<void> {
  const generation = watchGeneration;
  let progress: ConsoleUpdateProgress | null = null;
  try {
    progress = await fetchUpdateProgress(AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS));
  } catch {
    if (generation !== watchGeneration) return;
    if (followingPreflight()) {
      // 닿지 않는 것은 Console이 응답을 멈춘 것이다. preflight 다음은 정지이므로 커튼이 이제 사실이다.
      beginUpdateWatch(store.targetVersion);
      return;
    }
    if (!store.watching) return;
    // 닿지 않는 것 자체가 진행 중이라는 신호다 — 커튼을 유지한 채 계속 두드린다.
    reachStage("installing");
    noteSilence();
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }
  if (generation !== watchGeneration) return;
  if (followingPreflight()) {
    concludePreparing(progress);
    return;
  }
  if (!store.watching) return;
  silentSince = null;
  if (store.silentPastReturn) setStore({ ...store, silentPastReturn: false });
  if (store.stage === "installing") reachStage("reconnecting");
  // 위임의 폴링은 닿는지만 본다. 결과를 말할 워커 기록이 없고, 이 창은 셸이 재시작한다.
  if (store.delegated) {
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }
  if (progress.state === "running") {
    adoptRunningProgress(progress);
    return;
  }
  if (progress.state === "completed" && !reloadedAfterDisconnect && hasConsoleVersionDrifted(progress.targetVersion ?? null)) {
    // 콘솔은 새 버전으로 돌아왔지만 이 문서는 옛 번들이다. 커튼을 내린 채 새 문서를 받는다 —
    // 지켜보기와 도달한 단계는 남겨 두어, 돌아온 문서가 재연결 단계에서 결과를 읽어 알린다.
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
    location.reload();
    return;
  }
  if (progress.state === "completed" || progress.state === "failed") {
    stopWatching();
    setStore({
      ...store,
      watching: false,
      progress,
      outcome: progress.state,
      delegated: false,
      targetVersion: progress.targetVersion ?? store.targetVersion,
    });
    return;
  }
  // idle: 서버는 어떤 업데이트도 기억하지 못한다. 지켜볼 것이 없다.
  stopWatching();
  setStore(IDLE_SNAPSHOT);
}

/** 침묵이 계약의 복귀 시한(UPDATE_FAILED_CONSOLE_RETURN_MS)을 넘었는지. 위임은 셸이 창째 재시작하므로 해당하지 않는다. */
function noteSilence(): void {
  const now = Date.now();
  if (silentSince === null) silentSince = now;
  const pastReturn = !store.delegated && now - silentSince >= UPDATE_FAILED_CONSOLE_RETURN_MS;
  if (pastReturn !== store.silentPastReturn) setStore({ ...store, silentPastReturn: pastReturn });
}

/**
 * 부팅 시 한 번. 두 가지를 회수한다 — 새로고침으로 잃은 커튼과, 재기동을 겪고 돌아온
 * 콘솔이 아직 말하지 않은 결과.
 */
export function hydrateUpdateProgress(): void {
  const resumed = readSessionValue(WATCH_KEY);
  if (resumed !== null) {
    // 이 문서를 받았다는 것은 서버가 닿는다는 뜻이다. 앞선 문서가 끊김을 겪었다면 지금이
    // 곧 재연결이다 — 버전이 바뀌어 다시 받은 문서가 이 경우다.
    const resumedStage = readSessionValue(STAGE_KEY);
    const disconnected = resumedStage !== null && resumedStage !== "stopping";
    reloadedAfterDisconnect = disconnected;
    if (disconnected) writeSessionValue(STAGE_KEY, "reconnecting");
    setStore({ ...store, watching: true, stage: disconnected ? "reconnecting" : "stopping" });
    schedulePoll(0);
    return;
  }
  const generation = watchGeneration;
  void (async () => {
    let progress: ConsoleUpdateProgress | null = null;
    try {
      progress = await fetchUpdateProgress();
    } catch {
      return;
    }
    if (generation !== watchGeneration || progress.state === "idle") return;
    // 이 탭은 업데이트를 시작시키지 않았지만, 서버는 지금 갈아 끼워지는 중이다. 정상 화면을
    // 내주면 곧 사라질 콘솔을 멀쩡한 것처럼 보여주게 된다 — 지금 붙어서 함께 지켜본다.
    if (progress.state === "running") {
      adoptRunningProgress(progress);
      return;
    }
    if (progress.startedAt && readLocalValue(SEEN_KEY) === progress.startedAt) return;
    setStore({
      ...store,
      watching: false,
      progress,
      outcome: progress.state,
      delegated: false,
      targetVersion: progress.targetVersion ?? null,
    });
  })();
}

function readSessionValue(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSessionValue(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // 저장이 막힌 브라우저에서도 이 탭이 살아 있는 동안의 커튼은 메모리가 들고 있다.
  }
}

function removeSessionValue(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // 위와 같다.
  }
}

function readLocalValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 확인 기록이 남지 않으면 다음 방문에 한 번 더 알릴 뿐, 손실은 없다.
  }
}
