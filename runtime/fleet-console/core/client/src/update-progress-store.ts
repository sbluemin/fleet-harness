import { useSyncExternalStore } from "react";

import { fetchUpdateProgress } from "./api.js";
import type { ConsoleUpdateProgress } from "./types.js";

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
export type UpdateProgressPhase = "stopping" | "installing" | "starting" | "reconnecting";

export interface UpdateProgressSnapshot {
  /** 커튼을 내릴지 여부. 이 탭이 업데이트를 지켜보는 중이면 true. */
  readonly watching: boolean;
  readonly progress: ConsoleUpdateProgress | null;
  /** 종착에 도달했고 아직 사용자가 확인하지 않은 결과. 배너가 이것을 읽는다. */
  readonly outcome: "completed" | "failed" | null;
  /** 셸이 수행하기로 한 요청. 이 창은 곧 재시작된다. */
  readonly delegated: boolean;
  readonly targetVersion: string | null;
}

type Listener = () => void;

const WATCH_KEY = "fleet-console.update.watching";
const SEEN_KEY = "fleet-console.update.seen";
const POLL_INTERVAL_MS = 1_500;
/** 종착 없이 이만큼 지나면 지켜보기를 멈춘다 — 커튼이 영원히 남는 것이 가장 나쁘다. */
const WATCH_TIMEOUT_MS = 10 * 60 * 1000;

const listeners = new Set<Listener>();
let store: UpdateProgressSnapshot = { watching: false, progress: null, outcome: null, delegated: false, targetVersion: null };
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let watchStartedAt: number | null = null;

export function getUpdateProgressSnapshot(): UpdateProgressSnapshot {
  return store;
}

export function subscribeUpdateProgress(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useUpdateProgress(): UpdateProgressSnapshot {
  return useSyncExternalStore(subscribeUpdateProgress, getUpdateProgressSnapshot);
}

function setStore(next: UpdateProgressSnapshot): void {
  store = next;
  for (const listener of listeners) listener();
}

/** 이 탭이 업데이트를 시작시켰다. 서버가 사라지는 것은 이제 고장이 아니라 진행이다. */
export function beginUpdateWatch(targetVersion: string | null): void {
  watchStartedAt = Date.now();
  writeSessionValue(WATCH_KEY, String(watchStartedAt));
  setStore({ ...store, watching: true, outcome: null, delegated: false, targetVersion });
  schedulePoll(0);
}

/** 이 설치 레이아웃은 셸이 갈아 끼운다. 창은 곧 재시작되므로 폴링할 서버도 없다. */
export function markUpdateDelegated(targetVersion: string | null): void {
  setStore({ ...store, watching: true, delegated: true, outcome: null, targetVersion });
}

export function acknowledgeUpdateOutcome(): void {
  const startedAt = store.progress?.startedAt;
  if (startedAt) writeLocalValue(SEEN_KEY, startedAt);
  stopWatching();
  setStore({ watching: false, progress: null, outcome: null, delegated: false, targetVersion: null });
}

function stopWatching(): void {
  watchStartedAt = null;
  removeSessionValue(WATCH_KEY);
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll(delayMs: number): void {
  if (pollTimer !== null) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void pollOnce();
  }, delayMs);
}

async function pollOnce(): Promise<void> {
  if (watchStartedAt !== null && Date.now() - watchStartedAt > WATCH_TIMEOUT_MS) {
    // 여기서 멈추는 것은 "성공했다"가 아니라 "더는 알 수 없다"이다. 종착 기록이 없으므로
    // 결과를 지어내지 않고, 커튼만 걷어 사용자가 화면을 되찾게 한다.
    stopWatching();
    setStore({ ...store, watching: false, delegated: false });
    return;
  }
  let progress: ConsoleUpdateProgress | null = null;
  try {
    progress = await fetchUpdateProgress();
  } catch {
    // 닿지 않는 것 자체가 진행 중이라는 신호다 — 커튼을 유지한 채 계속 두드린다.
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }
  if (progress.state === "running") {
    setStore({ ...store, progress, targetVersion: progress.targetVersion ?? store.targetVersion });
    schedulePoll(POLL_INTERVAL_MS);
    return;
  }
  if (progress.state === "completed" || progress.state === "failed") {
    stopWatching();
    setStore({
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
  setStore({ watching: false, progress: null, outcome: null, delegated: false, targetVersion: null });
}

/**
 * 부팅 시 한 번. 두 가지를 회수한다 — 새로고침으로 잃은 커튼과, 재기동을 겪고 돌아온
 * 콘솔이 아직 말하지 않은 결과.
 */
export function hydrateUpdateProgress(): void {
  const resumed = readSessionValue(WATCH_KEY);
  if (resumed !== null) {
    watchStartedAt = Number.parseInt(resumed, 10) || Date.now();
    setStore({ ...store, watching: true });
    schedulePoll(0);
    return;
  }
  void (async () => {
    let progress: ConsoleUpdateProgress | null = null;
    try {
      progress = await fetchUpdateProgress();
    } catch {
      return;
    }
    if (progress.state === "idle") return;
    // 이 탭은 업데이트를 시작시키지 않았지만, 서버는 지금 갈아 끼워지는 중이다. 정상 화면을
    // 내주면 곧 사라질 콘솔을 멀쩡한 것처럼 보여주게 된다 — 지금 붙어서 함께 지켜본다.
    if (progress.state === "running") {
      watchStartedAt = Date.now();
      writeSessionValue(WATCH_KEY, String(watchStartedAt));
      setStore({ ...store, watching: true, progress, targetVersion: progress.targetVersion ?? null });
      schedulePoll(POLL_INTERVAL_MS);
      return;
    }
    if (progress.startedAt && readLocalValue(SEEN_KEY) === progress.startedAt) return;
    setStore({
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
