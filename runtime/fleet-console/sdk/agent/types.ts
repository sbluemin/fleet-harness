import type { ConsoleUseMcpHost, PluginMcpTool } from "../mcp/types.js";

export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
}

/** 서버 내부 이벤트다. 플러그인은 브라우저 DTO로 변환할 때 도구 입력과 오류를 정제한다. */
export type AgentEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "tool-start"; readonly id?: string; readonly name: string; readonly input: unknown }
  | { readonly kind: "tool-end"; readonly id?: string; readonly name?: string; readonly isError: boolean }
  | { readonly kind: "result"; readonly isError: boolean; readonly detail?: string; readonly source: "message" | "incomplete" | "watchdog"; readonly usage?: AgentUsage }
  | { readonly kind: "cancelled" };

export interface AgentToolGroup {
  readonly name: string;
  readonly tools: readonly PluginMcpTool[];
}

export interface AgentSessionOptions {
  readonly model: string;
  readonly effort?: AgentEffort;
  readonly systemPrompt: string;
  readonly continuation: "conversation" | "oneshot";
  readonly settlement: "result" | "result-required";
  readonly timeoutMs?: number;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  /** 플러그인 실행은 파일·셸·하위 Agent를 기본 제공하지 않는다. */
  readonly tools?: {
    readonly builtins?: readonly ("WebSearch" | "WebFetch")[];
    readonly custom?: readonly AgentToolGroup[];
    readonly consoleUse?: Parameters<ConsoleUseMcpHost["connect"]>[0];
    /**
     * fleet-ai-gateway 리소스(라우팅 가이드·노출 모델 로스터)를 이 세션에 연결한다. 도구는 없고
     * 읽기뿐이므로 호스트가 MCP 리소스 읽기 내장 도구를 함께 연다. 위임 실행 능력은 주지 않는다.
     */
    readonly aiGateway?: boolean;
  };
  readonly onEvent?: (event: AgentEvent) => void;
}

export interface AgentSession {
  /** 같은 세션의 턴은 순서대로 실행한다. */
  send(text: string): Promise<void>;
  /** 현재 턴만 취소한다. 대기 턴과 다음 메시지는 유지한다. */
  cancel(): void;
  /** 생성 중·실행 중·종료 후 언제나 멱등이며 실행 자원 정리를 기다린다. */
  dispose(): Promise<void>;
}

/** Console이 호출 플러그인에 바인딩한다. 다른 소유자나 provider 주소를 지정할 수 없다. */
export interface AgentHost {
  createSession(options: AgentSessionOptions): Promise<AgentSession>;
}
