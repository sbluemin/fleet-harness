// 공유 FLEET ASCII 배너 — fleet --help와 mission-control welcome 양쪽에서 사용
// 모든 줄은 visible width 41로 통일 (T 글자 우측 패딩 3칸 포함). 줄별 너비가 다르면
// mission-control welcome.ts의 centerText가 줄을 개별 중앙 정렬할 때 좌측 padding이
// 어긋나 어그러져 보이므로 자산 자체에서 균일성을 보장한다.
export const ASCII_FLEET_BANNER: readonly string[] = [
  "███████╗██╗     ███████╗███████╗████████╗",
  "██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝",
  "█████╗  ██║     █████╗  █████╗     ██║   ",
  "██╔══╝  ██║     ██╔══╝  ██╔══╝     ██║   ",
  "██║     ███████╗███████╗███████╗   ██║   ",
  "╚═╝     ╚══════╝╚══════╝╚══════╝   ╚═╝   ",
];
