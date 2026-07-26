import type {
  FloatingWidgetArrival,
  FloatingWidgetArrivalsCapability,
} from "@fleet-console/sdk/floating";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "./i18n.js";

export const MAX_ARRIVAL_ANNOUNCEMENTS = 3;

export interface ArrivalAnnouncement {
  readonly id: string;
  readonly arrivals: readonly FloatingWidgetArrival[];
}

export interface ArrivalSelectionState {
  readonly announcedIds: ReadonlySet<string>;
  readonly queue: readonly ArrivalAnnouncement[];
}

export function createArrivalSelectionState(
  initial: readonly FloatingWidgetArrival[],
): ArrivalSelectionState {
  return {
    announcedIds: new Set(initial.map((arrival) => arrival.operationId)),
    queue: [],
  };
}

export function selectArrivalAnnouncements(
  state: ArrivalSelectionState,
  arrivals: readonly FloatingWidgetArrival[],
): ArrivalSelectionState {
  const next = arrivals.filter((arrival) => !state.announcedIds.has(arrival.operationId));
  if (next.length === 0) return state;
  const announcedIds = new Set(state.announcedIds);
  for (const arrival of next) announcedIds.add(arrival.operationId);
  const announcement: ArrivalAnnouncement = {
    id: next.map((arrival) => arrival.operationId).join("\u0000"),
    arrivals: next,
  };
  return {
    announcedIds,
    queue: [...state.queue, announcement].slice(-MAX_ARRIVAL_ANNOUNCEMENTS),
  };
}

export function dismissArrivalAnnouncement(state: ArrivalSelectionState): ArrivalSelectionState {
  return state.queue.length === 0 ? state : { ...state, queue: state.queue.slice(1) };
}

export function ArrivalBubble({
  arrivals,
  locale,
  mascot,
  quiet,
  positionRevision,
  onShow,
}: {
  readonly arrivals: FloatingWidgetArrivalsCapability;
  readonly locale?: ConsoleLocale;
  readonly mascot: React.RefObject<HTMLButtonElement | null>;
  readonly quiet: boolean;
  readonly positionRevision: number;
  readonly onShow: () => void;
}) {
  const bubbleRef = React.useRef<HTMLButtonElement>(null);
  const shownRef = React.useRef(new Set<string>());
  const [selection, setSelection] = React.useState(() => createArrivalSelectionState(arrivals.list()));
  const [placement, setPlacement] = React.useState<React.CSSProperties>({ visibility: "hidden" });
  const active = selection.queue[0];

  React.useEffect(() => arrivals.subscribe((current) => {
    setSelection((state) => selectArrivalAnnouncements(state, current));
  }), [arrivals]);

  const updatePlacement = React.useCallback(() => {
    const mascotElement = mascot.current;
    const bubble = bubbleRef.current;
    if (!mascotElement || !bubble) return;
    const mascotRect = mascotElement.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const margin = 8;
    const gap = 8;
    const alignRight = mascotRect.left + mascotRect.width / 2 > window.innerWidth / 2;
    const placeAbove = mascotRect.top + mascotRect.height / 2 > window.innerHeight / 2;
    const preferredLeft = alignRight ? mascotRect.right - bubbleRect.width : mascotRect.left;
    const left = clamp(preferredLeft, margin, window.innerWidth - bubbleRect.width - margin);
    if (placeAbove) {
      setPlacement({
        left,
        bottom: window.innerHeight - mascotRect.top + gap,
        visibility: "visible",
      });
    } else {
      setPlacement({
        left,
        top: mascotRect.bottom + gap,
        visibility: "visible",
      });
    }
  }, [mascot]);

  React.useLayoutEffect(() => {
    if (!quiet || !active) return;
    updatePlacement();
    const bubble = bubbleRef.current;
    if (typeof ResizeObserver === "undefined" || !bubble) return;
    const observer = new ResizeObserver(updatePlacement);
    observer.observe(bubble);
    return () => observer.disconnect();
  }, [active, positionRevision, quiet, updatePlacement]);

  React.useEffect(() => {
    if (!quiet || !active) return;
    if (!shownRef.current.has(active.id)) {
      shownRef.current.add(active.id);
      onShow();
    }
    const timeout = window.setTimeout(() => {
      setSelection((state) => dismissArrivalAnnouncement(state));
    }, 6_000);
    return () => window.clearTimeout(timeout);
  }, [active, onShow, quiet]);

  React.useEffect(() => {
    if (!quiet || !active) return;
    window.addEventListener("resize", updatePlacement);
    return () => window.removeEventListener("resize", updatePlacement);
  }, [active, quiet, updatePlacement]);

  if (!quiet || !active) return null;
  const t = getT(locale);
  const message = active.arrivals.length === 1
    ? t("arrival.one", { title: active.arrivals[0]?.title ?? "" })
    : t("arrival.many", { count: active.arrivals.length });
  return (
    <button
      ref={bubbleRef}
      type="button"
      className="scuttlebutt-arrival-bubble"
      style={placement}
      tabIndex={-1}
      aria-live="polite"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => setSelection((state) => dismissArrivalAnnouncement(state))}
    >
      {message}
    </button>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
