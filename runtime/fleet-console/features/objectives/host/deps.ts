import type { HttpSecurityPort } from "@fleet-console/infra/http/host-ports";
import type { HttpPort } from "@fleet-console/infra/http/host-ports";
import type { ServerOriginPort } from "@fleet-console/infra/http/host-ports";
import type { ConsoleControlHost } from "../../execution/shared/control-port.js";
import type { ObjectiveRecordsHost } from "./records/ports.js";
import type { EventPort } from "@fleet-console/infra/http/host-ports";
import type { WorkspacePaths } from "../../workspace/host/path-port.js";
import type { ConsoleMcpTool } from "../../execution/shared/tools.js";
import type { CommodoreFeature } from "../../commodore/host/index.js";
import type { ExperimentsHost } from "../../settings/shared/experiment-ports.js";

/** 목표가 쓰는 Console 포트. 조합이 소유·호출자·정리 수명을 명시로 묶는다. */
export interface ObjectivesFeatureDeps {
  readonly resolveCreation: (commodoreId: string, theaterId: string) => { readonly commodoreId: string; readonly cwd: string };
  /** 그 사령관의 등록 Theater id. 없으면 add는 넘긴 id를 검증하지 않는다(테스트 대역). */
  readonly ownedTheaterIds?: (commodoreId: string) => readonly string[];
  readonly storage?: import("./storage.js").ObjectiveBoardStorage;
  readonly paths: WorkspacePaths;
  readonly events: EventPort;
  readonly objectiveRecords: ObjectiveRecordsHost;
  readonly consoleControl?: (ConsoleControlHost | undefined);
  readonly server: ServerOriginPort;
  readonly http: HttpPort;
  readonly security: HttpSecurityPort;
  readonly registerMcp: (name: string, tools: readonly ConsoleMcpTool[]) => () => void;
  readonly commodoreCommander?: CommodoreFeature["host"]["commander"];
  /** 새 지휘관 생성 시에만 읽고 저장하는 사령관별 정책. */
  readonly commodoreAutoMemoryEnabled?: CommodoreFeature["commanderAutoMemoryEnabled"];
  readonly experiments?: ExperimentsHost;
}
