import type { CarrierRuntime } from "@dotobokuri/fleet-carriers";

import type { MenuPanel, PanelStack } from "../menu/panel-stack.js";
import { MISSION_CONTROL_THEME } from "../renderer.js";
import { CarrierStatusOverlay } from "./panel.js";
import { createTaskForcePanel } from "./taskforce-panel.js";

export interface CreateCarrierRosterPanelOptions {
  readonly carrierRuntime: CarrierRuntime;
  readonly closePanel: () => void;
  readonly getStack: () => PanelStack;
  readonly requestRender: () => void;
}

export function createCarrierRosterPanel(options: CreateCarrierRosterPanelOptions): MenuPanel {
  const component = new CarrierStatusOverlay({
    carrierRuntime: options.carrierRuntime,
    done: options.closePanel,
    openTaskForcePanel: ({ carrierDisplayName, carrierId }) => {
      const stack = options.getStack();
      stack.push(createTaskForcePanel({
        carrierRuntime: options.carrierRuntime,
        carrierDisplayName,
        carrierId,
        done: () => {
          stack.pop();
          options.requestRender();
        },
        requestRender: options.requestRender,
        theme: MISSION_CONTROL_THEME,
      }));
    },
    requestRender: options.requestRender,
    theme: MISSION_CONTROL_THEME,
  });

  return {
    id: "carrier-roster",
    title: "Carrier Roster",
    handleInput(data): boolean {
      component.handleInput(data);
      return true;
    },
    getFocusLine({ width }): number | undefined {
      return component.getFocusLine?.(width);
    },
    render({ width }): readonly string[] {
      return component.render(width);
    },
  };
}
