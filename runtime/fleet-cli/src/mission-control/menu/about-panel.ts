import { MISSION_CONTROL_THEME } from "../renderer.js";
import { centerText } from "../welcome.js";
import type { FleetCliRelease, MissionControlCounts } from "../types.js";
import { renderBreadcrumbs, type MenuPanel, type PanelStack } from "./panel-stack.js";

export interface AboutPanelDeps {
  readonly counts?: MissionControlCounts;
  readonly release?: FleetCliRelease;
  readonly stack: PanelStack;
}

export function createAboutPanel(deps: AboutPanelDeps): MenuPanel {
  return {
    id: "fleet-menu:about",
    title: "About",
    render({ width }): readonly string[] {
      const release = deps.release;
      const counts = deps.counts;
      return [
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(deps.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Fleet"), width),
        centerText(`Version: ${release?.version ?? "(local)"}`, width),
        centerText(`Channel: ${release?.channel ?? "local"}`, width),
        "",
        centerText(`Carriers: ${counts?.carriers ?? 0}`, width),
        centerText(`Wiki entries: ${counts?.wikiEntries ?? 0}`, width),
        centerText(`Queued patches: ${counts?.queuedPatches ?? 0}`, width),
        centerText("Docs: (configured later)", width),
        centerText(`Node: ${process.version}`, width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Esc back"), width),
      ];
    },
  };
}
