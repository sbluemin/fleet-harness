import type { ObjectiveMarkVisual } from "../objective-activity.js";
import type { ObjectiveRecord } from "../../../../core/client/src/integration/types.js";

import { ObjectiveStatusIcon } from "./objective-status-icon.js";

/**
 * 목록의 이름 왼쪽 칸에 서는 마크 — 그 Objective 의 몽글 아바타가 사이드바 칩과 같은 얼굴로 지금을 말한다.
 */
export function ObjectiveNameMark({ objectiveRecord, status, archived, size, decorative = false, className }: {
  readonly objectiveRecord: Pick<ObjectiveRecord, "id" | "parentObjectiveId">;
  readonly status: ObjectiveMarkVisual | undefined;
  readonly archived?: boolean;
  readonly size?: number;
  /** 감싼 요소가 이미 그 사실을 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  return <ObjectiveStatusIcon objectiveRecord={objectiveRecord} status={status} archived={archived} size={size} decorative={decorative} className={className} />;
}
