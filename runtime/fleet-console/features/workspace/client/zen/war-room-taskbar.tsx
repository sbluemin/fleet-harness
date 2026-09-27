import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { useT } from "../../../../core/client/src/i18n/index.js";
import type { OperationNode } from "../../../../core/client/src/integration/types.js";
import { getIdleArrivalIds, subscribeIdleArrival } from "../../../execution/client/operation-marks.js";
import { resolveOperationActivity, resolveOperationMarkVisual } from "../../../execution/client/operation-activity.js";
import { OperationNameMark } from "../../../execution/client/components/operation-name-mark.js";
import { OperationStatusIcon } from "../../../execution/client/components/operation-status-icon.js";
import { CanvasModeSwitch, WarRoomModeTools } from "../canvas/canvas-mode-switch.js";
import { getTheaterCanvasSnapshot, getTheaterMinimizedIds, setTheaterOperationMinimized, useCanvasState } from "../canvas/canvas-store.js";
import { operationAccentFromNode, resolveAccentColor } from "../canvas/operation-accent.js";
import { getTriageEnteredAt, getTriageSnapshot, pickTriageOperation, resolveTriageCounts, resolveTriageQueue, subscribeTriage, useTriageStage } from "../canvas/triage-store.js";
import { highlightTriageDeckCard } from "../canvas/triage-watch-deck.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import { useContextMenuKeyboard } from "../sidebar/context-menu-keyboard.js";
import type { ZenTaskbarProps } from "./zen-taskbar.js";
import "./war-room-taskbar.css";

type Shelf = "minimized" | "ended" | "shelves" | "overflow";
interface Menu { readonly kind: Shelf; readonly anchor: DOMRect }

/** 전역 덱의 대응 대기열. 공용 도구모음은 크롬의 기존 트레이에 그대로 있고 이 표면은 복제하지 않는다. */
export function WarRoomTaskbar({ triageGlowHost, theaters, operations, operationRuntime, onResume, onOpenOperationMenu }: ZenTaskbarProps) {
  const t = useT();
  useSyncExternalStore(subscribeTriage, getTriageSnapshot, getTriageSnapshot);
  const arrivals = useSyncExternalStore(subscribeIdleArrival, getIdleArrivalIds, getIdleArrivalIds);
  useCanvasState();
  const stagedId = useTriageStage();
  const minimizedIds = new Set(getTheaterMinimizedIds(theaters.map((theater) => theater.id)));
  const ended = operations.filter((operation) => resolveOperationActivity(operation, operationRuntime) === "ended");
  const minimized = operations.filter((operation) => minimizedIds.has(operation.id) && resolveOperationActivity(operation, operationRuntime) !== "ended");
  const live = operations.filter((operation) => !minimizedIds.has(operation.id) && resolveOperationActivity(operation, operationRuntime) !== "ended");
  const counts = resolveTriageCounts(live, operationRuntime);
  const queue = resolveTriageQueue(operations, operationRuntime).map((entry) => entry.operation);
  const nextId = queue.find((operation) => operation.id !== stagedId)?.id ?? null;
  const staged = operations.find((operation) => operation.id === stagedId);
  const entries = staged && !queue.some((operation) => operation.id === stagedId) ? [staged, ...queue] : queue;
  const pinned = new Set([nextId, stagedId].filter((id): id is string => id !== null));
  const rowRef = useRef<HTMLDivElement>(null);
  const queueRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  // 막대가 소유한 실제 큐 구간을 명시적 캔버스 포털로 넘긴다. React 상태를 추가로 돌리지 않고
  // 같은 레이아웃 단계에서 맞춰, 넘침 접힘·번역·리사이즈에도 주의선과 배경의 빛이 갈라지지 않는다.
  const measureGlow = useCallback(() => {
    if (!triageGlowHost || !queueRef.current || !glowRef.current) return;
    const queue = queueRef.current.getBoundingClientRect();
    const host = triageGlowHost.getBoundingClientRect();
    glowRef.current.style.setProperty("--wr-queue-left", `${queue.left - host.left - 10}px`);
    glowRef.current.style.setProperty("--wr-queue-width", `${queue.width + 20}px`);
  }, [triageGlowHost]);
  useLayoutEffect(measureGlow);
  useLayoutEffect(() => {
    if (!triageGlowHost || !rowRef.current || !queueRef.current) return;
    const observer = new ResizeObserver(measureGlow);
    observer.observe(triageGlowHost);
    observer.observe(rowRef.current);
    observer.observe(queueRef.current);
    return () => observer.disconnect();
  }, [triageGlowHost, measureGlow]);
  const [fit, setFit] = useState({ step: 0, count: entries.length });
  const [, remeasureChips] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const [entering] = useState(() => (getTriageEnteredAt() ?? 0) > 0 || document.documentElement.dataset.zenFlight === "true");
  const closeMenu = useCallback(() => { setMenu(null); highlightTriageDeckCard(null); }, []);
  useContextMenuKeyboard({ open: menu !== null, menuSelector: ".war-room-taskbar-menu", returnFocusRef: menuReturnFocusRef, onEscape: closeMenu });
  const signature = entries.map((operation) => operation.id).join("\0");

  // 실제 가용 폭(트레이 접힘 포함)에서 순서대로 줄인다. 제어를 복제해 재는 숨은 도구모음은 없다.
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const reset = () => setFit({ step: 0, count: entries.length });
    reset();
    const observer = new ResizeObserver(reset);
    observer.observe(row);
    return () => observer.disconnect();
  }, [signature, counts.running, counts.idle, minimized.length, ended.length, t]);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row || row.scrollWidth <= row.clientWidth + 1) return;
    if (fit.step < 3) setFit({ ...fit, step: fit.step + 1 });
    else if (fit.count > pinned.size) {
      // Operation이 많아도 카드마다 동기 렌더를 반복하지 않는다. 실제 폭으로 한 번에 접는다.
      let remaining = row.scrollWidth - row.clientWidth + (fit.count === entries.length ? 52 : 0);
      let count = fit.count;
      for (const chip of [...row.querySelectorAll<HTMLElement>(".war-room-chip")].reverse()) {
        if (pinned.has(chip.dataset.zenOp ?? "")) continue;
        remaining -= chip.getBoundingClientRect().width + 2;
        count -= 1;
        if (remaining <= 0) break;
      }
      setFit({ step: 4, count: Math.max(pinned.size, Math.min(fit.count - 1, count)) });
    } else if (fit.step < 5) setFit({ ...fit, step: 5 });
  });
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => remeasureChips((revision) => revision + 1));
    for (const chip of rowRef.current?.querySelectorAll(".war-room-chip") ?? []) observer.observe(chip);
    return () => observer.disconnect();
  }, [signature, fit.count]);
  // 최소 「다음」과 실제 무대는 남긴다. 나머지는 큐 순서를 바꾸지 않고 메뉴로 넘긴다.
  const visibleIds = new Set(pinned);
  for (const operation of entries) {
    if (visibleIds.size >= fit.count) break;
    visibleIds.add(operation.id);
  }
  const shown = entries.filter((operation) => visibleIds.has(operation.id));
  const overflow = entries.filter((operation) => !visibleIds.has(operation.id));

  // 새 주의 도착만 한 번 번진다. 지목·미룸으로 순서만 바뀌는 것은 새 도착이 아니다.
  const attentionIds = live.filter((operation) => {
    const activity = resolveOperationActivity(operation, operationRuntime);
    return activity === "awaiting" || (activity === "idle" && arrivals.has(operation.id));
  }).map((operation) => operation.id);
  const attentionSignature = attentionIds.join("\0");
  const previousAttentionRef = useRef(new Set(attentionIds));
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const fresh = attentionIds.filter((id) => !previousAttentionRef.current.has(id));
    previousAttentionRef.current = new Set(attentionIds);
    if (!fresh.length) return;
    setNewIds(new Set(fresh));
    const timer = window.setTimeout(() => setNewIds(new Set()), 1100);
    return () => { window.clearTimeout(timer); setNewIds(new Set()); };
  }, [attentionSignature]);
  useEffect(() => () => highlightTriageDeckCard(null), []);
  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".war-room-taskbar-menu, [data-war-room-menu-anchor]")) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [menu, closeMenu]);

  const mark = (operation: OperationNode) => resolveOperationMarkVisual({ activity: resolveOperationActivity(operation, operationRuntime), operationId: operation.id, idleArrivalIds: arrivals });
  const theaterLabel = (operation: OperationNode) => theaters.find((theater) => theater.id === operation.theaterId)?.label ?? operation.theaterId;
  const pick = (operation: OperationNode) => { closeMenu(); pickTriageOperation(operation.id); };
  const openMenu = (kind: Shelf, anchor: HTMLButtonElement) => {
    menuReturnFocusRef.current = anchor;
    setMenu((current) => current?.kind === kind ? null : { kind, anchor: anchor.getBoundingClientRect() });
  };
  const menuButton = (kind: Shelf, label: string, items: readonly OperationNode[]) => <button type="button" className="war-room-menu-button"
    data-war-room-menu-anchor="" data-keep-operation-active="" data-zen-fold-ops={items.map((operation) => operation.id).join(" ")}
    aria-haspopup="menu" aria-expanded={menu?.kind === kind} onClick={(event) => openMenu(kind, event.currentTarget)}>
    {label}<span aria-hidden="true">⌄</span>
  </button>;
  const chip = (operation: OperationNode) => {
    const visual = mark(operation);
    const accentKey = getTheaterCanvasSnapshot(operation.theaterId).operationAccent[operation.id] ?? operationAccentFromNode(operation);
    const accent = accentKey ? resolveAccentColor(accentKey) : null;
    return <button key={operation.id} type="button" className={`zen-taskbar-op war-room-chip is-${visual}${operation.id === stagedId ? " is-active" : ""}${newIds.has(operation.id) ? " is-new" : ""}`}
      data-zen-op={operation.id} data-keep-operation-active="" aria-current={operation.id === stagedId ? "true" : undefined}
      title={`${operation.title} · ${theaterLabel(operation)}`} style={accent ? { "--user-accent": accent } as CSSProperties : undefined}
      onMouseEnter={() => highlightTriageDeckCard(operation.id)} onMouseLeave={() => highlightTriageDeckCard(null)}
      onFocus={() => highlightTriageDeckCard(operation.id)} onBlur={() => highlightTriageDeckCard(null)} onClick={() => pick(operation)}
      onContextMenu={(event) => { event.preventDefault(); onOpenOperationMenu(operation.id, new DOMRect(event.clientX, event.clientY, 0, 0), event.currentTarget); }}
      onKeyDown={(event) => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); onOpenOperationMenu(operation.id, event.currentTarget.getBoundingClientRect(), event.currentTarget); } }}>
      {operation.id === nextId ? <span className="war-room-next">{t("canvas.triage.next")}<span aria-hidden="true">▸</span></span> : null}
      <OperationNameMark operation={operation} status={visual} decorative className="zen-taskbar-op-mark" />
      <span className="zen-taskbar-op-title">{operation.title}</span><sup>{theaterInitials(theaterLabel(operation))}</sup>
    </button>;
  };
  const menuItems = menu?.kind === "overflow" ? overflow : menu?.kind === "minimized" ? minimized : menu?.kind === "ended" ? ended : [...minimized, ...ended];
  const summary = `${t("canvas.triage.runningCount", { count: counts.running })} · ${t("canvas.triage.idleCount", { count: counts.idle })}`;
  const attentionClasses = `${counts.waiting + counts.unseen > 0 ? " has-attention" : ""}${counts.waiting === 0 ? " is-positive" : ""}${newIds.size > 0 ? " is-arriving" : ""}`;
  return <nav className={`zen-taskbar war-room-taskbar${entering ? " is-entering" : ""}`} aria-label={t("chrome.commandBand.modeWarRoom")} data-fit={fit.step}>
    {triageGlowHost ? createPortal(<div ref={glowRef} className={`war-room-glow${attentionClasses}`} />, triageGlowHost) : null}
    <div className="zen-taskbar-left war-room-taskbar-row" ref={rowRef}>
      {fit.step < 5 ? <span className="war-room-kicker">{t("canvas.triage.modeKicker")}</span> : null}
      <span className="zen-taskbar-axis"><CanvasModeSwitch /></span>
      <span className="war-room-tools"><WarRoomModeTools compact={fit.step >= 2} /></span>
      <span className="zen-taskbar-sep" aria-hidden="true" />
      <div ref={queueRef} className={`war-room-queue${attentionClasses}`}>
        {entries.length ? shown.map(chip) : <span className="zen-taskbar-empty">{t("canvas.triage.queueEmpty")}</span>}
        {overflow.length > 0 ? menuButton("overflow", `+${overflow.length}`, overflow) : null}
      </div>
      <span className="war-room-summary" title={summary} aria-label={summary}>
        <span><OperationStatusIcon status="running" decorative />{fit.step > 0 ? counts.running : t("canvas.triage.runningCount", { count: counts.running })}</span>
        <span><OperationStatusIcon status="idle" decorative />{fit.step > 0 ? counts.idle : t("canvas.triage.idleCount", { count: counts.idle })}</span>
      </span>
      <span className="war-room-shelves">
        {fit.step >= 3 && minimized.length + ended.length > 0
          ? menuButton("shelves", t("canvas.triage.shelfCount", { count: minimized.length + ended.length }), [...minimized, ...ended])
          : <>{minimized.length > 0 ? menuButton("minimized", t("canvas.triage.minimizedCount", { count: minimized.length }), minimized) : null}
            {minimized.length > 0 && ended.length > 0 ? <span aria-hidden="true">·</span> : null}
            {ended.length > 0 ? menuButton("ended", t("canvas.triage.endedCount", { count: ended.length }), ended) : null}</>}
      </span>
    </div>
    {menu ? createPortal(<div className="zen-taskbar-menu war-room-taskbar-menu" role="menu" style={{ left: Math.max(8, Math.min(menu.anchor.left, window.innerWidth - 280)), bottom: window.innerHeight - menu.anchor.top + 8, width: 272 }}>
      {menuItems.map((operation) => <button key={operation.id} type="button" role="menuitem" className="zen-taskbar-menu-item" data-keep-operation-active=""
        onMouseEnter={() => highlightTriageDeckCard(operation.id)} onMouseLeave={() => highlightTriageDeckCard(null)}
        onFocus={() => highlightTriageDeckCard(operation.id)} onBlur={() => highlightTriageDeckCard(null)}
        onClick={() => {
          const kind = menu.kind;
          closeMenu();
          if (kind === "overflow") pickTriageOperation(operation.id);
          else if (resolveOperationActivity(operation, operationRuntime) === "ended") onResume(operation.id);
          else setTheaterOperationMinimized(operation.theaterId, operation.id, false);
          menuReturnFocusRef.current?.focus({ preventScroll: true });
        }}>
        <OperationNameMark operation={operation} status={mark(operation)} decorative className="zen-taskbar-op-mark" />
        <span className="zen-taskbar-menu-title">{operation.title}</span><span className="zen-taskbar-menu-count">{theaterInitials(theaterLabel(operation))}</span>
      </button>)}
    </div>, document.body) : null}
  </nav>;
}
