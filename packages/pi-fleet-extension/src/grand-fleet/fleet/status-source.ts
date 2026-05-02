import {
  buildFleetPingPayloadFromState,
  type FleetFrameworkLikeState,
  type FleetPingPayload,
  type FleetId,
  type StreamStoreLikeState,
} from "@sbluemin/fleet-core/admiralty";

import { getGrandFleetStreamStoreState } from "../../agent/ui/panel/state.js";
import { getState } from "../state.js";

const CARRIER_FRAMEWORK_KEY = "__pi_bridge_framework__";

export function buildFleetPingPayload(fleetId: FleetId): FleetPingPayload {
  const state = getState();
  return buildFleetPingPayloadFromState({
    fleetId,
    framework: getFleetFrameworkState(),
    mission: {
      activeMissionId: state.activeMissionId,
      activeMissionObjective: state.activeMissionObjective,
    },
    streams: getStreamStoreState(),
    uptime: Math.floor(process.uptime()),
  });
}

function getFleetFrameworkState(): FleetFrameworkLikeState {
  return ((globalThis as any)[CARRIER_FRAMEWORK_KEY] ?? {}) as FleetFrameworkLikeState;
}

function getStreamStoreState(): StreamStoreLikeState {
  return getGrandFleetStreamStoreState();
}
