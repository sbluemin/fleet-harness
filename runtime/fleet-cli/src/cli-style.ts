export const ANSI_RESET = "\x1b[0m";
export const ANSI_BOLD = "\x1b[1m";
export const ANSI_DIM = "\x1b[2m";
export const FLEET_ACCENT = "\x1b[38;2;254;188;56m";
export const FLEET_OPTION = "\x1b[38;2;125;211;252m";
export const FLEET_COMMAND = "\x1b[38;2;94;234;212m";
export const GRADIENT_COLORS: readonly string[] = [
  "\x1b[38;2;0;255;255m",
  "\x1b[38;2;0;215;255m",
  "\x1b[38;2;0;175;255m",
  "\x1b[38;2;0;135;255m",
  "\x1b[38;2;0;95;255m",
  "\x1b[38;2;0;0;255m",
];
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
