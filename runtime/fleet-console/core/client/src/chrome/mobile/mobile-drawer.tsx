import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type PointerEvent, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { resolveOperationActivity, resolveOperationMarkVisual, type OperationMarkVisual } from "../../../../../features/execution/client/operation-activity.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../../../features/execution/client/operation-marks.js";
import { openConsoleSwitcher, useMobileAppearance } from "../../integration/mobile-appearance-store.js";
import { statusGlyphClassName } from "@fleet-console/sdk/components/status-glyph";
import { resolveLocalizedText } from "@fleet-console/sdk/i18n/translate";
import type { RailEntryDestinationTrailingValue } from "@fleet-console/sdk/rail";

import { useConsoleLocale, useT } from "../../i18n/index.js";
import { openQuickLaunch } from "../../integration/store.js";
import type { ConsoleState, OperationNode } from "../../integration/types.js";
import { useHostCapabilities } from "../../integration/use-host-capabilities.js";
import { useRailEntries } from "../pane/pane-registry.js";
import { mobilePluginRows, useMobileDestinationBindings, useMobileDestinationTrailing, type MobileAttentionRow } from "./mobile-destinations.js";
import { AttentionReason } from "./mobile-attention-reason.js";
import { pushBackLayer } from "./mobile-back.js";
import { MobileIcon, type MobileIconName } from "./mobile-icons.js";
import { openedByKeyboard } from "./mobile-input-modality.js";
import { MobileMonogram } from "./mobile-monogram.js";
import { pushOverlayHistory, runAfterOverlayRelease } from "./mobile-overlay-history.js";
import { unwindDetailsThen } from "./mobile-unwind.js";
import { getMobileSheetStack, pushMobileSheet, setMobileDestination, setMobileDrawerOpen, useMobileDestination, useMobileDrawerOpen } from "./mobile-store.js";

const EDGE_ZONE = 22;
/** 옛 가장자리 띠가 섰던 층 — 셸 판 안에서 이보다 위에 뜬 겹침에서 시작한 누름은 가장자리 끌기가 아니다. */
const EDGE_LAYER = 39;
const DRAG_ARM = 12;
const OPEN_DISTANCE = 120;
const CLOSE_DISTANCE = 90;
const ENTER_MS = 300;
const LEAVE_MS = 250;
const MAX_ATTENTION_ROWS = 3;

/**
 * 드로어 — 하단 탭 다섯 개를 대신하는 목적지 하나. 위에서 아래로: 워드마크·찾기, Theater 전환 줄, 목적지,
 * 구분선, 확인 필요(최대 3행), 최근, 그리고 바닥에 붙는 Console 아바타와 「새 작업」 알약.
 * 화면 왼쪽 가장자리를 오른쪽으로 끌면 손가락을 따라 열리고, 열린 판을 왼쪽으로 끌면 닫힌다.
 */
export function MobileDrawer({ state, attention, activeOperationId, onOpenOperation }: {
  readonly state: ConsoleState;
  readonly attention: readonly MobileAttentionRow[];
  readonly activeOperationId: string | null;
  readonly onOpenOperation: (operationId: string) => void;
}) {
  const t = useT();
  const open = useMobileDrawerOpen();
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const [dragX, setDragX] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const historyIdRef = useRef<number | null>(null);
  const gestureRef = useRef<{ pointerId: number; startX: number; startY: number; mode: "edge" | "panel"; armed: boolean; width: number } | null>(null);

  // 열림/닫힘: 열면 먼저 마운트하고 다음 프레임에 `is-open`을 붙여 전이를 태운다. 닫으면 전이가 끝난 뒤 내린다.
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = window.requestAnimationFrame(() => setShown(true));
      if (historyIdRef.current === null) historyIdRef.current = pushOverlayHistory(() => { historyIdRef.current = null; setMobileDrawerOpen(false); });
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // 키보드로 열었을 때만 첫 목적지로 포커스를 옮긴다(PR-0c) — 터치로 연 드로어에 흰 고리가 남지 않게.
      if (openedByKeyboard()) window.requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>(".mobile-drawer-dest")?.focus({ preventScroll: true }));
      return () => { window.cancelAnimationFrame(frame); opener?.focus?.({ preventScroll: true }); };
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // 시트가 위에 있으면 Esc는 시트가 받는다 — 겹침은 위에서부터 하나씩 닫는다.
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && getMobileSheetStack().length === 0) { event.preventDefault(); close(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /** 닫고, 이동이 있으면 history 항목이 걷힌 뒤에 한다 — 걷히기 전에 이동하면 새 항목이 걷히는 쪽에 낀다. */
  const close = useCallback((then?: () => void) => {
    const id = historyIdRef.current;
    historyIdRef.current = null;
    setMobileDrawerOpen(false);
    runAfterOverlayRelease(id, () => then?.());
  }, []);

  // 열린 드로어는 하드웨어 뒤로가 닫는 겹침이다(메뉴·시트가 위에 있으면 그것이 먼저).
  useEffect(() => (open ? pushBackLayer(() => close(), "drawer") : undefined), [open, close]);

  // 가장자리 끌기로 열기 — 드로어가 닫혀 있을 때 왼쪽 EDGE_ZONE에서 시작한다. 그 자리에 띠를 깔지 않고 창에서 듣는다:
  // 띠가 hit를 가져가면 가장자리에 걸친 버튼의 누를 자리가 잘린다. 누름·click은 아래 요소가 그대로 받는다.
  const mountedRef = useRef(mounted);
  mountedRef.current = mounted;
  useEffect(() => {
    if (open) return;
    let suppressClickUntil = 0;
    const onDown = (event: globalThis.PointerEvent) => {
      if (mountedRef.current || gestureRef.current || !event.isPrimary || event.button !== 0) return;
      if (!startsOnEdge(event)) return;
      gestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, mode: "edge", armed: false, width: drawerWidth() };
    };
    const onMove = (event: globalThis.PointerEvent) => { if (gestureRef.current?.mode === "edge") onGestureMove(event); };
    const onUp = (event: globalThis.PointerEvent) => {
      const gesture = gestureRef.current;
      if (gesture?.mode !== "edge" || gesture.pointerId !== event.pointerId) return;
      // 끌기를 마친 마우스는 떼자마자 click을 낸다 — 그 click은 버린다. 터치는 끌면 click이 나지 않는다.
      if (gesture.armed) suppressClickUntil = event.timeStamp + 100;
      onGestureUp(event);
    };
    const onClick = (event: MouseEvent) => {
      if (event.timeStamp > suppressClickUntil) return;
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopPropagation();
    };
    // 가로로 끄는 동안 브라우저 팬을 막는다 — 아래 요소의 touch-action이 가로 팬을 허락하면 팬이 시작되며
    // pointercancel로 제스처가 끊긴다(옛 띠의 touch-action: pan-y 몫). 세로로 더 움직이면 막지 않아 스크롤이 된다.
    const onTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      const touch = event.touches[0];
      if (gesture?.mode !== "edge" || !event.cancelable || !touch) return;
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;
      if (gesture.armed || (dx > 0 && dx >= Math.abs(dy))) event.preventDefault();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("click", onClick, true);
    // 비수동(passive: false)이어야 첫 touchmove를 취소할 수 있다 — 끄는 중이 아니면 바로 돌아간다.
    window.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("touchmove", onTouchMove, true);
      if (gestureRef.current?.mode === "edge") { gestureRef.current = null; setDragX(null); }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const onGestureMove = (event: PointerEvent<HTMLElement> | globalThis.PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.armed) {
      // 세로로 더 움직이면 스크롤이다 — 잡지 않는다.
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 6) { gestureRef.current = null; return; }
      if (gesture.mode === "edge" ? dx < DRAG_ARM : dx > -6) return;
      gesture.armed = true;
      if (gesture.mode === "edge") { setMounted(true); setShown(true); }
    }
    setDragX(gesture.mode === "edge" ? Math.min(0, -gesture.width + dx) : Math.min(0, dx));
  };
  const onGestureUp = (event: PointerEvent<HTMLElement> | globalThis.PointerEvent) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (!gesture.armed) { if (gesture.mode === "edge") setDragX(null); return; }
    const dx = event.clientX - gesture.startX;
    setDragX(null);
    if (gesture.mode === "edge") {
      // pointercancel은 손가락을 뗀 것이 아니다 — 끌던 판을 도로 닫는다.
      if (event.type !== "pointercancel" && dx > OPEN_DISTANCE) setMobileDrawerOpen(true);
      else { setShown(false); window.setTimeout(() => setMounted(false), LEAVE_MS); }
    } else if (dx < -CLOSE_DISTANCE) close();
  };
  // 판 위 끌기는 판이 듣는다 — 가장자리 끌기는 위의 창 리스너가 맡는다.
  const onPanelMove = (event: PointerEvent<HTMLElement>) => { if (gestureRef.current?.mode === "panel") onGestureMove(event); };
  const onPanelUp = (event: PointerEvent<HTMLElement>) => { if (gestureRef.current?.mode === "panel") onGestureUp(event); };

  if (!mounted && !open) return null;
  const dragging = dragX !== null;
  const progress = dragging ? 1 + dragX / Math.max(1, drawerWidth()) : shown ? 1 : 0;
  return (
    <>
      <div className="mobile-drawer-scrim" style={{ opacity: progress }} data-dragging={dragging || undefined} onClick={() => close()} />
      <nav
        ref={panelRef}
        className={`mobile-drawer${shown ? " is-open" : ""}${dragging ? " is-dragging" : ""}`}
        style={dragging ? { transform: `translateX(${dragX}px)` } : undefined}
        aria-label={t("mobile.drawer.aria")}
        onPointerDown={(event) => { gestureRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, mode: "panel", armed: false, width: drawerWidth() }; }}
        onPointerMove={onPanelMove}
        onPointerUp={onPanelUp}
        onPointerCancel={onPanelUp}
      >
        <DrawerBody state={state} attention={attention} activeOperationId={activeOperationId} close={close} onOpenOperation={onOpenOperation} />
      </nav>
    </>
  );
}

/**
 * 가장자리 끌기를 시작해도 되는 누름인가 — 셸 판 왼쪽 EDGE_ZONE 안이고, 옛 띠(z-index 39)보다 위에 뜬 겹침
 * (시트·알림·선택 팝업·토스트)이 아닌 곳. 판 밖(본문 포털 등)에서 시작한 누름은 잡지 않는다.
 */
function startsOnEdge(event: globalThis.PointerEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const frame = target?.closest<HTMLElement>(".mobile-frame");
  if (!target || !frame || event.clientX - frame.getBoundingClientRect().left >= EDGE_ZONE) return false;
  let layer: Element = target;
  while (layer.parentElement && layer.parentElement !== frame) layer = layer.parentElement;
  const z = Number.parseInt(window.getComputedStyle(layer).zIndex, 10);
  return !(z > EDGE_LAYER);
}

function drawerWidth(): number {
  return Math.max(1, Math.min(window.innerWidth, document.querySelector<HTMLElement>(".mobile-frame")?.clientWidth ?? window.innerWidth) - 56);
}

function DrawerBody({ state, attention, activeOperationId, close, onOpenOperation }: {
  readonly state: ConsoleState;
  readonly attention: readonly MobileAttentionRow[];
  readonly activeOperationId: string | null;
  readonly close: (then?: () => void) => void;
  readonly onOpenOperation: (operationId: string) => void;
}) {
  const t = useT();
  const locale = useConsoleLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const capabilities = useHostCapabilities();
  const bindings = useRailEntries();
  const shownDestinations = useMobileDestinationBindings(bindings, state.activeTheaterId);
  const trailing = useMobileDestinationTrailing(bindings, state.activeTheaterId);
  const destination = useMobileDestination();
  const idleArrivalIds = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  const appearance = useMobileAppearance();
  const consoleName = appearance.console?.label ?? window.location.hostname;
  const theater = state.theaters.find((item) => item.id === state.activeTheaterId) ?? null;
  const path = location.pathname.replace(/\/+$/, "");

  const operations = state.operations.filter((operation) => operation.theaterId === state.activeTheaterId);
  const awaitingCount = operations.filter((operation) => resolveOperationActivity(operation, state.operationRuntime) === "awaiting").length;
  const attentionOperationIds = new Set(attention.flatMap((row) => row.kind === "operation" ? [row.operation.id] : []));
  const recent = operations.filter((operation) => !attentionOperationIds.has(operation.id));

  // 루트 이동 전에 쌓아 둔 상세(플러그인 depth·설정 섹션) 항목을 걷는다 — 남겨 두면 새 루트 아래에서 뒤로가 헛돈다.
  const go = (action: () => void) => close(() => unwindDetailsThen(location.pathname, location.search, action));
  // 루트끼리의 이동은 history를 늘리지 않는다(S-51) — 라우트는 replace.
  const toOperations = () => { if (path !== "/operations") navigate("/operations", { replace: true }); };

  const destinations: DestinationRow[] = [];
  for (const binding of shownDestinations) {
    destinations.push({
      key: binding.entry.id,
      icon: { node: renderEntryIcon(binding.entry.mobile?.icon ?? binding.entry.icon) },
      label: resolveLocalizedText(binding.entry.mobile?.destination?.label ?? binding.entry.title, locale),
      count: attention.filter((row) => row.kind === "plugin" && row.entryId === binding.entry.id).length,
      trailing: trailing.get(binding.entry.id) ?? null,
      current: path === "/operations" && destination.kind === "plugin" && destination.entryId === binding.entry.id,
      run: () => {
        setMobileDestination({ kind: "plugin", entryId: binding.entry.id });
        // 페인 없이 확대 표면만 여는 엔트리(Shell)는 목적지 화면이 그 표면을 스스로 열어 본문으로 삼는다.
        toOperations();
      },
    });
  }
  destinations.push({ key: "archive", icon: { name: "archive" }, label: t("mobile.drawer.archive"), count: 0, current: path === "/operations" && destination.kind === "archive", run: () => { setMobileDestination({ kind: "archive" }); toOperations(); } });
  if (mobilePluginRows(bindings).length > 0) {
    destinations.push({ key: "plugins", icon: { name: "grid" }, label: t("mobile.drawer.plugins"), count: 0, current: path === "/operations" && destination.kind === "plugins", run: () => { setMobileDestination({ kind: "plugins" }); toOperations(); } });
  }
  destinations.push({ key: "settings", icon: { name: "gear" }, label: t("mobile.drawer.settings"), count: 0, current: path === "/settings", run: () => navigate("/settings", { replace: true }) });

  return (
    <>
      <div className="mobile-drawer-head">
        <span className="mobile-wordmark">Fleet</span>
        <button type="button" className="mobile-bar-button" onClick={() => go(() => { setMobileDestination({ kind: "search" }); toOperations(); })} aria-label={t("mobile.drawer.search")}><MobileIcon name="search" /></button>
      </div>
      <button type="button" className="mobile-theater-switch" onClick={() => { setMobileDrawerOpen(false); pushMobileSheet({ kind: "theater", fromDrawer: true }); }} disabled={state.theaters.length === 0}>
        {theater ? <MobileMonogram label={theater.label} toneKey={theater.id} /> : <span className="mobile-monogram is-empty" aria-hidden="true"><MobileIcon name="theater" size={16} /></span>}
        <span className="mobile-theater-switch-copy">
          <strong>{theater?.label ?? t("mobile.drawer.noTheater")}</strong>
          {theater ? (
            <small>
              {t("mobile.drawer.opCount", { count: operations.length })}
              {awaitingCount > 0 ? <> · <span className="mobile-awaiting-chip"><span className={statusGlyphClassName("awaiting")} aria-hidden="true" /> {t("mobile.drawer.awaitingCount", { count: awaitingCount })}</span></> : null}
            </small>
          ) : null}
        </span>
        <MobileIcon name="down" size={18} className="mobile-theater-switch-caret" />
      </button>
      <div className="mobile-drawer-scroll">
        {destinations.map((row) => (
          <button type="button" key={row.key} className={`mobile-drawer-dest${row.current ? " is-current" : ""}`} aria-current={row.current ? "page" : undefined} onClick={() => go(row.run)}>
            <span className="mobile-drawer-dest-icon" aria-hidden="true">{"name" in row.icon ? <MobileIcon name={row.icon.name} /> : row.icon.node}</span>
            <span>{row.label}</span>
            {row.trailing ? (
              <span className={`mobile-drawer-cst${row.trailing.tone ? ` is-${row.trailing.tone}` : ""}`}>
                {row.trailing.glyph ? <span className={statusGlyphClassName(row.trailing.glyph)} aria-hidden="true" /> : null}
                {row.trailing.text}
              </span>
            ) : row.count > 0 ? <span className="mobile-drawer-count">{row.count}</span> : null}
          </button>
        ))}
        <div className="mobile-drawer-rule" />
        {attention.length > 0 ? (
          <>
            <button type="button" className="mobile-drawer-section is-button" onClick={() => go(() => { setMobileDestination({ kind: "attention" }); toOperations(); })}>
              <span>{t("mobile.drawer.attention")}</span><small>{attention.length} ›</small>
            </button>
            {attention.slice(0, MAX_ATTENTION_ROWS).map((row) => row.kind === "operation" ? (
              <DrawerRow key={row.key} glyph="awaiting" title={row.operation.title} reason={<AttentionReason row={row} />} tall current={activeOperationId === row.operation.id && path === "/operations" && destination.kind === "home"} onPress={() => go(() => onOpenOperation(row.operation.id))} />
            ) : (
              <DrawerRow key={row.key} glyph="review" title={row.item.title} reason={<AttentionReason row={row} />} tall onPress={() => go(() => { setMobileDestination({ kind: "plugin", entryId: row.entryId }); toOperations(); row.item.open(); })} />
            ))}
          </>
        ) : null}
        <div className="mobile-drawer-section"><span>{t("mobile.drawer.recent")}</span></div>
        {recent.length === 0 ? <p className="mobile-drawer-empty">{t("mobile.drawer.recentEmpty")}</p> : recent.map((operation) => (
          <DrawerRow
            key={operation.id}
            glyph={markOf(operation, state, idleArrivalIds)}
            title={operation.title}
            current={activeOperationId === operation.id && path === "/operations" && destination.kind === "home"}
            onPress={() => go(() => onOpenOperation(operation.id))}
          />
        ))}
      </div>
      <div className="mobile-drawer-foot">
        <button type="button" className="mobile-avatar" aria-label={t("mobile.drawer.consoleSwitch", { name: consoleName })} onClick={() => { if (!openConsoleSwitcher()) pushMobileSheet({ kind: "console" }); }}>
          <MobileMonogram label={consoleName} toneKey={consoleName} tone={appearance.console?.tone ?? null} letters={appearance.console?.monogram ?? consoleName.charAt(0).toUpperCase()} round size={44} />
          {state.connection !== "live" ? <span className="mobile-avatar-dot" data-state={state.connection === "offline" ? "failed" : "reconnecting"} aria-hidden="true" /> : null}
        </button>
        <button type="button" className="mobile-pill" onClick={() => go(openQuickLaunch)}><MobileIcon name="plus" size={18} />{t("mobile.drawer.newOperation")}</button>
      </div>
    </>
  );
}

interface DestinationRow {
  readonly key: string;
  /** 코어 목적지는 아이콘 이름, 플러그인 목적지는 엔트리가 준 노드. */
  readonly icon: { readonly name: MobileIconName } | { readonly node: ReactNode };
  readonly label: string;
  readonly count: number;
  /** 플러그인이 올린 오른쪽 칸(상태 낱말) — 있으면 건수 자리를 이것이 쓴다. */
  readonly trailing?: RailEntryDestinationTrailingValue | null;
  readonly current: boolean;
  readonly run: () => void;
}

function markOf(operation: OperationNode, state: ConsoleState, idleArrivalIds: ReadonlySet<string>): OperationMarkVisual {
  return resolveOperationMarkVisual({
    activity: resolveOperationActivity(operation, state.operationRuntime),
    operationId: operation.id,
    idleArrivalIds,
  });
}

function DrawerRow({ glyph, title, reason, tall = false, current = false, onPress }: {
  readonly glyph: OperationMarkVisual | "review";
  readonly title: string;
  readonly reason?: ReactNode;
  readonly tall?: boolean;
  readonly current?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <button type="button" className={`mobile-drawer-row${tall ? " is-tall" : ""}${current ? " is-current" : ""}`} aria-current={current ? "true" : undefined} onClick={onPress}>
      <span className="mobile-drawer-row-glyph"><span className={statusGlyphClassName(glyph)} aria-hidden="true" /></span>
      <span className="mobile-drawer-row-copy">
        <span className="mobile-drawer-row-title">{title}</span>
        {reason ? <small>{reason}</small> : null}
      </span>
    </button>
  );
}


function renderEntryIcon(icon: ReactNode | (() => ReactNode)): ReactNode {
  return typeof icon === "function" ? icon() : icon;
}
