import type { OperationMarkVisual } from "../operation-activity.js";
import type { OperationNode } from "../../../../core/client/src/integration/types.js";

import { OperationStatusIcon } from "./operation-status-icon.js";

/**
 * 목록의 이름 왼쪽 칸에 서는 마크 — 그 Operation 의 몽글 아바타가 사이드바 칩과 같은 얼굴로 지금을 말한다.
 */
export function OperationNameMark({ operation, status, archived, size, decorative = false, className }: {
  readonly operation: Pick<OperationNode, "id" | "parentOperationId">;
  readonly status: OperationMarkVisual | undefined;
  readonly archived?: boolean;
  readonly size?: number;
  /** 감싼 요소가 이미 그 사실을 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  return <OperationStatusIcon operation={operation} status={status} archived={archived} size={size} decorative={decorative} className={className} />;
}
