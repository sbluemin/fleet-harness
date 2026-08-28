// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getT } from "../client/i18n/index.js";
import { FileTree, type PluginFilesClient } from "../client/tree.js";
import type { FolderEntry, FolderListResult } from "../server/types.js";

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = [];

  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }
}

class EventSourceMock {
  readonly addEventListener = vi.fn();
  readonly close = vi.fn();
  onopen: (() => void) | null = null;
}

let container: HTMLDivElement;
let root: Root;
let treeHeight: number;

const entries: FolderEntry[] = Array.from({ length: 260 }, (_, index) => {
  const name = `file-${String(index + 1).padStart(3, "0")}.txt`;
  return { name, relativePath: name, kind: "file" };
});

const result: FolderListResult = {
  relativePath: "",
  parentRelativePath: null,
  entries,
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ResizeObserverMock.instances = [];
  treeHeight = 1117;
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("EventSource", EventSourceMock);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("fexp-tree") ? treeHeight : 0;
  });
  container = document.createElement("div");
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderedNames(): string[] {
  return [...container.querySelectorAll<HTMLElement>(".fexp-tree-row")]
    .map((row) => row.textContent?.trim() ?? "");
}

function renderTree(files: PluginFilesClient): void {
  root.render(
    <FileTree
      contextKey="theater-a:root"
      files={files}
      theaterId="theater-a"
      selectedPath={null}
      onSelect={vi.fn()}
      onContextMenu={vi.fn()}
      t={getT("en")}
    />,
  );
}

describe("FileTree viewport measurement", () => {
  it("measures the tree when an asynchronous listing mounts it, then fills a tall viewport while scrolling", async () => {
    let resolveListing!: (value: FolderListResult) => void;
    const listFolder = vi.fn(() => new Promise<FolderListResult>((resolve) => {
      resolveListing = resolve;
    }));

    await act(async () => renderTree({ listFolder }));
    expect(container.querySelector(".fexp-tree")).toBeNull();
    expect(ResizeObserverMock.instances).toHaveLength(0);

    await act(async () => resolveListing(result));

    expect(ResizeObserverMock.instances).toHaveLength(1);
    expect(ResizeObserverMock.instances[0]?.observe).toHaveBeenCalledWith(container.querySelector(".fexp-tree"));
    expect(renderedNames()).toHaveLength(42);
    expect(renderedNames().at(-1)).toBe("file-042.txt");

    const tree = container.querySelector<HTMLDivElement>(".fexp-tree")!;
    Object.defineProperty(tree, "scrollTop", { configurable: true, writable: true, value: 450 });
    await act(async () => tree.dispatchEvent(new Event("scroll", { bubbles: true })));

    expect(renderedNames()[0]).toBe("file-010.txt");
    expect(renderedNames().at(-1)).toBe("file-057.txt");
  });

  it("reconnects measurement when filtering replaces and restores the tree node", async () => {
    const listFolder = vi.fn(async () => result);
    await act(async () => renderTree({ listFolder }));
    expect(ResizeObserverMock.instances).toHaveLength(1);

    const input = container.querySelector<HTMLInputElement>(".fexp-filter-input")!;
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "needle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".fexp-tree")).toBeNull();
    expect(ResizeObserverMock.instances[0]?.disconnect).toHaveBeenCalled();

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelector(".fexp-tree")).not.toBeNull();
    expect(ResizeObserverMock.instances).toHaveLength(2);
    expect(renderedNames()[0]).toBe("file-001.txt");
    expect(renderedNames().at(-1)).toBe("file-042.txt");
  });
});
