import { openObjectivePopup } from "./objectives-panel.js";
import type { OpenUIOpenPort, OpenUIOpenTarget, OpenUIResolvedEntity } from "../../execution/shared/chat-renderer.js";
import { missionTitle, type Objective } from "../shared/types.js";
import { goToObjective } from "./fresh-conversation.js";
import { findAnyObjective, findFinishedObjective, readBoard, viewedCommodoreId } from "./objectives-state.js";

/** 기록 토큰과 같은 착지 — 완료로 보관된 목표는 읽어 둔 끝난 목표에서 완료를 읽는다. */
function openListedObjective(theaterId: string, objectiveId: string): void {
  const live = findAnyObjective(objectiveId);
  goToObjective(objectiveId, theaterId, !!(live ?? findFinishedObjective(objectiveId))?.done);
}

const isKoreanLocale = () => typeof document !== "undefined" && document.documentElement.lang === "ko";

/** 목표가 하나로 정해진 표면에서만 mission:N을 해석한다. 사령관 원장의 포트는 Console 의 commodore 기능이 따로 둔다. */
export function objectiveOpenUIPort(theaterId: string, objective?: Objective, openObjective?: (id: string) => void): OpenUIOpenPort {
  const mission = (number: number) => (objective ? findAnyObjective(objective.id) ?? objective : undefined)?.missions[number - 1];
  const accepts = (target: OpenUIOpenTarget) => target.kind === "objective"
    ? findAnyObjective(target.id)?.commodoreId === (objective?.commodoreId ?? viewedCommodoreId())
    : target.kind === "mission" && !!mission(target.number);
  const resolve = (target: OpenUIOpenTarget): OpenUIResolvedEntity | null => {
    const ko = isKoreanLocale();
    if (target.kind === "objective") {
      const obj = findAnyObjective(target.id) ?? findFinishedObjective(target.id);
      if (!obj) return null;
      const missions = Array.isArray(obj.missions) ? obj.missions : [];
      const doneCount = missions.filter((m) => Boolean(m.done)).length;
      const subtitle = missions.length > 0
        ? (ko ? `목표 · 임무 ${doneCount}/${missions.length}` : `Objective · ${doneCount}/${missions.length} missions`)
        : (ko ? "목표" : "Objective");
      const badge = obj.done
        ? (ko ? "완료" : "Done")
        : obj.awaitingReview
          ? (ko ? "검토 대기" : "Review")
          : obj.commenced
            ? (ko ? "진행 중" : "Running")
            : undefined;
      const badgeTone = obj.done
        ? "good" as const
        : obj.awaitingReview
          ? "wait" as const
          : obj.commenced
            ? "warn" as const
            : undefined;
      return {
        title: obj.title,
        subtitle,
        ...(badge ? { badge } : {}),
        ...(badgeTone ? { badgeTone } : {}),
      };
    }
    if (target.kind === "mission") {
      const found = mission(target.number);
      if (!found) return null;
      return {
        title: missionTitle(found),
        subtitle: ko ? `임무 #${target.number}` : `Mission #${target.number}`,
        badge: found.done ? (ko ? "완료" : "Done") : (ko ? "진행 중" : "Active"),
        badgeTone: found.done ? "good" : "warn",
      };
    }
    return null;
  };
  return {
    accepts,
    resolve,
    open: (target) => {
      if (!accepts(target)) return;
      if (target.kind === "objective") { if (openObjective) openObjective(target.id); else openListedObjective(theaterId, target.id); }
      else if (target.kind === "mission" && objective) {
        const found = mission(target.number);
        if (!found) return;
        openObjectivePopup(objective.id, "crew", found.id);
      }
    },
  };
}
