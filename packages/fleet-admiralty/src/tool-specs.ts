import { Type } from "typebox";

export const DEFAULT_PRIORITY = "normal";

export const GRAND_FLEET_DEPLOY_NAME = "grand_fleet_deploy";
export const GRAND_FLEET_DEPLOY_LABEL = "Grand Fleet Deploy";
export const GRAND_FLEET_DEPLOY_DESCRIPTION =
  "Admiral of the Navy (대원수)의 지시에 따라 대상 하위 디렉토리에 Fleet PI를 파견하거나 기존 Fleet을 재사용한다.";
export const GrandFleetDeployParams = Type.Object({
  directory: Type.String({
    minLength: 1,
    description: "함대를 파견할 대상 하위 디렉토리 경로",
  }),
  designation: Type.String({
    minLength: 1,
    description: "함대 표시명. UI와 프롬프트에 노출되는 식별명",
  }),
});

export const GRAND_FLEET_DISPATCH_NAME = "grand_fleet_dispatch";
export const GRAND_FLEET_DISPATCH_LABEL = "Grand Fleet Dispatch";
export const GRAND_FLEET_DISPATCH_DESCRIPTION =
  "Admiral of the Navy (대원수)의 명령을 특정 함대에 작전으로 하달한다.";
export const GrandFleetDispatchParams = Type.Object({
  fleetId: Type.String({
    minLength: 1,
    description: "작전을 하달할 함대 식별자",
  }),
  directive: Type.String({
    minLength: 1,
    description: "함대에 전달할 작전 지시",
  }),
  priority: Type.Optional(Type.String({
    default: DEFAULT_PRIORITY,
    description: "작전 우선순위",
  })),
});

export const GRAND_FLEET_RECALL_NAME = "grand_fleet_recall";
export const GRAND_FLEET_RECALL_LABEL = "Grand Fleet Recall";
export const GRAND_FLEET_RECALL_DESCRIPTION =
  "Admiral of the Navy (대원수)의 철수 명령에 따라 특정 함대를 회수하고 진행 중인 임무를 중단한다.";
export const GrandFleetRecallParams = Type.Object({
  fleetId: Type.String({
    minLength: 1,
    description: "철수시킬 함대 식별자",
  }),
});

export const GRAND_FLEET_BROADCAST_NAME = "grand_fleet_broadcast";
export const GRAND_FLEET_BROADCAST_LABEL = "Grand Fleet Broadcast";
export const GRAND_FLEET_BROADCAST_DESCRIPTION =
  "Admiral of the Navy (대원수)의 공통 명령을 연결된 모든 함대에 동시에 하달한다.";
export const GrandFleetBroadcastParams = Type.Object({
  directive: Type.String({
    minLength: 1,
    description: "전 함대에 전달할 공통 작전 지시",
  }),
  priority: Type.Optional(Type.String({
    default: DEFAULT_PRIORITY,
    description: "작전 우선순위",
  })),
});

export const GRAND_FLEET_STATUS_NAME = "grand_fleet_status";
export const GRAND_FLEET_STATUS_LABEL = "Grand Fleet Status";
export const GRAND_FLEET_STATUS_DESCRIPTION =
  "Admiral of the Navy (대원수)에게 보고할 함대별 상태, carrier 가동 현황, 비용을 조회한다.";
export const GrandFleetStatusParams = Type.Object({
  fleetId: Type.Optional(Type.String({
    minLength: 1,
    description: "특정 함대 식별자. 생략 시 전체 함대 현황을 반환",
  })),
});

export const MISSION_REPORT_NAME = "mission_report";
export const MISSION_REPORT_LABEL = "Mission Report";
export const MISSION_REPORT_DESCRIPTION =
  "작전 보고를 Admiralty에 전송한다. 임무 완료/실패/차단 시 반드시 호출해야 한다.";
export const MissionReportParamsSchema = Type.Object({
  type: Type.String({ enum: ["complete", "failed", "blocked"] }),
  summary: Type.String({ description: "작전 결과 요약" }),
});

export function normalizePriority(priority?: string): string {
  return priority?.trim() || DEFAULT_PRIORITY;
}
