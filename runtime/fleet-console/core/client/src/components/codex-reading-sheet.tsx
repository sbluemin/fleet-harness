import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  getCodexReaderHistoryState,
  mountReaderInto,
  navigateCodexReaderHistory,
  refreshCodexHealth,
  saveReaderScroll,
  setNavigatorTagFilter,
  subscribeCodexReaderHistory,
} from "../codex-host.js";
import { useConsoleState } from "../hooks/use-store.js";
import { useT } from "../i18n/index.js";
import { resolvedCodexWorkspaceIdFor } from "../rail/codex-panel.js";
import { collapseCodexReader, expandCodexReader, openCodexReader } from "../store.js";
import { loadInitialData } from "../codex/state.js";

// ─── Constants ────────────────────────────────────────────────────────────────

// ─── Component ────────────────────────────────────────────────────────────────

export function CodexReadingSheet() {
  const t = useT();
  const history = useSyncExternalStore(
    subscribeCodexReaderHistory,
    getCodexReaderHistoryState,
    getCodexReaderHistoryState,
  );
  const {
    codexReader: reader,
    codexReaderExpanded: expanded,
    activeTheaterId: theaterId,
  } = useConsoleState();

  const sheetRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  const readerKey = reader
    ? `${reader.kind}:${reader.kind === "entry" ? reader.entryId : reader.kind === "drydock" ? (reader.patchId ?? "") : reader.kind === "conflicts" ? (reader.id ?? "") : (reader.templateId ?? "")}`
    : null;

  // W2: expand 전용 — reader != null && expanded의 경우에만 시트 표시
  const isOpen = reader !== null && expanded;

  // 닫기 = 스크롤 위치 저장(언마운트 전 동기) 후 split 복귀.
  const closeReading = useCallback(() => {
    saveReaderScroll();
    collapseCodexReader();
  }, []);

  // 덱 열기/닫기 effect — 덱은 캔버스 위 비모달 작업면이다. 사이드바·레일은 계속
  // 살아 있어야 하므로 inert·탭 트랩을 걸지 않고, Esc 접기만 유지한다.
  useEffect(() => {
    if (!isOpen) return;
    const opener = reader;
    document.body.setAttribute("data-codex-reading", "true");

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeReading();
      }
    };

    window.addEventListener("keydown", onKey, true);

    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.removeAttribute("data-codex-reading");
      // focus 복귀: Expand 버튼 우선 → is-current entry → 검색 폴백
      const entryId = opener?.kind === "entry" ? opener.entryId : null;
      const restore =
        document.querySelector<HTMLElement>('[data-codex-expand="true"]') ??
        (entryId
          ? document.querySelector<HTMLElement>(
              `.codex-nav-entry.is-current[data-entry-id="${entryId}"] .t`,
            )
          : null) ??
        document.querySelector<HTMLElement>(".codex-navigator .codex-nav-search-input");
      restore?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opener는 열림 시점 1회 캡처
  }, [isOpen]);

  // 콘텐츠 effect: reader 호스트 노드를 시트 슬롯으로 relocate
  useEffect(() => {
    if (!isOpen || !readRef.current || !tocRef.current || !dockRef.current || !reader) return;

    const kind = reader.kind;
    const subId =
      kind === "drydock" ? reader.patchId : kind === "conflicts" ? reader.id : kind === "schema" ? reader.templateId : undefined;

    // 리더 fetch는 Theater id가 아니라 해석된 codex workspace id로 나가야 한다 —
    // Theater id는 /console/codex/w/ 라우터에서 workspace_not_found로 떨어진다.
    const workspaceId = resolvedCodexWorkspaceIdFor(theaterId);
    mountReaderInto(readRef.current, tocRef.current, dockRef.current, {
      initialEntryId: kind === "entry" ? reader.entryId : "",
      kind,
      subId,
      theaterId: workspaceId ?? theaterId,
      sessionTheaterId: theaterId,
      // 오버레이(크게 보기) 안에서 related 링크 클릭은 오버레이를 유지한 채 문서만 교체한다
      // (split의 onRelatedClick은 split에 머문다 — codex-panel.tsx). expandCodexReader가
      // openCodexReader의 expanded:false를 즉시 true로 되돌려 같은 read 모드를 유지.
      onRelatedClick: (id) => {
        openCodexReader({ kind: "entry", entryId: id });
        expandCodexReader();
      },
      onClose: closeReading,
      onPatchOpen: (pid) => {
        openCodexReader({ kind: "drydock", patchId: pid });
        expandCodexReader();
      },
      onConflictOpen: (id) => {
        openCodexReader({ kind: "conflicts", id });
        expandCodexReader();
      },
      // 덱이 열려 있어도 카탈로그 레일은 살아 있다 — 태그 칩은 그 레일을 그대로 거른다.
      onTagClick: (tag) => setNavigatorTagFilter(tag),
      onDecided: () => {
        void loadInitialData();
        refreshCodexHealth();
        openCodexReader({ kind: "drydock", patchId: undefined });
        expandCodexReader();
      },
    });

    requestAnimationFrame(() => {
      sheetRef.current
        ?.querySelector<HTMLElement>("[data-sheet-initial-focus]")
        ?.focus();
    });
  }, [isOpen, readerKey]);

  if (!isOpen) return null;

  // 캔버스 안에 정박한다 — 캔버스의 pan/제스처 핸들러가 덱에서 시작한 입력을 집어
  // 가지 않도록 포인터 계열 이벤트는 덱 경계에서 끊는다.
  const canvasHost = document.querySelector<HTMLElement>(".operations-canvas");

  return createPortal(
    (
      <div
        ref={sheetRef}
        className="codex-reading-sheet"
        role="region"
        aria-label={t("chrome.codexReading.dialogAria")}
        onPointerDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <div className="codex-reading-sheet-head">
          <div className="codex-reader-history">
            <button
              className="codex-reader-history-btn"
              type="button"
              aria-label={t("codex.nav.backAria")}
              disabled={!history.canGoBack}
              onClick={() => navigateCodexReaderHistory(-1)}
            >
              ←
            </button>
            <button
              className="codex-reader-history-btn"
              type="button"
              aria-label={t("codex.nav.forwardAria")}
              disabled={!history.canGoForward}
              onClick={() => navigateCodexReaderHistory(1)}
            >
              →
            </button>
          </div>
          <span className="codex-reading-sheet-eyebrow">{t("chrome.codexReading.eyebrow")}</span>
          <button
            data-sheet-initial-focus
            className="codex-reading-sheet-close"
            type="button"
            aria-label={t("chrome.codexReading.closeAria")}
            onClick={closeReading}
          >
            ✕
          </button>
        </div>
        <div className="codex-reading-sheet-body">
          <aside
            ref={tocRef}
            className="codex-reading-sheet-toc"
            aria-label={t("chrome.codexReading.onThisPage")}
          />
          <div className="codex-reading-sheet-main">
            <div ref={readRef} className="codex-reading-sheet-read" />
            <div ref={dockRef} className="codex-reader-composer" />
          </div>
        </div>
      </div>
    ),
    canvasHost ?? document.body,
  );
}

