import type { ChatStreamEvent } from "./sse-client.js";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import { getT } from "./i18n.js";

export type ChatEntry =
  | { readonly id: string; readonly kind: "user" | "assistant"; readonly text: string }
  | { readonly id: string; readonly kind: "tool" | "error"; readonly text: string };

export interface ChatState {
  readonly entries: readonly ChatEntry[];
  readonly phase: "idle" | "starting" | "thinking" | "ready" | "error";
}

export const initialChatState: ChatState = { entries: [], phase: "idle" };

export function reduceChatEvent(state: ChatState, event: ChatStreamEvent, locale?: ConsoleLocale): ChatState {
  if (event.type === "connected") return state;
  if (event.type === "chunk") {
    const last = state.entries.at(-1);
    const entries = last?.kind === "assistant"
      ? [...state.entries.slice(0, -1), { ...last, text: last.text + event.text }]
      : [...state.entries, { id: nextId(), kind: "assistant" as const, text: event.text }];
    return { entries, phase: "thinking" };
  }
  if (event.type === "tool") {
    const text = quietToolStatus(event.title, event.status, locale);
    const last = state.entries.at(-1);
    const entries = last?.kind === "tool"
      ? [...state.entries.slice(0, -1), { ...last, text }]
      : [...state.entries, { id: nextId(), kind: "tool" as const, text }];
    return { entries, phase: "thinking" };
  }
  if (event.type === "complete") return { ...state, phase: "ready" };
  return {
    entries: [...state.entries, { id: nextId(), kind: "error", text: event.error.message }],
    phase: "error",
  };
}

/** 카드는 현재 브라우저 메모리의 마지막 질문과 그에 대한 답만 보여준다. */
export function currentExchange(state: ChatState): readonly ChatEntry[] {
  for (let index = state.entries.length - 1; index >= 0; index -= 1) {
    if (state.entries[index]?.kind === "user") return state.entries.slice(index);
  }
  return state.entries;
}

export function appendUser(state: ChatState, text: string): ChatState {
  return {
    entries: [...state.entries, { id: nextId(), kind: "user", text }],
    phase: "thinking",
  };
}

export function quietToolStatus(title: string, status: string, locale?: ConsoleLocale): string {
  const t = getT(locale);
  const combined = `${title} ${status}`.toLowerCase();
  if (combined.includes("search")) return t("status.searching");
  if (combined.includes("fetch") || combined.includes("read")) return t("status.reading");
  return t("status.working");
}

let id = 0;
function nextId(): string {
  id += 1;
  return `scuttlebutt-entry-${id}`;
}
