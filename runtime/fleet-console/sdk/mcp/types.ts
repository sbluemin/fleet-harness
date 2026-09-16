import type http from "node:http";

export interface PluginMcpTransport {
  mount(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): { url(): Promise<string>; dispose(): void };
}

export const FLEET_CONSOLE_USE_MCP_SERVER = "fleet-console-use";

export const FLEET_AI_GATEWAY_MCP_SERVER = "fleet-ai-gateway";

export interface AiGatewayMcpHost {
  connect(): ConsoleUseMcpConnection;
}

export type { ConsoleCaller, ConsoleActionInput, ConsoleActionKind, ConsoleActionReceipt, ConsoleActivity, ConsoleAutomation, ConsoleAutomationInput, ConsoleControlState, ConsoleOperationObservation } from "./control.js";

export const CONSOLE_READ_TOOLS = [
  "console_context", "console_theaters", "console_operations", "console_operation", "console_events", "console_end",
  // 관측의 확장 — 누가 무엇을 쓰는지, 한 Operation의 전체 대화·잡·카탈로그, 분석가의 산출물과 관찰 결과.
  "console_using", "console_transcript", "console_jobs", "console_catalog", "console_analyst_artifacts", "console_watch_last",
] as const;
export const CONSOLE_CONTROL_TOOLS = [
  ...CONSOLE_READ_TOOLS, "console_launch", "console_send", "console_interrupt", "console_action", "console_automation",
  // 운용의 확장 — 사람이 Operation에 하는 나머지 동사(재개·닫기·이름·뷰), 정리(그룹·액센트·보이기), 자식 질문 답, 분석가 질문.
  "console_resume", "console_close", "console_rename", "console_view", "console_group", "console_accent", "console_reveal", "console_answer", "console_analyst_ask",
] as const;
export type ConsoleUseToolId = (typeof CONSOLE_CONTROL_TOOLS)[number];

export interface ConsoleUseSnapshot {
  readonly takenAt?: string;
  readonly theaters: readonly { readonly id: string; readonly label: string }[];
  readonly operations: readonly {
    readonly id: string;
    readonly theaterId: string;
    readonly type: string;
    readonly title: string;
    readonly activity: string;
  }[];
}

/** 서버 내부 연결 계약. URL과 토큰은 브라우저 DTO에 포함하지 않는다. */
export interface AdmiralMcpSession {
  getEndpoint(): Promise<{ readonly servers: readonly { readonly name: string; readonly url: string }[] }>;
  issueSessionToken(request: {
    readonly label: string;
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly includeTool?: (toolId: string) => boolean;
    readonly registeredAgentNames?: readonly string[];
  }): readonly { readonly name: string; readonly token: string }[];
  releaseSessionToken(label: string): void;
  cleanup(): void;
}

export interface ConsoleUseMcpConnection extends AdmiralMcpSession {
  /** 실행 어댑터가 사용하는 불투명 Embedded MCP 핸들. SDK는 vendor 타입에 의존하지 않는다. */
  readonly embeddedServer: unknown;
  dispose(): Promise<void>;
}

export interface PluginMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  execute(args: unknown, context: {
    readonly cwd: string;
    readonly sessionLabel?: string;
    readonly toolCallId?: string;
    readonly signal?: AbortSignal;
  }): Promise<unknown>;
}

export interface PluginAdmiralMcpHost {
  /** 호출 플러그인의 id로 fleet-{pluginId} 서버를 등록한다. 다른 플러그인의 이름은 지정할 수 없다. */
  register(tools: readonly PluginMcpTool[]): () => void;
  /** 등록 순서와 무관하게 세션을 만들 때 활성 플러그인의 MCP를 연결한다. */
  connect(): AdmiralMcpSession;
}

export interface ConsoleUseMcpHost {
  /**
   * 플러그인이 자기 영역의 읽기 도구를 `fleet-console-use`에 싣는다. 이름은 `console_` 접두사여야 하고
   * 호스트 기본 도구와 겹칠 수 없다. 기여한 도구는 모든 Console Use 연결에 실리며 호스트 기본 도구와
   * **같은 게이트**(실험 옵트인 AND 호출자 Operation의 콘솔 사용 토글)를 지난다 — 플러그인이 자기
   * 게이트를 따로 두지 않는다. 쓰기(커밋·파일 변경)는 여기로 열지 않는다: 그것은 그 Theater의
   * Operation에 시키는 일이다. 반환값은 등록 해제다.
   */
  contribute?(tools: readonly PluginMcpTool[]): () => void;
  /** 도구 등록 API가 아니다. 호스트 기본 도구 중 이 연결에 필요한 것만 요청한다. */
  connect(options: {
    readonly tools: readonly ConsoleUseToolId[];
    readonly snapshot?: () => ConsoleUseSnapshot | null;
    readonly enabled?: () => boolean;
    /** 제어 도구는 명시적으로 요청하며 호스트가 호출자와 콘솔 사용 옵트인을 검증한다. */
    readonly allowControl?: boolean;
    /**
     * 이 연결의 호출자는 Operation이다. 호출마다 호출자 Operation을 풀어 실험 옵트인과 그
     * Operation의 콘솔 사용 토글을 함께 확인하고, 읽기를 포함한 모든 도구를 거부할 수 있다.
     * 플러그인 소유 연결은 Operation을 갖지 않으므로 이 축을 쓰지 않는다.
     */
    readonly operationCallers?: boolean;
  }): ConsoleUseMcpConnection;
  /**
   * 한 Operation 이 호출자로서 열어 둔 Console Use 세션을 닫는다 — 그 Operation 의 턴이 끝났을 때 호스트가
   * 부른다. 실행한 하위 Operation 은 그대로 살고, 「사용 중」 표식만 턴과 함께 내려간다.
   */
  endOperationUse?(operationId: string): void;
}
