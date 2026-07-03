import type { TerminalRuntime } from "../shared/runtime.js";

interface PendingEntry {
  readonly input: string;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PendingInitialInputQueue {
  enqueue(sessionId: string, input: string): void;
  disarm(sessionId: string): void;
  cleanup(): void;
}

export function createPendingInitialInputQueue(deps: {
  readonly terminalRuntime: TerminalRuntime;
  readonly graceMs?: number;
}): PendingInitialInputQueue {
  const { terminalRuntime, graceMs = 200 } = deps;
  const pending = new Map<string, PendingEntry>();

  function enqueue(sessionId: string, input: string): void {
    disarm(sessionId);
    // \r\n\t 제거 후 빈 입력은 무시
    const sanitized = input.replace(/[\r\n\t]+/g, " ").trim();
    if (!sanitized) return;
    const entry: PendingEntry = { input: sanitized, timer: null };
    pending.set(sessionId, entry);
    // attach 성공 직후 graceMs 대기 후 flush — CLI 프롬프트 준비 시간 흡수
    entry.timer = setTimeout(() => {
      pending.delete(sessionId);
      terminalRuntime.write(sessionId, sanitized + "\n");
    }, graceMs);
  }

  function disarm(sessionId: string): void {
    const entry = pending.get(sessionId);
    if (!entry) return;
    if (entry.timer !== null) clearTimeout(entry.timer);
    pending.delete(sessionId);
  }

  function cleanup(): void {
    for (const sessionId of pending.keys()) disarm(sessionId);
  }

  return { enqueue, disarm, cleanup };
}
