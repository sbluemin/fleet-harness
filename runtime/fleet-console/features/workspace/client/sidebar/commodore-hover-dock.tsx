import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { openCommodoreNewSession } from "../conversation/new-session-entry.js";
import { SortMenu } from "../commander-tab/commander-list.js";
import { moveCommanderPlacement, useCommanderPlacement } from "../commander-tab/commander-placement.js";
import { useSortPreference } from "../commander-tab/commander-sort.js";
import { setCommanderKeepExpanded, useCommanderKeepExpanded } from "./commander-expansion.js";
import "./commodore-hover-dock.css";

/**
 * 사령관 머리의 호버 독 — 머리에 호버하거나 초점이 오면 오른쪽 끝에 ⋯ 글리프가 나오고, 글리프에 호버하거나 누르면
 * 가로 리스트박스가 왼쪽으로 펼쳐져 새 목표 · 정렬 · 목록 위치 · 펼침 유지를 고른다.
 * 새 목표만 이 사령관의 것이고, 나머지는 모든 사령관에 적용되는 글로벌 설정이다.
 */
export function CommodoreHoverDock({ commodoreId, name }: { readonly commodoreId: string; readonly name: string }) {
  const t = useT();
  const placement = useCommanderPlacement();
  const keepExpanded = useCommanderKeepExpanded();
  const sort = useSortPreference();
  const [open, setOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const dockRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // 글리프를 눌러 연 독은 마우스가 벗어나도 남는다 — 호버로 열린 독만 마우스를 따라 닫힌다.
  const pinnedRef = useRef(false);
  const shut = () => { pinnedRef.current = false; setOpen(false); };
  const toolbarId = useId();
  // ⋯를 키보드(Enter·Space)로 열면 첫 도구로 초점이 간다. 이미 열려 있던 독에서도 일어나도록 횟수로 센다.
  const [focusFirst, setFocusFirst] = useState(0);
  useEffect(() => {
    if (focusFirst === 0) return;
    dockRef.current?.querySelector<HTMLElement>(".commodore-dock-strip button")?.focus({ preventScroll: true });
  }, [focusFirst]);

  // 바깥을 누르면 닫는다. 정렬 메뉴는 독 안에 그려지므로 같은 안쪽으로 본다.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      // 정렬 메뉴는 문서 최상위에 그려지므로(독 밖 DOM) 따로 안쪽으로 본다.
      if (event.target instanceof Element && (dockRef.current?.contains(event.target) || event.target.closest(".commander-tab-menu"))) return;
      pinnedRef.current = false;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  const close = (returnFocus: boolean) => {
    shut();
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const onMouseLeave = () => {
    // 정렬 메뉴가 열려 있거나 키보드 초점이 독 안에 있으면 마우스가 벗어나도 닫지 않는다.
    if (sortOpen || pinnedRef.current) return;
    if (dockRef.current?.querySelector(":focus-visible")) return;
    setOpen(false);
  };

  // 키보드로 초점이 독과 ⋯ 밖으로 나가면 독이 닫힌다 — 열린 독이 아래 목표 행 위에 남지 않게. 마우스가 독 위에 있거나
  // 정렬 메뉴(독 밖 DOM)로 가는 초점, 창 밖으로 나가는 초점(relatedTarget 없음)은 건드리지 않는다.
  const onBlur = (event: FocusEvent<HTMLSpanElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Element) || dockRef.current?.contains(next) || next.closest(".commander-tab-menu")) return;
    if (sortOpen || dockRef.current?.matches(":hover")) return;
    shut();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key === "Escape" && open && !sortOpen) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const items = Array.from(dockRef.current?.querySelectorAll<HTMLElement>(".commodore-dock-strip button") ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0 || sortOpen) return;
    event.preventDefault();
    items[(index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length]?.focus({ preventScroll: true });
  };

  const newObjective = () => { close(false); openCommodoreNewSession(commodoreId); };
  const keepHint = t("sidebar.commodoreDock.keepExpandedHint");
  // 정렬 메뉴가 열려 있는 동안은 독도 열린 채다 — 닫히면 메뉴가 든 줄이 inert가 되어 항목이 눌리지 않는다.
  const shown = open || sortOpen;

  return (
    // 머리의 드래그·활성 Objective 해제에서 빠진다 — 이 단추들은 목록·설정만 다룬다.
    <span ref={dockRef} className="commodore-dock" data-open={shown ? "true" : "false"} data-keep-objective-active="" onMouseLeave={onMouseLeave} onKeyDown={onKeyDown} onBlur={onBlur}>
      {/* ⋯가 도구보다 DOM에서 앞선다 — Tab이 ⋯ → 도구 → 다음 요소로 가고 Shift+Tab이 도구에서 ⋯로 돌아온다. 화면에서는 CSS가 ⋯를 오른쪽 끝에 둔다. */}
      <button
        ref={triggerRef}
        type="button"
        className="commodore-dock-trigger"
        aria-expanded={shown}
        aria-controls={toolbarId}
        aria-label={t("sidebar.commodoreDock.open", { theater: name })}
        title={t("sidebar.commodoreDock.open", { theater: name })}
        onMouseEnter={() => setOpen(true)}
        onClick={(event) => {
          if (open && pinnedRef.current) { shut(); return; }
          pinnedRef.current = true;
          setOpen(true);
          // detail 0은 키보드(Enter·Space)로 눌렀다는 뜻이다.
          if (event.detail === 0) setFocusFirst((count) => count + 1);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1" fill="currentColor" /><circle cx="8" cy="8" r="1" fill="currentColor" /><circle cx="12.5" cy="8" r="1" fill="currentColor" /></svg>
      </button>
      <span id={toolbarId} className="commodore-dock-strip" role="toolbar" aria-orientation="horizontal" aria-label={t("sidebar.commodoreDock.group", { theater: name })} inert={!shown}>
        <button type="button" className="commodore-dock-button" aria-label={t("sidebar.commodore.newSession")} title={t("sidebar.commodore.newSession")} onClick={newObjective}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <span className="commodore-dock-rule" role="separator" aria-orientation="vertical" />
        <SortMenu glyph preference={sort} onOpenChange={setSortOpen} />
        <button type="button" className="commodore-dock-button" aria-pressed={placement === "left"} aria-label={t("commanderRail.placeSidebar")} title={t("commanderRail.placeSidebar")} onClick={() => moveCommanderPlacement(commodoreId, "left")}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 2.4h3.1v11.2H2.2z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M7.6 4.6h6M7.6 8h6M7.6 11.4h4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button type="button" className="commodore-dock-button" aria-pressed={placement === "right"} aria-label={t("commanderRail.placeRight")} title={t("commanderRail.placeRight")} onClick={() => moveCommanderPlacement(commodoreId, "right")}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.7 2.4h3.1v11.2h-3.1z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M2.4 4.6h6M2.4 8h6M2.4 11.4h4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
        <button type="button" className="commodore-dock-button" aria-pressed={keepExpanded} aria-label={t("sidebar.commodoreDock.keepExpanded")} title={`${t("sidebar.commodoreDock.keepExpanded")} · ${keepHint}`} onClick={() => setCommanderKeepExpanded(!keepExpanded)}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M3 8h10M3 12h6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><path d="M11.5 10.5 13 12l2-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </span>
    </span>
  );
}
