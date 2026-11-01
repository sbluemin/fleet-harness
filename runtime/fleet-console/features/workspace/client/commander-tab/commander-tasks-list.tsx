import { useState } from "react";
import type { CommodoreTasksListProps } from "../../../commodore/client/deps.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { CommodoreCommanderList } from "./commander-list.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { CommanderRowPanel } from "../../../objectives/client/objectives-panel.js";
import { readCommanderPlacement, useCommanderPlacement } from "./commander-placement.js";
import { useCommanderRowGlyphBoard, type CommanderRowGlyphTab } from "./commander-row-glyphs.js";
import type { SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

/**
 * 작업 탭 「목표」 섹션이 쓰는 목록 — 조립(호스트)이 commodore feature에 넘기는 렌더러다.
 * commodore feature가 workspace 목록을 직접 가져오면 순환이 생기므로, 이 모듈 한 곳에서만 잇는다.
 * 우측 배치에서는 행의 글리프(목표·구성원·라이브러리)를 누르면 그 내용만 그 행 아래에 펼쳐진다(아코디언).
 * 글리프 펼침은 가운데 채팅과 무관하고, 제목을 누르면 채팅만 옮긴다. 펼침·선택 상태는 화면 메모리로만 둔다.
 */
export function TasksCommanderList({ commodoreId, selectedId, heading, onSelect }: CommodoreTasksListProps) {
  const state = useConsoleState();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const placement = useCommanderPlacement();
  const [expanded, setExpanded] = useState<{ readonly objectiveId: string; readonly tab: CommanderRowGlyphTab } | null>(null);
  // 행 글리프의 점(결정 요청·안 읽은 기록)이 읽는 보드 — 펼침 패널이 올리기 전에도 점이 보여야 한다.
  useCommanderRowGlyphBoard(commodoreId);

  const handleGlyphTab = (objectiveId: string, tab: CommanderRowGlyphTab) => {
    // 펼친 글리프를 다시 누르면 접히고, 다른 글리프를 누르면 내용만 바뀐다. 가운데 채팅은 그대로 둔다.
    // 다른 행의 글리프를 누르면 펼침이 그 행으로 옮겨 간다(한 번에 한 행).
    setExpanded((current) => current !== null && current.objectiveId === objectiveId && current.tab === tab ? null : { objectiveId, tab });
  };

  const handleSelect = (item: SideBarRowItem) => {
    const objectiveId = commanderObjectiveId(item.layout.cluster);
    // 선택된 행을 다시 누르면 사령관 대화로 돌아간다(#2252) — 펼침은 바꾸지 않는다.
    if (objectiveId !== null && selectedId === objectiveId) { openCommodoreConversation(commodoreId); return; }
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

  return <CommodoreCommanderList
    commodoreId={commodoreId}
    selectedId={selectedId}
    sortNameOnly
    card
    heading={heading}
    onSelect={handleSelect}
    expansion={placement === "right" ? {
      expanded,
      onGlyphTab: handleGlyphTab,
      renderPanel: (item, tab) => {
        const objectiveId = commanderObjectiveId(item.layout.cluster);
        if (objectiveId === null) return null;
        return <CommanderRowPanel commodoreId={commodoreId} objectiveId={objectiveId} language={language} tab={tab} onGlyphTab={(next) => handleGlyphTab(objectiveId, next)} onOpenObjective={(id) => openCommanderConversation(commodoreId, id)} />;
      },
    } : undefined}
  />;
}

export const readTasksCommanderPlacement = readCommanderPlacement;
export const useTasksCommanderPlacement = useCommanderPlacement;
