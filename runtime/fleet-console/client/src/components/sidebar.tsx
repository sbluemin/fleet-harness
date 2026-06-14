import { memo, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { createTheaterTerminalSession, renameTerminalSession, terminateTerminalSession } from "../api.js";
import { describeJobStatus, formatCarrierName, latestStreamLine, sessionDisplayLabel, shortJobId, statusTone } from "../format.js";
import { isTerminalJobStatus } from "../reduce.js";
import { applySessionUpdate, beginCreateTerminalSession, completeCreateTerminalSession, failCreateTerminalSession, failRenameTerminalSession, failTerminateTerminalSession, removeTerminalSession, selectJob, selectTerminalSession, sessionJobs, theaterSessionOrder } from "../store.js";
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
          <PlusIcon />
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
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const activeCount = jobs.filter(({ job }) => !isTerminalJobStatus(job.status)).length;
  const live = activeCount > 0 || session.status === "registered" || session.status === "live" || session.status === "terminal-only";
  const displayLabel = sessionDisplayLabel(session);
  // 진행 중인 잡을 위로, 완료(terminal)된 잡을 아래로 모은다. 안정 정렬이라 그룹 내부 등록 순서는 그대로 유지된다.
  const orderedJobs = [...jobs].sort((a, b) => Number(isTerminalJobStatus(a.job.status)) - Number(isTerminalJobStatus(b.job.status)));

  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  // 세션 행 더블클릭으로 이름 변경 입력에 진입한다.
  const beginRename = () => {
    skipBlurCommitRef.current = false;
    setDraftLabel(displayLabel);
    setRenaming(true);
  };

  const cancelRename = () => {
    skipBlurCommitRef.current = true;
    setRenaming(false);
    setDraftLabel("");
  };

  const commitRename = async () => {
    if (committingRef.current) return;
    committingRef.current = true;
    try {
      applySessionUpdate(await renameTerminalSession(session.sessionId, draftLabel));
    } catch (error) {
      failRenameTerminalSession(error instanceof Error ? error.message : String(error));
    } finally {
      committingRef.current = false;
      skipBlurCommitRef.current = true;
      setRenaming(false);
    }
  };

  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
    }
  };

  return (
    <li className={`session-item ${active ? "is-active" : ""}`}>
      <div className="session-row-shell">
        {renaming ? (
          <div className={`session-row session-row-edit ${active ? "is-active" : ""}`}>
            <span className={`tenant-beacon ${live ? "is-live" : ""}`} aria-hidden="true" />
            <input
              ref={inputRef}
              className="session-rename-input"
              value={draftLabel}
              aria-label={`${displayLabel} 이름 변경`}
              onChange={(event) => setDraftLabel(event.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={() => {
                if (skipBlurCommitRef.current) {
                  skipBlurCommitRef.current = false;
                  return;
                }
                void commitRename();
              }}
            />
          </div>
        ) : (
          <button
            type="button"
            className={`session-row ${active ? "is-active" : ""}`}
            onClick={() => selectTerminalSession(session.sessionId)}
            onDoubleClick={beginRename}
            aria-current={active || undefined}
            aria-label={`Operation ${displayLabel}`}
          >
            <span className={`tenant-beacon ${live ? "is-live" : ""}`} aria-hidden="true" />
            <span className="tenant-row-text">
              <span className="tenant-label">{displayLabel}</span>
            </span>
            {!active && jobs.length > 0 ? <span className="tenant-count">{jobs.length}</span> : null}
          </button>
        )}
        <button
          type="button"
          className="session-close"
          onClick={() => { void closeSession(session.sessionId); }}
          aria-label={`Terminate operation ${displayLabel}`}
          title="Terminate operation"
        >
          <CloseIcon />
        </button>
      </div>
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

// X 버튼 종료 — 백엔드 PTY 세션을 끝낸 뒤에만 카드를 내린다. DELETE는 이미 없는 세션도 200 멱등 처리하므로
// throw는 진짜 실패(네트워크/401/5xx)뿐 — 이때는 카드를 남기고 오류를 표기해 살아있는 PTY를 은폐하지 않는다.
async function closeSession(sessionId: string): Promise<void> {
  try {
    await terminateTerminalSession(sessionId);
  } catch (error) {
    failTerminateTerminalSession(error instanceof Error ? error.message : String(error));
    return;
  }
  removeTerminalSession(sessionId);
}

function PlusIcon() {
  // Theater 박스 메뉴의 PlusIcon과 같은 가는 stroke·둥근 끝 마크를 공유한다.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.4v9.2M3.4 8h9.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  // Operation 종료 — Theater 박스 아이콘과 같은 가는 stroke·둥근 끝 언어를 공유하는 X 마크.
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
