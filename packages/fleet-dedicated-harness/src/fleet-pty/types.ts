import type { Component } from "../tui/types.js";

export interface FleetPtyRegion {
  readonly id: string;
  readonly component: Component;
}

export interface FleetPtyOverlay {
  readonly id: string;
  readonly component: Component;
  readonly dispose?: () => void;
}

export interface FleetPtySection {
  readonly id: string;
  readonly component: Component;
}

