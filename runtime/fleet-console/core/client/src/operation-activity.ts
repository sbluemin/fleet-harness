import type { OperationActivity } from "@fleet-console/sdk/plugin";

export type OperationActivityVisual = "running" | "awaiting" | "dormant" | "idle";

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
