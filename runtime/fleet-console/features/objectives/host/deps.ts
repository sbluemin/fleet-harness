import type { ConsoleUseMcpHost } from "../../console-use/shared/tools.js";
import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { ServerOriginPort } from "@fleet-console/infra/http/host-ports";
import type { ConsoleControlHost } from "../../console-use/shared/control-port.js";
import type { ObjectiveRecordsHost } from "./records/ports.js";
import type { EventPort } from "@fleet-console/infra/http/host-ports";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import type { ConsoleMcpTool } from "../../console-use/shared/tools.js";
import type { CommodoreFeature } from "../../commodore/host/index.js";

/** 목표가 쓰는 Console 포트. 조합이 소유·호출자·정리 수명을 명시로 묶는다. */
export interface ObjectivesFeatureDeps {
  readonly storage?: import("./storage.js").ObjectiveBoardStorage;
  readonly paths: WorkspacePaths;
  readonly events: EventPort;
  readonly objectiveRecords: ObjectiveRecordsHost;
  readonly consoleControl?: (ConsoleControlHost | undefined);
  readonly server: ServerOriginPort;
  readonly http: HttpPort;
  readonly security: HttpSecurityPort;
  readonly consoleUse: Pick<ConsoleUseMcpHost, "contribute">;
  readonly registerMcp: (name: string, tools: readonly ConsoleMcpTool[]) => () => void;
  readonly commodoreCommander?: CommodoreFeature["host"]["commander"];
}
