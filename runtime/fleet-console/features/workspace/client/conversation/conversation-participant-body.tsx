import { useLayoutEffect, useRef, useState } from "react";

import { ObjectiveBodySlot, type ObjectiveBodyConfig } from "../../../../core/client/src/chrome/mobile/objective-body-pool.js";
import type { ObjectiveGeometry } from "../../../../core/client/src/integration/types.js";

const INITIAL_GEOMETRY: ObjectiveGeometry = { x: 0, y: 0, width: 720, height: 640, zIndex: 0 };

/**
 * 원장 분할 화면의 칸 하나 — 그 참여자의 기존 본문 슬롯.
 *
 * 칸의 실측을 본문 geometry 로 넘긴다. 이 값은 저장하지 않는다. 같은 objectiveId 의 슬롯은
 * 트리에 하나만 있어야 한다(본문 풀이 슬롯을 하나만 붙인다).
 */
export function ConversationParticipantBody({ objectiveId, config }: {
  readonly objectiveId: string;
  readonly config: Omit<ObjectiveBodyConfig, "geometry" | "onGeometryChange">;
}) {
  const [geometry, setGeometry] = useState(INITIAL_GEOMETRY);
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setGeometry((current) => {
      const width = Math.max(1, element.clientWidth);
      const height = Math.max(1, element.clientHeight);
      return current.width === width && current.height === height ? current : { ...current, width, height };
    });
    update();
    if (typeof ResizeObserver === "undefined") return;
    // 관찰 콜백 안에서 곧장 크기를 바꾸면 같은 프레임에 다시 관찰이 쌓인다 — 다음 프레임에 한 번만 반영한다.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => { frame = 0; update(); });
    });
    observer.observe(element);
    return () => { observer.disconnect(); if (frame !== 0) cancelAnimationFrame(frame); };
  }, []);
  return (
    <div ref={ref} className="conversation-participant-body">
      <ObjectiveBodySlot objectiveId={objectiveId} config={{ ...config, geometry, onGeometryChange: setGeometry }} className="conversation-body-slot" />
    </div>
  );
}
