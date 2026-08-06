import fs from "node:fs/promises";

import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { FilesViewToggle, PREFS_FILES_VIEW, readFilesViewMode, saveFilesViewMode } from "../client/changed-files.js";
import { getT } from "../client/i18n/index.js";

const compareSource = await fs.readFile(new URL("../client/compare-inspector.tsx", import.meta.url), "utf8");
const historySource = await fs.readFile(new URL("../client/history-panel.tsx", import.meta.url), "utf8");
const dockSource = await fs.readFile(new URL("../client/workspace-dock.tsx", import.meta.url), "utf8");

type ElementProps = Record<string, unknown> & { readonly children?: ReactNode };

function isElement(node: ReactNode): node is ReactElement<ElementProps> {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function childrenOf(node: ReactNode): readonly ReactNode[] {
  if (!isElement(node)) return [];
  const children = node.props.children;
  return Array.isArray(children) ? children as readonly ReactNode[] : [children];
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe("Files view toggle", () => {
  it("offers both list and tree with the active mode pressed", () => {
    const onMode = vi.fn();
    const toggle = FilesViewToggle({ mode: "tree", onMode, t: getT("en") });
    const buttons = childrenOf(toggle).filter(isElement);

    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.props["aria-label"]).toBe("List view");
    expect(buttons[0]!.props["aria-pressed"]).toBe(false);
    expect(buttons[1]!.props["aria-label"]).toBe("Tree view");
    expect(buttons[1]!.props["aria-pressed"]).toBe(true);

    (buttons[0]!.props["onClick"] as () => void)();
    expect(onMode).toHaveBeenCalledWith("list");
  });

  it("persists one shared view mode and defaults to list", () => {
    const storage = memoryStorage();
    expect(readFilesViewMode(storage)).toBe("list");

    saveFilesViewMode("tree", storage);
    expect(storage.getItem(PREFS_FILES_VIEW)).toBe("tree");
    expect(readFilesViewMode(storage)).toBe("tree");

    storage.setItem(PREFS_FILES_VIEW, "columns");
    expect(readFilesViewMode(storage)).toBe("list");
  });
});

describe("Inspector dock", () => {
  it("gives the compare result the same list/tree switch as the commit inspector", () => {
    expect(compareSource).toContain("<FilesViewToggle");
    expect(compareSource).toContain("<DiffTreeView");
    expect(historySource).toContain("<FilesViewToggle");
  });

  it("renders the commit and compare inspectors through the resizable dock", () => {
    expect(compareSource).toContain("<WorkspaceDock");
    expect(historySource).toContain("<WorkspaceDock");
    // 두 검사기 모두 직접 .repository-ws-dock을 열지 않아야 디바이더가 한쪽에서만 사라지는 일이 없다.
    expect(compareSource).not.toContain("className=\"repository-ws-dock ");
    expect(historySource).not.toContain("className=\"repository-ws-dock\"");
  });

  it("injects the dock file width as a custom property, never as an inline track list", () => {
    expect(dockSource).toContain("\"--ws-dock-files-width\"");
    // 인라인 grid-template-columns는 세로 스택 컨테이너 쿼리를 이겨 main 열을 0으로 붕괴시킨다.
    expect(dockSource).not.toContain("gridTemplateColumns");
    expect(dockSource).toContain("repository-ws-dock-divider");
    expect(dockSource).toContain("aria-orientation=\"vertical\"");
  });

  it("starts a drag from the rendered width, not a stale stored width", () => {
    const drag = dockSource.slice(dockSource.indexOf("const startDrag"), dockSource.indexOf("installPointerDragLifecycle({"));
    expect(drag).toContain("clampWorkspaceDockFilesWidth(filesWidthRef.current, 0, width)");
    expect(drag).toContain("if (start === null) return");
  });

  it("persists the dragged width even when the inspector unmounts mid-drag", () => {
    // installPointerDragLifecycle의 dispose는 onFinish를 부르지 않는다 — 언마운트 정리 경로가
    // 직접 저장하지 않으면 화면에 이미 반영된 폭이 조용히 되돌아간다.
    const cleanup = dockSource.slice(dockSource.indexOf("useEffect(() => () =>"), dockSource.indexOf("const startDrag"));
    expect(cleanup).toContain("dragDisposeRef.current()");
    expect(cleanup).toContain("saveWorkspaceDockFilesWidth(filesWidthRef.current)");
  });
});
