import { useEffect, useRef, useSyncExternalStore } from "react";

import { isDesktopShell } from "./desktop-shell.js";
import { setZenMode, setZenRequestGate } from "./zen-mode.js";

type Listener = () => void;

let snapshot = false;
const listeners = new Set<Listener>();

export function useDesktopFullscreenSnapshot(): boolean {
  return useSyncExternalStore(subscribe, getDesktopFullscreenSnapshot, getDesktopFullscreenSnapshot);
}

export function getDesktopFullscreenSnapshot(): boolean {
  return snapshot;
}

/**
 * 셸이 마지막으로 보고한 값. 스트림 단절의 초기화(false)는 보고가 아니다 — 그것을 "전체화면에서
 * 나왔다"로 읽으면 Console이 잠깐 끊길 때마다 Zen이 걷힌다.
 */
let lastReported: boolean | null = null;
const leaveListeners = new Set<Listener>();

export function applyDesktopFullscreenSnapshot(value: unknown): void {
  if (!isDesktopFullscreenSnapshot(value)) {
    resetDesktopFullscreenSnapshot();
    return;
  }
  const left = lastReported === true && !value.fullscreen;
  lastReported = value.fullscreen;
  snapshot = value.fullscreen;
  for (const listener of listeners) listener();
  if (left) for (const listener of leaveListeners) listener();
}

export function resetDesktopFullscreenSnapshot(): void {
  snapshot = false;
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function isDesktopFullscreenSnapshot(value: unknown): value is { readonly fullscreen: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).length === 1 && typeof entry.fullscreen === "boolean";
}

const WINDOW_COMMAND_PATH = "/api/v1/desktop/window/command";

type DesktopWindowCommand = "enter-fullscreen" | "leave-fullscreen";

/** 끄라고 한 뒤 그 이탈 보고가 돌아올 만한 시간 — macOS 전환 애니메이션과 SSE 왕복을 넉넉히 담는다. */
const OWN_LEAVE_GRACE_MS = 3_000;
/** 창 전환을 기다리는 한도. macOS 전체화면 애니메이션(약 0.7초)과 보고 왕복을 담고, 못 오면 그냥 진행한다. */
const WINDOW_SETTLE_TIMEOUT_MS = 1_400;
/** 전환 완료 보고 뒤 한 박자 — 창이 새 크기로 첫 프레임을 그린 뒤에 장면을 시작한다. */
const WINDOW_SETTLE_PAUSE_MS = 80;

/** 셸에게 창 조작을 시킨다. 응답은 전달 여부일 뿐이고, 실제 전체화면 여부는 셸이 게시하는 스냅샷이 말한다. */
async function requestDesktopWindowCommand(command: DesktopWindowCommand): Promise<boolean> {
  try {
    const response = await fetch(WINDOW_COMMAND_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Desktop 창의 Zen은 네이티브 전체화면과 한 몸이다 — Command Band가 물러나면 그 위에 얹혀 있던
 * 신호등·캡션 버튼만 캔버스 위에 떠 남는데, 두 OS 모두 그 버튼을 거두는 확실한 길은 전체화면뿐이다.
 *
 * 화면은 뜻만 알린다: Zen을 켜면 켜기, 끄면 끄기. "이미 전체화면인가"·"Zen이 켠 것인가"는 창을 든 셸이
 * 실제 창 상태로 가린다(fleet-desktop desktop-window-command.ts) — 여기 스냅숏은 셸 → Console → SSE를
 * 거쳐 늦게 오므로, 이 값으로 가리면 빠르게 켰다 끈 뒤 전체화면이 남고 그다음부터 영영 끄지 못했다
 * (Windows 신고). 그래서 이미 전체화면이던 창에서 Zen을 켰다 끄면 창은 전체화면에 머문다.
 *
 * Zen이 켜 둔 동안 사용자가 OS 제스처(초록 단추·⌃⌘F·메뉴)로 전체화면을 빠져나오면 Zen도 함께 걷힌다 —
 * 버튼이 되돌아온 Zen은 바로 이 기능이 없애려던 어색한 상태다.
 * 브라우저 창은 이 결합의 대상이 아니다(셸이 없고, 브라우저 전체화면은 창 컨트롤과 무관하다).
 */
export function useZenDesktopFullscreen(zenActive: boolean): void {
  /** 이 Zen 회차가 셸에게 전체화면을 켜 달라고 했는가. */
  const requestedRef = useRef(false);
  /**
   * 스스로 끄라고 한 전체화면 이탈이 도착할 때까지의 기한. 끄고 곧바로 다시 켜면 그 이탈 보고가 새 Zen 회차
   * 안에 늦게 도착하는데, 그것을 사용자의 이탈로 읽으면 방금 켠 Zen이 걷힌다.
   */
  const ownLeaveUntilRef = useRef(0);
  /** 이 Zen 회차를 켤 때 창이 이미 전체화면이었는가 — 그렇다면 끌 때 창은 그대로라 기다릴 것이 없다. */
  const fromFullscreenRef = useRef(false);
  /** 창 전환을 기다리는 중인가 — 그동안의 요청은 삼킨다(전환 장면이 도는 동안과 같은 규칙). */
  const waitingRef = useRef(false);

  // 사용자의 켜기·끄기 요청은 창 전환을 먼저 끝내고 진행한다.
  useEffect(() => {
    if (!isDesktopShell()) return;
    let timers: number[] = [];
    let unsubscribe: (() => void) | null = null;
    const release = () => {
      unsubscribe?.();
      unsubscribe = null;
      for (const timer of timers) window.clearTimeout(timer);
      timers = [];
    };
    const waitForWindow = (target: boolean, proceed: () => void) => {
      waitingRef.current = true;
      let done = false;
      const finish = (pause: number) => {
        if (done) return;
        done = true;
        release();
        timers.push(window.setTimeout(() => {
          waitingRef.current = false;
          proceed();
        }, pause));
      };
      unsubscribe = subscribe(() => {
        if (getDesktopFullscreenSnapshot() === target) finish(WINDOW_SETTLE_PAUSE_MS);
      });
      timers.push(window.setTimeout(() => finish(0), WINDOW_SETTLE_TIMEOUT_MS));
    };
    const disposeGate = setZenRequestGate((next, proceed) => {
      // 창을 기다리는 중이거나 전환 장면이 도는 중이면 삼킨다 — 장면이 요청을 삼키는데 창만 먼저 바뀌면
      // 창과 Zen이 어긋난다(zen-transition.tsx의 html[data-zen-flight]가 장면의 표지다).
      if (waitingRef.current || document.documentElement.dataset.zenFlight !== undefined) return true;
      const fullscreen = getDesktopFullscreenSnapshot();
      if (next) {
        fromFullscreenRef.current = fullscreen;
        requestedRef.current = true;
        void requestDesktopWindowCommand("enter-fullscreen");
        if (fullscreen) return false;
        waitForWindow(true, proceed);
        return true;
      }
      if (!requestedRef.current) return false;
      requestedRef.current = false;
      ownLeaveUntilRef.current = Date.now() + OWN_LEAVE_GRACE_MS;
      void requestDesktopWindowCommand("leave-fullscreen");
      if (fromFullscreenRef.current || !fullscreen) return false;
      waitForWindow(false, proceed);
      return true;
    });
    return () => {
      disposeGate();
      release();
      waitingRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isDesktopShell()) return;
    if (zenActive) {
      if (requestedRef.current) return;
      requestedRef.current = true;
      void requestDesktopWindowCommand("enter-fullscreen");
      return;
    }
    if (!requestedRef.current) return;
    requestedRef.current = false;
    ownLeaveUntilRef.current = Date.now() + OWN_LEAVE_GRACE_MS;
    void requestDesktopWindowCommand("leave-fullscreen");
  }, [zenActive]);

  useEffect(() => {
    const onLeave = () => {
      if (Date.now() < ownLeaveUntilRef.current) {
        ownLeaveUntilRef.current = 0;
        return;
      }
      if (!requestedRef.current) return;
      // 사용자가 전체화면을 빠져나왔다 — 셸은 이미 몫을 놓았으니 다시 끄라고 시키지 않도록 요청부터 거둔다.
      // 창이 OS 전환 장면을 돌고 있으므로 경로 이탈처럼 강제 종료로 걷는다: 전환 장면 요청은 앞 장면이 도는
      // 동안 삼켜지므로, 그 길로 가면 전체화면 없는 Zen이 남을 수 있다.
      requestedRef.current = false;
      setZenMode(false);
    };
    leaveListeners.add(onLeave);
    return () => { leaveListeners.delete(onLeave); };
  }, []);
}
