export {
  CARRIER_BG_COLORS,
  CARRIER_COLORS,
  CARRIER_DISPLAY_NAMES,
  CARRIER_RGBS,
  CLI_DISPLAY_NAMES,
  CLI_PROVIDER_DISPLAY_NAMES,
  VALID_CLI_TYPES,
} from "@sbluemin/fleet-carriers";

// ─── ANSI 상수 ───────────────────────────────────────────

/** ANSI 리셋 시퀀스 */
export const ANSI_RESET = "\x1b[0m";

/** ANSI 이스케이프 시퀀스 제거용 정규식 */
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ─── 사각형 프레임 문자 (둥근 코너) ─────────────────────

export const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

// ─── 애니메이션 상수 ─────────────────────────────────────

/** 처리 중 스피너 프레임 (Braille 패턴) */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 애니메이션 갱신 간격 (ms) */
export const ANIM_INTERVAL_MS = 100;

/** 프로그레스 바 밝은 블록 크기 */
export const PROGRESS_BLOCK_SIZE = 6;

// ─── 미리보기 상수 ───────────────────────────────────────

/** 축소 뷰 응답 미리보기 줄 수 */
export const PREVIEW_LINES = 18;

/** 스트리밍 미리보기 줄 수 */
export const STREAMING_PREVIEW_LINES = 12;

// ─── 에이전트 패널 스타일 ────────────────────────────────

/** 에이전트 패널 기본 프레임색 (비활성 시) */
export const PANEL_COLOR = "\x1b[38;2;180;160;220m";
export const PANEL_RGB: [number, number, number] = [180, 160, 220];

/** 에이전트 패널 dim 색상 (힌트, 보조 텍스트) */
export const PANEL_DIM_COLOR = "\x1b[38;2;160;150;180m";

/** Thinking 블록 색상 (라벤더) */
export const THINKING_COLOR = "\x1b[38;2;180;140;255m";

/** Tools 블록 색상 (틸/청록) */
export const TOOLS_COLOR = "\x1b[38;2;80;200;180m";

/** Sortie 도구 요약 색상 */
export const SORTIE_SUMMARY_COLOR = TOOLS_COLOR;

/** Task Force 배지/도구 요약 색상 */
export const TASKFORCE_BADGE_COLOR = "\x1b[38;2;100;180;255m";

// ─── Claude Code 스타일 심볼 ─────────────────────────────

/** 메시지/도구 시작 인디케이터 (⏺) */
export const SYM_INDICATOR = "⏺";

/** 도구 결과 프리픽스 (⎿) */
export const SYM_RESULT = "⎿";

/** Thinking 블록 심볼 (◇) — TUI 패널 전용 */
export const SYM_THINKING = "◇";

// ─── 패널 높이 ──────────────────────────────────────────

/** 패널 본문 높이 기본값 (줄 수) */
export const DEFAULT_BODY_H = 6;

/** 패널 본문 높이 최솟값 */
export const MIN_BODY_H = 4;

/** 패널 본문 높이 최댓값 */
export const MAX_BODY_H = 50;

/** 높이 조절 1회당 증감량 */
export const BODY_H_STEP = 2;
