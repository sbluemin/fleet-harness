import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useDesktopFullscreenSnapshot } from "../desktop-fullscreen.js";
import { getCommandBandDocked, toggleCommandBandDocked, useCommandBandDocked } from "../fullscreen-band-store.js";

const DISPLAY_MODE_FULLSCREEN_QUERY = "(display-mode: fullscreen)";
const INITIAL_REVEAL_MS = 480;
const LEAVE_REVEAL_MS = 480;
// 상승 의도 레인. 최상단 EDGE_INSTANT_PX는 엣지 버튼이 직접 받아 즉시 발화하고, 그 아래
// EDGE_INTENT_PX까지는 위로 향하는 포인터가 EDGE_INTENT_DWELL_MS 동안 유지될 때만 발화한다.
// 이 구간을 히트 타깃으로 만들면 캔버스 상단의 클릭·드래그를 빼앗으므로, 요소가 아니라
// window 관찰로 둔다 — 관찰은 포인터 이벤트 대상을 바꾸지 않는다.
const EDGE_INSTANT_PX = 8;
const EDGE_INTENT_PX = 32;
const EDGE_INTENT_DWELL_MS = 120;
const ALWAYS_ALLOW_HIDE = () => true;

function isDisplayModeFullscreen(): boolean {
  return typeof window !== "undefined" && window.matchMedia(DISPLAY_MODE_FULLSCREEN_QUERY).matches;
}

/**
 * Owns only the renderer fullscreen lifecycle. Pointer and focus containment
 * stay with the command-band DOM, where the edge control and band refs exist.
 */
export function useFullscreenCommandBand(canHide: () => boolean = ALWAYS_ALLOW_HIDE) {
  const nativeFullscreen = useDesktopFullscreenSnapshot();
  const [displayModeFullscreen, setDisplayModeFullscreen] = useState(isDisplayModeFullscreen);
  const desktopShell = typeof document !== "undefined" && document.documentElement.dataset.desktopShell === "true";
  const fullscreen = displayModeFullscreen || (desktopShell && nativeFullscreen);
  const docked = useCommandBandDocked();
  const fullscreenRef = useRef(fullscreen);
  fullscreenRef.current = fullscreen;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(fullscreen);
  const [isRevealed, setIsRevealed] = useState(true);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const hideAfter = useCallback((delay: number) => {
    clearHideTimer();
    if (!fullscreenRef.current || getCommandBandDocked()) return;
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      if (fullscreenRef.current && !getCommandBandDocked() && canHide()) setIsRevealed(false);
    }, delay);
  }, [canHide, clearHideTimer]);

  const reveal = useCallback(() => {
    clearHideTimer();
    if (fullscreenRef.current) setIsRevealed(true);
  }, [clearHideTimer]);

  const hideAfterLeave = useCallback(() => hideAfter(LEAVE_REVEAL_MS), [hideAfter]);

  const toggleDock = useCallback(() => {
    toggleCommandBandDocked();
    if (getCommandBandDocked()) {
      clearHideTimer();
      setIsRevealed(true);
      return;
    }
    // 도킹을 끄면 밴드가 오버레이로 돌아온다 — 곧바로 사라지면 방금 누른 버튼이 손 아래에서
    // 증발하므로, 나갈 때와 같은 유예를 주고 숨긴다.
    hideAfter(LEAVE_REVEAL_MS);
  }, [clearHideTimer, hideAfter]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(DISPLAY_MODE_FULLSCREEN_QUERY);
    const syncDisplayMode = () => setDisplayModeFullscreen(mediaQuery.matches);
    syncDisplayMode();
    mediaQuery.addEventListener("change", syncDisplayMode);
    return () => mediaQuery.removeEventListener("change", syncDisplayMode);
  }, []);

  // 상승 의도 관찰 — 도킹 중이거나 전체화면이 아니면 아예 붙이지 않는다.
  useEffect(() => {
    if (!fullscreen || docked) return;
    // 첫 이벤트는 상승으로 세지 않는다 — 커서가 이미 레인 안에 놓여 있을 때 단발 흔들림만으로
    // 밴드가 내려오면 의도 게이트가 아니라 그냥 넓은 핫존이 된다.
    let lastY = Number.NEGATIVE_INFINITY;
    let dwellTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelDwell = () => {
      if (dwellTimer === null) return;
      clearTimeout(dwellTimer);
      dwellTimer = null;
    };
    const observe = (event: PointerEvent) => {
      const y = event.clientY;
      const rising = y < lastY;
      lastY = y;
      // 최상단 구간은 엣지 버튼이 소유한다. 버튼을 누른 채 올라오는 움직임은 캔버스 패닝이므로
      // 의도로 세지 않는다. 부유 크롬 카드 위의 상승도 의도가 아니다 — 카드 상단(top 12px)이
      // 의도 레인(8–32px)과 겹쳐, 사이드바 헤더의 + 버튼으로 올라가는 커서가 밴드를 불러
      // 그 버튼을 덮는다(적대 리뷰). 카드 위 조작은 카드의 것이다.
      const overFloatingChrome = event.target instanceof Element
        && event.target.closest(".operations-side-bar, .right-rail") !== null;
      if (y < EDGE_INSTANT_PX || y >= EDGE_INTENT_PX || !rising || event.buttons !== 0 || overFloatingChrome) {
        cancelDwell();
        return;
      }
      if (dwellTimer !== null) return;
      dwellTimer = setTimeout(() => {
        dwellTimer = null;
        reveal();
        // 의도 발화는 포인터가 아직 밴드 밖에 있을 때 일어난다 — 밴드가 정지한 커서 아래로
        // 미끄러져 들어가도 진입 이벤트는 생기지 않으므로, 이탈 이벤트도 영영 오지 않는다.
        // 그대로 두면 한 번 내려온 밴드가 다시는 숨지 않는다(실브라우저 재현). 진입 초기 노출과
        // 같은 유예를 걸어 두고, 사용자가 실제로 밴드 위로 움직이면 그때의 진입이 취소한다.
        hideAfterLeave();
      }, EDGE_INTENT_DWELL_MS);
    };
    window.addEventListener("pointermove", observe, { passive: true });
    // buttons 검사는 다음 pointermove에서만 돌아간다 — 의도를 걸어 둔 뒤 움직이지 않고 그대로
    // 누르면 dwell이 살아남아 드래그 시작과 함께 밴드가 내려온다. 누름 자체로 취소한다.
    window.addEventListener("pointerdown", cancelDwell, { passive: true });
    return () => {
      cancelDwell();
      window.removeEventListener("pointermove", observe);
      window.removeEventListener("pointerdown", cancelDwell);
    };
  }, [docked, fullscreen, hideAfterLeave, reveal]);

  useLayoutEffect(() => {
    clearHideTimer();
    setIsFullscreen(fullscreen);
    setIsRevealed(true);
    if (fullscreen && !docked) hideAfter(INITIAL_REVEAL_MS);
    return clearHideTimer;
  }, [clearHideTimer, docked, fullscreen, hideAfter]);

  // 도킹은 밴드를 흐름으로 되돌리므로 항상 보이는 상태다 — 숨김 타이머와 무관하게 참이다.
  return { isFullscreen, isVisible: docked || isRevealed, isDocked: docked, reveal, hideAfterLeave, toggleDock };
}
