import { useEffect, useRef, useSyncExternalStore } from "react";

import { isDesktopShell } from "./desktop-shell.js";
import { getZenModeState, setZenMode, setZenWindowStage } from "./zen-mode.js";

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
/** 전환 완료 보고 뒤 한 박자 — 창이 새 크기로 첫 프레임을 그린 뒤에 장면을 잇는다. */
const WINDOW_SETTLE_PAUSE_MS = 80;
const FLIGHT_ATTRIBUTE = "data-zen-flight";

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
 * 창은 전환 장면의 한가운데에서 바뀐다(zen-transition.tsx): 불투명한 커튼이 다 쳐지고 앰블럼이 가운데에
 * 멈춰 선 뒤 여기 창 단계가 셸에게 전체화면을 켜고 끄라고 하고, 셸의 완료 알림(전체화면 스냅숏)이 오면
 * 장면이 이어진다. macOS 전체화면 애니메이션은 그동안 창 내용을 얼리는데, 그때 보이는 것은 커튼과 멈춘
 * 앰블럼뿐이라 끊겨 보일 것이 없다. 주고받는 것은 방향마다 한 번씩이다: 화면 → 셸 명령, 셸 → 화면 완료.
 *
 * 화면은 뜻만 알린다: 켜기·끄기. "이미 전체화면인가"·"Zen이 켠 것인가"는 창을 든 셸이 실제 창 상태로
 * 가린다(fleet-desktop desktop-window-command.ts) — 스냅숏은 늦게 오므로 이 값으로 가리면 빠르게 켰다 끈 뒤
 * 전체화면이 남았다. 그래서 이미 전체화면이던 창에서 Zen을 켰다 끄면 창은 전체화면에 머문다.
 *
 * 장면 없이 바뀌는 Zen(동작 줄이기·경로 이탈 같은 강제 종료)은 기다리지 않고 명령만 보낸다.
 * Zen이 켜 둔 동안 사용자가 OS 제스처(초록 단추·⌃⌘F·메뉴)로 전체화면을 빠져나오면 Zen도 함께 걷힌다 —
 * 버튼이 되돌아온 Zen은 바로 이 기능이 없애려던 어색한 상태다.
 * 브라우저 창은 이 결합의 대상이 아니다 — 창 단계가 곧바로 끝나고, 장면은 가운데에서 쉬지 않고 이어진다.
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

  // 두 동작은 ref만 읽고 쓰므로 어느 렌더의 것을 불러도 같다. 반환값은 창이 실제로 바뀌는가다.
  const enter = (): boolean => {
    if (requestedRef.current) return false;
    fromFullscreenRef.current = getDesktopFullscreenSnapshot();
    requestedRef.current = true;
    void requestDesktopWindowCommand("enter-fullscreen");
    return !fromFullscreenRef.current;
  };
  const leave = (): boolean => {
    if (!requestedRef.current) return false;
    requestedRef.current = false;
    ownLeaveUntilRef.current = Date.now() + OWN_LEAVE_GRACE_MS;
    void requestDesktopWindowCommand("leave-fullscreen");
    return !fromFullscreenRef.current && getDesktopFullscreenSnapshot();
  };
  /** 창이 Zen과 어긋나 있으면 기다리지 않고 맞춘다 — 장면 밖의 전환, 도중에 거둔 장면의 뒷정리. */
  const settle = (active: boolean) => {
    if (active) enter();
    else leave();
  };

  // 전환 장면의 창 단계 — 셸에게 시키고 완료 알림(또는 한도)까지 기다린다.
  useEffect(() => {
    if (!isDesktopShell()) return;
    // 새로 뜬 화면은 Zen이 꺼진 채 시작한다. Zen 도중 새로 고쳤다면 셸에는 Zen 몫의 전체화면이 남아 있으므로
    // 한 번 풀어 달라고 한다 — 셸은 자기 몫만 풀고, 사용자가 켠 전체화면은 건드리지 않는다.
    void requestDesktopWindowCommand("leave-fullscreen");
    let cancelWait: (() => void) | null = null;
    const waitForWindow = (target: boolean) => new Promise<void>((resolve) => {
      let done = false;
      let pause: number | null = null;
      const finish = (delay: number) => {
        if (done) return;
        done = true;
        unsubscribe();
        window.clearTimeout(limit);
        pause = window.setTimeout(resolve, delay);
      };
      const unsubscribe = subscribe(() => {
        if (getDesktopFullscreenSnapshot() === target) finish(WINDOW_SETTLE_PAUSE_MS);
      });
      const limit = window.setTimeout(() => finish(0), WINDOW_SETTLE_TIMEOUT_MS);
      cancelWait = () => {
        done = true;
        unsubscribe();
        window.clearTimeout(limit);
        if (pause !== null) window.clearTimeout(pause);
        resolve();
      };
    });
    const disposeStage = setZenWindowStage(async (next) => {
      if (next ? enter() : leave()) await waitForWindow(next);
    });
    return () => {
      disposeStage();
      cancelWait?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 장면 밖의 전환은 곧바로 맞춘다. 장면이 도는 동안은 장면의 창 단계가 맡으므로 손대지 않고, 장면이
  // 끝나면(도중에 거둬졌어도) 한 번 더 맞춘다.
  useEffect(() => {
    if (!isDesktopShell()) return;
    if (document.documentElement.hasAttribute(FLIGHT_ATTRIBUTE)) return;
    settle(zenActive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zenActive]);
  useEffect(() => {
    if (!isDesktopShell() || typeof MutationObserver === "undefined") return;
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      if (!root.hasAttribute(FLIGHT_ATTRIBUTE)) settle(getZenModeState().active);
    });
    observer.observe(root, { attributes: true, attributeFilter: [FLIGHT_ATTRIBUTE] });
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onLeave = () => {
      if (Date.now() < ownLeaveUntilRef.current) {
        ownLeaveUntilRef.current = 0;
        return;
      }
      if (!requestedRef.current) return;
      // 사용자가 전체화면을 빠져나왔다 — 셸은 이미 몫을 놓았으니 다시 끄라고 시키지 않도록 요청부터 거둔다.
      // 창이 OS 전환 장면을 돌고 있으므로 경로 이탈처럼 강제 종료로 걷는다.
      requestedRef.current = false;
      setZenMode(false);
    };
    leaveListeners.add(onLeave);
    return () => { leaveListeners.delete(onLeave); };
  }, []);
}
