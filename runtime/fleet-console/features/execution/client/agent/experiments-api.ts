import type { ClientApiCapability } from "@fleet-console/infra/http/client-ports";

/** 서버 `server.ts`의 채널 이름과 같은 값 — 사용자 화면에 보내는 사건. */
export const OBJECTIVE_REVEAL_EVENT_CHANNEL = "objective:reveal";

export interface ObjectiveReveal {
  readonly objectiveId: string;
  readonly reason: string;
  readonly at: number;
}

const reveals = new Map<string, ObjectiveReveal>();
const revealListeners = new Set<() => void>();

export function isObjectiveRevealEvent(value: unknown): value is ObjectiveReveal {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.objectiveId === "string" && typeof record.reason === "string" && typeof record.at === "number";
}

export function recordObjectiveReveal(event: ObjectiveReveal): void {
  reveals.set(event.objectiveId, { objectiveId: event.objectiveId, reason: event.reason.slice(0, 200), at: event.at });
  for (const listener of revealListeners) listener();
}

export function getObjectiveReveal(objectiveId: string): ObjectiveReveal | null {
  return reveals.get(objectiveId) ?? null;
}

export function subscribeObjectiveReveals(listener: () => void): () => void {
  revealListeners.add(listener);
  return () => { revealListeners.delete(listener); };
}

/** 패널 안 허용 요청에 답한다. 실패(이미 풀린 요청·실험 꺼짐)는 던진다 — 카드가 다시 누르게 한다. */
export async function answerUseRequest(api: ClientApiCapability, input: { readonly objectiveId: string; readonly requestId: string; readonly capability: "computer"; readonly decision: "deny" | "always"; readonly language: "en" | "ko" }): Promise<void> {
  const response = await api.fetch(`experiments/sessions/${encodeURIComponent(input.objectiveId)}/use-requests/${encodeURIComponent(input.requestId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: input.decision, capability: input.capability, language: input.language }),
  });
  if (!response.ok) throw new Error(`use_request_${response.status}`);
}
