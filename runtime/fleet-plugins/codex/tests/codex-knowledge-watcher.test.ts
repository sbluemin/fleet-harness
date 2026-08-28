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

function createHarness(options?: {
  platform?: NodeJS.Platform;
  failFor?: (target: string) => boolean;
  directories?: Record<string, readonly string[]>;
}) {
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
    readDirectory: (target) => options?.directories?.[target] ?? [],
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

  /**
   * 지식 루트가 아직 없는 워크스페이스는 고장난 것이 아니라 비어 있을 뿐이다. degraded로
   * 알리면 화면은 놓친 변화가 있다고 믿고 주기 확인으로 강등하는데, 감시할 대상이 없다.
   */
  it("stays silent for a workspace whose knowledge root does not exist yet", () => {
    let rootExists = false;
    const h = createHarness({ failFor: (target) => target === ROOT && !rootExists });
    h.watcher.watch("ws1", ROOT);
    h.watcher.watch("ws1", ROOT);

    expect(h.states).toEqual([]);
    expect(h.watcher.stateOf("ws1")).toBeNull();
    expect(h.watcher.snapshot()).toEqual([]);

    rootExists = true;
    h.watcher.watch("ws1", ROOT);
    expect(h.states).toEqual([{ workspaceId: "ws1", state: "watching" }]);
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

  /**
   * 대기 중 제안의 본문 편집은 `queue/<patch-id>/patch.md`를 고쳐 쓴다. 부모 디렉토리만
   * 보면 편집된 제안이 낡은 채 화면에 남고, 읽는 사람이 못 본 내용을 승인하게 된다.
   */
  it("watches inside each queue entry where recursive watching is unavailable", () => {
    const queueDir = path.join(ROOT, "queue");
    const h = createHarness({
      platform: "linux",
      directories: { [queueDir]: ["patch-a", "patch-b"] },
    });
    h.watcher.watch("ws1", ROOT);

    const nested = h.watchers.find((w) => w.watchPath === path.join(queueDir, "patch-a"));
    expect(nested).toBeDefined();
    nested!.emit("change", "patch.md");
    vi.advanceTimersByTime(50);

    expect(h.changes).toEqual([{ workspaceId: "ws1", scopes: ["queue"] }]);
  });

  it("follows queue entries that appear and disappear", () => {
    const queueDir = path.join(ROOT, "queue");
    const directories: Record<string, readonly string[]> = { [queueDir]: ["patch-a"] };
    const h = createHarness({ platform: "linux", directories });
    h.watcher.watch("ws1", ROOT);
    const parent = h.watchers.find((w) => w.watchPath === queueDir)!;

    directories[queueDir] = ["patch-a", "patch-b"];
    parent.emit("rename", "patch-b");
    expect(h.watchers.some((w) => w.watchPath === path.join(queueDir, "patch-b"))).toBe(true);

    // 결정된 패치는 큐에서 archive로 옮겨 간다 — 남은 감시자는 정리되어야 한다.
    const goneWatcher = h.watchers.find((w) => w.watchPath === path.join(queueDir, "patch-a"))!;
    directories[queueDir] = ["patch-b"];
    parent.emit("rename", "patch-a");
    expect(goneWatcher.closed).toBe(true);
  });

  /**
   * 지식 루트는 첫 API 요청이 만든다. 그 전에 붙이려다 실패한 워크스페이스에 매 요청마다
   * degraded를 다시 알리면, 화면이 그때마다 전 범위 재검증에 들어가 요청이 부챗살처럼 퍼진다.
   */
  /**
   * 살아 있던 감시가 죽은 뒤에는 매 요청이 재무장을 시도한다. 그때마다 degraded를 다시
   * 알리면 화면이 그때마다 전 범위 재검증에 들어가 요청이 부챗살처럼 퍼진다.
   */
  it("does not re-announce a degraded workspace on every arming attempt", () => {
    let healthy = true;
    const h = createHarness({ failFor: (target) => target === ROOT && !healthy });
    h.watcher.watch("ws1", ROOT);
    expect(h.states).toEqual([{ workspaceId: "ws1", state: "watching" }]);

    healthy = false;
    h.watchers[0]!.fail();
    expect(h.states.at(-1)).toEqual({ workspaceId: "ws1", state: "degraded" });
    const announced = h.states.length;

    h.watcher.watch("ws1", ROOT);
    h.watcher.watch("ws1", ROOT);
    expect(h.states).toHaveLength(announced);

    // 되살아나면 그때는 승격을 알린다.
    healthy = true;
    h.watcher.watch("ws1", ROOT);
    expect(h.states.at(-1)).toEqual({ workspaceId: "ws1", state: "watching" });
  });

  /**
   * 충돌 해소는 `conflicts/<id>/meta.json`을 고쳐 쓴다 — 큐와 같은 이유로 부모만 보면
   * 다른 곳에서 해소된 충돌이 목록·상태 칩·열린 화면에 그대로 남는다.
   */
  it("watches inside each conflict record where recursive watching is unavailable", () => {
    const conflictsDir = path.join(ROOT, "conflicts");
    const h = createHarness({
      platform: "linux",
      directories: { [conflictsDir]: ["conflict-a"] },
    });
    h.watcher.watch("ws1", ROOT);

    const nested = h.watchers.find((w) => w.watchPath === path.join(conflictsDir, "conflict-a"));
    expect(nested).toBeDefined();
    nested!.emit("change", "meta.json");
    vi.advanceTimersByTime(50);

    expect(h.changes).toEqual([{ workspaceId: "ws1", scopes: ["conflicts"] }]);
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
