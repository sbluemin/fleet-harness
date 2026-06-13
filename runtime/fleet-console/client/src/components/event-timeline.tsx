import { memo } from "react";

import { formatClock } from "../format.js";
import type { ObservedEvent } from "../types.js";

interface EventTimelineProps {
  readonly events: readonly ObservedEvent[];
}

const PAYLOAD_PREVIEW_LIMIT = 400;
const PAYLOAD_TEXT_KEYS = ["text", "fallbackText", "fallbackThought"] as const;

export const EventTimeline = memo(function EventTimeline({ events }: EventTimelineProps) {
  return (
    <ol className="timeline" aria-label="Raw event timeline">
      {events.length === 0 ? <li className="timeline-empty">No events observed.</li> : null}
      {events.map((_, index) => {
        const event = events[events.length - 1 - index];
        return event ? <TimelineRow key={event.id} event={event} /> : null;
      })}
    </ol>
  );
});

const TimelineRow = memo(function TimelineRow({ event }: { readonly event: ObservedEvent }) {
  return (
    <li className="timeline-row">
      <time className="timeline-time">{formatClock(event.at)}</time>
      <span className="timeline-type">{event.type}</span>
      <code className="timeline-payload">{previewPayload(event.event)}</code>
    </li>
  );
});

function previewPayload(payload: Record<string, unknown>): string {
  const compact: Record<string, unknown> = { ...payload };
  delete compact.type;
  for (const key of PAYLOAD_TEXT_KEYS) {
    const value = compact[key];
    if (typeof value === "string") {
      compact[key] = value.length > 60 ? `${value.slice(0, 60)}… (${value.length} chars)` : value;
    }
  }
  const serialized = JSON.stringify(compact);
  return serialized.length > PAYLOAD_PREVIEW_LIMIT ? `${serialized.slice(0, PAYLOAD_PREVIEW_LIMIT)}…` : serialized;
}
