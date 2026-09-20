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
     * 컴퓨터 사용(실험). 도구는 세션이 열릴 때 실리고 허용은 호출마다 `enabled()`로 다시 묻는다 —
     * 켜고 끄는 것이 재연결 없이 다음 호출부터 듣는다. 허용을 거둔 순간 진행 중 호출까지 끊으려면
     * {@link AgentSession.revokeComputerUse}를 부른다. 실험 스위치 자체는 호스트가 따로 본다.
     */
    readonly computerUse?: {
      readonly enabled: () => boolean;
      /** 거부 문구의 언어. 없으면 호스트의 Console 언어를 따른다. */
      readonly language?: () => "en" | "ko" | null;
    };
  };
  readonly onEvent?: (event: AgentEvent) => void;
}

export interface AgentSession {
  /** 같은 세션의 턴은 순서대로 실행한다. */
  send(text: string): Promise<void>;
  /** 현재 턴만 취소한다. 대기 턴과 다음 메시지는 유지한다. */
  cancel(): void;
  /**
   * 컴퓨터 사용 허용을 거둔 순간 부른다 — 이 세션의 진행 중 기기 호출을 끊고 잡고 있던 기기를 놓는다.
   * 다음 호출은 `enabled()`가 거부한다. 컴퓨터 사용을 싣지 않은 세션에서는 아무 일도 하지 않는다.
   */
  revokeComputerUse?(): void;
  /** 생성 중·실행 중·종료 후 언제나 멱등이며 실행 자원 정리를 기다린다. */
  dispose(): Promise<void>;
}

/** Console이 호출 플러그인에 바인딩한다. 다른 소유자나 provider 주소를 지정할 수 없다. */
export interface AgentHost {
  createSession(options: AgentSessionOptions): Promise<AgentSession>;
}
