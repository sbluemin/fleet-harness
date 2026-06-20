import type http from "node:http";

import type { ConsoleObservedEvent, ConsoleObservedWorkspace, ConsoleSessionAttentionEvent, ConsoleSessionUpdatedEvent } from "./api-types.js";
import type { createConsoleObservabilityStore } from "./observability-store.js";
import { withSecurityHeaders } from "./security-headers.js";

type WorkspaceResolver = (tenantId: string) => ConsoleObservedWorkspace | null;

interface AggregateObserverEventsOptions {
  readonly subscribeAll?: boolean;
}

export function writeObserverEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspace: ConsoleObservedWorkspace,
  store: ReturnType<typeof createConsoleObservabilityStore>,
): void {
  res.writeHead(200, withSecurityHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  }));
  res.write(": connected\n\n");
  for (const event of store.listEvents(workspace.tenantId)) {
    writeEvent(res, event.id, event.type, { tenant: workspaceSnapshot(workspace), event });
  }
  const unsubscribe = store.subscribe(workspace.tenantId, (event) => {
    writeEvent(res, event.id, event.type, { tenant: workspaceSnapshot(workspace), event });
  });
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(keepalive);
    unsubscribe();
  });
}

export function writeAggregateObserverEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  workspaces: readonly ConsoleObservedWorkspace[],
  store: ReturnType<typeof createConsoleObservabilityStore>,
  resolveWorkspace: WorkspaceResolver,
  options: AggregateObserverEventsOptions = {},
): void {
  res.writeHead(200, withSecurityHeaders({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  }));
  res.write(": connected\n\n");
  for (const workspace of workspaces) {
    for (const event of store.listEvents(workspace.tenantId)) {
      writeEvent(res, event.id, event.type, { tenant: workspaceSnapshot(workspace), event });
    }
    const truncation = store.getTruncation(workspace.tenantId);
    if (truncation.droppedCount > 0) {
      writeEvent(res, 0, "observer:truncated", { tenant: workspaceSnapshot(workspace), truncation });
    }
  }
  const unsubscribers = options.subscribeAll
    ? [
      store.subscribeAll((event) => {
        // session:updated는 { session }만, session:attention은 reason까지 직렬화한다(event.type이 식별자).
        if (isSessionUpdatedEvent(event)) {
          writeEvent(res, 0, event.type, { session: event.session });
          return;
        }
        if (isSessionAttentionEvent(event)) {
          writeEvent(res, 0, event.type, { session: event.session, reason: event.reason });
          return;
        }
        writeEvent(res, event.id, event.type, { tenant: resolvedWorkspaceSnapshot(resolveWorkspace, event.tenantId), event });
      }),
    ]
    : workspaces.map((workspace) =>
      store.subscribe(workspace.tenantId, (event) => {
        writeEvent(res, event.id, event.type, { tenant: workspaceSnapshot(workspace), event });
      }),
    );
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(keepalive);
    for (const unsubscribe of unsubscribers) unsubscribe();
  });
}

function writeEvent(res: http.ServerResponse, id: number, event: string, data: unknown): void {
  if (id > 0) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isSessionUpdatedEvent(event: ConsoleObservedEvent | ConsoleSessionUpdatedEvent | ConsoleSessionAttentionEvent): event is ConsoleSessionUpdatedEvent {
  return event.type === "session:updated" && "session" in event;
}

function isSessionAttentionEvent(event: ConsoleObservedEvent | ConsoleSessionUpdatedEvent | ConsoleSessionAttentionEvent): event is ConsoleSessionAttentionEvent {
  return event.type === "session:attention" && "session" in event;
}

function workspaceSnapshot(workspace: ConsoleObservedWorkspace) {
  return {
    tenantId: workspace.tenantId,
    tenantLabel: workspace.tenantLabel,
  };
}

function resolvedWorkspaceSnapshot(resolveWorkspace: WorkspaceResolver, tenantId: string) {
  const workspace = resolveWorkspace(tenantId);
  if (workspace) return workspaceSnapshot(workspace);
  return {
    tenantId,
    tenantLabel: tenantId,
  };
}
