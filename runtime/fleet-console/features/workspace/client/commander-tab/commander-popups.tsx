import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { CommanderGoalDialog, CommanderMissionsDialog, type DetailTab } from "../../../objectives/client/objectives-panel.js";
import { getT as getObjectivesT } from "../../../objectives/client/i18n/index.js";
import { loadBoard, objectivesApi, useObjectiveBoard } from "../../../objectives/client/objectives-state.js";
import { unseenRecords } from "../../../objectives/shared/types.js";
import { commodoreAvatarKey } from "../../shared/avatars.js";
import { useAvatarAccent } from "../avatar-accent.js";
import type { RowPopups, SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

type PopupState = { readonly kind: "goal" | "missions"; readonly start: DetailTab; readonly objectiveId: string; readonly title: string; readonly opener: HTMLElement };

/**
 * 지휘관 행의 팝업 — 아바타는 목표 팝업, 임무 게이지는 임무 팝업을 연다. 우측 작업 탭 카드와 좌측 사이드바가 함께 쓴다.
 * `openTab` 은 행 글리프가 같은 팝업을 탭째로 열 때 쓴다(구성원은 임무 팝업, 목표·라이브러리는 목표 팝업). 닫으면 연 단추로 초점이 돌아간다.
 * 팝업은 body 포털이라 오른쪽·왼쪽 패널의 지휘관 강조색을 물려받지 못한다 — 같은 값을 팝업에 직접 건넨다.
 */
export function useCommanderPopups(commodoreId: string): {
  readonly rowPopups: (item: SideBarRowItem, objectiveId: string) => RowPopups;
  readonly openTab: (item: SideBarRowItem, objectiveId: string, tab: DetailTab, opener: HTMLElement) => void;
  readonly dialogs: ReactNode;
} {
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const objectivesT = getObjectivesT(language);
  const [dialog, setDialog] = useState<PopupState | null>(null);
  const accent: CSSProperties | undefined = useAvatarAccent(commodoreAvatarKey(commodoreId));
  // 게이지 단추의 안 읽은 기록 점이 읽는 보드 — 목록이 함께 올린다.
  const board = useObjectiveBoard(commodoreId);
  const api = objectivesApi();
  useEffect(() => { if (api !== null) void loadBoard(api, commodoreId); }, [api, commodoreId]);
  const unseenOf = (objectiveId: string) => board.loaded && (board.objectives.find((candidate) => candidate.id === objectiveId)?.missions.some((mission) => unseenRecords(mission) > 0) ?? false);
  const open = (kind: PopupState["kind"], start: DetailTab, item: SideBarRowItem, objectiveId: string, opener: HTMLElement) => setDialog({ kind, start, objectiveId, title: item.layout.cluster.title, opener });
  const rowPopups = (item: SideBarRowItem, objectiveId: string): RowPopups => ({
    // 아바타는 목표 팝업을 연다 — 지휘관 대화는 행 본문이 연다.
    avatarLabel: `${item.layout.cluster.title} · ${objectivesT("objectives.popover.openGoal")}`,
    progressLabel: (done, total) => objectivesT("objectives.popover.missions", { done, total }),
    unseen: unseenOf(objectiveId),
    unseenLabel: objectivesT("objectives.tabs.unseenDot"),
    onAvatar: (opener) => open("goal", "goal", item, objectiveId, opener),
    onProgress: (opener) => open("missions", "crew", item, objectiveId, opener),
  });
  const openTab = (item: SideBarRowItem, objectiveId: string, tab: DetailTab, opener: HTMLElement) => open(tab === "crew" ? "missions" : "goal", tab, item, objectiveId, opener);
  const PopupDialog = dialog?.kind === "missions" ? CommanderMissionsDialog : CommanderGoalDialog;
  const dialogs = dialog ? (
    <PopupDialog commodoreId={commodoreId} objectiveId={dialog.objectiveId} title={dialog.title} language={language} start={dialog.start} {...(accent ? { accent } : {})}
      onOpenObjective={(id) => openCommanderConversation(commodoreId, id)}
      onClose={() => { const opener = dialog.opener; setDialog(null); if (opener.isConnected) opener.focus(); }} />
  ) : null;
  return { rowPopups, openTab, dialogs };
}
