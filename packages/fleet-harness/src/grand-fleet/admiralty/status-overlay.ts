/**
 * admiralty/status-overlay.ts — Admiralty 상태 오버레이
 *
 * Admiral of the Navy (대원수)에게 상신할 연결 함대 현황을 상황판 형태로 표시한다.
 */
import type { Theme } from "@sbluemin/fleet-coding-agent";
import type { ExtensionContext } from "@sbluemin/fleet-coding-agent";
import type { Component, Focusable, TUI } from "@sbluemin/fleet-tui";
import { Key, matchesKey } from "@sbluemin/fleet-tui";

import { stripControlChars } from "@sbluemin/fleet-core/admiralty";
import {
  HEARTBEAT_TIMEOUT_MS,
  PROTOCOL_VERSION,
  type CarrierMap,
  type CarrierStatus,
  type ConnectedFleet,
  type FleetStatus,
} from "@sbluemin/fleet-core/admiralty";
import { getState } from "../state.js";
import { createOverlayFrame } from "../../carrier-status/frame.js";
import { getFleetRegistry } from "./register.js";

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[38;2;120;120;120m";
const ANSI_MUTED = "\x1b[38;2;150;150;170m";
const ANSI_ALERT = "\x1b[38;2;255;200;90m";
const ANSI_ACTIVE = "\x1b[38;2;80;220;120m";
const ANSI_ERROR = "\x1b[38;2;255;100;90m";
const ANSI_IDLE = "\x1b[38;2;100;180;255m";
const ANSI_STANDBY = "\x1b[38;2;180;150;255m";
const ANSI_DONE = "\x1b[38;2;120;220;180m";
const ANSI_UNAVAILABLE = "\x1b[38;2;170;170;170m";
const ANSI_TF = "\x1b[38;2;100;180;255m";
const REFRESH_INTERVAL_MS = 30_000;

const FLEET_STATUS_ICONS: Record<FleetStatus, string> = {
  idle: `${ANSI_IDLE}⚓${ANSI_RESET}`,
  active: `${ANSI_ACTIVE}⚔${ANSI_RESET}`,
  error: `${ANSI_ERROR}🔥${ANSI_RESET}`,
};

const CARRIER_STATUS_ICONS: Record<CarrierStatus, string> = {
  active: `${ANSI_ACTIVE}⚔${ANSI_RESET}`,
  idle: `${ANSI_IDLE}⚓${ANSI_RESET}`,
  standby: `${ANSI_STANDBY}◈${ANSI_RESET}`,
  done: `${ANSI_DONE}✓${ANSI_RESET}`,
  error: `${ANSI_ERROR}🔥${ANSI_RESET}`,
  unavailable: `${ANSI_UNAVAILABLE}○${ANSI_RESET}`,
};

export async function openAdmiraltyStatusOverlay(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new AdmiraltyStatusOverlay(tui as any, theme, done),
    {
      overlay: true,
      overlayOptions: {
        width: "70%",
        maxHeight: "70%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

class AdmiraltyStatusOverlay implements Component, Focusable {
  focused = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;

  private selectedIndex = 0;
  private scrollOffset = 0;
  private readonly expandedFleetIds = new Set<string>();
  private readonly refreshTimer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: (() => void) | null;

  constructor(tui: TUI, theme: Theme, done: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.refreshTimer = setInterval(() => {
      this.tui.requestRender();
    }, REFRESH_INTERVAL_MS);
    this.unsubscribe = getFleetRegistry()?.onChange(() => {
      this.clampSelection();
      this.tui.requestRender();
    }) ?? null;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("g"))) {
      this.done();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.tab)) {
      this.toggleExpanded();
      return;
    }
    if (data === "r") {
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const state = getState();
    const fleets = this.getSortedFleets();
    const frame = createOverlayFrame(this.theme, Math.max(60, width), " Grand Fleet Status ", ANSI_RESET);
    const lines: string[] = [];
    const availableRows = this.getAvailableFleetRows();
    const { hiddenAbove, hiddenBelow, visibleFleets } = this.getVisibleWindow(fleets, availableRows);

    lines.push(frame.topBorder);
    lines.push(frame.emptyRow());
    lines.push(frame.row(`  Role               admiralty`));
    lines.push(frame.row(`  Protocol Version   ${PROTOCOL_VERSION}`));
    lines.push(frame.row(`  Socket Path        ${state.socketPath ?? "(unset)"}`));
    lines.push(frame.row(`  Connected Fleets   ${String(fleets.length)}`));
    lines.push(frame.emptyRow());
    lines.push(frame.separator());
    lines.push(frame.row(`  Fleet Roster ${ANSI_DIM}[${this.selectedIndex + 1}/${Math.max(fleets.length, 1)}]${ANSI_RESET}`));
    lines.push(frame.emptyRow());

    if (fleets.length === 0) {
      lines.push(frame.row(`  ${ANSI_DIM}연결된 Fleet이 없습니다.${ANSI_RESET}`));
      lines.push(frame.emptyRow());
    } else {
      for (const fleet of visibleFleets) {
        const isSelected = fleets[this.selectedIndex]?.id === fleet.id;
        const prefix = isSelected ? `${ANSI_IDLE}▸${ANSI_RESET}` : " ";
        const fleetId = stripControlChars(`${fleet.designation} (${fleet.id})`);
        const zone = shortenText(
          stripControlChars(fleet.operationalZone),
          Math.max(16, frame.innerWidth - 24),
        );
        const statusIcon = FLEET_STATUS_ICONS[fleet.status] ?? FLEET_STATUS_ICONS.idle;
        lines.push(frame.row(`  ${prefix} ${statusIcon} ${fleetId}  ${ANSI_MUTED}${zone}${ANSI_RESET}`));

        if (this.expandedFleetIds.has(fleet.id)) {
          lines.push(frame.row(`      Mission    ${stripControlChars(fleet.activeMissionObjective ?? "(idle)")}`));
          lines.push(frame.row(`      Mission ID ${stripControlChars(fleet.activeMissionId ?? "-")}`));
          for (const carrierLine of buildCarrierLines(fleet.carriers)) {
            lines.push(frame.row(`      ${carrierLine}`));
          }
          const ageMs = Date.now() - fleet.lastHeartbeat;
          const warn = ageMs >= HEARTBEAT_TIMEOUT_MS ? ` ${ANSI_ALERT}⚠${ANSI_RESET}` : "";
          lines.push(frame.row(`      Heartbeat  ${formatAge(ageMs)}${warn}`));
        }
      }

      if (hiddenAbove > 0) {
        lines.push(frame.row(`  ${ANSI_DIM}↑ 더 위에 ${hiddenAbove}개${ANSI_RESET}`));
      }
      if (hiddenBelow > 0) {
        lines.push(frame.row(`  ${ANSI_DIM}↓ 더 아래에 ${hiddenBelow}개${ANSI_RESET}`));
      }
      lines.push(frame.emptyRow());
    }

    lines.push(frame.separator());
    lines.push(frame.row(`  ${ANSI_DIM}↑↓ 선택  Tab 확장  r 새로고침  Esc 닫기${ANSI_RESET}`));
    lines.push(frame.bottomBorder);
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.refreshTimer);
    this.unsubscribe?.();
  }

  private getSortedFleets(): ConnectedFleet[] {
    return Array.from(getState().connectedFleets.values()).sort((a, b) => {
      const aRank = a.status === "active" ? 0 : a.status === "error" ? 1 : 2;
      const bRank = b.status === "active" ? 0 : b.status === "error" ? 1 : 2;
      if (aRank !== bRank) return aRank - bRank;
      return a.id.localeCompare(b.id);
    });
  }

  private moveSelection(delta: number): void {
    const fleets = this.getSortedFleets();
    if (fleets.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(fleets.length - 1, this.selectedIndex + delta));
    this.scrollOffset = Math.min(this.scrollOffset, this.selectedIndex);
    this.tui.requestRender();
  }

  private toggleExpanded(): void {
    const fleet = this.getSortedFleets()[this.selectedIndex];
    if (!fleet) return;
    if (this.expandedFleetIds.has(fleet.id)) {
      this.expandedFleetIds.delete(fleet.id);
    } else {
      this.expandedFleetIds.add(fleet.id);
    }
    this.tui.requestRender();
  }

  private clampSelection(): void {
    const fleets = this.getSortedFleets();
    if (fleets.length === 0) {
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      return;
    }
    this.selectedIndex = Math.min(this.selectedIndex, fleets.length - 1);
    this.scrollOffset = Math.min(this.scrollOffset, this.selectedIndex);
  }

  private getAvailableFleetRows(): number {
    const rows = this.tui.terminal?.rows ?? 40;
    return Math.max(4, rows - 20);
  }

  private getVisibleWindow(
    fleets: ConnectedFleet[],
    availableRows: number,
  ): { hiddenAbove: number; hiddenBelow: number; visibleFleets: ConnectedFleet[] } {
    if (fleets.length === 0) {
      return { hiddenAbove: 0, hiddenBelow: 0, visibleFleets: [] };
    }

    let start = Math.min(this.scrollOffset, this.selectedIndex);
    let end = start;
    let usedRows = 0;

    while (end < fleets.length) {
      const rowCount = getFleetRenderRowCount(fleets[end], this.expandedFleetIds.has(fleets[end].id));
      if (end > start && usedRows + rowCount > availableRows) {
        break;
      }
      usedRows += rowCount;
      end++;
      if (usedRows >= availableRows) {
        break;
      }
    }

    if (this.selectedIndex < start || this.selectedIndex >= end) {
      start = this.selectedIndex;
      end = start;
      usedRows = 0;
      while (end < fleets.length) {
        const rowCount = getFleetRenderRowCount(fleets[end], this.expandedFleetIds.has(fleets[end].id));
        if (end > start && usedRows + rowCount > availableRows) {
          break;
        }
        usedRows += rowCount;
        end++;
        if (usedRows >= availableRows) {
          break;
        }
      }
    }

    while (start > 0) {
      const previousRows = getFleetRenderRowCount(
        fleets[start - 1],
        this.expandedFleetIds.has(fleets[start - 1].id),
      );
      if (usedRows + previousRows > availableRows) {
        break;
      }
      start--;
      usedRows += previousRows;
    }

    this.scrollOffset = start;
    return {
      hiddenAbove: start,
      hiddenBelow: fleets.length - end,
      visibleFleets: fleets.slice(start, end),
    };
  }
}

function buildCarrierLines(carriers: CarrierMap): string[] {
  const entries = Object.entries(carriers);
  if (entries.length === 0) {
    return [`Carriers   ${ANSI_DIM}(none)${ANSI_RESET}`];
  }

  return entries.map(([name, info], index) => {
    const label = index === 0 ? "Carriers   " : "           ";
    const icon = CARRIER_STATUS_ICONS[info.status] ?? CARRIER_STATUS_ICONS.idle;
    const tfBadge = info.tfConfigured ? ` ${ANSI_TF}[TF]${ANSI_RESET}` : "";
    return `${label}${icon} ${stripControlChars(name)}${tfBadge}`;
  });
}

function getFleetRenderRowCount(fleet: ConnectedFleet, expanded: boolean): number {
  if (!expanded) {
    return 1;
  }

  return 4 + Math.max(1, Object.keys(fleet.carriers).length);
}

function formatAge(ms: number): string {
  if (ms < 1_000) return "방금";
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s 전`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}m ${remain}s 전`;
}

function shortenText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, maxWidth);
  return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
}
