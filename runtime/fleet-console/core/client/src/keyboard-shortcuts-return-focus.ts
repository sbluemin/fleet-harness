// 팔레트처럼 "자신이 닫히면서" 단축키 다이얼로그를 여는 표면이, 다이얼로그가 닫힐 때 복원할
// 원래 포커스 요소를 App에 넘기는 1회성 채널. 여는 시점의 document.activeElement는 이미
// 제거 중인 표면 내부 요소라 App 캡처만으로는 opener를 알 수 없다.
// (core 클라이언트 단일 번들 내부 전용 — 호스트/플러그인 번들 경계를 넘지 않는다.)
let target: HTMLElement | null = null;

export function stashKeyboardShortcutsReturnFocus(element: HTMLElement | null): void {
  target = element;
}

export function takeKeyboardShortcutsReturnFocus(): HTMLElement | null {
  const taken = target;
  target = null;
  return taken;
}
