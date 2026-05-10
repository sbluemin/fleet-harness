import {
  buildFleetPingPayloadFromState,
  type FleetPingPayload,
  type FleetId,
  type StreamStoreLikeState,
} from "@sbluemin/fleet-core/admiralty";
import { getCarrierFrameworkState } from "../../fleet-core-facades.js";

import { getGrandFleetStreamStoreState } from "../../panel/state.js";
import { getState } from "../state.js";

export function buildFleetPingPayload(fleetId: FleetId): FleetPingPayload {
  const state = getState();
  return buildFleetPingPayloadFromState({
    fleetId,
    framework: getCarrierFrameworkState(),
    mission: {
      activeMissionId: state.activeMissionId,
      activeMissionObjective: state.activeMissionObjective,
    },
    streams: getStreamStoreState(),
    uptime: Math.floor(process.uptime()),
  });
}

function getStreamStoreState(): StreamStoreLikeState {
  return getGrandFleetStreamStoreState();
}
