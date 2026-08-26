import fs from "node:fs";
import path from "node:path";

import type { CodexKnowledgeScope, CodexWatchState } from "./contracts.js";

/**
 * fs.FSWatcher 중 이 레지스트리가 실제로 쓰는 최소 계약 — 테스트 mock은 이 형태만 만족하면 된다.
 */
export interface KnowledgeWatcherHandle {
  close(): void;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type KnowledgeWatcherFactory = (
  watchPath: string,
  options: { recursive: boolean },
  callback: (event: string, filename: string | null) => void,
) => KnowledgeWatcherHandle;

export interface CodexKnowledgeWatcherDeps {
  /** 변화 범위 통지. 같은 tick의 여러 이벤트는 디바운스로 합쳐진다. */
  readonly onChange: (workspaceId: string, scopes: readonly CodexKnowledgeScope[]) => void;
  /** 감시 상태 전이 통지. degraded는 이 워크스페이스가 더 이상 변화를 알릴 수 없다는 뜻이다. */
  readonly onState: (workspaceId: string, state: CodexWatchState) => void;
  readonly watcherFactory?: KnowledgeWatcherFactory;
  readonly debounceMs?: number;
  readonly platform?: NodeJS.Platform;
}

export interface CodexKnowledgeWatcher {
  /** 같은 워크스페이스에 대한 반복 호출은 무해하다(루트가 바뀐 경우에만 재무장). */
  watch(workspaceId: string, knowledgeRoot: string): void;
  unwatch(workspaceId: string): void;
  disposeAll(): void;
  /** 현재 감시 상태 — 새 SSE 구독자에게 첫 프레임으로 알려 주기 위한 조회. */
  stateOf(workspaceId: string): CodexWatchState | null;
  /**
   * 감시 중인 모든 워크스페이스의 상태. 이벤트만으로는 이미 감시가 시작된 뒤에 붙은 화면이
   * 그 사실을 영영 알 수 없다 — 새 구독자는 첫 프레임으로 현재 상태를 받는다.
   */
  snapshot(): ReadonlyArray<{ readonly workspaceId: string; readonly state: CodexWatchState }>;
}

interface WatchEntry {
  readonly knowledgeRoot: string;
  readonly recursive: boolean;
  readonly watchers: Map<string, KnowledgeWatcherHandle>;
  readonly pending: Set<CodexKnowledgeScope>;
  /** 아직 존재하지 않아 붙이지 못한 하위 디렉토리(비재귀 플랫폼에서만 쓰인다). */
  readonly missing: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  state: CodexWatchState;
}

// 서버측 디바운스 — 승인 한 번은 queue·archive·wiki·index를 연달아 건드린다.
const DEBOUNCE_MS = 200;

/**
 * 목록에 영향을 주는 지점만 본다. raw/는 불변 증거라 대량으로 쓰이고, log.md·cowork는
 * 카탈로그·대기열·상태 칩 중 무엇도 바꾸지 않는다 — 감시 범위를 넓히면 그 쓰기가 폭풍이 된다.
 */
const DIRECTORY_SCOPES: ReadonlyMap<string, CodexKnowledgeScope> = new Map([
  ["queue", "queue"],
  // 결정된 패치가 옮겨 가는 곳 — "결정됨" 이력이 여기서 자란다.
  ["archive", "queue"],
  ["wiki", "wiki"],
  ["conflicts", "conflicts"],
  ["schema", "schema"],
]);

const INDEX_FILENAME = "index.json";

export function createCodexKnowledgeWatcher(deps: CodexKnowledgeWatcherDeps): CodexKnowledgeWatcher {
  const watcherFactory: KnowledgeWatcherFactory = deps.watcherFactory
    ?? ((p, opts, cb) => fs.watch(p, opts, (event, filename) => cb(event, typeof filename === "string" ? filename : null)));
  const debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
  const platform = deps.platform ?? process.platform;
  // recursive 감시는 macOS·Windows만 지원한다. 그 밖에서는 디렉토리마다 하나씩 붙이며,
  // 패치 디렉토리 *안쪽* 수정(예: 대기 중 제안 본문 편집)은 놓칠 수 있다 — 목록에 드러나는
  // 추가·삭제·결정은 부모 디렉토리 이벤트로 그대로 잡힌다.
  const recursive = platform === "darwin" || platform === "win32";
  const entries = new Map<string, WatchEntry>();

  function scopeOf(relative: string): CodexKnowledgeScope | null {
    if (relative === "") return null;
    const normalized = relative.split(path.sep).join("/");
    const [head, ...rest] = normalized.split("/");
    if (head === INDEX_FILENAME && rest.length === 0) return "index";
    return DIRECTORY_SCOPES.get(head ?? "") ?? null;
  }

  function flush(workspaceId: string, entry: WatchEntry): void {
    entry.debounceTimer = null;
    if (entry.pending.size === 0) return;
    const scopes = [...entry.pending];
    entry.pending.clear();
    deps.onChange(workspaceId, scopes);
  }

  function schedule(workspaceId: string, entry: WatchEntry, scope: CodexKnowledgeScope): void {
    entry.pending.add(scope);
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => flush(workspaceId, entry), debounceMs);
  }

  function degrade(workspaceId: string, entry: WatchEntry): void {
    if (entry.state === "degraded") return;
    entry.state = "degraded";
    closeWatchers(entry);
    deps.onState(workspaceId, "degraded");
  }

  function closeWatchers(entry: WatchEntry): void {
    if (entry.debounceTimer !== null) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = null;
    }
    entry.pending.clear();
    for (const watcher of entry.watchers.values()) {
      try { watcher.close(); } catch { /* already closed */ }
    }
    entry.watchers.clear();
    entry.missing.clear();
  }

  /**
   * 감시 대상 소멸은 error 이벤트로 온다. 리스너가 없으면 unhandled 'error'가 되어
   * 콘솔 프로세스 전체를 끌어내린다 — 등록은 선택이 아니다.
   */
  function startWatcher(workspaceId: string, entry: WatchEntry, key: string, target: string): boolean {
    try {
      const watcher = watcherFactory(target, { recursive: entry.recursive }, (_event, filename) => {
        if (entry.watchers.get(key) !== watcher) return;
        if (entry.recursive) {
          const scope = scopeOf(filename ?? "");
          if (scope) schedule(workspaceId, entry, scope);
          return;
        }
        if (key === "") {
          const scope = scopeOf(filename ?? "");
          if (scope) schedule(workspaceId, entry, scope);
          // 루트 이벤트는 아직 없던 하위 디렉토리가 막 생겼다는 신호일 수 있다.
          if (entry.missing.size > 0) armMissing(workspaceId, entry);
          return;
        }
        const scope = DIRECTORY_SCOPES.get(key);
        if (scope) schedule(workspaceId, entry, scope);
      });
      watcher.on("error", () => degrade(workspaceId, entry));
      entry.watchers.set(key, watcher);
      return true;
    } catch {
      return false;
    }
  }

  function armMissing(workspaceId: string, entry: WatchEntry): void {
    for (const key of [...entry.missing]) {
      if (entry.watchers.has(key)) {
        entry.missing.delete(key);
        continue;
      }
      if (startWatcher(workspaceId, entry, key, path.join(entry.knowledgeRoot, key))) {
        entry.missing.delete(key);
        const scope = DIRECTORY_SCOPES.get(key);
        // 디렉토리가 생겼다는 사실 자체가 내용 변화다.
        if (scope) schedule(workspaceId, entry, scope);
      }
    }
  }

  function arm(workspaceId: string, entry: WatchEntry): void {
    if (!startWatcher(workspaceId, entry, "", entry.knowledgeRoot)) {
      degrade(workspaceId, entry);
      return;
    }
    if (entry.recursive) return;
    for (const key of DIRECTORY_SCOPES.keys()) {
      if (!startWatcher(workspaceId, entry, key, path.join(entry.knowledgeRoot, key))) {
        entry.missing.add(key);
      }
    }
  }

  return {
    watch(workspaceId, knowledgeRoot) {
      const existing = entries.get(workspaceId);
      if (existing) {
        if (existing.knowledgeRoot === knowledgeRoot && existing.state === "watching") return;
        closeWatchers(existing);
        entries.delete(workspaceId);
      }
      const entry: WatchEntry = {
        knowledgeRoot,
        recursive,
        watchers: new Map(),
        pending: new Set(),
        missing: new Set(),
        debounceTimer: null,
        state: "watching",
      };
      entries.set(workspaceId, entry);
      arm(workspaceId, entry);
      if (entry.state === "watching") deps.onState(workspaceId, "watching");
    },
    unwatch(workspaceId) {
      const entry = entries.get(workspaceId);
      if (!entry) return;
      closeWatchers(entry);
      entries.delete(workspaceId);
    },
    disposeAll() {
      for (const entry of entries.values()) closeWatchers(entry);
      entries.clear();
    },
    stateOf(workspaceId) {
      return entries.get(workspaceId)?.state ?? null;
    },
    snapshot() {
      return [...entries].map(([workspaceId, entry]) => ({ workspaceId, state: entry.state }));
    },
  };
}
