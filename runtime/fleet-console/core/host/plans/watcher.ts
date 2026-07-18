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
  subscribe(watchPath: string, onChange: () => void): () => void;
}

interface WatchEntry {
  readonly watcher: PlansWatcherHandle;
  readonly subscribers: Set<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

export const PLANS_WATCH_DEBOUNCE_MS = 200;

export function createPlansWatcherRegistry(
  watcherFactory: PlansWatcherFactory = (watchPath, options, listener) => fs.watch(watchPath, options, listener),
  debounceMs = PLANS_WATCH_DEBOUNCE_MS,
): PlansWatcherRegistry {
  const entries = new Map<string, WatchEntry>();

  return {
    subscribe(watchPath, onChange) {
      let entry: WatchEntry | null | undefined = entries.get(watchPath);
      if (!entry) {
        entry = createEntry(watchPath);
        if (!entry) return () => {};
        entries.set(watchPath, entry);
      }
      entry.subscribers.add(onChange);
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        entry.subscribers.delete(onChange);
        if (entry.subscribers.size !== 0) return;
        closeEntry(watchPath, entry);
      };
    },
  };

  function createEntry(watchPath: string): WatchEntry | null {
    const subscribers = new Set<() => void>();
    let entry: WatchEntry;
    try {
      const watcher = watcherFactory(watchPath, { recursive: false }, () => {
        if (entry.closed) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          for (const subscriber of entry.subscribers) subscriber();
        }, debounceMs);
      });
      entry = { watcher, subscribers, timer: null, closed: false };
      watcher.on("error", () => closeEntry(watchPath, entry));
      return entry;
    } catch {
      return null;
    }
  }

  function closeEntry(watchPath: string, entry: WatchEntry): void {
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
  }
}
