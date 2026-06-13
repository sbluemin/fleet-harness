import { memo } from "react";

import { createTerminalSession, pickTerminalFolder } from "../api.js";
import { compactPath, describeJobStatus, formatClock, shortJobId, statusTone } from "../format.js";
import { beginCreateTerminalSession, completeCreateTerminalSession, failCreateTerminalSession, selectJob, selectTenant, selectTerminalSession } from "../store.js";
import type { ConsoleState, JobView, ObservedTenant, SessionInfo, TenantJobsView } from "../types.js";

interface SidebarProps {
  readonly state: ConsoleState;
}

interface TenantGroupProps {
  readonly tenant: ObservedTenant | undefined;
  readonly tenantId: string;
  readonly jobs: TenantJobsView | undefined;
  readonly expanded: boolean;
  readonly selectedJobId: string | null;
}

interface JobEntryProps {
  readonly job: JobView;
  readonly active: boolean;
}

interface SessionEntryProps {
  readonly session: SessionInfo;
  readonly active: boolean;
}

export function Sidebar({ state }: SidebarProps) {
  const tenantIds = state.tenantOrder.length > 0 ? state.tenantOrder : state.tenants.map((tenant) => tenant.tenantId);
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
    <nav className="sidebar" aria-label="Workspaces and jobs">
      <div className="sidebar-heading">
        <p className="sidebar-eyebrow">Workspaces</p>
        <button type="button" className="workspace-add-button" onClick={handleCreateSession} disabled={state.creatingTerminalSession} aria-label="Add workspace">
          +
        </button>
      </div>
      {state.sessionOrder.length > 0 ? (
        <ol className="session-list">
          {state.sessionOrder.map((sessionId) => {
            const session = state.sessions[sessionId];
            return session ? <SessionEntry key={sessionId} session={session} active={state.activeTerminalSessionId === sessionId} /> : null;
          })}
        </ol>
      ) : null}
      {state.terminalSessionError ? <p className="sidebar-error">{state.terminalSessionError}</p> : null}
      {tenantIds.length === 0 ? (
        <p className="sidebar-empty">
          No CLI workspaces connected.
          <br />
          Launch a Fleet CLI session to begin observing.
        </p>
      ) : (
        tenantIds.map((tenantId) => (
          <TenantGroup
            key={tenantId}
            tenantId={tenantId}
            tenant={state.tenants.find((candidate) => candidate.tenantId === tenantId)}
            jobs={state.tenantJobs[tenantId]}
            expanded={state.selectedTenantId === tenantId}
            selectedJobId={state.selectedJobId}
          />
        ))
      )}
    </nav>
  );
}

const SessionEntry = memo(function SessionEntry({ session, active }: SessionEntryProps) {
  const live = session.status === "registered" || session.status === "live" || session.status === "terminal-only";
  return (
    <li>
      <button type="button" className={`session-row ${active ? "is-active" : ""}`} onClick={() => selectTerminalSession(session.sessionId)} aria-current={active || undefined}>
        <span className={`tenant-beacon ${live ? "is-live" : ""}`} aria-hidden="true" />
        <span className="tenant-row-text">
          <span className="tenant-label">{session.cwdLabel}</span>
          <span className="tenant-path">{session.status}</span>
        </span>
      </button>
    </li>
  );
});

const TenantGroup = memo(function TenantGroup({ tenant, tenantId, jobs, expanded, selectedJobId }: TenantGroupProps) {
  const label = tenant?.tenantLabel ?? jobs?.tenantLabel ?? tenantId;
  const jobCount = jobs?.jobOrder.length ?? 0;
  const liveCount = jobs ? jobs.jobOrder.filter((jobId) => statusTone(jobs.jobs[jobId]?.status ?? "") === "live").length : 0;
  return (
    <section className={`tenant-group ${expanded ? "is-expanded" : ""}`}>
      <button type="button" className="tenant-row" onClick={() => selectTenant(tenantId)} aria-current={expanded || undefined}>
        <span className={`tenant-beacon ${liveCount > 0 ? "is-live" : ""}`} aria-hidden="true" />
        <span className="tenant-row-text">
          <span className="tenant-label">{label}</span>
          {tenant ? <span className="tenant-path">{compactPath(tenant.cwd)}</span> : null}
        </span>
        <span className="tenant-count">{jobCount}</span>
      </button>
      {expanded ? (
        <ol className="job-list">
          {jobs && jobs.truncation.droppedCount > 0 ? (
            <li className="job-list-notice">{jobs.truncation.droppedCount} older events dropped by retention</li>
          ) : null}
          {jobs && jobs.jobOrder.length > 0 ? (
            jobs.jobOrder.map((jobId) => {
              const job = jobs.jobs[jobId];
              return job ? <JobEntry key={jobId} job={job} active={jobId === selectedJobId} /> : null;
            })
          ) : (
            <li className="job-list-empty">No jobs observed yet.</li>
          )}
        </ol>
      ) : null}
    </section>
  );
});

const JobEntry = memo(function JobEntry({ job, active }: JobEntryProps) {
  const tone = statusTone(job.status);
  return (
    <li>
      <button
        type="button"
        className={`job-row ${active ? "is-active" : ""}`}
        onClick={() => selectJob(job.tenantId, job.jobId)}
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
