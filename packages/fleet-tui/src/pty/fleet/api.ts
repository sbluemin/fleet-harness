import { Key, matchesKey } from "./keys.js";
import { createFleetPtyLocalUi, type FleetPtyLocalUiOptions } from "./local-ui.js";
import { createOverlayManager } from "./overlay-manager.js";
import { createRegionStack } from "./region-stack.js";
import { createFleetPtyTheme } from "./theme.js";
import type { Component } from "./component.js";
import type {
  FleetPtyCustomFactory,
  FleetPtyCustomOptions,
  FleetPtyOverlay,
  FleetPtyRegion,
  FleetPtySection,
} from "./types.js";
import { centerLine, fitLine, truncateToWidth, visibleWidth } from "../../primitives/cell-width.js";
import type { RoutedMouseInput } from "../../input/input-router.js";

export { createOverlayFrame } from "./frame.js";
export { isPrintable, matchesKey, Key } from "./keys.js";
export { centerLine, fitLine, truncateToWidth, visibleWidth };
export type { Component, Focusable } from "./component.js";
export type { FleetPtyTheme } from "./theme.js";
export type {
  FleetPtyCustomFactory,
  FleetPtyCustomOptions,
  FleetPtyOverlay,
  FleetPtyRegion,
  FleetPtySection,
} from "./types.js";

export interface CreateFleetPtyApiOptions {
  readonly defaultComponent: Component;
  readonly sections?: readonly FleetPtySection[];
}

export interface FleetPtyApi {
  readonly custom: <T>(factory: FleetPtyCustomFactory<T>, opts?: FleetPtyCustomOptions) => Promise<T>;
  readonly dispatchInput: (data: string) => boolean;
  readonly dispatchMouse: (event: RoutedMouseInput) => boolean;
  readonly getCurrentRegion: () => FleetPtyRegion;
  readonly getDesiredHeight: (maxRows: number) => number | undefined;
  readonly getSections: () => FleetPtySection[];
  readonly hasActiveOverlay: () => boolean;
  readonly mountSection: (section: FleetPtySection) => void;
  readonly popOverlay: () => FleetPtyRegion;
  readonly pushOverlay: (overlay: FleetPtyOverlay) => FleetPtyRegion;
  readonly replaceRegion: (region: FleetPtyRegion) => FleetPtyRegion;
}

export function createFleetPtyApi(
  options: CreateFleetPtyApiOptions,
  localUiOptions: FleetPtyLocalUiOptions,
): FleetPtyApi {
  const mountedSections = [...(options.sections ?? [])];
  const defaultRegion = {
    component: options.defaultComponent,
    id: "default-fleet-region",
  };
  const overlays = createOverlayManager();
  const regions = createRegionStack(defaultRegion);
  const localUi = createFleetPtyLocalUi(localUiOptions);
  const theme = createFleetPtyTheme();
  let closeActive: (() => void) | undefined;

  return {
    custom: async (factory, opts = { overlay: false }) => {
      void opts;
      return new Promise((resolve, reject) => {
        let mounted = false;
        let settled = false;
        const finish = (result: unknown, resolveResult: boolean) => {
          if (settled) {
            return;
          }

          settled = true;
          closeActive = undefined;
          overlays.unmount();
          if (mounted) {
            regions.pop();
          }
          notifyLayoutChange(localUi);
          if (resolveResult) {
            resolve(result as never);
          } else {
            reject(result);
          }
        };
        const done = (result: unknown) => finish(result, true);

        closeActive = () => done(undefined);
        Promise.resolve(factory(localUi, theme, { Key, matchesKey }, done))
          .then((component) => {
            mounted = true;
            overlays.mount({ component, id: "custom-overlay" });
            regions.push({ component, id: "custom-overlay" });
            localUi.setFocus(component);
            notifyLayoutChange(localUi);
          })
          .catch((error: unknown) => finish(error, false));
      });
    },
    dispatchInput: (data) => {
      if (regions.isDefault()) {
        return false;
      }

      regions.current().component.handleInput?.(data);
      return true;
    },
    dispatchMouse: (event) => {
      if (regions.isDefault()) {
        return true;
      }

      const result = regions.current().component.handleMouse?.(event);
      return result !== false;
    },
    getCurrentRegion: () => regions.current(),
    getDesiredHeight: (maxRows) => regions.current().component.desiredHeight?.(maxRows),
    getSections: () => [...mountedSections],
    hasActiveOverlay: () => !regions.isDefault(),
    mountSection: (section) => {
      mountedSections.push(section);
      defaultRegion.component.invalidate();
    },
    popOverlay: () => {
      if (closeActive) {
        closeActive();
        closeActive = undefined;
        return regions.current();
      }

      closeActive = undefined;
      overlays.unmount();
      const region = regions.pop();
      notifyLayoutChange(localUi);
      return region;
    },
    pushOverlay: (overlay) => {
      overlays.mount(overlay);
      const region = regions.push({ component: overlay.component, id: overlay.id });
      notifyLayoutChange(localUi);
      return region;
    },
    replaceRegion: (region) => {
      const next = regions.replace(region);
      notifyLayoutChange(localUi);
      return next;
    },
  };
}

function notifyLayoutChange(localUi: ReturnType<typeof createFleetPtyLocalUi>): void {
  localUi.requestResize();
  localUi.requestRender();
}
