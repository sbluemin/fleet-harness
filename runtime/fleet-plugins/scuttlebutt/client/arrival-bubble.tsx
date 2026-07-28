import type {
  FloatingWidgetArrival,
  FloatingWidgetArrivalsCapability,
} from "@fleet-console/sdk/floating";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { React } from "@fleet-console/sdk/plugin/browser";

import { getT } from "./i18n.js";

export const MAX_ARRIVAL_ANNOUNCEMENTS = 3;
export const ARRIVAL_VISIBLE_MS = 6_000;

export interface ArrivalAnnouncement {
  readonly id: string;
  readonly arrivals: readonly FloatingWidgetArrival[];
}

export interface ArrivalSelectionState {
  readonly announcedIds: ReadonlySet<string>;
  readonly queue: readonly ArrivalAnnouncement[];
  readonly sequence: number;
}

export function createArrivalSelectionState(
  initial: readonly FloatingWidgetArrival[],
): ArrivalSelectionState {
  return {
    announcedIds: new Set(initial.map((arrival) => arrival.operationId)),
    queue: [],
    sequence: 0,
  };
}

export function selectArrivalAnnouncements(
  state: ArrivalSelectionState,
  arrivals: readonly FloatingWidgetArrival[],
): ArrivalSelectionState {
  // 원장은 "지금 대기 중인 것"만 담는다. 확인이 끝나 목록에서 빠진 Operation을 남겨 두면
  // 그 Operation이 다시 대기 상태가 되어도 영영 알림이 오지 않는다.
  const present = new Set(arrivals.map((arrival) => arrival.operationId));
  const retained = [...state.announcedIds].filter((operationId) => present.has(operationId));
  const next = arrivals.filter((arrival) => !state.announcedIds.has(arrival.operationId));
  if (next.length === 0) {
    return retained.length === state.announcedIds.size
      ? state
      : { ...state, announcedIds: new Set(retained) };
  }
  const announcedIds = new Set(retained);
  for (const arrival of next) announcedIds.add(arrival.operationId);
  // 같은 Operation이 다시 도착하면 식별자가 겹치므로 순번을 붙여 매 알림을 구분한다.
  const sequence = state.sequence + 1;
  const announcement: ArrivalAnnouncement = {
    id: [String(sequence), ...next.map((arrival) => arrival.operationId)].join("\u0000"),
    arrivals: next,
  };
  return {
    announcedIds,
    sequence,
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
  const onShowRef = React.useRef(onShow);
  React.useEffect(() => {
    onShowRef.current = onShow;
  }, [onShow]);
  const [selection, setSelection] = React.useState(() => createArrivalSelectionState(arrivals.list()));
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
    // 좌표를 상태로 돌리면 프레임마다 리렌더가 돈다 — 따라붙는 값은 DOM에 직접 쓴다.
    bubble.style.left = `${left}px`;
    if (placeAbove) {
      bubble.style.top = "";
      bubble.style.bottom = `${window.innerHeight - mascotRect.top + gap}px`;
    } else {
      bubble.style.bottom = "";
      bubble.style.top = `${mascotRect.bottom + gap}px`;
    }
    bubble.style.visibility = "visible";
  }, [mascot]);

  // 새는 매 프레임 스스로 좌표를 쓰므로 리액트 갱신이 없다 — 말풍선이 붙어 있으려면 같이 따라가야 한다.
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
    // onShow 를 의존성에 두면 부모가 리렌더할 때마다 타이머가 리셋되어 말풍선이 영영 안 사라진다.
    const timeout = window.setTimeout(() => {
      setSelection((state) => dismissArrivalAnnouncement(state));
    }, ARRIVAL_VISIBLE_MS);
    return () => window.clearTimeout(timeout);
  }, [active, quiet]);

  if (!quiet || !active) return null;
  const t = getT(locale);
  const detail = active.arrivals.length === 1
    ? active.arrivals[0]?.title ?? ""
    : t("arrival.manyCount", { count: active.arrivals.length });
  return (
    <button
      ref={bubbleRef}
      type="button"
      className="scuttlebutt-arrival-bubble"
      tabIndex={-1}
      aria-live="polite"
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => setSelection((state) => dismissArrivalAnnouncement(state))}
    >
      <span className="scuttlebutt-arrival-label">{t("arrival.done")}</span>
      <span className="scuttlebutt-arrival-detail">{detail}</span>
    </button>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
