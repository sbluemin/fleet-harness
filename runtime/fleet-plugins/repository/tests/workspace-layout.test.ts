import { describe, expect, it } from "vitest";

import { getT } from "../client/i18n/index.js";
import {
  PREFS_WORKSPACE_DOCK_FILES_WIDTH,
  PREFS_WORKSPACE_DOCK_HEIGHT,
  WORKSPACE_DOCK_DEFAULT_HEIGHT,
  WORKSPACE_DOCK_DIVIDER_WIDTH,
  WORKSPACE_DOCK_FILES_DEFAULT_WIDTH,
  WORKSPACE_DOCK_FILES_MIN_WIDTH,
  WORKSPACE_DOCK_MAIN_MIN_WIDTH,
  WORKSPACE_DOCK_SPLIT_MIN_WIDTH,
  buildWorkspaceTreeSections,
  clampWorkspaceDockFilesWidth,
  normalizeWorkspaceDockHeight,
  readWorkspaceDockFilesWidth,
  readWorkspaceDockHeight,
  saveWorkspaceDockFilesWidth,
  saveWorkspaceDockHeight,
} from "../client/workspace-layout.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

// 소스 트리 열의 폭·분할선은 이제 표면이 소유한다 — 그 산수는
// `runtime/fleet-console/tests/pane-geometry.test.ts`가 지킨다. 여기 남은 것은 작업면 **안쪽**
// 독의 축이다(파일 목록 ⇔ diff, 높이).
describe("Repository workspace layout", () => {
  it("persists the dock height and falls back for invalid values", () => {
    const storage = memoryStorage();
    expect(readWorkspaceDockHeight(storage)).toBe(WORKSPACE_DOCK_DEFAULT_HEIGHT);

    saveWorkspaceDockHeight(284, storage);
    expect(storage.getItem(PREFS_WORKSPACE_DOCK_HEIGHT)).toBe("284");
    expect(readWorkspaceDockHeight(storage)).toBe(284);

    storage.setItem(PREFS_WORKSPACE_DOCK_HEIGHT, "12");
    expect(readWorkspaceDockHeight(storage)).toBe(WORKSPACE_DOCK_DEFAULT_HEIGHT);
  });

  it("persists the inspector dock file-column width and falls back for invalid values", () => {
    const storage = memoryStorage();
    expect(readWorkspaceDockFilesWidth(storage)).toBe(WORKSPACE_DOCK_FILES_DEFAULT_WIDTH);

    saveWorkspaceDockFilesWidth(320, storage);
    expect(storage.getItem(PREFS_WORKSPACE_DOCK_FILES_WIDTH)).toBe("320");
    expect(readWorkspaceDockFilesWidth(storage)).toBe(320);

    storage.setItem(PREFS_WORKSPACE_DOCK_FILES_WIDTH, "12");
    expect(readWorkspaceDockFilesWidth(storage)).toBe(WORKSPACE_DOCK_FILES_DEFAULT_WIDTH);
  });

  it("clamps the dock file-column drag so the diff column keeps its minimum", () => {
    expect(clampWorkspaceDockFilesWidth(250, 60, 800)).toBe(310);
    expect(clampWorkspaceDockFilesWidth(250, -200, 800)).toBe(150);
    // 컨테이너를 넘겨 끌어도 diff 열 340px + 디바이더 4px는 남는다.
    expect(clampWorkspaceDockFilesWidth(250, 900, 800)).toBe(456);
    // 독이 파일 열 최소폭조차 담지 못하면 드래그는 no-op — 세로 스택 컨테이너 쿼리에 맡긴다.
    expect(clampWorkspaceDockFilesWidth(250, 0, 480)).toBeNull();
  });

  it("normalizes a stored width wider than the current dock to the rendered width", () => {
    // CSS min()이 화면에서만 줄여 둔 상태에서 저장값을 기점으로 삼으면 숨은 초과분만큼
    // 첫 이동이 먹히지 않는다. delta 0 클램프가 그 기점 보정이다.
    expect(clampWorkspaceDockFilesWidth(600, 0, 800)).toBe(456);
    expect(clampWorkspaceDockFilesWidth(456, -100, 800)).toBe(356);
  });

  it("stacks the dock before either minimum can be violated", () => {
    // 스택 경계와 클램프가 같은 산술을 쓰지 않으면 "보이는데 끌리지 않는" 디바이더 구간이 생긴다.
    expect(WORKSPACE_DOCK_SPLIT_MIN_WIDTH).toBe(WORKSPACE_DOCK_FILES_MIN_WIDTH + WORKSPACE_DOCK_DIVIDER_WIDTH + WORKSPACE_DOCK_MAIN_MIN_WIDTH);
    expect(clampWorkspaceDockFilesWidth(250, 0, WORKSPACE_DOCK_SPLIT_MIN_WIDTH)).toBe(WORKSPACE_DOCK_FILES_MIN_WIDTH);
    expect(clampWorkspaceDockFilesWidth(250, 0, WORKSPACE_DOCK_SPLIT_MIN_WIDTH - 1)).toBeNull();
  });

  it("falls back safely when the storage accessor itself throws", () => {
    const throwing = {
      get getItem(): never { throw new Error("denied"); },
      get setItem(): never { throw new Error("denied"); },
      get removeItem(): never { throw new Error("denied"); },
    } as unknown as Parameters<typeof readWorkspaceDockHeight>[0];
    expect(readWorkspaceDockHeight(throwing)).toBe(WORKSPACE_DOCK_DEFAULT_HEIGHT);
    expect(readWorkspaceDockFilesWidth(throwing)).toBe(WORKSPACE_DOCK_FILES_DEFAULT_WIDTH);
    expect(() => saveWorkspaceDockHeight(300, throwing)).not.toThrow();
    expect(() => saveWorkspaceDockFilesWidth(320, throwing)).not.toThrow();
  });

  it("normalizes a stored dock height against the current container", () => {
    expect(normalizeWorkspaceDockHeight(800, 500)).toBe(316);
    expect(normalizeWorkspaceDockHeight(230, 900)).toBe(230);
    expect(normalizeWorkspaceDockHeight(100, 900)).toBe(160);
    expect(normalizeWorkspaceDockHeight(800, 200)).toBe(16);
  });

  it("builds the fixed source-tree section order with source counts", () => {
    expect(buildWorkspaceTreeSections({
      context: 3,
      changes: 5,
      worktrees: 2,
      branches: 9,
      tags: 4,
      stashes: 1,
    }, getT("en"))).toEqual([
      { id: "context", label: "CONTEXT", count: 3 },
      { id: "working", label: "WORKING", count: 5 },
      { id: "worktrees", label: "WORKTREES", count: 2 },
      { id: "branches", label: "BRANCHES", count: 9 },
      { id: "tags", label: "TAGS", count: 4 },
      { id: "stashes", label: "STASHES", count: 1 },
    ]);
  });
});
