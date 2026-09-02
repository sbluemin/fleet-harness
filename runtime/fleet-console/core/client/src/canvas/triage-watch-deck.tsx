import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";
import type { OperationActivityVisual } from "../operation-activity.js";

import { useT } from "../i18n/index.js";
import { getIdleArrivalIds, useOperationStatusDetails } from "../operation-marks.js";
import { operationActivityVisual, resolveOperationActivity, resolveOperationDisplayActivity } from "../operation-activity.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import type { OperationNode } from "../types.js";
import {
  clampTriageDeckZoom,
  getTriageDeckZoom,
  getTriageDeckZoomLive,
  isTriageActive,
  nextTriageDeckZoomPreset,
  pickTriageOperation,
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
  readonly entering: boolean;
  /** 전 Theater 목록 — deck는 Theater 밴드로 갈라 전 Theater의 휴면 아닌 Operation을 올린다. */
  readonly theaters: readonly TriageDeckTheater[];
  readonly operations: readonly OperationNode[];
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

// 카드 정렬 등급 — 사이드바 STATUS 축의 섹션 순서(대기→실행 중→백그라운드→유휴→휴면)를 그대로
// 따른다. deck이 자체 순서를 정의하면 같은 상태가 두 표면에서 다른 위치로 읽힌다.
const TRIAGE_DECK_ACTIVITY_RANK: Record<OperationActivityVisual, number> = {
  awaiting: 0,
  running: 1,
  background: 2,
  idle: 3,
  ended: 4,
};
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
// wheel 문법: bare wheel은 덱 줌(캔버스와 동일), shift+wheel은 카드 격자 스크롤, alt는 건드리지 않는다.
export interface TriageDeckZoomControl {
  readonly snapZoomTween: () => void;
  /** 프리셋 등 외부 배율 변경도 이 경로로 — 영속은 settle 시 휠과 동일하게. */
  readonly setZoomTarget: (zoom: number) => void;
  readonly attachWheelListener: (element: HTMLElement) => () => void;
}

const TRIAGE_DECK_ZOOM_TWEEN_FACTOR = 0.18;
const TRIAGE_DECK_ZOOM_TWEEN_EPSILON = 0.002;
const TRIAGE_DECK_ZOOM_WHEEL_SPEED = 0.0022;

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

  useEffect(() => {
    stopTween();
    const initial = getTriageDeckZoom();
    zoomRef.current = initial;
    targetRef.current = initial;
    lastDisplayRef.current = null;
    applyZoom(initial);
    return stopTween;
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
      const handleWheel = (event: WheelEvent) => {
        // 덱 줌은 triage 모드 안에서, 덱 위에서만 발화한다 — 무경계 소비는 자유 캔버스의
        // 기존 줌과 이중 소비되고 브라우저 페이지 줌을 전역 차단한다.
        if (!isTriageActive()) return;
        if (!(event.target instanceof Element) || event.target.closest(".canvas-triage-deck") === null) return;
        // Alt 제스처는 건드리지 않는다.
        if (event.altKey) return;
        // deltaMode 정규화 — Firefox 물리 휠은 line(1)/page(2) 단위로 보고한다. 픽셀 튜닝된
        // 지수·스크롤 경로에 그대로 넣으면 한 노치가 0.7% 줌이 되거나 페이지 단위로 튄다.
        const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? Math.max(240, element.clientHeight)
            : 1;
        // Shift+wheel은 카드 격자 세로 스크롤.
        if (event.shiftKey) {
          const grid = event.target.closest(".canvas-triage-deck")?.querySelector(".canvas-triage-deck-grid");
          if (!(grid instanceof HTMLElement)) return;
          event.preventDefault();
          // 일부 브라우저·트랙패드는 Shift+wheel을 deltaX로 보고한다 — 세로 스크롤로 수렴시킨다.
          grid.scrollTop += (event.deltaY !== 0 ? event.deltaY : event.deltaX) * deltaScale;
          return;
        }
        // bare wheel과 Ctrl/Meta+wheel 모두 덱 줌 — 브라우저 페이지 줌 차단도 유지한다.
        event.preventDefault();
        const zoom = zoomRef.current;
        // 밀도는 1×~2×만 — 그 아래는 카드가 읽히지 않는 구간이고, 함대 지도는 Cruise 축소가 맡는다.
        const next = clampTriageDeckZoom(zoom * Math.exp(-event.deltaY * deltaScale * TRIAGE_DECK_ZOOM_WHEEL_SPEED));
        if (next === zoom) return;
        applyZoom(next);
        setTargetZoom(next);
      };
      element.addEventListener("wheel", handleWheel, { passive: false });
      return () => {
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
  entering,
  theaters,
  operations,
  operationRuntime,
  operationAccent,
  arrivingOperationId = null,
  stagedOperationId = null,
  onBeforePick,
  onPanelSlotRef,
  freshOperationIds,
  onOperationContextMenu,
  onTheaterContextMenu,
}: TriageWatchDeckProps) {
  const t = useT();
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
  const visible = active && !entering && operations.length > 0;
  const underStage = stagedOperationId !== null;

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
  }>({ openMenu: () => {} });
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !visible) return;
    const onContextMenu = (event: MouseEvent) => {
      const cell = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-triage-deck-card]")
        : null;
      const operationId = cell?.dataset.triageDeckCard;
      if (!cell || !operationId) return;
      deckPointerRef.current.openMenu(operationId, event, cell);
    };
    grid.addEventListener("contextmenu", onContextMenu);
    return () => {
      grid.removeEventListener("contextmenu", onContextMenu);
    };
  }, [visible]);

  if (!visible) return null;

  const idleArrivalIds = getIdleArrivalIds();
  const displayActivity = (operation: OperationNode) => resolveOperationDisplayActivity({
    activity: resolveOperationActivity(operation, operationRuntime),
    operationId: operation.id,
    idleArrivalIds,
  });
  const activities = operations.map(displayActivity);
  const running = activities.filter((activity) => activity === "running").length;
  const idle = activities.filter((activity) => activity === "idle").length;
  // 밴드 순서: 대기 카드 수 내림차순 → 같으면 theaters 선언 순. 카드 없는 Theater는 밴드를 그리지 않는다.
  // 헤더 수치는 밴드 정렬과 같은 대기 판정(isTriageWaitingOperation)을 쓴다 — 유휴 도착을 정렬은 대기로
  // 치면서 수치는 0으로 보이면 큐·사이드바 카운트와 모순된다. 대기로 센 유휴 도착은 유휴 수에서 뺀다.
  const theaterBands = theaters
    .map((theater, theaterIndex) => {
      const theaterOperations = operations
        .filter((operation) => operation.theaterId === theater.id)
        .sort((left, right) => TRIAGE_DECK_ACTIVITY_RANK[displayActivity(left)]
          - TRIAGE_DECK_ACTIVITY_RANK[displayActivity(right)]);
      const waitingIds = new Set(
        theaterOperations
          .filter((operation) => displayActivity(operation) === "awaiting")
          .map((operation) => operation.id),
      );
      const counts = {
        waiting: waitingIds.size,
        running: theaterOperations.filter((operation) => displayActivity(operation) === "running").length,
        idle: theaterOperations.filter((operation) =>
          displayActivity(operation) === "idle" && !waitingIds.has(operation.id)).length,
      };
      return { theater, theaterIndex, operations: theaterOperations, counts };
    })
    .filter((band) => band.operations.length > 0)
    .sort((left, right) => right.counts.waiting - left.counts.waiting || left.theaterIndex - right.theaterIndex);
  const bands = theaterBands;
  const pick = (operationId: string, element: HTMLElement) => {
    // 승격 flight는 클릭 순간 사용자가 보고 있는 위치에서 출발해야 한다 — tween이 살아 있으면
    // 카드가 움직이는 중이라 좌표가 흔들리므로 먼저 스냅 종료하고, 그 다음 rect를 출발 전용 채널에 기록한다.
    onBeforePick?.();
    deckDepartureRect = { operationId, rect: element.getBoundingClientRect() };
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
  deckPointerRef.current = { openMenu: openOperationMenu };
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
  return (
    <section
      className={`canvas-triage-deck ${underStage ? "is-under-stage" : ""}`}
      data-canvas-blocker
    >
      <div className="canvas-triage-deck-caption">
        {t("canvas.triage.deckCaption", { running, idle })}
      </div>
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
                  {t("canvas.triage.bandCounts", { waiting: band.counts.waiting, running: band.counts.running, idle: band.counts.idle })}
                </span>
              </header>
              <div className="canvas-triage-deck-band-body">
                <div className="canvas-triage-deck-band-cards">
                  {band.operations.map((operation) => {
                    const activity = displayActivity(operation);
                    const visual = operationActivityVisual(activity);
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
                  })}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function escapeAttributeValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
