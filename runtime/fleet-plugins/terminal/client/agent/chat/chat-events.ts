/**
 * 서버 chat-stream 이벤트의 브라우저 쪽 어휘와 해석기.
 *
 * 서버 모듈(server/agent-api/chat-events.ts)과 같은 union을 손으로 복제한다 — 클라이언트
 * 번들이 서버 디렉터리를 import하면 Node 의존이 딸려 들어온다. 두 정의의 일치는
 * tests/agent-chat-events.test.ts가 못 박는다.
 */

export type AgentChatStreamEvent =
  | { readonly kind: "replay-start" }
  | { readonly kind: "replay-end"; readonly turns: number }
  | { readonly kind: "dispatch"; readonly text: string; readonly at?: number }
  | { readonly kind: "turn-start"; readonly at?: number }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly detail: string }
  | { readonly kind: "turn-end"; readonly ok: boolean; readonly durationMs?: number }
  | { readonly kind: "status"; readonly working: boolean }
  | { readonly kind: "error"; readonly code: string };

export interface AgentChatJournalEvent {
  readonly seq: number;
  readonly event: AgentChatStreamEvent;
}

export function readChatJournalEvent(raw: string): AgentChatJournalEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const entry = parsed as { readonly seq?: unknown; readonly event?: unknown };
  if (typeof entry.seq !== "number" || !entry.event || typeof entry.event !== "object") return null;
  const event = entry.event as { readonly kind?: unknown } & Record<string, unknown>;
  switch (event.kind) {
    case "replay-start":
      return { seq: entry.seq, event: { kind: "replay-start" } };
    case "replay-end":
      return { seq: entry.seq, event: { kind: "replay-end", turns: numberOr(event.turns, 0) } };
    case "dispatch":
      if (typeof event.text !== "string") return null;
      return { seq: entry.seq, event: { kind: "dispatch", text: event.text, ...atField(event.at) } };
    case "turn-start":
      return { seq: entry.seq, event: { kind: "turn-start", ...atField(event.at) } };
    case "text":
      if (typeof event.text !== "string") return null;
      return { seq: entry.seq, event: { kind: "text", text: event.text } };
    case "tool":
      if (typeof event.name !== "string") return null;
      return { seq: entry.seq, event: { kind: "tool", name: event.name, detail: typeof event.detail === "string" ? event.detail : "" } };
    case "turn-end":
      return {
        seq: entry.seq,
        event: {
          kind: "turn-end",
          ok: event.ok === true,
          ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}),
        },
      };
    case "status":
      return { seq: entry.seq, event: { kind: "status", working: event.working === true } };
    case "error":
      if (typeof event.code !== "string") return null;
      return { seq: entry.seq, event: { kind: "error", code: event.code } };
    default:
      return null;
  }
}

function atField(value: unknown): { readonly at?: number } {
  return typeof value === "number" && Number.isFinite(value) ? { at: value } : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ── 그룹핑: 평평한 이벤트 스트림 → 지휘 로그의 턴 구조 ────────────────────────

export interface AgentChatTurnItem {
  readonly type: "text" | "tool";
  readonly text?: string;
  readonly name?: string;
  readonly detail?: string;
}

export interface AgentChatTurn {
  readonly dispatch: { readonly text: string; readonly at?: number } | null;
  readonly items: readonly AgentChatTurnItem[];
  readonly state: "done" | "working" | "error";
  readonly durationMs?: number;
  readonly toolCount: number;
}

export interface AgentChatLogState {
  readonly turns: readonly AgentChatTurn[];
  readonly replaying: boolean;
  readonly replayedTurns: number;
  readonly working: boolean;
  readonly errorCode: string | null;
}

export const initialAgentChatLogState: AgentChatLogState = {
  turns: [],
  replaying: false,
  replayedTurns: 0,
  working: false,
  errorCode: null,
};

/**
 * 이벤트 하나를 로그 상태에 접는다. 재생 구간의 턴은 전부 done으로 닫고, 라이브 구간은
 * turn-start/turn-end가 상태를 옮긴다. dispatch는 항상 새 턴을 연다.
 */
export function reduceAgentChatLog(state: AgentChatLogState, event: AgentChatStreamEvent): AgentChatLogState {
  switch (event.kind) {
    case "replay-start":
      return { ...initialAgentChatLogState, replaying: true };
    case "replay-end":
      return { ...state, replaying: false, replayedTurns: event.turns };
    case "dispatch": {
      const turn: AgentChatTurn = {
        dispatch: { text: event.text, ...(event.at !== undefined ? { at: event.at } : {}) },
        items: [],
        state: state.replaying ? "done" : "working",
        toolCount: 0,
      };
      return { ...state, turns: [...settleLastTurn(state), turn] };
    }
    case "turn-start":
      return withLastTurn(state, (turn) => ({ ...turn, state: "working" }));
    case "text":
      return appendItem(state, { type: "text", text: event.text });
    case "tool":
      return appendItem(state, { type: "tool", name: event.name, detail: event.detail });
    case "turn-end":
      return withLastTurn(state, (turn) => ({
        ...turn,
        state: event.ok ? "done" : "error",
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
      }));
    case "status":
      return { ...state, working: event.working };
    case "error":
      return { ...state, errorCode: event.code };
    default:
      return state;
  }
}

/** 재생 중 dispatch가 연달아 오면 앞 턴은 그 시점에 닫힌 것이다. */
function settleLastTurn(state: AgentChatLogState): readonly AgentChatTurn[] {
  if (!state.replaying) return state.turns;
  const last = state.turns.at(-1);
  if (!last || last.state === "done") return state.turns;
  return [...state.turns.slice(0, -1), { ...last, state: "done" }];
}

function withLastTurn(state: AgentChatLogState, update: (turn: AgentChatTurn) => AgentChatTurn): AgentChatLogState {
  const last = state.turns.at(-1);
  if (!last) return state;
  return { ...state, turns: [...state.turns.slice(0, -1), update(last)] };
}

function appendItem(state: AgentChatLogState, item: AgentChatTurnItem): AgentChatLogState {
  const last = state.turns.at(-1);
  // 재생이 dispatch 이전의 assistant 줄로 시작할 수 있다(파일 중간 잘림) — 디스패치 없는 턴으로 담는다.
  if (!last) {
    const turn: AgentChatTurn = { dispatch: null, items: [item], state: state.replaying ? "done" : "working", toolCount: item.type === "tool" ? 1 : 0 };
    return { ...state, turns: [turn] };
  }
  return withLastTurn(state, (turn) => ({
    ...turn,
    items: [...turn.items, item],
    toolCount: turn.toolCount + (item.type === "tool" ? 1 : 0),
  }));
}
