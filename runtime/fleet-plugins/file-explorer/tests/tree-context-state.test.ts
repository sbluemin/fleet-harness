import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import type { FolderListResult } from "../server/types.js";

import { buildFlatRows, FILTER_DIRECTORY_CAP, isCurrentContextRequest, loadFilterDescendants, type PluginFilesClient } from "../client/tree.js";

const ROOT_ENTRIES = [{ name: "src", relativePath: "src", kind: "dir" }] as const;
const SRC_RESULT: FolderListResult = {
  relativePath: "src",
  parentRelativePath: "",
  entries: [{ name: "nested", relativePath: "src/nested", kind: "dir" }, { name: ".git", relativePath: "src/.git", kind: "dir" }],
};
const NESTED_RESULT: FolderListResult = {
  relativePath: "src/nested",
  parentRelativePath: "src",
  entries: [{ name: "match.ts", relativePath: "src/nested/match.ts", kind: "file" }],
};

describe("FileTree context request guard", () => {
  it("applies a list response only to the context that started it", () => {
    expect(isCurrentContextRequest("theater-a:src", "theater-a:src")).toBe(true);
    expect(isCurrentContextRequest("theater-a:src", "theater-b:src")).toBe(false);
    expect(isCurrentContextRequest("theater-a:src", "theater-a:docs")).toBe(false);
  });

  it("remounts before a new context can render the previous tree result", () => {
    const source = fs.readFileSync(new URL("../client/rail-panel.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/<FileTree\s+key=\{contextScope\}/);
  });

  it("loads unopened descendants for a filter and renders their matching path", async () => {
    const results = new Map<string, FolderListResult>();
    const listFolder = vi.fn(async (relativePath?: string) => {
      if (relativePath === "src") return SRC_RESULT;
      if (relativePath === "src/nested") return NESTED_RESULT;
      throw new Error(`unexpected path: ${relativePath}`);
    });
    const files: PluginFilesClient = { listFolder };

    await loadFilterDescendants({
      entries: ROOT_ENTRIES,
      cachedResults: new Map(),
      files,
      showHidden: false,
      isCurrent: () => true,
      onFolderResult: (relativePath, result) => results.set(relativePath, result),
    });

    expect(listFolder).toHaveBeenCalledWith("src");
    expect(listFolder).toHaveBeenCalledWith("src/nested");
    expect(listFolder).not.toHaveBeenCalledWith("src/.git");
    expect(buildFlatRows(ROOT_ENTRIES, 0, null, new Set(), new Set(), results, "match", false).map((row) => row.entry.relativePath)).toEqual([
      "src",
      "src/nested",
      "src/nested/match.ts",
    ]);
  });

  it("stops a stale filter traversal before applying or requesting later descendants", async () => {
    let current = true;
    const onFolderResult = vi.fn(() => { current = false; });
    const files: PluginFilesClient = {
      listFolder: vi.fn(async () => SRC_RESULT),
    };

    await loadFilterDescendants({
      entries: ROOT_ENTRIES,
      cachedResults: new Map(),
      files,
      showHidden: false,
      isCurrent: () => current,
      onFolderResult,
    });

    expect(onFolderResult).toHaveBeenCalledOnce();
    expect(files.listFolder).toHaveBeenCalledTimes(1);
  });

  it("uses cached folder results before requesting descendants again", async () => {
    const listFolder = vi.fn();
    const files: PluginFilesClient = { listFolder };
    const cachedResults = new Map<string, FolderListResult>([
      ["src", SRC_RESULT],
      ["src/nested", NESTED_RESULT],
    ]);

    await loadFilterDescendants({
      entries: ROOT_ENTRIES,
      cachedResults,
      files,
      showHidden: false,
      isCurrent: () => true,
      onFolderResult: vi.fn(),
    });

    expect(listFolder).not.toHaveBeenCalled();
  });

  it("keeps one recursive walk active while filter text remains non-empty", () => {
    const source = fs.readFileSync(new URL("../client/tree.tsx", import.meta.url), "utf8");

    expect(source).toContain("const isFiltering = Boolean(filterText);");
    expect(source).toContain("}, [contextKey, files, isFiltering, result, showHidden]);");
  });

  it("stops traversing when a server result repeats a visited relative path", async () => {
    const cycleResult: FolderListResult = {
      relativePath: "src",
      parentRelativePath: "",
      entries: [{ name: "loop", relativePath: "src/loop", kind: "dir" }],
    };
    const listFolder = vi.fn(async () => cycleResult);
    const files: PluginFilesClient = { listFolder };

    await loadFilterDescendants({
      entries: ROOT_ENTRIES,
      cachedResults: new Map(),
      files,
      showHidden: false,
      isCurrent: () => true,
      onFolderResult: vi.fn(),
    });

    expect(listFolder).toHaveBeenCalledTimes(2);
  });

  it("does not recursively render a cached cyclic folder result", () => {
    const cycleResult: FolderListResult = {
      relativePath: "src",
      parentRelativePath: "",
      entries: [
        { name: "loop", relativePath: "src/loop", kind: "dir" },
        { name: "match.ts", relativePath: "src/match.ts", kind: "file" },
      ],
    };
    const rows = buildFlatRows(ROOT_ENTRIES, 0, null, new Set(), new Set(), new Map([
      ["src", cycleResult],
      ["src/loop", cycleResult],
    ]), "match", false);

    expect(rows.map((row) => row.entry.relativePath)).toEqual(["src", "src/match.ts"]);
  });

  it("caps distinct directory requests during recursive discovery", async () => {
    const listFolder = vi.fn(async (relativePath?: string) => {
      const index = Number(relativePath?.split("-").at(-1) ?? "0");
      return {
        relativePath: relativePath ?? "",
        parentRelativePath: null,
        entries: [{ name: `dir-${index + 1}`, relativePath: `dir-${index + 1}`, kind: "dir" }],
      } satisfies FolderListResult;
    });
    const files: PluginFilesClient = { listFolder };

    await loadFilterDescendants({
      entries: [{ name: "dir-0", relativePath: "dir-0", kind: "dir" }],
      cachedResults: new Map(),
      files,
      showHidden: false,
      isCurrent: () => true,
      onFolderResult: vi.fn(),
    });

    expect(listFolder).toHaveBeenCalledTimes(FILTER_DIRECTORY_CAP);
  });
});
