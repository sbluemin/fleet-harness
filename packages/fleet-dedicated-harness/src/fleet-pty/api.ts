import { createOverlayManager } from "./overlay-manager.js";
import { createRegionStack } from "./region-stack.js";
import type { FleetPtyOverlay, FleetPtyRegion, FleetPtySection } from "./types.js";

export interface FleetPtyApi {
  readonly getCurrentRegion: () => FleetPtyRegion;
  readonly getSections: () => FleetPtySection[];
  readonly mountSection: (section: FleetPtySection) => void;
  readonly popOverlay: () => FleetPtyRegion;
  readonly pushOverlay: (overlay: FleetPtyOverlay) => FleetPtyRegion;
  readonly replaceRegion: (region: FleetPtyRegion) => FleetPtyRegion;
}

export function createFleetPtyApi(defaultRegion: FleetPtyRegion, sections: FleetPtySection[]): FleetPtyApi {
  const overlays = createOverlayManager();
  const regions = createRegionStack(defaultRegion);
  const mountedSections = [...sections];

  return {
    getCurrentRegion: () => regions.current(),
    getSections: () => [...mountedSections],
    mountSection: (section) => {
      mountedSections.push(section);
    },
    popOverlay: () => {
      overlays.unmount();
      return regions.pop();
    },
    pushOverlay: (overlay) => {
      overlays.mount(overlay);
      return regions.push({ component: overlay.component, id: overlay.id });
    },
    replaceRegion: (region) => regions.replace(region),
  };
}

