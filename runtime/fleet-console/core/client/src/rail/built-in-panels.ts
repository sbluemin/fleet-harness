import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { codexPanel } from "./codex-panel.js";

export const BUILT_IN_RAIL_PANELS: readonly RailPanelDescriptor[] = [codexPanel];
