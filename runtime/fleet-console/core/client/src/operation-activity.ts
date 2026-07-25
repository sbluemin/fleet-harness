import type { OperationActivity } from "@fleet-console/sdk/plugin";

import type { OperationNode } from "./types.js";

export type OperationActivityVisual = "running" | "awaiting" | "dormant" | "idle";

// 활동 맵에 항목이 없는 Operation의 분류 폭백. 플러그인이 아직 status를 심지 않은 복원 Operation은
// doctrine상 "dormant until explicitly relaunched"이므로 providerSession 보유 여부로 dormant를 판별한다.
// 사이드바 STATUS 축, Alt 순환, 팔레트 뱃지가 같은 분류를 공유하도록 이 함수가 단일 기준이다.
export function resolveOperationActivity(
  operation: OperationNode,
  operationStatus: Readonly<Record<string, OperationActivity>>,
): OperationActivity {
  const live = operationStatus[operation.id];
  if (live) return live;
  return operation.payload?.providerSession ? "dormant" : "idle";
}

export function operationActivityVisual(status: OperationActivity | undefined): OperationActivityVisual {
  if (status === "running") return "running";
  if (status === "awaiting") return "awaiting";
  if (status === "dormant") return "dormant";
  return "idle";
}

export function operationActivityLabel(status: OperationActivity | undefined): string {
  const visual = operationActivityVisual(status);
  if (visual === "running") return "Running";
  if (visual === "awaiting") return "Awaiting input";
  if (visual === "dormant") return "Dormant";
  return "Idle";
}
