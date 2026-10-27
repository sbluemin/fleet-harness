import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { useConsoleLocale, useT } from "../../../../core/client/src/i18n/index.js";
import { CommodoreAvatar } from "../../../commodore/client/commodore-avatar.js";
import { openCommodoreConversation } from "../../../commodore/client/commodore-conversation.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { ClusterRowAvatar, ClusterRowProgress, clusterRowSummary, type SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";
import { CommanderListOwner, CommodoreCommanderList, useCommanderOwner } from "./commander-list.js";
import { useCommanderRows } from "./commander-rows.js";
import { openCommanderConversation } from "./commander-navigation.js";
import { useCommanderPlacement } from "./commander-placement.js";
import "./commander-ghost-rail.css";

/** 대화의 거터 위에만 선다. 사령관과 지휘관이 바뀌어도 이 탐색기의 소유 사령관은 같다. */
export function CommanderGhostRail({ commodoreId, selectedId }: { readonly commodoreId: string; readonly selectedId: string | null }) {
  const t = useT();
  const locale = useConsoleLocale();
  const owner = useCommanderOwner(commodoreId);
  const { sections } = useCommanderRows(commodoreId, selectedId);
  const rows = sections.flatMap((section) => section.rows);
  const selected = selectedId === null ? 0 : rows.findIndex((item) => commanderObjectiveId(item.layout.cluster) === selectedId) + 1;
  const [cursor, setCursor] = useState(selected);
  const [expanded, setExpanded] = useState(false);
  const side = useCommanderPlacement().side;
  const [tip, setTip] = useState<{ index: number; top: number } | null>(null);
  const nav = useRef<HTMLElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const target = useRef(0);
  const snap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwell = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardExpanded = useRef(false);
  const pinned = useRef(false);
  const reduced = useRef(false);
  const id = useId();
  const itemId = (index: number) => `${id}-${index}`;

  const clearDwell = () => { if (dwell.current !== null) clearTimeout(dwell.current); dwell.current = null; };
  const clearLeave = () => { if (leave.current !== null) clearTimeout(leave.current); leave.current = null; };
  const resetFaces = () => nav.current?.querySelectorAll<HTMLElement>(".commander-ghost-face").forEach((face) => face.style.removeProperty("--ghost-scale"));
  // pin: 하단 화살표·키보드로 연 목록. 머물러 연 목록은 고정하지 않는다.
  const reveal = (pin: boolean, focusList = false) => {
    pinned.current = pin;
    keyboardExpanded.current = focusList;
    clearLeave(); clearDwell(); resetFaces(); setTip(null); setExpanded(true);
    if (focusList) requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>("button")?.focus());
  };
  const collapse = (restore = true) => {
    pinned.current = false;
    keyboardExpanded.current = false;
    clearLeave(); clearDwell(); setExpanded(false); setTip(null);
    if (restore) nav.current?.querySelector<HTMLElement>(`[data-ghost-index="${Math.min(cursor, rows.length)}"]`)?.focus({ preventScroll: true });
  };
  const scheduleCollapse = () => {
    if (pinned.current) return;
    clearDwell(); clearLeave(); resetFaces(); setTip(null);
    leave.current = setTimeout(() => {
      if (keyboardExpanded.current && panel.current?.contains(document.activeElement)) return;
      collapse(false);
    }, 220);
  };
  useEffect(() => () => { clearLeave(); clearDwell(); }, []);

  // 휠·선택·키보드는 하나의 곡선을 쓴다. 줄 크기와 스크롤 상태를 레이아웃 애니메이션으로 바꾸지 않는다.
  const scrollTo = useCallback((value: number) => {
    const element = scroller.current;
    if (!element) return;
    target.current = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, value));
    if (reduced.current) { cancelAnimationFrame(frame.current); frame.current = 0; element.scrollTop = target.current; return; }
    if (frame.current) return;
    let position = element.scrollTop;
    const step = () => {
      const delta = target.current - position;
      if (Math.abs(delta) < 0.5) { element.scrollTop = target.current; frame.current = 0; return; }
      position += delta * 0.2;
      element.scrollTop = position;
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, []);
  const center = useCallback((index: number) => {
    const element = scroller.current;
    const button = nav.current?.querySelector<HTMLElement>(`[data-ghost-index="${index}"]`);
    if (!element || !button || index === 0) return;
    if (snap.current !== null) clearTimeout(snap.current);
    const top = button.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
    scrollTo(top + button.offsetHeight / 2 - element.clientHeight / 2);
  }, [scrollTo]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      reduced.current = media.matches;
      if (media.matches) {
        resetFaces();
        if (snap.current !== null) clearTimeout(snap.current);
        cancelAnimationFrame(frame.current); frame.current = 0;
        if (scroller.current) scroller.current.scrollTop = target.current;
      }
    };
    update(); media.addEventListener("change", update);
    return () => { media.removeEventListener("change", update); cancelAnimationFrame(frame.current); if (snap.current !== null) clearTimeout(snap.current); clearDwell(); };
  }, []);
  useEffect(() => { setCursor(selected); center(selected); }, [selected, selectedId, center]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const fades = () => {
      element.dataset.moreTop = String(element.scrollTop > 1);
      element.dataset.moreBottom = String(element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaY === 0) return;
      event.preventDefault(); clearDwell(); setTip(null); resetFaces();
      const delta = event.deltaY * (event.deltaMode === 1 ? 46 : event.deltaMode === 2 ? element.clientHeight : 1);
      scrollTo((frame.current ? target.current : element.scrollTop) + delta);
      if (snap.current !== null) clearTimeout(snap.current);
      if (!reduced.current) snap.current = setTimeout(() => {
        const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
        const next = target.current >= maximum - 23 ? maximum : target.current <= 23 ? 0 : Math.round(target.current / 46) * 46;
        scrollTo(next);
      }, 140);
    };
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("scroll", fades, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fades);
    observer?.observe(element); fades();
    return () => { element.removeEventListener("wheel", wheel); element.removeEventListener("scroll", fades); observer?.disconnect(); };
  }, [rows.length, scrollTo]);
  useEffect(() => {
    if (!expanded) return;
    const outside = (event: PointerEvent) => {
      if (pinned.current) return;
      if (event.target instanceof Node && !nav.current?.contains(event.target)) collapse(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const list = panel.current?.querySelector<HTMLElement>(".commander-tab-groups");
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (list && row) list.scrollTo?.({ top: row.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop - (list.clientHeight - row.offsetHeight) / 2, behavior: reduced.current ? "instant" : "smooth" });
  }, [expanded, selectedId]);

  const select = (index: number) => {
    setCursor(index);
    if (index === 0) openCommodoreConversation(commodoreId);
    else {
      const item = rows[index - 1];
      if (!item) return;
      const objectiveId = commanderObjectiveId(item.layout.cluster);
      if (objectiveId === null) item.layout.cluster.open?.();
      else openCommanderConversation(commodoreId, objectiveId);
    }
    center(index);
  };
  const selectRow = (item: SideBarRowItem) => {
    const objectiveId = commanderObjectiveId(item.layout.cluster);
    if (objectiveId !== null) openCommanderConversation(commodoreId, objectiveId);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); collapse(); return; }
    if (expanded && event.target instanceof Node && panel.current?.contains(event.target)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length : Math.max(0, Math.min(rows.length, cursor + (event.key === "ArrowDown" ? 1 : -1)));
      setCursor(next); center(next);
      nav.current?.querySelector<HTMLElement>(`[data-ghost-index="${next}"]`)?.focus({ preventScroll: true });
    } else if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); select(cursor); }
    else if (event.key === (side === "left" ? "ArrowRight" : "ArrowLeft") || event.key === " ") { event.preventDefault(); event.stopPropagation(); reveal(true, true); }
  };
  const tipRow = tip && tip.index > 0 ? rows[tip.index - 1] : null;
  const tipSummary = tipRow ? clusterRowSummary(tipRow, locale, t) : null;

  return <nav ref={nav} className="commander-ghost" aria-label={t("commanderTab.aria")}
    data-side={side} data-expanded={expanded || undefined} data-pinned={(expanded && pinned.current) || undefined} onKeyDown={onKeyDown}
    onKeyDownCapture={() => { if (expanded) keyboardExpanded.current = true; }}
    onPointerEnter={clearLeave}
    onFocus={clearLeave}
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(":hover")) scheduleCollapse(); }}
    onPointerMove={(event) => {
      clearLeave();
      if (expanded || event.pointerType === "touch") return;
      clearDwell();
      let nearest: { index: number; distance: number; top: number } | null = null;
      const navTop = event.currentTarget.getBoundingClientRect().top;
      event.currentTarget.querySelectorAll<HTMLElement>("[data-ghost-index]").forEach((button) => {
        const rect = button.getBoundingClientRect();
        const middle = rect.top + rect.height / 2;
        const distance = Math.abs(event.clientY - middle);
        const proximity = Math.max(0, 1 - distance / 100);
        const scale = reduced.current ? 1 : 1 + 0.3 * proximity * proximity * (3 - 2 * proximity);
        button.querySelector<HTMLElement>(".commander-ghost-face")?.style.setProperty("--ghost-scale", String(scale));
        if (distance < 24 && (!nearest || distance < nearest.distance)) nearest = { index: Number(button.dataset.ghostIndex), distance, top: middle - navTop };
      });
      setTip(nearest);
      if (nearest) dwell.current = setTimeout(() => reveal(false), 500);
    }}
    onPointerLeave={scheduleCollapse}
  >
    <button id={itemId(0)} data-ghost-index={0} data-ghost-owner="" type="button" tabIndex={Math.min(cursor, rows.length) === 0 ? 0 : -1} className="commander-ghost-item" aria-label={owner.name} aria-current={selectedId === null ? "true" : undefined} data-cursor={cursor === 0 || undefined} onClick={() => select(0)}>
      <span className="commander-ghost-face"><CommodoreAvatar theaterId={commodoreId} state={owner.state} size={26} label="" decorative /></span>
    </button>
    <div className="commander-ghost-rule" role="separator" />
    {/* 레일의 탭 정지는 roving 항목 하나뿐이다. 스크롤 영역이 브라우저 기본으로 따로 초점을 받지 않게 한다. */}
    <div ref={scroller} className="commander-ghost-scroll" tabIndex={-1}>
      {rows.map((item, index) => {
        const summary = clusterRowSummary(item, locale, t);
        const position = index + 1;
        return <button key={item.layout.cluster.id} id={itemId(position)} data-ghost-index={position} data-ghost-commander={commanderObjectiveId(item.layout.cluster) ?? item.layout.cluster.id}
          type="button" tabIndex={Math.min(cursor, rows.length) === position ? 0 : -1} className="commander-ghost-item" aria-label={`${item.layout.cluster.title}, ${summary.conversationLine}${item.row.progress ? `, ${item.row.progress.done}/${item.row.progress.total}` : ""}`}
          aria-current={selectedId !== null && commanderObjectiveId(item.layout.cluster) === selectedId ? "true" : undefined} data-cursor={cursor === position || undefined} onClick={() => select(position)}>
          <span className="commander-ghost-face"><ClusterRowAvatar item={item} rowState={summary.state} label={summary.label} size={26} decorative /></span>
          <span className="commander-ghost-progress" aria-hidden="true"><ClusterRowProgress progress={item.row.progress ?? null} /></span>
          {item.row.decisionRequestedAt !== undefined && item.row.decisionQuestions ? <span className="commander-ghost-questions" aria-hidden="true">{item.row.decisionQuestions}</span> : null}
        </button>;
      })}
    </div>
    <button type="button" tabIndex={-1} className="commander-ghost-open" aria-label={t(expanded ? "commanderRail.collapse" : "commanderRail.expand")} aria-expanded={expanded} aria-controls={`${id}-list`} onClick={(event) => expanded ? collapse() : reveal(true, event.detail === 0)}>{side === "left" ? "›" : "‹"}</button>
    {!expanded && tip ? <span className="commander-ghost-tip" style={{ top: tip.top }} role="tooltip"><strong>{tipRow?.layout.cluster.title ?? owner.name}</strong><small>{tipSummary?.conversationLine ?? t("sidebar.commodore.fallback")}</small></span> : null}
    {expanded ? <div ref={panel} id={`${id}-list`} className="commander-ghost-list">
      <div className="commander-ghost-list-head"><CommanderListOwner commodoreId={commodoreId} selected={selectedId === null} onSelect={() => select(0)} />
        <button type="button" className="commander-ghost-close" aria-label={t("commanderRail.collapse")} onClick={() => collapse()}>×</button></div>
      <div className="commander-list-rule" role="separator" />
      <CommodoreCommanderList commodoreId={commodoreId} selectedId={selectedId} onSelect={selectRow} />
    </div> : null}
  </nav>;
}
