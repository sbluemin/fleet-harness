/**
 * admiral/agent/service-status — 서비스 상태 조회 API.
 *
 * Decision 27: refresh-driven. fleet-core 내부 폴링 루프로 스냅샷 갱신.
 * unified-agent native event API 신설 금지.
 *
 * imports → types/interfaces → constants → functions 순서 준수.
 */

import {
  getServiceSnapshots,
  refreshStatusQuiet,
  type ServiceSnapshot,
} from "@sbluemin/fleet-unified-agent";

// ═══════════════════════════════════════════════════════════════════════════
// Types / Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export type { ServiceSnapshot };

export interface ServiceStatusEvent {
  readonly snapshots: ServiceSnapshot[];
  readonly timestamp: number;
}

type ServiceStatusHandler = (event: ServiceStatusEvent) => void;

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 5 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// Functions
// ═══════════════════════════════════════════════════════════════════════════

/** 캐시된 서비스 상태 스냅샷 조회 */
export function read(): ServiceSnapshot[] {
  return getServiceSnapshots();
}

/** 백그라운드 새로고침 트리거 — 즉시 반환, 결과는 events로 수신 */
export function refresh(): void {
  try {
    refreshStatusQuiet();
  } catch {
    // unified-agent 미초정 상태에서는 무시
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Events — 모듈 채널
// ═══════════════════════════════════════════════════════════════════════════

const handlers = new Set<ServiceStatusHandler>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastEmittedHash = "";

/** 서비스 상태 변경 이벤트 구독 */
export const events = {
  register(handler: ServiceStatusHandler): () => void {
    handlers.add(handler);
    if (handlers.size === 1) startPolling();
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) stopPolling();
    };
  },
  unregister(handler: ServiceStatusHandler): void {
    handlers.delete(handler);
    if (handlers.size === 0) stopPolling();
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Internal
// ═══════════════════════════════════════════════════════════════════════════

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    try {
      refreshStatusQuiet();
    } catch {
      // 폴링 실패는 무시
    }
    checkAndEmit();
  }, POLL_INTERVAL_MS);
  // 첫 폴링 즉시 실행
  try { refreshStatusQuiet(); } catch { /* noop */ }
  setTimeout(checkAndEmit, 3000);
}

function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function checkAndEmit(): void {
  if (handlers.size === 0) return;
  const snapshots = getServiceSnapshots();
  const hash = JSON.stringify(snapshots);
  if (hash === lastEmittedHash) return;
  lastEmittedHash = hash;

  const event: ServiceStatusEvent = {
    snapshots,
    timestamp: Date.now(),
  };
  for (const handler of handlers) {
    try {
      handler(event);
    } catch {
      // 핸들러 에러는 무시
    }
  }
}
