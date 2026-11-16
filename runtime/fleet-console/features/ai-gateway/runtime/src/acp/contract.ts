/**
 * agy ACP 세션 포트 — Antigravity 카탈로그 모델(Gemini와 Claude)을 고른 Fleet 세션이 `agy acp` 자식과 말하는 유일한 계약.
 *
 * 게이트웨이는 Cloud Code Assist를 직접 부르지 않는다. 대신 이 포트 뒤에서 `agy acp`를 전용 app-data-dir로 기동하고,
 * ACP 업데이트를 아래 어휘로 정규화해 호스트에 넘긴다. 호스트(execution·commodore)는 이 타입만 알고 ACP 와이어는 모른다.
 *
 * - resume은 없다: Fleet이 다시 떠도 agy 세션은 언제나 `session/new`로 새로 연다.
 * - 고른 모델이 계정의 `availableModels`에 없으면 `open`이 즉시 `AcpModelUnavailableError`로 실패한다.
 */

export type AcpThoughtLevel = "low" | "medium" | "high";

/**
 * 내장 도구 없는 세션 — agy가 이 MCP 서버의 도구만 쓰게 한다(Messages 브리지용).
 *
 * agy 1.5.9 실측으로 통과한 조합이다: 세션 전용 gemini-dir에 내장 컴포넌트를 뺀 커스텀 에이전트(`--agent`)와
 * `config/mcp_config.json`을 써 두고 띄운다. MCP 서버는 ACP `session/new`가 아니라 이 설정 파일로 붙고(그래서
 * 도구 목록은 세션을 열 때 정해진다), 도구는 `eager`로 직접 노출한다. 권한 요청은 이 서버의 도구만 허용한다.
 * 세션 cwd는 gemini-dir 아래의 빈 디렉터리다.
 */
export interface AcpToolOnlyConfig {
  /** MCP 서버 이름. agy가 도구를 `mcp_<serverName>_<tool>`로 노출한다. */
  readonly serverName: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** 직접 노출할(eager) 도구 이름들. 목록 밖 도구는 agy가 `call_mcp_tool`로만 부른다. */
  readonly toolNames: readonly string[];
  /** agy가 MCP 호출 하나를 붙잡아 두는 한도(초). agy 기본은 180초다. */
  readonly callTimeoutSeconds: number;
}

export interface AcpSessionOpenOptions {
  /** 카탈로그의 Antigravity 모델 id(예: `gemini-4-argon`, `claude-opus-5.5`). agy 쪽 와이어 id 해석은 포트 구현이 맡는다. */
  readonly model: string;
  readonly thoughtLevel?: AcpThoughtLevel;
  /** 세션 시스템 프롬프트 — `_meta.antigravity.systemPrompt.append`로 붙는다. */
  readonly systemPrompt: string;
  /** agy는 이 MCP 서버의 도구만 쓴다. 이 포트에는 다른 모드가 없다. */
  readonly toolOnly: AcpToolOnlyConfig;
  /** 세션 전용 gemini-dir의 이름으로 쓸 키(`[A-Za-z0-9._-]+`). 생략하면 새 uuid. 세션을 닫으면 그 디렉터리를 지운다. */
  readonly sessionKey?: string;
  /** 세션을 닫으면 자식 프로세스까지 끝낸다. */
  readonly signal?: AbortSignal;
}

/** 프롬프트 한 턴의 입력 블록. 이미지는 base64 바이트를 그대로 싣는다. */
export type AcpPromptBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly mimeType: string; readonly data: string };

/** `session/prompt` 응답이 싣는 턴 전체의 토큰 사용량(여러 모델 호출의 합). */
export interface AcpTurnUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thoughtTokens: number;
  readonly cachedReadTokens: number;
  readonly totalTokens: number;
}

export interface AcpUsage {
  readonly usedTokens: number;
  readonly contextWindow: number;
}

/**
 * agy가 보내는 `session/update`를 접은 정규화 이벤트. 호스트는 이것을 자기 화면 어휘(AgentEvent·채팅 이벤트)로 옮긴다.
 * thought는 화면에 공개 출력으로 싣지 않는다(호스트 불변식) — 구분해서 넘길 뿐이다.
 */
export type AcpSessionEvent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thought"; readonly text: string }
  | { readonly kind: "tool-start"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly kind: "tool-end"; readonly id: string; readonly isError: boolean; readonly output?: string }
  | { readonly kind: "usage"; readonly usage: AcpUsage }
  | { readonly kind: "turn-end"; readonly stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled" | "error"; readonly detail?: string; readonly usage?: AcpTurnUsage }
  | { readonly kind: "exit"; readonly code: number | null; readonly detail?: string };

export interface AcpSession {
  /** agy가 준 세션 id — 진단용이며 재개에는 쓰지 않는다. */
  readonly sessionId: string;
  /** 실제로 고른 agy 와이어 모델 id. */
  readonly wireModel: string;
  /** 한 턴을 보내고, 그 턴의 이벤트를 `turn-end`까지 흘린다. 동시에 두 턴을 돌리지 않는다. */
  prompt(blocks: readonly AcpPromptBlock[]): AsyncIterable<AcpSessionEvent>;
  /**
   * 도는 턴에 사용자 내용을 더 보낸다(steering, agy 1.5.9: 실행 중인 턴에 `session/prompt`를 또 보낸다).
   * 실측: 앞선 prompt 요청은 곧바로 `end_turn`으로 응답하지만 이는 호출자의 턴 끝이 아니다(`turn-end`로 내지 않는다). 턴은 이어지고,
   * 보류 중인 도구 호출이 풀린 뒤 이 내용이 **도구 결과 다음의 user 메시지**로 모델에 보인다. 턴의 `turn-end`는 이 요청의 응답이다.
   * 도는 턴이 없으면 던진다. 앞선 요청의 응답까지 (짧게 한정해) 기다린 뒤 돌아온다: 호출자가 곧바로 도구 결과를 풀어도 agy가 이 내용을
   * 먼저 받은 뒤라는 보장이다.
   */
  steer(blocks: readonly AcpPromptBlock[]): void | Promise<void>;
  /** 도는 턴을 취소한다(`session/cancel`). 턴은 `turn-end`(cancelled)로 끝난다. */
  cancel(): Promise<void>;
  /** 세션과 자식 프로세스를 닫는다. 여러 번 불러도 안전하다. */
  close(): Promise<void>;
}

export interface AcpSessionPort {
  open(options: AcpSessionOpenOptions): Promise<AcpSession>;
}

/** 고른 모델이 이 계정의 `availableModels`에 없다 — 세션을 열지 않고 즉시 실패한다. */
export class AcpModelUnavailableError extends Error {
  readonly code = "acp_model_unavailable" as const;
  constructor(
    readonly model: string,
    readonly availableModels: readonly string[],
  ) {
    super(`Model ${model} is not available for this agy account.`);
    this.name = "AcpModelUnavailableError";
  }
}

/** agy가 로그인되어 있지 않다(전용 app-data-dir에 구독 로그인이 없다). */
export class AcpAuthRequiredError extends Error {
  readonly code = "acp_auth_required" as const;
  constructor(message = "agy is not signed in for Fleet's app-data-dir.") {
    super(message);
    this.name = "AcpAuthRequiredError";
  }
}
