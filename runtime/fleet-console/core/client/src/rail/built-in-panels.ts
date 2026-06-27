import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { alertsPanel } from "./alerts-panel.js";

export const BUILT_IN_RAIL_PANELS: readonly RailPanelDescriptor[] = [alertsPanel];
