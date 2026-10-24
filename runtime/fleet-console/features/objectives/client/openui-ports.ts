import type { OpenUIOpenPort, OpenUIOpenTarget } from "../../execution/shared/chat-renderer.js";
import type { Objective } from "../shared/types.js";
import { goToObjective } from "./fresh-conversation.js";
import { ownerOfContext } from "./board-commodore.js";
import { findAnyObjective, findFinishedObjective, openObjectiveFromCluster, readBoard, revealObjective } from "./objectives-state.js";

/** 기록 토큰과 같은 착지 — 완료로 보관된 목표는 읽어 둔 끝난 목표에서 완료를 읽는다. */
function openListedObjective(theaterId: string, objectiveId: string): void {
  const live = findAnyObjective(objectiveId);
  goToObjective(objectiveId, theaterId, !!(live ?? findFinishedObjective(objectiveId))?.done);
}

/** 목표가 하나로 정해진 표면에서만 mission:N을 해석한다. 사령관 원장의 포트는 Console 의 commodore 기능이 따로 둔다. */
export function objectiveOpenUIPort(theaterId: string, objective?: Objective, openObjective?: (id: string) => void): OpenUIOpenPort {
  const mission = (number: number) => (objective ? findAnyObjective(objective.id) ?? objective : undefined)?.missions[number - 1];
  const accepts = (target: OpenUIOpenTarget) => target.kind === "objective"
    ? findAnyObjective(target.id)?.commodoreId === (objective?.commodoreId ?? ownerOfContext(theaterId))
    : target.kind === "mission" && !!mission(target.number);
  return {
    accepts,
    open: (target) => {
      if (!accepts(target)) return;
      if (target.kind === "objective") { if (openObjective) openObjective(target.id); else openListedObjective(theaterId, target.id); }
      else if (target.kind === "mission" && objective) {
        const found = mission(target.number);
        if (!found) return;
        revealObjective({ objectiveId: objective.id, missionId: found.id });
        openObjectiveFromCluster(theaterId, objective.id);
      }
    },
  };
}
