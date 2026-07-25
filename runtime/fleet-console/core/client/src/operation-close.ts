import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

import { deleteOperation, fetchOperations, type DeferredDeletionReceipt } from "./api.js";
import { hydrateOperations } from "./store.js";

// Operation 닫기의 단일 경로: plugin 정리 → host DELETE → 재수화.
// operations 페이지(캔버스 프레임/사이드바 칩)와 팔레트 close 명령이 이 함수를 공유한다.
// 호스트가 삭제를 유예하므로 receipt를 그대로 돌려주고, 호출자가 undo 토스트에 쓴다.
export async function closeOperationCompletely(
  operationId: string,
  plugin: FleetClientPlugin | null,
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
