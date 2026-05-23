import { CarrierStatusOverlay } from "./overlay.js";
import type { CarrierStatusContext } from "./types.js";

export function createCarrierStatusKeybindingHandler(ctx: CarrierStatusContext): () => void {
  return () => {
    if (ctx.fleetPty.hasActiveOverlay()) {
      ctx.fleetPty.popOverlay();
    }
    void ctx.fleetPty.custom<void>((ui, theme, _keys, done) => new CarrierStatusOverlay({
      carrierRuntime: ctx.carrierRuntime,
      done,
      fleetPty: ctx.fleetPty,
      requestRender: () => ui.requestRender(),
      theme,
    }));
  };
}
