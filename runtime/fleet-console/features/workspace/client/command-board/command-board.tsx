import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ChevronGlyph } from "@fleet-console/ui/react";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { openArchiveSheet, useObjectiveArchive } from "../../../../core/client/src/integration/objective-archive.js";
import { CommodoreAvatar } from "../../../commodore/client/commodore-avatar.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { messageCommodore } from "../../../commodore/client/commodore-state.js";
import { commodoreAvatarKey, objectiveRecordAvatarKey } from "../../shared/avatars.js";
import { useAvatarToneOf } from "../avatar-accent.js";
import { KeyedAvatar } from "../avatars.js";
import { openCommanderConversation } from "../commander-tab/commander-navigation.js";
import { openCommanderRowGlyphTab } from "../commander-tab/commander-popups.js";
import { CommanderRowGlyphs } from "../commander-tab/commander-row-glyphs.js";
import {
  COMMAND_BOARD_COLUMNS,
  COMMAND_BOARD_PRESETS,
  dispatchBatchDonePrompt,
  dispatchObjectivePrompt,
  formatDoneStamp,
  formatRelativeTime,
  formatShortDueDate,
  useCommandBoardData,
  type CommandBoardCardItem,
  type CommandBoardColumnId,
  type CommandBoardCommodore,
} from "./command-board-data.js";
import {
  clearCommandBoardCommodoreFilter,
  setCommandBoardMatrixFocus,
  setCommandBoardViewMode,
  toggleCommandBoardCommodoreFilter,
  toggleCommandBoardMatrixRail,
  useCommandBoardState,
} from "./command-board-store.js";
import "./command-board.css";

export const CommandBoardGlyph = ({ size = 15 }: { readonly size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2.5" width="3.2" height="11" rx="1" />
    <rect x="6.4" y="2.5" width="3.2" height="7.5" rx="1" />
    <rect x="10.8" y="2.5" width="3.2" height="9.2" rx="1" />
  </svg>
);

const SwimlaneGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" aria-hidden="true">
    <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
    <rect x="2" y="9" width="12" height="4.5" rx="1" />
    <path d="M6.5 2.5v4.5M10.5 2.5v4.5M6.5 9v4.5M10.5 9v4.5" />
  </svg>
);

const MatrixGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" aria-hidden="true">
    <rect x="2" y="2.5" width="4" height="11" rx="0.9" />
    <rect x="7.8" y="2.5" width="6.2" height="11" rx="0.9" />
    <path d="M3.2 5.5h1.6M3.2 8h1.6M3.2 10.5h1.6" />
  </svg>
);

const SearchGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <circle cx="7" cy="7" r="4.2" />
    <path d="M10.4 10.4 13.5 13.5" />
  </svg>
);

const PlusGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M8 3.2v9.6M3.2 8h9.6" />
  </svg>
);

const FreshGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="8" cy="8" r="5.4" strokeDasharray="2.2 2.2" />
  </svg>
);

const DoneGlyph = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="5.6" fill="currentColor" opacity="0.24" />
    <path d="M5.4 8.1l1.7 1.7 3.5-3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const SendGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7" />
  </svg>
);

const ExternalGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6.5 3.5h6v6M12.5 3.5 5.5 10.5M3.5 6.5v6h6" />
  </svg>
);

interface ToastNotice {
  readonly text: string;
  readonly commodoreId?: string;
}

type ActiveModal =
  | { readonly kind: "create"; readonly defaultCommodoreId: string | null }
  | { readonly kind: "batch-done" };

/** 데스크톱 지휘판(Command Board) — 4열 × 3종 보기(통합 · 사령관별 · 매트릭스) + 사령관 인라인 지시. */
export function CommandBoardStage() {
  const t = useT();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const board = useCommandBoardData(true);
  const store = useCommandBoardState();
  const archive = useObjectiveArchive();
  const toneOf = useAvatarToneOf();

  const [searchQuery, setSearchQuery] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [onlyDue, setOnlyDue] = useState(false);
  const [hoveredCommodoreId, setHoveredCommodoreId] = useState<string | null>(null);
  const [collapsedLanes, setCollapsedLanes] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [dispatchingIds, setDispatchingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [modal, setModal] = useState<ActiveModal | null>(null);
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((next: ToastNotice) => {
    setToast(next);
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 5_000);
  }, []);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
  }, []);

  // Esc는 열린 모달 → 펼쳐진 카드 인라인 지시 트레이 순서로 닫는다.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (modal !== null) {
        event.stopPropagation();
        setModal(null);
      } else if (expandedCardId !== null) {
        event.stopPropagation();
        setExpandedCardId(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [modal, expandedCardId]);

  const commodoreMap = useMemo(() => new Map(board.commodores.map((c) => [c.id, c])), [board.commodores]);

  const filterItems = useCallback((ignoreCommodoreFilter: boolean): readonly CommandBoardCardItem[] => {
    const q = searchQuery.trim().toLowerCase();
    return board.items.filter((item) => {
      if (!ignoreCommodoreFilter && store.selectedCommodores.size > 0 && !store.selectedCommodores.has(item.commodoreId)) return false;
      if (onlyAttention && !item.needsAttention) return false;
      if (onlyDue && item.due === null) return false;
      if (q) {
        const comm = commodoreMap.get(item.commodoreId);
        const hay = `${item.title} ${item.note} ${comm?.name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [board.items, commodoreMap, onlyAttention, onlyDue, searchQuery, store.selectedCommodores]);

  const allFiltered = useMemo(() => filterItems(true), [filterItems]);
  const visibleItems = useMemo(() => filterItems(false), [filterItems]);

  const handleDispatchCard = useCallback(async (item: CommandBoardCardItem, text: string) => {
    setDispatchingIds((prev) => new Set([...prev, item.id]));
    try {
      await dispatchObjectivePrompt(item.commodoreId, item.id, text);
      setExpandedCardId((current) => (current === item.id ? null : current));
      const commName = commodoreMap.get(item.commodoreId)?.name ?? t("sidebar.commodore.fallback");
      showToast({ text: t("commandBoard.toast.sent", { name: commName, title: item.title }), commodoreId: item.commodoreId });
    } finally {
      setTimeout(() => {
        setDispatchingIds((prev) => {
          if (!prev.has(item.id)) return prev;
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      }, 900);
    }
  }, [commodoreMap, showToast, t]);

  const toggleLane = useCallback((commodoreId: string) => {
    setCollapsedLanes((prev) => {
      const next = new Set(prev);
      if (next.has(commodoreId)) next.delete(commodoreId);
      else next.add(commodoreId);
      return next;
    });
  }, []);

  const defaultCreateCommodoreId = useCallback((preferred: string | null = null): string | null => {
    if (preferred && commodoreMap.has(preferred)) return preferred;
    if (store.viewMode === "matrix" && store.matrixFocusId !== "ALL" && commodoreMap.has(store.matrixFocusId)) return store.matrixFocusId;
    if (store.selectedCommodores.size === 1) {
      const [only] = store.selectedCommodores;
      if (only && commodoreMap.has(only)) return only;
    }
    return board.commodores[0]?.id ?? null;
  }, [board.commodores, commodoreMap, store.matrixFocusId, store.selectedCommodores, store.viewMode]);

  const renderCard = (item: CommandBoardCardItem, options?: { readonly hideCommodore?: boolean; readonly compact?: boolean }) => {
    const commodore = commodoreMap.get(item.commodoreId);
    if (!commodore) return null;
    const tone = toneOf(commodoreAvatarKey(commodore.id));
    return (
      <CommandBoardCard
        key={item.id}
        item={item}
        commodore={commodore}
        tone={tone}
        language={language}
        expanded={expandedCardId === item.id}
        dimmed={store.viewMode === "unified" && hoveredCommodoreId !== null && hoveredCommodoreId !== item.commodoreId}
        dispatching={dispatchingIds.has(item.id)}
        hideCommodore={options?.hideCommodore === true}
        compact={options?.compact === true}
        onToggle={() => setExpandedCardId((current) => (current === item.id ? null : item.id))}
        onDispatch={(text) => handleDispatchCard(item, text)}
      />
    );
  };

  const doneVisible = useMemo(() => visibleItems.filter((item) => item.column === "done"), [visibleItems]);

  return (
    <div className="command-board" data-command-board-view={store.viewMode} aria-label={t("commandBoard.aria")}>
      <header className="command-board-head">
        <div className="command-board-title-group">
          <span className="command-board-title-icon" aria-hidden="true"><CommandBoardGlyph /></span>
          <h2 className="command-board-title">{t("commandBoard.title")}</h2>
          <span className="command-board-summary">
            {t("commandBoard.summary", { commodores: board.commodores.length, objectives: visibleItems.length })}
          </span>
        </div>

        <div className="command-board-toolbar">
          <label className="command-board-search">
            <SearchGlyph />
            <input
              type="text"
              className="command-board-search-input"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("commandBoard.searchPlaceholder")}
              aria-label={t("commandBoard.searchAria")}
            />
          </label>

          <button
            type="button"
            className="command-board-filter-btn is-attention"
            aria-pressed={onlyAttention}
            onClick={() => setOnlyAttention((value) => !value)}
          >
            {t("commandBoard.filterAttention")}
          </button>

          <button
            type="button"
            className="command-board-filter-btn"
            aria-pressed={onlyDue}
            onClick={() => setOnlyDue((value) => !value)}
          >
            {t("commandBoard.filterDue")}
          </button>

          <div className="command-board-segmented" role="group" aria-label={t("commandBoard.viewGroupAria")}>
            <button
              type="button"
              className={`command-board-seg-btn${store.viewMode === "unified" ? " is-active" : ""}`}
              aria-pressed={store.viewMode === "unified"}
              onClick={() => setCommandBoardViewMode("unified")}
            >
              <CommandBoardGlyph size={12} />
              <span>{t("commandBoard.view.unified")}</span>
            </button>
            <button
              type="button"
              className={`command-board-seg-btn${store.viewMode === "commodore" ? " is-active" : ""}`}
              aria-pressed={store.viewMode === "commodore"}
              onClick={() => setCommandBoardViewMode("commodore")}
            >
              <SwimlaneGlyph />
              <span>{t("commandBoard.view.commodore")}</span>
            </button>
            <button
              type="button"
              className={`command-board-seg-btn${store.viewMode === "matrix" ? " is-active" : ""}`}
              aria-pressed={store.viewMode === "matrix"}
              onClick={() => setCommandBoardViewMode("matrix")}
            >
              <MatrixGlyph />
              <span>{t("commandBoard.view.matrix")}</span>
            </button>
          </div>

          {board.commodores.length > 0 ? (
            <button
              type="button"
              className="command-board-primary-btn"
              onClick={() => setModal({ kind: "create", defaultCommodoreId: defaultCreateCommodoreId() })}
            >
              <PlusGlyph />
              <span>{t("commandBoard.newObjective")}</span>
            </button>
          ) : null}
        </div>
      </header>

      {board.commodores.length === 0 ? (
        <div className="command-board-empty-stage">{t("commandBoard.empty.noCommodores")}</div>
      ) : (
        <>
          {store.viewMode !== "matrix" ? (
            <div className="command-board-roster">
              <button
                type="button"
                className={`command-board-pill${store.selectedCommodores.size === 0 ? " is-active" : ""}`}
                aria-pressed={store.selectedCommodores.size === 0}
                onClick={clearCommandBoardCommodoreFilter}
              >
                <span>{t("commandBoard.filterAll")}</span>
                <span className="command-board-pill-count">{allFiltered.length}</span>
              </button>
              {board.sectionBuckets.map((bucket, bucketIndex) => (
                <span key={bucket.id ?? `flat-${bucketIndex}`} style={{ display: "contents" }}>
                  {bucket.name !== null ? (
                    <>
                      <span className="command-board-roster-sep" aria-hidden="true" />
                      <span className="command-board-roster-sec">{bucket.name}</span>
                    </>
                  ) : null}
                  {bucket.commodores.map((comm) => {
                    const count = allFiltered.filter((item) => item.commodoreId === comm.id).length;
                    const hasAlert = board.items.some((item) => item.commodoreId === comm.id && (item.column === "review" || item.due?.overdue));
                    const active = store.selectedCommodores.has(comm.id);
                    return (
                      <button
                        key={comm.id}
                        type="button"
                        className={`command-board-pill${active ? " is-active" : ""}`}
                        aria-pressed={active}
                        onClick={() => toggleCommandBoardCommodoreFilter(comm.id)}
                        onMouseEnter={() => { if (store.viewMode === "unified") setHoveredCommodoreId(comm.id); }}
                        onMouseLeave={() => { if (hoveredCommodoreId === comm.id) setHoveredCommodoreId(null); }}
                      >
                        <CommodoreAvatar commodoreId={comm.id} state={comm.running ? "running" : "idle"} size={18} label="" decorative />
                        <span>{comm.name}</span>
                        <span className="command-board-pill-count">{count}</span>
                        {hasAlert ? <span className="command-board-pill-alert" aria-hidden="true" /> : null}
                      </button>
                    );
                  })}
                </span>
              ))}
            </div>
          ) : null}

          {store.viewMode === "unified" ? (
            <div className="command-board-scroll">
              <div className="command-board-grid">
                {COMMAND_BOARD_COLUMNS.map((col) => {
                  const colItems = visibleItems.filter((item) => item.column === col.id);
                  return (
                    <section key={col.id} className="command-board-col" data-command-board-col={col.id} aria-label={t(col.labelKey)}>
                      <div className="command-board-col-head">
                        <div className="command-board-col-head-left">
                          <span className={`command-board-col-dot is-${col.id}`} aria-hidden="true" />
                          <span className="command-board-col-title">{t(col.labelKey)}</span>
                          <span className="command-board-col-count">{colItems.length}</span>
                        </div>
                        {col.id === "done" && colItems.length > 0 ? (
                          <button type="button" className="command-board-col-btn" onClick={() => setModal({ kind: "batch-done" })}>
                            {t("commandBoard.done.batchAction")}
                          </button>
                        ) : col.id === "fresh" ? (
                          <button
                            type="button"
                            className="command-board-col-btn is-icon"
                            aria-label={t("commandBoard.newObjective")}
                            title={t("commandBoard.newObjective")}
                            onClick={() => setModal({ kind: "create", defaultCommodoreId: defaultCreateCommodoreId() })}
                          >
                            <PlusGlyph />
                          </button>
                        ) : (
                          <span className="command-board-col-desc">{t(col.descKey)}</span>
                        )}
                      </div>

                      <div className="command-board-col-list">
                        {colItems.length > 0
                          ? colItems.map((item) => renderCard(item))
                          : <div className="command-board-col-empty">{t("commandBoard.col.empty")}</div>}
                      </div>

                      {col.id === "done" ? (
                        <div className="command-board-col-foot">
                          <span>{t("commandBoard.done.footerHint")}</span>
                          <button type="button" className="command-board-link-btn" onClick={openArchiveSheet}>
                            {archive.total > 0 ? t("commandBoard.done.openArchive", { n: archive.total }) : t("commandBoard.done.openArchiveEmpty")}
                          </button>
                        </div>
                      ) : null}
                    </section>
                  );
                })}
              </div>
            </div>
          ) : store.viewMode === "commodore" ? (
            <div className="command-board-scroll">
              <div className="command-board-swim-wrap">
                <div className="command-board-swim-sticky">
                  {COMMAND_BOARD_COLUMNS.map((col) => {
                    const count = visibleItems.filter((item) => item.column === col.id).length;
                    return (
                      <div key={col.id} className="command-board-swim-col-head">
                        <span className={`command-board-col-dot is-${col.id}`} aria-hidden="true" />
                        <span className="command-board-col-title">{t(col.labelKey)}</span>
                        <span className="command-board-col-count">{count}</span>
                      </div>
                    );
                  })}
                </div>

                <div className="command-board-lanes">
                  {(() => {
                    const activeComms = board.commodores.filter((comm) => store.selectedCommodores.size === 0 || store.selectedCommodores.has(comm.id));
                    const populated = activeComms.filter((comm) => visibleItems.some((item) => item.commodoreId === comm.id));
                    const empty = activeComms.filter((comm) => !visibleItems.some((item) => item.commodoreId === comm.id));
                    return (
                      <>
                        {populated.map((comm) => {
                          const laneItems = visibleItems.filter((item) => item.commodoreId === comm.id);
                          const collapsed = collapsedLanes.has(comm.id);
                          const tone = toneOf(commodoreAvatarKey(comm.id));
                          const toneStyle = { "--cb-tone-ink": `var(--id-${tone})` } as CSSProperties;
                          const f = laneItems.filter((i) => i.column === "fresh").length;
                          const a = laneItems.filter((i) => i.column === "active").length;
                          const r = laneItems.filter((i) => i.column === "review").length;
                          const d = laneItems.filter((i) => i.column === "done").length;
                          return (
                            <section key={comm.id} className={`command-board-lane${collapsed ? " is-collapsed" : ""}`} style={toneStyle}>
                              <div className="command-board-lane-head">
                                <button type="button" className="command-board-lane-toggle" aria-expanded={!collapsed} onClick={() => toggleLane(comm.id)}>
                                  <ChevronGlyph direction={collapsed ? "right" : "down"} />
                                  <CommodoreAvatar commodoreId={comm.id} state={comm.running ? "running" : "idle"} size={22} label="" decorative />
                                  <span className="command-board-lane-name">{comm.name}</span>
                                  {comm.sectionName ? <span className="command-board-col-desc">{comm.sectionName}</span> : null}
                                  {comm.autonomous ? <span className="command-board-lane-badge">{t("commandBoard.lane.autonomous")}</span> : null}
                                </button>
                                <div className="command-board-lane-actions">
                                  <span className="command-board-lane-counts">{t("commandBoard.lane.counts", { fresh: f, active: a, review: r, done: d })}</span>
                                  <button type="button" className="command-board-col-btn" onClick={() => openCommodoreConversation(comm.id)}>
                                    {t("commandBoard.lane.openChat")}
                                  </button>
                                  <button type="button" className="command-board-col-btn" onClick={() => setModal({ kind: "create", defaultCommodoreId: comm.id })}>
                                    <PlusGlyph />
                                    <span>{t("commandBoard.newObjectiveShort")}</span>
                                  </button>
                                </div>
                              </div>
                              {!collapsed ? (
                                <div className="command-board-lane-grid">
                                  {COMMAND_BOARD_COLUMNS.map((col) => {
                                    const cellItems = laneItems.filter((item) => item.column === col.id);
                                    return (
                                      <div key={col.id} className="command-board-lane-cell">
                                        {cellItems.length > 0
                                          ? cellItems.map((item) => renderCard(item, { hideCommodore: true, compact: true }))
                                          : <div className="command-board-lane-dash">—</div>}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : null}
                            </section>
                          );
                        })}

                        {empty.length > 0 ? (
                          <div className="command-board-empty-strip">
                            <div className="command-board-empty-strip-list">
                              <span>{t("commandBoard.lane.emptyCommodores", { n: empty.length })}</span>
                              {empty.map((comm) => (
                                <span key={comm.id} className="command-board-empty-chip">
                                  <CommodoreAvatar commodoreId={comm.id} state="idle" size={16} label="" decorative />
                                  <span>{comm.name}</span>
                                </span>
                              ))}
                            </div>
                            <button type="button" className="command-board-col-btn" onClick={() => setModal({ kind: "create", defaultCommodoreId: empty[0]!.id })}>
                              {t("commandBoard.lane.firstObjective")}
                            </button>
                          </div>
                        ) : null}
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          ) : (
            <div className="command-board-matrix">
              <div className={`command-board-matrix-rail${store.matrixRailCollapsed ? " is-collapsed" : ""}`}>
                {!store.matrixRailCollapsed ? (
                  <>
                    <div className="command-board-matrix-head">
                      <span>{t("commandBoard.matrix.title")}</span>
                      <button
                        type="button"
                        className="command-board-col-btn is-icon"
                        aria-label={t("commandBoard.matrix.collapse")}
                        title={t("commandBoard.matrix.collapse")}
                        onClick={toggleCommandBoardMatrixRail}
                      >
                        <ChevronGlyph direction="left" />
                      </button>
                    </div>
                    <button
                      type="button"
                      className={`command-board-matrix-row${store.matrixFocusId === "ALL" ? " is-active" : ""}`}
                      aria-pressed={store.matrixFocusId === "ALL"}
                      onClick={() => setCommandBoardMatrixFocus("ALL")}
                    >
                      <span className="command-board-matrix-row-top">
                        <span className="command-board-matrix-name">{t("commandBoard.matrix.all")}</span>
                        <span className="command-board-col-count">{allFiltered.length}</span>
                      </span>
                    </button>
                    {board.sectionBuckets.map((bucket, bucketIndex) => (
                      <div key={bucket.id ?? `m-${bucketIndex}`}>
                        {bucket.name !== null ? <div className="command-board-matrix-sec">{bucket.name}</div> : null}
                        {bucket.commodores.map((comm) => {
                          const cItems = allFiltered.filter((item) => item.commodoreId === comm.id);
                          const f = cItems.filter((i) => i.column === "fresh").length;
                          const a = cItems.filter((i) => i.column === "active").length;
                          const r = cItems.filter((i) => i.column === "review").length;
                          const d = cItems.filter((i) => i.column === "done").length;
                          const tone = toneOf(commodoreAvatarKey(comm.id));
                          return (
                            <button
                              key={comm.id}
                              type="button"
                              className={`command-board-matrix-row${store.matrixFocusId === comm.id ? " is-active" : ""}`}
                              aria-pressed={store.matrixFocusId === comm.id}
                              style={{ "--cb-tone-ink": `var(--id-${tone})` } as CSSProperties}
                              onClick={() => setCommandBoardMatrixFocus(comm.id)}
                            >
                              <span className="command-board-matrix-row-top">
                                <CommodoreAvatar commodoreId={comm.id} state={comm.running ? "running" : "idle"} size={18} label="" decorative />
                                <span className="command-board-matrix-name">{comm.name}</span>
                                <span className="command-board-col-count">{cItems.length}</span>
                              </span>
                              <span className="command-board-matrix-cells">
                                <span className={`command-board-matrix-cell${f > 0 ? " is-fresh" : ""}`}>{f}</span>
                                <span className={`command-board-matrix-cell${a > 0 ? " is-active" : ""}`}>{a}</span>
                                <span className={`command-board-matrix-cell${r > 0 ? " is-review" : ""}`}>{r}</span>
                                <span className={`command-board-matrix-cell${d > 0 ? " is-done" : ""}`}>{d}</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="command-board-col-btn is-icon"
                      aria-label={t("commandBoard.matrix.expand")}
                      title={t("commandBoard.matrix.expand")}
                      onClick={toggleCommandBoardMatrixRail}
                    >
                      <ChevronGlyph direction="right" />
                    </button>
                    {board.commodores.map((comm) => (
                      <button
                        key={comm.id}
                        type="button"
                        className={`command-board-matrix-icon-btn${store.matrixFocusId === comm.id ? " is-active" : ""}`}
                        aria-label={comm.name}
                        title={comm.name}
                        onClick={() => setCommandBoardMatrixFocus(comm.id)}
                      >
                        <CommodoreAvatar commodoreId={comm.id} state={comm.running ? "running" : "idle"} size={20} label="" decorative />
                      </button>
                    ))}
                  </>
                )}
              </div>

              <div className="command-board-matrix-main">
                {(() => {
                  const focused = store.matrixFocusId === "ALL" ? null : commodoreMap.get(store.matrixFocusId) ?? null;
                  const drillItems = focused ? allFiltered.filter((item) => item.commodoreId === focused.id) : allFiltered;
                  const focusTone = focused ? toneOf(commodoreAvatarKey(focused.id)) : null;
                  return (
                    <>
                      {focused ? (
                        <div className="command-board-matrix-banner" style={focusTone ? { "--cb-tone-ink": `var(--id-${focusTone})` } as CSSProperties : undefined}>
                          <div className="command-board-matrix-banner-left">
                            <CommodoreAvatar commodoreId={focused.id} state={focused.running ? "running" : "idle"} size={22} label="" decorative />
                            <span className="command-board-lane-name">{focused.name}</span>
                            {focused.theaterPath ? <span className="command-board-matrix-path">{focused.theaterPath}</span> : null}
                            {focused.autonomous ? <span className="command-board-lane-badge">{t("commandBoard.lane.autonomous")}</span> : null}
                          </div>
                          <div className="command-board-lane-actions">
                            <button type="button" className="command-board-col-btn" onClick={() => openCommodoreConversation(focused.id)}>
                              {t("commandBoard.matrix.openChat")}
                            </button>
                            <button type="button" className="command-board-col-btn" onClick={() => setModal({ kind: "create", defaultCommodoreId: focused.id })}>
                              <PlusGlyph />
                              <span>{t("commandBoard.newObjectiveShort")}</span>
                            </button>
                          </div>
                        </div>
                      ) : null}

                      <div className="command-board-scroll">
                        <div className="command-board-grid">
                          {COMMAND_BOARD_COLUMNS.map((col) => {
                            const colItems = drillItems.filter((item) => item.column === col.id);
                            return (
                              <section key={col.id} className="command-board-col" data-command-board-col={col.id} aria-label={t(col.labelKey)}>
                                <div className="command-board-col-head">
                                  <div className="command-board-col-head-left">
                                    <span className={`command-board-col-dot is-${col.id}`} aria-hidden="true" />
                                    <span className="command-board-col-title">{t(col.labelKey)}</span>
                                    <span className="command-board-col-count">{colItems.length}</span>
                                  </div>
                                </div>
                                <div className="command-board-col-list">
                                  {colItems.length > 0
                                    ? colItems.map((item) => renderCard(item, { hideCommodore: focused !== null }))
                                    : <div className="command-board-col-empty">{t("commandBoard.col.empty")}</div>}
                                </div>
                              </section>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}
        </>
      )}

      {modal?.kind === "create" ? (
        <CreateObjectivePromptModal
          commodores={board.commodores}
          initialCommodoreId={modal.defaultCommodoreId ?? board.commodores[0]?.id ?? ""}
          onClose={() => setModal(null)}
          onSent={(commodoreId) => {
            setModal(null);
            const name = commodoreMap.get(commodoreId)?.name ?? t("sidebar.commodore.fallback");
            showToast({ text: t("commandBoard.toast.sentNew", { name }), commodoreId });
          }}
        />
      ) : null}

      {modal?.kind === "batch-done" ? (
        <BatchDonePromptModal
          items={doneVisible}
          commodoreMap={commodoreMap}
          onClose={() => setModal(null)}
          onSent={(commodoreCount, itemCount) => {
            setModal(null);
            showToast({ text: t("commandBoard.toast.sentBatch", { n: itemCount, count: commodoreCount }) });
          }}
        />
      ) : null}

      {toast ? (
        <div className="command-board-toast" role="status" aria-live="polite">
          <span>{toast.text}</span>
          {toast.commodoreId ? (
            <button type="button" className="command-board-toast-btn" onClick={() => openCommodoreConversation(toast.commodoreId!)}>
              {t("commandBoard.toast.openChat")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 모바일 지휘판(4열 탭 + 사령관 필터 + 동일 카드 인라인 지시 트레이). */
export function MobileCommandBoard({
  initialCommodoreId = null,
  onOpenObjective,
}: {
  readonly initialCommodoreId?: string | null;
  readonly onOpenObjective?: (item: CommandBoardCardItem) => void;
}) {
  const t = useT();
  const language = useConsoleLocale() === "ko" ? "ko" : "en";
  const board = useCommandBoardData(true);
  const toneOf = useAvatarToneOf();
  const [activeTab, setActiveTab] = useState<CommandBoardColumnId>("fresh");
  const [selectedCommodore, setSelectedCommodore] = useState<string | null>(initialCommodoreId);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [dispatchingIds, setDispatchingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [toast, setToast] = useState<string | null>(null);

  const commodoreMap = useMemo(() => new Map(board.commodores.map((c) => [c.id, c])), [board.commodores]);
  const visible = useMemo(
    () => (selectedCommodore ? board.items.filter((item) => item.commodoreId === selectedCommodore) : board.items),
    [board.items, selectedCommodore],
  );
  const tabItems = useMemo(() => visible.filter((item) => item.column === activeTab), [activeTab, visible]);

  return (
    <div className="command-board-mobile">
      <div className="command-board-roster">
        <button
          type="button"
          className={`command-board-pill${selectedCommodore === null ? " is-active" : ""}`}
          onClick={() => setSelectedCommodore(null)}
        >
          <span>{t("commandBoard.filterAll")}</span>
          <span className="command-board-pill-count">{board.items.length}</span>
        </button>
        {board.commodores.map((comm) => (
          <button
            key={comm.id}
            type="button"
            className={`command-board-pill${selectedCommodore === comm.id ? " is-active" : ""}`}
            onClick={() => setSelectedCommodore((current) => (current === comm.id ? null : comm.id))}
          >
            <CommodoreAvatar commodoreId={comm.id} state={comm.running ? "running" : "idle"} size={16} label="" decorative />
            <span>{comm.name}</span>
          </button>
        ))}
      </div>

      <div className="command-board-mobile-tabs" role="tablist">
        {COMMAND_BOARD_COLUMNS.map((col) => {
          const count = visible.filter((item) => item.column === col.id).length;
          const active = activeTab === col.id;
          return (
            <button
              key={col.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`command-board-mobile-tab${active ? " is-active" : ""}`}
              onClick={() => setActiveTab(col.id)}
            >
              <span>{t(col.labelKey)}</span>
              <span>{count}</span>
            </button>
          );
        })}
      </div>

      <div className="command-board-mobile-cards">
        {tabItems.length > 0 ? tabItems.map((item) => {
          const comm = commodoreMap.get(item.commodoreId);
          if (!comm) return null;
          return (
            <CommandBoardCard
              key={item.id}
              item={item}
              commodore={comm}
              tone={toneOf(commodoreAvatarKey(comm.id))}
              language={language}
              expanded={expandedCardId === item.id}
              dimmed={false}
              dispatching={dispatchingIds.has(item.id)}
              hideCommodore={selectedCommodore !== null}
              compact={false}
              onToggle={() => setExpandedCardId((current) => (current === item.id ? null : item.id))}
              onOpenObjective={onOpenObjective ? () => onOpenObjective(item) : undefined}
              onDispatch={async (text) => {
                setDispatchingIds((prev) => new Set([...prev, item.id]));
                try {
                  await dispatchObjectivePrompt(item.commodoreId, item.id, text);
                  setExpandedCardId(null);
                  setToast(t("commandBoard.toast.sent", { name: comm.name, title: item.title }));
                  setTimeout(() => setToast(null), 4_000);
                } finally {
                  setDispatchingIds((prev) => {
                    const next = new Set(prev);
                    next.delete(item.id);
                    return next;
                  });
                }
              }}
            />
          );
        }) : <div className="command-board-col-empty">{t("commandBoard.col.empty")}</div>}
      </div>

      {toast ? <div className="command-board-toast" role="status">{toast}</div> : null}
    </div>
  );
}

function CommandBoardCard({
  item,
  commodore,
  tone,
  language,
  expanded,
  dimmed,
  dispatching,
  hideCommodore,
  compact,
  onToggle,
  onOpenObjective,
  onDispatch,
}: {
  readonly item: CommandBoardCardItem;
  readonly commodore: CommandBoardCommodore;
  readonly tone: string;
  readonly language: "en" | "ko";
  readonly expanded: boolean;
  readonly dimmed: boolean;
  readonly dispatching: boolean;
  readonly hideCommodore: boolean;
  readonly compact: boolean;
  readonly onToggle: () => void;
  readonly onOpenObjective?: () => void;
  readonly onDispatch: (text: string) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [pickedPresetId, setPickedPresetId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!expanded) {
      setDraft("");
      setPickedPresetId(null);
      setError(null);
      return;
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [expanded]);

  const pct = item.progress && item.progress.total > 0 ? Math.round((item.progress.done / item.progress.total) * 100) : 0;
  const toneStyle = {
    "--cb-tone-ink": `var(--id-${tone})`,
    "--cb-tone-body": `var(--mongle-${tone})`,
  } as CSSProperties;

  const submit = async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError(t("commandBoard.error.emptyPrompt"));
      inputRef.current?.focus();
      return;
    }
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await onDispatch(trimmed);
    } catch (caught) {
      const code = caught instanceof Error && caught.message ? caught.message : "failed";
      setError(t("commandBoard.error.sendFailed", { code }));
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const presets = COMMAND_BOARD_PRESETS[item.column];
  const dueBadge = item.due ? (
    <span className={`command-board-due${item.due.overdue ? " is-overdue" : ""}`}>
      {item.due.overdue
        ? t("commandBoard.card.overdue", { date: formatShortDueDate(item.due.date) })
        : formatShortDueDate(item.due.date)}
    </span>
  ) : null;

  return (
    <article
      className={[
        "command-board-card",
        expanded ? "is-expanded" : "",
        dimmed ? "is-dimmed" : "",
        item.column === "done" ? "is-done" : "",
      ].filter(Boolean).join(" ")}
      style={toneStyle}
      data-command-board-card={item.id}
      onClick={(event) => {
        if ((event.target as Element).closest("[data-stop-card]")) return;
        onToggle();
      }}
    >
      <div className="command-board-card-top">
        {!hideCommodore ? (
          <span className="command-board-card-owner">
            <CommodoreAvatar commodoreId={commodore.id} state={commodore.running ? "running" : "idle"} size={18} label="" decorative />
            <span className="command-board-card-owner-name">{commodore.name}</span>
          </span>
        ) : (
          <span className="command-board-card-updated">{formatRelativeTime(item.updatedAt, language)}</span>
        )}
        <span data-stop-card="1">
          <CommanderRowGlyphs
            commodoreId={item.commodoreId}
            objectiveId={item.id}
            title={item.title}
            onGlyphTab={(objectiveId, tab, opener) => openCommanderRowGlyphTab(objectiveId, tab, opener)}
          />
        </span>
      </div>

      <div className="command-board-card-title">{item.title}</div>
      {!compact && item.column !== "done" && item.note ? (
        <div className="command-board-card-note">{item.note}</div>
      ) : null}

      {dispatching ? (
        <div className="command-board-dispatch-bar">
          <span>{t("commandBoard.card.dispatching", { name: commodore.name })}</span>
        </div>
      ) : item.column === "fresh" ? (
        <div className="command-board-card-foot">
          <div className="command-board-card-row">
            <span className="command-board-card-status">
              <FreshGlyph />
              <span className="command-board-card-status-text">
                {item.progress && item.progress.total > 0
                  ? t("commandBoard.card.pendingMissions", { n: item.progress.total })
                  : t("commandBoard.card.waitingStart")}
              </span>
            </span>
            {dueBadge ?? <span className="command-board-card-updated">{formatRelativeTime(item.updatedAt, language)}</span>}
          </div>
        </div>
      ) : item.column === "active" ? (
        <div className="command-board-card-foot">
          <div className="command-board-card-row">
            <span className="command-board-card-status">
              <KeyedAvatar avatarKey={objectiveRecordAvatarKey(item.id)} role="commander" state={item.mongleState} size={18} label="" decorative />
              <span className={`command-board-card-status-text${item.mongleState === "running" ? " is-running" : item.mongleState === "awaiting" ? " is-awaiting" : ""}`}>
                {item.activityLine ?? t("cluster.picker.activity.idle")}
              </span>
            </span>
            {dueBadge}
          </div>
          {item.progress ? (
            <div className="command-board-progress">
              <span className="command-board-progress-track">
                <span className={`command-board-progress-fill${item.progress.done === item.progress.total ? " is-done" : ""}`} style={{ width: `${pct}%` }} />
              </span>
              <span className="command-board-progress-num">{item.progress.done}/{item.progress.total}</span>
            </div>
          ) : null}
        </div>
      ) : item.column === "review" ? (
        <div className="command-board-card-foot">
          <div className="command-board-review-pill">
            <span className="command-board-review-dot" aria-hidden="true" />
            <span className="command-board-review-text">{item.reviewNote ?? t("commanderTab.status.review")}</span>
          </div>
          <div className="command-board-card-row">
            <span>{item.progress ? t("commandBoard.card.missionsCount", { done: item.progress.done, total: item.progress.total }) : ""}</span>
            <span>{formatRelativeTime(item.updatedAt, language)}</span>
          </div>
        </div>
      ) : (
        <div className="command-board-card-foot">
          <div className="command-board-card-row">
            <span className="command-board-done-mark">
              <DoneGlyph />
              <span className="command-board-done-stamp">
                {item.doneAt ? formatDoneStamp(item.doneAt, language) : t("commandBoard.col.done")}
              </span>
            </span>
            <span className="command-board-card-updated">{t("commandBoard.card.doneHint")}</span>
          </div>
        </div>
      )}

      {expanded && !dispatching ? (
        <div className="command-board-tray" data-stop-card="1">
          <div className="command-board-tray-head">
            <span className="command-board-tray-who">
              <CommodoreAvatar commodoreId={commodore.id} state={commodore.running ? "running" : "idle"} size={16} label="" decorative />
              <span>{t("commandBoard.card.instructHeading", { name: commodore.name })}</span>
            </span>
            <button
              type="button"
              className="command-board-link-btn"
              onClick={() => {
                if (onOpenObjective) onOpenObjective();
                else openCommanderConversation(item.commodoreId, item.id);
              }}
            >
              <span>{item.column === "fresh" ? t("commandBoard.card.openStart") : t("commandBoard.card.openChat")}</span>
              <ExternalGlyph />
            </button>
          </div>

          <div className="command-board-presets" role="group" aria-label={t("commandBoard.card.presetsAria")}>
            {presets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={`command-board-preset-chip${pickedPresetId === preset.id ? " is-picked" : ""}`}
                onClick={() => {
                  const text = t(preset.promptKey);
                  setPickedPresetId(preset.id);
                  setDraft(text);
                  setError(null);
                  requestAnimationFrame(() => {
                    const el = inputRef.current;
                    if (!el) return;
                    el.focus();
                    el.setSelectionRange(text.length, text.length);
                  });
                }}
              >
                {t(preset.labelKey)}
              </button>
            ))}
          </div>

          <div className="command-board-composer">
            <span className="command-board-ref-chip">@{item.title}</span>
            <div className="command-board-composer-row">
              <textarea
                ref={inputRef}
                rows={2}
                className="command-board-textarea"
                value={draft}
                disabled={sending}
                placeholder={t("commandBoard.card.promptPlaceholder")}
                aria-label={t("commandBoard.card.promptAria", { name: commodore.name })}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={handleKeyDown}
              />
              <button
                type="button"
                className="command-board-send-btn"
                disabled={sending || !draft.trim()}
                aria-label={t("commandBoard.card.sendAria", { name: commodore.name })}
                title={t("commandBoard.card.sendAria", { name: commodore.name })}
                onClick={() => { void submit(); }}
              >
                <SendGlyph />
              </button>
            </div>
          </div>

          {error ? <p className="command-board-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </article>
  );
}

function CreateObjectivePromptModal({
  commodores,
  initialCommodoreId,
  onClose,
  onSent,
}: {
  readonly commodores: readonly CommandBoardCommodore[];
  readonly initialCommodoreId: string;
  readonly onClose: () => void;
  readonly onSent: (commodoreId: string) => void;
}) {
  const t = useT();
  const toneOf = useAvatarToneOf();
  const [commodoreId, setCommodoreId] = useState(initialCommodoreId || commodores[0]?.id || "");
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const submit = async () => {
    const clean = prompt.trim();
    if (!commodoreId || !clean) {
      setError(t("commandBoard.error.emptyPrompt"));
      return;
    }
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await messageCommodore(commodoreId, clean);
      onSent(commodoreId);
    } catch (caught) {
      const code = caught instanceof Error && caught.message ? caught.message : "failed";
      setError(t("commandBoard.error.sendFailed", { code }));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="command-board-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t("commandBoard.create.title")}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="command-board-modal">
        <div>
          <div className="command-board-modal-eyebrow">{t("commandBoard.create.eyebrow")}</div>
          <h3 className="command-board-modal-title">{t("commandBoard.create.title")}</h3>
        </div>

        <div className="command-board-modal-field">
          <span>{t("commandBoard.create.commodoreLabel")}</span>
          <div className="command-board-comm-choices" role="group" aria-label={t("commandBoard.create.commodoreLabel")}>
            {commodores.map((comm) => {
              const tone = toneOf(commodoreAvatarKey(comm.id));
              return (
                <button
                  key={comm.id}
                  type="button"
                  className="command-board-comm-choice"
                  aria-pressed={commodoreId === comm.id}
                  style={{ "--cb-tone-ink": `var(--id-${tone})` } as CSSProperties}
                  onClick={() => setCommodoreId(comm.id)}
                >
                  <CommodoreAvatar commodoreId={comm.id} state={comm.running ? "running" : "idle"} size={16} label="" decorative />
                  <span>{comm.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="command-board-presets">
          <button
            type="button"
            className="command-board-preset-chip"
            onClick={() => {
              const text = t("commandBoard.create.presetRegisterPrompt");
              setPrompt(text);
              requestAnimationFrame(() => {
                textareaRef.current?.focus();
                textareaRef.current?.setSelectionRange(text.length, text.length);
              });
            }}
          >
            {t("commandBoard.create.presetRegister")}
          </button>
          <button
            type="button"
            className="command-board-preset-chip"
            onClick={() => {
              const text = t("commandBoard.create.presetRunPrompt");
              setPrompt(text);
              requestAnimationFrame(() => {
                textareaRef.current?.focus();
                textareaRef.current?.setSelectionRange(text.length, text.length);
              });
            }}
          >
            {t("commandBoard.create.presetRun")}
          </button>
        </div>

        <label className="command-board-modal-field">
          <span>{t("commandBoard.create.promptLabel")}</span>
          <textarea
            ref={textareaRef}
            rows={3}
            className="command-board-modal-textarea"
            value={prompt}
            disabled={sending}
            placeholder={t("commandBoard.create.promptPlaceholder")}
            onChange={(event) => {
              setPrompt(event.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>

        {error ? <p className="command-board-error" role="alert">{error}</p> : null}

        <div className="command-board-modal-foot">
          <button type="button" className="command-board-modal-btn" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="command-board-modal-btn is-primary" disabled={sending || !prompt.trim()} onClick={() => { void submit(); }}>
            {t("commandBoard.create.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}

function BatchDonePromptModal({
  items,
  commodoreMap,
  onClose,
  onSent,
}: {
  readonly items: readonly CommandBoardCardItem[];
  readonly commodoreMap: ReadonlyMap<string, CommandBoardCommodore>;
  readonly onClose: () => void;
  readonly onSent: (commodoreCount: number, itemCount: number) => void;
}) {
  const t = useT();
  const [prompt, setPrompt] = useState(() => t("commandBoard.batch.defaultPrompt"));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const names = useMemo(() => {
    const unique = [...new Set(items.map((item) => commodoreMap.get(item.commodoreId)?.name).filter((name): name is string => Boolean(name)))];
    return unique.join(", ");
  }, [commodoreMap, items]);

  const submit = async () => {
    if (sending || items.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const count = await dispatchBatchDonePrompt(items, prompt);
      onSent(count, items.length);
    } catch (caught) {
      const code = caught instanceof Error && caught.message ? caught.message : "failed";
      setError(t("commandBoard.error.sendFailed", { code }));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="command-board-scrim"
      role="dialog"
      aria-modal="true"
      aria-label={t("commandBoard.batch.title", { n: items.length })}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="command-board-modal">
        <div>
          <div className="command-board-modal-eyebrow">{t("commandBoard.batch.eyebrow")}</div>
          <h3 className="command-board-modal-title">{t("commandBoard.batch.title", { n: items.length })}</h3>
        </div>
        <p className="command-board-modal-desc">{t("commandBoard.batch.body", { names })}</p>
        <textarea
          rows={2}
          className="command-board-modal-textarea"
          value={prompt}
          disabled={sending}
          onChange={(event) => setPrompt(event.target.value)}
        />
        {error ? <p className="command-board-error" role="alert">{error}</p> : null}
        <div className="command-board-modal-foot">
          <button type="button" className="command-board-modal-btn" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" className="command-board-modal-btn is-primary" disabled={sending || !prompt.trim()} onClick={() => { void submit(); }}>
            {t("commandBoard.batch.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
