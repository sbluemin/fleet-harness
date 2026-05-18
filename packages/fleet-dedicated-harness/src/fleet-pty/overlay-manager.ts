import type { FleetPtyOverlay } from "./types.js";

export interface OverlayManager {
  readonly current: () => FleetPtyOverlay | undefined;
  readonly mount: (overlay: FleetPtyOverlay) => FleetPtyOverlay;
  readonly unmount: () => FleetPtyOverlay | undefined;
}

export function createOverlayManager(): OverlayManager {
  let currentOverlay: FleetPtyOverlay | undefined;

  return {
    current: () => currentOverlay,
    mount: (overlay) => {
      currentOverlay?.dispose?.();
      currentOverlay = overlay;
      return overlay;
    },
    unmount: () => {
      const previous = currentOverlay;
      previous?.dispose?.();
      currentOverlay = undefined;
      return previous;
    },
  };
}

