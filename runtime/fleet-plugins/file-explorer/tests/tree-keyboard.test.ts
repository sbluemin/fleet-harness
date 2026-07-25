// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import { buildFlatRows, resolveTreeNavigation } from "../client/tree.js";
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
  let cursorPath = getRows()[0]?.entry.relativePath ?? null;

  const render = () => {
    const currentRows = getRows();
    if (!currentRows.some((row) => row.entry.relativePath === cursorPath)) {
      cursorPath = currentRows[0]?.entry.relativePath ?? null;
    }
    tree.replaceChildren(...currentRows.map((row, index) => {
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
          cursorPath = currentRows[action.index]?.entry.relativePath ?? cursorPath;
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
      return button;
    }));
    focusCursor();
  };

  const activate = (row: ReturnType<typeof buildFlatRows>[number]) => {
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
