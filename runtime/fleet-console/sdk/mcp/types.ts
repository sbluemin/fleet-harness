import type http from "node:http";
import type { ConsoleCaller } from "./control.js";
import type { ConsoleActionSchema } from "./actions.js";

export interface PluginMcpTransport {
  mount(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): { url(): Promise<string>; dispose(): void };
}

export const FLEET_CONSOLE_USE_MCP_SERVER = "fleet-console-use";

/** 검증기의 원문·메시지가 아닌 필드·코드·상한만 받는 구조적 계약. */
interface ArgumentIssue {
  readonly path: readonly PropertyKey[];
  readonly code: string;
  readonly maximum?: number | bigint;
  readonly errors?: readonly (readonly ArgumentIssue[])[];
}

/** 입력 원문 없이 거부된 필드와 한도를 돌려준다. union 안쪽의 한도도 보존한다. */
export function inputIssues(issues: readonly ArgumentIssue[]): { path: readonly PropertyKey[]; code: string; maximum?: number | bigint }[] {
  return issues.flatMap((issue) => issue.code === "invalid_union" && issue.errors ? issue.errors.flatMap(inputIssues) : [{ path: issue.path, code: issue.code, ...(issue.code === "too_big" ? { maximum: issue.maximum } : {}) }]);
}

export type { ConsoleCaller, ConsoleActionInput, ConsoleActionKind, ConsoleActionResult, ConsoleActivity, ConsoleAutomation, ConsoleAutomationInput, ConsoleControlState, ConsoleCoordinates, ConsoleCoordinatesFailureCause, ConsoleCoordinatesResult, ConsoleOperationObservation, ConsoleTranscriptPage, ConsoleTurnFailure, ConsoleTurnEnd } from "./control.js";

/**
 * Console Use 호스트 코어 도구. 이름은 `console_<화면>[_<하위 화면>]` — 사이드바, Quick Launch(launcher),
 * Operation 패널과 그 분석가. 화면 하나의 여러 동사는 도구 하나의 `action` 이다(`./actions` 의 `defineConsoleTool`).
 * 읽기 전용 연결은 도구 목록이 아니라 action 필터다 — `allowControl` 이 없는 연결에는 read action 만 실린다.
 * 호출 하나는 사용자 화면 위의 제스처 하나이며, 호스트가 `console-use:call` 사건으로 알린다.
 */
export const CONSOLE_USE_TOOLS = ["console_context", "console_sidebar", "console_launcher", "console_operation", "console_operation_analyst"] as const;
export type ConsoleUseToolId = (typeof CONSOLE_USE_TOOLS)[number];

/** 어느 화면 자리에 제스처가 닿는가. 내용(전사·diff·파일 본문)은 싣지 않는다 — 원격 세션도 받는 채널이다. */
export type ConsoleUseCallTarget =
  | { readonly kind: "theater"; readonly theaterId: string }
  | { readonly kind: "operation"; readonly operationId: string }
  | { readonly kind: "group"; readonly groupId: string; readonly theaterId: string }
  | { readonly kind: "panel"; readonly panelId: string; readonly theaterId: string; readonly view?: string; readonly path?: string }
  /** 플러그인이 `operationClusters` 로 낸 사이드바 묶음 줄 하나. 도구는 자기 묶음 id(Objectives 는 목표 id)를 주고, 호스트가 `<pluginId>:` 를 붙여 낸다. */
  | { readonly kind: "cluster"; readonly clusterId: string; readonly theaterId: string }
  /**
   * 한 Theater(또는 그 그룹 하나)의 묶음 줄 목록 — 목록 읽기처럼 줄 하나로 좁혀지지 않는 호출. 줄들이 모인 머리가 감싸인다.
   * 묶음 자리의 theaterId 를 비워 두면 호스트가 호출자 Operation 의 Theater 로 채운다.
   */
  | { readonly kind: "clusters"; readonly theaterId: string; readonly groupId?: string };

export interface ConsoleUseCallEvent {
  readonly caller: ConsoleCaller;
  readonly tool: string;
  /** 사람이 읽는 한 줄 — 대상 표식의 툴팁·말풍선에 그대로 나간다. 경로는 Theater 상대, 식별자는 제목으로. */
  readonly summary: string;
  readonly gesture: "gaze" | "input" | "press" | "create" | "wait";
  readonly target?: ConsoleUseCallTarget;
  /** 기여 도구가 선언한 레일 패널 — 대상이 패널이 아니어도 그 레일 아이콘이 함께 감싸인다. */
  readonly panelId?: string;
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
   * Console Use 기여 도구의 action 선언 — `defineConsoleTool(...).plugin(...)` 이 채운다. 호스트는 이것으로 연결마다
   * 설명·inputSchema 를 거르고(읽기 전용 연결은 read action 만, 호출자 종류별 허용 action 만) 호출을 action별 strict 로
   * 검증한다. 기여(`contribute`)에는 필수이고, `fleet-{pluginId}` 서버 도구에는 쓰지 않는다.
   */
  readonly actionSchema?: ConsoleActionSchema;
  /**
   * Console Use 기여 도구의 화면 자리. 호스트는 호출마다 그 Activity Rail 패널 버튼을 감싸는 표식을
   * 그린다 — 자리를 선언하지 않은 도구는 Console Use 에 실리지 않는다. `describe` 는 인자에서 표식 이름표
   * 한 줄과 보기(view)·경로를 뽑는다; 경로는 Theater 상대여야 한다.
   */
  readonly surface?: {
    readonly panelId: string;
    /**
     * 인자에서 표식 한 줄과 자리를 뽑는다. 기본은 레일 패널을 8초 감싸는 시선(gaze)이다. 자기 제품 상태를 쓰는
     * 도구는 `gesture` 로 create·press·input 을, `target` 으로 Operation·그룹·묶음 줄 자리를 대신 말할 수 있다 —
     * 그래야 사람이 본 Console 에서 "무엇이 바뀌었는지" 가 그 자리에 보인다. 레일 패널 버튼은 그때도 함께 감싸인다.
     */
    describe(args: Record<string, unknown>): {
      readonly theaterId: string;
      readonly summary: string;
      readonly view?: string;
      readonly path?: string;
      readonly gesture?: ConsoleUseCallEvent["gesture"];
      readonly target?: ConsoleUseCallTarget;
    } | null;
  };
  execute(args: unknown, context: {
    readonly cwd: string;
    readonly sessionLabel?: string;
    readonly toolCallId?: string;
    readonly signal?: AbortSignal;
    /**
     * 이 호출을 한 호출자 — 계보·권한을 가르는 도구가 읽는다. Console Use 기여 도구는 호출자 Operation 또는 플러그인,
     * 플러그인 MCP(`fleet-{pluginId}`) 도구는 세션이 묶인 Operation 이다. 풀리지 않으면 비어 있다(fail-closed).
     */
    readonly caller?: ConsoleCaller;
  }): Promise<unknown>;
}

export interface PluginAdmiralMcpHost {
  /**
   * 호출 플러그인의 id로 fleet-{pluginId} 서버를 등록한다. 다른 플러그인의 이름은 지정할 수 없다. 이 서버는 Console Use
   * 토글과 무관하게 모든 Operation 세션에 실린다 — 호출자에 따른 권한은 도구가 `context.caller` 로 스스로 가른다.
   * 화면 제스처는 없다(제스처는 Console Use 도구의 것이다).
   */
  register(tools: readonly PluginMcpTool[]): () => void;
  /** 등록 순서와 무관하게 세션을 만들 때 활성 플러그인의 MCP를 연결한다. */
  connect(): AdmiralMcpSession;
}

export interface ConsoleUseMcpHost {
  /**
   * 플러그인이 자기 영역의 도구를 `fleet-console-use`에 싣는다. 이름은 `console_<화면>[_<하위 화면>]`
   * (`^console_[a-z]+(_[a-z]+)?$`)이고, `defineConsoleTool` 로 만든 action 판별 도구(`actionSchema`)여야 하며,
   * 호스트 기본 도구·이미 기여된 이름과 겹칠 수 없다 — 어긋나면 등록 자체가 실패한다. 기여한 도구는 모든 Console Use 연결에 실리며 호스트 기본 도구와
   * **같은 게이트**(호출자 Operation의 콘솔 사용 토글, 또는 부관 grant)를 지난다 — 플러그인이 자기
   * 게이트를 따로 두지 않는다. 파일시스템·git 쓰기(커밋·파일 변경)는 여기로 열지 않는다: 그것은 그
   * Theater의 Operation에 시키는 일이다. 플러그인 **자기 제품 상태**의 쓰기(목표 추가·완료 같은)는
   * `surface.describe` 로 제스처·자리를 선언하고 저자 귀속·되돌리기를 갖출 때 허용된다 — 조용한 API
   * 쓰기는 Console Use 가 아니다. 반환값은 등록 해제다.
   */
  contribute?(tools: readonly PluginMcpTool[]): () => void;
  /** 도구 등록 API가 아니다. 호스트 기본 도구 중 이 연결에 필요한 것만 요청한다(생략하면 전부). */
  connect(options: {
    readonly tools?: readonly ConsoleUseToolId[];
    readonly snapshot?: () => ConsoleUseSnapshot | null;
    readonly enabled?: () => boolean;
    /**
     * write action 은 명시적으로 요청하며 호스트가 호출자와 Operation 토글·부관 grant를 검증한다. 없으면 이 연결의
     * 도구 설명·inputSchema 에는 read action 만 실리고, write action 호출은 `permission_required` 로 거절된다.
     */
    readonly allowControl?: boolean;
    /**
     * 이 연결의 호출자는 Operation이다. 호출마다 호출자 Operation을 풀어 그 Operation의
     * 콘솔 사용 토글을 확인하고, 읽기를 포함한 모든 도구를 거부할 수 있다.
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
