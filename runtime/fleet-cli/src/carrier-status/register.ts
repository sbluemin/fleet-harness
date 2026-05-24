import { CarrierStatusOverlay } from "./overlay.js";
import { MISSION_CONTROL_THEME } from "../mission-control/renderer.js";
import { TaskForceConfigOverlay } from "./taskforce-overlay.js";
import type { CarrierStatusContext } from "./types.js";

export function createCarrierStatusKeybindingHandler(ctx: CarrierStatusContext): () => void {
  return () => {
    if (ctx.missionControl.hasActivePanel()) {
      ctx.missionControl.closePanel();
      return;
    }
    ctx.missionControl.openPanel({
      component: createCarrierStatusPanel(ctx),
      id: "carrier-status",
    });
  };
}

export function createCarrierStatusPanel(ctx: CarrierStatusContext): CarrierStatusOverlay {
  return new CarrierStatusOverlay({
    carrierRuntime: ctx.carrierRuntime,
    done: ctx.missionControl.closePanel,
    openTaskForceConfig: ({ carrierDisplayName, carrierId }) => {
      ctx.missionControl.openPanel({
        component: new TaskForceConfigOverlay({
          carrierRuntime: ctx.carrierRuntime,
          carrierDisplayName,
          carrierId,
          done: ctx.missionControl.closePanel,
          requestRender: ctx.missionControl.requestRender,
          theme: MISSION_CONTROL_THEME,
        }),
        id: "taskforce-config",
      });
    },
    requestRender: ctx.missionControl.requestRender,
    theme: MISSION_CONTROL_THEME,
  });
}
