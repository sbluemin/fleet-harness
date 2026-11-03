import * as React from "react";

import { useConsoleState } from "../../../../../../core/client/src/hooks/use-store.js";
import { useT } from "../../../../../../core/client/src/i18n/index.js";
import { registerContextRailProvider, type ContextRailProvider } from "../../../../../workspace/client/conversation/context-rail/registry.js";
import type { ContextRailMeasure, ContextRailSession } from "../../../../../workspace/shared/context-rail.js";
import type { AgentChatContext } from "../chat-events.js";
import { useGroupClusters, useParticipantContexts } from "../group-timeline-store.js";

/**
 * 목표(Objective) 대화의 컨텍스트 레일 제공자. 지휘관 카드 하나와 구성원마다 카드 하나를 낸다 — 내용은 원장의 컨텍스트 창과 같은 내역이다.
 * 구성원 원장을 보는 중이면 그 구성원이 보는 세션(`focus`)이라 맨 위에 펼쳐진다. 채팅으로 열리지 않은 목표(터미널)는 그릴 컨텍스트가 없다.
 */
const ObjectiveContextRail: ContextRailProvider = ({ scope, children }) => {
  const t = useT();
  const state = useConsoleState();
  const clusters = useGroupClusters();
  const root = scope.kind === "objective" ? scope.objectiveId : null;
  const contexts = useParticipantContexts(root);
  if (scope.kind !== "objective" || root === null) return null;
  const rootRecord = state.objectiveRecords.find((record) => record.id === root);
  if (!rootRecord || rootRecord.chatMode !== true) return null;
  const board = clusters.find((cluster) => cluster.conversation?.objectiveId === root)?.conversation;
  const nested = state.nestedObjectiveRecords.filter((record) => record.parentObjectiveId === root);
  const sessions: ContextRailSession[] = [{
    id: root,
    name: board ? t("cluster.picker.coordinator") : rootRecord.title,
    role: "commander",
    measure: measureOf(contexts.get(root) ?? null),
    focus: scope.bodyObjectiveId === root,
  }];
  const seen = new Set<string>([root]);
  for (const member of board?.members ?? []) {
    if (!member.objectiveId || seen.has(member.objectiveId)) continue;
    seen.add(member.objectiveId);
    sessions.push({ id: member.objectiveId, name: member.name, role: "member", measure: measureOf(contexts.get(member.objectiveId) ?? null), focus: scope.bodyObjectiveId === member.objectiveId });
  }
  for (const record of nested) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    sessions.push({ id: record.id, name: record.title, role: "member", measure: measureOf(contexts.get(record.id) ?? null), focus: scope.bodyObjectiveId === record.id });
  }
  return <>{children(sessions)}</>;
};

/** 원장의 문맥 상태를 레일 카드의 측정으로 옮긴다. 한 턴도 측정되지 않았으면(내역이 비고 총량이 없다) 측정 전이다. */
export function measureOf(context: AgentChatContext | null): ContextRailMeasure | null {
  if (!context) return null;
  const occupied = context.liveTotal ?? context.total;
  if (occupied <= 0 && context.slices.length === 0) return null;
  return {
    occupied,
    max: context.max,
    ...(context.reserved !== undefined ? { reserved: context.reserved } : {}),
    ...(context.compactAt !== undefined ? { compactAt: context.compactAt } : {}),
    slices: context.slices,
    memoryFiles: context.memoryFiles,
    mcpTools: context.mcpTools,
  };
}

export function registerObjectiveContextRail(): () => void {
  return registerContextRailProvider(ObjectiveContextRail);
}
