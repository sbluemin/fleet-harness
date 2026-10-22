export type SessionStatus = "starting" | "live" | "registered" | "terminal-only" | "closed" | "error" | "dormant";

export type TurnState = "none" | "running" | "ended";
export type ModelActivity = "working" | "not-working";
/** Chat 턴 안에서 지금 하는 일의 계열 — 서버가 계열이 바뀔 때만 싣는다. 몽글 아바타의 활동 연기만 읽는다. */
export type SessionStep = "think" | "read" | "edit" | "run" | "fetch" | "delegate" | "text" | "compact";

export type AttentionReason =
  | "idle_prompt"
  | "permission_prompt"
  | "auth_success"
  | "elicitation_dialog"
  | "elicitation_complete"
  | "elicitation_response";

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
  /** Chat 턴이 도는 동안 지금 하는 일의 계열. 터미널 세션·턴 밖·모르는 도구에는 없다. 활동축이 아니라 표시용 사실이다. */
  readonly step?: SessionStep;
  readonly createdAt: number;
  readonly theaterId?: string;
  readonly tenantId?: string;
  readonly registrationId?: string;
  readonly resumeAvailable: boolean;
  /**
   * 살아 있는 PTY의 세대 — 기동마다 바뀌고 휴면에는 없다. 터미널 표면은 세대마다 새로 붙고, 옛 소켓의
   * 종료(4001)는 같은 세대의 항목만 지운다. 옛 서버는 싣지 않는다.
   */
  readonly generation?: string;
  /**
   * 살아 있는 세션이 시작할 때 실은 구성의 판정. `previous` 면 업데이트 전 구성으로 계속 도는 중이다(조용한 사실).
   * 휴면 세션과 옛 서버에는 없다.
   */
  readonly configurationState?: "current" | "previous" | "unknown";
  /** `previous` 이고 시작 release 가 지금과 다를 때만 그 version. */
  readonly configurationRelease?: string;
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
