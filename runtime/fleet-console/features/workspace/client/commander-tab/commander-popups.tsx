import type { ReactNode } from "react";
import { openObjectivePopup } from "../../../objectives/client/objectives-panel.js";
import { openResultWindow } from "../../../objectives/client/result-window.js";
import type { CommanderRowGlyphTab } from "./commander-row-glyphs.js";
import { getT as getObjectivesT } from "../../../objectives/client/i18n/index.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import type { RowPopups, SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

/** 좌우 목록과 대화 링크는 같은 목표·임무 팝업을 연다. 증거는 증거 뷰어를 연다. */
export function useCommanderPopups(_commodoreId: string): {
  readonly rowPopups: (item: SideBarRowItem, objectiveId: string) => RowPopups;
  readonly openTab: (item: SideBarRowItem, objectiveId: string, tab: CommanderRowGlyphTab, opener: HTMLElement) => void;
  readonly dialogs: ReactNode;
} {
  const t = getObjectivesT(useConsoleLocale() === "ko" ? "ko" : "en");
  return {
    rowPopups: (item, objectiveId) => ({
      avatarLabel: `${item.layout.cluster.title} · ${t("objectives.popover.openGoal")}`,
      progressLabel: (done, total) => t("objectives.popover.missions", { done, total }),
      onAvatar: (opener) => openObjectivePopup(objectiveId, "goal", undefined, opener),
      onProgress: (opener) => openObjectivePopup(objectiveId, "crew", undefined, opener),
    }),
    openTab: (_item, objectiveId, tab, opener) => {
      if (tab === "results") openResultWindow(objectiveId, "", opener);
      else openObjectivePopup(objectiveId, tab, undefined, opener);
    },
    dialogs: null,
  };
}
