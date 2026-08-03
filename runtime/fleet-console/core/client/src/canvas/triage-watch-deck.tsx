import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { OperationActivity } from "@fleet-console/sdk/plugin";

import { useT } from "../i18n/index.js";
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
}

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

export function TriageWatchDeck({
  active,
  entering,
  theaterId,
  operations,
  operationStatus,
  operationAccent,
}: TriageWatchDeckProps) {
  const t = useT();
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(Date.now());
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
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(recordRects);
    observer.observe(grid);
    return () => observer.disconnect();
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
          return (
            <button
              className={`canvas-triage-deck-card is-${visual}`}
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
              <span className="canvas-triage-deck-card-detail" title={statusDetail.detail ?? label}>
                {statusDetail.detail ?? label}
              </span>
            </button>
          );
        })}
      </div>
    </section>
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
