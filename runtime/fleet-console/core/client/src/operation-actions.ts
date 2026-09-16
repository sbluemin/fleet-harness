// Operation lifecycle actions issued from chrome: close a card for good, or resume
// a dormant one in place.

import type { ClientExecutionProvider } from "@fleet-console/sdk/plugin";
import type { OperationNode } from "./types.js";
import { type DeferredDeletionReceipt, deleteOperation, fetchOperations } from "./api.js";
import { minimizeOperation } from "./canvas/canvas-store.js";
import { playMinimizeFlight } from "./canvas/panel-motion.js";
import { resolveOperationActivity } from "./operation-activity.js";
import { clearIdleArrival } from "./operation-marks.js";
import { getState, hydrateOperations, setActiveOperation } from "./store.js";

// ─── minimize ──────────────────────────────────────────────────────────────────

// 최소화는 패널을 치우는 명시적 처리다. War Room에서는 일반 포커스 확인을 막지만,
// 사용자가 직접 최소화를 누른 Operation의 유휴 도착은 확인한 것으로 보고 미확인 마크를 걷는다.
export function minimizeOperationCompletely(operationId: string): void {
  if (getState().activeOperationId === operationId) setActiveOperation(null);
  clearIdleArrival(operationId);
  playMinimizeFlight(operationId);
  minimizeOperation(operationId);
}

// ─── close ─────────────────────────────────────────────────────────────────────

// Operation 닫기의 단일 경로: plugin 정리 → host DELETE → 재수화.
// operations 페이지(캔버스 프레임/사이드바 칩)와 팔레트 close 명령이 이 함수를 공유한다.
// 호스트가 삭제를 유예하므로 receipt를 그대로 돌려주고, 호출자가 undo 토스트에 쓴다.
export async function closeOperationCompletely(
  operationId: string,
  plugin: ClientExecutionProvider | null,
): Promise<DeferredDeletionReceipt | null> {
  try {
    if (plugin?.closeOperation) await plugin.closeOperation(operationId);
  } catch { /* 플러그인 close 오류는 무시 */ }
  let deletion: DeferredDeletionReceipt | null = null;
  try {
    deletion = (await deleteOperation(operationId)).deletion;
  } catch { /* 삭제 요청 실패는 무시하고 재수화로 실제 상태를 따른다 */ }
  await fetchOperations(null).then(hydrateOperations).catch(() => {});
  return deletion;
}

// ─── resume ────────────────────────────────────────────────────────────────────

// Operation 재개의 단일 경로: plugin resume 훅 → 미제공 시 호출 표면의 focus 폴백.
// 팔레트 resume 명령과 War Room 종료 선반 칩이 이 함수를 공유한다.
// plugin 실패는 자체 알림이 담당하므로 focus 폴백을 실행하지 않는다.
//
// 권위 스냅샷이 아직 도착하지 않은 구간(hydration "pending")에서는 아무것도 하지 않는다. 그 구간의
// 종료 표시는 보수적 폭백이지 관측된 사실이 아니므로, 그 위에서 재개를 시작하면 사용자는 자기가
// 무엇을 눌렀는지 모른 채 세션을 되살리게 된다. 축이 자리잡으면 같은 클릭이 정상 동작한다.
export function resumeOperationInPlace(
  operationId: string,
  operations: readonly OperationNode[],
  plugins: readonly ClientExecutionProvider[],
  focusFallback: (operationId: string) => void,
): void {
  if (getState().operationRuntimeHydration === "pending") return;
  const operation = operations.find((candidate) => candidate.id === operationId);
  const plugin = operation ? plugins.find((candidate) => candidate.id === operation.pluginId) : undefined;
  if (plugin?.resumeOperation) {
    void Promise.resolve(plugin.resumeOperation(operationId))
      .then(() => fetchOperations(null).then(hydrateOperations))
      .catch(() => { /* 실패 알림은 plugin이 emit */ });
  } else {
    focusFallback(operationId);
  }
}

// 최소화 선반에서 패널을 꺼내는 제스처는 그 자체로 "이 Operation을 다시 쓰겠다"는 뜻이다.
// 꺼낸 자리가 휴면 프레임이면 Resume를 한 번 더 누르게 하지 않고 여는 동작이 재개까지 데려간다.
// 이미 캔버스에 떠 있던 휴면 패널은 대상이 아니다 — 사용자는 그 카드를 보고도 두기로 한 상태이고,
// 단순한 포커스 이동이 프로세스를 되살리면 안 된다.
// 재개 훅이 없는 plugin에서는 아무 일도 하지 않는다: 여는 동작이 이미 패널을 그 자리에 세웠으므로
// resumeOperationInPlace의 focus 폭백은 여기서 할 일이 없다.
export function resumeDormantOnOpen(
  operationId: string,
  operations: readonly OperationNode[],
  plugins: readonly ClientExecutionProvider[],
): void {
  const operation = operations.find((candidate) => candidate.id === operationId);
  if (!operation) return;
  if (resolveOperationActivity(operation, getState().operationRuntime) !== "ended") return;
  resumeOperationInPlace(operationId, operations, plugins, () => {});
}
