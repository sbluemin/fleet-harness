import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { RailPanelContext, RailPanelDescriptor, RailSearchResult } from "@fleet-console/sdk/rail";

import type { FileReadResult, FileSearchItem, FileSearchResult, FolderEntry, FolderListResult } from "../server/types.js";
import "./explorer.css";
import {
  FileContextMenu,
  performFileContextAction,
  type FileContextAction,
} from "./context-menu.js";
import { breadcrumbSegments, buildViewerMetaParts } from "./format.js";
import { getT } from "./i18n/index.js";
import { translateServerError } from "./i18n/index.js";
import { FileIcon } from "./file-icon.js";
import { FileTree, isFilterFocusShortcut, type FileTreeHandle, type PluginFilesClient } from "./tree.js";
import { BinaryViewer } from "./viewer/binary.js";
import { canWrapLines, CodeViewer } from "./viewer/code.js";
import { cacheBustedImageSrc, ImageViewer } from "./viewer/image.js";
import { MarkdownViewer } from "./viewer/markdown.js";
import { loadedMtimeOf, parentDirOf, stalePathsAfterRefresh } from "./viewer/stale.js";
import {
  buildSplitGridTemplate,
  canResizeTreePane,
  CHIP_STRIP_GAP_PX,
  chipDirHints,
  clampTreePaneWidth,
  countOverflowingChips,
  getTreePaneSeparatorState,
  resizeTreePaneWithKeyboard,
  resolveExtraWidth,
} from "./layout.js";
import {
  activateStoredDocument,
  canNavigateDocumentHistory,
  closeStoredDocument,
  hydrateStoredSession,
  markDocStale,
  seedDocMtime,
  navigateStoredHistory,
  setDocViewState,
  setTreePaneWidth,
  setWrapLines,
  useFileExplorerViewState,
  type ViewState,
} from "./view-store.js";
import { activateFileSearchTarget, consumeFileSearchTarget, mintRevealRequestId, useFileSearchTarget, type FileSearchTarget } from "./search-navigation.js";

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const FEEDBACK_DURATION_MS = 2_500;
/**
 * 폴더 브레드크럼 클릭 복사의 더블클릭 유예 — 이 안에 두 번째 클릭이 오면 복사 없이 reveal만 한다.
 * 브라우저는 OS 더블클릭 간격을 노출하지 않으므로 널리 쓰이는 OS 기본 상한(500ms)에 맞춘다 —
 * 이보다 짧으면 기본 설정의 느긋한 더블클릭에서도 복사가 먼저 나가 클립보드를 덮는다.
 */
const CRUMB_DBLCLICK_GRACE_MS = 500;

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
    wrapLines,
  } = useFileExplorerViewState(contextScope);
  const treePaneWidthRef = useRef(treePaneWidth);
  treePaneWidthRef.current = treePaneWidth;
  const rootRef = useRef<HTMLDivElement>(null);
  const fileTreeRef = useRef<FileTreeHandle | null>(null);
  const chipsRef = useRef<HTMLDivElement>(null);
  // Theater마다 다른 경로 공간이다 — 스코프를 바꿀 때 비우지 않으면 A의 foo.png mtime이
  // B의 같은 이름 파일에 실려 바뀌지도 않은 문서를 낡음으로 표시한다.
  const knownMtimesRef = useRef(new Map<string, number>());
  /** 목록이 알려 준 파일 크기 — 이미지 뷰어 메타 바가 용량을 사실로 말하기 위한 캐시. */
  const knownSizesRef = useRef(new Map<string, number>());
  const nextTransientIdRef = useRef(0);
  const [isDragging, setIsDragging] = useState(false);
  const [revealTarget, setRevealTarget] = useState<FileSearchTarget | null>(null);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveContextMenu | null>(null);
  const [feedback, setFeedback] = useState<InlineFeedback | null>(null);
  const [splitContainerWidth, setSplitContainerWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 0 : window.innerWidth);
  const [chipOverflow, setChipOverflow] = useState(0);
  const [chipsScrolled, setChipsScrolled] = useState(false);
  // 마크다운 소스 모드로 보는 경로들 — 문서별로 기억하고 프리뷰가 기본이다.
  const [sourceModePaths, setSourceModePaths] = useState<ReadonlySet<string>>(new Set());
  const searchTarget = useFileSearchTarget();

  // theaterId 변경마다 새 클라이언트 인스턴스를 생성한다(PluginFilesClient는 stateless).
  const files = useMemo(() => makeFilesClient(theaterId), [theaterId]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const contextScopeRef = useRef(contextScope);
  contextScopeRef.current = contextScope;

  const docSession = useMemo(
    () => ({ openDocs, activePath, history, historyIndex }),
    [openDocs, activePath, history, historyIndex],
  );

  // 저장된 열린 문서 세션 복원 — 메모리에 이미 세션이 있으면 그쪽이 이긴다.
  useEffect(() => {
    hydrateStoredSession(contextScope || null);
  }, [contextScope]);

  useEffect(() => {
    knownMtimesRef.current = new Map<string, number>();
    knownSizesRef.current = new Map<string, number>();
  }, [contextScope]);

  const fetchDocContent = useCallback(async (relativePath: string, silent: boolean) => {
    if (!theaterId) return;
    const scope = contextScope;
    const name = nameOfPath(relativePath);
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();

    if (IMAGE_EXTS.has(ext)) {
      // 부모 폴더를 한 번도 나열한 적이 없으면(검색·세션 복원으로 연 경우) 기준 mtime이 없다.
      // 그 상태로 두면 첫 목록이 "이미 바뀐 뒤"의 값일 수 있어 그 변경을 영영 놓친다 — 지금 확보한다.
      if (!knownMtimesRef.current.has(relativePath)) {
        try {
          const listing = await filesRef.current.listFolder(parentDirOf(relativePath));
          for (const entry of listing.entries) {
            if (entry.mtimeMs !== undefined) knownMtimesRef.current.set(entry.relativePath, entry.mtimeMs);
            if (entry.sizeBytes !== undefined) knownSizesRef.current.set(entry.relativePath, entry.sizeBytes);
          }
        } catch { /* 목록 실패는 표식 없이 여는 것으로 감수한다 — 다음 목록에서 회복된다 */ }
        if (scope !== contextScopeRef.current) return;
      }
      const mtimeMs = knownMtimesRef.current.get(relativePath);
      const sizeBytes = knownSizesRef.current.get(relativePath);
      const src = cacheBustedImageSrc(
        `/plugins/file-explorer/files/image?theaterId=${encodeURIComponent(theaterId)}&path=${encodeURIComponent(relativePath)}`,
        mtimeMs,
      );
      setDocViewState(scope, relativePath, { kind: "image", relativePath, name, src, mtimeMs, sizeBytes, stale: false });
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
      knownMtimesRef.current.set(relativePath, result.mtimeMs);
      setDocViewState(scope, relativePath, {
        kind: "code",
        relativePath: result.relativePath,
        content: result.content,
        lang: result.lang,
        truncated: result.truncated,
        sizeBytes: result.sizeBytes,
        mtimeMs: result.mtimeMs,
        stale: false,
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
  const openDocsRef = useRef(openDocs);
  openDocsRef.current = openDocs;
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

  const handleSearchSelect = useCallback((item: FileSearchItem) => {
    if (!theaterId || item.kind !== "file") return;
    const target: FileSearchTarget = {
      theaterId,
      relativePath: item.relativePath,
      requestId: mintRevealRequestId(),
      ...(item.preview ? { lineNumber: item.preview.lineNumber, ranges: item.preview.ranges } : {}),
    };
    setRevealTarget(target);
    openFilePath(item.relativePath);
  }, [openFilePath, theaterId]);

  const handleSelect = useCallback((entry: FolderEntry) => {
    if (entry.kind !== "file") return;
    if (entry.mtimeMs !== undefined) knownMtimesRef.current.set(entry.relativePath, entry.mtimeMs);
    if (entry.sizeBytes !== undefined) knownSizesRef.current.set(entry.relativePath, entry.sizeBytes);
    openFilePath(entry.relativePath, entry.name);
  }, [openFilePath]);

  const handleEntriesRefreshed = useCallback((result: FolderListResult) => {
    const entries = result.entries;
    for (const entry of entries) {
      if (entry.mtimeMs !== undefined) knownMtimesRef.current.set(entry.relativePath, entry.mtimeMs);
      if (entry.sizeBytes !== undefined) knownSizesRef.current.set(entry.relativePath, entry.sizeBytes);
    }
    const loadedMtimeByPath = new Map<string, number | undefined>();
    for (const doc of openDocsRef.current) {
      loadedMtimeByPath.set(doc.relativePath, loadedMtimeOf(docStatesRef.current.get(doc.relativePath)));
    }
    // 목록이 먼저 도착하는 경우(검색·세션 복원으로 연 문서)를 위해, mtime 없이 열린
    // 문서에는 이제 알게 된 mtime을 심어 준다 — 그러지 않으면 이후 변경이 영원히 표식 없이 지나간다.
    for (const doc of openDocsRef.current) {
      if (loadedMtimeByPath.get(doc.relativePath) !== undefined) continue;
      const known = knownMtimesRef.current.get(doc.relativePath);
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

  const handleCloseDoc = useCallback((relativePath: string) => {
    closeStoredDocument(contextScope, relativePath);
  }, [contextScope]);

  const handleReloadStale = useCallback(() => {
    if (!activePath) return;
    void fetchDocContent(activePath, true);
  }, [activePath, fetchDocContent]);

  const handleRootKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    // "/"는 패널 어디서든 필터로 — 트리만 잡으면 뷰어 페인(칩·브레드크럼·줌)에서 단축키가 죽는다.
    if (isFilterFocusShortcut(event.key, event.target)) {
      event.preventDefault();
      fileTreeRef.current?.focusFilter();
      return;
    }
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

  /** 브레드크럼 조각 클릭 — 그 조각까지의 상대 경로를 복사한다(컨텍스트 메뉴의 상대 경로 복사와 같은 결과). */
  const handleCrumbCopy = useCallback((path: string) => {
    void (async () => {
      try {
        const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
        if (!clipboard) throw new Error("clipboard_unavailable");
        await clipboard.writeText(path);
        showFeedback(t("fileExplorer.menu.relativePathCopied"));
      } catch {
        showFeedback(t("fileExplorer.menu.actionUnavailable"));
      }
    })();
  }, [showFeedback, t]);

  /** 폴더 조각 더블클릭 — 트리에서 그 폴더를 펼쳐 보여준다(검색 reveal 배선 재사용). */
  const handleCrumbReveal = useCallback((path: string) => {
    if (!theaterId) return;
    setRevealTarget({ theaterId, relativePath: path, requestId: mintRevealRequestId() });
  }, [theaterId]);

  // 더블클릭은 click을 두 번 앞세운다 — 폴더 조각의 복사를 유예 없이 실행하면
  // reveal 더블클릭마다 클립보드가 두 번 덮인다. 유예 안에 두 번째 클릭이 오면 복사를 접는다.
  const crumbCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPendingCrumbCopy = useCallback(() => {
    if (crumbCopyTimerRef.current === null) return;
    clearTimeout(crumbCopyTimerRef.current);
    crumbCopyTimerRef.current = null;
  }, []);
  useEffect(() => cancelPendingCrumbCopy, [cancelPendingCrumbCopy, contextScope]);

  const handleCrumbDirClick = useCallback((path: string, detail: number) => {
    cancelPendingCrumbCopy();
    // 브라우저가 이미 다중 클릭으로 인식한 클릭(detail>1)은 reveal 제스처의 일부다 — 복사를 다시 걸지 않는다.
    if (detail > 1) return;
    crumbCopyTimerRef.current = setTimeout(() => {
      crumbCopyTimerRef.current = null;
      handleCrumbCopy(path);
    }, CRUMB_DBLCLICK_GRACE_MS);
  }, [cancelPendingCrumbCopy, handleCrumbCopy]);

  const handleCrumbDirDoubleClick = useCallback((path: string) => {
    cancelPendingCrumbCopy();
    handleCrumbReveal(path);
  }, [cancelPendingCrumbCopy, handleCrumbReveal]);

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
  const showCodePane = viewState.kind === "code" && (!isMarkdownDoc || showSource);
  // 줄바꿈은 창을 나누지 않고 전부 그리므로, 감당 가능한 줄 수까지만 연다.
  const wrapAvailable = viewState.kind === "code" && canWrapLines(viewState.content.split("\n").length);
  const canGoBack = canNavigateDocumentHistory(docSession, -1);
  const canGoForward = canNavigateDocumentHistory(docSession, 1);
  const isStale = (viewState.kind === "code" || viewState.kind === "image") && Boolean(viewState.stale);

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

  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    ctx.requestExtraWidth?.(resolveExtraWidth(isViewerActive, viewportWidth));
  }, [ctx, isViewerActive, viewportWidth]);

  /** 열린 문서들의 부모 폴더 — 트리에서 접혀 있어도 이 폴더의 변경은 지켜봐야 낡음 표식이 선다. */
  const watchedDocumentDirectories = useMemo(() => {
    const dirs = new Set<string>();
    for (const doc of openDocs) {
      const slash = doc.relativePath.lastIndexOf("/");
      dirs.add(slash < 0 ? "" : doc.relativePath.slice(0, slash));
    }
    return [...dirs];
  }, [openDocs]);

  const measureChipOverflow = useCallback(() => {
    const container = chipsRef.current;
    if (!container) {
      setChipOverflow(0);
      setChipsScrolled(false);
      return;
    }
    const widths = [...container.querySelectorAll<HTMLElement>(".fexp-chip")].map((el) => el.getBoundingClientRect().width);
    setChipOverflow(countOverflowingChips(container.clientWidth, container.scrollLeft, widths, CHIP_STRIP_GAP_PX));
    setChipsScrolled(container.scrollLeft > 1);
  }, []);

  /**
   * 활성 칩을 띠 안으로 끌어온다. scrollIntoView({inline:"nearest"})는 칩이 "조금 걸친" 상태를
   * 이미 보이는 것으로 판정해 그대로 두므로(실측: 오른쪽 끝이 31px 잘린 채 유지), 좌표로 직접 민다.
   */
  const ensureActiveChipVisible = useCallback(() => {
    const container = chipsRef.current;
    const activeChip = container?.querySelector<HTMLElement>(".fexp-chip.is-active");
    if (!container || !activeChip) return;
    const left = activeChip.offsetLeft;
    const right = left + activeChip.offsetWidth;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    if (left < viewLeft) container.scrollLeft = Math.max(0, left - CHIP_STRIP_GAP_PX);
    else if (right > viewRight) container.scrollLeft = right - container.clientWidth + CHIP_STRIP_GAP_PX;
  }, []);

  useLayoutEffect(() => {
    const container = chipsRef.current;
    if (!container || !isViewerActive) {
      setChipOverflow(0);
      setChipsScrolled(false);
      return;
    }
    measureChipOverflow();
    ensureActiveChipVisible();
    measureChipOverflow();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureChipOverflow);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activePath, chipOverflow, ensureActiveChipVisible, isViewerActive, measureChipOverflow, openDocs]);

  const dividerState = getTreePaneSeparatorState(treePaneWidth, splitContainerWidth);

  const viewerMeta = viewState.kind === "code"
    ? buildViewerMetaParts(viewState, t)
    : [];

  const chipHints = useMemo(() => chipDirHints(openDocs), [openDocs]);
  const crumbSegments = useMemo(() => activePath ? breadcrumbSegments(activePath) : [], [activePath]);

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
            <div className="fexp-chips-wrap">
              <div
                ref={chipsRef}
                className={`fexp-chips${chipOverflow > 0 ? " is-overflowing" : ""}${chipsScrolled ? " is-scrolled" : ""}`}
                role="list"
                aria-label={t("fileExplorer.viewer.openFiles")}
                onScroll={measureChipOverflow}
              >
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
                      {chipHints.has(doc.relativePath) && (
                        <span className="fexp-chip-dir" aria-hidden="true">{chipHints.get(doc.relativePath)}</span>
                      )}
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
              {chipOverflow > 0 && (
                <span
                  className="fexp-chips-more"
                  title={t("fileExplorer.viewer.moreChipsTitle", { count: chipOverflow })}
                >
                  {t("fileExplorer.viewer.moreChips", { count: chipOverflow })}
                </span>
              )}
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
              <div className="fexp-viewer-crumb" role="group" aria-label={t("fileExplorer.viewer.pathAria")}>
                {crumbSegments.map((segment, index) => (
                  <span key={segment.path} className="fexp-crumb-part">
                    {index > 0 && <span className="fexp-crumb-sep" aria-hidden="true">/</span>}
                    <button
                      type="button"
                      className={`fexp-crumb-seg${segment.isLeaf ? " is-leaf" : ""}`}
                      title={segment.isLeaf
                        ? t("fileExplorer.viewer.crumbFileTitle", { path: segment.path })
                        : t("fileExplorer.viewer.crumbDirTitle", { path: segment.path })}
                      onClick={segment.isLeaf
                        ? () => handleCrumbCopy(segment.path)
                        : (event) => handleCrumbDirClick(segment.path, event.detail)}
                      onDoubleClick={segment.isLeaf ? undefined : () => handleCrumbDirDoubleClick(segment.path)}
                    >
                      {segment.name}
                    </button>
                  </span>
                ))}
              </div>
              {isStale && (
                <button
                  type="button"
                  className="fexp-viewer-stale"
                  title={t("fileExplorer.viewer.staleTitle")}
                  onClick={handleReloadStale}
                >
                  {t("fileExplorer.viewer.staleReload")}
                </button>
              )}
              {showCodePane && (
                <button
                  type="button"
                  className="fexp-viewer-wrap"
                  aria-pressed={wrapLines && wrapAvailable}
                  disabled={!wrapAvailable}
                  title={wrapAvailable
                    ? (wrapLines ? t("fileExplorer.viewer.wrapOff") : t("fileExplorer.viewer.wrapOn"))
                    : t("fileExplorer.viewer.wrapUnavailable")}
                  aria-label={wrapAvailable
                    ? (wrapLines ? t("fileExplorer.viewer.wrapOff") : t("fileExplorer.viewer.wrapOn"))
                    : t("fileExplorer.viewer.wrapUnavailable")}
                  onClick={() => setWrapLines(!wrapLines)}
                >
                  {wrapLines && wrapAvailable ? t("fileExplorer.viewer.wrapOff") : t("fileExplorer.viewer.wrapOn")}
                </button>
              )}
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
              {showCodePane && viewState.kind === "code" && (
                <CodeViewer
                  content={viewState.content}
                  lang={viewState.lang}
                  truncated={viewState.truncated}
                  wrap={wrapLines}
                  target={revealTarget?.relativePath === activePath && revealTarget.lineNumber ? {
                    lineNumber: revealTarget.lineNumber,
                    ranges: revealTarget.ranges ?? [],
                  } : undefined}
                  t={t}
                />
              )}
              {viewState.kind === "image" && (
                <ImageViewer src={viewState.src} name={viewState.name} sizeBytes={viewState.sizeBytes} t={t} />
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
