import { describeJobStatus, formatCarrierName, latestStreamLine, shortJobId, statusTone } from "../format.js";
import { selectJob } from "../store.js";
import type { JobView } from "../types.js";

interface CarrierJobLinesProps {
  readonly jobs: readonly JobView[];
  readonly selectedJobId: string | null;
}

interface CarrierJobLineProps {
  readonly job: JobView;
  readonly active: boolean;
}

// 진행 중 캐리어 job들을 한 줄씩(최신 스트림 미리보기 포함) 보여주는 공용 dock 본문.
// Helm은 터미널 내부 상단(terminal-job-dock)에, Map은 패널 위 floating(canvas-panel-jobdock)에 감싸 쓴다.
export function CarrierJobLines({ jobs, selectedJobId }: CarrierJobLinesProps) {
  return (
    <ol className="terminal-job-lines">
      {jobs.map((job) => (
        <CarrierJobLine key={job.jobId} job={job} active={selectedJobId === job.jobId} />
      ))}
    </ol>
  );
}

function CarrierJobLine({ job, active }: CarrierJobLineProps) {
  const tone = statusTone(job.status);
  const streamLine = latestStreamLine(job);
  const meta = job.ownerCarrierId ? `${formatCarrierName(job.ownerCarrierId)} · ${describeJobStatus(job.status)}` : describeJobStatus(job.status);
  return (
    <li>
      <button
        type="button"
        className={`terminal-job-line ${active ? "is-active" : ""}`}
        onClick={() => selectJob(job.jobId)}
        aria-current={active || undefined}
      >
        <span className={`status-dot status-dot--${tone}`} aria-hidden="true" />
        <span className="terminal-job-line-label">{job.label ?? shortJobId(job.jobId)}</span>
        <span className="terminal-job-line-meta">{meta}</span>
        {streamLine ? (
          <>
            <span className="terminal-job-line-sep" aria-hidden="true">-</span>
            <span className="terminal-job-line-stream">{streamLine}</span>
          </>
        ) : null}
      </button>
    </li>
  );
}
