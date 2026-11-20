import type { MongleActivity, MongleRole, MongleShape, MongleState, QuakerMorph } from "../../workspace/shared/avatars.js";
import type { IdentityTone } from "../../workspace/shared/identity-tones.js";

/**
 * 「더 월드 (The World)」 공유 도메인 계약.
 *
 * 호스트·React UI 계층(`surfaces/*`)과 순수 Three.js 3D 엔진(`engine/*`)이 오직 이 스냅샷과 사건 타입만으로
 * 통신해, 콘솔 채팅 리렌더와 60fps 3D 게임 루프가 서로 결합되지 않게 한다.
 */

export type WorldLifecycleState = "closed" | "diving" | "open" | "escaping";

export type WorldTimeMode = "realtime" | "day" | "sunset" | "night" | "cycle";

export type WorldCameraMode = "follow" | "orbit";

export type WorldDemoPopulateMode = "auto" | "on" | "off";

export type WorldChoreographyKind = "delegate" | "report" | "handoff" | "celebrate";

export interface WorldChoreographyCommand {
  readonly nonce: number;
  readonly kind: WorldChoreographyKind;
  readonly outpostId?: string | undefined;
}

export interface WorldZoneSpec {
  readonly id: string;
  readonly kind: "plaza" | "outpost" | "garden";
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly roofTone: IdentityTone;
  readonly commodoreId?: string | undefined;
  readonly rootObjectiveId?: string | undefined;
  readonly fullWorkshop?: boolean | undefined;
}

export interface WorldMissionItem {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
  readonly active: boolean;
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
  readonly summaryLines: readonly string[];
  readonly isDemo?: boolean | undefined;
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
  readonly actors: readonly WorldActorSpec[];
  readonly activeCount: number;
  readonly totalPopulation: number;
  readonly attentionCount: number;
  readonly usingDemoActors: boolean;
}
