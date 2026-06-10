export interface GatewayObservedEvent {
  readonly id: number;
  readonly tenantId: string;
  readonly jobId?: string;
  readonly type: string;
  readonly at: number;
  readonly event: unknown;
}

export interface GatewayObservedJob {
  readonly jobId: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly events: GatewayObservedEvent[];
}

export interface GatewayObservabilityStoreDeps {
  readonly now?: () => number;
}

export function createGatewayObservabilityStore(deps: GatewayObservabilityStoreDeps = {}) {
  const now = deps.now ?? Date.now;
  const eventsByTenant = new Map<string, GatewayObservedEvent[]>();
  const listenersByTenant = new Map<string, Set<(event: GatewayObservedEvent) => void>>();
  let nextId = 1;

  function append(tenantId: string, rawEvent: unknown): GatewayObservedEvent {
    const eventObject = typeof rawEvent === "object" && rawEvent !== null ? rawEvent as Record<string, unknown> : {};
    const event: GatewayObservedEvent = {
      id: nextId,
      tenantId,
      jobId: typeof eventObject.jobId === "string" ? eventObject.jobId : undefined,
      type: typeof eventObject.type === "string" ? eventObject.type : "event",
      at: now(),
      event: redactEvent(rawEvent),
    };
    nextId += 1;
    const list = eventsByTenant.get(tenantId) ?? [];
    list.push(event);
    eventsByTenant.set(tenantId, list.slice(-1_000));
    for (const listener of listenersByTenant.get(tenantId) ?? []) {
      listener(event);
    }
    return event;
  }

  function listEvents(tenantId: string): readonly GatewayObservedEvent[] {
    return eventsByTenant.get(tenantId) ?? [];
  }

  function listJobs(tenantId: string): readonly GatewayObservedJob[] {
    const jobs = new Map<string, GatewayObservedJob>();
    for (const event of listEvents(tenantId)) {
      if (!event.jobId) continue;
      const previous = jobs.get(event.jobId);
      jobs.set(event.jobId, {
        jobId: event.jobId,
        status: inferStatus(event.type, event.event),
        updatedAt: event.at,
        events: [...(previous?.events ?? []), event],
      });
    }
    return Array.from(jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function subscribe(tenantId: string, listener: (event: GatewayObservedEvent) => void): () => void {
    const listeners = listenersByTenant.get(tenantId) ?? new Set();
    listeners.add(listener);
    listenersByTenant.set(tenantId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByTenant.delete(tenantId);
    };
  }

  return {
    append,
    listEvents,
    listJobs,
    subscribe,
    clear(): void {
      eventsByTenant.clear();
      listenersByTenant.clear();
    },
  };
}

function inferStatus(type: string, event: unknown): string {
  if (type === "job:finalized") {
    const status = typeof event === "object" && event !== null ? (event as Record<string, unknown>).status : undefined;
    return typeof status === "string" ? status : "done";
  }
  return "active";
}

function redactEvent(event: unknown): unknown {
  if (typeof event !== "object" || event === null) return event;
  const obj = event as Record<string, unknown>;
  if (obj.type === "track:text" || obj.type === "track:thought") {
    return {
      ...obj,
      text: undefined,
      textLength: typeof obj.text === "string" ? obj.text.length : 0,
    };
  }
  return obj;
}
