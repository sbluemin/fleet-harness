/**
 * fleet/register.ts — Fleet 역할 facade
 *
 * Fleet 이벤트, 커맨드, 도구, 런타임, Status Overlay owner를 role별 모듈에 위임한다.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { CarrierMap, FleetStatus } from "@sbluemin/fleet-core/admiralty";
import { infra } from "@sbluemin/fleet-core";
import { getState } from "../state.js";
import { registerFleetPiCommands } from "./commands.js";
import { registerFleetPiEvents } from "./events.js";
import { registerFleetPiTools } from "./tools.js";
import { getFleetRuntime } from "./runtime.js";
import { buildFleetPingPayload } from "./status-source.js";
import { getKeybindAPI } from "../../keybinds.js";
import { openFleetStatusOverlay } from "./status-overlay.js";

interface FleetOverlayRuntimeState {
  activeMissionId: string | null;
  activeMissionObjective: string | null;
  carriers: CarrierMap;
  connectionState: "disconnected" | "connecting" | "connected";
  designation: string | null;
  fleetStatus: FleetStatus;
  heartbeatAgeMs: number | null;
  socketPath: string | null;
}

const LOG_SOURCE = "grand-fleet";

let activeStatusPopup: Promise<void> | null = null;

export default function registerFleet(pi: ExtensionAPI): void {
  const state = getState();
  const fleetId = state?.fleetId ?? "unset";
  const socketPath = state?.socketPath ?? "unset";

  infra.log.getLogAPI().info(LOG_SOURCE, `Fleet 모드 초기화: fleetId=${fleetId}, socket=${socketPath}`);
  getFleetRuntime();
  registerFleetStatusOverlayKeybind();
  registerFleetPiCommands(pi);
  registerFleetPiEvents(pi);
  registerFleetPiTools(pi);
}

export function getFleetOverlayRuntimeState(): FleetOverlayRuntimeState {
  const state = getState();
  const runtime = getFleetRuntime();
  const ping = buildFleetPingPayload(state.fleetId ?? "unset");
  return {
    activeMissionId: ping.activeMissionId,
    activeMissionObjective: ping.activeMissionObjective,
    carriers: ping.carriers,
    connectionState: runtime.client?.getState() ?? "disconnected",
    designation: state.designation,
    fleetStatus: ping.fleetStatus,
    heartbeatAgeMs: runtime.lastHeartbeatAt === null ? null : Date.now() - runtime.lastHeartbeatAt,
    socketPath: state.socketPath,
  };
}

function registerFleetStatusOverlayKeybind(): void {
  const keybind = getKeybindAPI();
  keybind.register({
    extension: "grand-fleet",
    action: "status-overlay",
    defaultKey: "alt+g",
    description: "Grand Fleet Status 오버레이",
    category: "Grand Fleet",
    handler: async (ctx) => {
      if (!ctx.hasUI) return;
      if (activeStatusPopup) return;

      activeStatusPopup = openFleetStatusOverlay(ctx);

      try {
        await activeStatusPopup;
      } finally {
        activeStatusPopup = null;
      }
    },
  });
}
