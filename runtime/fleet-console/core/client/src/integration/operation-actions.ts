// Operation lifecycle actions issued from chrome: archive a card, or resume a dormant
// one in place.

import { ApiError, archiveOperation, readOperationLaunch, wasOperationBornDormant, type OperationArchiveReceipt } from "@fleet-console/sdk/operations/browser";
import type { ClientExecutionProvider } from "@fleet-console/sdk/plugin";
import type { OperationNode } from "./types.js";
import { fetchOperations } from "./api.js";
import { forceDropCompanionOperationId, getCompanionOperationId, minimizeOperation } from "../../../../features/workspace/client/canvas/canvas-store.js";
import { dismissTriageOperation, forgetTriageOperation, isTriageActive } from "../../../../features/workspace/client/canvas/triage-store.js";
import { playMinimizeFlight } from "../../../../features/workspace/client/canvas/panel-motion.js";
import { resolveOperationActivity } from "../../../../features/execution/client/operation-activity.js";
import { clearIdleArrival } from "../../../../features/execution/client/operation-marks.js";
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

// ─── archive ───────────────────────────────────────────────────────────────────

export type ArchiveOutcome =
  | { readonly ok: true; readonly receipt: OperationArchiveReceipt }
  | { readonly ok: false; readonly error: string };

// 같은 Operation을 두 입구가 동시에 보관하려 할 때(두 번 누름, 캡션과 ⌘K) 요청을 하나로 모은다.
const archivingOperationIds = new Set<string>();

/** 보관 요청이 날아가는 중인가 — 그 사이 도착한 늦은 동작(예: 재개 뒤의 포커스)이 사라질 패널을 다시 세우지 않게 한다. */
export function isArchivingOperation(operationId: string): boolean {
  return archivingOperationIds.has(operationId);
}

// 사람이 Operation을 치우는 단일 경로: Core 보관 → 화면 정리 → 재수화.
// 캔버스 캡션·사이드바 칩·우클릭 메뉴·트리아지·모바일·플러그인 본문의 onClose와 ⌘K가 이 함수를 공유한다.
// plugin.closeOperation은 부르지 않는다 — 그 훅은 세션과 첨부를 지우는 파괴적 정리였고, 보관의 실행 종료는
// 서버가 비파괴로 맡는다. 보관은 하위 Operation까지 함께 치우므로 receipt의 operationIds가 토스트의 개수다.
// 이미 진행 중인 같은 요청은 null을 돌려준다(호출자는 아무것도 하지 않는다).
export async function archiveOperationFromUi(operationId: string): Promise<ArchiveOutcome | null> {
  if (archivingOperationIds.has(operationId)) return null;
  archivingOperationIds.add(operationId);
  let outcome: ArchiveOutcome;
  try {
    outcome = { ok: true, receipt: await archiveOperation(operationId) };
    // 서버가 확정한 뒤에만 companion·선별 대상을 푼다. 실패 시 열린 화면을 그대로 둔다.
    if (getCompanionOperationId() === operationId) forceDropCompanionOperationId();
    if (isTriageActive()) dismissTriageOperation(operationId);
    for (const id of outcome.receipt.operationIds) forgetTriageOperation(id);
  } catch (error) {
    outcome = { ok: false, error: error instanceof ApiError ? error.message : "archive_failed" };
  } finally {
    archivingOperationIds.delete(operationId);
  }
  if (getState().activeOperationId !== null && outcome.ok && outcome.receipt.operationIds.includes(getState().activeOperationId!)) setActiveOperation(null);
  await fetchOperations(null).then(hydrateOperations).catch(() => {});
  return outcome;
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
// 다만 휴면으로 태어나 첫 턴 전인 지휘관은 구상·시작 전까지 열기만으로 깨우지 않는다.
// 프레임의 명시적인 Resume는 resumeOperationInPlace를 직접 사용하므로 그대로 동작한다.
// 재개 훅이 없는 plugin에서는 아무 일도 하지 않는다: 여는 동작이 이미 패널을 그 자리에 세웠으므로
// resumeOperationInPlace의 focus 폭백은 여기서 할 일이 없다.
export function resumeDormantOnOpen(
  operationId: string,
  operations: readonly OperationNode[],
  plugins: readonly ClientExecutionProvider[],
): void {
  const operation = operations.find((candidate) => candidate.id === operationId);
  if (!operation) return;
  if (wasOperationBornDormant(operation.payload) && !readOperationLaunch(operation.payload).started) return;
  if (resolveOperationActivity(operation, getState().operationRuntime) !== "ended") return;
  resumeOperationInPlace(operationId, operations, plugins, () => {});
}
