import {
  buildCarrierJobsToolSpec,
  type CarrierRuntime,
  type CarrierToolSpecDeps,
} from "@dotobokuri/fleet-carriers";
import type { AgentToolSpec, McpToolRegistry } from "@dotobokuri/core-agent";

import { GATEWAY_MODELS_TOOL_ID } from "./ai-gateway/gateway-models-tool.js";
import type { AdmiralDoctrine } from "./protocols/doctrine.js";

export const FLEET_MCP_SERVER_NAME = "fleet";

// 캐리어 운용 도구. gateway doctrine 호스트 세션에는 노출하지 않는다.
export const CARRIER_OPERATION_TOOL_IDS = new Set<string>([
  "carrier_dispatch",
  "carrier_jobs",
]);

// 게이트웨이 로스터 도구. classic doctrine 세션은 게이트웨이를 거치지 않으므로
// 여기서 얻은 모델 id를 그대로 쓰면 상류가 알지 못하는 이름이 되어 실패한다.
export const GATEWAY_DOCTRINE_TOOL_IDS = new Set<string>([
  GATEWAY_MODELS_TOOL_ID,
]);

/** 해당 doctrine 호스트 세션이 이 도구를 받아야 하는지 판정한다. */
export function isHostSessionToolAllowed(toolId: string, doctrine: AdmiralDoctrine): boolean {
  if (doctrine === "native") {
    // Native는 위키 MCP만 남긴다. 캐리어 운용과 게이트웨이 로스터는 제외한다.
    return toolId.startsWith("wiki_") && !CARRIER_OPERATION_TOOL_IDS.has(toolId) && !GATEWAY_DOCTRINE_TOOL_IDS.has(toolId);
  }
  return doctrine === "gateway"
    ? !CARRIER_OPERATION_TOOL_IDS.has(toolId)
    : !GATEWAY_DOCTRINE_TOOL_IDS.has(toolId);
}

// 모든 캐리어에 글로벌로 노출되는 무조건 읽기 전용 Wiki 도구.
// 이 집합에 없는 Wiki 도구(ingest/drydock/patch_edit/compile_source/query/schema_*/patch_queue)는
// host-only이며 어떤 캐리어에도 executor로 노출되지 않는다.
export const GLOBAL_READONLY_WIKI_TOOL_IDS = new Set<string>([
  "wiki_briefing",
  "wiki_orient",
  "wiki_read",
  "wiki_resolve",
]);

// host-only Wiki 도구 판정: read-only 4종을 제외한 모든 wiki_* 도구.
// 페르소나 metadata(allowedExecutorTools)가 host-only ID를 나열해도 executor로 재부여되지 않도록
// executor 해석 결과에서 강제로 걸러내는 데 쓴다.
export function isHostOnlyWikiTool(toolId: string): boolean {
  return toolId.startsWith("wiki_") && !GLOBAL_READONLY_WIKI_TOOL_IDS.has(toolId);
}

export function registerAgentToolDefaults(
  registry: McpToolRegistry,
  carrierRuntime: CarrierRuntime,
  deps: CarrierToolSpecDeps,
): void {
  // Build carrier_dispatch through the runtime so the tool owns this runtime's
  // dispatch-context registry, admission gate, and in-flight tracker.
  registry.registerAgentTool(carrierRuntime.buildDispatchToolSpec(deps));
  registry.registerAgentTool(buildCarrierJobsToolSpec());
}

export function getExecutorMcpTools(
  registry: McpToolRegistry,
  carrierRuntime: CarrierRuntime,
  carrierId?: string,
): AgentToolSpec[] {
  const metadataIds = carrierId
    ? carrierRuntime.registry.getState().modes.get(carrierId)?.config.carrierMetadata?.allowedExecutorTools ?? []
    : [];
  // getExecutorMcpToolsForScope는 persona metadata에 나열된 ID를 executor 스냅샷에 union한다.
  // host-only Wiki 도구는 metadata를 통한 재부여마저 차단한다.
  // 글로벌 등록 게이트만으로는 metadata union 경로를 막지 못하므로 executor 해석 결과에서 하드 강제한다.
  return registry
    .getExecutorMcpToolsForScope(carrierId, metadataIds)
    .filter((spec) =>
      !isHostOnlyWikiTool(spec.id),
    );
}
