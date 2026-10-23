import { useMemo } from "react";
import type { GroupConversationActions } from "../../../shared/conversation/types.js";
import { useConsoleState } from "../../../../../core/client/src/hooks/use-store.js";
import { useAllObjectiveUseRequests, type ObjectiveUseRequest } from "../../../../computer-use/client/computer-screen-share.js";
import { useGroupClusters } from "./group-timeline-store.js";

/** 플러그인이 소유한 검증·저장·전달 경로만 노출한다. */
export function useGroupConversationActions(rootObjectiveId: string | null): GroupConversationActions | null {
  return useGroupClusters().find((cluster) => cluster.conversation?.objectiveId === rootObjectiveId)?.conversation?.actions ?? null;
}

/** 답변 좌표는 원 요청의 objectiveId다. 그룹 뿌리로 바꾸지 않는다. */
export function useGroupUseRequests(rootObjectiveId: string | null): readonly ObjectiveUseRequest[] {
  const state = useConsoleState();
  const requests = useAllObjectiveUseRequests();
  return useMemo(() => {
    if (!rootObjectiveId) return [];
    const ids = new Set([rootObjectiveId, ...state.nestedObjectiveRecords.filter((objectiveRecord) => objectiveRecord.parentObjectiveId === rootObjectiveId).map((objectiveRecord) => objectiveRecord.id)]);
    return requests.filter((request) => ids.has(request.objectiveId));
  }, [rootObjectiveId, state.nestedObjectiveRecords, requests]);
}
