import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { getT, type ScuttlebuttMessageKey } from "./scuttlebutt-catalog.js";
import type { ChatStreamEvent, ChatStreamUsage } from "./sse-client.js";

export type ToolStatus = "running" | "done" | "error";

export type ChatEntry =
  | { readonly id: string; readonly kind: "user"; readonly text: string; readonly at: number }
  | {
      readonly id: string;
      readonly kind: "assistant";
      readonly text: string;
      /** 답하는 동안 읽은 페이지들. 완료 뒤 출처 칩으로 선다. */
      readonly sources: readonly string[];
      readonly usage?: ChatStreamUsage;
    }
  /**
   * 도구 호출 하나. 로그에 행으로 서지 않는다 — 도는 동안은 Live line 한 줄이 마지막 것을 말하고,
   * 끝난 뒤에는 접힘 안의 스텝이 된다. 호출 id로 시작과 끝을 짝짓는다.
   */
  | { readonly id: string; readonly kind: "tool"; readonly callId: string | null; readonly title: string; readonly status: ToolStatus; readonly url?: string }
  | { readonly id: string; readonly kind: "notice"; readonly text: string }
  | { readonly id: string; readonly kind: "error"; readonly text: string; readonly code: string; readonly retryable: boolean }
  /** 한 문답의 결말 — 걸린 시간과 끝난 모양. 접힘 한 줄의 재료다. */
  | { readonly id: string; readonly kind: "receipt"; readonly outcome: "done" | "stopped" | "error"; readonly durationMs: number };

export interface ChatState {
  readonly entries: readonly ChatEntry[];
  readonly phase: "idle" | "starting" | "thinking" | "ready" | "error";
  /** 답 항목이 서기 전에 읽힌 출처. 답이 서는 순간 그리로 옮겨 간다. */
  readonly pendingSources: readonly string[];
  /**
   * 읽는 중인 페이지들, 도구 호출 id별. 읽기가 성공으로 끝나야 출처가 된다 — 실패한 페이지는 읽은
   * 것이 아니고, 한 턴에 여러 페이지를 나란히 읽으면 각자 자기 완료에만 정착해야 한다.
   */
  readonly fetching: Readonly<Record<string, string>>;
}

export const initialChatState: ChatState = { entries: [], phase: "idle", pendingSources: [], fetching: {} };

/** 오류 코드에서 사용자 문구. 코드를 모르면 일반 문구로 떨어진다 — 원문 코드는 화면에 내지 않는다. */
export function errorMessage(code: string, name: string, locale?: ConsoleLocale): string {
  const t = getT(locale);
  const key = `error.${code}` as ScuttlebuttMessageKey;
  const known: readonly string[] = [
    "error.session_unavailable",
    "error.session_capacity",
    "error.session_busy",
    "error.session_not_found",
    "error.stream_closed",
    "error.chat_error",
    "error.forbidden",
  ];
  return t(known.includes(key) ? key : "error.generic", { name });
}

export function reduceChatEvent(state: ChatState, event: ChatStreamEvent, name: string, locale?: ConsoleLocale, now: number = Date.now()): ChatState {
  if (event.type === "connected") return state;
  if (event.type === "chunk") {
    const last = state.entries.at(-1);
    if (last?.kind === "assistant") {
      return { ...state, entries: [...state.entries.slice(0, -1), { ...last, text: last.text + event.text }], phase: "thinking" };
    }
    // 한 문답 안에서 답이 도구 호출로 끊기면 새 답 항목이 선다 — 앞 조각에 붙은 출처는 이 조각이
    // 이어받는다. 카드와 말풍선은 마지막 답 항목의 출처만 읽기 때문이다.
    const inherited = exchangeSources(state);
    return {
      ...state,
      entries: [...state.entries, {
        id: nextId(),
        kind: "assistant" as const,
        text: event.text,
        sources: [...inherited, ...state.pendingSources.filter((url) => !inherited.includes(url))],
      }],
      phase: "thinking",
      pendingSources: [],
    };
  }
  if (event.type === "tool") {
    const key = event.id ?? null;
    const status: ToolStatus = event.status === "error" ? "error" : event.status === "done" ? "done" : "running";
    let entries: readonly ChatEntry[];
    // 끝 이벤트는 같은 호출 id의 도는 항목에 정착한다. 짝이 없으면(시작을 놓쳤거나 id가 없으면) 새 항목이다.
    const index = key === null ? -1 : findRunningTool(state.entries, key);
    if (status !== "running" && index >= 0) {
      const running = state.entries[index] as Extract<ChatEntry, { kind: "tool" }>;
      entries = [...state.entries.slice(0, index), { ...running, status }, ...state.entries.slice(index + 1)];
    } else {
      entries = [...state.entries, { id: nextId(), kind: "tool" as const, callId: key, title: event.title, status, ...(event.url ? { url: event.url } : {}) }];
    }
    const next: ChatState = { ...state, entries, phase: "thinking" };
    // id가 없는 도구 이벤트는 짝지을 수 없다 — 그런 읽기는 출처가 되지 않는다.
    if (status === "running") {
      return key && event.url ? { ...next, fetching: { ...state.fetching, [key]: event.url } } : next;
    }
    const url = key ? state.fetching[key] : undefined;
    if (url === undefined) return next;
    const { [key!]: _settled, ...rest } = state.fetching;
    const settled: ChatState = { ...next, fetching: rest };
    return status === "done" ? attachSource(settled, url) : settled;
  }
  if (event.type === "complete") {
    const last = state.entries.at(-1);
    // 사용량은 답에 붙는다 — 답이 없는 완료(도구만 돌고 끝난 턴)는 붙일 곳이 없다.
    const entries = last?.kind === "assistant" && event.usage
      ? [...state.entries.slice(0, -1), { ...last, usage: event.usage }]
      : state.entries;
    return { entries: close(entries, "done", now), phase: "ready", pendingSources: [], fetching: {} };
  }
  if (event.type === "cancelled") {
    return {
      entries: [...close(state.entries, "stopped", now), { id: nextId(), kind: "notice", text: getT(locale)("notice.cancelled") }],
      phase: "ready",
      pendingSources: [],
      fetching: {},
    };
  }
  return {
    entries: [...close(state.entries, "error", now), {
      id: nextId(),
      kind: "error",
      code: event.error.code,
      text: errorMessage(event.error.code, name, locale),
      retryable: event.error.code !== "forbidden",
    }],
    phase: "error",
    pendingSources: [],
    fetching: {},
  };
}

/** 지금 문답의 앞선 답 조각들이 모은 출처. */
function exchangeSources(state: ChatState): readonly string[] {
  const sources: string[] = [];
  for (const entry of currentExchange(state)) {
    if (entry.kind !== "assistant") continue;
    for (const url of entry.sources) if (!sources.includes(url)) sources.push(url);
  }
  return sources;
}

/** 마지막 질문과 그 뒤의 것. 말풍선과 카드 모두 이것을 보여 주고, 앞선 문답은 밴드 뒤에 둔다. */
export function currentExchange(state: ChatState): readonly ChatEntry[] {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    if (state.entries[index]?.kind === "user") return state.entries.slice(index);
  }
  return state.entries;
}

/** 대화를 문답 단위로 자른다 — 질문 하나와 그 뒤의 것이 한 묶음이다. 첫 질문 앞의 알림은 첫 묶음에 든다. */
export function exchanges(state: ChatState): readonly (readonly ChatEntry[])[] {
  const groups: ChatEntry[][] = [];
  for (const entry of state.entries) {
    if (entry.kind === "user" || groups.length === 0) groups.push([entry]);
    else groups[groups.length - 1]!.push(entry);
  }
  return groups;
}

/** 마지막으로 보낸 질문 — 재시도가 다시 보내는 문장. */
export function lastQuestion(state: ChatState): string | null {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === "user") return entry.text;
  }
  return null;
}

export function lastAnswer(state: ChatState): Extract<ChatEntry, { kind: "assistant" }> | null {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.entries[index];
    if (entry?.kind === "assistant") return entry;
    if (entry?.kind === "user") return null;
  }
  return null;
}

export function appendUser(state: ChatState, text: string, now: number = Date.now()): ChatState {
  return {
    entries: [...state.entries, { id: nextId(), kind: "user", text, at: now }],
    phase: "thinking",
    pendingSources: [],
    fetching: {},
  };
}

export function appendNotice(state: ChatState, text: string): ChatState {
  return { ...state, entries: [...state.entries, { id: nextId(), kind: "notice", text }] };
}

/** 한 문답의 도구 호출들 — 접힘의 스텝이자 Live line의 재료. */
export function exchangeTools(exchange: readonly ChatEntry[]): readonly Extract<ChatEntry, { kind: "tool" }>[] {
  return exchange.filter((entry): entry is Extract<ChatEntry, { kind: "tool" }> => entry.kind === "tool");
}

export function exchangeReceipt(exchange: readonly ChatEntry[]): Extract<ChatEntry, { kind: "receipt" }> | null {
  for (let index = exchange.length - 1; index >= 0; index -= 1) {
    const entry = exchange[index];
    if (entry?.kind === "receipt") return entry;
  }
  return null;
}

export function exchangeStartedAt(exchange: readonly ChatEntry[]): number | null {
  const first = exchange.find((entry) => entry.kind === "user");
  return first?.kind === "user" ? first.at : null;
}

/**
 * 답이 오기 전에 읽힌 출처는 상태에 모아 두었다가 답 항목이 생길 때 넘긴다. 이 질문의 답 항목이
 * 이미 있으면 거기에 바로 붙는다.
 */
function attachSource(state: ChatState, url: string): ChatState {
  const { entries } = state;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === "user") break;
    if (entry.kind === "assistant") {
      if (entry.sources.includes(url)) return state;
      return { ...state, entries: [...entries.slice(0, index), { ...entry, sources: [...entry.sources, url] }, ...entries.slice(index + 1)] };
    }
  }
  return state.pendingSources.includes(url) ? state : { ...state, pendingSources: [...state.pendingSources, url] };
}

/**
 * 문답을 닫는다 — 아직 도는 도구는 결말에 맞춰 정착하고(완료면 끝난 것으로, 멈춤·실패면 실패로),
 * 걸린 시간을 든 영수증이 마지막에 선다. 질문이 없는 상태(지운 뒤의 잔여)에는 영수증을 세우지 않는다.
 */
function close(entries: readonly ChatEntry[], outcome: "done" | "stopped" | "error", now: number): readonly ChatEntry[] {
  const settled = entries.map((entry) => entry.kind === "tool" && entry.status === "running"
    ? { ...entry, status: outcome === "done" ? "done" as const : "error" as const }
    : entry);
  let startedAt: number | null = null;
  for (let index = settled.length - 1; index >= 0; index -= 1) {
    const entry = settled[index]!;
    if (entry.kind === "receipt") return settled;
    if (entry.kind === "user") { startedAt = entry.at; break; }
  }
  if (startedAt === null) return settled;
  return [...settled, { id: nextId(), kind: "receipt", outcome, durationMs: Math.max(0, now - startedAt) }];
}

function findRunningTool(entries: readonly ChatEntry[], callId: string): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "user") return -1;
    if (entry?.kind === "tool" && entry.callId === callId && entry.status === "running") return index;
  }
  return -1;
}

let id = 0;
function nextId(): string {
  id += 1;
  return `scuttlebutt-entry-${id}`;
}
