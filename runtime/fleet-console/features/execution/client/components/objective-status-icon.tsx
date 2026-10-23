import type { ObjectiveRecord } from "../../../../core/client/src/integration/types.js";
import { ObjectiveAvatar, clusterFaceFacts, mongleStateOfMark } from "../../../workspace/client/avatars.js";
import { useObjectiveClusters } from "../../../workspace/client/objective-clusters.js";
import { objectiveRecordMarkLabel, type ObjectiveMarkVisual } from "../objective-activity.js";

/**
 * Objective 활동 상태를 그리는 단일 조형 — 사이드바 밖 목록(새 세션 @·검색 팔레트)이 같은 얼굴을 쓴다.
 * 조형은 그 Objective 의 몽글 아바타다(구성원은 베이스만, 그 밖은 지휘관 안테나). 얼굴은 사이드바 칩과 같은 경로로 고른다:
 * 표식(unseen 포함) → `mongleStateOfMark` 에 묶음의 결정 요청·검토 대기·임무 완료 사실을 더한다. 보관된 Objective 은 끝난 얼굴이다.
 */
interface ObjectiveStatusIconProps {
  readonly objectiveRecord: Pick<ObjectiveRecord, "id" | "parentObjectiveId">;
  readonly status: ObjectiveMarkVisual | undefined;
  /** 보관함 행 — 묶음 사실과 무관하게 끝난 얼굴이다. */
  readonly archived?: boolean;
  /** 한 변(px). 목록 행의 마크 칸(16px)이 기본이다. */
  readonly size?: number;
  /** 마크를 감싼 요소가 이미 상태를 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
}

export function ObjectiveStatusIcon({ objectiveRecord, status, archived = false, size = 16, decorative = false, className }: ObjectiveStatusIconProps) {
  const clusters = useObjectiveClusters();
  const state = archived ? "ended" : mongleStateOfMark(status, clusterFaceFacts(clusters, objectiveRecord.id));
  return <ObjectiveAvatar objectiveRecord={objectiveRecord} state={state} size={size} label={objectiveRecordMarkLabel(archived ? "ended" : status)} decorative={decorative} className={className} />;
}
