import type { CarrierRuntime } from "@dotobokuri/fleet-carriers";

import type { Component, FleetPtyApi } from "../controls/index.js";
import type { JobBarState } from "./job-bar/state.js";

export interface MissionBridgeController {
  readonly component: Component;
  readonly ptyApi: FleetPtyApi;
  readonly jobBarState: JobBarState;
  start(): void;
  dispose(): void;
}

export interface CreateMissionBridgeControllerOptions {
  readonly addInputListener: (listener: (data: string) => void) => () => void;
  readonly carrierRuntime: CarrierRuntime;
  readonly getColumns: () => number;
  readonly getRows: () => number;
  readonly onCarrierResultReminder?: (text: string) => void;
  readonly onJobBarRenderRequest: () => void;
  readonly requestResize: () => void;
  readonly requestRender: () => void;
}
