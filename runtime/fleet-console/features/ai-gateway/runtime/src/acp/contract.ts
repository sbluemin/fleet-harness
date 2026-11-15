/**
 * agy ACP 세션 포트 — Gemini 모델을 고른 Fleet 세션(사령관·지휘관·구성원)이 `agy acp` 자식과 말하는 유일한 계약.
 *
 * 게이트웨이는 Cloud Code Assist를 직접 부르지 않는다. 대신 이 포트 뒤에서 `agy acp`를 전용 app-data-dir로 기동하고,
 * ACP 업데이트를 아래 어휘로 정규화해 호스트에 넘긴다. 호스트(execution·commodore)는 이 타입만 알고 ACP 와이어는 모른다.
 *
 * - resume은 없다: Fleet이 다시 떠도 agy 세션은 언제나 `session/new`로 새로 연다.
 * - 고른 모델이 계정의 `availableModels`에 없으면 `open`이 즉시 `AcpModelUnavailableError`로 실패한다.
 */

/** 호스트가 agy 세션에 붙이는 HTTP MCP 서버 하나 — Fleet MCP가 Bearer 헤더로 연결된다. */
export interface AcpMcpServer {
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** 이 세션이 쓸 Claude Code 플러그인 하나 — 사령관이 고른, 이미 설치된 사본의 이름과 로컬 디렉터리. */
export interface AcpPluginSource {
  /** 플러그인 이름. 변환본이 이 이름으로 노출된다. */
  readonly name: string;
  /** Claude Code 쪽 설치본의 절대경로(`.claude-plugin/plugin.json`이 있는 디렉터리). */
  readonly dir: string;
}

export type AcpThoughtLevel = "low" | "medium" | "high";

export interface AcpSessionOpenOptions {
  /** 카탈로그의 Gemini 모델 id(예: `gemini-4-argon`). agy 쪽 와이어 id 해석은 포트 구현이 맡는다. */
  readonly model: string;
  readonly thoughtLevel?: AcpThoughtLevel;
  readonly cwd: string;
  /** 쓰기를 허용할 추가 디렉터리 — `agy acp --add-dir`로 옮긴다. */
  readonly addDirs?: readonly string[];
  /** 세션 시스템 프롬프트 — `_meta.antigravity.systemPrompt.append`로 붙는다. */
  readonly systemPrompt: string;
  readonly mcpServers: readonly AcpMcpServer[];
  /**
   * 이 세션이 쓸 플러그인. 세션을 시작할 때마다 agy 변환 캐시를 이 목록으로 다시 만들고, 세션의 gemini-dir가
   * 그 이름만(`include_only`) 읽게 한다. 설치·활성 상태는 어디에도 남지 않는다. 비면 플러그인 없이 연다.
   */
  readonly plugins?: readonly AcpPluginSource[];
  /** 세션 전용 gemini-dir의 이름으로 쓸 키(`[A-Za-z0-9._-]+`). 생략하면 새 uuid. 세션을 닫으면 그 디렉터리를 지운다. */
  readonly sessionKey?: string;
  /** 세션을 닫으면 자식 프로세스까지 끝낸다. */
  readonly signal?: AbortSignal;
}

/** 프롬프트 한 턴의 입력 블록. 이미지는 base64 바이트를 그대로 싣는다. */
export type AcpPromptBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly mimeType: string; readonly data: string };

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
  | { readonly kind: "turn-end"; readonly stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled" | "error"; readonly detail?: string }
  | { readonly kind: "exit"; readonly code: number | null; readonly detail?: string };

export interface AcpSession {
  /** agy가 준 세션 id — 진단용이며 재개에는 쓰지 않는다. */
  readonly sessionId: string;
  /** 실제로 고른 agy 와이어 모델 id. */
  readonly wireModel: string;
  /** 한 턴을 보내고, 그 턴의 이벤트를 `turn-end`까지 흘린다. 동시에 두 턴을 돌리지 않는다. */
  prompt(blocks: readonly AcpPromptBlock[]): AsyncIterable<AcpSessionEvent>;
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
