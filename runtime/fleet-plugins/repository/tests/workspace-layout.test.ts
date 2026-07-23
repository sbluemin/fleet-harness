import { describe, expect, it } from "vitest";

import {
  PREFS_WORKSPACE,
  PREFS_WORKSPACE_DOCK_HEIGHT,
  WORKSPACE_DOCK_DEFAULT_HEIGHT,
  buildWorkspaceTreeSections,
  calculateWorkspaceExtraWidth,
  readWorkspaceDockHeight,
  readWorkspaceMode,
  saveWorkspaceDockHeight,
  saveWorkspaceMode,
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
  it("persists expansion as 1 and removes the preference on collapse", () => {
    const storage = memoryStorage();

    expect(readWorkspaceMode(storage)).toBe(false);
    saveWorkspaceMode(true, storage);
    expect(storage.getItem(PREFS_WORKSPACE)).toBe("1");
    expect(readWorkspaceMode(storage)).toBe(true);

    saveWorkspaceMode(false, storage);
    expect(storage.getItem(PREFS_WORKSPACE)).toBeNull();
    expect(readWorkspaceMode(storage)).toBe(false);
  });

  it("calculates extra width from the capped viewport allowance and rail base", () => {
    expect(calculateWorkspaceExtraWidth(600)).toBe(0);
    expect(calculateWorkspaceExtraWidth(1440)).toBe(728);
    expect(calculateWorkspaceExtraWidth(2000)).toBe(888);
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

  it("builds the fixed source-tree section order with source counts", () => {
    expect(buildWorkspaceTreeSections({
      context: 3,
      changes: 5,
      worktrees: 2,
      branches: 9,
      tags: 4,
      stashes: 1,
    })).toEqual([
      { id: "context", label: "CONTEXT", count: 3 },
      { id: "working", label: "WORKING", count: 5 },
      { id: "worktrees", label: "WORKTREES", count: 2 },
      { id: "branches", label: "BRANCHES", count: 9 },
      { id: "tags", label: "TAGS", count: 4 },
      { id: "stashes", label: "STASHES", count: 1 },
    ]);
  });
});
