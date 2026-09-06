import type { ConsoleLocale } from "@fleet-console/sdk/i18n";

import {
  appendUser,
  initialChatState,
  reduceChatEvent,
  type ChatState,
} from "./chat-store.js";
import {
  connectChatStream,
  type ChatStreamConnection,
  type ChatStreamEvent,
} from "./sse-client.js";

export interface ChatSessionSnapshot {
  readonly state: ChatState;
  readonly draft: string;
}

export type AdmiralId = "tori" | "bori" | "dori";

export interface ChatSessionDeps {
  readonly admiral: AdmiralId;
  readonly fetch: (path: string, init?: RequestInit) => Promise<Response>;
  readonly connect?: (
    chatId: string,
    onEvent: (event: ChatStreamEvent) => void,
  ) => ChatStreamConnection;
  readonly locale?: () => ConsoleLocale | undefined;
  /**
   * 실험 "부관의 Console 읽기"가 켜졌을 때 메시지에 실을 Console 스냅샷. 꺼져 있으면 null을 돌려주고
   * 본문은 오늘과 같은 `{ text }`다 — 서버도 그 경우 도구를 붙이지 않는다.
   */
  readonly console?: () => ConsoleSnapshotPayload | null;
}

export interface ConsoleSnapshotPayload {
  readonly theaters: readonly { readonly id: string; readonly label: string }[];
  readonly operations: readonly { readonly id: string; readonly theaterId: string; readonly type: string; readonly title: string; readonly activity: string }[];
}

export interface ChatSession {
  readonly subscribe: (listener: () => void) => () => void;
  readonly snapshot: () => ChatSessionSnapshot;
  readonly setDraft: (draft: string) => void;
  readonly ask: (text: string) => Promise<void>;
  readonly close: () => void;
}

const INITIAL_SNAPSHOT: ChatSessionSnapshot = { state: initialChatState, draft: "" };

/**
 * 대화는 카드가 아니라 마스코트에 매인다. 카드를 닫아도 스트림이 살아 있어야 답이 끝까지
 * 도착하고, 그래야 완료 연출이 나오고 '생각 중' 말풍선이 걷힌다. 카드가 소유하면 닫는 순간
 * 스트림이 끊겨 마스코트가 thinking 상태로 굳는다.
 */
export function createChatSession(deps: ChatSessionDeps): ChatSession {
  const connect = deps.connect ?? connectChatStream;
  const listeners = new Set<() => void>();
  let snapshot = INITIAL_SNAPSHOT;
  let stream: ChatStreamConnection | null = null;
  let chatId: string | null = null;
  let closed = false;

  function put(next: Partial<ChatSessionSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) listener();
  }

  function receive(event: ChatStreamEvent): void {
    if (closed) return;
    put({ state: reduceChatEvent(snapshot.state, event, deps.locale?.()) });
  }

  async function start(): Promise<string> {
    const response = await deps.fetch("chat/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ admiral: deps.admiral }),
    });
    const payload = await response.json() as { readonly chatId?: unknown; readonly error?: unknown };
    if (!response.ok || typeof payload.chatId !== "string") {
      throw new Error(typeof payload.error === "string" ? payload.error : "Chat is unavailable.");
    }
    return payload.chatId;
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    setDraft(draft) {
      if (draft !== snapshot.draft) put({ draft });
    },
    async ask(text) {
      const question = text.trim();
      const phase = snapshot.state.phase;
      if (closed || !question || phase === "starting" || phase === "thinking") return;
      put({ draft: "", state: { ...appendUser(snapshot.state, question), phase: "starting" } });
      try {
        if (chatId === null) {
          const started = await start();
          if (closed) return;
          chatId = started;
          stream = connect(started, receive);
          await stream.connected;
          if (closed) return;
        }
        const response = await deps.fetch(`chat/${encodeURIComponent(chatId)}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify((() => {
            const console = deps.console?.() ?? null;
            return console ? { text: question, console } : { text: question };
          })()),
        });
        if (!response.ok) throw new Error(await readError(response));
        // 답이 이 응답보다 먼저 끝났을 수 있다 — 그때는 도착한 상태를 덮지 않는다.
        if (snapshot.state.phase === "starting") put({ state: { ...snapshot.state, phase: "thinking" } });
      } catch (error) {
        if (closed) return;
        put({
          state: reduceChatEvent(snapshot.state, {
            type: "error",
            error: {
              code: "client_error",
              message: error instanceof Error ? error.message : "Chat is unavailable.",
            },
          }, deps.locale?.()),
        });
      }
    },
    close() {
      closed = true;
      stream?.close();
      stream = null;
      listeners.clear();
    },
  };
}

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { readonly error?: unknown };
    if (typeof payload.error === "string") return payload.error;
  } catch {
    // 본문이 JSON이 아니면 상태 코드만 남긴다.
  }
  return `Chat request failed (${response.status}).`;
}
