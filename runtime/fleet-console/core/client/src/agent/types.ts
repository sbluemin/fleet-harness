export type SessionStatus = "starting" | "live" | "registered" | "terminal-only" | "closed" | "error" | "dormant";

export type TurnState = "none" | "running" | "ended";
export type ModelActivity = "working" | "not-working";

export type AttentionReason =
  | "idle_prompt"
  | "permission_prompt"
  | "auth_success"
  | "elicitation_dialog"
  | "elicitation_complete"
  | "elicitation_response";

export interface AgentCliStatus {
  readonly id: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly version: string | null;
}

export interface AgentCliState {
  readonly clis: readonly AgentCliStatus[];
}

/** 설치된 Claude Code가 보고한 내장 서브에이전트 로스터. 서버가 CLI를 격리 실행해 읽는다. */
export interface ClaudeBuiltInAgentsState {
  readonly available: boolean;
  readonly agents: readonly string[];
  readonly version: string | null;
  readonly error: "cli_not_found" | "probe_failed" | null;
}

export interface AgentCliDiagnosticsEntry {
  readonly cliCommand: string;
  readonly configuredPath: string | null;
  readonly resolutionSource: "env" | "user" | "path" | null;
  readonly searchedPathEntries: readonly string[];
}

export interface AgentCliDiagnostics {
  readonly entries: readonly AgentCliDiagnosticsEntry[];
}

export interface AgentCliMetadata {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly signedIn: boolean;
}

/**
 * Operation이 지금 서 있는 자리. 서버가 Theater 루트 기준으로 접어 보낸 투영이라 절대 경로는
 * 없다 — `folder`는 루트면 null, Theater 밖이면 basename 하나에 `outside`가 선다.
 */
export interface OperationWorkspace {
  readonly folder: string | null;
  readonly outside: boolean;
  readonly branch: string | null;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly terminalSessionId: string;
  readonly cwdLabel: string;
  /** 실험 기능(Operation 위치 표시)이 켜진 동안만 온다. */
  readonly workspace?: OperationWorkspace;
  readonly label?: string;
  readonly status: SessionStatus;
  readonly turnState: TurnState;
  readonly modelActivity?: ModelActivity;
  readonly attentionPending?: boolean;
  readonly backgroundPending?: boolean;
  /**
   * Chat Mode가 이 세션을 인수했는지 — PTY 없이도 실행 표면이 살아 있다. 활동은 위의
   * `modelActivity`·`attentionPending`이 지고, 이 값은 수명과 표면 표식만 정한다.
   */
  readonly chatActive?: boolean;
  readonly createdAt: number;
  readonly theaterId?: string;
  readonly tenantId?: string;
  readonly registrationId?: string;
  readonly resumeAvailable: boolean;
}

export interface AgentClientState {
  readonly connection: "connecting" | "live";
  readonly connectionError: string | null;
  readonly agentClis: readonly AgentCliMetadata[];
  readonly sessions: Readonly<Record<string, SessionInfo>>;
  readonly sessionOrder: readonly string[];
  readonly activeTerminalSessionId: string | null;
  readonly turnState: Readonly<Record<string, TurnState>>;
}
