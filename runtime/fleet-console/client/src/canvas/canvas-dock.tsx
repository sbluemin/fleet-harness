import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";

import { setTerminalSessionAccent } from "../api.js";
import { sessionBeaconClassName, sessionDisplayLabel } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { sessionJobs } from "../store.js";
import type { ConsoleState, SessionInfo } from "../types.js";
import { dropIndexFromPoint } from "./canvas-dock-hit-test.js";
import { setPanelAccent, setPanelOrder, useCanvasState, type CanvasViewportSize } from "./canvas-store.js";
import { useActiveShellId } from "./shell-panels.js";
import { activateWindowPanel, closeWindowPanel, getPanelHandles, type WindowPanelHandle } from "./window-registry.js";

type Underway = "live" | "turn" | null;

interface CanvasDockProps {
  readonly state: ConsoleState;
  readonly sessions: readonly SessionInfo[];
  // 칩 클릭 시 패널을 전면 활성화하며 카메라를 그 패널로 이동하는 데 필요한 캔버스 픽셀 크기.
  readonly canvasSize: CanvasViewportSize;
  readonly minimizedIds: readonly string[];
}

interface DockEntry {
  readonly handle: WindowPanelHandle;
  readonly label: string;
  readonly meta: string;
  readonly beaconClassName: string;
  readonly activeJobCount: number;
  readonly underway: Underway;
  readonly showRing: boolean;
  readonly active: boolean;
}

interface CanvasDockChipProps {
  readonly entry: DockEntry;
  readonly index: number;
  readonly canvasSize: CanvasViewportSize;
  // 최대화 모드에서 칩 클릭이 maximizeWindowPanel로 전환할 때 넘길 전체 패널 핸들.
  readonly allHandles: readonly WindowPanelHandle[];
  readonly isCloseArmed: boolean;
  readonly onArmClose: (handleId: string) => void;
  readonly onDisarmClose: () => void;
  readonly accentKey: string | null;
  readonly accentValue: string | null;
  readonly accentMenuOpen: boolean;
  readonly dragging: boolean;
  readonly dragOffsetX: number;
  readonly dropTarget: boolean;
  readonly onKeyboardMove: (panelId: string, direction: -1 | 1) => void;
  readonly onPointerDragStart: (event: ReactPointerEvent<HTMLDivElement>, panelId: string) => void;
  readonly onPointerDragMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerDragEnd: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerDragCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onOpenAccentMenu: (panelId: string) => void;
  readonly onSetAccent: (panelId: string, accentKey: string | null) => void;
}

interface PagerState {
  readonly overflow: boolean;
  readonly atStart: boolean;
  readonly atEnd: boolean;
  readonly page: number;
  readonly pages: number;
}

interface DragState {
  readonly sourceId: string;
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  // 현재 포인터 X — 끄는 칩이 커서를 따라 들려 이동(translateX)하게 해 "잡고 끌고 있다"는 감각을 준다.
  readonly currentX: number;
  readonly dragging: boolean;
  readonly dropIndex: number;
}

interface DockAccent {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

const INITIAL_PAGER: PagerState = { overflow: false, atStart: false, atEnd: true, page: 1, pages: 1 };
const CLOSE_ARM_DURATION_MS = 1500;
const DRAG_THRESHOLD_PX = 6;
const AUTO_SCROLL_EDGE_PX = 34;
const AUTO_SCROLL_STEP_PX = 18;
// 16색 큐레이션 팔레트 — hue 휠 전체(빨강/노랑/초록 포함). accent는 fill 채널 단독 소유이고 시스템 신호는
// border/링/beacon/glow가 맡으므로, 신호색과 hue가 겹쳐도 채널 분리로 상태와 혼동되지 않는다(낮은 chroma 틴트).
const DOCK_ACCENTS: readonly DockAccent[] = [
  { key: "red", label: "Red", color: "oklch(70% 0.12 25)" },
  { key: "orange", label: "Orange", color: "oklch(73% 0.12 50)" },
  { key: "amber", label: "Amber", color: "oklch(78% 0.11 70)" },
  { key: "yellow", label: "Yellow", color: "oklch(84% 0.11 95)" },
  { key: "lime", label: "Lime", color: "oklch(81% 0.12 120)" },
  { key: "green", label: "Green", color: "oklch(74% 0.12 145)" },
  { key: "emerald", label: "Emerald", color: "oklch(73% 0.10 165)" },
  { key: "teal", label: "Teal", color: "oklch(74% 0.09 185)" },
  { key: "cyan", label: "Cyan", color: "oklch(76% 0.09 205)" },
  { key: "sky", label: "Sky", color: "oklch(74% 0.10 230)" },
  { key: "blue", label: "Blue", color: "oklch(70% 0.11 255)" },
  { key: "indigo", label: "Indigo", color: "oklch(68% 0.11 278)" },
  { key: "violet", label: "Violet", color: "oklch(70% 0.11 300)" },
  { key: "purple", label: "Purple", color: "oklch(70% 0.12 320)" },
  { key: "magenta", label: "Magenta", color: "oklch(71% 0.12 340)" },
  { key: "rose", label: "Rose", color: "oklch(72% 0.11 5)" },
] as const;

export function CanvasDock({ state, sessions, canvasSize, minimizedIds }: CanvasDockProps) {
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const pinRightRef = useRef(true);
  const closeArmTimeoutRef = useRef<number | null>(null);
  const [pager, setPager] = useState<PagerState>(INITIAL_PAGER);
  const [armedCloseId, setArmedCloseId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [accentMenuId, setAccentMenuId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const canvas = useCanvasState();
  // 활성 셸 id를 구독한다 — 셸 칩의 포커스 강조가 포커스 전환에 즉시 반영되게 한다(opportunistic read는 리렌더 안 됨).
  const activeShellId = useActiveShellId();
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const operationIds = sessions.map((session) => session.sessionId);
  // 태스크바는 최소화 여부와 무관하게 모든 패널(Operation+셸)을 항상 표시한다 — OS 윈도우 시스템의 태스크바처럼.
  // panelHandles 전체는 최대화 모드 칩 전환(maximizeWindowPanel)에 그대로 넘겨야 하므로 변수로 보존한다.
  const panelHandles = getPanelHandles(operationIds);
  const minimizedSet = new Set(minimizedIds);
  const entries = panelHandles
    .map((handle): DockEntry | null => {
      const session = sessionById.get(handle.id);
      if (!session) {
        // 셸 패널: 세션 메타가 없다. 활성 셸이면 포커스 강조한다(Operation 활성과 상호배타라 동시에 둘이 켜지지 않는다).
        return {
          handle,
          label: "Shell",
          meta: "shell",
          beaconClassName: "tenant-beacon is-live",
          activeJobCount: 0,
          underway: null,
          showRing: false,
          active: activeShellId === handle.id,
        };
      }
      const activeJobCount = sessionJobs(state, session).filter(({ job }) => !isTerminalJobStatus(job.status)).length;
      const underway: Underway = session.status === "dormant"
        ? null
        : activeJobCount > 0
          ? "live"
          : session.turnState === "running"
            ? "turn"
            : null;
      return {
        handle,
        label: sessionDisplayLabel(session),
        meta: session.cliLabel ?? session.cliId ?? "CLI",
        beaconClassName: sessionBeaconClassName(session, activeJobCount),
        activeJobCount,
        underway,
        showRing: underway !== null && minimizedSet.has(handle.id),
        active: state.activeTerminalSessionId === session.sessionId,
      };
    })
    .filter((entry): entry is DockEntry => Boolean(entry));
  const entriesKey = entries.map((entry) => entry.handle.id).join(",");
  const metricsKey = entries.map((entry) => `${entry.label}\u0001${entry.meta}\u0001${entry.activeJobCount}`).join("\u0002");
  const dragSourceIndex = drag ? entries.findIndex((entry) => entry.handle.id === drag.sourceId) : -1;

  const clearCloseArmTimer = useCallback(() => {
    if (closeArmTimeoutRef.current === null) return;
    window.clearTimeout(closeArmTimeoutRef.current);
    closeArmTimeoutRef.current = null;
  }, []);

  const disarmClose = useCallback(() => {
    clearCloseArmTimer();
    setArmedCloseId(null);
  }, [clearCloseArmTimer]);

  const armClose = useCallback((handleId: string) => {
    clearCloseArmTimer();
    setArmedCloseId(handleId);
    closeArmTimeoutRef.current = window.setTimeout(() => {
      closeArmTimeoutRef.current = null;
      setArmedCloseId(null);
    }, CLOSE_ARM_DURATION_MS);
  }, [clearCloseArmTimer]);

  const measure = useCallback(() => {
    const el = chipsRef.current;
    if (!el) return;
    const { scrollLeft, clientWidth, scrollWidth } = el;
    const maxScroll = Math.max(0, scrollWidth - clientWidth);
    const overflow = clientWidth > 0 && maxScroll > 1;
    const pages = overflow ? Math.max(1, Math.ceil(scrollWidth / clientWidth)) : 1;
    const atEnd = scrollLeft >= maxScroll - 1;
    const page = overflow ? (atEnd ? 1 : Math.min(pages, Math.ceil((maxScroll - scrollLeft) / clientWidth) + 1)) : 1;
    setPager({ overflow, atStart: scrollLeft <= 1, atEnd, page, pages });
  }, []);

  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    pinRightRef.current = true;
    el.scrollLeft = el.scrollWidth;
    measure();
    const observer = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          if (pinRightRef.current) el.scrollLeft = el.scrollWidth;
          measure();
        })
      : null;
    observer?.observe(el);
    const onScroll = () => {
      const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
      pinRightRef.current = el.scrollLeft >= maxScroll - 1;
      measure();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer?.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, [entriesKey, measure]);

  useEffect(() => clearCloseArmTimer, [clearCloseArmTimer]);

  useEffect(() => {
    const el = chipsRef.current;
    if (!el) return;
    if (pinRightRef.current) el.scrollLeft = el.scrollWidth;
    measure();
  }, [metricsKey, measure]);

  useEffect(() => {
    if (armedCloseId === null) return;
    if (entries.some((entry) => entry.handle.id === armedCloseId)) return;
    disarmClose();
  }, [armedCloseId, entries, disarmClose]);

  useEffect(() => {
    if (accentMenuId === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".canvas-dock-accent-popover, .canvas-dock-accent-trigger")) return;
      setAccentMenuId(null);
    };
    // 팝오버 좌표는 open 시점 트리거 rect로 한 번 고정되므로, dock 스크롤/창 리사이즈로 트리거가 움직이면
    // 메뉴와 칩이 분리되지 않게 닫는다(재계산 대신 닫기로 단순·안전하게).
    const closeMenu = () => setAccentMenuId(null);
    const chips = chipsRef.current;
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", closeMenu);
    chips?.addEventListener("scroll", closeMenu, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", closeMenu);
      chips?.removeEventListener("scroll", closeMenu);
    };
  }, [accentMenuId]);

  if (entries.length === 0) return null;

  const showPager = pager.overflow;
  const turnPage = (direction: -1 | 1) => {
    const el = chipsRef.current;
    if (!el) return;
    const reduce = typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: direction * el.clientWidth, behavior: reduce ? "auto" : "smooth" });
  };
  const currentOrder = entries.map((entry) => entry.handle.id);
  const announceOrder = (panelId: string, targetIndex: number) => {
    const entry = entries.find((item) => item.handle.id === panelId);
    setStatusMessage(`${entry?.label ?? "Window"} moved to position ${targetIndex + 1} of ${entries.length}.`);
  };
  const keyboardMove = (panelId: string, direction: -1 | 1) => {
    const index = currentOrder.indexOf(panelId);
    if (index === -1) return;
    const targetIndex = Math.max(0, Math.min(currentOrder.length - 1, index + direction));
    if (targetIndex === index) return;
    // 전체 가시 순서를 새로 만들어 영속한다 — movePanel(희소 인덱스)은 panelOrder가 비어 있을 때
    // 인덱스 의미가 어긋나(드래그가 맨 앞으로 점프) 한 번에 전체 순서를 setPanelOrder로 확정한다.
    const nextOrder = [...currentOrder];
    const [moved] = nextOrder.splice(index, 1);
    if (moved === undefined) return;
    nextOrder.splice(targetIndex, 0, moved);
    setPanelOrder(nextOrder);
    announceOrder(panelId, targetIndex);
  };
  const beginPointerDrag = (event: ReactPointerEvent<HTMLDivElement>, panelId: string) => {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setAccentMenuId(null);
    setDrag({ sourceId: panelId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, currentX: event.clientX, dragging: false, dropIndex: currentOrder.indexOf(panelId) });
  };
  const updatePointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.dragging && distance < DRAG_THRESHOLD_PX) return;
    const dropIndex = dropIndexFromPoint(event.clientX, currentOrder, chipsRef.current, drag.sourceId);
    autoScrollDock(event.clientX, chipsRef.current);
    setDrag({ ...drag, currentX: event.clientX, dragging: true, dropIndex });
  };
  const finishPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const { sourceId, dragging, dropIndex } = drag;
    setDrag(null);
    if (!dragging) return;
    const sourceIndex = currentOrder.indexOf(sourceId);
    if (sourceIndex === -1 || dropIndex === sourceIndex) return;
    // dropIndex는 source를 포함한 가시 리스트의 "이 인덱스 앞에 삽입" 의미다. 전체 순서를 재구성해
    // setPanelOrder로 확정한다(희소 movePanel의 인덱스 어긋남 회피).
    const nextOrder = reorderIds(currentOrder, sourceId, dropIndex);
    setPanelOrder(nextOrder);
    announceOrder(sourceId, nextOrder.indexOf(sourceId));
  };
  const cancelPointerDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag && event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDrag(null);
  };
  const chooseAccent = (panelId: string, accentKey: string | null) => {
    setPanelAccent(panelId, accentKey);
    if (sessionById.has(panelId)) void setTerminalSessionAccent(panelId, accentKey).catch(() => undefined);
    setAccentMenuId(null);
  };

  return (
    <div className="canvas-dock is-taskbar" data-canvas-blocker>
      <div className="canvas-dock-rail" role="toolbar" aria-label="Open windows">
        {showPager ? (
          <button type="button" className="canvas-dock-pager canvas-dock-pager--prev" onClick={() => turnPage(-1)} disabled={pager.atStart} aria-label="Show older windows" title="Older">
            <PagerCaret direction="prev" />
          </button>
        ) : null}
        <div className="canvas-dock-chips" ref={chipsRef}>
          {entries.map((entry, index) => {
            const accentKey = canvas.panelAccent[entry.handle.id] ?? null;
            const accentValue = accentKey ? resolveDockAccentColor(accentKey) : null;
            return (
              <CanvasDockChip
                key={entry.handle.id}
                entry={entry}
                index={index}
                canvasSize={canvasSize}
                allHandles={panelHandles}
                isCloseArmed={armedCloseId === entry.handle.id}
                onArmClose={armClose}
                onDisarmClose={disarmClose}
                accentKey={accentValue ? accentKey : null}
                accentValue={accentValue}
                accentMenuOpen={accentMenuId === entry.handle.id}
                dragging={drag?.sourceId === entry.handle.id && drag.dragging}
                dragOffsetX={drag?.sourceId === entry.handle.id && drag.dragging ? drag.currentX - drag.startX : 0}
                dropTarget={drag?.dragging === true && drag.dropIndex === index && dragSourceIndex !== index}
                onKeyboardMove={keyboardMove}
                onPointerDragStart={beginPointerDrag}
                onPointerDragMove={updatePointerDrag}
                onPointerDragEnd={finishPointerDrag}
                onPointerDragCancel={cancelPointerDrag}
                onOpenAccentMenu={setAccentMenuId}
                onSetAccent={chooseAccent}
              />
            );
          })}
        </div>
        {showPager ? (
          <button type="button" className="canvas-dock-pager canvas-dock-pager--next" onClick={() => turnPage(1)} disabled={pager.atEnd} aria-label="Show newer windows" title="Newer">
            <PagerCaret direction="next" />
          </button>
        ) : null}
        {showPager ? <span className="canvas-dock-page" aria-label={`Page ${pager.page} of ${pager.pages}`}>{pager.page}/{pager.pages}</span> : null}
        <span className="sr-only" aria-live="polite">{statusMessage}</span>
      </div>
    </div>
  );
}

function CanvasDockChip({
  entry,
  index,
  canvasSize,
  allHandles,
  isCloseArmed,
  onArmClose,
  onDisarmClose,
  accentKey,
  accentValue,
  accentMenuOpen,
  dragging,
  dragOffsetX,
  dropTarget,
  onKeyboardMove,
  onPointerDragStart,
  onPointerDragMove,
  onPointerDragEnd,
  onPointerDragCancel,
  onOpenAccentMenu,
  onSetAccent,
}: CanvasDockChipProps) {
  const suppressClickRef = useRef(false);
  const accentTriggerRef = useRef<HTMLButtonElement | null>(null);
  // 팝오버는 dock의 overflow:hidden(가로 스크롤 클립)에 잘리므로 document.body로 포털하고 position:fixed로 띄운다.
  // 좌표는 트리거 버튼 rect에서 계산한다(트리거 위쪽, 좌측 정렬). 열릴 때마다 재계산한다.
  const [accentMenuStyle, setAccentMenuStyle] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!accentMenuOpen || !accentTriggerRef.current) return;
    const rect = accentTriggerRef.current.getBoundingClientRect();
    setAccentMenuStyle({ position: "fixed", left: Math.max(8, rect.left), top: "auto", bottom: Math.round(window.innerHeight - rect.top + 8) });
  }, [accentMenuOpen]);
  const chipClassName = [
    "canvas-dock-chip",
    entry.active ? "canvas-dock-chip--active" : "",
    entry.underway ? `canvas-dock-chip--underway canvas-dock-chip--underway-${entry.underway}` : "",
    entry.showRing ? "canvas-dock-chip--underway-ring" : "",
    dragging ? "canvas-dock-chip--dragging" : "",
    dropTarget ? "canvas-dock-chip--drop-target" : "",
  ].filter(Boolean).join(" ");
  const closeClassName = [
    "canvas-dock-chip-close",
    isCloseArmed ? "is-armed" : "",
  ].filter(Boolean).join(" ");
  const chipStyle = {
    "--i": index,
    ...(accentValue ? { "--chip-accent": accentValue } : {}),
    ...(dragging ? { "--drag-dx": `${Math.round(dragOffsetX)}px` } : {}),
  } as CSSProperties;

  // 칩 클릭 = 그 패널을 전면 활성화한다. 최대화 모드면 최대화를 유지한 채 전환, 아니면 최소화 복원·카메라 이동까지 흡수한다.
  const activate = () => {
    // 드래그 직후의 합성 click은 활성화를 억제한다(canary 2단 닫기의 disarm은 항상 수행).
    onDisarmClose();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    activateWindowPanel(entry.handle, allHandles, canvasSize);
  };
  // pointerdown은 전파만 막고(칩 활성화·드래그 경로 차단), 실제 닫기는 click에서 한 번만 실행한다 —
  // pointerdown과 click 양쪽에 닫기를 걸면 closeWindowPanel이 이중 호출되어 두 번째 terminate가 에러 토스트를 띄운다.
  const stopClosePointer = (event: SyntheticEvent<HTMLButtonElement>) => { event.stopPropagation(); };
  const close = (event: SyntheticEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!isCloseArmed) {
      onArmClose(entry.handle.id);
      return;
    }
    onDisarmClose();
    closeWindowPanel(entry.handle);
  };
  // 팝오버 개폐는 부모(accentMenuId)가 단일 소스로 관리한다 — 부모의 바깥-pointerdown 핸들러가
  // 팝오버/트리거 내부 클릭을 제외하므로, 칩-로컬 무조건 닫기(스와치 클릭 전에 언마운트되어 선택이 유실되던 버그)를 없앤다.
  const openAccent = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenAccentMenu(entry.handle.id);
  };

  return (
    <div
      data-dock-chip-id={entry.handle.id}
      className={chipClassName}
      role="button"
      tabIndex={0}
      aria-label={entry.active ? `${entry.label} (focused)` : `Focus ${entry.label}`}
      aria-current={entry.active ? "true" : undefined}
      title={entry.active ? "Focused" : "Click to focus"}
      style={chipStyle}
      onClick={activate}
      onFocus={() => {
        if (!isCloseArmed) onDisarmClose();
      }}
      onContextMenu={openAccent}
      onPointerDown={(event) => onPointerDragStart(event, entry.handle.id)}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onPointerUp={(event) => {
        if (dragging) suppressClickRef.current = true;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.stopPropagation();
      }}
      onKeyDown={(event) => {
        // 칩 본체에서 발생한 키만 활성화로 처리한다 — 닫기 버튼 등 중첩 컨트롤의 Enter/Space가 버블링되어
        // preventDefault+activate가 닫기를 가로채는 것을 막는다(닫기 버튼은 자체 onClick으로 닫힌다).
        if (event.target !== event.currentTarget) return;
        // 재배치는 Alt+Shift+←/→ — shift 없는 Alt+←/→는 operations의 패널 순환이 가져간다(전역 capture 핸들러).
        if (event.altKey && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          onKeyboardMove(entry.handle.id, event.key === "ArrowLeft" ? -1 : 1);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
      onPointerMoveCapture={(event) => onPointerDragMove(event)}
      onPointerUpCapture={(event) => onPointerDragEnd(event)}
      onPointerCancelCapture={(event) => onPointerDragCancel(event)}
    >
      <span className={entry.beaconClassName} aria-hidden="true" />
      <span className="canvas-dock-chip-name">{entry.label}</span>
      <span className="canvas-dock-chip-cli">{entry.meta}</span>
      {entry.activeJobCount > 0 ? <span className="canvas-dock-chip-count">{entry.activeJobCount}</span> : null}
      <button ref={accentTriggerRef} type="button" className="canvas-dock-accent-trigger" onPointerDown={stopClosePointer} onClick={openAccent} aria-label={`Accent ${entry.label}`} title="Accent">
        <span style={accentValue ? { background: accentValue } : undefined} />
      </button>
      {accentMenuOpen && accentMenuStyle ? createPortal(
        <div className="canvas-dock-accent-popover" role="menu" aria-label={`Accent ${entry.label}`} style={accentMenuStyle} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" className="canvas-dock-accent-swatch canvas-dock-accent-swatch--clear" role="menuitem" aria-label="No accent" aria-pressed={accentKey === null} onClick={(event) => { event.stopPropagation(); onSetAccent(entry.handle.id, null); }}>
            <span />
            None
          </button>
          {DOCK_ACCENTS.map((accent) => (
            <button key={accent.key} type="button" className="canvas-dock-accent-swatch" role="menuitem" aria-label={accent.label} aria-pressed={accentKey === accent.key} onClick={(event) => { event.stopPropagation(); onSetAccent(entry.handle.id, accent.key); }}>
              <span style={{ background: accent.color }} />
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
      <button type="button" className={closeClassName} onPointerDown={stopClosePointer} onClick={close} aria-label={isCloseArmed ? `Confirm close ${entry.label}` : `Close ${entry.label}`} title={isCloseArmed ? "Confirm close" : "Close"}>
        {isCloseArmed ? "Close?" : <CloseIcon />}
      </button>
    </div>
  );
}

function resolveDockAccentColor(accentKey: string): string | null {
  return DOCK_ACCENTS.find((accent) => accent.key === accentKey)?.color ?? null;
}

// 전체 가시 순서(source 포함)에서 source를 dropIndex 자리로 옮긴 새 순서를 만든다. dropIndex는
// dropIndexFromPoint가 준 "이 인덱스 앞에 삽입" 값이라, source 제거로 뒤쪽 인덱스가 한 칸 당겨지면 보정한다.
function reorderIds(orderedIds: readonly string[], sourceId: string, dropIndex: number): string[] {
  const sourceIndex = orderedIds.indexOf(sourceId);
  if (sourceIndex === -1) return [...orderedIds];
  const next = orderedIds.filter((id) => id !== sourceId);
  const insertAt = dropIndex > sourceIndex ? dropIndex - 1 : dropIndex;
  const bounded = Math.max(0, Math.min(insertAt, next.length));
  next.splice(bounded, 0, sourceId);
  return next;
}

function autoScrollDock(clientX: number, chipsElement: HTMLDivElement | null): void {
  if (!chipsElement) return;
  const rect = chipsElement.getBoundingClientRect();
  if (clientX < rect.left + AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollLeft -= AUTO_SCROLL_STEP_PX;
  } else if (clientX > rect.right - AUTO_SCROLL_EDGE_PX) {
    chipsElement.scrollLeft += AUTO_SCROLL_STEP_PX;
  }
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function PagerCaret({ direction }: { readonly direction: "prev" | "next" }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d={direction === "prev" ? "M10 3.5 5.5 8 10 12.5" : "M6 3.5 10.5 8 6 12.5"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
