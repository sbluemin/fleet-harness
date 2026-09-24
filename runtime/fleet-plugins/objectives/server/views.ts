import type { ConsoleCaller } from "@fleet-console/sdk/mcp";
import type { FleetPluginServerContext } from "@fleet-console/sdk/plugin";

import type { PromptLanguage } from "./prompts.js";
import type { ObjectiveStore } from "./store.js";
import { coordinatorMode, latestRecord, stepReady, type ObjectiveItem } from "./types.js";

/**
 * 보드 보기 — `fleet-objectives`(지휘관·담당의 작업 도구)와 `console_objectives`(Console Use)가 같은 모양으로 목표를 읽는다.
 * 도구 응답은 JSON 한 덩이: 텍스트와 structuredContent 가 같은 값이다.
 */

export function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: (value && typeof value === "object" && !Array.isArray(value) ? value : { value }) as Record<string, unknown>, isError: false };
}
export function refuse(error: string, extra: Record<string, unknown> = {}) {
  return { ...text({ error, ...extra }), isError: true };
}

/** 이 Operation 이 이 목표에서 맡은 자리 — 지휘관 또는 명단에 연결된 구성원. 둘 다 아니면 null. */
export function roleIn(item: ObjectiveItem, caller: ConsoleCaller | undefined): { role: "commander" } | { role: "member"; memberId: string } | null {
  if (caller?.kind !== "operation") return null;
  if (item.id === caller.operationId) return { role: "commander" };
  const member = item.members.find((candidate) => candidate.operationId === caller.operationId);
  return member ? { role: "member", memberId: member.id } : null;
}

export function createBoardViews(ctx: FleetPluginServerContext, store: ObjectiveStore) {
  const observe = (operationId: string) => {
    const node = ctx.host.operations.get(operationId);
    if (!node) return { operationId, title: null, state: "closed" as const };
    const observation = ctx.host.consoleControl?.observe(operationId) ?? null;
    return { operationId, title: node.title, state: observation ? (observation.lifecycle === "dormant" ? "dormant" : observation.activity) : "unknown" };
  };
  const graph = (item: ObjectiveItem) => ({
    commander: { ...observe(item.id), session: item.commander.sessionName },
    mode: coordinatorMode(item.steps),
    ...(item.cooking ? { planning: true } : {}),
    steps: item.steps.map((step, index) => ({
      index, stepId: step.id, text: step.text, done: step.done,
      after: step.after.map((id) => item.steps.findIndex((candidate) => candidate.id === id)).filter((value) => value >= 0),
      why: step.why,
      member: step.member ? ((member) => member ? { id: member.id, role: member.role } : null)(item.members.find((candidate) => candidate.id === step.member)) : null,
      ...(step.unplaced ? { unplaced: true } : {}),
      ready: !step.done && stepReady(item.steps, step),
      // 다음 단계가 받는 것 — 가장 최근 기록과 기록 수. 앞선 기록은 사람이 화면에서 읽는다.
      record: ((latest) => (latest ? { lines: latest.lines, kind: latest.kind, at: latest.at ? new Date(latest.at).toISOString() : null } : null))(latestRecord(step)),
      records: step.records.length,
      // 구성원 세션 상태는 명단에서 읽는다. 한 구성원은 여러 임무를 맡는다.
    })),
  });
  const itemView = (item: ObjectiveItem) => ({
    id: item.id, theaterId: item.theaterId, groupId: item.groupId, title: item.title, note: item.note,
    // 메모에 붙인 이미지 — 이미지 자체는 싣지 않고 이 기계의 절대 경로만. 필요할 때 Read 로 연다(브라우저에는 이 경로가 가지 않는다).
    attachments: (item.attachments ?? []).map((attachment) => ({ n: attachment.n, name: attachment.name, type: attachment.type, bytes: attachment.bytes, ...(attachment.width ? { width: attachment.width, height: attachment.height } : {}), path: store.attachmentPath(item, attachment) })),
    important: item.important, dueDate: item.dueDate, today: item.today,
    // 달성 기준 — n 은 1부터, 기준을 가리키는 번호. met 은 지휘관이 충족으로 표시한 근거(없으면 미충족).
    criteria: item.criteria.map((criterion, index) => ({ n: index + 1, id: criterion.id, text: criterion.text, by: criterion.by, met: criterion.met ?? null })),
    members: item.members.map((member) => ({ id: member.id, role: member.role, brief: member.brief ?? null, by: member.by, model: member.model ?? null, effort: member.effort ?? null, session: member.sessionName,
      ...(member.operationId ? observe(member.operationId) : { operationId: null, state: "missing" as const }) })),
    done: !!item.done, awaitingReview: item.awaitingReview, addedBy: item.addedBy, graph: graph(item),
  });
  const rowView = (item: ObjectiveItem) => ({ id: item.id, groupId: item.groupId, title: item.title, done: !!item.done, awaitingReview: item.awaitingReview, important: item.important, dueDate: item.dueDate, today: item.today, steps: `${item.steps.filter((step) => step.done).length}/${item.steps.length}`, mode: coordinatorMode(item.steps), addedBy: item.addedBy?.operationId ?? null });
  /** 알림 문구의 언어 — 목표가 띄운 세션은 objectiveLanguage 에, 그 전 판의 세션은 콘솔 사용 표식에 남아 있다. */
  const languageOf = (caller: ConsoleCaller | undefined): PromptLanguage => {
    if (caller?.kind !== "operation") return "en";
    const payload = ctx.host.operations.get(caller.operationId)?.payload;
    const marked = payload?.objectiveLanguage ?? (payload?.consoleUse as { language?: unknown } | undefined)?.language;
    return marked === "ko" ? "ko" : "en";
  };
  return { itemView, rowView, languageOf };
}
