import { CarrierStatusOverlay } from "./overlay.js";
import type { CarrierStatusContext } from "./types.js";
import { CARRIER_STATUS_KEY, registerKeybinding } from "../input/keybindings.js";

export function registerCarrierStatusKeybinding(ctx: CarrierStatusContext): void {
  registerKeybinding({
    action: "carrier-status",
    handler: () => {
      if (ctx.fleetPty.hasActiveOverlay()) {
        ctx.fleetPty.popOverlay();
      }

      ctx.rt.admiral.agent.serviceStatus.refresh();
      void ctx.fleetPty.custom<void>((ui, theme, _keys, done) => new CarrierStatusOverlay({
        done,
        fleetPty: ctx.fleetPty,
        requestRender: () => ui.requestRender(),
        rt: ctx.rt,
        theme,
      }));
    },
    key: CARRIER_STATUS_KEY,
  });
}
