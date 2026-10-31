import type { CommodoreTasksListProps } from "../../../commodore/client/deps.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { CommodoreCommanderList } from "./commander-list.js";
import { readCommanderPlacement, useCommanderPlacement } from "./commander-placement.js";

/**
 * 작업 탭 「목표」 섹션이 쓰는 목록 — 조립(호스트)이 commodore feature에 넘기는 렌더러다.
 * commodore feature가 workspace 목록을 직접 가져오면 순환이 생기므로, 이 모듈 한 곳에서만 잇는다.
 */
export function TasksCommanderList({ commodoreId, selectedId, heading, onSelect }: CommodoreTasksListProps) {
  const state = useConsoleState();
  return <CommodoreCommanderList
    commodoreId={commodoreId}
    selectedId={selectedId}
    sortNameOnly
    card
    heading={heading}
    {...(onSelect ? {
      onSelect: (item) => {
        const objectiveId = commanderObjectiveId(item.layout.cluster);
        onSelect({
          objectiveId,
          open: item.layout.cluster.open,
          hasRecord: objectiveId !== null && state.objectiveRecords.some((record) => record.id === objectiveId),
        });
      },
    } : {})}
  />;
}

export const readTasksCommanderPlacement = readCommanderPlacement;
export const useTasksCommanderPlacement = useCommanderPlacement;
