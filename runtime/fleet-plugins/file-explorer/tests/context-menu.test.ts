// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  FILE_CONTEXT_MENU_ENTRIES,
  clampContextMenuPosition,
  performFileContextAction,
  resolveContextMenuKeyboardAction,
  restoreContextMenuFocus,
} from "../client/context-menu.js";

describe("file explorer row context menu", () => {
  it("keeps the host-fixed action and separator order", () => {
    expect(FILE_CONTEXT_MENU_ENTRIES.map((entry) => entry.kind === "separator" ? "separator" : entry.action)).toEqual([
      "copyPath",
      "copyRelativePath",
      "separator",
      "reveal",
      "openExternal",
    ]);
  });

  it("roves cyclically with ArrowUp/ArrowDown and activates the focused item with Enter", () => {
    const harness = createKeyboardHarness();

    expect(harness.tabStops()).toEqual([harness.items[0]]);
    harness.key("ArrowUp");
    expect(document.activeElement).toBe(harness.items[3]);
    expect(harness.tabStops()).toEqual([harness.items[3]]);

    harness.key("ArrowDown");
    expect(document.activeElement).toBe(harness.items[0]);
    harness.key("ArrowDown");
    harness.key("Enter");
    expect(harness.activated).toHaveBeenCalledWith(1);
  });

  it("closes on Escape and restores focus to the originating tree row", () => {
    const harness = createKeyboardHarness();
    harness.key("ArrowDown");

    const event = harness.key("Escape");

    expect(event.defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(harness.origin);
  });

  it("falls back to the current cursor row, then the tree, when virtualization unmounts the origin", () => {
    document.body.replaceChildren();
    const tree = document.createElement("div");
    tree.setAttribute("role", "tree");
    tree.tabIndex = -1;
    const origin = document.createElement("button");
    const cursor = document.createElement("button");
    tree.append(origin, cursor);
    document.body.append(tree);
    const rowRefs = new Map<string, HTMLElement>([
      ["origin.ts", origin],
      ["cursor.ts", cursor],
    ]);

    origin.remove();
    restoreContextMenuFocus("origin.ts", rowRefs, "cursor.ts", tree);
    expect(document.activeElement).toBe(cursor);
    expect(document.activeElement).not.toBe(document.body);

    cursor.remove();
    restoreContextMenuFocus("origin.ts", rowRefs, "cursor.ts", tree);
    expect(document.activeElement).toBe(tree);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("clamps the rendered menu within every panel edge", () => {
    const bounds = { left: 100, top: 50, width: 300, height: 220 };
    const size = { width: 196, height: 150 };

    expect(clampContextMenuPosition({ x: 90, y: 30 }, bounds, size)).toEqual({ x: 4, y: 4 });
    expect(clampContextMenuPosition({ x: 390, y: 260 }, bounds, size)).toEqual({ x: 100, y: 66 });
  });

  it("sends only Theater identity and a relative path to the absolute-copy route", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));

    const feedback = await performFileContextAction(
      "copyPath",
      "theater-a",
      "src/file.ts",
      { fetch: fetchMock as typeof fetch },
    );

    expect(feedback).toBe("fileExplorer.menu.pathCopied");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/plugins/file-explorer/files/clipboard");
    expect(JSON.parse(String(init?.body))).toEqual({ theaterId: "theater-a", relativePath: "src/file.ts" });
    expect(Object.keys(JSON.parse(String(init?.body)) as object)).toEqual(["theaterId", "relativePath"]);
  });

  it("copies the already-browser-visible relative path with navigator clipboard semantics", async () => {
    const writeText = vi.fn(async () => undefined);

    const feedback = await performFileContextAction(
      "copyRelativePath",
      "theater-a",
      "src/file.ts",
      { clipboard: { writeText } },
    );

    expect(writeText).toHaveBeenCalledWith("src/file.ts");
    expect(feedback).toBe("fileExplorer.menu.relativePathCopied");
  });
});

function createKeyboardHarness() {
  document.body.replaceChildren();
  const tree = document.createElement("div");
  tree.setAttribute("role", "tree");
  tree.tabIndex = -1;
  const origin = document.createElement("button");
  origin.dataset.path = "src/file.ts";
  tree.append(origin);
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  const items = Array.from({ length: 4 }, (_, index) => {
    const item = document.createElement("button");
    item.setAttribute("role", "menuitem");
    item.dataset.index = String(index);
    menu.append(item);
    return item;
  });
  document.body.append(tree, menu);
  const activated = vi.fn();
  let activeIndex = 0;

  const focusItem = (index: number) => {
    activeIndex = index;
    for (const [itemIndex, item] of items.entries()) item.tabIndex = itemIndex === index ? 0 : -1;
    items[index]?.focus();
  };
  menu.addEventListener("keydown", (event) => {
    const action = resolveContextMenuKeyboardAction(activeIndex, event.key, items.length);
    if (action.kind === "none") return;
    event.preventDefault();
    if (action.kind === "focus") focusItem(action.index);
    else if (action.kind === "activate") activated(action.index);
    else {
      menu.remove();
      restoreContextMenuFocus("src/file.ts", new Map([["src/file.ts", origin]]), "src/file.ts", tree);
    }
  });
  focusItem(0);

  return {
    activated,
    items,
    origin,
    key(key: string) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      document.activeElement?.dispatchEvent(event);
      return event;
    },
    tabStops: () => items.filter((item) => item.tabIndex === 0),
  };
}
