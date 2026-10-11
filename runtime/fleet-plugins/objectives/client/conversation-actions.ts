import type { GroupConversationActions, GroupWriteResult } from "@fleet-console/sdk/conversation";
import type { Objective } from "../server/types.js";
import { commodoreLanguage } from "./commodore-state.js";
import { objectivesApi, post } from "./objectives-state.js";

/** 사람용 보드 라우트를 공유한다. 컴포넌트가 보드/세션 상태를 직접 고쳐 성공을 만들지 않는다. */
export function objectiveConversationActions(objective: Pick<Objective, "id" | "theaterId">): GroupConversationActions {
  const request = <T>(path: string, input: Record<string, unknown>) => {
    const api = objectivesApi();
    if (!api) return Promise.reject(new Error("objectives_unavailable"));
    return post<T>(api, path, { ...input, language: commodoreLanguage() ?? "en" });
  };
  return {
    async send(target, text, attachmentIds) {
      if (target.kind === "commodore") {
        await request("/commodore/message", { theaterId: objective.theaterId, objectiveId: objective.id, text, ...(attachmentIds?.length ? { attachmentIds } : {}) });
        return { targets: [{ targetId: `commodore:${objective.theaterId}`, outcome: "sent" }] };
      }
      if (target.kind === "all") return request<GroupWriteResult>("/conversation/broadcast", { objectiveId: objective.id, text });
      const memberId = target.kind === "member" ? target.operationId : null;
      const attached = attachmentIds && attachmentIds.length > 0 ? { attachmentIds } : {};
      const result = await request<{ notified: boolean | null }>("/commander/message", { objectiveId: objective.id, memberId, text, ...attached });
      return { targets: [{ targetId: memberId ?? objective.id, outcome: "sent" }], ...(result.notified !== null ? { commanderNotified: result.notified } : {}) };
    },
    async stopAll() {
      const result = await request<{ targets: readonly { operationId: string; outcome: "interrupted" | "skipped" | "failed"; reason?: string }[] }>("/commander/stop", { objectiveId: objective.id });
      return { targets: result.targets.map((target) => ({ targetId: target.operationId, outcome: target.outcome === "interrupted" ? "stopped" as const : target.outcome, ...(target.reason ? { reason: target.reason } : {}) })) };
    },
    async answerDecision(requestId, answers) {
      await request("/decision/answer", { objectiveId: objective.id, requestId, answers });
    },
  };
}
