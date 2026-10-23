import type { FleetPluginHostCapabilities } from "@fleet-console/sdk/plugin";
import type { PluginMcpTool } from "@fleet-console/sdk/mcp";
import type { CommodoreFeature } from "../../commodore/host/index.js";

/** 목표가 쓰는 Console 포트. 조합이 소유·호출자·정리 수명을 명시로 묶는다. */
export interface ObjectivesFeatureDeps {
  readonly paths: FleetPluginHostCapabilities["paths"];
  readonly events: FleetPluginHostCapabilities["events"];
  readonly operations: FleetPluginHostCapabilities["operations"];
  readonly consoleControl?: FleetPluginHostCapabilities["consoleControl"];
  readonly server: FleetPluginHostCapabilities["server"];
  readonly http: FleetPluginHostCapabilities["http"];
  readonly security: FleetPluginHostCapabilities["security"];
  readonly consoleUse: Pick<FleetPluginHostCapabilities["consoleUse"], "contribute">;
  readonly registerMcp: (name: string, tools: readonly PluginMcpTool[]) => () => void;
  readonly commodoreCommander?: CommodoreFeature["host"]["commander"];
}
