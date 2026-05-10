/**
 * fleet — 공용 상수
 *
 * Carrier 프레임워크 및 기본 구현에서 공유되는 상수입니다.
 */

import { CLI_BACKENDS, getProviderModels } from "@sbluemin/fleet-unified-agent";
import type { CliType } from "@sbluemin/fleet-unified-agent";

// ─── CLI 표시 이름 ───────────────────────────────────────

export const CLI_PROVIDER_DISPLAY_NAMES: Record<CliType, string> = Object.fromEntries(
  Object.keys(CLI_BACKENDS).map((cliType) => [
    cliType,
    getProviderModels(cliType as CliType).name,
  ]),
) as Record<CliType, string>;

export const CARRIER_DISPLAY_NAMES: Record<string, string> = {
  genesis: "Genesis",
  sentinel: "Sentinel",
  vanguard: "Vanguard",
};

export const CLI_DISPLAY_NAMES: Record<string, string> = {
  ...CLI_PROVIDER_DISPLAY_NAMES,
  ...CARRIER_DISPLAY_NAMES,
};

export const CLI_TYPE_DISPLAY_ORDER: Record<CliType, number> = Object.fromEntries(
  Object.keys(CLI_BACKENDS).map((cliType, index) => [cliType, index]),
) as Record<CliType, number>;

export const VALID_CLI_TYPES = new Set<CliType>(Object.keys(CLI_BACKENDS) as CliType[]);

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

// ─── Carrier 스타일 ──────────────────────────────────────

/** Carrier별 RGB 원천값 */
export const CARRIER_RGBS: Record<string, [number, number, number]> = Object.fromEntries(
  Object.entries(CLI_BACKENDS).map(([cliType, backend]) => [
    cliType,
    [...backend.colorRgb],
  ]),
) as Record<string, [number, number, number]>;

/** Carrier별 입력창 상하단 라인 색상 (ANSI 24-bit RGB) */
export const CARRIER_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(CLI_BACKENDS).map(([cliType, backend]) => {
    const [r, g, b] = backend.colorRgb;
    return [cliType, rgb(r, g, b)];
  }),
) as Record<string, string>;

/** Carrier별 응답 배경색 (은은한 톤 — 다크 테마 기준) */
export const CARRIER_BG_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries(CLI_BACKENDS).map(([cliType, backend]) => {
    const [r, g, b] = backend.bgColorRgb;
    return [cliType, bgRgb(r, g, b)];
  }),
) as Record<string, string>;

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

/** Sortie 도구 요약 색상 (기존 Squadron renderCall 색상 계승) */
export const SORTIE_SUMMARY_COLOR = TOOLS_COLOR;

/** Task Force 배지/도구 요약 색상 */
export const TASKFORCE_BADGE_COLOR = "\x1b[38;2;100;180;255m";

/** Squadron 배지/도구 요약 색상 */
export const SQUADRON_BADGE_COLOR = "\x1b[38;2;180;140;255m";

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

// ─── Fleet Bridge 힌트 ──────────────────────────────────

/** Fleet Bridge 멀티컬럼 뷰 하단 힌트 */
export const PANEL_MULTI_COL_HINT = " ctrl+enter detail · alt+j/k · alt+p ";

/** Fleet Bridge 상세 뷰 하단 힌트 */
export const PANEL_DETAIL_HINT = " ctrl+enter back · alt+j/k · alt+p ";

/** 패널 높이 표시를 포함한 멀티컬럼 뷰 하단 힌트 */
export function formatPanelMultiColHint(bodyH?: number): string {
  return bodyH === undefined
    ? PANEL_MULTI_COL_HINT
    : `${PANEL_MULTI_COL_HINT}[h=${bodyH}]`;
}

function rgb(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bgRgb(r: number, g: number, b: number): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}
