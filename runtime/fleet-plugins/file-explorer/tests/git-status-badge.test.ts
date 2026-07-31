import { describe, expect, it, vi } from "vitest";

import { mapGitStatusBadge, shouldRefreshGitStatusOnVisibility, triggerManualRefresh } from "../client/tree.js";

describe("mapGitStatusBadge", () => {
  it("maps git states to their fixed badge letter and accessible message key", () => {
    expect(mapGitStatusBadge("modified")).toEqual({
      text: "M",
      status: "modified",
      messageKey: "fileExplorer.git.modified",
    });
    expect(mapGitStatusBadge("untracked")).toEqual({
      text: "U",
      status: "untracked",
      messageKey: "fileExplorer.git.untracked",
    });
    expect(mapGitStatusBadge("deleted")).toEqual({
      text: "D",
      status: "deleted",
      messageKey: "fileExplorer.git.deleted",
    });
    expect(mapGitStatusBadge(undefined)).toBeNull();
  });
});

describe("triggerManualRefresh", () => {
  it("refreshes both the file tree and Git status immediately", () => {
    const refreshTree = vi.fn();
    const refreshGitStatus = vi.fn();

    triggerManualRefresh(refreshTree, refreshGitStatus);

    expect(refreshTree).toHaveBeenCalledOnce();
    expect(refreshGitStatus).toHaveBeenCalledOnce();
  });
});

describe("shouldRefreshGitStatusOnVisibility", () => {
  it("refreshes only when the tab becomes visible", () => {
    expect(shouldRefreshGitStatusOnVisibility("visible")).toBe(true);
    expect(shouldRefreshGitStatusOnVisibility("hidden")).toBe(false);
    expect(shouldRefreshGitStatusOnVisibility("prerender")).toBe(false);
  });
});
