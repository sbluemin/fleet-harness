import {
  buildCarrierJobsToolSpec,
  type CarrierRuntime,
  type CarrierToolSpecDeps,
} from "@dotobokuri/fleet-carriers";
import type { AgentToolSpec, McpToolRegistry } from "@dotobokuri/core-agent";

export const FLEET_MCP_SERVER_NAME = "fleet";

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
