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

export interface GatewayObserverTruncation {
  readonly droppedCount: number;
  readonly droppedBeforeId?: number;
}

export interface GatewayObservabilityStoreDeps {
  readonly now?: () => number;
}

interface TenantJobState {
  readonly jobs: Map<string, GatewayObservedJob>;
  readonly finalizedOrder: string[];
}

type GatewayObservedEventListener = (event: GatewayObservedEvent) => void;

const TENANT_EVENT_LIMIT = 1_000;
const JOB_EVENT_LIMIT = 200;
const TENANT_FINALIZED_JOB_LIMIT = 100;
// active 잡 포함 테넌트당 전체 잡 스냅샷 상한. finalize 이벤트가 유실된 잡이
// 무한히 쌓이지 않도록 updatedAt 기준 LRU로 축출한다.
const TENANT_JOB_LIMIT = 200;
// 이벤트당 보존하는 텍스트 길이 상한. Fleet Console 스트리밍 표시를 위해 본문을 보존하되,
// 이벤트당 캡 × 테넌트/잡 이벤트 한도로 메모리 사용을 제한한다.
// 상한 추정: 8KB × 200 이벤트/잡 × 200 잡 한도가 테넌트당 최악치이며, 실제로는
// 테넌트 이벤트 한도(1,000)와 잡 이벤트 잘림이 함께 작용해 그보다 훨씬 작다.
const EVENT_TEXT_RETENTION_LIMIT = 8_192;

export function createGatewayObservabilityStore(deps: GatewayObservabilityStoreDeps = {}) {
  const now = deps.now ?? Date.now;
  const eventsByTenant = new Map<string, GatewayObservedEvent[]>();
  const truncationByTenant = new Map<string, GatewayObserverTruncation>();
  const jobsByTenant = new Map<string, TenantJobState>();
  const listenersByTenant = new Map<string, Set<GatewayObservedEventListener>>();
  const allListeners = new Set<GatewayObservedEventListener>();
  let nextId = 1;

  function append(tenantId: string, rawEvent: unknown): GatewayObservedEvent {
    const eventObject = typeof rawEvent === "object" && rawEvent !== null ? rawEvent as Record<string, unknown> : {};
    const event: GatewayObservedEvent = {
      id: nextId,
      tenantId,
      jobId: typeof eventObject.jobId === "string" ? eventObject.jobId : undefined,
      type: typeof eventObject.type === "string" ? eventObject.type : "event",
      at: now(),
      event: clampEventText(rawEvent),
    };
    nextId += 1;
    const list = eventsByTenant.get(tenantId) ?? [];
    list.push(event);
    if (list.length > TENANT_EVENT_LIMIT) {
      const dropped = list.length - TENANT_EVENT_LIMIT;
      const retained = list.slice(dropped);
      eventsByTenant.set(tenantId, retained);
      const previous = truncationByTenant.get(tenantId);
      truncationByTenant.set(tenantId, {
        droppedCount: (previous?.droppedCount ?? 0) + dropped,
        droppedBeforeId: retained[0]?.id,
      });
    } else {
      eventsByTenant.set(tenantId, list);
      if (!truncationByTenant.has(tenantId)) truncationByTenant.set(tenantId, { droppedCount: 0 });
    }
    updateJobSnapshot(tenantId, event);
    for (const listener of listenersByTenant.get(tenantId) ?? []) {
      listener(event);
    }
    for (const listener of allListeners) {
      listener(event);
    }
    return event;
  }

  function listEvents(tenantId: string): readonly GatewayObservedEvent[] {
    return eventsByTenant.get(tenantId) ?? [];
  }

  function listJobs(tenantId: string): readonly GatewayObservedJob[] {
    return Array.from(getTenantJobState(tenantId).jobs.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function getTruncation(tenantId: string): GatewayObserverTruncation {
    return truncationByTenant.get(tenantId) ?? { droppedCount: 0 };
  }

  function subscribe(tenantId: string, listener: GatewayObservedEventListener): () => void {
    const listeners = listenersByTenant.get(tenantId) ?? new Set();
    listeners.add(listener);
    listenersByTenant.set(tenantId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) listenersByTenant.delete(tenantId);
    };
  }

  function subscribeAll(listener: GatewayObservedEventListener): () => void {
    allListeners.add(listener);
    return () => {
      allListeners.delete(listener);
    };
  }

  return {
    append,
    getTruncation,
    listEvents,
    listJobs,
    subscribe,
    subscribeAll,
    removeTenant(tenantId: string): void {
      // 해제된 테넌트의 관측 상태는 observer 표면에서 더 이상 도달할 수 없는 고아 메모리이므로 회수한다.
      eventsByTenant.delete(tenantId);
      truncationByTenant.delete(tenantId);
      jobsByTenant.delete(tenantId);
    },
    clear(): void {
      eventsByTenant.clear();
      truncationByTenant.clear();
      jobsByTenant.clear();
      listenersByTenant.clear();
      allListeners.clear();
    },
  };

  function getTenantJobState(tenantId: string): TenantJobState {
    const existing = jobsByTenant.get(tenantId);
    if (existing) return existing;
    const created = { jobs: new Map<string, GatewayObservedJob>(), finalizedOrder: [] };
    jobsByTenant.set(tenantId, created);
    return created;
  }

  function updateJobSnapshot(tenantId: string, event: GatewayObservedEvent): void {
    if (!event.jobId) return;
    const state = getTenantJobState(tenantId);
    const previous = state.jobs.get(event.jobId);
    const status = inferStatus(event.type, event.event, previous?.status);
    state.jobs.set(event.jobId, {
      jobId: event.jobId,
      status,
      updatedAt: event.at,
      events: [...(previous?.events ?? []), event].slice(-JOB_EVENT_LIMIT),
    });
    if (event.type === "job:finalized") {
      const existingIndex = state.finalizedOrder.indexOf(event.jobId);
      if (existingIndex >= 0) state.finalizedOrder.splice(existingIndex, 1);
      state.finalizedOrder.push(event.jobId);
      while (state.finalizedOrder.length > TENANT_FINALIZED_JOB_LIMIT) {
        const prunedJobId = state.finalizedOrder.shift();
        if (prunedJobId) state.jobs.delete(prunedJobId);
      }
    }
    pruneTenantJobs(state);
  }

  function pruneTenantJobs(state: TenantJobState): void {
    if (state.jobs.size <= TENANT_JOB_LIMIT) return;
    const byOldest = Array.from(state.jobs.values()).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of byOldest) {
      if (state.jobs.size <= TENANT_JOB_LIMIT) break;
      state.jobs.delete(job.jobId);
      const finalizedIndex = state.finalizedOrder.indexOf(job.jobId);
      if (finalizedIndex >= 0) state.finalizedOrder.splice(finalizedIndex, 1);
    }
  }
}

function inferStatus(type: string, event: unknown, previousStatus = "active"): string {
  if (type !== "job:finalized") return previousStatus === "done" || previousStatus === "error" || previousStatus === "aborted" ? previousStatus : "active";
  const status = typeof event === "object" && event !== null ? (event as Record<string, unknown>).status : undefined;
  return typeof status === "string" ? status : "done";
}

// 텍스트 본문은 보존하되 이벤트당 캡으로 클램프한다. 길이 메타데이터는 원본 전체 길이를 기록한다.
function clampEventText(event: unknown): Record<string, unknown> | unknown {
  if (typeof event !== "object" || event === null) return event;
  const obj = event as Record<string, unknown>;
  if (obj.type === "track:text" || obj.type === "track:thought") {
    return {
      ...obj,
      text: clampText(obj.text),
      textLength: typeof obj.text === "string" ? obj.text.length : 0,
    };
  }
  if (obj.type === "track:finalized") {
    return {
      ...obj,
      fallbackText: clampText(obj.fallbackText),
      fallbackTextLength: typeof obj.fallbackText === "string" ? obj.fallbackText.length : undefined,
      fallbackThought: clampText(obj.fallbackThought),
      fallbackThoughtLength: typeof obj.fallbackThought === "string" ? obj.fallbackThought.length : undefined,
    };
  }
  return obj;
}

function clampText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length > EVENT_TEXT_RETENTION_LIMIT ? value.slice(0, EVENT_TEXT_RETENTION_LIMIT) : value;
}
