/** macOS OS 화면 실측(DIP): 지름 14인 신호등 셋과 두 간격 9가 60을 차지한다.
 * 창 왼쪽 여백 16과 같은 오른쪽 여백을 두면 구분선을 포함한 좁은 열은 92 DIP다. 네이티브 컨트롤은 페이지 줌을 타지 않는다. */
export const MACOS_TRAFFIC_LIGHTS = {
  left: 16,
  span: 60,
  right: 16,
  height: 14,
} as const;
