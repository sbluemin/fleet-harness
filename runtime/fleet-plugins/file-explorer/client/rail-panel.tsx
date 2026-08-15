import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor, RailSearchResult } from "@fleet-console/sdk/rail";

import type { FileReadResult, FileSearchResult, FolderEntry, FolderListResult } from "../server/types.js";
import "./explorer.css";
import {
  FileContextMenu,
  performFileContextAction,
  type FileContextAction,
} from "./context-menu.js";
import { getT } from "./i18n/index.js";
import { translateServerError } from "./i18n/index.js";
import { FileTree, type FileTreeHandle, type PluginFilesClient } from "./tree.js";
import { BinaryViewer } from "./viewer/binary.js";
import { CodeViewer } from "./viewer/code.js";
import { ImageViewer } from "./viewer/image.js";
import { MarkdownViewer } from "./viewer/markdown.js";
import {
  buildSplitGridTemplate,
  canResizeTreePane,
  clampTreePaneWidth,
  getTreePaneSeparatorState,
  resizeTreePaneWithKeyboard,
  resolveExtraWidth,
} from "./layout.js";
import { setSelectedPath, setTreePaneWidth, setViewState, useFileExplorerViewState } from "./view-store.js";
import { activateFileSearchTarget, consumeFileSearchTarget, useFileSearchTarget, type FileSearchTarget } from "./search-navigation.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const FEEDBACK_DURATION_MS = 2_500;

interface ActiveContextMenu {
  readonly id: number;
  readonly entry: FolderEntry;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly returnFocusPath: string;
}

interface InlineFeedback {
  readonly id: number;
  readonly message: string;
}

export const fileExplorerPanel: RailPanelDescriptor = {
  id: "file-explorer",
  title: (locale) => getT(locale)("fileExplorer.panel.title"),
  defaultWidth: 360,
  icon: FileExplorerIcon,
  render: (ctx) => <FileExplorerPanel {...ctx} />,
  search: async ({ query, theaterId, limit, signal, language }) => {
    const response = await fetch("/plugins/file-explorer/files/palette-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theaterId, query, limit }),
      signal,
    });
    if (!response.ok) throw new Error("file_search_failed");
    const result = await response.json() as FileSearchResult;
    const t = getT(language);
    const items: RailSearchResult[] = result.files.map((file) => ({
      id: file.relativePath,
      title: file.relativePath.split("/").at(-1) ?? file.relativePath,
      subtitle: file.relativePath,
      activate: () => activateFileSearchTarget(theaterId, file.relativePath),
    }));
    // 상한 표식 행 — 코어가 provider limit으로 자르기 때문에, 마지막 파일 자리를 표식에 양보해
    // 항상 살아남게 한다. activate는 no-op이지만 선택 시 코어가 Files 패널을 열어 준다.
    const marker: RailSearchResult | null = result.walkCapped
      ? { id: "file-explorer.search-capped", title: t("fileExplorer.search.capped"), activate: () => undefined }
      : result.totalMatches > result.files.length
        ? { id: "file-explorer.search-more", title: t("fileExplorer.search.moreMatches", { count: result.totalMatches - result.files.length }), activate: () => undefined }
        : null;
    if (!marker) return items;
    return [...items.slice(0, Math.max(0, limit - 1)), marker];
  },
};

function makeFilesClient(theaterId: string | null): PluginFilesClient {
  return {
    listFolder: async (relativePath?) => {
      if (!theaterId) throw new Error("no_theater");
      const res = await fetch("/plugins/file-explorer/files/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId, relativePath: relativePath ?? "" }),
      });
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        throw new Error(payload.error ?? "list_failed");
      }
      return res.json() as Promise<FolderListResult>;
    },
  };
}

function FileExplorerPanel(ctx: RailPanelContext) {
  const { theaterId } = ctx;
  const t = getT(ctx.language);
  const contextScope = theaterId ?? "";
  const { selectedPath, viewState, treePaneWidth } = useFileExplorerViewState(contextScope);
  const treePaneWidthRef = useRef(treePaneWidth);
  treePaneWidthRef.current = treePaneWidth;
  const rootRef = useRef<HTMLDivElement>(null);
  const fileTreeRef = useRef<FileTreeHandle | null>(null);
  const nextTransientIdRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [revealTarget, setRevealTarget] = useState<FileSearchTarget | null>(null);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [feedback, setFeedback] = useState<InlineFeedback | null>(null);
  const [splitContainerWidth, setSplitContainerWidth] = useState(0);
  const searchTarget = useFileSearchTarget();

  // theaterId 변경마다 새 클라이언트 인스턴스를 생성한다(PluginFilesClient는 stateless).
  const files = useMemo(() => makeFilesClient(theaterId), [theaterId]);

  const openFilePath = useCallback(async (relativePath: string, displayName?: string) => {
    if (!theaterId) {
      setViewState(theaterId, { kind: "error", message: translateServerError("no_theater", t) });
      return;
    }
    setSelectedPath(contextScope, relativePath);
    const name = displayName ?? relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();

    if (IMAGE_EXTS.has(ext)) {
      const src = theaterId
        ? `/plugins/file-explorer/files/image?theaterId=${encodeURIComponent(theaterId)}&path=${encodeURIComponent(relativePath)}`
        : "";
      setViewState(contextScope, { kind: "image", relativePath, name, src });
      return;
    }

    setViewState(contextScope, { kind: "loading" });
    try {
      // files/read는 422(binary_file)를 error 바디로 반환하므로 raw fetch로 직접 처리한다.
      const res = await fetch("/plugins/file-explorer/files/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theaterId, relativePath }),
      });
      if (!res.ok) {
        const payload = await res.json() as { error?: string };
        throw new Error(payload.error ?? "read_failed");
      }
      const result = await res.json() as FileReadResult;
      if (result.binary) {
        setViewState(contextScope, { kind: "binary", name });
        return;
      }
      setViewState(contextScope, { kind: "code", relativePath: result.relativePath, content: result.content, lang: result.lang, truncated: result.truncated });
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : "Unable to load file";
      if (raw === "binary_file") {
        setViewState(contextScope, { kind: "binary", name });
      } else {
        setViewState(contextScope, { kind: "error", message: translateServerError(raw, t) });
      }
    }
  }, [contextScope, t, theaterId]);
  useLayoutEffect(() => {
    if (!searchTarget || searchTarget.theaterId !== theaterId) return;
    setRevealTarget(searchTarget);
    void openFilePath(searchTarget.relativePath);
    consumeFileSearchTarget(searchTarget);
  }, [openFilePath, searchTarget, theaterId]);
  const handleSelect = useCallback(async (entry: FolderEntry) => {
    if (entry.kind !== "file") return;
    await openFilePath(entry.relativePath, entry.name);
  }, [openFilePath]);

  const handleCloseViewer = useCallback(() => {
    setViewState(contextScope, { kind: "none" });
    setSelectedPath(contextScope, null);
  }, [contextScope]);

  const showFeedback = useCallback((message: string) => {
    nextTransientIdRef.current += 1;
    setFeedback({ id: nextTransientIdRef.current, message });
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback((current) => current?.id === feedback.id ? null : current), FEEDBACK_DURATION_MS);
    return () => clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    setActiveContextMenu(null);
    setFeedback(null);
  }, [contextScope]);

  const handleOpenContextMenu = useCallback((
    entry: FolderEntry,
    x: number,
    y: number,
  ) => {
    nextTransientIdRef.current += 1;
    setActiveContextMenu({
      id: nextTransientIdRef.current,
      entry,
      anchor: { x, y },
      returnFocusPath: entry.relativePath,
    });
  }, []);

  const handleRestoreContextMenuFocus = useCallback((relativePath: string) => {
    const restored = fileTreeRef.current?.restoreContextMenuFocus(relativePath);
    if (restored) return;
    rootRef.current?.querySelector<HTMLElement>('[role="tree"]')?.focus();
  }, []);

  const handleContextAction = useCallback((action: FileContextAction, entry: FolderEntry) => {
    if (!theaterId) {
      showFeedback(t("fileExplorer.menu.actionUnavailable"));
      return;
    }
    void performFileContextAction(action, theaterId, entry.relativePath)
      .then((feedbackKey) => {
        if (feedbackKey) showFeedback(t(feedbackKey));
      })
      .catch(() => showFeedback(t("fileExplorer.menu.actionUnavailable")));
  }, [showFeedback, t, theaterId]);

  const handleDividerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    if (!canResizeTreePane(containerWidth)) return;
    const startX = e.clientX;
    const startWidth = treePaneWidthRef.current;
    setIsDragging(true);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const nextWidth = clampTreePaneWidth(startWidth, dx, containerWidth);
      treePaneWidthRef.current = nextWidth;
      setTreePaneWidth(nextWidth);
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      setIsDragging(false);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }, []);

  const handleDividerKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    const container = rootRef.current;
    if (!container) return;
    const containerWidth = container.getBoundingClientRect().width;
    const nextWidth = resizeTreePaneWithKeyboard(treePaneWidthRef.current, event.key, containerWidth);
    if (nextWidth === treePaneWidthRef.current) return;
    treePaneWidthRef.current = nextWidth;
    setTreePaneWidth(nextWidth);
  }, []);

  const isViewerActive = viewState.kind !== "none";

  useLayoutEffect(() => {
    if (!isViewerActive) {
      setSplitContainerWidth(0);
      return;
    }
    const container = rootRef.current;
    if (!container) return;
    const measure = () => setSplitContainerWidth(container.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [isViewerActive]);

  useLayoutEffect(() => {
    ctx.requestExtraWidth?.(resolveExtraWidth(isViewerActive));
  }, [ctx, isViewerActive]);

  const dividerState = getTreePaneSeparatorState(treePaneWidth, splitContainerWidth);

  return (
    <div
      ref={rootRef}
      className={`fexp-root${isViewerActive ? " is-split" : " is-tree-only"}${isDragging ? " is-dragging" : ""}`}
      style={isViewerActive
        ? { gridTemplateColumns: buildSplitGridTemplate(treePaneWidth) }
        : undefined}
    >
      {isViewerActive && (
        <>
          <div className="fexp-viewer-pane">
            <div className="fexp-viewer-head">
              <span className="fexp-viewer-filename">
                {viewState.kind !== "loading" && viewState.kind !== "error"
                  ? "relativePath" in viewState ? viewState.relativePath : viewState.name
                  : ""}
              </span>
              <button className="fexp-viewer-close" type="button" onClick={handleCloseViewer} aria-label={t("fileExplorer.viewer.close")}>
                ✕
              </button>
            </div>
            <div className="fexp-viewer-body">
              {viewState.kind === "loading" && <div className="fexp-viewer-loading">{t("fileExplorer.status.loading")}</div>}
              {viewState.kind === "error" && <div className="fexp-viewer-error">{viewState.message}</div>}
              {viewState.kind === "code" && viewState.lang === "markdown" && (
                <MarkdownViewer
                  content={viewState.content}
                  onOpenPath={openFilePath}
                  relativePath={viewState.relativePath}
                  theaterId={theaterId}
                  truncated={viewState.truncated}
                  language={ctx.language}
                />
              )}
              {viewState.kind === "code" && viewState.lang !== "markdown" && (
                <CodeViewer content={viewState.content} lang={viewState.lang} truncated={viewState.truncated} t={t} />
              )}
              {viewState.kind === "image" && (
                <ImageViewer src={viewState.src} name={viewState.name} />
              )}
              {viewState.kind === "binary" && (
                <BinaryViewer name={viewState.name} t={t} />
              )}
            </div>
          </div>
          <div
            className="fexp-divider"
            onPointerDown={handleDividerDown}
            onKeyDown={handleDividerKeyDown}
            role="separator"
            tabIndex={dividerState.tabIndex}
            aria-disabled={dividerState.ariaDisabled}
            aria-orientation="vertical"
            aria-valuenow={dividerState.currentWidth}
            aria-valuemin={dividerState.minWidth}
            aria-valuemax={dividerState.maxWidth}
            aria-label={t("fileExplorer.divider.resizeAria")}
          />
        </>
      )}
      <div className="fexp-tree-pane">
        <FileTree
          key={contextScope}
          ref={fileTreeRef}
          files={files}
          theaterId={theaterId}
          contextKey={contextScope}
          selectedPath={selectedPath}
          revealTarget={revealTarget}
          onSelect={handleSelect}
          onContextMenu={handleOpenContextMenu}
          t={t}
        />
      </div>
      {activeContextMenu && (
        <FileContextMenu
          key={activeContextMenu.id}
          anchor={activeContextMenu.anchor}
          boundaryRef={rootRef}
          returnFocusPath={activeContextMenu.returnFocusPath}
          t={t}
          onAction={(action) => handleContextAction(action, activeContextMenu.entry)}
          onClose={() => setActiveContextMenu(null)}
          onRestoreFocus={handleRestoreContextMenuFocus}
        />
      )}
      {feedback && (
        <div key={feedback.id} className="fexp-inline-toast" role="status" aria-live="polite">
          {feedback.message}
        </div>
      )}
    </div>
  );
}

function FileExplorerIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 5a2 2 0 012-2h3.586a1 1 0 01.707.293L10.707 4.7A1 1 0 0011.414 5H15a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
