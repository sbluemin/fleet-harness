import { ShellGlyph } from "@fleet-console/sdk/components/shell-glyph";

import { getT } from "../i18n/index.js";
import { resolveActiveLocale } from "../operation-activity.js";
import { isShellOperation } from "../theater.js";
import type { OperationMarkVisual } from "../operation-activity.js";
import type { OperationNode } from "../types.js";

import { OperationStatusIcon } from "./operation-status-icon.js";

/**
 * 목록의 이름 왼쪽 칸에 서는 마크. 두 종류뿐이다.
 *
 * - 에이전트 Operation: 활동 비콘(OperationStatusIcon) — 지금 무엇을 하고 있는지.
 * - Shell Operation: 종류 글리프 — Shell은 활동 축을 발행하지 않아 비콘이 늘 "초록 유휴"
 *   또는 "중공 종료"로 굳는다. 그건 상태가 아니라 상태가 없다는 사실이므로, 발광·맥동을
 *   띄우는 대신 그 자리를 정체성이 가져간다. 살아있는 Shell과 종료된 Shell은 같은 그림이다.
 *
 * 칸(섹션 분류)은 이 마크와 무관하게 그대로다 — Shell은 여전히 유휴/휴면 칸에 선다.
 */
export function ShellKindMark({ decorative = false, className }: {
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  const label = getT(resolveActiveLocale())("operation.kind.shell");
  const classes = ["shell-kind-mark", className].filter(Boolean).join(" ");
  if (decorative) return <span className={classes} aria-hidden="true" title={label}><ShellGlyph /></span>;
  return <span className={classes} role="img" aria-label={label} title={label}><ShellGlyph /></span>;
}

export function OperationNameMark({ operation, status, decorative = false, className }: {
  readonly operation: Pick<OperationNode, "type">;
  readonly status: OperationMarkVisual | undefined;
  /** 감싼 요소가 이미 그 사실을 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  if (isShellOperation(operation)) return <ShellKindMark decorative={decorative} className={className} />;
  return <OperationStatusIcon status={status} decorative={decorative} className={className} />;
}
