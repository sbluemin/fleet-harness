import type { TaskForceCliType } from "./types.js";

const TASK_FORCE_POOL_KEY_PATTERN = /(?:^|:)taskforce:[^:]+:([^:]+)$/;

export function buildCarrierExecutorPoolKey(carrierId: string, originSessionId: string | undefined, cwd?: string): string {
  return namespacePoolKey(carrierId, joinSessionCwdNamespace(originSessionId, cwd));
}

export function buildTaskForceExecutorPoolKey(carrierId: string, cliType: TaskForceCliType, originSessionId: string | undefined, cwd?: string): string {
  return namespacePoolKey(buildTaskForceRunId(carrierId, cliType), joinSessionCwdNamespace(originSessionId, cwd));
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

/**
 * executor pool 식별자에 resolved cwd를 반영한다.
 * 같은 carrier/origin이라도 cwd가 다르면 별도 풀로 분리되어, idle 세션 재사용이
 * cwd 변경을 무시하고 옛 디렉토리에서 spawn하는 것을 막는다. cwd는 base64url로
 * 인코딩해 `:` 충돌과 carrierId 끝-매칭(matchesCarrierPoolKey)을 함께 보존한다.
 */
function joinSessionCwdNamespace(originSessionId: string | undefined, cwd: string | undefined): string | undefined {
  const cwdNamespace = cwd ? `cwd-${Buffer.from(cwd, "utf-8").toString("base64url")}` : undefined;
  if (originSessionId && cwdNamespace) return `${originSessionId}:${cwdNamespace}`;
  return originSessionId ?? cwdNamespace;
}
