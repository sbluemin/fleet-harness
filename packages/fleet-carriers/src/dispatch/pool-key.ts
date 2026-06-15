import type { TaskForceCliType } from "./types.js";

const TASK_FORCE_POOL_KEY_PATTERN = /(?:^|:)taskforce:[^:]+:([^:]+)$/;

export function buildCarrierExecutorPoolKey(carrierId: string, originSessionId: string | undefined): string {
  return namespacePoolKey(carrierId, originSessionId);
}

export function buildTaskForceExecutorPoolKey(carrierId: string, cliType: TaskForceCliType, originSessionId: string | undefined): string {
  return namespacePoolKey(buildTaskForceRunId(carrierId, cliType), originSessionId);
}

export function buildTaskForceRunId(carrierId: string, cliType: TaskForceCliType): string {
  const encodedCarrierId = Buffer.from(carrierId, "utf-8").toString("base64url");
  return `taskforce:${cliType}:${encodedCarrierId}`;
}

export function matchesCarrierPoolKey(poolKey: string, carrierId: string): boolean {
  const encodedCarrierId = Buffer.from(carrierId, "utf-8").toString("base64url");
  const taskForceMatch = TASK_FORCE_POOL_KEY_PATTERN.exec(poolKey);
  if (taskForceMatch) return taskForceMatch[1] === encodedCarrierId;
  return poolKey === carrierId || poolKey.endsWith(`:${carrierId}`);
}

export function namespacePoolKey(baseKey: string, originSessionId: string | undefined): string {
  return originSessionId ? `${originSessionId}:${baseKey}` : baseKey;
}
