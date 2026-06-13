import { memo } from "react";

import { createTerminalSession, pickTerminalFolder } from "../api.js";
import { describeJobStatus, formatClock, shortJobId, statusTone } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { beginCreateTerminalSession, completeCreateTerminalSession, failCreateTerminalSession, selectJob, selectTerminalSession, sessionJobs } from "../store.js";
import type { SessionJob } from "../store.js";
import type { ConsoleState, JobView, SessionInfo } from "../types.js";

interface SidebarProps {
  readonly state: ConsoleState;
}

interface JobEntryProps {
  readonly job: JobView;
  readonly active: boolean;
}

interface SessionEntryProps {
  readonly session: SessionInfo;
  readonly active: boolean;
  readonly jobs: readonly SessionJob[];
  readonly selectedJobId: string | null;
}

export function Sidebar({ state }: SidebarProps) {
  const handleCreateSession = async () => {
    if (state.creatingTerminalSession) return;
    beginCreateTerminalSession();
    try {
      const picked = await pickTerminalFolder();
      if ("cancelled" in picked) {
        failCreateTerminalSession("");
        return;
      }
      completeCreateTerminalSession(await createTerminalSession(picked.folderGrantId));
    } catch (error) {
      failCreateTerminalSession(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <nav className="sidebar" aria-label="Admiral sessions and carrier jobs">
      <div className="sidebar-heading">
        <p className="sidebar-eyebrow">Admirals</p>
        <button type="button" className="workspace-add-button" onClick={handleCreateSession} disabled={state.creatingTerminalSession} aria-label="Add admiral station">
          +
        </button>
      </div>
      {state.sessionOrder.length > 0 ? (
        <ol className="session-list">
          {state.sessionOrder.map((sessionId) => {
            const session = state.sessions[sessionId];
            if (!session) return null;
            return (
              <SessionEntry
                key={sessionId}
                session={session}
                active={state.activeTerminalSessionId === sessionId}
                jobs={sessionJobs(state, session)}
                selectedJobId={state.selectedJobId}
              />
            );
          })}
        </ol>
      ) : null}
      {state.terminalSessionError ? <p className="sidebar-error">{state.terminalSessionError}</p> : null}
      {state.sessionOrder.length === 0 ? (
        <p className="sidebar-empty">
          No Admiral stations on watch.
          <br />
          Add a station to bring a Fleet terminal alongside.
        </p>
      ) : null}
    </nav>
  );
}

const SessionEntry = memo(function SessionEntry({ session, active, jobs, selectedJobId }: SessionEntryProps) {
  const activeCount = jobs.filter(({ job }) => !isTerminalJobStatus(job.status)).length;
  const live = activeCount > 0 || session.status === "registered" || session.status === "live" || session.status === "terminal-only";
  return (
    <li className={`session-item ${active ? "is-active" : ""}`}>
      <button type="button" className={`session-row ${active ? "is-active" : ""}`} onClick={() => selectTerminalSession(session.sessionId)} aria-current={active || undefined}>
        <span className={`tenant-beacon ${live ? "is-live" : ""}`} aria-hidden="true" />
        <span className="tenant-row-text">
          <span className="tenant-label">{session.cwdLabel}</span>
          <span className="tenant-path">{session.status}</span>
        </span>
        {!active && jobs.length > 0 ? <span className="tenant-count">{jobs.length}</span> : null}
      </button>
      {active ? (
        <ol className="session-job-list">
          {jobs.length > 0 ? (
            jobs.map(({ job }) => <JobEntry key={job.jobId} job={job} active={job.jobId === selectedJobId} />)
          ) : (
            <li className="job-list-empty">No carrier jobs in this session.</li>
          )}
        </ol>
      ) : null}
    </li>
  );
});

const JobEntry = memo(function JobEntry({ job, active }: JobEntryProps) {
  const tone = statusTone(job.status);
  return (
    <li>
      <button
        type="button"
        className={`job-row ${active ? "is-active" : ""}`}
        onClick={() => selectJob(job.jobId)}
        aria-current={active || undefined}
      >
        <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
        <span className="job-row-text">
          <span className="job-row-label">{job.label ?? shortJobId(job.jobId)}</span>
          <span className="job-row-meta">
            {describeJobStatus(job.status)} · {formatClock(job.updatedAt)}
          </span>
        </span>
      </button>
    </li>
  );
});
