import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
import { OperationBodySlot, useOperationBodyPoolAvailable, type OperationBodyConfig } from "../mobile/operation-body-pool.js";
import { operationActivityLabel, operationActivityVisual, resolveOperationActivity } from "../operation-activity.js";
import { getOperationStatusDetailSnapshot, useOperationStatusDetails } from "../operation-status-detail-store.js";
import type { OperationNode } from "../types.js";
import { operationAccentFromNode, resolveAccentColor } from "./operation-accent.js";
import { pickTriageOperation } from "./triage-store.js";

interface TriageWatchDeckProps {
  readonly active: boolean;
  readonly entering: boolean;
  readonly theaterId: string | null;
  readonly operations: readonly OperationNode[];
  readonly operationStatus: Readonly<Record<string, OperationActivity>>;
  readonly operationAccent: Readonly<Record<string, string>>;
  readonly arrivingOperationId?: string | null;
  /** 무대에 오른 Operation — 그 카드만 슬롯을 무대 프레임에 넘기고, deck는 은닉된 채 mount를 유지한다. */
  readonly stagedOperationId?: string | null;
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
  return deckCardRects.get(operationId) ?? null;
}

export function flashTriageDeckCard(operationId: string): void {
  const card = document.querySelector<HTMLElement>(`[data-triage-deck-card="${escapeAttributeValue(operationId)}"]`);
  if (!card) return;
  card.classList.remove("is-landed");
  void card.offsetWidth;
  card.classList.add("is-landed");
  window.setTimeout(() => card.classList.remove("is-landed"), CARD_FLASH_DURATION_MS);
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
  theaterId,
  operations,
  operationStatus,
  operationAccent,
  arrivingOperationId = null,
  stagedOperationId = null,
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
  // 무대가 떠 있는 동안에도 deck는 mount를 유지하고 visibility로만 숨는다 — 비무대 body가
  // 카드(고정 크기)와 숨김 프레임(크롬 제외 크기) 사이를 오가며 전 세션에 PTY 리사이즈를
  // 뿌리는 churn을 없애기 위해서다. 리사이즈는 무대에 오른 Operation에만 남는다.
  const visible = active && !entering && theaterId !== null && operations.length > 0;
  const underStage = stagedOperationId !== null;

  useLayoutEffect(() => {
    if (!visible) return;
    const grid = gridRef.current;
    if (!grid) return;
    const recordRects = () => {
      const currentIds = new Set<string>();
      for (const card of grid.querySelectorAll<HTMLElement>("[data-triage-deck-card]")) {
        const operationId = card.dataset.triageDeckCard;
        if (!operationId) continue;
        currentIds.add(operationId);
        // Quick-Look 확대 중인 카드는 getBoundingClientRect가 확대 rect를 주므로 레이아웃
        // 좌표(offset 기하는 transform 무영향)로 비확대 rect를 재구성한다 — 이 맵은 복귀
        // flight의 목적지라 확대 rect가 실리면 고스트가 카드 두 배 크기 자리로 날아가고,
        // 그렇다고 기록을 건너뛰면 확대 중 grid 스크롤이 일어났을 때 옛 위치가 남는다.
        if (card.classList.contains("is-quicklook")) {
          const gridRect = grid.getBoundingClientRect();
          const unscaledRect = new DOMRect(
            gridRect.left + (card.offsetLeft - grid.offsetLeft) - grid.scrollLeft,
            gridRect.top + (card.offsetTop - grid.offsetTop) - grid.scrollTop,
            card.offsetWidth,
            card.offsetHeight,
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
        deckCardRects.set(operationId, card.getBoundingClientRect());
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
    if (!visible || stagedOperationId !== null) dismissQuicklook();
  }, [visible, stagedOperationId]);

  // unmount 시 드웰 타이머를 반납한다 — unmount 뒤 발동하면 떠난 카드에 setState를 던진다.
  useEffect(() => () => clearQuicklookTimer(), []);

  if (!visible) return null;

  const activities = operations.map((operation) => resolveOperationActivity(operation, operationStatus));
  const running = activities.filter((activity) => activity === "running").length;
  const idle = activities.filter((activity) => activity === "idle").length;
  // 정렬: 응답 대기(awaiting) → 실행 중(running) → 유휴(idle). 같은 등급끼리는 기존 순서 유지.
  const sortedOperations = [...operations].sort(
    (left, right) => TRIAGE_DECK_ACTIVITY_RANK[resolveOperationActivity(left, operationStatus)]
      - TRIAGE_DECK_ACTIVITY_RANK[resolveOperationActivity(right, operationStatus)],
  );

  return (
    <section className={`canvas-triage-deck ${underStage ? "is-under-stage" : ""}`} data-canvas-blocker>
      <div className="canvas-triage-deck-caption">
        {t("canvas.triage.deckCaption", { running, idle })}
      </div>
      <div className="canvas-triage-deck-grid" ref={gridRef}>
        {sortedOperations.map((operation) => {
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
                // 터치엔 hover 개념이 없다 — 손가락으로 카드를 누를 때마다 확대가 번쩍이지 않게 차단.
                if (event.pointerType === "touch") return;
                // 도착 맥동(1100ms)이 진행 중인 카드에 드웰 확대가 겹치면 두 신호가 충돌해
                // 어떤 피드백인지 읽히지 않는다 — 맥동이 끝난 뒤에만 Quick-Look을 연다.
                if (arrivingOperationId === operation.id) return;
                armQuicklook(operation.id, event.currentTarget, true);
              }}
              onPointerLeave={dismissQuicklook}
              onFocus={(event) => {
                // 마우스 클릭 포커스는 onClick이 곧바로 승격시키므로 확대할 필요가 없고,
                // :focus-visible(키보드 포커스)일 때만 드웰 없이 즉시 Quick-Look을 연다.
                if (!event.currentTarget.matches(":focus-visible")) return;
                armQuicklook(operation.id, event.currentTarget, false);
              }}
              onBlur={dismissQuicklook}
              onClick={(event) => {
                // 클릭 순간의 rect(Quick-Look이면 확대된 모습 그대로)를 출발 전용 채널에 기록한다 —
                // 승격 flight는 사용자가 보고 있는 위치에서 출발해야 하고, deckCardRects는 복귀
                // flight 목적지용 비확대 rect로 남아야 하므로 두 용도를 분리한다.
                deckDepartureRect = { operationId: operation.id, rect: event.currentTarget.getBoundingClientRect() };
                pickTriageOperation(theaterId, operation.id);
              }}
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
    </section>
  );
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
