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
      disposeOverlay(currentOverlay);
      currentOverlay = overlay;
      return overlay;
    },
    unmount: () => {
      const previous = currentOverlay;
      disposeOverlay(previous);
      currentOverlay = undefined;
      return previous;
    },
  };
}

function disposeOverlay(overlay: FleetPtyOverlay | undefined): void {
  overlay?.dispose?.();
  overlay?.component.dispose?.();
}
