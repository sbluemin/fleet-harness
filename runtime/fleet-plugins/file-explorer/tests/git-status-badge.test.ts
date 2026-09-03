import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { mapGitStatusBadge, rollupDominantStatus, rollupGitStatuses, shouldRefreshGitStatusOnVisibility, triggerManualRefresh } from "../client/tree.js";

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

describe("rollupGitStatuses", () => {
  it("counts descendant git statuses on every ancestor directory", () => {
    const statuses = new Map([
      ["src/a.ts", "modified" as const],
      ["src/b.ts", "untracked" as const],
      ["src/nested/gone.ts", "deleted" as const],
      ["readme.md", "modified" as const],
    ]);
    const rollups = rollupGitStatuses(statuses);
    expect(rollups.get("src")).toEqual({ modified: 1, untracked: 1, deleted: 1, total: 3 });
    expect(rollups.get("src/nested")).toEqual({ modified: 0, untracked: 0, deleted: 1, total: 1 });
    expect(rollups.has("")).toBe(false);
    expect(rollups.has("readme.md")).toBe(false);
  });
});

describe("status dots are actually painted", () => {
  it("gives .fexp-tree-dot a size and ink so the signal is visible, not aria-only", () => {
    const css = fs.readFileSync(new URL("../client/explorer.css", import.meta.url), "utf8");
    const block = css.slice(css.indexOf(".fexp-tree-dot {"), css.indexOf(".fexp-tree-dot.is-rollup {"));
    expect(block).toContain("width:");
    expect(block).toContain("height:");
    expect(block).toContain("background: currentColor");
    // 폴더 롤업 점은 속이 빈 링이다 — "안에 무언가 있다"와 "이 파일이 그렇다"를 한 점의 속으로 가른다.
    const rollup = css.slice(css.indexOf(".fexp-tree-dot.is-rollup {"));
    expect(rollup).toContain("box-shadow: inset 0 0 0 1px currentColor");
  });

  it("names the letter badge only for assistive text — the row itself carries the tint class", () => {
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");
    expect(source).toContain('className={`fexp-tree-dot is-${gitBadge.status}`}');
    expect(source).toContain("${gitBadge ? ` is-${gitBadge.status}` : \"\"}");
    expect(source).not.toContain("fexp-git-badge");
  });
});

describe("rollupDominantStatus", () => {
  it("picks the strongest state — deleted over modified over untracked", () => {
    expect(rollupDominantStatus({ modified: 2, untracked: 1, deleted: 1, total: 4 })).toBe("deleted");
    expect(rollupDominantStatus({ modified: 2, untracked: 1, deleted: 0, total: 3 })).toBe("modified");
    expect(rollupDominantStatus({ modified: 0, untracked: 1, deleted: 0, total: 1 })).toBe("untracked");
    expect(rollupDominantStatus({ modified: 0, untracked: 0, deleted: 0, total: 0 })).toBeNull();
  });
});
