import type {
  FloatingWidgetDeparture,
  FloatingWidgetDeparturesCapability,
} from "@fleet-console/sdk/floating";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import {
  createArrivalSelectionState,
  dismissArrivalAnnouncement,
  selectArrivalAnnouncements,
  type ArrivalSelectionState,
} from "./arrival-bubble.js";
import { getT } from "./i18n.js";

export const MAX_DEPARTURE_ANNOUNCEMENTS = 3;
export const DEPARTURE_VISIBLE_MS = 6_000;

export const createDepartureSelectionState = createArrivalSelectionState;
export const dismissDepartureAnnouncement = dismissArrivalAnnouncement;

// departure 엔트리는 30초면 원장에서 만료된다 — quiet 중 쌓인 큐가 만료를 넘기면 카드를 닫는
// 순간 한참 전의 시작을 "방금 시작"처럼 거짓 알린다. 큐에는 원장에 남아 있는 시작만 유지한다.
export function selectDepartureAnnouncements(
  state: ArrivalSelectionState,
  departures: readonly FloatingWidgetDeparture[],
): ArrivalSelectionState {
  const present = new Set(departures.map((item) => item.operationId));
  let pruned = false;
  const queue = state.queue
    .map((announcement) => {
      const arrivals = announcement.arrivals.filter((item) => present.has(item.operationId));
      if (arrivals.length !== announcement.arrivals.length) pruned = true;
      return { ...announcement, arrivals };
    })
    .filter((announcement) => {
      if (announcement.arrivals.length === 0) pruned = true;
      return announcement.arrivals.length > 0;
    });
  // 프룬할 게 없으면 원래 상태를 그대로 넘겨 selector의 동일성(identity) 보존을 깨지 않는다.
  return selectArrivalAnnouncements(pruned ? { ...state, queue } : state, departures);
}

export function DepartureBubble({
  departures,
  locale,
  mascot,
  quiet,
  positionRevision,
  onShow,
}: {
  readonly departures: FloatingWidgetDeparturesCapability;
  readonly locale?: ConsoleLocale;
  readonly mascot: React.RefObject<HTMLButtonElement | null>;
  readonly quiet: boolean;
  readonly positionRevision: number;
  readonly onShow: () => void;
}) {
  const bubbleRef = React.useRef<HTMLButtonElement>(null);
  const shownRef = React.useRef(new Set<string>());
  const onShowRef = React.useRef(onShow);
  React.useEffect(() => {
    onShowRef.current = onShow;
  }, [onShow]);
  const [selection, setSelection] = React.useState(() => createDepartureSelectionState(departures.list()));
  const active = selection.queue[0];

  React.useEffect(() => departures.subscribe((current) => {
    setSelection((state) => selectDepartureAnnouncements(state, current));
  }), [departures]);

  const updatePlacement = React.useCallback(() => {
    const mascotElement = mascot.current;
    const bubble = bubbleRef.current;
    if (!mascotElement || !bubble) return;
    const arrival = document.querySelector<HTMLButtonElement>(".scuttlebutt-arrival-bubble");
    placeDepartureBubble({
      bubble,
      mascot: mascotElement,
      arrival,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  }, [mascot]);

  React.useLayoutEffect(() => {
    if (!quiet || !active) return;
    let frame = window.requestAnimationFrame(function follow() {
      updatePlacement();
      frame = window.requestAnimationFrame(follow);
    });
    updatePlacement();
    return () => window.cancelAnimationFrame(frame);
  }, [active, positionRevision, quiet, updatePlacement]);

  React.useEffect(() => {
    if (!quiet || !active) return;
    if (!shownRef.current.has(active.id)) {
      shownRef.current.add(active.id);
      onShowRef.current();
    }
    const timeout = window.setTimeout(() => {
      setSelection((state) => dismissDepartureAnnouncement(state));
    }, DEPARTURE_VISIBLE_MS);
    return () => window.clearTimeout(timeout);
  }, [active, quiet]);

  if (!quiet || !active) return null;
  const t = getT(locale);
  const currentDepartures = active.arrivals as readonly FloatingWidgetDeparture[];
  const detail = currentDepartures.length === 1
    ? currentDepartures[0]?.title ?? ""
    : t("departure.manyCount", { count: currentDepartures.length });
  return (
    <button
      ref={bubbleRef}
      type="button"
      className="scuttlebutt-departure-bubble"
      tabIndex={-1}
      aria-live="polite"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => setSelection((state) => dismissDepartureAnnouncement(state))}
    >
      <span className="scuttlebutt-departure-label">{t("departure.started")}</span>
      <span className="scuttlebutt-departure-detail">{detail}</span>
    </button>
  );
}

export function placeDepartureBubble({
  bubble,
  mascot,
  arrival,
  viewportWidth,
  viewportHeight,
}: {
  readonly bubble: HTMLButtonElement;
  readonly mascot: HTMLButtonElement;
  readonly arrival: HTMLButtonElement | null;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}): void {
  const mascotRect = mascot.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const margin = 8;
  const gap = 8;
  const alignRight = mascotRect.left + mascotRect.width / 2 > viewportWidth / 2;
  const placeAbove = mascotRect.top + mascotRect.height / 2 > viewportHeight / 2;
  const preferredLeft = alignRight ? mascotRect.right - bubbleRect.width : mascotRect.left;
  const left = clamp(preferredLeft, margin, viewportWidth - bubbleRect.width - margin);
  const visibleArrival = arrival?.style.visibility === "visible" ? arrival : null;
  bubble.style.left = `${left}px`;
  if (placeAbove) {
    bubble.style.top = "";
    const bottom = visibleArrival
      ? viewportHeight - visibleArrival.getBoundingClientRect().top + gap
      : viewportHeight - mascotRect.top + gap;
    bubble.style.bottom = `${bottom}px`;
  } else {
    bubble.style.bottom = "";
    const top = visibleArrival
      ? visibleArrival.getBoundingClientRect().bottom + gap
      : mascotRect.bottom + gap;
    bubble.style.top = `${top}px`;
  }
  bubble.style.visibility = "visible";
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
