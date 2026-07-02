import fs from "node:fs";

// fs.FSWatcher 중 레지스트리가 실제로 쓰는 최소 계약 — 테스트 mock이 이 형태만 만족하면 된다
export interface WatcherHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

// watcher 팩토리 타입 — 테스트에서 주입 가능
export type WatcherFactory = (
  watchPath: string,
  options: { recursive: boolean },
  callback: (event: string, filename: string | null) => void,
) => WatcherHandle;

export type WatchChangeCallback = (relDir: string) => void;
export type WatchStateCallback = (state: "watching" | "degraded") => void;

export interface WatcherRegistry {
  subscribe(
    theaterId: string,
    theaterPath: string,
    onChange: WatchChangeCallback,
    onState: WatchStateCallback,
  ): () => void;
}

interface WatcherEntry {
  readonly watcher: WatcherHandle;
  readonly subscribers: Set<WatchChangeCallback>;
  readonly stateSubscribers: Set<WatchStateCallback>;
  subscriberCount: number;
  readonly debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
}

// 서버 측 debounce 간격 — 이벤트 폭풍 흡수
const DEBOUNCE_MS = 200;

export function createWatcherRegistry(
  watcherFactory: WatcherFactory = (p, opts, cb) =>
    fs.watch(p, opts, (ev, fn) => cb(ev, typeof fn === "string" ? fn : null)),
  debounceMs = DEBOUNCE_MS,
): WatcherRegistry {
  const entries = new Map<string, WatcherEntry>();

  function makeUnsubscribe(
    theaterId: string,
    onChange: WatchChangeCallback,
    onState: WatchStateCallback,
    entry: WatcherEntry,
  ): () => void {
    let called = false;
    return () => {
      if (called) return;
      called = true;
      entry.subscribers.delete(onChange);
      entry.stateSubscribers.delete(onState);
      entry.subscriberCount--;
      if (entry.subscriberCount <= 0) {
        for (const t of entry.debounceTimers.values()) clearTimeout(t);
        entry.watcher.close();
        entries.delete(theaterId);
      }
    };
  }

  function subscribe(
    theaterId: string,
    theaterPath: string,
    onChange: WatchChangeCallback,
    onState: WatchStateCallback,
  ): () => void {
    const existing = entries.get(theaterId);
    if (existing) {
      existing.subscribers.add(onChange);
      existing.stateSubscribers.add(onState);
      existing.subscriberCount++;
      onState("watching");
      return makeUnsubscribe(theaterId, onChange, onState, existing);
    }

    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const subscribers = new Set<WatchChangeCallback>();
    const stateSubscribers = new Set<WatchStateCallback>();

    let watcher: WatcherHandle;
    try {
      watcher = watcherFactory(theaterPath, { recursive: true }, (_, filename) => {
        const relDir = computeRelDir(filename);
        const pending = debounceTimers.get(relDir);
        if (pending) clearTimeout(pending);
        debounceTimers.set(
          relDir,
          setTimeout(() => {
            debounceTimers.delete(relDir);
            for (const sub of subscribers) sub(relDir);
          }, debounceMs),
        );
      });
    } catch {
      // fs.watch 미지원 플랫폼: graceful degrade — 감시 불가 상태만 알리고 연결 유지
      onState("degraded");
      return () => {};
    }

    // 감시 런타임 오류(감시 대상 삭제 등): unhandled 'error'로 프로세스가 죽지 않도록
    // 구독자 전원에게 degrade를 알리고 watcher를 정리한다. SSE 연결 자체는 유지된다.
    watcher.on("error", () => {
      for (const t of debounceTimers.values()) clearTimeout(t);
      debounceTimers.clear();
      try { watcher.close(); } catch { /* 이미 닫힌 경우 무시 */ }
      entries.delete(theaterId);
      for (const notify of stateSubscribers) notify("degraded");
    });

    const entry: WatcherEntry = { watcher, subscribers, stateSubscribers, subscriberCount: 1, debounceTimers };
    entries.set(theaterId, entry);
    subscribers.add(onChange);
    stateSubscribers.add(onState);
    onState("watching");
    return makeUnsubscribe(theaterId, onChange, onState, entry);
  }

  return { subscribe };
}

// 기본 싱글턴 레지스트리 — handlers.ts에서 사용
export const watcherRegistry: WatcherRegistry = createWatcherRegistry();

function computeRelDir(filename: string | null): string {
  if (!filename) return "";
  // OS 구분자를 포워드슬래시로 정규화
  const normalized = filename.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  // 루트 레벨 파일(슬래시 없음 또는 맨 앞에만)이면 루트 dir('')로
  if (lastSlash <= 0) return "";
  return normalized.slice(0, lastSlash);
}
