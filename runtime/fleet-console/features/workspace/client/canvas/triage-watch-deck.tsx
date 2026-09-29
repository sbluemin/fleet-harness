import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { OperationRuntimeHydration, OperationRuntimeState } from "@fleet-console/sdk/plugin";
import type { OperationActivityVisual } from "../../../execution/client/operation-activity.js";

import { useT } from "../../../../core/client/src/i18n/index.js";
import { shortcutCommandLabel, useShortcutOverrides } from "../../../../core/client/src/integration/shortcut-bindings.js";
import { getIdleArrivalIds, useOperationStatusDetails } from "../../../execution/client/operation-marks.js";
import { resolveOperationMarkVisual, resolveOperationActivity, resolveOperationDisplayActivity } from "../../../execution/client/operation-activity.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import type { OperationGeometry, OperationNode, OperationGroup } from "../../../../core/client/src/integration/types.js";
import { flattenGroupedOrder, operationOrderFromNodes, revealOperationStage } from "../../../../core/client/src/integration/store.js";
import { FleetMap, type FleetMapDotMark } from "./fleet-map.js";
import {
  clampTriageDeckZoom,
  closeTriageMap,
  getTriageDeckZoom,
  getTriageDeckZoomLive,
  getTriageMapHeldQueueIds,
  isTriageActive,
  isTriageMapOpen,
  isTriageOperationDeferred,
  isTriageOperationDismissed,
  isTriageWaitingOperation,
  nextTriageDeckZoomPreset,
  openTriageMap,
  pickTriageOperation,
  resolveTriageCounts,
  resolveTriageQueue,
  setTriageDeckOverflowing,
  setTriageDeckZoom,
  setTriageDeckZoomLive,
  subscribeTriage,
  TRIAGE_DECK_CARD_BASE_MIN_PX,
} from "./triage-store.js";

export interface TriageDeckTheater {
  readonly id: string;
  readonly label: string;
}

interface TriageWatchDeckProps {
  readonly active: boolean;
  /** 전 Theater 목록 — deck는 Theater 밴드로 갈라 전 Theater의 휴면 아닌 Operation을 올린다. */
  readonly theaters: readonly TriageDeckTheater[];
  readonly operations: readonly OperationNode[];
  readonly groups?: readonly OperationGroup[];
  readonly operationRuntime: Readonly<Record<string, OperationRuntimeState>>;
  readonly operationAccent: Readonly<Record<string, string>>;
  readonly arrivingOperationId?: string | null;
  /** 무대에 오른 Operation — 그 카드만 슬롯을 무대 프레임에 넘기고, deck는 은닉된 채 mount를 유지한다. */
  readonly stagedOperationId?: string | null;
  /** 줌 tween 즉시 스냅 — 카드 클릭 직전에 호출해 승격 flight의 출발 rect를 고정한다. */
  readonly onBeforePick?: () => void;
  /** 칸이 마운트·해제될 때마다 그 자리를 캔버스에 알린다 — 캔버스는 이 자리로 그 Operation의
      실제 패널을 portal한다. 덱이 그리는 것은 자리와 배율이고, 패널은 끝까지 캔버스 소유다. */
  readonly onPanelSlotRef?: (operationId: string, element: HTMLElement | null) => void;
  /** 스포트라이트 OFF에서 검토 전인 대기 카드 — 지속 aurora 맥동(is-fresh)을 얹는다. */
  readonly freshOperationIds?: ReadonlySet<string>;
  /** Operation 표면의 공용 메뉴와 Theater 소유 빈 영역의 launch 메뉴를 상위 canvas가 호스트한다. */
  readonly onOperationContextMenu?: (operationId: string, anchor: DOMRect, returnFocus?: HTMLElement | null) => void;
  readonly onTheaterContextMenu?: (theaterId: string, anchor: { readonly x: number; readonly y: number }) => void;
  /** 지도 층이 열려 있는가 — 층은 덱 칸과 무대를 visibility로만 가리고, 둘의 mount는 그대로 둔다. */
  readonly mapOpen?: boolean;
  /** 런타임 맵을 믿을 수 있는가 — 지도의 상태 카드가 모름을 모름이라고 말하는 데 쓴다. */
  readonly operationRuntimeHydration?: OperationRuntimeHydration;
  /** 지도 점의 자리 — 캔버스가 자기 스토어로 해석한 유효 geometry. */
  readonly geometryFor?: (operation: OperationNode) => OperationGeometry | null;
}

// 권한 요청 독의 자리 — 오른쪽 아래 코너 독의 카드 폭(336px)과 한두 장이 쌓이는 높이. 지도 층은
// 이 자리에 구역·점·Quick-Look을 두지 않는다. 독은 덱보다 위 층이라, 겹치면 신호를 가리는 쪽은 독이다.
const TRIAGE_MAP_DOCK_KEEP_OUT = { width: 352, height: 216 };
// Quick-Look 틀이 칸을 둘러싼 여백.
const QUICK_LOOK_PAD_PX = 8;

interface QuickLookPlacement {
  readonly operationId: string;
  /** 여백까지 포함한 Quick-Look 틀 — 지도 판 기준 좌표(px). */
  readonly frame: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}

export interface TriageDeckArrivalDwell {
  readonly operationId: string;
  readonly deadline: number;
}

interface TriageDeckPromotionDecision {
  readonly promote: boolean;
  readonly arrivingOperationId: string | null;
  readonly dwell: TriageDeckArrivalDwell | null;
}

export const TRIAGE_DECK_ARRIVAL_DWELL_MS = 1_100;

// 승격 출발 rect 1회용 채널 — 클릭 순간의 rect는 outbound flight의 출발점으로만 쓰여야 한다.
// deckCardRects에 덮어쓰면 무대 복귀 flight의 목적지까지 오염되므로, 소비 즉시 비워지는
// 별도 채널로 분리한다.
let deckDepartureRect: { readonly operationId: string; readonly rect: DOMRect } | null = null;

export function takeTriageDeckDepartureRect(operationId: string): DOMRect | null {
  if (deckDepartureRect?.operationId !== operationId) return null;
  const rect = deckDepartureRect.rect;
  deckDepartureRect = null;
  return rect;
}

// 막대의 겨눔은 지목과 다르다. 카드의 outline만 바꾸고 무대·처리 큐는 건드리지 않는다.
export function highlightTriageDeckCard(operationId: string | null): void {
  document.querySelector(".canvas-triage-deck-cell.is-queue-hovered")?.classList.remove("is-queue-hovered");
  if (!operationId) return;
  const card = document.querySelector<HTMLElement>(`[data-triage-deck-card="${escapeAttributeValue(operationId)}"]`);
  if (!card) return;
  card.classList.add("is-queue-hovered");
  const grid = card.closest(".canvas-triage-deck-grid");
  if (!grid || card.closest(".is-under-stage")) return;
  const rect = card.getBoundingClientRect(), bounds = grid.getBoundingClientRect();
  if (rect.top < bounds.top || rect.bottom > bounds.bottom) card.scrollIntoView({ block: "nearest", behavior: "instant" });
}
const deckCardRects = new Map<string, DOMRect>();
const CARD_FLASH_DURATION_MS = 900;

export function getTriageDeckCardRect(operationId: string): DOMRect | null {
  // flight 좌표는 소비 시점 실측이 정본이다 — 캐시는 레이아웃 effect 주기에 묶여 줌 tween
  // 중간값을 담을 수 있으므로, 살아있는 DOM을 먼저 읽고 캐시도 함께 갱신한다.
  const escaped = escapeAttributeValue(operationId);
  const target = document.querySelector<HTMLElement>(`[data-triage-deck-card="${escaped}"]`);
  if (target) {
    const rect = target.getBoundingClientRect();
    deckCardRects.set(operationId, rect);
    return rect;
  }
  return deckCardRects.get(operationId) ?? null;
}

// 줌 제어는 deck와 rail의 공용 컨트롤러다. rAF tween과 wheel 부착은 React 합성
// 이벤트 밖에서 다뤄야 한다 — React는 root wheel을 passive로 묶어 preventDefault가 무용해진다.
// wheel 문법: Alt는 그대로 둔다. Ctrl/Meta는 언제나 줌·지도 당김이다. 무장 본문과 엿보기 칸은
// 네이티브 스크롤에 맡기고, Shift는 격자, 나머지는 줌이다. 합성 WheelEvent는 xterm에 닿지 않는다.
export interface TriageDeckZoomControl {
  readonly snapZoomTween: () => void;
  /** 프리셋 등 외부 배율 변경도 이 경로로 — 영속은 settle 시 휠과 동일하게. */
  readonly setZoomTarget: (zoom: number) => void;
  readonly attachWheelListener: (element: HTMLElement) => () => void;
}

const TRIAGE_DECK_ZOOM_TWEEN_FACTOR = 0.18;
const TRIAGE_DECK_ZOOM_TWEEN_EPSILON = 0.002;
const TRIAGE_DECK_ZOOM_WHEEL_SPEED = 0.0022;
// 1× 바닥 아래로 더 당긴 몫 — 덱은 1×에 멈춘 채 물러나고, 누적 배율이 여기 닿으면 지도 층이 선다.
// 지도 위에서는 반대로 확대 누적이 닫힘 임계에 닿으면 같은 덱으로 돌아온다. 휠이 잠시 멎으면
// 당김은 제자리로 돌아간다. 층을 여닫은 뒤의 휠은 휠이 멎을 때까지 버린다 — 고정 시간으로 끊으면
// 트랙패드 관성 꼬리(손을 뗀 뒤 1초 가까이)가 그 뒤로 새어 닫힌 덱의 밀도를 2×까지 올린다.
const TRIAGE_MAP_PULL_OPEN = 0.72;
const TRIAGE_MAP_PUSH_CLOSE = 1.35;
const TRIAGE_MAP_GESTURE_IDLE_MS = 400;
const TRIAGE_MAP_GESTURE_QUIET_MS = 180;

function elementCanScroll(element: HTMLElement, deltaX: number, deltaY: number): boolean {
  const style = getComputedStyle(element);
  const scrollable = (overflow: string) => overflow === "auto" || overflow === "scroll" || overflow === "overlay";
  if (scrollable(style.overflowY) && deltaY > 0 && element.scrollTop + element.clientHeight < element.scrollHeight - 1) return true;
  if (scrollable(style.overflowY) && deltaY < 0 && element.scrollTop > 0) return true;
  if (scrollable(style.overflowX) && deltaX > 0 && element.scrollLeft + element.clientWidth < element.scrollWidth - 1) return true;
  if (scrollable(style.overflowX) && deltaX < 0 && element.scrollLeft > 0) return true;
  return false;
}

/** 대상에서 본문(없으면 칸·엿보기 틀)까지만 본다 — 그 밖의 격자까지 가면 숨은 덱이 따라 스크롤된다. */
function wheelHasScrollRoom(target: Element, deltaX: number, deltaY: number): boolean {
  const boundary = target.closest(".canvas-operation-terminal")
    ?? target.closest(".canvas-triage-deck-cell")
    ?? target.closest(".canvas-triage-quick-look");
  let node: Element | null = target;
  while (node) {
    if (node instanceof HTMLElement && elementCanScroll(node, deltaX, deltaY)) return true;
    if (node === boundary) break;
    node = node.parentElement;
  }
  return false;
}

function setDeckTerminalInert(cell: HTMLElement, inert: boolean): void {
  const terminal = cell.querySelector<HTMLElement>(".canvas-operation-terminal");
  if (terminal) terminal.inert = inert;
}

/** 포인터가 칸 안에 있는 동안만 본문 inert 를 푼다. 한 번에 한 칸이다. */
let armedDeckCell: HTMLElement | null = null;

function armDeckCell(cell: HTMLElement): void {
  if (armedDeckCell && armedDeckCell !== cell) setDeckTerminalInert(armedDeckCell, true);
  armedDeckCell = cell;
  setDeckTerminalInert(cell, false);
}

function disarmDeckCell(cell: HTMLElement): void {
  setDeckTerminalInert(cell, true);
  if (armedDeckCell === cell) armedDeckCell = null;
}

function isEditableField(target: Element): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

/** 엿보기 탭 루프 — 본문과 승격 면은 빼서 캡션 → 칩 rail → 스트립만 남긴다. */
function peekDeckTabbables(cell: HTMLElement): HTMLElement[] {
  const operation = cell.querySelector<HTMLElement>(".canvas-operation");
  if (!operation) return [];
  const result: HTMLElement[] = [];
  for (const el of operation.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")) {
    if (el.closest(".canvas-operation-terminal")) continue;
    if (el.tabIndex < 0 || el.hasAttribute("disabled") || el.getAttribute("aria-hidden") === "true") continue;
    if (el.getClientRects().length === 0) continue;
    result.push(el);
  }
  return result;
}

export function useTriageDeckZoomControl(): {
  readonly zoom: number;
  readonly control: TriageDeckZoomControl;
} {
  const zoomRef = useRef(getTriageDeckZoom());
  const targetRef = useRef(zoomRef.current);
  const frameRef = useRef<number | null>(null);
  const ownerRef = useRef<HTMLElement | null>(null);
  const lastDisplayRef = useRef<string | null>(null);
  const [, setZoomRevision] = useState(0);
  const gestureRef = useRef<{ pull: number; push: number; resetTimer: number | null; latchUntil: number; bodyLatchUntil: number }>({ pull: 1, push: 1, resetTimer: null, latchUntil: 0, bodyLatchUntil: 0 });

  const stopTween = () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  };

  const applyZoom = (zoom: number) => {
    // 동일 배율 재적용도 허용한다 — theater 전환 effect가 ref를 먼저 스냅한 뒤 호출하므로
    // 조기 반환하면 CSS 변수/지도 판정/칩 표시가 새 theater의 배율로 갱신되지 않는다.
    zoomRef.current = zoom;
    const owner = ownerRef.current;
    if (owner) {
      owner.style.setProperty("--triage-card-min", `${Math.round(TRIAGE_DECK_CARD_BASE_MIN_PX * zoom)}px`);
      owner.style.setProperty("--triage-row-min", `${Math.max(84, Math.round(150 * zoom))}px`);
      owner.style.setProperty("--triage-row-max", `${Math.max(84, Math.round(210 * zoom))}px`);
    }
    // 리렌더는 칩 표시 문자열이 실제로 바뀔 때만 — 매 프레임 bump는 OperationsCanvas 전체를
    // 프레임당 리렌더로 몰아넣는다.
    const display = zoom.toFixed(1);
    if (display !== lastDisplayRef.current) {
      lastDisplayRef.current = display;
      setTriageDeckZoomLive(Number.parseFloat(display));
      setZoomRevision((revision) => revision + 1);
    }
  };

  const setTargetZoom = (target: number) => {
    targetRef.current = target;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (reducedMotion) {
      stopTween();
      applyZoom(target);
      setTriageDeckZoom(target);
      return;
    }
    if (frameRef.current !== null) return;
    const step = () => {
      const current = zoomRef.current;
      const goal = targetRef.current;
      if (Math.abs(goal - current) < TRIAGE_DECK_ZOOM_TWEEN_EPSILON) {
        applyZoom(goal);
        setTriageDeckZoom(goal);
        frameRef.current = null;
        return;
      }
      applyZoom(current + (goal - current) * TRIAGE_DECK_ZOOM_TWEEN_FACTOR);
      frameRef.current = window.requestAnimationFrame(step);
    };
    frameRef.current = window.requestAnimationFrame(step);
  };

  // 당김의 시각 — 저장 배율은 1×에 둔 채 격자만 물러난다. transform은 당기는 동안만 서므로 칸의
  // 크기(PTY)도, 지도 층의 고정 배치(Quick-Look)도 건드리지 않는다.
  const applyPull = (pull: number) => {
    const deck = ownerRef.current?.querySelector<HTMLElement>(".canvas-triage-deck");
    if (!deck) return;
    if (pull < 1) {
      deck.classList.add("is-pulling");
      deck.style.setProperty("--triage-deck-pull", pull.toFixed(3));
    } else {
      deck.classList.remove("is-pulling");
      deck.style.removeProperty("--triage-deck-pull");
    }
  };
  const resetGesture = () => {
    const gesture = gestureRef.current;
    if (gesture.resetTimer !== null) window.clearTimeout(gesture.resetTimer);
    gesture.resetTimer = null;
    gesture.pull = 1;
    gesture.push = 1;
    applyPull(1);
  };
  const scheduleGestureReset = () => {
    const gesture = gestureRef.current;
    if (gesture.resetTimer !== null) window.clearTimeout(gesture.resetTimer);
    gesture.resetTimer = window.setTimeout(resetGesture, TRIAGE_MAP_GESTURE_IDLE_MS);
  };

  useEffect(() => {
    stopTween();
    const initial = getTriageDeckZoom();
    zoomRef.current = initial;
    targetRef.current = initial;
    lastDisplayRef.current = null;
    applyZoom(initial);
    return () => {
      stopTween();
      resetGesture();
    };
  }, []);

  // store 쪽 배율 변경(rail 칩 프리셋 순환)도 같은 tween 경로로 흡수한다. 저장 배율이 실제로
  // 바뀐 emit에만 반응해야 한다 — triage store는 배율 외의 이유로도 emit한다.
  const lastStoredRef = useRef(getTriageDeckZoom());
  useEffect(() => {
    lastStoredRef.current = getTriageDeckZoom();
    return subscribeTriage(() => {
      const stored = getTriageDeckZoom();
      if (stored === lastStoredRef.current) return;
      lastStoredRef.current = stored;
      if (stored !== targetRef.current) setTargetZoom(stored);
    });
  }, []);

  const control = useMemo<TriageDeckZoomControl>(() => ({
    snapZoomTween: () => {
      // 동결은 사용자가 향하던 목표 배율로 한다 — 저장값으로 되돌리면 tween 도중(예: 지도
      // 진입 직후) 점을 클릭한 순간 화면이 이전 배율로 튀어 선택한 밀도가 사라진다. 목표를
      // 즉시 확정 저장해 flight 좌표와 이후 재진입 배율을 함께 고정한다.
      stopTween();
      const goal = targetRef.current;
      applyZoom(goal);
      setTriageDeckZoom(goal);
    },
    setZoomTarget: (zoom: number) => {
      setTargetZoom(clampTriageDeckZoom(zoom));
    },
    attachWheelListener: (element: HTMLElement) => {
      const previousOwner = ownerRef.current;
      ownerRef.current = element;
      if (previousOwner !== element) applyZoom(zoomRef.current);
      const consumeDeckZoomWheel = (event: WheelEvent, deltaScale: number) => {
        // 줌·지도 당김은 브라우저 페이지 줌도 막는다. 층 전환 뒤의 휠은 기한을 늘리며 버린다.
        event.preventDefault();
        const gesture = gestureRef.current;
        const now = performance.now();
        if (now < gesture.latchUntil) {
          gesture.latchUntil = now + TRIAGE_MAP_GESTURE_QUIET_MS;
          return;
        }
        const factor = Math.exp(-event.deltaY * deltaScale * TRIAGE_DECK_ZOOM_WHEEL_SPEED);
        // 지도 층 위 — 축소는 더 갈 곳이 없고, 확대 누적만 층을 걷는다(같은 덱, 같은 1×로 돌아온다).
        if (isTriageMapOpen()) {
          if (factor <= 1) return;
          gesture.push *= factor;
          scheduleGestureReset();
          if (gesture.push < TRIAGE_MAP_PUSH_CLOSE) return;
          resetGesture();
          gesture.latchUntil = performance.now() + TRIAGE_MAP_GESTURE_QUIET_MS;
          closeTriageMap();
          return;
        }
        const zoom = zoomRef.current;
        const raw = zoom * factor;
        // 밀도는 1×~2×만 — 1× 바닥 아래로 넘친 몫과, 이미 당기는 중의 휠은 밀도가 아니라 지도로 가는 당김이다.
        const next = clampTriageDeckZoom(raw);
        if (gesture.pull < 1 || raw < next) {
          if (gesture.pull < 1) gesture.pull = Math.min(1, gesture.pull * factor);
          else {
            if (next !== zoom) {
              applyZoom(next);
              setTargetZoom(next);
            }
            gesture.pull = raw / next;
          }
          applyPull(gesture.pull);
          scheduleGestureReset();
          if (gesture.pull > TRIAGE_MAP_PULL_OPEN) return;
          resetGesture();
          gesture.latchUntil = performance.now() + TRIAGE_MAP_GESTURE_QUIET_MS;
          openTriageMap();
          return;
        }
        if (next === zoom) return;
        applyZoom(next);
        setTargetZoom(next);
      };
      const handleWheel = (event: WheelEvent) => {
        // 덱 줌은 triage 모드 안에서, 덱 위에서만 발화한다 — 무경계 소비는 자유 캔버스의
        // 기존 줌과 이중 소비되고 브라우저 페이지 줌을 전역 차단한다.
        if (!isTriageActive()) return;
        if (!(event.target instanceof Element) || event.target.closest(".canvas-triage-deck") === null) return;
        // 판정 순서: Alt → Ctrl/Meta → 본문·엿보기 → Shift → 나머지.
        if (event.altKey) return;
        const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(240, element.clientHeight)
            : 1;
        if (event.ctrlKey || event.metaKey) {
          consumeDeckZoomWheel(event, deltaScale);
          return;
        }
        const target = event.target;
        const inTerminal = target.closest(".canvas-triage-deck-cell .canvas-operation-terminal") !== null;
        // 엿보기 칸의 Shift 포함 모든 비-Ctrl 휠은 본문 규칙이다 — 지도가 닫히거나 숨은 격자가 스크롤되지 않는다.
        const inQuickLook = target.closest(".canvas-triage-deck-cell.is-quick-look, .canvas-triage-quick-look") !== null;
        const gesture = gestureRef.current;
        const now = performance.now();
        if (!inTerminal && !inQuickLook && now < gesture.bodyLatchUntil) {
          event.preventDefault();
          gesture.bodyLatchUntil = now + TRIAGE_MAP_GESTURE_QUIET_MS;
          return;
        }
        if (inTerminal || inQuickLook) {
          // 당김은 누적하지 않는다. 스크롤은 기본 동작이나 xterm에 맡기고, 끝에 닿으면 조상으로 새지 않게 흡수한다.
          resetGesture();
          gesture.bodyLatchUntil = performance.now() + TRIAGE_MAP_GESTURE_QUIET_MS;
          if (!event.defaultPrevented && !wheelHasScrollRoom(target, event.deltaX, event.deltaY)) event.preventDefault();
          return;
        }
        if (event.shiftKey) {
          const grid = target.closest(".canvas-triage-deck")?.querySelector(".canvas-triage-deck-grid");
          if (!(grid instanceof HTMLElement)) return;
          event.preventDefault();
          // 일부 브라우저·트랙패드는 Shift+wheel을 deltaX로 보고한다 — 세로 스크롤로 수렴시킨다.
          grid.scrollTop += (event.deltaY !== 0 ? event.deltaY : event.deltaX) * deltaScale;
          return;
        }
        consumeDeckZoomWheel(event, deltaScale);
      };
      // Ctrl/Meta는 타깃(xterm)보다 먼저 기본 동작을 끊는다. 본문 휠의 흡수 판정은 버블에 둔다 —
      // xterm이 먼저 preventDefault 했는지(!defaultPrevented)를 봐야 하기 때문이다.
      const handleWheelCapture = (event: WheelEvent) => {
        if (!isTriageActive() || event.altKey || (!event.ctrlKey && !event.metaKey)) return;
        if (!(event.target instanceof Element) || event.target.closest(".canvas-triage-deck") === null) return;
        event.preventDefault();
      };
      element.addEventListener("wheel", handleWheelCapture, { capture: true, passive: false });
      element.addEventListener("wheel", handleWheel, { passive: false });
      return () => {
        element.removeEventListener("wheel", handleWheelCapture, { capture: true });
        element.removeEventListener("wheel", handleWheel);
        if (ownerRef.current === element) ownerRef.current = null;
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 내부 함수는 ref 경유로 최신 상태를 읽는다.
  }), []);

  // 밴드의 밀도 버튼도 이 컨트롤러를 거쳐야 한다 — store에 먼저 쓰면 tween 없이 칸이 튀고,
  // 컨트롤러 밖의 배율은 어느 요소에도 실리지 않는다(영속은 settle 시).
  useEffect(() => {
    mountedDeckZoomControl = control;
    return () => {
      if (mountedDeckZoomControl === control) mountedDeckZoomControl = null;
    };
  }, [control]);

  return { zoom: zoomRef.current, control };
}

// 덱이 마운트된 동안의 줌 컨트롤러. 덱이 없으면(모드 밖) store에 직접 쓴다.
let mountedDeckZoomControl: TriageDeckZoomControl | null = null;

export function cycleTriageDeckZoomPreset(): void {
  const next = nextTriageDeckZoomPreset(getTriageDeckZoomLive());
  if (mountedDeckZoomControl) {
    mountedDeckZoomControl.setZoomTarget(next);
    return;
  }
  setTriageDeckZoom(next);
}

export function flashTriageDeckCard(operationId: string): void {
  const escaped = escapeAttributeValue(operationId);
  const target = document.querySelector<HTMLElement>(`[data-triage-deck-card="${escaped}"]`);
  if (!target) return;
  target.classList.remove("is-landed");
  void target.offsetWidth;
  target.classList.add("is-landed");
  window.setTimeout(() => target.classList.remove("is-landed"), CARD_FLASH_DURATION_MS);
}

export function resolveTriageDeckPromotion(input: {
  readonly operationId: string | null;
  readonly picked: boolean;
  readonly deckVisible: boolean;
  readonly spotlight: boolean;
  readonly dwell: TriageDeckArrivalDwell | null;
  readonly now: number;
  readonly suppressed: boolean;
}): TriageDeckPromotionDecision {
  if (input.operationId !== null && input.picked) {
    return { promote: true, arrivingOperationId: null, dwell: null };
  }
  // 스포트라이트 OFF에서는 자동 등단이 아예 없다 — 무대를 바꾸는 것은 오직 지목(picked)뿐이다.
  // 무대가 이미 서 있는 교대 상황도 예외가 아니다: 무대의 작업이 끝나 다음 대기 건이 저절로
  // 올라오는 것이야말로 사용자가 이 스위치를 끄면서 막으려는 동작이다. reduced-motion의 즉시
  // 등단(suppressed)과 입장 연출 중(!deckVisible) 승격보다 먼저 판정해야 저장된 OFF가 항상 이긴다.
  // 도착 신호는 카드의 is-fresh가 계속 책임진다.
  if (input.operationId !== null && !input.spotlight) {
    return { promote: false, arrivingOperationId: null, dwell: null };
  }
  if (!input.operationId || !input.deckVisible) {
    return { promote: input.operationId !== null, arrivingOperationId: null, dwell: null };
  }
  if (!input.spotlight) {
    return { promote: false, arrivingOperationId: null, dwell: null };
  }
  if (input.suppressed) {
    return { promote: true, arrivingOperationId: null, dwell: null };
  }
  const dwell = input.dwell?.operationId === input.operationId
    ? input.dwell
    : { operationId: input.operationId, deadline: input.now + TRIAGE_DECK_ARRIVAL_DWELL_MS };
  const promote = input.now >= dwell.deadline;
  return {
    promote,
    arrivingOperationId: promote ? null : input.operationId,
    dwell: promote ? null : dwell,
  };
}

export function TriageWatchDeck({
  active,
  theaters,
  operations,
  groups = [],
  operationRuntime,
  operationAccent,
  arrivingOperationId = null,
  stagedOperationId = null,
  onBeforePick,
  onPanelSlotRef,
  freshOperationIds,
  onOperationContextMenu,
  onTheaterContextMenu,
  mapOpen = false,
  operationRuntimeHydration = "ready",
  geometryFor = (operation) => operation.geometry ?? null,
}: TriageWatchDeckProps) {
  const t = useT();
  useShortcutOverrides();
  const sectionRef = useRef<HTMLElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  useOperationStatusDetails();
  // 칸의 ref 콜백은 Operation당 하나로 고정한다 — 렌더마다 새 함수를 주면 React가 매 커밋에
  // 옛 콜백을 null로, 새 콜백을 element로 부르고, 그 두 번이 상위 state를 갱신해 렌더 루프가 된다.
  const slotRefsRef = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const onPanelSlotRefRef = useRef(onPanelSlotRef);
  onPanelSlotRefRef.current = onPanelSlotRef;
  const slotRefFor = (operationId: string) => {
    const cache = slotRefsRef.current;
    const existing = cache.get(operationId);
    if (existing) return existing;
    const callback = (element: HTMLElement | null) => { onPanelSlotRefRef.current?.(operationId, element); };
    cache.set(operationId, callback);
    return callback;
  };
  // 무대가 떠 있는 동안에도 deck는 mount를 유지하고 visibility로만 숨는다 — 비무대 body가
  // 카드(고정 크기)와 숨김 프레임(크롬 제외 크기) 사이를 오가며 전 세션에 PTY 리사이즈를
  // 뿌리는 churn을 없애기 위해서다. 리사이즈는 무대에 오른 Operation에만 남는다.
  // 진입 연출을 기다리지 않는다 — 덱은 모드가 서는 첫 프레임부터 자기 자리에 있다.
  const visible = active && (operations.length > 0 || mapOpen);
  const underStage = stagedOperationId !== null;
  const mapLayerOpen = visible && mapOpen;

  // 덱이 한 화면을 넘으면 Map 칩만 밝힌다 — 지도를 저절로 열지 않는다(제품 결정).
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!visible || !grid || typeof ResizeObserver === "undefined") {
      setTriageDeckOverflowing(false);
      return;
    }
    const measure = () => setTriageDeckOverflowing(grid.scrollHeight > grid.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    for (const child of grid.children) observer.observe(child);
    return () => observer.disconnect();
  }, [operations, visible]);
  useEffect(() => () => setTriageDeckOverflowing(false), []);

  // 층이 열리면 초점은 판으로 옮기고, 같은 무대로 닫히면(무대가 없던 채로 닫혀도) 떠나기 전 자리로 돌려준다 —
  // 판은 걷히며 사라지므로 돌려주지 않으면 초점이 문서로 떨어진다. 지목으로 닫혀 무대가 바뀌면 캔버스의 등단
  // 초점이 새 무대를 맡는다.
  const mapReturnRef = useRef<{ readonly focus: Element | null; readonly stageId: string | null } | null>(null);
  const [quickLook, setQuickLook] = useState<{ readonly operationId: string; readonly anchor: DOMRect } | null>(null);
  const [quickLookPlacement, setQuickLookPlacement] = useState<QuickLookPlacement | null>(null);
  useLayoutEffect(() => {
    if (mapLayerOpen) {
      if (mapReturnRef.current) return;
      mapReturnRef.current = { focus: document.activeElement, stageId: stagedOperationId };
      // 「다음」 점이 먼저, 없으면 판이다 — 한 선택자로 묶으면 문서 순서상 조상인 판이 늘 먼저 잡힌다.
      const section = sectionRef.current;
      const target = section?.querySelector<HTMLElement>("[data-fleet-map-dot].is-next") ?? section?.querySelector<HTMLElement>("[data-fleet-map]");
      target?.focus({ preventScroll: true });
      return;
    }
    setQuickLook(null);
    const saved = mapReturnRef.current;
    mapReturnRef.current = null;
    if (!saved || saved.stageId !== stagedOperationId) return;
    const focus = saved.focus;
    if (focus instanceof HTMLElement && focus.isConnected) {
      window.requestAnimationFrame(() => focus.focus({ preventScroll: true }));
    }
  }, [mapLayerOpen, stagedOperationId]);

  useLayoutEffect(() => {
    if (!visible) return;
    const grid = gridRef.current;
    if (!grid) return;
    const recordRects = () => {
      const currentIds = new Set<string>();
      for (const target of grid.querySelectorAll<HTMLElement>("[data-triage-deck-card]")) {
        const operationId = target.dataset.triageDeckCard;
        if (!operationId) continue;
        currentIds.add(operationId);
        deckCardRects.set(operationId, target.getBoundingClientRect());
      }
      for (const operationId of deckCardRects.keys()) {
        if (!currentIds.has(operationId)) deckCardRects.delete(operationId);
      }
    };
    recordRects();
    // 스크롤은 grid 크기를 바꾸지 않아 ResizeObserver가 침묵한다 — viewport 상대 rect는
    // 스크롤마다 갱신해야 승격 flight가 실제 카드 위치에서 출발한다.
    let scrollFrame: number | null = null;
    const handleScroll = () => {
      if (scrollFrame !== null) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = null;
        recordRects();
      });
    };
    grid.addEventListener("scroll", handleScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(recordRects);
    observer?.observe(grid);
    return () => {
      grid.removeEventListener("scroll", handleScroll);
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
      observer?.disconnect();
    };
  }, [operations, visible]);

  // 칸 위의 우클릭은 네이티브 리스너가 판(grid)에서 위임으로 받는다. 칸 안에 선 패널은 캔버스가
  // portal로 들여보낸 것이라 React 트리에서는 캔버스의 자식이다 — 칸에 건 합성 핸들러는 그
  // 캡션에서 일어난 우클릭을 영영 보지 못해 이 판의 메뉴로 오지 않는다. 네이티브 이벤트는 DOM
  // 버블링을 타므로 "물리적으로 칸 안"이라는 사실을 그대로 읽는다 — 프레임이 이식된 body의
  // 클릭을 네이티브로 받는 것과 같은 이유다.
  const deckPointerRef = useRef<{
    openMenu: (operationId: string, event: MouseEvent, host: HTMLElement) => void;
    pick: (operationId: string, element: HTMLElement) => void;
  }>({ openMenu: () => {}, pick: () => {} });
  const quickLookKeyRef = useRef<{ id: string | null; close: () => void }>({ id: null, close: () => {} });
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !visible) return;
    // 무장 본문의 포인터는 캡처에서 끊는다. 칸에 건 합성 핸들러는 portal 본문을 보지 못한다.
    const bodyEvents = ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "dblclick", "auxclick", "click", "contextmenu"] as const;
    const terminalOf = (target: EventTarget | null) => (
      target instanceof Element ? target.closest<HTMLElement>(".canvas-triage-deck-cell .canvas-operation-terminal") : null
    );
    const promote = (cell: HTMLElement) => {
      if (cell.classList.contains("is-quick-look")) return;
      const operationId = cell.dataset.triageDeckCard;
      const surface = cell.querySelector<HTMLElement>(".canvas-triage-deck-pick");
      if (!operationId || !surface) return;
      deckPointerRef.current.pick(operationId, surface);
    };
    const onBodyPointer = (event: Event) => {
      const terminal = terminalOf(event.target);
      if (!terminal) return;
      event.stopPropagation();
      if (event.type === "pointerdown" || event.type === "mousedown") {
        if (event.cancelable) event.preventDefault();
        return;
      }
      if (event.type === "contextmenu" && event instanceof MouseEvent) {
        const cell = terminal.closest<HTMLElement>(".canvas-triage-deck-cell");
        const operationId = cell?.dataset.triageDeckCard;
        if (cell && operationId) deckPointerRef.current.openMenu(operationId, event, cell);
        return;
      }
      // pointerdown 의 preventDefault 는 click 을 취소하지 않는다 — 승격은 click 한 경로다.
      if (event.type !== "click" || (event instanceof MouseEvent && event.button !== 0)) return;
      const cell = terminal.closest<HTMLElement>(".canvas-triage-deck-cell");
      if (!cell) return;
      promote(cell);
    };
    const onFocusIn = (event: FocusEvent) => {
      const terminal = terminalOf(event.target);
      if (!terminal) return;
      const cell = terminal.closest<HTMLElement>(".canvas-triage-deck-cell");
      if (!cell) return;
      const surface = cell.querySelector<HTMLElement>(".canvas-triage-deck-pick");
      if (!cell.classList.contains("is-quick-look")) {
        surface?.focus({ preventScroll: true });
        return;
      }
      // 승격 면에서 거꾸로 들어오면 본문 앞 마지막 컨트롤로 — 아니면 점과의 루프로 보낸다.
      const backward = event.relatedTarget instanceof Node && !!surface && (event.relatedTarget === surface || surface.contains(event.relatedTarget));
      const next = backward
        ? peekDeckTabbables(cell).at(-1) ?? null
        : sectionRef.current?.querySelector<HTMLElement>(`[data-fleet-map-dot="${escapeAttributeValue(cell.dataset.triageDeckCard ?? "")}"]`) ?? null;
      (next ?? surface)?.focus({ preventScroll: true });
    };
    // 리마운트는 패널이 mount 에 직접 붙는 경우뿐이다. 스트리밍 채팅 노드마다 :hover 를 묻지 않는다.
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || !node.classList.contains("canvas-operation")) continue;
          const mount = node.parentElement;
          if (!mount?.classList.contains("canvas-triage-deck-mount")) continue;
          const cell = mount.parentElement;
          if (cell instanceof HTMLElement && cell.classList.contains("canvas-triage-deck-cell") && cell.matches(":hover")) armDeckCell(cell);
        }
      }
    });
    observer.observe(grid, { subtree: true, childList: true });
    // 패널은 portal이라 React enter/leave가 셀을 놓친다. 격자의 네이티브 위임만 무장을 맡는다.
    const cellOf = (target: EventTarget | null) => (
      target instanceof Element ? target.closest<HTMLElement>(".canvas-triage-deck-cell") : null
    );
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const cell = cellOf(event.target);
      if (!cell || armedDeckCell === cell) return;
      armDeckCell(cell);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const cell = cellOf(event.target);
      if (!cell) return;
      const next = cellOf(event.relatedTarget);
      if (next === cell) return;
      disarmDeckCell(cell);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const peek = quickLookKeyRef.current;
      if (!peek.id || !(event.target instanceof Element)) return;
      if (event.key === "Escape") {
        if (event.defaultPrevented || isEditableField(event.target)) return;
        if (!event.target.closest("[data-fleet-map], .canvas-triage-quick-look, .canvas-triage-deck-cell.is-quick-look")) return;
        event.preventDefault();
        peek.close();
        return;
      }
      if (event.key !== "Tab") return;
      const section = sectionRef.current;
      const cell = section?.querySelector<HTMLElement>(".canvas-triage-deck-cell.is-quick-look");
      const dot = section?.querySelector<HTMLElement>(`[data-fleet-map-dot="${escapeAttributeValue(peek.id)}"]`);
      if (!cell || !dot) return;
      const controls = peekDeckTabbables(cell);
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = event.target;
      if (!event.shiftKey && (active === dot || dot.contains(active))) {
        if (!first) return;
        event.preventDefault();
        first.focus({ preventScroll: true });
        return;
      }
      if (event.shiftKey && first && (active === first || first.contains(active))) {
        event.preventDefault();
        dot.focus({ preventScroll: true });
        return;
      }
      if (!event.shiftKey && last && (active === last || last.contains(active))) {
        event.preventDefault();
        dot.focus({ preventScroll: true });
      }
    };
    const section = sectionRef.current;
    grid.addEventListener("pointerover", onPointerOver);
    grid.addEventListener("pointerout", onPointerOut);
    section?.addEventListener("keydown", onKeyDown);
    for (const type of bodyEvents) grid.addEventListener(type, onBodyPointer, true);
    grid.addEventListener("focusin", onFocusIn);
    const onContextMenu = (event: MouseEvent) => {
      if (terminalOf(event.target)) return;
      const cell = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-triage-deck-card]") : null;
      const operationId = cell?.dataset.triageDeckCard;
      if (!cell || !operationId) return;
      deckPointerRef.current.openMenu(operationId, event, cell);
    };
    grid.addEventListener("contextmenu", onContextMenu);
    return () => {
      observer.disconnect();
      if (armedDeckCell) disarmDeckCell(armedDeckCell);
      grid.removeEventListener("pointerover", onPointerOver);
      grid.removeEventListener("pointerout", onPointerOut);
      section?.removeEventListener("keydown", onKeyDown);
      for (const type of bodyEvents) grid.removeEventListener(type, onBodyPointer, true);
      grid.removeEventListener("focusin", onFocusIn);
      grid.removeEventListener("contextmenu", onContextMenu);
    };
  }, [visible]);

  // Quick-Look — 숨은 덱 칸의 실제 패널을 그 크기 그대로 지도 위로 들어 올린다. 칸은 격자에 남아
  // 자리를 지키고(형제 칸이 흐르지 않는다), 마운트만 고정 배치로 뜬다. 크기가 같아 PTY는 리사이즈되지
  // 않고, portal 대상도 그대로라 패널은 remount되지 않는다. 무대는 건드리지 않는다.
  useLayoutEffect(() => {
    if (!quickLook || !mapLayerOpen) {
      setQuickLookPlacement(null);
      return;
    }
    const section = sectionRef.current;
    const root = section?.closest<HTMLElement>(".operations-canvas") ?? null;
    const plate = section?.querySelector<HTMLElement>(".canvas-fleet-map-plate") ?? null;
    const cell = section?.querySelector<HTMLElement>(`[data-triage-deck-card="${escapeAttributeValue(quickLook.operationId)}"]`) ?? null;
    const mount = cell?.querySelector<HTMLElement>(".canvas-triage-deck-mount") ?? null;
    if (!section || !root || !plate || !cell || !mount) {
      setQuickLook(null);
      return;
    }
    const size = mount.getBoundingClientRect();
    const bounds = plate.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    const width = size.width + QUICK_LOOK_PAD_PX * 2;
    const height = size.height + QUICK_LOOK_PAD_PX * 2;
    const anchor = quickLook.anchor;
    const keepOut = { left: bounds.right - TRIAGE_MAP_DOCK_KEEP_OUT.width, top: bounds.bottom - TRIAGE_MAP_DOCK_KEEP_OUT.height };
    const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));
    // 점 오른쪽이 먼저, 모자라면 왼쪽이다. 세로는 점 높이에 맞추고 판 안으로 끌어들인다.
    let left = anchor.right + 14 + width <= bounds.right - 8 ? anchor.right + 14 : anchor.left - 14 - width;
    left = clamp(left, bounds.left + 8, bounds.right - 8 - width);
    let top = clamp(anchor.top + anchor.height / 2 - height / 2, bounds.top + 8, bounds.bottom - 8 - height);
    // 권한 독의 자리에 걸리면 그 위로 올린다 — 올릴 곳이 없으면 독의 왼쪽으로 비킨다.
    if (left + width > keepOut.left && top + height > keepOut.top) {
      if (keepOut.top - 8 - height >= bounds.top + 8) top = keepOut.top - 8 - height;
      else left = clamp(keepOut.left - 8 - width, bounds.left + 8, bounds.right - 8 - width);
    }
    const frame = { left: left - origin.left, top: top - origin.top, width, height };
    cell.classList.add("is-quick-look");
    // 마운트는 잠그지 않는다. 본문만 프레임의 inert 기본값이고, 포인터가 칸 위에 남아 있으면 그것만 다시 푼다.
    mount.style.setProperty("left", `${frame.left + QUICK_LOOK_PAD_PX}px`);
    mount.style.setProperty("top", `${frame.top + QUICK_LOOK_PAD_PX}px`);
    mount.style.setProperty("width", `${size.width}px`);
    mount.style.setProperty("height", `${size.height}px`);
    const hoverFrame = window.requestAnimationFrame(() => {
      if (cell.isConnected && cell.matches(":hover")) armDeckCell(cell);
    });
    setQuickLookPlacement({ operationId: quickLook.operationId, frame });
    return () => {
      window.cancelAnimationFrame(hoverFrame);
      cell.classList.remove("is-quick-look");
      if (!cell.matches(":hover")) disarmDeckCell(cell);
      for (const property of ["left", "top", "width", "height"]) mount.style.removeProperty(property);
    };
  }, [quickLook, mapLayerOpen]);
  // 엿보기를 닫으면 초점은 그것을 연 점으로 돌아간다 — 빈 곳을 눌러 닫아도 초점이 판으로 흩어지지 않게.
  const closeQuickLook = () => {
    const operationId = quickLook?.operationId;
    setQuickLook(null);
    if (operationId) sectionRef.current?.querySelector<HTMLElement>(`[data-fleet-map-dot="${escapeAttributeValue(operationId)}"]`)?.focus({ preventScroll: true });
  };
  quickLookKeyRef.current = { id: quickLook?.operationId ?? null, close: closeQuickLook };
  // 엿보던 Operation이 판에서 내려가면(최소화·보관) 틀을 걷고, 초점은 그 점으로 — 점이 없으면 판으로.
  useEffect(() => {
    if (!quickLook || operations.some((operation) => operation.id === quickLook.operationId)) return;
    const operationId = quickLook.operationId;
    setQuickLook(null);
    const section = sectionRef.current;
    const dot = section?.querySelector<HTMLElement>(`[data-fleet-map-dot="${escapeAttributeValue(operationId)}"]`);
    const plate = section?.querySelector<HTMLElement>("[data-fleet-map]");
    (dot ?? plate)?.focus({ preventScroll: true });
  }, [operations, quickLook]);

  if (!visible) return null;

  const idleArrivalIds = getIdleArrivalIds();
  const counts = resolveTriageCounts(operations, operationRuntime);
  // flattenGroupedOrder 안의 sortOperationsByOrder가 durable order를 먼저 적용한다.
  // 상태축·주의 큐와 독립된 그룹 화면 순서이며, 밴드도 Theater 목록 순서를 그대로 따른다.
  const bands = theaters.map((theater) => {
    const theaterOperations = operations.filter((operation) => operation.theaterId === theater.id);
    return {
      theater,
      operations: flattenGroupedOrder(theaterOperations, groups.filter((group) => group.theaterId === theater.id), operationOrderFromNodes(theaterOperations)),
      counts: resolveTriageCounts(theaterOperations, operationRuntime),
    };
  }).filter((band) => band.operations.length > 0);
  const pick = (operationId: string, element: HTMLElement) => {
    // 승격 flight는 클릭 순간 사용자가 보고 있는 위치에서 출발해야 한다 — tween이 살아 있으면
    // 카드가 움직이는 중이라 좌표가 흔들리므로 먼저 스냅 종료하고, 그 다음 rect를 출발 전용 채널에 기록한다.
    onBeforePick?.();
    deckDepartureRect = { operationId, rect: element.getBoundingClientRect() };
    revealOperationStage();
    pickTriageOperation(operationId);
  };
  const openOperationMenu = (operationId: string, event: ReactMouseEvent<HTMLElement> | MouseEvent, host?: HTMLElement) => {
    event.preventDefault();
    event.stopPropagation();
    // 포커스 복귀 대상은 포커스를 받을 수 있는 요소여야 한다 — 칸에서 연 메뉴는 그 칸의
    // 승격 면으로 돌아간다(칸 자신은 tabindex를 갖지 않는다).
    const anchorHost = host ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
    const returnFocus = anchorHost instanceof HTMLButtonElement
      ? anchorHost
      : anchorHost?.querySelector<HTMLElement>(".canvas-triage-deck-pick") ?? null;
    onOperationContextMenu?.(operationId, new DOMRect(event.clientX, event.clientY, 0, 0), returnFocus);
  };
  // 위임 리스너가 읽는 최신 핸들러 — effect는 한 번만 붙고, 매 렌더의 값은 이 ref로 건넨다.
  deckPointerRef.current = { openMenu: openOperationMenu, pick };
  const openOperationMenuFromKeyboard = (operationId: string, event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return false;
    event.preventDefault();
    event.stopPropagation();
    onOperationContextMenu?.(operationId, event.currentTarget.getBoundingClientRect(), event.currentTarget);
    return true;
  };
  const openTheaterMenu = (theater: TriageDeckTheater, event: ReactMouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.target instanceof Element && event.target.closest("[data-triage-deck-card]")) return;
    event.preventDefault();
    event.stopPropagation();
    onTheaterContextMenu?.(theater.id, { x: event.clientX, y: event.clientY });
  };
  // 대기 쪽 수치 — 치워둔 대기는 대기와 따로 말한다. 막대·덱·지도가 같은 셈을 읽는다.
  const attentionParts = (value: typeof counts) => ([
    [value.waiting, "canvas.triage.waitingCount"],
    [value.unseen, "canvas.triage.unseenCount"],
    [value.setAside, "canvas.triage.setAsideCount"],
  ] as const).filter(([count]) => count > 0).map(([count, key]) => t(key, { count }));
  // 「모두 정리됨」은 치워둔 대기까지 없을 때만 말한다 — 치워둔 건이 있으면 정리된 것이 아니다.
  const caption = [
    ...attentionParts(counts),
    ...(counts.waiting + counts.unseen > 0
      ? []
      : counts.setAside > 0
        ? [t("canvas.triage.runningCount", { count: counts.running }), t("canvas.triage.idleCount", { count: counts.idle })]
        : [t("canvas.triage.deckCaption", counts)]),
  ].join(" · ");

  // 지도의 대기열 표식 — 막대와 같은 순서다: 무대, 「다음」, 그 뒤 순번, 미룸은 맨 뒤, 치워둠은 따로.
  const mapMarks = new Map<string, FleetMapDotMark>();
  if (mapLayerOpen) {
    const queueIds = resolveTriageQueue(operations, operationRuntime).map((entry) => entry.operation.id);
    const nextId = queueIds.find((id) => id !== stagedOperationId) ?? null;
    if (stagedOperationId !== null) mapMarks.set(stagedOperationId, { kind: "stage" });
    let order = 1;
    for (const id of queueIds) {
      if (id === stagedOperationId) continue;
      if (isTriageOperationDeferred(id)) mapMarks.set(id, { kind: "deferred" });
      else mapMarks.set(id, id === nextId ? { kind: "next" } : { kind: "order", order });
      order += 1;
    }
    for (const operation of operations) {
      if (!mapMarks.has(operation.id) && isTriageOperationDismissed(operation.id) && isTriageWaitingOperation(operation, operationRuntime)) {
        mapMarks.set(operation.id, { kind: "set-aside" });
      }
    }
  }
  // 보류 수는 Map 칩과 같은 파생값이다(대기열 순서) — 머리 버튼은 대기열에서 가장 앞선 보류 건을 올린다.
  const heldArrivalIds = mapLayerOpen ? getTriageMapHeldQueueIds() : [];
  // 대기 점은 무대로 오른다. 그 밖의 점은 무대를 바꾸지 않고 Quick-Look으로 엿본다.
  const activateDot = (operationId: string, element: HTMLElement) => {
    const operation = operations.find((candidate) => candidate.id === operationId);
    if (!operation) return;
    if (isTriageWaitingOperation(operation, operationRuntime) || operationId === stagedOperationId) {
      setQuickLook(null);
      onBeforePick?.();
      deckDepartureRect = { operationId, rect: element.getBoundingClientRect() };
      revealOperationStage();
      pickTriageOperation(operationId);
      return;
    }
    // 엿보기는 점과 이름표를 함께 비켜 선다 — 점만 비키면 틀이 그 점의 이름을 덮는다.
    const dot = element.getBoundingClientRect();
    const label = element.querySelector(".canvas-fleet-map-dot-label")?.getBoundingClientRect() ?? dot;
    const left = Math.min(dot.left, label.left);
    const right = Math.max(dot.right, label.right);
    setQuickLook((current) => current?.operationId === operationId ? null : { operationId, anchor: new DOMRect(left, dot.top, right - left, dot.height) });
  };
  const quickLookOperation = quickLookPlacement
    ? operations.find((operation) => operation.id === quickLookPlacement.operationId) ?? null
    : null;
  const mapShortcut = shortcutCommandLabel("operations.toggle-war-room-map");
  return (
    <section
      ref={sectionRef}
      className={`canvas-triage-deck ${underStage ? "is-under-stage" : ""} ${mapLayerOpen ? "is-map-open" : ""}`}
      data-canvas-blocker
      onClick={(event) => {
        // 엿보는 동안 지도의 빈 곳을 누르면 엿보기가 걷힌다 — 점(다른 점 엿보기·무대)과 머리의 버튼은 제 일을 한다.
        if (!quickLook || !(event.target instanceof Element)) return;
        if (!event.target.closest("[data-fleet-map]") || event.target.closest("[data-fleet-map-dot], button")) return;
        closeQuickLook();
      }}
    >
      <div className="canvas-triage-deck-caption">{caption}</div>
      {mapLayerOpen ? (
        <FleetMap
          theaters={theaters}
          operations={operations}
          operationRuntime={operationRuntime}
          operationRuntimeHydration={operationRuntimeHydration}
          geometryFor={geometryFor}
          marks={mapMarks}
          peekOperationId={quickLook?.operationId ?? null}
          keepOut={TRIAGE_MAP_DOCK_KEEP_OUT}
          header={<>
            <span className="canvas-fleet-map-title">{t("canvas.fleetMap.title")}</span>
            <span className="canvas-fleet-map-counts">
              {[...attentionParts(counts), t("canvas.triage.runningCount", { count: counts.running }), t("canvas.triage.idleCount", { count: counts.idle })].join(" · ")}
            </span>
            {heldArrivalIds.length > 0 ? (
              <button type="button" className="canvas-fleet-map-action is-held" onClick={() => { revealOperationStage(); pickTriageOperation(heldArrivalIds[0]!); }}>
                {t("canvas.fleetMap.heldStage", { count: heldArrivalIds.length })}
              </button>
            ) : null}
            <button type="button" className="canvas-fleet-map-action" onClick={closeTriageMap}
              aria-keyshortcuts={mapShortcut || undefined}>
              {t("canvas.fleetMap.close")}{mapShortcut ? <kbd>{mapShortcut}</kbd> : null}
            </button>
          </>}
          onActivate={activateDot}
          onOperationContextMenu={onOperationContextMenu}
          onTheaterContextMenu={onTheaterContextMenu}
        />
      ) : null}
      {quickLookPlacement && quickLookOperation ? (
        <div
          className="canvas-triage-quick-look"
          role="region"
          aria-label={t("canvas.fleetMap.quickLookAria", { title: quickLookOperation.title })}
          style={{
            left: `${quickLookPlacement.frame.left}px`,
            top: `${quickLookPlacement.frame.top}px`,
            width: `${quickLookPlacement.frame.width}px`,
            height: `${quickLookPlacement.frame.height}px`,
          }}
        />
      ) : null}
      <div className="canvas-triage-deck-grid" ref={gridRef}>
        {bands.map((band) => {
          return (
            <section
              className="canvas-triage-deck-band"
              key={band.theater.id}
              onContextMenu={(event) => openTheaterMenu(band.theater, event)}
            >
              <header className="canvas-triage-deck-band-head">
                <span className="canvas-triage-deck-band-chip" aria-hidden="true">{theaterInitials(band.theater.label)}</span>
                <span className="canvas-triage-deck-band-label">{band.theater.label}</span>
                <span className="canvas-triage-deck-band-rule" aria-hidden="true" />
                <span className="canvas-triage-deck-band-counts">
                  {[
                    ...attentionParts(band.counts),
                    ...([
                      [band.counts.running, "canvas.triage.runningCount"],
                      [band.counts.idle, "canvas.triage.idleCount"],
                    ] as const).filter(([count]) => count > 0).map(([count, key]) => t(key, { count })),
                  ].join(" · ")}
                </span>
              </header>
              <div className="canvas-triage-deck-band-body">
                <div className="canvas-triage-deck-band-cards">
                  {band.operations.map((operation) => renderCell(operation))}
                </div>
              </div>
            </section>
          );
          function renderCell(operation: OperationNode) {
                    const activity = resolveOperationActivity(operation, operationRuntime);
                    const visual = resolveOperationMarkVisual({ activity, operationId: operation.id, idleArrivalIds });
                    return (
                      // 칸은 자리이지 물건이 아니다 — 이 안에 서는 것은 캔버스가 소유한 그
                      // Operation의 실제 패널이고(canvas가 portal로 들여보낸다), 칸은 자리·배율·
                      // 변형만 진다. 카드 얼굴을 따로 그리던 종전 구조에서는 같은 Operation이
                      // 밀도마다 다른 물건으로 그려졌고, 축소가 transform이라 글자도 함께 뭉갰다.
                      <div
                        className={`canvas-triage-deck-cell is-${visual} ${arrivingOperationId === operation.id ? "is-arriving" : ""} ${freshOperationIds?.has(operation.id) ? "is-fresh" : ""}`}
                        key={operation.id}
                        data-triage-deck-card={operation.id}
                      >
                        {/* 패널이 들어올 자리 — 캔버스가 이 노드로 portal한다. React 자식을 두지
                            않는 빈 노드여야 한다: portal 대상에 React가 관리하는 형제가 섞이면
                            자식 조정과 portal 삽입이 서로의 DOM을 밀어낸다.
                            그래서 폴백도 자식이 아니라 CSS가 :empty에 그린다 — 플러그인이 사라졌거나
                            render를 내주지 않는 kind는 캔버스가 프레임을 만들지 못해 이 자리가 끝까지
                            비는데, 이름 없는 빈 칸은 어느 Operation을 올리는 것인지 말해 주지 못한다. */}
                        <div
                          className="canvas-triage-deck-mount"
                          data-fallback-title={operation.title}
                          ref={slotRefFor(operation.id)}
                        />
                        {/* 무대로 올리는 면 — 덱에서 패널의 본문은 읽는 것이지 조작하는 것이
                            아니다. 본문 위를 덮어 클릭 한 번을 승격으로 받고, 캡션은 그 위에 남아
                            창 컨트롤이 자기 클릭을 지킨다. */}
                        <button
                          className="canvas-triage-deck-pick"
                          type="button"
                          aria-label={t("canvas.triage.deckCardAria", { title: operation.title })}
                          aria-haspopup="menu"
                          onKeyDown={(event) => { openOperationMenuFromKeyboard(operation.id, event); }}
                          onClick={(event) => pick(operation.id, event.currentTarget)}
                        />
                      </div>
                    );
          }
        })}
      </div>
    </section>
  );
}

function escapeAttributeValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
