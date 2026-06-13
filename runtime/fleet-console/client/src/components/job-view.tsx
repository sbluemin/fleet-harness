import { memo } from "react";

import { describeJobStatus, formatClock, formatElapsed, shortJobId, statusTone } from "../format.js";
import { usePinnedScroll } from "../hooks/use-pinned-scroll.js";
import { toggleTimeline } from "../store.js";
import type { JobView as JobViewModel } from "../types.js";
import { EventTimeline } from "./event-timeline.js";
import { TrackCard } from "./track-card.js";

interface JobViewProps {
  readonly job: JobViewModel | null;
  readonly timelineOpen: boolean;
}

export function JobView({ job, timelineOpen }: JobViewProps) {
  const { containerRef, pinned, jumpToLatest } = usePinnedScroll(job?.jobId ?? "none", job?.lastEventId ?? 0);
  if (!job) {
    return (
      <main className="stage">
        <div className="stage-idle">
          <p className="stage-idle-mark" aria-hidden="true">▵</p>
          <h2>Standing by</h2>
          <p>Select a job from the left rail, or dispatch carriers from a Fleet session.</p>
        </div>
      </main>
    );
  }
  return (
    <main className="stage">
      <JobHeader job={job} />
      <div className="stage-stream">
        <div className="stage-scroll" ref={containerRef} tabIndex={-1}>
          <div className="stage-content">
            {job.trackOrder.length === 0 ? (
              <p className="stage-waiting">
                <span className="stream-caret" aria-hidden="true" /> waiting for track registration
              </p>
            ) : (
              job.trackOrder.map((trackId) => {
                const track = job.tracks[trackId];
                return track ? <TrackCard key={`${job.jobId}:${trackId}`} track={track} /> : null;
              })
            )}
            {job.summary ? <JobSummary summary={job.summary} status={job.status} error={job.error} /> : null}
          </div>
        </div>
        {!pinned ? (
          <button type="button" className="follow-button" onClick={jumpToLatest}>
            ↓ Follow stream
          </button>
        ) : null}
      </div>
      <section className={`timeline-dock ${timelineOpen ? "is-open" : ""}`}>
        <button type="button" className="timeline-toggle" onClick={toggleTimeline} aria-expanded={timelineOpen}>
          <span className="timeline-chevron" aria-hidden="true">{timelineOpen ? "▾" : "▴"}</span>
          Event timeline
          <span className="timeline-count">{job.recentEvents.length}</span>
        </button>
        {timelineOpen ? <EventTimeline events={job.recentEvents} /> : null}
      </section>
    </main>
  );
}

const JobHeader = memo(function JobHeader({ job }: { readonly job: JobViewModel }) {
  const tone = statusTone(job.status);
  const elapsed = job.startedAt ? formatElapsed(job.startedAt, job.finishedAt ?? job.updatedAt) : null;
  return (
    <header className="job-head">
      <div className="job-head-id">
        <span className={`status-dot status-dot--${tone} status-dot--lg`} aria-hidden="true" />
        <div>
          <h2 className="job-title">{job.label ?? shortJobId(job.jobId)}</h2>
          <p className="job-meta">
            <span className={`job-status job-status--${tone}`}>{describeJobStatus(job.status)}</span>
            {job.ownerCarrierId ? <span>· {job.ownerCarrierId}</span> : null}
            {job.kind ? <span>· {job.kind}</span> : null}
            {elapsed ? <span>· {elapsed}</span> : null}
            {job.startedAt ? <span>· started {formatClock(job.startedAt)}</span> : null}
          </p>
        </div>
      </div>
      <code className="job-id" title={job.jobId}>{shortJobId(job.jobId)}</code>
    </header>
  );
});

function JobSummary({ summary, status, error }: { readonly summary: string; readonly status: string; readonly error?: string }) {
  return (
    <aside className={`job-summary job-summary--${statusTone(status)}`}>
      <p className="job-summary-eyebrow">{status === "error" ? "Finalized with error" : "Finalized"}</p>
      <p className="job-summary-text">{summary}</p>
      {error ? <p className="job-summary-error">{error}</p> : null}
    </aside>
  );
}
