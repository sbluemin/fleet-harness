import { operationMarkLabel, operationMarkVisual, type OperationMarkVisual } from "../operation-activity.js";

/**
 * Operation 활동 상태를 그리는 단일 조형. 사이드바 칩·War Room·커맨드 밴드·모바일 목록·
 * 검색 팔레트가 같은 마크를 쓴다 — 표면마다 다른 조형을 두면 같은 사실이 표면 수만큼의 이야기로 갈라진다.
 * 조형은 둥근 네모 하나뿐이다(원형 폐지). 상태는 채움·중공·발광·맥동으로만 갈린다.
 */
function operationStatusIconClass(status: OperationMarkVisual | undefined): string {
  const visual = operationMarkVisual(status);
  if (visual === "running") return "tenant-beacon is-turn-running";
  if (visual === "background") return "tenant-beacon is-background";
  if (visual === "awaiting") return "tenant-beacon is-awaiting";
  if (visual === "unseen") return "tenant-beacon is-unseen";
  if (visual === "ended") return "tenant-beacon is-ended";
  return "tenant-beacon is-idle";
}

interface OperationStatusIconProps {
  readonly status: OperationMarkVisual | undefined;
  /** 마크를 감싼 요소가 이미 상태를 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
}

export function OperationStatusIcon({ status, decorative = false, className }: OperationStatusIconProps) {
  const label = operationMarkLabel(status);
  const classes = [operationStatusIconClass(status), className].filter(Boolean).join(" ");
  if (decorative) return <span className={classes} aria-hidden="true" title={label} />;
  return <span className={classes} role="img" aria-label={label} title={label} />;
}
