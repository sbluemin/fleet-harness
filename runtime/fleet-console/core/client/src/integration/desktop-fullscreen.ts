import { useEffect, useRef, useSyncExternalStore } from "react";

import { isDesktopShell } from "./desktop-shell.js";
import { setZenMode } from "./zen-mode.js";

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
 * 전체화면은 Zen이 켠 것만 Zen이 끈다: 이미 전체화면이던 창에서 Zen을 켰다 끄면 창은 전체화면에
 * 머문다. 반대로 Zen이 켠 전체화면을 사용자가 OS 제스처(초록 단추·⌃⌘F·메뉴)로 빠져나오면 Zen도
 * 함께 걷힌다 — 버튼이 되돌아온 Zen은 바로 이 기능이 없애려던 어색한 상태다.
 * 브라우저 창은 이 결합의 대상이 아니다(셸이 없고, 브라우저 전체화면은 창 컨트롤과 무관하다).
 */
export function useZenDesktopFullscreen(zenActive: boolean): void {
  /** 이 Zen 회차가 전체화면을 켜 달라고 했는가. */
  const ownedRef = useRef(false);

  useEffect(() => {
    if (!isDesktopShell()) return;
    if (zenActive) {
      if (ownedRef.current || getDesktopFullscreenSnapshot()) return;
      ownedRef.current = true;
      void requestDesktopWindowCommand("enter-fullscreen");
      return;
    }
    if (!ownedRef.current) return;
    ownedRef.current = false;
    if (getDesktopFullscreenSnapshot()) void requestDesktopWindowCommand("leave-fullscreen");
  }, [zenActive]);

  useEffect(() => {
    const onLeave = () => {
      if (!ownedRef.current) return;
      // 사용자가 Zen이 켠 전체화면을 빠져나왔다 — 다시 끄라고 시키지 않도록 소유부터 놓는다. 창이 이미
      // OS 전환 장면을 돌고 있으므로 경로 이탈처럼 강제 종료로 걷는다: 전환 장면 요청은 앞 장면이 도는
      // 동안 삼켜지므로, 그 길로 가면 전체화면 없는 Zen이 남을 수 있다.
      ownedRef.current = false;
      setZenMode(false);
    };
    leaveListeners.add(onLeave);
    return () => { leaveListeners.delete(onLeave); };
  }, []);
}
