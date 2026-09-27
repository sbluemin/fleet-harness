// 열릴 때 잰 앵커 자리에 붙은 팝오버는, 그 자리를 실제로 옮긴 스크롤에만 닫힌다.
// window capture 리스너는 문서 안의 모든 스크롤러 이벤트를 받는다 — 스트리밍 중 채팅 로그가
// 바닥을 따라가는 프로그램 스크롤까지 "사용자가 손을 움직였다"로 읽으면, 무관한 메뉴와
// 입력칸이 응답이 올 때마다 닫힌다.

/** 앵커 자리에 실제로 그려진 맨 위 요소. 팝오버 자신(오버레이 포함)은 건너뛴다. */
export function anchorElementAt(anchor: DOMRectReadOnly, popover: Element | null | undefined): Element | null {
  const x = anchor.left + anchor.width / 2;
  const y = anchor.top + anchor.height / 2;
  for (const element of document.elementsFromPoint(x, y)) {
    if (!popover?.contains(element)) return element;
  }
  return null;
}

export function scrollMovesAnchor(event: Event, anchor: DOMRectReadOnly, anchorElement: Element | null): boolean {
  const target = event.target;
  // 문서 자체의 스크롤은 fixed 팝오버 밑의 모든 것을 옮긴다.
  if (!(target instanceof Element)) return true;
  // 앵커를 그린 요소를 알면 DOM 소유로 판정한다. 접힌 사이드바의 픽처럼 겹쳐 떠 있는 표면은
  // 그 밑의 채팅 로그와 화면상 겹치지만, 그 로그의 스크롤은 앵커를 옮기지 못한다.
  if (anchorElement?.isConnected) return target.contains(anchorElement);
  // 요소를 잃었을 때만 기하로 가늠한다. 커서 앵커는 폭·높이가 0이라 1px 점으로 보고,
  // 맞닿은 변은 겹침으로 치지 않는다.
  const box = target.getBoundingClientRect();
  const right = Math.max(anchor.right, anchor.left + 1);
  const bottom = Math.max(anchor.bottom, anchor.top + 1);
  return box.left < right && anchor.left < box.right && box.top < bottom && anchor.top < box.bottom;
}
