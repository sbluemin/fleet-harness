export type AgentSessionStatus = "starting" | "terminal-only" | "registered" | "closed" | "error" | "dormant";

export type AgentTurnState = "none" | "running" | "ended";

export type AgentModelActivity = "working" | "not-working";

// Claude Notification hook의 notification_type 값. 이 목록 밖(예: AskUserQuestion=PreToolUse는 필드
// 자체가 없음)은 reason 없이 흘려, 클라이언트가 실제 입력 대기로 처리하게 한다. 임의 문자열이
// 브라우저 페이로드로 새는 것도 막는다. 목록과 유니온을 따로 적으면 한쪽만 늘어나 조용히 어긋나므로
// 목록을 유일한 출처로 두고 유니온을 파생시킨다.
export const AGENT_ATTENTION_REASONS = [
  "idle_prompt",
  "permission_prompt",
  "auth_success",
  "elicitation_dialog",
  "elicitation_complete",
  "elicitation_response",
] as const;

export type AgentAttentionReason = (typeof AGENT_ATTENTION_REASONS)[number];

/** hook stdin(JSON)의 notification_type을 알려진 reason으로 정규화한다. 알 수 없거나 부재면 undefined. */
export function normalizeAttentionReason(value: unknown): AgentAttentionReason | undefined {
  return typeof value === "string" && (AGENT_ATTENTION_REASONS as readonly string[]).includes(value)
    ? (value as AgentAttentionReason)
    : undefined;
}

export type AgentLabelSource = "user" | "auto";

// Provider-derived titles are durable server state. Keep this separate from
// AgentLabelSource because that union is projected into browser session DTOs.
export interface AgentProviderTitleMarker {
  readonly source: "provider";
}

export interface AgentSession {
  readonly harness: "claude-code";
  readonly model?: string;
  readonly effort?: string;
  readonly id?: string;
  readonly transcriptPath?: string;
  readonly source?: string;
  readonly capturedAt?: string;
}

export interface CapturedAgentSession extends AgentSession {
  readonly id: string;
  readonly capturedAt: string;
}

export interface AgentDurableOperation {
  readonly sessionId: string;
  readonly theaterId: string;
  readonly cwd: string;
  readonly label?: string;
  readonly labelSource?: AgentLabelSource;
  readonly providerTitle?: AgentProviderTitleMarker;
  readonly createdAt: number;
  readonly session?: CapturedAgentSession;
}

export interface AgentTerminalSessionInfo {
  readonly sessionId: string;
  readonly terminalSessionId: string;
  readonly cwdLabel: string;
  readonly label?: string;
  readonly labelSource?: AgentLabelSource;
  readonly cliId?: string;
  readonly cliLabel?: string;
  readonly status: AgentSessionStatus;
  readonly turnState: AgentTurnState;
  readonly modelActivity?: AgentModelActivity;
  readonly attentionPending?: boolean;
  readonly backgroundPending?: boolean;
  /**
   * Chat Mode가 이 세션을 인수했는지. PTY는 접혔지만 core-agent SDK가 같은 provider 세션을 이어
   * 돌리므로 실행 표면은 살아 있다 — 수명 해석은 PTY의 유무가 아니라 이 값을 먼저 읽어야 한다.
   *
   * 활동 자체는 여기 실리지 않는다. 두 표면 모두 위의 `modelActivity`·`attentionPending`에 쓰고,
   * 이 값은 그것을 **누가 채웠는지**와 표면 표식만 정한다.
   */
  readonly chatActive?: boolean;
  readonly createdAt: number;
  readonly theaterId: string;
  readonly registrationId?: string;
  readonly cliRunId?: string;
  readonly tenantId?: string;
  readonly resumeAvailable: boolean;
}

export interface AgentObservedWorkspace {
  readonly tenantId: string;
  readonly tenantLabel: string;
  readonly createdAt: number;
  readonly sessions: number;
  readonly status: "live" | "closed" | "dormant";
  readonly cliRunId: string;
  readonly registrationId: string;
  readonly theaterId: string;
  readonly terminalSessionId?: string;
}

export interface AgentObservedEvent {
  readonly id: number;
  readonly tenantId: string;
  readonly jobId?: string;
  readonly type: string;
  readonly at: number;
  readonly event: Record<string, unknown>;
}

export interface AgentObservedJob {
  readonly jobId: string;
  readonly status: string;
  readonly updatedAt: number;
  /** First valid observer-only request, retained beyond the event window. */
  readonly request?: AgentObservedRequest;
  readonly events: readonly AgentObservedEvent[];
}

export interface AgentObservedRequestBlock {
  readonly tag: string;
  readonly hint: string;
  readonly required: boolean;
  readonly present: boolean;
  readonly body: string;
}

export interface AgentObservedRequest {
  readonly blocks: readonly AgentObservedRequestBlock[];
  readonly additional: string;
}

export interface AgentObserverTruncation {
  readonly droppedCount: number;
  readonly droppedBeforeId?: number;
}

export interface AgentWorkspaceJobs {
  readonly tenantId: string;
  readonly tenantLabel?: string;
  readonly jobs: readonly AgentObservedJob[];
  readonly truncation: AgentObserverTruncation;
}

export interface AgentSessionUpdatedEvent {
  readonly type: "session:updated";
  readonly session: AgentTerminalSessionInfo;
}

export interface AgentSessionAttentionEvent {
  readonly type: "session:attention";
  readonly session: AgentTerminalSessionInfo;
  readonly reason?: AgentAttentionReason;
}
