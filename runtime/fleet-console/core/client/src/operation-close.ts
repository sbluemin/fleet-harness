import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

import { fetchOperations } from "./api.js";
import { hydrateOperations } from "./store.js";

// Operation 닫기의 단일 경로: plugin 정리 → host DELETE → 재수화.
// operations 페이지(캔버스 프레임/사이드바 칩)와 팔레트 close 명령이 이 함수를 공유한다.
export async function closeOperationCompletely(operationId: string, plugin: FleetClientPlugin | null): Promise<void> {
  try {
    if (plugin?.closeOperation) await plugin.closeOperation(operationId);
  } catch { /* 플러그인 close 오류는 무시 */ }
  await fetch(`/api/v1/operations/${encodeURIComponent(operationId)}`, { method: "DELETE" }).catch(() => {});
  await fetchOperations(null).then(hydrateOperations).catch(() => {});
}
