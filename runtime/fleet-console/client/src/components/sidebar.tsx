import { memo } from "react";

import { createTheaterTerminalSession } from "../api.js";
import { describeJobStatus, formatCarrierName, latestStreamLine, shortJobId, statusTone } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { beginCreateTerminalSession, completeCreateTerminalSession, failCreateTerminalSession, selectJob, selectTerminalSession, sessionJobs, theaterSessionOrder } from "../store.js";
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
  const visibleSessionOrder = theaterSessionOrder(state);
  const handleCreateSession = async () => {
    if (state.creatingTerminalSession || state.addingTheater || !state.activeTheaterId) return;
    beginCreateTerminalSession();
    try {
      completeCreateTerminalSession(await createTheaterTerminalSession(state.activeTheaterId));
    } catch (error) {
      failCreateTerminalSession(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <nav className="sidebar" aria-label="Operation sessions and carrier jobs">
      <div className="sidebar-heading">
        <p className="sidebar-eyebrow">Operations</p>
        <button type="button" className="workspace-add-button" onClick={handleCreateSession} disabled={state.creatingTerminalSession || state.addingTheater || !state.activeTheaterId} aria-label="Launch operation">
          +
        </button>
      </div>
      {visibleSessionOrder.length > 0 ? (
        <ol className="session-list">
          {visibleSessionOrder.map((sessionId) => {
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
      {visibleSessionOrder.length === 0 ? (
        <p className="sidebar-empty">
          {state.activeTheaterId ? "No operations in this Theater." : "No Theaters registered."}
          <br />
          {state.activeTheaterId ? "Use + to launch one here." : "Add a Theater from the top bar."}
        </p>
      ) : null}
    </nav>
  );
}

const SessionEntry = memo(function SessionEntry({ session, active, jobs, selectedJobId }: SessionEntryProps) {
  const activeCount = jobs.filter(({ job }) => !isTerminalJobStatus(job.status)).length;
  const live = activeCount > 0 || session.status === "registered" || session.status === "live" || session.status === "terminal-only";
  // 진행 중인 잡을 위로, 완료(terminal)된 잡을 아래로 모은다. 안정 정렬이라 그룹 내부 등록 순서는 그대로 유지된다.
  const orderedJobs = [...jobs].sort((a, b) => Number(isTerminalJobStatus(a.job.status)) - Number(isTerminalJobStatus(b.job.status)));
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
          {orderedJobs.length > 0 ? (
            orderedJobs.map(({ job }) => <JobEntry key={job.jobId} job={job} active={job.jobId === selectedJobId} />)
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
  // 진행 중인 잡에 한해 job bar가 스트리밍하는 최신 한 줄을 노출하고, 완료되면 null이라 영역 자체가 사라진다.
  const streamLine = latestStreamLine(job);
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
          {streamLine ? <span className="job-row-stream">{streamLine}</span> : null}
          <span className="job-row-meta">
            {job.ownerCarrierId ? `${formatCarrierName(job.ownerCarrierId)} · ${describeJobStatus(job.status)}` : describeJobStatus(job.status)}
          </span>
        </span>
      </button>
    </li>
  );
});
