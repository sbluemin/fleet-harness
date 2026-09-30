import { StatusGlyph, type StatusGlyphState } from "@fleet-console/sdk/components/status-glyph";

import { operationMarkLabel, operationMarkVisual, type OperationMarkVisual } from "../operation-activity.js";

/**
 * Operation 활동 상태를 그리는 단일 조형. 사이드바 칩·War Room·커맨드 밴드·모바일 목록·
 * 검색 팔레트가 같은 마크를 쓴다 — 표면마다 다른 조형을 두면 같은 사실이 표면 수만큼의 이야기로 갈라진다.
 * 조형은 SDK 상태 글리프(12px 원)다. 이 모듈은 활동 → 글리프 상태와 로케일 라벨만 소유한다.
 */
export function operationStatusGlyphState(status: OperationMarkVisual | undefined): StatusGlyphState {
  return operationMarkVisual(status);
}

interface OperationStatusIconProps {
  readonly status: OperationMarkVisual | undefined;
  /** 마크를 감싼 요소가 이미 상태를 접근성 이름으로 말하는 자리 — 중복 낭독을 막는다. */
  readonly decorative?: boolean;
  readonly className?: string;
}

export function OperationStatusIcon({ status, decorative = false, className }: OperationStatusIconProps) {
  return <StatusGlyph state={operationStatusGlyphState(status)} label={operationMarkLabel(status)} decorative={decorative} className={className} />;
}
