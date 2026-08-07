import type http from "node:http";

import type { createConsoleObservabilityStore } from "./observability-store.js";
import type { AgentObservedEvent, AgentSessionAttentionEvent, AgentSessionUpdatedEvent } from "./types.js";

/**
 * Agent 세션 SSE — 세션 갱신과 입력 대기 신호만 나른다.
 */
export function writeAgentSessionEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  store: ReturnType<typeof createConsoleObservabilityStore>,
): void {
  res.writeHead(200, withAgentSecurityHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  }));
  res.write(": connected\n\n");
  // session:updated는 { session }만, session:attention은 reason까지 직렬화한다(event.type이 식별자).
  const unsubscribe = store.subscribeAll((event) => {
    if (isSessionUpdatedEvent(event)) {
      writeEvent(res, 0, event.type, { session: event.session });
      return;
    }
    if (isSessionAttentionEvent(event)) {
      writeEvent(res, 0, event.type, { session: event.session, reason: event.reason });
    }
  });
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
  });
}

function writeEvent(res: http.ServerResponse, id: number, event: string, data: unknown): void {
  if (id > 0) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isSessionUpdatedEvent(event: AgentObservedEvent | AgentSessionUpdatedEvent | AgentSessionAttentionEvent): event is AgentSessionUpdatedEvent {
  return event.type === "session:updated" && "session" in event;
}

function isSessionAttentionEvent(event: AgentObservedEvent | AgentSessionUpdatedEvent | AgentSessionAttentionEvent): event is AgentSessionAttentionEvent {
  return event.type === "session:attention" && "session" in event;
}

function withAgentSecurityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}
