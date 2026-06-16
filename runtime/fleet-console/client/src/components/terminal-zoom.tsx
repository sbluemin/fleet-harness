import { isTerminalJobStatus } from "../reduce.js";
import { sessionJobs, toggleTerminalZoom } from "../store.js";
import type { ConsoleState } from "../types.js";
import { CarrierJobLines } from "./carrier-job-lines.js";

interface TerminalZoomProps {
  readonly state: ConsoleState;
  readonly sessionId: string;
  readonly expanded: boolean;
}

export function TerminalZoom({ state, sessionId, expanded }: TerminalZoomProps) {
  const session = state.sessions[sessionId];
  const jobs = session ? sessionJobs(state, session).filter(({ job }) => !isTerminalJobStatus(job.status)).map(({ job }) => job) : [];
  return (
    <>
      <button
        type="button"
        className={`terminal-zoom-toggle ${expanded ? "is-expanded" : ""}`}
        onClick={() => toggleTerminalZoom(sessionId)}
        aria-label={expanded ? "터미널 축소" : "터미널 확대"}
        title={expanded ? "터미널 축소" : "터미널 확대"}
      >
        {expanded ? <CollapseIcon /> : <ExpandIcon />}
      </button>
      {jobs.length > 0 ? (
        <div className="terminal-job-dock" aria-label="Active carrier jobs in terminal">
          <CarrierJobLines jobs={jobs} selectedJobId={state.selectedJobId} />
        </div>
      ) : null}
    </>
  );
}

function ExpandIcon() {
  // Sidebar 아이콘과 같은 가는 stroke·둥근 끝 언어를 쓰는 대각 확대 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6.4 3.2H3.2v3.2M3.4 3.4l4.1 4.1M9.6 12.8h3.2V9.6M12.6 12.6 8.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CollapseIcon() {
  // 확대 상태에서 원래 레이아웃으로 돌아가는 안쪽 대각 화살표 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M7 7H3.8M3.8 7V3.8M3.9 7.1l4-4M9 9h3.2M12.2 9v3.2M12.1 8.9l-4 4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
