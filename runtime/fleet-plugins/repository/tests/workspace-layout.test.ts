import { describe, expect, it } from "vitest";

import { getT } from "../client/i18n/index.js";
import {
  PREFS_WORKSPACE_DOCK_HEIGHT,
  PREFS_WORKSPACE_TREE_WIDTH,
  WORKSPACE_DOCK_DEFAULT_HEIGHT,
  WORKSPACE_TREE_DEFAULT_WIDTH,
  buildWorkspaceTreeSections,
  clampWorkspaceTreeWidth,
  normalizeWorkspaceDockHeight,
  readWorkspaceDockHeight,
  readWorkspaceTreeWidth,
  saveWorkspaceDockHeight,
  saveWorkspaceTreeWidth,
} from "../client/workspace-layout.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("Repository workspace layout", () => {
  it("persists the source-tree width and falls back for invalid values", () => {
    const storage = memoryStorage();
    expect(readWorkspaceTreeWidth(storage)).toBe(WORKSPACE_TREE_DEFAULT_WIDTH);

    saveWorkspaceTreeWidth(280, storage);
    expect(storage.getItem(PREFS_WORKSPACE_TREE_WIDTH)).toBe("280");
    expect(readWorkspaceTreeWidth(storage)).toBe(280);

    storage.setItem(PREFS_WORKSPACE_TREE_WIDTH, "12");
    expect(readWorkspaceTreeWidth(storage)).toBe(WORKSPACE_TREE_DEFAULT_WIDTH);
  });

  it("clamps the source-tree drag within the container", () => {
    expect(clampWorkspaceTreeWidth(222, 40, 800)).toBe(262);
    expect(clampWorkspaceTreeWidth(222, -200, 800)).toBe(148);
    expect(clampWorkspaceTreeWidth(222, 900, 800)).toBe(616);
    expect(clampWorkspaceTreeWidth(222, 0, 300)).toBeNull();
  });

  it("persists the dock height and falls back for invalid values", () => {
    const storage = memoryStorage();
    expect(readWorkspaceDockHeight(storage)).toBe(WORKSPACE_DOCK_DEFAULT_HEIGHT);

    saveWorkspaceDockHeight(284, storage);
    expect(storage.getItem(PREFS_WORKSPACE_DOCK_HEIGHT)).toBe("284");
    expect(readWorkspaceDockHeight(storage)).toBe(284);

    storage.setItem(PREFS_WORKSPACE_DOCK_HEIGHT, "12");
    expect(readWorkspaceDockHeight(storage)).toBe(WORKSPACE_DOCK_DEFAULT_HEIGHT);
  });

  it("falls back safely when the storage accessor itself throws", () => {
    const throwing = {
      get getItem(): never { throw new Error("denied"); },
      get setItem(): never { throw new Error("denied"); },
      get removeItem(): never { throw new Error("denied"); },
    } as unknown as Parameters<typeof readWorkspaceTreeWidth>[0];
    expect(readWorkspaceTreeWidth(throwing)).toBe(WORKSPACE_TREE_DEFAULT_WIDTH);
    expect(readWorkspaceDockHeight(throwing)).toBe(WORKSPACE_DOCK_DEFAULT_HEIGHT);
    expect(() => saveWorkspaceTreeWidth(280, throwing)).not.toThrow();
    expect(() => saveWorkspaceDockHeight(300, throwing)).not.toThrow();
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
