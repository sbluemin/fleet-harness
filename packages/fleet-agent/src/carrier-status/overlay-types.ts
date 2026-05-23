import type { CarrierRuntime } from "@sbluemin/fleet-carriers";
import type { FleetPtyApi, FleetPtyTheme } from "@sbluemin/fleet-tui/pty";

import type { CarrierCliType, CarrierStatusEntry } from "./types.js";

export interface CarrierStatusOverlayOptions {
  readonly carrierRuntime: CarrierRuntime;
  readonly done: () => void;
  readonly fleetPty: FleetPtyApi;
  readonly requestRender: () => void;
  readonly theme: FleetPtyTheme;
}

export interface EntrySnapshot {
  readonly cliType: CarrierCliType;
  readonly effort: string | null;
  readonly isDefault: boolean;
  readonly model: string;
}

export interface GroupedEntries {
  readonly color: string;
  readonly entries: CarrierStatusEntry[];
  readonly header: string;
}

export interface RenameState {
  readonly carrierId: string;
  readonly draft: string;
}

export interface StatusOverlayViewModel {
  readonly flatEntries: CarrierStatusEntry[];
  readonly groupedEntries: GroupedEntries[];
  readonly selectedCarrierId: string | null;
}
