import type { ConsoleUseMcpHost, PluginMcpTool } from "../mcp/types.js";

export type AgentInputBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; readonly data: string } };
export type AgentInput = string | readonly AgentInputBlock[];

/** 플러그인 등록이 소유자를 고정한다. 경로 없이 바이트만 건넨다. */
export interface PluginAttachmentHost {
  claim(scopeId: string, messageId: string, ids: readonly string[], maxBytes: number): number;
  read(scopeId: string, messageId: string): readonly { readonly id: string; readonly mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; readonly bytes: Uint8Array }[];
  release(scopeId: string, messageId: string): void;
  rollbackClaim(scopeId: string, messageId: string): void;
}

export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "max";
export interface AgentUsage {
  /** 이 턴의 주 루프 호출들이 읽은 입력의 합(캐시 포함). 도구를 쓴 턴에서는 대화 크기보다 크다. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd?: number;
  /** 이 턴의 마지막 호출이 읽은 입력(캐시 포함) — 다음 턴이 이어받는 대화의 크기. 관찰하지 못했으면 없다. */
  readonly contextTokens?: number;
  /**
   * 압축 지점을 호출자가 아니라 실행 경로가 정하는 세션(Gateway 모델)에서, `contextTokens`와 같은 단위의 창과 실제 압축 지점.
   * 호스트는 그 세션의 토큰을 공급자의 실제 토큰으로 되돌려 싣는다. `null`은 호스트도 모른다는 뜻이다(토큰은 실행기가 말한 그대로다).
   * 없으면 세션이 요청한 `compactAt`이 압축 지점이다.
   */
  readonly context?: { readonly window: number | null; readonly compactAt: number | null };
}

/** 서버 내부 이벤트다. 플러그인은 브라우저 DTO로 변환할 때 도구 입력과 오류를 정제한다. */
export type AgentEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string }
  | { readonly kind: "tool-start"; readonly id?: string; readonly name: string; readonly input: unknown }
  | { readonly kind: "tool-end"; readonly id?: string; readonly name?: string; readonly isError: boolean }
  | { readonly kind: "result"; readonly isError: boolean; readonly detail?: string; readonly source: "message" | "incomplete" | "watchdog"; readonly usage?: AgentUsage }
  | { readonly kind: "cancelled" }
  /** 세션이 대화를 요약해 같은 세션으로 이어 갔다. 턴 시작에도, 도구 루프 중간에도 올 수 있다. 모르는 소비자는 무시한다. */
  | { readonly kind: "compacted"; readonly trigger: "auto" | "manual"; readonly preTokens: number; readonly postTokens?: number }
  /** 세션이 대화를 요약하려다 실패했다 — 대화는 줄지 않았다. 창을 넘긴 세션이면 이어지는 턴이 오류로 끝난다. 모르는 소비자는 무시한다. */
  | { readonly kind: "compact-failed" };

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
  /**
   * `conversation` 세션이 대화를 요약해 이어 갈 문맥 토큰 수. 생략하면 실행기의 기본 지점이다.
   *
   * 호스트는 이 값을 자식의 자동 압축 창으로 옮긴다 — 네이티브 Claude 모델에서는 대화가 이 크기에 닿을 때 압축된다.
   * Gateway 모델(비-Claude)은 Gateway가 사용량을 공급자 창으로 투영하고 자기 compact 정책으로 압축 시점을 정하므로
   * 이 값을 적용하지 않는다.
   */
  readonly compactAt?: number;
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
  send(input: AgentInput): Promise<void>;
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
