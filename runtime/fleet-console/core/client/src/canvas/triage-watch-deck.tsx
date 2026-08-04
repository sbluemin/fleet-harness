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
  isTriageActive,
  isTriageDeckMapMode,
  isTriageDeckMapModeActive,
  isTriageWaitingOperation,
  pickTriageOperation,
  resolveTriageMapMarkerLayout,
  setTriageDeckMapModeLive,
  setTriageDeckZoom,
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
    zoomRef.current = zoom;
    const owner = ownerRef.current;
    if (owner) {
      owner.style.setProperty("--triage-card-min", `${Math.round(TRIAGE_DECK_CARD_BASE_MIN_PX * zoom)}px`);
      owner.style.setProperty("--triage-row-min", `${Math.max(84, Math.round(150 * zoom))}px`);
      owner.style.setProperty("--triage-row-max", `${Math.max(84, Math.round(210 * zoom))}px`);
    }
    setTriageDeckMapModeLive(isTriageDeckMapMode(zoom));
    const display = zoom.toFixed(1);
    if (display !== lastDisplayRef.current) {
      lastDisplayRef.current = display;
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

  // 진입 시 저장된 배율로 즉시 스냅한다.
  useEffect(() => {
    stopTween();
    const initial = getTriageDeckZoom();
    zoomRef.current = initial;
    targetRef.current = initial;
    lastDisplayRef.current = null;
    applyZoom(initial);
    return stopTween;
  }, []);

  // store 쪽 배율 변경(rail 칩 프리셋 순환)도 같은 tween 경로로 흡수한다.
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
        if (!isTriageActive()) return;
        if (!(event.target instanceof Element) || event.target.closest(".canvas-triage-deck") === null) return;
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        const zoom = zoomRef.current;
        const next = Math.min(2.0, Math.max(0.35, zoom * Math.exp(-event.deltaY * TRIAGE_DECK_ZOOM_WHEEL_SPEED)));
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
  }), []);
  return { zoom: zoomRef.current, control };
}

export function flashTriageDeckCard(operationId: string): void {
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
  // Quick-Look 상태 — 동시에 한 카드만 확대된다.
  const [quicklook, setQuicklook] = useState<{ operationId: string; origin: string; scale: number } | null>(null);
  const quicklookTimerRef = useRef<number | null>(null);
  const quicklookRef = useRef<typeof quicklook>(null);
  useEffect(() => {
    quicklookRef.current = quicklook;
  }, [quicklook]);
  // 지도 판정은 줌 tween 프레임마다 store의 live 채널에 반영된다.
  const mapMode = useSyncExternalStore(
    subscribeTriage,
    () => isTriageDeckMapModeActive(),
    () => false,
  );
  // 무대가 떠 있는 동안에도 deck는 mount를 유지하고 visibility로만 숨는다.
  const visible = active && !entering && operations.length > 0;
  const underStage = stagedOperationId !== null;

  useLayoutEffect(() => {
    if (!visible) return;
    const grid = gridRef.current;
    if (!grid) return;
    const recordRects = () => {
      const currentIds = new Set<string>();
      const targets = mapMode
        ? grid.closest(".canvas-triage-deck")?.querySelectorAll<HTMLElement>("[data-triage-map-dot]") ?? []
        : grid.querySelectorAll<HTMLElement>("[data-triage-deck-card]");
      for (const target of targets) {
        const operationId = target.dataset.triageMapDot ?? target.dataset.triageDeckCard;
        if (!operationId) continue;
        currentIds.add(operationId);
        if (target.classList.contains("is-quicklook")) {
          const gridRect = grid.getBoundingClientRect();
          const unscaledRect = new DOMRect(
            gridRect.left + (target.offsetLeft - grid.offsetLeft) - grid.scrollLeft,
            gridRect.top + (target.offsetTop - grid.offsetTop) - grid.scrollTop,
            target.offsetWidth,
            target.offsetHeight,
          );
          deckCardRects.set(operationId, unscaledRect);
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
      fire();
      return;
    }
    clearQuicklookTimer();
    quicklookTimerRef.current = window.setTimeout(fire, TRIAGE_DECK_QUICKLOOK_DWELL_MS);
  };

  useEffect(() => {
    if (!visible || stagedOperationId !== null || mapMode) dismissQuicklook();
  }, [visible, stagedOperationId, mapMode]);

  useEffect(() => () => clearQuicklookTimer(), []);

  if (!visible) return null;

  const activities = operations.map((operation) => resolveOperationActivity(operation, operationStatus));
  const running = activities.filter((activity) => activity === "running").length;
  const idle = activities.filter((activity) => activity === "idle").length;
  // 밴드 순서: 대기 카드 수 내림차순 → 같으면 theaters 선언 순. 카드 없는 Theater는 밴드를 그리지 않는다.
  const bands = theaters
    .map((theater, theaterIndex) => {
      const theaterOperations = operations
        .filter((operation) => operation.theaterId === theater.id)
        .sort((left, right) => TRIAGE_DECK_ACTIVITY_RANK[resolveOperationActivity(left, operationStatus)]
          - TRIAGE_DECK_ACTIVITY_RANK[resolveOperationActivity(right, operationStatus)]);
      return { theater, theaterIndex, operations: theaterOperations };
    })
    .filter((band) => band.operations.length > 0)
    .sort((left, right) => {
      const leftWaiting = bandWaitingCount(left.operations, operationStatus);
      const rightWaiting = bandWaitingCount(right.operations, operationStatus);
      return rightWaiting - leftWaiting || left.theaterIndex - right.theaterIndex;
    });

  const pick = (operationId: string, element: HTMLElement) => {
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
          const bandActivities = band.operations.map((operation) => resolveOperationActivity(operation, operationStatus));
          const waiting = bandActivities.filter((activity) => activity === "awaiting").length;
          const bandRunning = bandActivities.filter((activity) => activity === "running").length;
          const bandIdle = bandActivities.filter((activity) => activity === "idle").length;
          return (
            <section className="canvas-triage-deck-band" key={band.theater.id}>
              <header className="canvas-triage-deck-band-head">
                <span className="canvas-triage-deck-band-chip" aria-hidden="true">{theaterInitials(band.theater.label)}</span>
                <span className="canvas-triage-deck-band-label">{band.theater.label}</span>
                <span className="canvas-triage-deck-band-rule" aria-hidden="true" />
                <span className="canvas-triage-deck-band-counts">
                  {t("canvas.triage.bandCounts", { waiting, running: bandRunning, idle: bandIdle })}
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
                          if (event.pointerType === "touch") return;
                          if (arrivingOperationId === operation.id) return;
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
                <div className="canvas-triage-map" aria-hidden={!mapMode}>
                  {mapMode ? resolveTriageMapMarkerLayout(band.operations.map((operation) => ({
                    id: operation.id,
                    geometry: mapGeometryFor ? mapGeometryFor(operation) : operation.geometry,
                  }))).map((marker) => {
                    const operation = band.operations.find((candidate) => candidate.id === marker.operationId);
                    if (!operation) return null;
                    const visual = operationActivityVisual(resolveOperationActivity(operation, operationStatus));
                    return (
                      <button
                        key={marker.operationId}
                        type="button"
                        className={`canvas-triage-map-dot is-${visual}`}
                        data-triage-map-dot={marker.operationId}
                        style={{ left: `${marker.x}%`, top: `${marker.y}%` } as CSSProperties}
                        aria-label={t("canvas.triage.deckCardAria", { title: operation.title })}
                        onClick={(event) => pick(operation.id, event.currentTarget)}
                      >
                        <span className="canvas-triage-map-dot-label">{operation.title}</span>
                      </button>
                    );
                  }) : null}
                </div>
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function bandWaitingCount(
  operations: readonly OperationNode[],
  operationStatus: Readonly<Record<string, OperationActivity>>,
): number {
  return operations.filter((operation) => isTriageWaitingOperation(operation, operationStatus)).length;
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
