import path from "node:path";

import type { FleetWikiLock } from "./lock.js";

export function isStaleLock(lock: FleetWikiLock, distMtime: number): boolean {
  if (distMtime === 0) return false;
  const startedAtMs = new Date(lock.startedAt).getTime();
  if (Number.isNaN(startedAtMs)) return false;
  return startedAtMs < distMtime;
}

export interface LockTrustResult {
  trusted: boolean;
  reason?: string;
}

export function isLockTrustworthyForRestart(
  lock: FleetWikiLock,
  currentCwd: string,
  healthResponseCwd: string | null,
): LockTrustResult {
  if (!Number.isInteger(lock.pid) || lock.pid <= 1) {
    return { trusted: false, reason: `pid 검증 실패(${lock.pid})` };
  }
  if (path.resolve(lock.cwd) !== path.resolve(currentCwd)) {
    return { trusted: false, reason: `cwd 불일치(lock=${lock.cwd}, current=${currentCwd})` };
  }
  if (healthResponseCwd === null || path.resolve(healthResponseCwd) !== path.resolve(lock.cwd)) {
    return { trusted: false, reason: `health 응답 cwd 불일치(${healthResponseCwd})` };
  }
  return { trusted: true };
}
