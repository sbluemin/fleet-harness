import type { AgentStreamEvent } from "./types.js";

export type AgentStreamHandler = (event: AgentStreamEvent) => void;

const handlers = new Set<AgentStreamHandler>();

export function registerStreamHandler(handler: AgentStreamHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function unregisterStreamHandler(handler: AgentStreamHandler): void {
  handlers.delete(handler);
}

export function emitStreamEvent(event: AgentStreamEvent): void {
  for (const handler of handlers) {
    handler(event);
  }
}

export function clearStreamHandlers(): void {
  handlers.clear();
}
