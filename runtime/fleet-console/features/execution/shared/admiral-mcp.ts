import type { ConsoleMcpTool } from "../../console-use/shared/tools.js";
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


export interface AdmiralMcpRegistration {
  /**
   * 이 서버의 도구가 닿는 곳은 `context.commodoreId` 가 가리키는 사령관 하나뿐이다(인자로 다른 사령관을 고를 수 없다) — 그래서
   * 호스트가 Operation 세션에는 세션 소속 사령관을 싣고, 사령관 세션에는 그 사령관에 묶어 내줄 수 있다(`bindCommodore`).
   * 아니면 생략한다.
   */
  readonly commodoreScoped?: boolean;
}


/** `bindCommodore` 가 내주는 서버 하나 — `tools.custom` 의 그룹으로 그대로 싣는다. 이름은 Operation 세션이 보는 서버 이름(`fleet-{pluginId}`)이다. */
export interface McpServerTools {
  readonly name: string;
  readonly tools: readonly ConsoleMcpTool[];
}


export interface AdmiralMcpHost {
  /**
   * 호출 플러그인의 id로 fleet-{pluginId} 서버를 등록한다. 다른 플러그인의 이름은 지정할 수 없다. 이 서버는 Console Use
   * 토글과 무관하게 모든 Operation 세션에 실린다 — 호출자에 따른 권한은 도구가 `context.caller` 로 스스로 가른다.
   * 화면 제스처는 없다(제스처는 Console Use 도구의 것이다).
   */
  register(tools: readonly ConsoleMcpTool[], options?: AdmiralMcpRegistration): () => void;
  /** 등록 순서와 무관하게 세션을 만들 때 활성 플러그인의 MCP를 연결한다. */
  connect(): AdmiralMcpSession;
  /**
   * `commodoreScoped` 로 등록된 서버들의 도구를 그 사령관에 묶어 돌려준다 — Operation 이 받는 것과 같은 도구·같은 검증이다.
   * `context.commodoreId` 는 이 사령관으로 고정되고 `context.cwd` 는 사령관 디렉터리다. 호출자(`caller`)는 없다.
   * 모르는 사령관이면 빈 목록. 서버가 내려간 뒤의 호출은 오류로 돌아온다. 구버전 호스트에는 없다.
   */
  bindCommodore?(commodoreId: string): readonly McpServerTools[];
}
