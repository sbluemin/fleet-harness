import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import type { PaneContext, PaneDescriptor, PaneSearchResult } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor } from "@fleet-console/sdk/rail";
import { parseFileRef } from "@fleet-console/markdown/file-ref";
import { TheaterBadge, theaterInitials } from "@fleet-console/sdk/components/theater-badge";
import { FileIcon, FolderIcon } from "@fleet-console/sdk/components/file-icon";

import type { FileSearchItem, FileSearchResult, FolderEntry, FolderListResult } from "../server/types.js";
import "./explorer.css";
import {
  FileContextMenu,
  performFileContextAction,
  type FileContextAction,
} from "./context-menu.js";
import {
  DOCUMENT_PANE_ID,
  documentPaneTitle,
  FileExplorerDocumentCaptionActions,
  FileExplorerDocumentPane,
} from "./document-pane.js";
import { nameOfPath, refreshDocumentDiskStatus } from "./doc-loader.js";
import { knownMtime, noteEntryStats } from "./entry-stats.js";
import { getT } from "./i18n/index.js";
import { MIN_TREE_PX, MIN_VIEWER_PX } from "./layout.js";
import { makeFilesClient } from "./files-client.js";
import { FileTree, isFilterFocusShortcut, type FileTreeHandle } from "./tree.js";
import { loadedMtimeOf, stalePathsAfterRefresh } from "./viewer/stale.js";
import {
  activateStoredDocument,
  getFileExplorerSnapshot,
  hydrateStoredSession,
  markDocStale,
  seedDocMtime,
  useFileExplorerViewState,
} from "./view-store.js";
import { filePaneTarget, findReferencedFile, FileNavigationError, parseFileLocation, resolveFilePath } from "./file-navigation.js";
import { showFileNavigationError, setDocumentPaneOpen, setFileRevealTarget, setSelectedPath } from "./view-store.js";
import { parentDirOf } from "./viewer/stale.js";
import { ShellActionNotice, useShellAction } from "./shell-action.js";

const FEEDBACK_DURATION_MS = 2_500;
/** 트리 열이 처음 설 때의 폭 — 문서 창이 열리기 전에는 표면 전체가 이 폭이다. */
const TREE_PANE_DEFAULT_WIDTH = 360;
/** 문서 창이 처음 설 때 표면에 더해지는 폭. 이후로는 분할선이 정한다. */
const DOCUMENT_PANE_DEFAULT_WIDTH = 420;

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

export const fileExplorerEntry: RailEntryDescriptor = {
  id: "file-explorer",
  title: (locale) => getT(locale)("fileExplorer.panel.title"),
  icon: FileExplorerIcon,
  panes: ["file-explorer", DOCUMENT_PANE_ID],
  handles: {
    openFile: async (request) => {
      const ref = parseFileLocation(request.path);
      if (!ref) { showFileNavigationError("unsupported"); return { ok: false, reason: "unsupported" }; }
      try {
        const resolved = await resolveFilePath(request.theaterId, ref.path, request.pathKind);
        return filePaneTarget(request.theaterId, resolved, { ...ref, line: request.line ?? ref.line, column: request.column ?? ref.column });
      } catch (error) {
        const reason = error instanceof FileNavigationError ? error.reason : "not_found";
        showFileNavigationError(reason);
        return { ok: false, reason };
      }
    },
  },
};

/** 소스 트리 — 표면이 열리면 이 열이 선다. */
export const fileExplorerPane: PaneDescriptor = {
  id: "file-explorer",
  role: "primary",
  mounts: ["rail"],
  title: (ctx) => getT(ctx.language ?? "en")("fileExplorer.panel.title"),
  render: (ctx) => <FileExplorerTreePane {...ctx} />,
  defaultWidth: TREE_PANE_DEFAULT_WIDTH,
  minWidth: MIN_TREE_PX,
  search: async ({ query, theaterId, limit, signal, language }) => {
    const t = getT(language);
    const ref = parseFileRef(query);
    let referenced: Awaited<ReturnType<typeof findReferencedFile>>;
    try { referenced = await findReferencedFile(theaterId, query, signal); }
    catch (error) {
      if (signal.aborted) throw error;
      const reason = error instanceof FileNavigationError ? error.reason : "not_found";
      return [{ id: "file-explorer.invalid-reference", title: t(`fileExplorer.navigation.${reason}`), kind: "info", activate: () => undefined }];
    }
    const normalizedQuery = ref?.path ?? query;
    const response = await fetch("/plugins/file-explorer/files/palette-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 퍼지 결과는 파일로 좁히되, 정확한 폴더 참조는 아래에서 트리 대상으로 더한다.
      body: JSON.stringify({ theaterId, query: referenced?.resolved.path ?? normalizedQuery, limit, kinds: ["file"] }),
      signal,
    });
    if (!response.ok) throw new Error("file_search_failed");
    const result = await response.json() as FileSearchResult;
    const files = referenced ? [
      { relativePath: referenced.resolved.path, kind: referenced.resolved.kind },
      ...result.files.filter((file) => file.relativePath !== referenced.resolved.path),
    ] : result.files;
    const items: PaneSearchResult[] = files.map((file) => {
      const name = file.relativePath.split("/").at(-1) ?? file.relativePath;
      return {
        id: file.relativePath,
        title: name,
        subtitle: file.relativePath,
        // 트리와 같은 종류 아이콘 — 팔레트 행이 폴더 레일 아이콘 대신 파일이 무엇인지 말한다.
        icon: file.kind === "dir" ? <FolderIcon name={name} open={false} /> : <FileIcon name={name} />,
        exact: file.relativePath === (referenced?.resolved.path ?? normalizedQuery),
        activate: () => filePaneTarget(theaterId, { path: file.relativePath, kind: file.kind }, referenced?.ref ?? ref ?? {}),
      };
    });
    // 상한 표식 행 — 코어가 provider limit으로 자르기 때문에, 마커 자리를 확보하되
    // 자리가 남으면 결과를 줄이지 않는다. 추가 매치 수는 실제로 유지되는 결과 기준으로 센다.
    const keep = Math.min(items.length, Math.max(0, limit - 1));
    const marker: PaneSearchResult | null = result.walkCapped
      ? { id: "file-explorer.search-capped", title: t("fileExplorer.search.capped"), activate: () => undefined, kind: "info" }
      : result.totalMatches > result.files.length
        ? { id: "file-explorer.search-more", title: t("fileExplorer.search.moreMatches", { count: result.totalMatches - keep }), activate: () => undefined, kind: "info" }
        : result.truncated
          ? { id: "file-explorer.search-limit", title: t("fileExplorer.search.resultLimit", { count: result.totalMatches.toLocaleString() }), activate: () => undefined, kind: "info" }
          : null;
    if (!marker) return items;
    return [...items.slice(0, keep), marker];
  },
};

/**
 * 문서 창 — 트리가 파일을 열면 그 옆에 선다.
 *
 * `keepAlive`는 읽던 자리와 열린 칩을 지킨다. 캡션의 확대는 호스트 내장 표면이 같은 본문을
 * 캔버스에 세우는 것이므로, 여기서 따로 구현할 것이 없다.
 */
export const fileExplorerDocumentPane: PaneDescriptor = {
  id: DOCUMENT_PANE_ID,
  role: "detail",
  mounts: ["rail", "expanded"],
  title: (ctx) => documentPaneTitle(ctx),
  render: (ctx) => <FileExplorerDocumentPane {...ctx} />,
  captionActions: (ctx) => <FileExplorerDocumentCaptionActions {...ctx} />,
  defaultWidth: DOCUMENT_PANE_DEFAULT_WIDTH,
  minWidth: MIN_VIEWER_PX,
  keepAlive: true,
  onClose: ({ params }) => { if (params.theaterId) setDocumentPaneOpen(params.theaterId, false); },
};

function FileExplorerTreePane(ctx: PaneContext) {
  const { theaterId, panes } = ctx;
  const t = getT(ctx.language);
  const contextScope = theaterId ?? "";
  const { selectedPath, openDocs, docStates, revealTarget, navigationError } = useFileExplorerViewState(contextScope);
  const label = useSyncExternalStore(ctx.consoleState.subscribe, () => ctx.consoleState.getTheaters().find((theater) => theater.id === theaterId)?.label ?? "", () => "");
  const shellAction = useShellAction(ctx.shell, theaterId, selectedPath);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileTreeRef = useRef<FileTreeHandle | null>(null);
  const nextTransientIdRef = useRef(0);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [feedback, setFeedback] = useState<InlineFeedback | null>(null);
  const directoryPath = ctx.params.theaterId === theaterId ? ctx.params.directory : undefined;

  useEffect(() => {
    if (!theaterId || !ctx.visible || directoryPath === undefined) return;
    setSelectedPath(contextScope, directoryPath);
    setFileRevealTarget(contextScope, { theaterId, relativePath: directoryPath, kind: "dir", requestId: ctx.params.requestId ?? crypto.randomUUID() });
    // 착지 요청은 한 번만 소비한다. 이후 Theater 복귀가 새로 고른 파일을 덮지 않는다.
    panes.replaceParams({});
  }, [contextScope, ctx.params.requestId, ctx.visible, directoryPath, panes, theaterId]);

  // theaterId 변경마다 새 클라이언트 인스턴스를 생성한다(PluginFilesClient는 stateless).
  const files = useMemo(() => makeFilesClient(theaterId), [theaterId]);

  useEffect(() => {
    hydrateStoredSession(contextScope || null);
    const restored = getFileExplorerSnapshot(contextScope);
    if (restored.documentPaneOpen && restored.activePath) {
      panes.open({ paneId: DOCUMENT_PANE_ID, params: { path: restored.activePath, theaterId: contextScope }, focus: false });
    } else if (panes.isOpen(DOCUMENT_PANE_ID)) {
      panes.open({ paneId: DOCUMENT_PANE_ID, params: { path: "", theaterId: contextScope }, focus: false });
      panes.close(DOCUMENT_PANE_ID);
    }
  }, [contextScope, panes]);

  const openFilePath = useCallback((relativePath: string, displayName?: string) => {
    if (!theaterId) return;
    activateStoredDocument(contextScope, { relativePath, name: displayName ?? nameOfPath(relativePath) });
    panes.open({ paneId: DOCUMENT_PANE_ID, params: { path: relativePath, theaterId: contextScope } });
  }, [contextScope, panes, theaterId]);

  const handleSearchSelect = useCallback((item: FileSearchItem) => {
    if (!theaterId) return;
    const target = filePaneTarget(theaterId, { path: item.relativePath, kind: item.kind }, item.location);
    const params = { ...target.params, ...(item.preview ? { line: String(item.preview.lineNumber), ranges: JSON.stringify(item.preview.ranges) } : {}) };
    panes.open({ paneId: target.paneId, params });
  }, [panes, theaterId]);

  const handleSelect = useCallback((entry: FolderEntry) => {
    if (entry.kind !== "file") return;
    noteEntryStats(contextScope, [entry]);
    openFilePath(entry.relativePath, entry.name);
  }, [contextScope, openFilePath]);

  const docStatesRef = useRef(docStates);
  docStatesRef.current = docStates;
  const openDocsRef = useRef(openDocs);
  openDocsRef.current = openDocs;

  const handleEntriesRefreshed = useCallback((result: FolderListResult) => {
    const entries = result.entries;
    noteEntryStats(contextScope, entries);
    const loadedMtimeByPath = new Map<string, number | undefined>();
    for (const doc of openDocsRef.current) {
      loadedMtimeByPath.set(doc.relativePath, loadedMtimeOf(docStatesRef.current.get(doc.relativePath)));
    }
    // 목록이 먼저 도착하는 경우(검색·세션 복원으로 연 문서)를 위해, mtime 없이 열린
    // 문서에는 이제 알게 된 mtime을 심어 준다 — 그러지 않으면 이후 변경이 영원히 표식 없이 지나간다.
    for (const doc of openDocsRef.current) {
      if (loadedMtimeByPath.get(doc.relativePath) !== undefined) continue;
      const known = knownMtime(contextScope, doc.relativePath);
      if (known === undefined) continue;
      seedDocMtime(contextScope, doc.relativePath, known);
      loadedMtimeByPath.set(doc.relativePath, known);
    }
    const stale = stalePathsAfterRefresh({
      relativeDir: result.relativePath,
      entries,
      openPaths: openDocsRef.current.map((doc) => doc.relativePath),
      loadedMtimeByPath,
      truncated: result.truncated === true,
    });
    for (const path of stale) {
      const deleted = result.truncated !== true && !entries.some((entry) => entry.relativePath === path);
      markDocStale(contextScope, path, true, deleted ? "deleted" : "changed");
    }
    // 500개 밖의 열린 문서는 목록 부재로 삭제를 단정하지 않는다. 내용 없이 stat만 확인한다.
    const unlisted = result.truncated ? openDocsRef.current.filter((doc) => parentDirOf(doc.relativePath) === result.relativePath && !entries.some((entry) => entry.relativePath === doc.relativePath)).map((doc) => doc.relativePath) : [];
    if (unlisted.length > 0) void refreshDocumentDiskStatus(contextScope, unlisted).catch(() => undefined);
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

  const handleOpenContextMenu = useCallback((entry: FolderEntry, x: number, y: number) => {
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
    if (action === "openShell") {
      shellAction.open(entry.kind === "file" ? parentDirOf(entry.relativePath) : entry.relativePath);
      return;
    }
    void performFileContextAction(action, theaterId, entry.relativePath)
      .then((feedbackKey) => {
        if (feedbackKey) showFeedback(t(feedbackKey));
      })
      .catch(() => showFeedback(t("fileExplorer.menu.actionUnavailable")));
  }, [shellAction, showFeedback, t, theaterId]);

  const handleRowActionFailed = useCallback(() => {
    showFeedback(t("fileExplorer.menu.actionUnavailable"));
  }, [showFeedback, t]);

  const handleRootKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!isFilterFocusShortcut(event.key, event.target)) return;
    event.preventDefault();
    fileTreeRef.current?.focusFilter();
  }, []);

  /** 열린 문서들의 부모 폴더 — 트리에서 접혀 있어도 이 폴더의 변경은 지켜봐야 낡음 표식이 선다. */
  const watchedDocumentDirectories = useMemo(() => {
    const dirs = new Set<string>();
    for (const doc of openDocs) {
      const slash = doc.relativePath.lastIndexOf("/");
      dirs.add(slash < 0 ? "" : doc.relativePath.slice(0, slash));
    }
    return [...dirs];
  }, [openDocs]);

  return (
    <div ref={rootRef} className="fexp-root" onKeyDown={handleRootKeyDown}>
      <div className="fexp-tree-pane">
        <div className="fexp-theater-head">
          {label && <TheaterBadge label={label} initials={theaterInitials(label)} />}
          {navigationError && <span className="fexp-navigation-error">{t(`fileExplorer.navigation.${navigationError.reason}`)}</span>}
          <ShellActionNotice action={shellAction} t={t} />
        </div>
        <FileTree
          key={contextScope}
          ref={fileTreeRef}
          files={files}
          theaterId={theaterId}
          contextKey={contextScope}
          selectedPath={selectedPath}
          revealTarget={revealTarget}
          onSelect={handleSelect}
          onSearchSelect={handleSearchSelect}
          onContextMenu={handleOpenContextMenu}
          onEntriesRefreshed={handleEntriesRefreshed}
          watchedDirectories={watchedDocumentDirectories}
          onActionFailed={handleRowActionFailed}
          language={ctx.language}
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
