import { sidebarDisplayJson } from "../../../protocol/desktop/console-section.js";
import type { Objective } from "../../objectives/shared/types.js";
import { mongleStateOf, objectiveRecordAvatarKey, type AvatarBook } from "../shared/avatars.js";
import type { SidebarSort, SidebarRemoteCommodore, SidebarRemoteFace, SidebarRemotePage } from "../shared/sidebar-remote.js";

export function parseSidebarPreferences(value: unknown): { commanderSort?: SidebarSort; commanderFolds?: SidebarRemotePage["preferences"]["folds"]; commanderKeepExpanded?: boolean; commanderShowSettled?: boolean } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !["commanderSort", "commanderFolds", "commanderKeepExpanded", "commanderShowSettled"].includes(key))) return null;
  for (const key of ["commanderKeepExpanded", "commanderShowSettled"]) if (data[key] !== undefined && typeof data[key] !== "boolean") return null;
  if (data.commanderSort !== undefined) {
    const sort = data.commanderSort as Partial<SidebarSort> | null;
    if (!sort || typeof sort !== "object" || Array.isArray(sort) || Object.keys(sort).some((key) => !["key", "direction", "answerFirst", "grouped"].includes(key))
      || !["activity", "progress", "remaining", "due", "created", "name", "manual"].includes(sort.key ?? "")
      || !["asc", "desc"].includes(sort.direction ?? "") || typeof sort.answerFirst !== "boolean" || typeof sort.grouped !== "boolean") return null;
  }
  if (data.commanderFolds !== undefined) {
    const folds = data.commanderFolds as Partial<SidebarRemotePage["preferences"]["folds"]> | null;
    if (!folds || typeof folds !== "object" || Array.isArray(folds) || Object.keys(folds).some((key) => !["fresh", "done", "settled"].includes(key))
      || typeof folds.fresh !== "boolean" || typeof folds.done !== "boolean" || typeof folds.settled !== "boolean") return null;
  }
  return { ...(data.commanderSort !== undefined ? { commanderSort: data.commanderSort as SidebarSort } : {}),
    ...(data.commanderFolds !== undefined ? { commanderFolds: data.commanderFolds as SidebarRemotePage["preferences"]["folds"] } : {}),
    ...(typeof data.commanderKeepExpanded === "boolean" ? { commanderKeepExpanded: data.commanderKeepExpanded } : {}),
    ...(typeof data.commanderShowSettled === "boolean" ? { commanderShowSettled: data.commanderShowSettled } : {}) };
}

/** 페이지마다 표시 facts만 보낸다. session/provider 좌표는 상태 읽기와도 분리한다. */
export function sidebarSafeObjective(objective: Objective): Objective {
  return JSON.parse(sidebarDisplayJson(JSON.stringify(objective))) as Objective;
}

export function sidebarRemotePage(input: {
  readonly at: number;
  readonly offset: number;
  readonly writable: boolean;
  readonly autonomous: boolean;
  readonly taskforceEnabled: boolean;
  readonly computerUseAvailable: boolean;
  readonly computerUseEnabledOf: (id: string) => boolean;
  readonly ownWorkingOf: (id: string) => boolean;
  readonly commodoreId: string | null;
  readonly commodores: readonly SidebarRemoteCommodore[];
  readonly objectives: readonly Objective[];
  readonly groups: SidebarRemotePage["groups"];
  readonly preferences: SidebarRemotePage["preferences"];
  readonly avatars: AvatarBook;
  readonly faceOf: (id: string) => Omit<SidebarRemoteFace, "look">;
  readonly toolOf: (ids: readonly string[]) => { readonly tool: "browser" | "computer"; readonly actor: string | null } | null;
  readonly personWaiting: (objective: Objective) => boolean;
}): SidebarRemotePage {
  const source = input.commodoreId ? input.objectives.filter((objective) => objective.commodoreId === input.commodoreId && !objective.archived && !objective.removed) : input.commodores;
  const page = source.slice(input.offset, input.offset + 20);
  const objectives = input.commodoreId ? (page as readonly Objective[]).map((objective) => {
    const faces: Record<string, SidebarRemoteFace> = {};
    const ids = [objective.id, ...objective.members.map((member) => member.id)];
    for (const id of ids) {
      const face = input.faceOf(id);
      const missions = objective.missions.filter((mission) => mission.member === id || mission.objectiveId === id);
      const state = id !== objective.id && face.state === "idle" && missions.length > 0 && missions.every((mission) => mission.done) ? "done" : face.state;
      faces[id] = { ...face, state, look: input.avatars[objectiveRecordAvatarKey(id)] ?? null };
    }
    const root = faces[objective.id]!;
    const memberWorking = objective.members.some((member) => faces[member.id]?.state === "running");
    const memberWaiting = objective.members.some((member) => faces[member.id]?.state === "awaiting");
    const rootActivity = root.activity ?? (root.state === "idle" && memberWorking ? "background" : null);
    faces[objective.id] = { ...root, activity: rootActivity, state: mongleStateOf({ session: objective.hasSession === true || objective.done !== null || objective.awaitingReview || input.personWaiting(objective), awaitingReview: objective.awaitingReview,
      personTurn: input.personWaiting(objective), workDone: objective.done !== null,
      activity: root.state === "running" || (root.state === "idle" && memberWorking) ? "running" : root.state === "awaiting" || (root.state === "idle" && memberWaiting) ? "awaiting" : root.state === "ended" ? "ended" : "idle" }) };
    // 이미 사람 HTTP가 쓰는 보드 DTO에서 세션 좌표까지 빼고 내린다. 원격에서 렌더링할 때 다시 채우지 않는다.
    const safe = sidebarSafeObjective(objective);
    return { objective: safe, faces, tool: input.toolOf(ids), ownWorking: input.ownWorkingOf(objective.id), computerUseEnabled: input.computerUseEnabledOf(objective.id) };
  }) : [];
  return { v: 1, at: input.at, writable: input.writable, autonomous: input.autonomous, taskforceEnabled: input.taskforceEnabled, computerUseAvailable: input.computerUseAvailable, next: input.offset + page.length < source.length ? input.offset + page.length : null,
    commodores: input.commodoreId ? [] : page as readonly SidebarRemoteCommodore[], objectives, groups: input.groups, preferences: input.preferences };
}
