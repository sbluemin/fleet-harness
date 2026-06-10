import { renderKeyValueBlock, type KeyValueBlockRow } from "../layout.js";
import { MISSION_CONTROL_THEME } from "../theme.js";
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
      const releaseRows = [
        { key: "Version", value: MISSION_CONTROL_THEME.accent(release?.version ?? "(local)") },
        { key: "Channel", value: MISSION_CONTROL_THEME.accent(release?.channel ?? "local") },
      ];
      const infoRows = [
        { key: "Carriers", value: MISSION_CONTROL_THEME.accent(String(counts?.carriers ?? 0)) },
        { key: "Wiki entries", value: MISSION_CONTROL_THEME.accent(String(counts?.wikiEntries ?? 0)) },
        { key: "Queued patches", value: MISSION_CONTROL_THEME.accent(String(counts?.queuedPatches ?? 0)) },
        { key: "Docs", value: MISSION_CONTROL_THEME.accent("(configured later)") },
        { key: "Node", value: MISSION_CONTROL_THEME.accent(process.version) },
      ];
      return [
        centerText(MISSION_CONTROL_THEME.dim(renderBreadcrumbs(deps.stack.breadcrumbs())), width),
        centerText(MISSION_CONTROL_THEME.accent("Fleet"), width),
        ...renderInfoRows(releaseRows, width),
        "",
        ...renderInfoRows(infoRows, width),
        "",
        centerText(MISSION_CONTROL_THEME.dim("Esc back"), width),
      ];
    },
  };
}

function renderInfoRows(rows: readonly KeyValueBlockRow[], width: number): string[] {
  return renderKeyValueBlock({ innerWidth: width, rows });
}
