import type http from "node:http";
import type { ConsoleCaller } from "./control.js";

export interface PluginMcpTransport {
  mount(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): { url(): Promise<string>; dispose(): void };
}

export const FLEET_CONSOLE_USE_MCP_SERVER = "fleet-console-use";

export const FLEET_AI_GATEWAY_MCP_SERVER = "fleet-ai-gateway";

export interface AiGatewayMcpHost {
  connect(): ConsoleUseMcpConnection;
}

export type { ConsoleCaller, ConsoleActionInput, ConsoleActionKind, ConsoleActionReceipt, ConsoleActivity, ConsoleAutomation, ConsoleAutomationInput, ConsoleControlState, ConsoleOperationObservation } from "./control.js";

/**
 * Console Use 도구는 Console 화면의 자리 이름을 갖는다 — 사이드바(operations·organize), Operation 패널
 * (operation·send·panel·analyst), Quick Launch(launch). 자리가 없는 동사(자동화·사건 대기·영수증 조회)는
 * 도구가 아니다. 호출 하나는 사용자 화면 위의 제스처 하나이며, 호스트가 `console-use:call` 사건으로 알린다.
 */
export const CONSOLE_READ_TOOLS = ["console_context", "console_operations", "console_operation"] as const;
export const CONSOLE_CONTROL_TOOLS = [
  ...CONSOLE_READ_TOOLS, "console_organize", "console_send", "console_panel", "console_analyst", "console_launch",
] as const;
export type ConsoleUseToolId = (typeof CONSOLE_CONTROL_TOOLS)[number];

/** 어느 화면 자리에 제스처가 닿는가. 내용(전사·diff·파일 본문)은 싣지 않는다 — 원격 세션도 받는 채널이다. */
export type ConsoleUseCallTarget =
  | { readonly kind: "theater"; readonly theaterId: string }
  | { readonly kind: "operation"; readonly operationId: string }
  | { readonly kind: "group"; readonly groupId: string; readonly theaterId: string }
  | { readonly kind: "panel"; readonly panelId: string; readonly theaterId: string; readonly view?: string; readonly path?: string };

export interface ConsoleUseCallEvent {
  readonly caller: ConsoleCaller;
  readonly tool: string;
  /** 사람이 읽는 한 줄 — 대상 표식의 툴팁·말풍선에 그대로 나간다. 경로는 Theater 상대, 식별자는 제목으로. */
  readonly summary: string;
  readonly gesture: "gaze" | "input" | "press" | "create" | "wait";
  readonly target?: ConsoleUseCallTarget;
  readonly at: number;
}

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
  }): readonly { readonly name: string; readonly token: string }[];
  releaseSessionToken(label: string): void;
  cleanup(): void;
}

export interface ConsoleUseMcpConnection extends AdmiralMcpSession {
  /** 실행 어댑터가 사용하는 불투명 Embedded MCP 핸들. SDK는 vendor 타입에 의존하지 않는다. */
  readonly embeddedServer: unknown;
  /** 이 연결에 실린 도구 이름 전부 — 요청한 호스트 도구와 플러그인이 기여한 도구. allowlist 를 짜는 쪽이 읽는다. */
  toolNames?(): readonly string[];
  dispose(): Promise<void>;
}

export interface PluginMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /**
   * Console Use 기여 도구의 화면 자리. 호스트는 호출마다 그 Activity Rail 패널 버튼을 감싸는 표식을
   * 그린다 — 자리를 선언하지 않은 도구는 Console Use 에 실리지 않는다. `describe` 는 인자에서 표식 이름표
   * 한 줄과 보기(view)·경로를 뽑는다; 경로는 Theater 상대여야 한다.
   */
  readonly surface?: {
    readonly panelId: string;
    describe(args: Record<string, unknown>): { readonly theaterId: string; readonly summary: string; readonly view?: string; readonly path?: string } | null;
  };
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
