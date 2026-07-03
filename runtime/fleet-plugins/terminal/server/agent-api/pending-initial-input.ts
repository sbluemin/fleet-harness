import type { TerminalRuntime } from "../shared/runtime.js";

// 출력 정온(quiescence) 기반 초기 프롬프트 전달 — CLI가 부팅 중일 때 stdin 유실을 방지한다.
// settle 타이머: 출력이 올 때마다 리셋, maxWait 초과 시 강제 flush.
const SETTLE_MS = 700;
const CR_DELAY_MS = 250;
const MAX_WAIT_MS = 8_000;

interface PendingEntry {
  readonly input: string;
  settleTimer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  crTimer: ReturnType<typeof setTimeout> | null;
  readonly unsubscribeOutput: () => void;
}

export interface PendingInitialInputQueue {
  enqueue(sessionId: string, input: string): void;
  disarm(sessionId: string): void;
  cleanup(): void;
}

export function createPendingInitialInputQueue(deps: {
  readonly terminalRuntime: TerminalRuntime;
  readonly settleMs?: number;
  readonly crMs?: number;
  readonly maxWaitMs?: number;
}): PendingInitialInputQueue {
  const { terminalRuntime, settleMs = SETTLE_MS, crMs = CR_DELAY_MS, maxWaitMs = MAX_WAIT_MS } = deps;
  const pending = new Map<string, PendingEntry>();

  function flush(sessionId: string): void {
    const entry = pending.get(sessionId);
    if (!entry) return;
    if (entry.settleTimer !== null) clearTimeout(entry.settleTimer);
    if (entry.maxTimer !== null) clearTimeout(entry.maxTimer);
    entry.settleTimer = null;
    entry.maxTimer = null;
    entry.unsubscribeOutput();
    // (i) 텍스트 write
    terminalRuntime.write(sessionId, entry.input);
    // (ii) crMs 후 "\r"(Enter) write
    entry.crTimer = setTimeout(() => {
      pending.delete(sessionId);
      terminalRuntime.write(sessionId, "\r");
    }, crMs);
  }

  function enqueue(sessionId: string, input: string): void {
    disarm(sessionId);
    // \r\n\t 제거 후 빈 입력은 무시
    const sanitized = input.replace(/[\r\n\t]+/g, " ").trim();
    if (!sanitized) return;

    const entry: PendingEntry = {
      input: sanitized,
      settleTimer: null,
      maxTimer: null,
      crTimer: null,
      unsubscribeOutput: terminalRuntime.subscribeOutput((outputSessionId) => {
        if (outputSessionId !== sessionId) return;
        const e = pending.get(sessionId);
        if (!e) return;
        // 출력이 올 때마다 settle 타이머 리셋
        if (e.settleTimer !== null) clearTimeout(e.settleTimer);
        e.settleTimer = setTimeout(() => flush(sessionId), settleMs);
      }),
    };
    pending.set(sessionId, entry);

    // 총 대기 상한 — 초과 시 강제 flush
    entry.maxTimer = setTimeout(() => flush(sessionId), maxWaitMs);
  }

  function disarm(sessionId: string): void {
    const entry = pending.get(sessionId);
    if (!entry) return;
    if (entry.settleTimer !== null) clearTimeout(entry.settleTimer);
    if (entry.maxTimer !== null) clearTimeout(entry.maxTimer);
    if (entry.crTimer !== null) clearTimeout(entry.crTimer);
    entry.unsubscribeOutput();
    pending.delete(sessionId);
  }

  function cleanup(): void {
    for (const sessionId of [...pending.keys()]) disarm(sessionId);
  }

  return { enqueue, disarm, cleanup };
}
