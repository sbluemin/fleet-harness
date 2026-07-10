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
});
