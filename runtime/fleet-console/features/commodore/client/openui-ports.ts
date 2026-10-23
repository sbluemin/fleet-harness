import { useMemo } from "react";
import type { OpenUIOpenPort, OpenUIOpenTarget } from "../../execution/shared/chat-renderer.js";
import { finishedObjectives, readTheater } from "./board.js";
import { openReferencedObjective, useCommodoreObjectiveIndex } from "./commodore-reference-input.js";

/** 사령관 원장·대화의 OpenUI 열기 포트 — 목표가 하나로 정해지지 않으므로 같은 Theater 의 목표 링크만 받고 mission:N 은 받지 않는다. */
export function useCommodoreOpenUIPort(theaterId: string, openObjective?: (id: string) => void): OpenUIOpenPort {
  // 같은 목표 인덱스 구독으로 accepts의 렌더 결과도 목록 도착·삭제를 따라간다.
  const index = useCommodoreObjectiveIndex(theaterId);
  return useMemo(() => {
    const accepts = (target: OpenUIOpenTarget) => target.kind === "objective"
      && (readTheater(theaterId).objectives.some((candidate) => candidate.id === target.id)
        || finishedObjectives(theaterId).some((candidate) => candidate.id === target.id));
    return {
      accepts,
      open: (target) => {
        if (!accepts(target) || target.kind !== "objective") return;
        if (openObjective) openObjective(target.id); else openReferencedObjective(theaterId, target.id);
      },
    };
  }, [theaterId, openObjective, index]);
}
