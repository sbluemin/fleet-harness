import type { OperationLifecycle } from "@fleet-console/sdk/plugin";

import { getState, subscribe as subscribeConsole } from "../../../../core/client/src/integration/store.js";
import type { ConsoleState, OperationNode } from "../../../../core/client/src/integration/types.js";
import {
  getTheaterCanvasSnapshot,
  getTheaterCompanionOperationId,
  setTheaterOperationMinimized,
  SNAP_FULL_PRESET_ID,
  subscribe as subscribeCanvas,
} from "./canvas-store.js";
import { playMinimizeFlight } from "./panel-motion.js";
import { isTriageActive } from "./triage-store.js";

/**
 * 휴면 자동 최소화 — Operation의 실행 표면이 사라져 수명주기가 live에서 dormant로 바뀌는 순간(화면에서는 ended)
 * 그 패널을 캔버스에서 내린다. 살아 있는 동안의 턴 종료(running·background → idle)는 수명주기 전이가 아니므로
 * 패널을 건드리지 않는다 — 에이전트는 다음 지시를 기다리며 그 자리에 선다.
 *
 * 전이 순간에 한 번만 판단한다. 휴면 패널을 계속 접지 않으므로 사람이 펼쳐 둔 휴면 패널은 그 자리에 남는다.
 * 판단 근거는 플러그인이 관측한 런타임 항목뿐이다 — 항목이 없을 때의 폭백 분류(복원 마커로 ended)나 축을 믿을 수
 * 없는 동안(hydration이 ready가 아닐 때: 부팅 스냅샷·재연결)의 값은 전이로 치지 않는다. 재연결 스냅샷은 ready 전에
 * 도착하므로, 끊긴 사이 휴면이 된 Operation은 기준선으로만 기록되고 내려가지 않는다.
 *
 * 내리는 길은 캔버스 스토어의 최소화뿐이다. 사용자의 최소화 동작(minimizeOperationCompletely)과 달리 도착 마크를
 * 걷지 않는다 — 마크 축은 사이드바 활동 추적이 소유하며 이 경로는 그것을 더하지도 지우지도 않는다.
 *
 * 그대로 두는 패널: 사람이 지금 보고 있는 활성 패널, 동반 레이어와 전체 칸에 앉은 패널(내리면 레이아웃이 통째로 바뀐다),
 * War Room 진행 중의 모든 패널(최소화는 deck에서 내린다는 뜻이다), 그리고 자동으로 내린 뒤 사람이 되올린 패널.
 * 마지막은 이 탭 세션 동안만 기억한다.
 */

const lastLifecycle = new Map<string, OperationLifecycle>();
const autoMinimizedIds = new Set<string>();
const restoredByUserIds = new Set<string>();

export function subscribeDormantAutoMinimize(): () => void {
  lastLifecycle.clear();
  autoMinimizedIds.clear();
  // 처음 보이는 값은 기준선이다 — 이미 휴면인 패널을 부팅이나 재마운트 때 내리지 않는다.
  observeLifecycle(false);
  const unsubscribeConsole = subscribeConsole(() => observeLifecycle(true));
  const unsubscribeCanvas = subscribeCanvas(noteUserRestores);
  return () => {
    unsubscribeConsole();
    unsubscribeCanvas();
  };
}

function observeLifecycle(act: boolean): void {
  const state = getState();
  const ready = state.operationRuntimeHydration === "ready";
  const present = new Set<string>();
  for (const operation of state.operations) {
    present.add(operation.id);
    const current = state.operationRuntime[operation.id]?.lifecycle;
    const previous = lastLifecycle.get(operation.id);
    if (current === undefined) lastLifecycle.delete(operation.id);
    else lastLifecycle.set(operation.id, current);
    if (!act || !ready || current !== "dormant" || previous !== "live") continue;
    if (keepsPanel(operation, state)) continue;
    if (operation.theaterId === state.activeTheaterId) playMinimizeFlight(operation.id);
    autoMinimizedIds.add(operation.id);
    setTheaterOperationMinimized(operation.theaterId, operation.id, true);
  }
  for (const id of lastLifecycle.keys()) if (!present.has(id)) lastLifecycle.delete(id);
  for (const id of autoMinimizedIds) if (!present.has(id)) autoMinimizedIds.delete(id);
  for (const id of restoredByUserIds) if (!present.has(id)) restoredByUserIds.delete(id);
}

function keepsPanel(operation: OperationNode, state: ConsoleState): boolean {
  if (restoredByUserIds.has(operation.id)) return true;
  if (isTriageActive()) return true;
  if (operation.id === state.activeOperationId) return true;
  const canvas = getTheaterCanvasSnapshot(operation.theaterId);
  if (canvas.minimized.includes(operation.id)) return true;
  if (getTheaterCompanionOperationId(operation.theaterId) === operation.id) return true;
  const hold = canvas.snapHold;
  return hold?.presetId === SNAP_FULL_PRESET_ID && operation.id in hold.assignments;
}

// 자동으로 내린 패널이 다시 캔버스에 서면 사람이 되올린 것이다 — 그 패널은 이 세션 동안 다시 자동으로 내리지 않는다.
function noteUserRestores(): void {
  if (autoMinimizedIds.size === 0) return;
  const operations = getState().operations;
  for (const id of autoMinimizedIds) {
    const operation = operations.find((candidate) => candidate.id === id);
    if (!operation) { autoMinimizedIds.delete(id); continue; }
    if (getTheaterCanvasSnapshot(operation.theaterId).minimized.includes(id)) continue;
    autoMinimizedIds.delete(id);
    restoredByUserIds.add(id);
  }
}
