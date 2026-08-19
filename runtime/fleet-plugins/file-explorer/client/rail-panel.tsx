import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor, RailSearchResult } from "@fleet-console/sdk/rail";

import type { FileReadResult, FileSearchResult, FolderEntry, FolderListResult } from "../server/types.js";
import "./explorer.css";
import {
  FileContextMenu,
  performFileContextAction,
  type FileContextAction,
} from "./context-menu.js";
import { countLines, formatByteSize } from "./format.js";
import { getT } from "./i18n/index.js";
import { translateServerError } from "./i18n/index.js";
import { FileIcon } from "./file-icon.js";
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
import {
  activateStoredDocument,
  canNavigateDocumentHistory,
  closeStoredDocument,
  hydrateStoredSession,
  navigateStoredHistory,
  setDocViewState,
  setTreePaneWidth,
  useFileExplorerViewState,
  type ViewState,
} from "./view-store.js";
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
    // 상한 표식 행 — 코어가 provider limit으로 자르기 때문에, 마커 자리를 확보하되
    // 자리가 남으면 결과를 줄이지 않는다. 추가 매치 수는 실제로 유지되는 결과 기준으로 센다.
    const keep = Math.min(items.length, Math.max(0, limit - 1));
    const marker: RailSearchResult | null = result.walkCapped
      ? { id: "file-explorer.search-capped", title: t("fileExplorer.search.capped"), activate: () => undefined, kind: "info" }
      : result.totalMatches > result.files.length
        ? { id: "file-explorer.search-more", title: t("fileExplorer.search.moreMatches", { count: result.totalMatches - keep }), activate: () => undefined, kind: "info" }
        : null;
    if (!marker) return items;
    return [...items.slice(0, keep), marker];
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

function nameOfPath(relativePath: string): string {
  return relativePath.split("/").filter(Boolean).at(-1) ?? relativePath;
}

function dirOfPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "" : relativePath.slice(0, slash + 1);
}

function FileExplorerPanel(ctx: RailPanelContext) {
  const { theaterId } = ctx;
  const t = getT(ctx.language);
  const contextScope = theaterId ?? "";
  const {
    selectedPath,
    openDocs,
    activePath,
    history,
    historyIndex,
    docStates,
    treePaneWidth,
  } = useFileExplorerViewState(contextScope);
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
  // 마크다운 소스 모드로 보는 경로들 — 문서별로 기억하고 프리뷰가 기본이다.
  const [sourceModePaths, setSourceModePaths] = useState<ReadonlySet<string>>(new Set());
  const searchTarget = useFileSearchTarget();

  // theaterId 변경마다 새 클라이언트 인스턴스를 생성한다(PluginFilesClient는 stateless).
  const files = useMemo(() => makeFilesClient(theaterId), [theaterId]);

  const docSession = useMemo(
    () => ({ openDocs, activePath, history, historyIndex }),
    [openDocs, activePath, history, historyIndex],
  );

  // 저장된 열린 문서 세션 복원 — 메모리에 이미 세션이 있으면 그쪽이 이긴다.
  useEffect(() => {
    hydrateStoredSession(contextScope || null);
  }, [contextScope]);

  const fetchDocContent = useCallback(async (relativePath: string, silent: boolean) => {
    if (!theaterId) return;
    const scope = contextScope;
    const name = nameOfPath(relativePath);
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();

    if (IMAGE_EXTS.has(ext)) {
      const src = `/plugins/file-explorer/files/image?theaterId=${encodeURIComponent(theaterId)}&path=${encodeURIComponent(relativePath)}`;
      setDocViewState(scope, relativePath, { kind: "image", relativePath, name, src });
      return;
    }

    if (!silent) setDocViewState(scope, relativePath, { kind: "loading" });
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
        setDocViewState(scope, relativePath, { kind: "binary", name });
        return;
      }
      setDocViewState(scope, relativePath, {
        kind: "code",
        relativePath: result.relativePath,
        content: result.content,
        lang: result.lang,
        truncated: result.truncated,
        sizeBytes: result.sizeBytes,
      });
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : "Unable to load file";
      if (raw === "binary_file") {
        setDocViewState(scope, relativePath, { kind: "binary", name });
      } else {
        setDocViewState(scope, relativePath, { kind: "error", message: translateServerError(raw, t) });
      }
    }
  }, [contextScope, t, theaterId]);

  const openFilePath = useCallback((relativePath: string, displayName?: string) => {
    if (!theaterId) return;
    const name = displayName ?? nameOfPath(relativePath);
    activateStoredDocument(contextScope, { relativePath, name });
  }, [contextScope, theaterId]);

  // 활성 문서가 바뀔 때 내용을 불러온다 — 캐시가 있으면 즉시 그리고 배경에서 재검증한다.
  const docStatesRef = useRef(docStates);
  docStatesRef.current = docStates;
  useEffect(() => {
    if (!activePath) return;
    void fetchDocContent(activePath, docStatesRef.current.has(activePath));
  }, [activePath, fetchDocContent]);

  useLayoutEffect(() => {
    if (!searchTarget || searchTarget.theaterId !== theaterId) return;
    setRevealTarget(searchTarget);
    openFilePath(searchTarget.relativePath);
    consumeFileSearchTarget(searchTarget);
  }, [openFilePath, searchTarget, theaterId]);

  const handleSelect = useCallback((entry: FolderEntry) => {
    if (entry.kind !== "file") return;
    openFilePath(entry.relativePath, entry.name);
  }, [openFilePath]);

  const handleCloseDoc = useCallback((relativePath: string) => {
    closeStoredDocument(contextScope, relativePath);
  }, [contextScope]);

  const handleRootKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // 컨텍스트 메뉴가 열려 있으면 메뉴의 Escape 경로가 우선한다(메뉴가 stopPropagation한다).
    if (!activePath) return;
    event.preventDefault();
    event.stopPropagation();
    closeStoredDocument(contextScope, activePath);
  }, [activePath, contextScope]);

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
    setSourceModePaths(new Set());
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

  const isViewerActive = activePath !== null;
  const activeDoc = activePath ? openDocs.find((doc) => doc.relativePath === activePath) ?? null : null;
  const viewState: ViewState = activePath
    ? docStates.get(activePath) ?? { kind: "loading" }
    : { kind: "none" };
  const isMarkdownDoc = viewState.kind === "code" && viewState.lang === "markdown";
  const showSource = activePath !== null && sourceModePaths.has(activePath);
  const canGoBack = canNavigateDocumentHistory(docSession, -1);
  const canGoForward = canNavigateDocumentHistory(docSession, 1);

  const handleToggleSourceMode = useCallback((source: boolean) => {
    if (!activePath) return;
    setSourceModePaths((current) => {
      if (current.has(activePath) === source) return current;
      const next = new Set(current);
      if (source) next.add(activePath);
      else next.delete(activePath);
      return next;
    });
  }, [activePath]);

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

  const viewerMeta = viewState.kind === "code"
    ? [
      viewState.sizeBytes !== undefined ? formatByteSize(viewState.sizeBytes) : null,
      t("fileExplorer.viewer.lines", { count: countLines(viewState.content) }),
    ].filter((part): part is string => part !== null && part !== "")
    : [];

  return (
    <div
      ref={rootRef}
      className={`fexp-root${isViewerActive ? " is-split" : " is-tree-only"}${isDragging ? " is-dragging" : ""}`}
      style={isViewerActive
        ? { gridTemplateColumns: buildSplitGridTemplate(treePaneWidth) }
        : undefined}
      onKeyDown={handleRootKeyDown}
    >
      {isViewerActive && (
        <>
          <div className="fexp-viewer-pane">
            <div className="fexp-chips" role="list" aria-label={t("fileExplorer.viewer.openFiles")}>
              {openDocs.map((doc) => (
                <div
                  key={doc.relativePath}
                  role="listitem"
                  className={`fexp-chip${doc.relativePath === activePath ? " is-active" : ""}`}
                >
                  <button
                    type="button"
                    className="fexp-chip-open"
                    aria-current={doc.relativePath === activePath ? "true" : undefined}
                    title={doc.relativePath}
                    onClick={() => openFilePath(doc.relativePath, doc.name)}
                  >
                    <span className="fexp-chip-icon" aria-hidden="true"><FileIcon name={doc.name} /></span>
                    <span className="fexp-chip-name">{doc.name}</span>
                  </button>
                  <button
                    type="button"
                    className="fexp-chip-close"
                    aria-label={t("fileExplorer.viewer.closeNamed", { name: doc.name })}
                    onClick={() => handleCloseDoc(doc.relativePath)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <div className="fexp-viewer-head">
              <button
                type="button"
                className="fexp-viewer-nav"
                disabled={!canGoBack}
                aria-label={t("fileExplorer.viewer.back")}
                title={t("fileExplorer.viewer.back")}
                onClick={() => navigateStoredHistory(contextScope, -1)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <button
                type="button"
                className="fexp-viewer-nav"
                disabled={!canGoForward}
                aria-label={t("fileExplorer.viewer.forward")}
                title={t("fileExplorer.viewer.forward")}
                onClick={() => navigateStoredHistory(contextScope, 1)}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {activeDoc && (
                <span className="fexp-viewer-doc-icon" aria-hidden="true"><FileIcon name={activeDoc.name} /></span>
              )}
              <span className="fexp-viewer-filename" title={activePath ?? undefined}>
                {activeDoc?.name ?? (activePath ? nameOfPath(activePath) : "")}
                {activePath && dirOfPath(activePath) && (
                  <span className="fexp-viewer-dir">{dirOfPath(activePath)}</span>
                )}
              </span>
              {isMarkdownDoc && (
                <div className="fexp-view-mode" role="group" aria-label={t("fileExplorer.viewer.viewModeAria")}>
                  <button
                    type="button"
                    aria-pressed={!showSource}
                    onClick={() => handleToggleSourceMode(false)}
                  >
                    {t("fileExplorer.viewer.previewMode")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={showSource}
                    onClick={() => handleToggleSourceMode(true)}
                  >
                    {t("fileExplorer.viewer.sourceMode")}
                  </button>
                </div>
              )}
              <button
                className="fexp-viewer-close"
                type="button"
                onClick={() => activePath && handleCloseDoc(activePath)}
                aria-label={t("fileExplorer.viewer.close")}
              >
                ✕
              </button>
            </div>
            <div className="fexp-viewer-body">
              {viewState.kind === "loading" && <div className="fexp-viewer-loading">{t("fileExplorer.status.loading")}</div>}
              {viewState.kind === "error" && <div className="fexp-viewer-error">{viewState.message}</div>}
              {viewState.kind === "code" && isMarkdownDoc && !showSource && (
                <MarkdownViewer
                  content={viewState.content}
                  onOpenPath={openFilePath}
                  relativePath={viewState.relativePath}
                  theaterId={theaterId}
                  truncated={viewState.truncated}
                  language={ctx.language}
                />
              )}
              {viewState.kind === "code" && (!isMarkdownDoc || showSource) && (
                <CodeViewer content={viewState.content} lang={viewState.lang} truncated={viewState.truncated} t={t} />
              )}
              {viewState.kind === "image" && (
                <ImageViewer src={viewState.src} name={viewState.name} />
              )}
              {viewState.kind === "binary" && (
                <BinaryViewer name={viewState.name} t={t} />
              )}
            </div>
            {viewerMeta.length > 0 && (
              <div className="fexp-viewer-meta">
                {viewerMeta.map((part, index) => (
                  <span key={index} className="fexp-viewer-meta-part">{part}</span>
                ))}
              </div>
            )}
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
        {isViewerActive && (
          <div className="fexp-tree-pane-label" aria-hidden="true">
            {t("fileExplorer.panel.title")}
          </div>
        )}
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
