/**
 * 모바일 뒤로의 마지막 두 우선순위 (impl-spec S-51 3·4).
 *
 *   [G 가드] [R 지금 루트] [상세 …] [겹침(드로어·시트) …]
 *
 * 루트(Operation 홈·목적지 루트)끼리의 이동은 history를 늘리지 않는다 — 라우트는 replace, store 목적지와
 * `?op=`는 URL만 바꾼다. 그래서 루트 아래에는 늘 가드 한 칸뿐이고, 뒤로가 그 가드에 닿으면:
 *   - 목적지 루트이면 홈으로 간다(우선순위 3),
 *   - 홈이면 드로어를 연다(우선순위 4 — 앱을 나가지 않는다. F5).
 * 닿은 가드는 곧바로 앞으로 한 칸 되돌린다. 상세(플러그인 depth·설정 섹션)와 겹침은 각자의 모듈이 그 위에 쌓고 걷는다.
 *
 * 가드에 닿는 popstate와 되돌리는 popstate는 이 모듈이 캡처 단계에서 삼킨다 — 홈 셸의 `?op=` 읽기나 라우터가
 * 가드의 옛 URL을 잠깐이라도 읽으면 화면이 깜박인다.
 */

const GUARD = "fleetMobileGuard";

type HistoryState = Record<string, unknown> | null;

let installed = false;
let handler: (() => void) | null = null;
let swallowNext = 0;
let afterSwallow: (() => void) | null = null;

function onPop(event: PopStateEvent): void {
  if (swallowNext > 0) {
    swallowNext -= 1;
    event.stopImmediatePropagation();
    const callback = afterSwallow;
    afterSwallow = null;
    callback?.();
    return;
  }
  const state = (window.history.state as HistoryState) ?? {};
  if (state[GUARD] !== true) return;
  event.stopImmediatePropagation();
  swallowNext += 1;
  // 되돌아온 뒤에 동작해야 한다 — 되돌리기 전에 드로어가 history를 쌓으면 앞 항목이 지워진다.
  afterSwallow = () => handler?.();
  window.history.go(1);
}

/** 모바일 배치가 서는 순간 한 번 — 지금 항목을 가드로 두고 그 위에 루트를 쌓는다. `onGuard`는 뒤로가 가드에 닿았을 때 부른다. */
export function installMobileHistory(onGuard: () => void): () => void {
  handler = onGuard;
  if (!installed) {
    installed = true;
    const current = { ...((window.history.state as HistoryState) ?? {}) };
    if (current[GUARD] !== true) {
      window.history.replaceState({ ...current, [GUARD]: true }, "");
      window.history.pushState({ ...current, [GUARD]: undefined }, "");
    }
    window.addEventListener("popstate", onPop, true);
  }
  return () => {
    window.removeEventListener("popstate", onPop, true);
    installed = false;
    handler = null;
  };
}
