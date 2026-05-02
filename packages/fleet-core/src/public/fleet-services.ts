import * as AdmiralProtocolFacade from "../admiral/index.js";
import * as CarrierServiceFacade from "../admiral/carrier/index.js";
import * as SquadronServiceFacade from "../admiral/squadron/index.js";
import * as TaskForceServiceFacade from "../admiral/taskforce/index.js";
import { buildCarrierJobsToolSpec } from "../admiral/carrier-jobs/tool-spec.js";
import { buildSortieToolSpec } from "../admiral/carrier/tool-spec.js";
import { buildSquadronToolSpec } from "../admiral/squadron/tool-spec.js";
import { buildTaskForceToolSpec } from "../admiral/taskforce/tool-spec.js";
import {
  clearPendingForSession,
  hasPendingToolCall,
  resolveNextToolCall,
  setOnToolCallArrived,
  startMcpServer,
  stopMcpServer,
  type McpCallToolResult,
  type ToolCallArrivedCallback,
} from "../admiral/_shared/mcp.js";
import {
  clearAllTools,
  computeToolHash,
  convertToolSchema,
  getToolNamesForSession,
  getToolsForSession,
  registerToolsForSession,
  removeToolsForSession,
  type RegisteredTool,
  type Tool,
} from "../services/tool-registry/tool-snapshot.js";
import { createAuthService } from "../services/auth/index.js";
import type { AuthService } from "../services/auth/index.js";
import type { AgentToolSpec } from "../services/tool-registry/types.js";

export type { McpCallToolResult, ToolCallArrivedCallback };
export type { RegisteredTool, Tool };

export interface FleetServicesPorts {
}

export interface FleetServices {
  readonly protocols: typeof AdmiralProtocolFacade;
  readonly carrier: typeof CarrierServiceFacade;
  readonly squadron: typeof SquadronServiceFacade;
  readonly taskForce: typeof TaskForceServiceFacade;
  readonly auth: AuthService;
  readonly tools: readonly AgentToolSpec[];
  readonly mcp: {
    url(): Promise<string>;
    setOnToolCallArrived(token: string, cb: ToolCallArrivedCallback | null): void;
    resolveNextToolCall(token: string, toolCallId: string, result: McpCallToolResult): void;
    hasPendingToolCall(token: string): boolean;
    clearPendingForSession(token: string): void;
    registerTools(sessionToken: string, tools: readonly Tool[]): void;
    getTools(sessionToken: string): readonly RegisteredTool[];
    getToolNames(sessionToken: string): Set<string>;
    removeTools(sessionToken: string): void;
    clearAllTools(): void;
    computeToolHash(tools: readonly Tool[]): string;
    convertToolSchema(schema: unknown): unknown;
  };
}

let cachedMcpUrlPromise: Promise<string> | null = null;

export function createFleetServices(_ports?: FleetServicesPorts): FleetServices {
  const auth = createAuthService();

  return {
    protocols: AdmiralProtocolFacade,
    carrier: CarrierServiceFacade,
    squadron: SquadronServiceFacade,
    taskForce: TaskForceServiceFacade,
    auth,
      // carrier 등록은 runtime 초기화 이후에 일어나므로 매 접근마다 lazy로 재계산해야
      // sortie/squadron/taskforce ToolSpec이 정상 노출됨.
    get tools(): readonly AgentToolSpec[] {
      return buildFleetToolSpecs();
    },
    mcp: {
      url: getFleetMcpUrl,
      setOnToolCallArrived,
      resolveNextToolCall,
      hasPendingToolCall,
      clearPendingForSession,
      registerTools: registerMcpTools,
      getTools: getToolsForSession,
      getToolNames: getToolNamesForSession,
      removeTools: removeToolsForSession,
      clearAllTools,
      computeToolHash: computeMcpToolHash,
      convertToolSchema,
    },
  };
}

export async function shutdownFleetMcp(): Promise<void> {
  cachedMcpUrlPromise = null;
  await stopMcpServer();
}

function getFleetMcpUrl(): Promise<string> {
  cachedMcpUrlPromise ??= startMcpServer();
  return cachedMcpUrlPromise;
}

function registerMcpTools(sessionToken: string, tools: readonly Tool[]): void {
  registerToolsForSession(sessionToken, [...tools]);
}

function computeMcpToolHash(tools: readonly Tool[]): string {
  return computeToolHash([...tools]);
}

function buildFleetToolSpecs(): readonly AgentToolSpec[] {
  const specs: AgentToolSpec[] = [];
  const sortie = buildSortieToolSpec();
  const squadron = buildSquadronToolSpec();
  const taskForce = buildTaskForceToolSpec();

  if (sortie) specs.push(sortie);
  if (squadron) specs.push(squadron);
  if (taskForce) specs.push(taskForce);
  specs.push(buildCarrierJobsToolSpec());

  return specs;
}
