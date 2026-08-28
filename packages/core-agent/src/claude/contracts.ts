/**
 * 이 패키지의 공개 어휘. vendor SDK 타입 이름이 한 개도 등장하지 않는다.
 *
 * 왜 재수출이 아니라 자체 정의인가: vendor 타입을 그대로 재수출하면 소비자의 tsc가 우리 `.d.ts`가
 * 참조하는 `@anthropic-ai/claude-agent-sdk`(및 그 peer인 `@anthropic-ai/sdk`,
 * `@modelcontextprotocol/sdk`, `zod`)를 자기 해석 컨텍스트에서 다시 찾아야 한다. pnpm strict는
 * 선언하지 않은 의존을 소비자 node_modules로 끌어올리지 않으므로, 재수출은 곧 소비자에게 vendor
 * 의존을 강제하는 것과 같다. 정밀한 SDK 타입을 포기하는 대신 소비처의 직접 의존을 없애는 교환이며,
 * 그 교환이 이 패키지의 존재 이유다.
 */

/** core-ai-gateway 카탈로그가 노출하는 추론 강도 사다리. */
export type ClaudeGatewayEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type ClaudeGatewayPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

/**
 * 한 턴이 흘려보내는 이벤트.
 *
 * vendor의 message union은 40여 개 변종이고 그 안에 `BetaMessage`·`MessageParam` 같은 다른
 * 패키지의 타입이 물려 있다. 소비자는 `type`으로 좁히고 필요한 필드를 읽는다.
 */
export interface ClaudeGatewayMessage {
  readonly type: string;
  readonly subtype?: string;
  readonly session_id?: string;
  readonly [key: string]: unknown;
}

/**
 * `defineTool`이 만든 불투명 핸들. 손으로 만들 수 없다.
 *
 * 입력 타입을 파라미터로 싣지 않는다. 그 타입은 `defineTool` 호출부에서 handler 인자를 좁히는 데만
 * 쓰이고 핸들을 받는 쪽은 아무도 읽지 않는데, 파라미터로 실으면 인터페이스로 선언된 입력 타입이
 * 암묵 index signature를 못 받아 `tools` 배열에 담기지 않는다.
 */
export interface ClaudeGatewayTool {
  /** @internal */
  readonly __claudeGatewayTool: true;
}

/** `createEmbeddedMcpServer`가 만든 불투명 핸들. */
export interface ClaudeGatewayMcpServer {
  /** @internal */
  readonly __claudeGatewayMcpServer: true;
}

export interface ClaudeGatewayToolResult {
  readonly content: readonly Readonly<Record<string, unknown>>[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

/**
 * 자식이 포트로 접속하는 HTTP MCP 서버.
 *
 * `mcpServers`(값으로 건네는 in-process 도구)와 다른 물건이다. 이쪽은 호스트가 이미 띄워 둔
 * 엔드포인트의 주소와 자격을 알려 줄 뿐이고, 자식이 직접 접속한다.
 *
 * 타임아웃 단위가 이름에 박혀 있는 이유: vendor는 밀리초를 받고 1000 미만은 무시한다. 초를 그대로
 * 넘기면 전부 무시되어 기본값으로 도는데, 그 실패는 조용하다.
 */
export interface ClaudeGatewayServedMcpServer {
  readonly name: string;
  readonly url: string;
  readonly headers?: readonly { readonly name: string; readonly value: string }[];
  readonly toolTimeoutSeconds?: number;
}

export interface ClaudeGatewayToolExtras {
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly searchHint?: string;
  readonly alwaysLoad?: boolean;
}

export interface ClaudeGatewayMcpServerOptions {
  readonly name: string;
  readonly version?: string;
  readonly tools?: readonly ClaudeGatewayTool[];
  readonly alwaysLoad?: boolean;
}

/**
 * 호출자가 직접 쓴 시스템 지시. Claude Code CLI의 플래그와 같은 모드들이다.
 *
 * - `replace` — `--system-prompt`. 이 텍스트가 시스템 블록이 된다. 측정하면 SDK 자신의 62자
 *   정체성 블록은 남고 이 텍스트가 별도 블록으로 붙으며 프롬프트 캐싱이 걸린다.
 * - `append` — `--append-system-prompt`. Claude Code의 기본 프롬프트를 켠 뒤 그 **본문 안에**
 *   이 텍스트를 이어 붙인다. 측정치로 27,7xx자를 매 턴 싣게 되므로, 코딩 에이전트가 실제로
 *   필요한 소비처에만 쓴다. 페르소나만 필요하면 `replace`다.
 * - `preset` — 이어붙일 텍스트 없이 Claude Code 기본 프롬프트만 켠다. 생략과의 차이가 이
 *   모드의 전부다: 실측(SDK 0.3.212, haiku, 턴당 총 입력 토큰) 생략 18,272 / `preset`
 *   24,632 — 생략하면 그 기본 프롬프트가 아예 실리지 않는다.
 *
 * 생략하면 아무것도 주입하지 않는다. 그때 자식이 받는 시스템은 SDK 정체성 한 줄뿐이다.
 */
export type ClaudeGatewaySystemPrompt =
  | { readonly mode: "replace"; readonly text: string }
  | { readonly mode: "append"; readonly text: string }
  | { readonly mode: "preset" };

/**
 * 자식이 도구를 쓰기 전에 호스트에게 묻는 자리. 호출자가 이 콜백을 주면 vendor가 대화형 도구
 * (`AskUserQuestion`·`ExitPlanMode`)를 자식의 도구 목록에 싣는다 — 실측: 콜백이 없으면 29개,
 * 있으면 32개이고 그 셋이 함께 들어온다.
 *
 * `permissionMode: "bypassPermissions"`는 평범한 도구를 콜백 앞에서 자동 승인하지만, 이 두
 * 대화형 도구는 그 모드에서도 여기까지 온다(실측). 그래서 이 콜백은 권한 게이트가 아니라
 * **사용자에게 물어보는 통로**로 쓰인다.
 */
export interface ClaudeGatewayToolPermissionContext {
  /** 이 도구 호출의 식별자. 같은 assistant 메시지의 도구 호출끼리 서로 다르다. */
  readonly toolUseId: string;
  /** 턴이 끊기면 신호가 온다. 대기 중인 질문을 정리하는 근거다. */
  readonly signal: AbortSignal;
}

/**
 * 호스트의 답. `allow`의 `updatedInput`이 답변을 싣는 자리다 — `AskUserQuestion`은 그 안의
 * `answers`(질문 텍스트 → 답)를 사용자의 선택으로 읽고, `ExitPlanMode`는 allow 자체를 계획
 * 승인으로 읽는다. `deny`의 `message`는 자식에게 오류 결과로 전달되며, 계획 쪽에서는 그것이
 * 곧 수정 요청이 되어 모델이 계획을 고쳐 다시 낸다.
 */
export type ClaudeGatewayToolPermission =
  | { readonly behavior: "allow"; readonly updatedInput?: Readonly<Record<string, unknown>> }
  | { readonly behavior: "deny"; readonly message: string };

export type ClaudeGatewayCanUseTool = (
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  context: ClaudeGatewayToolPermissionContext,
) => Promise<ClaudeGatewayToolPermission>;

export interface ClaudeGatewaySdkOptions {
  /**
   * Anthropic 호환 `/v1` endpoint의 절대 URL. 호스트가 `createAiGatewayRouter`를 서빙한 주소를
   * 그대로 넘긴다. 이 패키지는 listener를 만들지 않고, 값이 없거나 절대 HTTP(S) URL이 아니면
   * 생성 시점에 throw한다 — Anthropic 공개 endpoint로 조용히 내려가지 않는다.
   */
  readonly baseUrl: string;
  /**
   * 이 인스턴스가 실행을 허용하는 모델 id. 빈 배열은 거부한다.
   *
   * 두 종류를 받는다. `claude-gateway--`로 시작하는 id는 카탈로그로 검증하며, 해석되지 않으면
   * 거부한다 — 게이트웨이 라우터가 같은 입력에 400을 내는 것과 같은 판정이다. 그 외의 id는
   * 네이티브 Anthropic 모델로 보고 그대로 통과시킨다. 게이트웨이가 카탈로그에 없는 모델을
   * 호출자 자격증명으로 Anthropic에 원문 중계하기 때문이고, 그 경로를 여기서 막으면 게이트웨이가
   * 실제로 서빙하는 것을 이 패키지만 거부하게 된다.
   *
   * 선택 항목이 아니라 필수인 이유: 생략을 전체 카탈로그로 해석하면, 사용자가 Console에서 끈
   * 모델을 요청했을 때 게이트웨이 선별 게이트의 403이 첫 턴까지 미뤄진다. 실패를 생성 시점으로
   * 당긴다.
   */
  readonly models: readonly string[];
  /** 격리 config dir을 만들 부모 디렉터리. 기본값은 OS 임시 디렉터리. `home`이 공유면 무시된다. */
  readonly tempRoot?: string;
  /**
   * 자식이 실을 로컬 플러그인 디렉터리. 그 안의 스킬·훅·에이전트·커맨드가 함께 들어온다.
   *
   * 파일 경로이지만 ambient가 아니다 — 호출자가 이 목록을 직접 만들어 넘긴다. 자식이 스스로
   * 찾아 읽는 것과 호출자가 지목한 것의 차이가 이 패키지의 경계이고, 후자는 `systemPrompt`와
   * 같은 자격이다. 플러그인의 MCP 선언은 읽지 않는다(`skipMcpDiscovery`) — MCP 좌표는 호출자가
   * `mcpServers`/`servedMcpServers`로 이미 소유한다.
   */
  readonly plugins?: readonly { readonly path: string }[];
  /**
   * 자식이 디스크에서 읽어도 되는 설정 층. 생략하면 아무것도 읽지 않는다.
   *
   * 이것과 `allowAmbientMcpServers`만이 ambient를 여는 자리다. 기본값이 "아무것도"인 이유는
   * 소비자가 그것을 몰라서 켜지는 일이 없게 하기 위함이지, ambient가 언제나 틀려서가 아니다 —
   * 같은 세션을 터미널 CLI로도 여는 호스트에서는 두 표면이 같은 `CLAUDE.md`와 설정을 읽어야
   * 한 세션의 두 얼굴이 된다.
   */
  readonly settingSources?: readonly ("user" | "project" | "local")[];
  /**
   * 자식이 프로젝트 `.mcp.json`·사용자 설정·플러그인이 선언한 MCP 서버에 붙어도 되는가.
   * 기본은 `false`이고, 그때는 호출자가 넘긴 좌표만 남는다.
   *
   * 여는 쪽을 골라도 이 패키지가 넘기는 내부 세션 토큰이 그 서버들로 새지는 않는다 — 헤더는
   * 호출자가 지목한 좌표에만 실리고, 자식이 스스로 찾은 서버에는 이 패키지가 아무것도 주지 않는다.
   */
  readonly allowAmbientMcpServers?: boolean;
  /**
   * 스킬 이름별 노출 오버라이드. 이 패키지는 어떤 스킬을 끌지 알지 못한다 — 그 판단은 도메인이고,
   * 여기는 호출자가 고른 값을 자식의 설정으로 옮기기만 한다.
   *
   * `settings` 전체가 아니라 이 한 갈래만 여는 이유: 전체를 열면 호출자가 쓰지 않은 지시가
   * 설정 파일 모양으로 들어오는 통로가 다시 생긴다.
   */
  readonly skillOverrides?: Readonly<Record<string, "on" | "name-only" | "user-invocable-only" | "off">>;
  /**
   * 세션 설정 `ultracode`. CLI의 `--effort ultracode`가 켜는 것과 같은 자리 — `xhigh` 강도와
   * standing dynamic-workflow orchestration. `Options.effort` 단이 아니라 settings 플래그다.
   *
   * `true`만 연다. `false`를 실으면 사용자·프로젝트 설정의 켠 값을 flag 소스가 덮어 끈다.
   */
  readonly ultracode?: true;
  /**
   * 자식의 `CLAUDE_CONFIG_DIR` 정책. 생략하면 격리다.
   *
   * 정책을 불리언이나 경로 하나로 숨기지 않는 이유: 격리 홈과 공유 홈은 캐시 소유권과 트랜스크립트
   * 위치가 반대이고, 그 반대가 호출부에서 읽혀야 한다. 공유 홈이 무엇을 호스트에게 넘기는지는
   * `ClaudeConfigHome`에 적혀 있다.
   */
  readonly home?:
    | { readonly kind: "isolated" }
    | { readonly kind: "shared"; readonly configDir: string };
  /** 자식이 상속할 기본 환경. 기본값은 이 프로세스의 `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * 한 턴의 요청.
 *
 * 여기 없는 키는 런타임 allowlist가 spawn 전에 거부한다. `agent`, `agents`, `settings`,
 * `managedSettings`, `skills`, `hooks`, `extraArgs`, `env`, `pathToClaudeCodeExecutable`는
 * 타입에도 런타임에도 존재하지 않는다.
 *
 * 가르는 기준은 "지시를 싣느냐"가 아니라 **누가 그것을 골랐느냐, 그리고 언제 바뀌느냐**다.
 * 턴마다 바뀌지 않는 실행 정책 — 어떤 플러그인을 실을지, 어떤 설정 층을 읽을지, 어느 홈을 쓸지 —
 * 은 인스턴스가 소유하므로 `ClaudeGatewaySdkOptions`에서 호출자가 명시적으로 고른다. 위 키들은
 * 턴 단위로 자식의 지시와 능력을 갈아 끼우는 통로여서 열지 않는다. `systemPrompt`는 호출자가
 * 직접 쓴 지시 하나이므로 턴에서도 열려 있다.
 */
export interface ClaudeGatewayTurn {
  readonly prompt: string;
  /** 호출자가 쓴 시스템 지시. 생략하면 아무것도 주입하지 않는다. */
  readonly systemPrompt?: ClaudeGatewaySystemPrompt;
  /** `models`에 실린 게이트웨이 모델 id. */
  readonly model: string;
  readonly effort?: ClaudeGatewayEffort;
  readonly cwd?: string;
  readonly resume?: string;
  /**
   * 자식이 스스로 만드는 대신 호출자가 못박는 세션 id. 유효한 UUID여야 한다.
   *
   * `resume`·`continue`와 함께 쓰려면 `forkSession`이 있어야 한다(실측: 없으면 자식이
   * `--session-id can only be used with --continue or --resume if --fork-session is also
   * specified`로 종료한다). 못박은 id는 실행 성공 여부와 무관하게 확정되므로, 호출자는
   * 첫 턴을 기다리지 않고 그 세션의 좌표를 알 수 있다.
   */
  readonly sessionId?: string;
  /** 재개할 때 이어 쓰지 않고 새 세션 id로 갈라 나간다. `sessionId`와 함께 주면 그 id가 갈래의 id다. */
  readonly forkSession?: boolean;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
  /**
   * 자식이 가질 수 있는 툴 집합의 절대 화이트리스트. 생략하면 vendor 기본값을 쓴다.
   *
   * 이름과 달리 내장 툴만의 목록이 아니다. 실측: 이 필드를 주면 `servedMcpServers`로 붙인 MCP
   * 서버의 툴도 함께 사라지고, MCP 툴 이름을 여기 적어도 되살아나지 않는다 — `[]`를 주면
   * `system/init`의 툴 목록이 0이 되어 자식은 아무것도 부르지 못한다.
   *
   * 값으로 건네는 `mcpServers`(in-process)는 이 억제를 받지 않는다. 그래서 in-process 툴만 쓰는
   * 소비처는 `tools: []`로 내장 툴을 전부 지울 수 있지만, HTTP MCP를 쓰는 소비처는 이 필드를
   * 쓰면 안 되고 `disallowedTools`로 위험한 내장 툴을 문맥에서 빼야 한다.
   */
  readonly tools?: readonly string[];
  readonly allowedTools?: readonly string[];
  /**
   * 문맥에서 아예 제거할 툴 이름. `servedMcpServers`를 쓰는 턴이 능력을 좁히는 유일한 수단이다.
   * `allowedTools`(사전승인)와 겹쳐 쓰면 제거되지 않은 나머지도 호출 시점에 거부된다.
   */
  readonly disallowedTools?: readonly string[];
  readonly permissionMode?: ClaudeGatewayPermissionMode;
  /**
   * 도구 사용 전에 호스트에게 묻는 콜백. 이 키가 allowlist에 있는 이유는 `hooks`와 성격이 다르기
   * 때문이다 — hooks는 그 출력이 `additionalContext`·`appendSystemPrompt`를 실어 호출자가 쓰지
   * 않은 **지시**를 자식에게 주입하는 통로인 반면, 이 콜백은 지시를 싣지 않고 자식이 물은 것에
   * 호스트가 답만 돌려준다. 주면 대화형 도구가 자식의 도구 목록에 실린다.
   */
  readonly canUseTool?: ClaudeGatewayCanUseTool;
  readonly mcpServers?: Readonly<Record<string, ClaudeGatewayMcpServer>>;
  /** 자식이 접속할 HTTP MCP 엔드포인트. 호스트가 이미 서빙 중이어야 한다. */
  readonly servedMcpServers?: readonly ClaudeGatewayServedMcpServer[];
  readonly includePartialMessages?: boolean;
  readonly abortController?: AbortController;
  readonly stderr?: (data: string) => void;
}

/**
 * 세션 하나의 실행 정책. `ClaudeGatewayTurn`에서 `prompt`만 뺀 모양이다.
 *
 * 프롬프트가 빠진 것이 이 타입의 전부다: 세션은 프롬프트 하나가 아니라 **여러 개를 차례로**
 * 받으므로, 무엇을 물을지는 `send()`가 정하고 어떤 자식으로 도는지는 여기서 한 번 정한다.
 */
export type ClaudeGatewaySessionRequest = Omit<ClaudeGatewayTurn, "prompt">;

/** `ClaudeGatewayTurn`이 허용하는 키. 런타임 검증의 단일 출처다. */
export const CLAUDE_GATEWAY_TURN_KEYS: readonly string[] = Object.freeze([
  "prompt",
  "systemPrompt",
  "model",
  "effort",
  "cwd",
  "resume",
  "sessionId",
  "forkSession",
  "maxTurns",
  "maxBudgetUsd",
  "tools",
  "allowedTools",
  "disallowedTools",
  "permissionMode",
  "canUseTool",
  "mcpServers",
  "servedMcpServers",
  "includePartialMessages",
  "abortController",
  "stderr",
]);

/** `ClaudeGatewaySessionRequest`가 허용하는 키. 턴의 allowlist에서 `prompt`만 뺀 것이다. */
export const CLAUDE_GATEWAY_SESSION_KEYS: readonly string[] = Object.freeze(
  CLAUDE_GATEWAY_TURN_KEYS.filter((key) => key !== "prompt"),
);

/** 문맥 창을 나눠 쓰는 한 덩어리. `tokens`는 그 덩어리가 지금 차지한 몫이다. */
export interface ClaudeGatewayContextCategory {
  readonly name: string;
  readonly tokens: number;
  /** 아직 문맥에 실리지 않고 필요할 때 불러오는 몫. 총량에 더해지지 않는다. */
  readonly deferred: boolean;
}

/**
 * 자식이 지금 쓰고 있는 문맥 창의 내역.
 *
 * `total`은 창에 실제로 들어앉은 토큰이고 `max`는 그 창의 크기다. `compactAt`은 자동 압축이
 * 걸리는 지점이며, 켜져 있지 않으면 `null`이다 — 임계가 없는데 임계선을 그리면 오지 않을 사건을
 * 예고하게 된다.
 */
export interface ClaudeGatewayContextUsage {
  readonly total: number;
  readonly max: number;
  readonly model: string;
  readonly compactAt: number | null;
  readonly categories: readonly ClaudeGatewayContextCategory[];
  readonly memoryFiles: readonly { readonly path: string; readonly tokens: number }[];
  readonly mcpTools: readonly { readonly name: string; readonly server: string; readonly tokens: number }[];
}

/**
 * 자식이 `/이름`으로 받아 주는 것 하나. 내장 명령과 스킬이 벤더 쪽에서 같은 레코드로 오므로
 * 여기서도 가르지 않는다 — 무엇을 명령이라 부르고 무엇을 스킬이라 부를지는 이 계약이 아니라
 * 소비처의 분류 규칙이다.
 *
 * `argumentHint`는 인자를 받는다는 사실 자체를 말한다. 빈 문자열은 "힌트가 없다"가 아니라
 * "인자를 받지 않는다"로 읽어도 되는 신호다(벤더가 인자 있는 항목에만 채운다).
 */
export interface ClaudeGatewayCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly aliases: readonly string[];
}

/**
 * 자식이 Task 도구로 부를 수 있는 서브에이전트 하나. `/이름` 문법이 아니라는 점이 명령과
 * 다르다 — 이 레코드를 슬래시 목록에 섞으면 없는 문법을 가르치게 된다.
 */
export interface ClaudeGatewayAgent {
  readonly name: string;
  readonly description: string;
  /** 이 에이전트가 고정으로 쓰는 모델. 부모를 따르면 `null`이다. */
  readonly model: string | null;
}

export interface ClaudeGatewayRun extends AsyncIterable<ClaudeGatewayMessage> {
  /** 진행 중인 턴을 끊는다. 이미 끝난 턴에 호출해도 안전하다. */
  close(): void;
  /**
   * 자식에게 지금 문맥 내역을 묻는다. **살아 있는 턴에만** 답이 온다.
   *
   * 던지지 않고 `null`로 접는 이유는 실패가 예외 상황이 아니기 때문이다(실측): 턴이 끝나 가면
   * 자식이 먼저 닫히므로, 마지막 몇 번의 호출은 정상 경로에서 반드시 실패한다. 호출자가 매번
   * try/catch로 그 정상 실패를 감싸야 한다면 계약이 잘못된 것이다.
   *
   * 스트림 소비를 막고 부르면 안 된다(실측): 이터레이션 루프 안에서 이 응답을 기다리면 세 번째
   * 호출쯤에서 자식이 조기에 닫힌다. 소비와 나란히, 소비를 세우지 않는 자리에서 부른다.
   */
  getContextUsage(): Promise<ClaudeGatewayContextUsage | null>;
}

/**
 * 자식 하나를 **살려 둔 채** 여러 프롬프트를 주고받는 세션.
 *
 * `startTurn`과의 차이는 편의가 아니라 자식의 수명이다. 문자열 프롬프트 하나로 시작한 실행은
 * vendor SDK가 single-turn으로 판정해 첫 `result`에 자식의 stdin을 닫고, 입력이 닫힌 자식은
 * Claude Code의 wind-down 규율에 따라 **백그라운드 셸을 5초 유예 뒤 kill**한다(에이전트·워크플로는
 * 기다려 주지만 셸은 기다려 주지 않는다). 즉 턴마다 실행을 세우는 소비처는 백그라운드 작업을
 * 가질 수 없다 — 그것이 이 인터페이스가 존재하는 이유다.
 *
 * 이터레이터는 세션당 하나이고 `close()`까지 끝나지 않는다. 턴 경계는 스트림이 아니라 `result`
 * 메시지가 말한다 — 백그라운드 작업이 끝나면 자식이 모델을 다시 깨우므로, 한 세션에서 `result`는
 * 보낸 프롬프트 수보다 많을 수 있다.
 */
export interface ClaudeGatewaySession extends AsyncIterable<ClaudeGatewayMessage> {
  /**
   * 자식에게 사용자 메시지 하나를 밀어 넣는다. 반환은 큐 등록이며, 진행은 스트림으로만 온다.
   *
   * 자식이 자기 큐를 갖고 있으므로 턴 중에 보내도 잃지 않는다. 호출자가 턴을 직렬화하고 싶다면
   * 그 규율은 호출자의 것이다 — 이 계약은 순서만 보장한다.
   */
  send(text: string): void;
  /**
   * 도는 턴을 끊는다. 자식은 살아남고 백그라운드 작업도 그대로다 — 프로세스를 죽이는 `close()`와
   * 다른 물건이다.
   */
  interrupt(): Promise<void>;
  /**
   * 백그라운드 작업 하나를 멈춘다. 좌표는 `task_notification`·`task_updated`가 실어 온 `task_id`다.
   * 멈춘 작업은 `stopped` 알림을 낸다.
   */
  stopTask(taskId: string): Promise<void>;
  /**
   * 진행 중인 포그라운드 작업을 백그라운드로 민다 — 터미널의 Ctrl+B와 같은 자리다. `toolUseId`를
   * 주면 그 도구 호출 하나만, 없으면 전부. 반환은 실제로 민 것이 있었는가다.
   */
  backgroundTasks(toolUseId?: string): Promise<boolean>;
  /**
   * 자식이 지금 쓰는 문맥 내역. 턴이 도는 동안에는 자식이 control 채널을 닫아 두므로 `null`이
   * 정상 응답이다(`ClaudeGatewayRun.getContextUsage`와 같은 규율).
   */
  getContextUsage(): Promise<ClaudeGatewayContextUsage | null>;
  /**
   * 자식이 지금 받아 주는 `/이름` 목록. 내장 명령과 스킬이 함께 온다.
   *
   * `null`과 빈 배열은 다른 뜻이다: `null`은 **묻지 못했다**(턴이 도는 동안 자식이 control
   * 채널을 닫아 둔다 — `getContextUsage`와 같은 규율)이고, 빈 배열은 묻고서 하나도 없다는
   * 답이다. 둘을 같게 다루면 "카탈로그가 비었다"와 "카탈로그를 못 읽었다"가 한 화면이 된다.
   */
  supportedCommands(): Promise<readonly ClaudeGatewayCommand[] | null>;
  /** 자식이 Task 도구로 부를 수 있는 서브에이전트 목록. `null` 규율은 위와 같다. */
  supportedAgents(): Promise<readonly ClaudeGatewayAgent[] | null>;
  /** 세션을 접고 자식 프로세스를 끝낸다. 살아 있던 백그라운드 작업도 함께 거둬진다. */
  close(): void;
}

export interface ClaudeGatewaySdk {
  /** 이 인스턴스가 소유한 격리 `CLAUDE_CONFIG_DIR`. 진단용으로만 노출한다. */
  readonly configDir: string;
  /** 이 인스턴스가 실행을 허용하는 모델 id. */
  readonly models: readonly string[];
  /**
   * 한 턴을 시작한다.
   *
   * 비동기인 이유는 spawn 직전에 discovery 캐시를 다시 쓰기 때문이다. Claude Code가 그 캐시에
   * 어떤 신선도 규칙을 두는지는 문서화되어 있지 않으므로, 매 launch마다 다시 쓰는
   * `fleet-admiral`의 측정된 동작을 그대로 따른다.
   */
  startTurn(turn: ClaudeGatewayTurn): Promise<ClaudeGatewayRun>;
  /**
   * 자식 하나를 살려 둔 세션을 연다. 턴 하나로 끝나지 않는 소비처 — 백그라운드 작업을 가지거나,
   * 턴 사이에 자식의 상태를 이어야 하는 곳 — 는 `startTurn`이 아니라 이쪽을 쓴다.
   *
   * 슬롯은 `startTurn`과 공유한다: 한 인스턴스의 config dir을 두 자식이 동시에 쓰면 세션 상태가
   * 서로를 덮으므로, 세션이 열려 있는 동안 이 인스턴스는 다른 실행을 세우지 않는다.
   */
  openSession(request: ClaudeGatewaySessionRequest): Promise<ClaudeGatewaySession>;
  /** 진행 중인 턴·세션을 끊고 격리 디렉터리를 지운다. 두 번 불러도 안전하다. */
  dispose(): Promise<void>;
}
