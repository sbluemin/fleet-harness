export const ANSI_RESET = "\x1b[0m";
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export const BORDER = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const;

export const ANIM_INTERVAL_MS = 100;
export const BREATHING_CYCLE_FRAMES = 10;
export const TOKEN_COUNTUP_EASING_FACTOR = 0.25;
export const TOKEN_COUNTUP_MIN_STEP = 8;
export const PROGRESS_BLOCK_SIZE = 6;

export const PREVIEW_LINES = 18;
export const STREAMING_PREVIEW_LINES = 12;

export const PANEL_COLOR = "\x1b[38;2;180;160;220m";
export const PANEL_RGB: [number, number, number] = [180, 160, 220];
export const PANEL_DIM_COLOR = "\x1b[38;2;160;150;180m";
export const THINKING_COLOR = "\x1b[38;2;180;140;255m";
export const TOOLS_COLOR = "\x1b[38;2;80;200;180m";
export const SORTIE_SUMMARY_COLOR = TOOLS_COLOR;
export const TASKFORCE_BADGE_RGB: [number, number, number] = [100, 180, 255];
export const TASKFORCE_BADGE_COLOR = `\x1b[38;2;${TASKFORCE_BADGE_RGB[0]};${TASKFORCE_BADGE_RGB[1]};${TASKFORCE_BADGE_RGB[2]}m`;

export const SYM_INDICATOR = "⏺";
export const SYM_RESULT = "⎿";
export const SYM_THINKING = "◇";

export const DEFAULT_BODY_H = 6;
export const MIN_BODY_H = 4;
export const MAX_BODY_H = 50;
export const BODY_H_STEP = 2;
