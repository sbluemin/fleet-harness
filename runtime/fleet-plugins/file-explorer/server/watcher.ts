import fs from "node:fs";
import path from "node:path";

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
  trackDirectory(theaterId: string, theaterPath: string, relativePath: string): Promise<void>;
}

interface WatcherEntry {
  readonly recursive: boolean;
  readonly watchers: Map<string, WatcherHandle>;
  readonly subscribers: Set<WatchChangeCallback>;
  readonly stateSubscribers: Set<WatchStateCallback>;
  subscriberCount: number;
  readonly debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
}

// 서버 측 debounce 간격 — 이벤트 폭풍 흡수
const DEBOUNCE_MS = 200;
const LINUX_DIRECTORY_WATCH_CAP = 1_024;

// 기본 싱글턴 레지스트리 — handlers.ts에서 사용 (함수 선언 호이스팅에 의존)
export const watcherRegistry: WatcherRegistry = createWatcherRegistry();

export function createWatcherRegistry(
  watcherFactory: WatcherFactory = (p, opts, cb) =>
    fs.watch(p, opts, (ev, fn) => cb(ev, typeof fn === "string" ? fn : null)),
  debounceMs = DEBOUNCE_MS,
  platform: NodeJS.Platform = process.platform,
): WatcherRegistry {
  const entries = new Map<string, WatcherEntry>();

  function scheduleChange(entry: WatcherEntry, relDir: string): void {
    const pending = entry.debounceTimers.get(relDir);
    if (pending) clearTimeout(pending);
    entry.debounceTimers.set(
      relDir,
      setTimeout(() => {
        entry.debounceTimers.delete(relDir);
        for (const sub of entry.subscribers) sub(relDir);
      }, debounceMs),
    );
  }

  function closeEntry(entry: WatcherEntry): void {
    for (const timer of entry.debounceTimers.values()) clearTimeout(timer);
    entry.debounceTimers.clear();
    for (const watcher of entry.watchers.values()) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    entry.watchers.clear();
  }

  function startWatcher(
    theaterId: string,
    entry: WatcherEntry,
    watchKey: string,
    watchPath: string,
  ): void {
    let activeWatcher: WatcherHandle | null = null;
    const watcher = watcherFactory(watchPath, { recursive: entry.recursive }, (event, filename) => {
      const currentWatcher = activeWatcher;
      if (!currentWatcher || entry.watchers.get(watchKey) !== currentWatcher) return;
      scheduleChange(entry, entry.recursive ? computeRelDir(filename) : watchKey);

      // Linux watcher는 inode를 추적하므로 디렉터리 교체 후 새 inode를 보지 못한다.
      // rename 시 등록을 비워 다음 성공적인 folder list가 새 watcher를 만들게 한다.
      if (!entry.recursive && watchKey !== "" && event === "rename") {
        entry.watchers.delete(watchKey);
        try { currentWatcher.close(); } catch { /* already closed */ }
      }
    });
    activeWatcher = watcher;
    entry.watchers.set(watchKey, watcher);

    watcher.on("error", () => {
      if (entry.watchers.get(watchKey) !== watcher) return;
      try { watcher.close(); } catch { /* already closed */ }
      entry.watchers.delete(watchKey);

      if (watchKey === "") {
        closeEntry(entry);
        if (entries.get(theaterId) === entry) entries.delete(theaterId);
      } else {
        const pending = entry.debounceTimers.get(watchKey);
        if (pending) clearTimeout(pending);
        entry.debounceTimers.delete(watchKey);
      }
      for (const notify of entry.stateSubscribers) notify("degraded");
    });
  }

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
        closeEntry(entry);
        // error 이후 교체된 새 entry를 지우지 않도록 동일 entry일 때만 제거한다
        if (entries.get(theaterId) === entry) entries.delete(theaterId);
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

    const entry: WatcherEntry = {
      // Linux의 recursive fs.watch fallback은 구독 시 전체 트리를 동기 순회한다.
      // 대신 root와 실제로 조회된 디렉터리만 개별 비재귀 watcher로 추적한다.
      recursive: platform !== "linux",
      watchers: new Map(),
      subscribers: new Set([onChange]),
      stateSubscribers: new Set([onState]),
      subscriberCount: 1,
      debounceTimers: new Map(),
    };

    try {
      startWatcher(theaterId, entry, "", theaterPath);
    } catch {
      // fs.watch 미지원 플랫폼: graceful degrade — 감시 불가 상태만 알리고 연결 유지
      onState("degraded");
      return () => {};
    }

    entries.set(theaterId, entry);
    onState("watching");
    return makeUnsubscribe(theaterId, onChange, onState, entry);
  }

  async function trackDirectory(theaterId: string, theaterPath: string, relativePath: string): Promise<void> {
    const entry = entries.get(theaterId);
    if (!entry || entry.recursive || relativePath === "" || entry.watchers.has(relativePath)) return;
    if (entry.watchers.size >= LINUX_DIRECTORY_WATCH_CAP) {
      for (const notify of entry.stateSubscribers) notify("degraded");
      return;
    }

    const targetPath = await resolveTrackedDirectory(theaterPath, relativePath);
    if (!targetPath) return;

    // realpath 대기 중 구독이 끝났거나 같은 디렉터리가 먼저 등록됐을 수 있다.
    if (
      entries.get(theaterId) !== entry
      || entry.watchers.has(relativePath)
      || entry.watchers.size >= LINUX_DIRECTORY_WATCH_CAP
    ) return;
    try {
      startWatcher(theaterId, entry, relativePath, targetPath);
    } catch {
      for (const notify of entry.stateSubscribers) notify("degraded");
    }
  }

  return { subscribe, trackDirectory };
}

async function resolveTrackedDirectory(theaterPath: string, relativePath: string): Promise<string | null> {
  const resolvedRoot = path.resolve(theaterPath);
  const targetPath = path.resolve(resolvedRoot, relativePath);
  if (!isWithinRoot(targetPath, resolvedRoot)) return null;

  try {
    const [realRoot, realTarget] = await Promise.all([
      fs.promises.realpath(theaterPath),
      fs.promises.realpath(targetPath),
    ]);
    return isWithinRoot(realTarget, realRoot) ? realTarget : null;
  } catch {
    return null;
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function computeRelDir(filename: string | null): string {
  if (!filename) return "";
  // 구분자를 변환하지 않는다 — files/list의 relativePath(path.relative, OS-native 구분자)와
  // 동일한 형태여야 클라이언트의 expandedDirs 비교가 Windows에서도 일치한다.
  const lastSep = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  // 루트 레벨 파일(구분자 없음 또는 맨 앞에만)이면 루트 dir('')로
  if (lastSep <= 0) return "";
  return filename.slice(0, lastSep);
}
