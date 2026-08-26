import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  getCodexReaderDocumentState,
  getCodexReaderHistoryState,
  getCodexReaderMarkdown,
  mountReaderInto,
  navigateCodexReaderHistory,
  refreshCodexHealth,
  saveReaderScroll,
  setCodexReaderExpandedForSession,
  setNavigatorTagFilter,
  subscribeCodexReaderDocument,
  subscribeCodexReaderHistory,
} from "../codex-host.js";
import { useConsoleState } from "../hooks/use-store.js";
import { useT } from "../i18n/index.js";
import { resolvedCodexWorkspaceIdFor, subscribeCodexWorkspace } from "../rail/codex-panel.js";
import { collapseCodexReader, expandCodexReader, openCodexReader } from "../store.js";
import { getState as getCodexState, loadInitialData, subscribeState as subscribeCodexState } from "../codex/state.js";
import type { SearchEntry } from "../codex/api.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const READING_SIZE_KEY = "fleet.codex.reader.size";
const READING_SIZES = ["comfortable", "wide", "large"] as const;
type ReadingSize = (typeof READING_SIZES)[number];

const FIND_HIGHLIGHT = "codex-find";
const FIND_HIGHLIGHT_CURRENT = "codex-find-current";
const SWITCHER_LIMIT = 40;

type Overlay = "none" | "switcher" | "source";

// ─── Component ────────────────────────────────────────────────────────────────

export function CodexReadingSheet() {
  const t = useT();
  const history = useSyncExternalStore(
    subscribeCodexReaderHistory,
    getCodexReaderHistoryState,
    getCodexReaderHistoryState,
  );
  const document_ = useSyncExternalStore(
    subscribeCodexReaderDocument,
    getCodexReaderDocumentState,
    getCodexReaderDocumentState,
  );
  const {
    codexReader: reader,
    codexReaderExpanded: expanded,
    activeTheaterId: theaterId,
  } = useConsoleState();
  // 공유 링크로 곧장 들어오면 워크스페이스 해석이 아직 끝나지 않았다 — 그 결과를 구독해
  // 해석이 도착한 프레임에 리더를 세운다(그 전에는 세우지 않는다).
  const workspaceId = useSyncExternalStore(
    subscribeCodexWorkspace,
    () => resolvedCodexWorkspaceIdFor(theaterId),
    () => resolvedCodexWorkspaceIdFor(theaterId),
  );

  const sheetRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const switcherInputRef = useRef<HTMLInputElement>(null);

  const [progress, setProgress] = useState(0);
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [switcherQuery, setSwitcherQuery] = useState("");
  const [switcherTag, setSwitcherTag] = useState<string | null>(null);
  const [switcherIndex, setSwitcherIndex] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findState, setFindState] = useState({ total: 0, current: 0 });
  const [size, setSize] = useState<ReadingSize>(readStoredSize);
  const [linkCopied, setLinkCopied] = useState(false);

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

  // 확대 여부는 리더 세션의 일부다 — 새로고침 뒤 같은 화면으로 돌아오게 한다.
  useEffect(() => {
    setCodexReaderExpandedForSession(isOpen);
  }, [isOpen]);

  // 덱 열기/닫기 effect — 덱은 캔버스 위 비모달 작업면이다. 사이드바·레일은 계속
  // 살아 있어야 하므로 inert·탭 트랩을 걸지 않고, Esc 접기만 유지한다.
  useEffect(() => {
    if (!isOpen) return;
    const opener = reader;
    document.body.setAttribute("data-codex-reading", "true");

    return () => {
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

  // 문서가 바뀌면 열려 있던 보조 표면(찾기·전환기·원문)은 이전 문서의 것이므로 닫는다.
  useEffect(() => {
    setOverlay("none");
    setFindOpen(false);
    setFindQuery("");
    setLinkCopied(false);
  }, [readerKey]);

  // 콘텐츠 effect: reader 호스트 노드를 시트 슬롯으로 relocate
  useEffect(() => {
    if (!isOpen || !readRef.current || !tocRef.current || !dockRef.current || !reader) return;
    // 리더 fetch는 Theater id가 아니라 해석된 codex workspace id로 나가야 한다 —
    // Theater id로 대신 부르면 /console/codex/w/ 라우터가 workspace_not_found로 거절한다.
    // 해석 전에는 아무것도 세우지 않고, 해석이 도착하면 이 effect가 다시 돈다.
    if (!workspaceId) return;

    const kind = reader.kind;
    const subId =
      kind === "drydock" ? reader.patchId : kind === "conflicts" ? reader.id : kind === "schema" ? reader.templateId : undefined;

    mountReaderInto(readRef.current, tocRef.current, dockRef.current, {
      initialEntryId: kind === "entry" ? reader.entryId : "",
      kind,
      subId,
      theaterId: workspaceId,
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
      // 확대 중에는 카탈로그 레일이 화면 밖일 수 있다 — 필터 결과를 시트 안 항목 전환기로
      // 열어 보여주고, 레일 필터도 같은 값으로 맞춰 접었을 때 어긋나지 않게 한다.
      onTagClick: (tag) => {
        setNavigatorTagFilter(tag);
        setSwitcherTag(tag);
        setSwitcherQuery("");
        setSwitcherIndex(0);
        setOverlay("switcher");
      },
      onDecided: () => {
        void loadInitialData();
        refreshCodexHealth();
        openCodexReader({ kind: "drydock", patchId: undefined });
        expandCodexReader();
      },
    });

    // 정독 화면의 기본 동작: 본문이 키보드 초점을 받아야 Space·PageDown·Home/End가 먹는다.
    requestAnimationFrame(() => {
      readRef.current?.focus({ preventScroll: true });
    });
  }, [isOpen, readerKey, workspaceId]);

  // 읽기 진행률 — 헤드바가 "지금 어디쯤"을 말한다.
  useEffect(() => {
    if (!isOpen) return;
    const slot = readRef.current;
    if (!slot) return;
    const update = () => {
      const max = slot.scrollHeight - slot.clientHeight;
      setProgress(max > 8 ? Math.min(100, Math.max(0, Math.round((slot.scrollTop / max) * 100))) : 0);
    };
    update();
    slot.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(slot);
    return () => {
      slot.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [isOpen, readerKey]);

  useEffect(() => {
    if (!isOpen) clearFindHighlights();
  }, [isOpen]);

  // 읽기 크기는 사람이 고른다 — 화면 폭이 아니라.
  useEffect(() => {
    try {
      localStorage.setItem(READING_SIZE_KEY, size);
    } catch {
      // Storage is optional.
    }
  }, [size]);

  const jumpSection = useCallback((direction: 1 | -1) => {
    const slot = readRef.current;
    if (!slot) return;
    const headings = [...slot.querySelectorAll<HTMLElement>("article h2[id], article h3[id]")];
    if (headings.length === 0) return;
    const foldTop = slot.getBoundingClientRect().top;
    const offsets = headings.map((h) => h.getBoundingClientRect().top - foldTop + slot.scrollTop);
    const here = slot.scrollTop;
    const target =
      direction === 1
        ? offsets.find((value) => value > here + 4)
        : [...offsets].reverse().find((value) => value < here - 4);
    slot.scrollTo({ top: target ?? (direction === 1 ? slot.scrollHeight : 0), behavior: "smooth" });
  }, []);

  const copyLink = useCallback(() => {
    const entryId = document_.entryId;
    if (!entryId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("codex", entryId);
    url.searchParams.set("codexView", "full");
    // 항목 id는 Theater 안에서만 뜻이 있다 — 링크를 받은 콘솔이 다른 Theater를 보고
    // 있으면 같은 id로 엉뚱한 문서를 찾게 되므로 사는 곳을 함께 싣는다.
    if (theaterId) url.searchParams.set("codexTheater", theaterId);
    void navigator.clipboard?.writeText(url.toString()).then(
      () => setLinkCopied(true),
      () => setLinkCopied(false),
    );
  }, [document_.entryId, theaterId]);

  const openSwitcher = useCallback(() => {
    setSwitcherTag(null);
    setSwitcherQuery("");
    setSwitcherIndex(0);
    setOverlay((current) => (current === "switcher" ? "none" : "switcher"));
  }, []);

  // 시트 키보드 문법 — 본문에 초점이 있는 동안의 읽기 키와, 시트 전역의 이동 키.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      const mod = e.metaKey || e.ctrlKey;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (findOpen) {
          setFindOpen(false);
          setFindQuery("");
          clearFindHighlights();
          readRef.current?.focus({ preventScroll: true });
          return;
        }
        if (overlay !== "none") {
          setOverlay("none");
          readRef.current?.focus({ preventScroll: true });
          return;
        }
        closeReading();
        return;
      }

      if (mod && (e.key === "k" || e.key === "K")) {
        // 시트가 열려 있는 동안 ⌘K는 이 화면의 항목 전환기다(전역 세션 검색이 아니라).
        e.preventDefault();
        e.stopImmediatePropagation();
        openSwitcher();
        return;
      }

      if (mod && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setFindOpen(true);
        requestAnimationFrame(() => findInputRef.current?.select());
        return;
      }

      if (mod && (e.key === "[" || e.key === "]")) {
        e.preventDefault();
        e.stopImmediatePropagation();
        navigateCodexReaderHistory(e.key === "[" ? -1 : 1);
        return;
      }

      if (typing || overlay !== "none") return;

      if (e.key === "j" || e.key === "J") {
        e.preventDefault();
        jumpSection(1);
        return;
      }
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        jumpSection(-1);
      }
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, findOpen, overlay, closeReading, jumpSection, openSwitcher]);

  // 문서 안에서 찾기 — 하이라이트는 DOM을 건드리지 않는 CSS Custom Highlight로 그린다.
  const findMatches = useRef<Range[]>([]);
  useEffect(() => {
    if (!isOpen || !findOpen) {
      clearFindHighlights();
      findMatches.current = [];
      setFindState({ total: 0, current: 0 });
      return;
    }
    const body = readRef.current?.querySelector<HTMLElement>(".markdown-body, article");
    const query = findQuery.trim();
    if (!body || query.length === 0) {
      clearFindHighlights();
      findMatches.current = [];
      setFindState({ total: 0, current: 0 });
      return;
    }
    const ranges = collectRanges(body, query);
    findMatches.current = ranges;
    paintFind(ranges, 0);
    setFindState({ total: ranges.length, current: ranges.length > 0 ? 1 : 0 });
    if (ranges[0]) scrollRangeIntoView(ranges[0]);
  }, [isOpen, findOpen, findQuery, readerKey]);

  const stepFind = useCallback((direction: 1 | -1) => {
    const ranges = findMatches.current;
    if (ranges.length === 0) return;
    setFindState((prev) => {
      const nextIndex = ((prev.current - 1 + direction) % ranges.length + ranges.length) % ranges.length;
      paintFind(ranges, nextIndex);
      const range = ranges[nextIndex];
      if (range) scrollRangeIntoView(range);
      return { total: ranges.length, current: nextIndex + 1 };
    });
  }, []);

  if (!isOpen) return null;

  // 캔버스 안에 정박한다 — 캔버스의 pan/제스처 핸들러가 덱에서 시작한 입력을 집어
  // 가지 않도록 포인터 계열 이벤트는 덱 경계에서 끊는다.
  const canvasHost = document.querySelector<HTMLElement>(".operations-canvas");
  const title = document_.title || t("chrome.codexReading.eyebrow");

  return createPortal(
    (
      <div
        ref={sheetRef}
        className="codex-reading-sheet"
        data-reading-size={size}
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
              title={`${t("codex.nav.backAria")} (⌘[)`}
              disabled={!history.canGoBack}
              onClick={() => navigateCodexReaderHistory(-1)}
            >
              ←
            </button>
            <button
              className="codex-reader-history-btn"
              type="button"
              aria-label={t("codex.nav.forwardAria")}
              title={`${t("codex.nav.forwardAria")} (⌘])`}
              disabled={!history.canGoForward}
              onClick={() => navigateCodexReaderHistory(1)}
            >
              →
            </button>
          </div>

          <button
            className="codex-reader-headline"
            type="button"
            aria-haspopup="dialog"
            aria-expanded={overlay === "switcher"}
            title={t("chrome.codexReading.switchEntry")}
            onClick={openSwitcher}
          >
            <span className="codex-reader-headline-title">{title}</span>
            <span className="codex-reader-headline-hint">⌘K</span>
          </button>

          <span className="codex-reader-progress" aria-label={t("chrome.codexReading.progressAria")}>
            <span className="codex-reader-progress-track">
              <span className="codex-reader-progress-fill" style={{ width: `${progress}%` }} />
            </span>
            <span className="codex-reader-progress-value">{progress}%</span>
          </span>

          <div className="codex-reader-tools">
            <button
              className="codex-reader-tool"
              type="button"
              aria-pressed={findOpen}
              title={`${t("chrome.codexReading.find")} (⌘F)`}
              onClick={() => {
                setFindOpen((v) => !v);
                requestAnimationFrame(() => findInputRef.current?.select());
              }}
            >
              {t("chrome.codexReading.find")}
            </button>
            <button
              className="codex-reader-tool"
              type="button"
              title={t("chrome.codexReading.copyLink")}
              onClick={copyLink}
              disabled={!document_.entryId}
            >
              {linkCopied ? t("chrome.codexReading.linkCopied") : t("chrome.codexReading.copyLink")}
            </button>
            <button
              className="codex-reader-tool"
              type="button"
              aria-pressed={overlay === "source"}
              title={t("chrome.codexReading.source")}
              onClick={() => setOverlay((current) => (current === "source" ? "none" : "source"))}
              disabled={!document_.entryId}
            >
              {t("chrome.codexReading.source")}
            </button>
            <button
              className="codex-reader-tool codex-reader-tool--size"
              type="button"
              title={t("chrome.codexReading.readingSize")}
              onClick={() => setSize((current) => READING_SIZES[(READING_SIZES.indexOf(current) + 1) % READING_SIZES.length] ?? "comfortable")}
            >
              {t(`chrome.codexReading.size.${size}` as Parameters<typeof t>[0])}
            </button>
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
        </div>

        {findOpen ? (
          <div className="codex-reader-find" role="search">
            <input
              ref={findInputRef}
              className="codex-reader-find-input"
              type="search"
              value={findQuery}
              placeholder={t("chrome.codexReading.findPlaceholder")}
              aria-label={t("chrome.codexReading.find")}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  stepFind(e.shiftKey ? -1 : 1);
                }
              }}
            />
            <span className="codex-reader-find-count">
              {findQuery.trim().length === 0
                ? ""
                : findState.total === 0
                  ? t("chrome.codexReading.findNone")
                  : `${findState.current} / ${findState.total}`}
            </span>
            <button
              className="codex-reader-tool"
              type="button"
              aria-label={t("chrome.codexReading.findPrev")}
              disabled={findState.total === 0}
              onClick={() => stepFind(-1)}
            >
              ↑
            </button>
            <button
              className="codex-reader-tool"
              type="button"
              aria-label={t("chrome.codexReading.findNext")}
              disabled={findState.total === 0}
              onClick={() => stepFind(1)}
            >
              ↓
            </button>
            <button
              className="codex-reader-tool"
              type="button"
              aria-label={t("chrome.codexReading.findClose")}
              onClick={() => {
                setFindOpen(false);
                setFindQuery("");
                clearFindHighlights();
                readRef.current?.focus({ preventScroll: true });
              }}
            >
              ✕
            </button>
          </div>
        ) : null}

        <div className="codex-reading-sheet-body">
          <aside
            ref={tocRef}
            className="codex-reading-sheet-toc"
            aria-label={t("chrome.codexReading.onThisPage")}
          />
          <div className="codex-reading-sheet-main">
            <div
              ref={readRef}
              className="codex-reading-sheet-read"
              tabIndex={-1}
              aria-label={t("chrome.codexReading.documentAria")}
            />
            <div ref={dockRef} className="codex-reader-composer" />
          </div>
        </div>

        {overlay === "switcher" ? (
          <EntrySwitcher
            inputRef={switcherInputRef}
            query={switcherQuery}
            tag={switcherTag}
            activeIndex={switcherIndex}
            currentEntryId={document_.entryId}
            onQuery={(value) => {
              setSwitcherQuery(value);
              setSwitcherIndex(0);
            }}
            onActiveIndex={setSwitcherIndex}
            onClearTag={() => setSwitcherTag(null)}
            onPick={(id) => {
              setOverlay("none");
              openCodexReader({ kind: "entry", entryId: id });
              expandCodexReader();
            }}
            onClose={() => {
              setOverlay("none");
              readRef.current?.focus({ preventScroll: true });
            }}
          />
        ) : null}

        {overlay === "source" ? (
          <SourceView
            title={title}
            onClose={() => {
              setOverlay("none");
              readRef.current?.focus({ preventScroll: true });
            }}
          />
        ) : null}
      </div>
    ),
    canvasHost ?? document.body,
  );
}

// ─── Entry switcher (⌘K) ──────────────────────────────────────────────────────

function EntrySwitcher({
  inputRef,
  query,
  tag,
  activeIndex,
  currentEntryId,
  onQuery,
  onActiveIndex,
  onClearTag,
  onPick,
  onClose,
}: {
  readonly inputRef: React.RefObject<HTMLInputElement | null>;
  readonly query: string;
  readonly tag: string | null;
  readonly activeIndex: number;
  readonly currentEntryId: string | null;
  readonly onQuery: (value: string) => void;
  readonly onActiveIndex: (index: number) => void;
  readonly onClearTag: () => void;
  readonly onPick: (entryId: string) => void;
  readonly onClose: () => void;
}) {
  const t = useT();
  // 카탈로그와 같은 출처를 읽는다 — 전환기가 레일과 다른 목록을 보여주면 두 화면이 어긋난다.
  const index = useSyncExternalStore(
    (listener) => subscribeCodexState(listener),
    () => getCodexState().index,
    () => getCodexState().index,
  );

  const results = useMemo(() => filterEntries(index, query, tag), [index, query, tag]);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [inputRef]);

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results.length]);

  const move = (delta: number) => {
    if (results.length === 0) return;
    onActiveIndex(((activeIndex + delta) % results.length + results.length) % results.length);
  };

  return (
    <div className="codex-reader-overlay" role="dialog" aria-modal="false" aria-label={t("chrome.codexReading.switchEntry")}>
      <div className="codex-reader-overlay-panel">
        <div className="codex-reader-switcher-head">
          <input
            ref={inputRef}
            className="codex-reader-switcher-input"
            type="search"
            value={query}
            placeholder={t("chrome.codexReading.switchPlaceholder")}
            aria-label={t("chrome.codexReading.switchEntry")}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                move(1);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                move(-1);
              } else if (e.key === "Enter") {
                e.preventDefault();
                const picked = results[activeIndex];
                if (picked) onPick(picked.id);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                onClose();
              }
            }}
          />
          {tag ? (
            <button className="codex-reader-switcher-tag" type="button" onClick={onClearTag}>
              #{tag} ✕
            </button>
          ) : null}
          <span className="codex-reader-switcher-count">
            {t("chrome.codexReading.switchCount", { count: results.length })}
          </span>
        </div>
        <div className="codex-reader-switcher-list" ref={listRef} role="listbox">
          {results.length === 0 ? (
            <p className="codex-reader-switcher-empty">{t("chrome.codexReading.switchEmpty")}</p>
          ) : (
            results.map((entry, i) => (
              <button
                key={entry.id}
                className="codex-reader-switcher-row"
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                data-active={i === activeIndex}
                data-current={entry.id === currentEntryId}
                onMouseEnter={() => onActiveIndex(i)}
                onClick={() => onPick(entry.id)}
              >
                <span className="codex-reader-switcher-title">{entry.title}</span>
                <span className="codex-reader-switcher-tags">
                  {entry.tags.slice(0, 3).map((entryTag) => (
                    <span key={entryTag} className="codex-reader-switcher-chip">
                      {entryTag}
                    </span>
                  ))}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Source view ──────────────────────────────────────────────────────────────

function SourceView({ title, onClose }: { readonly title: string; readonly onClose: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const markdown = getCodexReaderMarkdown() ?? "";

  return (
    <div className="codex-reader-overlay" role="dialog" aria-modal="false" aria-label={t("chrome.codexReading.source")}>
      <div className="codex-reader-overlay-panel codex-reader-source">
        <div className="codex-reader-source-head">
          <span className="codex-reader-source-title">{title}</span>
          <button
            className="codex-reader-tool"
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(markdown).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? t("chrome.codexReading.sourceCopied") : t("chrome.codexReading.sourceCopy")}
          </button>
          <button className="codex-reader-tool" type="button" aria-label={t("chrome.codexReading.closeSource")} onClick={onClose}>
            ✕
          </button>
        </div>
        <pre className="codex-reader-source-body">{markdown}</pre>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readStoredSize(): ReadingSize {
  try {
    const stored = localStorage.getItem(READING_SIZE_KEY);
    return READING_SIZES.includes(stored as ReadingSize) ? (stored as ReadingSize) : "comfortable";
  } catch {
    return "comfortable";
  }
}

function filterEntries(index: readonly SearchEntry[], query: string, tag: string | null): SearchEntry[] {
  const needle = query.trim().toLowerCase();
  return index
    .filter((entry) => (tag ? entry.tags.includes(tag) : true))
    .filter((entry) =>
      needle.length === 0
        ? true
        : entry.title.toLowerCase().includes(needle) ||
          entry.id.toLowerCase().includes(needle) ||
          entry.tags.some((entryTag) => entryTag.toLowerCase().includes(needle)),
    )
    .slice(0, SWITCHER_LIMIT);
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function highlightRegistry(): HighlightRegistry | null {
  // CSS Custom Highlight는 있으면 쓰고 없으면 조용히 넘어가는 향상이다 —
  // 전역 CSS 객체 자체가 없는 실행 환경(테스트 DOM)도 여기서 걸러진다.
  if (typeof CSS === "undefined" || typeof window === "undefined") return null;
  const api = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const ctor = (window as unknown as { Highlight?: unknown }).Highlight;
  return api && typeof ctor === "function" ? api : null;
}

/**
 * 대소문자를 접되 길이는 보존한다. `İ`처럼 소문자가 두 코드 유닛이 되는 글자가 있으면
 * 접은 문자열의 인덱스가 원본 텍스트 노드와 어긋나 Range가 범위 밖을 가리킨다
 * (setEnd가 IndexSizeError로 던져 그 문서의 찾기가 통째로 죽는다).
 */
function foldKeepingLength(text: string): string {
  let folded = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    folded += lower.length === char.length ? lower : char;
  }
  return folded;
}

function collectRanges(root: HTMLElement, query: string): Range[] {
  const needle = foldKeepingLength(query);
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    const haystack = foldKeepingLength(text);
    let from = haystack.indexOf(needle);
    while (from !== -1) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      ranges.push(range);
      from = haystack.indexOf(needle, from + needle.length);
    }
    node = walker.nextNode();
  }
  return ranges;
}

function paintFind(ranges: readonly Range[], currentIndex: number): void {
  const registry = highlightRegistry();
  if (!registry) return;
  const Ctor = (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  registry.set(FIND_HIGHLIGHT, new Ctor(...ranges));
  const current = ranges[currentIndex];
  registry.set(FIND_HIGHLIGHT_CURRENT, current ? new Ctor(current) : new Ctor());
}

function clearFindHighlights(): void {
  const registry = highlightRegistry();
  if (!registry) return;
  registry.delete(FIND_HIGHLIGHT);
  registry.delete(FIND_HIGHLIGHT_CURRENT);
}

function scrollRangeIntoView(range: Range): void {
  const target = range.startContainer.parentElement;
  target?.scrollIntoView({ block: "center", behavior: "smooth" });
}
