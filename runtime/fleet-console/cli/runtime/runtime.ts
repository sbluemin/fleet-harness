import path from "node:path";

import {
  DEFAULT_WIRE_LOG_MAX_BYTES,
  createAiGatewayQuotaCollectors,
  createAiGatewaySettingsStore,
  createQuotaService,
  resolveAiGatewaySelection,
  setWireLogTarget,
  type AiGatewaySettingsStore,
} from "@dotobokuri/core-ai-gateway";
import {
  buildGatewayModelsToolSpec,
  createFleetGatewayAgentRuntimeLifecycle,
  parseGatewayQuotaSnapshot,
  type FleetGatewayAgentRuntimeLifecycle,
} from "@dotobokuri/fleet-admiral";
import {
  createInfraServices,
  ensureWorkspaceDirectory,
  getFleetDataDir,
  withDirectoryLock,
  type InfraServices,
} from "@dotobokuri/core-infra";
import { createWikiWorkspaceResolver, getWikiToolSpecs } from "@dotobokuri/fleet-wiki";

export interface FleetCliRuntime extends FleetGatewayAgentRuntimeLifecycle {
  readonly aiGatewayStore: AiGatewaySettingsStore;
  readonly dataDir: string;
  readonly infraServices: InfraServices;
}

export interface CreateFleetCliRuntimeOptions {
  readonly dataDir?: string;
}

export async function createFleetCliRuntime(
  options: CreateFleetCliRuntimeOptions = {},
): Promise<FleetCliRuntime> {
  const dataDir = options.dataDir ?? getFleetDataDir();
  const infraServices = createInfraServices();
  const aiGatewayStore = createAiGatewaySettingsStore({ dataDir });
  const quotaService = createQuotaService({
    platform: process.platform,
    // CLI에는 Console의 연결 토글이 없다 — 프로브가 직접 상태를 판정한다.
    isClaudeConnected: async () => true,
    isCursorConnected: async () => true,
    ...createAiGatewayQuotaCollectors({ authService: infraServices.authService }),
  });
  const wikiWorkspaceResolver = createWikiWorkspaceResolver({
    ensureWorkspace: (cwd) => ensureWorkspaceDirectory(dataDir, cwd),
    withMigrationLock: (workspace, operation) => withDirectoryLock(
      { lockDir: path.join(workspace.path, "knowledge.migration.lock") },
      operation,
    ),
  });
  const gatewayModelsSpec = buildGatewayModelsToolSpec({
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
      wikiToolSpecs: getWikiToolSpecs(wikiWorkspaceResolver),
      extraAgentTools: [gatewayModelsSpec],
    });
    let cleaned = false;
    return {
      ...agentRuntime,
      aiGatewayStore,
      dataDir,
      infraServices,
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        setWireLogTarget(undefined);
        await agentRuntime.cleanup();
      },
    };
  } catch (error) {
    setWireLogTarget(undefined);
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
