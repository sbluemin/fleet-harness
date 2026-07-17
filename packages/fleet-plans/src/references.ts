import type { ParsedPlanRef, ParsedTaskRef } from "./types.js";

const WORKSPACE_REF_PATTERN = /^[A-Za-z0-9-]+$/;
const PLAN_ID_PATTERN = /^(?!.*\.md$)[a-z0-9](?:[a-z0-9_-]|\.(?=[a-z0-9_-])){0,127}$/;
const TASK_ID_PATTERN = /^W[1-9]\d*-[A-Z][A-Z0-9]*-T[1-9]\d*$/;

export function formatPlanRef(workspaceRef: string, planId: string): string {
  assertWorkspaceRef(workspaceRef);
  assertPlanId(planId);
  return `${workspaceRef}:${planId}`;
}

export function parsePlanRef(planRef: string): ParsedPlanRef {
  const separator = planRef.lastIndexOf(":");
  if (separator <= 0 || separator === planRef.length - 1) {
    throw new Error(`Invalid PlanRef: ${planRef}`);
  }
  const workspaceRef = planRef.slice(0, separator);
  const planId = planRef.slice(separator + 1);
  assertWorkspaceRef(workspaceRef);
  assertPlanId(planId);
  return { planId, workspaceRef };
}

export function formatTaskRef(planRef: string, taskId: string): string {
  parsePlanRef(planRef);
  assertTaskId(taskId);
  return `${planRef}#${taskId}`;
}

export function parseTaskRef(taskRef: string): ParsedTaskRef {
  const separator = taskRef.lastIndexOf("#");
  if (separator <= 0 || separator === taskRef.length - 1) {
    throw new Error(`Invalid TaskRef: ${taskRef}`);
  }
  const plan = parsePlanRef(taskRef.slice(0, separator));
  const taskId = taskRef.slice(separator + 1);
  assertTaskId(taskId);
  return { ...plan, taskId };
}

export function assertPlanId(planId: string): void {
  if (!PLAN_ID_PATTERN.test(planId)) {
    throw new Error(`Invalid plan id: ${planId}`);
  }
}

export function assertTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`Invalid task id: ${taskId}`);
  }
}

export function assertWorkspaceRef(workspaceRef: string): void {
  if (!WORKSPACE_REF_PATTERN.test(workspaceRef)) {
    throw new Error(`Invalid workspace reference: ${workspaceRef}`);
  }
}
