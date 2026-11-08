import { afterEach, expect, it, vi } from "vitest";

import * as workbench from "../features/workspace/client/conversation/workbench/workbench-store.js";
import { EMPTY_WORKBENCH_LAYOUT, sanitizeWorkbenchLayout, workbenchTiles, type WorkbenchLayout, type WorkbenchWrite } from "../features/workspace/shared/conversation-workbench.js";

const key = "session:commodore:commodore:owner";
const stored: WorkbenchLayout = {
  ...EMPTY_WORKBENCH_LAYOUT,
  columns: [{ tiles: [
    { id: "browser", kind: "browser" },
    { id: "objectives", kind: "entry", entryId: "objectives" },
  ], weights: [3, 1] }],
  columnWeights: [1],
  splitRatio: 0.6,
};

function server() {
  let read!: (response: Response) => void;
  const writes: WorkbenchWrite[] = [];
  let saved = stored;
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      const write = JSON.parse(String(init.body)) as WorkbenchWrite;
      writes.push(write);
      if (write.key === key) saved = write.layout ?? EMPTY_WORKBENCH_LAYOUT;
      return Promise.resolve(new Response("{}"));
    }
    return new Promise<Response>((resolve) => { read = resolve; });
  }));
  return {
    writes,
    async hydrate(ok = true) {
      read(new Response(JSON.stringify({ layouts: { [key]: { layout: saved, updatedAt: 1 } } }), { status: ok ? 200 : 503 }));
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

afterEach(() => {
  workbench.resetWorkbenchForTest();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// 서버 작업대의 GET/PUT 경합을 지나지 않는다. 읽기보다 먼저 온 도구 열기·닫기가
// 다른 칸을 영구 삭제하지 않는 저장 무결성 경계를 검증한다.
it("applies startup edits to the saved workbench before persisting, including a reused tool on reload", async () => {
  vi.useFakeTimers();
  const api = server();
  workbench.setWorkbenchConversation(key);
  workbench.loadWorkbenchLayouts();
  workbench.openWorkbenchEntry("commodore");
  workbench.setWorkbenchSplitRatio(0.7);
  workbench.openWorkbenchBrowser();
  workbench.openWorkbenchEntry("quota");
  workbench.closeWorkbenchEntry("quota");
  workbench.setWorkbenchConversation("another-owner");
  workbench.openWorkbenchBrowser();
  await vi.advanceTimersByTimeAsync(1_000);
  workbench.flushWorkbenchSaves();
  expect(api.writes).toEqual([]);

  await api.hydrate();
  expect(workbench.getWorkbenchKey()).toBe("another-owner");
  expect(workbenchTiles(workbench.getWorkbenchLayout())).toMatchObject([{ kind: "browser" }]);
  workbench.setWorkbenchConversation(key);
  const layout = workbench.getWorkbenchLayout();
  expect(workbenchTiles(layout)).toEqual([
    stored.columns[0]!.tiles[0],
    stored.columns[0]!.tiles[1],
    expect.objectContaining({ kind: "entry", entryId: "commodore" }),
  ]);
  expect(layout.columns[0]!.weights).toEqual([3, 1, 2]);
  expect(layout.splitRatio).toBe(0.7);
  workbench.flushWorkbenchSaves();
  expect(api.writes.find((write) => write.key === key)?.layout).toEqual(layout);

  workbench.resetWorkbenchForTest();
  workbench.setWorkbenchConversation(key);
  workbench.loadWorkbenchLayouts();
  workbench.openWorkbenchEntry("commodore");
  await api.hydrate();
  expect(workbench.getWorkbenchLayout()).toEqual(layout);
  expect(workbench.getWorkbenchFocusedTileId()).toBe(workbenchTiles(layout).find((tile) => tile.kind === "entry" && tile.entryId === "commodore")!.id);
});

it("does not overwrite an unread layout after a failed load and retries the pending edits", async () => {
  vi.useFakeTimers();
  const api = server();
  workbench.setWorkbenchConversation(key);
  workbench.loadWorkbenchLayouts();
  workbench.openWorkbenchEntry("commodore");
  await api.hydrate(false);
  await vi.advanceTimersByTimeAsync(1_000);
  workbench.flushWorkbenchSaves();
  expect(api.writes).toEqual([]);

  workbench.loadWorkbenchLayouts();
  await api.hydrate();
  workbench.flushWorkbenchSaves();
  expect(workbenchTiles(api.writes[0]!.layout!)).toEqual([
    ...workbenchTiles(stored),
    expect.objectContaining({ kind: "entry", entryId: "commodore" }),
  ]);
});

// 브라우저는 Console 에 하나라 도킹한 칸의 열림·닫힘도 대화를 따라간다 — 어느 대화에서든 사람이 열고 닫은 것이 다음 대화(처음 가는 대화 포함)에 이어진다.
it("carries the docked browser's open or closed state across conversations", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => Promise.resolve(init?.method === "PUT"
    ? new Response("{}")
    : new Response(JSON.stringify({ layouts: { alpha: { layout: stored, updatedAt: 1 } } })))));
  workbench.setWorkbenchConversation("alpha");
  workbench.loadWorkbenchLayouts();
  await vi.advanceTimersByTimeAsync(0);
  expect(workbench.isWorkbenchBrowserShown()).toBe(true);

  workbench.setWorkbenchConversation("bravo");
  expect(workbench.isWorkbenchBrowserShown()).toBe(true);
  workbench.closeWorkbenchBrowser();
  workbench.setWorkbenchConversation("alpha");
  expect(workbench.isWorkbenchBrowserShown()).toBe(false);
  expect(workbenchTiles(workbench.getWorkbenchLayout()).map((tile) => tile.kind)).toEqual(["entry"]);
  workbench.setWorkbenchConversation("never-visited");
  expect(workbench.isWorkbenchBrowserShown()).toBe(false);

  workbench.openWorkbenchBrowser();
  workbench.setWorkbenchConversation("bravo");
  expect(workbench.isWorkbenchBrowserShown()).toBe(true);
});

// 브라우저 칸은 펼치지 않는다 — 예전에 저장된 펼침이 브라우저 칸을 가리켜도 펼친 채로 남지 않고, 다른 칸의 펼침은 그대로 읽힌다.
it("reads a saved expansion of the browser tile as not expanded", () => {
  expect(sanitizeWorkbenchLayout({ ...stored, expandedTileId: "browser" })?.expandedTileId).toBeNull();
  expect(sanitizeWorkbenchLayout({ ...stored, expandedTileId: "objectives" })?.expandedTileId).toBe("objectives");
});

// 퇴역 진입점·표면(#2343 Files·Repository·Shell, #2035 Skills, 관측된 "files")은
// 저장된 배치에서 걷어낸다 — 남은 칸이 빈 패널 안내로 그려지지 않게 저장 무결성을 지킨다.
it("drops retired entry and surface tiles from saved layouts", () => {
  const layout = sanitizeWorkbenchLayout({
    columns: [
      { tiles: [
        { id: "r1", kind: "entry", entryId: "codex" },
        { id: "r2", kind: "entry", entryId: "files" },
        { id: "r3", kind: "entry", entryId: "skills" },
      ], weights: [1, 1, 1] },
      { tiles: [
        { id: "r4", kind: "entry", entryId: "file-explorer" },
        { id: "r5", kind: "entry", entryId: "repository" },
        { id: "r6", kind: "entry", entryId: "global-shell" },
      ], weights: [1, 1, 1] },
      { tiles: [
        { id: "r7", kind: "surface", surfaceId: "repository", params: {} },
        { id: "r8", kind: "surface", surfaceId: "shell", params: {} },
        { id: "live", kind: "entry", entryId: "objectives" },
      ], weights: [1, 1, 1] },
    ],
    columnWeights: [1, 1, 1],
    below: { tiles: [{ id: "live-below", kind: "entry", entryId: "commodore" }], weights: [1] },
    splitRatio: null,
    belowRatio: null,
    expandedTileId: null,
  });
  expect(workbenchTiles(layout!)).toEqual([
    { id: "live", kind: "entry", entryId: "objectives" },
    { id: "live-below", kind: "entry", entryId: "commodore" },
  ]);
});
