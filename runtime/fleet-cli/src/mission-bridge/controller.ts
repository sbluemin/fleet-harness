import {
  createFleetPtyApi,
  createFleetPtyViewport,
  type Component,
  type FleetPtySection,
} from "../controls/index.js";
import { FleetStatusSection } from "./fleet-status-section.js";
import { sanitizeCarrierResultReminder, subscribeJobBar } from "./job-bar/register.js";
import { createJobBarSections } from "./job-bar/section.js";
import { createJobBarState } from "./job-bar/state.js";
import type { CreateMissionBridgeControllerOptions, MissionBridgeController } from "./types.js";

export function createMissionBridgeController(options: CreateMissionBridgeControllerOptions): MissionBridgeController {
  const jobBarState = createJobBarState({
    carrierRuntime: options.carrierRuntime,
    onCarrierResultReminder: options.onCarrierResultReminder === undefined
      ? undefined
      : (text) => options.onCarrierResultReminder?.(sanitizeCarrierResultReminder(text)),
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
