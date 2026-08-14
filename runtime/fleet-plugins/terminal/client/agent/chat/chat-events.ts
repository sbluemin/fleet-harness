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
  /** 라이브 전용 글자 단위 델타 — 저널에는 실리지 않으며, 완성 text 이벤트가 정정 앵커다. */
  | { readonly kind: "text-delta"; readonly text: string }
  | { readonly kind: "tool"; readonly name: string; readonly detail: string }
  /** answer는 SDK result가 말한 최종 응답 텍스트 — 마지막 text의 Answer 승격에 대한 서버 권위. */
  | { readonly kind: "turn-end"; readonly ok: boolean; readonly durationMs?: number; readonly answer?: string }
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
    case "text-delta":
      if (typeof event.text !== "string") return null;
      return { seq: entry.seq, event: { kind: "text-delta", text: event.text } };
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
          ...(typeof event.answer === "string" && event.answer.length > 0 ? { answer: event.answer } : {}),
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
  /** 라이브 델타 누적 버퍼 — 완성 text 이벤트가 도착하면 비워지고 아이템으로 확정된다. */
  readonly draft: string;
  /** turn-end가 실어온 서버 권위의 최종 응답 텍스트. */
  readonly answer?: string;
  /** turn-start 시각 — 진행 중 elapsed 티커의 기준. */
  readonly startedAt?: number;
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
        draft: "",
      };
      return { ...state, turns: [...settleLastTurn(state), turn] };
    }
    case "turn-start":
      return withLastTurn(state, (turn) => ({
        ...turn,
        state: "working",
        ...(event.at !== undefined ? { startedAt: event.at } : {}),
      }));
    case "text":
      // 완성 text는 흘러온 델타의 정정 앵커다 — 버퍼를 비우고 확정 아이템으로 치환한다.
      return withLastTurn(appendItem(state, { type: "text", text: event.text }), (turn) => ({ ...turn, draft: "" }));
    case "text-delta":
      return withLastTurn(state, (turn) => turn.state === "working" ? { ...turn, draft: turn.draft + event.text } : turn);
    case "tool":
      return appendItem(state, { type: "tool", name: event.name, detail: event.detail });
    case "turn-end":
      return withLastTurn(state, (turn) => ({
        ...turn,
        // 델타만 받고 완성 text 없이 턴이 끝나면(스트림 조기 종료) 버퍼를 아이템으로 회수한다.
        ...(turn.draft.length > 0
          ? { items: [...turn.items, { type: "text" as const, text: turn.draft }], draft: "" }
          : { draft: "" }),
        state: event.ok ? "done" : "error",
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.answer !== undefined ? { answer: event.answer } : {}),
      }));
    case "status":
      return { ...state, working: event.working };
    case "error":
      return { ...state, errorCode: event.code };
    default:
      return state;
  }
}

/** 뷰가 소비하는 턴의 파생 형태 — 원장(과정)과 Answer(결론)와 스트리밍 말미를 가른다. */
export interface AgentChatTurnView {
  /** 접힌 영수증에 들어가는 과정 아이템 — Answer로 승격된 말미 텍스트는 제외된다. */
  readonly ledger: readonly AgentChatTurnItem[];
  /** done 턴의 확정 응답. 서버 권위(turn-end.answer)가 있으면 그것, 없으면 말미 text 승격. */
  readonly answer: string | null;
  /** working 턴이 지금 흘리고 있는 말미 텍스트(확정 text 아이템 + 델타 버퍼). */
  readonly streamingText: string | null;
}

/**
 * 턴을 뷰 구조로 가른다. done 턴의 말미 text 아이템은 Answer로 승격되어 원장에서 빠진다 —
 * 서버 answer가 있으면 그것이 권위이고, 말미 text와 같은 내용이면 중복을 걷어낸다. 재생 턴은
 * turn-end 이벤트가 없으므로 말미 승격 규칙이 곧 Answer 판정이다.
 */
export function splitAgentChatTurn(turn: AgentChatTurn): AgentChatTurnView {
  const last = turn.items.at(-1);
  const trailingText = last?.type === "text" ? last.text ?? "" : null;
  if (turn.state === "working") {
    const streaming = (trailingText ?? "") + turn.draft;
    return {
      ledger: trailingText !== null ? turn.items.slice(0, -1) : turn.items,
      answer: null,
      streamingText: streaming.length > 0 ? streaming : null,
    };
  }
  if (turn.state === "error") {
    return { ledger: turn.items, answer: null, streamingText: null };
  }
  if (turn.answer !== undefined) {
    const promoted = trailingText !== null && trailingText.trim() === turn.answer.trim();
    return { ledger: promoted ? turn.items.slice(0, -1) : turn.items, answer: turn.answer, streamingText: null };
  }
  if (trailingText !== null && trailingText.length > 0) {
    return { ledger: turn.items.slice(0, -1), answer: trailingText, streamingText: null };
  }
  return { ledger: turn.items, answer: null, streamingText: null };
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
    const turn: AgentChatTurn = { dispatch: null, items: [item], state: state.replaying ? "done" : "working", toolCount: item.type === "tool" ? 1 : 0, draft: "" };
    return { ...state, turns: [turn] };
  }
  return withLastTurn(state, (turn) => ({
    ...turn,
    items: [...turn.items, item],
    toolCount: turn.toolCount + (item.type === "tool" ? 1 : 0),
  }));
}
