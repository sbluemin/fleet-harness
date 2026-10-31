import { useEffect, useState } from "react";
import type { CommodoreTasksListProps } from "../../../commodore/client/deps.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { isCommanderObjective } from "./commander-rows.js";
import { CommodoreCommanderList } from "./commander-list.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { CommanderRowPanel } from "../../../objectives/client/objectives-panel.js";
import { readCommanderPlacement, useCommanderPlacement } from "./commander-placement.js";
import { useConversationStandIn, useConversationSubject } from "../conversation/conversation-slots.js";
import { useObjectiveClusters } from "../objective-clusters.js";
import type { SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

/**
 * 작업 탭 「목표」 섹션이 쓰는 목록 — 조립(호스트)이 commodore feature에 넘기는 렌더러다.
 * commodore feature가 workspace 목록을 직접 가져오면 순환이 생기므로, 이 모듈 한 곳에서만 잇는다.
 * 우측 배치에서는 누른 행 아래에 그 지휘관 패널이 펼쳐진다(아코디언). 펼침은 화면 메모리로만 둔다.
 */
export function TasksCommanderList({ commodoreId, selectedId, heading, onSelect }: CommodoreTasksListProps) {
  const state = useConsoleState();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const placement = useCommanderPlacement();
  const clusters = useObjectiveClusters();
  const subject = useConversationSubject();
  const standIn = useConversationStandIn();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 가운데를 따라 펼친다 — 팔레트 등 목록 밖에서 지휘관을 열어도 같은 행이 펼쳐진다.
  const centerId = subject?.id ?? standIn ?? null;
  const centerCommanderId = centerId !== null && placement === "right" && isCommanderObjective(clusters, commodoreId, centerId) ? centerId : null;
  useEffect(() => { setExpandedId(centerCommanderId); }, [centerCommanderId]);

  const handleSelect = (item: SideBarRowItem) => {
    const objectiveId = commanderObjectiveId(item.layout.cluster);
    // 펼쳐진 행을 다시 누르면 접히고, 가운데는 그대로 둔다.
    if (objectiveId !== null && expandedId === objectiveId) { setExpandedId(null); return; }
    if (objectiveId !== null) setExpandedId(objectiveId);
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
      expandedId,
      renderPanel: (item, _titleId) => {
        const objectiveId = commanderObjectiveId(item.layout.cluster);
        if (objectiveId === null) return null;
        return <CommanderRowPanel commodoreId={commodoreId} objectiveId={objectiveId} language={language} onOpenObjective={(id) => openCommanderConversation(commodoreId, id)} />;
      },
    } : undefined}
  />;
}

export const readTasksCommanderPlacement = readCommanderPlacement;
export const useTasksCommanderPlacement = useCommanderPlacement;
