import { useMemo } from "react";
import type { OpenUIOpenPort, OpenUIOpenTarget, OpenUIResolvedEntity } from "../../execution/shared/chat-renderer.js";
import { commodoreAvatarKey } from "../../workspace/shared/avatars.js";
import { useAvatarToneOf } from "../../workspace/client/avatar-accent.js";
import { finishedObjectives, readTheater } from "./board.js";
import { openReferencedObjective, useCommodoreObjectiveIndex } from "./commodore-reference-input.js";
import { readCommodoreList, useCommodoreList } from "./commodore-list.js";
import { commodoreLanguage } from "./commodore-state.js";

/** 사령관 원장·대화의 열기 포트 — 같은 소유자의 목표와 목록에 있는 사령관만 받고 mission:N은 받지 않는다. */
export function useCommodoreOpenUIPort(theaterId: string, openObjective?: (id: string) => void, openCommodore?: (id: string) => void): OpenUIOpenPort {
  // 목록 도착·삭제·아바타 변경 때 렌더 판정도 갱신하고, 클릭 시에는 캐시된 목록이 아닌 현재 목록을 다시 확인한다.
  const index = useCommodoreObjectiveIndex(theaterId);
  const commodores = useCommodoreList();
  const toneOf = useAvatarToneOf();
  return useMemo(() => {
    const accepts = (target: OpenUIOpenTarget) => target.kind === "commodore"
      ? !!openCommodore && readCommodoreList().some((candidate) => candidate.commodoreId === target.id)
      : target.kind === "objective" && (readTheater(theaterId).objectives.some((candidate) => candidate.id === target.id)
        || finishedObjectives(theaterId).some((candidate) => candidate.id === target.id));
    const resolve = (target: OpenUIOpenTarget): OpenUIResolvedEntity | null => {
      const ko = commodoreLanguage() === "ko";
      if (target.kind === "commodore") {
        const found = readCommodoreList().find((candidate) => candidate.commodoreId === target.id);
        if (!found) return null;
        const theaters = Array.isArray(found.theaters) ? found.theaters : [];
        const theaterLabels = theaters.map((item) => item?.label).filter((label): label is string => typeof label === "string" && label.length > 0);
        const title = found.alias || theaterLabels[0] || found.label || (ko ? "사령관" : "Commodore");
        const phase = found.run?.phase;
        const subtitle = theaterLabels.length > 0
          ? theaterLabels.slice(0, 2).join(" · ")
          : (ko ? "사령관 · 대기 중" : "Commodore · Idle");
        const badge = phase === "turn"
          ? (ko ? "작업 중" : "Running")
          : phase === "error"
            ? (ko ? "오류" : "Error")
            : theaters.length === 0
              ? (ko ? "Theater 미연결" : "No Theater")
              : undefined;
        const badgeTone = phase === "turn"
          ? "warn" as const
          : phase === "error"
            ? "bad" as const
            : theaters.length === 0
              ? "warn" as const
              : undefined;
        return {
          title,
          subtitle,
          ...(badge ? { badge } : {}),
          ...(badgeTone ? { badgeTone } : {}),
          avatarTone: toneOf(commodoreAvatarKey(target.id)),
        };
      }
      if (target.kind === "objective") {
        const live = readTheater(theaterId).objectives.find((candidate) => candidate.id === target.id);
        const obj = live ?? finishedObjectives(theaterId).find((candidate) => candidate.id === target.id);
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
            : obj.waiting
              ? (ko ? "확인 대기" : "Waiting")
              : obj.running
                ? (ko ? "진행 중" : "Running")
                : undefined;
        const badgeTone = obj.done
          ? "good" as const
          : obj.awaitingReview || obj.waiting
            ? "wait" as const
            : obj.running
              ? "warn" as const
              : undefined;
        return {
          title: obj.title,
          subtitle,
          ...(badge ? { badge } : {}),
          ...(badgeTone ? { badgeTone } : {}),
        };
      }
      return null;
    };
    return {
      accepts,
      resolve,
      open: (target) => {
        if (!accepts(target)) return;
        if (target.kind === "commodore") openCommodore?.(target.id);
        else if (target.kind === "objective") {
          if (openObjective) openObjective(target.id); else openReferencedObjective(theaterId, target.id);
        }
      },
    };
  }, [theaterId, openObjective, openCommodore, index, commodores, toneOf]);
}
