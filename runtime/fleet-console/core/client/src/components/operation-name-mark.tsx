import type { OperationMarkVisual } from "../operation-activity.js";
import type { OperationNode } from "../types.js";

import { OperationStatusIcon } from "./operation-status-icon.js";

/**
 * 목록의 이름 왼쪽 칸에 서는 마크. Shell이 확대 표면으로 옮겨 간 뒤로 이 자리에 서는
 * Operation은 전부 활동 축을 발행하므로, 마크는 활동 비콘 하나다.
 */
export function OperationNameMark({ operation, status, decorative = false, className }: {
  readonly operation: Pick<OperationNode, "type">;
  readonly status: OperationMarkVisual | undefined;
  /** 감싼 요소가 이미 그 사실을 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  return <OperationStatusIcon status={status} decorative={decorative} className={className} />;
}
