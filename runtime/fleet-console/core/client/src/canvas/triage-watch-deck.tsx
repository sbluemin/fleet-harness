import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent } from "react";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import { OperationBodySlot, useOperationBodyPoolAvailable, type OperationBodyConfig } from "../mobile/operation-body-pool.js";
import { operationActivityLabel, operationActivityVisual, resolveOperationActivity } from "../operation-activity.js";
import { getOperationStatusDetailSnapshot, useOperationStatusDetails } from "../operation-status-detail-store.js";
import { theaterInitials } from "../sidebar/operations-side-bar.js";
import type { OperationGeometry, OperationNode } from "../types.js";
import { operationAccentFromNode, resolveAccentColor } from "./operation-accent.js";
import {
  clampTriageDeckZoom,
  getTriageDeckZoom,
  getTriageDeckZoomLive,
  hashTriageMapKey,
  isTriageActive,
  isTriageDeckMapMode,
  isTriageDeckMapModeActive,
  isTriageOperationDeferred,
  isTriageWaitingOperation,
  nextTriageDeckZoomPreset,
  pickTriageOperation,
  resolveTriageFleetZoneLayout,
  resolveTriageMapMarkerLayout,
  setTriageDeckMapModeLive,
  setTriageDeckZoom,
  setTriageDeckZoomLive,
  subscribeTriage,
  TRIAGE_DECK_CARD_BASE_MIN_PX,
  TRIAGE_DECK_ZOOM_DEFAULT,
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
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly operationAccent: Readonly<Record<string, string>>;
  readonly arrivingOperationId?: string | null;
  /** 무대에 오른 Operation — 그 카드만 슬롯을 무대 프레임에 넘기고, deck는 은닉된 채 mount를 유지한다. */
  readonly stagedOperationId?: string | null;
  /** 줌 tween 즉시 스냅 — 카드/지도 점 클릭 직전에 호출해 승격 flight의 출발 rect를 고정한다. */
  readonly onBeforePick?: () => void;
  /** 지도 마커용 유효 geometry — durable DTO보다 라이브 캔버스 배치가 정본이다(드래그 직후
      PATCH 왕복 대기·실패, DTO null인 자동 배치 op). canvas가 자기 스토어로 해석해 넘긴다. */
  readonly mapGeometryFor?: (operation: OperationNode) => OperationGeometry | null;
  /** 카드 본문 라이브 프리뷰용 pool 슬롯 config 빌더 — 핸들러 배선은 canvas가 단일 소유한다.
      렌더 가능한 kind가 아니면 null을 반환하고 카드는 tail 폴백으로 내려간다. */
  readonly previewConfigFor?: (operation: OperationNode) => OperationBodyConfig | null;
  /** 스포트라이트 OFF에서 검토 전인 대기 카드 — 지속 aurora 맥동(is-fresh)을 얹는다. */
  readonly freshOperationIds?: ReadonlySet<string>;
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
export const TRIAGE_DECK_QUICKLOOK_DWELL_MS = 400;
export const TRIAGE_DECK_QUICKLOOK_SCALE = 1.95;

// Quick-Look 배율 상한 — 단일 컬럼처럼 카드가 grid 폭을 거의 채우면 1.95를 그대로 곱한 카드가
// grid(overflow hidden)보다 커져 확대분이 잘려 나간다. origin 클램프는 컨테이너보다 큰 대상을
// 구제하지 못하므로 배율 자체를 grid가 수용 가능한 값으로 깎는다. 1 미만으로는 내리지 않는다
// (축소는 확대 보기가 아니다) — 좁은 창에서는 확대 없이 강조만 남는 정직한 열화를 택한다.
export function resolveTriageQuicklookScale(
  cardRect: DOMRect,
  gridRect: DOMRect,
  maxScale = TRIAGE_DECK_QUICKLOOK_SCALE,
): number {
  if (cardRect.width <= 0 || cardRect.height <= 0) return 1;
  return Math.max(1, Math.min(maxScale, gridRect.width / cardRect.width, gridRect.height / cardRect.height));
}

// 승격 출발 rect 1회용 채널 — 클릭 순간의(Quick-Look이면 확대된) rect는 outbound flight의
// 출발점으로만 쓰여야 한다. deckCardRects에 덮어쓰면 무대 복귀 flight의 목적지까지 확대
// rect로 오염되므로, 소비 즉시 비워지는 별도 채널로 분리한다.
let deckDepartureRect: { readonly operationId: string; readonly rect: DOMRect } | null = null;

export function takeTriageDeckDepartureRect(operationId: string): DOMRect | null {
  if (deckDepartureRect?.operationId !== operationId) return null;
  const rect = deckDepartureRect.rect;
  deckDepartureRect = null;
  return rect;
}

// Quick-Look transform-origin 결정 — 확대 후 카드가 grid 경계를 넘는 방향으로 origin을
// 클램프해 팽창이 경계 안쪽으로만 일어나게 한다. center origin 기준 카드는 절반 증가폭
// (scale-1)/2 만큼 양쪽으로 팽창하므로, 그 폭이 카드와 grid 사이 여백보다 크면 해당 방향의
// 경계를 넘는 것으로 본다.
export function resolveTriageQuicklookOrigin(
  cardRect: DOMRect,
  gridRect: DOMRect,
  scale = TRIAGE_DECK_QUICKLOOK_SCALE,
): string {
  const halfGrowX = ((scale - 1) / 2) * cardRect.width;
  const halfGrowY = ((scale - 1) / 2) * cardRect.height;
  const horizontal = cardRect.left - gridRect.left < halfGrowX
    ? "left"
    : gridRect.right - cardRect.right < halfGrowX
      ? "right"
      : "center";
  const vertical = cardRect.top - gridRect.top < halfGrowY
    ? "top"
    : gridRect.bottom - cardRect.bottom < halfGrowY
      ? "bottom"
      : "center";
  return `${horizontal} ${vertical}`;
}
// 카드 정렬 등급 — 사이드바 STATUS 축의 섹션 순서(대기→실행 중→백그라운드→유휴→휴면)를 그대로
// 따른다. deck이 자체 순서를 정의하면 같은 상태가 두 표면에서 다른 위치로 읽힌다.
const TRIAGE_DECK_ACTIVITY_RANK: Record<OperationActivity, number> = {
  awaiting: 0,
  running: 1,
  background: 2,
  idle: 3,
  dormant: 4,
};
const deckCardRects = new Map<string, DOMRect>();
const CARD_FLASH_DURATION_MS = 900;

export function getTriageDeckCardRect(operationId: string): DOMRect | null {
  // flight 좌표는 소비 시점 실측이 정본이다 — 캐시는 레이아웃 effect 주기에 묶여 줌 tween
  // 중간값을 담을 수 있으므로, 살아있는 DOM을 먼저 읽고 캐시도 함께 갱신한다.
  const escaped = escapeAttributeValue(operationId);
  const target = document.querySelector<HTMLElement>(`[data-triage-map-dot="${escaped}"]`)
    ?? document.querySelector<HTMLElement>(`[data-triage-deck-card="${escaped}"]`);
  // Quick-Look 확대 중인 카드는 실측 rect가 확대본이다 — 이 함수는 복귀 flight 목적지를
  // 답하므로 recordRects가 유지하는 비확대 캐시를 신뢰한다.
  if (target && !target.classList.contains("is-quicklook")) {
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
  /** deck가 지금 보이거나(visible) 입장 연출이 끝나면 보일 상태 — 이전 무대 없음 && deck 카드 존재.
      스포트라이트 OFF 억제는 이 넓은 기준을 쓴다: 입장 연출 중(deckVisible=false)에도 저장된 OFF가
      무시되고 등단하는 일이 없어야 하고, 무대 교대(이전 무대 존재)는 여기 해당하지 않아 계속 진행된다. */
  readonly deckAvailable: boolean;
  readonly spotlight: boolean;
  readonly dwell: TriageDeckArrivalDwell | null;
  readonly now: number;
  readonly suppressed: boolean;
}): TriageDeckPromotionDecision {
  if (input.operationId !== null && input.picked) {
    return { promote: true, arrivingOperationId: null, dwell: null };
  }
  // 스포트라이트 OFF에서는 자동 등단을 하지 않는다 — reduced-motion의 즉시 등단(suppressed)과
  // 입장 연출 중의 deck 비가시(!deckVisible) 승격보다 먼저 판정해야 저장된 OFF가 항상 존중된다.
  // 도착 신호는 카드의 is-fresh가 계속 책임진다.
  if (input.operationId !== null && !input.spotlight && input.deckAvailable) {
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
  operationStatus,
  operationAccent,
  arrivingOperationId = null,
  stagedOperationId = null,
  onBeforePick,
  mapGeometryFor,
  previewConfigFor,
  freshOperationIds,
}: TriageWatchDeckProps) {
  const t = useT();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const poolAvailable = useOperationBodyPoolAvailable();
  useOperationStatusDetails();
  // Quick-Look 상태 — 동시에 한 카드만 확대된다. 타이머도 1개만 유지해 카드 사이를 빠르게
  // 오갈 때 이전 카드의 드웰이 뒤늦게 발동해 두 카드가 동시에 확대되는 일을 막는다.
  const [quicklook, setQuicklook] = useState<{ operationId: string; origin: string; scale: number } | null>(null);
  const quicklookTimerRef = useRef<number | null>(null);
  // rect 기록 effect는 quicklook을 deps로 갖지 않으므로(스크롤/리사이즈마다 재구독 방지),
  // 스테일 클로저 없이 현재 값을 읽도록 ref 미러를 둔다.
  const quicklookRef = useRef<typeof quicklook>(null);
  useEffect(() => {
    quicklookRef.current = quicklook;
  }, [quicklook]);
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
        // Quick-Look 확대 중인 카드는 getBoundingClientRect가 확대 rect를 주므로 레이아웃
        // 좌표(offset 기하는 transform 무영향)로 비확대 rect를 재구성한다 — 이 맵은 복귀
        // flight의 목적지라 확대 rect가 실리면 고스트가 카드 두 배 크기 자리로 날아가고,
        // 그렇다고 기록을 건너뛰면 확대 중 grid 스크롤이 일어났을 때 옛 위치가 남는다.
        // 지도 점은 grid 자식이 아니고 Quick-Look도 없으므로 이 분기는 카드에만 닿는다.
        if (target.classList.contains("is-quicklook")) {
          const gridRect = grid.getBoundingClientRect();
          const unscaledRect = new DOMRect(
            gridRect.left + (target.offsetLeft - grid.offsetLeft) - grid.scrollLeft,
            gridRect.top + (target.offsetTop - grid.offsetTop) - grid.scrollTop,
            target.offsetWidth,
            target.offsetHeight,
          );
          deckCardRects.set(operationId, unscaledRect);
          // 열린 quick-look의 scale/origin은 발동 시점 스냅샷이라, grid 스크롤이나 리사이즈
          // (사이드바 토글 등)로 기하가 움직이면 새 경계에 맞게 재계산한다 — 스냅샷을 그대로
          // 두면 좁아진 grid에서 1.95를 유지하거나 새로 인접해진 가장자리 밖으로 팽창한다.
          const active = quicklookRef.current;
          if (active?.operationId === operationId) {
            const scale = resolveTriageQuicklookScale(unscaledRect, gridRect);
            const origin = resolveTriageQuicklookOrigin(unscaledRect, gridRect, scale);
            if (scale !== active.scale || origin !== active.origin) {
              setQuicklook({ operationId, origin, scale });
            }
          }
          continue;
        }
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
    setQuicklook(null);
  };

  const armQuicklook = (operationId: string, card: HTMLElement, dwell: boolean) => {
    const fire = () => {
      quicklookTimerRef.current = null;
      const grid = gridRef.current;
      if (!grid) return;
      const cardRect = card.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      const scale = resolveTriageQuicklookScale(cardRect, gridRect);
      setQuicklook({
        operationId,
        origin: resolveTriageQuicklookOrigin(cardRect, gridRect, scale),
        scale,
      });
    };
    if (!dwell) {
      // 키보드 사용자 동등성 — 드웰 없이 즉시 발동해 포인터와 같은 정보에 접근하게 한다.
      fire();
      return;
    }
    clearQuicklookTimer();
    quicklookTimerRef.current = window.setTimeout(fire, TRIAGE_DECK_QUICKLOOK_DWELL_MS);
  };

  useEffect(() => {
    // 지도 모드 진입도 해제 사유다 — grid가 visibility로 은닉되면 pointerleave가 발화하지
    // 않아, 열린 Quick-Look(또는 진행 중 드웰)이 카드 복귀 때 포인터 없는 확대로 남는다.
    if (!visible || stagedOperationId !== null || mapMode) dismissQuicklook();
  }, [visible, stagedOperationId, mapMode]);

  // 작전지도 원 배치는 판의 실제 종횡비를 알아야 픽셀 기준 겹침을 피할 수 있다 — 판(grid 뷰포트)을 실측한다.
  const [fleetAspect, setFleetAspect] = useState(1.8);
  useLayoutEffect(() => {
    if (!mapMode || !visible) return;
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

  // unmount 시 드웰 타이머를 반납한다 — unmount 뒤 발동하면 떠난 카드에 setState를 던진다.
  useEffect(() => () => clearQuicklookTimer(), []);

  if (!visible) return null;

  const activities = operations.map((operation) => resolveOperationActivity(operation, operationStatus));
  const running = activities.filter((activity) => activity === "running").length;
  const idle = activities.filter((activity) => activity === "idle").length;
  // 밴드 순서: 대기 카드 수 내림차순 → 같으면 theaters 선언 순. 카드 없는 Theater는 밴드를 그리지 않는다.
  // 헤더 수치는 밴드 정렬과 같은 대기 판정(isTriageWaitingOperation)을 쓴다 — 유휴 도착을 정렬은 대기로
  // 치면서 수치는 0으로 보이면 큐·사이드바 카운트와 모순된다. 대기로 센 유휴 도착은 유휴 수에서 뺀다.
  const bands = theaters
    .map((theater, theaterIndex) => {
      const theaterOperations = operations
        .filter((operation) => operation.theaterId === theater.id)
        .sort((left, right) => TRIAGE_DECK_ACTIVITY_RANK[resolveOperationActivity(left, operationStatus)]
          - TRIAGE_DECK_ACTIVITY_RANK[resolveOperationActivity(right, operationStatus)]);
      const mapMarkers = mapMode
        ? resolveTriageMapMarkerLayout(theaterOperations.map((operation) => ({
            id: operation.id,
            geometry: mapGeometryFor ? mapGeometryFor(operation) : operation.geometry,
          })))
        : null;
      const waitingIds = new Set(
        theaterOperations
          .filter((operation) => isTriageWaitingOperation(operation, operationStatus))
          .map((operation) => operation.id),
      );
      const counts = {
        waiting: waitingIds.size,
        running: theaterOperations.filter((operation) => resolveOperationActivity(operation, operationStatus) === "running").length,
        idle: theaterOperations.filter((operation) =>
          resolveOperationActivity(operation, operationStatus) === "idle" && !waitingIds.has(operation.id)).length,
      };
      return { theater, theaterIndex, operations: theaterOperations, mapMarkers, counts };
    })
    .filter((band) => band.operations.length > 0)
    .sort((left, right) => right.counts.waiting - left.counts.waiting || left.theaterIndex - right.theaterIndex);
  const fleetZones = mapMode
    ? resolveTriageFleetZoneLayout(bands.map((band) => ({ theaterId: band.theater.id, count: band.operations.length })), fleetAspect)
    : [];
  const pick = (operationId: string, element: HTMLElement) => {
    // 승격 flight는 클릭 순간 사용자가 보고 있는 위치에서 출발해야 한다 — tween이 살아 있으면
    // 카드가 움직이는 중이라 좌표가 흔들리므로 먼저 스냅 종료하고, 그 다음 rect를 출발 전용 채널에 기록한다.
    onBeforePick?.();
    deckDepartureRect = { operationId, rect: element.getBoundingClientRect() };
    pickTriageOperation(operationId);
  };
  return (
    <section
      className={`canvas-triage-deck ${underStage ? "is-under-stage" : ""} ${mapMode ? "is-map-mode" : ""}`}
      data-canvas-blocker
    >
      <div className="canvas-triage-deck-caption">
        {t("canvas.triage.deckCaption", { running, idle })}
      </div>
      <div className="canvas-triage-deck-grid" ref={gridRef}>
        {bands.map((band) => {
          return (
            <section className="canvas-triage-deck-band" key={band.theater.id}>
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
                    const activity = resolveOperationActivity(operation, operationStatus);
                    const visual = operationActivityVisual(activity);
                    const label = operationActivityLabel(activity);
                    const statusDetail = getOperationStatusDetailSnapshot(operation.id);
                    const accentKey = operationAccent[operation.id] ?? operationAccentFromNode(operation);
                    const accentColor = accentKey ? resolveAccentColor(accentKey) : null;
                    const previewConfig = poolAvailable && previewConfigFor && operation.id !== stagedOperationId
                      ? previewConfigFor(operation)
                      : null;
                    const isQuicklook = quicklook?.operationId === operation.id;
                    return (
                      <button
                        className={`canvas-triage-deck-card is-${visual} ${previewConfig ? "has-preview" : ""} ${arrivingOperationId === operation.id ? "is-arriving" : ""} ${freshOperationIds?.has(operation.id) ? "is-fresh" : ""} ${isQuicklook ? "is-quicklook" : ""}`}
                        data-triage-deck-card={operation.id}
                        key={operation.id}
                        type="button"
                        style={isQuicklook
                          ? { transformOrigin: quicklook.origin, "--triage-quicklook-scale": String(quicklook.scale) } as CSSProperties
                          : undefined}
                        aria-label={t("canvas.triage.deckCardAria", { title: operation.title })}
                        onPointerEnter={(event: PointerEvent<HTMLButtonElement>) => {
                          if (event.pointerType === "touch" || arrivingOperationId === operation.id) return;
                          armQuicklook(operation.id, event.currentTarget, true);
                        }}
                        onPointerLeave={dismissQuicklook}
                        onFocus={(event) => {
                          if (!event.currentTarget.matches(":focus-visible")) return;
                          armQuicklook(operation.id, event.currentTarget, false);
                        }}
                        onBlur={dismissQuicklook}
                        onClick={(event) => pick(operation.id, event.currentTarget)}
                      >
                        {accentColor ? <span className="canvas-triage-deck-card-spine" style={{ backgroundColor: accentColor } as CSSProperties} aria-hidden="true" /> : null}
                        <span className="canvas-triage-deck-card-status">
                          <span className="canvas-triage-deck-card-dot" aria-hidden="true" />
                          <span>{label}</span>
                        </span>
                        <strong title={operation.title}>{operation.title}</strong>
                        {previewConfig ? (
                          <TriageDeckCardPreview config={previewConfig} operationId={operation.id} />
                        ) : (
                          <span className="canvas-triage-deck-card-detail" title={statusDetail.detail ?? label}>
                            {statusDetail.detail ?? label}
                          </span>
                        )}
                      </button>
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
              <div className="canvas-triage-map canvas-triage-map--plane">
                {renderTriageMapDots(bands[0]!, operationStatus, t, pick)}
              </div>
            ) : bands.map((band, bandIndex) => {
              const zone = fleetZones[bandIndex]!;
              return (
              <section
                className="canvas-triage-map-zone"
                key={band.theater.id}
                style={{
                  "--zone-x": `${zone.centerX}%`,
                  "--zone-y": `${zone.centerY}%`,
                  "--zone-size": `${zone.size}%`,
                  "--zone-tint": `var(--id-${TRIAGE_ZONE_TONES[band.theaterIndex % TRIAGE_ZONE_TONES.length]})`,
                } as CSSProperties}
              >
                <header className="canvas-triage-map-zone-head">
                  <span className="canvas-triage-deck-band-chip" aria-hidden="true">{theaterInitials(band.theater.label)}</span>
                  <span className="canvas-triage-map-zone-label">{band.theater.label}</span>
                  <span className="canvas-triage-map-zone-counts">
                    {t("canvas.triage.bandCounts", { waiting: band.counts.waiting, running: band.counts.running, idle: band.counts.idle })}
                  </span>
                </header>
                <div className="canvas-triage-map">
                  {renderTriageMapDots(band, operationStatus, t, pick)}
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

function renderTriageMapDots(
  band: {
    readonly operations: readonly OperationNode[];
    readonly mapMarkers: readonly { readonly operationId: string; readonly x: number; readonly y: number }[] | null;
  },
  operationStatus: Readonly<Record<string, OperationActivity>>,
  t: ReturnType<typeof useT>,
  pick: (operationId: string, element: HTMLElement) => void,
) {
  return band.mapMarkers?.map((marker) => {
    const operation = band.operations.find((candidate) => candidate.id === marker.operationId);
    if (!operation) return null;
    const visual = operationActivityVisual(resolveOperationActivity(operation, operationStatus));
    // 미룬(deferred) 마커는 대기 링 맥동에서 제외한다 — 사용자가 이미 보고 미룬 신호를 다시 흔들지 않는다.
    const deferred = isTriageOperationDeferred(operation.id);
    let style: CSSProperties = { left: `${marker.x}%`, top: `${marker.y}%` };
    if (visual === "running") {
      // 실행 마커의 유영 경로·주기 — id 해시 기반 결정적 주입(렌더마다 흔들리면 지도가 아니다).
      // 주기는 초 리터럴이 아니라 --duration-slow 배수라 테마 모션 스케일을 따라간다.
      const hash = hashTriageMapKey(operation.id);
      style = {
        ...style,
        "--triage-drift-mult": (30.6 + (hash % 7) * 5).toFixed(1),
        "--triage-drift-x1": `${((hash >> 2) % 29) - 14}px`,
        "--triage-drift-y1": `${((hash >> 4) % 23) - 11}px`,
        "--triage-drift-x2": `${((hash >> 6) % 29) - 14}px`,
        "--triage-drift-y2": `${((hash >> 8) % 23) - 11}px`,
      } as CSSProperties;
    }
    return (
      <button
        key={marker.operationId}
        type="button"
        className={`canvas-triage-map-dot is-${visual}${deferred ? " is-deferred" : ""}`}
        data-triage-map-dot={marker.operationId}
        style={style}
        aria-label={t("canvas.triage.deckCardAria", { title: operation.title })}
        onClick={(event) => pick(operation.id, event.currentTarget)}
      >
        <span className="canvas-triage-map-dot-label">{operation.title}</span>
      </button>
    );
  });
}

// 라이브 프리뷰 — pool 슬롯이 실제 패널 body를 카드 안으로 끌어온다. 내부 박스는 패널의 원래
// 픽셀 크기를 고정 유지한 채 transform scale로만 축소한다: FitAddon이 카드 크기를 측정하면
// PTY cols/rows가 타일 크기로 리사이즈되어 실세션 레이아웃이 깨지므로, 측정 크기 불변이 계약이다.
// 레터박스 없이 카드 영역을 채우는 cover-fit — max 비율로 확대하고 넘치는 축은 크롭한다.
// 크롭 앵커는 가로 중앙·세로 하단: 터미널의 최신 출력과 입력줄은 항상 하단에 있으므로
// 모니터링 가치가 있는 영역이 살아남는다(빈 셸이 비어 보이는 것은 정직한 상태 표현이다).
function TriageDeckCardPreview({ operationId, config }: {
  readonly operationId: string;
  readonly config: OperationBodyConfig;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ scale: number; left: number; top: number } | null>(null);
  // 하한은 패널 리사이즈 최소값(operation-resize.tsx의 320×200)과 일치시킨다 — 이보다 크게
  // 올려 잡으면 지원되는 작은 패널의 프리뷰 컨테이너가 실제 geometry보다 커져 refit을 유발한다.
  const innerWidth = Math.max(320, config.geometry.width);
  const innerHeight = Math.max(200, config.geometry.height);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (width <= 0 || height <= 0) {
        setFit(null);
        return;
      }
      const scale = Math.max(width / innerWidth, height / innerHeight);
      setFit({
        scale,
        left: (width - innerWidth * scale) / 2,
        top: height - innerHeight * scale,
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [innerHeight, innerWidth]);
  return (
    <span className="canvas-triage-deck-card-preview" ref={viewportRef} aria-hidden="true" inert>
      {fit ? (
        <span
          className="canvas-triage-deck-card-preview-inner"
          style={{
            width: innerWidth,
            height: innerHeight,
            transform: `translate(${fit.left}px, ${fit.top}px) scale(${fit.scale})`,
          } as CSSProperties}
        >
          <OperationBodySlot className="canvas-triage-deck-card-preview-slot" config={config} operationId={operationId} />
        </span>
      ) : null}
    </span>
  );
}

function escapeAttributeValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
