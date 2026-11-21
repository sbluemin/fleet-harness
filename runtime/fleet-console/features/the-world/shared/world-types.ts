import type { MongleActivity, MongleRole, MongleShape, MongleState, QuakerMorph } from "../../workspace/shared/avatars.js";
import type { IdentityTone } from "../../workspace/shared/identity-tones.js";
import type {
  WorldDevelopmentTier,
  WorldDevelopmentTierCode,
  WorldMetricsResponse,
  WorldTheaterMetrics,
  WorldTheaterStatus,
} from "./world-metrics-contract.js";

export type {
  WorldDevelopmentTier,
  WorldDevelopmentTierCode,
  WorldMetricsResponse,
  WorldTheaterMetrics,
  WorldTheaterStatus,
};

/**
 * 「더 월드 (The World)」 공유 도메인 계약.
 *
 * 호스트·React UI 계층(`surfaces/*`)과 순수 Three.js 3D 엔진(`engine/*`)이 오직 이 스냅샷과 사건 타입만으로
 * 통신해, 콘솔 채팅 리렌더와 60fps 3D 게임 루프가 서로 결합되지 않게 한다.
 */

export type WorldLifecycleState = "closed" | "diving" | "open" | "escaping";

export type WorldTimeMode = "realtime" | "day" | "sunset" | "night" | "cycle";

export type WorldCameraMode = "follow" | "orbit";

export type WorldActorPanelMode = "goals" | "info" | "settings";

export type WorldInteractionMode = "closed" | "radial" | "dialogue" | WorldActorPanelMode;

export type WorldChatChannel = "all" | "chat" | "system" | "action";

export type WorldChatFeedKind =
  | "player"
  | "speech"
  | "peer"
  | "system-wake"
  | "system-info"
  | "system-error"
  | "action"
  | "ask";

export interface WorldChatFeedEntry {
  readonly id: string;
  readonly at: number;
  readonly channel: "chat" | "system" | "action";
  readonly kind: WorldChatFeedKind;
  readonly actorId: string;
  readonly actorName: string;
  readonly actorRole: MongleRole;
  readonly actorTone: IdentityTone;
  readonly targetName?: string | undefined;
  readonly badge?: string | undefined;
  readonly text: string;
  readonly detail?: string | undefined;
  readonly streaming?: boolean | undefined;
  readonly failed?: boolean | undefined;
  readonly askId?: string | undefined;
}

export interface WorldActorConversationState {
  readonly entries: readonly WorldChatFeedEntry[];
  readonly loading: boolean;
  readonly working: boolean;
  readonly stepLabel: string | null;
  readonly hasOlder: boolean;
  readonly loadOlder: () => void;
  readonly stopTurn?: (() => Promise<void>) | undefined;
  readonly retryTurn?: (() => Promise<void>) | undefined;
  readonly skipFailed?: (() => Promise<void>) | undefined;
  readonly openAsksCount: number;
}

export type WorldActorEmote = "greet" | "cheer" | "highfive";

export type WorldChoreographyKind = "delegate" | "report" | "handoff" | "celebrate";

export interface WorldChoreographyCommand {
  readonly nonce: number;
  readonly kind: WorldChoreographyKind;
  readonly outpostId?: string | undefined;
}

export interface WorldZoneSpec {
  readonly id: string;
  readonly kind: "plaza" | "outpost" | "garden" | "village";
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly roofTone: IdentityTone;
  readonly commodoreId?: string | undefined;
  readonly rootObjectiveId?: string | undefined;
  readonly fullWorkshop?: boolean | undefined;
  readonly overallTier?: WorldDevelopmentTier | undefined;
  readonly districtCount?: number | undefined;
}

/**
 * 사령관 마을 내부의 개별 Theater 구역(District / Parcel).
 * 보안 불변식: 원시 파일시스템 절대경로(`path`)는 절대 싣지 않는다.
 */
export interface WorldDistrictSpec {
  readonly id: string;
  readonly villageId: string;
  readonly commodoreId: string;
  readonly commodoreName: string;
  readonly theaterId: string;
  readonly label: string;
  readonly status: WorldTheaterStatus;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly rotationY: number;
  readonly tone: IdentityTone;
  readonly fileCount: number;
  readonly dirCount: number;
  readonly totalEntries: number;
  readonly truncated: boolean;
  readonly metricsLoaded: boolean;
  readonly tier: WorldDevelopmentTier;
  readonly tierCode: WorldDevelopmentTierCode;
  readonly progress01: number;
  readonly remainingToNext: number;
  readonly nextTierThreshold: number | null;
  readonly linkedObjectiveIds: readonly string[];
  /** 이 구역(또는 소속 사령관)이 현재 수행 중인 작업 단계(`edit`·`run`·`think` 등). */
  readonly activeWorkStep: string | null;
  readonly needsAttention: boolean;
  readonly hasError: boolean;
}

/** 사령관 마을 분위기(바이옴) 테마. */
export type WorldVillageBiome = "meadow" | "sakura" | "citadel";

/** Theater 구역에 꽂는 제독 작전 깃발. */
export interface WorldDispatchFlag {
  readonly districtId: string;
  readonly label: string;
  readonly createdAt: number;
}

/** 사령관별 마을(Village) — 배정된 Theater 구역들의 집합. */
export interface WorldVillageSpec {
  readonly id: string;
  readonly commodoreId: string;
  readonly label: string;
  readonly tone: IdentityTone;
  readonly biome: WorldVillageBiome;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly gateAngle: number;
  readonly overallTier: WorldDevelopmentTier;
  readonly overallTierCode: WorldDevelopmentTierCode;
  readonly maxDistrictTier: WorldDevelopmentTier;
  readonly totalFiles: number;
  readonly totalDirs: number;
  readonly totalEntries: number;
  /** 활성 등록 루틴 수 (1 이상이면 마을에 회전 루틴 풍차 배치). */
  readonly routineCount: number;
  /** 완료된 목표 수 (1 이상이면 마을 입구에 황금 업적 기념비 배치). */
  readonly completedObjectiveCount: number;
  /** 현재 진행 중 목표 수. */
  readonly activeObjectiveCount: number;
  /** 사령관 실시간 작업 단계(`edit`·`run`·`think`·`delegate` 등). 대기 시 null. */
  readonly workStep: string | null;
  readonly needsAttention: boolean;
  readonly hasError: boolean;
  readonly openAsksCount: number;
  readonly districts: readonly WorldDistrictSpec[];
}

export interface WorldMissionItem {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
  readonly active: boolean;
}

/** 중앙 길드 광장 북동쪽(가로등 옆, 풍차 비충돌) 3D 퀘스트 게시판 좌표 및 피킹 반경. */
export const WORLD_NOTICE_BOARD_POS = {
  x: 4.8,
  z: -3.4,
  radius: 1.8,
} as const;

export interface WorldQuestAskSummary {
  readonly id: string;
  readonly askId: string;
  readonly commodoreId: string;
  readonly commodoreActorId: string;
  readonly commodoreName: string;
  readonly commodoreTone: IdentityTone;
  readonly reason: string;
  readonly firstQuestion: string;
  readonly questionCount: number;
  readonly at: number;
  readonly objectiveId: string | null;
}

export interface WorldQuestApprovalSummary {
  readonly id: string;
  readonly type: string;
  readonly createdAt: number;
  readonly expiresAt?: number | undefined;
}

export interface WorldQuestMissionSummary {
  readonly id: string;
  readonly objectiveId: string | null;
  readonly title: string;
  readonly commodoreId: string | null;
  readonly commodoreActorId: string | null;
  readonly commodoreName: string;
  readonly commodoreTone: IdentityTone;
  readonly status: "review" | "active" | "completed";
  readonly progressDone: number;
  readonly progressTotal: number;
  readonly personWaiting: boolean;
  readonly activityAt: number;
  readonly doneAt: number | null;
}

export interface WorldQuestBoardData {
  readonly asks: readonly WorldQuestAskSummary[];
  readonly pendingApprovalsCount: number;
  readonly pendingApprovals: readonly WorldQuestApprovalSummary[];
  readonly reviewMissions: readonly WorldQuestMissionSummary[];
  readonly activeMissions: readonly WorldQuestMissionSummary[];
  readonly completedMissions: readonly WorldQuestMissionSummary[];
  readonly totalUrgentCount: number;
}

export interface WorldActorSpec {
  readonly id: string;
  readonly role: MongleRole;
  readonly name: string;
  readonly subtitle: string;
  readonly zoneId: string;
  readonly homeX: number;
  readonly homeZ: number;
  readonly baseId: number;
  readonly shape: MongleShape;
  readonly tone: IdentityTone;
  readonly quaker: QuakerMorph | null;
  readonly state: MongleState;
  readonly activity: MongleActivity | null;
  readonly needsAttention: boolean;
  readonly initialSpeech?: string | undefined;
  readonly commodoreId?: string | undefined;
  readonly objectiveId?: string | undefined;
  readonly rootObjectiveId?: string | undefined;
  readonly missions?: readonly WorldMissionItem[] | undefined;
  readonly modelLabel?: string | undefined;
  readonly theaterLabels?: readonly string[] | undefined;
  readonly askCount?: number | undefined;
  readonly summaryLines: readonly string[];
}

export interface WorldScreenLabel {
  readonly actorId: string;
  readonly name: string;
  readonly role: MongleRole;
  readonly tone: IdentityTone;
  readonly quaker: QuakerMorph | null;
  readonly x: number;
  readonly y: number;
  readonly hitX: number;
  readonly hitY: number;
  readonly hitRadius: number;
  readonly distance: number;
  readonly speech: string;
  readonly isNearPlayer: boolean;
  readonly isSelected: boolean;
  readonly needsAttention: boolean;
}

export interface WorldPlayerScreenLabel {
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

export interface WorldSnapshot {
  readonly zones: readonly WorldZoneSpec[];
  readonly villages: readonly WorldVillageSpec[];
  readonly actors: readonly WorldActorSpec[];
  readonly activeCount: number;
  readonly totalPopulation: number;
  readonly attentionCount: number;
}
