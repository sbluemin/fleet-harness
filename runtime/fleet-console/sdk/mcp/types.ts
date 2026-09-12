import type http from "node:http";

export interface PluginMcpTransport {
  mount(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): { url(): Promise<string>; dispose(): void };
}

export const FLEET_CONSOLE_USE_MCP_SERVER = "fleet-console-use";

export const FLEET_AI_GATEWAY_MCP_SERVER = "fleet-ai-gateway";

export interface AiGatewayMcpHost {
  connect(): ConsoleUseMcpConnection;
}

export type { ConsoleActionInput, ConsoleActionKind, ConsoleActionReceipt, ConsoleActivity, ConsoleAutomation, ConsoleAutomationInput, ConsoleControlState, ConsoleOperationObservation } from "./control.js";

export const CONSOLE_READ_TOOLS = ["console_context", "console_theaters", "console_operations", "console_operation", "console_events"] as const;
export const CONSOLE_CONTROL_TOOLS = [...CONSOLE_READ_TOOLS, "console_launch", "console_send", "console_interrupt", "console_action", "console_automation"] as const;
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
  /** 도구 등록 API가 아니다. 호스트 기본 도구 중 이 연결에 필요한 것만 요청한다. */
  connect(options: {
    readonly tools: readonly ConsoleUseToolId[];
    readonly snapshot?: () => ConsoleUseSnapshot | null;
    readonly enabled?: () => boolean;
    /** 호스트 Admiral 연결만 요청한다. 읽기 옵트인은 제어 권한으로 승격되지 않는다. */
    readonly allowControl?: boolean;
  }): ConsoleUseMcpConnection;
}
