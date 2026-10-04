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
    // 위에 있던 오버레이의 항목이 실제로 걷혔을 때만 그것을 닫는다 — 오버레이와 상관없는 popstate(라우터·가드)가 열린 오버레이를 닫지 않게.
    const top = stack.at(-1);
    if (top && !isOnTop(top.id)) { stack.pop(); top.close(); }
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

function isOnTop(id: number): boolean {
  return ((window.history.state as { fleetMobileOverlay?: number } | null) ?? {}).fleetMobileOverlay === id;
}

function dropFromStack(id: number): void {
  const index = stack.findIndex((overlay) => overlay.id === id);
  if (index >= 0) stack.splice(index, 1);
}

/**
 * UI가 직접 닫았을 때 — 쌓아 둔 history 항목을 걷는다. 지금 항목이 정말 그 오버레이(맨 위)일 때만 걷는다:
 * 이미 뒤로가 걷었거나 다른 항목 위로 옮겨 갔다면 아무 일도 하지 않는다(엉뚱한 항목을 걷지 않는다).
 */
export function releaseOverlayHistory(id: number): void {
  const onTop = isOnTop(id);
  dropFromStack(id);
  if (!onTop) return;
  swallowPops += 1;
  window.history.back();
}

/**
 * 닫은 뒤 이동을 해야 할 때: 걷기가 끝나(popstate) 항목이 사라진 다음에 동작한다 — 걷기 전에 이동하면 새 상태가 걷히는 항목에 쓰여 사라진다.
 * 스택 기록이 아니라 지금 항목의 표식으로 판정한다(다른 popstate가 스택 기록을 먼저 비우는 경우가 있다).
 */
export function runAfterOverlayRelease(id: number | null, action: () => void): void {
  if (id === null || !isOnTop(id)) { if (id !== null) dropFromStack(id); action(); return; }
  const done = () => { window.removeEventListener("popstate", done); window.clearTimeout(timer); action(); };
  const timer = window.setTimeout(done, 400);
  window.addEventListener("popstate", done);
  releaseOverlayHistory(id);
}
