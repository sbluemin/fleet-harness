import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey } from "@mariozechner/pi-tui";

import { stripControlChars } from "@sbluemin/fleet-core/admiralty";
import { getState } from "../state.js";
import { createOverlayFrame } from "../../carrier-status/frame.js";
import { getFleetOverlayRuntimeState } from "./register.js";

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[38;2;120;120;120m";
const ANSI_OK = "\x1b[38;2;80;220;120m";
const ANSI_WARN = "\x1b[38;2;255;200;90m";
const ANSI_IDLE = "\x1b[38;2;100;180;255m";
const REFRESH_INTERVAL_MS = 30_000;

export async function openFleetStatusOverlay(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new FleetStatusOverlay(tui as any, theme, done),
    {
      overlay: true,
      overlayOptions: {
        width: "60%",
        maxHeight: "55%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

class FleetStatusOverlay implements Component, Focusable {
  focused = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly refreshTimer: ReturnType<typeof setInterval>;

  constructor(tui: TUI, theme: Theme, done: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.refreshTimer = setInterval(() => {
      this.tui.requestRender();
    }, REFRESH_INTERVAL_MS);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.alt("g"))) {
      this.done();
      return;
    }
    if (data === "r") {
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const state = getState();
    const runtime = getFleetOverlayRuntimeState();
    const frame = createOverlayFrame(this.theme, Math.max(56, width), " Fleet Status ", ANSI_RESET);
    const isConnected = runtime.connectionState === "connected";
    const missionStatus = runtime.activeMissionId ? "Active" : "Idle";
    const connectionLabel = isConnected
      ? `${ANSI_OK}Connected${ANSI_RESET}`
      : `${ANSI_WARN}Disconnected${ANSI_RESET}`;
    const heartbeat = !isConnected
      ? `${ANSI_DIM}연결 대기 중${ANSI_RESET}`
      : runtime.heartbeatAgeMs === null
        ? `${ANSI_DIM}아직 heartbeat 없음${ANSI_RESET}`
        : `${runtime.heartbeatAgeMs < 90_000 ? ANSI_OK : ANSI_WARN}${formatAge(runtime.heartbeatAgeMs)}${ANSI_RESET}`;

    const lines: string[] = [];
    lines.push(frame.topBorder);
    lines.push(frame.emptyRow());
    lines.push(frame.row(`  Connection`));
    lines.push(frame.row(`    Role            ${state.role ?? "fleet"}`));
    lines.push(frame.row(`    Fleet ID        ${state.fleetId ?? "(unset)"}`));
    lines.push(frame.row(`    Designation     ${stripControlChars(runtime.designation ?? "(unset)")}`));
    lines.push(frame.row(`    Admiralty/F.Adm ${connectionLabel}`));
    lines.push(frame.row(`    Socket Path     ${runtime.socketPath ?? "(unset)"}`));
    lines.push(frame.emptyRow());
    lines.push(frame.separator());
    lines.push(frame.row(`  Mission`));

    if (isConnected) {
      lines.push(frame.row(`    Status          ${runtime.activeMissionId ? ANSI_OK : ANSI_IDLE}${missionStatus}${ANSI_RESET}`));
      lines.push(frame.row(`    Objective       ${stripControlChars(runtime.activeMissionObjective ?? "(idle)")}`));
      lines.push(frame.row(`    Mission ID      ${stripControlChars(runtime.activeMissionId ?? "-")}`));
    } else {
      lines.push(frame.row(`    ${ANSI_DIM}PI_GRAND_FLEET_SOCK 설정 또는 /fleet:grand-fleet:settings 로 Admiralty에 연결하세요.${ANSI_RESET}`));
    }

    lines.push(frame.emptyRow());
    lines.push(frame.separator());
    lines.push(frame.row(`  Stats`));
    lines.push(frame.row(`    Heartbeat       ${heartbeat}`));
    lines.push(frame.row(`    Fleet Status    ${runtime.fleetStatus}`));
    lines.push(frame.row(`    Carrier Count   ${String(Object.keys(runtime.carriers).length)}`));
    lines.push(frame.emptyRow());
    lines.push(frame.separator());
    lines.push(frame.row(`  ${ANSI_DIM}r 새로고침  Esc 닫기${ANSI_RESET}`));
    lines.push(frame.bottomBorder);
    return lines;
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.refreshTimer);
  }
}

function formatAge(ms: number): string {
  if (ms < 1_000) return "방금";
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return `${minutes}m ${remain}s`;
}
