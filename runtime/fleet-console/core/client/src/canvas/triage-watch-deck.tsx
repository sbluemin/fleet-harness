import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { OperationRuntimeState } from "@fleet-console/sdk/plugin";
import type { OperationActivityVisual } from "../operation-activity.js";

import { useT } from "../i18n/index.js";
import { getIdleArrivalIds, useOperationStatusDetails } from "../operation-marks.js";
import { operationActivityVisual, operationMarkVisual, resolveOperationActivity, resolveOperationDisplayActivity, resolveOperationMarkVisual } from "../operation-activity.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import type { OperationGeometry, OperationNode } from "../types.js";
import {
  clampTriageDeckZoom,
  getTriageDeckZoom,
  getTriageDeckZoomLive,
  hashTriageMapKey,
  isTriageActive,
  isTriageDeckMapMode,
  isTriageDeckMapModeActive,
  isTriageOperationDeferred,
  nextTriageDeckZoomPreset,
  pickTriageOperation,
  clampTriageMapPercent,
  projectTriageMapDeltaToGeometry,
  resolveTriageFleetZoneLayout,
  resolveTriageMapMarkerLayout,
  resolveTriageMapProjection,
  setTriageMapMarkerOverride,
  setTriageDeckMapModeLive,
  setTriageDeckZoom,
  setTriageDeckZoomLive,
  subscribeTriage,
  TRIAGE_DECK_CARD_BASE_MIN_PX,
  TRIAGE_DECK_ZOOM_DEFAULT,
  type TriageMapProjection,
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
  /** 줌 tween 즉시 스냅 — 카드/지도 점 클릭 직전에 호출해 승격 flight의 출발 rect를 고정한다. */
  readonly onBeforePick?: () => void;
  /** 지도 마커용 유효 geometry — durable DTO보다 라이브 캔버스 배치가 정본이다(드래그 직후
      PATCH 왕복 대기·실패, DTO null인 자동 배치 op). canvas가 자기 스토어로 해석해 넘긴다. */
  readonly mapGeometryFor?: (operation: OperationNode) => OperationGeometry | null;
  /** 칸이 마운트·해제될 때마다 그 자리를 캔버스에 알린다 — 캔버스는 이 자리로 그 Operation의
      실제 패널을 portal한다. 덱이 그리는 것은 자리와 배율이고, 패널은 끝까지 캔버스 소유다. */
  readonly onPanelSlotRef?: (operationId: string, element: HTMLElement | null) => void;
  /** 스포트라이트 OFF에서 검토 전인 대기 카드 — 지속 aurora 맥동(is-fresh)을 얹는다. */
  readonly freshOperationIds?: ReadonlySet<string>;
  /** 지도에서 마커를 끌어 옮겼을 때의 새 캔버스 좌표 — 지도는 함대의 축소판이므로 여기서 옮긴
      자리가 곧 캔버스에서의 자리다. 전 Theater가 올라오므로 소속 Theater를 함께 넘긴다. */
  readonly onMapMarkerMove?: (operationId: string, theaterId: string, geometry: OperationGeometry) => void;
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
const TRIAGE_DECK_QUICKLOOK_DWELL_MS = 400;

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

export interface TriageMorphFrame {
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
}

// 밀도 전환은 두 표면의 교대가 아니라 같은 함대의 변형이다 — 카드가 자기 점이 설 자리로
// 날아가 수축하고(지도 진입), 점이 있던 자리에서 카드가 자라난다(지도 이탈). 두 방향 모두
// "카드를 점 자리에 놓는" 한 장의 프레임으로 기술되고, 방향은 재생 순서가 정한다.
// 배율은 균등하게 잡는다 — 축별로 다르면 카드가 찌그러지며 빨려 들어간다.
export function resolveTriageMorphFrame(cardRect: DOMRect, dotRect: DOMRect): TriageMorphFrame {
  return {
    dx: (dotRect.left + dotRect.width / 2) - (cardRect.left + cardRect.width / 2),
    dy: (dotRect.top + dotRect.height / 2) - (cardRect.top + cardRect.height / 2),
    scale: Math.min(
      dotRect.width / Math.max(1, cardRect.width),
      dotRect.height / Math.max(1, cardRect.height),
    ),
  };
}

// CSS 쪽 전환 길이(--duration-slow * 1.15 ≈ 414ms)보다 넉넉히 길게 잡아 전환이 끝나기 전에
// 프레임이 걷히는 일을 막는다.
const TRIAGE_DECK_MORPH_MS = 470;

interface TriageDeckMorph {
  readonly phase: "to-map" | "to-cards";
  readonly frames: ReadonlyMap<string, TriageMorphFrame>;
  /** 프레임이 실제로 적용되는 단계인지 — to-map은 적용이 곧 재생이고, to-cards는 적용(무전이)
      뒤 다음 프레임에 걷어내는 것이 재생이다(FLIP invert & play). */
  readonly applied: boolean;
}

export interface TriageMapQuicklookPlacement {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

// 지도 Quick-Look 기본 크기 — 1.0× 카드를 1.95배로 키운 판독 크기다. 지도 모드의 실제 카드
// 배율은 판독 한계 아래라, 점의 확대창을 그 배율에 묶으면 확대해도 읽히지 않는다. 확대창은
// "1.0× 카드를 읽을 수 있는 크기로 키운 것"이라는 하나의 크기 계약을 따른다.
const TRIAGE_MAP_QUICKLOOK_SCALE = 1.95;
export const TRIAGE_MAP_QUICKLOOK_WIDTH = Math.round(TRIAGE_DECK_CARD_BASE_MIN_PX * TRIAGE_MAP_QUICKLOOK_SCALE);
export const TRIAGE_MAP_QUICKLOOK_HEIGHT = Math.round(150 * TRIAGE_MAP_QUICKLOOK_SCALE);
const TRIAGE_MAP_QUICKLOOK_MARGIN = 8;
const TRIAGE_MAP_QUICKLOOK_GAP = 14;

// 확대창은 점에 붙는다 — 툴팁과 같은 앵커 문법이다. 점 중앙에 얹고 경계로 밀어내면 판
// 가장자리의 점일수록 창이 포인터에서 멀리 떨어져 "다른 곳에서 열린 창"으로 읽힌다.
// 기본은 점의 오른쪽 아래, 그쪽이 좁으면 반대편으로 뒤집고, 양쪽 다 좁을 때만 경계로 민다.
// 판이 확대창보다 좁으면 크기 자체를 판에 맞춰 깎는다 — 좁은 창에서는 정직하게 열화한다.
// position: fixed의 실제 원점 — 뷰포트라는 보장이 없다. transform·filter·contain을 가진 조상이
// 하나라도 있으면 그 조상이 containing block이 되고, 뷰포트 좌표를 그대로 실은 창은 그 조상의
// 오프셋만큼 밀려난다. 규칙을 거슬러 올라가며 추측하는 대신, 같은 부모에 0×0 프로브를 잠깐 세워
// 그 원점을 직접 잰다 — 어떤 속성이 컨테이닝 블록을 만들었는지 알 필요가 없다.
function resolveFixedOrigin(host: HTMLElement): { readonly x: number; readonly y: number } {
  const probe = host.ownerDocument.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;visibility:hidden;";
  host.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  return { x: rect.left, y: rect.top };
}

export function resolveTriageMapQuicklookPlacement(
  dotRect: DOMRect,
  gridRect: DOMRect,
  width = TRIAGE_MAP_QUICKLOOK_WIDTH,
  height = TRIAGE_MAP_QUICKLOOK_HEIGHT,
): TriageMapQuicklookPlacement {
  const margin = TRIAGE_MAP_QUICKLOOK_MARGIN;
  const gap = TRIAGE_MAP_QUICKLOOK_GAP;
  const boxWidth = Math.max(1, Math.min(width, gridRect.width - margin * 2));
  const boxHeight = Math.max(1, Math.min(height, gridRect.height - margin * 2));
  const anchor = (start: number, end: number, span: number, box: number) => {
    // start/end는 점의 양 끝(판 기준). 오른쪽(아래)에 붙여 보고, 넘치면 왼쪽(위)으로 뒤집는다.
    const after = end + gap;
    if (after + box + margin <= span) return after;
    const before = start - gap - box;
    if (before >= margin) return before;
    // 어느 쪽도 못 담으면 점 중앙을 기준으로 경계 안에 밀어 넣는다.
    const centered = (start + end) / 2 - box / 2;
    return Math.max(margin, Math.min(centered, Math.max(margin, span - box - margin)));
  };
  const left = dotRect.left - gridRect.left;
  const top = dotRect.top - gridRect.top;
  return {
    left: anchor(left, left + dotRect.width, gridRect.width, boxWidth),
    top: anchor(top, top + dotRect.height, gridRect.height, boxHeight),
    width: boxWidth,
    height: boxHeight,
  };
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
  const target = document.querySelector<HTMLElement>(`[data-triage-map-dot="${escaped}"]`)
    ?? document.querySelector<HTMLElement>(`[data-triage-deck-card="${escaped}"]`);
  if (target) {
    const rect = target.getBoundingClientRect();
    deckCardRects.set(operationId, rect);
    return rect;
  }
  return deckCardRects.get(operationId) ?? null;
}

// 줌/지도 오버레이 제어는 deck와 rail의 공용 컨트롤러다. rAF tween과 wheel 부착은 React 합성
// 이벤트 밖에서 다뤄야 한다 — React는 root wheel을 passive로 묶어 preventDefault가 무용해진다.
// wheel 문법: bare wheel은 덱 줌(캔버스와 동일), shift+wheel은 카드 격자 스크롤, alt는 건드리지 않는다.
export interface TriageDeckZoomControl {
  readonly snapZoomTween: () => void;
  /** 프리셋 등 외부 배율 변경도 이 경로로 — store 선기록은 tween 시작 프레임에 지도 판정
      폴백을 뒤집어 잘못된 모드가 한 프레임 번쩍인다. 영속은 settle 시 휠과 동일하게. */
  readonly setZoomTarget: (zoom: number) => void;
  readonly attachWheelListener: (element: HTMLElement) => () => void;
}

// 밀도 신호 — 줌 컨트롤러가 판의 칸 크기를 실제로 바꾼 프레임에만 울린다. store의 라이브 배율은
// 표시용으로 소수 첫째 자리까지만 실리므로(매 프레임 emit이 캔버스를 통째로 리렌더하는 것을 막는
// 장치다) 트랙패드의 작은 델타를 놓치고, 칸 크기를 정하는 CSS 변수는 줌 컨트롤러가 캔버스에 쓴다 —
// 덱이 그 요소를 알아내 관찰하는 것은 배치에 기대는 결합이라, 값을 쓰는 쪽이 직접 알린다.
const deckDensityListeners = new Set<() => void>();

function subscribeDeckDensity(listener: () => void): () => void {
  deckDensityListeners.add(listener);
  return () => { deckDensityListeners.delete(listener); };
}

function emitDeckDensityChange(): void {
  for (const listener of [...deckDensityListeners]) listener();
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
      // 칸 크기를 정하는 값 중 하나라도 실제로 달라진 프레임에만 밀도 신호를 울린다. 폭만 비교하면
      // 같은 폭 구간 안에서 행 높이만 넘어가는 델타(예: 1.0020 → 1.0030은 폭을 261px로 둔 채 행
      // 상한을 210px → 211px로 옮긴다)를 놓쳐, 판이 바뀌는데 확대창이 살아남는다. 최초 부착(이전 값이
      // 비어 있는 상태)은 전환이 아니라 초기화이므로 울리지 않는다.
      const sizing: readonly (readonly [string, string])[] = [
        ["--triage-card-min", `${Math.round(TRIAGE_DECK_CARD_BASE_MIN_PX * zoom)}px`],
        ["--triage-row-min", `${Math.max(84, Math.round(150 * zoom))}px`],
        ["--triage-row-max", `${Math.max(84, Math.round(210 * zoom))}px`],
      ];
      let initialised = true;
      let resized = false;
      for (const [name, value] of sizing) {
        const previous = owner.style.getPropertyValue(name);
        if (previous === "") initialised = false;
        else if (previous !== value) resized = true;
        owner.style.setProperty(name, value);
      }
      if (initialised && resized) emitDeckDensityChange();
    }
    // 지도 판정은 프레임 정확도로 반영한다 — tween이 임계를 가로지르는 중간에도
    // 카드↔지도 전환이 정확한 프레임에 일어나야 한다.
    setTriageDeckMapModeLive(isTriageDeckMapMode(zoom));
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
        // Shift+wheel은 카드 격자 세로 스크롤(지도 모드에서는 no-op).
        if (event.shiftKey) {
          if (isTriageDeckMapModeActive()) return;
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
        const next = Math.min(2.0, Math.max(0.35, zoom * Math.exp(-event.deltaY * deltaScale * TRIAGE_DECK_ZOOM_WHEEL_SPEED)));
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

  // 밴드의 밀도 버튼도 이 컨트롤러를 거쳐야 한다 — store에 먼저 쓰면 tween 시작 프레임에
  // 지도 판정이 뒤집혀 잘못된 모드가 한 프레임 번쩍인다(영속은 settle 시).
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
  // 착지 확인은 사용자가 보고 있는 요소에 준다 — 지도 모드에서는 카드가 은닉되어 있으므로
  // 지도 점을 우선 조회한다(점은 지도 모드에서만 존재해 우선순위가 안전하다).
  const escaped = escapeAttributeValue(operationId);
  const target = document.querySelector<HTMLElement>(`[data-triage-map-dot="${escaped}"]`)
    ?? document.querySelector<HTMLElement>(`[data-triage-deck-card="${escaped}"]`);
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
  mapGeometryFor,
  onPanelSlotRef,
  freshOperationIds,
  onMapMarkerMove,
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
  // 지도 모드의 Quick-Look — 점만으로는 어떤 Operation의 무엇이 걸려 있는지 읽을 수 없어,
  // 점에 hover하면 그 칸(=패널)을 판 위로 끌어올려 점 옆에 세운다. 동시에 한 창만 열리고
  // 드웰 타이머도 1개만 유지한다 — 점 사이를 빠르게 오갈 때 이전 점의 드웰이 뒤늦게 발동해
  // 두 창이 겹치는 일을 막는다. 카드 모드에는 확대가 없다(겨눈 칸은 hover 링으로만 말한다).
  const [mapQuicklook, setMapQuicklook] = useState<{ operationId: string; placement: TriageMapQuicklookPlacement } | null>(null);
  // 드래그 좌표는 ref가 나른다(리렌더 없음). 상태는 "지금 끌고 있는 마커" 한 개뿐이며 잡을 때와
  // 놓을 때만 바뀐다 — 그 클래스가 유영을 끄고 드래그 어포던스를 입힌다.
  const mapDragRef = useRef<TriageMapDragState | null>(null);
  const [draggingMarkerId, setDraggingMarkerId] = useState<string | null>(null);
  const quicklookTimerRef = useRef<number | null>(null);
  // 지도 판정은 줌 tween 프레임마다 store의 live 채널에 반영된다 — 렌더 시점 zoom 스냅샷을
  // 들고 있으면 임계 교차가 영영 발화하지 않는다.
  const mapMode = useSyncExternalStore(
    subscribeTriage,
    () => isTriageDeckMapModeActive(),
    () => false,
  );
  // 무대가 떠 있는 동안에도 deck는 mount를 유지하고 visibility로만 숨는다 — 비무대 body가
  // 카드(고정 크기)와 숨김 프레임(크롬 제외 크기) 사이를 오가며 전 세션에 PTY 리사이즈를
  // 뿌리는 churn을 없애기 위해서다. 리사이즈는 무대에 오른 Operation에만 남는다.
  const visible = active && !entering && operations.length > 0;
  const underStage = stagedOperationId !== null;

  // 밀도 임계를 넘는 순간의 변형 — 이 effect는 rect 기록 effect보다 **먼저** 선언되어야 한다.
  // deckCardRects가 아직 "떠나는 표면"(지도 진입이면 카드, 이탈이면 점)의 좌표를 들고 있어야
  // 출발점을 알 수 있고, 아래 기록 effect가 실행되면 그 좌표는 도착 표면 것으로 덮인다.
  const [morph, setMorph] = useState<TriageDeckMorph | null>(null);
  const morphTimerRef = useRef<number | null>(null);
  const morphFrameRef = useRef<number | null>(null);
  const previousMapModeRef = useRef(mapMode);
  useLayoutEffect(() => {
    const previous = previousMapModeRef.current;
    if (previous === mapMode) return;
    previousMapModeRef.current = mapMode;
    if (morphTimerRef.current !== null) window.clearTimeout(morphTimerRef.current);
    if (morphFrameRef.current !== null) window.cancelAnimationFrame(morphFrameRef.current);
    morphTimerRef.current = null;
    morphFrameRef.current = null;
    const grid = gridRef.current;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (!visible || !grid || reducedMotion) {
      setMorph(null);
      return;
    }
    const frames = new Map<string, TriageMorphFrame>();
    if (mapMode) {
      // 지도 진입 — 점은 방금 그려졌고(현재 DOM), 카드 좌표는 직전 스냅샷에 남아 있다.
      for (const dot of grid.querySelectorAll<HTMLElement>("[data-triage-map-dot]")) {
        const operationId = dot.dataset.triageMapDot;
        const cardRect = operationId ? deckCardRects.get(operationId) : undefined;
        if (!operationId || !cardRect) continue;
        frames.set(operationId, resolveTriageMorphFrame(cardRect, dot.getBoundingClientRect()));
      }
    } else {
      // 지도 이탈 — 카드가 방금 자리를 잡았고(현재 DOM), 점 좌표는 직전 스냅샷에 남아 있다.
      for (const card of grid.querySelectorAll<HTMLElement>("[data-triage-deck-card]")) {
        const operationId = card.dataset.triageDeckCard;
        const dotRect = operationId ? deckCardRects.get(operationId) : undefined;
        if (!operationId || !dotRect) continue;
        frames.set(operationId, resolveTriageMorphFrame(card.getBoundingClientRect(), dotRect));
      }
    }
    if (frames.size === 0) {
      setMorph(null);
      return;
    }
    // 두 방향 모두 프레임을 먼저 건다 — 지도 진입은 그 적용이 곧 재생이고, 이탈은 걸어 둔
    // 프레임을 다음 프레임에 걷어내는 것이 재생이다.
    setMorph({ phase: mapMode ? "to-map" : "to-cards", frames, applied: true });
    if (!mapMode) {
      // invert & play — 점 자리에 축소해 둔 카드를 다음 프레임에 놓아 준다.
      morphFrameRef.current = window.requestAnimationFrame(() => {
        morphFrameRef.current = null;
        setMorph((current) => current?.phase === "to-cards" ? { ...current, applied: false } : current);
      });
    }
    morphTimerRef.current = window.setTimeout(() => {
      morphTimerRef.current = null;
      setMorph(null);
    }, TRIAGE_DECK_MORPH_MS);
  }, [mapMode, visible]);

  useEffect(() => () => {
    if (morphTimerRef.current !== null) window.clearTimeout(morphTimerRef.current);
    if (morphFrameRef.current !== null) window.cancelAnimationFrame(morphFrameRef.current);
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    const grid = gridRef.current;
    if (!grid) return;
    const recordRects = () => {
      const currentIds = new Set<string>();
      // map mode에서는 카드가 은닉되므로 flight 좌표는 지도 점에서 읽는다 — 소비자
      // (getTriageDeckCardRect)는 어느 쪽이 기록했는지 모른다.
      const targets = mapMode
        ? grid.closest(".canvas-triage-deck")?.querySelectorAll<HTMLElement>("[data-triage-map-dot]") ?? []
        : grid.querySelectorAll<HTMLElement>("[data-triage-deck-card]");
      for (const target of targets) {
        const operationId = target.dataset.triageMapDot ?? target.dataset.triageDeckCard;
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
  }, [operations, visible, mapMode]);

  const clearQuicklookTimer = () => {
    if (quicklookTimerRef.current !== null) {
      window.clearTimeout(quicklookTimerRef.current);
      quicklookTimerRef.current = null;
    }
  };

  const dismissQuicklook = () => {
    clearQuicklookTimer();
    setMapQuicklook(null);
  };

  // 지도 점의 Quick-Look — 포인터는 드웰 뒤에, 키보드 포커스는 즉시 연다(같은 정보에 같은
  // 순간 닿게 하는 접근성 동등성). 좌표는 점 실측에서 온다.
  const armMapQuicklook = (operationId: string, dot: HTMLElement, dwell: boolean) => {
    const fire = () => {
      quicklookTimerRef.current = null;
      const grid = gridRef.current;
      if (!grid) return;
      // 확대는 밴드 안에 있는 칸을 판 위로 끌어올리는 것이라, 앵커·클램프는 판(grid)을 상자로
      // 삼는다. 칸은 그때 position: fixed로 서는데, fixed의 원점은 뷰포트라는 보장이 없다 —
      // 조상에 transform·filter가 하나라도 있으면 그 조상이 기준이 된다(캔버스 크롬이 그렇다).
      // 그래서 그 원점을 프로브로 실측해 판 기준 좌표를 그 좌표계로 옮긴다.
      const gridRect = grid.getBoundingClientRect();
      const placement = resolveTriageMapQuicklookPlacement(dot.getBoundingClientRect(), gridRect);
      const origin = resolveFixedOrigin(grid);
      setMapQuicklook({
        operationId,
        placement: {
          ...placement,
          left: placement.left + gridRect.left - origin.x,
          top: placement.top + gridRect.top - origin.y,
        },
      });
    };
    if (!dwell) {
      fire();
      return;
    }
    clearQuicklookTimer();
    quicklookTimerRef.current = window.setTimeout(fire, TRIAGE_DECK_QUICKLOOK_DWELL_MS);
  };

  useEffect(() => {
    // 표면이 바뀌면 열린 확대창은 걷는다 — 은닉되거나 언마운트된 점은 pointerleave·blur를
    // 발화하지 않아, 지도를 벗어나면 그 창이 주인 없이 남아 pool 슬롯까지 카드와 다툰다.
    dismissQuicklook();
  }, [visible, stagedOperationId, mapMode]);

  // 밀도 전환은 한 점을 들여다보는 조작이 아니라 판 전체를 다시 짜는 조작이다 — 열린 확대창의
  // 좌표는 발동 시점 스냅샷이라, 판이 다시 짜이면 그 창은 어느 점의 것도 아닌 자리에 남는다.
  // 칸 크기가 실제로 달라진 모든 전환을 이 구독이 받는다 — 표시값이 움직이지 않는 작은 델타까지.
  const releaseRef = useRef(dismissQuicklook);
  releaseRef.current = dismissQuicklook;
  useEffect(() => subscribeDeckDensity(() => { releaseRef.current(); }), []);
  // 표시값 경로도 함께 둔다 — 줌 컨트롤러가 아직 어떤 요소도 소유하지 않은 구간(덱 마운트 전
  // 프리셋 순환)에서는 CSS 변수 쓰기가 일어나지 않아 위 신호가 울리지 않는다.
  const deckZoomLive = useSyncExternalStore(subscribeTriage, getTriageDeckZoomLive, () => TRIAGE_DECK_ZOOM_DEFAULT);
  const previousZoomRef = useRef(deckZoomLive);
  useEffect(() => {
    // 마운트는 밀도 전환이 아니다 — 실제로 값이 움직인 전환에만 반응한다.
    if (previousZoomRef.current === deckZoomLive) return;
    previousZoomRef.current = deckZoomLive;
    dismissQuicklook();
  }, [deckZoomLive]);

  // 열린 지도 확대창의 좌표는 발동 시점 스냅샷이다 — 판이 리사이즈되면(사이드바 토글·창 변경)
  // 점은 %로 재배치되는데 확대창만 옛 px에 남으므로, 재계산 대신 해제해 유령 창을 만들지 않는다.
  useEffect(() => {
    if (!mapQuicklook || typeof ResizeObserver === "undefined") return;
    const grid = gridRef.current;
    if (!grid) return;
    let first = true;
    const observer = new ResizeObserver(() => {
      if (first) {
        first = false;
        return;
      }
      setMapQuicklook(null);
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, [mapQuicklook]);

  // 지도 진입 시 grid 스크롤을 원점으로 되돌린다 — 판(fleet)은 grid 안의 절대배치라 잔류
  // scrollTop만큼 함께 밀려 잘린 채 남고, overflow 잠금 뒤에는 되돌릴 휠 경로도 없다.
  useLayoutEffect(() => {
    if (!mapMode) return;
    const grid = gridRef.current;
    if (grid) grid.scrollTop = 0;
  }, [mapMode]);

  // 작전지도 원 배치는 판의 실제 종횡비를 알아야 픽셀 기준 겹침을 피할 수 있다 — 판(grid 뷰포트)을 실측한다.
  // 지도 모드에서만 재면 카드 모드 동안의 리사이즈(창 크기·사이드바 토글)가 반영되지 않아,
  // 지도 진입 첫 프레임이 옛 비율로 구역을 배치하고 morph는 그 자리를 목표로 굳는다 —
  // 직후 측정이 구역을 옮기면 카드가 이미 없는 자리로 날아간다. 덱이 살아 있는 동안 계속 잰다.
  const [fleetAspect, setFleetAspect] = useState(1.8);
  useLayoutEffect(() => {
    if (!visible) return;
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      if (grid.clientWidth > 0 && grid.clientHeight > 0) {
        setFleetAspect(grid.clientWidth / Math.max(1, grid.clientHeight));
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [mapMode, visible]);

  // unmount 시 드웰 타이머를 반납한다 — unmount 뒤 발동하면 떠난 판에 setState를 던진다.
  useEffect(() => () => clearQuicklookTimer(), []);

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
  // 마커 배치는 구역이 몇 개로 갈리는지 안 뒤에 정한다 — 중앙 표석은 구역이 둘 이상일 때만
  // 서므로, 그때만 마커가 비켜설 띠를 잡는다(단일 함대는 판 전체가 열린 바다다).
  const bands = theaterBands.map((band) => ({
    ...band,
    mapMarkers: mapMode
      ? resolveTriageMapMarkerLayout(band.operations.map((operation) => ({
          id: operation.id,
          geometry: mapGeometryFor ? mapGeometryFor(operation) : operation.geometry,
        })), theaterBands.length > 1)
      : null,
  }));
  const fleetZones = mapMode
    ? resolveTriageFleetZoneLayout(
        bands.map((band) => ({ theaterId: band.theater.id, count: band.operations.length, slotIndex: band.theaterIndex })),
        fleetAspect,
      )
    : [];
  const pick = (operationId: string, element: HTMLElement) => {
    // 승격 flight는 클릭 순간 사용자가 보고 있는 위치에서 출발해야 한다 — tween이 살아 있으면
    // 카드가 움직이는 중이라 좌표가 흔들리므로 먼저 스냅 종료하고, 그 다음 rect를 출발 전용 채널에 기록한다.
    onBeforePick?.();
    deckDepartureRect = { operationId, rect: element.getBoundingClientRect() };
    dismissQuicklook();
    pickTriageOperation(operationId);
  };
  const openOperationMenu = (operationId: string, event: ReactMouseEvent<HTMLElement> | MouseEvent, host?: HTMLElement) => {
    event.preventDefault();
    event.stopPropagation();
    // 메뉴가 뜬 동안 지도 확대창이 메뉴와 패널 body를 두고 싸우지 않게 즉시 걷는다.
    dismissQuicklook();
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
    dismissQuicklook();
    onOperationContextMenu?.(operationId, event.currentTarget.getBoundingClientRect(), event.currentTarget);
    return true;
  };
  const openTheaterMenu = (theater: TriageDeckTheater, event: ReactMouseEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.target instanceof Element && event.target.closest("[data-triage-deck-card], [data-triage-map-dot]")) return;
    event.preventDefault();
    event.stopPropagation();
    dismissQuicklook();
    onTheaterContextMenu?.(theater.id, { x: event.clientX, y: event.clientY });
  };
  const openMapOperationMenu = (operationId: string, event: ReactMouseEvent<HTMLButtonElement>) => {
    const activeDrag = mapDragRef.current;
    if ((activeDrag?.operationId === operationId && activeDrag.moved) || isTriageMapDragSuppressed(operationId)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    openOperationMenu(operationId, event);
  };
  const mapHover: TriageMapDotHover = { arm: armMapQuicklook, dismiss: dismissQuicklook };
  // 마커 드래그 — 판 위에서 옮긴 자리가 곧 캔버스에서의 자리다. 이동 중에는 리렌더를 한 번도
  // 일으키지 않고 점의 CSS 변수만 직접 쓴다: 이 컴포넌트의 렌더 한 번은 전 밴드의 마커 배치를
  // (겹침 이완 12패스까지) 다시 계산하므로, 포인터 프레임마다 setState를 돌리면 손끝을 못 따라온다.
  // 상태 갱신은 잡을 때와 놓을 때 각 한 번뿐이고, 좌표는 ref가 나른다.
  const mapDrag: TriageMapDotDrag = {
    start: (operationId, event) => {
      if (event.button !== 0) return;
      const band = bands.find((candidate) => candidate.operations.some((operation) => operation.id === operationId));
      const field = event.currentTarget.parentElement;
      if (!band || !field) return;
      // 투영이 퇴화면(geometry 부재·공선) 캔버스로 되돌릴 원본이 없다 — 그래도 판 위에서는
      // 옮길 수 있어야 하므로, 그때는 판이 자기 좌표만 기억하고 캔버스는 건드리지 않는다.
      const projection = resolveTriageMapProjection(band.operations.map((operation) => ({
        geometry: mapGeometryFor ? mapGeometryFor(operation) : operation.geometry,
      })));
      dismissQuicklook();
      event.currentTarget.setPointerCapture(event.pointerId);
      const fieldRect = field.getBoundingClientRect();
      mapDragRef.current = {
        operationId,
        theaterId: band.theater.id,
        pointerId: event.pointerId,
        originX: event.clientX,
        originY: event.clientY,
        fieldWidth: fieldRect.width,
        fieldHeight: fieldRect.height,
        projection,
        dx: 0,
        dy: 0,
        moved: false,
      };
    },
    // 포인터 캡처가 걸려 있어 점을 벗어나도 이 요소가 계속 이벤트를 받는다 — 전역 리스너 없이
    // 제스처가 끝까지 유지된다.
    move: (event) => {
      const dragging = mapDragRef.current;
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      dragging.dx = event.clientX - dragging.originX;
      dragging.dy = event.clientY - dragging.originY;
      if (!dragging.moved) {
        if (Math.hypot(dragging.dx, dragging.dy) < TRIAGE_MAP_DRAG_THRESHOLD_PX) return;
        dragging.moved = true;
        // 잡았다는 신호는 이때 한 번만 — 문턱을 넘기 전에는 아직 클릭일 수 있다.
        setDraggingMarkerId(dragging.operationId);
      }
      event.currentTarget.style.setProperty("--drag-dx", `${dragging.dx}px`);
      event.currentTarget.style.setProperty("--drag-dy", `${dragging.dy}px`);
    },
    end: (event) => {
      const dragged = mapDragRef.current;
      if (!dragged || dragged.pointerId !== event.pointerId) return;
      mapDragRef.current = null;
      // 새 좌표가 들어오면 점은 그 자리에 그려진다 — 이동량을 함께 지워야 두 번 더해지지 않는다.
      event.currentTarget.style.removeProperty("--drag-dx");
      event.currentTarget.style.removeProperty("--drag-dy");
      if (!dragged.moved) return;
      setDraggingMarkerId(null);
      // click은 pointerup 뒤에 온다 — 이동으로 끝난 제스처의 click 한 번을 삼키게 표시한다.
      triageMapDragSuppression = dragged.operationId;
      const marker = bands
        .flatMap((band) => band.mapMarkers ?? [])
        .find((candidate) => candidate.operationId === dragged.operationId);
      const operation = operations.find((candidate) => candidate.id === dragged.operationId);
      const geometry = operation ? (mapGeometryFor ? mapGeometryFor(operation) : operation.geometry) : null;
      if (!marker || !operation || dragged.fieldWidth <= 0 || dragged.fieldHeight <= 0) return;
      // 판 밖에서 손을 떼도(포인터 캡처는 경계를 넘어서도 이벤트를 준다) 마커는 판 안에 선다.
      // 클램프는 캔버스에 넘길 이동량보다 먼저 걸어야 한다 — 나중에 걸면 판은 가장자리에 멈추고
      // 패널만 판 밖 좌표로 끌려가 화면에서 사라진다.
      const dropped = {
        x: clampTriageMapPercent(marker.x + (dragged.dx / dragged.fieldWidth) * 100),
        y: clampTriageMapPercent(marker.y + (dragged.dy / dragged.fieldHeight) * 100),
      };
      // 판이 먼저 자기 좌표를 기억한다 — 자동 배치가 다음 렌더에서 이 자리를 도로 흩뜨리면
      // 옮길 수 없는 지도가 된다.
      setTriageMapMarkerOverride(operation.id, dropped);
      if (!dragged.projection || !geometry) return;
      onMapMarkerMove?.(
        operation.id,
        dragged.theaterId,
        projectTriageMapDeltaToGeometry(
          { x: dropped.x - marker.x, y: dropped.y - marker.y },
          dragged.projection,
          geometry,
        ),
      );
    },
    // 취소는 인도가 아니다 — 좌표를 남기지 않고, click 삼킴도 걸지 않는다. 취소된 제스처는
    // 뒤따르는 click을 만들지 않으므로, 삼킴을 걸어 두면 다음번 진짜 클릭이 먹힌다.
    cancel: (event) => {
      const dragged = mapDragRef.current;
      if (!dragged || dragged.pointerId !== event.pointerId) return;
      mapDragRef.current = null;
      event.currentTarget.style.removeProperty("--drag-dx");
      event.currentTarget.style.removeProperty("--drag-dy");
      if (dragged.moved) setDraggingMarkerId(null);
    },
  };
  return (
    <section
      className={`canvas-triage-deck ${underStage ? "is-under-stage" : ""} ${mapMode ? "is-map-mode" : ""} ${morph ? `is-morphing is-morph-${morph.phase}` : ""}`}
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
                    // 지도 모드의 확대는 이 칸을 점 위로 옮겨 세운다 — 좌표는 뷰포트 기준이라
                    // 칸이 어느 밴드에 속하든 판 위 같은 자리에 선다.
                    const mapLook = mapMode && mapQuicklook?.operationId === operation.id ? mapQuicklook.placement : null;
                    // 밀도 변형 프레임 — 칸을 자기 점 자리로 옮겨 놓는다. 칸의 transform은
                    // 이 변형만 쓴다.
                    const morphFrame = morph?.applied ? morph.frames.get(operation.id) ?? null : null;
                    return (
                      // 칸은 자리이지 물건이 아니다 — 이 안에 서는 것은 캔버스가 소유한 그
                      // Operation의 실제 패널이고(canvas가 portal로 들여보낸다), 칸은 자리·배율·
                      // 변형만 진다. 카드 얼굴을 따로 그리던 종전 구조에서는 같은 Operation이
                      // 밀도마다 다른 물건으로 그려졌고, 축소가 transform이라 글자도 함께 뭉갰다.
                      <div
                        className={`canvas-triage-deck-cell is-${visual} ${arrivingOperationId === operation.id ? "is-arriving" : ""} ${freshOperationIds?.has(operation.id) ? "is-fresh" : ""} ${mapLook ? "is-map-quicklook" : ""} ${morph ? "is-morphing" : ""} ${morph?.phase === "to-cards" && morph.applied ? "is-morph-snap" : ""}`}
                        key={operation.id}
                        data-triage-deck-card={operation.id}
                        style={mapLook
                          ? { left: `${mapLook.left}px`, top: `${mapLook.top}px`, width: `${mapLook.width}px`, height: `${mapLook.height}px` }
                          : morphFrame
                            ? { transform: `translate(${morphFrame.dx.toFixed(1)}px, ${morphFrame.dy.toFixed(1)}px) scale(${morphFrame.scale.toFixed(4)})` }
                            : undefined}
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
        {mapMode ? (
          // 작전지도는 하나의 판이다 — 지구본 위 작전구역처럼 각 Theater가 원형 구역으로 떠 있고
          // 그 원 안에 소속 Operation들이 모인다. 카드 grid는 mount 계약(비무대 body의 고정 거처)
          // 때문에 숨김 상태로 뒤에 남는다.
          <div className="canvas-triage-map-fleet">
            {bands.length === 1 ? (
              // Theater가 하나뿐이면 구역을 나눌 이유가 없다 — 원 없이 판 전체가 그 함대의 바다다.
              <div
                className="canvas-triage-map canvas-triage-map--plane"
                onContextMenu={(event) => openTheaterMenu(bands[0]!.theater, event)}
              >
                {renderTriageMapDots(bands[0]!, operationRuntime, t, pick, mapHover, mapDrag, draggingMarkerId, openMapOperationMenu, openOperationMenuFromKeyboard)}
              </div>
            ) : bands.map((band, bandIndex) => {
              const zone = fleetZones[bandIndex]!;
              return (
              <section
                className="canvas-triage-map-zone"
                key={band.theater.id}
                onContextMenu={(event) => openTheaterMenu(band.theater, event)}
                style={{
                  "--zone-x": `${zone.centerX}%`,
                  "--zone-y": `${zone.centerY}%`,
                  "--zone-size": `${zone.size}%`,
                  "--zone-tint": `var(--id-${TRIAGE_ZONE_TONES[band.theaterIndex % TRIAGE_ZONE_TONES.length]})`,
                } as CSSProperties}
              >
                {/* 구역의 이름표는 원주 대신 구역 중앙에 선다 — 점선 원주를 걷어낸 판에서
                    "여기가 어느 Theater인가"를 말하는 것은 그 자리에 놓인 상태 문구 자체다. */}
                <header className="canvas-triage-map-zone-head">
                  <span className="canvas-triage-map-zone-title">
                    <span className="canvas-triage-deck-band-chip" aria-hidden="true">{theaterInitials(band.theater.label)}</span>
                    <span className="canvas-triage-map-zone-label">{band.theater.label}</span>
                  </span>
                  <span className="canvas-triage-map-zone-counts">
                    {t("canvas.triage.bandCounts", { waiting: band.counts.waiting, running: band.counts.running, idle: band.counts.idle })}
                  </span>
                </header>
                <div className="canvas-triage-map">
                  {renderTriageMapDots(band, operationRuntime, t, pick, mapHover, mapDrag, draggingMarkerId, openMapOperationMenu, openOperationMenuFromKeyboard)}
                </div>
              </section>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}

// Theater 원형 구역의 식별 톤 — 밴드 순서(대기 수)가 아니라 theaters 선언 순서(theaterIndex)로
// 배정해 대기 수가 변해도 같은 Theater가 같은 색을 유지한다.
const TRIAGE_ZONE_TONES: readonly string[] = ["teal", "amber", "plum", "moss", "cerulean", "rose", "crimson", "indigo"];

interface TriageMapDotHover {
  readonly arm: (operationId: string, dot: HTMLElement, dwell: boolean) => void;
  readonly dismiss: () => void;
}

interface TriageMapDotDrag {
  readonly start: (operationId: string, event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly move: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly end: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly cancel: (event: ReactPointerEvent<HTMLButtonElement>) => void;
}

interface TriageMapDragState {
  readonly operationId: string;
  readonly theaterId: string;
  readonly pointerId: number;
  readonly originX: number;
  readonly originY: number;
  readonly fieldWidth: number;
  readonly fieldHeight: number;
  readonly projection: TriageMapProjection | null;
  dx: number;
  dy: number;
  moved: boolean;
}

// 클릭과 드래그를 가르는 이동 거리 — 이보다 짧으면 무대로 올리는 클릭으로 읽는다.
const TRIAGE_MAP_DRAG_THRESHOLD_PX = 4;

// 드래그로 끝난 포인터가 뒤이어 내보내는 click 1회를 삼키는 채널. 브라우저는 pointerup 뒤
// click을 항상 보내므로, 이 표시가 없으면 점을 옮길 때마다 그 패널이 무대로 올라간다.
let triageMapDragSuppression: string | null = null;

function isTriageMapDragSuppressed(operationId: string): boolean {
  return triageMapDragSuppression === operationId;
}

function consumeTriageMapDragSuppression(operationId: string): boolean {
  if (!isTriageMapDragSuppressed(operationId)) return false;
  triageMapDragSuppression = null;
  return true;
}

// 점의 유영 진폭·주기 — 실행 중은 넓고 빠르게, 나머지 상태는 그 절반 이하로 좁고 느리게 돈다.
// 정지한 점은 판을 정물로 만들지만, 모든 점이 같은 폭으로 흔들리면 "실행 중"이 가진 움직임의
// 의미가 사라진다. 진폭 차이가 상태 위계를 그대로 옮긴다.
const TRIAGE_MAP_DRIFT_CALM_AMPLITUDE = 0.42;
const TRIAGE_MAP_DRIFT_CALM_PERIOD = 1.55;

export function resolveTriageMapDriftStyle(operationId: string, active: boolean): CSSProperties {
  // id 해시 기반 결정적 주입 — 렌더마다 흔들리면 지도가 아니다. 주기는 초 리터럴이 아니라
  // --duration-slow 배수라 테마 모션 스케일을 따라간다.
  const hash = hashTriageMapKey(operationId);
  const amplitude = active ? 1 : TRIAGE_MAP_DRIFT_CALM_AMPLITUDE;
  const period = (30.6 + (hash % 7) * 5) * (active ? 1 : TRIAGE_MAP_DRIFT_CALM_PERIOD);
  const offset = (shift: number, span: number) => `${((((hash >> shift) % span) - (span - 1) / 2) * amplitude).toFixed(1)}px`;
  return {
    "--triage-drift-mult": period.toFixed(1),
    "--triage-drift-x1": offset(2, 29),
    "--triage-drift-y1": offset(4, 23),
    "--triage-drift-x2": offset(6, 29),
    "--triage-drift-y2": offset(8, 23),
  } as CSSProperties;
}

function renderTriageMapDots(
  band: {
    readonly operations: readonly OperationNode[];
    readonly mapMarkers: readonly { readonly operationId: string; readonly x: number; readonly y: number }[] | null;
  },
  operationRuntime: Readonly<Record<string, OperationRuntimeState>>,
  t: ReturnType<typeof useT>,
  pick: (operationId: string, element: HTMLElement) => void,
  hover: TriageMapDotHover,
  drag: TriageMapDotDrag,
  draggingMarkerId: string | null,
  openOperationMenu: (operationId: string, event: ReactMouseEvent<HTMLButtonElement>) => void,
  openOperationMenuFromKeyboard: (operationId: string, event: ReactKeyboardEvent<HTMLButtonElement>) => boolean,
) {
  return band.mapMarkers?.map((marker) => {
    const operation = band.operations.find((candidate) => candidate.id === marker.operationId);
    if (!operation) return null;
    // 점·사이드바 칩·커맨드 밴드가 같은 마크 축을 써서 도착을 "unseen"(초록 느린 점등)으로 읽는다.
    // 선별 축(대기 밴드 정렬·무대 승격)은 그대로 표시 활동을 쓴다 — 색과 배치는 다른 질문이다.
    const visual = operationMarkVisual(resolveOperationMarkVisual({
      activity: resolveOperationActivity(operation, operationRuntime),
      operationId: operation.id,
      idleArrivalIds: getIdleArrivalIds(),
    }));
    // 미룬(deferred) 마커는 대기 링 맥동에서 제외한다 — 사용자가 이미 보고 미룬 신호를 다시 흔들지 않는다.
    const deferred = isTriageOperationDeferred(operation.id);
    const dragging = draggingMarkerId === operation.id;
    // 모든 점이 제자리에서 유영한다 — 살아 있는 함대의 판에서 정지한 점은 죽은 표시로 읽힌다.
    // 끌고 있는 점만은 손끝을 정확히 따라야 하므로 유영을 멈춘다. 이동량은 렌더가 아니라
    // 포인터 핸들러가 --drag-dx/--drag-dy로 직접 싣는다.
    const style: CSSProperties = {
      left: `${marker.x}%`,
      top: `${marker.y}%`,
      ...(dragging ? {} : resolveTriageMapDriftStyle(operation.id, visual === "running")),
    };
    return (
      <Fragment key={marker.operationId}>
      {/* 집어 올린 자리에 남는 자국 — 끌리는 점의 자식이 아니라 형제다(점은 scale로 커지므로
          자식으로 두면 자국까지 그 배율에 실려 원래 자리를 벗어난다). 드래그가 끝날 때까지
          판 좌표에 못 박혀 움직이지 않는다. */}
      {dragging ? (
        <span
          className="canvas-triage-map-dot-origin"
          style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
          aria-hidden="true"
        />
      ) : null}
      <button
        type="button"
        className={`canvas-triage-map-dot is-${visual}${deferred ? " is-deferred" : ""}${dragging ? " is-dragging" : ""}`}
        data-triage-map-dot={marker.operationId}
        style={style}
        aria-label={t("canvas.triage.deckCardAria", { title: operation.title })}
        aria-haspopup="menu"
        onContextMenu={(event) => openOperationMenu(operation.id, event)}
        onPointerDown={(event) => drag.start(operation.id, event)}
        onPointerMove={drag.move}
        onPointerUp={drag.end}
        onPointerCancel={drag.cancel}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          hover.arm(operation.id, event.currentTarget, true);
        }}
        onPointerLeave={hover.dismiss}
        onFocus={(event) => {
          if (!event.currentTarget.matches(":focus-visible")) return;
          hover.arm(operation.id, event.currentTarget, false);
        }}
        onBlur={hover.dismiss}
        onKeyDown={(event) => { openOperationMenuFromKeyboard(operation.id, event); }}
        onClick={(event) => {
          // 끌어서 옮긴 직후의 click은 무대 승격이 아니다 — 이동 의도를 클릭으로 삼키지 않는다.
          if (consumeTriageMapDragSuppression(operation.id)) return;
          pick(operation.id, event.currentTarget);
        }}
      >
        <span className="canvas-triage-map-dot-label">{operation.title}</span>
      </button>
      </Fragment>
    );
  });
}


function escapeAttributeValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
