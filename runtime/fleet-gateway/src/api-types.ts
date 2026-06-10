export interface GatewayLockPayload {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly startedAt: number;
  readonly token: string;
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
