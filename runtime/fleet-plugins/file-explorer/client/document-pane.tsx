import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { CaptionActionButton } from "@fleet-console/sdk/components/caption-actions";
import type { PaneContext } from "@fleet-console/sdk/pane";

import { loadDocument, nameOfPath } from "./doc-loader.js";
import { breadcrumbSegments, buildViewerMetaParts } from "./format.js";
import { FileIcon } from "./file-icon.js";
import { getT } from "./i18n/index.js";
import { CHIP_STRIP_GAP_PX, chipDirHints, countOverflowingChips } from "./layout.js";
import { mintRevealRequestId, setFileRevealTarget, useFileRevealTarget } from "./search-navigation.js";
import {
  activateStoredDocument,
  canNavigateDocumentHistory,
  closeStoredDocument,
  navigateStoredHistory,
  setWrapLines,
  useFileExplorerViewState,
  type ViewState,
} from "./view-store.js";
import { BinaryViewer } from "./viewer/binary.js";
import { canWrapLines, CodeViewer } from "./viewer/code.js";
import { ImageViewer } from "./viewer/image.js";
import { MarkdownViewer } from "./viewer/markdown.js";

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

/**
 * 폴더 브레드크럼 클릭 복사의 더블클릭 유예 — 이 안에 두 번째 클릭이 오면 복사 없이 reveal만 한다.
 * 브라우저는 OS 더블클릭 간격을 노출하지 않으므로 널리 쓰이는 OS 기본 상한(500ms)에 맞춘다 —
 * 이보다 짧으면 기본 설정의 느긋한 더블클릭에서도 복사가 먼저 나가 클립보드를 덮는다.
 */
const CRUMB_DBLCLICK_GRACE_MS = 500;

/** 캡션에 설 이름 — 페인 종류가 아니라 지금 담은 문서를 말한다. */
export function documentPaneTitle(ctx: PaneContext): string {
  const t = getT(ctx.language);
  const path = ctx.params.path;
  return path ? nameOfPath(path) : t("fileExplorer.panel.title");
}

export function FileExplorerDocumentPane(ctx: PaneContext) {
  const { theaterId, params, panes, signal, language } = ctx;
  const t = getT(language);
  const contextScope = theaterId ?? "";
  const { openDocs, activePath, docStates, wrapLines } = useFileExplorerViewState(contextScope);
  const chipsRef = useRef<HTMLDivElement>(null);
  const [chipOverflow, setChipOverflow] = useState(0);
  const [chipsScrolled, setChipsScrolled] = useState(false);
  const [sourceModePaths, setSourceModePaths] = useState<ReadonlySet<string>>(new Set());
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
  const addressed = params.path;
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
    if (!activePath || params.path === activePath) return;
    panes.replaceParams({ path: activePath });
  }, [activePath, panes, params.path]);

  // 마지막 문서가 닫히면 열도 함께 사라진다. 빈 창을 남겨 두면 사용자는 닫을 것이 하나
  // 더 생긴 것으로 읽는다. 주차된 사본은 이미 닫혀 있으므로 자기를 또 닫지 않는다.
  useEffect(() => {
    if (openDocs.length === 0 && ctx.visible) panes.close();
  }, [ctx.visible, openDocs.length, panes]);

  const openFilePath = useCallback((relativePath: string, displayName?: string) => {
    if (!theaterId) return;
    activateStoredDocument(contextScope, { relativePath, name: displayName ?? nameOfPath(relativePath) });
  }, [contextScope, theaterId]);

  const handleCloseDoc = useCallback((relativePath: string) => {
    closeStoredDocument(contextScope, relativePath);
  }, [contextScope]);

  const handleCrumbCopy = useCallback((path: string) => {
    void (async () => {
      try {
        const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
        if (!clipboard) return;
        await clipboard.writeText(path);
      } catch {
        // 복사 실패는 조용히 지나간다 — 알림 토스트는 트리 페인이 소유한다.
      }
    })();
  }, []);

  const handleCrumbReveal = useCallback((path: string) => {
    if (!theaterId) return;
    setFileRevealTarget({ theaterId, relativePath: path, requestId: mintRevealRequestId() });
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
    if (!container) {
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
  }, [activePath, chipOverflow, ensureActiveChipVisible, measureChipOverflow, openDocs]);

  // Escape는 지금 읽는 문서를 닫는다. 마지막 문서였다면 위의 effect가 열까지 거둔다.
  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !activePath) return;
    event.preventDefault();
    event.stopPropagation();
    closeStoredDocument(contextScope, activePath);
  }, [activePath, contextScope]);

  return (
    <div className="fexp-viewer-pane" onKeyDown={handleKeyDown}>
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
