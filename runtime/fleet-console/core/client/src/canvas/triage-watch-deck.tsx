import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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
// 카드 정렬 등급 — 운영자 응답을 기다리는 것이 맨 앞, 그다음 실행 중, 유휴 순.
const TRIAGE_DECK_ACTIVITY_RANK: Record<OperationActivity, number> = {
  awaiting: 0,
  running: 1,
  idle: 2,
  dormant: 3,
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
  readonly dwell: TriageDeckArrivalDwell | null;
  readonly now: number;
  readonly suppressed: boolean;
}): TriageDeckPromotionDecision {
  if (!input.operationId || !input.deckVisible) {
    return { promote: input.operationId !== null, arrivingOperationId: null, dwell: null };
  }
  if (input.picked || input.suppressed) {
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
}: TriageWatchDeckProps) {
  const t = useT();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const poolAvailable = useOperationBodyPoolAvailable();
  useOperationStatusDetails();
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
          return (
            <button
              className={`canvas-triage-deck-card is-${visual} ${previewConfig ? "has-preview" : ""} ${arrivingOperationId === operation.id ? "is-arriving" : ""}`}
              data-triage-deck-card={operation.id}
              key={operation.id}
              type="button"
              aria-label={t("canvas.triage.deckCardAria", { title: operation.title })}
              onClick={() => pickTriageOperation(theaterId, operation.id)}
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
