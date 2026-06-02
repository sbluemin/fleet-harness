import { MISSION_CONTROL_THEME } from "../renderer.js";
import { centerText } from "../welcome.js";
import type { FleetCliRelease, MissionControlCounts } from "../types.js";
import { renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

export interface AboutPanelDeps {
  readonly counts?: MissionControlCounts;
  readonly getRelease: () => FleetCliRelease | undefined;
  readonly stack: PanelStack;
}

export function createAboutPanel(deps: AboutPanelDeps): MenuPanel {
  return {
    id: "fleet-menu:about",
    title: "About",
    render({ width }): readonly string[] {
      const release = deps.getRelease();
      const counts = deps.counts;
      return [
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(deps.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Fleet"), width),
        centerText(formatKeyValue("Version", release?.version ?? "(local)"), width),
        centerText(formatKeyValue("Channel", release?.channel ?? "local"), width),
        "",
        centerText(formatKeyValue("Carriers", String(counts?.carriers ?? 0)), width),
        centerText(formatKeyValue("Wiki entries", String(counts?.wikiEntries ?? 0)), width),
        centerText(formatKeyValue("Queued patches", String(counts?.queuedPatches ?? 0)), width),
        centerText(formatKeyValue("Docs", "(configured later)"), width),
        centerText(formatKeyValue("Node", process.version), width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Esc back"), width),
      ];
    },
  };
}

function formatKeyValue(key: string, value: string): string {
  return `${key}: ${MISSION_CONTROL_THEME.accent(value)}`;
}
