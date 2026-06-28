import type { RailPanelDescriptor } from "@fleet-console/sdk/rail";

import { usePluginRegistry } from "../plugin-registry.js";

export function useRailPanels(side: "right" = "right"): readonly RailPanelDescriptor[] {
  const { railPanels } = usePluginRegistry();
  return side === "right" ? railPanels.filter((p) => (p.side ?? "right") === "right") : railPanels;
}
