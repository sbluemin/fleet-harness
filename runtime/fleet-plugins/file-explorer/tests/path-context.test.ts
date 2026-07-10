import { describe, expect, it } from "vitest";

import { adaptFolderList, prefixContextPath, stripContextPath, translateContextEvent } from "../client/path-context.js";

describe("File Explorer path context adapter", () => {
  it("prefixes and strips only complete context boundaries", () => {
    expect(prefixContextPath("worktrees/a", "src/index.ts")).toBe("worktrees/a/src/index.ts");
    expect(stripContextPath("worktrees/a", "worktrees/a/src/index.ts")).toBe("src/index.ts");
    expect(stripContextPath("worktrees/a", "worktrees/ab/src/index.ts")).toBeNull();
  });

  it("normalizes separators and rejects context escapes", () => {
    expect(prefixContextPath("pkg", "src\\a.ts")).toBe("pkg/src/a.ts");
    expect(prefixContextPath("pkg", "../escape")).toBeNull();
    expect(translateContextEvent("pkg", "other/file.ts")).toBeNull();
  });

  it("filters folder results outside the selected root", () => {
    expect(adaptFolderList("pkg", { relativePath: "pkg", parentRelativePath: null, entries: [{ name: "ok", relativePath: "pkg/ok", kind: "file" }, { name: "bad", relativePath: "other/bad", kind: "file" }] })?.entries).toEqual([{ name: "ok", relativePath: "ok", kind: "file" }]);
  });

  it("pins the context root parent to null even when the server reports an outside parent", () => {
    const adapted = adaptFolderList(".fleet/worktrees/wt", {
      relativePath: ".fleet/worktrees/wt",
      parentRelativePath: ".fleet/worktrees",
      entries: [{ name: "docs", relativePath: ".fleet/worktrees/wt/docs", kind: "dir" }],
    });
    expect(adapted).toEqual({ relativePath: "", parentRelativePath: null, entries: [{ name: "docs", relativePath: "docs", kind: "dir" }] });
  });

  it("still rejects non-root results whose parent escapes the context", () => {
    expect(adaptFolderList("pkg", { relativePath: "pkg/sub", parentRelativePath: "other", entries: [] })).toBeNull();
  });
});
