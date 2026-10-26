import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { useConsoleState } from "../../../../core/client/src/hooks/use-store.js";
import { closeNewSession } from "../../../../core/client/src/integration/store.js";
import { commanderObjectiveId } from "../objective-clusters.js";
import { SideBarClusterRow } from "../sidebar/side-bar-cluster-row.js";
import { openCommanderSplit, useCommanderSplit } from "../conversation/commander-split-store.js";
import { openCommodoreNewSession } from "../conversation/new-session-entry.js";
import { CommodoreRecentActions } from "../../../commodore/client/commodore-trail.js";
import { revealCommodoreTurn } from "../../../commodore/client/commodore-conversation.js";
import { useConsoleLocale } from "../../../../core/client/src/i18n/index.js";
import { SORTS, setSort, type SortPreference } from "./commander-sort.js";
import { useCommanderRows } from "./commander-rows.js";
import "./commander-list.css";

/*
 * 사령관 오른쪽 「지휘관」 탭 — 시작 전·진행 중·완료 목표를 같은 두 줄 문법으로 보인다. 정렬과 그룹 묶기 선호는 전역이다.
 * 목표를 고르면 옆 칸에 시작 화면 또는 그룹 대화가 서고, 선택한 행 아래에 최근 사령관 행위가 펼쳐진다.
 */

export function CommodoreCommanderList({ commodoreId }: { readonly commodoreId: string }) {
  const t = useT();
  const state = useConsoleState();
  const split = useCommanderSplit();
  const language = useConsoleLocale();
  const shownId = split.open && state.newSession?.placement !== "commander-split" ? split.picked[commodoreId] ?? null : null;
  const { sorted, sections, preference } = useCommanderRows(commodoreId, shownId);

  return (
    <section className="commander-tab" aria-label={t("commanderTab.aria")}>
      <div className="commander-tab-bar">
        <span className="commander-tab-count">{t("commanderTab.count", { count: sorted.length })}</span>
        <SortMenu preference={preference} />
        <button
          type="button"
          className="commander-tab-direction"
          aria-label={t(preference.direction === "asc" ? "commanderTab.sort.ascending" : "commanderTab.sort.descending")}
          title={t(preference.direction === "asc" ? "commanderTab.sort.ascending" : "commanderTab.sort.descending")}
          onClick={() => setSort({ ...preference, direction: preference.direction === "asc" ? "desc" : "asc" })}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {preference.direction === "asc"
              ? <path d="M8 13V3M8 3 4.5 6.5M8 3l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              : <path d="M8 3v10M8 13l-3.5-3.5M8 13l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />}
          </svg>
        </button>
        <button type="button" className="commander-tab-direction" aria-label={t("sidebar.commodore.newSession")} title={t("sidebar.commodore.newSession")} onClick={() => openCommodoreNewSession(commodoreId)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>
      {sorted.length === 0 ? <p className="commander-tab-empty">{t("commanderTab.empty")}</p> : (
        <div className="commander-tab-groups">
          {sections.map((group) => <section key={group.id}>
            {group.title !== null ? <h3 className="commander-tab-group-title">{group.title}<span>{group.rows.length}</span></h3> : null}
            <ol className="commander-tab-list side-bar-group-chips">
              {group.rows.map((item) => {
                const objectiveId = commanderObjectiveId(item.layout.cluster);
                const selected = objectiveId !== null && shownId === objectiveId;
                return <Fragment key={item.layout.cluster.id}>
                  <SideBarClusterRow item={item} selected={selected}
                    onFocus={(id) => { closeNewSession(); openCommanderSplit(commodoreId, id); }} />
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

function SortMenu({ preference }: { readonly preference: SortPreference }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const current = SORTS.find((sort) => sort.key === preference.key) ?? SORTS[0]!;
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && (menuRef.current?.contains(event.target) || buttonRef.current?.contains(event.target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  return (
    <span className="commander-tab-sort">
      <button
        ref={buttonRef}
        type="button"
        className="commander-tab-sort-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {t("commanderTab.sort.button", { label: t(current.label) })}
      </button>
      {open ? (
        <div ref={menuRef} id={menuId} className="commander-tab-menu" role="menu" aria-label={t("commanderTab.sort.menu")} onKeyDown={onMenuKeyDown}>
          {SORTS.map((sort) => (
            <button
              key={sort.key}
              type="button"
              role="menuitemradio"
              aria-checked={sort.key === preference.key}
              className="commander-tab-menu-item"
              onClick={() => { setSort({ ...preference, key: sort.key, direction: sort.direction }); close(); }}
            >
              <span className="commander-tab-menu-check" aria-hidden="true">{sort.key === preference.key ? "✓" : ""}</span>
              {t(sort.label)}
            </button>
          ))}
          <span className="commander-tab-menu-rule" role="separator" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={preference.answerFirst}
            className="commander-tab-menu-item"
            onClick={() => setSort({ ...preference, answerFirst: !preference.answerFirst })}
          >
            <span className="commander-tab-menu-check" aria-hidden="true">{preference.answerFirst ? "✓" : ""}</span>
            {t("commanderTab.sort.answerFirst")}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={preference.grouped} className="commander-tab-menu-item" onClick={() => setSort({ ...preference, grouped: !preference.grouped })}>
            <span className="commander-tab-menu-check" aria-hidden="true">{preference.grouped ? "✓" : ""}</span>{t("commanderTab.sort.grouped")}
          </button>
        </div>
      ) : null}
    </span>
  );
}
