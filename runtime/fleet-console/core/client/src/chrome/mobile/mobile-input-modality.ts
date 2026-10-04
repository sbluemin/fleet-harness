/**
 * 마지막 입력이 키보드였는지 — 드로어·시트·메뉴·팝업이 열릴 때 첫 항목으로 포커스를 옮길지 가른다(S-52 PR-0c).
 * 터치로 연 표면은 포커스를 옮기지 않는다(옮기면 닫을 때까지 흰 고리·면이 남는다). 키보드로 열었을 때만 옮겨 방향키·Esc가 닿게 한다.
 * 입력이 아직 한 번도 없었던 열림(프로그램이 연 경우)은 터치와 같이 다룬다.
 */
let keyboard = false;

if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { keyboard = true; }, true);
  window.addEventListener("pointerdown", () => { keyboard = false; }, true);
  window.addEventListener("touchstart", () => { keyboard = false; }, { capture: true, passive: true });
}

/** 지금 열리는 표면을 키보드가 연 것인가. 열리는 순간(효과 시작)에 읽는다. */
export function openedByKeyboard(): boolean {
  return keyboard;
}
