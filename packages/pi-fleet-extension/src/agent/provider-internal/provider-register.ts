/**
 * core/acp-provider — Extension 진입점 (wiring only)
 *
 * 역할: Gemini/Codex/Claude 모델군 등록, subagent 중복 방지, 세션 라이프사이클 핸들링.
 * 모델 목록과 이름은 packages/unified-agent/models.json을 단일 소스로 사용한다.
 * 비즈니스 로직은 provider.ts / event-mapper.ts에 위임.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as os from "node:os";
import * as path from "node:path";
import {
  CLI_BACKENDS,
  getModelsRegistry,
  type CliType,
} from "@sbluemin/unified-agent";

import { getLogAPI } from "@sbluemin/fleet-core/services/log";
import {
  buildModelId,
  buildProviderId,
  clearActiveStreamRef,
  getActiveStreamRef,
  resetAcpProviderState,
  setActiveStreamRef,
} from "./state.js";
import { initRuntime, onHostSessionChange } from "./session-runtime.js";
import { streamAcp, cleanupAll, handleSessionStart } from "./provider-stream.js";
import {
  installAcpThinkingLevelPatch,
  reconcileAcpThinkingLevel,
} from "./thinking-level-patch.js";
import { registerProviderGuard } from "./provider-guard.js";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * models.json을 순회하여 pi registerProvider 형식의 모델 목록을 동적 생성.
 * Model.id는 models.json의 display name(name)에 ` (Unified)` postfix를 붙여 등록한다.
 * provider 내부 cli/backendModel 복원은 provider/types의 parseModelId /
 * buildModelId가 담당하며, thinking level UI 보정은 thinking-level-patch.ts가 맡는다.
 */
const PROVIDER_REGISTRATIONS = Object.entries(getModelsRegistry().providers)
  .flatMap(([cliKey, provider]) => {
    const cli = cliKey as CliType;
    const models = buildProviderModels(cli, provider);
    if (models.length === 0) return [];

    return [{ providerId: buildProviderId(cli), models }];
  });

/** Fleet와 동일한 SessionMapStore 영속 경로 */
const FLEET_DATA_DIR = path.join(os.homedir(), ".pi", "fleet");
type ProviderModels = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["models"]>;

// ═══════════════════════════════════════════════════════════════════════════
// Extension Entry Point
// ═══════════════════════════════════════════════════════════════════════════

export default function registerProviderRuntime(pi: ExtensionAPI): void {
  const log = getLogAPI();
  log.registerCategory({ id: "acp", label: "ACP Provider", description: "ACP 프로바이더 일반 로그" });
  log.registerCategory({ id: "acp-system-prompt", label: "ACP System Prompt", description: "시스템 프롬프트 전문 로그" });
  log.registerCategory({ id: "acp-stderr", label: "ACP Stderr", description: "ACP CLI stderr 출력" });

  initRuntime(FLEET_DATA_DIR);
  installAcpThinkingLevelPatch();
  registerProviderGuard(pi);

  // ── 세션 라이프사이클 ──

  pi.on("session_start", (event, ctx) => {
    reconcileAcpThinkingLevel(pi, ctx.model);

    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      const piSessionId = ctx.sessionManager.getSessionId();
      onHostSessionChange(piSessionId);
      handleSessionStart(event.reason, piSessionId).catch((err) => {
        console.error("[fleet-acp] session_start 처리 실패:", err);
      });
    }
  });

  pi.on("session_tree", (_event, ctx) => {
    onHostSessionChange(ctx.sessionManager.getSessionId());
  });

  pi.on("model_select", (event) => {
    reconcileAcpThinkingLevel(pi, event.model);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    cleanupAll()
      .catch((err) => {
        console.error("[fleet-acp] session_shutdown 정리 실패:", err);
      })
      .finally(() => {
        resetAcpProviderState();
        clearActiveStreamRef(streamAcp);
      });
  });

  // ── Provider 등록 (subagent 중복 방지) ──

  if (!getActiveStreamRef()) {
    // 최초 인스턴스: streamSimple 참조 저장 후 등록
    setActiveStreamRef(streamAcp);

    for (const { providerId, models } of PROVIDER_REGISTRATIONS) {
      pi.registerProvider(providerId, {
        baseUrl: providerId,
        apiKey: "not-used",
        api: providerId,
        models,
        streamSimple: streamAcp,
      });
    }
  }
  // 후속 인스턴스(subagent): 부모의 ModelRegistry 등록을 공유하므로 skip
}

function buildProviderModels(
  cli: CliType,
  provider: ReturnType<typeof getModelsRegistry>["providers"][CliType],
): ProviderModels {
  const backend = CLI_BACKENDS[cli];
  if (!backend) return [] as ProviderModels;

  // reasoning boolean은 models.json의 reasoningEffort.supported에서 유도
  const reasoning = provider.reasoningEffort.supported;

  return provider.models.map((m) => ({
    id: buildModelId(cli, m.modelId),
    name: m.name,
    reasoning,
    input: ["text", "image"] as ("text" | "image")[],
    cost: { input: 0, output: 0 },
    maxTokens: backend.defaultMaxTokens,
  })) as unknown as ProviderModels;
}
