import { useMemo } from "react";
import type { OpenUIOpenPort, OpenUIOpenTarget } from "../../execution/shared/chat-renderer.js";
import { finishedObjectives, readTheater } from "./board.js";
import { openReferencedObjective, useCommodoreObjectiveIndex } from "./commodore-reference-input.js";
import { readCommodoreList, useCommodoreList } from "./commodore-list.js";

/** 사령관 원장·대화의 열기 포트 — 같은 소유자의 목표와 목록에 있는 사령관만 받고 mission:N은 받지 않는다. */
export function useCommodoreOpenUIPort(theaterId: string, openObjective?: (id: string) => void, openCommodore?: (id: string) => void): OpenUIOpenPort {
  // 목록 도착·삭제 때 렌더 판정도 갱신하고, 클릭 시에는 캐시된 목록이 아닌 현재 목록을 다시 확인한다.
  const index = useCommodoreObjectiveIndex(theaterId);
  const commodores = useCommodoreList();
  return useMemo(() => {
    const accepts = (target: OpenUIOpenTarget) => target.kind === "commodore"
      ? !!openCommodore && readCommodoreList().some((candidate) => candidate.commodoreId === target.id)
      : target.kind === "objective" && (readTheater(theaterId).objectives.some((candidate) => candidate.id === target.id)
        || finishedObjectives(theaterId).some((candidate) => candidate.id === target.id));
    return {
      accepts,
      open: (target) => {
        if (!accepts(target)) return;
        if (target.kind === "commodore") openCommodore?.(target.id);
        else if (target.kind === "objective") {
          if (openObjective) openObjective(target.id); else openReferencedObjective(theaterId, target.id);
        }
      },
    };
  }, [theaterId, openObjective, openCommodore, index, commodores]);
}
