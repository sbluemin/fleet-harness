import type { CommodoreTasksListProps } from "../../../commodore/client/deps.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { CommodoreCommanderList } from "./commander-list.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { useCommanderPopups } from "./commander-popups.js";
import type { SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";

/**
 * 작업 탭 「목표」 섹션이 쓰는 목록 — 조립(호스트)이 commodore feature에 넘기는 렌더러다.
 * commodore feature가 workspace 목록을 직접 가져오면 순환이 생기므로, 이 모듈 한 곳에서만 잇는다.
 * 행을 누르면 지휘관 대화가 바로 열리고, 아바타를 누르면 목표 팝업, 임무 게이지를 누르면 임무 팝업이 뜬다.
 * 행의 글리프(목표·구성원·증거)는 목표·임무 팝업 또는 증거 뷰어를 연다 — 행 아래로 펼치지 않으며 가운데 대화는 그대로 둔다.
 */
export function TasksCommanderList({ commodoreId, selectedId, heading, onSelect }: CommodoreTasksListProps) {
  const state = useConsoleState();
  const { rowPopups, openTab, dialogs } = useCommanderPopups(commodoreId);

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

  const handleSelect = (item: SideBarRowItem) => {
    const objectiveId = commanderObjectiveId(item.layout.cluster);
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
      popups={rowPopups}
      onGlyphTab={(objectiveId, tab, item, opener) => openTab(item, objectiveId, tab, opener)}
    />
    {dialogs}
  </>;
}
