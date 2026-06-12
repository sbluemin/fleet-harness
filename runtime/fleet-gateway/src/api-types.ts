export interface GatewayLockPayload {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly startedAt: number;
  readonly token: string;
  readonly observerToken: string;
  readonly version: string;
}

export interface GatewayHealth {
  readonly ok: true;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly startedAt: number;
  readonly version: string;
  readonly tenantCount: number;
}

export interface GatewayToolSnapshot {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly [key: string]: unknown;
}

export interface GatewayRegisterTenantRequest {
  readonly tenantLabel: string;
  readonly cwd: string;
  readonly tools: readonly GatewayToolSnapshot[];
}

export interface GatewayRegisterTenantResponse {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly endpoint: string;
  readonly controlToken: string;
  readonly sessionToken: string;
  readonly observerToken: string;
}

export interface GatewayQueuedToolCall {
  readonly callId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly createdAt: number;
}

export interface GatewayToolCallResult {
  readonly content: Array<{ type: string; text?: string }>;
  readonly isError: boolean;
}

export interface GatewayObservedTenant {
  readonly tenantId: string;
  readonly tenantLabel: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly sessions: number;
}

export interface GatewayObserverTenantsResponse {
  readonly tenants: readonly GatewayObservedTenant[];
}

export interface GatewayObservedEvent {
  readonly id: number;
  readonly jobId?: string;
  readonly type: string;
  readonly timestamp: number;
  readonly payload: Record<string, unknown>;
}

export interface GatewayObservedJob {
  readonly jobId: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly events: readonly GatewayObservedEvent[];
}

export interface GatewayObserverTruncation {
  readonly droppedCount: number;
  readonly droppedBeforeId?: number;
}

export interface GatewayObserverJobsResponse {
  readonly jobs: readonly GatewayObservedJob[];
  readonly truncation: GatewayObserverTruncation;
}

export interface GatewayObserverTenantJobsResponse {
  readonly tenantId: string;
  readonly tenantLabel?: string;
  readonly jobs: readonly GatewayObservedJob[];
  readonly truncation: GatewayObserverTruncation;
}

export interface GatewayObserverAggregateJobsResponse {
  readonly tenants: readonly GatewayObserverTenantJobsResponse[];
}

export interface GatewayObserverEventsResponse {
  readonly events: readonly GatewayObservedEvent[];
  readonly truncation: GatewayObserverTruncation;
}
