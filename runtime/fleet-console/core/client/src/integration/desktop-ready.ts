import { DESKTOP_WINDOW_COMMAND_PATH } from "@fleet-console/protocol/desktop";
import { DESKTOP_BRAND_READY_ATTRIBUTE } from "@fleet-console/protocol/desktop/brand";

import { openBootLane } from "./boot-schedule.js";
import { getState, subscribe } from "./store.js";

/**
 * 이 화면이 처음으로 「다 그렸다」고 셸에게 알린다.
 *
 * 호스트를 갈아타는 Desktop은 새 콘솔이 그리는 동안 옛 화면을 붙잡아 둔다. 걷는 때는 부팅 셸의 첫 페인트가
 * 아니다 — 그것은 상단 띠만 있는 빈 화면 그 자체다. Theater 목록과 Operation 목록이 처음 들어와 사이드바와
 * 본문이 한꺼번에 선 뒤, 그 상태가 한 번 화면에 칠해진 다음이다.
 *
 * 렌더러에서 셸로 가는 통로는 없고 있어서도 안 된다. 그래서 자기 서버의 창 명령 경로에 알리고, 서버는 그것을
 * 이 창의 셸에게만 흘린다(desktop-contract). 셸이 아닌 브라우저에는 들을 셸이 없으므로 보내지 않는다.
 * 실패는 조용히 버린다 — 셸은 상한 타이머로 옛 화면을 걷는다.
 */
export function announceDesktopReady(): void {
  if (typeof document === "undefined" || document.documentElement.getAttribute("data-desktop-shell") !== "true") return;
  let announced = false;
  let unsubscribe: (() => void) | null = null;
  const check = (): void => {
    if (announced) return;
    const state = getState();
    // 목록 조회가 실패해도 bootstrapped는 선다. Operation 목록이 끝내 오지 않으면 알리지 않는다 — 상한이 걷는다.
    if (!state.bootstrapped || !state.operationsHydrated) return;
    announced = true;
    unsubscribe?.();
    unsubscribe = null;
    // 이 상태로 React가 커밋하고(구독 갱신은 다음 마이크로태스크에 동기 반영된다) 한 프레임이 칠해진 뒤에 알린다.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.documentElement.setAttribute(DESKTOP_BRAND_READY_ATTRIBUTE, "");
      // 같은 턴에 먼저 내보내야 뒤따라 열리는 조회보다 연결을 먼저 집는다. priority는 그 줄을 앞당긴다.
      void fetch(DESKTOP_WINDOW_COMMAND_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: "console-ready" }),
        signal: AbortSignal.timeout(3_000),
        priority: "high",
      }).catch(() => undefined);
      openBootLane();
    }));
  };
  unsubscribe = subscribe(check);
  check();
}
