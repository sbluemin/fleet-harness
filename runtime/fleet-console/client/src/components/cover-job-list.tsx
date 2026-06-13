import { describeJobStatus, formatClock, shortJobId, statusTone } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { selectCoverJob } from "../store.js";
import type { ConsoleState, JobView } from "../types.js";

interface CoverJobListProps {
  readonly state: ConsoleState;
}

interface CoverJobRow {
  readonly job: JobView;
  readonly tenantLabel: string;
}

export function CoverJobList({ state }: CoverJobListProps) {
  const rows = listActiveJobs(state);
  return (
    <div className="cover-job-list" role="list">
      <div className="cover-panel-head">
        <p className="cover-panel-eyebrow">Carrier Cover</p>
        <p className="cover-panel-count">{rows.length}</p>
      </div>
      {rows.length > 0 ? (
        rows.map((row) => <CoverJobButton key={`${row.job.tenantId}:${row.job.jobId}`} row={row} />)
      ) : (
        <p className="cover-empty">No active carrier jobs.</p>
      )}
    </div>
  );
}

function CoverJobButton({ row }: { readonly row: CoverJobRow }) {
  const tone = statusTone(row.job.status);
  return (
    <button type="button" className="cover-job-row" onClick={() => selectCoverJob(row.job.jobId)} role="listitem">
      <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
      <span className="cover-job-row-text">
        <span className="cover-job-label">{row.job.label ?? shortJobId(row.job.jobId)}</span>
        <span className="cover-job-meta">
          {row.tenantLabel} · {row.job.ownerCarrierId ?? "carrier"} · {describeJobStatus(row.job.status)} · {formatClock(row.job.updatedAt)}
        </span>
      </span>
    </button>
  );
}

function listActiveJobs(state: ConsoleState): readonly CoverJobRow[] {
  const rows: CoverJobRow[] = [];
  for (const tenantId of state.tenantOrder) {
    const tenant = state.tenantJobs[tenantId];
    if (!tenant) continue;
    const tenantLabel = tenant.tenantLabel ?? state.tenants.find((candidate) => candidate.tenantId === tenantId)?.tenantLabel ?? tenantId;
    for (const jobId of tenant.jobOrder) {
      const job = tenant.jobs[jobId];
      if (job && !isTerminalJobStatus(job.status)) rows.push({ job, tenantLabel });
    }
  }
  return rows.sort((a, b) => b.job.updatedAt - a.job.updatedAt);
}
