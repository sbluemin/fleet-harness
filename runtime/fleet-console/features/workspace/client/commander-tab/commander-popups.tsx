import type { ReactNode } from "react";
import { openObjectivePopup } from "../../../objectives/client/objectives-panel.js";
import { openResultWindow } from "../../../objectives/client/result-window.js";
import { findAnyObjective, loadObjective } from "../../../objectives/client/objectives-state.js";
import type { CommanderRowGlyphTab } from "./commander-row-glyphs.js";
import { getT as getObjectivesT } from "../../../objectives/client/i18n/index.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import type { RowPopups, SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

/** 명부 행과 기존 목록 글리프는 같은 목표·임무 팝업과 증거 뷰어를 연다. */
export function openCommanderRowGlyphTab(objectiveId: string, tab: CommanderRowGlyphTab, opener: HTMLElement): void {
  if (tab === "results") {
    // 명부 요약만 읽은 목표도 증거 뷰어에서 열린다 — 목표·임무 팝업과 같은 지연 적재다.
    if (!findAnyObjective(objectiveId)) void loadObjective(objectiveId).catch(() => undefined);
    openResultWindow(objectiveId, "", opener);
  } else openObjectivePopup(objectiveId, tab, undefined, opener);
}

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
    openTab: (_item, objectiveId, tab, opener) => openCommanderRowGlyphTab(objectiveId, tab, opener),
    dialogs: null,
  };
}
