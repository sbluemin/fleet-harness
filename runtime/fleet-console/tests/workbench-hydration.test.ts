import { afterEach, expect, it, vi } from "vitest";

import * as workbench from "../features/workspace/client/conversation/workbench/workbench-store.js";
import { EMPTY_WORKBENCH_LAYOUT, workbenchTiles, type WorkbenchLayout, type WorkbenchWrite } from "../features/workspace/shared/conversation-workbench.js";

const key = "session:commodore:commodore:owner";
const stored: WorkbenchLayout = {
  ...EMPTY_WORKBENCH_LAYOUT,
  columns: [{ tiles: [
    { id: "files", kind: "entry", entryId: "file-explorer" },
    { id: "shell", kind: "surface", surfaceId: "shell", params: { tab: "saved" } },
    { id: "repository", kind: "surface", surfaceId: "repository", params: {} },
  ], weights: [2, 1, 3] }],
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

// 확대 표면의 탭 복원 검사는 서버 작업대의 GET/PUT 경합을 지나지 않는다.
// 읽기보다 먼저 온 도구 열기·변경이 다른 칸을 영구 삭제하지 않는 저장 무결성 경계를 검증한다.
it("applies startup edits to the saved workbench before persisting, including a reused tool on reload", async () => {
  vi.useFakeTimers();
  const api = server();
  workbench.setWorkbenchConversation(key);
  workbench.loadWorkbenchLayouts();
  workbench.openWorkbenchEntry("codex");
  workbench.setWorkbenchSplitRatio(0.7);
  const shell = workbench.openWorkbenchSurface({ surfaceId: "shell", params: { tab: "linked" } });
  workbench.replaceWorkbenchTileParams(shell, { tab: "updated" });
  const closed = workbench.openWorkbenchSurface({ surfaceId: "shell", mode: "split" });
  workbench.closeWorkbenchTile(closed, { confirmed: true });
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
    { ...stored.columns[0]!.tiles[1], params: { tab: "updated" } },
    stored.columns[0]!.tiles[2],
    expect.objectContaining({ kind: "entry", entryId: "codex" }),
  ]);
  expect(layout.columns[0]!.weights).toEqual([2, 1, 3]);
  expect(layout.splitRatio).toBe(0.7);
  workbench.flushWorkbenchSaves();
  expect(api.writes.find((write) => write.key === key)?.layout).toEqual(layout);

  workbench.resetWorkbenchForTest();
  workbench.setWorkbenchConversation(key);
  workbench.loadWorkbenchLayouts();
  workbench.openWorkbenchEntry("codex");
  await api.hydrate();
  expect(workbench.getWorkbenchLayout()).toEqual(layout);
  expect(workbench.getWorkbenchFocusedTileId()).toBe(workbenchTiles(layout).find((tile) => tile.kind === "entry" && tile.entryId === "codex")!.id);
});

it("does not overwrite an unread layout after a failed load and retries the pending edits", async () => {
  vi.useFakeTimers();
  const api = server();
  workbench.setWorkbenchConversation(key);
  workbench.loadWorkbenchLayouts();
  workbench.openWorkbenchEntry("codex");
  await api.hydrate(false);
  await vi.advanceTimersByTimeAsync(1_000);
  workbench.flushWorkbenchSaves();
  expect(api.writes).toEqual([]);

  workbench.loadWorkbenchLayouts();
  await api.hydrate();
  workbench.flushWorkbenchSaves();
  expect(workbenchTiles(api.writes[0]!.layout!)).toEqual([
    ...workbenchTiles(stored),
    expect.objectContaining({ kind: "entry", entryId: "codex" }),
  ]);
});
