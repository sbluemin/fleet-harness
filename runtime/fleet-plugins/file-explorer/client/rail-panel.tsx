import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { PaneContext, PaneDescriptor } from "@fleet-console/sdk/pane";
import type { RailEntryDescriptor, RailSearchResult } from "@fleet-console/sdk/rail";

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
import { nameOfPath } from "./doc-loader.js";
import { knownMtime, noteEntryStats } from "./entry-stats.js";
import { getT } from "./i18n/index.js";
import { MIN_TREE_PX, MIN_VIEWER_PX } from "./layout.js";
import { makeFilesClient } from "./files-client.js";
import { FileTree, isFilterFocusShortcut, type FileTreeHandle } from "./tree.js";
import { loadedMtimeOf, stalePathsAfterRefresh } from "./viewer/stale.js";
import {
  activateStoredDocument,
  hydrateStoredSession,
  markDocStale,
  seedDocMtime,
  useFileExplorerViewState,
} from "./view-store.js";
import {
  activateFileSearchTarget,
  consumeFileSearchTarget,
  mintRevealRequestId,
  setFileRevealTarget,
  useFileRevealTarget,
  useFileSearchTarget,
  type FileSearchTarget,
} from "./search-navigation.js";

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
    const response = await fetch("/plugins/file-explorer/files/palette-search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 파일 열기 팔레트는 파일만 받는다 — 디렉터리를 문서로 열면 not_a_file로 끝난다.
      body: JSON.stringify({ theaterId, query, limit, kinds: ["file"] }),
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
};

function FileExplorerTreePane(ctx: PaneContext) {
  const { theaterId, panes } = ctx;
  const t = getT(ctx.language);
  const contextScope = theaterId ?? "";
  const { selectedPath, openDocs, docStates } = useFileExplorerViewState(contextScope);
  const rootRef = useRef<HTMLDivElement>(null);
  const fileTreeRef = useRef<FileTreeHandle | null>(null);
  const nextTransientIdRef = useRef(0);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [feedback, setFeedback] = useState<InlineFeedback | null>(null);
  const revealTarget = useFileRevealTarget();
  const searchTarget = useFileSearchTarget();

  // theaterId 변경마다 새 클라이언트 인스턴스를 생성한다(PluginFilesClient는 stateless).
  const files = useMemo(() => makeFilesClient(theaterId), [theaterId]);

  // 저장된 열린 문서 세션 복원 — 메모리에 이미 세션이 있으면 그쪽이 이긴다.
  useEffect(() => {
    hydrateStoredSession(contextScope || null);
  }, [contextScope]);

  // 복원된 세션에도 문서 창이 서야 한다 — 칩만 살아나고 열이 없으면 읽던 문서가 사라진 것으로 보인다.
  const restoredPath = openDocs.length > 0 ? selectedPath ?? openDocs.at(-1)?.relativePath ?? null : null;
  useEffect(() => {
    if (!restoredPath) return;
    panes.open({ paneId: DOCUMENT_PANE_ID, params: { path: restoredPath }, focus: false });
    // 한 번 세우고 나면 이후의 문서 전환은 스토어가 진다 — 여기서 다시 열면 매 전환마다
    // 포커스가 문서 창으로 끌려간다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextScope, panes, restoredPath !== null]);

  const openFilePath = useCallback((relativePath: string, displayName?: string) => {
    if (!theaterId) return;
    activateStoredDocument(contextScope, { relativePath, name: displayName ?? nameOfPath(relativePath) });
    panes.open({ paneId: DOCUMENT_PANE_ID, params: { path: relativePath } });
  }, [contextScope, panes, theaterId]);

  useLayoutEffect(() => {
    if (!searchTarget || searchTarget.theaterId !== theaterId) return;
    setFileRevealTarget(searchTarget);
    openFilePath(searchTarget.relativePath);
    consumeFileSearchTarget(searchTarget);
  }, [openFilePath, searchTarget, theaterId]);

  const handleSearchSelect = useCallback((item: FileSearchItem) => {
    if (!theaterId || item.kind !== "file") return;
    const target: FileSearchTarget = {
      theaterId,
      relativePath: item.relativePath,
      requestId: mintRevealRequestId(),
      ...(item.preview ? { lineNumber: item.preview.lineNumber, ranges: item.preview.ranges } : {}),
    };
    setFileRevealTarget(target);
    openFilePath(item.relativePath);
  }, [openFilePath, theaterId]);

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
      markDocStale(contextScope, path, true);
    }
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
    void performFileContextAction(action, theaterId, entry.relativePath)
      .then((feedbackKey) => {
        if (feedbackKey) showFeedback(t(feedbackKey));
      })
      .catch(() => showFeedback(t("fileExplorer.menu.actionUnavailable")));
  }, [showFeedback, t, theaterId]);

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
