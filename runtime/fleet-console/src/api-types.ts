import type { CliSession } from "@dotobokuri/core-agent";

export interface ConsoleLockPayload {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly startedAt: number;
  readonly token: string;
  readonly observerToken: string;
  readonly terminalToken: string;
  readonly version: string;
}

export interface ConsoleHealth {
  readonly ok: true;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly startedAt: number;
  readonly version: string;
  readonly workspaceCount: number;
}

export interface ConsoleObservedWorkspace {
  readonly tenantId: string;
  readonly tenantLabel: string;
  readonly cwd: string;
  readonly createdAt: number;
  readonly sessions: number;
  readonly status: CliSession["status"];
  readonly cliRunId: string;
  readonly registrationId: string;
}

export interface ConsoleObservedEvent {
  readonly id: number;
  readonly tenantId: string;
  readonly jobId?: string;
  readonly type: string;
  readonly at: number;
  readonly event: Record<string, unknown>;
}

export interface ConsoleObservedJob {
  readonly jobId: string;
  readonly status: string;
  readonly updatedAt: number;
  readonly events: readonly ConsoleObservedEvent[];
}

export interface ConsoleObserverTruncation {
  readonly droppedCount: number;
  readonly droppedBeforeId?: number;
}

export interface ConsoleObserverWorkspaceJobs {
  readonly tenantId: string;
  readonly tenantLabel?: string;
  readonly jobs: readonly ConsoleObservedJob[];
  readonly truncation: ConsoleObserverTruncation;
}

export interface ConsoleObserverAggregateJobsResponse {
  readonly tenants: readonly ConsoleObserverWorkspaceJobs[];
}

export interface ConsoleObserverWorkspacesResponse {
  readonly tenants: readonly ConsoleObservedWorkspace[];
}
