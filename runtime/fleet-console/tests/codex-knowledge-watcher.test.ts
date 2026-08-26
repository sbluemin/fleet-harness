import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCodexKnowledgeWatcher } from "../core/host/codex/knowledge-watcher.js";
import type { KnowledgeWatcherFactory, KnowledgeWatcherHandle } from "../core/host/codex/knowledge-watcher.js";
import type { CodexKnowledgeScope, CodexWatchState } from "../core/host/codex/contracts.js";

interface FakeWatcher extends KnowledgeWatcherHandle {
  readonly watchPath: string;
  readonly recursive: boolean;
  emit(event: string, filename: string | null): void;
  fail(): void;
  closed: boolean;
}

const ROOT = path.join("/tmp", "codex-knowledge");

function createHarness(options?: { platform?: NodeJS.Platform; failFor?: (target: string) => boolean }) {
  const watchers: FakeWatcher[] = [];
  const changes: Array<{ workspaceId: string; scopes: readonly CodexKnowledgeScope[] }> = [];
  const states: Array<{ workspaceId: string; state: CodexWatchState }> = [];

  const factory: KnowledgeWatcherFactory = (watchPath, opts, callback) => {
    if (options?.failFor?.(watchPath)) throw new Error("ENOENT");
    let errorListener: ((error: Error) => void) | null = null;
    const watcher: FakeWatcher = {
      watchPath,
      recursive: opts.recursive,
      closed: false,
      close() { watcher.closed = true; },
      on(_event, listener) { errorListener = listener; return watcher; },
      emit(event, filename) { callback(event, filename); },
      fail() { errorListener?.(new Error("watch failed")); },
    };
    watchers.push(watcher);
    return watcher;
  };

  const watcher = createCodexKnowledgeWatcher({
    onChange: (workspaceId, scopes) => { changes.push({ workspaceId, scopes }); },
    onState: (workspaceId, state) => { states.push({ workspaceId, state }); },
    watcherFactory: factory,
    debounceMs: 50,
    platform: options?.platform ?? "darwin",
  });

  return { watcher, watchers, changes, states };
}

describe("codex knowledge watcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("maps a queued draft to the queue scope and reports watching", () => {
    const h = createHarness();
    h.watcher.watch("ws1", ROOT);

    expect(h.states).toEqual([{ workspaceId: "ws1", state: "watching" }]);
    h.watchers[0]!.emit("rename", path.join("queue", "2026-08-26T00-00-00-000Z-abcdef01", "patch.md"));
    vi.advanceTimersByTime(50);

    expect(h.changes).toEqual([{ workspaceId: "ws1", scopes: ["queue"] }]);
  });

  it("collapses one approval's many writes into a single notification", () => {
    const h = createHarness();
    h.watcher.watch("ws1", ROOT);
    const root = h.watchers[0]!;

    // 승인 한 번은 queue -> archive 이동, wiki 쓰기, 인덱스 재작성을 연달아 일으킨다.
    root.emit("rename", path.join("queue", "patch-a"));
    root.emit("rename", path.join("archive", "patch-a"));
    root.emit("change", path.join("wiki", "storm-watch.md"));
    root.emit("change", "index.json");
    vi.advanceTimersByTime(49);
    expect(h.changes).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(h.changes).toHaveLength(1);
    expect([...h.changes[0]!.scopes].sort()).toEqual(["index", "queue", "wiki"]);
  });

  it("ignores raw evidence and log writes so bulk sources cannot storm the channel", () => {
    const h = createHarness();
    h.watcher.watch("ws1", ROOT);
    const root = h.watchers[0]!;

    root.emit("change", path.join("raw", "2026-08-26-storm-watch-source.md"));
    root.emit("change", "log.md");
    vi.advanceTimersByTime(100);

    expect(h.changes).toEqual([]);
  });

  /**
   * 감시 대상이 사라지면 fs.watch는 error를 던진다. 리스너가 없으면 unhandled 'error'가
   * 콘솔 프로세스를 끌어내리므로, 등록 여부는 이 테스트가 지킨다.
   */
  it("degrades instead of throwing when a watcher errors", () => {
    const h = createHarness();
    h.watcher.watch("ws1", ROOT);
    h.states.length = 0;

    expect(() => h.watchers[0]!.fail()).not.toThrow();
    expect(h.states).toEqual([{ workspaceId: "ws1", state: "degraded" }]);
    expect(h.watcher.stateOf("ws1")).toBe("degraded");
    expect(h.watchers.every((w) => w.closed)).toBe(true);
  });

  it("reports degraded when the knowledge root cannot be watched at all", () => {
    const h = createHarness({ failFor: (target) => target === ROOT });
    h.watcher.watch("ws1", ROOT);

    expect(h.states).toEqual([{ workspaceId: "ws1", state: "degraded" }]);
  });

  it("stops delivering after unwatch", () => {
    const h = createHarness();
    h.watcher.watch("ws1", ROOT);
    const root = h.watchers[0]!;
    h.watcher.unwatch("ws1");

    root.emit("change", "index.json");
    vi.advanceTimersByTime(100);

    expect(h.changes).toEqual([]);
    expect(root.closed).toBe(true);
    expect(h.watcher.stateOf("ws1")).toBeNull();
  });

  it("keeps a repeated watch of the same root idempotent", () => {
    const h = createHarness();
    h.watcher.watch("ws1", ROOT);
    const created = h.watchers.length;
    h.watcher.watch("ws1", ROOT);

    expect(h.watchers).toHaveLength(created);
    expect(h.states).toEqual([{ workspaceId: "ws1", state: "watching" }]);
  });

  it("watches each directory separately where recursive watching is unavailable", () => {
    const h = createHarness({ platform: "linux" });
    h.watcher.watch("ws1", ROOT);

    const targets = h.watchers.map((w) => w.watchPath);
    expect(targets).toContain(ROOT);
    expect(targets).toContain(path.join(ROOT, "queue"));
    expect(targets).toContain(path.join(ROOT, "wiki"));
    expect(h.watchers.every((w) => w.recursive === false)).toBe(true);

    const queueWatcher = h.watchers.find((w) => w.watchPath === path.join(ROOT, "queue"))!;
    queueWatcher.emit("rename", "2026-08-26T00-00-00-000Z-abcdef01");
    vi.advanceTimersByTime(50);
    expect(h.changes).toEqual([{ workspaceId: "ws1", scopes: ["queue"] }]);
  });

  it("arms a directory that appears later on a non-recursive platform", () => {
    const missing = path.join(ROOT, "conflicts");
    let conflictsExists = false;
    const h = createHarness({
      platform: "linux",
      failFor: (target) => target === missing && !conflictsExists,
    });
    h.watcher.watch("ws1", ROOT);
    expect(h.watchers.some((w) => w.watchPath === missing)).toBe(false);

    conflictsExists = true;
    const root = h.watchers.find((w) => w.watchPath === ROOT)!;
    root.emit("rename", "conflicts");
    vi.advanceTimersByTime(50);

    expect(h.watchers.some((w) => w.watchPath === missing)).toBe(true);
    expect(h.changes.at(-1)?.scopes).toContain("conflicts");
  });

  /**
   * 감시는 화면보다 먼저 시작될 수 있다. 이벤트만으로는 그 뒤에 붙은 화면이 "감시 중"이라는
   * 사실을 영영 알 수 없어, 살아 있는 감시를 "연결 전"으로 표시하게 된다.
   */
  it("exposes a snapshot so a late subscriber learns the current state", () => {
    const h = createHarness();
    h.watcher.watch("ws1", ROOT);
    h.watcher.watch("ws2", path.join(ROOT, "other"));
    h.watchers.find((w) => w.watchPath === path.join(ROOT, "other"))!.fail();

    expect(h.watcher.snapshot()).toEqual([
      { workspaceId: "ws1", state: "watching" },
      { workspaceId: "ws2", state: "degraded" },
    ]);

    h.watcher.unwatch("ws1");
    expect(h.watcher.snapshot()).toEqual([{ workspaceId: "ws2", state: "degraded" }]);
  });

  it("drops every watcher on disposeAll", () => {
    const h = createHarness();
    h.watcher.watch("ws1", ROOT);
    h.watcher.watch("ws2", path.join(ROOT, "other"));
    h.watcher.disposeAll();

    expect(h.watchers.every((w) => w.closed)).toBe(true);
    expect(h.watcher.stateOf("ws1")).toBeNull();
    expect(h.watcher.stateOf("ws2")).toBeNull();
  });
});
