import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import type { Translate } from "@fleet-console/sdk/i18n";

import type { FileExplorerMessageKey } from "./i18n/index.js";

export type FileContextAction = "copyPath" | "copyRelativePath" | "reveal" | "openExternal";

export const FILE_CONTEXT_MENU_ENTRIES = [
  { kind: "action", action: "copyPath", label: "fileExplorer.menu.copyPath" },
  { kind: "action", action: "copyRelativePath", label: "fileExplorer.menu.copyRelativePath" },
  { kind: "separator" },
  { kind: "action", action: "reveal", label: "fileExplorer.menu.reveal" },
  { kind: "action", action: "openExternal", label: "fileExplorer.menu.openExternal" },
] as const satisfies readonly (
  | { readonly kind: "action"; readonly action: FileContextAction; readonly label: FileExplorerMessageKey }
  | { readonly kind: "separator" }
)[];

type FileContextActionEntry = Extract<(typeof FILE_CONTEXT_MENU_ENTRIES)[number], { readonly kind: "action" }>;

const ACTION_ENTRIES = FILE_CONTEXT_MENU_ENTRIES.filter(
  (entry): entry is FileContextActionEntry => entry.kind === "action",
);

export type ContextMenuKeyboardAction =
  | { readonly kind: "focus"; readonly index: number }
  | { readonly kind: "activate"; readonly index: number }
  | { readonly kind: "dismiss" }
  | { readonly kind: "close" }
  | { readonly kind: "none" };

interface Point {
  readonly x: number;
  readonly y: number;
}

interface RectBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface FileContextMenuProps {
  readonly anchor: Point;
  readonly boundaryRef: RefObject<HTMLElement | null>;
  readonly returnFocusPath: string;
  readonly t: Translate<FileExplorerMessageKey>;
  readonly onAction: (action: FileContextAction) => void;
  readonly onClose: () => void;
  readonly onRestoreFocus: (relativePath: string) => void;
}

interface FileContextActionDependencies {
  readonly fetch: typeof fetch;
  readonly clipboard?: Pick<Clipboard, "writeText">;
}

export function resolveContextMenuKeyboardAction(
  currentIndex: number,
  key: string,
  itemCount: number,
): ContextMenuKeyboardAction {
  if (key === "Escape") return { kind: "dismiss" };
  // Tab은 포커스 이동을 막지 않고 메뉴를 닫기만 한다 — 포커스가 빠진 채
  // 열린 오버레이는 Escape 경로도 잃어 패널 위에 갇히기 때문이다.
  if (key === "Tab") return { kind: "close" };
  if (itemCount <= 0) return { kind: "none" };
  if (key === "ArrowDown") return { kind: "focus", index: (currentIndex + 1) % itemCount };
  if (key === "ArrowUp") {
    return { kind: "focus", index: currentIndex <= 0 ? itemCount - 1 : currentIndex - 1 };
  }
  if (key === "Enter") return { kind: "activate", index: Math.max(0, currentIndex) };
  return { kind: "none" };
}

export function clampContextMenuPosition(
  anchor: Point,
  bounds: RectBounds,
  menuSize: Size,
  margin = 4,
): Point {
  const requestedLeft = anchor.x - bounds.left;
  const requestedTop = anchor.y - bounds.top;
  const maxLeft = Math.max(margin, bounds.width - menuSize.width - margin);
  const maxTop = Math.max(margin, bounds.height - menuSize.height - margin);
  return {
    x: Math.max(margin, Math.min(requestedLeft, maxLeft)),
    y: Math.max(margin, Math.min(requestedTop, maxTop)),
  };
}

export function resolveContextMenuFocusTarget(
  relativePath: string,
  rowRefs: ReadonlyMap<string, HTMLElement>,
  cursorPath: string | null,
  tree: HTMLElement | null,
): HTMLElement | null {
  const currentRow = rowRefs.get(relativePath);
  if (currentRow?.isConnected) return currentRow;
  const cursorRow = cursorPath ? rowRefs.get(cursorPath) : null;
  if (cursorRow?.isConnected) return cursorRow;
  return tree?.isConnected ? tree : null;
}

export function restoreContextMenuFocus(
  relativePath: string,
  rowRefs: ReadonlyMap<string, HTMLElement>,
  cursorPath: string | null,
  tree: HTMLElement | null,
): HTMLElement | null {
  const target = resolveContextMenuFocusTarget(relativePath, rowRefs, cursorPath, tree);
  target?.focus();
  return target;
}

export function isTreeContextMenuKey(key: string, shiftKey: boolean): boolean {
  return key === "ContextMenu" || (key === "F10" && shiftKey);
}

export function contextMenuAnchorFromRowRect(rect: Pick<DOMRect, "left" | "bottom">): Point {
  return { x: rect.left, y: rect.bottom };
}

export async function performFileContextAction(
  action: FileContextAction,
  theaterId: string,
  relativePath: string,
  dependencies: Partial<FileContextActionDependencies> = {},
): Promise<"fileExplorer.menu.pathCopied" | "fileExplorer.menu.relativePathCopied" | null> {
  if (action === "copyRelativePath") {
    const clipboard = dependencies.clipboard
      ?? (typeof navigator === "undefined" ? undefined : navigator.clipboard);
    if (!clipboard) throw new Error("clipboard_unavailable");
    await clipboard.writeText(relativePath);
    return "fileExplorer.menu.relativePathCopied";
  }

  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const endpoint = action === "copyPath"
    ? "/plugins/file-explorer/files/clipboard"
    : "/plugins/file-explorer/files/reveal";
  const body = action === "copyPath"
    ? { theaterId, relativePath }
    : { theaterId, relativePath, mode: action === "reveal" ? "reveal" : "open" };
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error("action_unavailable");
  return action === "copyPath" ? "fileExplorer.menu.pathCopied" : null;
}

export function FileContextMenu({
  anchor,
  boundaryRef,
  returnFocusPath,
  t,
  onAction,
  onClose,
  onRestoreFocus,
}: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<Point | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    const boundary = boundaryRef.current;
    if (!menu || !boundary) return;
    const updatePosition = () => {
      const menuRect = menu.getBoundingClientRect();
      const boundaryRect = boundary.getBoundingClientRect();
      setPosition(clampContextMenuPosition(anchor, boundaryRect, menuRect));
    };
    updatePosition();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updatePosition);
    observer.observe(menu);
    observer.observe(boundary);
    return () => observer.disconnect();
  }, [anchor, boundaryRef]);

  useEffect(() => {
    const focusFrame = window.requestAnimationFrame(() => itemRefs.current[0]?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, []);

  const closeAndRestoreFocus = useCallback(() => {
    onClose();
    onRestoreFocus(returnFocusPath);
  }, [onClose, onRestoreFocus, returnFocusPath]);

  useEffect(() => {
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !menuRef.current?.contains(target)) closeAndRestoreFocus();
    };
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", handleOutsidePointer, true);
  }, [closeAndRestoreFocus]);

  const focusItem = (index: number) => {
    setActiveIndex(index);
    itemRefs.current[index]?.focus();
  };
  const activate = (index: number) => {
    const entry = ACTION_ENTRIES[index];
    if (!entry) return;
    closeAndRestoreFocus();
    onAction(entry.action);
  };
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const action = resolveContextMenuKeyboardAction(activeIndex, event.key, ACTION_ENTRIES.length);
    if (action.kind === "close") {
      // preventDefault 없이 닫는다 — Tab의 자연스러운 포커스 이동을 보존.
      onClose();
      return;
    }
    if (action.kind === "none") return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === "focus") focusItem(action.index);
    else if (action.kind === "activate") activate(action.index);
    else closeAndRestoreFocus();
  };

  const style: CSSProperties = position
    ? { left: position.x, top: position.y }
    : { left: 0, top: 0, visibility: "hidden" };
  let actionIndex = -1;

  return (
    <div
      ref={menuRef}
      className="fexp-context-menu"
      role="menu"
      style={style}
      onKeyDown={handleKeyDown}
    >
      {FILE_CONTEXT_MENU_ENTRIES.map((entry, index) => {
        if (entry.kind === "separator") {
          return <div key={`separator-${index}`} className="fexp-context-menu-separator" role="separator" />;
        }
        actionIndex += 1;
        const currentActionIndex = actionIndex;
        return (
          <button
            key={entry.action}
            ref={(node) => { itemRefs.current[currentActionIndex] = node; }}
            className="fexp-context-menu-item"
            type="button"
            role="menuitem"
            tabIndex={activeIndex === currentActionIndex ? 0 : -1}
            data-file-context-action={entry.action}
            onClick={() => activate(currentActionIndex)}
            onFocus={() => setActiveIndex(currentActionIndex)}
            onMouseEnter={() => focusItem(currentActionIndex)}
          >
            {t(entry.label)}
          </button>
        );
      })}
    </div>
  );
}
