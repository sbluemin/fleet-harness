// 맵 컨트롤(모드 스위치+트레이)은 중앙 트랙의 단독 승객이다 — Theater›Operation 브레드크럼과
// 스위처 메뉴는 사이드바가 이미 말하는 문장이라 퇴역했고, 그 가드들도 함께 물러났다.
// 중앙은 Console 전체 정중앙에 고정하므로 좌우 여백 하한은 좌·우 클러스터의 실측 콘텐츠 폭 중
// 큰 쪽에서 계산한다. 좌우 트랙은 반드시 같은 하한을 쓴다 — 한쪽만 예약하면 중앙이 viewport
// 중앙에서 밀리거나 우측 클러스터와 겹친다.
const COMMAND_BAND_CENTER_BREATHING_PX = 12;
const COMMAND_BAND_CENTER_GUTTER_FLOOR_PX = 44;

export function commandBandCenterGutter(leftContentEnd: number, rightContentWidth: number): number {
  return Math.max(
    COMMAND_BAND_CENTER_GUTTER_FLOOR_PX,
    leftContentEnd > 0 ? leftContentEnd + COMMAND_BAND_CENTER_BREATHING_PX : 0,
    rightContentWidth > 0 ? rightContentWidth + COMMAND_BAND_CENTER_BREATHING_PX : 0,
  );
}

// 좌우 여백 트랙을 뺀 나머지가 맵 컨트롤의 자연 폭에 못 미치면 중앙 정렬을 포기하고 좌측
// 플로우(is-center-flow)로 되돌린다 — 모드 스위치는 캔버스 모드의 유일한 조작면이라 브레드크럼
// 처럼 접을 수 없다. 미측정(0 이하)은 중앙 정렬 쪽으로 판정한다 — 첫 페인트에서 깜빡이며
// 자리를 옮기지 않게 한다.
export function commandBandCenterFits(bandWidth: number, gutter: number, centerContentWidth: number): boolean {
  if (bandWidth <= 0 || centerContentWidth <= 0) return true;
  return bandWidth - gutter * 2 >= centerContentWidth;
}
