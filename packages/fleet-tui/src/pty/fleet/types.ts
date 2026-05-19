import type { Component, DisposableComponent } from "./component.js";
import type { Key, matchesKey } from "./keys.js";
import type { FleetPtyLocalUi } from "./local-ui.js";
import type { FleetPtyTheme } from "./theme.js";

export interface FleetPtyRegion {
  readonly id: string;
  readonly component: Component;
}

export interface FleetPtyOverlay {
  readonly id: string;
  readonly component: DisposableComponent;
  readonly dispose?: () => void;
}

export interface FleetPtySection {
  readonly id: string;
  readonly component: Component;
}

export interface FleetPtyCustomOptions {
  readonly overlay?: boolean;
}

export interface FleetPtyKeyFacade {
  readonly Key: typeof Key;
  readonly matchesKey: typeof matchesKey;
}

export type FleetPtyCustomFactory<T> = (
  ui: FleetPtyLocalUi,
  theme: FleetPtyTheme,
  keys: FleetPtyKeyFacade,
  done: (result: T) => void,
) => DisposableComponent | Promise<DisposableComponent>;
