import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { alertsPanel } from "./alerts-panel.js";
import { codexPanel } from "./codex-panel.js";
import { plansPanel } from "./plans-panel.js";

export const BUILT_IN_RAIL_PANELS: readonly RailPanelDescriptor[] = [alertsPanel, codexPanel, plansPanel];
