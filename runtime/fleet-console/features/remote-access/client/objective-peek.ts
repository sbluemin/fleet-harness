import {
  CONSOLE_OBJECTIVE_PEEK_EVENT,
  isConsoleObjectivePeekReply,
  type ConsoleObjectivePeek,
  type ConsoleObjectivePeekStatus,
} from "@fleet-console/protocol/desktop/console-section";

export type ObjectivePeekTab = "goal" | "crew" | "results";
export interface ObjectivePeekTarget {
  readonly console: string;
  readonly objective: string;
  readonly machine: string;
  readonly title: string;
  readonly opener: HTMLElement;
  readonly request: (nonce: string) => void;
  readonly openConsole: () => void;
}
export interface ObjectivePeekSelection {
  /** 같은 목표 id가 다른 Console에도 있어도 스냅샷을 섞지 않는다. */
  readonly key: string;
  readonly target: ObjectivePeekTarget;
  readonly tab: ObjectivePeekTab;
  readonly status: ConsoleObjectivePeekStatus | "loading";
  readonly snapshot: ConsoleObjectivePeek | null;
}

// 지역 objectives-state에 넣지 않고 열린 창 하나만 소유한다. 닫으면 모두 버린다.
let selection: ObjectivePeekSelection | null = null;
let nonce: string | null = null;
let refresh: ReturnType<typeof setInterval> | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };
export const objectivePeekSnapshot = (): ObjectivePeekSelection | null => selection;
export function subscribeObjectivePeek(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// 셸의 앞선 읽기 한 건(신원 8초 + HTTP 5초)과 이번 읽기, 전달 여유 4초를 기다린다.
const PEEK_REPLY_TIMEOUT_MS = 30_000;

function requestSnapshot(): void {
  if (!selection || nonce !== null) return;
  const current = crypto.randomUUID();
  nonce = current;
  timeout = setTimeout(() => {
    if (!selection || nonce !== current) return;
    nonce = null;
    selection = { ...selection, status: "unavailable", snapshot: null };
    emit();
  }, PEEK_REPLY_TIMEOUT_MS);
  try { selection.target.request(current); }
  catch {
    if (!selection || nonce !== current) return;
    clearTimeout(timeout);
    nonce = null;
    selection = { ...selection, status: "unavailable", snapshot: null };
    emit();
  }
}

export function openObjectivePeek(target: ObjectivePeekTarget, tab: ObjectivePeekTab): void {
  const key = JSON.stringify([target.console, target.objective]);
  if (selection?.key === key) {
    selection = { ...selection, target, tab };
    emit();
    return;
  }
  closeObjectivePeek(false);
  selection = { key, target, tab, status: "loading", snapshot: null };
  emit();
  requestSnapshot();
  refresh = setInterval(requestSnapshot, 15_000);
}

export function closeObjectivePeek(returnFocus = true): void {
  const opener = selection?.target.opener;
  clearInterval(refresh);
  clearTimeout(timeout);
  refresh = undefined;
  timeout = undefined;
  nonce = null;
  selection = null;
  emit();
  if (!returnFocus || !opener?.isConnected) return;
  const target = opener.getClientRects().length ? opener : opener.closest(".side-bar-cluster-row")?.querySelector<HTMLElement>(".side-bar-cluster-row-main");
  target?.focus({ preventScroll: true });
}

if (typeof window !== "undefined") {
  window.addEventListener(CONSOLE_OBJECTIVE_PEEK_EVENT, (event) => {
    const reply: unknown = (event as CustomEvent).detail;
    if (!isConsoleObjectivePeekReply(reply) || !selection || nonce === null || reply.nonce !== nonce
      || reply.console !== selection.target.console || reply.objective !== selection.target.objective) return;
    // 늦은 응답·다른 창·닫힌 창의 응답은 버린다. 목표 id도 본문과 대조한다.
    if (reply.status === "ok" && reply.snapshot?.id !== selection.target.objective) return;
    clearTimeout(timeout);
    nonce = null;
    selection = { ...selection, status: reply.status, snapshot: reply.status === "ok" ? reply.snapshot ?? null : null };
    emit();
  });
  window.addEventListener("pagehide", () => closeObjectivePeek(false));
}
