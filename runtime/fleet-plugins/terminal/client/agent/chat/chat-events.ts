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

export interface AgentChatQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface AgentChatQuestion {
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly options: readonly AgentChatQuestionOption[];
}

export type AgentChatAskForm = "question" | "plan";
export type AgentChatAskOutcome = "answered" | "dismissed" | "approved" | "revised";

/** 원장에 선 카드 하나. settled가 붙으면 접힌 줄로 바뀐다. */
export interface AgentChatAsk {
  readonly id: string;
  readonly form: AgentChatAskForm;
  readonly questions: readonly AgentChatQuestion[];
  readonly plan?: string;
  /** 계획이 잘렸다 — 보여 주지 못한 단계가 있으므로 카드는 승인을 열지 않는다. */
  readonly truncated?: true;
  readonly outcome?: AgentChatAskOutcome;
  readonly answers?: readonly { readonly header: string; readonly value: string }[];
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
  /** 모델이 멈춰 서서 사용자를 기다린다. 저널에 남으므로 재접속해도 같은 카드가 다시 선다. */
  | {
      readonly kind: "ask";
      readonly id: string;
      readonly form: AgentChatAskForm;
      readonly questions?: readonly AgentChatQuestion[];
      readonly plan?: string;
      readonly truncated?: true;
    }
  | {
      readonly kind: "ask-settled";
      readonly id: string;
      readonly outcome: AgentChatAskOutcome;
      readonly answers?: readonly { readonly header: string; readonly value: string }[];
    }
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
    case "ask": {
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      if (event.form !== "question" && event.form !== "plan") return null;
      const questions = readQuestions(event.questions);
      const plan = typeof event.plan === "string" && event.plan.length > 0 ? event.plan : undefined;
      // 형태가 비면 카드가 아무것도 못 그린다 — 빈 카드를 세우느니 이벤트를 버린다.
      if (event.form === "question" ? questions.length === 0 : plan === undefined) return null;
      return {
        seq: entry.seq,
        event: {
          kind: "ask",
          id: event.id,
          form: event.form,
          ...(questions.length > 0 ? { questions } : {}),
          ...(plan !== undefined ? { plan } : {}),
          ...(event.truncated === true ? { truncated: true } : {}),
        },
      };
    }
    case "ask-settled": {
      if (typeof event.id !== "string" || event.id.length === 0) return null;
      const outcome = event.outcome;
      if (outcome !== "answered" && outcome !== "dismissed" && outcome !== "approved" && outcome !== "revised") return null;
      const answers = Array.isArray(event.answers)
        ? event.answers.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const row = raw as { readonly header?: unknown; readonly value?: unknown };
          if (typeof row.header !== "string" || typeof row.value !== "string") return [];
          return [{ header: row.header, value: row.value }];
        })
        : [];
      return {
        seq: entry.seq,
        event: { kind: "ask-settled", id: event.id, outcome, ...(answers.length > 0 ? { answers } : {}) },
      };
    }
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

function readQuestions(value: unknown): readonly AgentChatQuestion[] {
  if (!Array.isArray(value)) return [];
  const questions: AgentChatQuestion[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.question !== "string" || entry.question.length === 0) continue;
    if (typeof entry.header !== "string" || entry.header.length === 0) continue;
    const options: AgentChatQuestionOption[] = [];
    if (Array.isArray(entry.options)) {
      for (const rawOption of entry.options) {
        if (!rawOption || typeof rawOption !== "object") continue;
        const option = rawOption as Record<string, unknown>;
        if (typeof option.label !== "string" || option.label.length === 0) continue;
        options.push({
          label: option.label,
          description: typeof option.description === "string" ? option.description : "",
        });
      }
    }
    if (options.length === 0) continue;
    questions.push({
      header: entry.header,
      question: entry.question,
      multiSelect: entry.multiSelect === true,
      options,
    });
  }
  return questions;
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
  readonly type: "text" | "tool" | "ask";
  /** type="ask"일 때의 카드. 대기 중이면 누를 수 있고, 결말이 붙으면 한 줄로 접힌다. */
  readonly ask?: AgentChatAsk;
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
    case "ask":
      return appendItem(state, {
        type: "ask",
        ask: {
          id: event.id,
          form: event.form,
          questions: event.questions ?? [],
          ...(event.plan !== undefined ? { plan: event.plan } : {}),
          ...(event.truncated === true ? { truncated: true } : {}),
        },
      });
    case "ask-settled": {
      // 재생 구간에서는 여러 턴이 한꺼번에 쌓이므로 마지막 턴만 보면 짝을 놓친다.
      const merged = mergeAskById(state, event.id, (ask) => ({
        ...ask,
        outcome: event.outcome,
        ...(event.answers ? { answers: event.answers } : {}),
      }));
      return merged ?? state;
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
  /** 아직 답하지 않은 카드가 있는가 — 이 턴은 일하는 중이 아니라 기다리는 중이다. */
  readonly awaiting: boolean;
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
  const awaiting = turn.items.some((item) => item.type === "ask" && item.ask?.outcome === undefined);
  if (turn.state === "working") {
    const streaming = (trailingText ?? "") + turn.draft;
    return {
      ledger: trailingText !== null ? turn.items.slice(0, -1) : turn.items,
      answer: null,
      streamingText: streaming.length > 0 ? streaming : null,
      changes,
      failed,
      awaiting,
    };
  }
  if (turn.state === "error") {
    return { ledger: turn.items, answer: null, streamingText: null, changes, failed, awaiting };
  }
  if (turn.answer !== undefined) {
    const promoted = trailingText !== null && trailingText.trim() === turn.answer.trim();
    return {
      ledger: promoted ? turn.items.slice(0, -1) : turn.items,
      answer: turn.answer,
      streamingText: null,
      changes,
      failed,
      awaiting,
    };
  }
  if (trailingText !== null && trailingText.length > 0) {
    return { ledger: turn.items.slice(0, -1), answer: trailingText, streamingText: null, changes, failed, awaiting };
  }
  return { ledger: turn.items, answer: null, streamingText: null, changes, failed, awaiting };
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
  // 재생 구간에서만 이 이름들이 스텝으로 온다 — 라이브에서는 카드가 그 자리를 대신한다.
  AskUserQuestion: "ask",
  ExitPlanMode: "propose",
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

/**
 * 원장의 한 구간 — 모델이 남긴 문장 하나와, 그 문장 뒤에 이어진 스텝들.
 *
 * 턴 전체를 하나로 집계하면 숫자가 끝없이 커지기만 하고("셸 7회 실행 · 파일 19개 읽음"),
 * 무엇을 하려고 그 도구들을 썼는지가 사라진다. 구간을 가르는 것은 모델 자신의 문장이다:
 * 문장이 의도를 말하고 바로 아래 한 줄이 그 의도로 한 일을 말한다.
 */
export interface AgentChatLedgerSegment {
  /** 이 구간을 여는 문장. 첫 도구가 문장보다 먼저 오면 없다. */
  readonly note?: string;
  /** 이 구간에서 한 줄로 접힌 평범한 완료 스텝의 집계. */
  readonly groups: readonly AgentChatStepGroup[];
  /** 그 집계 뒤에 실제로 있던 스텝들 — 집계 줄을 누르면 이것이 펼쳐진다. */
  readonly folded: readonly AgentChatTurnItem[];
  /** 접지 않고 줄을 지키는 것 — 실패한 스텝, Theater 밖 스텝, 그리고 열린 구간의 최근 스텝. */
  readonly inline: readonly AgentChatTurnItem[];
  /** 지금 도는 스텝. */
  readonly running: readonly AgentChatTurnItem[];
}

/**
 * 원장을 구간으로 가른다. 구간의 경계는 모델의 문장이고, 각 구간은 그 문장 뒤에 이어진
 * 스텝들을 한 줄로 접는다 — 한 턴이 여러 번 "문장 → 한 일" 쌍으로 읽힌다.
 *
 * 마지막 구간만 예외다. 턴이 도는 동안 그 구간은 열려 있어서, 최근 스텝(`recentLimit`)을
 * 순서대로 세워 둔다 — 방금 무엇을 했는지가 곧 "일하는 중"이라는 감각이다. 다음 문장이
 * 도착하거나 턴이 끝나면 그 구간도 닫히고 한 줄로 접힌다.
 *
 * 실패한 스텝과 Theater 밖을 가리킨 스텝은 어느 구간에서도 접지 않는다.
 */
export function segmentAgentChatLedger(
  items: readonly AgentChatTurnItem[],
  recentLimit = 0,
): readonly AgentChatLedgerSegment[] {
  const buckets: { note?: string; steps: AgentChatTurnItem[] }[] = [];
  for (const item of items) {
    if (item.type === "text") {
      buckets.push({ ...(item.text !== undefined ? { note: item.text } : {}), steps: [] });
      continue;
    }
    const last = buckets.at(-1);
    if (last) last.steps.push(item);
    else buckets.push({ steps: [item] });
  }
  if (buckets.length === 0) return [];

  return buckets.map((bucket, index) => {
    const open = recentLimit > 0 && index === buckets.length - 1;
    return foldSegment(bucket.note, bucket.steps, open ? recentLimit : 0);
  });
}

function foldSegment(
  note: string | undefined,
  steps: readonly AgentChatTurnItem[],
  recentLimit: number,
): AgentChatLedgerSegment {
  // 열린 구간에서는 뒤에서부터 세어 순서대로 남길 평범한 완료 스텝의 경계를 먼저 정한다.
  const keepInline = new Set<number>();
  let keep = recentLimit;
  for (let index = steps.length - 1; index >= 0 && keep > 0; index -= 1) {
    const step = steps[index];
    if (!step) continue;
    if (step.type === "ask") continue;
    if (step.state === "running" || step.state === "fail" || step.outside === true) continue;
    keepInline.add(index);
    keep -= 1;
  }

  const inline: AgentChatTurnItem[] = [];
  const running: AgentChatTurnItem[] = [];
  const folded: AgentChatTurnItem[] = [];
  const groups: AgentChatStepGroup[] = [];
  const seen = new Map<string, number>();
  steps.forEach((step, at) => {
    // 카드는 접지 않는다 — 접힌 질문은 답할 수 없고, 답한 뒤의 한 줄도 그 턴이 무엇으로
    // 갈렸는지 말하는 증거라 집계에 삼켜지면 안 된다.
    if (step.type === "ask") { inline.push(step); return; }
    if (step.state === "running") { running.push(step); return; }
    // 과거형 집계는 결과가 ok로 돌아온 스텝만 센다. 결과 없이 닫힌 스텝(`done`)을 "씀"으로
    // 세면, 같은 이유로 변경 장부에서 뺀 그 쓰기를 원장이 다시 했다고 말하는 셈이다 —
    // 두 표면이 서로 다른 사실을 말하게 된다. 확인되지 않은 것은 예외로 줄을 지킨다.
    if (step.state !== "ok" || step.outside === true || keepInline.has(at)) { inline.push(step); return; }
    folded.push(step);
    const family = agentChatToolFamily(step.name);
    const key = family === "other" ? `other:${step.name ?? ""}` : family;
    const found = seen.get(key);
    if (found === undefined) {
      seen.set(key, groups.length);
      groups.push({ family, count: 1, ...(family === "other" ? { name: step.name ?? "" } : {}) });
    } else {
      const current = groups[found];
      if (current) groups[found] = { ...current, count: current.count + 1 };
    }
  });
  return { ...(note !== undefined ? { note } : {}), groups, folded, inline, running };
}

/** 같은 파일을 여러 번 쓴 턴은 파일 하나로 합산한다 — 장부는 파일 단위다. */
function collectChanges(items: readonly AgentChatTurnItem[]): readonly AgentChatChange[] {
  const byFile = new Map<string, { file: string; added: number; removed: number }>();
  for (const item of items) {
    // 결과가 ok로 돌아온 쓰기만 장부에 오른다. 실패한 쓰기는 남지 않은 변경이고, 결과 없이
    // 끝난 쓰기(턴이 중간에 닫혀 done으로 가라앉은 스텝)는 일어났는지 자체를 모른다 —
    // 모르는 것을 "바뀌었다"로 세우면 이 원장이 고치려던 거짓말을 다시 하는 셈이다.
    if (!item.change || item.state !== "ok") continue;
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

/** 마지막 턴부터 거슬러 올라가며 같은 id의 카드를 찾아 갱신한다. 없으면 null. */
function mergeAskById(
  state: AgentChatLogState,
  id: string,
  update: (ask: AgentChatAsk) => AgentChatAsk,
): AgentChatLogState | null {
  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = state.turns[turnIndex];
    if (!turn) continue;
    const itemIndex = turn.items.findIndex((item) => item.type === "ask" && item.ask?.id === id);
    if (itemIndex < 0) continue;
    const current = turn.items[itemIndex];
    if (!current?.ask) continue;
    const items = [...turn.items];
    items[itemIndex] = { ...current, ask: update(current.ask) };
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
