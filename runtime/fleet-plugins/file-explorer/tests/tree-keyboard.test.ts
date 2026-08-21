// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { buildFlatRows, isEntryRow, resolveTreeNavigation, resolveTypeaheadIndex, type EntryRow } from "../client/tree.js";
import { contextMenuAnchorFromRowRect, isTreeContextMenuKey } from "../client/context-menu.js";
import type { FolderEntry, FolderListResult } from "../server/types.js";

describe("FileTree keyboard navigation", () => {
  it("keeps one roving tab stop while actual KeyboardEvents drive four directions, Home, End, and activation", () => {
    const expanded = new Set<string>();
    const activated = vi.fn();
    const harness = createHarness(() => rows(expanded, ""), expanded, activated);

    expect(harness.tabStops()).toHaveLength(1);
    expect(harness.focusedPath()).toBe("src");

    expect(harness.key("ArrowRight").defaultPrevented).toBe(true);
    expect(expanded.has("src")).toBe(true);
    expect(harness.focusedPath()).toBe("src");

    harness.key("ArrowRight");
    expect(harness.focusedPath()).toBe("src/match.ts");
    harness.key("ArrowDown");
    expect(harness.focusedPath()).toBe("src/other.ts");
    harness.key("ArrowUp");
    expect(harness.focusedPath()).toBe("src/match.ts");
    harness.key("ArrowLeft");
    expect(harness.focusedPath()).toBe("src");
    harness.key("ArrowLeft");
    expect(expanded.has("src")).toBe(false);
    expect(harness.tabStops()).toHaveLength(1);

    harness.key("End");
    expect(harness.focusedPath()).toBe("root.txt");
    harness.key("Home");
    expect(harness.focusedPath()).toBe("src");

    harness.key("ArrowDown");
    harness.key("Enter");
    expect(activated).toHaveBeenCalledWith("docs");
    expect(expanded.has("docs")).toBe(true);

    harness.click("root.txt");
    expect(harness.focusedPath()).toBe("root.txt");
    expect(harness.tabStops()).toHaveLength(1);
    expect(activated).toHaveBeenCalledWith("root.txt");
  });

  it("uses only filtered visible rows as the traversal order", () => {
    const expanded = new Set<string>();
    const harness = createHarness(() => rows(expanded, "match"), expanded, vi.fn());

    expect(harness.paths()).toEqual(["src", "src/match.ts", "docs", "docs/match.md"]);
    expect(harness.tabStops()).toHaveLength(1);
    harness.key("End");
    expect(harness.focusedPath()).toBe("docs/match.md");
    harness.key("Home");
    expect(harness.focusedPath()).toBe("src");
    harness.key("ArrowDown");
    expect(harness.focusedPath()).toBe("src/match.ts");
    expect(harness.paths()).not.toContain("src/other.ts");
    expect(harness.paths()).not.toContain("root.txt");
    expect(harness.tabStops()).toHaveLength(1);
  });
});

function createHarness(
  getRows: () => ReturnType<typeof buildFlatRows>,
  expanded: Set<string>,
  activated: (path: string) => void,
) {
  const tree = document.createElement("div");
  tree.setAttribute("role", "tree");
  document.body.replaceChildren(tree);
  let cursorPath = getRows().find(isEntryRow)?.entry.relativePath ?? null;

  const render = () => {
    const currentRows = getRows();
    if (!currentRows.some((row) => isEntryRow(row) && row.entry.relativePath === cursorPath)) {
      cursorPath = currentRows.find(isEntryRow)?.entry.relativePath ?? null;
    }
    tree.replaceChildren(...currentRows.flatMap((row, index) => {
      if (!isEntryRow(row)) return [];
      const button = document.createElement("button");
      button.dataset.path = row.entry.relativePath;
      button.tabIndex = row.entry.relativePath === cursorPath ? 0 : -1;
      button.addEventListener("click", () => {
        cursorPath = row.entry.relativePath;
        activate(row);
      });
      button.addEventListener("keydown", (event) => {
        const action = resolveTreeNavigation(currentRows, index, event.key);
        if (action.kind === "none") {
          if (event.key === "ArrowRight" || event.key === "ArrowLeft") event.preventDefault();
          return;
        }
        event.preventDefault();
        if (action.kind === "focus") {
          const target = currentRows[action.index];
          cursorPath = target && isEntryRow(target) ? target.entry.relativePath : cursorPath;
          render();
          focusCursor();
          return;
        }
        if (action.kind === "expand") expanded.add(row.entry.relativePath);
        if (action.kind === "collapse") expanded.delete(row.entry.relativePath);
        if (action.kind === "activate") activate(row);
        render();
        focusCursor();
      });
      return [button];
    }));
    focusCursor();
  };

  const activate = (row: EntryRow) => {
    activated(row.entry.relativePath);
    if (row.entry.kind !== "dir") return;
    if (expanded.has(row.entry.relativePath)) expanded.delete(row.entry.relativePath);
    else expanded.add(row.entry.relativePath);
  };
  const focusCursor = () => tree.querySelector<HTMLElement>(`[data-path="${cursorPath}"]`)?.focus();
  render();

  return {
    click(path: string) {
      tree.querySelector<HTMLButtonElement>(`[data-path="${path}"]`)?.click();
      render();
    },
    focusedPath: () => (document.activeElement as HTMLElement | null)?.dataset.path ?? null,
    key(key: string) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(event);
      return event;
    },
    paths: () => Array.from(tree.querySelectorAll<HTMLElement>("[data-path]")).map((node) => node.dataset.path ?? ""),
    tabStops: () => Array.from(tree.querySelectorAll<HTMLButtonElement>("[data-path]")).filter((node) => node.tabIndex === 0),
  };
}

function rows(expanded: Set<string>, filter: string) {
  return buildFlatRows(ROOT_ENTRIES, 0, null, expanded, new Set(), CHILD_RESULTS, filter, true);
}

function entry(name: string, relativePath: string, kind: FolderEntry["kind"]): FolderEntry {
  return { name, relativePath, kind };
}

const ROOT_ENTRIES = [
  entry("src", "src", "dir"),
  entry("docs", "docs", "dir"),
  entry("root.txt", "root.txt", "file"),
];

const CHILD_RESULTS = new Map<string, FolderListResult>([
  ["src", { relativePath: "src", parentRelativePath: null, entries: [
    entry("match.ts", "src/match.ts", "file"),
    entry("other.ts", "src/other.ts", "file"),
  ] }],
  ["docs", { relativePath: "docs", parentRelativePath: null, entries: [
    entry("match.md", "docs/match.md", "file"),
  ] }],
]);

describe("FileTree keyboard completeness", () => {
  it("jumps type-ahead to the next row whose name starts with the buffer", () => {
    const current = rows(new Set(["src"]), "");
    const srcIndex = current.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "src");
    const matchIndex = current.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "src/match.ts");
    expect(resolveTypeaheadIndex(current, srcIndex, "m")).toBe(matchIndex);
    const otherIndex = current.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "src/other.ts");
    expect(resolveTypeaheadIndex(current, matchIndex, "o")).toBe(otherIndex);
  });

  it("pages by one viewport of rows", () => {
    const current = rows(new Set(["src", "docs"]), "");
    const start = current.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "src");
    expect(resolveTreeNavigation(current, start, "PageDown", { pageSize: 2 })).toEqual({
      kind: "focus",
      index: current.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "src/other.ts"),
    });
    const end = current.findIndex((row) => isEntryRow(row) && row.entry.relativePath === "root.txt");
    expect(resolveTreeNavigation(current, end, "PageUp", { pageSize: 10 })).toEqual({
      kind: "focus",
      index: start,
    });
  });

  it("opens the focused row context menu from Shift+F10 and the ContextMenu key", () => {
    const current = rows(new Set(), "");
    expect(resolveTreeNavigation(current, 0, "F10", { shiftKey: true })).toEqual({ kind: "openMenu" });
    expect(resolveTreeNavigation(current, 0, "ContextMenu")).toEqual({ kind: "openMenu" });
    expect(resolveTreeNavigation(current, 0, "F10")).toEqual({ kind: "none" });
    expect(isTreeContextMenuKey("F10", true)).toBe(true);
    expect(isTreeContextMenuKey("ContextMenu", false)).toBe(true);
    expect(contextMenuAnchorFromRowRect({ left: 12, bottom: 40 })).toEqual({ x: 12, y: 40 });
  });

});
