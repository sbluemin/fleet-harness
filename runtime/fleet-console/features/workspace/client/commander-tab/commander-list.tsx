import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { openCommanderConversation } from "./commander-navigation.js";
import type { SideBarRowItem } from "../sidebar/side-bar-cluster-row.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { SideBarClusterRow } from "../sidebar/side-bar-cluster-row.js";
import { CommodoreAvatar } from "../../../commodore/client/commodore-avatar.js";
import { commodoreSectionLabel, useCommodoreList } from "../../../commodore/client/commodore-list.js";
import { useCommodore } from "../../../commodore/client/commodore-state.js";
import { commodoreMongleState } from "../../../commodore/client/commodore-header.js";
import { useObjectiveTheater } from "../../../commodore/client/board.js";
import { openCommodoreNewSession } from "../conversation/new-session-entry.js";
import { CommodoreRecentActions } from "../../../commodore/client/commodore-trail.js";
import { revealCommodoreTurn } from "../../../commodore/client/commodore-conversation.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { SORTS, setSort, type SortDirection, type SortPreference } from "./commander-sort.js";
import { useCommanderRows } from "./commander-rows.js";
import { setCommanderPlacement, useCommanderPlacement, useEffectiveCommanderPlacement, type CommanderPlacement } from "./commander-placement.js";
import "./commander-list.css";

/** 고스트 목록과 폰 시트가 같은 두 줄 행·정렬·최근 행위를 쓴다. */
export function CommodoreCommanderList({ commodoreId, selectedId = null, onSelect, onNewSession }: {
  readonly commodoreId: string;
  readonly selectedId?: string | null;
  readonly onSelect?: (item: SideBarRowItem) => void;
  readonly onNewSession?: () => void;
}) {
  const t = useT();
  const language = useConsoleLocale();
  const { sorted, sections, preference } = useCommanderRows(commodoreId, selectedId);

  return (
    <section className="commander-tab" aria-label={t("commanderTab.aria")}>
      <div className="commander-tab-bar">
        <span className="commander-tab-count">{t("commanderTab.count", { count: sorted.length })}</span>
        <SortMenu preference={preference} />
        <button type="button" className="commander-tab-direction" aria-label={t("sidebar.commodore.newSession")} title={t("sidebar.commodore.newSession")} onClick={onNewSession ?? (() => openCommodoreNewSession(commodoreId))}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <CommanderPlacementGlyphs />
      </div>
      {sorted.length === 0 ? <p className="commander-tab-empty">{t("commanderTab.empty")}</p> : (
        <div className="commander-tab-groups">
          {sections.map((group) => <section key={group.id}>
            {group.title !== null ? <h3 className="commander-tab-group-title">{group.title}<span>{group.rows.length}</span></h3> : null}
            <ol className="commander-tab-list side-bar-group-chips">
              {group.rows.map((item) => {
                const objectiveId = commanderObjectiveId(item.layout.cluster);
                const selected = objectiveId !== null && selectedId === objectiveId;
                return <Fragment key={item.layout.cluster.id}>
                  <SideBarClusterRow item={item} selected={selected}
                    onFocus={(id) => { if (onSelect) onSelect(item); else openCommanderConversation(commodoreId, id); }} />
                  {selected ? <li className="commander-tab-trail"><CommodoreRecentActions commodoreId={commodoreId} objectiveId={objectiveId} language={language} onReveal={(at) => revealCommodoreTurn(commodoreId, at)} /></li> : null}
                </Fragment>;
              })}
            </ol>
          </section>)}
        </div>
      )}
    </section>
  );
}

export function useCommanderOwner(commodoreId: string) {
  const t = useT();
  const owner = useCommodoreList().find((item) => item.commodoreId === commodoreId);
  const { view } = useCommodore(commodoreId);
  const board = useObjectiveTheater(commodoreId);
  return {
    name: owner ? commodoreSectionLabel(owner, t("sidebar.commodore.fallback")) : t("sidebar.commodore.fallback"),
    state: commodoreMongleState(view, board.objectives),
  };
}

export function CommanderListOwner({ commodoreId, selected, onSelect }: { readonly commodoreId: string; readonly selected: boolean; readonly onSelect: () => void }) {
  const owner = useCommanderOwner(commodoreId);
  const t = useT();
  return <button type="button" className="commander-list-owner" aria-current={selected ? "true" : undefined} onClick={onSelect}>
    <CommodoreAvatar theaterId={commodoreId} state={owner.state} size={30} label="" decorative />
    <span><strong>{owner.name}</strong><small>{t("sidebar.commodore.fallback")}</small></span>
  </button>;
}

/** 목록 위치. 글자 없이 글리프만 두고, 사이드바와 채팅의 왼쪽·오른쪽은 한 묶음이다. */
function CommanderPlacementGlyphs() {
  const t = useT();
  const placement = useCommanderPlacement();
  const shown = useEffectiveCommanderPlacement();
  const choose = (next: CommanderPlacement) => setCommanderPlacement(next);
  return (
    <span className="commander-place" role="group" aria-label={t("commanderRail.place")}>
      <button type="button" className="commander-place-button" aria-pressed={shown.place === "sidebar"} aria-label={t("commanderRail.placeSidebar")} title={t("commanderRail.placeSidebar")} onClick={() => choose({ place: "sidebar", side: placement.side })}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 2.4h3.1v11.2H2.2z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M7.6 4.6h6M7.6 8h6M7.6 11.4h4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </button>
      <button type="button" className="commander-place-button" aria-pressed={shown.place === "chat" && shown.side === "left"} aria-label={t("commanderRail.placeChatLeft")} title={t("commanderRail.placeChatLeft")} onClick={() => choose({ place: "chat", side: "left" })}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 3.2h3.2v9.6H2.2zM6.6 3.2h7.2v9.6H6.6z" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
      <button type="button" className="commander-place-button" aria-pressed={shown.place === "chat" && shown.side === "right"} aria-label={t("commanderRail.placeChatRight")} title={t("commanderRail.placeChatRight")} onClick={() => choose({ place: "chat", side: "right" })}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 3.2h7.2v9.6H2.2zM10.6 3.2h3.2v9.6h-3.2z" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
      </button>
    </span>
  );
}

function SortMenu({ preference }: { readonly preference: SortPreference }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const current = SORTS.find((sort) => sort.key === preference.key) ?? SORTS[0]!;
  const sortLabel = t("commanderTab.sort.button", { label: t(current.label) });
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const row = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-sort-row]");
    const column = (document.activeElement as HTMLElement | null)?.dataset.sortColumn ?? "name";
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      if (!row) return;
      event.preventDefault();
      const order = ["name", "asc", "desc"];
      const next = order[order.indexOf(column) + (event.key === "ArrowRight" ? 1 : -1)];
      if (next) row.querySelector<HTMLElement>(`[data-sort-column="${next}"]`)?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    if (row) {
      const rows = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-sort-row]") ?? []);
      const next = rows[rows.indexOf(row) + step];
      if (next) { (next.querySelector<HTMLElement>(`[data-sort-column="${column}"]`) ?? next.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus(); return; }
    }
    const fallback = items[index + step] ?? items[step > 0 ? 0 : items.length - 1];
    fallback?.focus();
  };
  const pick = (key: SortPreference["key"], direction: SortDirection) => { setSort({ ...preference, key, direction }); close(); };
  return (
    <span className="commander-tab-sort">
      <button ref={buttonRef} type="button" className="commander-tab-sort-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-label={sortLabel} title={sortLabel} onClick={() => setOpen((value) => !value)}>{sortLabel}</button>
      {open ? <div ref={menuRef} id={menuId} className="commander-tab-menu" role="menu" aria-label={t("commanderTab.sort.menu")} onKeyDown={onMenuKeyDown}>
        {SORTS.map((sort) => {
          const label = t(sort.label);
          const selected = sort.key === preference.key;
          return <div key={sort.key} className="commander-tab-menu-row" data-sort-row="">
            <button type="button" role="menuitemradio" data-sort-column="name" aria-checked={selected} className="commander-tab-menu-item" onClick={() => pick(sort.key, sort.direction)}>
              <span className="commander-tab-menu-check" aria-hidden="true">{selected ? "✓" : ""}</span>{label}
            </button>
            {(["asc", "desc"] as const).map((direction) => (
              <button key={direction} type="button" role="menuitemradio" data-sort-column={direction} className="commander-tab-menu-direction" aria-checked={selected && preference.direction === direction} aria-label={t("commanderTab.sort.toward", { label, direction: t(direction === "asc" ? "commanderTab.sort.asc" : "commanderTab.sort.desc") })} title={t(direction === "asc" ? "commanderTab.sort.asc" : "commanderTab.sort.desc")} onClick={() => pick(sort.key, direction)}>
                <svg viewBox="0 0 16 16" aria-hidden="true">{direction === "asc"
                  ? <path d="M8 13V3M8 3 4.5 6.5M8 3l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  : <path d="M8 3v10M8 13l-3.5-3.5M8 13l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}</svg>
              </button>
            ))}
          </div>;
        })}
        <span className="commander-tab-menu-rule" role="separator" />
        <button type="button" role="menuitemcheckbox" aria-checked={preference.answerFirst} className="commander-tab-menu-item" onClick={() => setSort({ ...preference, answerFirst: !preference.answerFirst })}>
          <span className="commander-tab-menu-check" aria-hidden="true">{preference.answerFirst ? "✓" : ""}</span>{t("commanderTab.sort.answerFirst")}
        </button>
        <button type="button" role="menuitemcheckbox" aria-checked={preference.grouped} className="commander-tab-menu-item" onClick={() => setSort({ ...preference, grouped: !preference.grouped })}>
          <span className="commander-tab-menu-check" aria-hidden="true">{preference.grouped ? "✓" : ""}</span>{t("commanderTab.sort.grouped")}
        </button>
      </div> : null}
    </span>
  );
}
