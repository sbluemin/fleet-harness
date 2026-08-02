import type { CarrierRuntime } from "@dotobokuri/fleet-carriers";

import {
  createFleetPtyApi,
  createFleetPtyViewport,
  type Component,
  type FleetPtyApi,
  type FleetPtySection,
} from "../controls/index.js";
import { DIM_COLOR } from "../styles/palette.js";
import { paint } from "../styles/index.js";

import { createJobBarSections } from "./job-bar/section.js";
import { createJobBarState, subscribeJobBar, type JobBarState } from "./job-bar/state.js";

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
  readonly onJobBarRenderRequest: () => void;
  readonly requestResize: () => void;
  readonly requestRender: () => void;
}

const BORDER_CHAR = "─";

export class FleetStatusSection implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		return [renderBorder(width, DIM_COLOR)];
	}
}

function renderBorder(width: number, color: string): string {
	if (width <= 0) return "";
	return paint(color, BORDER_CHAR.repeat(width), true);
}

export function createMissionBridgeController(options: CreateMissionBridgeControllerOptions): MissionBridgeController {
  const jobBarState = createJobBarState({
    carrierRuntime: options.carrierRuntime,
    onRenderRequest: options.onJobBarRenderRequest,
  });
  const sections = [
    { component: new FleetStatusSection(), id: "fleet-status-section" },
    ...createJobBarSections(jobBarState),
  ];
  const ptyApi = createFleetPtyApi({
    defaultComponent: createMissionBridgeDefaultComponent(sections),
    sections,
  }, {
    addInputListener: options.addInputListener,
    getColumns: options.getColumns,
    getRows: options.getRows,
    requestResize: options.requestResize,
    requestRender: options.requestRender,
  });
  const component = createFleetPtyViewport(ptyApi);
  let unsubscribeJobBar: (() => void) | undefined;
  let disposed = false;

  return {
    component,
    ptyApi,
    jobBarState,
    start: () => {
      if (disposed || unsubscribeJobBar !== undefined) {
        return;
      }
      unsubscribeJobBar = subscribeJobBar({ jobBarState });
    },
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (unsubscribeJobBar !== undefined) {
        unsubscribeJobBar();
        unsubscribeJobBar = undefined;
        return;
      }
      jobBarState.dispose();
    },
  };
}

function createMissionBridgeDefaultComponent(sections: readonly FleetPtySection[]): Component {
  return {
    desiredHeight(maxRows: number): number {
      return Math.min(maxRows, sections.reduce((sum, section) => sum + (section.component.desiredHeight?.(maxRows) ?? 1), 0));
    },
    invalidate(): void {
      for (const section of sections) {
        section.component.invalidate();
      }
    },
    render(width: number): string[] {
      return sections.flatMap((section) => section.component.render(width));
    },
  };
}
