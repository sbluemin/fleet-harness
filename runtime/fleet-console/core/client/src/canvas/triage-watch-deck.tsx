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
  /** 카드 본문 라이브 프리뷰용 pool 슬롯 config 빌더 — 핸들러 배선은 canvas가 단일 소유한다. */
  readonly previewConfigFor?: (operation: OperationNode) => OperationBodyConfig;
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
  previewConfigFor,
}: TriageWatchDeckProps) {
  const t = useT();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(Date.now());
  const poolAvailable = useOperationBodyPoolAvailable();
  useOperationStatusDetails();
  const visible = active && !entering && theaterId !== null && operations.length > 0;

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

  useLayoutEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [visible]);

  if (!visible) return null;

  const activities = operations.map((operation) => resolveOperationActivity(operation, operationStatus));
  const running = activities.filter((activity) => activity === "running").length;
  const idle = activities.filter((activity) => activity === "idle").length;

  return (
    <section className="canvas-triage-deck" data-canvas-blocker>
      <div className="canvas-triage-deck-caption">
        {t("canvas.triage.deckCaption", { running, idle })}
      </div>
      <div className="canvas-triage-deck-grid" ref={gridRef}>
        {operations.map((operation) => {
          const activity = resolveOperationActivity(operation, operationStatus);
          const visual = operationActivityVisual(activity);
          const label = operationActivityLabel(activity);
          const statusDetail = getOperationStatusDetailSnapshot(operation.id);
          const accentKey = operationAccent[operation.id] ?? operationAccentFromNode(operation);
          const accentColor = accentKey ? resolveAccentColor(accentKey) : null;
          const previewConfig = poolAvailable && previewConfigFor ? previewConfigFor(operation) : null;
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
                <time>{formatElapsed(now, statusDetail.activityChangedAt)}</time>
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
// 패널 전체를 min 비율로 fit해 중앙 배치한다 — 한 축 크롭은 신선한 셸(상단 프롬프트)이나
// 긴 세션(하단 최신 줄) 중 한쪽을 반드시 가리므로 전체 표시가 유일하게 안전하다.
function TriageDeckCardPreview({ operationId, config }: {
  readonly operationId: string;
  readonly config: OperationBodyConfig;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ scale: number; left: number; top: number } | null>(null);
  const innerWidth = Math.max(320, config.geometry.width);
  const innerHeight = Math.max(240, config.geometry.height);
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
      const scale = Math.min(width / innerWidth, height / innerHeight);
      setFit({
        scale,
        left: Math.max(0, (width - innerWidth * scale) / 2),
        top: Math.max(0, (height - innerHeight * scale) / 2),
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

export function formatElapsed(now: number, changedAt: number | null): string {
  const totalSeconds = Math.max(0, Math.floor((now - (changedAt ?? now)) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function escapeAttributeValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}
