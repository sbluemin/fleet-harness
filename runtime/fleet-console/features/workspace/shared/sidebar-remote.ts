import type { TaskforceSummary } from "../../commodore/shared/contracts/taskforce.js";
import type { Objective } from "../../objectives/shared/types.js";
import type { MongleActivity, MongleLook, MongleState } from "./avatars.js";
export interface SidebarRemoteGroup {
  readonly id: string;
  readonly commodoreId: string;
  readonly theaterId: string;
  readonly name: string;
  readonly color: string;
  readonly order: number;
  readonly createdAt: number;
}
export interface SidebarSort {
  readonly key: "activity" | "progress" | "remaining" | "due" | "created" | "name" | "manual";
  readonly direction: "asc" | "desc";
  readonly answerFirst: boolean;
  readonly grouped: boolean;
}

/** 표시 전용 투영. provider/session 좌표, transcript, 절대 파일 경로는 이 모양에 없다. */
export interface SidebarRemoteFace {
  readonly state: MongleState;
  readonly activity: MongleActivity | null;
  readonly look: MongleLook | null;
}
export interface SidebarMotion extends Omit<SidebarRemoteFace, "look"> {
  readonly revision: number;
  readonly at: number;
  readonly kind: "commodore" | "objective";
  readonly id: string;
  readonly live: boolean;
}
export interface SidebarRemoteCommodore extends SidebarRemoteFace {
  readonly taskforce?: TaskforceSummary;
  readonly id: string;
  readonly name: string;
  readonly preview: string;
  readonly live: boolean;
  readonly decisions: number;
  readonly browsing: boolean;
}
export interface SidebarRemoteObjective {
  readonly ownWorking: boolean;
  readonly computerUseEnabled: boolean;
  readonly objective: Objective;
  readonly faces: Readonly<Record<string, SidebarRemoteFace>>;
  readonly tool: { readonly tool: "browser" | "computer"; readonly actor: string | null } | null;
}
export interface SidebarRemotePage {
  readonly v: 1;
  readonly at: number;
  readonly writable: boolean;
  readonly autonomous: boolean;
  readonly taskforceEnabled: boolean;
  readonly computerUseAvailable: boolean;
  readonly next: number | null;
  readonly commodores: readonly SidebarRemoteCommodore[];
  readonly objectives: readonly SidebarRemoteObjective[];
  readonly groups: readonly SidebarRemoteGroup[];
  readonly preferences: { readonly sort: SidebarSort; readonly folds: Readonly<Record<"fresh" | "done" | "settled", boolean>>; readonly keepExpanded: boolean; readonly showSettled: boolean };
}
