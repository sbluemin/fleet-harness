import type { ClaudeProcessSpawner } from "@fleet-console/agent-runtime/claude";
import type { AgentCliPlugin, LaunchPromptDirectoryAllocator } from "@fleet-console/agent-runtime/fleet";
import type { AgentOptionsService } from "@fleet-console/infra";
import type { ApiCatalogEntry, FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { RouteHandler, UpgradeHandler } from "@fleet-console/sdk/routing";

export type ConsoleRuntimeHost = Pick<FleetPluginHostCapabilities, "consoleUse" | "mcpTransport" | "events" | "server" | "http" | "security" | "lifecycle" | "experiments"> & {
  readonly admiralMcp: Pick<FleetPluginHostCapabilities["admiralMcp"], "connect">;
  readonly computerUseMcp?: { connect(): import("../../computer-use/host/mcp.js").ComputerUseMcpConnection; revokeOperation(operationId: string): void };
  readonly browserMcp?: { connect(): import("../../browser/host/mcp.js").BrowserMcpConnection; revokeOperation(operationId: string): void | Promise<void>; interruptOperation(operationId: string): number; bindTerminalPaste(paste: (operationId: string) => boolean): () => void; endAgentSession(operationId: string): void };
  /** 패널 안 허용 요청(콘솔 사용·컴퓨터 사용). 답하는 라우트와 턴 종료가 쓴다. */
  readonly useRequests?: Pick<import("../../console-use/host/use-requests.js").UseRequestBroker, "answer" | "settle" | "revoke" | "list">;
  readonly operations: Pick<FleetPluginHostCapabilities["operations"], "list" | "get" | "create" | "createChild" | "patch" | "delete" | "deleteChild" | "isTransitioning">;
  readonly paths: Omit<FleetPluginHostCapabilities["paths"], "pluginDataDir">;
  /**
   * 이 요청이 입장한 접속의 수명. 원격 리스너에서는 그 원격 세션이고, 루프백에서는 끝나지 않는다.
   * 판정은 리스너와 세션을 아는 Console이 하고, 실행 기능은 묻기만 한다. 이 능력이 없는 호스트에서는
   * 모든 접속을 끝난 것으로 본다 — 수명을 모르는 채널이 명령을 받아 주지 않게 하기 위해서다.
   */
  readonly requestLifetime?: (req: import("node:http").IncomingMessage) => RequestLifetime;
};

/**
 * 한 요청(업그레이드 포함)이 입장한 접속의 수명. 오래 사는 채널이 메시지마다 "그 접속이 아직
 * 살아 있는가"를 다시 묻는 자리다 — 입장 판정은 소켓을 열 때 한 번뿐이기 때문이다.
 */
export interface RequestLifetime {
  /** 아직 살아 있는가. 유휴 수명을 늘리지 않는다 — 서버가 내려보내는 일은 사람의 활동이 아니다. */
  isLive(): boolean;
  /** 사람의 명령이 왔다. 살아 있으면 유휴 수명을 밀고 true, 끝났으면 false. */
  touch(): boolean;
}

/** Console이 직접 구성하는 실행 기능의 의존성. 플러그인 신원·manifest·로더를 갖지 않는다. */
export interface ConsoleRuntimeContext {
  readonly basePath: string;
  readonly wsBasePath: string;
  readonly dataDir: string;
  readonly recordFailure?: (kind: string, error: unknown) => void;
  readonly legacyDataDir: string;
  /** Agent 실행 옵션. 저장 자리(Console 슬롯)는 부트스트랩이 정해 붙인다. */
  readonly agentOptions: AgentOptionsService;
  /** 기동에 한 번 렌더한 Claude 플러그인 트리. 런치는 이것을 쓰기만 한다. */
  readonly agentCliPlugin: AgentCliPlugin;
  /** launch 프롬프트 파일의 자리. 이 Console의 runtime lock 도메인에 묶여 있고, 회수는 부트스트랩이 lock 뒤에 부른다. */
  readonly launchPromptDirectories?: LaunchPromptDirectoryAllocator;
  /**
   * Spawns every agent CLI this Console's SDK users start (chat, Analyst, the routing model) into a process group this
   * Console owns. Required: an SDK user without it would spawn children the Console's deadline never ends.
   */
  readonly spawnAgentProcess: ClaudeProcessSpawner;
  readonly host: ConsoleRuntimeHost;
  readonly consoleControl?: import("../../console-use/host/console-control.js").ConsoleControl;
  /**
   * 이 Operation의 서브에이전트(Agent 도구) 호출에 돌려줄 거절 사유. null이면 호출을 그대로 둔다.
   * 사유는 등록한 플러그인이 정하고, 실행 기능은 묻고 전달만 한다.
   */
  readonly agentCallRedirect?: (operationId: string) => string | null;
  registerRouter(path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
  registerWsHandler(path: string, handler: UpgradeHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void;
}

export function registerRouter(ctx: ConsoleRuntimeContext, path: string, handler: RouteHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void {
  ctx.registerRouter(path, handler, catalog);
}

export function registerWsHandler(ctx: ConsoleRuntimeContext, path: string, handler: UpgradeHandler, catalog?: ApiCatalogEntry | readonly ApiCatalogEntry[]): void {
  ctx.registerWsHandler(path, handler, catalog);
}
