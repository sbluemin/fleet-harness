/**
 * 서버 chat-stream 이벤트의 브라우저 쪽 어휘와 해석기.
 *
 * 서버 모듈(server/agent-api/chat-events.ts)과 같은 union을 손으로 복제한다 — 클라이언트
 * 번들이 서버 디렉터리를 import하면 Node 의존이 딸려 들어온다. 두 정의의 일치는
 * tests/agent-chat-events.test.ts가 못 박는다.
 */

/** 쓰기 계열 도구가 남긴 파일 변경 — 서버가 도구 입력에서 접어 보낸다. */
export interface AgentChatChange {
  readonly file: string;
  readonly added: number;
  readonly removed: number;
}

export type AgentChatStreamEvent =
  | { readonly kind: "replay-start" }
  | { readonly kind: "replay-end"; readonly turns: number }
  | { readonly kind: "dispatch"; readonly text: string; readonly at?: number }
  | { readonly kind: "turn-start"; readonly at?: number }
  | { readonly kind: "text"; readonly text: string }
  /** 라이브 전용 글자 단위 델타 — 저널에는 실리지 않으며, 완성 text 이벤트가 정정 앵커다. */
  | { readonly kind: "text-delta"; readonly text: string }
  /** 라이브 전용 — 인자 JSON이 끝나기 전에 도착하는 도구 이름. 완성 tool 이벤트가 좌표를 채운다. */
  | { readonly kind: "tool-start"; readonly id: string; readonly name: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly detail: string;
      readonly id?: string;
      readonly outside?: boolean;
      readonly change?: AgentChatChange;
    }
  | { readonly kind: "tool-result"; readonly id: string; readonly ok: boolean; readonly summary: string }
  /** answer는 SDK result가 말한 최종 응답 텍스트 — 마지막 text의 Answer 승격에 대한 서버 권위. */
  | { readonly kind: "turn-end"; readonly ok: boolean; readonly durationMs?: number; readonly answer?: string }
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
    case "tool-start":
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      if (typeof event.name !== "string" || event.name.length === 0) return null;
      return { seq: entry.seq, event: { kind: "tool-start", id: event.id, name: event.name } };
    case "tool":
      if (typeof event.name !== "string") return null;
      return {
        seq: entry.seq,
        event: {
          kind: "tool",
          name: event.name,
          detail: typeof event.detail === "string" ? event.detail : "",
          ...(typeof event.id === "string" && event.id.length > 0 ? { id: event.id } : {}),
          ...(event.outside === true ? { outside: true } : {}),
          ...(readChange(event.change) ? { change: readChange(event.change) as AgentChatChange } : {}),
        },
      };
    case "tool-result":
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      return {
        seq: entry.seq,
        event: {
          kind: "tool-result",
          id: event.id,
          ok: event.ok === true,
          summary: typeof event.summary === "string" ? event.summary : "",
        },
      };
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
    case "error":
      if (typeof event.code !== "string") return null;
      return { seq: entry.seq, event: { kind: "error", code: event.code } };
    default:
      return null;
  }
}

function readChange(value: unknown): AgentChatChange | null {
  if (!value || typeof value !== "object") return null;
  const change = value as { readonly file?: unknown; readonly added?: unknown; readonly removed?: unknown };
  if (typeof change.file !== "string" || change.file.length === 0) return null;
  return { file: change.file, added: numberOr(change.added, 0), removed: numberOr(change.removed, 0) };
}

function atField(value: unknown): { readonly at?: number } {
  return typeof value === "number" && Number.isFinite(value) ? { at: value } : {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// ── 그룹핑: 평평한 이벤트 스트림 → 지휘 로그의 턴 구조 ────────────────────────

/** 스텝의 결말. running은 아직 돌아오지 않은 것이고, done은 결과 없이 턴이 닫힌 것이다. */
export type AgentChatStepState = "running" | "ok" | "fail" | "done";

export interface AgentChatTurnItem {
  readonly type: "text" | "tool";
  readonly text?: string;
  readonly name?: string;
  readonly detail?: string;
  readonly id?: string;
  readonly state?: AgentChatStepState;
  readonly result?: string;
  readonly outside?: boolean;
  readonly change?: AgentChatChange;
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
  readonly errorCode: string | null;
}

/** 서버 chat-events의 MAX_TEXT_CHARS와 같은 상한 — 확정 text가 이 길이로 도착하므로 draft도 같은 캡을 진다. */
const MAX_DRAFT_CHARS = 60_000;

export const initialAgentChatLogState: AgentChatLogState = {
  turns: [],
  replaying: false,
  replayedTurns: 0,
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
      // 델타 개별은 서버가 캡을 지키지만 누적 버퍼는 여기서 다시 상한을 진다 — 병합 앵커가
      // 도착하기 전의 초장문 응답이 draft를 무한히 키우면 매 렌더가 그 전체를 복사한다.
      return withLastTurn(state, (turn) => {
        if (turn.state !== "working" || turn.draft.length >= MAX_DRAFT_CHARS) return turn;
        return { ...turn, draft: (turn.draft + event.text).slice(0, MAX_DRAFT_CHARS) };
      });
    case "tool-start":
      // 이름만 아는 스텝을 먼저 세운다. 뒤따르는 완성 tool 이벤트가 같은 id로 좌표를 채운다.
      return appendItem(state, { type: "tool", name: event.name, detail: "", id: event.id, state: "running" });
    case "tool": {
      // 재생 구간의 스텝은 이미 끝난 일이다 — 결과 줄이 뒤따르면 ok/fail로 다시 옮겨 붙는다.
      const initial: AgentChatStepState = state.replaying ? "done" : "running";
      const filled: AgentChatTurnItem = {
        type: "tool",
        name: event.name,
        detail: event.detail,
        state: initial,
        ...(event.id !== undefined ? { id: event.id } : {}),
        ...(event.outside === true ? { outside: true } : {}),
        ...(event.change ? { change: event.change } : {}),
      };
      // tool-start가 이미 세운 스텝이면 새 줄을 만들지 않고 그 자리를 채운다.
      const merged = event.id !== undefined
        ? mergeItemById(state, event.id, (item) => ({ ...filled, state: item.state ?? initial }))
        : null;
      return merged ?? appendItem(state, filled);
    }
    case "tool-result": {
      const merged = mergeItemById(state, event.id, (item) => ({
        ...item,
        state: event.ok ? "ok" : "fail",
        ...(event.summary.length > 0 ? { result: event.summary } : {}),
      }));
      // 짝을 못 찾은 결과는 버린다 — 좌표 없는 결말은 원장에 세울 자리가 없다.
      return merged ?? state;
    }
    case "turn-end":
      return withLastTurn(state, (turn) => ({
        ...turn,
        // 델타만 받고 완성 text 없이 턴이 끝나면(스트림 조기 종료) 버퍼를 아이템으로 회수한다.
        ...(turn.draft.length > 0
          ? { items: [...settleRunningSteps(turn.items), { type: "text" as const, text: turn.draft }], draft: "" }
          : { items: settleRunningSteps(turn.items), draft: "" }),
        state: event.ok ? "done" : "error",
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.answer !== undefined ? { answer: event.answer } : {}),
      }));
    case "error":
      return { ...state, errorCode: event.code };
    default:
      return state;
  }
}

/**
 * 턴이 닫히면 아직 돌지 않은 스텝은 done으로 가라앉는다 — 결과를 못 받았을 뿐 실패는 아니다.
 * running을 그대로 두면 끝난 턴에 진행 링이 영원히 돈다.
 */
function settleRunningSteps(items: readonly AgentChatTurnItem[]): readonly AgentChatTurnItem[] {
  if (!items.some((item) => item.state === "running")) return items;
  return items.map((item) => (item.state === "running" ? { ...item, state: "done" as const } : item));
}

/** 뷰가 소비하는 턴의 파생 형태 — 원장(과정)과 Answer(결론)와 스트리밍 말미를 가른다. */
export interface AgentChatTurnView {
  /** 접힌 원장에 들어가는 과정 아이템 — Answer로 승격된 말미 텍스트는 제외된다. */
  readonly ledger: readonly AgentChatTurnItem[];
  /** done 턴의 확정 응답. 서버 권위(turn-end.answer)가 있으면 그것, 없으면 말미 text 승격. */
  readonly answer: string | null;
  /** working 턴이 지금 흘리고 있는 말미 텍스트(확정 text 아이템 + 델타 버퍼). */
  readonly streamingText: string | null;
  /** 이 턴이 건드린 파일 — 같은 파일의 여러 쓰기는 한 줄로 합친다. */
  readonly changes: readonly AgentChatChange[];
  /** 결과가 실패로 돌아온 스텝 수. 접힌 줄이 이 값을 말한다. */
  readonly failed: number;
}

/**
 * 턴을 뷰 구조로 가른다. done 턴의 말미 text 아이템은 Answer로 승격되어 원장에서 빠진다 —
 * 서버 answer가 있으면 그것이 권위이고, 말미 text와 같은 내용이면 중복을 걷어낸다. 재생 턴은
 * turn-end 이벤트가 없으므로 말미 승격 규칙이 곧 Answer 판정이다.
 */
export function splitAgentChatTurn(turn: AgentChatTurn): AgentChatTurnView {
  const last = turn.items.at(-1);
  const trailingText = last?.type === "text" ? last.text ?? "" : null;
  const changes = collectChanges(turn.items);
  const failed = turn.items.reduce((count, item) => count + (item.state === "fail" ? 1 : 0), 0);
  if (turn.state === "working") {
    const streaming = (trailingText ?? "") + turn.draft;
    return {
      ledger: trailingText !== null ? turn.items.slice(0, -1) : turn.items,
      answer: null,
      streamingText: streaming.length > 0 ? streaming : null,
      changes,
      failed,
    };
  }
  if (turn.state === "error") {
    return { ledger: turn.items, answer: null, streamingText: null, changes, failed };
  }
  if (turn.answer !== undefined) {
    const promoted = trailingText !== null && trailingText.trim() === turn.answer.trim();
    return {
      ledger: promoted ? turn.items.slice(0, -1) : turn.items,
      answer: turn.answer,
      streamingText: null,
      changes,
      failed,
    };
  }
  if (trailingText !== null && trailingText.length > 0) {
    return { ledger: turn.items.slice(0, -1), answer: trailingText, streamingText: null, changes, failed };
  }
  return { ledger: turn.items, answer: null, streamingText: null, changes, failed };
}

/**
 * 도구 이름을 계열로 접는다. 원장이 스텝을 하나하나 세는 대신 "무엇을 몇 번 했는가"로 읽히려면
 * 집계 축이 이름이 아니라 계열이어야 한다 — Read와 NotebookRead는 사용자에게 같은 일이다.
 */
const TOOL_FAMILIES: Readonly<Record<string, string>> = {
  Read: "read",
  NotebookRead: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "run",
  BashOutput: "run",
  Glob: "search",
  Grep: "search",
  WebSearch: "search",
  WebFetch: "fetch",
  Task: "delegate",
  Agent: "delegate",
  TodoWrite: "plan",
};

export function agentChatToolFamily(name: string | undefined): string {
  return (name !== undefined ? TOOL_FAMILIES[name] : undefined) ?? "other";
}

/** 집계 한 덩어리 — 계열과 그 계열로 끝난 스텝 수. `other`는 도구 이름별로 따로 센다. */
export interface AgentChatStepGroup {
  readonly family: string;
  /** `other` 계열의 표시 이름. 알려진 계열에서는 비어 있다. */
  readonly name?: string;
  readonly count: number;
}

export interface AgentChatLedgerView {
  /** 순서대로 자기 줄을 지키는 것 — 문장, 실패한 스텝, Theater 밖 스텝. */
  readonly inline: readonly AgentChatTurnItem[];
  /** 한 줄 집계로 접힌 평범한 완료 스텝. */
  readonly groups: readonly AgentChatStepGroup[];
  /** 지금 도는 스텝 — 집계에 접지 않는다. "지금 무엇을 하는가"가 이 뷰의 값이다. */
  readonly running: readonly AgentChatTurnItem[];
}

/**
 * 원장을 "집계 + 예외"로 가른다. 예외는 언제나 줄을 지킨다 — 진행 중인 스텝, 실패한 스텝,
 * Theater 밖을 가리킨 스텝, 그리고 모델이 남긴 문장.
 *
 * 평범한 완료 스텝을 언제 접는지는 국면이 정한다. 턴이 도는 동안에는 방금 무엇을 했는지가
 * 곧 "개발 중"이라는 감각이므로 최근 것들은 순서대로 남기고(`recentLimit`), 그보다 오래된
 * 것만 앞머리 한 줄로 접는다. 턴이 끝나면 남길 이유가 없다 — 전부 집계로 접히고, 결론이
 * 화면을 차지한다(`recentLimit: 0`).
 */
export function groupAgentChatLedger(
  items: readonly AgentChatTurnItem[],
  recentLimit = 0,
): AgentChatLedgerView {
  // 뒤에서부터 세어, 인라인으로 남길 평범한 완료 스텝의 경계를 먼저 정한다.
  let keep = recentLimit;
  const inlineRoutine = new Set<number>();
  if (keep > 0) {
    for (let index = items.length - 1; index >= 0 && keep > 0; index -= 1) {
      const item = items[index];
      if (!item || item.type !== "tool") continue;
      if (item.state === "running" || item.state === "fail" || item.outside === true) continue;
      inlineRoutine.add(index);
      keep -= 1;
    }
  }

  const inline: AgentChatTurnItem[] = [];
  const running: AgentChatTurnItem[] = [];
  const groups: AgentChatStepGroup[] = [];
  const index = new Map<string, number>();
  items.forEach((item, at) => {
    if (item.type === "text") { inline.push(item); return; }
    if (item.state === "running") { running.push(item); return; }
    if (item.state === "fail" || item.outside === true || inlineRoutine.has(at)) { inline.push(item); return; }
    const family = agentChatToolFamily(item.name);
    const key = family === "other" ? `other:${item.name ?? ""}` : family;
    const seen = index.get(key);
    if (seen === undefined) {
      index.set(key, groups.length);
      groups.push({ family, count: 1, ...(family === "other" ? { name: item.name ?? "" } : {}) });
    } else {
      const current = groups[seen];
      if (current) groups[seen] = { ...current, count: current.count + 1 };
    }
  });
  return { inline, groups, running };
}

/** 같은 파일을 여러 번 쓴 턴은 파일 하나로 합산한다 — 장부는 파일 단위다. */
function collectChanges(items: readonly AgentChatTurnItem[]): readonly AgentChatChange[] {
  const byFile = new Map<string, { file: string; added: number; removed: number }>();
  for (const item of items) {
    // 실패한 쓰기는 장부에 오르지 않는다 — 남지 않은 변경이다.
    if (!item.change || item.state === "fail") continue;
    const entry = byFile.get(item.change.file);
    if (entry) {
      entry.added += item.change.added;
      entry.removed += item.change.removed;
    } else {
      byFile.set(item.change.file, { ...item.change });
    }
  }
  return [...byFile.values()];
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

/**
 * 마지막 턴에서 같은 id의 스텝을 찾아 갱신한다. 없으면 null — 호출부가 새로 세울지 버릴지 고른다.
 * 재생 구간에서는 여러 턴이 한 번에 쌓이므로 마지막 턴만 보고 판단하면 짝을 놓친다: 뒤에서부터
 * 훑어 처음 만나는 턴에서 잇는다.
 */
function mergeItemById(
  state: AgentChatLogState,
  id: string,
  update: (item: AgentChatTurnItem) => AgentChatTurnItem,
): AgentChatLogState | null {
  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = state.turns[turnIndex];
    if (!turn) continue;
    const itemIndex = turn.items.findIndex((item) => item.type === "tool" && item.id === id);
    if (itemIndex < 0) continue;
    const current = turn.items[itemIndex];
    if (!current) continue;
    const items = [...turn.items];
    items[itemIndex] = update(current);
    const turns = [...state.turns];
    turns[turnIndex] = { ...turn, items };
    return { ...state, turns };
  }
  return null;
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
