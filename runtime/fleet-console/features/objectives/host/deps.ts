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
  readonly consoleUse: Pick<ConsoleUseMcpHost, "contribute">;
  readonly registerMcp: (name: string, tools: readonly ConsoleMcpTool[]) => () => void;
  readonly commodoreCommander?: CommodoreFeature["host"]["commander"];
  /** 사람이 AI Gateway에서 켠 모델(정준 id) — 라우팅 대체 좌표가 이 목록 밖이면 띄우지 않는다. null은 읽지 못한 것이다. 없으면(테스트 대역) 확인하지 않는다. */
  readonly enabledModels?: () => ReadonlySet<string> | null;
  readonly experiments?: ExperimentsHost;
}
