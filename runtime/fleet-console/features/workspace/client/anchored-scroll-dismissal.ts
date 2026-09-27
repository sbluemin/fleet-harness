// 열릴 때 잰 앵커 자리에 붙은 팝오버는, 그 자리를 실제로 옮긴 스크롤에만 닫힌다.
// window capture 리스너는 문서 안의 모든 스크롤러 이벤트를 받는다 — 스트리밍 중 채팅 로그가
// 바닥을 따라가는 프로그램 스크롤까지 "사용자가 손을 움직였다"로 읽으면, 무관한 메뉴와
// 입력칸이 응답이 올 때마다 닫힌다. 앵커와 겹치지 않는 스크롤러는 앵커를 옮길 수 없다.
export function scrollMovesAnchor(event: Event, anchor: DOMRectReadOnly): boolean {
  const target = event.target;
  // 문서 자체의 스크롤은 fixed 팝오버 밑의 모든 것을 옮긴다.
  if (!(target instanceof Element)) return true;
  const box = target.getBoundingClientRect();
  // 커서 앵커는 폭·높이가 0이다 — 1px 점으로 보고, 맞닿은 변은 겹침으로 치지 않는다.
  const right = Math.max(anchor.right, anchor.left + 1);
  const bottom = Math.max(anchor.bottom, anchor.top + 1);
  return box.left < right && anchor.left < box.right && box.top < bottom && anchor.top < box.bottom;
}
