import type { ClientApiCapability, PromptRefineInput, PromptRefinement } from "@fleet-console/sdk/plugin";

/** 서버 `experiments-routes.ts`의 채널 이름과 같은 값 — 두 번들이 문자열로만 만난다. */
export const SESSION_WATCH_EVENT_CHANNEL = "terminal:session-watch";

export interface SessionWatchAlert {
  readonly operationId: string;
  readonly phase: "alert";
  readonly kind: "drift" | "repeat" | "destructive";
  readonly title: string;
  readonly body: string;
  readonly at: number;
}

/** 서버가 채널에 싣는 검토 상태 — 시작·이상 없음·실패·경고. 경고만 알림이 되고 나머지는 캡션 버튼이 보여 준다. */
export type SessionWatchEvent =
  | { readonly operationId: string; readonly phase: "started" | "clear"; readonly at: number }
  | { readonly operationId: string; readonly phase: "failed"; readonly reason?: string; readonly at: number }
  | SessionWatchAlert;

export function isSessionWatchEvent(value: unknown): value is SessionWatchEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.operationId !== "string" || typeof record.at !== "number") return false;
  if (record.phase === "started" || record.phase === "clear" || record.phase === "failed") return true;
  return record.phase === "alert" && typeof record.title === "string" && typeof record.body === "string";
}

export function isSessionWatchAlert(value: unknown): value is SessionWatchAlert {
  return isSessionWatchEvent(value) && value.phase === "alert";
}

/** Operation별 마지막 검토 상태 — 캡션 버튼의 busy·툴팁이 읽는다. */
export interface SessionWatchReview {
  readonly phase: "started" | "clear" | "failed" | "alert";
  readonly at: number;
  readonly title?: string;
  readonly body?: string;
  readonly kind?: "drift" | "repeat" | "destructive";
  readonly reason?: string;
  /** 검토 중에도 직전 결과를 보여 주기 위해 남긴다 — "검토 중"이 마지막 경고를 지우면 안 된다. */
  readonly previous?: SessionWatchReview;
}

const reviews = new Map<string, SessionWatchReview>();
const reviewListeners = new Set<() => void>();

export function recordSessionWatchEvent(event: SessionWatchEvent): void {
  const current = reviews.get(event.operationId);
  const previous = current?.phase === "started" ? current.previous : current;
  reviews.set(event.operationId, {
    phase: event.phase,
    at: event.at,
    ...(event.phase === "alert" ? { title: event.title, body: event.body, kind: event.kind } : {}),
    ...(event.phase === "failed" && event.reason ? { reason: event.reason } : {}),
    ...(event.phase === "started" && previous ? { previous } : {}),
  });
  for (const listener of reviewListeners) listener();
}

export function clearSessionWatchReview(operationId: string): void {
  if (!reviews.delete(operationId)) return;
  for (const listener of reviewListeners) listener();
}

export function getSessionWatchReview(operationId: string): SessionWatchReview | null {
  return reviews.get(operationId) ?? null;
}

export function subscribeSessionWatchReviews(listener: () => void): () => void {
  reviewListeners.add(listener);
  return () => { reviewListeners.delete(listener); };
}

/** Operation payload의 관찰 표식 — 서버가 쓰고 브라우저는 읽기만 한다. */
export function readWatchEnabled(payload: Record<string, unknown> | undefined): boolean {
  const watch = payload?.watch;
  return !!watch && typeof watch === "object" && (watch as { enabled?: unknown }).enabled === true;
}

/**
 * 서버가 payload.watch.last에 남긴 마지막 검토 결과. 새로고침이나 다른 창은 SSE로 지난 이벤트를 받지
 * 못하므로, 산 이벤트가 없을 때 라벨은 이것을 읽는다. 모양이 맞지 않으면 없는 것으로 친다.
 */
export function readWatchLast(payload: Record<string, unknown> | undefined): SessionWatchReview | null {
  const watch = payload?.watch;
  if (!watch || typeof watch !== "object") return null;
  const last = (watch as { last?: unknown }).last;
  if (!last || typeof last !== "object") return null;
  const record = last as Record<string, unknown>;
  const phase = record.phase;
  if ((phase !== "clear" && phase !== "failed" && phase !== "alert") || typeof record.at !== "number") return null;
  const kind = record.kind === "drift" || record.kind === "repeat" || record.kind === "destructive" ? record.kind : undefined;
  return {
    phase,
    at: record.at,
    ...(typeof record.title === "string" ? { title: record.title } : {}),
    ...(typeof record.body === "string" ? { body: record.body } : {}),
    ...(kind ? { kind } : {}),
    ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
  };
}

export async function setSessionWatch(api: ClientApiCapability, operationId: string, enabled: boolean, language: "en" | "ko"): Promise<void> {
  await api.fetch("terminal", `experiments/sessions/${encodeURIComponent(operationId)}/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled, language }),
  });
}

/**
 * 프롬프트 다듬기 — 코어가 넘긴 입력을 그대로 서버에 묻는다. 꺼짐(404)·실패는 전부 null이다: 초안이
 * 없는 것이지 오류가 아니며, 컴포저는 수동 흐름 그대로 남는다.
 */
export async function refineLaunchPrompt(api: ClientApiCapability | null, input: PromptRefineInput): Promise<PromptRefinement | null> {
  if (!api) return null;
  try {
    const response = await api.fetch("terminal", "experiments/refine-prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: input.prompt, theaterLabel: input.theaterLabel, language: input.language }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const payload = await response.json() as { readonly refinement?: unknown };
    return isPromptRefinement(payload.refinement) ? payload.refinement : null;
  } catch {
    return null;
  }
}

function isPromptRefinement(value: unknown): value is PromptRefinement {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.prompt === "string" && Array.isArray(record.notes) && record.notes.every((note) => typeof note === "string");
}
