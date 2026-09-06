export interface ChatStreamUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

export type ChatStreamEvent =
  | { readonly type: "connected" }
  | { readonly type: "chunk"; readonly text: string }
  | { readonly type: "tool"; readonly id?: string; readonly title: string; readonly status: string; readonly url?: string }
  | { readonly type: "complete"; readonly usage?: ChatStreamUsage }
  | { readonly type: "cancelled" }
  | { readonly type: "error"; readonly error: { readonly code: string; readonly message: string } };

function parseChatStreamEvent(data: string): ChatStreamEvent | null {
  try {
    const value = JSON.parse(data) as unknown;
    if (!isRecord(value) || typeof value.type !== "string") return null;
    if (value.type === "connected" || value.type === "cancelled") return { type: value.type };
    if (value.type === "complete") {
      const usage = parseUsage(value.usage);
      return usage ? { type: "complete", usage } : { type: "complete" };
    }
    if (value.type === "chunk" && typeof value.text === "string") return { type: "chunk", text: value.text };
    if (value.type === "tool" && typeof value.title === "string" && typeof value.status === "string") {
      return {
        type: "tool",
        ...(typeof value.id === "string" ? { id: value.id } : {}),
        title: value.title,
        status: value.status,
        ...(typeof value.url === "string" ? { url: value.url } : {}),
      };
    }
    if (value.type === "error" && isRecord(value.error)
      && typeof value.error.code === "string" && typeof value.error.message === "string") {
      return { type: "error", error: { code: value.error.code, message: value.error.message } };
    }
  } catch {
    return null;
  }
  return null;
}

function parseUsage(value: unknown): ChatStreamUsage | null {
  if (!isRecord(value) || typeof value.inputTokens !== "number" || typeof value.outputTokens !== "number") return null;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(typeof value.costUsd === "number" ? { costUsd: value.costUsd } : {}),
  };
}

export interface ChatStreamConnection {
  readonly connected: Promise<void>;
  readonly close: () => void;
}

export function connectChatStream(chatId: string, onEvent: (event: ChatStreamEvent) => void): ChatStreamConnection {
  const source = new EventSource(`/plugins/scuttlebutt/chat/${encodeURIComponent(chatId)}/stream`);
  let resolveConnected: () => void = () => undefined;
  const connected = new Promise<void>((resolve) => {
    resolveConnected = resolve;
  });
  source.onmessage = (message) => {
    const event = parseChatStreamEvent(message.data);
    if (event?.type === "connected") resolveConnected();
    if (event) onEvent(event);
  };
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      onEvent({ type: "error", error: { code: "stream_closed", message: "Chat stream closed." } });
    }
  };
  return { connected, close: () => source.close() };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
