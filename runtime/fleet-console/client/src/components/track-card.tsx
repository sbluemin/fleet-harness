import { memo, useState } from "react";

import { describeTrackStatus, statusTone } from "../format.js";
import type { TrackView } from "../types.js";

interface TrackCardProps {
  readonly track: TrackView;
}

interface ToolRailProps {
  readonly track: TrackView;
}

export const TrackCard = memo(function TrackCard({ track }: TrackCardProps) {
  const tone = statusTone(track.status);
  const streaming = track.status === "stream";
  const truncated = track.sentTextLength > track.text.length || track.sentThoughtLength > track.thought.length;
  const emittedTotal = track.sentTextLength + track.sentThoughtLength;
  return (
    <article className={`track-card track-card--${tone}`}>
      <header className="track-head">
        <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
        <h3 className="track-name">{track.displayName}</h3>
        {track.displayCli ? <span className="track-tag">{track.displayCli}</span> : null}
        {track.model ? <span className="track-tag track-tag--dim">{track.model}</span> : null}
        {track.effort ? <span className="track-tag track-tag--dim">{track.effort}</span> : null}
        <span className={`track-status track-status--${tone}`}>{describeTrackStatus(track.status)}</span>
      </header>
      {track.subtitle ? <p className="track-subtitle">{track.subtitle}</p> : null}
      {track.requestPreview ? <RequestPreview preview={track.requestPreview} /> : null}
      {track.thought ? <ThoughtFold thought={track.thought} streaming={streaming && !track.text} /> : null}
      <ToolRail track={track} />
      {track.text ? (
        <div className="track-output" data-streaming={streaming || undefined}>
          <pre className="track-text">
            {track.text}
            {streaming ? <span className="stream-caret" aria-hidden="true" /> : null}
          </pre>
        </div>
      ) : streaming || track.status === "conn" || track.status === "queued" ? (
        <p className="track-waiting">
          <span className="stream-caret" aria-hidden="true" /> awaiting output
        </p>
      ) : null}
      {truncated ? (
        <p className="track-notice">Output partially retained — {emittedTotal.toLocaleString()} chars emitted in total.</p>
      ) : null}
      {track.error ? <p className="track-error">{track.error}</p> : null}
    </article>
  );
});

function RequestPreview({ preview }: { readonly preview: string }) {
  return (
    <p className="track-request" title={preview}>
      <span className="track-request-mark" aria-hidden="true">▸</span>
      {preview}
    </p>
  );
}

function ThoughtFold({ thought, streaming }: { readonly thought: string; readonly streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`thought-fold ${open ? "is-open" : ""}`}>
      <button type="button" className="thought-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="thought-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
        reasoning
        {streaming ? <span className="stream-caret stream-caret--dim" aria-hidden="true" /> : null}
      </button>
      {open ? <pre className="thought-text">{thought}</pre> : null}
    </div>
  );
}

function ToolRail({ track }: ToolRailProps) {
  if (track.tools.length === 0) return null;
  return (
    <ul className="tool-rail" aria-label="Tool calls">
      {track.tools.map((tool) => (
        <li key={tool.key} className={`tool-chip tool-chip--${toolTone(tool.status)}`}>
          <span className="tool-chip-glyph" aria-hidden="true">⚙</span>
          <span className="tool-chip-title">{tool.title}</span>
          {tool.status ? <span className="tool-chip-status">{tool.status}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function toolTone(status: string): "live" | "ok" | "bad" | "idle" {
  const normalized = status.toLowerCase();
  if (normalized.includes("error") || normalized.includes("fail")) return "bad";
  if (normalized.includes("done") || normalized.includes("ok") || normalized.includes("complete")) return "ok";
  if (normalized.includes("run") || normalized.includes("progress") || normalized.includes("stream")) return "live";
  return "idle";
}
