import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

import { CaptionActionButton } from "@fleet-console/sdk/components/caption-actions";
import type { PaneContext } from "@fleet-console/sdk/pane";

import type { FolderEntry, FolderListResult } from "../server/types.js";
import { performFileContextAction, type FileContextAction } from "./context-menu.js";
import { loadDocument, nameOfPath } from "./doc-loader.js";
import { breadcrumbSegments, buildViewerMetaParts, type BreadcrumbSegment } from "./format.js";
import { FileIcon } from "./file-icon.js";
import { makeFilesClient } from "./files-client.js";
import { getT } from "./i18n/index.js";
import { CHIP_STRIP_GAP_PX, chipDirHints, overflowingChipIndices, tabLineGeometry } from "./layout.js";
import { QuietMenu } from "./quiet-menu.js";
import { mintRevealRequestId, setFileRevealTarget, useFileRevealTarget } from "./search-navigation.js";
import {
  activateStoredDocument,
  canNavigateDocumentHistory,
  closeStoredDocument,
  navigateStoredHistory,
  setWrapLines,
  useFileExplorerViewState,
  type OpenDocument,
  type ViewState,
} from "./view-store.js";
import { BinaryViewer } from "./viewer/binary.js";
import { canWrapLines, CodeViewer } from "./viewer/code.js";
import { ImageViewer } from "./viewer/image.js";
import { MarkdownViewer } from "./viewer/markdown.js";
import { parentDirOf } from "./viewer/stale.js";

/**
 * 문서 창 — 표면의 detail 열.
 *
 * 트리와 한 본문 안에 있던 시절 이 절반은 `is-split` 격자의 첫 칸이었고, 폭·분할선·닫기 버튼을
 * 스스로 그렸다. 이제 그 셋은 전부 표면이 진다. 여기 남은 것은 **무엇을 읽고 있는가**뿐이다.
 *
 * 문서 세션(열린 칩·활성 경로·이력)은 `view-store`가 Theater 단위로 들고 있다. 두 페인이 같은
 * 세션을 보므로 어느 쪽도 그것을 소유하지 않는다 — 트리는 열고, 이 페인은 읽는다.
 *
 * 주소(`params.path`)와 활성 경로의 방향은 하나다: **스토어가 진실이고 주소가 따라간다.** 반대
 * 방향은 페인이 처음 설 때 한 번만 열린다(공유 링크·확대 표면에서 곧장 들어오는 경우).
 */

export const DOCUMENT_PANE_ID = "file-explorer-document";

/** 복사 확인("복사됨")이 제자리에 서 있는 시간. */
const COPY_NOTE_MS = 1200;
/** 활성 탭 밑줄이 탭 글자 폭에서 양쪽으로 물러나는 px. */
const TAB_LINE_INSET_PX = 8;

/** 캡션에 설 이름 — 페인 종류가 아니라 지금 담은 문서를 말한다. */
export function documentPaneTitle(ctx: PaneContext): string {
  const t = getT(ctx.language);
  // 다른 Theater에서 실려 온 주소는 이름도 말하지 않는다 — 그 이름은 지금 화면에 없는 문서다.
  const path = ctx.params.theaterId === (ctx.theaterId ?? "") ? ctx.params.path : undefined;
  return path ? nameOfPath(path) : t("fileExplorer.panel.title");
}

export function FileExplorerDocumentPane(ctx: PaneContext) {
  const { theaterId, params, panes, signal, language } = ctx;
  const t = getT(language);
  const contextScope = theaterId ?? "";
  const { openDocs, activePath, docStates, wrapLines } = useFileExplorerViewState(contextScope);
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabsMoreRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [hiddenTabs, setHiddenTabs] = useState<readonly number[]>([]);
  const [tabsScrolled, setTabsScrolled] = useState(false);
  const [tabLine, setTabLine] = useState<{ readonly left: number; readonly width: number } | null>(null);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  const [sourceModePaths, setSourceModePaths] = useState<ReadonlySet<string>>(new Set());
  const [crumbPop, setCrumbPop] = useState<CrumbPopState | null>(null);
  const [copied, setCopied] = useState(false);
  const revealTarget = useFileRevealTarget();

  useEffect(() => {
    setSourceModePaths(new Set());
  }, [contextScope]);

  // 주소가 지목한 문서를 세션에 **세우기만** 한다 — 공유 링크나 확대 표면에서 곧장 들어와
  // 아직 아무것도 열려 있지 않을 때가 그 자리다.
  //
  // 활성 문서가 이미 있으면 손대지 않는다. 주소와 활성이 어긋날 때마다 주소 쪽으로 되돌리면,
  // 같은 페인이 두 자리에 서 있는 순간(확대 + 레일 주차) 두 사본이 서로 다른 주소로 스토어를
  // 번갈아 되돌려 갱신이 멈추지 않는다. 방향은 하나여야 한다 — 스토어가 진실, 주소가 사본.
  //
  // 주소는 **자기 Theater 안에서만** 뜻이 있다. 이 열은 `keepAlive`라 Theater를 갈아타도
  // 인스턴스가 살아남고, 그 인스턴스가 든 경로는 떠나온 Theater의 것이다. 그것을 새 Theater에
  // 세우면 있지도 않은 문서를 열고 그 Theater의 저장된 세션까지 덮어쓴다 — 그래서 주소가
  // 어느 Theater의 것인지 함께 싣고, 다르면 세우지 않는다.
  const addressed = params.theaterId === contextScope ? params.path : undefined;
  useEffect(() => {
    if (!addressed || activePath !== null) return;
    activateStoredDocument(contextScope, { relativePath: addressed, name: nameOfPath(addressed) });
  }, [activePath, addressed, contextScope]);

  // 활성 문서가 바뀔 때 내용을 불러온다 — 캐시가 있으면 즉시 그리고 배경에서 재검증한다.
  // 주차된 사본(확대 중의 레일 인스턴스)은 읽지 않는다 — 같은 문서를 두 번 가져올 뿐이다.
  // 계약이 "보이지 않는 동안에도 렌더는 계속되므로 값비싼 작업은 스스로 멈춰야 한다"고
  // 말하는 자리가 여기다.
  const docStatesRef = useRef(docStates);
  docStatesRef.current = docStates;
  useEffect(() => {
    if (!activePath || !ctx.visible) return;
    void loadDocument(theaterId, activePath, {
      silent: docStatesRef.current.has(activePath),
      language,
      signal,
    });
  }, [activePath, ctx.visible, language, signal, theaterId]);

  // 주소는 지금 읽는 문서를 말해야 한다 — 캡션 이름과 확대 표면이 같은 값을 읽는다.
  // 이미 같으면 쓰지 않는다: `replaceParams`가 스토어를 건드리므로 무조건 부르면 순환한다.
  useEffect(() => {
    if (!activePath) return;
    if (params.path === activePath && params.theaterId === contextScope) return;
    panes.replaceParams({ path: activePath, theaterId: contextScope });
  }, [activePath, contextScope, panes, params.path, params.theaterId]);

  // 마지막 문서가 닫히면 열도 함께 사라진다. 빈 창을 남겨 두면 사용자는 닫을 것이 하나
  // 더 생긴 것으로 읽는다. 주차된 사본은 이미 닫혀 있으므로 자기를 또 닫지 않는다.
  useEffect(() => {
    if (openDocs.length === 0 && ctx.visible) panes.close();
  }, [ctx.visible, openDocs.length, panes]);

  // 팝오버들은 문서가 바뀌면 함께 닫힌다 — 다른 문서의 목록이 남아 있으면 거짓말이 된다.
  useEffect(() => {
    setTabsMenuOpen(false);
    setCrumbPop(null);
  }, [activePath, contextScope]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPY_NOTE_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const openFilePath = useCallback((relativePath: string, displayName?: string) => {
    if (!theaterId) return;
    activateStoredDocument(contextScope, { relativePath, name: displayName ?? nameOfPath(relativePath) });
  }, [contextScope, theaterId]);

  const handleCloseDoc = useCallback((relativePath: string) => {
    closeStoredDocument(contextScope, relativePath);
  }, [contextScope]);

  const reloadDoc = useCallback((relativePath: string) => {
    void loadDocument(theaterId, relativePath, { silent: true, language, signal });
  }, [language, signal, theaterId]);

  const handleCrumbReveal = useCallback((path: string) => {
    if (!theaterId) return;
    setFileRevealTarget({ theaterId, relativePath: path, requestId: mintRevealRequestId() });
  }, [theaterId]);

  // 복사는 헤더 오른쪽의 아이콘 하나가 맡는다 — 클릭은 상대 경로, Alt+클릭은 절대 경로.
  // 확인은 토스트가 아니라 제자리다: 아이콘이 체크로 바뀌고 조각 옆에 "복사됨"이 스며든다.
  const handleCopyPath = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!activePath) return;
    const action: FileContextAction = event.altKey ? "copyPath" : "copyRelativePath";
    void performFileContextAction(action, contextScope, activePath)
      .then(() => setCopied(true))
      .catch(() => {
        // 복사 실패는 조용히 지나간다 — 알림 토스트는 트리 페인이 소유한다.
      });
  }, [activePath, contextScope]);

  const openCrumbPop = useCallback((segment: BreadcrumbSegment, trigger: HTMLElement) => {
    const head = headRef.current;
    const anchorLeft = head ? trigger.getBoundingClientRect().left - head.getBoundingClientRect().left : 0;
    // 폴더 조각은 그 폴더를 연다. 잎(파일)은 제 부모 — 자기 옆의 파일들 — 을 연다.
    const dirPath = segment.isLeaf ? parentDirOf(segment.path) : segment.path;
    setCrumbPop((current) => (current?.segmentPath === segment.path ? null : { segmentPath: segment.path, dirPath, anchorLeft, trigger }));
  }, []);

  const closeCrumbPop = useCallback((restoreFocus: boolean) => {
    setCrumbPop((current) => {
      if (restoreFocus) current?.trigger.focus();
      return null;
    });
  }, []);

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

  const activeDoc = activePath ? openDocs.find((doc) => doc.relativePath === activePath) ?? null : null;
  const viewState: ViewState = activePath
    ? docStates.get(activePath) ?? { kind: "loading" }
    : { kind: "none" };
  const isMarkdownDoc = viewState.kind === "code" && viewState.lang === "markdown";
  const showSource = activePath !== null && sourceModePaths.has(activePath);
  const showCodePane = viewState.kind === "code" && (!isMarkdownDoc || showSource);
  const viewerMeta = viewState.kind === "code" ? buildViewerMetaParts(viewState, t) : [];
  const chipHints = useMemo(() => chipDirHints(openDocs), [openDocs]);
  const crumbSegments = useMemo(() => activePath ? breadcrumbSegments(activePath) : [], [activePath]);

  const measureTabs = useCallback(() => {
    const container = tabsRef.current;
    if (!container) {
      setHiddenTabs([]);
      setTabsScrolled(false);
      setTabLine(null);
      return;
    }
    const tabs = [...container.querySelectorAll<HTMLElement>(".fexp-tab")];
    const widths = tabs.map((el) => el.getBoundingClientRect().width);
    setHiddenTabs(overflowingChipIndices(container.clientWidth, container.scrollLeft, widths, CHIP_STRIP_GAP_PX));
    setTabsScrolled(container.scrollLeft > 1);
    const activeTab = container.querySelector<HTMLElement>(".fexp-tab.is-active");
    const activeButton = activeTab?.querySelector<HTMLElement>(".fexp-tab-open");
    setTabLine(activeTab && activeButton
      ? tabLineGeometry(activeTab.offsetLeft, activeButton.offsetLeft, activeButton.offsetWidth, TAB_LINE_INSET_PX)
      : null);
  }, []);

  /**
   * 활성 탭을 띠 안으로 끌어온다. scrollIntoView({inline:"nearest"})는 탭이 "조금 걸친" 상태를
   * 이미 보이는 것으로 판정해 그대로 두므로(실측: 오른쪽 끝이 31px 잘린 채 유지), 좌표로 직접 민다.
   */
  const ensureActiveTabVisible = useCallback(() => {
    const container = tabsRef.current;
    const activeTab = container?.querySelector<HTMLElement>(".fexp-tab.is-active");
    if (!container || !activeTab) return;
    const left = activeTab.offsetLeft;
    const right = left + activeTab.offsetWidth;
    const viewLeft = container.scrollLeft;
    const viewRight = viewLeft + container.clientWidth;
    if (left < viewLeft) container.scrollLeft = Math.max(0, left - CHIP_STRIP_GAP_PX);
    else if (right > viewRight) container.scrollLeft = right - container.clientWidth + CHIP_STRIP_GAP_PX;
  }, []);

  useLayoutEffect(() => {
    const container = tabsRef.current;
    if (!container) {
      setHiddenTabs([]);
      setTabsScrolled(false);
      setTabLine(null);
      return;
    }
    measureTabs();
    ensureActiveTabVisible();
    measureTabs();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureTabs);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activePath, ensureActiveTabVisible, hiddenTabs.length, measureTabs, openDocs]);

  // Escape는 지금 읽는 문서를 닫는다. 마지막 문서였다면 위의 effect가 열까지 거둔다.
  // 팝오버가 열려 있으면 그쪽이 먼저 Escape를 삼킨다.
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !activePath) return;
    event.preventDefault();
    event.stopPropagation();
    closeStoredDocument(contextScope, activePath);
  }, [activePath, contextScope]);

  const hiddenDocs = hiddenTabs.map((index) => openDocs[index]).filter((doc): doc is OpenDocument => doc !== undefined);

  return (
    <div className="fexp-viewer-pane" onKeyDown={handleKeyDown}>
      <div className="fexp-tabs-wrap">
        <div
          ref={tabsRef}
          className={`fexp-tabs${hiddenTabs.length > 0 ? " is-overflowing" : ""}${tabsScrolled ? " is-scrolled" : ""}${tabLine ? " is-settled" : ""}`}
          role="list"
          aria-label={t("fileExplorer.tabs.aria")}
          onScroll={measureTabs}
        >
          {openDocs.map((doc) => {
            const active = doc.relativePath === activePath;
            const stale = isStaleViewState(docStates.get(doc.relativePath));
            return (
              <div
                key={doc.relativePath}
                role="listitem"
                className={`fexp-tab${active ? " is-active" : ""}${stale ? " is-stale" : ""}`}
              >
                <button
                  type="button"
                  className="fexp-tab-open"
                  aria-current={active ? "true" : undefined}
                  title={stale ? t("fileExplorer.tabs.staleTitle") : doc.relativePath}
                  onClick={() => {
                    openFilePath(doc.relativePath, doc.name);
                    if (stale) reloadDoc(doc.relativePath);
                  }}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    handleCloseDoc(doc.relativePath);
                  }}
                >
                  <span className="fexp-chip-icon" aria-hidden="true"><FileIcon name={doc.name} /></span>
                  {chipHints.has(doc.relativePath) && (
                    <span className="fexp-chip-dir" aria-hidden="true">{chipHints.get(doc.relativePath)}</span>
                  )}
                  <span className="fexp-chip-name">{doc.name}</span>
                </button>
                <button
                  type="button"
                  className="fexp-tab-close"
                  aria-label={t("fileExplorer.viewer.closeNamed", { name: doc.name })}
                  onClick={() => handleCloseDoc(doc.relativePath)}
                >
                  <span className="fexp-tab-close-glyph" aria-hidden="true">✕</span>
                </button>
              </div>
            );
          })}
          <span
            className="fexp-tab-line"
            aria-hidden="true"
            style={tabLine ? { left: tabLine.left, width: tabLine.width } : { left: 0, width: 0 }}
          />
        </div>
        {hiddenTabs.length > 0 && (
          <button
            ref={tabsMoreRef}
            type="button"
            className="fexp-tabs-more"
            aria-haspopup="menu"
            aria-expanded={tabsMenuOpen}
            aria-label={t("fileExplorer.tabs.more", { count: hiddenTabs.length })}
            title={t("fileExplorer.tabs.more", { count: hiddenTabs.length })}
            onClick={() => setTabsMenuOpen((open) => !open)}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{hiddenTabs.length}</span>
          </button>
        )}
        {tabsMenuOpen && (
          <QuietMenu
            className="fexp-tabs-menu"
            ariaLabel={t("fileExplorer.tabs.menuAria")}
            triggerRef={tabsMoreRef}
            items={hiddenDocs.map((doc) => ({
              key: doc.relativePath,
              label: doc.name,
              hint: parentDirOf(doc.relativePath) ? `${parentDirOf(doc.relativePath)}/` : undefined,
              icon: <FileIcon name={doc.name} />,
              current: doc.relativePath === activePath,
              onSelect: () => {
                openFilePath(doc.relativePath, doc.name);
                setTabsMenuOpen(false);
              },
            }))}
            onClose={(restoreFocus) => {
              setTabsMenuOpen(false);
              if (restoreFocus) tabsMoreRef.current?.focus();
            }}
          />
        )}
      </div>
      <div ref={headRef} className="fexp-viewer-head">
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
                aria-haspopup="menu"
                aria-expanded={crumbPop?.segmentPath === segment.path}
                title={segment.isLeaf
                  ? t("fileExplorer.viewer.crumbFileOpen", { name: segment.name })
                  : t("fileExplorer.viewer.crumbDirOpen", { path: segment.path })}
                onClick={(event) => openCrumbPop(segment, event.currentTarget)}
              >
                {segment.name}
              </button>
            </span>
          ))}
        </div>
        <span className={`fexp-crumb-ok${copied ? " is-shown" : ""}`} role="status" aria-live="polite">
          {copied ? t("fileExplorer.viewer.copied") : ""}
        </span>
        {activePath && (
          <button
            type="button"
            className={`fexp-crumb-copy${copied ? " is-done" : ""}`}
            aria-label={t("fileExplorer.viewer.copyPath")}
            title={t("fileExplorer.viewer.copyPath")}
            onClick={handleCopyPath}
          >
            {copied ? (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M3 11V4a1 1 0 0 1 1-1h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        )}
        {isMarkdownDoc && (
          <div className="fexp-view-mode" role="group" aria-label={t("fileExplorer.viewer.viewModeAria")}>
            <button type="button" aria-pressed={!showSource} onClick={() => handleToggleSourceMode(false)}>
              {t("fileExplorer.viewer.previewMode")}
            </button>
            <button type="button" aria-pressed={showSource} onClick={() => handleToggleSourceMode(true)}>
              {t("fileExplorer.viewer.sourceMode")}
            </button>
          </div>
        )}
        {crumbPop && (
          <CrumbSiblingsMenu
            key={crumbPop.segmentPath}
            theaterId={theaterId}
            dirPath={crumbPop.dirPath}
            activePath={activePath}
            anchorLeft={crumbPop.anchorLeft}
            boundaryRef={headRef}
            triggerElement={crumbPop.trigger}
            t={t}
            onOpenFile={(path, name) => {
              openFilePath(path, name);
              setCrumbPop(null);
            }}
            onReveal={(path) => {
              handleCrumbReveal(path);
              closeCrumbPop(true);
            }}
            onClose={closeCrumbPop}
          />
        )}
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
            language={language}
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
  );
}

interface CrumbPopState {
  readonly segmentPath: string;
  readonly dirPath: string;
  readonly anchorLeft: number;
  readonly trigger: HTMLElement;
}

function isStaleViewState(state: ViewState | undefined): boolean {
  return (state?.kind === "code" || state?.kind === "image") && state.stale === true;
}

export type SiblingListSource = FolderListResult | "pending" | "failed";
export type SiblingListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly entries: readonly FolderEntry[]; readonly partial: boolean };

/**
 * 경로 팝오버의 목록 상태 — 빈 폴더, 실패, 상한에 잘린 목록을 서로 다른 사실로 보존한다.
 * directory 항목은 이 메뉴가 "옆 파일"을 여는 표면이라 제외하되, truncated는 그대로 말한다.
 */
export function resolveSiblingListState(source: SiblingListSource): SiblingListState {
  if (source === "pending") return { kind: "loading" };
  if (source === "failed") return { kind: "error" };
  const entries = source.entries.filter((entry) => entry.kind === "file");
  if (entries.length === 0 && !source.truncated) return { kind: "empty" };
  return { kind: "ready", entries, partial: source.truncated === true };
}

interface CrumbSiblingsMenuProps {
  readonly theaterId: string | null;
  readonly dirPath: string;
  readonly activePath: string | null;
  readonly anchorLeft: number;
  readonly boundaryRef: RefObject<HTMLElement | null>;
  readonly triggerElement: HTMLElement;
  readonly t: ReturnType<typeof getT>;
  readonly onOpenFile: (relativePath: string, name: string) => void;
  readonly onReveal: (dirPath: string) => void;
  readonly onClose: (restoreFocus: boolean) => void;
}

/**
 * 경로 조각이 여는 폴더 목록 — 그 폴더의 파일들이 서고, 지금 읽는 파일은 brass다.
 * 머리 행(폴더 경로)을 누르면 트리에서 드러낸다. 목록은 기존 `files/list` 한 번으로 온다.
 */
function CrumbSiblingsMenu({ theaterId, dirPath, activePath, anchorLeft, boundaryRef, triggerElement, t, onOpenFile, onReveal, onClose }: CrumbSiblingsMenuProps) {
  const [source, setSource] = useState<SiblingListSource>("pending");

  useEffect(() => {
    let active = true;
    setSource("pending");
    makeFilesClient(theaterId).listFolder(dirPath || undefined).then((result) => {
      if (active) setSource(result);
    }).catch(() => {
      if (active) setSource("failed");
    });
    return () => { active = false; };
  }, [dirPath, theaterId]);

  const state = resolveSiblingListState(source);
  const retry = () => {
    setSource("pending");
    makeFilesClient(theaterId).listFolder(dirPath || undefined)
      .then((result) => setSource(result))
      .catch(() => setSource("failed"));
  };
  const items = state.kind === "ready" ? state.entries : [];
  const noticeLabel = state.kind === "error"
    ? t("fileExplorer.viewer.crumbLoadFailed")
    : state.kind === "ready" && state.partial
      ? t("fileExplorer.viewer.crumbPartial", { count: state.entries.length })
      : undefined;

  return (
    <QuietMenu
      className="fexp-crumb-menu"
      ariaLabel={t("fileExplorer.viewer.crumbSiblingsAria", { path: dirPath || "/" })}
      anchorLeft={anchorLeft}
      boundaryRef={boundaryRef}
      triggerElement={triggerElement}
      header={{
        label: dirPath || "/",
        title: t("fileExplorer.viewer.crumbRevealFolder"),
        onSelect: () => onReveal(dirPath),
      }}
      loading={state.kind === "loading"}
      emptyLabel={state.kind === "empty" ? t("fileExplorer.viewer.crumbEmpty") : undefined}
      noticeLabel={noticeLabel}
      noticeTone={state.kind === "error" ? "error" : "quiet"}
      items={[
        ...(state.kind === "error" ? [{
          key: "retry",
          label: t("fileExplorer.viewer.crumbRetry"),
          onSelect: retry,
        }] : []),
        ...items.map((entry) => ({
          key: entry.relativePath,
          label: entry.name,
          icon: <FileIcon name={entry.name} />,
          current: entry.relativePath === activePath,
          onSelect: () => onOpenFile(entry.relativePath, entry.name),
        })),
      ]}
      onClose={onClose}
    />
  );
}

/**
 * 캡션 동작 선반 — 이력·낡음·줄바꿈.
 *
 * 호스트가 그리는 밴드에 얹히므로 자기 마크업을 실어 오지 않는다. 닫기와 확대는 호스트 몫이라
 * 여기 없다. 보기 모드(프리뷰↔소스)는 문서마다 기억하는 본문의 상태라 본문 머리에 남는다.
 */
export function FileExplorerDocumentCaptionActions(ctx: PaneContext) {
  const t = getT(ctx.language);
  const contextScope = ctx.theaterId ?? "";
  const { openDocs, activePath, history, historyIndex, docStates, wrapLines } = useFileExplorerViewState(contextScope);
  const docSession = useMemo(
    () => ({ openDocs, activePath, history, historyIndex }),
    [openDocs, activePath, history, historyIndex],
  );
  const viewState: ViewState = activePath ? docStates.get(activePath) ?? { kind: "loading" } : { kind: "none" };
  const isStale = (viewState.kind === "code" || viewState.kind === "image") && Boolean(viewState.stale);
  // 줄바꿈은 창을 나누지 않고 전부 그리므로, 감당 가능한 줄 수까지만 연다.
  const wrapAvailable = viewState.kind === "code" && canWrapLines(viewState.content.split("\n").length);
  const canGoBack = canNavigateDocumentHistory(docSession, -1);
  const canGoForward = canNavigateDocumentHistory(docSession, 1);

  return (
    <>
      <CaptionActionButton
        label={t("fileExplorer.viewer.back")}
        actionId="file-explorer-back"
        disabled={!canGoBack}
        onClick={() => navigateStoredHistory(contextScope, -1)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M10 3.5 5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </CaptionActionButton>
      <CaptionActionButton
        label={t("fileExplorer.viewer.forward")}
        actionId="file-explorer-forward"
        disabled={!canGoForward}
        onClick={() => navigateStoredHistory(contextScope, 1)}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </CaptionActionButton>
      {isStale ? (
        <CaptionActionButton
          label={t("fileExplorer.viewer.staleReload")}
          actionId="file-explorer-stale"
          busy
          onClick={() => {
            if (!activePath) return;
            void loadDocument(ctx.theaterId, activePath, { silent: true, language: ctx.language, signal: ctx.signal });
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M12.5 6.5A4.6 4.6 0 1 0 12.9 10" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M12.6 3.4v3.2H9.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </CaptionActionButton>
      ) : null}
      {viewState.kind === "code" ? (
        <CaptionActionButton
          label={wrapAvailable
            ? (wrapLines ? t("fileExplorer.viewer.wrapOff") : t("fileExplorer.viewer.wrapOn"))
            : t("fileExplorer.viewer.wrapUnavailable")}
          actionId="file-explorer-wrap"
          pressed={wrapLines && wrapAvailable}
          disabled={!wrapAvailable}
          onClick={() => setWrapLines(!wrapLines)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M3 4.5h10" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
            <path d="M3 8h7.4a2 2 0 1 1 0 4H8.6" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9.7 10.7 8.4 12l1.3 1.3" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </CaptionActionButton>
      ) : null}
    </>
  );
}
