// 전체 칸 진입구 — 캡션 ⤢, Alt↑, glance HUD, companion 복귀, 플러그인 focus(id, { snap: "full" })가
// 모두 이 한 함수를 지난다. 「한 패널만 크게」는 별도 상태(옛 최대화 레이어)가 아니라 스냅 유지의
// 전체 칸 하나이며, 되돌아갈 자리는 snapHold.restore에 실린다.
//
// 칸 사각형은 "지금 보이는 아레나"의 것이라 스토어가 스스로 계산할 수 없다(snap-layouts가 캡션 높이를
// 스토어에서 읽으므로 반대 방향 import는 순환이다). 그 한 줄의 환산이 이 모듈의 존재 이유다.

import { clearCompanionOperationId, getCanvasSnapArenaRect, getSnapFullOperationId, restoreSnapFullOperation, snapOperationToArenaRect } from "./canvas-store.js";
import { SNAP_FULL_ZONES, snapZoneHitFor } from "./snap-layouts.js";

/**
 * 전체 칸에 앉힌다 — 아레나 크기를 아직 모르면 false. 줌은 스냅 규칙대로 100%로 돌아오므로
 * Fleet Map 저줌에서 버튼·키로 들어와도 결과는 작업 크기의 한 칸이다(드래그 스냅의 저줌 금지는 별개).
 */
export function snapOperationToFullZone(operationId: string): boolean {
  const arena = getCanvasSnapArenaRect();
  if (!arena) return false;
  const hit = snapZoneHitFor(arena, SNAP_FULL_ZONES, 0);
  snapOperationToArenaRect(operationId, hit.zone, { presetId: hit.set.id, zones: hit.set.zones, zoneIndex: hit.zoneIndex });
  return true;
}

/** 같은 버튼(⤡)·Alt↓·캡션 더블클릭 — 전체 칸을 쥔 패널이면 직전 자리로 되돌리고, 아니면 앉힌다. */
export function toggleOperationSnapFull(operationId: string): boolean {
  return getSnapFullOperationId() === operationId
    ? restoreSnapFullOperation(operationId)
    : snapOperationToFullZone(operationId);
}

/**
 * companion 레이어를 닫는다 — 열기 전에 전체 칸이 서 있었다면 닫는 패널이 그 칸을 받는다.
 * 닫기 경로가 여럿(캡션 칩·단축키·패널 안 닫기·마지막 패널 숨김)이라 인계를 한 곳에서만 짊어진다.
 */
export function closeCompanionLayer(): void {
  const handOverOperationId = clearCompanionOperationId();
  if (handOverOperationId !== null) snapOperationToFullZone(handOverOperationId);
}
