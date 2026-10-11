import { useCallback } from "react";

import { useOperationClusters } from "../operation-clusters.js";

/** 그룹 대화의 `board-action` 줄 하나 — 줄의 목표(묶음 conversation.operationId)·줄 id·시각. */
export interface BoardActionRecordRequest {
  readonly objectiveId: string;
  readonly entryId: string;
  readonly at: number | null;
}

/**
 * 그룹 대화의 `board-action` 줄에서 그 행위의 기록을 연다(사령관 행위면 가운데 칸에 읽기 전용 사령관 기록이 그 턴 위치로
 * 선다). 기록을 찾는 일은 묶음을 공급한 플러그인의 `conversation.openBoardAction` 이 한다 — 호스트는 줄을 그 플러그인에게
 * 건네기만 한다. 기록이 없는 줄이면 아무 일도 하지 않는다.
 */
export function useOpenBoardActionRecord(): (request: BoardActionRecordRequest) => void {
  const clusters = useOperationClusters();
  return useCallback((request: BoardActionRecordRequest) => {
    const owner = clusters.find((cluster) => cluster.conversation?.operationId === request.objectiveId);
    owner?.conversation?.openBoardAction?.(request.entryId);
  }, [clusters]);
}
