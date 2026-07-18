import fs from "node:fs";

export interface PlansWatcherHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type PlansWatcherFactory = (
  watchPath: string,
  options: { readonly recursive: boolean },
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => PlansWatcherHandle;

export interface PlansWatcherRegistry {
  subscribe(watchPath: string, onChange: () => void, onClose: () => void): () => void;
}

export interface PlansWatchDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface WatchSubscriber {
  readonly onChange: () => void;
  readonly onClose: () => void;
}

interface WatchEntry {
  readonly watcher: PlansWatcherHandle;
  readonly subscribers: Set<WatchSubscriber>;
  readonly identity: PlansWatchDirectoryIdentity | null;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

export const PLANS_WATCH_DEBOUNCE_MS = 200;

export function createPlansWatcherRegistry(
  watcherFactory: PlansWatcherFactory = (watchPath, options, listener) => fs.watch(watchPath, options, listener),
  debounceMs = PLANS_WATCH_DEBOUNCE_MS,
  directoryIdentity: (watchPath: string) => PlansWatchDirectoryIdentity | null = (watchPath) => {
    try {
      const stat = fs.statSync(watchPath);
      return { dev: stat.dev, ino: stat.ino };
    } catch {
      return null;
    }
  },
): PlansWatcherRegistry {
  const entries = new Map<string, WatchEntry>();

  return {
    subscribe(watchPath, onChange, onClose) {
      let entry: WatchEntry | null | undefined = entries.get(watchPath);
      if (!entry) {
        entry = createEntry(watchPath);
        if (!entry) {
          onClose();
          return () => {};
        }
        entries.set(watchPath, entry);
      }
      const subscriber = { onChange, onClose };
      entry.subscribers.add(subscriber);
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        entry.subscribers.delete(subscriber);
        if (entry.subscribers.size !== 0) return;
        closeEntry(watchPath, entry);
      };
    },
  };

  function createEntry(watchPath: string): WatchEntry | null {
    const subscribers = new Set<WatchSubscriber>();
    let entry: WatchEntry;
    try {
      const watcher = watcherFactory(watchPath, { recursive: false }, () => {
        if (entry.closed) return;
        // 감시 대상 디렉터리가 삭제·교체되면 fs.watch는 죽은 inode에 붙은 채 이후 이벤트를
        // 놓친다. 빠른 rm -rf && mkdir 교체는 이벤트 도착 시점에 경로가 이미 다시 존재하므로
        // 존재 여부가 아니라 watch 시점에 캡처한 dev/ino 아이덴티티와 비교해 판별한다 —
        // 불일치·소실이면 구독을 종료 전파해 SSE를 닫고, 클라이언트 재연결 경로가
        // 재생성된 디렉터리로 새 워처를 붙이게 한다.
        const current = directoryIdentity(watchPath);
        if (!current || entry.identity === null || current.dev !== entry.identity.dev || current.ino !== entry.identity.ino) {
          closeEntry(watchPath, entry, true);
          return;
        }
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          for (const subscriber of entry.subscribers) subscriber.onChange();
        }, debounceMs);
      });
      entry = { watcher, subscribers, identity: directoryIdentity(watchPath), timer: null, closed: false };
      watcher.on("error", () => closeEntry(watchPath, entry, true));
      return entry;
    } catch {
      return null;
    }
  }

  function closeEntry(watchPath: string, entry: WatchEntry, notifySubscribers = false): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    try {
      entry.watcher.close();
    } catch {
      // A platform watcher can already be closed when its error event arrives.
    }
    if (entries.get(watchPath) === entry) entries.delete(watchPath);
    if (notifySubscribers) {
      for (const subscriber of entry.subscribers) subscriber.onClose();
    }
  }
}
