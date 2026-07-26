import type { ChatStreamEvent } from "./sse-client.js";

export type ChatEntry =
  | { readonly id: string; readonly kind: "user" | "assistant"; readonly text: string }
  | { readonly id: string; readonly kind: "tool" | "error"; readonly text: string };

export interface ChatState {
  readonly entries: readonly ChatEntry[];
  readonly phase: "idle" | "starting" | "thinking" | "ready" | "error";
}

export const initialChatState: ChatState = { entries: [], phase: "idle" };

export function reduceChatEvent(state: ChatState, event: ChatStreamEvent): ChatState {
  if (event.type === "connected") return state;
  if (event.type === "chunk") {
    const last = state.entries.at(-1);
    const entries = last?.kind === "assistant"
      ? [...state.entries.slice(0, -1), { ...last, text: last.text + event.text }]
      : [...state.entries, { id: nextId(), kind: "assistant" as const, text: event.text }];
    return { entries, phase: "thinking" };
  }
  if (event.type === "tool") {
    const text = quietToolStatus(event.title, event.status);
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

export function appendUser(state: ChatState, text: string): ChatState {
  return {
    entries: [...state.entries, { id: nextId(), kind: "user", text }],
    phase: "thinking",
  };
}

export function hydrateEntries(threads: readonly ChatThreadDto[]): ChatState {
  const thread = threads[0];
  if (!thread) return initialChatState;
  return {
    entries: thread.messages.map((message) => ({
      id: message.id,
      kind: message.role,
      text: message.text,
    })),
    phase: "idle",
  };
}

export interface ChatMessageDto {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: number;
}

export interface ChatThreadDto {
  readonly id: string;
  readonly title: string;
  readonly cliId: "claude" | "claude-kimi" | "codex";
  readonly model: string;
  readonly createdAt: number;
  readonly messages: readonly ChatMessageDto[];
}

function quietToolStatus(title: string, status: string): string {
  const combined = `${title} ${status}`.toLowerCase();
  if (combined.includes("search")) return "Searching…";
  if (combined.includes("fetch") || combined.includes("read")) return "Reading a source…";
  return status.trim() ? `${status.trim().replace(/[.]+$/u, "")}…` : "Working…";
}

let id = 0;
function nextId(): string {
  id += 1;
  return `scuttlebutt-entry-${id}`;
}
