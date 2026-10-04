import type { ClientApiCapability, ClientExperimentsCapability } from "@fleet-console/sdk/plugin";
import type { ConsoleExperimentSettings } from "@fleet-console/sdk/settings";

/**
 * install에서 받은 실험 설정 능력 — 렌더 밖(store)에서도 읽고 구독해야 하므로 모듈 스코프에 둔다.
 * 코어 번들 안의 상태라 호스트/플러그인 경계를 넘지 않는다.
 */
let installedExperiments: ClientExperimentsCapability | null = null;

export function setInstalledExperiments(capability: ClientExperimentsCapability | null): void {
  installedExperiments = capability;
}

export function readInstalledExperiments(): ConsoleExperimentSettings | null {
  return installedExperiments?.read() ?? null;
}

export function subscribeInstalledExperiments(listener: () => void): () => void {
  return installedExperiments?.subscribe(listener) ?? (() => undefined);
}

/** 서버 `server.ts`의 채널 이름과 같은 값 — Console Use 의 console_reveal 이 사용자 화면에 보내는 사건. */
export const OPERATION_REVEAL_EVENT_CHANNEL = "operation:reveal";

export interface OperationReveal {
  readonly operationId: string;
  readonly reason: string;
  readonly at: number;
}

const reveals = new Map<string, OperationReveal>();
const revealListeners = new Set<() => void>();

export function isOperationRevealEvent(value: unknown): value is OperationReveal {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.operationId === "string" && typeof record.reason === "string" && typeof record.at === "number";
}

export function recordOperationReveal(event: OperationReveal): void {
  reveals.set(event.operationId, { operationId: event.operationId, reason: event.reason.slice(0, 200), at: event.at });
  for (const listener of revealListeners) listener();
}

export function getOperationReveal(operationId: string): OperationReveal | null {
  return reveals.get(operationId) ?? null;
}

export function subscribeOperationReveals(listener: () => void): () => void {
  revealListeners.add(listener);
  return () => { revealListeners.delete(listener); };
}

/** Operation의 콘솔 사용 허용 표식 — 서버가 쓰고 브라우저는 읽기만 한다. */
export function readConsoleUseEnabled(payload: Record<string, unknown> | undefined): boolean {
  const value = payload?.consoleUse;
  return !!value && typeof value === "object" && (value as { enabled?: unknown }).enabled === true;
}

export function readComputerUseEnabled(payload: Record<string, unknown> | undefined): boolean {
  const value = payload?.computerUse;
  return !!value && typeof value === "object" && (value as { enabled?: unknown }).enabled === true;
}

export async function setComputerUse(api: ClientApiCapability, operationId: string, enabled: boolean, language: "en" | "ko"): Promise<void> {
  await api.fetch(null, `experiments/sessions/${encodeURIComponent(operationId)}/computer-use`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, language }),
  });
}

/** 패널 안 허용 요청에 답한다. 실패(이미 풀린 요청·실험 꺼짐)는 던진다 — 카드가 다시 누르게 한다. */
export async function answerUseRequest(api: ClientApiCapability, input: { readonly operationId: string; readonly requestId: string; readonly capability: "console" | "computer"; readonly decision: "deny" | "turn" | "always"; readonly language: "en" | "ko" }): Promise<void> {
  const response = await api.fetch(null, `experiments/sessions/${encodeURIComponent(input.operationId)}/use-requests/${encodeURIComponent(input.requestId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: input.decision, capability: input.capability, language: input.language }),
  });
  if (!response.ok) throw new Error(`use_request_${response.status}`);
}

export async function setConsoleUse(api: ClientApiCapability, operationId: string, enabled: boolean, language: "en" | "ko"): Promise<void> {
  await api.fetch(null, `experiments/sessions/${encodeURIComponent(operationId)}/console-use`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, language }),
  });
}
