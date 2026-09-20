import { createMcpHttpTransport } from "../../core/host/transport/mcp-http.js";
import path from "node:path";
import { createAiGatewayMcpHost } from "../../features/ai-gateway/host/mcp.js";

import {
  DEFAULT_WIRE_LOG_MAX_BYTES,
  createAiGatewayQuotaCollectors,
  createAiGatewaySettingsStore,
  createProviderAuthService,
  createQuotaService,
  resolveAiGatewaySelection,
  setWireLogTarget,
  type AiGatewaySettingsStore,
  type AuthService,
} from "@fleet-console/ai-gateway";
import { createFleetGatewayAgentRuntimeLifecycle, type FleetGatewayAgentRuntimeLifecycle } from "@fleet-console/agent-runtime/fleet";
import { parseGatewayQuotaSnapshot } from "@fleet-console/ai-gateway";
import {
  getFleetDataDir,
  type AgentOptionsService,
} from "@fleet-console/infra";

import { createConsoleDataPaths } from "../../core/host/bootstrap/paths.js";
import { createAgentOptionsService } from "../../features/settings/host/agent-options.js";
import { createConsoleSettingsStore } from "../../features/settings/host/settings-domain.js";

export interface FleetCliRuntime extends FleetGatewayAgentRuntimeLifecycle {
  readonly aiGatewayStore: AiGatewaySettingsStore;
  readonly authService: AuthService;
  readonly dataDir: string;
  readonly infraServices: { readonly agentOptionsService: AgentOptionsService };
}

export interface CreateFleetCliRuntimeOptions {
  /**
   * 이 실행이 쓸 Console 슬롯. 생략하면 Console 서버가 쓰는 것과 같은 규칙으로 푼다 —
   * 같은 설치에서 나온 두 프로세스가 같은 자리를 보아야 `fleet`이 Console에 로그인한
   * 자격증명과 선별을 그대로 읽는다.
   */
  readonly dataDir?: string;
}

export async function createFleetCliRuntime(
  options: CreateFleetCliRuntimeOptions = {},
): Promise<FleetCliRuntime> {
  const consolePaths = createConsoleDataPaths();
  const dataDir = options.dataDir ?? consolePaths.dir;
  const fleetRoot = getFleetDataDir();
  // 설정·자격증명·Agent 옵션은 모두 Console 슬롯에 산다. 옛 자리(Fleet 루트)는 승계 출처로만
  // 넘긴다 — CLI가 먼저 떠서 빈 파일을 만들어 버리면 Console이 승계할 값을 잃는다.
  const legacyDirs = [fleetRoot];
  const authService = createProviderAuthService({ dataDir, legacyDirs });
  const aiGatewayStore = createAiGatewaySettingsStore({ dataDir, legacyDirs });
  const agentOptionsService = createAgentOptionsService({
    store: createConsoleSettingsStore({ paths: consolePaths }),
    legacyDirs,
  });
  const quotaService = createQuotaService({
    platform: process.platform,
    // CLI에는 Console의 연결 토글이 없다 — 프로브가 직접 상태를 판정한다.
    isClaudeConnected: async () => true,
    isCursorConnected: async () => true,
    ...createAiGatewayQuotaCollectors({ authService }),
  });
  const mcpHttp = createMcpHttpTransport();
  const aiGatewayMcp = createAiGatewayMcpHost({ transport: mcpHttp.transport,
    readSelection: () => {
      const selection = resolveAiGatewaySelection(aiGatewayStore.read());
      return {
        // identity와 roster는 delegationModels를, wire·launch picker·validation은 models를 사용한다.
        models: selection.delegationModels,
        effortExposure: selection.effortExposure,
        ...(selection.providerPriority ? { providerPriority: selection.providerPriority } : {}),
      };
    },
    readQuota: async () => {
      try {
        return parseGatewayQuotaSnapshot(await quotaService.getSummary());
      } catch {
        return undefined;
      }
    },
  });

  applyStoredWireLog(aiGatewayStore, dataDir);
  try {
    const agentRuntime = await createFleetGatewayAgentRuntimeLifecycle({
      additionalMcpSessions: [aiGatewayMcp.connect()],
    });
    let cleaned = false;
    return {
      ...agentRuntime,
      aiGatewayStore,
      authService,
      dataDir,
      infraServices: { agentOptionsService },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        setWireLogTarget(undefined);
        try { await agentRuntime.cleanup(); } finally { try { await aiGatewayMcp.dispose(); } finally { await mcpHttp.dispose(); } }
      },
    };
  } catch (error) {
    setWireLogTarget(undefined);
    try { await aiGatewayMcp.dispose(); } finally { await mcpHttp.dispose(); }
    throw error;
  }
}

/** 저장된 wire-log 토글을 프로세스에 적용한다. CLI 런타임과 `fleet gateway serve`가 공유한다. */
export function applyStoredWireLog(store: AiGatewaySettingsStore, dataDir: string): void {
  try {
    applyWireLog(store.read().wireLogEnabled, dataDir);
  } catch {
    // Malformed durable settings must not prevent the CLI from starting;
    // fail closed by overriding any env target until a valid setting is available.
    applyWireLog(false, dataDir);
  }
}

function applyWireLog(stored: boolean | undefined, dataDir: string): void {
  setWireLogTarget(stored === undefined
    ? undefined
    : stored
      ? {
        path: path.join(dataDir, "logs", "fleet-cli-gateway-wire.jsonl"),
        maxBytes: DEFAULT_WIRE_LOG_MAX_BYTES,
      }
      : null);
}
