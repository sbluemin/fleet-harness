/**
 * 드로어·하단 시트를 history 항목 하나로 세운다 — 하드웨어 뒤로·브라우저 뒤로·뒤로 제스처가 화면을 떠나지 않고
 * 먼저 열린 것을 닫는다. 화면 이동(`?op=`, 라우트)과는 섞이지 않는다: 이 항목은 URL을 바꾸지 않는다.
 *
 * 열린 쪽이 UI로 닫히면(스크림·항목 선택) 쌓아 둔 항목을 `history.back()`으로 걷는다. 그때 오는 popstate는
 * 이미 닫은 것의 흔적이라 삼킨다.
 */

interface Overlay { readonly id: number; readonly close: () => void }

const stack: Overlay[] = [];
let nextId = 1;
let swallowPops = 0;
let installed = false;

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("popstate", () => {
    if (swallowPops > 0) { swallowPops -= 1; return; }
    const top = stack.pop();
    top?.close();
  });
}

/** 열린 오버레이를 등록한다. `close`는 history를 건드리지 않고 상태만 닫는 함수여야 한다. 반환값은 이 오버레이의 id. */
export function pushOverlayHistory(close: () => void): number {
  install();
  const id = nextId++;
  stack.push({ id, close });
  window.history.pushState({ ...(window.history.state ?? {}), fleetMobileOverlay: id }, "");
  return id;
}

/** UI가 직접 닫았을 때 — 쌓아 둔 history 항목을 걷는다. 이미 뒤로가 닫은 것(스택에 없음)이면 아무 일도 하지 않는다. */
export function releaseOverlayHistory(id: number): void {
  const index = stack.findIndex((overlay) => overlay.id === id);
  if (index < 0) return;
  stack.splice(index, 1);
  swallowPops += 1;
  window.history.back();
}

/** 닫은 뒤 이동을 해야 할 때: 걷기가 끝나(popstate) 항목이 사라진 다음에 동작한다 — 걷기 전에 이동하면 새 항목이 걷히는 쪽에 낀다. */
export function runAfterOverlayRelease(id: number | null, action: () => void): void {
  if (id === null || !stack.some((overlay) => overlay.id === id)) { action(); return; }
  const done = () => { window.removeEventListener("popstate", done); window.clearTimeout(timer); action(); };
  const timer = window.setTimeout(done, 400);
  window.addEventListener("popstate", done);
  releaseOverlayHistory(id);
}
