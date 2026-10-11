import { useMemo } from "react";
import type { GroupConversationActions } from "@fleet-console/sdk/conversation";
import { useConsoleState } from "../../../../../core/client/src/hooks/use-store.js";
import { useAllOperationUseRequests, type OperationUseRequest } from "../../../../computer-use/client/computer-screen-share.js";
import { useGroupClusters } from "./group-timeline-store.js";

/** 플러그인이 소유한 검증·저장·전달 경로만 노출한다. */
export function useGroupConversationActions(rootOperationId: string | null): GroupConversationActions | null {
  return useGroupClusters().find((cluster) => cluster.conversation?.operationId === rootOperationId)?.conversation?.actions ?? null;
}

/** 답변 좌표는 원 요청의 operationId다. 그룹 뿌리로 바꾸지 않는다. */
export function useGroupUseRequests(rootOperationId: string | null): readonly OperationUseRequest[] {
  const state = useConsoleState();
  const requests = useAllOperationUseRequests();
  return useMemo(() => {
    if (!rootOperationId) return [];
    const ids = new Set([rootOperationId, ...state.nestedOperations.filter((operation) => operation.parentOperationId === rootOperationId).map((operation) => operation.id)]);
    return requests.filter((request) => ids.has(request.operationId));
  }, [rootOperationId, state.nestedOperations, requests]);
}
