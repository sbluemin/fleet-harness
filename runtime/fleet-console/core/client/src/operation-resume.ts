import type { FleetClientPlugin } from "@fleet-console/sdk/plugin";

import type { OperationNode } from "./types.js";

// Operation 재개의 단일 경로: plugin resume 훅 → 미제공 시 호출 표면의 focus 폭백.
// 팔레트 resume 명령과 War Room 휴면 선반 칩이 이 함수를 공유한다.
// plugin 실패는 자체 알림이 담당하므로 focus 폭백을 실행하지 않는다.
export function resumeOperationInPlace(
  operationId: string,
  operations: readonly OperationNode[],
  plugins: readonly FleetClientPlugin[],
  focusFallback: (operationId: string) => void,
): void {
  const operation = operations.find((candidate) => candidate.id === operationId);
  const plugin = operation ? plugins.find((candidate) => candidate.id === operation.pluginId) : undefined;
  if (plugin?.resumeOperation) {
    void Promise.resolve(plugin.resumeOperation(operationId)).catch(() => { /* 실패 알림은 plugin이 emit */ });
  } else {
    focusFallback(operationId);
  }
}
