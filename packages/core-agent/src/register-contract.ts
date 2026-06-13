export interface RegisterCliRequest {
  readonly protocolVersion: string;
  readonly cliRunId: string;
  readonly tenantLabel: string;
  readonly cwd: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly fleetVersion: string;
  readonly mcp?: RegisterCliMcpMetadata;
}

export interface RegisterCliMcpMetadata {
  // MCP metadata는 인증 토큰이나 브라우저 노출 자격증명을 포함하지 않는다.
  readonly servers?: readonly RegisterCliMcpServerMetadata[];
  readonly protocolVersion?: string;
  readonly capabilities?: readonly string[];
}

export interface RegisterCliMcpServerMetadata {
  readonly name: string;
  readonly toolCount?: number;
}

export interface RegisterCliResponse {
  readonly registrationId: string;
  readonly ingestToken: string;
  readonly heartbeatIntervalMs: number;
  readonly leaseTtlMs: number;
  readonly maxBatchEvents: number;
}

export interface CliSession {
  readonly registrationId: string;
  readonly cliRunId: string;
  readonly tenantLabel: string;
  readonly cwd: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly fleetVersion: string;
  readonly registeredAt: string;
  readonly lastHeartbeatAt: string;
  readonly leaseExpiresAt: string;
  readonly status: "online" | "offline" | "deregistered";
  readonly mcp?: RegisterCliMcpMetadata;
}

export interface PushEventEnvelope {
  readonly cliRunId: string;
  readonly seq: number;
  readonly at: string;
  readonly event: unknown;
}

export type PushEventsRequest = readonly PushEventEnvelope[];

export interface PushEventsResponse {
  readonly accepted: number;
  readonly highestContiguousSeq: number;
}

export interface HeartbeatCliRequest {
  readonly cliRunId: string;
  readonly registrationId: string;
  readonly at: string;
}

export interface HeartbeatCliResponse {
  readonly accepted: boolean;
  readonly leaseExpiresAt: string;
}

export interface DeregisterCliRequest {
  readonly cliRunId: string;
  readonly registrationId: string;
  readonly at: string;
  readonly reason?: string;
}

export interface DeregisterCliResponse {
  readonly accepted: boolean;
}

// 이벤트는 cliRunId별 seq 순서로 소비된다. 중복 seq는 소비측에서 멱등 무시하고,
// seq gap은 소비측에서 synthetic truncation 이벤트로 보정한다.
export type PushEventSequencePolicy = "ordered-per-cli-run-id";
