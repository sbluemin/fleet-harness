/**
 * 편집 중인 요소에 포커스가 있을 때 Operations 단축키를 삼킬지 정하는 정책.
 *
 * 기본은 삼키는 것이다 — 타자가 단축키에 먹히면 글을 쓸 수 없다. 예외는 Console 뷰 축(Alt+문자)
 * 하나다: 같은 키가 터미널 포커스에서는 이미 살아 있으므로(xterm은 편집 판정에서 빠진다),
 * 채팅 컴포저에 포커스가 있다는 이유로만 화면을 바꾸는 키가 죽으면 표면마다 문법이 갈린다.
 * macOS의 Option+문자 합성은 각 분기의 preventDefault가 막으므로 문자가 새지 않는다.
 *
 * 화살표는 그 예외에서 다시 빠진다. 편집 중 Alt+화살표는 단어 단위 이동이고, 그것은 화면 배치
 * 명령보다 먼저 이 자리의 것이다.
 */
export function blocksOperationsShortcutWhileEditing(
  editing: boolean,
  event: { readonly altKey: boolean; readonly code: string },
): boolean {
  if (!editing) return false;
  if (!event.altKey) return true;
  return event.code.startsWith("Arrow");
}
