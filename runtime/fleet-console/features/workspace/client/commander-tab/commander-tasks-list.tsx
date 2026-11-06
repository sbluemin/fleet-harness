import { useEffect, useState } from "react";
import type { CommodoreTasksListProps } from "../../../commodore/client/deps.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { CommodoreCommanderList } from "./commander-list.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { CommanderMissionsDialog } from "../../../objectives/client/objectives-panel.js";
import { CommanderObjectivePopover } from "../../../objectives/client/commander-objective-popover.js";
import { getT as getObjectivesT } from "../../../objectives/client/i18n/index.js";
import { useObjectivesToolUse } from "../../../computer-use/client/computer-screen-share.js";
import { readCommanderPlacement, useCommanderPlacement } from "./commander-placement.js";
import { useCommanderRows } from "./commander-rows.js";
import { loadBoard, objectivesApi, useObjectiveBoard } from "../../../objectives/client/objectives-state.js";
import { unseenRecords } from "../../../objectives/shared/types.js";
import { ClusterRowAvatar, clusterRowSummary, rowToolUseLabel, rowUseIds, type SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

type Popover = { readonly objectiveId: string; readonly clusterId: string; readonly opener: HTMLElement };
type Missions = { readonly objectiveId: string; readonly title: string; readonly opener: HTMLElement };

/** 카드 안에서 그 행 요소를 찾는다 — 팝업이 행 전체를 기준으로 선다. */
const rowElement = (opener: HTMLElement, clusterId: string): HTMLElement =>
  opener.closest<HTMLElement>(`[data-cluster-row-id="${CSS.escape(clusterId)}"]`) ?? opener;

/**
 * 작업 탭 「목표」 섹션이 쓰는 목록 — 조립(호스트)이 commodore feature에 넘기는 렌더러다.
 * commodore feature가 workspace 목록을 직접 가져오면 순환이 생기므로, 이 모듈 한 곳에서만 잇는다.
 * 우측 배치에서는 행 펼침이 없다 — 행이나 아바타를 누르면 목표 팝업이, 임무 게이지를 누르면 임무 팝업(구성원 로스터 + 임무 그래프)이
 * 뜬다. 지휘관 대화는 목표 팝업의 「대화 열기」로 간다. 왼쪽 배치는 행을 누르면 지금처럼 대화로 간다.
 */
export function TasksCommanderList({ commodoreId, selectedId, heading, onSelect }: CommodoreTasksListProps) {
  const state = useConsoleState();
  const t = useT();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const objectivesT = getObjectivesT(language);
  const placement = useCommanderPlacement();
  const right = placement === "right";
  const [popover, setPopover] = useState<Popover | null>(null);
  const [missions, setMissions] = useState<Missions | null>(null);
  // 게이지 단추의 안 읽은 기록 점이 읽는 보드 — 팝업을 한 번도 열지 않은 행의 점도 보여야 하므로 목록이 함께 올린다.
  const board = useObjectiveBoard(commodoreId);
  const api = objectivesApi();
  useEffect(() => { if (right && api !== null) void loadBoard(api, commodoreId); }, [right, api, commodoreId]);
  const unseenOf = (objectiveId: string) => board.loaded && (board.objectives.find((candidate) => candidate.id === objectiveId)?.missions.some((mission) => unseenRecords(mission) > 0) ?? false);

  const openConversation = (item: SideBarRowItem) => {
    const objectiveId = commanderObjectiveId(item.layout.cluster);
    if (onSelect) {
      onSelect({
        objectiveId,
        open: item.layout.cluster.open,
        hasRecord: objectiveId !== null && state.objectiveRecords.some((record) => record.id === objectiveId),
      });
      return;
    }
    if (objectiveId !== null) openCommanderConversation(commodoreId, objectiveId);
    else item.layout.cluster.open?.();
  };

  const togglePopover = (item: SideBarRowItem, objectiveId: string, opener: HTMLElement) => {
    setPopover((current) => current?.objectiveId === objectiveId ? null : { objectiveId, clusterId: item.layout.cluster.id, opener });
  };

  const handleSelect = (item: SideBarRowItem) => {
    const objectiveId = commanderObjectiveId(item.layout.cluster);
    if (right && objectiveId !== null) {
      // 행 본문 단추가 연 것 — 초점을 돌려줄 자리는 그 행의 본문 단추다.
      const main = document.querySelector<HTMLElement>(`[data-cluster-row-id="${CSS.escape(item.layout.cluster.id)}"] .side-bar-cluster-row-main`);
      if (main) { togglePopover(item, objectiveId, main); return; }
    }
    // 선택된 행을 다시 누르면 사령관 대화로 돌아간다(#2252).
    if (objectiveId !== null && selectedId === objectiveId) { openCommodoreConversation(commodoreId); return; }
    openConversation(item);
  };

  return <>
    <CommodoreCommanderList
      commodoreId={commodoreId}
      selectedId={selectedId}
      sortNameOnly
      card
      heading={heading}
      onSelect={handleSelect}
      popups={right ? (item, objectiveId) => ({
        open: popover?.objectiveId === objectiveId,
        avatarLabel: objectivesT("objectives.popover.open", { title: item.layout.cluster.title }),
        progressLabel: (done, total) => objectivesT("objectives.popover.missions", { done, total }),
        unseen: unseenOf(objectiveId),
        unseenLabel: objectivesT("objectives.tabs.unseenDot"),
        onAvatar: (opener) => togglePopover(item, objectiveId, opener),
        onProgress: (opener) => { setPopover(null); setMissions({ objectiveId, title: item.layout.cluster.title, opener }); },
      }) : undefined}
    />
    {right && popover ? (
      <ObjectivePopoverForRow commodoreId={commodoreId} selectedId={selectedId} popover={popover} language={language} t={t}
        onOpenConversation={(item) => openConversation(item)}
        onClose={(restoreFocus) => { const opener = popover.opener; setPopover(null); if (restoreFocus && opener.isConnected) opener.focus(); }} />
    ) : null}
    {right && missions ? (
      <CommanderMissionsDialog commodoreId={commodoreId} objectiveId={missions.objectiveId} title={missions.title} language={language}
        onOpenObjective={(id) => openCommanderConversation(commodoreId, id)}
        onClose={() => { const opener = missions.opener; setMissions(null); if (opener.isConnected) opener.focus(); }} />
    ) : null}
  </>;
}

/** 목표 팝업에 행 쪽 사실(아바타·상태·상태 문구·도구 사용)을 건넨다 — 행이 바뀌면 팝업도 따라 그린다. */
function ObjectivePopoverForRow({ commodoreId, selectedId, popover, language, t, onOpenConversation, onClose }: {
  readonly commodoreId: string;
  readonly selectedId: string | null;
  readonly popover: Popover;
  readonly language: "en" | "ko";
  readonly t: ReturnType<typeof useT>;
  readonly onOpenConversation: (item: SideBarRowItem) => void;
  readonly onClose: (restoreFocus: boolean) => void;
}) {
  const locale = useConsoleLocale();
  const { sorted } = useCommanderRows(commodoreId, selectedId);
  const item = sorted.find((candidate) => candidate.layout.cluster.id === popover.clusterId) ?? null;
  const toolUse = useObjectivesToolUse(item ? rowUseIds(item) : []);
  if (!item) return null;
  const { state, label, conversationLine } = clusterRowSummary(item, locale, t);
  return (
    <CommanderObjectivePopover
      commodoreId={commodoreId}
      objectiveId={popover.objectiveId}
      anchor={rowElement(popover.opener, popover.clusterId)}
      language={language}
      avatar={<ClusterRowAvatar item={item} rowState={state} label={label} decorative size={40} />}
      activityAt={item.row.activityAt ?? null}
      statusLine={conversationLine}
      toolLabel={toolUse ? rowToolUseLabel(item, toolUse, t) : null}
      onOpenConversation={() => onOpenConversation(item)}
      onReview={item.row.review ? () => item.row.review!(locale) : null}
      onClose={onClose}
    />
  );
}

export const readTasksCommanderPlacement = readCommanderPlacement;
export const useTasksCommanderPlacement = useCommanderPlacement;
