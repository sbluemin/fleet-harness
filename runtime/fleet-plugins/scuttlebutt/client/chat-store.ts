import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { getT, type ScuttlebuttMessageKey } from "./scuttlebutt-catalog.js";
import type { ChatStreamEvent, ChatStreamUsage } from "./sse-client.js";

export type ChatEntry =
  | { readonly id: string; readonly kind: "user"; readonly text: string }
  | {
      readonly id: string;
      readonly kind: "assistant";
      readonly text: string;
      /** 답하는 동안 읽은 페이지들. 완료 뒤 출처 칩으로 선다. */
      readonly sources: readonly string[];
      readonly usage?: ChatStreamUsage;
    }
  | { readonly id: string; readonly kind: "tool"; readonly text: string }
  | { readonly id: string; readonly kind: "notice"; readonly text: string }
  | { readonly id: string; readonly kind: "error"; readonly text: string; readonly code: string; readonly retryable: boolean };

export interface ChatState {
  readonly entries: readonly ChatEntry[];
  readonly phase: "idle" | "starting" | "thinking" | "ready" | "error";
  /** 답 항목이 서기 전에 읽힌 출처. 답이 서는 순간 그리로 옮겨 간다. */
  readonly pendingSources: readonly string[];
  /** 지금 읽는 중인 페이지. 읽기가 성공으로 끝나야 출처가 된다 — 실패한 페이지는 읽은 것이 아니다. */
  readonly fetching: string | null;
}

export const initialChatState: ChatState = { entries: [], phase: "idle", pendingSources: [], fetching: null };

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

export function reduceChatEvent(state: ChatState, event: ChatStreamEvent, name: string, locale?: ConsoleLocale): ChatState {
  if (event.type === "connected") return state;
  if (event.type === "chunk") {
    const last = state.entries.at(-1);
    if (last?.kind === "assistant") {
      return { ...state, entries: [...state.entries.slice(0, -1), { ...last, text: last.text + event.text }], phase: "thinking" };
    }
    return {
      ...state,
      entries: [...state.entries, { id: nextId(), kind: "assistant" as const, text: event.text, sources: state.pendingSources }],
      phase: "thinking",
      pendingSources: [],
    };
  }
  if (event.type === "tool") {
    const text = quietToolStatus(event.title, event.status, locale);
    const last = state.entries.at(-1);
    const entries = last?.kind === "tool"
      ? [...state.entries.slice(0, -1), { ...last, text }]
      : [...state.entries, { id: nextId(), kind: "tool" as const, text }];
    const next: ChatState = { ...state, entries, phase: "thinking" };
    if (event.status === "running") return { ...next, fetching: event.url ?? null };
    if (event.status === "done" && state.fetching) return attachSource({ ...next, fetching: null }, state.fetching);
    return { ...next, fetching: null };
  }
  if (event.type === "complete") {
    const last = state.entries.at(-1);
    // 사용량은 답에 붙는다 — 답이 없는 완료(도구만 돌고 끝난 턴)는 붙일 곳이 없다.
    const entries = last?.kind === "assistant" && event.usage
      ? [...state.entries.slice(0, -1), { ...last, usage: event.usage }]
      : state.entries;
    return { entries: settleTools(entries, locale), phase: "ready", pendingSources: [], fetching: null };
  }
  if (event.type === "cancelled") {
    return {
      entries: [...settleTools(state.entries, locale), { id: nextId(), kind: "notice", text: getT(locale)("notice.cancelled") }],
      phase: "ready",
      pendingSources: [],
      fetching: null,
    };
  }
  return {
    entries: [...settleTools(state.entries, locale), {
      id: nextId(),
      kind: "error",
      code: event.error.code,
      text: errorMessage(event.error.code, name, locale),
      retryable: event.error.code !== "forbidden",
    }],
    phase: "error",
    pendingSources: [],
    fetching: null,
  };
}

/** 마지막 질문과 그 뒤의 것. 말풍선은 이것만 보여 준다(카드는 전체를 스크롤한다). */
export function currentExchange(state: ChatState): readonly ChatEntry[] {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    if (state.entries[index]?.kind === "user") return state.entries.slice(index);
  }
  return state.entries;
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

export function appendUser(state: ChatState, text: string): ChatState {
  return {
    entries: [...state.entries, { id: nextId(), kind: "user", text }],
    phase: "thinking",
    pendingSources: [],
    fetching: null,
  };
}

export function appendNotice(state: ChatState, text: string): ChatState {
  return { ...state, entries: [...state.entries, { id: nextId(), kind: "notice", text }] };
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

/** 완료 뒤에도 진행형으로 남는 도구 행을 마무리 문구로 바꾼다. */
function settleTools(entries: readonly ChatEntry[], locale?: ConsoleLocale): readonly ChatEntry[] {
  const t = getT(locale);
  const progressive = new Set([t("status.searching"), t("status.reading"), t("status.working")]);
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.kind !== "tool" || !progressive.has(entry.text)) return entry;
    changed = true;
    return {
      ...entry,
      text: entry.text === t("status.searching")
        ? t("status.searchDone")
        : entry.text === t("status.reading") ? t("status.readDone") : t("status.toolDone"),
    };
  });
  return changed ? next : entries;
}

function quietToolStatus(title: string, status: string, locale?: ConsoleLocale): string {
  const t = getT(locale);
  if (status === "error") return t("status.toolFailed");
  const lowered = title.toLowerCase();
  if (status === "done") {
    if (lowered.includes("search")) return t("status.searchDone");
    if (lowered.includes("fetch") || lowered.includes("read")) return t("status.readDone");
    return t("status.toolDone");
  }
  if (lowered.includes("search")) return t("status.searching");
  if (lowered.includes("fetch") || lowered.includes("read")) return t("status.reading");
  return t("status.working");
}

let id = 0;
function nextId(): string {
  id += 1;
  return `scuttlebutt-entry-${id}`;
}
