/**
 * admiralty/roster-widget.ts — Grand Fleet 함대 로스터 aboveEditor 위젯
 *
 * Admiralty가 Admiral of the Navy (대원수)에게 보고할 연결 함대들의 상태,
 * 작전 구역, 임무를 실시간으로 표시한다.
 */
import * as os from "node:os";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import { stripControlChars, type ConnectedFleet } from "@sbluemin/fleet-core/admiralty";
import { getState } from "../state.js";

const WIDGET_KEY = "grand-fleet-roster";
const ADMIRALTY_COLOR = "\x1b[38;2;255;200;60m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const MAX_FLEET_ROWS = 8;
const SPINNER_INTERVAL_MS = 120;

// 상태별 색상
const COLOR_IDLE = "\x1b[38;2;100;180;255m";    // 청색
const COLOR_ACTIVE = "\x1b[38;2;80;220;120m";   // 녹색
const COLOR_ERROR = "\x1b[38;2;255;80;80m";     // 적색
const COLOR_ZONE = "\x1b[38;2;140;140;160m";    // 회청색

// 스피너 프레임 (Braille 패턴)
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const STATUS_ICONS: Record<string, string> = {
  idle: `${COLOR_IDLE}⚓${RESET}`,
  error: `${COLOR_ERROR}🔥${RESET}`,
};

const STATUS_NAME_COLORS: Record<string, string> = {
  idle: COLOR_IDLE,
  active: COLOR_ACTIVE,
  error: COLOR_ERROR,
};

let widgetCtx: ExtensionContext | null = null;
let pendingSync = false;
let spinnerFrame = 0;
let spinnerTimer: ReturnType<typeof setInterval> | null = null;

/** 위젯 초기화 — session_start에서 호출 */
export function initRosterWidget(ctx: ExtensionContext): void {
  widgetCtx = ctx;
  applyWidget();
  startSpinner();
}

/** 위젯 해제 — session_shutdown에서 호출 */
export function disposeRosterWidget(): void {
  stopSpinner();
  if (widgetCtx) {
    widgetCtx.ui.setWidget(WIDGET_KEY, undefined);
    widgetCtx = null;
  }
}

function startSpinner(): void {
  if (spinnerTimer) return;
  spinnerTimer = setInterval(() => {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    // 임무 수행 중인 함대가 있을 때만 위젯 재등록
    const state = getState();
    if (!state) return;
    const hasActive = Array.from(state.connectedFleets.values()).some((f) => f.activeMissionId);
    if (hasActive) applyWidget();
  }, SPINNER_INTERVAL_MS);
}

function stopSpinner(): void {
  if (!spinnerTimer) return;
  clearInterval(spinnerTimer);
  spinnerTimer = null;
}

/** 상태 변경 시 위젯 갱신 (microtask 배칭) */
export function syncRosterWidget(): void {
  if (!widgetCtx || pendingSync) return;
  pendingSync = true;
  queueMicrotask(() => {
    pendingSync = false;
    applyWidget();
  });
}

function applyWidget(): void {
  if (!widgetCtx) return;

  widgetCtx.ui.setWidget(WIDGET_KEY, (_tui, _theme) => ({
    render(width: number): string[] {
      return renderRoster(width);
    },
    invalidate() {},
  }), { placement: "aboveEditor" });
}

function renderRoster(width: number): string[] {
  const state = getState();
  const fleets = state ? Array.from(state.connectedFleets.values()) : [];

  const headerText = " Grand Fleet ";
  const dashCount = Math.max(0, width - visibleWidth(headerText) - 6);
  const header = fitLineToWidth(
    `  ${DIM}──${RESET}${ADMIRALTY_COLOR}${headerText}${RESET}${DIM}${"─".repeat(dashCount)}${RESET}`,
    width,
  );

  if (fleets.length === 0) {
    return [fitLineToWidth(`  ${DIM}──${RESET}${ADMIRALTY_COLOR} Grand Fleet ${RESET}${DIM}── 연결된 함대 없음${RESET}`, width)];
  }

  const lines: string[] = [header];
  const home = os.homedir();
  // 임무 수행 중인 함대를 상단에 배치
  const sorted = [...fleets].sort((a, b) => {
    const aActive = a.activeMissionId ? 1 : 0;
    const bActive = b.activeMissionId ? 1 : 0;
    return bActive - aActive;
  });
  const visibleFleets = sorted.slice(0, MAX_FLEET_ROWS);

  // 열 폭 계산 — 전체 함대 기준으로 최대 길이에 맞춤
  const nameCol = Math.min(
    30,
    Math.max(
      8,
      ...visibleFleets.map((f) => visibleWidth(stripControlChars(formatFleetLabel(f)))),
    ),
  );
  const zoneCol = Math.min(
    40,
    Math.max(10, ...visibleFleets.map((f) => visibleWidth(shortenPath(stripControlChars(f.operationalZone), home)))),
  );

  for (const fleet of visibleFleets) {
    lines.push(renderFleetRow(fleet, width, home, nameCol, zoneCol));
  }

  if (fleets.length > MAX_FLEET_ROWS) {
    const overflow = fleets.length - MAX_FLEET_ROWS;
    lines.push(fitLineToWidth(`  ${DIM}  +${overflow} more${RESET}`, width));
  }

  return lines;
}

function renderFleetRow(fleet: ConnectedFleet, width: number, home: string, nameCol: number, zoneCol: number): string {
  const effectiveStatus = fleet.activeMissionId ? "active" : fleet.status;
  const icon = effectiveStatus === "active"
    ? `${COLOR_ACTIVE}${SPINNER_FRAMES[spinnerFrame]}${RESET}`
    : (STATUS_ICONS[effectiveStatus] ?? `${COLOR_IDLE}⚓${RESET}`);
  const nameColor = STATUS_NAME_COLORS[effectiveStatus] ?? COLOR_IDLE;
  const name = fitTextToWidth(stripControlChars(formatFleetLabel(fleet)), nameCol);
  const zone = fitTextToWidth(shortenPath(stripControlChars(fleet.operationalZone), home), zoneCol);
  const mission = fleet.activeMissionObjective
    ? `${ADMIRALTY_COLOR}「${stripControlChars(fleet.activeMissionObjective)}」${RESET}`
    : "";
  const missionSuffix = mission ? `  ${mission}` : "";

  return fitLineToWidth(
    `  ${icon} ${nameColor}${name}${RESET} ${COLOR_ZONE}${zone}${RESET}${missionSuffix}`,
    width,
  );
}

function shortenPath(fullPath: string, home: string): string {
  if (fullPath === home) return "~";
  if (fullPath.startsWith(home + "/")) return "~" + fullPath.slice(home.length);
  return fullPath;
}

function formatFleetLabel(fleet: ConnectedFleet): string {
  return `${fleet.designation} (${fleet.id})`;
}

function fitTextToWidth(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const truncated = visibleWidth(text) > width ? truncateToWidth(text, width) : text;
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function fitLineToWidth(line: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const truncated = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}
